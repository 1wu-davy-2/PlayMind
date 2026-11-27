// 妙探寻凶：提问 → 私下展示一张牌 → 排除 → 一次性指控。第一版砍掉棋盘移动。
import { GameBase, shuffle, pick } from '../base.mjs';
import { renderBriefBase } from '../brief-kit.mjs';

export const SUSPECTS = [
  { id: 'plum', name: '梅教授' },
  { id: 'green', name: '绿先生' },
  { id: 'mustard', name: '芥末上校' },
  { id: 'scarlett', name: '红小姐' },
  { id: 'peacock', name: '孔雀夫人' },
  { id: 'white', name: '白太太' },
];

export const WEAPONS = [
  { id: 'candlestick', name: '烛台' },
  { id: 'knife', name: '匕首' },
  { id: 'leadpipe', name: '铅管' },
  { id: 'revolver', name: '左轮枪' },
  { id: 'rope', name: '绳索' },
  { id: 'wrench', name: '扳手' },
];

export const ROOMS = [
  { id: 'kitchen', name: '厨房' },
  { id: 'ballroom', name: '舞厅' },
  { id: 'conservatory', name: '温室' },
  { id: 'dining', name: '餐厅' },
  { id: 'billiard', name: '台球室' },
  { id: 'library', name: '图书室' },
  { id: 'study', name: '书房' },
  { id: 'hall', name: '门厅' },
  { id: 'lounge', name: '休息室' },
];

const CATS = [
  { key: 'suspect', label: '嫌疑人', list: SUSPECTS },
  { key: 'weapon', label: '凶器', list: WEAPONS },
  { key: 'room', label: '房间', list: ROOMS },
];

const NAME_OF = (() => {
  const m = {};
  for (const c of CATS) for (const x of c.list) m[x.id] = x.name;
  return m;
})();
const CAT_OF = (() => {
  const m = {};
  for (const c of CATS) for (const x of c.list) m[x.id] = c.key;
  return m;
})();
const cardName = (id) => NAME_OF[id] || id;

const ALL_IDS = CATS.flatMap((c) => c.list.map((x) => x.id));

export class Cluedo extends GameBase {
  constructor(o = {}) {
    super({ ...o, gameType: 'cluedo' });
    this.minSeats = 3;
    this.maxSeats = 6;
    this.gameTitle = '妙探寻凶';
    this.solution = null;
    this.turnIdx = 0;
    this.suggestions = [];
    this.accusations = [];
  }

  setup() {
    this.fast = this.players.every((p) => p.kind === 'bot');
    const [s, wp, r] = CATS.map((c) => pick(c.list, () => this.rng()).id);
    this.solution = { suspect: s, weapon: wp, room: r };
    const envelope = new Set([s, wp, r]);
    const deck = shuffle(ALL_IDS.filter((id) => !envelope.has(id)), () => this.rng());

    this.players.forEach((p, i) => {
      p.hand = [];
      p.alive = true;
      p.hp = 1;
      p.maxHp = 1;
      p.meta.accused = false;
      p.meta.seen = [];
      p.meta.seat = i;
    });
    deck.forEach((id, i) => {
      this.players[i % this.players.length].hand.push(id);
    });

    this.turnIdx = 0;
    this.round = 1;
    this.phase = 'deduce';
  }

  /* ---------------- 座位顺序 ---------------- */

  // 从 startIdx 的下家开始顺时针，不包含自己
  orderFrom(startIdx) {
    const n = this.players.length;
    const out = [];
    for (let k = 1; k < n; k += 1) {
      const p = this.players[(startIdx + k) % n];
      if (p) out.push(p);
    }
    return out;
  }

