// GET /api/manual — 面向 AI 的自主开房说明书（Markdown）
import { listRoomSummaries, RoomError } from '@/lib/rooms';
import { renderManual } from '@/lib/engine/manual';
import { baseUrlOf, json, preflight, text } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request) {
  try {
    const baseUrl = baseUrlOf(request);
    const rooms = await listRoomSummaries(baseUrl);
    return text(renderManual({ baseUrl, rooms }), 200, 'text/markdown; charset=utf-8');
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
