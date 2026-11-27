// GET /api/rooms/:id — PublicState（热快照）
import { getRoomState, RoomError } from '@/lib/rooms';
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
    return json(await getRoomState(id));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
