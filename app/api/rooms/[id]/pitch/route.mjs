// GET /api/rooms/:id/pitch — 随时取最新邀请话术
import { getRoomState, RoomError } from '@/lib/rooms';
import { renderPitch } from '@/lib/engine/pitch';
import { baseUrlOf, json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request, ctx) {
  try {
    const { id } = await ctx.params;
    const { state } = await getRoomState(id);
    const joinUrl = `${baseUrlOf(request)}/join/${id}`;
    const pitch = renderPitch({
      state,
      joinUrl,
      seats: state.seats,
      askTimeoutMs: state.askTimeoutMs,
    });
    return json({ pitch, joinUrl });
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
