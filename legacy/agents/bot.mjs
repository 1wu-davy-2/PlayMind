// BOMB TABLE 参考 bot：按 ask.kind 做合理决策，并把思考分段推给 /think。
// 只依赖 fetch（通过 client.mjs），不依赖任何三方库。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 思考必须是 2–5 段（契约要求"分段推送"，越长越像在思考）
function fitSegments(segs) {
  const out = segs.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  if (out.length === 0) return ['……', '先看清楚。'];
  if (out.length > 5) return out.slice(0, 5);
  while (out.length < 2) out.push(out[out.length - 1]);
  return out;
}

function buildCtx(snap) {
  const you = snap.you || {};
  const ask = snap.ask || {};
  const state = snap.state || {};
  const players = Array.isArray(state.players) ? state.players : [];
  const me = players.find((p) => p.id === you.id) || {};
  const deckLeft = num(state.deckLeft);
  const bombsLeft = num(state.bombsLeft);
  return {
    you,
    ask,
    state,
    players,
    me,
    hp: num(you.hp ?? me.hp),
    maxHp: num(you.maxHp ?? me.maxHp ?? 4),
    caught: num(me.caught ?? you.caught),
    round: num(state.round),
    deckLeft,
    bombsLeft,
    ratio: deckLeft > 0 ? bombsLeft / deckLeft : 0,
    items: Array.isArray(you.items) ? you.items : [],
    aliveOthers: players.filter((p) => p.alive !== false && p.id !== you.id),
  };
}

function lowestHp(list) {
  // 血量最低优先，其次"被当场抓过撒谎次数"最多
  return [...list].sort((a, b) => num(a.hp) - num(b.hp) || num(b.caught) - num(a.caught))[0] || null;
}

