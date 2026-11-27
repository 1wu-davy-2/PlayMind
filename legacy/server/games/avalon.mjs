// 阿瓦隆：组队 → 全员表决 → 队员并行提交任务牌 → 三次成功进入刺杀。
// 规则按 GAME_PLAYBOOK 第 4 节锁定版；本版不含莫德雷德。
import { GameBase, shuffle, pick } from '../core/base.mjs';
import { renderBriefBase } from '../core/brief-kit.mjs';

// 每个任务需要的队员数
export const MISSION_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// 阵营配置：固定包含 梅林 / 派西维尔 / 刺客，6 人起配莫甘娜，7 人起配爪牙。
export const ROLE_SETS = {
  5: ['merlin', 'percival', 'loyal', 'morgana', 'assassin'],
  6: ['merlin', 'percival', 'loyal', 'loyal', 'morgana', 'assassin'],
  7: ['merlin', 'percival', 'loyal', 'loyal', 'morgana', 'assassin', 'minion'],
  8: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'minion'],
  9: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'minion'],
  10: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'minion', 'minion'],
};

export const ROLE_LABEL = {
  merlin: '梅林',
  percival: '派西维尔',
  loyal: '忠臣',
  morgana: '莫甘娜',
  assassin: '刺客',
  minion: '爪牙',
};

export const EVIL_ROLES = new Set(['morgana', 'assassin', 'minion']);

const PHASE_LABEL = {
  team: '组队',
  vote: '表决',
  mission: '任务',
  assassinate: '刺杀',
  ended: '结束',
};

export class Avalon extends GameBase {
  constructor(opts = {}) {
    super({ ...opts, gameType: 'avalon' });
    this.minSeats = 5;
    this.maxSeats = 10;
    this.gameTitle = '阿瓦隆';
    this.seats = Math.max(5, Math.min(10, this.seats));

    this.missionSizes = MISSION_SIZES[5];
    this.missionIdx = 0;
    this.missions = [];
    this.rejectCount = 0;
    this.leaderIdx = 0;
    this.teamProposed = [];
    this.evilIds = [];
    this.merlinId = null;
    this.morganaId = null;
    this.assassinId = null;
  }

  setup() {
    const n = this.players.length;
    this.missionSizes = MISSION_SIZES[n] || MISSION_SIZES[5];
    this.missionIdx = 0;
    this.missions = [];
    this.rejectCount = 0;
    this.leaderIdx = Math.floor(Math.random() * n);
    this.teamProposed = [];

    const roles = shuffle(ROLE_SETS[n] || ROLE_SETS[5]);
    this.players.forEach((p, i) => {
      const role = roles[i];
      p.role = role;
      p.team = EVIL_ROLES.has(role) ? 'evil' : 'good';
      p.rolePublic = false;
      p.teamPublic = false;
      p.alive = true;
    });

    this.evilIds = this.players.filter((p) => p.team === 'evil').map((p) => p.id);
    this.merlinId = this.players.find((p) => p.role === 'merlin')?.id || null;
    this.morganaId = this.players.find((p) => p.role === 'morgana')?.id || null;
    this.assassinId = this.players.find((p) => p.role === 'assassin')?.id || null;

    // 派西维尔的「两个嫌疑人」固定下来，避免每次轮询顺序变化。
    const suspects = shuffle([this.merlinId, this.morganaId].filter(Boolean));
    for (const p of this.players) {
      if (p.role === 'percival') p.meta.suspects = suspects;
    }

    this.phase = 'team';
  }

  /* ---------------- 主循环 ---------------- */

