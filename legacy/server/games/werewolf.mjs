// 狼人杀：6 人明牌局（2 狼人 + 预言家 + 猎人 + 2 平民）。规则锁定版见 GAME_PLAYBOOK.md 第 3 节。
import { GameBase, shuffle, pick, clamp } from '../core/base.mjs';
import { renderBriefBase } from '../core/brief-kit.mjs';

const ROLE_TEXT = { wolf: '狼人', seer: '预言家', hunter: '猎人', villager: '平民' };
const ROLES = ['wolf', 'wolf', 'seer', 'hunter', 'villager', 'villager'];

const SPEECH = {
  wolf: [
    '先听大家说，我暂时没有明确怀疑。',
    '昨晚太安静了，我怀疑有人在带节奏。',
    '我觉得发言最含糊的那个有问题。',
  ],
  seer: [
    '我是预言家，我手里有晚上的查验信息。',
    '我是预言家，请把票压住，别投我。',
    '我有查验结果，先听我把话说完。',
  ],
  hunter: [
    '我是好人，票别投在我身上。',
    '我手里有牌，今天先听大家的。',
    '稳一点，别乱来。',
  ],
  villager: [
    '我是普通村民，先说我的怀疑。',
    '昨晚我没听到什么动静。',
    '我怀疑发言最保守的那个。',
  ],
};

const LAST_WORDS = [
  '我没什么好说的，你们继续。',
  '我可能信错人了，抱歉。',
  '记住我的身份，好好打剩下的。',
];

export class Werewolf extends GameBase {
  constructor(opts = {}) {
    super({ ...opts, gameType: 'werewolf' });
    this.minSeats = 6;
    this.maxSeats = 6;
    this.seats = clamp(this.seats, 6, 6);
    this.gameTitle = '狼人杀';
  }

  setup() {
    this.round = 1;
    this.phase = 'night';
    this.accused = {};
    const roles = shuffle(ROLES);
    this.players.forEach((p, i) => {
      p.role = roles[i];
      p.team = p.role === 'wolf' ? 'wolf' : 'good';
      p.alive = true;
      p.hp = 1;
      p.maxHp = 1;
      p.folded = false;
      p.rolePublic = false;
      p.teamPublic = false;
      p.say = '';
      p.thought = '';
      p.meta = { checked: [] };
    });
  }

  /* ---------------- 工具 ---------------- */

  wolvesOf(list = this.aliveList) { return list.filter((p) => p.role === 'wolf'); }

  goodOf(list = this.aliveList) { return list.filter((p) => p.team === 'good'); }

  judge() {
    const wolves = this.wolvesOf().length;
    const good = this.goodOf().length;
    if (wolves === 0) return { id: 'good', name: '好人阵营' };
    if (good === 0) return { id: 'wolf', name: '狼人阵营' };
    return null;
  }

  killPlayer(p) {
    p.alive = false;
    p.hp = 0;
    p.folded = true;
    p.rolePublic = true;
    p.teamPublic = true;
  }

  // 发言里提到谁，就给谁记一笔被指控（用于白天投票收敛）
  noteAccusation(text) {
    if (!text) return;
    for (const p of this.aliveList) {
      if (p.name && String(text).includes(p.name)) this.accused[p.id] = (this.accused[p.id] || 0) + 1;
    }
  }

  mostAccused(ids = []) {
    let best = null;
    let bestN = 0;
    for (const id of ids) {
      const n = this.accused[id] || 0;
      if (n > bestN) { best = id; bestN = n; }
    }
    return best;
  }

  async *applyDeaths(list) {
    for (const d of list) {
      const p = d?.p;
      if (!p || !p.alive) continue;
      this.killPlayer(p);
      yield {
        t: 'death',
        playerId: p.id,
        cause: d.cause,
        text: `${p.name} ${d.cause === 'wolf' ? '昨夜倒牌' : d.cause === 'vote' ? '被投票放逐' : '中枪倒下'}。`,
        wait: 180,
        log: `${p.name} 死亡`,
      };
      yield {
        t: 'reveal',
        playerId: p.id,
        role: p.role,
        text: `${p.name} 的身份是${ROLE_TEXT[p.role]}。`,
        wait: 120,
      };
    }
  }

