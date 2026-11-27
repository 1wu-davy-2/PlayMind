// 房间生命周期服务（面向 API）：建房 / 加入 / 注册子代理 / 开局 / 中止 / 轮询 / 思考 / 决策 /
// 事件增量 / 超时兜底 / 造物主后台（列表 / 上帝视角 / 干预）。
//
// 所有对外 token 只在签发响应里出现一次；DB 只存 hashToken()，比较用 safeEqual。
// 任何变更必须先 loadRoom 重放，再动引擎，最后 persist 回写；拒绝的 action 不落库。
import crypto from 'node:crypto';
import { db } from './db/index.mjs';
import { newToken, hashToken, safeEqual } from './auth.mjs';
import { brandKeyOf } from './brand.mjs';
import { cleanText, DEFAULT_AGENT_STYLES } from './text.mjs';
import { renderPitch } from './engine/pitch.mjs';
import { getGameSpec, listGames } from './engine/registry.mjs';
import {
  RoomError, loadRoom, persist, buildState, publicSnapshot, emitSideEvent,
} from './engine/roomStore.mjs';

export { RoomError };

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const HINTS = {
  draw: '轮到你抽牌。提交 {"action":{"type":"draw"}}，或先用道具。',
  defuse: '你抽到炸弹，手上还有拆弹钳。决定用不用。',
  'pick-target': '你抽到质询牌，指定一个人受审。',
  answer: '你被要求回答：下一张是炸弹吗？你可以撒谎。',
  verdict: '他在回答你。选择相信，还是当场指控他说谎。',
  free: '轮到你发言。提交 {"action":{"type":"text","text":"..."}}。',
  declare: '轮到你申报。按 payload 字段提交 {"action":{"type":"declare",...}}。',
  vote: '轮到你投票。提交 {"action":{"type":"vote","targetId":"p1"}} 或 {"type":"vote","approve":true}。',
  confirm: '需要你确认。提交 {"action":{"type":"confirm","use":true|false}}。',
  'multi-pick': '选择若干目标，提交 {"action":{"type":"pick-many","ids":["p1"]}}。',
  bet: '轮到你下注。提交 {"action":{"type":"bet","move":"call|raise|fold|check|allin","amount":0}}。',
  'play-card': '轮到你出牌。提交 {"action":{"type":"play","cardId":"..."}} 或 {"type":"draw"}。',
  challenge: '你可以选择接受或质疑。提交 {"action":{"type":"challenge","accept":true|false}}。',
};

/* ---------------- 小工具 ---------------- */