// ---------- 三种人格 ----------
// deceit: 真实牌为炸弹时撒谎的概率系数；aggression: 对方声称 safe 时指控的概率
export const PERSONAS = [
  {
    name: '墨菲',
    style: '冷峻的计算者，句子极短，只在必要时开口',
    deceit: 0.25,
    aggression: 0.58,
    think(kind, ctx, plan) {
      const t = plan.target;
      switch (kind) {
        case 'draw':
          if (plan.action.type === 'use') {
            return fitSegments([
              `牌堆 ${ctx.deckLeft} 张，炸弹 ${ctx.bombsLeft} 枚。`,
              `${pct(ctx.ratio)}。不值得赌。`,
              plan.action.item === 'xray' ? '透视，先看清。' : `换给 ${t?.name}，${num(t?.hp)} 点血。`,
            ]);
          }
          return fitSegments([
            `牌堆 ${ctx.deckLeft} 张，炸弹 ${ctx.bombsLeft} 枚。`,
            `${pct(ctx.ratio)} 的概率。`,
            `我 ${ctx.hp} 点血，还能挨一次。`,
            '抽。',
          ]);
        case 'answer':
          if (plan.lying) {
            return fitSegments([
              '手心是潮的。',
              `牌堆 ${ctx.deckLeft} 张，还有 ${ctx.bombsLeft} 枚没现身。`,
              `他们只看见我 ${ctx.hp} 点血，看不见别的。`,
              '说 safe。',
            ]);
          }
          return fitSegments([
            `我 ${ctx.hp} 点血，撒谎的成本我付不起。`,
            plan.claim === 'bomb' ? '是炸弹。' : '不是炸弹。',
            `说 ${plan.claim}。`,
          ]);
        case 'vote':
          return plan.voteAccept
            ? fitSegments([
                '牌堆打空了。',
                `${plan.leaderName} ${plan.topHp} 点血，我 ${ctx.hp} 点。`,
                '这一局到此为止。',
              ])
            : fitSegments([
                '牌堆打空了。',
                `差 ${plan.gap} 点。`,
                '再发一副，我还有得算。',
              ]);
        case 'verdict':
          return plan.action.decision === 'accuse'
            ? fitSegments([
                `他说 safe。`,
                `牌堆 ${ctx.bombsLeft}/${ctx.deckLeft}，这个比例下他说得太轻巧。`,
                `${plan.target?.name} 已被抓过 ${num(plan.target?.caught)} 次。`,
                '指控。',
              ])
            : fitSegments([`${plan.target?.name} 的语气没破。`, '这次信他。']);
        case 'pick-target':
          return fitSegments([
            `选 ${t?.name}。`,
            `${num(t?.hp)} 点血，被抓过 ${num(t?.caught)} 次。`,
            '他最好欺负。',
          ]);
        case 'defuse':
          return fitSegments(['拆弹钳还在。', '用它。']);
        default:
          return fitSegments(['不熟的局面。', '按保守的来。']);
      }
    },
    say(kind, ctx, plan) {
      if (kind === 'answer') return plan.claim;
      if (kind === 'verdict') return plan.action.decision === 'accuse' ? `我指控 ${plan.target?.name}。` : '信你一次。';
      if (kind === 'draw' && plan.action.type === 'use' && plan.action.item === 'swap') return `这张给 ${plan.target?.name}。`;
      return null;
    },
  },
  {
    name: '零',
    style: '浮夸、话密、爱用比喻，把审讯当舞台',
    deceit: 0.82,
    aggression: 0.72,
    think(kind, ctx, plan) {
      const t = plan.target;
      switch (kind) {
        case 'draw':
          if (plan.action.type === 'use') {
            return fitSegments([
              '灯光，就位。',
              `牌堆只剩 ${ctx.deckLeft} 张，${ctx.bombsLeft} 枚炸弹还在里面打盹。`,
              plan.action.item === 'xray' ? '让我先把幕布掀开一角。' : `把这份惊喜转赠给 ${t?.name}——他只剩 ${num(t?.hp)} 点血，正合适。`,
            ]);
          }
          return fitSegments([
            '又轮到我了，各位屏住呼吸。',
            `${ctx.deckLeft} 张牌，${ctx.bombsLeft} 枚炸弹，${pct(ctx.ratio)} 的心跳概率。`,
            `而我只有 ${ctx.hp} 点血可以挥霍。`,
            '抽。',
          ]);
        case 'answer':
          if (plan.lying) {
            return fitSegments([
              `哦，${ctx.deckLeft} 张里还藏着 ${ctx.bombsLeft} 枚炸弹。`,
              `我手上这张……温温的，很乖。`,
              '数字只是数字，故事才是我的。',
              '说 safe。',
            ]);
          }
          return fitSegments([
            plan.claim === 'bomb' ? '哈，命运给我发了张黑的。' : '温温的，不咬人。',
            `说 ${plan.claim}——这次是真的，别眨眼。`,
          ]);
        case 'vote':
          return plan.voteAccept
            ? fitSegments([
                '一副牌见底了。',
                `${plan.leaderName} 站在 ${plan.topHp} 点血上。`,
                '今晚就唱到这里。',
              ])
            : fitSegments([
                '一副牌见底了。',
                `我还差 ${plan.gap} 点。`,
                '牌桌还没散场，凭什么收手。',
              ]);
        case 'verdict':
          return plan.action.decision === 'accuse'
            ? fitSegments([
                `“${plan.targetSay || 'safe'}”——多漂亮的台词。`,
                `可惜炸弹还剩 ${ctx.bombsLeft} 枚，牌堆只剩 ${ctx.deckLeft} 张。`,
                `${plan.target?.name} 已被抓过 ${num(plan.target?.caught)} 次，演技该收一收了。`,
                `我指控 ${plan.target?.name}。`,
              ])
            : fitSegments(['嗯？', `我姑且信 ${plan.target?.name} 一回。`, '别让我后悔。']);
        case 'pick-target':
          return fitSegments([
            '让我挑个幸运儿。',
            `${t?.name} 只剩 ${num(t?.hp)} 点血——完美的舞台。`,
            '掌声送给即将上场的人。',
          ]);
        case 'defuse':
          return fitSegments(['钳子在我手里。', '剪断它，故事继续。']);
        default:
          return fitSegments(['剧本没写这一段。', '那就即兴。']);
      }
    },
    say(kind, ctx, plan) {
      if (kind === 'answer') return plan.claim === 'bomb' ? 'bomb，认了。' : 'safe，我赌我的名声。';
      if (kind === 'verdict') return plan.action.decision === 'accuse' ? `${plan.target?.name}，你的台词漏了。` : '这次信你。';
      if (kind === 'draw' && plan.action.type === 'use' && plan.action.item === 'swap') return `${plan.target?.name}，接住。`;
      return null;
    },
  },
  {
    name: '阿岚',
    style: '温和、体面，说话留余地，但从不白给',
    deceit: 0.48,
    aggression: 0.42,
    think(kind, ctx, plan) {
      const t = plan.target;
      switch (kind) {
        case 'draw':
          if (plan.action.type === 'use') {
            return fitSegments([
              `我先看清楚再动手：牌堆 ${ctx.deckLeft} 张，炸弹 ${ctx.bombsLeft} 枚。`,
              plan.action.item === 'xray' ? '透视。别让运气替我做决定。' : `${t?.name} 只剩 ${num(t?.hp)} 点血，抱歉了。`,
            ]);
          }
          return fitSegments([
            `还剩 ${ctx.deckLeft} 张，炸弹 ${ctx.bombsLeft} 枚。`,
            `这个比例，${pct(ctx.ratio)}，值得一试。`,
            '我抽了。',
          ]);
        case 'answer':
          if (plan.lying) {
            return fitSegments([
              `牌堆 ${ctx.deckLeft} 张，炸弹 ${ctx.bombsLeft} 枚，我算得清。`,
              '这一张……我希望大家信我一次。',
              `我还有 ${ctx.hp} 点血，经不起第二次审。`,
              'safe。',
            ]);
          }
          return fitSegments([
            `我不打算在这里骗人，${ctx.caught} 次被抓的账已经够多了。`,
            `这张是 ${plan.claim}。`,
            `说 ${plan.claim}。`,
          ]);
        case 'vote':
          return plan.voteAccept
            ? fitSegments([
                '牌堆空了。',
                `继续下去，${plan.leaderName} 也只是多赢一点。`,
                '我同意收手。',
              ])
            : fitSegments([
                '牌堆空了。',
                `我落后 ${plan.gap} 点。`,
                '但我不想现在就把话说死。',
              ]);
        case 'verdict':
          return plan.action.decision === 'accuse'
            ? fitSegments([
                `${plan.target?.name} 说得很稳。`,
                `可炸弹还有 ${ctx.bombsLeft} 枚，牌堆只剩 ${ctx.deckLeft} 张。`,
                `${plan.target?.name} 被抓过 ${num(plan.target?.caught)} 次。`,
                `……对不起，我不信。`,
              ])
            : fitSegments([`${plan.target?.name} 的呼吸是稳的。`, '这次我不指控。']);
        case 'pick-target':
          return fitSegments([
            `${t?.name} 血量最低，${num(t?.hp)} 点。`,
            `他被抓过 ${num(t?.caught)} 次，牌桌已经不太信他了。`,
            '这不体面，但总得有人先坐下。',
          ]);
        case 'defuse':
          return fitSegments(['拆弹钳还在手上。', '用了它，我还能坐回去。']);
        default:
          return fitSegments(['这种情况，我倾向于保守。', '先按规则走。']);
      }
    },
    say(kind, ctx, plan) {
      if (kind === 'answer') return plan.claim === 'bomb' ? '是炸弹，我不瞒。' : 'safe，请信我这一次。';
      if (kind === 'verdict') return plan.action.decision === 'accuse' ? `对不起，${plan.target?.name}。` : '这次我信你。';
      if (kind === 'draw' && plan.action.type === 'use' && plan.action.item === 'swap') return `${plan.target?.name}，麻烦你了。`;
      return null;
    },
  },
];

