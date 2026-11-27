// 密码名牌：两队各一名队长（spymaster）看关键卡，给「一词 + 数字」线索，猜手翻牌。
// 规则按 GAME_PLAYBOOK 第 5 节锁定版：25 张词卡、9/8/7/1 分布、N+1 次猜测、刺客即死。
import { GameBase, shuffle, pick, clamp } from '../core/base.mjs';
import { renderBriefBase } from '../core/brief-kit.mjs';

export const WORD_POOL = [
  '苹果', '香蕉', '西瓜', '葡萄', '橙子', '草莓', '柠檬', '菠萝',
  '鲸鱼', '老虎', '大象', '熊猫', '狐狸', '蝴蝶', '鲨鱼', '蜘蛛',
  '钢琴', '吉他', '鼓', '小提琴', '口琴', '喇叭',
  '医生', '教师', '警察', '厨师', '司机', '农民', '画家', '歌手',
  '北京', '巴黎', '东京', '埃及', '火星', '月球', '沙漠', '海洋', '森林', '雪人',
  '火车', '飞机', '轮船', '自行车', '火箭', '地铁',
  '咖啡', '面包', '蛋糕', '冰淇淋', '火锅', '月饼', '啤酒', '糖果',
  '足球', '篮球', '网球', '游泳', '滑雪', '拳击',
  '钥匙', '雨伞', '眼镜', '手表', '镜子', '剪刀', '梯子', '气球',
  '学校', '医院', '银行', '机场', '图书馆', '博物馆', '电影院', '监狱',
  '太阳', '星星', '彩虹', '闪电', '台风', '冰山',
  '手机', '电脑', '电视', '冰箱', '洗衣机', '电灯',
  '独角兽', '龙', '幽灵', '吸血鬼', '木乃伊', '海盗', '骑士', '巫师', '国王', '女王',
];

const COLOR_LABEL = { red: '红队', blue: '蓝队', neutral: '中立', assassin: '刺客' };
const TEAM_NAME = { red: '红队', blue: '蓝队' };
const BOT_CLUES = ['日常', '常见', '某种东西', '生活里', '大家都见过', '可以联想到'];

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

export class Codenames extends GameBase {
  constructor(opts = {}) {
    super({ ...opts, gameType: 'codenames' });
    this.minSeats = 4;
    this.maxSeats = 8;
    this.gameTitle = '密码名牌';
    this.seats = Math.max(4, Math.min(8, this.seats));

    this.words = [];
    this.keycard = {};
    this.revealed = {};
    this.turnTeam = 'red';
    this.startTeam = 'red';
    this.clue = null;
    this.guessIdx = { red: 0, blue: 0 };
  }

  setup() {
    const n = this.players.length;
    const order = shuffle(this.players);
    const redCount = Math.ceil(n / 2);
    const reds = order.slice(0, redCount);
    const blues = order.slice(redCount);

    const assign = (team, list) => {
      list.forEach((p, i) => {
        p.team = team;
        p.teamPublic = true;
        p.role = i === 0 ? 'spymaster' : 'guesser';
        p.rolePublic = true;
        p.alive = true;
        p.meta.isSpymaster = i === 0;
      });
    };
    assign('red', reds);
    assign('blue', blues);

    const pool = shuffle([...new Set(WORD_POOL)]);
    this.words = pool.slice(0, 25).map((word, i) => ({ id: `c${i}`, word }));

    this.startTeam = Math.random() < 0.5 ? 'red' : 'blue';
    const other = this.startTeam === 'red' ? 'blue' : 'red';
    const ids = shuffle(this.words.map((c) => c.id));
    this.keycard = {};
    ids.forEach((id, i) => {
      if (i < 9) this.keycard[id] = this.startTeam;
      else if (i < 17) this.keycard[id] = other;
      else if (i < 24) this.keycard[id] = 'neutral';
      else this.keycard[id] = 'assassin';
    });

    this.revealed = {};
    this.turnTeam = this.startTeam;
    this.clue = null;
    this.round = 0;
    this.guessIdx = { red: 0, blue: 0 };
    this.phase = 'clue';
  }

