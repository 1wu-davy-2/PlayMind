// HTTP 端到端自测：开纯 AI 房，N 个脚本玩家自动轮询并决策。
// 用法：node agents/auto-play.mjs <gameType> [players] [baseUrl]
const type = process.argv[2] || 'undercover';
const count = Number(process.argv[3]) || 4;
const base = (process.argv[4] || 'http://127.0.0.1:8781').replace(/\/+$/, '');
const POLL_MS = Math.max(20, Number(process.env.AGENT_POLL_MS) || 80);

const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const get = async (path) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

const created = await post('/api/rooms', {
  gameType: type,
  seats: count,
  mode: 'ai',
  autoStart: false,
  askTimeoutMs: 20000,
});
if (!created.j.roomId) {
  console.error('create failed', created);
  process.exit(1);
}
const { roomId, hostToken } = created.j;
console.log(`room ${roomId} · ${created.j.gameTitle}`);

const players = [];
for (let i = 0; i < count; i += 1) {
  const r = await post(`/api/rooms/${roomId}/join`, { name: `AUTO${i}`, style: '自测脚本' });
  if (!r.j.token) { console.error('join failed', r); process.exit(1); }
  players.push(r.j);
}
const started = await post(`/api/rooms/${roomId}/start`, { hostToken });
if (started.status !== 200) { console.error('start failed', started); process.exit(1); }

function actionFor(ask) {
  const p = ask.payload || {};
  switch (ask.kind) {
    case 'draw': return { type: 'draw' };
    case 'defuse': return { type: 'defuse', use: true };
    case 'pick-target': return { type: 'pick', targetId: p.candidates?.[0] };
    case 'answer': return { type: 'answer', claim: 'safe' };
    case 'verdict': return { type: 'verdict', decision: 'trust' };
    case 'free': return { type: 'text', text: '我先听听大家怎么说。' };
    case 'declare': {
      const mr = p.minRaise || {};
      if (p.canOpen && (!mr.count || Math.random() < 0.35)) return { type: 'open' };
      return {
        type: 'declare',
        word: '提示', number: 1,
        count: mr.count || p.minCount || p.count || 2,
        face: mr.face || p.minFace || 2,
        wild: mr.wild !== undefined ? mr.wild : true,
        suspect: 'plum', weapon: 'rope', room: 'library',
        color: 'r',
      };
    }
    case 'vote': {
      if (p.mode === 'guess' && Array.isArray(p.candidates) && p.candidates.length) {
        return { type: 'vote', cardId: p.candidates[0] };
      }
      if (Array.isArray(p.candidates) && p.candidates.length) {
        return { type: 'vote', targetId: p.candidates[0] };
      }
      if (p.mode === 'approve' || typeof p.approve === 'boolean' || p.threshold !== undefined) {
        return { type: 'vote', approve: true, accept: true };
      }
      return { type: 'vote', accept: false };
    }
    case 'confirm': return { type: 'confirm', use: false };
    case 'multi-pick': return { type: 'pick-many', ids: (p.candidates || []).slice(0, p.min || 1) };
    case 'bet': {
      const legal = p.legal || ['call'];
      const move = legal.includes('check') ? 'check' : legal.includes('call') ? 'call' : legal[0];
      return { type: 'bet', move, amount: p.minRaise || p.minBet || 20 };
    }
    case 'play-card': return p.legal?.length ? { type: 'play', cardId: p.legal[0] } : { type: 'draw' };
    case 'challenge': return { type: 'challenge', accept: true };
    default: return { type: 'pass' };
  }
}

let ended = false;
const errors = [];
const loops = players.map(async (pl) => {
  let idle = 0;
  while (!ended && idle < 800) {
    try {
      const v = await get(`/api/agent/${roomId}/${pl.token}`);
      if (v.status !== 200) { errors.push(v.j.error || v.status); break; }
      if (v.j.state?.status === 'ended') { ended = true; break; }
      if (v.j.ask) {
        const body = { action: actionFor(v.j.ask) };
        const r = await post(`/api/agent/${roomId}/${pl.token}/act`, body);
        if (!r.j.ok) {
          errors.push(`${pl.playerId} ${v.j.ask.kind}: ${r.j.error}`);
          await new Promise((res) => setTimeout(res, 300));
        }
        idle = 0;
      } else {
        idle += 1;
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
    } catch (e) {
      errors.push(`${pl.playerId} fetch: ${e.message}`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }
});

await Promise.all(loops);
const final = await get(`/api/rooms/${roomId}`);
const st = final.j.state;
console.log(JSON.stringify({
  roomId,
  gameType: type,
  status: st?.status,
  phase: st?.phase,
  round: st?.round,
  winner: st?.winner,
  players: st?.players?.map((p) => ({ id: p.id, alive: p.alive, hp: p.hp, chips: p.chips, handCount: p.handCount })),
  errors: errors.slice(0, 8),
}, null, 2));
if (st?.status !== 'ended') process.exit(2);
