// UNO：颜色 / 数字 / 功能牌匹配，Wild 选色，Wild+4 可质疑。2–6 人。
import { GameBase, shuffle, pick } from '../core/base.mjs';
import { renderBriefBase } from '../core/brief-kit.mjs';

const PACE = process.env.BT_PACE === '0' ? 0 : 1;

export const COLORS = [
  { id: 'r', name: '红' },
  { id: 'y', name: '黄' },
  { id: 'g', name: '绿' },
  { id: 'b', name: '蓝' },
];
const COLOR_IDS = COLORS.map((c) => c.id);
const COLOR_NAME = Object.fromEntries(COLORS.map((c) => [c.id, c.name]));

export function parseCard(id) {
  if (id === 'wild') return { id, type: 'wild', color: null };
  if (id === 'wd4') return { id, type: 'wd4', color: null };
  const parts = String(id).split('-');
  if (parts.length === 2) return { id, type: parts[0], color: parts[1] };
  return { id, type: 'num', color: id[0], num: Number(id.slice(1)) };
}

const colorOf = (id) => parseCard(id).color;

const TYPE_LABEL = { skip: '跳过', rev: '反转', d2: '+2', wild: '万能牌', wd4: '万能+4' };

function cardLabel(id) {
  const c = parseCard(id);
  if (c.type === 'wild') return '万能牌';
  if (c.type === 'wd4') return '万能+4';
  const cn = COLOR_NAME[c.color] || c.color;
  if (c.type === 'num') return `${cn}${c.num}`;
  return `${cn}${TYPE_LABEL[c.type] || c.type}`;
}

function buildDeck() {
  const deck = [];
  for (const c of COLOR_IDS) {
    deck.push(`${c}0`);
    for (let n = 1; n <= 9; n += 1) { deck.push(`${c}${n}`); deck.push(`${c}${n}`); }
    for (const t of ['skip', 'rev', 'd2']) { deck.push(`${t}-${c}`); deck.push(`${t}-${c}`); }
  }
  for (let i = 0; i < 4; i += 1) { deck.push('wild'); deck.push('wd4'); }
  return deck;
}

export class Uno extends GameBase {
  constructor(o = {}) {
    super({ ...o, gameType: 'uno' });
    this.minSeats = 2;
    this.maxSeats = 6;
    this.gameTitle = 'UNO';
    this.drawPile = [];
    this.discard = [];
    this.direction = 1;
    this.currentColor = 'r';
    this.turnIdx = 0;
  }

  pace(ms) {
    if (!PACE) return 0;
    return this.fast ? Math.min(ms, 24) : ms;
  }

  setup() {
    this.fast = this.players.every((p) => p.kind === 'bot');
    const deck = shuffle(buildDeck());
    this.players.forEach((p) => { p.hand = []; p.alive = true; });
    for (let round = 0; round < 7; round += 1) {
      for (const p of this.players) p.hand.push(deck.pop());
    }
    // 开局翻一张数字牌
    let idx = deck.length - 1;
    while (idx >= 0 && parseCard(deck[idx]).type !== 'num') idx -= 1;
    if (idx < 0) idx = deck.length - 1;
    const top = deck.splice(idx, 1)[0];
    this.discard = [top];
    this.drawPile = deck;
    this.currentColor = colorOf(top);
    this.direction = 1;
    this.turnIdx = 0;
    this.phase = 'play';
    this.turnSeq = 0;
    this.stall = 0;
  }

  /* ---------------- 牌堆 ---------------- */

  topId() { return this.discard[this.discard.length - 1]; }

  reshuffle() {
    if (this.discard.length <= 1) return false;
    const top = this.discard.pop();
    const rest = shuffle(this.discard);
    this.discard = [top];
    this.drawPile = rest;
    return rest.length > 0;
  }

  drawOne(p) {
    if (!this.drawPile.length) this.reshuffle();
    if (!this.drawPile.length) return null;
    const c = this.drawPile.pop();
    p.hand.push(c);
    return c;
  }

  step(n = 1) {
    const N = this.players.length;
    return ((this.turnIdx + this.direction * n) % N + N) % N;
  }