  /* ---------------- 查询 ---------------- */

  teamMembers(team) {
    return this.players.filter((p) => p.team === team);
  }

  spymasterOf(team) {
    return this.teamMembers(team).find((p) => p.role === 'spymaster');
  }

  unrevealed() {
    return this.words.filter((c) => !this.revealed[c.id]);
  }

  remainingOf(team) {
    return this.words.filter((c) => this.keycard[c.id] === team && !this.revealed[c.id]).length;
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    const n = this.players.length;
    yield {
      t: 'begin',
      text: `密码名牌开始：${n} 人分${TEAM_NAME.red}与${TEAM_NAME.blue}，${TEAM_NAME[this.startTeam]}先手（9 张）。`,
      wait: 200,
    };

    for (const team of ['red', 'blue']) {
      const spy = this.spymasterOf(team);
      if (!spy) continue;
      yield {
        t: 'intel',
        playerId: spy.id,
        secretFor: spy.id,
        text: `你是${TEAM_NAME[team]}队长，掌握全部关键卡。你的队伍有 ${this.remainingOf(team)} 张词卡。`,
        wait: 40,
      };
    }

    let winner = null;
    while (!winner) {
      const team = this.turnTeam;
      const spymaster = this.spymasterOf(team);
      this.round += 1;

      // 1) 队长给线索
      this.phase = 'clue';
      yield {
        t: 'phase',
        phase: 'clue',
        turnTeam: team,
        text: `第 ${this.round} 回合 · ${TEAM_NAME[team]}队长 ${spymaster?.name || '?'} 给线索。`,
        wait: 140,
      };

      const declare = yield* this.askFor(
        spymaster,
        'declare',
        {
          fields: ['word', 'number'],
          team,
          maxNumber: Math.max(1, this.remainingOf(team)),
          prompt: '给一个词 + 数字 N。线索不能包含任何未翻开词卡的原文。',
        },
        { team },
      );
      const word = String(declare.action?.word || '').trim();
      const number = clamp(Math.round(Number(declare.action?.number) || 1), 1, 9);
      this.clue = { word, number, team };

      yield {
        t: 'clue',
        team,
        word,
        number,
        spymasterId: spymaster?.id || null,
        text: `${TEAM_NAME[team]}队长给出线索：「${word}」 ${number}。`,
        wait: 220,
      };

      // 2) 猜手逐张猜，最多 N+1 次
      this.phase = 'guess';
      yield {
        t: 'phase',
        phase: 'guess',
        turnTeam: team,
        text: `最多可以猜 ${number + 1} 次。猜中刺客立即判负。`,
        wait: 120,
      };

      let guessesLeft = number + 1;
      const guessers = this.teamMembers(team).filter((p) => p.role !== 'spymaster');
      let gi = this.guessIdx[team] || 0;

      while (guessesLeft > 0 && !winner) {
        const cands = this.unrevealed().map((c) => c.id);
        if (!cands.length) break;
        const guesser = guessers[gi % guessers.length];
        gi += 1;

        const act = yield* this.askFor(
          guesser,
          'vote',
          { candidates: cands, mode: 'guess', guessesLeft, clue: { word, number } },
          { team, guessesLeft },
        );
        const cardId = act.action?.cardId;

        if (cardId === 'pass') {
          yield {
            t: 'turn',
            team,
            text: `${guesser.name} 选择停止猜测，${TEAM_NAME[team]}回合结束。`,
            wait: 180,
          };
          break;
        }

        const card = this.words.find((c) => c.id === cardId);
        if (!card) break;
        const color = this.keycard[cardId];
        this.revealed[cardId] = color;
        guessesLeft -= 1;

        yield {
          t: 'reveal',
          cardId,
          word: card.word,
          color,
          guesserId: guesser.id,
          text: `${guesser.name} 猜「${card.word}」—— ${COLOR_LABEL[color]}。`,
          wait: 200,
        };

        if (color === 'assassin') {
          const winTeam = team === 'red' ? 'blue' : 'red';
          yield {
            t: 'assassin',
            cardId,
            word: card.word,
            team,
            winnerTeam: winTeam,
            text: `猜到刺客「${card.word}」！${TEAM_NAME[team]}当场判负，${TEAM_NAME[winTeam]}获胜。`,
            wait: 400,
          };
          winner = { id: winTeam, name: TEAM_NAME[winTeam] };
          break;
        }

        if (this.remainingOf('red') === 0) {
          winner = { id: 'red', name: TEAM_NAME.red };
          break;
        }
        if (this.remainingOf('blue') === 0) {
          winner = { id: 'blue', name: TEAM_NAME.blue };
          break;
        }

        if (color !== team) {
          yield {
            t: 'turn',
            team,
            text: `猜中${COLOR_LABEL[color]}，${TEAM_NAME[team]}回合结束。`,
            wait: 180,
          };
          break;
        }
      }

      this.guessIdx[team] = gi;
      if (winner) break;

      this.turnTeam = team === 'red' ? 'blue' : 'red';
      yield {
        t: 'turn',
        team: this.turnTeam,
        text: `轮到${TEAM_NAME[this.turnTeam]}（红 ${this.remainingOf('red')} 张 / 蓝 ${this.remainingOf('blue')} 张）。`,
        wait: 200,
      };
    }

    const cardMap = this.words
      .map((c) => `${c.word}=${COLOR_LABEL[this.keycard[c.id]]}`)
      .join('，');
    yield { t: 'reveal', text: `关键卡公开：${cardMap}。`, wait: 260 };

    this.finish(winner);
    yield {
      t: 'end',
      winnerId: winner.id,
      winnerName: winner.name,
      text: `游戏结束：${winner.name}获胜。`,
      wait: 0,
    };
  }

