// GET /api/admin/rooms/[id]/godview?level=masked|raw&reason=...
// masked：viewer 及以上；raw：operator 及以上且必须填 reason。
// 每次读取都写 godview_snapshots + audit_logs，且审计成功后才返回数据。
import { json, preflight, clientIp } from '@/lib/http';
import { db } from '@/lib/db';
import { adminGodview } from '@/lib/rooms';
import {
  apiError,
  errorResponse,
  requireAdmin,
  serializeGodview,
} from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return preflight();
}

export async function GET(request, ctx) {
  try {
    const params = ctx && ctx.params ? await ctx.params : {};
    const id = String(params.id || '');
    if (!id) throw apiError(400, '缺少房间号');

    const url = new URL(request.url);
    const level = url.searchParams.get('level') === 'raw' ? 'raw' : 'masked';
    const reason = String(url.searchParams.get('reason') || '').trim();

    // viewer 访问 raw 直接 403（requireAdmin 抛 ApiError(403)）
    const { admin, session } = await requireAdmin(request, {
      minRole: level === 'raw' ? 'operator' : 'viewer',
    });

    if (level === 'raw' && !reason) {
      throw apiError(400, 'raw 需要填写 reason');
    }

    const data = await adminGodview(id, { level });

    // 快照 + 审计一次事务写入；任一步失败都不返回数据
    const ip = clientIp(request);
    await db.recordGodviewRead({
      snapshot: {
        roomCode: id,
        capturedBy: admin.id,
        visibilityLevel: level,
        publicState: data.publicState,
        playersPrivate: data.players,
        pendingAsks: data.asks,
        thoughts: data.thoughts,
        events: data.events,
      },
      audit: {
        actorId: admin.id,
        actorUsername: admin.username,
        sessionId: session.id,
        action: 'admin.godview.read',
        targetType: 'room',
        targetId: id,
        after: {
          level,
          eventCount: Array.isArray(data.events) ? data.events.length : 0,
        },
        reason: reason || null,
        ipAddress: ip && ip !== 'unknown' ? ip : null,
      },
    });

    return json(serializeGodview(data));
  } catch (error) {
    return errorResponse(error);
  }
}
