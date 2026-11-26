// 强制结束房间自测：单进程启动服务，覆盖进行中/未开局/错误 token/重复结束。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ABORT_PORT) || 8901;
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), BT_PACE: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += String(d); });
srv.stderr.on('data', (d) => { log += String(d); });

const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const checks = [];
const check = (name, ok, extra = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

let ready = false;
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`${base}/api/games`)).ok) { ready = true; break; } } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) { console.error(log); srv.kill(); process.exit(1); }

const room = await post('/api/rooms', { gameType: 'undercover', seats: 4, mode: 'ai' });
const id = room.j.roomId;
const token = room.j.hostToken;
for (let i = 0; i < 4; i += 1) await post(`/api/rooms/${id}/join`, { name: `A${i}` });
const started = await post(`/api/rooms/${id}/start`, { hostToken: token });
check('开局成功', started.status === 200);

const ab = await post(`/api/rooms/${id}/abort`, { hostToken: token, reason: '测试结束' });
check('进行中可强制结束', ab.status === 200 && ab.j.state?.status === 'ended',
  `status=${ab.status} winner=${ab.j.state?.winner?.name}`);
check('胜者标记为强制结束', ab.j.state?.winner?.name === '强制结束');

const bad = await post(`/api/rooms/${id}/abort`, { hostToken: 'wrong-token' });
check('错误令牌返回 403', bad.status === 403, `status=${bad.status}`);

const again = await post(`/api/rooms/${id}/abort`, { hostToken: token });
check('重复结束返回 409', again.status === 409, `status=${again.status}`);

const waiting = await post('/api/rooms', { gameType: 'uno', seats: 4, mode: 'ai' });
const waited = await post(`/api/rooms/${waiting.j.roomId}/abort`, {
  hostToken: waiting.j.hostToken,
  reason: '没等人',
});
check('未开局房间也能结束', waited.status === 200 && waited.j.state?.status === 'ended');

srv.kill();
const pass = checks.filter(Boolean).length;
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