  // 猎人开枪：返回 {p, cause:'shot'} 或 null
  async *hunterShoot(hunter) {
    const cands = this.aliveList.filter((p) => p.id !== hunter.id).map((p) => p.id);
    if (!cands.length) return null;

    const conf = yield* this.askFor(
      hunter,
      'confirm',
      { prompt: '你是猎人，可以开枪带走一名存活玩家。是否发动？', candidates: cands },
      { phase: 'hunter' },
    );
    if (conf.action?.use !== true) {
      yield { t: 'shoot', playerId: hunter.id, targetId: null, text: `${hunter.name} 选择不开枪。`, wait: 140 };
      return null;
    }

    const vote = yield* this.askFor(
      hunter,
      'vote',
      { candidates: cands, prompt: '选择开枪目标' },
      { phase: 'hunter-shot' },
    );
    let tid = vote.action?.targetId;
    if (!cands.includes(tid)) tid = pick(cands);

    const target = this.byId(tid);
    yield {
      t: 'shoot',
      playerId: hunter.id,
      targetId: tid,
      text: `${hunter.name} 开枪，带走了 ${target.name}。`,
      wait: 220,
      log: `${hunter.name} 开枪带走 ${target.name}`,
    };
    return { p: target, cause: 'shot' };
  }

  secretLine(p) {
    if (p.role === 'wolf') {
      const allies = this.players.filter((x) => x.role === 'wolf' && x.id !== p.id).map((x) => x.name);
      return `你的身份是狼人。同伴：${allies.join('、')}。`;
    }
    return `你的身份是${ROLE_TEXT[p.role]}。`;
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    yield {
      t: 'begin',
      text: '狼人杀 · 6 人明牌局：2 狼人、1 预言家、1 猎人、2 平民。狼人全灭好人胜，好人全灭狼人胜。',
      wait: 350,
      log: '开局',
    };

    for (const p of this.players) {
      yield { t: 'intel', secretFor: p.id, playerId: p.id, text: `${this.secretLine(p)}（仅你可见）`, wait: 0 };
    }

    let winner = null;

    while (!winner) {
      winner = this.judge();
      if (winner) break;

      /* ---------------- 夜晚 ---------------- */
      this.phase = 'night';
      yield {
        t: 'phase',
        phase: 'night',
        round: this.round,
        text: `第 ${this.round} 夜 · 天黑请闭眼`,
        wait: 180,
        log: `第 ${this.round} 夜`,
      };

      const wolves = this.wolvesOf();
      const goods = this.goodOf();
      let wolfTarget = null;

      if (wolves.length && goods.length) {
        const cand = goods.map((p) => p.id);
        const votes = yield* this.askMany(
          wolves,
          'vote',
          () => ({ candidates: cand, prompt: '狼人共同刀人：选一名今晚要击杀的玩家' }),
          () => ({ phase: 'night-wolf' }),
          { phase: 'night-wolf' },
        );
        const tally = {};
        for (const w of wolves) {
          const t = votes[w.id]?.action?.targetId;
          if (t && cand.includes(t)) tally[t] = (tally[t] || 0) + 1;
        }
        const max = Math.max(0, ...Object.values(tally));
        const tops = Object.keys(tally).filter((k) => tally[k] === max);
        wolfTarget = max > 0 ? pick(tops) : pick(cand);
      }

      // 预言家查验（结果只发给本人）
      const seer = this.aliveList.find((p) => p.role === 'seer');
      if (seer) {
        const cand = this.aliveList.filter((p) => p.id !== seer.id).map((p) => p.id);
        if (cand.length) {
          const act = yield* this.askFor(
            seer,
            'vote',
            { candidates: cand, prompt: '查验一名玩家的阵营' },
            { phase: 'night-seer' },
          );
          let tid = act.action?.targetId;
          if (!cand.includes(tid)) tid = pick(cand);
          const t = this.byId(tid);
          seer.meta.checked = [...new Set([...(seer.meta.checked || []), tid])];
          yield {
            t: 'intel',
            secretFor: seer.id,
            playerId: seer.id,
            targetId: tid,
            camp: t.team,
            text: `查验结果：${t.name} 是${t.team === 'wolf' ? '狼人' : '好人'}。（仅你可见）`,
            wait: 120,
          };
        }
      }

      /* ---------------- 天亮 ---------------- */
      this.phase = 'dawn';
      yield { t: 'phase', phase: 'dawn', text: `第 ${this.round} 天 · 天亮了`, wait: 160 };

      const nightDeaths = [];
      if (wolfTarget) nightDeaths.push({ p: this.byId(wolfTarget), cause: 'wolf' });

      const nightExtra = [];
      for (const d of nightDeaths) {
        if (d.p && d.p.role === 'hunter') {
          const shot = yield* this.hunterShoot(d.p);
          if (shot) nightExtra.push(shot);
        }
      }

      if (!nightDeaths.length) {
        yield { t: 'phase', phase: 'dawn', text: '昨夜是平安夜，无人死亡。', wait: 140 };
      }

      // 首夜死亡有遗言（此时尚未标记死亡，可正常提问）
      if (this.round === 1) {
        const speakers = [...nightDeaths, ...nightExtra].map((d) => d.p).filter((p) => p && p.alive);
        if (speakers.length) {
          const acts = yield* this.askMany(
            speakers,
            'free',
            () => ({ prompt: '你已倒牌，留一句遗言。', maxLen: 60 }),
            () => ({ phase: 'lastword' }),
            { phase: 'lastword' },
          );
          for (const p of speakers) {
            const text = String(acts[p.id]?.action?.text || '').slice(0, 60);
            if (text) yield { t: 'say', playerId: p.id, text, log: `${p.name}（遗言）：${text}`, wait: 100 };
          }
        }
      }

      yield* this.applyDeaths([...nightDeaths, ...nightExtra]);
      winner = this.judge();
      if (winner) break;

      /* ---------------- 白天发言 ---------------- */
      this.phase = 'speech';
      this.accused = {};
      yield {
        t: 'phase',
        phase: 'day',
        text: `第 ${this.round} 天 · 存活 ${this.aliveList.length} 人，依次发言。`,
        wait: 140,
      };

      for (const p of this.aliveList.slice()) {
        const act = yield* this.askFor(
          p,
          'free',
          { prompt: '用一句话表明立场，可以点出你怀疑的人。', maxLen: 60 },
          { phase: 'speech' },
        );
        const text = String(act.action?.text || '').slice(0, 60) || '……';
        p.say = text;
        this.noteAccusation(text);
        yield { t: 'say', playerId: p.id, text, log: `${p.name}：${text}`, wait: 90 };
      }

      /* ---------------- 放逐投票 ---------------- */
      this.phase = 'vote';
      yield { t: 'phase', phase: 'vote', text: '发言结束，开始放逐投票。', wait: 130 };

      const voters = this.aliveList.slice();
      const votes = yield* this.askMany(
        voters,
        'vote',
        (p) => ({ candidates: voters.filter((x) => x.id !== p.id).map((x) => x.id), prompt: '投票放逐一名玩家' }),
        () => ({ phase: 'vote' }),
        { phase: 'vote' },
      );

      const tally = {};
      for (const p of voters) {
        const t = votes[p.id]?.action?.targetId;
        if (t && t !== p.id && this.byId(t)?.alive) tally[t] = (tally[t] || 0) + 1;
      }
      const max = Math.max(0, ...Object.values(tally));
      const tops = Object.keys(tally).filter((k) => tally[k] === max);
      const tallyText = Object.entries(tally).map(([id, n]) => `${this.nameOf(id)} ${n} 票`).join('，') || '无人得票';
      yield {
        t: 'vote-result',
        tally,
        max,
        text: `放逐投票：${tallyText}。`,
        wait: 220,
        log: `投票 ${tallyText}`,
      };

      const dayDeaths = [];
      if (tops.length === 1 && max > 0) {
        const out = this.byId(tops[0]);
        yield { t: 'phase', phase: 'exile', text: `${out.name} 得票最高，将被放逐。`, wait: 150 };

        const dayExtra = [];
        if (out.role === 'hunter') {
          const shot = yield* this.hunterShoot(out);
          if (shot) dayExtra.push(shot);
        }

        const act = yield* this.askFor(
          out,
          'free',
          { prompt: '你被放逐了，留一句遗言。', maxLen: 60 },
          { phase: 'lastword' },
        );
        const text = String(act.action?.text || '').slice(0, 60);
        if (text) yield { t: 'say', playerId: out.id, text, log: `${out.name}（遗言）：${text}`, wait: 100 };

        dayDeaths.push({ p: out, cause: 'vote' }, ...dayExtra);
      } else {
        yield { t: 'phase', phase: 'tie', text: '平票，本轮无人被放逐。', wait: 150 };
      }

      yield* this.applyDeaths(dayDeaths);
      winner = this.judge();
      if (winner) break;

      this.round += 1;
    }

    this.finish(winner);
    yield {
      t: 'end',
      winnerId: winner.id,
      winnerName: winner.name,
      text: `游戏结束：${winner.name} 获胜。`,
      wait: 0,
      log: `${winner.name} 获胜`,
    };
  }

