// 谁是卧底：描述 + 投票。插件参考实现。
import { GameBase, shuffle, pick } from '../base.mjs';
import { renderBriefBase } from '../brief-kit.mjs';

export const WORD_PAIRS = [
  { a: '豆浆', b: '牛奶', ha: ['早餐', '白色', '豆子做的'], hb: ['早餐', '白色', '奶牛产的'] },
  { a: '玫瑰', b: '月季', ha: ['花', '带刺', '送人'], hb: ['花', '带刺', '花期长'] },
  { a: '辣椒', b: '芥末', ha: ['辣的', '调味', '红色'], hb: ['辣的', '调味', '绿色'] },
  { a: '面包', b: '蛋糕', ha: ['主食', '烤的', '便宜'], hb: ['甜点', '烤的', '生日'] },
  { a: '端午节', b: '中秋节', ha: ['传统节日', '粽子', '五月初五'], hb: ['传统节日', '月饼', '八月十五'] },
  { a: '童话', b: '神话', ha: ['故事', '写给小孩', '王子公主'], hb: ['故事', '很古老', '神仙'] },
  { a: '电影院', b: '剧院', ha: ['看戏的地方', '黑', '大银幕'], hb: ['看戏的地方', '舞台', '现场'] },
  { a: '地铁', b: '公交', ha: ['交通工具', '城市', '地下'], hb: ['交通工具', '城市', '地面'] },
  { a: '咖啡', b: '茶', ha: ['饮料', '提神', '苦'], hb: ['饮料', '提神', '叶子泡的'] },
  { a: '雪碧', b: '可乐', ha: ['汽水', '透明', '柠檬味'], hb: ['汽水', '黑色', '焦糖味'] },
  { a: '游泳', b: '跳水', ha: ['水上运动', '泳池', '横着'], hb: ['水上运动', '泳池', '往下'] },
  { a: '医生', b: '护士', ha: ['医院', '白大褂', '开药'], hb: ['医院', '白大褂', '打针'] },
  { a: '篮球', b: '排球', ha: ['球类', '用手', '篮筐'], hb: ['球类', '用手', '网'] },
  { a: '口红', b: '唇膏', ha: ['涂嘴唇', '化妆品', '有颜色'], hb: ['涂嘴唇', '护肤品', '无色'] },
];

export class Undercover extends GameBase {
  constructor(opts = {}) {
    super({ ...opts, gameType: 'undercover' });
    this.minSeats = 4;
    this.maxSeats = 8;
    this.gameTitle = '谁是卧底';
    this.spyCount = 1;
    this.wordPair = null;
  }

  setup() {
    this.spyCount = this.players.length >= 6 ? 2 : 1;
    this.wordPair = pick(WORD_PAIRS, () => this.rng());
    const flip = this.rng() < 0.5;
    const civWord = flip ? this.wordPair.a : this.wordPair.b;
    const spyWord = flip ? this.wordPair.b : this.wordPair.a;
    const civHints = flip ? this.wordPair.ha : this.wordPair.hb;
    const spyHints = flip ? this.wordPair.hb : this.wordPair.ha;

    const idx = shuffle(this.players.map((_, i) => i), () => this.rng());
    const spies = new Set(idx.slice(0, this.spyCount));
    this.players.forEach((p, i) => {
      const isSpy = spies.has(i);
      p.role = isSpy ? 'spy' : 'civilian';
      p.team = isSpy ? 'spy' : 'civilian';
      p.hp = 1;
      p.maxHp = 1;
      p.meta.word = isSpy ? spyWord : civWord;
      p.meta.hints = isSpy ? spyHints : civHints;
    });
    this.phase = 'describe';
  }

  async *drive() {
    yield {
      t: 'begin',
      text: `谁是卧底开始：${this.players.length} 人，${this.spyCount} 名卧底。`,
      wait: 400,
    };

    let winner = null;
    while (!winner) {
      this.phase = 'describe';
      yield { t: 'phase', phase: 'describe', text: `第 ${this.round} 轮 · 描述`, wait: 200 };

      for (const p of this.aliveList) {
        const act = yield* this.askFor(p, 'free', {
          prompt: '用一句话描述你的词，不能出现词中任何一个字。',
          maxLen: 60,
        }, { round: this.round });
        const text = String(act.action?.text || act.say || '……').slice(0, 60);
        p.say = text;
        yield { t: 'say', playerId: p.id, text, log: `${p.name}：${text}`, wait: 260 };
        this.checkWordLeak(p, text);
      }

      this.phase = 'vote';
      yield { t: 'phase', phase: 'vote', text: '描述结束，开始投票。', wait: 200 };
      const voters = this.aliveList;
      const results = yield* this.askMany(
        voters,
        'vote',
        (p) => ({ candidates: this.aliveList.filter((x) => x.id !== p.id).map((x) => x.id) }),
        () => ({ round: this.round }),
        { phase: 'vote' },
      );

      const tally = {};
      for (const p of voters) {
        const target = results[p.id]?.action?.targetId;
        if (target && this.byId(target)?.alive) tally[target] = (tally[target] || 0) + 1;
      }
      const max = Math.max(0, ...Object.values(tally));
      const tops = Object.entries(tally).filter(([, n]) => n === max).map(([id]) => id);
      yield {
        t: 'vote-result',
        tally,
        text: max === 0 ? '全员弃票，本轮无人出局。' : `票数：${Object.entries(tally).map(([id, n]) => `${this.nameOf(id)} ${n}`).join('，')}`,
        wait: 400,
      };

      if (tops.length === 1 && max > 0) {
        const out = this.byId(tops[0]);
        out.alive = false;
        out.rolePublic = true;
        out.teamPublic = true;
        yield {
          t: 'reveal',
          playerId: out.id,
          role: out.role,
          text: `${out.name} 被投出，身份是${out.role === 'spy' ? '卧底' : '平民'}。`,
          wait: 600,
        };
      } else {
        yield { t: 'tie', text: '平票，本轮无人出局。', wait: 400 };
      }

      winner = this.judge();
      if (!winner) this.round += 1;
    }

    this.finish(winner);
    yield {
      t: 'end',
      winnerId: winner.id,
      winnerName: winner.name,
      text: `游戏结束：${winner.name}。`,
      wait: 0,
    };
  }

