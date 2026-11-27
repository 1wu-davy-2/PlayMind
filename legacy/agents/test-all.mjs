// 全部游戏引擎自测汇总。用法：node agents/test-all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  ['bomb-table', 4],
  ['undercover', 6],
  ['liars-dice', 4],
  ['werewolf', 6],
  ['avalon', 5],
  ['avalon', 8],
  ['codenames', 4],
  ['codenames', 6],
  ['cluedo', 3],
  ['cluedo', 5],
  ['holdem', 3],
  ['holdem', 5],
  ['uno', 4],
  ['uno', 6],
];

const rows = [];
for (const [game, seats] of cases) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, 'test-engine.mjs'), game, String(seats)], {
    cwd: path.resolve(here, '..'),
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, BT_PACE: '0' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const status = /"status": "ended"/.test(out) ? 'PASS' : 'FAIL';
  const winner = (out.match(/"winner": \{\s*"id": "([^"]*)",\s*"name": "([^"]*)"/) || [])[2] || '—';
  const ms = (out.match(/"ms": (\d+)/) || [])[1] || String(Date.now() - t0);
  rows.push({ game, seats, status, winner, ms: Number(ms) });
  console.log(`${status}  ${game} ${seats}p  ${winner}  ${ms}ms`);
  if (status === 'FAIL') {
    const tail = out.trim().split('\n').slice(-12).join('\n');
    console.log(tail);
  }
}

const failed = rows.filter((r) => r.status === 'FAIL');
console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
process.exit(failed.length ? 1 : 0);