  nextAliveFrom(idx) {
    const n = this.players.length;
    for (let k = 1; k <= n; k += 1) {
      const p = this.players[(idx + k) % n];
      if (p.alive) return p;
    }
    return null;
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    yield {
      t: 'begin',
      text: `妙探寻凶开始：${this.players.length} 人，21 张线索牌里有 3 张锁在信封中。`,
      wait: 400,
    };

    const turnCap = this.fast ? 120 : 400; // 全 bot 自测要快，真人局放宽
    let guard = 0;
    while (!this.finished) {
      guard += 1;
      if (guard > turnCap) {
        yield {
          t: 'reveal',
          text: `推理超时，信封揭开：${cardName(this.solution.suspect)} · ${cardName(this.solution.weapon)} · ${cardName(this.solution.room)}，无人破案。`,
          wait: 300,
        };
        this.finish({ id: 'none', name: '无人破案' });
        break;
      }

      const actor = this.players[this.turnIdx];
      if (!actor || !actor.alive) {
        const nxt = this.nextAliveFrom(this.turnIdx);
        if (!nxt) {
          yield {
            t: 'reveal',
            text: `所有玩家都已出局，信封是：${cardName(this.solution.suspect)} · ${cardName(this.solution.weapon)} · ${cardName(this.solution.room)}。`,
            wait: 300,
          };
          this.finish({ id: 'none', name: '无人破案' });
          break;
        }
        this.turnIdx = this.players.indexOf(nxt);
        continue;
      }

      const act = yield* this.askFor(actor, 'declare', {
        mode: 'suggest',
        prompt: '提出一个假设：一名嫌疑人 + 一件凶器 + 一个房间。',
        suspects: SUSPECTS,
        weapons: WEAPONS,
        rooms: ROOMS,
        handCount: actor.hand.length,
      }, { round: this.round, canAccuse: !actor.meta.accused });

      const guess = this.normalizeGuess(act.action || {}, actor);
      if (!guess) {
        this.turnIdx = (this.turnIdx + 1) % this.players.length;
        continue;
      }

      const spoken = `${cardName(guess.suspect)}、${cardName(guess.weapon)}、${cardName(guess.room)}`;
      this.suggestions.push({ byId: actor.id, ...guess, at: Date.now() });
      if (this.suggestions.length > 30) this.suggestions.shift();
      yield {
        t: 'suggest',
        playerId: actor.id,
        guess,
        text: `${actor.name} 提出假设：${spoken}。`,
        log: `${actor.name} 假设：${spoken}`,
        wait: 260,
      };

      // 顺时针找第一个能展示的人（出局玩家仍有展示义务）
      const holder = this.findHolder(this.turnIdx, [guess.suspect, guess.weapon, guess.room]);
      if (holder) {
        const cardId = holder.p.hand.find((id) => [guess.suspect, guess.weapon, guess.room].includes(id));
        if (actor.meta.seen && !actor.meta.seen.includes(cardId)) actor.meta.seen.push(cardId);
        yield {
          t: 'show',
          playerId: holder.p.id,
          targetId: actor.id,
          text: `${holder.p.name} 向 ${actor.name} 展示了 1 张牌（内容仅 ${actor.name} 可见）。`,
          log: `${holder.p.name} 展示了 1 张牌给 ${actor.name}`,
          wait: 180,
        };
        yield {
          t: 'intel',
          playerId: actor.id,
          secretFor: actor.id,
          card: cardId,
          category: CAT_OF[cardId] || null,
          text: `${holder.p.name} 给你看的牌是：${cardName(cardId)}（${CATS.find((c) => c.key === CAT_OF[cardId])?.label || ''}）。`,
          wait: 120,
        };
      } else {
        yield {
          t: 'no-show',
          playerId: actor.id,
          text: `无人能出示与「${spoken}」相关的牌 —— 三条线索可能都在信封里。`,
          wait: 220,
        };

        if (actor.meta.accused) {
          yield {
            t: 'note',
            text: `${actor.name} 已经用过指控机会，只能结束回合。`,
            wait: 140,
          };
        } else {
          const acc = yield* this.askFor(actor, 'declare', {
            mode: 'accuse',
            prompt: '你有一次指控机会：三张全对即胜，错则出局。也可以选择 pass 结束回合。',
            suggest: guess,
            suspects: SUSPECTS,
            weapons: WEAPONS,
            rooms: ROOMS,
          }, { round: this.round });

          if (acc.action?.type === 'declare') {
            const target = this.normalizeGuess(acc.action, actor);
            const win = yield* this.resolveAccusation(actor, target);
            if (win) break;
          }
        }
      }

      const nxt = this.nextAliveFrom(this.turnIdx);
      if (!nxt) {
        yield {
          t: 'reveal',
          text: `所有玩家都已出局，信封是：${cardName(this.solution.suspect)} · ${cardName(this.solution.weapon)} · ${cardName(this.solution.room)}。`,
          wait: 300,
        };
        this.finish({ id: 'none', name: '无人破案' });
        break;
      }
      const prev = this.turnIdx;
      this.turnIdx = this.players.indexOf(nxt);
      if (this.turnIdx <= prev) this.round += 1;
      if (this.players.every((p) => p.meta.accused)) {
        yield {
          t: 'reveal',
          text: `所有人用完了指控机会，信封是：${cardName(this.solution.suspect)} · ${cardName(this.solution.weapon)} · ${cardName(this.solution.room)}。`,
          wait: 300,
        };
        this.finish({ id: 'none', name: '无人破案' });
        break;
      }
    }

    if (this.status !== 'ended') this.finish(this.winner || { id: 'none', name: '无人破案' });
    const win = this.winner;
    yield {
      t: 'end',
      winnerId: win?.id || 'none',
      winnerName: win?.name || '无人',
      text: win && win.id !== 'none'
        ? `案件告破：${win.name} 的指控完全正确。`
        : '案件悬而未决。',
      wait: 0,
    };
  }

