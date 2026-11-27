// 管理员后台通用工具：会话校验 / 角色权限 / 审计写入 / 响应序列化。
// 约定：审计 hash 链由 db.appendAuditLog 负责（Neon 走触发器、memory 走应用层），
// 本文件只负责组织 who / when / target / before / after / reason，绝不自行计算 hash。
import {
  parseCookies,
  hashToken,
  safeEqual,
  newToken,
  hashPassword,
  verifyPassword,
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { json, clientIp } from '@/lib/http';

// 角色等级：viewer < operator < root
export const ROLE_RANK = { viewer: 1, operator: 2, root: 3 };

/* ---------------- 错误 ---------------- */

export class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

export function apiError(status, message, extra) {
  return new ApiError(status, message, extra);
}

/* ---------------- 会话 ---------------- */

// 读 Cookie → hash → 查会话 → 校验吊销/过期 → 刷新 lastSeenAt → { session, admin } | null
export async function getSessionAdmin(request) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[ADMIN_COOKIE];
  if (!token) return null;

  let session = await db.getAdminSessionByTokenHash(hashToken(token));
  if (!session) return null;
  if (session.revokedAt) return null;

  const expiresAt = Number(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  const admin = await db.getAdminById(session.adminUserId);
  if (!admin || admin.active === false) return null;

  const touched = await db.touchAdminSession(session.id);
  if (touched) session = touched;
  return { session, admin };
}

// 强制登录 + 最低角色；未登录 401（前端据此回登录态），角色不足 403
export async function requireAdmin(request, { minRole = 'viewer' } = {}) {
  const ctx = await getSessionAdmin(request);
  if (!ctx) throw new ApiError(401, '未登录');
  const need = ROLE_RANK[minRole] || 1;
  const have = ROLE_RANK[ctx.admin.role] || 0;
  if (have < need) throw new ApiError(403, '权限不足');
  return ctx;
}

/* ---------------- 审计 ---------------- */

// 写一条审计；返回 { id, hash, prevHash }。写失败向上抛，调用方决定是否容忍。
export async function writeAudit({
  admin,
  session,
  action,
  targetType = null,
  targetId = null,
  before = null,
  after = null,
  reason = null,
  request,
}) {
  return db.appendAuditLog({
    actorId: admin ? admin.id : null,
    actorUsername: admin ? admin.username : 'system',
    sessionId: session ? session.id : null,
    action,
    targetType,
    targetId,
    before,
    after,
    reason,
    ipAddress: requestIp(request),
  });
}

function requestIp(request) {
  const ip = clientIp(request);
  return !ip || ip === 'unknown' ? null : ip;
}

/* ---------------- 序列化 ---------------- */

// number(ms) | Date | string → ISO 字符串；null / 非法值 → null
export function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return null;
}

// 递归剔除 token / hash / password 类字段，保证 godview 响应不含任何凭据
const DROP_KEY_RE = /(token|hash|password)/i;

function sanitize(value, seen) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROP_KEY_RE.test(key)) continue;
      out[key] = sanitize(item, seen);
    }
    return out;
  }
  return value;
}

// godview 返回体：剔除凭据 + 所有时间字段转 ISO（字段名与前端 GodviewClient 契约一致）
export function serializeGodview(data) {
  const clean = sanitize(data || {}, new WeakSet());

  const room = clean.room
    ? { ...clean.room, createdAt: toIso(clean.room.createdAt) }
    : null;

  const players = Array.isArray(clean.players)
    ? clean.players.map((p) => ({ ...p, lastSeen: toIso(p.lastSeen) }))
    : [];

  const asks = Array.isArray(clean.asks)
    ? clean.asks.map((a) => ({ ...a, deadline: toIso(a.deadline) }))
    : [];

  const thoughts = Array.isArray(clean.thoughts)
    ? clean.thoughts.map((t) => ({ ...t, at: toIso(t.at) }))
    : [];

  const events = Array.isArray(clean.events)
    ? clean.events.map((ev) => ({ ...ev, at: toIso(ev.at) }))
    : [];

  const meta = clean.meta
    ? { ...clean.meta, capturedAt: toIso(clean.meta.capturedAt) }
    : {};

  return { ...clean, room, players, asks, thoughts, events, meta };
}

/* ---------------- 统一错误响应 ---------------- */

// 所有 admin 路由的 catch 都走这里：ApiError → 对应状态码；RoomError（带 status）→ 原样；
// 其它 → 500 并打印堆栈。401 固定输出 { error: '未登录' }（由 ApiError 提供）。
export function errorResponse(error) {
  if (error instanceof ApiError) {
    const body = { error: error.message };
    if (error.games) body.games = error.games;
    return json(body, error.status);
  }
  const status = error && Number.isFinite(Number(error.status)) ? Number(error.status) : 0;
  if (status >= 400 && status <= 599) {
    const body = { error: (error && error.message) || '请求失败' };
    if (error && error.games) body.games = error.games;
    return json(body, status);
  }
  console.error('[admin api] 未处理异常：', error);
  return json({ error: '服务器内部错误' }, 500);
}