  /* ---------------- 校验 / 代打 / bot ---------------- */

  validate(ask, act) {
    if (!act || typeof act !== 'object' || !act.action) return '缺少 action 字段';
    const a = act.action;

    if (ask.kind === 'free') {
      if (a.type !== 'text') return '需要 {"type":"text","text":"..."}';
      const text = String(a.text || '').trim();
      if (!text) return '发言不能为空';
      if (text.length > 60) return '发言最多 60 字';
      return null;
    }
    if (ask.kind === 'vote') {
      if (a.type !== 'vote') return '需要 {"type":"vote","targetId":"p1"}';
      const cands = ask.payload?.candidates || [];
      if (!cands.includes(a.targetId)) return 'targetId 不在候选里';
      return null;
    }
    if (ask.kind === 'confirm') {
      if (a.type !== 'confirm') return '需要 {"type":"confirm","use":true|false}';
      if (typeof a.use !== 'boolean') return 'use 必须是布尔值';
      return null;
    }
    return '未知的 ask 类型';
  }

  autoAct(ask) {
    if (ask.kind === 'free') return { action: { type: 'text', text: '我先过。' } };
    if (ask.kind === 'confirm') return { action: { type: 'confirm', use: false } };
    if (ask.kind === 'vote') {
      const cands = ask.payload?.candidates || [];
      return { action: { type: 'vote', targetId: cands.length ? pick(cands) : null } };
    }
    return super.autoAct(ask);
  }

