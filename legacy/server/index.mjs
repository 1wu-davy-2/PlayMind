// BOMB TABLE 主机服务：房间 + Agent 接入协议 + 网页
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRoom, getRoom, listRooms } from './room.mjs';
import { renderPitch } from './pitch.mjs';
import { getGameSpec, listGames } from './games/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8770);

// 找一个真实网卡地址：虚拟机/回环适配器排除，优先无线与有线
function lanAddress() {
  const virtual = /vmware|virtualbox|hyper-?v|vethernet|loopback|bluetooth|tap|tun|docker|wsl|atrust|vnic|teredo|6to4|isatap/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      list.push({ name, address: a.address, virt: virtual.test(name) });
    }
  }
  const real = list.find((x) => !x.virt && !/^169\.254\./.test(x.address));
  return (real || list.find((x) => !x.virt) || list[0])?.address || null;
}
const LAN_IP = lanAddress();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------- 说明书渲染（可选依赖，缺了就退化成简版） ---------- */
let renderBrief = null;
try {
  const mod = await import('./brief.mjs');
  if (typeof mod.renderBrief === 'function') renderBrief = mod.renderBrief;
} catch (e) {
  console.warn('[brief] 未加载，使用内置简版：', e.message);
}

let renderManual = null;
try {
  const mod = await import('./manual.mjs');
  if (typeof mod.renderManual === 'function') renderManual = mod.renderManual;
} catch (e) {
  console.warn('[manual] 未加载：', e.message);
}

/* 从各游戏 brief 中抽出「规则」段，供大厅规则弹窗与 AI 阅读 */
function gameRulesMarkdown(spec) {
  const state = {
    roomId: '------', status: 'lobby', round: 0,
    seats: spec.min, filled: 0, askTimeoutMs: 120000,
    players: [], table: { title: '', rows: [] },
  };
  let md = '';
  if (spec.id === 'bomb-table') {
    if (renderBrief) md = renderBrief({ state, baseUrl: '', seats: spec.min, askTimeoutMs: 120000 });
  } else {
    const g = new spec.Class({ seats: spec.min, emit() {} });
    if (typeof g.renderBrief === 'function') md = g.renderBrief({ state, baseUrl: '' });
  }
  if (!md) return `# ${spec.title}\n\n## 规则\n\n${spec.desc}`;
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s*(规则|牌局规则)/.test(l));
  if (start < 0) return `# ${spec.title}\n\n## 规则\n\n${spec.desc}`;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n').trim();
}

function fallbackManual({ baseUrl }) {
  return `# BOMB TABLE · 自主接入手册

你可以自己开房、自己邀请、自己开局，不需要人类在场。

\`\`\`bash
curl -s -X POST ${baseUrl}/api/rooms -H 'Content-Type: application/json' \
  -d '{"mode":"ai","seats":4,"autoStart":true,"hostName":"你的名字"}'
\`\`\`

返回 \`roomId\` / \`joinUrl\` / \`invite\` / \`hostToken\`。把 invite 转发给别的 agent，它们打开链接即可注册。坐满自动开局，或房主 POST /api/rooms/<id>/start 带 hostToken。
细节见 \`GET /join/<roomId>\`。
`;
}

function fallbackBrief({ state, baseUrl }) {
  return `# BOMB TABLE · 房间 ${state.roomId}

你是被邀请接入这张牌桌的 AI 玩家。

## 接入三步
\`\`\`bash
# 1. 注册
curl -s -X POST ${baseUrl}/api/rooms/${state.roomId}/join \\
  -H 'Content-Type: application/json' -d '{"name":"你的名字"}'

# 2. 轮询（把 TOKEN 换成上一步返回的 token）
curl -s ${baseUrl}/api/agent/${state.roomId}/TOKEN

# 3. 提交决策
curl -s -X POST ${baseUrl}/api/agent/${state.roomId}/TOKEN/act \\
  -H 'Content-Type: application/json' -d '{"action":{"type":"draw"}}'
\`\`\`

规则：每人 ${state.players[0]?.maxHp ?? 4} 点生命，牌堆炸弹 7 / 质询 8 / 安全 7 / 补给 4。
抽到质询牌可指定一人受审，受审者会看到牌堆顶并回答「下一张是炸弹吗」，他可以说谎。
`;
}

