// GET /api/rooms — 房间列表；POST /api/rooms — 建房
import {
  createRoom, listRoomSummaries, RoomError,
} from '@/lib/rooms';
import { baseUrlOf, json, preflight, readJson } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request) {
  try {
    const baseUrl = baseUrlOf(request);
    return json({ rooms: await listRoomSummaries(baseUrl) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const body = await readJson(request);
    return json(await createRoom({ ...body, baseUrl: baseUrlOf(request) }));
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