  /* ---------------- 校验 ---------------- */

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';

    if (ask.kind === 'declare') {
      if (a.type !== 'declare') return '需要 {"type":"declare","word":"海洋","number":2}';
      const word = String(a.word || '').trim();
      if (!word) return '线索词不能为空';
      if ([...word].length > 12) return '线索最多 12 个字';
      const num = Number(a.number);
      if (!Number.isInteger(num) || num < 1 || num > 9) return 'number 必须是 1–9 的整数';

      const clue = norm(word);
      const leak = this.unrevealed().some((c) => {
        const w = norm(c.word);
        return w.includes(clue) || clue.includes(w);
      });
      if (leak) return '线索不能包含或等于未翻开词卡的原文';
      return null;
    }

    if (ask.kind === 'vote') {
      if (a.type !== 'vote') return '需要 {"type":"vote","cardId":"c3"}';
      if (a.cardId === 'pass') return null;
      if (!(ask.payload.candidates || []).includes(a.cardId)) return 'cardId 不在候选里';
      return null;
    }

    return '未知的 ask 类型';
  }

  autoAct(ask) {
    if (ask.kind === 'declare') return { action: { type: 'declare', word: '提示', number: 1 } };
    if (ask.kind === 'vote') {
      const cands = ask.payload.candidates || [];
      return { action: { type: 'vote', cardId: cands[0] || 'pass' } };
    }
    return super.autoAct(ask);
  }

  /* ---------------- bot ---------------- */

  botThought(p, kind, payload) {
    if (kind === 'declare') return '挑一个不会碰到词卡原文的通用线索。';
    if (kind === 'vote') return `还剩 ${payload?.guessesLeft ?? '?'} 次机会，随便翻一张。`;
    return '';
  }

  botAct(p, ask) {
    if (ask.kind === 'declare') {
      const own = this.words.filter((c) => this.keycard[c.id] === p.team && !this.revealed[c.id]);
      const wordsLeft = this.unrevealed().map((c) => norm(c.word));
      const safe = BOT_CLUES.filter((h) => {
        const clue = norm(h);
        return !wordsLeft.some((w) => w.includes(clue) || clue.includes(w));
      });
      const word = safe.length ? pick(safe) : '提示';
      const number = Math.max(1, Math.min(2, own.length));
      return { action: { type: 'declare', word, number }, say: `线索：「${word}」 ${number}。` };
    }

    if (ask.kind === 'vote') {
      const cands = (ask.payload.candidates || [])
        .map((id) => this.words.find((c) => c.id === id))
        .filter(Boolean);
      if (!cands.length) return { action: { type: 'vote', cardId: 'pass' } };
      const card = pick(cands);
      return { action: { type: 'vote', cardId: card.id }, say: `我猜「${card.word}」。` };
    }

    return super.autoAct(ask);
  }

  /* ---------------- 视图 ---------------- */

  secretOf(p) {
    if (!p) return null;
    if (p.role !== 'spymaster') return null;
    return { kind: 'keycard', data: { ...this.keycard }, team: p.team };
  }

  tableState() {
    const turn = this.turnTeam || 'red';
    const left = (team) => this.words.filter((c) => this.keycard[c.id] === team && !this.revealed[c.id]).length;
    return {
      title: `第 ${this.round || 0} 回合 · ${TEAM_NAME[turn]}行动`,
      rows: [
        { label: '剩余', value: `红 ${left('red')} 张 / 蓝 ${left('blue')} 张` },
        { label: '线索', value: this.clue ? `「${this.clue.word}」 ${this.clue.number}` : '等待队长' },
        { label: '已翻开', value: `${Object.keys(this.revealed || {}).length} / 25` },
      ],
      note: '队长看关键卡，猜手只看词。猜中刺客立即判负；猜中对方或中立结束回合。',
    };
  }

  publicState() {
    const s = super.publicState();
    s.words = (this.words || []).map((c) => ({ id: c.id, word: c.word, revealed: this.revealed[c.id] || null }));
    s.revealed = { ...(this.revealed || {}) };
    s.turnTeam = this.turnTeam;
    s.clue = this.clue ? { ...this.clue } : null;
    return s;
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '密码名牌',
      gameTitle: '密码名牌',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 4–8 人分成红蓝两队，每队第一人是队长（spymaster），其余是猜手。',
        '- 桌面 25 张词卡：先手队 9 张、后手队 8 张、中立 7 张、刺客 1 张。',
        '- 两名队长共享关键卡，能看到每张词的归属；猜手只看到词。',
        '- 队长每回合给「一个词 + 数字 N」，N 表示与线索相关的己方卡数量。',
        '- 猜手最多猜 N+1 次：猜中己方卡可继续；猜中对方或中立立即结束回合；猜中刺客立即判负。',
        '- 线索不能包含任何未翻开词卡的原文，也不能是某张未翻开词卡的片段。',
        '- 先翻完自己全部词卡的一方获胜。',
      ],
      askRows: [
        ['declare', '队长给线索', '{"type":"declare","word":"海洋","number":2}'],
        ['vote', '猜手翻一张牌', '{"type":"vote","cardId":"c7"}'],
        ['vote', '放弃剩余猜测', '{"type":"vote","cardId":"pass"}'],
      ],
      notes: [
        '队长身份与关键卡只在自己的 `you.secret`，猜手的 `secret` 为 null。',
        '`you.secret.data` 是 `{cardId: "red"|"blue"|"neutral"|"assassin"}`。',
        '猜手提交 `cardId:"pass"` 可以提前结束本队回合。',
      ],
      tableRows: [
        { label: '当前回合', value: TEAM_NAME[state?.turnTeam] || '红队' },
        { label: '剩余词卡', value: `红 ${(state?.words || []).filter((w) => w.revealed === 'red').length} / 蓝 ${(state?.words || []).filter((w) => w.revealed === 'blue').length}（已翻开）` },
      ],
      players: state?.players || [],
    });
  }
}
