// 鉴权工具：高熵 token、HMAC token hash、bcrypt 密码、Cookie 序列化 / 解析。
// token 明文只在签发响应里出现一次；数据库只存 hashToken() 的结果。
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const ADMIN_COOKIE = 'pm_admin';
export const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;

const BCRYPT_ROUNDS = 10;

function tokenSecret() {
  return process.env.TOKEN_SECRET || 'dev-only-insecure-secret';
}

/** 生成高熵 token（hex 编码，默认 32 字节 = 64 hex）。 */
export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** bearer token → 确定性 HMAC-SHA256（hex），用于入库索引查找。 */
export function hashToken(token) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(token)).digest('hex');
}

/** 常量时间比较；长度不同直接返回 false（timingSafeEqual 要求等长）。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** bcrypt hash，10 rounds。 */
export function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

/** bcrypt 校验；任何异常（空值 / 非法 hash）都视为失败。 */
export async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try {
    return await bcrypt.compare(String(password), String(hash));
  } catch {
    return false;
  }
}

/** Cookie 头 → { name: value } 对象。 */
export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const rawValue = part.slice(idx + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    out[name] = value;
  }
  return out;
}

function secureFlag() {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

/** 管理员会话 Set-Cookie 字符串。 */
export function sessionCookie(token, maxAgeSec = 1800) {
  const maxAge = Number.isFinite(Number(maxAgeSec)) ? Math.max(0, Math.floor(Number(maxAgeSec))) : 1800;
  return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureFlag()}`;
}

/** 清除会话的 Set-Cookie 字符串。 */
export function clearSessionCookie() {
  return `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag()}`;
}