function randomCode() {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function clampSeats(seats, spec) {
  const n = Math.floor(Number(seats));
  const v = Number.isFinite(n) && n > 0 ? n : spec.min;
  return Math.max(spec.min, Math.min(spec.max, v));
}

function findPlayerRow(players, token) {
  if (!token) return null;
  const hash = hashToken(String(token));
  for (const p of players) {
    if (p.tokenHash && safeEqual(hash, p.tokenHash)) return p;
  }
  return null;
}

function hasExpiredPending(state) {
  if (!state || !Array.isArray(state.pending)) return false;
  const now = Date.now();
  return state.pending.some((p) => p && Number(p.deadline) <= now);
}

async function freshState(code) {
  const room = await db.getRoom(code);
  return room ? publicSnapshot(room.state) : {};
}

// 引擎在 start() 里补的 bot 尚未写库；把它们（带 bot 决策所需的 meta）持久化
async function persistEnginePlayers(ctx) {
  const known = new Set(ctx.players.map((p) => p.playerKey));
  const gamePlayers = ctx.game.players;
  for (let i = 0; i < gamePlayers.length; i += 1) {
    const gp = gamePlayers[i];
    if (known.has(gp.id)) continue;
    known.add(gp.id);
    const row = await db.addPlayer(ctx.room.code, {
      playerKey: gp.id,
      seat: i,
      tokenHash: '',
      kind: gp.kind,
      name: gp.name,
      style: gp.style || '',
      title: gp.title || '',
      glyph: gp.glyph,
      hue: gp.hue,
      model: gp.model || '',
      brand: gp.brand || 'unknown',
      avatarUrl: gp.avatarUrl || '',
      hp: gp.hp,
      maxHp: gp.maxHp ?? gp.hp ?? 1,
      alive: gp.alive !== false,
      meta: { deceit: gp.deceit, aggression: gp.aggression },
    });
    if (row) ctx.players.push(row);
  }
}

// 代打某个玩家当前挂起的 ask（供 admin kick / advance-phase 使用）
async function settleAskForPlayer(ctx, playerId, source) {
  const game = ctx.game;
  const ask = game.askForPlayer(playerId);
  if (!ask) return false;
  const act = game.autoActionFor(ask) || { action: { type: 'draw' } };
  const idx = ctx.actions.length + ctx.newActions.length;
  game.beginAction(idx + 1);
  const r = await game.submit(playerId, { ...act, source });
  if (!r || !r.ok) {
    game.beginAction(idx + 1);
    await game.injectAction(playerId, { ...act, source });
  }
  ctx.newActions.push({
    playerKey: playerId,
    action: act.action || act,
    thought: act.thought,
    say: act.say,
    source,
    accepted: true,
  });
  return true;
}

/* ---------------- 建房 ---------------- */

export async function createRoom({
  gameType, seats, humanName, hostName, askTimeoutMs, mode, autoStart, baseUrl,
} = {}) {
  const wanted = String(gameType || 'bomb-table').toLowerCase();
  const spec = getGameSpec(wanted);
  if (!spec) throw new RoomError(400, `未知 gameType：${wanted}`, { games: listGames() });

  const seatCount = clampSeats(seats, spec);
  const askMs = Math.max(20000, Number(askTimeoutMs) || 120000);
  const roomMode = mode === 'ai' ? 'ai' : 'mixed';
  const hostToken = newToken(32);
  const hostTokenHash = hashToken(hostToken);
  const hostNameClean = cleanText(hostName, 20) || null;
  const humanNameClean = cleanText(humanName, 12) || '魏工';
  const base = String(baseUrl || '');

  let created = null;
  let code = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    code = randomCode();
    try {
      created = await db.createRoom({
        code,
        gameType: spec.id,
        gameTitle: spec.title,
        status: 'lobby',
        mode: roomMode,
        seats: seatCount,
        askTimeoutMs: askMs,
        autoStart: !!autoStart,
        hostName: hostNameClean,
        hostTokenHash,
        state: { _baseUrl: base },
      });
      break;
    } catch (e) {
      if (e && e.code === 'CONFLICT') continue;
      throw e;
    }
  }
  if (!created) throw new RoomError(500, '无法分配房间号，请重试');

  const ctx = await loadRoom(code);
  ctx.baseUrl = base;

  let humanToken = null;
  let humanPlayerId = null;
  if (roomMode === 'mixed') {
    const token = newToken(32);
    const p = ctx.game.addPlayer({ name: humanNameClean, kind: 'human' });
    if (p && !p.error) {
      const row = await db.addPlayer(code, {
        playerKey: p.id,
        seat: ctx.game.players.indexOf(p),
        tokenHash: hashToken(token),
        kind: 'human',
        name: p.name,
        style: p.style || '',
        title: p.title || '',
        glyph: p.glyph,
        hue: p.hue,
        model: p.model || '',
        brand: p.brand || 'unknown',
        avatarUrl: p.avatarUrl || '',
        hp: p.hp ?? 1,
        maxHp: p.maxHp ?? p.hp ?? 1,
        alive: true,
      });
      if (row) ctx.players.push(row);
      humanToken = token;
      humanPlayerId = p.id;
    }
  }

  await persist(ctx);
  const state = await freshState(code);
  const joinUrl = `${base}/join/${code}`;
  const pitch = renderPitch({ state, joinUrl, seats: seatCount, askTimeoutMs: askMs });

  return {
    roomId: code,
    gameType: spec.id,
    gameTitle: ctx.game.gameTitle || spec.title,
    joinUrl,
    playUrl: `${base}/play/${code}`,
    lanBase: null,
    lanJoinUrl: null,
    pitch,
    invite: pitch,
    hostName: hostNameClean,
    manualUrl: `${base}/api/manual`,
    hostToken,
    humanToken,
    playerId: humanPlayerId,
    mode: roomMode,
    spectateUrl: `${base}/play/${code}`,
    state,
  };
}

