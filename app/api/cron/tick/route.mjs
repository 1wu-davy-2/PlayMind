// GET|POST /api/cron/tick — 超时兜底（vercel cron 每分钟触发）
import { tickAll, RoomError } from '@/lib/rooms';
import { json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

async function handle(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) return json({ error: '未授权' }, 401);
  }
  try {
    const { ticked } = await tickAll();
    return json({ ok: true, ticked });
  } catch (e) {
    return fail(e);
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}

export function OPTIONS() {
  return preflight();
}
