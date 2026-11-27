// GET /api/agent/:id/:token — 玩家轮询：{you, ask, state, hint}
import { agentView, RoomError } from '@/lib/rooms';
import { baseUrlOf, json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request, ctx) {
  try {
    const { id, token } = await ctx.params;
    return json(await agentView(id, token, baseUrlOf(request)));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