  legalFor(hand, topId, color) {
    const top = parseCard(topId);
    const out = [];
    for (const id of hand) {
      const c = parseCard(id);
      if (c.type === 'wild') { out.push(id); continue; }
      // +4 永远可以打出（可能是诈唬），是否合规由下家质疑时裁决
      if (c.type === 'wd4') { out.push(id); continue; }
      if (c.color === color) { out.push(id); continue; }
      if (top.type === 'num' && c.type === 'num' && c.num === top.num) { out.push(id); continue; }
      if (top.type !== 'num' && c.type === top.type) out.push(id);
    }
    return out;
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    yield {
      t: 'begin',
      text: `UNO 开始：${this.players.length} 人各 7 张，翻开 ${cardLabel(this.topId())}，${this.nameOf(this.players[this.turnIdx].id)} 先手。`,
      wait: this.pace(400),
    };

    while (true) {
      this.turnSeq += 1;
      if (this.turnSeq > 1500) {
        const fewest = this.players.slice().sort((a, b) => a.hand.length - b.hand.length)[0];
        yield {
          t: 'end',
          text: `回合上限，手牌最少的 ${fewest.name} 获胜。`,
          wait: this.pace(200),
        };
        this.finish(fewest);
        return;
      }

      const p = this.players[this.turnIdx];
      if (!p) break;

      const legal = [...new Set(this.legalFor(p.hand, this.topId(), this.currentColor))];
      const act = yield* this.askFor(p, 'play-card', {
        top: this.topId(),
        topLabel: cardLabel(this.topId()),
        currentColor: this.currentColor,
        currentColorName: COLOR_NAME[this.currentColor] || this.currentColor,
        legal,
        hand: p.hand.slice(),
        direction: this.direction,
        drawPile: this.drawPile.length,
        mustDraw: legal.length === 0,
        wd4Legal: legal.filter((id) => parseCard(id).type === 'wd4'
          && !p.hand.some((x) => colorOf(x) === this.currentColor)),
        colors: COLORS,
      }, { turn: this.turnSeq });

      const a = act.action || {};
      let chosen = null;
      let playColor = a.color;
      if (a.type === 'play' && typeof a.cardId === 'string'
        && p.hand.includes(a.cardId) && legal.includes(a.cardId)) {
        chosen = a.cardId;
      }

      if (!chosen) {
        const got = this.drawOne(p);
        yield {
          t: 'draw',
          playerId: p.id,
          count: got ? 1 : 0,
          drawPile: this.drawPile.length,
          text: got
            ? `${p.name} 摸 1 张牌（剩余牌堆 ${this.drawPile.length}）。`
            : `${p.name} 摸牌但牌堆已空，跳过。`,
          wait: this.pace(160),
        };
        if (got) {
          const canPlayDrawn = this.legalFor([got], this.topId(), this.currentColor).length > 0;
          if (canPlayDrawn) {
            const act2 = yield* this.askFor(p, 'play-card', {
              top: this.topId(),
              topLabel: cardLabel(this.topId()),
              currentColor: this.currentColor,
              legal: [got],
              hand: p.hand.slice(),
              optional: true,
              drawn: got,
            }, { turn: this.turnSeq, drawn: true });
            if (act2.action?.type === 'play' && act2.action.cardId === got) {
              chosen = got;
              playColor = act2.action.color;
            }
          }
        }
        if (!chosen) {
          this.stall += 1;
          if (this.stall > 60) {
            const fewest = this.players.slice().sort((x, y) => x.hand.length - y.hand.length)[0];
            yield {
              t: 'end',
              text: `连续多轮无人出牌，手牌最少的 ${fewest.name} 获胜。`,
              wait: this.pace(200),
            };
            this.finish(fewest);
            return;
          }
          this.turnIdx = this.step(1);
          continue;
        }
      }

      this.stall = 0;
      const done = yield* this.resolvePlay(p, chosen, playColor, act.say || '');
      if (done) return;
    }

    if (this.status !== 'ended') this.finish({ id: 'none', name: '无人' });
  }

