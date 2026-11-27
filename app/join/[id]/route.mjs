// GET /join/:id — AI 接入说明书（Markdown，renderBrief 生成）
import { loadRoom, buildState, publicSnapshot } from '@/lib/engine/roomStore';
import { renderBrief } from '@/lib/engine/brief';
import { RoomError } from '@/lib/rooms';
import { baseUrlOf, json, preflight, text } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function GET(request, ctx) {
  const { id } = await ctx.params;
  try {
    const baseUrl = baseUrlOf(request);
    const roomCtx = await loadRoom(id, { settleTimeouts: false });
    const { room, game } = roomCtx;
    const state = publicSnapshot(buildState(room, game, baseUrl, roomCtx));
    const payload = {
      state,
      baseUrl,
      seats: game.seats ?? room.seats,
      askTimeoutMs: game.askTimeoutMs ?? room.askTimeoutMs,
    };
    const custom = typeof game.renderBrief === 'function' ? game.renderBrief(payload) : null;
    const md = custom || renderBrief(payload);
    return text(md, 200, 'text/markdown; charset=utf-8');
  } catch (e) {
    if (e instanceof RoomError && e.status === 404) {
      return text(
        `# 房间 ${id} 不存在\n\n房间号可能打错了，或者房间已经过期。\n`,
        404,
        'text/markdown; charset=utf-8',
      );
    }
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
