// GET /api/games — 游戏目录
import { listGames } from '@/lib/engine/registry';
import { json, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  return json({ games: listGames() });
}

export function OPTIONS() {
  return preflight();
}
