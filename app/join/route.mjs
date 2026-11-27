// GET /join — 纯文本提示
import { preflight, text } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  return text('把带房间号的链接发给 AI，例如 /join/K7M2QX', 200);
}

export function OPTIONS() {
  return preflight();
}
