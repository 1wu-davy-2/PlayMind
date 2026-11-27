// BOMB TABLE 游戏引擎 v2
// 关键变化：引擎不自己"思考"——需要决策时挂起，等外部 Agent 通过 HTTP 提交 action。
import {
  CARD_META, ITEM_META, DECK_RECIPE, MAX_HP, MAX_ITEMS, SEAT_PRESETS, GLYPHS, HUES,
} from './data.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 演出节奏：默认按剧本停顿，便于观看；BT_PACE=0 时全速推进，给自动化测试用
const PACE = process.env.BT_PACE === '0' ? 0 : 1;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function buildDeck() {
  const deck = [];
  for (const [k, n] of Object.entries(DECK_RECIPE)) {
    for (let i = 0; i < n; i += 1) deck.push(k);
  }
  return shuffle(deck);
}

export class Game {
  constructor({ seats = 4, askTimeoutMs = 120000, emit = () => {} }) {
    this.seats = Math.max(2, Math.min(6, seats));
    this.askTimeoutMs = askTimeoutMs;
    this.emit = emit;

    this.players = [];
    this.deck = [];
    this.discard = [];
    this.round = 1;
    this.turnIdx = 0;
    this.askSeq = 0;

    this.status = 'lobby';
    this.ask = null;
    this.pending = null;
    this.vote = null;
    this.voteCount = 0;
    this.winner = null;
    this.timer = null;
    this.pumping = false;
    this.finished = false;
    this.gen = null;
  }

  /* ================= 座位 ================= */