  botThought(p, kind, payload, context) {
    const phase = context?.phase;
    if (kind === 'vote' && phase === 'night-wolf') return '挑一个对狼队威胁最大的。';
    if (kind === 'vote' && phase === 'night-seer') return '验一个还没查过的。';
    if (kind === 'confirm') return '被抓住了，要不要带走一个。';
    if (kind === 'free' && phase === 'lastword') return '留句话，别暴露太多。';
    if (kind === 'free') return p.role === 'wolf' ? '混在好人里，别被盯上。' : '把自己的立场说清楚。';
    if (kind === 'vote') return p.role === 'wolf' ? '把票投给好人。' : '投最像狼的那个。';
    return '';
  }

  botAct(p, ask) {
    const phase = ask.context?.phase;

    if (ask.kind === 'free') {
      if (phase === 'lastword') return { action: { type: 'text', text: pick(LAST_WORDS) } };
      const others = this.aliveList.filter((x) => x.id !== p.id);
      let text = pick(SPEECH[p.role] || SPEECH.villager);
      if (others.length) {
        let t;
        if (p.role === 'wolf') {
          const good = others.filter((x) => x.team === 'good');
          const claimed = good.filter((x) => String(x.say || '').includes('预言家'));
          t = pick(claimed.length ? claimed : (good.length ? good : others));
        } else {
          const top = this.mostAccused(others.map((x) => x.id));
          t = top ? this.byId(top) : pick(others);
        }
        text = `${text} 我怀疑 ${t.name}。`;
      }
      return { action: { type: 'text', text: text.slice(0, 60) } };
    }

    if (ask.kind === 'confirm') return { action: { type: 'confirm', use: true } };

    if (ask.kind === 'vote') {
      const cands = (ask.payload?.candidates || []).map((id) => this.byId(id)).filter(Boolean);
      if (!cands.length) return { action: { type: 'vote', targetId: null } };

      if (phase === 'night-wolf') {
        // 优先刀已自称预言家的好人
        const claimed = cands.filter((x) => String(x.say || '').includes('预言家'));
        const good = cands.filter((x) => x.team === 'good');
        const pool = claimed.length ? claimed : (good.length ? good : cands);
        const t = pick(pool);
        return { action: { type: 'vote', targetId: t.id } };
      }

      if (phase === 'night-seer') {
        const checked = new Set(p.meta.checked || []);
        const fresh = cands.filter((x) => !checked.has(x.id));
        const t = pick(fresh.length ? fresh : cands);
        return { action: { type: 'vote', targetId: t.id } };
      }

      if (phase === 'hunter-shot') {
        const wolves = cands.filter((x) => x.team === 'wolf');
        const t = pick(wolves.length && Math.random() < 0.7 ? wolves : cands);
        return { action: { type: 'vote', targetId: t.id }, say: `我带走 ${t.name}。` };
      }

      // 白天放逐投票：好人跟随指控，狼人投好人（优先已自称预言家）
      let target = pick(cands);
      if (p.role === 'wolf') {
        const good = cands.filter((x) => x.team === 'good');
        const claimed = good.filter((x) => String(x.say || '').includes('预言家'));
        const pool = claimed.length ? claimed : (good.length ? good : cands);
        const top = this.mostAccused(pool.map((x) => x.id));
        target = top ? this.byId(top) : pick(pool);
      } else {
        const top = this.mostAccused(cands.map((x) => x.id));
        if (top) target = this.byId(top);
      }
      return { action: { type: 'vote', targetId: target.id }, say: `我投 ${target.name}。` };
    }

    return super.autoAct(ask);
  }

