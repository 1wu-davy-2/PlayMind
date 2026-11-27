// POST /api/rooms/:id/join — 注册为玩家
import { joinRoom, RoomError } from '@/lib/rooms';
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
    return json(await joinRoom(id, body, baseUrlOf(request)));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
