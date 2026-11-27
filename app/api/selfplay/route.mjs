// POST /api/selfplay — 一键建房 + 子代理填满 + 开局
import { getGameSpec, listGames } from '@/lib/engine/registry';
import {
  createRoom, registerAgents, startRoom, RoomError,
} from '@/lib/rooms';
import { cleanText, DEFAULT_AGENT_STYLES } from '@/lib/text';
import { baseUrlOf, json, preflight, readJson } from '@/lib/http';

export const dynamic = 'force-dynamic';

function fail(e) {
  if (e instanceof RoomError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
  console.error('[api]', e);
  return json({ error: '服务器内部错误' }, 500);
}

export async function POST(request) {
  try {
    const body = await readJson(request);
    const wanted = String(body.gameType || 'undercover').toLowerCase();
    const spec = getGameSpec(wanted);
    if (!spec) return json({ error: `未知 gameType：${wanted}`, games: listGames() }, 400);

    const seats = body.seats === undefined || body.seats === null || body.seats === ''
      ? spec.min : Number(body.seats);
    if (!Number.isInteger(seats) || seats < spec.min || seats > spec.max) {
      return json({
        error: `seats 必须在 ${spec.min}–${spec.max} 之间`,
        game: { id: spec.id, min: spec.min, max: spec.max },
      }, 400);
    }

    const baseUrl = baseUrlOf(request);
    const room = await createRoom({
      gameType: spec.id,
      seats,
      mode: 'ai',
      autoStart: false,
      humanName: '观察席',
      askTimeoutMs: body.askTimeoutMs,
      baseUrl,
    });

    const given = Array.isArray(body.styles)
      ? body.styles.map((s) => cleanText(s, 120)).filter(Boolean)
      : [];
    const agents = Array.from({ length: seats }, (_, i) => ({
      name: `子代理${i + 1}`,
      style: given[i] || DEFAULT_AGENT_STYLES[i % DEFAULT_AGENT_STYLES.length],
      model: 'selfplay-agent',
    }));

    const reg = await registerAgents(room.roomId, room.hostToken, agents, baseUrl);
    const started = await startRoom(room.roomId, room.hostToken, baseUrl);

    return json({
      roomId: room.roomId,
      hostToken: room.hostToken,
      joinUrl: room.joinUrl,
      manualUrl: room.manualUrl,
      gameType: room.gameType,
      gameTitle: room.gameTitle,
      players: reg.players.map(({ playerId, token, style }) => ({ playerId, token, style })),
      state: started.state,
    });
  } catch (e) {
    return fail(e);
  }
}

export function OPTIONS() {
  return preflight();
}
