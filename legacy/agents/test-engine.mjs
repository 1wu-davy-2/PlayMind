// 引擎自测：全 bot 跑一局，进程内完成，不占端口。
// 用法：node agents/test-engine.mjs undercover [seats]
import { getGameSpec } from '../server/games/index.mjs';

const type = process.argv[2] || 'undercover';
const seatsArg = Number(process.argv[3]) || 0;
const spec = getGameSpec(type);
if (!spec) {
  console.error(`未知游戏：${type}`);
  console.error('可选：bomb-table, undercover, liars-dice, werewolf, avalon, codenames, cluedo, holdem, uno');
  process.exit(1);
}

const seats = seatsArg || spec.min;
const events = [];
const game = new spec.Class({
  seats,
  askTimeoutMs: 5000,
  emit: (ev) => {
    events.push(ev);
    if (ev.text && events.length <= 200) console.log(`  · ${ev.text}`);
  },
});

for (let i = 0; i < seats; i += 1) {
  const r = game.addPlayer({ name: `BOT${i}`, kind: 'bot', title: '测试 bot' });
  if (r.error) { console.error(r.error); process.exit(1); }
}

const t0 = Date.now();
const r = await game.start();
if (r.error) { console.error('start failed:', r.error); process.exit(1); }

let guard = 0;
while (game.status === 'playing' && guard < 1200) {
  await new Promise((res) => setTimeout(res, 50));
  guard += 1;
}

const state = game.publicState();
console.log('\n--- result ---');
console.log(JSON.stringify({
  gameType: type,
  status: state.status,
  phase: state.phase,
  round: state.round,
  winner: state.winner,
  players: state.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, hp: p.hp, chips: p.chips, handCount: p.handCount })),
  events: events.length,
  ms: Date.now() - t0,
}, null, 2));

if (state.status !== 'ended') {
  console.error('未在限定时间内结束');
  process.exit(2);
}
