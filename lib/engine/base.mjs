// 通用游戏底座（serverless 版）：玩家、座位、单/多 ask、bot、状态骨架。
// 与 legacy/server/core/base.mjs 的差异：
//   1. 不持有任何定时器 —— ask 只记录 deadline，超时由 roomStore 惰性检查后注入动作
//   2. 所有随机数走 seeded RNG（this.rng），保证同一 action 序列重放结果完全一致
//   3. submit / injectAction 都是 async 且 await pump()，不再 fire-and-forget
// 新游戏继承 GameBase，只实现 setup/drive/validate/autoAct/botAct/secretOf/tableState。
import { GLYPHS, HUES } from './data.mjs';

// 32 位 FNV-1a：种子哈希，跨进程稳定
export const hash32 = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

// 洗牌：rng 是函数，默认用 Math.random（引擎内请传 () => this.rng()）
export const shuffle = (arr, rng = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// 事件 → 通用特效类型。前端只认 fx.kind，不认识具体游戏。
const FX_KIND = {
  action: 'chip', win: 'chip', collect: 'chip', bet: 'chip',
  hand: 'card', board: 'card', showdown: 'card', play: 'card',
  draw: 'card', deal: 'card', suggest: 'card', guess: 'card',
  reverse: 'card', skip: 'card', uno: 'card', handover: 'card',
  bid: 'bid',
  'vote-result': 'vote',
  reveal: 'stamp', truth: 'stamp', accuse: 'stamp', shoot: 'stamp',
  eliminate: 'stamp', caught: 'stamp', penalty: 'stamp', wrong: 'stamp',
  clue: 'clue',
  street: 'phase', turn: 'phase', team: 'phase',
  end: 'end',
};

const BOT_NAMES = [
  ['墨菲', '前拆弹工程师', 0.25, 0.6],
  ['零', '职业赌徒', 0.82, 0.5],
  ['阿岚', '谈判专家', 0.48, 0.25],
  ['灰雀', '退役审讯员', 0.6, 0.8],
  ['白鸦', '档案管理员', 0.35, 0.3],
  ['夜莺', '夜班电台主持', 0.55, 0.45],
  ['石川', '沉默的会计', 0.3, 0.4],
  ['红豆', ' improv 演员', 0.7, 0.55],
];

export class GameBase {
  constructor({ seats = 4, askTimeoutMs = 120000, emit = () => {}, gameType = 'base', seed = '', pace = 0 } = {}) {
    this.gameType = gameType;
    this.gameTitle = this.gameTitle || gameType;
    this.seats = clamp(Number(seats) || 4, this.minSeats || 2, this.maxSeats || 10);
    this.askTimeoutMs = Math.max(5000, Number(askTimeoutMs) || 120000);
    const rawEmit = typeof emit === 'function' ? emit : () => {};
    this.emit = (ev) => rawEmit(this.decorateFx(ev));

    // 确定性随机：seed = 房间种子，actionSeq = 第几个被接受的 action，callIndex = 该 action 内第几次取随机
    this.seedBase = String(seed || gameType || 'seed');
    this._actionSeq = 0;
    this._rngCalls = 0;
    this.pace = pace; // 兼容旧构造签名；serverless 下不参与任何逻辑

    this.players = [];
    this.status = 'lobby';
    this.phase = 'lobby';
    this.round = 1;
    this.winner = null;
    this.finished = false;
    this.pumping = false;
    this.gen = null;

    this.asks = new Map();
    this.ask = null;
    this.timers = new Map(); // 兼容旧字段，永远为空
    this.askSeq = 0;
    this.log = [];
  }

  /* ---------------- 确定性随机 ---------------- */

  // 每个 action 开始前调用，重置随机计数
  beginAction(seq) {
    this._actionSeq = Math.max(0, Number(seq) || 0);
    this._rngCalls = 0;
  }

  rng() {
    return hash32(`${this.seedBase}:${this._actionSeq}:${this._rngCalls++}`) / 4294967296;
  }

  /* ---------------- 座位 ---------------- */

  addPlayer({
    id = '', name, kind = 'agent', token = null, style = '', title = '',
    model = '', brand = 'unknown', avatarUrl = '',
  } = {}) {
    if (this.players.length >= this.seats) return { error: '房间已满' };
    if (this.status !== 'lobby') return { error: '已经开局' };
    const n = this.players.length;
    const p = {
      // 重放时由调用方按座位顺序指定 p0/p1…；未指定则按加入顺序生成
      id: String(id || `p${n}`),
      name: String(name || `玩家${n}`).slice(0, 12),
      kind,
      token,
      style: String(style || '').slice(0, 120),
      model: String(model || '').slice(0, 80),
      brand: String(brand || 'unknown').slice(0, 24),
      avatarUrl: String(avatarUrl || '').slice(0, 300),
      title: title || (kind === 'human' ? '唯一的真人' : kind === 'bot' ? '内置代打' : '外部 Agent'),
      glyph: kind === 'human' ? '★' : GLYPHS[n % GLYPHS.length],
      hue: kind === 'human' ? 205 : HUES[n % HUES.length],
      alive: true,
      hp: 1,
      maxHp: 1,
      items: [],
      hand: [],
      dice: [],
      chips: 0,
      team: null,
      role: null,
      say: '',
      thought: '',
      caught: 0,
      folded: false,
      lastSeen: 0,
      deceit: BOT_NAMES[n % BOT_NAMES.length][2],
      aggression: BOT_NAMES[n % BOT_NAMES.length][3],
      meta: {},
    };
    this.players.push(p);
    return p;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  byToken(t) { return t ? this.players.find((p) => p.token === t) : null; }
  get current() { return this.ask ? this.byId(this.ask.playerId) : null; }
  get aliveList() { return this.players.filter((p) => p.alive); }
  othersOf(p) { return this.aliveList.filter((x) => x.id !== p.id); }
  nameOf(id) { return this.byId(id)?.name || id; }

  get pendingAsks() { return [...this.asks.values()].map((a) => ({ ...a })); }

  /* ---------------- 开局 ---------------- */

  async start() {
    if (this.status !== 'lobby') return { error: '已经开局' };
    if (this.players.length < (this.minSeats || 2)) {
      return { error: `至少需要 ${this.minSeats || 2} 名玩家` };
    }
    let k = 0;
    while (this.players.length < this.seats) {
      const [name, title, deceit, aggression] = BOT_NAMES[k % BOT_NAMES.length];
      const used = new Set(this.players.map((p) => p.name));
      const p = this.addPlayer({ name: used.has(name) ? `${name}Ⅱ` : name, kind: 'bot', title });
      if (p.error) break;
      p.deceit = deceit;
      p.aggression = aggression;
      k += 1;
    }
    this.status = 'playing';
    this.phase = 'setup';
    this.setup();
    this.gen = this.drive();
    await this.pump();
    return { ok: true };
  }

  setup() {}

  async *drive() {
    yield { t: 'error', text: '该游戏尚未实现主循环' };
    this.finish('none');
  }

  /* ---------------- 推进 ---------------- */

  async pump() {
    if (this.pumping || this.finished || !this.gen) return;
    this.pumping = true;
    try {
      while (true) {
        if (this.finished) break;
        let step;
        try {
          step = await this.gen.next();
        } catch (e) {
          this.emit({ t: 'error', text: `引擎异常：${String((e && e.message) || e)}` });
          this.finished = true;
          break;
        }
        if (step.done) { this.finished = true; break; }
        const value = step.value;
        if (!value) continue;
        this.emit(value);
        if (value.log) this.pushLog(value.log);
        if (value.pause) break;
        // 忽略 value.wait：serverless 不 sleep，演出节奏交给前端
      }
    } finally {
      this.pumping = false;
    }
  }

  // 接受一个 action（submit 与 injectAction 共用）：投屏思考、清 ask、写回 result
  acceptAction(ask, act) {
    const p = this.byId(ask.playerId);
    const a = act && typeof act === 'object' ? act : {};
    if (p) {
      if (a.thought && !p.thought) {
        this.emit({ t: 'thought', playerId: p.id, delta: String(a.thought).slice(0, 800) });
      }
      if (p.thought) this.emit({ t: 'thought-end', playerId: p.id });
      p.thought = '';
      p.say = a.say ? String(a.say).slice(0, 200) : '';
      p.lastSeen = Date.now();
    }

    this.clearTimer(ask.id);
    ask.result = a;
    this.asks.delete(ask.id);
    if (this.ask && this.ask.id === ask.id) this.ask = [...this.asks.values()][0] || null;
    return p;
  }

  async submit(playerId, act = {}) {
    const ask = [...this.asks.values()].find((a) => a.playerId === playerId);
    if (!ask) return { ok: false, error: '当前没有待你决策的事项' };

    const err = this.validate(ask, act, this);
    if (err) return { ok: false, error: err };

    const p = this.acceptAction(ask, act);

    // 同批次还有别人的 ask 没收齐：不推进，等最后一个人
    const sameBatchLeft = [...this.asks.values()].some((a) => a.batchId === ask.batchId);
    if (sameBatchLeft) {
      this.emit({ t: 'ask-wait', text: `${p ? p.name : playerId} 已提交，等待其他人`, playerId, batchId: ask.batchId });
      return { ok: true, waiting: true };
    }

    await this.pump();
    return { ok: true };
  }

  // 重放专用：跳过 validate，直接接受并推进
  async injectAction(playerId, act = {}) {
    const ask = [...this.asks.values()].find((a) => a.playerId === playerId);
    if (ask) this.acceptAction(ask, act);
    await this.pump();
    return { ok: true };
  }

  appendThought(playerId, text) {
    const p = this.byId(playerId);
    if (!p) return false;
    const piece = String(text == null ? '' : text).slice(0, 500);
    if (!piece) return false;
    p.thought = (p.thought + piece).slice(0, 2000);
    p.lastSeen = Date.now();
    this.emit({ t: 'thought', playerId, delta: piece });
    return true;
  }

  touch(playerId) {
    const p = this.byId(playerId);
    if (p) p.lastSeen = Date.now();
  }

  decorateFx(ev) {
    if (!ev || typeof ev !== 'object' || ev.fx) return ev;
    const kind = FX_KIND[ev.t];
    if (!kind) return ev;
    const fx = { kind };
    for (const key of ['playerId', 'targetId', 'bid', 'amount', 'cardId', 'cardLabel', 'word', 'number', 'tally', 'approved', 'role', 'lied']) {
      if (ev[key] !== undefined) fx[key] = ev[key];
    }
    return { ...ev, fx };
  }

  pushLog(text) {
    if (!text) return;
    this.log.push({ at: Date.now(), text: String(text).slice(0, 300) });
    if (this.log.length > 120) this.log.shift();
  }

  // 超时只记录 deadline，真实计时由 roomStore 惰性检查；这里保留空实现防止插件调用报错
  clearTimer() {}

  clearAllTimers() { this.timers.clear(); }

  armTimeout() {}

  /* ---------------- 单 ask ---------------- */

  async *askFor(player, kind, payload = {}, context = {}) {
    const act = yield* this.askMany([player], kind, () => payload, () => context);
    return act[player.id] || {};
  }

  /* ---------------- 多 ask（同一 batch） ---------------- */

  async *askMany(players, kind, payloadOf = () => ({}), contextOf = () => ({}), meta = {}) {
    const batchId = `b${(this.askSeq += 1)}`;
    const results = {};
    const live = [];

    for (const player of players) {
      if (!player || !player.alive) continue;
      if (player.kind === 'bot') {
        const payload = payloadOf(player);
        const context = contextOf(player);
        const thought = this.botThought(player, kind, payload, context);
        if (thought) yield { t: 'thought', playerId: player.id, delta: thought };
        const act = this.botAct(player, { kind, payload, context }, this) || {};
        if (act.say) yield { t: 'say', playerId: player.id, text: act.say };
        results[player.id] = act;
        continue;
      }
      const ask = {
        id: `a${(this.askSeq += 1)}`,
        batchId,
        playerId: player.id,
        kind,
        payload: payloadOf(player),
        context: contextOf(player),
        deadline: Date.now() + this.askTimeoutMs,
        ...meta,
      };
      this.asks.set(ask.id, ask);
      live.push(ask);
    }

    if (!live.length) return results;

    this.ask = live[0];
    yield { t: 'ask', asks: live, ask: live[0], pause: true };

    for (const ask of live) {
      results[ask.playerId] = ask.result || {};
    }
    return results;
  }

  askForPlayer(playerId) {
    return [...this.asks.values()].find((a) => a.playerId === playerId) || null;
  }

  /* ---------------- 插件钩子（可覆盖） ---------------- */

  validate(ask, act) {
    if (!act || typeof act !== 'object' || !act.action) return '缺少 action 字段';
    return null;
  }

  // 超时 / 跳过时的默认动作（沿用 legacy autoAct 逻辑）
  autoActionFor(ask) {
    return this.autoAct(ask);
  }

  autoAct(ask) {
    if (ask.kind === 'free') return { action: { type: 'text', text: '……' } };
    if (ask.kind === 'confirm') return { action: { type: 'confirm', use: true } };
    if (ask.kind === 'vote') {
      const cands = ask.payload?.candidates || [];
      if (cands.length) return { action: { type: 'vote', targetId: cands[0] } };
      return { action: { type: 'vote', approve: false } };
    }
    if (ask.kind === 'multi-pick') {
      const ids = (ask.payload?.candidates || []).slice(0, ask.payload?.min || 1);
      return { action: { type: 'pick-many', ids } };
    }
    if (ask.kind === 'bet') return { action: { type: 'bet', move: 'fold' } };
    if (ask.kind === 'play-card') return { action: { type: 'draw' } };
    return { action: { type: 'pass' } };
  }

  botThought() { return ''; }

  botAct(player, ask) {
    return this.autoAct(ask);
  }

  secretOf() { return null; }

  tableState() { return { title: '', rows: [], note: '' }; }

  renderBrief() { return null; }

  /* ---------------- 状态 ---------------- */

  publicState() {
    const asks = [...this.asks.values()];
    return {
      roomId: null,
      gameType: this.gameType,
      gameTitle: this.gameTitle || this.gameType,
      status: this.status,
      phase: this.phase,
      round: this.round,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        title: p.title,
        model: p.model || '',
        brand: p.brand || 'unknown',
        avatarUrl: p.avatarUrl || '',
        glyph: p.glyph,
        hue: p.hue,
        alive: p.alive,
        hp: p.hp,
        maxHp: p.maxHp,
        items: p.items.slice(),
        handCount: p.hand.length,
        diceCount: p.dice.length,
        chips: p.chips,
        team: p.teamPublic ? p.team : null,
        role: p.rolePublic ? p.role : null,
        folded: p.folded,
        caught: p.caught,
        says: p.say || '',
        connected: p.kind !== 'agent' || Date.now() - (p.lastSeen || 0) < 90000,
      })),
      turnPlayerId: this.ask ? this.ask.playerId : null,
      askPlayerId: asks[0]?.playerId ?? null,
      askPlayerIds: asks.map((a) => a.playerId),
      askKind: asks[0]?.kind ?? null,
      askDeadline: asks[0]?.deadline ?? null,
      table: this.tableState(),
      log: this.log.slice(-40),
      winner: this.winner ? { id: this.winner.id ?? 'none', name: this.winner.name ?? '无人' } : null,
      seats: this.seats,
      filled: this.players.length,
      askTimeoutMs: this.askTimeoutMs,
    };
  }

  selfState(p) {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      glyph: p.glyph,
      hp: p.hp,
      maxHp: p.maxHp,
      items: p.items.slice(),
      hand: p.hand.slice(),
      dice: p.dice.slice(),
      chips: p.chips,
      alive: p.alive,
      team: p.team,
      role: p.rolePublic ? p.role : (p.team ? `${p.team}` : null),
      caught: p.caught,
      secret: p.alive ? this.secretOf(p) : null,
    };
  }

  finish(winner = null) {
    this.status = 'ended';
    this.finished = true;
    this.phase = 'ended';
    this.winner = winner && winner.id ? winner : (winner ? { id: 'none', name: String(winner) } : null);
    this.clearAllTimers();
    this.asks.clear();
    this.ask = null;
  }
}
