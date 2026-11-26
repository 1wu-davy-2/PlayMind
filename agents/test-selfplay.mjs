// AI 自玩接口自测：单进程起服务，测完即 kill，不留常驻进程。
// 覆盖：GET /api/manual · GET /api/ai/capabilities · POST /api/selfplay · 6 token 并发玩到 ended ·
//       POST /api/rooms/:id/agents 的 403/409 · POST /api/rooms/:id/abort 200
// 用法：node agents/test-selfplay.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SELFPLAY_PORT) || 8902;
const base = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), BT_PACE: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += String(d); });
srv.stderr.on('data', (d) => { log += String(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  if (text) { try { j = JSON.parse(text); } catch { /* 纯文本 */ } }
  return { status: r.status, text, j };
}
const get = (p) => request('GET', p);
const post = (p, body) => request('POST', p, body || {});

const checks = [];
function check(name, ok, extra = '') {
  checks.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

// 与 agents/auto-play.mjs 相同的动作生成策略：按 ask.kind 分派
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

let serverReady = false;
try {
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try { if ((await get('/api/games')).status === 200) { ready = true; break; } } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!ready) throw new Error(`服务未能启动：${log.slice(0, 600)}`);
  serverReady = true;

  /* --- 1. 手册与能力清单 --- */
  const manual = await get('/api/manual');
  const KEYS = [
    '/api/selfplay', '/api/rooms/:id/agents', '/api/games', '/api/ai/capabilities',
    'hostToken', 'style', 'thought', 'ask.kind', '强制结束', '模式 A', '模式 B', '模式 C',
  ];
  const missing = KEYS.filter((k) => !manual.text.includes(k));
  check('GET /api/manual 返回 200 且含关键字符串', manual.status === 200 && missing.length === 0,
    `status=${manual.status} 缺失=${missing.join(',') || '无'}`);

  const caps = await get('/api/ai/capabilities');
  check('GET /api/ai/capabilities 返回 JSON 能力清单',
    caps.status === 200 && Array.isArray(caps.j?.capabilities) && caps.j.capabilities.length >= 10,
    `status=${caps.status} 能力数=${caps.j?.capabilities?.length}`);

  /* --- 2. 一键自玩：undercover 6 人局 --- */
  const sp = await post('/api/selfplay', {
    gameType: 'undercover',
    seats: 6,
    styles: ['谨慎派', '直觉派', '搅局者', '分析派', '沉默者', '老好人'],
  });
  const tokens = (sp.j?.players || []).map((p) => p.token);
  check('POST /api/selfplay 创建 undercover 6 人局',
    sp.status === 200 && sp.j?.gameType === 'undercover' && tokens.length === 6 && sp.j?.state?.status === 'playing',
    `status=${sp.status} players=${tokens.length} game=${sp.j?.gameType} state=${sp.j?.state?.status}`);
  check('6 个 token 两两不同且长度 >= 40（64 位 hex）',
    tokens.length === 6
    && tokens.every((t) => typeof t === 'string' && /^[a-f0-9]+$/.test(t) && t.length >= 40)
    && new Set(tokens).size === 6,
    `长度=${tokens.map((t) => t.length).join(',')}`);

  /* --- 3. 用 6 个 token 并发轮询并按 ask.kind 提交，跑到 ended --- */
  const roomId = sp.j?.roomId;
  let ended = false;
  const errors = [];
  const loops = tokens.map(async (tok) => {
    let idle = 0;
    while (!ended && idle < 1000) {
      try {
        const v = await get(`/api/agent/${roomId}/${tok}`);
        if (v.status !== 200) { errors.push(`poll ${v.status}: ${v.j?.error || v.text}`); break; }
        if (v.j?.state?.status === 'ended') { ended = true; break; }
        if (v.j?.ask) {
          const r = await post(`/api/agent/${roomId}/${tok}/act`, { action: actionFor(v.j.ask) });
          if (!r.j?.ok) errors.push(`${v.j.ask.kind}: ${r.j?.error || r.status}`);
          idle = 0;
        } else {
          idle += 1;
          await sleep(30);
        }
      } catch (e) {
        errors.push(`fetch: ${e.message}`);
        await sleep(200);
      }
    }
  });
  await Promise.all(loops);
  const final = await get(`/api/rooms/${roomId}`);
  check('6 token 并发自动玩到 status=ended',
    final.j?.state?.status === 'ended' && errors.length === 0,
    `status=${final.j?.state?.status} errors=${errors.slice(0, 3).join(' | ') || '无'}`);

  /* --- 4. /agents：错误 hostToken → 403 --- */
  const lobby = await post('/api/rooms', { gameType: 'undercover', seats: 6, mode: 'ai', autoStart: false });
  const bad = await post(`/api/rooms/${lobby.j?.roomId}/agents`, {
    hostToken: 'wrong-token', agents: [{ name: '测试', style: '测试人设' }],
  });
  check('POST /api/rooms/:id/agents 错误 hostToken → 403',
    bad.status === 403, `status=${bad.status}`);

  /* --- 5. /agents：开局后再注册 → 409 --- */
  // undercover 至少 4 人才能开局，先用 /agents 填满 6 席再开局
  const fill = await post(`/api/rooms/${lobby.j?.roomId}/agents`, {
    hostToken: lobby.j?.hostToken,
    agents: Array.from({ length: 6 }, (_, i) => ({ name: `子代理${i + 1}`, style: '测试人设' })),
  });
  const started = await post(`/api/rooms/${lobby.j?.roomId}/start`, { hostToken: lobby.j?.hostToken });
  const afterStart = await post(`/api/rooms/${lobby.j?.roomId}/agents`, {
    hostToken: lobby.j?.hostToken, agents: [{ name: '测试', style: '测试人设' }],
  });
  check('POST /api/rooms/:id/agents 开局后注册 → 409',
    fill.status === 200 && started.status === 200 && afterStart.status === 409,
    `fill=${fill.status} start=${started.status} agents=${afterStart.status}`);

  /* --- 6. /agents：席位不足 → 409 --- */
  const small = await post('/api/rooms', { gameType: 'undercover', seats: 4, mode: 'ai', autoStart: false });
  const overflow = await post(`/api/rooms/${small.j?.roomId}/agents`, {
    hostToken: small.j?.hostToken,
    agents: Array.from({ length: 5 }, (_, i) => ({ name: `A${i}`, style: '测试人设' })),
  });
  check('POST /api/rooms/:id/agents 席位不足 → 409', overflow.status === 409, `status=${overflow.status}`);

  /* --- 7. /abort：强制结束 → 200 --- */
  const room2 = await post('/api/rooms', { gameType: 'bomb-table', seats: 4, mode: 'ai', autoStart: false });
  const fill2 = await post(`/api/rooms/${room2.j?.roomId}/agents`, {
    hostToken: room2.j?.hostToken,
    agents: Array.from({ length: 4 }, (_, i) => ({ name: `A${i}`, style: '测试人设' })),
  });
  const started2 = await post(`/api/rooms/${room2.j?.roomId}/start`, { hostToken: room2.j?.hostToken });
  const ab = await post(`/api/rooms/${room2.j?.roomId}/abort`, {
    hostToken: room2.j?.hostToken, reason: '自测强制结束',
  });
  check('POST /api/rooms/:id/abort 强制结束 → 200',
    fill2.status === 200 && started2.status === 200 && ab.status === 200 && ab.j?.state?.status === 'ended',
    `start=${started2.status} status=${ab.status} state=${ab.j?.state?.status}`);
} catch (e) {
  check('测试执行未抛异常', false, e.message);
} finally {
  srv.kill();
}

const pass = checks.filter(Boolean).length;
console.log(`\n${pass}/${checks.length} passed`);
process.exit(serverReady && pass === checks.length ? 0 : 1);
