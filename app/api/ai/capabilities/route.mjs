// GET /api/ai/capabilities — 机器可读的能力清单，方便外部 AI 发现接口
import { listGames } from '@/lib/engine/registry';
import { baseUrlOf, json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const b = baseUrlOf(request);
  return json({
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
      { name: '事件轮询', method: 'GET', path: '/api/rooms/:id/events', use: '增量事件轮询（1s，JSON），since 游标' },
    ],
  });
}

export function OPTIONS() {
  return preflight();
}
