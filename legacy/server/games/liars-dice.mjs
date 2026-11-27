// 大话骰（Liar's Dice）：叫点 + 质疑 + 开盅。2–6 人，每人 5 颗六面骰。
// 规则锁定版见 GAME_PLAYBOOK.md 第 2 节。
import { GameBase, pick, clamp } from '../core/base.mjs';
import { renderBriefBase } from '../core/brief-kit.mjs';

const DICE_PER_PLAYER = 5;
const FACE_CN = ['', '一', '二', '三', '四', '五', '六'];

const rollDice = (n) => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
const faceCn = (f) => FACE_CN[f] || String(f);
const bidText = (b) => (b ? `${b.count} 个 ${faceCn(b.face)}${b.wild ? '' : '（斋）'}` : '无');

// 二项分布尾概率 P(X >= k)
function binomTail(n, p, k) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const q = 1 - p;
  let sum = 0;
  let comb = 1;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) comb = (comb * (n - i + 1)) / i;
    const term = comb * (p ** i) * (q ** (n - i));
    if (i >= k) sum += term;
  }
  return Math.min(1, sum);
}

export class LiarsDice extends GameBase {
  constructor(opts = {}) {
    super({ ...opts, gameType: 'liars-dice' });
    this.minSeats = 2;
    this.maxSeats = 6;
    this.seats = clamp(this.seats, this.minSeats, this.maxSeats);
    this.gameTitle = '大话骰';
    this.lastBid = null;
  }

  setup() {
    this.round = 1;
    this.phase = 'bid';
    this.lastBid = null;
    for (const p of this.players) {
      p.alive = true;
      p.hp = 1;
      p.maxHp = 1;
      p.folded = false;
      p.dice = rollDice(DICE_PER_PLAYER);
      p.say = '';
      p.thought = '';
      p.meta = {};
    }
  }

  /* ---------------- 工具 ---------------- */

  aliveCount() { return this.aliveList.length; }

  totalDice() { return this.aliveList.reduce((n, p) => n + p.dice.length, 0); }

  nextAliveId(id) {
    const n = this.players.length;
    const start = this.players.findIndex((p) => p.id === id);
    for (let i = 1; i <= n; i += 1) {
      const p = this.players[(start + i + n) % n];
      if (p && p.alive) return p.id;
    }
    return id;
  }

  // 统计全场符合叫点的骰子数：非斋时 1 算百搭
  countBid(bid) {
    let n = 0;
    for (const p of this.aliveList) {
      for (const d of p.dice) {
        if (d === bid.face) n += 1;
        else if (bid.wild && bid.face !== 1 && d === 1) n += 1;
      }
    }
    return n;
  }

  // 最小的合法加码；null 表示只能开盅
  minRaiseOf(lastBid, totalDice) {
    if (!lastBid) return { count: Math.max(1, this.aliveCount()), face: 2, wild: true };
    if (lastBid.count < totalDice) return { count: lastBid.count + 1, face: 2, wild: true };
    if (lastBid.face < 6) return { count: lastBid.count, face: lastBid.face + 1, wild: lastBid.wild };
    return null;
  }

  declarePayload(p, lastBid) {
    const totalDice = this.totalDice();
    return {
      prompt: lastBid
        ? `上家 ${lastBid.byName} 叫 ${bidText(lastBid)}。加码叫点，或开盅质疑。`
        : '本局由你先叫。首叫数量至少等于存活人数。',
      lastBid: lastBid ? { ...lastBid } : null,
      canOpen: !!lastBid,
      minCount: lastBid ? lastBid.count : Math.max(1, this.aliveCount()),
      minFace: lastBid ? lastBid.face : 1,
      aliveCount: this.aliveCount(),
      totalDice,
      diceLeft: p.dice.length,
      minRaise: this.minRaiseOf(lastBid, totalDice),
    };
  }

