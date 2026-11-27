// 德州扑克：盲注 10/20，四轮下注，7 选 5 牌力比较。不做边池（all-in 按可跟注上限封顶）。
import { GameBase, shuffle } from '../base.mjs';
import { renderBriefBase } from '../brief-kit.mjs';

const SUITS = [
  { s: 's', name: '♠' },
  { s: 'h', name: '♥' },
  { s: 'd', name: '♦' },
  { s: 'c', name: '♣' },
];
const SUIT_LABEL = Object.fromEntries(SUITS.map((x) => [x.s, x.name]));
const RANK_LABEL = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const SB = 10;
const BB = 20;
const START_CHIPS = 1000;
const MAX_RAISES_PER_STREET = 4;
const MAX_HANDS = 90;

const cardLabel = (c) => `${RANK_LABEL[c.r]}${SUIT_LABEL[c.s]}`;
const cardsLabel = (cs) => (cs && cs.length ? cs.map(cardLabel).join(' ') : '—');

const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function buildDeck() {
  const deck = [];
  for (const su of SUITS) {
    for (const r of RANKS) deck.push({ s: su.s, r, v: r });
  }
  return deck;
}

/* ---------------- 牌力评估 ---------------- */

function evalFive(cards) {
  const vs = cards.map((c) => c.v).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(vs)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A2345
  }
  const cnt = new Map();
  for (const v of vs) cnt.set(v, (cnt.get(v) || 0) + 1);
  const groups = [...cnt.entries()]
    .map(([v, n]) => ({ v, n }))
    .sort((a, b) => b.n - a.n || b.v - a.v);

  if (flush && straightHigh) return { cat: 8, tie: [straightHigh] };
  if (groups[0].n === 4) return { cat: 7, tie: [groups[0].v, groups[1].v] };
  if (groups[0].n === 3 && groups[1].n === 2) return { cat: 6, tie: [groups[0].v, groups[1].v] };
  if (flush) return { cat: 5, tie: vs };
  if (straightHigh) return { cat: 4, tie: [straightHigh] };
  if (groups[0].n === 3) return { cat: 3, tie: [groups[0].v, groups[1].v, groups[2].v] };
  if (groups[0].n === 2 && groups[1].n === 2) return { cat: 2, tie: [groups[0].v, groups[1].v, groups[2].v] };
  if (groups[0].n === 2) return { cat: 1, tie: [groups[0].v, groups[1].v, groups[2].v, groups[3].v] };
  return { cat: 0, tie: vs };
}

