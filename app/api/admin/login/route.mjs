// POST /api/admin/login — 后门管理员登录。
// 独立账号表 + 独立会话，与玩家 token 完全隔离；密码只存 bcrypt hash。
// 首次无任何管理员时，按 ADMIN_USERNAME / ADMIN_PASSWORD 引导创建 root。
import { json, readJson, preflight, clientIp } from '@/lib/http';
import {
  ADMIN_SESSION_TTL_MS,
  hashPassword,
  hashToken,
  newToken,
  sessionCookie,
  verifyPassword,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { errorResponse, writeAudit, toIso } from '@/lib/admin';

export const dynamic = 'force-dynamic';

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export async function OPTIONS() {
  return preflight();
}

// 系统内是否一个管理员都没有：优先 listAdmins，不存在时用 env 用户名兜底探测
async function systemHasNoAdmin() {
  if (typeof db.listAdmins === 'function') {
    const list = await db.listAdmins();
    return !Array.isArray(list) || list.length === 0;
  }
  const probeName = String(process.env.ADMIN_USERNAME || '').trim() || 'admin';
  const probe = await db.findAdminByUsername(probeName);
  return !probe;
}

export async function POST(request) {
  try {
    const body = await readJson(request);
    const username = String(body.username == null ? '' : body.username).trim();
    const password = String(body.password == null ? '' : body.password);
    if (!username || !password) {
      return json({ error: '请输入用户名与密码' }, 400);
    }

    const envUsername = String(process.env.ADMIN_USERNAME || '').trim();
    const envPassword = String(process.env.ADMIN_PASSWORD || '');

    let admin = await db.findAdminByUsername(username);
    let noAdmin = false;

    if (!admin) {
      noAdmin = await systemHasNoAdmin();
      if (noAdmin && envUsername && envPassword) {
        try {
          await db.createAdmin({
            username: envUsername,
            passwordHash: await hashPassword(envPassword),
            role: 'root',
          });
        } catch (err) {
          // 并发 bootstrap 撞唯一键：忽略，继续按用户名重新查找
          if (!(err && err.code === 'CONFLICT')) throw err;
        }
        admin = await db.findAdminByUsername(username);
      }
    }

    if (!admin) {
      if (noAdmin && (!envUsername || !envPassword)) {
        return json({ error: '未初始化管理员，请配置 ADMIN_USERNAME / ADMIN_PASSWORD' }, 401);
      }
      return json({ error: '用户名或密码错误' }, 401);
    }

    if (admin.active === false) {
      return json({ error: '账号已停用' }, 403);
    }

    // 锁定窗口未过：直接拒绝（不累加计数，避免永锁）
    const lockedUntil = Number(admin.lockedUntil);
    if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
      return json({ error: '账号已锁定，请稍后再试' }, 403);
    }

    const passed = await verifyPassword(password, admin.passwordHash);
    if (!passed) {
      const attempts = Number(admin.failedAttempts || 0) + 1;
      const lockAt = attempts >= MAX_FAILED ? Date.now() + LOCK_MS : null;
      try {
        await db.updateAdmin(admin.id, { failedAttempts: attempts, lockedUntil: lockAt });
      } catch (err) {
        console.error('[admin login] 失败计数写入失败：', err);
      }
      // login.fail 审计容忍失败，避免掩盖登录错误本身
      try {
        await writeAudit({
          admin,
          session: null,
          action: 'admin.login.fail',
          targetType: 'admin',
          targetId: admin.id,
          after: { attempts, lockedUntil: toIso(lockAt) },
          reason: '密码错误',
          request,
        });
        if (lockAt) {
          await writeAudit({
            admin,
            session: null,
            action: 'admin.login.lock',
            targetType: 'admin',
            targetId: admin.id,
            after: { attempts, lockedUntil: toIso(lockAt) },
            reason: `连续 ${MAX_FAILED} 次密码错误，锁定 15 分钟`,
            request,
          });
        }
      } catch (err) {
        console.error('[admin login] 失败审计写入失败：', err);
      }
      return json({ error: '用户名或密码错误' }, 401);
    }

    // 登录成功：清零计数、更新最后登录时间、签发会话
    await db.updateAdmin(admin.id, {
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: Date.now(),
    });

    const token = newToken(32);
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
    const ip = clientIp(request);
    const session = await db.createAdminSession({
      adminUserId: admin.id,
      tokenHash: hashToken(token),
      ipAddress: ip && ip !== 'unknown' ? ip : null,
      userAgent: request.headers.get('user-agent') || '',
      expiresAt,
    });

    // 成功审计写入失败不吞（整次登录以 500 结束，便于发现审计链路故障）
    await writeAudit({
      admin,
      session,
      action: 'admin.login.success',
      targetType: 'admin',
      targetId: admin.id,
      after: { role: admin.role },
      reason: '登录成功',
      request,
    });

    const res = json({
      ok: true,
      adminId: admin.id,
      username: admin.username,
      role: admin.role,
      expiresAt: toIso(expiresAt),
    });
    res.headers.append('Set-Cookie', sessionCookie(token, Math.floor(ADMIN_SESSION_TTL_MS / 1000)));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
