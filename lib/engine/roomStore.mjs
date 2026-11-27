// 事件溯源核心：从 DB 读取事实（players / actions / events），重建引擎实例，重放到当前挂起点。
// serverless 无常驻进程 —— 任何请求都先 loadRoom 重放，再在内存里推进，最后 persist 回写。
//
// 关键设计：
//   1. 确定性：引擎 seed=room.code，每个 action 前 beginAction(seq) 重置 RNG 计数
//   2. 事件由两部分组成：引擎在 start/action 中吐出的，以及 roomStore 直接补发的（join/thought/
//      timeout/leave/end）。后者记录在 rooms.state._oob（含 beforeAction 位置），重放时按位置补发，
//      保证 seq 与持久化事件流严格对齐，从而能检测非确定性随机
//   3. 惰性超时：ask 只有 deadline，没有真实定时器；now > deadline 时用 autoActionFor 代打
import { db } from '../db/index.mjs';
import { getGameSpec } from './registry.mjs';

export class RoomError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

const OOB_LIMIT = 500;
const OMIT_EVENT_KEYS = new Set(['t', 'seq', 'at', 'fx', 'secretFor', 'text', 'context']);

function stripStamp(ev) {
  const rest = { ...(ev || {}) };
  delete rest.seq;
  delete rest.at;
  return rest;
}

// 补发一条 roomStore 侧事件（join/thought/timeout/leave/end），同时把位置记进 _oob 供重放
export function emitSideEvent(ctx, ev, beforeAction) {
  if (!ctx || !ctx.game) return;
  ctx.game.emit(ev);
  const pos = Number.isFinite(beforeAction)
    ? beforeAction
    : ctx.actions.length + ctx.newActions.length;
  ctx.oob.push({ ev: stripStamp(ev), beforeAction: pos });
}

// 事件 → events 表记录；ask 事件必须剔除 context，防止私有信息落到公开事件流
function toEventRecord(ev) {
  const payload = {};
  for (const key of Object.keys(ev)) {
    if (OMIT_EVENT_KEYS.has(key)) continue;
    payload[key] = ev[key];
  }
  if (ev.t === 'ask') {
    if (payload.ask && typeof payload.ask === 'object') {
      const { context, ...rest } = payload.ask;
      payload.ask = rest;
    }
    if (Array.isArray(payload.asks)) {
      payload.asks = payload.asks.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const { context, ...rest } = item;
        return rest;
      });
    }
  }
  return {
    seq: ev.seq,
    type: ev.t,
    payload,
    text: ev.text ?? null,
    fx: ev.fx ?? null,
    visibility: ev.secretFor ? 'secret_for' : (ev.adminOnly ? 'admin' : 'public'),
    secretForPlayerId: ev.secretFor || null,
    createdAt: ev.at || Date.now(),
  };
}

// 热快照：publicState 之上补齐房间元数据 + pending（不含 context）+ 重放所需的内部字段
export function buildState(room, game, baseUrl, ctx) {
  const publicState = game.publicState();
  const url = baseUrl || (room && room.state ? room.state._baseUrl : '') || '';
  const pending = game.pendingAsks.map((a) => ({
    id: a.id,
    playerId: a.playerId,
    batchId: a.batchId,
    kind: a.kind,
    deadline: a.deadline,
  }));
  const prevOob = room && room.state && Array.isArray(room.state._oob) ? room.state._oob : [];
  const nextOob = ctx && Array.isArray(ctx.oob) ? ctx.oob : [];
  const oob = prevOob.concat(nextOob).slice(-OOB_LIMIT);

  return {
    ...publicState,
    roomId: room.code,
    gameType: room.gameType,
    gameTitle: game.gameTitle || room.gameTitle,
    seats: room.seats,
    filled: game.players.length,
    mode: room.mode,
    autoStart: !!room.autoStart,
    hostName: room.hostName,
    joinUrl: url ? `${url}/join/${room.code}` : '',
    createdAt: room.createdAt,
    status: game.status,
    askPlayerIds: pending.map((p) => p.playerId),
    pending,
    _baseUrl: url,
    _oob: oob,
  };
}

// 对外快照：剥掉内部字段（_oob / _baseUrl），joinUrl 已内置
export function publicSnapshot(state) {
  if (!state || typeof state !== 'object') return state;
  const { _oob, _baseUrl, ...rest } = state;
  return rest;
}

// 惰性超时：把过期的挂起 ask 用 autoActionFor 代打，循环到没有过期挂起（上限 50 次）
async function settleExpired(ctx) {
  const { game, actions, newActions } = ctx;
  for (let guard = 0; guard < 50; guard += 1) {
    const expired = game.pendingAsks.filter((a) => Number(a.deadline) <= Date.now());
    if (!expired.length) return;
    const ask = expired[0];
    const act = game.autoActionFor(ask) || { action: { type: 'draw' } };
    const idx = actions.length + newActions.length;
    emitSideEvent(ctx, {
      t: 'timeout',
      playerId: ask.playerId,
      kind: ask.kind,
      text: '⏱ 超时 · 系统代打',
    }, idx);
    game.beginAction(idx + 1);
    const r = await game.submit(ask.playerId, { ...act, source: 'timeout' });
    if (!r || !r.ok) {
      game.beginAction(idx + 1);
      await game.injectAction(ask.playerId, { ...act, source: 'timeout' });
    }
    if (game.pendingAsks.some((x) => x && x.id === ask.id)) {
      throw new RoomError(500, '超时代打未能推进挂起 ask');
    }
    newActions.push({
      playerKey: ask.playerId,
      action: act.action || act,
      thought: act.thought,
      say: act.say,
      source: 'timeout',
      accepted: true,
    });
  }
}