  async *drive() {
    const n = this.players.length;
    yield {
      t: 'begin',
      text: `阿瓦隆开始：${n} 人局，${this.evilIds.length} 名坏人。第 1 个任务需要 ${this.missionSizes[0]} 人。`,
      wait: 200,
    };

    for (const p of this.players) {
      yield { t: 'intel', playerId: p.id, secretFor: p.id, text: this.intelText(p), wait: 40 };
    }

    let winner = null;
    const totalSuccess = () => this.missions.filter((m) => m === 'success').length;
    const totalFail = () => this.missions.filter((m) => m === 'fail').length;

    while (this.missionIdx < 5 && !winner) {
      const teamSize = this.missionSizes[this.missionIdx];

      // 1) 组队 → 表决，直到通过或累计 5 次否决
      let approvedTeam = null;
      while (!approvedTeam) {
        const leader = this.players[this.leaderIdx % n];
        this.phase = 'team';
        yield {
          t: 'phase',
          phase: 'team',
          missionIdx: this.missionIdx,
          leaderId: leader.id,
          text: `第 ${this.missionIdx + 1} 个任务 · 队长 ${leader.name} 组队（需要 ${teamSize} 人）`,
          wait: 120,
        };

        const teamAct = yield* this.askFor(
          leader,
          'multi-pick',
          {
            candidates: this.players.map((p) => p.id),
            min: teamSize,
            max: teamSize,
            teamSize,
            missionIdx: this.missionIdx,
          },
          { missionIdx: this.missionIdx, teamSize },
        );
        const ids = [...new Set((teamAct.action?.ids || []).filter((id) => this.byId(id)))].slice(0, teamSize);
        while (ids.length < teamSize) {
          const extra = this.players.find((p) => !ids.includes(p.id));
          if (!extra) break;
          ids.push(extra.id);
        }
        this.teamProposed = ids;

        yield {
          t: 'team',
          leaderId: leader.id,
          teamIds: ids.slice(),
          missionIdx: this.missionIdx,
          text: `${leader.name} 提名队伍：${ids.map((id) => this.nameOf(id)).join('、')}。全票表决开始。`,
          wait: 160,
        };

        this.phase = 'vote';
        const votes = yield* this.askMany(
          this.players,
          'vote',
          () => ({ mode: 'approve', missionIdx: this.missionIdx }),
          () => ({ teamIds: ids.slice(), leaderId: leader.id }),
          { phase: 'vote' },
        );

        const detail = {};
        let approve = 0;
        let reject = 0;
        for (const p of this.players) {
          const yes = votes[p.id]?.action?.approve === true;
          detail[p.id] = yes;
          if (yes) approve += 1;
          else reject += 1;
        }
        const passed = approve > this.players.length / 2;
        yield {
          t: 'vote-result',
          tally: { approve, reject },
          votes: detail,
          approved: passed,
          text: passed
            ? `表决 ${approve} 赞成 / ${reject} 反对 —— 队伍通过。`
            : `表决 ${approve} 赞成 / ${reject} 反对 —— 队伍被否决。`,
          wait: 200,
        };

        if (passed) {
          approvedTeam = ids;
          break;
        }

        this.rejectCount += 1;
        this.leaderIdx = (this.leaderIdx + 1) % n;
        if (this.rejectCount >= 5) {
          yield {
            t: 'phase',
            phase: 'ended',
            text: '连续 5 次否决，坏人直接获胜。',
            wait: 200,
          };
          winner = { id: 'evil', name: '坏人阵营' };
          break;
        }
        yield {
          t: 'phase',
          phase: 'team',
          text: `否决累计 ${this.rejectCount} / 5，队长交给下一位。`,
          wait: 120,
        };
        continue;
      }

      if (winner) break;

      // 2) 队员并行提交任务牌，收齐后统一公布
      this.phase = 'mission';
      const teamPlayers = approvedTeam.map((id) => this.byId(id)).filter(Boolean);
      yield {
        t: 'phase',
        phase: 'mission',
        missionIdx: this.missionIdx,
        text: `任务队伍进入密室：${teamPlayers.map((p) => p.name).join('、')}。所有人提交后统一揭晓。`,
        wait: 140,
      };

      const acts = yield* this.askMany(
        teamPlayers,
        'confirm',
        () => ({ prompt: '提交任务牌：use=true 代表失败票（仅坏人可用），use=false 代表成功票。', missionIdx: this.missionIdx }),
        () => ({ missionIdx: this.missionIdx, teamSize: teamPlayers.length }),
        { phase: 'mission' },
      );

      let failCards = 0;
      for (const p of teamPlayers) {
        const use = acts[p.id]?.action?.use === true;
        if (use && p.team === 'evil') failCards += 1;
      }
      const need = n >= 7 && this.missionIdx === 3 ? 2 : 1;
      const success = failCards < need;
      this.missions.push(success ? 'success' : 'fail');

      yield {
        t: 'mission',
        missionIdx: this.missionIdx,
        result: success ? 'success' : 'fail',
        successes: totalSuccess(),
        fails: totalFail(),
        text: success
          ? `第 ${this.missionIdx + 1} 个任务成功。（${totalSuccess()} 成功 / ${totalFail()} 失败）`
          : `第 ${this.missionIdx + 1} 个任务失败。（${totalSuccess()} 成功 / ${totalFail()} 失败）`,
        wait: 240,
      };

      this.leaderIdx = (this.leaderIdx + 1) % n;
      this.rejectCount = 0;
      this.missionIdx += 1;

      if (totalFail() >= 3) {
        winner = { id: 'evil', name: '坏人阵营' };
        yield { t: 'phase', phase: 'ended', text: '坏人完成 3 次破坏，坏人阵营获胜。', wait: 200 };
        break;
      }
      if (totalSuccess() >= 3) {
        // 3) 刺杀
        this.phase = 'assassinate';
        yield {
          t: 'phase',
          phase: 'assassinate',
          text: '好人完成 3 次任务，进入刺杀阶段：刺客要找出梅林。',
          wait: 240,
        };
        const assassin = this.byId(this.assassinId) || this.players.find((p) => p.team === 'evil');
        const candidates = this.players.map((p) => p.id);
        const killAct = yield* this.askFor(
          assassin,
          'vote',
          { candidates, mode: 'assassinate' },
          { phase: 'assassinate' },
        );
        const targetId = candidates.includes(killAct.action?.targetId) ? killAct.action.targetId : pick(candidates);
        const target = this.byId(targetId);
        const hit = target?.role === 'merlin';
        yield {
          t: 'assassinate',
          assassinId: assassin.id,
          targetId,
          hitMerlin: hit,
          text: `刺客 ${assassin.name} 指认 ${target?.name || targetId}：${hit ? '正是梅林！' : '不是梅林。'}`,
          wait: 400,
        };
        winner = hit ? { id: 'evil', name: '坏人阵营' } : { id: 'good', name: '好人阵营' };
        break;
      }
    }

    if (!winner) winner = { id: 'none', name: '无人' };

    const revealText = this.players
      .map((p) => `${p.name}=${ROLE_LABEL[p.role] || p.role}`)
      .join('，');
    yield { t: 'reveal', text: `身份公开：${revealText}。`, wait: 300 };

    this.finish(winner);
    yield {
      t: 'end',
      winnerId: winner.id,
      winnerName: winner.name,
      text: `游戏结束：${winner.name}获胜。`,
      wait: 0,
    };
  }