  addPlayer({ name, kind = 'agent', token = null, style = '', title = '', model = '', brand = 'unknown', avatarUrl = '' }) {
    if (this.players.length >= this.seats) return { error: '房间已满' };
    const n = this.players.length;
    const preset = SEAT_PRESETS[(Math.max(0, n - 1)) % SEAT_PRESETS.length];
    const p = {
      id: `p${n}`,
      name: String(name || `玩家${n}`).slice(0, 12),
      kind,
      token,
      style: String(style || '').slice(0, 120),
      model: String(model || '').slice(0, 80),
      brand: String(brand || 'unknown').slice(0, 24),
      avatarUrl: String(avatarUrl || '').slice(0, 300),
      title: title || (kind === 'human' ? '唯一的真人' : kind === 'bot' ? '内置代打' : '外部 Agent'),
      glyph: kind === 'human' ? '★' : GLYPHS[(Math.max(0, n - 1)) % GLYPHS.length],
      hue: kind === 'human' ? 205 : HUES[(Math.max(0, n - 1)) % HUES.length],
      hp: MAX_HP,
      items: [],
      alive: true,
      say: '',
      thought: '',
      caught: 0,
      lastSeen: 0,
      deceit: preset?.deceit ?? 0.4,
      aggression: preset?.aggression ?? 0.5,
    };
    this.players.push(p);
    return p;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  byToken(t) { return t ? this.players.find((p) => p.token === t) : null; }
  get current() { return this.players[this.turnIdx]; }
  get aliveList() { return this.players.filter((p) => p.alive); }
  othersOf(p) { return this.aliveList.filter((x) => x.id !== p.id); }

  /* ================= 开局 ================= */

  async start() {
    if (this.status !== 'lobby') return { error: '已经开局' };
    if (this.players.length < 2) return { error: '至少需要 2 名玩家' };

    let k = 0;
    while (this.players.length < this.seats) {
      const preset = SEAT_PRESETS[k % SEAT_PRESETS.length];
      const used = new Set(this.players.map((p) => p.name));
      const name = used.has(preset.name) ? `${preset.name}Ⅱ` : preset.name;
      this.addPlayer({ name, kind: 'bot', title: preset.title });
      k += 1;
    }

    this.deck = buildDeck();
    this.status = 'playing';
    this.gen = this.drive();
    await this.pump();
    return { ok: true };
  }

  /* ================= 推进 ================= */

  async pump() {
    if (this.pumping || this.finished || !this.gen) return;
    this.pumping = true;
    try {
      while (true) {
        if (this.finished) break;
        const { value, done } = await this.gen.next();
        if (done) { this.finished = true; break; }
        if (!value) continue;
        this.emit(value);
        if (value.pause) break;
        if (value.wait && PACE) await sleep(value.wait);
      }
    } finally {
      this.pumping = false;
    }
  }

  submit(playerId, act) {
    if (!this.ask) return { ok: false, error: '当前没有待决策的事项' };
    if (this.ask.playerId !== playerId) return { ok: false, error: '现在不是你的回合' };
    const err = validateAction(this.ask, act, this);
    if (err) return { ok: false, error: err };

    const p = this.byId(playerId);
    this.clearTimer();

    if (act.thought && !p.thought) {
      this.emit({ t: 'thought', playerId, delta: String(act.thought).slice(0, 600) });
    }
    if (p.thought) this.emit({ t: 'thought-end', playerId });
    p.thought = '';
    p.say = act.say ? String(act.say).slice(0, 120) : '';
    p.lastSeen = Date.now();

    this.pending = act;
    this.ask = null;
    this.pump().catch((e) => this.emit({ t: 'error', message: String((e && e.message) || e) }));
    return { ok: true };
  }

  appendThought(playerId, text) {
    const p = this.byId(playerId);
    if (!p) return false;
    const piece = String(text == null ? '' : text).slice(0, 400);
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

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  armTimeout(ask) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (!this.ask || this.ask.id !== ask.id) return;
      this.emit({ t: 'timeout', playerId: ask.playerId, kind: ask.kind });
      const r = this.submit(ask.playerId, autoAction(ask, this));
      if (!r.ok) this.emit({ t: 'error', message: r.error });
    }, this.askTimeoutMs);
  }

  /* ================= 向某个玩家要决策 ================= */

  async *askFor(player, kind, payload, context) {
    // 内置 bot 不挂起，直接代打并投屏一段思考
    if (player.kind === 'bot') {
      const thought = botThought(player, kind, payload, context, this);
      yield { t: 'thought', playerId: player.id, delta: thought };
      yield { t: 'thought-end', playerId: player.id, wait: 300 };
      const act = botAction(player, kind, payload, context, this);
      if (act.say) yield { t: 'say', playerId: player.id, text: act.say, wait: 200 };
      return act;
    }

    const ask = {
      id: `a${(this.askSeq += 1)}`,
      playerId: player.id,
      kind,
      payload,
      context,
      deadline: Date.now() + this.askTimeoutMs,
    };
    this.ask = ask;
    this.armTimeout(ask);
    yield { t: 'ask', ask, pause: true };

    const act = this.pending || {};
    this.pending = null;
    return act;
  }

  /* ================= 主循环 ================= */

  async *drive() {
    yield {
      t: 'begin',
      seats: this.players.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      wait: 240,
    };

    while (!this.winner) {
      const p = this.current;
      if (!p.alive) { this.nextTurn(); continue; }

      yield { t: 'turn', playerId: p.id, round: this.round, wait: 280 };

      yield* this.drawPhase(p);
      if (this.winner) break;

      this.nextTurn();
      yield { t: 'tick', wait: 140 };
    }

    yield { t: 'end', winnerId: this.winner?.id ?? 'none', winnerName: this.winner?.name ?? '无人', wait: 0 };
  }

  /* 牌堆空了：先问要不要停战，不散场就重洗。返回 true 表示牌局已结束 */
  async *ensureDeck() {
    if (this.deck.length > 0) return false;
    const settled = yield* this.peaceVote();
    if (settled || this.winner) return true;
    this.deck = shuffle(this.discard);
    this.discard = [];
    yield { t: 'reshuffle', deckLeft: this.deck.length, wait: 300 };
    return false;
  }

  async *drawPhase(p) {
    if (yield* this.ensureDeck()) return;

    const bombRate = this.deck.length
      ? Number((this.deck.filter((c) => c === 'bomb').length / this.deck.length).toFixed(3)) : 0;

    const act = yield* this.askFor(p, 'draw', {
      items: p.items.slice(),
      deckLeft: this.deck.length,
      bombsLeft: this.deck.filter((c) => c === 'bomb').length,
      bombRate,
      candidates: this.othersOf(p).map((o) => o.id),
    }, { bombRate });

    const action = act.action || {};
    if (action.type === 'use' && action.item === 'xray' && p.items.includes('xray')) {
      yield* this.doXray(p);
    } else if (action.type === 'use' && action.item === 'swap' && p.items.includes('swap')) {
      const t = this.byId(action.targetId);
      if (t && t.alive && t.id !== p.id) {
        p.items.splice(p.items.indexOf('swap'), 1);
        yield { t: 'item', playerId: p.id, item: 'swap', targetId: t.id, wait: 280 };
        this.turnIdx = this.players.indexOf(t);
        yield { t: 'handover', fromId: p.id, toId: t.id, wait: 240 };
      }
    }

    if (yield* this.ensureDeck()) return;
    const drawer = this.current;
    const card = this.deck.shift();
    this.discard.push(card);
    yield { t: 'draw', playerId: drawer.id, card, deckLeft: this.deck.length, wait: 360 };
    yield* this.resolveCard(drawer, card, 0);
  }

  /* ============ 牌堆耗尽：停战投票 ============ */

  async *peaceVote() {
    const alive = this.aliveList;
    if (alive.length <= 1) return false;

    const topHp = Math.max(...alive.map((x) => x.hp));
    const leaders = alive.filter((x) => x.hp === topHp);

    // 血量并列就没有唯一胜者，投票无意义，直接洗牌
    if (leaders.length > 1) {
      yield {
        t: 'vote-skip',
        reason: 'tie',
        topHp,
        names: leaders.map((x) => x.name),
        wait: 620,
      };
      return false;
    }

    // 连续投过 3 次都不同意，就别再问了
    if (this.voteCount >= 3) {
      yield { t: 'vote-skip', reason: 'tired', topHp, names: [leaders[0].name], wait: 420 };
      return false;
    }
    this.voteCount += 1;

    const threshold = Math.ceil((alive.length * 2) / 3);
    const proposal = {
      reason: 'deck-exhausted',
      leaderId: leaders[0].id,
      leaderName: leaders[0].name,
      topHp,
      aliveCount: alive.length,
      threshold,
    };
    this.vote = { proposal, votes: {} };

    yield { t: 'vote-start', proposal, alive: alive.map((x) => ({ id: x.id, name: x.name, hp: x.hp })), wait: 520 };

    for (const voter of alive) {
      const act = yield* this.askFor(voter, 'vote', {
        leaderId: proposal.leaderId,
        leaderName: proposal.leaderName,
        topHp,
        threshold,
        aliveCount: alive.length,
        alive: alive.map((x) => ({ id: x.id, name: x.name, hp: x.hp })),
      }, { myHp: voter.hp, topHp });
      const accept = act.action ? act.action.accept === true : false;
      this.vote.votes[voter.id] = accept;
      yield {
        t: 'vote-cast',
        playerId: voter.id,
        accept,
        yes: Object.values(this.vote.votes).filter(Boolean).length,
        cast: Object.keys(this.vote.votes).length,
        total: alive.length,
        wait: 240,
      };
    }

    const yes = Object.values(this.vote.votes).filter(Boolean).length;
    const passed = yes >= threshold;
    yield {
      t: 'vote-result',
      passed,
      yes,
      no: alive.length - yes,
      total: alive.length,
      threshold,
      leaderId: proposal.leaderId,
      leaderName: proposal.leaderName,
      votes: { ...this.vote.votes },
      wait: 620,
    };
    this.vote = null;

    if (passed) {
      const w = this.byId(proposal.leaderId);
      if (w && w.alive) {
        this.winner = w;
        this.status = 'ended';
        yield { t: 'settle', winnerId: w.id, winnerName: w.name, topHp, wait: 240 };
        return true;
      }
    }
    return false;
  }

  async *doXray(p) {
    p.items.splice(p.items.indexOf('xray'), 1);
    const top = this.deck.slice(0, 2);
    yield { t: 'item', playerId: p.id, item: 'xray' };
    yield { t: 'peek', playerId: p.id, secretFor: p.id, cards: top, wait: 240 };
  }

  /* ================= 卡牌结算 ================= */

  async *resolveCard(p, card, depth) {
    if (card === 'safe') {
      yield { t: 'resolve', playerId: p.id, card, text: '安全。什么都没发生。', wait: 300 };
      return;
    }

    if (card === 'supply') {
      const roll = Math.random();
      const item = roll < 0.55 ? 'defuse' : roll < 0.8 ? 'xray' : 'swap';
      let text;
      if (p.items.length >= MAX_ITEMS) {
        p.hp = Math.min(MAX_HP, p.hp + 1);
        text = '道具已满 · 回复 1 点生命';
      } else {
        p.items.push(item);
        text = `获得道具 · ${ITEM_META[item].label}`;
      }
      yield { t: 'resolve', playerId: p.id, card, text, item, wait: 320 };
      return;
    }

    if (card === 'bomb') {
      yield { t: 'resolve', playerId: p.id, card, text: '炸弹。', wait: 360 };

      if (p.items.includes('defuse')) {
        const act = yield* this.askFor(p, 'defuse', {}, {});
        const use = act.action ? act.action.use !== false : true;
        if (use) {
          p.items.splice(p.items.indexOf('defuse'), 1);
          yield { t: 'defused', playerId: p.id, wait: 300 };
          return;
        }
      }
      yield* this.hit(p, 1, 'bomb');
      return;
    }

    if (card === 'question') {
      if (depth >= 2) {
        yield { t: 'resolve', playerId: p.id, card, text: '连续质询断链 · 本轮作废', wait: 280 };
        return;
      }
      yield { t: 'resolve', playerId: p.id, card, text: '质询 · 他要指定一个人', wait: 320 };
      yield* this.runInterrogation(p, depth);
    }
  }

  async *hit(p, amount, cause) {
    p.hp = Math.max(0, p.hp - amount);
    if (p.hp === 0) p.alive = false;
    yield { t: 'damage', playerId: p.id, amount, cause, hp: p.hp, wait: 400 };
    if (!p.alive) {
      yield { t: 'eliminate', playerId: p.id, wait: 360 };
      this.checkWin();
    }
  }

  /* ================= 质询 ================= */

  async *runInterrogation(drawer, depth) {
    const foes = this.othersOf(drawer);
    if (!foes.length) return;

    const pickAct = yield* this.askFor(drawer, 'pick-target', {
      candidates: foes.map((f) => f.id),
    }, {
      foes: foes.map((f) => ({ id: f.id, name: f.name, hp: f.hp, caught: f.caught })),
    });
    let target = foes.find((f) => f.id === pickAct.action?.targetId);
    if (!target) target = foes[0];

    yield { t: 'target', drawerId: drawer.id, targetId: target.id, wait: 300 };

    const top = this.deck[0] ?? 'safe';
    yield { t: 'intel', playerId: target.id, secretFor: target.id, card: top, wait: 360 };

    const ansAct = yield* this.askFor(target, 'answer', {
      drawerId: drawer.id,
      drawerName: drawer.name,
    }, {
      secret: { topCard: top },
      drawer: { id: drawer.id, name: drawer.name, hp: drawer.hp },
    });

    const claim = ansAct.action?.claim === 'bomb' ? 'bomb' : 'safe';
    const say = ansAct.say || (claim === 'bomb' ? '是炸弹。' : '不是。');
    const lied = (claim === 'bomb') !== (top === 'bomb');

    yield { t: 'say', playerId: target.id, text: say, wait: 360 };

    const verAct = yield* this.askFor(drawer, 'verdict', {
      targetId: target.id,
      targetName: target.name,
      claim,
      say,
    }, {
      target: { id: target.id, name: target.name, hp: target.hp, caught: target.caught },
      bombRate: this.deck.length
        ? Number((this.deck.filter((c) => c === 'bomb').length / this.deck.length).toFixed(3)) : 0,
    });
    const decision = verAct.action?.decision === 'accuse' ? 'accuse' : 'trust';

    yield { t: 'verdict', drawerId: drawer.id, targetId: target.id, decision, wait: 300 };

    if (lied) target.caught += 1;
    yield {
      t: 'truth',
      targetId: target.id,
      drawerId: drawer.id,
      actualCard: top,
      claim,
      lied,
      decision,
      note: ansAct.action?.note || '',
      wait: 620,
    };

    if (decision === 'trust') {
      if (yield* this.ensureDeck()) return;
      const next = this.deck.shift();
      this.discard.push(next);
      yield { t: 'draw', playerId: drawer.id, card: next, deckLeft: this.deck.length, chained: true, wait: 320 };
      yield* this.resolveCard(drawer, next, depth + 1);
      return;
    }

    if (lied) {
      if (drawer.items.length < MAX_ITEMS) drawer.items.push('defuse');
      yield { t: 'caught', targetId: target.id, drawerId: drawer.id, wait: 280 };
      yield* this.hit(target, 1, 'caught');
    } else {
      yield { t: 'wrong', drawerId: drawer.id, targetId: target.id, wait: 280 };
      yield* this.hit(drawer, 1, 'wrong-accusation');
    }
  }

  /* ================= 轮转与胜负 ================= */

  nextTurn() {
    const n = this.players.length;
    const prev = this.turnIdx;
    for (let i = 1; i <= n; i += 1) {
      const idx = (this.turnIdx + i) % n;
      if (this.players[idx].alive) {
        if (idx <= prev) this.round += 1;
        this.turnIdx = idx;
        break;
      }
    }
    this.checkWin();
  }

  checkWin() {
    const alive = this.aliveList;
    if (alive.length === 1) this.winner = alive[0];
    else if (alive.length === 0) this.winner = { id: 'none', name: '无人' };
    if (this.winner && this.status === 'playing') this.status = 'ended';
    return this.winner;
  }

  /* ================= 快照 ================= */

  publicState() {
    return {
      roomId: null,
      status: this.status,
      round: this.round,
      deckLeft: this.deck.length,
      bombsLeft: this.deck.filter((c) => c === 'bomb').length,
      turnPlayerId: this.current?.id ?? null,
      askPlayerId: this.ask?.playerId ?? null,
      askKind: this.ask?.kind ?? null,
      askDeadline: this.ask?.deadline ?? null,
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
        hp: p.hp,
        maxHp: MAX_HP,
        items: p.items.slice(),
        alive: p.alive,
        caught: p.caught,
        says: p.say || '',
        connected: p.kind !== 'agent' || Date.now() - (p.lastSeen || 0) < 90000,
      })),
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      vote: this.vote
        ? { proposal: this.vote.proposal, votes: { ...this.vote.votes } }
        : null,
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
      model: p.model || '',
      brand: p.brand || 'unknown',
      avatarUrl: p.avatarUrl || '',
      hp: p.hp,
      maxHp: MAX_HP,
      items: p.items.slice(),
      alive: p.alive,
      caught: p.caught,
      secret: null,
    };
  }
}

