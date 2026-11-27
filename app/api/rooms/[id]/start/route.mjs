// POST /api/rooms/:id/start — 房主开局
import { startRoom, RoomError } from '@/lib/rooms';
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
    return json(await startRoom(id, body.hostToken, baseUrlOf(request)));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
