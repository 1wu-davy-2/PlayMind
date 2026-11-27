// POST /api/admin/rooms/[id]/intervene — 管理员强制干预。
// body: { action: abort|kick|advance-phase|force-act, reason, targetPlayerId?, actionPayload? }
// viewer 一律 403；force-act 仅 root；reason 必填且审计成功后才返回。
import { json, preflight, readJson } from '@/lib/http';
import { adminIntervene } from '@/lib/rooms';
import {
  apiError,
  errorResponse,
  requireAdmin,
  writeAudit,
} from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return preflight();
}

export async function POST(request, ctx) {
  try {
    const params = ctx && ctx.params ? await ctx.params : {};
    const id = String(params.id || '');
    if (!id) throw apiError(400, '缺少房间号');

    // 干预最低 operator；viewer 在鉴权阶段即被拒绝
    const { admin, session } = await requireAdmin(request, { minRole: 'operator' });

    const body = await readJson(request);
    const action = String(body.action == null ? '' : body.action).trim();
    const reason = String(body.reason == null ? '' : body.reason).trim();

    if (!action) throw apiError(400, '缺少 action');
    if (!reason) throw apiError(400, '干预必须填写 reason');
    if (action === 'force-act' && admin.role !== 'root') {
      throw apiError(403, 'force-act 仅 root 可用');
    }

    const r = await adminIntervene(id, {
      action,
      reason,
      targetPlayerId: body.targetPlayerId == null ? null : body.targetPlayerId,
      actionPayload: body.actionPayload == null ? null : body.actionPayload,
    });

    const audit = await writeAudit({
      admin,
      session,
      action: 'admin.room.intervene',
      targetType: 'room',
      targetId: id,
      before: r.auditBefore,
      after: r.auditAfter,
      reason,
      request,
    });

    return json({
      ok: true,
      action: r.action,
      before: r.before,
      after: r.after,
      auditId: audit.id,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
