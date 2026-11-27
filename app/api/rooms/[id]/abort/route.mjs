// POST /api/rooms/:id/abort — 房主强制结束（hostToken 也可用 X-Host-Token 头）
import { abortRoom, RoomError } from '@/lib/rooms';
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
    const hostToken = body.hostToken || request.headers.get('x-host-token') || '';
    return json(await abortRoom(id, hostToken, body.reason || '', baseUrlOf(request)));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