/* ================= action 校验 ================= */

function validateAction(ask, act, game) {
  const a = act && act.action;
  if (!a || typeof a !== 'object') return '缺少 action 字段';
  const t = a.type;
  switch (ask.kind) {
    case 'draw':
      if (t === 'draw') return null;
      if (t === 'use') {
        if (!['xray', 'swap'].includes(a.item)) return 'item 只能是 xray 或 swap';
        const p = game.byId(ask.playerId);
        if (!p.items.includes(a.item)) return `你手上没有 ${a.item}`;
        if (a.item === 'swap' && !ask.payload.candidates.includes(a.targetId)) return 'targetId 不在候选里';
        return null;
      }
      return 'draw 阶段的 action.type 只能是 draw 或 use';
    case 'defuse':
      if (t !== 'defuse' || typeof a.use !== 'boolean') return '需要 {"type":"defuse","use":true|false}';
      return null;
    case 'pick-target':
      if (t !== 'pick' || !ask.payload.candidates.includes(a.targetId)) return '需要 {"type":"pick","targetId":"<候选 id>"}';
      return null;
    case 'answer':
      if (t !== 'answer' || !['bomb', 'safe'].includes(a.claim)) return '需要 {"type":"answer","claim":"bomb"|"safe"}';
      return null;
    case 'verdict':
      if (t !== 'verdict' || !['trust', 'accuse'].includes(a.decision)) return '需要 {"type":"verdict","decision":"trust"|"accuse"}';
      return null;
    case 'vote':
      if (t !== 'vote' || typeof a.accept !== 'boolean') return '需要 {"type":"vote","accept":true|false}';
      return null;
    default:
      return '未知的 ask 类型';
  }
}