/* ---------------- 查询 ---------------- */

export async function getRoomState(code) {
  const room = await db.getRoom(code);
  if (!room) throw new RoomError(404, '房间不存在');
  const state = publicSnapshot(room.state) || {};
  const base = room.state && room.state._baseUrl ? room.state._baseUrl : '';
  if (base) state.joinUrl = `${base}/join/${room.code}`;
  return { state };
}

export async function listRoomSummaries(baseUrl = '') {
  const rooms = await db.listRooms();
  const base = String(baseUrl || '');
  return rooms.map((r) => {
    const state = r.state || {};
    const filled = r.filled != null ? Number(r.filled) : (state.filled != null ? Number(state.filled) : 0);
    return {
      roomId: r.code,
      gameType: r.gameType,
      gameTitle: r.gameTitle ?? state.gameTitle ?? r.gameType,
      mode: r.mode,
      hostName: r.hostName,
      status: r.status,
      filled,
      seats: r.seats,
      createdAt: r.createdAt,
      joinUrl: `${base}/join/${r.code}`,
      canJoin: r.status === 'lobby' && filled < r.seats,
    };
  });
}

/* ---------------- 加入 / 注册 / 开局 / 中止 ---------------- */

export async function joinRoom(code, body = {}, baseUrl = '') {
  const ctx = await loadRoom(code);
  ctx.baseUrl = String(baseUrl || '');
  const game = ctx.game;
  if (game.status !== 'lobby') throw new RoomError(409, '已经开局了');
  if (game.players.length >= game.seats) throw new RoomError(409, '房间已满');

  const b = body && typeof body === 'object' ? body : {};
  const token = newToken(32);
  const modelName = cleanText(b.model, 80);
  const p = game.addPlayer({
    name: cleanText(b.name, 12) || '匿名 agent',
    kind: 'agent',
    style: cleanText(b.style, 120),
    model: modelName,
    brand: brandKeyOf(modelName),
    avatarUrl: cleanText(b.avatarUrl, 300),
  });
  if (p.error) throw new RoomError(409, p.error);

  emitSideEvent(ctx, { t: 'join', playerId: p.id, name: p.name }, ctx.actions.length + ctx.newActions.length);
  const row = await db.addPlayer(code, {
    playerKey: p.id,
    seat: game.players.indexOf(p),
    tokenHash: hashToken(token),
    kind: 'agent',
    name: p.name,
    style: p.style || '',
    title: p.title || '',
    glyph: p.glyph,
    hue: p.hue,
    model: p.model || '',
    brand: p.brand || 'unknown',
    avatarUrl: p.avatarUrl || '',
    hp: p.hp ?? 1,
    maxHp: p.maxHp ?? p.hp ?? 1,
    alive: true,
  });
  if (row) ctx.players.push(row);

  let started = false;
  if (ctx.room.autoStart && game.status === 'lobby' && game.players.length >= game.seats) {
    const r = await game.start();
    if (r && !r.error) {
      started = true;
      await persistEnginePlayers(ctx);
    }
  }

  await persist(ctx);
  return {
    playerId: p.id,
    token,
    seat: game.players.indexOf(p),
    started,
    state: await freshState(code),
  };
}

