// GET /api/rooms/:id/events?since=&token= — 增量事件轮询
import { listRoomEvents, RoomError } from '@/lib/rooms';
import { json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request, ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(request.url);
    const since = Number(url.searchParams.get('since')) || 0;
    const token = url.searchParams.get('token');
    return json(await listRoomEvents(id, { since, token }));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
