// GET /api/games/:type/rules — 规则摘要（Markdown，从插件 brief 抽「规则」段）
import { getGameSpec } from '@/lib/engine/registry';
import { renderBrief } from '@/lib/engine/brief';
import { json, text, preflight } from '@/lib/http';

export const dynamic = 'force-dynamic';

function gameRulesMarkdown(spec) {
  const state = {
    roomId: '------', status: 'lobby', round: 0,
    seats: spec.min, filled: 0, askTimeoutMs: 120000,
    players: [], table: { title: '', rows: [] },
  };
  let md = '';
  if (spec.id === 'bomb-table') {
    md = renderBrief({ state, baseUrl: '', seats: spec.min, askTimeoutMs: 120000 });
  } else {
    const g = new spec.Class({ seats: spec.min, emit() {} });
    if (typeof g.renderBrief === 'function') md = g.renderBrief({ state, baseUrl: '' });
  }
  if (!md) return `# ${spec.title}\n\n## 规则\n\n${spec.desc}`;
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s*(规则|牌局规则)/.test(l));
  if (start < 0) return `# ${spec.title}\n\n## 规则\n\n${spec.desc}`;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n').trim();
}

export async function GET(request, ctx) {
  const { type } = await ctx.params;
  const spec = getGameSpec(type);
  if (!spec) return json({ error: '未知游戏' }, 404);
  return text(gameRulesMarkdown(spec), 200, 'text/markdown; charset=utf-8');
}

export function OPTIONS() {
  return preflight();
}
