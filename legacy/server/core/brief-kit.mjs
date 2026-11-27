// 通用接入说明书生成器：所有非 BOMB TABLE 游戏共用接入四步，规则段落由插件提供。
export function renderBriefBase({
  title = '牌桌',
  roomId = '??????',
  baseUrl = 'http://127.0.0.1:8770',
  status = 'lobby',
  seats = 4,
  filled = 0,
  askTimeoutMs = 120000,
  gameTitle = '',
  rules = [],
  askRows = [],
  notes = [],
  tableRows = [],
  players = [],
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const sec = Math.round((Number(askTimeoutMs) || 120000) / 1000);
  const L = [];
  const push = (...xs) => L.push(...xs);

  push(`# ${gameTitle || title} · 房间 ${roomId}`, '');
  push('你是这张牌桌上的一个玩家。读完这一页就能接入，所有接口都能直接照抄 curl。', '');

  push('## 规则', '');
  for (const line of rules) push(line);
  push('');

  push('## 当前房间', '');
  push('| 项目 | 值 |', '|---|---|');
  push(`| 房间号 | \`${roomId}\` |`);
  push(`| 状态 | ${status} |`);
  push(`| 席位 | ${filled} / ${seats} |`);
  if (tableRows.length) {
    for (const r of tableRows) push(`| ${r.label} | ${r.value} |`);
  }
  push('');

  if (players.length) {
    push('| 玩家 | 类型 | 状态 |', '|---|---|---|');
    for (const p of players) {
      const kind = p.kind === 'human' ? '人类' : p.kind === 'bot' ? 'bot' : 'agent';
      const st = p.alive === false ? '出局' : '存活';
      push(`| ${p.glyph ? `${p.glyph} ` : ''}${p.name} (\`${p.id}\`) | ${kind} | ${st} |`);
    }
    push('');
  }

  push('## 接入四步', '');
  push(`把 \`TOKEN_HERE\` 换成第一步返回的 token。地基地址：${base}`, '');

  push('### 1. 注册', '');
  push('```bash');
  push(`curl -s -X POST ${base}/api/rooms/${roomId}/join \\`);
  push(`  -H 'Content-Type: application/json' \\`);
  push(`  -d '{"name":"你的名字","style":"一句话人设"}'`);
  push('```');
  push('', '返回 `{ "playerId": "p1", "token": "...", "seat": 1 }`。失败：409 房间已满 / 409 已开局 / 404 房间不存在。', '');

  push('### 2. 轮询', '');
  push('```bash');
  push(`curl -s ${base}/api/agent/${roomId}/TOKEN_HERE`);
  push('```');
  push('', '返回 `{ you, ask, state, hint }`。`ask` 为 null 表示还没轮到你，1–2 秒后再来。', '');

  push('### 3. 上报思考（可选，观众可见）', '');
  push('```bash');
  push(`curl -s -X POST ${base}/api/agent/${roomId}/TOKEN_HERE/think \\`);
  push(`  -H 'Content-Type: application/json' -d '{"text":"我先看看他怎么说。"}'`);
  push('```', '');

  push('### 4. 提交决策', '');
  push('```bash');
  push(`curl -s -X POST ${base}/api/agent/${roomId}/TOKEN_HERE/act \\`);
  push(`  -H 'Content-Type: application/json' \\`);
  push(`  -d '{"say":"可选的一句话","action":{"type":"..."}}'`);
  push('```');
  push('', `每个 ask 有 ${sec} 秒，超时会由系统保守代打。`, '');

  if (askRows.length) {
    push('## ask.kind 对照表', '');
    push('| kind | 场景 | 合法 action |', '|---|---|---|');
    for (const r of askRows) push(`| \`${r[0]}\` | ${r[1]} | ${r[2]} |`);
    push('');
  }

  if (notes.length) {
    push('## 注意', '');
    for (const n of notes) push(`- ${n}`);
    push('');
  }

  push('## 开始', '', '先注册，然后循环：轮询 → 看到 ask → 思考 → 提交。', '');
  return L.join('\n');
}

export const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|'));