/**
 * 加载并重放一个房间。
 * @returns {{room, game, players, actions, newActions, newEvents, oob, seq, lastSeq, baseUrl}}
 */
export async function loadRoom(code, { settleTimeouts = true } = {}) {
  const room = await db.getRoom(code);
  if (!room) throw new RoomError(404, '房间不存在');

  const players = (await db.listPlayers(code)).sort((a, b) => Number(a.seat) - Number(b.seat));
  const actions = await db.listActions(code);
  const lastSeq = await db.maxEventSeq(code);
  const spec = getGameSpec(room.gameType) || getGameSpec('bomb-table');

  let seq = 0;
  const newEvents = [];
  const newActions = [];
  const oob = [];

  const game = new spec.Class({
    seats: room.seats,
    askTimeoutMs: room.askTimeoutMs,
    gameType: room.gameType,
    seed: room.code,
    pace: 0,
    emit: (ev) => {
      seq += 1;
      const stamped = { ...ev, seq, at: Date.now() };
      if (seq > lastSeq) newEvents.push(stamped);
    },
  });
  game.gameTitle = game.gameTitle || room.gameTitle;

  // 1) 按 seat 顺序回填玩家（含 bot；bot 也带自己的 pN id）
  for (const p of players) {
    const gp = game.addPlayer({
      id: p.playerKey,
      name: p.name,
      kind: p.kind,
      style: p.style || '',
      title: p.title || '',
      model: p.model || '',
      brand: p.brand || 'unknown',
      avatarUrl: p.avatarUrl || '',
    });
    if (gp && !gp.error) {
      if (p.glyph) gp.glyph = p.glyph;
      if (p.hue != null) gp.hue = Number(p.hue);
      const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
      if (Number.isFinite(meta.deceit)) gp.deceit = meta.deceit;
      if (Number.isFinite(meta.aggression)) gp.aggression = meta.aggression;
    }
  }

  const ctx = {
    room,
    game,
    players,
    actions,
    newActions,
    newEvents,
    oob,
    seq: 0,
    lastSeq,
    baseUrl: room.state ? room.state._baseUrl || '' : '',
  };

  // 2) 已开局 / 已结束：先 start()（setup 随机数用 actionSeq=0），再按序重放 action
  if (room.status !== 'lobby') {
    const started = await game.start();
    const canStart = !(started && started.error);
    if (!canStart && actions.length > 0) {
      throw new RoomError(500, '房间无法重放：引擎拒绝开局');
    }

    const storedOob = room.state && Array.isArray(room.state._oob) ? room.state._oob : [];
    const byPos = new Map();
    const clampPos = (n) => {
      const x = Number.isFinite(n) ? n : actions.length;
      return Math.max(0, Math.min(x, actions.length));
    };
    for (const item of storedOob) {
      const pos = clampPos(item && item.beforeAction);
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos).push((item && item.ev) || {});
    }
    const flush = (pos) => {
      const list = byPos.get(pos);
      if (list) for (const ev of list) game.emit(ev);
    };

    const replayActions = canStart ? actions : [];
    for (let i = 0; i < replayActions.length; i += 1) {
      flush(i);
      game.beginAction(i + 1);
      const a = replayActions[i];
      await game.injectAction(a.playerKey, {
        action: a.action,
        thought: a.thought,
        say: a.say,
        source: a.source,
      });
    }
    flush(actions.length);

    if (seq < lastSeq) {
      throw new RoomError(500, '事件序列重放不一致，拒绝继续（可能存在非确定性随机）');
    }

    // 被管理员踢出（或其它 out-of-band 出局）的玩家：DB alive=false，但重放不重建这个状态
    for (const p of players) {
      if (p.alive === false) {
        const gp = game.byId(p.playerKey);
        if (gp) gp.alive = false;
      }
    }

    if (room.status === 'ended' && !game.finished) {
      game.finish(room.winner || { id: 'none', name: '强制结束' });
    }
  } else {
    // 未开局：不从零重放，直接把事件计数器对齐到已持久化的最大 seq
    seq = lastSeq;
  }

  ctx.seq = seq;

  // 3) 恢复挂起 ask 的持久化 deadline（否则每轮重放都会刷新超时、永不超时）
  const storedPending = room.state && Array.isArray(room.state.pending) ? room.state.pending : [];
  for (const p of game.players) {
    const ask = game.askForPlayer(p.id);
    if (!ask) continue;
    const s = storedPending.find((x) => x && x.id === ask.id);
    if (s && Number.isFinite(Number(s.deadline))) ask.deadline = Number(s.deadline);
  }

  // 4) 惰性超时
  if (settleTimeouts && game.status === 'playing') {
    await settleExpired(ctx);
  }

  ctx.seq = seq;
  return ctx;
}

/**
 * 把本次 loadRoom 产生的 action / event / 热快照写回 DB。
 */
export async function persist(ctx, extra = {}) {
  const { room, game, newActions, newEvents, baseUrl } = ctx;
  const code = room.code;

  for (const na of newActions) {
    await db.appendAction(code, {
      playerKey: na.playerKey,
      action: na.action && typeof na.action === 'object' ? na.action : {},
      thought: na.thought ?? null,
      say: na.say ?? null,
      source: na.source || 'agent',
      accepted: na.accepted !== false,
    });
  }

  if (newEvents.length) {
    await db.appendEvents(code, newEvents.map((ev) => toEventRecord(ev)));
  }

  const patch = {
    status: game.status,
    winner: game.winner || null,
    state: buildState(room, game, baseUrl, ctx),
  };
  if (game.status === 'playing' && !room.startedAt) patch.startedAt = Date.now();
  if (game.status === 'ended' && !room.endedAt) patch.endedAt = Date.now();
  Object.assign(patch, extra || {});
  await db.updateRoom(code, patch);
  return patch.state;
}