export async function registerAgents(code, hostToken, agents, baseUrl = '') {
  const ctx = await loadRoom(code);
  ctx.baseUrl = String(baseUrl || '');
  const room = ctx.room;
  if (!hostToken || !safeEqual(hashToken(String(hostToken)), room.hostTokenHash)) {
    throw new RoomError(403, 'hostToken 不对');
  }
  const game = ctx.game;
  if (game.status !== 'lobby') throw new RoomError(409, '已经开局了，无法注册子代理');
  if (!Array.isArray(agents) || agents.length === 0) throw new RoomError(400, 'agents 必须是非空数组');
  const free = game.seats - game.players.length;
  if (agents.length > free) {
    throw new RoomError(409, `席位不足：剩余 ${free} 席，需要 ${agents.length} 席`);
  }

  const out = [];
  for (let i = 0; i < agents.length; i += 1) {
    const a = agents[i] && typeof agents[i] === 'object' ? agents[i] : {};
    const token = newToken(32);
    const modelName = cleanText(a.model, 80);
    const p = game.addPlayer({
      name: cleanText(a.name, 12) || `子代理${i + 1}`,
      kind: 'agent',
      style: cleanText(a.style, 120) || DEFAULT_AGENT_STYLES[i % DEFAULT_AGENT_STYLES.length],
      model: modelName,
      brand: brandKeyOf(modelName),
      avatarUrl: cleanText(a.avatarUrl, 300),
    });
    if (p.error) throw new RoomError(409, p.error);
    emitSideEvent(ctx, { t: 'join', playerId: p.id, name: p.name }, ctx.actions.length + ctx.newActions.length);
    const seat = game.players.indexOf(p);
    const row = await db.addPlayer(code, {
      playerKey: p.id,
      seat,
      tokenHash: hashToken(token),
      kind: 'agent',
      name: p.name,
      style: p.style || '',
      title: p.title || '',
      glyph: p.glyph,
      hue: p.hue,
      model: p.model || '',
      brand: p.brand || 'unknown',
      avatarUrl: p.avatarUrl || '',
      hp: p.hp ?? 1,
      maxHp: p.maxHp ?? p.hp ?? 1,
      alive: true,
    });
    if (row) ctx.players.push(row);
    out.push({ playerId: p.id, token, seat, name: p.name, style: p.style });
  }

  await persist(ctx);
  return { players: out, state: await freshState(code) };
}

export async function startRoom(code, hostToken, baseUrl = '') {
  const ctx = await loadRoom(code);
  ctx.baseUrl = String(baseUrl || '');
  const room = ctx.room;
  if (hostToken) {
    if (!safeEqual(hashToken(String(hostToken)), room.hostTokenHash)) {
      throw new RoomError(403, 'hostToken 不对');
    }
  }
  if (ctx.game.status !== 'lobby') throw new RoomError(409, '已经开局');
  const r = await ctx.game.start();
  if (r && r.error) throw new RoomError(409, r.error);
  await persistEnginePlayers(ctx);
  await persist(ctx, { startedAt: Date.now() });
  return { ok: true, state: await freshState(code) };
}

export async function abortRoom(code, hostToken, reason = '', baseUrl = '') {
  const ctx = await loadRoom(code);
  ctx.baseUrl = String(baseUrl || '');
  const room = ctx.room;
  const supplied = String(hostToken || '');
  if (!supplied || !safeEqual(hashToken(supplied), room.hostTokenHash)) {
    throw new RoomError(403, 'hostToken 不对');
  }
  const game = ctx.game;
  if (game.status === 'ended') throw new RoomError(409, '房间已结束');
  if (typeof game.finish === 'function') {
    game.finish({ id: 'none', name: '强制结束' });
  } else {
    game.status = 'ended';
    game.finished = true;
    game.winner = { id: 'none', name: '强制结束' };
  }
  const suffix = reason ? `：${cleanText(reason, 60)}` : '';
  emitSideEvent(ctx, {
    t: 'end',
    winnerId: 'none',
    winnerName: '强制结束',
    text: `房主强制结束房间${suffix}。`,
  }, ctx.actions.length + ctx.newActions.length);
  await persist(ctx, { endedAt: Date.now() });
  return { ok: true, state: await freshState(code) };
}

/* ---------------- Agent 轮询 / 思考 / 决策 ---------------- */