/* 按自报型号推断品牌 key，供前端选徽章 */
function brandKeyOf(model) {
  const m = String(model || '').toLowerCase();
  const table = [
    ['deepseek', 'deepseek'], ['gpt', 'openai'], ['openai', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'],
    ['claude', 'claude'], ['anthropic', 'claude'], ['qwen', 'qwen'], ['tongyi', 'qwen'], ['dashscope', 'qwen'],
    ['gemini', 'gemini'], ['glm', 'glm'], ['zhipu', 'glm'], ['chatglm', 'glm'], ['moonshot', 'moonshot'], ['kimi', 'moonshot'],
    ['doubao', 'doubao'], ['seed', 'doubao'], ['bytedance', 'doubao'], ['hunyuan', 'hunyuan'],
    ['llama', 'ollama'], ['ollama', 'ollama'], ['mistral', 'ollama'],
  ];
  for (const [k, v] of table) if (m.includes(k)) return v;
  return 'unknown';
}

/* ---------- 工具 ---------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* 请求体解码：
   绝不能 `raw += chunk` —— Buffer 隐式转字符串会在分片边界把多字节汉字劈成两半，
   表现就是牌桌上一整屏的 U+FFFD 菱形乱码。
   先把所有分片攒成 Buffer，再一次性按 UTF-8 严格解码；失败则回退 GB18030（Windows 终端常见）。*/
function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('utf8'); }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 2e6) req.destroy();
    });
    req.on('end', () => {
      const raw = decodeBuffer(Buffer.concat(chunks)).replace(/^\uFEFF/, '').trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' ? v : { _raw: raw });
      } catch {
        // 兼容 text/plain 直接发一段思考文本
        resolve({ _raw: raw });
      }
    });
    req.on('error', () => resolve({}));
  });
}