  async *resolvePlay(p, cardId, colorHint, sayText = '') {
    const prevTop = this.topId();
    const prevColor = this.currentColor;
    const meta = parseCard(cardId);

    const at = p.hand.indexOf(cardId);
    if (at < 0) return false;
    p.hand.splice(at, 1);
    this.discard.push(cardId);
    this.currentColor = meta.color || this.currentColor;

    let declared = null;
    if (meta.type === 'wild' || meta.type === 'wd4') {
      if (colorHint && COLOR_IDS.includes(colorHint)) declared = colorHint;
      if (!declared) {
        const d = yield* this.askFor(p, 'declare', {
          prompt: '选择接下来的颜色。',
          colors: COLORS,
          cardId,
        }, { turn: this.turnSeq });
        declared = d.action?.color;
      }
      this.currentColor = COLOR_IDS.includes(declared) ? declared : this.majorityColor(p);
    }

    yield {
      t: 'play',
      playerId: p.id,
      cardId,
      cardLabel: cardLabel(cardId),
      type: meta.type,
      color: this.currentColor,
      handLeft: p.hand.length,
      text: `${p.name} 打出 ${cardLabel(cardId)}${meta.type === 'wild' || meta.type === 'wd4' ? `，指定颜色 ${COLOR_NAME[this.currentColor]}` : ''}。`,
      log: `${p.name} 出 ${cardLabel(cardId)}`,
      wait: this.pace(180),
    };

    if (meta.type === 'wild' || meta.type === 'wd4') {
      yield {
        t: 'color',
        playerId: p.id,
        color: this.currentColor,
        text: `后续颜色改为 ${COLOR_NAME[this.currentColor]}。`,
        wait: this.pace(140),
      };
    }

    if (p.hand.length === 1) {
      const called = /uno/i.test(String(sayText || ''));
      yield called
        ? { t: 'uno', playerId: p.id, text: `${p.name} 喊了 UNO！`, wait: this.pace(120) }
        : { t: 'warn', playerId: p.id, text: `${p.name} 只剩 1 张牌却没喊 UNO（本版只提示，不罚抽）。`, wait: this.pace(120) };
    }

    if (p.hand.length === 0) {
      yield {
        t: 'end',
        winnerId: p.id,
        winnerName: p.name,
        text: `${p.name} 出完手牌，赢下本局。`,
        wait: this.pace(300),
      };
      this.finish(p);
      return true;
    }

    if (meta.type === 'skip') {
      const skipped = this.players[this.step(1)];
      this.turnIdx = this.step(2);
      yield {
        t: 'skip',
        playerId: skipped.id,
        text: `${skipped.name} 被跳过。`,
        wait: this.pace(140),
      };
      return false;
    }

    if (meta.type === 'rev') {
      if (this.players.length === 2) {
        const skipped = this.players[this.step(1)];
        this.turnIdx = this.step(2);
        yield {
          t: 'skip',
          playerId: skipped.id,
          text: `2 人局反转视同跳过：${skipped.name} 停一轮。`,
          wait: this.pace(140),
        };
        return false;
      }
      this.direction *= -1;
      this.turnIdx = this.step(1);
      yield {
        t: 'reverse',
        direction: this.direction,
        text: `方向反转，改为${this.direction > 0 ? '顺时针' : '逆时针'}。`,
        wait: this.pace(140),
      };
      return false;
    }

    if (meta.type === 'd2') {
      const victim = this.players[this.step(1)];
      const got = [];
      for (let i = 0; i < 2; i += 1) {
        const c = this.drawOne(victim);
        if (c) got.push(c);
      }
      this.turnIdx = this.step(2);
      yield {
        t: 'penalty',
        playerId: victim.id,
        count: got.length,
        reason: '+2',
        text: `${victim.name} 罚抽 ${got.length} 张并停一轮。`,
        wait: this.pace(180),
      };
      return false;
    }

    if (meta.type === 'wd4') {
      return yield* this.resolveWd4(p, meta, prevTop, prevColor);
    }

    this.turnIdx = this.step(1);
    return false;
  }