/* ================= 超时代打 ================= */

function autoAction(ask) {
  switch (ask.kind) {
    case 'draw': return { thought: '（超时代打）', action: { type: 'draw' } };
    case 'defuse': return { thought: '（超时代打）', action: { type: 'defuse', use: true } };
    case 'pick-target':
      return { thought: '（超时代打）', action: { type: 'pick', targetId: ask.payload.candidates[0] } };
    case 'answer': {
      const top = ask.context?.secret?.topCard;
      const claim = top === 'bomb' ? 'bomb' : 'safe';
      return { say: claim === 'bomb' ? '是炸弹。' : '不是。', action: { type: 'answer', claim } };
    }
    case 'verdict':
      return { say: '我信你。', action: { type: 'verdict', decision: 'trust' } };
    case 'vote':
      return { thought: '（超时代打 · 保持现状）', action: { type: 'vote', accept: false } };
    default: return { action: { type: 'draw' } };
  }
}

/* ================= 内置 bot ================= */

function botThought(p, kind, payload, context, game) {
  const bombs = game.deck.filter((c) => c === 'bomb').length;
  const rate = game.deck.length ? Math.round((bombs / game.deck.length) * 100) : 0;
  if (kind === 'draw') {
    return `${game.deck.length} 张牌，炸弹 ${bombs} 张。${rate > 40 ? '这一手不干净。' : '还在能赌的范围里。'}`;
  }
  if (kind === 'pick-target') {
    const t = game.byId(payload.candidates[0]);
    return `挑 ${t?.name ?? '?'}。他 ${t?.hp ?? 0} 点血，被抓过 ${t?.caught ?? 0} 次。`;
  }
  if (kind === 'answer') {
    return context?.secret?.topCard === 'bomb' && Math.random() < p.deceit
      ? '他希望我说安全。我给他一个能让他下决心的答案。'
      : '说实话，换他下回信我。';
  }
  if (kind === 'vote') {
    const gap = (payload.topHp ?? 0) - p.hp;
    return gap <= 0
      ? `牌堆打空了。我领先 ${gap === 0 ? '所有人' : `${-gap} 点`}，到此为止吧。`
      : `牌堆打空了。我还差 ${gap} 点，凭什么收手。`;
  }
  return Math.random() < p.aggression
    ? '太顺了。人紧张的时候不会把话说这么圆。'
    : '指控错了要掉血。这赌注不值。';
}