  // 用自己骰面 + 其余未知骰的二项分布估算「实际 >= count」的概率
  estimateProb(count, face, wild, myDice) {
    const unknown = Math.max(0, this.totalDice() - myDice.length);
    const hit = myDice.filter((d) => d === face || (wild && face !== 1 && d === 1)).length;
    const need = Math.max(0, count - hit);
    const p = wild ? 1 / 3 : 1 / 6;
    return binomTail(unknown, p, need);
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    yield {
      t: 'begin',
      text: `大话骰开始：${this.players.length} 人，每人 ${DICE_PER_PLAYER} 颗六面骰，只看自己的骰面。`,
      wait: 300,
      log: '开局',
    };

    let starter = pick(this.aliveList);
    let winner = null;
    let guard = 0;

    while (!winner && guard < 300) {
      guard += 1;

      // 摇骰（骰数随掉骰减少）
      for (const p of this.aliveList) p.dice = rollDice(Math.max(1, p.dice.length));
      this.phase = 'bid';
      this.lastBid = null;
      yield {
        t: 'roll',
        round: this.round,
        total: this.totalDice(),
        wait: 180,
      };

      const total = this.totalDice();
      yield {
        t: 'phase',
        phase: 'bid',
        round: this.round,
        text: `第 ${this.round} 局 · 存活 ${this.aliveCount()} 人 · 全场 ${total} 颗骰 · ${starter.name} 先叫`,
        wait: 120,
        log: `第 ${this.round} 局开始`,
      };

      let lastBid = null;
      let turnId = starter.id;
      let loser = null;

      for (let step = 0; step < 500; step += 1) {
        const p = this.byId(turnId);
        if (!p) break;
        if (!p.alive) { turnId = this.nextAliveId(turnId); continue; }

        const payload = this.declarePayload(p, lastBid);
        const act = yield* this.askFor(p, 'declare', payload, { round: this.round, lastBid });
        const a = act?.action || {};

        const doDeclare = (b) => {
          lastBid = { count: b.count, face: b.face, wild: b.wild, byId: p.id, byName: p.name };
          this.lastBid = lastBid;
          turnId = this.nextAliveId(p.id);
          return {
            t: 'bid',
            playerId: p.id,
            bid: { ...lastBid },
            text: `${p.name} 叫 ${bidText(b)}。`,
            wait: 70,
            log: `${p.name} 叫 ${bidText(b)}`,
          };
        };

        let challenge = false;
        let event = null;

        if (a.type === 'open' && lastBid) {
          challenge = true;
        } else if (a.type === 'declare') {
          const b = { count: Number(a.count), face: Number(a.face), wild: a.wild !== false };
          const ok = Number.isInteger(b.count) && Number.isInteger(b.face)
            && b.face >= 2 && b.face <= 6 && b.count >= 1 && b.count <= total;
          if (ok) event = doDeclare(b);
        }

        if (!challenge && !event) {
          // 兜底：用最小合法加码；无合法加码则视为开盅
          if (payload.minRaise) event = doDeclare({ ...payload.minRaise });
          else if (lastBid) challenge = true;
          else break;
        }

        if (event) { yield event; continue; }

        // 开盅结算
        const actual = this.countBid(lastBid);
        const bidder = this.byId(lastBid.byId);
        const short = actual < lastBid.count;
        loser = short ? bidder : p;
        const rows = this.aliveList.map((x) => `${x.name}：${x.dice.join(' ')}`).join('；');
        yield {
          t: 'open',
          bid: { ...lastBid },
          actual,
          dice: Object.fromEntries(this.aliveList.map((x) => [x.id, x.dice.slice()])),
          challengerId: p.id,
          bidderId: lastBid.byId,
          loserId: loser?.id,
          text: `${p.name} 开盅！${bidder.name} 叫 ${bidText(lastBid)}，实际 ${actual} 个。`
            + `全场骰面 —— ${rows}。判定：${short ? '叫点不成立，叫点者输' : '叫点成立，质疑者输'}。`,
          wait: 260,
          log: `开盅 · 实际 ${actual} 个`,
        };
        break;
      }

      if (!loser) loser = lastBid ? this.byId(lastBid.byId) : starter;
      if (!loser) break;

      const before = loser.dice.length;
      loser.dice = loser.dice.slice(0, Math.max(0, before - 1));
      const left = loser.dice.length;
      yield {
        t: 'dice-loss',
        playerId: loser.id,
        diceLeft: left,
        text: `${loser.name} 输了这一局，掉 1 颗骰${left > 0 ? `（剩 ${left} 颗）` : '（骰子归零）'}。`,
        wait: 200,
        log: `${loser.name} 掉骰`,
      };

      if (left === 0) {
        loser.alive = false;
        loser.folded = true;
        yield {
          t: 'eliminate',
          playerId: loser.id,
          text: `${loser.name} 骰子归零，淘汰出局。`,
          wait: 220,
          log: `${loser.name} 出局`,
        };
      }

      if (this.aliveList.length <= 1) {
        winner = this.aliveList[0] || loser;
        break;
      }

      // 下一局由输者先叫；输者已淘汰则顺延到下一名存活者
      starter = loser.alive ? loser : this.byId(this.nextAliveId(loser.id));
      this.round += 1;
    }

    if (!winner) {
      winner = this.aliveList.slice().sort((x, y) => y.dice.length - x.dice.length)[0];
    }
    if (!winner) { this.finish('none'); yield { t: 'end', text: '游戏异常结束。', wait: 0 }; return; }

    this.finish(winner);
    yield {
      t: 'end',
      winnerId: winner.id,
      winnerName: winner.name,
      text: `游戏结束：${winner.name} 是最后的幸存者。`,
      wait: 0,
      log: `${winner.name} 获胜`,
    };
  }

