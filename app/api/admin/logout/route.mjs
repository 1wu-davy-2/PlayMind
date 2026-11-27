// POST /api/admin/logout — 吊销当前管理员会话并清除 Cookie。
import { json, preflight, baseUrlOf } from '@/lib/http';
import { clearSessionCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { errorResponse, getSessionAdmin, writeAudit } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  try {
    const ctx = await getSessionAdmin(request);
    if (ctx) {
      await db.revokeAdminSession(ctx.session.id);
      await writeAudit({
        admin: ctx.admin,
        session: ctx.session,
        action: 'admin.logout',
        targetType: 'admin',
        targetId: ctx.admin.id,
        reason: '管理员登出',
        request,
      });
    }

    const res = json({ ok: true });
    res.headers.append('Set-Cookie', clearSessionCookie(baseUrlOf(request).startsWith('https://')));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