  async *resolveWd4(player, meta, prevTop, prevColor) {
    const legal = !player.hand.some((id) => colorOf(id) === prevColor);
    player.meta.lastWd4Legal = legal;
    player.meta.lastWd4Color = prevColor;

    const victim = this.players[this.step(1)];
    const ans = yield* this.askFor(victim, 'challenge', {
      prompt: `${player.name} 打出万能+4，并指定 ${COLOR_NAME[this.currentColor]}。接受罚抽 4 张，或质疑他手里其实有${COLOR_NAME[prevColor]}牌。`,
      claimerId: player.id,
      claimerName: player.name,
      declaredColor: this.currentColor,
      prevColor,
    }, { turn: this.turnSeq });

    const accept = ans.action?.accept !== false;
    if (accept) {
      const got = [];
      for (let i = 0; i < 4; i += 1) {
        const c = this.drawOne(victim);
        if (c) got.push(c);
      }
      this.turnIdx = this.step(2);
      yield {
        t: 'penalty',
        playerId: victim.id,
        count: got.length,
        reason: 'wd4-accept',
        text: `${victim.name} 接受罚抽 ${got.length} 张并停一轮。`,
        wait: this.pace(180),
      };
      return false;
    }

    if (legal) {
      const got = [];
      for (let i = 0; i < 6; i += 1) {
        const c = this.drawOne(victim);
        if (c) got.push(c);
      }
      this.turnIdx = this.step(2);
      yield {
        t: 'penalty',
        playerId: victim.id,
        count: got.length,
        reason: 'wd4-challenge-fail',
        reveal: player.hand.slice(),
        text: `${player.name} 亮牌自证：手里确实没有${COLOR_NAME[prevColor]}牌。质疑失败，${victim.name} 罚抽 ${got.length} 张并停一轮。`,
        wait: this.pace(240),
      };
      return false;
    }

    // 质疑成功：+4 作废，出牌者罚抽 4 张，下家按原顶牌继续
    const voided = this.discard.pop();
    if (voided) this.drawPile.unshift(voided);
    this.currentColor = prevColor;
    this.turnIdx = this.players.indexOf(victim);
    const got = [];
    for (let i = 0; i < 4; i += 1) {
      const c = this.drawOne(player);
      if (c) got.push(c);
    }
    yield {
      t: 'penalty',
      playerId: player.id,
      count: got.length,
      reason: 'wd4-challenge-success',
      reveal: player.hand.slice(),
      text: `质疑成功：${player.name} 手里本来就有${COLOR_NAME[prevColor]}牌，+4 作废，他罚抽 ${got.length} 张，轮到 ${victim.name} 按原顶牌 ${cardLabel(prevTop)} 继续。`,
      wait: this.pace(260),
    };
    return false;
  }

  majorityColor(p) {
    const count = {};
    for (const id of p.hand) {
      const c = colorOf(id);
      if (c) count[c] = (count[c] || 0) + 1;
    }
    let best = 'r';
    let n = -1;
    for (const c of COLOR_IDS) {
      if ((count[c] || 0) > n) { best = c; n = count[c] || 0; }
    }
    return best;
  }

