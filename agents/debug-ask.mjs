// 调试：创建房间，打印前几个 ask 的 payload 与提交结果。
// 用法：node agents/debug-ask.mjs liars-dice 2
const type = process.argv[2] || 'liars-dice';
const count = Number(process.argv[3]) || 2;
const base = 'http://127.0.0.1:8799';
const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const get = async (p) => (await fetch(base + p)).json();

const room = await post('/api/rooms', { gameType: type, seats: count, mode: 'ai' });
const ps = [];
for (let i = 0; i < count; i += 1) ps.push(await post(`/api/rooms/${room.roomId}/join`, { name: `D${i}` }));
await post(`/api/rooms/${room.roomId}/start`, { hostToken: room.hostToken });

for (let i = 0; i < 6; i += 1) {
  const v = await get(`/api/agent/${room.roomId}/${ps[0].token}`);
  console.log('ask=', JSON.stringify(v.ask && { kind: v.ask.kind, payload: v.ask.payload, context: v.ask.context }));
  if (!v.ask) {
    console.log('hint=', v.hint);
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }
  const p = v.ask.payload || {};
  let action;
  if (v.ask.kind === 'declare') action = { type: 'declare', count: p.minCount, face: p.minFace, wild: true };
  else if (v.ask.kind === 'confirm') action = { type: 'confirm', use: false };
  else action = { type: 'pass' };
  console.log('submit', JSON.stringify(action));
  console.log('resp', JSON.stringify(await post(`/api/agent/${room.roomId}/${ps[0].token}/act`, { action })));
  await new Promise((r) => setTimeout(r, 200));
}
process.exit(0);