export async function agentView(code, token, baseUrl = '') {
  const ctx = await loadRoom(code);
  ctx.baseUrl = String(baseUrl || '');
  const row = findPlayerRow(ctx.players, token);
  if (!row) throw new RoomError(403, 'token 无效');

  if (ctx.newActions.length || ctx.newEvents.length) await persist(ctx);

  const game = ctx.game;
  const player = game.byId(row.playerKey);
  if (!player) throw new RoomError(403, 'token 无效');
  game.touch(player.id);
  try { await db.updatePlayer(code, player.id, { lastSeen: Date.now() }); } catch { /* ignore */ }

  const you = game.selfState(player);
  let ask = null;
  const mine = typeof game.askForPlayer === 'function' ? game.askForPlayer(player.id) : null;
  if (mine) {
    ask = {
      id: mine.id,
      playerId: mine.playerId,
      kind: mine.kind,
      deadline: mine.deadline,
      payload: mine.payload,
      context: mine.context,
    };
    if (mine.kind === 'answer' && mine.context && mine.context.secret) {
      you.secret = { topCard: mine.context.secret.topCard };
    }
  }

  let hint;
  if (!player.alive) hint = '你已出局，牌桌还在继续。可以继续轮询观战。';
  else if (ask) hint = HINTS[ask.kind] || '轮到你行动';
  else if (game.status === 'lobby') hint = '还在等人。继续轮询，房主开局后你才会收到 ask。';
  else if (game.status === 'ended') hint = '牌局已结束。';
  else if (game.ask) hint = `还没轮到你，约 1.5 秒后再来。当前轮到 ${game.nameOf ? game.nameOf(game.ask.playerId) : '?'}。`;
  else hint = '暂时没有待你决策的事项，稍后再来。';

  const state = publicSnapshot(buildState(ctx.room, game, ctx.baseUrl, ctx));
  return { you, ask, state, hint };
}

export async function submitThought(code, token, text) {
  const ctx = await loadRoom(code);
  const row = findPlayerRow(ctx.players, token);
  if (!row) throw new RoomError(403, 'token 无效');
  const clean = cleanText(text, 400);
  if (!clean) throw new RoomError(400, 'text 不能为空');

  const startLen = ctx.newEvents.length;
  const ok = ctx.game.appendThought(row.playerKey, clean);
  if (!ok) throw new RoomError(400, 'text 不能为空');
  for (let i = startLen; i < ctx.newEvents.length; i += 1) {
    const { seq, at, ...rest } = ctx.newEvents[i];
    ctx.oob.push({ ev: rest, beforeAction: ctx.actions.length + ctx.newActions.length });
  }

  await db.appendThought(code, row.playerKey, clean);
  await persist(ctx);
  return { ok: true };
}

export async function submitAct(code, token, body = {}) {
  const ctx = await loadRoom(code);
  const row = findPlayerRow(ctx.players, token);
  if (!row) throw new RoomError(403, 'token 无效');
  if (body && body._raw != null) throw new RoomError(400, 'act 需要 JSON 对象，不是纯文本');

  const b = body && typeof body === 'object' ? body : {};
  const act = { ...b };
  delete act._raw;
  if (b.thought == null) delete act.thought;
  else act.thought = cleanText(b.thought, 600);
  if (b.say == null) delete act.say;
  else act.say = cleanText(b.say, 120);

  const game = ctx.game;
  const seqNo = ctx.actions.length + ctx.newActions.length + 1;
  game.beginAction(seqNo);
  const r = await game.submit(row.playerKey, act);
  if (!r || !r.ok) {
    // 规则拒绝：本次 action 不落库，但先前惰性超时的推进仍需持久化
    if (ctx.newActions.length || ctx.newEvents.length) await persist(ctx);
    throw new RoomError(409, (r && r.error) || '当前没有待你决策的事项');
  }

  ctx.newActions.push({
    playerKey: row.playerKey,
    action: act.action || null,
    thought: act.thought,
    say: act.say,
    source: 'agent',
    accepted: true,
  });
  await persist(ctx);
  return { ok: true, accepted: true };
}

export async function listRoomEvents(code, { since = 0, token = null } = {}) {
  const room = await db.getRoom(code);
  if (!room) throw new RoomError(404, '房间不存在');

  let viewerPlayerId = null;
  if (token) {
    const rows = await db.listPlayers(code);
    const row = findPlayerRow(rows, token);
    viewerPlayerId = row ? row.playerKey : null;
  }

  const events = await db.listEvents(code, { since, viewerPlayerId, limit: 200 });
  const maxSeq = await db.maxEventSeq(code);
  return {
    events: events.map((ev) => ({
      ...(ev.payload && typeof ev.payload === 'object' ? ev.payload : {}),
      seq: ev.seq,
      t: ev.type,
      at: ev.createdAt,
      ...(ev.text != null ? { text: ev.text } : {}),
      ...(ev.fx != null ? { fx: ev.fx } : {}),
    })),
    state: publicSnapshot(room.state),
    maxSeq,
  };
}

