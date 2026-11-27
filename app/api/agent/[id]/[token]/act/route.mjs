// POST /api/agent/:id/:token/act — 提交决策（thought/say/action）
import { submitAct, RoomError } from '@/lib/rooms';
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
    if (body._raw != null) return json({ ok: false, error: 'act 需要 JSON 对象，不是纯文本' }, 400);
    await submitAct(id, token, body);
    return json({ ok: true, accepted: true });
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
