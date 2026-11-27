#!/usr/bin/env node
// PlayMind 冒烟测试（纯 Node，无 jest）。
// 默认对 http://127.0.0.1:8790 冒烟；若不可达则自己拉起 `next start -p 8790`（内存模式），
// 全流程结束（成功或失败）都会回收子进程。
//
// 覆盖：游戏目录 → 规则 → 建房 → 加入 → 开局 → 玩家轮询/决策 → 事件增量 → 接入说明书 → 强制结束
//       → 管理员登录 → 房间列表 → godview masked/raw → 干预 → 审计哈希链。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const BASE = String(process.env.BASE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const PORT = '8790';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'smoke-pass-123';
const TOKEN_SECRET = 'smoke-secret';

let child = null;
let failed = false;
let passed = 0;
let total = 0;
let adminCookie = '';

/* ---------------- 输出 ---------------- */

function check(name, ok, detail = '') {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed = true;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function info(text) {
  console.log(`      ${text}`);
}

/* ---------------- HTTP ---------------- */

async function request(method, pathname, { body, useCookie = false, timeout = 20000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (useCookie && adminCookie) headers.Cookie = adminCookie;

  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, headers: res.headers };
}

function statusOk(res) {
  return res.status >= 200 && res.status < 300;
}

/* ---------------- 子进程 ---------------- */

async function reachable() {
  try {
    const res = await fetch(`${BASE}/api/games`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function killChild() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else if (pid) {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try {
      if (pid) process.kill(pid, 'SIGTERM');
    } catch { /* 已退出 */ }
  }
}

function finish(code) {
  killChild();
  if (code === 0) console.log(`\nSMOKE OK (${passed}/${total})`);
  else console.log(`\nSMOKE FAILED (${passed}/${total})`);
  process.exit(code);
}

async function ensureServer() {
  if (await reachable()) {
    info(`复用已运行的服务：${BASE}`);
    return;
  }

  const env = { ...process.env };
  // 强制内存模式：置空而非删除（Next 仍会加载 .env.local，dotenv 不覆盖已存在的键）
  env.DATABASE_URL = '';
  env.ADMIN_USERNAME = ADMIN_USER;
  env.ADMIN_PASSWORD = ADMIN_PASS;
  env.TOKEN_SECRET = TOKEN_SECRET;

  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  info(`启动服务：${bin} next start -p ${PORT}（内存模式）`);
  child = spawn(bin, ['next', 'start', '-p', PORT], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    // Node 18.20+ / 20.12+ 在 Windows 上 spawn .cmd 需要 shell；非 Windows 用进程组方便回收
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  child.on('error', (err) => {
    console.error(`[smoke] 启动服务失败：${(err && err.message) || err}`);
  });

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`服务在 40s 内未就绪：${BASE}（先执行 npm run build）`);
}

/* ---------------- 业务流程 ---------------- */

async function findPendingAsk(roomId, tokens) {
  for (const token of tokens) {
    if (!token) continue;
    const res = await request('GET', `/api/agent/${roomId}/${token}`);
    if (statusOk(res) && res.data && res.data.ask && res.data.ask.id) {
      return { token, ask: res.data.ask, view: res.data };
    }
  }
  return null;
}

async function runMainRoom() {
  // 1. 游戏目录
  const games = await request('GET', '/api/games');
  const gameList = games.data && Array.isArray(games.data.games) ? games.data.games : [];
  check('GET /api/games 返回 200', statusOk(games), `status=${games.status}`);
  check('游戏目录共 9 款', gameList.length === 9, `实际 ${gameList.length}`);

  // 2. 规则
  const rules = await request('GET', '/api/games/bomb-table/rules');
  check('GET /api/games/bomb-table/rules 返回 200', statusOk(rules), `status=${rules.status}`);
  check('规则为 Markdown 且含「规则」', typeof rules.data === 'string' && rules.data.includes('规则'));

  // 3. 建房
  const created = await request('POST', '/api/rooms', {
    body: { gameType: 'bomb-table', seats: 2, mode: 'mixed' },
  });
  const roomId = created.data && created.data.roomId;
  const hostToken = created.data && created.data.hostToken;
  const humanToken = created.data && created.data.humanToken;
  check('POST /api/rooms 建房成功', statusOk(created) && !!roomId, `status=${created.status}`);
  check('返回 roomId / hostToken / humanToken', !!roomId && !!hostToken && !!humanToken);
  info(`房间 ${roomId}`);

  if (!roomId || !hostToken || !humanToken) return;

  // 4. 加入 + 开局
  const joined = await request('POST', `/api/rooms/${roomId}/join`, { body: { name: '冒烟AI' } });
  const agentToken = joined.data && joined.data.token;
  check('POST /api/rooms/:id/join 返回 token', statusOk(joined) && !!agentToken, `status=${joined.status}`);

  const started = await request('POST', `/api/rooms/${roomId}/start`, { body: { hostToken } });
  check('POST /api/rooms/:id/start 返回 200', statusOk(started), `status=${started.status}`);

  // 5. 玩家轮询 + 决策
  // BOMB TABLE 从 0 号座位（建房时的人类）开始，首个 ask 可能不在刚加入的 AI 身上，
  // 因此按 [AI, 人类] 顺序找当前真正持有 ask 的 token（两者共用同一 /api/agent 路由）。
  const pending = await findPendingAsk(roomId, [agentToken, humanToken]);
  check('GET /api/agent/:id/:token 返回 ask.kind=draw', !!pending && pending.ask.kind === 'draw',
    pending ? `kind=${pending.ask.kind}` : '没有找到待决策玩家');

  if (pending) {
    const acted = await request('POST', `/api/agent/${roomId}/${pending.token}/act`, {
      body: { action: { type: 'draw' }, thought: '冒烟测试抽一张' },
    });
    check('POST /api/agent/:id/:token/act 提交 draw 返回 200', statusOk(acted), `status=${acted.status}`);
  }

  // 6. 事件增量
  const events = await request('GET', `/api/rooms/${roomId}/events?since=0`);
  const evList = events.data && Array.isArray(events.data.events) ? events.data.events : [];
  check('GET /api/rooms/:id/events 返回 200', statusOk(events), `status=${events.status}`);
  check('事件流非空', evList.length > 0, `events=${evList.length}`);
  check('state.status=playing', events.data && events.data.state && events.data.state.status === 'playing',
    `status=${events.data && events.data.state && events.data.state.status}`);
  check('maxSeq > 0', events.data && Number(events.data.maxSeq) > 0, `maxSeq=${events.data && events.data.maxSeq}`);

  // 7. 接入说明书 + 强制结束
  const brief = await request('GET', `/join/${roomId}`);
  check('GET /join/:id 返回 200 Markdown', brief.status === 200 && typeof brief.data === 'string' && brief.data.length > 50,
    `status=${brief.status} len=${typeof brief.data === 'string' ? brief.data.length : 'n/a'}`);

  const aborted = await request('POST', `/api/rooms/${roomId}/abort`, {
    body: { hostToken, reason: 'smoke' },
  });
  check('POST /api/rooms/:id/abort 返回 200', statusOk(aborted), `status=${aborted.status}`);
  check('abort 后 state.status=ended',
    aborted.data && aborted.data.state && aborted.data.state.status === 'ended',
    `status=${aborted.data && aborted.data.state && aborted.data.state.status}`);
}

async function runAdmin() {
  // 8. 另建一房（德州扑克：2 人即可开局，且每位玩家都有私有手牌，masked 档必有脱敏 secret）
  const created = await request('POST', '/api/rooms', {
    body: { gameType: 'holdem', seats: 2, mode: 'mixed' },
  });
  const roomId = created.data && created.data.roomId;
  const hostToken = created.data && created.data.hostToken;
  check('管理端：另建一房成功', statusOk(created) && !!roomId, `status=${created.status}`);
  if (!roomId || !hostToken) return;

  const joined = await request('POST', `/api/rooms/${roomId}/join`, { body: { name: '管理端AI' } });
  check('管理端：AI 加入成功', statusOk(joined) && Boolean(joined.data && joined.data.token), `status=${joined.status}`);

  const started = await request('POST', `/api/rooms/${roomId}/start`, { body: { hostToken } });
  check('管理端：房间开局成功', statusOk(started), `status=${started.status}`);

  // 登录
  const login = await request('POST', '/api/admin/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const rawCookie = login.headers.get('set-cookie') || '';
  const cookieMatch = /(pm_admin=[^;]+)/.exec(rawCookie);
  adminCookie = cookieMatch ? cookieMatch[1] : '';
  check('POST /api/admin/login 返回 200', statusOk(login), `status=${login.status}`);
  check('登录返回 pm_admin Cookie', !!adminCookie, rawCookie ? 'Set-Cookie 缺少 pm_admin' : '没有 Set-Cookie');

  // 房间列表
  const rooms = await request('GET', '/api/admin/rooms', { useCookie: true });
  check('GET /api/admin/rooms 返回 200', statusOk(rooms), `status=${rooms.status}`);
  check('房间列表含 rooms / stats', Boolean(rooms.data && Array.isArray(rooms.data.rooms) && rooms.data.stats),
    `keys=${rooms.data && typeof rooms.data === 'object' ? Object.keys(rooms.data).join(',') : 'n/a'}`);
  check('admin.role=root', Boolean(rooms.data && rooms.data.admin && rooms.data.admin.role === 'root'),
    `role=${rooms.data && rooms.data.admin && rooms.data.admin.role}`);

  // godview masked
  const masked = await request('GET', `/api/admin/rooms/${roomId}/godview?level=masked`, { useCookie: true });
  const maskedPlayers = masked.data && Array.isArray(masked.data.players) ? masked.data.players : [];
  check('GET godview?level=masked 返回 200', statusOk(masked), `status=${masked.status}`);
  check('masked 玩家私有信息脱敏（含 {redacted}）',
    maskedPlayers.some((p) => p && p.secret && p.secret.redacted === true),
    `players=${maskedPlayers.length}`);

  // godview raw：无 reason → 400；带 reason → 200
  const rawNoReason = await request('GET', `/api/admin/rooms/${roomId}/godview?level=raw`, { useCookie: true });
  check('godview?level=raw 无 reason 返回 400', rawNoReason.status === 400, `status=${rawNoReason.status}`);
  const rawReason = await request('GET', `/api/admin/rooms/${roomId}/godview?level=raw&reason=smoke`, { useCookie: true });
  check('godview?level=raw 带 reason 返回 200', statusOk(rawReason), `status=${rawReason.status}`);

  // 干预
  const intervene = await request('POST', `/api/admin/rooms/${roomId}/intervene`, {
    body: { action: 'abort', reason: 'smoke' },
    useCookie: true,
  });
  check('POST intervene{abort} 返回 ok + auditId',
    statusOk(intervene) && intervene.data && intervene.data.ok === true && intervene.data.auditId != null,
    `status=${intervene.status}`);

  // 审计
  const audit = await request('GET', '/api/admin/audit', { useCookie: true });
  const records = audit.data && Array.isArray(audit.data.records) ? audit.data.records : [];
  check('GET /api/admin/audit 返回 200', statusOk(audit), `status=${audit.status}`);
  check('审计记录非空', records.length >= 1, `records=${records.length}`);
  const chainOk = records.length > 0 && records.every((r) => /^[0-9a-f]{64}$/i.test(String(r.hash || ''))
    && String(r.seal || '').length === 8);
  check('审计哈希为 64 位 hex 且 seal 为 8 位', chainOk);
}

/* ---------------- 入口 ---------------- */

async function main() {
  console.log(`PlayMind smoke → ${BASE}\n`);
  await ensureServer();

  await runMainRoom();
  await runAdmin();

  finish(failed ? 1 : 0);
}

process.on('SIGINT', () => finish(1));
process.on('SIGTERM', () => finish(1));

main().catch((err) => {
  failed = true;
  check('冒烟流程未抛出异常', false, (err && err.message) || String(err));
  finish(1);
});