  intelText(p) {
    const evilNames = this.evilIds.map((id) => this.nameOf(id)).join('、');
    if (p.role === 'merlin') return `你是梅林。你看到所有坏人：${evilNames}。别表现得太明显。`;
    if (p.role === 'percival') {
      const names = (p.meta.suspects || []).map((id) => this.nameOf(id)).join(' 和 ');
      return `你是派西维尔。你看到 ${names}，其中一个是梅林，一个是莫甘娜，分不清。`;
    }
    if (p.team === 'evil') {
      const mates = this.evilIds.filter((id) => id !== p.id).map((id) => this.nameOf(id));
      const mateText = mates.length ? `同伙：${mates.join('、')}。` : '你是唯一的坏人。';
      return `你是${ROLE_LABEL[p.role]}（坏人）。${mateText}`;
    }
    return '你是忠臣。你没有额外情报，靠表决和任务结果推断。';
  }

  /* ---------------- 校验 ---------------- */

  validate(ask, act) {
    const a = act?.action;
    if (!a || typeof a !== 'object') return '缺少 action 字段';

    if (ask.kind === 'multi-pick') {
      if (a.type !== 'pick-many') return '需要 {"type":"pick-many","ids":["p1","p2"]}';
      if (!Array.isArray(a.ids)) return 'ids 必须是数组';
      const ids = [...new Set(a.ids.map(String))];
      const need = ask.payload.teamSize;
      if (ids.length !== need) return `必须恰好选择 ${need} 人`;
      const cands = ask.payload.candidates || [];
      for (const id of ids) if (!cands.includes(id)) return `${id} 不是合法候选人`;
      return null;
    }

    if (ask.kind === 'vote') {
      if (a.type !== 'vote') return '需要 {"type":"vote",...}';
      if (ask.payload?.mode === 'approve') {
        if (typeof a.approve !== 'boolean') return '需要 {"type":"vote","approve":true|false}';
        return null;
      }
      if (ask.payload?.mode === 'assassinate') {
        const cands = ask.payload.candidates || [];
        if (!cands.includes(a.targetId)) return 'targetId 不在候选里';
        return null;
      }
      return '未知的投票类型';
    }

    if (ask.kind === 'confirm') {
      if (a.type !== 'confirm') return '需要 {"type":"confirm","use":true|false}';
      if (typeof a.use !== 'boolean') return 'use 必须是布尔值';
      const p = this.byId(ask.playerId);
      if (a.use === true && p?.team !== 'evil') return '好人只能提交成功票（use=false）';
      return null;
    }

    return '未知的 ask 类型';
  }