  normalizeGuess(action, actor) {
    const g = {
      suspect: action.suspect,
      weapon: action.weapon,
      room: action.room,
    };
    if (!g.suspect || !g.weapon || !g.room) return null;
    if (!SUSPECTS.some((x) => x.id === g.suspect)) return null;
    if (!WEAPONS.some((x) => x.id === g.weapon)) return null;
    if (!ROOMS.some((x) => x.id === g.room)) return null;
    return g;
  }

  findHolder(fromIdx, ids) {
    for (const p of this.orderFrom(fromIdx)) {
      if (!p.hand || !p.hand.length) continue;
      if (p.hand.some((id) => ids.includes(id))) return { p };
    }
    return null;
  }

  async *resolveAccusation(actor, guess) {
    if (!guess) {
      yield { t: 'note', text: `${actor.name} 的指控格式不合法，回合结束。`, wait: 140 };
      return false;
    }
    actor.meta.accused = true;
    const hit = this.solution.suspect === guess.suspect
      && this.solution.weapon === guess.weapon
      && this.solution.room === guess.room;
    const spoken = `${cardName(guess.suspect)}、${cardName(guess.weapon)}、${cardName(guess.room)}`;
    this.accusations.push({ byId: actor.id, ...guess, hit });

    if (hit) {
      yield {
        t: 'accuse',
        playerId: actor.id,
        guess,
        hit: true,
        text: `${actor.name} 指控「${spoken}」—— 完全正确！信封被打开。`,
        log: `${actor.name} 指控成功`,
        wait: 600,
      };
      yield {
        t: 'reveal',
        solution: this.solution,
        text: `真相：${spoken}。`,
        wait: 400,
      };
      this.finish(actor);
      return true;
    }

    actor.alive = false;
    yield {
      t: 'accuse',
      playerId: actor.id,
      guess,
      hit: false,
      text: `${actor.name} 指控「${spoken}」—— 错误，出局（仍需配合展示手牌）。`,
      log: `${actor.name} 指控失败，出局`,
      wait: 420,
    };
    return false;
  }

