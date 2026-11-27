// GET /api/admin/rooms — 全量房间（脱敏列表）+ 顶部统计。
// 仅返回列表级字段，私有信息一律走 godview（并留痕）。
import { json, preflight } from '@/lib/http';
import { db } from '@/lib/db';
import { adminRoomSummaries } from '@/lib/rooms';
import { errorResponse, requireAdmin, toIso } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return preflight();
}

export async function GET(request) {
  try {
    const { admin } = await requireAdmin(request);

    const rooms = await adminRoomSummaries();
    const decorated = rooms.map((room) => ({
      ...room,
      displayCode: `BT-${String(room.roomId).slice(-4)}`,
      uiState: room.status === 'lobby' ? 'waiting' : room.status,
      createdAt: toIso(room.createdAt),
      // 前端按角色禁用按钮；服务端仍会做权威校验
      canIntervene: room.status !== 'ended' && admin.role !== 'viewer',
    }));

    // 一次聚合查询拿到统计卡数据，避免按房间 N+1
    const stats = await db.adminStats();

    return json({
      rooms: decorated,
      stats: {
        activeRooms: stats.activeRooms,
        agentsPresent: stats.agentsPresent,
        revealsToday: stats.revealsToday,
        unloggedOps: 0,
      },
      total: decorated.length,
      admin: { username: admin.username, role: admin.role },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