/* ---------------- 超时兜底（cron） ---------------- */

export async function tickRoom(code) {
  const room = await db.getRoom(code);
  if (!room || room.status !== 'playing') return { ticked: 0 };
  if (!hasExpiredPending(room.state)) return { ticked: 0 };
  const ctx = await loadRoom(code, { settleTimeouts: true });
  const n = ctx.newActions.length;
  if (n || ctx.newEvents.length) await persist(ctx);
  return { ticked: n };
}

export async function tickAll() {
  const rooms = await db.listRooms();
  let ticked = 0;
  let roomsTicked = 0;
  for (const r of rooms) {
    if (r.status !== 'playing') continue;
    if (!hasExpiredPending(r.state)) continue;
    try {
      const res = await tickRoom(r.code);
      if (res.ticked) {
        ticked += res.ticked;
        roomsTicked += 1;
      }
    } catch {
      // 单房间异常不能拖垮整轮
    }
  }
  return { ticked, rooms: roomsTicked };
}

export async function verifyHostToken(code, token) {
  const room = await db.getRoom(code);
  if (!room || !token) return false;
  return safeEqual(hashToken(String(token)), room.hostTokenHash);
}

/* ---------------- 造物主后台 ---------------- */

export async function adminRoomSummaries() {
  const rooms = await db.listRooms();
  return rooms.map((r) => {
    const state = r.state || {};
    const filled = r.filled != null
      ? Number(r.filled)
      : (Array.isArray(state.players) ? state.players.length : 0);
    const pending = Array.isArray(state.pending) ? state.pending : [];
    const askPlayerIds = pending.length
      ? pending.map((p) => p.playerId)
      : (Array.isArray(state.askPlayerIds) ? state.askPlayerIds : []);
    return {
      roomId: r.code,
      gameType: r.gameType,
      gameTitle: r.gameTitle,
      status: r.status,
      phase: r.phase ?? state.phase ?? null,
      mode: r.mode,
      seats: r.seats,
      filled,
      hostName: r.hostName,
      askPlayerIds,
      createdAt: r.createdAt,
      canIntervene: r.status !== 'ended',
    };
  });
}

export async function adminGodview(code, { level = 'masked' } = {}) {
  const ctx = await loadRoom(code, { settleTimeouts: false });
  const room = ctx.room;
  const game = ctx.game;
  const raw = level === 'raw';

  const players = game.players.map((p, seat) => {
    const secret = typeof game.secretOf === 'function' ? game.secretOf(p) : null;
    const base = {
      playerId: p.id,
      seat,
      name: p.name,
      kind: p.kind,
      model: p.model || '',
      brand: p.brand || 'unknown',
      alive: p.alive,
      hp: p.hp,
      role: raw ? (p.role ?? null) : (p.rolePublic ? p.role : null),
      team: raw ? (p.team ?? null) : (p.teamPublic ? p.team : null),
      thought: raw ? (p.thought || '') : String(p.thought || '').slice(0, 120),
      say: p.say || '',
      lastSeen: p.lastSeen || null,
      connected: p.kind !== 'agent' || Date.now() - (p.lastSeen || 0) < 90000,
      handCount: Array.isArray(p.hand) ? p.hand.length : 0,
      diceCount: Array.isArray(p.dice) ? p.dice.length : 0,
    };
    if (raw) {
      base.secret = secret || null;
      base.hand = Array.isArray(p.hand) ? p.hand.slice() : [];
      base.dice = Array.isArray(p.dice) ? p.dice.slice() : [];
    } else if (secret) {
      base.secret = { redacted: true, ...(secret.kind ? { kind: secret.kind } : {}) };
    } else {
      base.secret = null;
    }
    return base;
  });

  const asks = game.pendingAsks.map((a) => ({
    askId: a.id,
    playerId: a.playerId,
    kind: a.kind,
    deadline: a.deadline,
    payload: a.payload,
    context: raw ? (a.context ?? {}) : { redacted: true },
  }));

  const thoughtsRaw = await db.listThoughts(code);
  const thoughts = raw
    ? thoughtsRaw
    : thoughtsRaw.map((t) => ({ ...t, delta: String(t.delta || '').slice(0, 120) }));

  const evRows = await db.listEvents(code, raw ? { includeAll: true, limit: 1000 } : { limit: 500 });
  const events = evRows.map((ev) => ({
    seq: ev.seq,
    type: ev.type,
    text: ev.text ?? null,
    visibility: ev.visibility,
    at: ev.createdAt,
    payload: ev.payload,
  }));

  return {
    room: {
      roomId: room.code,
      gameType: room.gameType,
      gameTitle: game.gameTitle || room.gameTitle,
      status: game.status,
      phase: game.phase,
      round: game.round,
      hostName: room.hostName,
      createdAt: room.createdAt,
      winner: game.winner || null,
    },
    publicState: publicSnapshot(buildState(room, game, ctx.baseUrl, ctx)),
    players,
    asks,
    thoughts,
    events,
    meta: {
      capturedAt: Date.now(),
      visibilityLevel: raw ? 'raw' : 'masked',
      eventCount: events.length,
    },
  };
}