  autoAct(ask) {
    if (ask.kind === 'multi-pick') {
      const need = ask.payload.teamSize || 1;
      return { action: { type: 'pick-many', ids: (ask.payload.candidates || []).slice(0, need) } };
    }
    if (ask.kind === 'vote') {
      if (ask.payload?.mode === 'approve') return { action: { type: 'vote', approve: true } };
      if (ask.payload?.mode === 'assassinate') {
        const cands = ask.payload.candidates || [];
        return { action: { type: 'vote', targetId: cands[Math.floor(Math.random() * cands.length)] } };
      }
    }
    if (ask.kind === 'confirm') return { action: { type: 'confirm', use: false } };
    return super.autoAct(ask);
  }

  /* ---------------- bot ---------------- */

  botThought(p, kind, payload) {
    if (kind === 'multi-pick') {
      return p.team === 'evil' ? '把自己人塞进任务队伍，找机会破坏。' : '选看起来靠谱的人，别把可疑分子放进来。';
    }
    if (kind === 'vote' && payload?.mode === 'approve') {
      return p.team === 'evil' ? '队伍里有自己人就放行，否则否决。' : '先通过看看任务结果，别把否决次数用光。';
    }
    if (kind === 'confirm') return p.team === 'evil' ? '找机会投失败票。' : '只能投成功票。';
    if (kind === 'vote' && payload?.mode === 'assassinate') return '梅林一定藏在好人里，挑一个最像的。';
    return '';
  }

  botAct(p, ask) {
    const payload = ask.payload || {};

    if (ask.kind === 'multi-pick') {
      const size = payload.teamSize || 2;
      const ids = [];
      if (p.team === 'evil') {
        ids.push(p.id);
        const mates = this.players.filter((x) => x.team === 'evil' && x.id !== p.id);
        if (mates.length && Math.random() < 0.7) ids.push(pick(mates).id);
      } else if (Math.random() < 0.6) {
        ids.push(p.id);
      }
      const rest = shuffle(this.players.map((x) => x.id).filter((id) => !ids.includes(id)));
      while (ids.length < size && rest.length) ids.push(rest.pop());
      const team = ids.slice(0, size);
      return {
        action: { type: 'pick-many', ids: team },
        say: `我提议 ${team.map((id) => this.nameOf(id)).join('、')}。`,
      };
    }

    if (ask.kind === 'vote' && payload.mode === 'approve') {
      const teamIds = ask.context?.teamIds || [];
      const hasEvil = teamIds.some((id) => this.byId(id)?.team === 'evil');
      let approve;
      if (p.team === 'evil') approve = hasEvil ? Math.random() < 0.9 : Math.random() < 0.25;
      else approve = Math.random() < 0.75;
      return { action: { type: 'vote', approve }, say: approve ? '通过。' : '我反对。' };
    }

    if (ask.kind === 'confirm') {
      const fail = p.team === 'evil' && Math.random() < (this.missionIdx >= 2 ? 0.75 : 0.35);
      return { action: { type: 'confirm', use: fail } };
    }

    if (ask.kind === 'vote' && payload.mode === 'assassinate') {
      const cands = (payload.candidates || []).map((id) => this.byId(id)).filter(Boolean);
      const good = cands.filter((x) => x.team === 'good');
      const target = pick(good.length ? good : cands);
      return { action: { type: 'vote', targetId: target?.id }, say: `我指认 ${target?.name || '他'}。` };
    }

    return super.autoAct(ask);
  }

  /* ---------------- 视图 ---------------- */