function botAction(p, kind, payload, context, game) {
  if (kind === 'draw') {
    const bombs = game.deck.filter((c) => c === 'bomb').length;
    const rate = game.deck.length ? bombs / game.deck.length : 0;
    if (p.items.includes('xray') && rate > 0.3) return { action: { type: 'use', item: 'xray' } };
    if (p.items.includes('swap') && rate > 0.45) {
      const foes = game.othersOf(p).filter((f) => f.hp > 0);
      if (foes.length) {
        const t = foes.reduce((a, b) => (a.hp <= b.hp ? a : b));
        return { action: { type: 'use', item: 'swap', targetId: t.id } };
      }
    }
    return { action: { type: 'draw' } };
  }
  if (kind === 'defuse') return { action: { type: 'defuse', use: true } };
  if (kind === 'pick-target') {
    const foes = payload.candidates.map((id) => game.byId(id)).filter(Boolean);
    const t = foes.sort((a, b) => (a.hp - b.hp) || (b.caught - a.caught))[0];
    return { say: `${t.name}，你过来。`, action: { type: 'pick', targetId: t.id } };
  }
  if (kind === 'answer') {
    const top = context?.secret?.topCard;
    const lie = top === 'bomb' ? Math.random() < p.deceit * 0.95 : Math.random() < 0.06;
    const claim = lie ? (top === 'bomb' ? 'safe' : 'bomb') : (top === 'bomb' ? 'bomb' : 'safe');
    const say = claim === 'bomb' ? '是炸弹。' : '不是炸弹。';
    return { say, action: { type: 'answer', claim, note: lie ? '我在骗他。' : '' } };
  }
  if (kind === 'vote') {
    const gap = (payload.topHp ?? 0) - p.hp;
    const accept = gap <= 0 || (gap >= 2 && Math.random() < 0.5);
    return {
      say: accept ? '我同意收手。' : '再来一副。',
      action: { type: 'vote', accept },
    };
  }
  const accuse = payload.claim === 'safe'
    ? Math.random() < 0.3 + p.aggression * 0.4
    : Math.random() < 0.1;
  return {
    say: accuse ? '你在骗我。' : '行，我信你一次。',
    action: { type: 'verdict', decision: accuse ? 'accuse' : 'trust' },
  };
}