  /* ---------------- 校验 / 代打 / bot ---------------- */

  validate(ask, act) {
    if (!act || typeof act !== 'object' || !act.action) return '缺少 action 字段';
    if (ask.kind !== 'declare') return '未知的 ask 类型';
    const a = act.action;
    const { lastBid, totalDice, aliveCount } = ask.payload || {};

    if (a.type === 'open') {
      if (!lastBid) return '还没有人叫点，只能先叫点';
      return null;
    }
    if (a.type !== 'declare') {
      return '需要 {"type":"declare","count":5,"face":3,"wild":true} 或 {"type":"open"}';
    }

    const count = Number(a.count);
    const face = Number(a.face);
    const wild = a.wild !== false;
    if (!Number.isInteger(count) || !Number.isInteger(face)) return 'count / face 必须是整数';
    if (face < 2 || face > 6) return 'face 只能叫 2–6';
    if (count < 1 || count > totalDice) return `count 必须在 1–${totalDice} 之间`;

    if (!lastBid) {
      if (count < aliveCount) return `首叫数量至少 ${aliveCount} 个`;
      return null;
    }
    if (count < lastBid.count) return `数量不能变小（上家 ${lastBid.count} 个）`;
    if (count === lastBid.count) {
      if (face <= lastBid.face) return `数量相同时点数必须大于 ${lastBid.face}`;
      if (wild !== lastBid.wild) return '数量相同时不能改变斋/非斋口径';
    }
    return null;
  }

  autoAct(ask) {
    if (ask.kind !== 'declare') return super.autoAct(ask);
    const { minRaise, canOpen } = ask.payload || {};
    if (minRaise) return { action: { type: 'declare', ...minRaise } };
    if (canOpen) return { action: { type: 'open' } };
    return { action: { type: 'declare', count: 1, face: 2, wild: true } };
  }

  botThought(p, kind, payload) {
    if (kind !== 'declare') return '';
    if (!payload?.lastBid) return `手上有 ${p.dice.length} 颗骰，先叫个保守的。`;
    const b = payload.lastBid;
    const prob = this.estimateProb(b.count, b.face, b.wild, p.dice);
    return `上家叫 ${bidText(b)}，我算它成立的概率约 ${Math.round(prob * 100)}%。`;
  }