  checkWordLeak(p, text) {
    const word = p.meta.word || '';
    const hit = [...word].some((ch) => ch && text.includes(ch));
    if (hit) {
      p.caught += 1;
      this.emit({
        t: 'warn',
        playerId: p.id,
        text: `${p.name} 的描述里出现了词中的字（仅记录，不判罚）。`,
      });
    }
  }

  judge() {
    const spies = this.players.filter((p) => p.alive && p.role === 'spy');
    const civ = this.players.filter((p) => p.alive && p.role === 'civilian');
    if (spies.length === 0) return { id: 'civilian', name: '平民阵营' };
    if (spies.length >= civ.length) return { id: 'spy', name: '卧底阵营' };
    return null;
  }

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';
    if (ask.kind === 'free') {
      if (a.type !== 'text') return '需要 {"type":"text","text":"..."}';
      const text = String(a.text || '').trim();
      if (!text) return '描述不能为空';
      if (text.length > 60) return '描述最多 60 字';
      return null;
    }
    if (ask.kind === 'vote') {
      if (a.type !== 'vote') return '需要 {"type":"vote","targetId":"p1"}';
      if (!ask.payload.candidates.includes(a.targetId)) return 'targetId 不在候选里';
      return null;
    }
    return '未知的 ask 类型';
  }

  autoAct(ask) {
    if (ask.kind === 'free') return { action: { type: 'text', text: '和日常有关，很常见。' } };
    if (ask.kind === 'vote') {
      const c = ask.payload.candidates || [];
      return { action: { type: 'vote', targetId: c[Math.floor(this.rng() * c.length)] } };
    }
    return super.autoAct(ask);
  }

  botThought(p, kind) {
    if (kind === 'free') return p.role === 'spy' ? '我的词和他们不一样，说得模糊一点。' : '说一个特征，别太具体。';
    if (kind === 'vote') return '谁说得最含糊，就投谁。';
    return '';
  }

  botAct(p, ask) {
    if (ask.kind === 'free') {
      const hints = p.meta.hints || ['很常见'];
      const h = hints[Math.floor(this.rng() * hints.length)];
      return { action: { type: 'text', text: `跟「${h}」有关。` }, say: `跟「${h}」有关。` };
    }
    if (ask.kind === 'vote') {
      const cands = (ask.payload.candidates || []).map((id) => this.byId(id)).filter(Boolean);
      if (!cands.length) return { action: { type: 'vote', targetId: null } };
      let target = pick(cands, () => this.rng());
      if (p.role === 'spy') {
        const civ = cands.filter((x) => x.role !== 'spy');
        if (civ.length) target = pick(civ, () => this.rng());
      }
      return { action: { type: 'vote', targetId: target.id }, say: `我选 ${target.name}。` };
    }
    return super.autoAct(ask);
  }

  secretOf(p) {
    return { kind: 'word', data: { word: p.meta.word, isSpy: p.role === 'spy' } };
  }

  tableState() {
    const alive = this.aliveList.length;
    return {
      title: `${this.phase === 'vote' ? '投票' : '描述'} · 第 ${this.round} 轮`,
      rows: [
        { label: '存活', value: `${alive} / ${this.players.length}` },
        { label: '卧底', value: `${this.spyCount} 名（身份隐藏）` },
      ],
      note: '描述不能出现词中任何一个字；平票本轮无人出局。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '谁是卧底',
      gameTitle: '谁是卧底',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 多数人拿到同一个词（平民），少数人拿到相近但不同的词（卧底）。',
        '- 每轮每人用一句话描述自己的词，不能说出词中任何一个字，也不能复述别人。',
        '- 描述完投票，得票唯一最高者出局并公开身份；平票无人出局。',
        '- 卧底全部出局 → 平民胜；存活卧底数 ≥ 存活平民数 → 卧底胜。',
      ],
      askRows: [
        ['free', '轮到你描述', '{"type":"text","text":"圆圆的，早餐常见"}'],
        ['vote', '投票指认卧底', '{"type":"vote","targetId":"p2"}'],
      ],
      notes: [
        '你的词只在自己 `you.secret` 里，别人看不到。',
        '描述含禁字会被公开记录，但不自动判罚。',
      ],
      tableRows: [
        { label: '轮次', value: state?.round ?? 1 },
        { label: '存活', value: `${state?.players?.filter((p) => p.alive).length ?? 0} 人` },
      ],
      players: state?.players || [],
    });
  }
}