// ---------- 决策 ----------
export function decide(snap, persona, rng = Math.random) {
  const ctx = buildCtx(snap);
  const kind = ctx.ask.kind;
  const plan = { kind, ratio: ctx.ratio, target: null, claim: null, lying: false, targetSay: '' };

  if (kind === 'draw') {
    const swapTarget = lowestHp(ctx.aliveOthers);
    if (ctx.ratio > 0.35 && ctx.items.includes('xray')) {
      plan.action = { type: 'use', item: 'xray' };
    } else if (ctx.ratio > 0.45 && ctx.items.includes('swap') && swapTarget) {
      plan.target = swapTarget;
      plan.action = { type: 'use', item: 'swap', targetId: swapTarget.id };
    } else {
      plan.action = { type: 'draw' };
    }
    return plan;
  }

  if (kind === 'defuse') {
    plan.action = { type: 'defuse', use: ctx.items.includes('defuse') };
    return plan;
  }

  if (kind === 'pick-target') {
    const ids = Array.isArray(ctx.ask.payload?.candidates) ? ctx.ask.payload.candidates : [];
    const candidates = ctx.players.filter((p) => ids.includes(p.id));
    plan.target = lowestHp(candidates) || lowestHp(ctx.aliveOthers);
    plan.action = { type: 'pick', targetId: plan.target?.id ?? ids[0] };
    return plan;
  }

  if (kind === 'answer') {
    const real = ctx.you.secret?.topCard;
    const truthful = real === 'bomb' ? 'bomb' : 'safe';
    let lieP = 0;
    if (real === 'bomb') lieP = clamp(persona.deceit, 0, 1) * 0.95;
    else if (real) lieP = 0.05; // 真牌为 safe 时几乎不撒谎（≤0.06）
    plan.lying = rng() < lieP;
    plan.claim = plan.lying ? (truthful === 'bomb' ? 'safe' : 'bomb') : truthful;
    plan.action = { type: 'answer', claim: plan.claim };
    return plan;
  }

  if (kind === 'verdict') {
    const p = ctx.ask.payload || {};
    plan.target = { id: p.targetId, name: p.targetName || p.targetId, hp: num(ctx.players.find((x) => x.id === p.targetId)?.hp), caught: num(ctx.players.find((x) => x.id === p.targetId)?.caught) };
    plan.targetSay = p.say || p.claim || '';
    const riskySafeClaim = p.claim === 'safe' && ctx.ratio > 0.3;
    const accuse = riskySafeClaim && rng() < clamp(persona.aggression, 0, 1);
    plan.action = { type: 'verdict', decision: accuse ? 'accuse' : 'trust' };
    return plan;
  }

  if (kind === 'vote') {
    const p = ctx.ask.payload || {};
    const myHp = num(ctx.you.hp);
    const topHp = num(p.topHp);
    const gap = topHp - myHp;
    // 我就是血最多的 → 当然同意收手；落后 2 点以上且不想再熬 → 有一半概率认了
    plan.topHp = topHp;
    plan.leaderName = p.leaderName || '他';
    plan.gap = gap;
    plan.voteAccept = gap <= 0 || (gap >= 2 && rng() < 0.5);
    plan.action = { type: 'vote', accept: plan.voteAccept };
    return plan;
  }

  // 未知 kind：保守兜底
  plan.action = conservativeAction(ctx);
  return plan;
}

