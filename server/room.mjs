// 房间：座位、接入 token、SSE 广播、事件缓存
import crypto from 'node:crypto';
import { Game } from './engine.mjs';
import { getGameSpec } from './games/index.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const rand = (n) => crypto.randomBytes(n).toString('hex');
function roomId() {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export class Room {
  constructor({ seats = 4, humanName = '魏工', askTimeoutMs = 120000, baseUrl = '', lanBase = '', mode = 'mixed', autoStart = false, gameType = 'bomb-table', hostName = null } = {}) {
    this.id = roomId();
    this.baseUrl = baseUrl;
    this.lanBase = lanBase || '';
    this.hostToken = rand(20);
    this.hostName = hostName || null;
    this.mode = mode === 'ai' ? 'ai' : 'mixed';
    this.autoStart = !!autoStart;
    this.createdAt = Date.now();
    this.clients = new Set();
    this.events = [];
    this.seq = 0;

    const spec = getGameSpec(gameType) || getGameSpec('bomb-table');
    this.gameType = spec.id;
    this.gameTitle = spec.title;
    const seatCount = Math.max(spec.min, Math.min(spec.max, Number(seats) || spec.min));
    this.game = new spec.Class({
      seats: seatCount,
      askTimeoutMs,
      emit: (ev) => this.onEvent(ev),
    });
    this.game.gameType = this.gameType;
    if (!this.game.gameTitle) this.game.gameTitle = spec.title;
    // 纯 AI 房不占人类席位，房主只是观众
    this.human = this.mode === 'ai' ? null : this.game.addPlayer({
      name: humanName,
      kind: 'human',
      token: rand(20),
    });
  }

  /* ---------- 事件 ---------- */

  onEvent(ev) {
    this.seq += 1;
    const stamped = { ...ev, seq: this.seq, at: Date.now() };
    this.events.push(stamped);
    if (this.events.length > 800) this.events.shift();
    this.broadcast(stamped);

    // 除思考流外，每个事件后同步一次全量状态，前端不用自己拼
    if (ev.t !== 'thought' && ev.t !== 'thought-end' && ev.t !== 'ask') {
      this.broadcastState();
    }
    if (ev.t === 'ask') this.broadcastState();
  }

  broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) {
      if (payload.secretFor && payload.secretFor !== c.playerId) continue;
      try { c.res.write(line); } catch { this.clients.delete(c); }
    }
  }

  broadcastState() {
    const state = this.publicState();
    const line = `data: ${JSON.stringify({ t: 'state', state })}\n\n`;
    for (const c of this.clients) {
      try { c.res.write(line); } catch { this.clients.delete(c); }
    }
  }

  addClient(res, playerId = null) {
    const client = { res, playerId };
    this.clients.add(client);
    res.write(`data: ${JSON.stringify({ t: 'state', state: this.publicState() })}\n\n`);
    // 补发最近的记录，让新开的面板不是空白
    const recent = this.events.slice(-80);
    for (const ev of recent) {
      if (ev.secretFor && ev.secretFor !== playerId) continue;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    return client;
  }

  removeClient(client) { this.clients.delete(client); }

  /* ---------- 状态 ---------- */

  publicState() {
    const s = this.game.publicState();
    s.roomId = this.id;
    s.gameType = this.gameType;
    s.gameTitle = this.game.gameTitle || this.gameTitle;
    s.seats = this.game.seats;
    s.filled = this.game.players.length;
    s.mode = this.mode;
    s.autoStart = this.autoStart;
    s.hostName = this.hostName;
    s.joinUrl = `${this.baseUrl}/join/${this.id}`;
    if (this.lanBase) s.lanJoinUrl = `${this.lanBase}/join/${this.id}`;
    s.createdAt = this.createdAt;
    return s;
  }

  /* 房主强行结束：对 BOMB TABLE 与 v3 插件通用 */
  abort(reason = '') {
    const g = this.game;
    if (g.status === 'ended') return { error: '房间已结束' };
    if (typeof g.finish === 'function') {
      g.finish({ id: 'none', name: '强制结束' });
    } else {
      if (typeof g.clearTimer === 'function') g.clearTimer();
      clearTimeout(g.timer);
      g.status = 'ended';
      g.ask = null;
      g.pending = null;
      g.winner = { id: 'none', name: '强制结束' };
    }
    g.finished = true;
    this.onEvent({
      t: 'end',
      winnerId: 'none',
      winnerName: '强制结束',
      text: `房主强制结束房间${reason ? `：${String(reason).slice(0, 60)}` : ''}。`,
    });
    return { ok: true, state: this.publicState() };
  }

  agentView(player) {
    const g = this.game;
    const you = g.selfState(player);
    let ask = null;

    const mine = typeof g.askForPlayer === 'function'
      ? g.askForPlayer(player.id)
      : (g.ask && g.ask.playerId === player.id ? g.ask : null);
    if (mine) {
      ask = {
        id: mine.id,
        playerId: mine.playerId,
        kind: mine.kind,
        deadline: mine.deadline,
        payload: mine.payload,
        context: mine.context,
      };
      if (mine.kind === 'answer' && mine.context?.secret) {
        you.secret = { topCard: mine.context.secret.topCard };
      }
    }

    let hint;
    if (!player.alive) hint = '你已出局，牌桌还在继续。可以继续轮询观战。';
    else if (ask) hint = HINTS[ask.kind] || '轮到你行动';
    else if (this.game.status === 'lobby') hint = '还在等人。继续轮询，房主开局后你才会收到 ask。';
    else if (this.game.status === 'ended') hint = '牌局已结束。';
    else if (g.ask) hint = `还没轮到你，约 1.5 秒后再来。当前轮到 ${g.nameOf ? g.nameOf(g.ask.playerId) : '?'}。`;
    else hint = '暂时没有待你决策的事项，稍后再来。';

    return { you, ask, state: this.publicState(), hint };
  }
}

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

/* ---------- 注册表 ---------- */

export function createRoom(opts) {
  const room = new Room(opts);
  rooms.set(room.id, room);
  return room;
}

export function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) || null;
}

export function listRooms() {
  return [...rooms.values()].map((r) => ({
    roomId: r.id,
    gameType: r.gameType,
    gameTitle: r.game.gameTitle || r.gameTitle,
    mode: r.mode,
    hostName: r.hostName,
    status: r.game.status,
    filled: r.game.players.length,
    seats: r.game.seats,
    createdAt: r.createdAt,
    joinUrl: `${r.baseUrl}/join/${r.id}`,
    canJoin: r.game.status === 'lobby' && r.game.players.length < r.game.seats,
  }));
}

// 回收：2 小时前的房间、或结束超过 20 分钟的房间
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    const endedLongAgo = r.game.status === 'ended' && now - r.createdAt > 1200000;
    if (now - r.createdAt > 7200000 || endedLongAgo) {
      for (const c of r.clients) { try { c.res.end(); } catch { /* ignore */ } }
      rooms.delete(id);
    }
  }
}, 60000).unref?.();
