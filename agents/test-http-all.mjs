// HTTP 端到端汇总：单进程内启动服务，逐局跑脚本玩家，结束自动关服。
// 用法：node agents/test-http-all.mjs
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.TEST_PORT) || 8899;
const base = `http://127.0.0.1:${PORT}`;

const cases = [
  ['bomb-table', 4],
  ['undercover', 4],
  ['liars-dice', 2],
  ['werewolf', 6],
  ['avalon', 5],
  ['codenames', 4],
  ['cluedo', 3],
  ['holdem', 3],
  ['uno', 4],
];

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), BT_PACE: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += String(d); });
srv.stderr.on('data', (d) => { serverLog += String(d); });
srv.on('exit', (code, signal) => {
  console.log(`[server exit] code=${code} signal=${signal}\n${serverLog.slice(0, 600)}`);
});

async function waitServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${base}/api/games`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

const up = await waitServer();
if (!up) {
  console.error('server failed to start\n' + serverLog);
  srv.kill();
  process.exit(1);
}
console.log(`server ${base} ready\n`);

let pass = 0;
for (const [game, seats] of cases) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, 'auto-play.mjs'), game, String(seats), base], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, BT_PACE: '0', AGENT_POLL_MS: '30' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ended = /"status": "ended"/.test(out);
  const errors = (out.match(/"errors": \[([\s\S]*?)\]/) || [])[1] || '';
  const clean = !errors.trim();
  const ok = ended && clean;
  if (ok) pass += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${game} ${seats}p  ${Date.now() - t0}ms`);
  if (!ok) {
    console.log('  raw: ' + out.trim().slice(0, 400).replace(/\n/g, ' | '));
    if (!ended) console.log('  no ended state');
    if (errors.trim()) console.log('  errors: ' + errors.trim().slice(0, 240));
    if (!out.trim()) console.log('  no output / ' + (r.error?.message || r.signal || 'timeout'));
  }
}

srv.kill();
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