  /* ---------------- 校验 / 托管 / bot ---------------- */

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';
    if (ask.kind === 'play-card') {
      if (a.type === 'draw') return null;
      if (a.type !== 'play') return '需要 {"type":"play","cardId":"r3"} 或 {"type":"draw"}';
      const hand = ask.payload?.hand || [];
      if (!hand.includes(a.cardId)) return 'cardId 不在你手里';
      if (!(ask.payload?.legal || []).includes(a.cardId)) return '这张牌现在打不出去';
      if (a.color && !COLOR_IDS.includes(a.color)) return 'color 只能是 r/y/g/b';
      return null;
    }
    if (ask.kind === 'declare') {
      if (a.type !== 'declare') return '需要 {"type":"declare","color":"r"}';
      if (!COLOR_IDS.includes(a.color)) return 'color 只能是 r/y/g/b';
      return null;
    }
    if (ask.kind === 'challenge') {
      if (a.type !== 'challenge') return '需要 {"type":"challenge","accept":true}';
      return null;
    }
    return '未知的 ask 类型';
  }

  autoAct(ask) {
    if (ask.kind === 'play-card') {
      const legal = ask.payload?.legal || [];
      if (legal.length) return { action: { type: 'play', cardId: legal[0] } };
      return { action: { type: 'draw' } };
    }
    if (ask.kind === 'declare') return { action: { type: 'declare', color: 'r' } };
    if (ask.kind === 'challenge') return { action: { type: 'challenge', accept: true } };
    return super.autoAct(ask);
  }

  botThought(p, kind, payload) {
    if (kind === 'play-card') {
      const legal = payload?.legal || [];
      if (!legal.length) return '没有能出的牌，摸一张再说。';
      return `手里 ${p.hand.length} 张，能出的有 ${legal.length} 张。`;
    }
    if (kind === 'declare') return '选我手里最多的颜色。';
    if (kind === 'challenge') return Math.random() < 0.35 ? '他会不会藏了同色牌？' : '罚 4 张比赌一把稳。';
    return '';
  }

  botAct(p, ask) {
    if (ask.kind === 'play-card') {
      const legal = ask.payload?.legal || [];
      if (!legal.length) return { action: { type: 'draw' } };
      const plain = legal.filter((id) => {
        const c = parseCard(id);
        return c.type !== 'wild' && c.type !== 'wd4';
      });
      const wd4s = legal.filter((id) => parseCard(id).type === 'wd4');
      const hasColor = p.hand.some((x) => colorOf(x) === ask.payload.currentColor);
      if (wd4s.length && hasColor && Math.random() < 0.15) {
        return {
          action: { type: 'play', cardId: wd4s[0], color: this.majorityColor(p) },
          say: p.hand.length === 2 ? 'UNO！' : '换个颜色吧。',
        };
      }
      const pool = plain.length ? plain : legal;
      const sameColor = pool.filter((id) => colorOf(id) === ask.payload.currentColor);
      const card = pick(sameColor.length ? sameColor : pool);
      const willUno = p.hand.length === 2;
      const c = parseCard(card);
      const color = c.type === 'wild' || c.type === 'wd4' ? this.majorityColor(p) : undefined;
      const action = { type: 'play', cardId: card };
      if (color) action.color = color;
      return {
        action,
        say: willUno ? 'UNO！' : (c.type === 'wd4' ? `换${COLOR_NAME[color]}色。` : ''),
      };
    }
    if (ask.kind === 'declare') {
      return { action: { type: 'declare', color: this.majorityColor(p) } };
    }
    if (ask.kind === 'challenge') {
      const accept = Math.random() < 0.65;
      return {
        action: { type: 'challenge', accept },
        say: accept ? '我认罚。' : '我不信你手里没有这个颜色。',
      };
    }
    return super.autoAct(ask);
  }

  secretOf(p) {
    return { kind: 'hand', data: p.hand.slice() };
  }

  tableState() {
    const top = this.topId();
    return {
      title: `出牌 · 第 ${Math.floor((this.turnSeq || 0) / this.players.length) + 1} 轮`,
      rows: [
        { label: '顶牌', value: top ? cardLabel(top) : '—' },
        { label: '当前颜色', value: COLOR_NAME[this.currentColor] || '—' },
        { label: '方向', value: this.direction > 0 ? '顺时针' : '逆时针' },
        { label: '牌堆', value: `${this.drawPile.length} 张` },
        { label: '弃牌堆', value: `${this.discard.length} 张` },
      ],
      note: '出牌需与顶牌同色、同数字或同功能；万能牌随时可出；+4 只在手中没有当前颜色时合法，下家可质疑。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: 'UNO',
      gameTitle: 'UNO',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 108 张牌：四色 0–9（1–9 各 2 张）、跳过 / 反转 / +2 各 2 张、万能牌与万能+4 各 4 张。每人 7 张，翻 1 张数字牌开局。',
        '- 每回合出 1 张：与顶牌同色、同数字或同功能即可；万能牌任意可出。没有可出的牌就摸 1 张，摸到的牌能出则可以立刻打出，否则回合结束。',
        '- 跳过：下家停一轮。反转：改变方向（2 人局视同跳过）。+2：下家罚抽 2 张并停一轮。',
        '- 万能牌由出牌者指定后续颜色；万能+4 只在手中没有当前颜色牌时合法，下家可选择接受罚抽 4 张，或质疑。',
        '- 质疑：出牌者亮手牌自证。合法 → 质疑者罚抽 6 张并停一轮；违规 → 出牌者罚抽 4 张，+4 作废，下家按原顶牌继续。',
        '- 打出倒数第二张牌时用 `say` 喊 UNO（本版只提示，不自动罚抽）。先出完手牌者胜；牌堆用尽时洗回弃牌堆（保留顶牌）。',
      ],
      askRows: [
        ['play-card', '轮到你出牌', '{"type":"play","cardId":"r3","color":"b"} 或 {"type":"draw"}'],
        ['declare', '万能牌选色（也可直接在 play 里带 color）', '{"type":"declare","color":"g"}'],
        ['challenge', '被 +4 时的选择', '{"type":"challenge","accept":true} 接受罚抽；false 表示质疑'],
      ],
      notes: [
        '颜色代码：`r` 红、`y` 黄、`g` 绿、`b` 蓝。牌 id 形如 `r3`、`skip-y`、`rev-g`、`d2-b`、`wild`、`wd4`。',
        '`ask.payload.legal` 是当前能打出的牌 id 列表，`hand` 是你的完整手牌。',
        '`ask.payload.legal` 为空时只能 `{"type":"draw"}`。',
        '打 +4 时若手里其实有当前颜色牌属于违规诈唬：服务端允许你打，但下家质疑成功你会罚抽 4 张且 +4 作废。`ask.payload.wd4Legal` 列出当前合规的 +4。',
      ],
      tableRows: [
        { label: '顶牌', value: state?.table?.rows?.[0]?.value ?? '—' },
        { label: '当前颜色', value: state?.table?.rows?.[1]?.value ?? '—' },
      ],
      players: state?.players || [],
    });
  }
}