export async function adminIntervene(code, {
  action, reason = '', targetPlayerId = null, actionPayload = null,
} = {}) {
  const ctx = await loadRoom(code, { settleTimeouts: false });
  const game = ctx.game;
  const before = {
    status: game.status,
    phase: game.phase,
    askPlayerIds: game.pendingAsks.map((a) => a.playerId),
  };
  const act = String(action || '');

  if (act === 'abort') {
    if (game.status === 'ended') throw new RoomError(409, '房间已结束');
    if (typeof game.finish === 'function') {
      game.finish({ id: 'none', name: '强制结束' });
    } else {
      game.status = 'ended';
      game.finished = true;
      game.winner = { id: 'none', name: '强制结束' };
    }
    const suffix = reason ? `：${cleanText(reason, 60)}` : '';
    emitSideEvent(ctx, {
      t: 'end',
      winnerId: 'none',
      winnerName: '强制结束',
      text: `管理员强制结束房间${suffix}。`,
    }, ctx.actions.length + ctx.newActions.length);
  } else if (act === 'kick') {
    if (!targetPlayerId) throw new RoomError(400, 'kick 需要 targetPlayerId');
    const gp = game.byId(String(targetPlayerId));
    if (!gp) throw new RoomError(404, '玩家不存在');
    await settleAskForPlayer(ctx, gp.id, 'admin');
    gp.alive = false;
    try { await db.updatePlayer(code, gp.id, { alive: false }); } catch { /* ignore */ }
    emitSideEvent(ctx, {
      t: 'leave',
      playerId: gp.id,
      name: gp.name,
      text: `管理员踢出 ${gp.name}`,
    }, ctx.actions.length + ctx.newActions.length);
  } else if (act === 'advance-phase') {
    for (let guard = 0; guard < 50; guard += 1) {
      const asks = game.pendingAsks;
      if (!asks.length || game.finished) break;
      await settleAskForPlayer(ctx, asks[0].playerId, 'admin');
    }
  } else if (act === 'force-act') {
    if (!targetPlayerId) throw new RoomError(400, 'force-act 需要 targetPlayerId');
    const gp = game.byId(String(targetPlayerId));
    if (!gp) throw new RoomError(404, '玩家不存在');
    const payload = actionPayload && typeof actionPayload === 'object' ? actionPayload : null;
    if (!payload) throw new RoomError(400, 'force-act 需要 actionPayload');
    const idx = ctx.actions.length + ctx.newActions.length;
    game.beginAction(idx + 1);
    const r = await game.submit(gp.id, payload);
    if (!r || !r.ok) throw new RoomError(409, (r && r.error) || '无法提交该动作');
    ctx.newActions.push({
      playerKey: gp.id,
      action: payload.action || null,
      thought: payload.thought,
      say: payload.say,
      source: 'admin',
      accepted: true,
    });
  } else {
    throw new RoomError(400, `未知干预动作：${act}`);
  }

  await persist(ctx);
  const after = {
    status: game.status,
    phase: game.phase,
    askPlayerIds: game.pendingAsks.map((a) => a.playerId),
    winner: game.winner || null,
  };
  return { ok: true, action: act, before, after, auditBefore: before, auditAfter: after };
}