  /* ---------------- 私有信息 / 桌面 / 说明 ---------------- */

  secretOf(p) {
    if (p.role === 'wolf') {
      const allies = this.players.filter((x) => x.role === 'wolf' && x.id !== p.id);
      return { kind: 'role', data: { role: 'wolf', allies: allies.map((x) => x.id), allyNames: allies.map((x) => x.name) } };
    }
    if (p.role === 'seer') {
      return { kind: 'role', data: { role: 'seer', checked: (p.meta.checked || []).slice() } };
    }
    if (p.role === 'hunter') return { kind: 'role', data: { role: 'hunter' } };
    return { kind: 'role', data: { role: 'villager' } };
  }

  tableState() {
    const alive = this.aliveList;
    const wolves = this.wolvesOf(alive).length;
    const phaseText = this.phase === 'night' ? '夜晚' : this.phase === 'vote' ? '投票' : '白天';
    return {
      title: `${phaseText} · 第 ${this.round} 轮`,
      rows: [
        { label: '存活', value: `${alive.length} / ${this.players.length}` },
        { label: '狼人存活', value: `${wolves} 名` },
        { label: '好人存活', value: `${alive.length - wolves} 名` },
      ],
      note: '屠城局：狼人全灭好人胜，好人全灭狼人胜；平票无人放逐；猎人可开枪带走一人。',
    };
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '狼人杀',
      gameTitle: '狼人杀 · 6 人明牌局',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 固定 6 人：2 狼人、1 预言家、1 猎人、2 平民。身份随机分配，死亡后公开身份（明牌局）。',
        '- 夜晚：狼人共同刀人（每名狼人各投一票，多数决，平票随机）→ 预言家查验一人阵营（结果只发给预言家）→ 天亮。',
        '- 白天：公布死亡 → 存活玩家依次发言 → 全员投票放逐，得票唯一最高者出局；平票无人放逐。',
        '- 被放逐者可留一句遗言；首夜死亡者也有遗言，之后夜晚死亡无遗言。',
        '- 猎人被狼人击杀或被投票放逐时可以开枪，带走一名存活玩家。本版无女巫，不存在被毒杀。',
        '- 狼人全部出局 → 好人胜；好人全部出局 → 狼人胜（屠城版）。',
      ],
      askRows: [
        ['vote', '夜晚刀人 / 查验 / 白天放逐投票', '{"type":"vote","targetId":"p2"}'],
        ['free', '白天发言 / 遗言', '{"type":"text","text":"我怀疑 3 号。"}'],
        ['confirm', '猎人开枪前确认', '{"type":"confirm","use":true}'],
      ],
      notes: [
        '你的身份只在 `you.secret`（kind 为 `role`）里；狼人额外拿到同伴 id，预言家只能看到自己的查验结果。',
        '夜晚狼人投票与预言家查验同时进行，天亮才公布死亡。',
        '猎人开枪先回答 `confirm`（use=false 表示不开枪），同意后再收到一次 `vote` 选目标。',
      ],
      tableRows: [
        { label: '轮次', value: state?.round ?? 1 },
        { label: '存活', value: `${state?.players?.filter((p) => p.alive).length ?? 0} 人` },
        { label: '阶段', value: state?.phase ?? '—' },
      ],
      players: state?.players || [],
    });
  }
}