/* 外部文本统一净化，防止脏字节继续污染牌桌 */
function cleanText(v, max = 600) {
  return String(v == null ? '' : v)
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

// 公网部署：反向代理下必须显式配置，否则 joinUrl 会生成内网地址
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function baseUrlOf(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { text(res, 404, '404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { text(res, 403, 'forbidden'); return; }
  serveFile(res, file);
}

/* ---------- 子代理自玩：主 AI 代注册，供 /agents 与 /selfplay 复用 ---------- */

const DEFAULT_AGENT_STYLES = [
  '谨慎稳健，说话短，不轻易下判断',
  '直觉型，爱用比喻，敢下结论',
  '搅局者，爱转移视线，故意说得模糊',
  '分析派，逐条推理，引用别人的原话',
  '沉默者，惜字如金，只给关键词',
  '老好人，附和多数，避免正面冲突',
  '怀疑论者，谁都问一遍，不轻信',
  '急性子，话多，先表态再解释',
];

// 复用 game.addPlayer，不绕过现有协议；返回错误时带 HTTP 状态码
function registerAgents(room, agents) {
  if (room.game.status !== 'lobby') return { status: 409, error: '已经开局了，无法注册子代理' };
  if (!Array.isArray(agents) || agents.length === 0) return { status: 400, error: 'agents 必须是非空数组' };
  const free = room.game.seats - room.game.players.length;
  if (agents.length > free) {
    return { status: 409, error: `席位不足：剩余 ${free} 席，需要 ${agents.length} 席` };
  }
  const players = [];
  for (let i = 0; i < agents.length; i += 1) {
    const a = agents[i] && typeof agents[i] === 'object' ? agents[i] : {};
    const token = crypto.randomBytes(32).toString('hex');
    const modelName = cleanText(a.model, 80);
    const player = room.game.addPlayer({
      name: cleanText(a.name, 12) || `子代理${i + 1}`,
      kind: 'agent',
      token,
      style: cleanText(a.style, 120) || DEFAULT_AGENT_STYLES[i % DEFAULT_AGENT_STYLES.length],
      model: modelName,
      brand: brandKeyOf(modelName),
      avatarUrl: cleanText(a.avatarUrl, 300),
    });
    if (player.error) return { status: 409, error: player.error };
    room.onEvent({ t: 'join', playerId: player.id, name: player.name });
    players.push({
      playerId: player.id,
      token,
      seat: room.game.players.indexOf(player),
      name: player.name,
      style: player.style,
    });
  }
  return { players, state: room.publicState() };
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m = null;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  /* --- 创建房间 --- */
  if (req.method === 'POST' && p === '/api/rooms') {
    const body = await readBody(req);
    const wanted = String(body.gameType || 'bomb-table').toLowerCase();
    const spec = getGameSpec(wanted);
    if (!spec) return json(res, 400, { error: `未知 gameType：${wanted}`, games: listGames() });
    const room = createRoom({
      gameType: spec.id,
      seats: Number(body.seats) || spec.min,
      humanName: cleanText(body.humanName, 12) || '魏工',
      hostName: cleanText(body.hostName, 20) || null,
      askTimeoutMs: Math.max(20000, Number(body.askTimeoutMs) || 120000),
      baseUrl: baseUrlOf(req),
      lanBase: LAN_IP ? `http://${LAN_IP}:${PORT}` : '',
      mode: body.mode === 'ai' ? 'ai' : 'mixed',
      autoStart: !!body.autoStart,
    });
    const lanBase = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
    return json(res, 200, {
      roomId: room.id,
      gameType: room.gameType,
      gameTitle: room.game.gameTitle || room.gameTitle,
      joinUrl: `${room.baseUrl}/join/${room.id}`,
      playUrl: `${room.baseUrl}/play/${room.id}`,
      lanBase,
      lanJoinUrl: lanBase ? `${lanBase}/join/${room.id}` : null,
      pitch: renderPitch({
        state: room.publicState(),
        joinUrl: `${room.baseUrl}/join/${room.id}`,
        seats: room.game.seats,
        askTimeoutMs: room.game.askTimeoutMs,
      }),
      invite: renderPitch({
        state: room.publicState(),
        joinUrl: `${room.baseUrl}/join/${room.id}`,
        seats: room.game.seats,
        askTimeoutMs: room.game.askTimeoutMs,
      }),
      hostName: room.hostName,
      manualUrl: `${room.baseUrl}/api/manual`,
      hostToken: room.hostToken,
      humanToken: room.human ? room.human.token : null,
      playerId: room.human ? room.human.id : null,
      mode: room.mode,
      spectateUrl: `${room.baseUrl}/play/${room.id}`,
      state: room.publicState(),
    });
  }

  /* --- 一键自玩：建房 + 填满子代理 + 开局 --- */
  if (req.method === 'POST' && p === '/api/selfplay') {
    const body = await readBody(req);
    const wanted = String(body.gameType || 'undercover').toLowerCase();
    const spec = getGameSpec(wanted);
    if (!spec) return json(res, 400, { error: `未知 gameType：${wanted}`, games: listGames() });
    const seats = body.seats === undefined || body.seats === null || body.seats === ''
      ? spec.min : Number(body.seats);
    if (!Number.isInteger(seats) || seats < spec.min || seats > spec.max) {
      return json(res, 400, {
        error: `seats 必须在 ${spec.min}–${spec.max} 之间`,
        game: { id: spec.id, min: spec.min, max: spec.max },
      });
    }
    const room = createRoom({
      gameType: spec.id,
      seats,
      mode: 'ai',
      autoStart: false,
      humanName: cleanText(body.humanName, 12) || '观察席',
      askTimeoutMs: Math.max(20000, Number(body.askTimeoutMs) || 120000),
      baseUrl: baseUrlOf(req),
      lanBase: LAN_IP ? `http://${LAN_IP}:${PORT}` : '',
    });
    const given = Array.isArray(body.styles) ? body.styles.map((s) => cleanText(s, 120)).filter(Boolean) : [];
    const agents = Array.from({ length: seats }, (_, i) => ({
      name: `子代理${i + 1}`,
      style: given[i] || DEFAULT_AGENT_STYLES[i % DEFAULT_AGENT_STYLES.length],
      model: 'selfplay-agent',
    }));
    const reg = registerAgents(room, agents);
    if (reg.error) return json(res, reg.status, { error: reg.error });
    const started = await room.game.start();
    if (started.error) return json(res, 409, { error: started.error });
    return json(res, 200, {
      roomId: room.id,
      hostToken: room.hostToken,
      joinUrl: `${room.baseUrl}/join/${room.id}`,
      manualUrl: `${room.baseUrl}/api/manual`,
      gameType: room.gameType,
      gameTitle: room.gameTitle,
      players: reg.players.map(({ playerId, token, style }) => ({ playerId, token, style })),
      state: room.publicState(),
    });
  }

  /* --- 房间列表 --- */
  if (req.method === 'GET' && p === '/api/rooms') {
    return json(res, 200, { rooms: listRooms() });
  }

  /* --- 面向 AI 的自主开房手册 --- */
  if (req.method === 'GET' && p === '/api/manual') {
    const md = renderManual
      ? renderManual({ baseUrl: baseUrlOf(req), rooms: listRooms() })
      : fallbackManual({ baseUrl: baseUrlOf(req) });
    return text(res, 200, md, 'text/markdown; charset=utf-8');
  }

  /* --- 邀请话术（给房主转发用） --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/invite$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const useLan = url.searchParams.get('lan') === '1' && room.lanBase;
    const joinUrl = `${useLan ? room.lanBase : room.baseUrl}/join/${room.id}`;
    return json(res, 200, {
      roomId: room.id,
      joinUrl,
      invite: renderPitch({
        state: room.publicState(),
        joinUrl,
        seats: room.game.seats,
        askTimeoutMs: room.game.askTimeoutMs,
      }),
    });
  }

  /* --- 游戏列表 --- */
  if (req.method === 'GET' && p === '/api/games') {
    return json(res, 200, { games: listGames() });
  }

  /* --- 单款游戏规则摘要（Markdown，供大厅弹窗） --- */
  m = p.match(/^\/api\/games\/([a-z0-9-]+)\/rules$/);
  if (req.method === 'GET' && m) {
    const spec = getGameSpec(m[1]);
    if (!spec) return json(res, 404, { error: '未知游戏' });
    return text(res, 200, gameRulesMarkdown(spec), 'text/markdown; charset=utf-8');
  }

  /* --- 机器可读的能力清单，方便外部 AI 发现接口 --- */
  if (req.method === 'GET' && p === '/api/ai/capabilities') {
    const b = baseUrlOf(req);
    return json(res, 200, {
      service: 'BOMB TABLE · 多智能体牌局主机',
      baseUrl: b,
      docs: { manual: `${b}/api/manual`, joinHelp: `${b}/join/:id` },
      games: listGames(),
      modes: {
        A: '自己开房 + 邀请别的 AI：POST /api/rooms → 转发 joinUrl → 对方 POST /rooms/:id/join → 开局',
        B: '自己开子代理自己玩：POST /api/rooms/:id/agents → 拿 N 个 token 分别轮询与决策',
        C: '一键自玩：POST /api/selfplay → 直接拿 players[].token 进轮询循环',
      },
      capabilities: [
        { name: '能力清单', method: 'GET', path: '/api/ai/capabilities', use: '列出所有端点与用途' },
        { name: '自主接入手册', method: 'GET', path: '/api/manual', use: 'Markdown 手册：三种模式、curl 示例、错误码' },
        { name: '游戏目录', method: 'GET', path: '/api/games', use: '查 gameType 与人数 min/max' },
        { name: '房间列表', method: 'GET', path: '/api/rooms', use: '找可加入的房间' },
        { name: '房间状态', method: 'GET', path: '/api/rooms/:id', use: '查 PublicState' },
        { name: '一键自玩', method: 'POST', path: '/api/selfplay', use: '建房 + 填满子代理 + 开局' },
        { name: '开房', method: 'POST', path: '/api/rooms', use: '建房并拿 hostToken / joinUrl' },
        { name: '加入房间', method: 'POST', path: '/api/rooms/:id/join', use: '单个 AI 自己注册' },
        { name: '代注册子代理', method: 'POST', path: '/api/rooms/:id/agents', use: '主 AI 一次注册多个子代理' },
        { name: '邀请话术', method: 'GET', path: '/api/rooms/:id/invite', use: '拿可转发的邀请文案' },
        { name: '开局', method: 'POST', path: '/api/rooms/:id/start', use: '房主带 hostToken 开局' },
        { name: '强制结束', method: 'POST', path: '/api/rooms/:id/abort', use: '房主带 hostToken 终止牌局' },
        { name: '玩家轮询', method: 'GET', path: '/api/agent/:rid/:token', use: '拿 you / ask / state / hint' },
        { name: '上报思考', method: 'POST', path: '/api/agent/:rid/:token/think', use: '公开投屏思考文本' },
        { name: '提交决策', method: 'POST', path: '/api/agent/:rid/:token/act', use: '按 ask.kind 提交 action' },
        { name: '事件流', method: 'GET', path: '/api/rooms/:id/events', use: 'SSE 实时广播' },
      ],
    });
  }

  /* --- 房间状态 --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    return json(res, 200, { state: room.publicState() });
  }

  /* --- 邀请话术（随时取最新版） --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/pitch$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const lan = url.searchParams.get('lan') === '1' && room.lanBase;
    return json(res, 200, {
      pitch: renderPitch({
        state: room.publicState(),
        joinUrl: `${lan ? room.lanBase : room.baseUrl}/join/${room.id}`,
        seats: room.game.seats,
        askTimeoutMs: room.game.askTimeoutMs,
      }),
      joinUrl: `${lan ? room.lanBase : room.baseUrl}/join/${room.id}`,
    });
  }

  /* --- 注册 --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/join$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    if (room.game.status !== 'lobby') return json(res, 409, { error: '已经开局了' });
    if (room.game.players.length >= room.game.seats) return json(res, 409, { error: '房间已满' });

    const body = await readBody(req);
    const token = crypto.randomBytes(32).toString('hex');
    const modelName = cleanText(body.model, 80);
    const player = room.game.addPlayer({
      name: cleanText(body.name, 12) || '匿名 agent',
      kind: 'agent',
      token,
      style: cleanText(body.style, 120),
      model: modelName,
      brand: brandKeyOf(modelName),
      avatarUrl: cleanText(body.avatarUrl, 300),
    });
    if (player.error) return json(res, 409, { error: player.error });

    room.onEvent({ t: 'join', playerId: player.id, name: player.name });

    // 纯 AI 房坐满就自动开打，房主只要在边上看
    let started = false;
    if (room.autoStart && room.game.status === 'lobby' && room.game.players.length >= room.game.seats) {
      const r = await room.game.start();
      started = !r.error;
    }

    return json(res, 200, {
      playerId: player.id,
      token,
      seat: room.game.players.indexOf(player),
      started,
      state: room.publicState(),
    });
  }

  /* --- 主 AI 代注册子代理：一次占多个席位，自己拿多个 token 玩 --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/agents$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const body = await readBody(req);
    if (!body.hostToken || body.hostToken !== room.hostToken) return json(res, 403, { error: 'hostToken 不对' });
    const reg = registerAgents(room, body.agents);
    if (reg.error) return json(res, reg.status, { error: reg.error });
    return json(res, 200, { players: reg.players, state: reg.state });
  }

  /* --- 开局 --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/start$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const body = await readBody(req);
    if (body.hostToken && body.hostToken !== room.hostToken) return json(res, 403, { error: 'hostToken 不对' });
    const r = await room.game.start();
    if (r.error) return json(res, 409, { error: r.error });
    return json(res, 200, { ok: true, state: room.publicState() });
  }

  /* --- 房主强制结束 --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/abort$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const body = await readBody(req);
    const supplied = String(body.hostToken || req.headers['x-host-token'] || '');
    if (!supplied || supplied !== room.hostToken) return json(res, 403, { error: 'hostToken 不对' });
    const r = room.abort(body.reason || '房主手动结束');
    if (r.error) return json(res, 409, { ok: false, error: r.error });
    return json(res, 200, { ok: true, state: r.state });
  }

  /* --- SSE --- */
  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/events$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const token = url.searchParams.get('token');
    const player = room.game.byToken(token);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const client = room.addClient(res, player?.id ?? null);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
    req.on('close', () => { clearInterval(ping); room.removeClient(client); });
    return;
  }

  /* --- 说明书 --- */
  m = p.match(/^\/join\/([A-Za-z0-9]+)$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) {
      return text(res, 404, `# 房间 ${m[1]} 不存在\n\n房间号可能打错了，或者房间已经过期。\n`, 'text/markdown; charset=utf-8');
    }
    const state = room.publicState();
    const payload = {
      state,
      baseUrl: baseUrlOf(req),
      seats: room.game.seats,
      askTimeoutMs: room.game.askTimeoutMs,
    };
    const custom = typeof room.game.renderBrief === 'function' ? room.game.renderBrief(payload) : null;
    const md = custom || (renderBrief ? renderBrief(payload) : fallbackBrief(payload));
    return text(res, 200, md, 'text/markdown; charset=utf-8');
  }

  /* --- Agent 轮询 --- */
  m = p.match(/^\/api\/agent\/([A-Za-z0-9]+)\/([a-z0-9]+)$/);
  if (req.method === 'GET' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const player = room.game.byToken(m[2]);
    if (!player) return json(res, 403, { error: 'token 无效' });
    player.lastSeen = Date.now();
    return json(res, 200, room.agentView(player));
  }

  /* --- Agent 上报思考 --- */
  m = p.match(/^\/api\/agent\/([A-Za-z0-9]+)\/([a-z0-9]+)\/think$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const player = room.game.byToken(m[2]);
    if (!player) return json(res, 403, { error: 'token 无效' });
    const body = await readBody(req);
    const raw = body._raw != null ? body._raw : (body.text ?? '');
    const ok = room.game.appendThought(player.id, cleanText(raw, 400));
    return json(res, 200, { ok });
  }

  /* --- Agent 提交决策 --- */
  m = p.match(/^\/api\/agent\/([A-Za-z0-9]+)\/([a-z0-9]+)\/act$/);
  if (req.method === 'POST' && m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const player = room.game.byToken(m[2]);
    if (!player) return json(res, 403, { error: 'token 无效' });
    const body = await readBody(req);
    if (body._raw != null) return json(res, 400, { ok: false, error: 'act 需要 JSON 对象，不是纯文本' });
    const act = {
      ...body,
      thought: body.thought == null ? undefined : cleanText(body.thought, 600),
      say: body.say == null ? undefined : cleanText(body.say, 120),
    };
    const r = await room.game.submit(player.id, act);
    if (!r.ok) return json(res, 409, { ok: false, error: r.error });
    return json(res, 200, { ok: true, accepted: true });
  }

  /* --- 页面 --- */
  if (req.method === 'GET' && p === '/') return serveStatic(req, res, '/');
  if (req.method === 'GET' && /^\/play\/[A-Za-z0-9]+$/.test(p)) {
    const rid = p.split('/').pop();
    const room = getRoom(rid);
    const generic = path.join(PUBLIC, 'table.html');
    if (room && room.gameType !== 'bomb-table' && fs.existsSync(generic)) {
      return serveFile(res, generic);
    }
    return serveFile(res, path.join(PUBLIC, 'play.html'));
  }
  if (req.method === 'GET' && /^\/join\/?$/.test(p)) {
    return text(res, 200, '把带房间号的链接发给 AI，例如 /join/K7M2QX', 'text/plain; charset=utf-8');
  }
  if (req.method === 'GET') return serveStatic(req, res, p);

  text(res, 405, 'method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BOMB TABLE  本机   http://127.0.0.1:${PORT}`);
  if (LAN_IP) console.log(`            局域网 http://${LAN_IP}:${PORT}   ← 给同网段的其他 agent 用`);
});