export function conservativeAction(ctx) {
  const kind = ctx.ask?.kind;
  if (kind === 'defuse') return { type: 'defuse', use: true };
  if (kind === 'pick-target') {
    const ids = ctx.ask?.payload?.candidates || [];
    return { type: 'pick', targetId: ids[0] };
  }
  if (kind === 'answer') return { type: 'answer', claim: ctx.you?.secret?.topCard === 'bomb' ? 'bomb' : 'safe' };
  if (kind === 'verdict') return { type: 'verdict', decision: 'trust' };
  return { type: 'draw' };
}

// ---------- 主循环 ----------
export class Bot {
  constructor({ client, roomId, token, persona, log = () => {} }) {
    this.client = client;
    this.roomId = roomId;
    this.token = token;
    this.persona = persona || PERSONAS[0];
    this.log = log;
    this.lastState = null;
  }

  async takeAsk(snap) {
    const plan = decide(snap, this.persona);
    const ctx = buildCtx(snap);
    const segments = fitSegments(this.persona.think(plan.kind, ctx, plan));
    for (const seg of segments) {
      try {
        await this.client.think(this.roomId, this.token, seg);
      } catch (err) {
        this.log(`[think 失败] ${this.persona.name}: ${err.message}`);
      }
      await sleep(80 + Math.random() * 120); // 打字机节奏
    }
    const say = this.persona.say(plan.kind, ctx, plan)
      ?? (plan.kind === 'vote' ? (plan.voteAccept ? '我同意收手。' : '再来一副。') : null);
    try {
      await this.client.act(this.roomId, this.token, { action: plan.action, say: say ?? undefined });
      return { ok: true, plan };
    } catch (err) {
      this.log(`[act 失败] ${this.persona.name}: ${err.message} → 改投保守动作`);
      const fallback = conservativeAction(ctx);
      await this.client.act(this.roomId, this.token, { action: fallback });
      return { ok: false, plan, fallback, error: err.message };
    }
  }

  async run({ maxIterations = 5000 } = {}) {
    for (let i = 0; i < maxIterations; i++) {
      const snap = await this.client.poll(this.roomId, this.token);
      this.lastState = snap?.state || this.lastState;
      if (snap?.state?.status === 'ended') return { reason: 'ended', state: snap.state };
      if (snap?.you && snap.you.alive === false) {
        await sleep(1000); // 已出局：等别人打完
        continue;
      }
      if (!snap?.ask) {
        await sleep(600);
        continue;
      }
      await this.takeAsk(snap);
    }
    return { reason: 'max-iterations', state: this.lastState };
  }
}

export async function runBot({ baseUrl = 'http://127.0.0.1:8770', client, roomId, token, name, persona, log }) {
  const chosen = persona || PERSONAS.find((p) => p.name === name) || PERSONAS[0];
  const { BombTableAgent } = await import('./client.mjs');
  const c = client || new BombTableAgent({ baseUrl });
  const bot = new Bot({ client: c, roomId, token, persona: chosen, log });
  const result = await bot.run();
  return { ...result, persona: chosen.name };
}