  /* ---------------- 校验 / 托管 / bot ---------------- */

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';
    if (ask.kind !== 'declare') return '未知的 ask 类型';
    if (ask.payload?.mode === 'accuse' && a.type === 'pass') return null;
    if (a.type !== 'declare') return '需要 {"type":"declare","suspect":"plum","weapon":"rope","room":"library"}';
    if (!SUSPECTS.some((x) => x.id === a.suspect)) return 'suspect 不在嫌疑人列表里';
    if (!WEAPONS.some((x) => x.id === a.weapon)) return 'weapon 不在凶器列表里';
    if (!ROOMS.some((x) => x.id === a.room)) return 'room 不在房间列表里';
    return null;
  }

  autoAct(ask) {
    if (ask.kind === 'declare') {
      if (ask.payload?.mode === 'accuse') return { action: { type: 'pass' } };
      return {
        action: {
          type: 'declare',
          suspect: pick(SUSPECTS, () => this.rng()).id,
          weapon: pick(WEAPONS, () => this.rng()).id,
          room: pick(ROOMS, () => this.rng()).id,
        },
      };
    }
    return super.autoAct(ask);
  }

  botThought(p, kind, payload) {
    if (kind !== 'declare') return '';
    if (payload?.mode === 'accuse') return '三张全对才赢，错一次就出局，没把握就放弃。';
    return '问一个我手上没有的组合，看看谁肯出示。';
  }

  botAct(p, ask) {
    const payload = ask.payload || {};
    if (ask.kind === 'declare' && payload.mode === 'accuse') {
      // 无人能展示 + 自己手上也没有这三张 → 三张必然都在信封里，可以必赢指控
      const sg = payload.suggest;
      if (sg && ![sg.suspect, sg.weapon, sg.room].some((id) => p.hand.includes(id))) {
        return {
          action: { type: 'declare', suspect: sg.suspect, weapon: sg.weapon, room: sg.room },
          say: '没人能出示 —— 那这三张就在信封里。',
        };
      }
      // 已被自己手牌 + 别人展示过的牌排除后，每类只剩一张 → 确定答案
      const left = (list) => list.filter((x) => !p.hand.includes(x.id) && !(p.meta.seen || []).includes(x.id));
      const ls = left(SUSPECTS);
      const lw = left(WEAPONS);
      const lr = left(ROOMS);
      if (ls.length === 1 && lw.length === 1 && lr.length === 1) {
        return {
          action: { type: 'declare', suspect: ls[0].id, weapon: lw[0].id, room: lr[0].id },
          say: '我排除完了 —— 就是这三张。',
        };
      }
      if (this.rng() > 0.1) return { action: { type: 'pass' }, say: '证据还不够，我再问问。' };
      const s = pick(ls.length ? ls : SUSPECTS, () => this.rng()).id;
      const wp = pick(lw.length ? lw : WEAPONS, () => this.rng()).id;
      const r = pick(lr.length ? lr : ROOMS, () => this.rng()).id;
      return { action: { type: 'declare', suspect: s, weapon: wp, room: r }, say: '我指控，就是他们。' };
    }
    if (ask.kind === 'declare') {
      // 优先问「自己没持有、也没见人展示过」的牌，才能收集新信息
      const fresh = (list) => {
        const pool = list.filter((x) => !p.hand.includes(x.id) && !(p.meta.seen || []).includes(x.id));
        return pool.length ? pool : list;
      };
      const useFresh = this.rng() < 0.75;
      const s = pick(useFresh ? fresh(SUSPECTS) : SUSPECTS, () => this.rng()).id;
      const wp = pick(useFresh ? fresh(WEAPONS) : WEAPONS, () => this.rng()).id;
      const r = pick(useFresh ? fresh(ROOMS) : ROOMS, () => this.rng()).id;
      return {
        action: { type: 'declare', suspect: s, weapon: wp, room: r },
        say: `我想知道：${cardName(s)}、${cardName(wp)}、${cardName(r)}。`,
      };
    }
    return super.autoAct(ask);
  }

  secretOf(p) {
    return { kind: 'cards', data: p.hand.slice() };
  }

  tableState() {
    const alive = this.players.filter((p) => p.alive).length;
    return {
      title: `推理 · 第 ${this.round} 轮`,
      rows: [
        { label: '存活', value: `${alive} / ${this.players.length}` },
        { label: '线索牌', value: '21 张（3 张在信封）' },
        { label: '最近假设', value: this.suggestions.length
          ? `${this.nameOf(this.suggestions[this.suggestions.length - 1].byId)}：${cardName(this.suggestions[this.suggestions.length - 1].suspect)} / ${cardName(this.suggestions[this.suggestions.length - 1].weapon)} / ${cardName(this.suggestions[this.suggestions.length - 1].room)}`
          : '—' },
        { label: '指控', value: `${this.accusations.length} 次` },
      ],
      note: '假设会由下家顺时针第一位持有相关牌的玩家私下展示一张；每人只有一次指控机会。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '妙探寻凶',
      gameTitle: '妙探寻凶',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 21 张线索牌：6 名嫌疑人、6 件凶器、9 个房间。各抽 1 张锁进信封，其余平均发给所有人。',
        '- 轮到你时提出假设：嫌疑人 + 凶器 + 房间（房间任选，不需要棋子位置）。',
        '- 从你的下家顺时针，第一位持有假设中任一牌的玩家会私下展示其中一张给你，其他玩家只知道「谁展示了牌」。',
        '- 没有任何人能展示时，你可以选择结束回合，或立即指控。',
        '- 指控必须三张全对：正确即胜；错误则出局，但仍需配合他人展示手牌。每人全局只有一次指控。',
        `- 嫌疑人 id：${SUSPECTS.map((x) => `\`${x.id}\`=${x.name}`).join('、')}。`,
        `- 凶器 id：${WEAPONS.map((x) => `\`${x.id}\`=${x.name}`).join('、')}。`,
        `- 房间 id：${ROOMS.map((x) => `\`${x.id}\`=${x.name}`).join('、')}。`,
      ],
      askRows: [
        ['declare', '提出假设', '{"type":"declare","suspect":"plum","weapon":"rope","room":"library"}'],
        ['declare', '无人可展示时的指控（可放弃）', '{"type":"declare","suspect":"green","weapon":"knife","room":"kitchen"} 或 {"type":"pass"}'],
      ],
      notes: [
        '你的手牌在 `you.secret.data`，是字符串数组，例如 `["plum","rope","kitchen"]`。',
        '别人展示给你的牌只会出现在你的 `intel` 事件里，公共日志看不到内容。',
        '牌面 id 见 brief 顶部的嫌疑人/凶器/房间列表。',
      ],
      tableRows: [
        { label: '轮次', value: state?.round ?? 1 },
        { label: '存活', value: `${state?.players?.filter((p) => p.alive).length ?? 0} 人` },
      ],
      players: state?.players || [],
    });
  }
}
