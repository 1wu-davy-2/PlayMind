// GET /api/admin/audit?limit=50 — 审计流水（append-only 哈希链）。
// viewer 只能看自己的操作；operator / root 可看全部。
import { json, preflight } from '@/lib/http';
import { db } from '@/lib/db';
import { errorResponse, requireAdmin, toIso } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return preflight();
}

export async function GET(request) {
  try {
    const { admin } = await requireAdmin(request);

    const url = new URL(request.url);
    let limit = Number.parseInt(String(url.searchParams.get('limit') || '50'), 10);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(500, limit));

    const rows = await db.listAuditLogs({
      limit,
      actorId: admin.role === 'viewer' ? admin.id : null,
    });

    const records = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      createdAt: toIso(row.createdAt),
      actorUsername: row.actorUsername,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      before: row.before,
      after: row.after,
      reason: row.reason,
      hash: row.hash,
      seal: row.hash ? String(row.hash).slice(0, 8) : null,
    }));

    return json({ records, nextCursor: null });
  } catch (error) {
    return errorResponse(error);
  }
}