  botAct(p, ask) {
    if (ask.kind !== 'declare') return super.autoAct(ask);
    const payload = ask.payload || {};
    const lastBid = payload.lastBid;

    if (lastBid && payload.canOpen) {
      const prob = this.estimateProb(lastBid.count, lastBid.face, lastBid.wild, p.dice);
      if (prob < 0.35) {
        return { action: { type: 'open' }, say: '开！' };
      }
    }

    const base = payload.minRaise;
    if (!base) return { action: { type: 'open' }, say: '只能开了。' };

    // 有一定概率多抬一个数量，或偶尔改叫斋，制造变化
    let bid = { ...base };
    if (base.count + 1 <= payload.totalDice && Math.random() < 0.3) {
      bid = { count: base.count + 1, face: base.face, wild: base.wild };
    }
    if (bid.count > lastBid?.count && Math.random() < 0.2) bid = { ...bid, wild: false };

    return { action: { type: 'declare', ...bid } };
  }

  /* ---------------- 私有信息 / 桌面 / 说明 ---------------- */

  secretOf(p) {
    return { kind: 'dice', data: p.dice.slice() };
  }

  tableState() {
    const alive = this.aliveCount();
    const total = this.totalDice();
    const bid = this.lastBid;
    return {
      title: `${this.phase === 'bid' ? '叫点' : '结算'} · 第 ${this.round} 局`,
      rows: [
        { label: '存活', value: `${alive} / ${this.players.length}` },
        { label: '全场骰数', value: `${total} 颗` },
        { label: '当前叫点', value: bid ? bidText(bid) : '尚未开叫' },
      ],
      note: '首叫数量不小于存活人数；1 为非斋百搭；开盅时实际数量够则质疑者输，不够则叫点者输。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '大话骰',
      gameTitle: '大话骰（Liar\'s Dice）',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 2–6 人，每人 5 颗六面骰，开局摇骰，只看自己的骰面；全场骰数 = 存活人数 × 5（掉骰后递减）。',
        '- 首叫 `X个Y`：X 不小于存活人数，默认非斋（`wild:true`，1 为百搭可算任意点数）。',
        '- 后续叫点必须「数量变大」，或「数量相同且点数变大」；数量相同时不能改变斋/非斋口径。',
        '- `wild:false` 为斋：1 只算 1，不再百搭。叫的点数只能 2–6。',
        '- 轮到你时二选一：加码叫点（`declare`）或开盅质疑上家（`open`）。首回合没有上家，只能叫点。',
        '- 开盅统计全场符合点数的骰子（非斋时 1 一并计入）：实际 ≥ 叫点 → 质疑者输；实际 < 叫点 → 叫点者输。',
        '- 输者掉 1 颗骰并重摇，下一局由输者先叫；骰子归零淘汰，最后存活者获胜。',
      ],
      askRows: [
        ['declare', '轮到你叫点 / 开盅', '{"type":"declare","count":5,"face":3,"wild":true} 或 {"type":"open"}'],
      ],
      notes: [
        '你的骰面只在 `you.secret.data`（kind 为 `dice`）里，别人看不到。',
        '`ask.payload.lastBid` 是上家叫点，`minRaise` 是最小合法加码；没有合法加码时必须开盅。',
        '`say` 是叫点台词；`thought` 会实时投屏，但不会泄露骰面。',
      ],
      tableRows: [
        { label: '轮次', value: state?.round ?? 1 },
        { label: '存活', value: `${state?.players?.filter((p) => p.alive).length ?? 0} 人` },
        { label: '当前叫点', value: state?.table?.rows?.find((r) => r.label === '当前叫点')?.value ?? '—' },
      ],
      players: state?.players || [],
    });
  }
}
