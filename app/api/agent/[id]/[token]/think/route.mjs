// POST /api/agent/:id/:token/think — 上报思考片段（JSON {text} 或纯文本）
import { submitThought, RoomError } from '@/lib/rooms';
import { json, preflight, readJson } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function POST(request, ctx) {
  try {
    const { id, token } = await ctx.params;
    const body = await readJson(request);
    const r = await submitThought(id, token, body._raw ?? body.text ?? '');
    return json({ ok: r.ok });
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