function compareRank(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i += 1) {
    const x = a.tie[i] || 0;
    const y = b.tie[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 从 n 张牌里取 5 张的所有组合（n = 5/6/7）
function combos5(n) {
  const out = [];
  for (let a = 0; a < n - 4; a += 1) {
    for (let b = a + 1; b < n - 3; b += 1) {
      for (let c = b + 1; c < n - 2; c += 1) {
        for (let d = c + 1; d < n - 1; d += 1) {
          for (let e = d + 1; e < n; e += 1) out.push([a, b, c, d, e]);
        }
      }
    }
  }
  return out;
}

export function bestOf(cards) {
  const n = cards ? cards.length : 0;
  if (n < 5) return { cat: -1, tie: [] };
  let best = null;
  for (const idx of combos5(n)) {
    const r = evalFive(idx.map((i) => cards[i]));
    if (!best || compareRank(r, best) > 0) best = r;
  }
  return best;
}

export class Holdem extends GameBase {
  constructor(o = {}) {
    super({ ...o, gameType: 'holdem' });
    this.minSeats = 2;
    this.maxSeats = 6;
    this.gameTitle = '德州扑克';
    this.deck = [];
    this.board = [];
    this.pot = 0;
    this.street = 'preflop';
    this.streetBet = 0;
    this.raisesThisStreet = 0;
    this.buttonIdx = -1;
    this.handNo = 0;
    this.lastWinners = [];
  }

  setup() {
    this.fast = this.players.every((p) => p.kind === 'bot');
    this.players.forEach((p) => {
      p.chips = START_CHIPS;
      p.hand = [];
      p.folded = false;
      p.allin = false;
      p.bet = 0;
      p.totalBet = 0;
      p.acted = false;
      p.alive = true;
      p.meta.hands = 0;
      p.meta.won = 0;
    });
    this.buttonIdx = this.players.length - 1;
    this.handNo = 0;
    this.phase = 'preflop';
  }

  get N() { return this.players.length; }

  nextSeatWithChips(from, { includeSelf = false } = {}) {
    const n = this.N;
    for (let k = includeSelf ? 0 : 1; k <= n; k += 1) {
      const idx = ((from + k) % n + n) % n;
      const p = this.players[idx];
      if (p && p.chips > 0) return idx;
    }
    return -1;
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    yield {
      t: 'begin',
      text: `德州扑克开始：${this.N} 人，每人 ${START_CHIPS} 筹码，盲注 ${SB}/${BB}。`,
      wait: 400,
    };

    while (true) {
      const alive = this.players.filter((p) => p.chips > 0);
      if (alive.length <= 1) {
        const w = alive[0] || null;
        yield {
          t: 'end',
          winnerId: w?.id || 'none',
          winnerName: w?.name || '无人',
          text: w ? `${w.name} 赢下了所有筹码。` : '无人完成牌局。',
          wait: 300,
        };
        this.finish(w || { id: 'none', name: '无人' });
        return;
      }

      if (this.handNo >= MAX_HANDS) {
        const chipLeader = alive.slice().sort((a, b) => b.chips - a.chips)[0];
        yield {
          t: 'end',
          winnerId: chipLeader.id,
          winnerName: chipLeader.name,
          text: `达到 ${MAX_HANDS} 手上限，筹码领先的 ${chipLeader.name} 获胜（${chipLeader.chips}）。`,
          wait: 300,
        };
        this.finish(chipLeader);
        return;
      }

      this.handNo += 1;
      this.buttonIdx = this.nextSeatWithChips(this.buttonIdx);
      this.startHand();

      yield {
        t: 'hand',
        handNo: this.handNo,
        buttonId: this.players[this.buttonIdx]?.id,
        text: `第 ${this.handNo} 手：按钮 ${this.players[this.buttonIdx]?.name}，盲注 ${SB}/${BB}。`,
        wait: 260,
      };

      yield* this.playHand();
      if (this.status === 'ended') return;
      yield* this.settleHand();
      if (this.status === 'ended') return;
    }
  }

  startHand() {
    this.deck = shuffle(buildDeck(), () => this.rng());
    this.board = [];
    this.pot = 0;
    this.streetBet = 0;
    this.street = 'preflop';
    this.raisesThisStreet = 0;
    this.lastWinners = [];

    for (const p of this.players) {
      p.folded = p.chips <= 0;
      p.allin = false;
      p.bet = 0;
      p.totalBet = 0;
      p.acted = false;
      p.hand = [];
      if (!p.folded) {
        p.meta.hands = (p.meta.hands || 0) + 1;
        p.hand.push(this.deck.pop(), this.deck.pop());
      }
    }

    const sbIdx = this.nextSeatWithChips(this.buttonIdx);
    const bbIdx = this.nextSeatWithChips(sbIdx);
    this.sbIdx = sbIdx;
    this.bbIdx = bbIdx;
    this.postBlind(this.players[sbIdx], SB);
    this.postBlind(this.players[bbIdx], BB);
    this.streetBet = Math.max(this.players[sbIdx]?.bet || 0, this.players[bbIdx]?.bet || 0);
    this.preflopStart = this.nextSeatAfter(bbIdx);
  }

  postBlind(p, amt) {
    if (!p) return;
    const pay = Math.min(amt, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.totalBet += pay;
    this.pot += pay;
    if (p.chips === 0) p.allin = true;
  }

  commit(p, amount) {
    const pay = Math.max(0, Math.min(amount, p.chips));
    p.chips -= pay;
    p.bet += pay;
    p.totalBet += pay;
    this.pot += pay;
    if (p.chips === 0) p.allin = true;
    return pay;
  }

  contenders() { return this.players.filter((p) => !p.folded); }

  async *playHand() {
    let result = yield* this.bettingRound('preflop', this.preflopStart);
    if (result === 'ended') { yield* this.showdown(); return; }

    const plan = [['flop', 3], ['turn', 1], ['river', 1]];
    for (const [street, n] of plan) {
      this.deck.pop(); // 烧牌
      for (let i = 0; i < n; i += 1) this.board.push(this.deck.pop());
      this.street = street;
      this.streetBet = 0;
      this.raisesThisStreet = 0;
      this.players.forEach((p) => { p.bet = 0; p.acted = false; });
      this.phase = street;

      yield {
        t: 'street',
        street,
        board: this.board.slice(),
        boardLabel: cardsLabel(this.board),
        text: `${street === 'flop' ? '翻牌' : street === 'turn' ? '转牌' : '河牌'}：${cardsLabel(this.board)}，底池 ${this.pot}。`,
        wait: 320,
      };
      yield {
        t: 'board',
        street,
        board: this.board.slice(),
        boardLabel: cardsLabel(this.board),
        text: `公共牌 ${this.board.length} 张：${cardsLabel(this.board)}。`,
      };

      result = yield* this.bettingRound(street, this.postflopStart());
      if (result === 'ended') { yield* this.showdown(); return; }

      if (this.contenders().every((p) => p.allin)) {
        // 全部 all-in：剩下的公共牌直接发完
        const rest = plan.slice(plan.findIndex(([s]) => s === street) + 1);
        for (const [s2, n2] of rest) {
          this.deck.pop();
          for (let i = 0; i < n2; i += 1) this.board.push(this.deck.pop());
          this.street = s2;
          this.phase = s2;
          yield {
            t: 'street',
            street: s2,
            board: this.board.slice(),
            boardLabel: cardsLabel(this.board),
            text: `全部 all-in，直接发${s2 === 'turn' ? '转牌' : '河牌'}：${cardsLabel(this.board)}，底池 ${this.pot}。`,
            wait: 320,
          };
          yield {
            t: 'board',
            street: s2,
            board: this.board.slice(),
            boardLabel: cardsLabel(this.board),
            text: `公共牌 ${this.board.length} 张：${cardsLabel(this.board)}。`,
          };
        }
        break;
      }
    }

    yield* this.showdown();
  }

  // 按钮左手第一个未弃牌的人（是否 all-in 由 findNextActor 跳过）
  nextSeatAfter(from) {
    for (let k = 1; k <= this.N; k += 1) {
      const idx = (from + k) % this.N;
      if (!this.players[idx].folded) return idx;
    }
    return -1;
  }

  postflopStart() {
    const idx = this.nextSeatAfter(this.buttonIdx);
    return idx >= 0 ? idx : 0;
  }

  findNextActor(from) {
    const n = this.N;
    for (let k = 0; k < n; k += 1) {
      const idx = ((from + k) % n + n) % n;
      const p = this.players[idx];
      if (!p || p.folded || p.allin) continue;
      if (!p.acted || p.bet < this.streetBet) return { p, idx };
    }
    return null;
  }

  legalMoves(p) {
    const toCall = Math.max(0, this.streetBet - p.bet);
    const maxTotal = p.bet + p.chips;
    const minRaise = this.streetBet + BB; // 规则锁定版：当前最高投入 + 大盲
    const legal = ['fold'];
    if (toCall === 0) legal.push('check');
    else legal.push('call');
    if (this.raisesThisStreet < MAX_RAISES_PER_STREET && maxTotal >= minRaise && maxTotal > this.streetBet) legal.push('raise');
    if (p.chips > 0) legal.push('allin');
    return { toCall, maxTotal, minRaise, legal };
  }

  async *bettingRound(street, startIdx) {
    this.street = street;
    this.players.forEach((p) => { if (!p.folded && !p.allin) p.acted = false; });
    let idx = Math.max(0, startIdx);
    let guard = 0;

    while (true) {
      guard += 1;
      if (guard > 300) break;

      const found = this.findNextActor(idx);
      if (!found) break;
      const { p } = found;
      const info = this.legalMoves(p);

      const act = yield* this.askFor(p, 'bet', {
        street,
        pot: this.pot,
        toCall: info.toCall,
        minRaise: info.minRaise,
        maxRaise: info.maxTotal,
        legal: info.legal,
        raisesLeft: MAX_RAISES_PER_STREET - this.raisesThisStreet,
        board: this.board.map(cardLabel),
        hole: p.hand.map((c) => ({ s: c.s, r: RANK_LABEL[c.r], label: cardLabel(c) })),
        players: this.players.map((x) => ({
          id: x.id,
          name: x.name,
          chips: x.chips,
          bet: x.bet,
          folded: x.folded,
          allin: x.allin,
        })),
      }, { handNo: this.handNo, buttonId: this.players[this.buttonIdx]?.id });

      const a = act.action || {};
      const move = info.legal.includes(a.move) ? a.move : 'fold';
      let say = act.say || '';
      let pay = 0;

      if (move === 'fold') {
        p.folded = true;
        p.acted = true;
      } else if (move === 'check') {
        p.acted = true;
      } else if (move === 'call') {
        pay = this.commit(p, info.toCall);
        p.acted = true;
        if (p.chips === 0) p.allin = true;
      } else if (move === 'raise') {
        let target = Math.floor(Number(a.amount) || 0);
        if (!Number.isFinite(target) || target < info.minRaise) target = info.minRaise;
        target = Math.min(target, info.maxTotal);
        const before = this.streetBet;
        pay = this.commit(p, target - p.bet);
        p.acted = true;
        if (p.bet > before) {
          this.streetBet = p.bet;
          this.raisesThisStreet += 1;
          for (const x of this.players) {
            if (x.id !== p.id && !x.folded && !x.allin) x.acted = false;
          }
        }
      } else if (move === 'allin') {
        const others = this.players.filter((x) => x.id !== p.id && !x.folded);
        const maxCover = others.length
          ? Math.max(...others.map((x) => x.chips + x.bet))
          : p.bet + p.chips;
        const targetTotal = Math.min(p.bet + p.chips, Math.max(this.streetBet, maxCover));
        const before = this.streetBet;
        pay = this.commit(p, targetTotal - p.bet);
        p.acted = true;
        p.allin = true; // 超出对手可跟注上限的部分直接留在手上（无边界池）
        if (p.bet > before) {
          this.streetBet = p.bet;
          this.raisesThisStreet += 1;
          for (const x of this.players) {
            if (x.id !== p.id && !x.folded && !x.allin) x.acted = false;
          }
        }
      }

      const moveLabel = {
        fold: '弃牌',
        check: '过牌',
        call: `跟注 ${pay}`,
        raise: `加注到 ${p.bet}`,
        allin: `全下 ${pay}`,
      }[move] || move;

      yield {
        t: 'action',
        playerId: p.id,
        street,
        move,
        amount: pay,
        bet: p.bet,
        pot: this.pot,
        chips: p.chips,
        text: `${p.name} ${moveLabel}${p.allin ? '（all-in）' : ''}。底池 ${this.pot}。`,
        log: `${p.name} ${moveLabel}`,
        say,
        wait: 140,
      };

      if (this.contenders().length <= 1) return 'ended';

      idx = (found.idx + 1) % this.N;
    }

    // 结算本街：清空投入计数（筹码已在 commit 时进底池）
    this.players.forEach((p) => { p.bet = 0; p.acted = false; });
    this.streetBet = 0;
    this.raisesThisStreet = 0;
    return 'ok';
  }

  /* ---------------- 摊牌与结算 ---------------- */

  async *showdown() {
    const list = this.contenders();
    if (list.length === 1) {
      const w = list[0];
      const amount = this.pot;
      w.chips += amount;
      w.meta.won = (w.meta.won || 0) + 1;
      this.lastWinners = [w];
      yield {
        t: 'win',
        playerId: w.id,
        amount,
        reason: 'fold',
        text: `其他人都弃牌，${w.name} 直接收下 ${amount} 的底池。`,
        log: `${w.name} 收池 ${amount}`,
        wait: 300,
      };
      this.pot = 0;
      return;
    }

    const scored = list.map((p) => {
      const rank = bestOf([...p.hand, ...this.board]);
      return { p, rank };
    });
    scored.sort((a, b) => compareRank(b.rank, a.rank));

    yield {
      t: 'showdown',
      board: this.board.slice(),
      boardLabel: cardsLabel(this.board),
      players: scored.map(({ p, rank }) => ({
        id: p.id,
        name: p.name,
        hole: p.hand.slice(),
        holeLabel: cardsLabel(p.hand),
        hand: HAND_NAMES[rank.cat] || '—',
        best: rank,
        chips: p.chips,
      })),
      text: `摊牌：${scored.map(({ p, rank }) => `${p.name} ${cardsLabel(p.hand)}（${HAND_NAMES[rank.cat]}）`).join('；')}。`,
      wait: 500,
    };

    const top = scored[0].rank;
    const winners = scored.filter((x) => compareRank(x.rank, top) === 0);
    const share = Math.floor(this.pot / winners.length);
    let rest = this.pot - share * winners.length;
    for (const w of winners) {
      const got = share + (rest > 0 ? 1 : 0);
      if (rest > 0) rest -= 1;
      w.p.chips += got;
      w.p.meta.won = (w.p.meta.won || 0) + 1;
    }
    this.lastWinners = winners.map((x) => x.p);

    yield {
      t: 'win',
      playerIds: winners.map((x) => x.p.id),
      amount: this.pot,
      reason: 'showdown',
      hand: HAND_NAMES[top.cat],
      text: winners.length > 1
        ? `平局：${winners.map((x) => x.p.name).join('、')} 平分 ${this.pot} 的底池（${HAND_NAMES[top.cat]}）。`
        : `${winners[0].p.name} 以 ${HAND_NAMES[top.cat]} 收下 ${this.pot} 的底池。`,
      log: `${winners.map((x) => x.p.name).join('、')} 收池 ${this.pot}`,
      wait: 360,
    };
    this.pot = 0;
  }

  async *settleHand() {
    this.players.forEach((p) => {
      p.folded = false;
      p.allin = false;
      p.bet = 0;
      p.acted = false;
      p.hand = [];
    });
    for (const p of this.players) {
      if (p.chips <= 0 && p.alive) {
        p.alive = false;
        yield {
          t: 'eliminate',
          playerId: p.id,
          text: `${p.name} 筹码归零，离桌。`,
          wait: 240,
        };
      }
    }
    const left = this.players.filter((p) => p.chips > 0);
    if (left.length <= 1) {
      yield {
        t: 'end',
        winnerId: left[0]?.id || 'none',
        winnerName: left[0]?.name || '无人',
        text: left[0] ? `${left[0].name} 成为最后的赢家。` : '牌局结束。',
        wait: 300,
      };
      this.finish(left[0] || { id: 'none', name: '无人' });
    }
  }

  /* ---------------- 校验 / 托管 / bot ---------------- */

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';
    if (ask.kind !== 'bet') return '未知的 ask 类型';
    if (a.type !== 'bet') return '需要 {"type":"bet","move":"call","amount":60}';
    const legal = ask.payload?.legal || [];
    if (!legal.includes(a.move)) return `本轮合法动作：${legal.join(' / ')}`;
    if (a.move === 'raise') {
      const amt = Number(a.amount);
      if (!Number.isFinite(amt)) return 'raise 必须在 amount 里给出本轮累计投入（不是增量）';
      if (amt < ask.payload.minRaise) return `加注至少到 ${ask.payload.minRaise}`;
      if (amt > ask.payload.maxRaise) return `你最多投入到 ${ask.payload.maxRaise}`;
    }
    return null;
  }

  autoAct(ask) {
    if (ask.kind === 'bet') {
      const legal = ask.payload?.legal || [];
      if (legal.includes('check')) return { action: { type: 'bet', move: 'check' } };
      if (legal.includes('call')) return { action: { type: 'bet', move: 'call' } };
      return { action: { type: 'bet', move: 'fold' } };
    }
    return super.autoAct(ask);
  }

  strengthOf(p) {
    if (!p.hand || p.hand.length < 2) return 0.2;
    if (this.board.length >= 3) {
      const rank = bestOf([...p.hand, ...this.board]);
      if (rank.cat >= 8) return 1;
      if (rank.cat === 7) return 0.98;
      if (rank.cat === 6) return 0.92;
      if (rank.cat === 5) return 0.82;
      if (rank.cat === 4) return 0.78;
      if (rank.cat === 3) return 0.66;
      if (rank.cat === 2) return 0.56;
      if (rank.cat === 1) return 0.42;
      return 0.18 + Math.max(0, (rank.tie[0] - 5) / 40);
    }
    const [a, b] = p.hand.map((c) => c.r).sort((x, y) => y - x);
    if (a === b) return a >= 10 ? 0.85 : 0.68;
    if (a >= 13 && b >= 11) return 0.62;
    if (a >= 11 && b >= 9) return 0.48;
    if (a >= 14) return 0.4;
    return 0.24;
  }

  botThought(p, kind, payload) {
    if (kind !== 'bet') return '';
    const s = Math.round(this.strengthOf(p) * 100);
    if (payload.toCall > 0) return `跟注要 ${payload.toCall}，底池 ${payload.pot}，我的牌力大概 ${s}%。`;
    return `没人下注，我的牌力大概 ${s}%。`;
  }

  botAct(p, ask) {
    const payload = ask.payload || {};
    const legal = payload.legal || [];
    const strength = this.strengthOf(p);
    const pot = payload.pot || 0;
    const toCall = payload.toCall || 0;
    const canRaise = legal.includes('raise') && payload.raisesLeft > 0;
    const maxRaise = payload.maxRaise || 0;
    const minRaise = payload.minRaise || 0;

    // 短码：拿着像样的牌就推
    if (p.chips <= 140 && legal.includes('allin') && (strength >= 0.42 || this.rng() < 0.12)) {
      return { action: { type: 'bet', move: 'allin' }, say: '短码了，我推。' };
    }

    const raiseTo = (fraction) => {
      const raw = this.streetBet + Math.max(BB, Math.round((pot * fraction) / 10) * 10);
      const amt = Math.min(Math.max(raw, minRaise), maxRaise);
      return amt >= minRaise ? amt : null;
    };

    if (toCall === 0) {
      if (canRaise && strength >= 0.45) {
        const amt = raiseTo(0.7);
        if (amt) return { action: { type: 'bet', move: 'raise', amount: amt }, say: '我下注。' };
      }
      if (canRaise && strength <= 0.3 && this.rng() < 0.1) {
        const amt = raiseTo(0.5);
        if (amt) return { action: { type: 'bet', move: 'raise', amount: amt }, say: '试试你的胆量。' };
      }
      return { action: { type: 'bet', move: 'check' } };
    }

    const potOdds = toCall / Math.max(1, pot + toCall);
    if (canRaise && strength >= 0.8 && this.rng() < 0.6) {
      const amt = raiseTo(0.9);
      if (amt) return { action: { type: 'bet', move: 'raise', amount: amt }, say: '加注。' };
    }
    if (strength >= 0.4 || toCall <= p.chips * 0.05 || strength > potOdds + 0.15) {
      return { action: { type: 'bet', move: legal.includes('call') ? 'call' : 'check' } };
    }
    if (toCall >= p.chips) {
      return { action: { type: 'bet', move: 'fold' }, say: '这手牌不值得全下。' };
    }
    if (this.rng() < 0.08 && legal.includes('call')) {
      return { action: { type: 'bet', move: 'call' }, say: '我跟。' };
    }
    return { action: { type: 'bet', move: 'fold' } };
  }

  secretOf(p) {
    return { kind: 'cards', data: p.hand.map((c) => ({ s: c.s, r: RANK_LABEL[c.r] })) };
  }

  tableState() {
    const alive = this.players.filter((p) => p.chips > 0).length;
    return {
      title: `${this.street} · 第 ${this.handNo} 手`,
      rows: [
        { label: '底池', value: this.pot },
        { label: '公共牌', value: cardsLabel(this.board) },
        { label: '按钮', value: this.players[this.buttonIdx]?.name || '—' },
        { label: '在桌', value: `${alive} / ${this.players.length}` },
        { label: '盲注', value: `${SB} / ${BB}` },
      ],
      note: '加注 amount 填「本轮累计投入总额」，最少 当前最高投入 + 大盲。弃牌后本手不再收到询问。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '德州扑克',
      gameTitle: '德州扑克',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        `- 每人起始 ${START_CHIPS} 筹码，盲注固定 ${SB}/${BB}（小盲 ${SB}、大盲 ${BB}），按钮每手顺时针轮转。`,
        '- 每人 2 张底牌，只有自己可见；公共牌 5 张，分翻牌前 / 翻牌 / 转牌 / 河牌四轮下注。',
        '- 动作：`fold` 弃牌、`check` 过牌（本轮无人下注时才合法）、`call` 跟注、`raise` 加注、`allin` 全下。',
        '- 加注最小为「本轮当前最高投入 + 大盲」；`amount` 填的是你本轮要投入到的**总额**，不是增量。',
        '- 摊牌：2 张底牌 + 5 张公共牌里选最好的 5 张。牌型：同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌；同型比点数与踢脚，完全相同平分底池。',
        '- 只剩 1 人未弃牌时直接收池；本版不做边池：all-in 会被封顶到对手能跟注的上限，多余筹码留在手上。',
        '- 一手结束按钮移动，筹码归零的玩家出局，最后剩下的一人获胜。',
      ],
      askRows: [
        ['bet', '轮到你下注', '{"type":"bet","move":"call"} / {"type":"bet","move":"raise","amount":60} / {"type":"bet","move":"fold"}'],
      ],
      notes: [
        '`ask.payload.legal` 列出本轮合法动作；`toCall` 是跟注所需，`minRaise`/`maxRaise` 是加注总额的上下限。',
        '`hole` 只在你自己收到的 payload 与 `you.secret` 里，公共状态看不到别人的底牌。',
        '牌面格式：`{"s":"h","r":"A"}`，s ∈ s/h/d/c，r ∈ 2-9/T/J/Q/K/A。',
      ],
      tableRows: [
        { label: '底池', value: state?.table?.rows?.[0]?.value ?? 0 },
        { label: '公共牌', value: state?.table?.rows?.[1]?.value ?? '—' },
      ],
      players: state?.players || [],
    });
  }
}
