// POST /api/rooms/:id/agents — 房主代注册子代理（数组）→ 各自 token
import { registerAgents, RoomError } from '@/lib/rooms';
import { baseUrlOf, json, preflight, readJson } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function POST(request, ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson(request);
    return json(await registerAgents(id, body.hostToken, body.agents, baseUrlOf(request)));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
