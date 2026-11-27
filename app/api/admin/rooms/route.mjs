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

    // 在线 AI 数 = 所有房间玩家中 kind === 'agent' 的总数
    let agentsPresent = 0;
    for (const room of rooms) {
      try {
        const players = await db.listPlayers(room.roomId);
        agentsPresent += players.filter((p) => p && p.kind === 'agent').length;
      } catch {
        // 单房间读取失败不影响整体统计
      }
    }

    const revealsToday = await db.countRawRevealsToday();

    return json({
      rooms: decorated,
      stats: {
        activeRooms: rooms.filter((room) => room.status === 'playing').length,
        agentsPresent,
        revealsToday,
        unloggedOps: 0,
      },
      total: decorated.length,
      admin: { username: admin.username, role: admin.role },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