  secretOf(p) {
    if (!p) return null;
    const base = { role: p.role, roleName: ROLE_LABEL[p.role] || p.role };
    if (p.role === 'merlin') return { kind: 'role', data: { ...base, evilIds: this.evilIds.slice() } };
    if (p.role === 'percival') return { kind: 'role', data: { ...base, suspects: (p.meta.suspects || []).slice() } };
    if (p.team === 'evil') {
      return { kind: 'role', data: { ...base, evilIds: this.evilIds.filter((id) => id !== p.id) } };
    }
    return { kind: 'role', data: { ...base, evilIds: [] } };
  }

  tableState() {
    const n = this.players.length || this.seats;
    const idx = Math.min(this.missionIdx, 4);
    const teamSize = (this.missionSizes || [2])[idx] || 2;
    const need = n >= 7 && idx === 3 ? 2 : 1;
    const marks = (this.missions || []).map((m, i) => `${i + 1}${m === 'success' ? '胜' : '败'}`).join(' ');
    const leader = this.players[this.leaderIdx % (this.players.length || 1)];
    return {
      title: `第 ${idx + 1} 个任务 · ${PHASE_LABEL[this.phase] || this.phase}`,
      rows: [
        { label: '任务记录', value: marks || '尚无' },
        { label: '成功 / 失败', value: `${(this.missions || []).filter((m) => m === 'success').length} / ${(this.missions || []).filter((m) => m === 'fail').length}` },
        { label: '队长', value: leader?.name || '待定' },
        { label: '提名队伍', value: (this.teamProposed || []).map((id) => this.nameOf(id)).join('、') || '—' },
        { label: '连续否决', value: `${this.rejectCount} / 5` },
      ],
      note: `${n} 人局：第 ${idx + 1} 个任务需要 ${teamSize} 人${need === 2 ? '，且要 2 张失败票才算失败' : ''}。任务只公布成败，不公布失败票数。`,
    };
  }

  publicState() {
    const s = super.publicState();
    s.missionIdx = this.missionIdx;
    s.missions = (this.missions || []).slice();
    s.votesFailCount = this.rejectCount;
    s.teamProposed = (this.teamProposed || []).slice();
    s.leaderId = this.players[this.leaderIdx % (this.players.length || 1)]?.id || null;
    return s;
  }

  renderBrief({ state, baseUrl } = {}) {
    return renderBriefBase({
      title: '阿瓦隆',
      gameTitle: '阿瓦隆',
      roomId: state?.roomId,
      baseUrl,
      status: state?.status,
      seats: state?.seats,
      filled: state?.filled,
      askTimeoutMs: state?.askTimeoutMs,
      rules: [
        '- 5–10 人，分好人（梅林 / 派西维尔 / 忠臣）与坏人（莫甘娜 / 刺客 / 爪牙）两方。',
        '- 梅林看到所有坏人；派西维尔看到梅林与莫甘娜两人但分不清；坏人互相认识。',
        '- 每轮队长按人数表提名队伍，全员表决，赞成过半通过；平票否决。',
        '- 同一任务累计 5 次否决 → 坏人直接获胜。',
        '- 队员秘密提交任务牌：好人只能成功；坏人可投失败。至少 1 张失败则任务失败（7 人及以上第 4 个任务需 2 张）。',
        '- 任务只公布成功 / 失败，不公布失败票数。坏人 3 次破坏 → 坏人胜；好人 3 次成功 → 进入刺杀。',
        '- 刺杀阶段刺客指认 1 人：命中梅林则坏人胜，否则好人胜。',
      ],
      askRows: [
        ['multi-pick', '轮到你组队', '{"type":"pick-many","ids":["p0","p2"]}'],
        ['vote', '对队伍表决', '{"type":"vote","approve":true}'],
        ['confirm', '提交任务牌', '{"type":"confirm","use":false}'],
        ['vote', '刺客指认梅林', '{"type":"vote","targetId":"p3"}'],
      ],
      notes: [
        '你的身份与私有情报只在自己的 `you.secret`，别人看不到。',
        '任务牌会等所有队员提交后统一揭晓，不存在先提交先暴露。',
        '`use=true` 是失败票，只有坏人能提交；好人提交 true 会被拒绝。',
      ],
      tableRows: [
        { label: '任务进度', value: `${(state?.missions || []).filter((m) => m === 'success').length} 成功 / ${(state?.missions || []).filter((m) => m === 'fail').length} 失败` },
        { label: '连续否决', value: `${state?.votesFailCount ?? 0} / 5` },
      ],
      players: state?.players || [],
    });
  }
}
