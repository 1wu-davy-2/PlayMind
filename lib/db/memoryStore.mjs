// 内存数据访问层：无 DATABASE_URL 时使用（本地开发 / 测试）。
// 字段与语义对齐 db/schema.sql；token 只存 hash（由调用方传入），不落明文。
// 审计日志 append-only，自行计算 sha256 哈希链，不提供 update / delete 方法。
import crypto from 'node:crypto';

const GENESIS_HASH = '0'.repeat(64);

/* ---------- 通用小工具 ---------- */

function nowMs() {
  return Date.now();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'NOT_FOUND';
  return err;
}

function conflict(message) {
  const err = new Error(message);
  err.code = 'CONFLICT';
  throw err;
}

function normCode(code) {
  return String(code == null ? '' : code).toUpperCase();
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// 尽量贴近 Postgres TIMESTAMPTZ::text（形如 2026-11-26 14:05:20.123000+00），
// 让内存模式与数据库触发器计算出的哈希链在格式上保持一致。
function pgTimestampText(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000+00`;
}

function auditPayload(rec) {
  return [
    pgTimestampText(rec.createdAt),
    rec.actorUsername,
    rec.action || '',
    rec.targetType || '',
    rec.targetId == null ? '' : String(rec.targetId),
    rec.before == null ? '' : JSON.stringify(rec.before),
    rec.after == null ? '' : JSON.stringify(rec.after),
    rec.reason || '',
    rec.ipAddress || '',
    rec.sessionId == null ? '' : String(rec.sessionId),
  ].join('|');
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function phaseOf(state) {
  return state && typeof state === 'object' && state.phase != null ? state.phase : null;
}

/* ---------- 工厂 ---------- */

export function createMemoryStore() {
  /** @type {Map<string, object>} code -> room */
  const rooms = new Map();
  /** @type {Map<string, Map<string, object>>} code -> playerKey -> player */
  const players = new Map();
  /** @type {Map<string, object[]>} */
  const events = new Map();
  /** @type {Map<string, object[]>} */
  const actions = new Map();
  /** @type {Map<string, object[]>} */
  const thoughts = new Map();

  /** @type {Map<string, object>} id -> admin */
  const admins = new Map();
  /** @type {Map<string, string>} username -> id */
  const adminByUsername = new Map();
  /** @type {Map<string, object>} id -> session */
  const sessions = new Map();
  /** @type {Map<string, string>} tokenHash -> session id */
  const sessionByToken = new Map();

  /** @type {object[]} */
  const auditLogs = [];
  let auditSeq = 0;
  /** @type {object[]} */
  const snapshots = [];
  /** @type {Map<string, object>} */
  const worldSettings = new Map();

  let actionSeq = 0;

  function roomOrThrow(code) {
    const key = normCode(code);
    const room = rooms.get(key);
    if (!room) throw notFound(`房间不存在：${key}`);
    return room;
  }

  function playersOf(code) {
    const key = normCode(code);
    let map = players.get(key);
    if (!map) {
      map = new Map();
      players.set(key, map);
    }
    return map;
  }

  function playerOrThrow(code, playerKey) {
    const player = playersOf(code).get(String(playerKey));
    if (!player) throw notFound(`玩家不存在：${playerKey}`);
    return player;
  }

  function roomView(room, { withToken = true } = {}) {
    const view = clone(room);
    view.filled = playersOf(room.code).size;
    if (!withToken) delete view.hostTokenHash;
    return view;
  }

  /* ---------- rooms ---------- */

  function createRoom(rec = {}) {
    const code = normCode(rec.code);
    if (!code) throw new Error('createRoom 需要 code');
    if (rooms.has(code)) conflict(`房间号已存在：${code}`);
    const ts = nowMs();
    const room = {
      id: rec.id || crypto.randomUUID(),
      code,
      gameType: rec.gameType,
      gameTitle: rec.gameTitle ?? null,
      status: rec.status || 'lobby',
      mode: rec.mode || 'mixed',
      seats: asNumber(rec.seats, 2),
      askTimeoutMs: asNumber(rec.askTimeoutMs, 120000),
      autoStart: !!rec.autoStart,
      hostName: rec.hostName ?? null,
      hostTokenHash: rec.hostTokenHash,
      winner: rec.winner == null ? null : clone(rec.winner),
      state: rec.state && typeof rec.state === 'object' ? clone(rec.state) : {},
      createdAt: rec.createdAt != null ? asNumber(rec.createdAt, ts) : ts,
      startedAt: rec.startedAt != null ? asNumber(rec.startedAt, ts) : null,
      endedAt: rec.endedAt != null ? asNumber(rec.endedAt, ts) : null,
      updatedAt: ts,
    };
    rooms.set(code, room);
    players.set(code, new Map());
    events.set(code, []);
    actions.set(code, []);
    thoughts.set(code, []);
    return roomView(room);
  }

  function getRoom(code) {
    const room = rooms.get(normCode(code));
    return room ? roomView(room) : null;
  }

  const ROOM_PATCH_FIELDS = new Set([
    'gameTitle', 'status', 'mode', 'seats', 'askTimeoutMs', 'autoStart', 'hostName',
    'winner', 'state', 'startedAt', 'endedAt',
  ]);

  function updateRoom(code, patch = {}) {
    const room = rooms.get(normCode(code));
    if (!room) return null;
    for (const key of Object.keys(patch)) {
      if (!ROOM_PATCH_FIELDS.has(key) || patch[key] === undefined) continue;
      room[key] = clone(patch[key]);
    }
    room.updatedAt = nowMs();
    return roomView(room);
  }

  function listRooms() {
    return [...rooms.values()]
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => {
        const view = roomView(room, { withToken: false });
        const s = room.state && typeof room.state === 'object' ? room.state : {};
        // 与 neonStore 对齐：列表只带 state 的必要片段，不回传整份热快照
        view.state = {
          phase: s.phase ?? null,
          pending: clone(s.pending ?? null),
          askPlayerIds: clone(s.askPlayerIds ?? null),
          gameTitle: s.gameTitle ?? null,
          filled: s.filled ?? null,
        };
        view.phase = phaseOf(room.state);
        return view;
      });
  }

  /* ---------- 批量读写（与 neonStore 的批量方法同名同语义） ---------- */

  function loadRoomFacts(code) {
    const key = normCode(code);
    const room = rooms.get(key);
    if (!room) return { room: null, players: [], actions: [], maxSeq: 0 };
    return {
      room: roomView(room),
      players: listPlayers(key),
      actions: listActions(key),
      maxSeq: maxEventSeq(key),
    };
  }

  function commitRoom(code, plan = {}) {
    const key = normCode(code);
    const room = rooms.get(key);
    if (!room) throw notFound(`房间不存在：${key}`);
    const actionList = Array.isArray(plan.actions) ? plan.actions : [];
    const eventList = Array.isArray(plan.events) ? plan.events : [];
    const patch = plan.patch && typeof plan.patch === 'object' ? plan.patch : {};
    for (const rec of actionList) {
      if (!rec || rec.playerKey == null) continue;
      appendAction(key, rec);
    }
    if (eventList.length) appendEvents(key, eventList);
    const hasPatch = Object.keys(patch)
      .some((k) => patch[k] !== undefined && ROOM_PATCH_FIELDS.has(k));
    return { room: hasPatch ? updateRoom(key, patch) : roomView(room) };
  }

  function getRoomEvents(code, opts = {}) {
    const key = normCode(code);
    const room = rooms.get(key);
    if (!room) return { room: null, events: [], maxSeq: 0 };
    const {
      since = 0, viewerTokenHash = null, limit = 500, includeAll = false,
    } = opts || {};
    let viewerPlayerId = null;
    if (viewerTokenHash != null) {
      const hash = String(viewerTokenHash);
      for (const p of playersOf(key).values()) {
        if (p.tokenHash === hash) {
          viewerPlayerId = p.playerKey;
          break;
        }
      }
    }
    return {
      room: roomView(room),
      events: listEvents(key, { since, viewerPlayerId, limit, includeAll }),
      maxSeq: maxEventSeq(key),
    };
  }

  function countAgentsPresent() {
    let n = 0;
    for (const code of rooms.keys()) {
      for (const p of playersOf(code).values()) if (p.kind === 'agent') n += 1;
    }
    return n;
  }

  function adminStats() {
    let activeRooms = 0;
    for (const room of rooms.values()) if (room.status === 'playing') activeRooms += 1;
    return {
      activeRooms,
      agentsPresent: countAgentsPresent(),
      revealsToday: countRawRevealsToday(),
    };
  }

  /* ---------- players ---------- */

  function addPlayer(roomCode, rec = {}) {
    const room = roomOrThrow(roomCode);
    const map = playersOf(room.code);
    const playerKey = String(rec.playerKey);
    if (!playerKey) throw new Error('addPlayer 需要 playerKey');
    if (map.has(playerKey)) conflict(`玩家已存在：${playerKey}`);
    for (const existing of map.values()) {
      if (Number(existing.seat) === Number(rec.seat)) conflict(`座位已被占用：${rec.seat}`);
    }
    const ts = nowMs();
    const player = {
      id: rec.id || crypto.randomUUID(),
      playerKey,
      seat: asNumber(rec.seat, 0),
      tokenHash: rec.tokenHash ?? '',
      kind: rec.kind || 'agent',
      name: rec.name ?? '',
      style: rec.style ?? '',
      title: rec.title ?? null,
      glyph: rec.glyph ?? null,
      hue: rec.hue == null ? null : asNumber(rec.hue, 0),
      model: rec.model ?? null,
      brand: rec.brand || 'unknown',
      avatarUrl: rec.avatarUrl ?? null,
      alive: rec.alive !== false,
      hp: asNumber(rec.hp, 1),
      maxHp: asNumber(rec.maxHp, 1),
      items: clone(rec.items ?? []),
      hand: clone(rec.hand ?? []),
      dice: clone(rec.dice ?? []),
      chips: asNumber(rec.chips, 0),
      caught: asNumber(rec.caught, 0),
      folded: !!rec.folded,
      say: rec.say ?? '',
      thought: rec.thought ?? '',
      role: rec.role ?? null,
      team: rec.team ?? null,
      teamPublic: !!rec.teamPublic,
      rolePublic: !!rec.rolePublic,
      secret: rec.secret && typeof rec.secret === 'object' ? clone(rec.secret) : {},
      meta: rec.meta && typeof rec.meta === 'object' ? clone(rec.meta) : {},
      lastSeen: rec.lastSeen != null ? asNumber(rec.lastSeen, ts) : null,
      joinedAt: rec.joinedAt != null ? asNumber(rec.joinedAt, ts) : ts,
      leftAt: null,
      updatedAt: ts,
    };
    map.set(playerKey, player);
    return clone(player);
  }

  function getPlayer(roomCode, playerKey) {
    const player = playersOf(roomCode).get(String(playerKey));
    return player ? clone(player) : null;
  }

  function getPlayerByTokenHash(roomCode, tokenHash) {
    if (tokenHash == null) return null;
    for (const player of playersOf(roomCode).values()) {
      if (player.tokenHash === tokenHash) return clone(player);
    }
    return null;
  }

  const PLAYER_PATCH_FIELDS = new Set([
    'seat', 'tokenHash', 'kind', 'name', 'style', 'title', 'glyph', 'hue', 'model',
    'brand', 'avatarUrl', 'alive', 'hp', 'maxHp', 'items', 'hand', 'dice', 'chips',
    'caught', 'folded', 'say', 'thought', 'role', 'team', 'teamPublic', 'rolePublic',
    'secret', 'meta', 'lastSeen',
  ]);

  function updatePlayer(roomCode, playerKey, patch = {}) {
    const map = playersOf(roomCode);
    const player = map.get(String(playerKey));
    if (!player) return null;
    for (const key of Object.keys(patch)) {
      if (!PLAYER_PATCH_FIELDS.has(key) || patch[key] === undefined) continue;
      player[key] = clone(patch[key]);
    }
    player.updatedAt = nowMs();
    return clone(player);
  }

  function listPlayers(roomCode) {
    return [...playersOf(roomCode).values()]
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => clone(p));
  }

  /* ---------- events（append-only 事实流） ---------- */

  function eventsOf(roomCode) {
    const key = normCode(roomCode);
    let list = events.get(key);
    if (!list) {
      list = [];
      events.set(key, list);
    }
    return list;
  }

  function appendEvents(roomCode, batch) {
    const room = roomOrThrow(roomCode);
    const list = eventsOf(room.code);
    const seen = new Set(list.map((e) => e.seq));
    const appended = [];
    for (const ev of Array.isArray(batch) ? batch : []) {
      if (!ev || ev.seq == null) continue;
      const seq = Number(ev.seq);
      if (!Number.isFinite(seq) || seen.has(seq)) continue;
      seen.add(seq);
      const rec = {
        seq,
        type: ev.type,
        payload: ev.payload && typeof ev.payload === 'object' ? clone(ev.payload) : {},
        text: ev.text ?? null,
        fx: ev.fx == null ? null : clone(ev.fx),
        visibility: ev.visibility || 'public',
        secretForPlayerId: ev.secretForPlayerId ?? null,
        createdAt: ev.createdAt != null ? asNumber(ev.createdAt, nowMs()) : nowMs(),
      };
      list.push(rec);
      appended.push(rec);
    }
    return appended.length;
  }

  function listEvents(roomCode, opts = {}) {
    const {
      since = 0, viewerPlayerId = null, limit = 500, includeAll = false,
    } = opts || {};
    const sinceN = asNumber(since, 0);
    const limitN = asNumber(limit, 500);
    const maxRows = limitN > 0 ? limitN : 500;
    const viewer = viewerPlayerId == null ? null : String(viewerPlayerId);
    const out = [];
    for (const ev of eventsOf(roomCode)) {
      if (ev.seq <= sinceN) continue;
      // 管理员 raw 查看：不做 visibility 过滤，直接全量返回
      if (!includeAll) {
        const visible = ev.visibility === 'public'
          || ((ev.visibility === 'secret_for' || ev.visibility === 'private')
            && viewer != null && String(ev.secretForPlayerId) === viewer);
        if (!visible) continue;
      }
      out.push(clone(ev));
    }
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(0, maxRows);
  }

  function maxEventSeq(roomCode) {
    let max = 0;
    for (const ev of eventsOf(roomCode)) if (ev.seq > max) max = ev.seq;
    return max;
  }

  /* ---------- actions（重放事实源） ---------- */

  function appendAction(roomCode, rec = {}) {
    const room = roomOrThrow(roomCode);
    const playerKey = String(rec.playerKey);
    playerOrThrow(room.code, playerKey);
    const record = {
      id: ++actionSeq,
      playerKey,
      action: rec.action && typeof rec.action === 'object' ? clone(rec.action) : {},
      thought: rec.thought ?? null,
      say: rec.say ?? null,
      source: rec.source || 'agent',
      accepted: rec.accepted !== false,
      createdAt: nowMs(),
    };
    actions.get(room.code).push(record);
    return clone(record);
  }

  function listActions(roomCode) {
    const list = actions.get(normCode(roomCode)) || [];
    return list.map((a) => clone(a));
  }

  /* ---------- thoughts ---------- */

  function appendThought(roomCode, playerKey, delta) {
    const room = roomOrThrow(roomCode);
    const key = String(playerKey);
    playerOrThrow(room.code, key);
    const list = thoughts.get(room.code);
    let seq = 0;
    for (const t of list) if (t.playerKey === key && t.seq > seq) seq = t.seq;
    seq += 1;
    list.push({ playerKey: key, seq, delta: String(delta ?? ''), createdAt: nowMs() });
    return { seq };
  }

  function listThoughts(roomCode) {
    const list = thoughts.get(normCode(roomCode)) || [];
    return list.map((t) => ({
      playerKey: t.playerKey,
      seq: t.seq,
      delta: t.delta,
      createdAt: t.createdAt,
    }));
  }

  function getRoomArchive(roomCode, { includeAll = false, limit = 1000 } = {}) {
    return {
      thoughts: listThoughts(roomCode),
      events: listEvents(roomCode, { includeAll, limit }),
    };
  }

  /* ---------- admin users / sessions ---------- */

  function adminView(admin) {
    return clone(admin);
  }

  function findAdminByUsername(username) {
    const id = adminByUsername.get(String(username));
    const admin = id ? admins.get(id) : null;
    return admin ? adminView(admin) : null;
  }

  function getAdminById(id) {
    const admin = admins.get(String(id));
    return admin ? adminView(admin) : null;
  }

  function createAdmin({ username, passwordHash, role } = {}) {
    const name = String(username);
    if (adminByUsername.has(name)) conflict(`管理员已存在：${name}`);
    const ts = nowMs();
    const admin = {
      id: crypto.randomUUID(),
      username: name,
      passwordHash: String(passwordHash ?? ''),
      totpSecretEncrypted: null,
      role: role || 'viewer',
      ipAllowlist: [],
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      active: true,
      createdAt: ts,
      updatedAt: ts,
    };
    admins.set(admin.id, admin);
    adminByUsername.set(name, admin.id);
    return adminView(admin);
  }

  const ADMIN_PATCH_FIELDS = new Set(['failedAttempts', 'lockedUntil', 'lastLoginAt', 'active']);

  function updateAdmin(id, patch = {}) {
    const admin = admins.get(String(id));
    if (!admin) return null;
    for (const key of Object.keys(patch)) {
      if (!ADMIN_PATCH_FIELDS.has(key) || patch[key] === undefined) continue;
      admin[key] = clone(patch[key]);
    }
    admin.updatedAt = nowMs();
    return adminView(admin);
  }

  function sessionView(session) {
    return clone(session);
  }

  function createAdminSession({ adminUserId, tokenHash, ipAddress, userAgent, expiresAt } = {}) {
    const hash = String(tokenHash ?? '');
    if (sessionByToken.has(hash)) conflict('会话 token 已存在');
    const ts = nowMs();
    const session = {
      id: crypto.randomUUID(),
      adminUserId,
      tokenHash: hash,
      csrfTokenHash: null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      createdAt: ts,
      expiresAt: asNumber(expiresAt, ts),
      lastSeenAt: ts,
      revokedAt: null,
    };
    sessions.set(session.id, session);
    sessionByToken.set(hash, session.id);
    return sessionView(session);
  }

  function getAdminSessionByTokenHash(tokenHash) {
    const id = sessionByToken.get(String(tokenHash ?? ''));
    const session = id ? sessions.get(id) : null;
    return session ? sessionView(session) : null;
  }

  function touchAdminSession(id) {
    const session = sessions.get(String(id));
    if (!session) return null;
    session.lastSeenAt = nowMs();
    return sessionView(session);
  }

  function getSessionContext(tokenHash) {
    const session = getAdminSessionByTokenHash(tokenHash);
    if (!session) return null;
    const admin = getAdminById(session.adminUserId);
    if (!admin) return null;
    const touched = touchAdminSession(session.id) || session;
    return { session: touched, admin };
  }

  function revokeAdminSession(id) {
    const session = sessions.get(String(id));
    if (!session) return null;
    if (!session.revokedAt) session.revokedAt = nowMs();
    return sessionView(session);
  }

  /* ---------- audit（append-only + sha256 哈希链） ---------- */

  function appendAuditLog(fields = {}) {
    const prevHash = auditLogs.length ? auditLogs[auditLogs.length - 1].hash : GENESIS_HASH;
    const record = {
      id: ++auditSeq,
      createdAt: nowMs(),
      actorId: fields.actorId ?? null,
      actorUsername: String(fields.actorUsername ?? 'system'),
      sessionId: fields.sessionId ?? null,
      action: String(fields.action ?? ''),
      targetType: fields.targetType ?? null,
      targetId: fields.targetId == null ? null : String(fields.targetId),
      before: fields.before === undefined || fields.before === null ? null : clone(fields.before),
      after: fields.after === undefined || fields.after === null ? null : clone(fields.after),
      reason: fields.reason ?? null,
      ipAddress: fields.ipAddress ?? null,
      prevHash,
    };
    record.hash = sha256Hex(`${prevHash}|${auditPayload(record)}`);
    auditLogs.push(record);
    return { id: record.id, hash: record.hash, prevHash: record.prevHash };
  }

  function listAuditLogs({ limit = 100, actorId = null, targetId = null } = {}) {
    const limitN = asNumber(limit, 100);
    const maxRows = limitN > 0 ? limitN : 100;
    return auditLogs
      .filter((log) => (actorId == null ? true : String(log.actorId) === String(actorId)))
      .filter((log) => (targetId == null ? true : String(log.targetId) === String(targetId)))
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, maxRows)
      .map((log) => clone(log));
  }

  function countRawRevealsToday() {
    const start = startOfToday();
    let count = 0;
    for (const snap of snapshots) {
      if (snap.visibilityLevel === 'raw' && snap.createdAt >= start) count += 1;
    }
    return count;
  }

  /* ---------- godview snapshots ---------- */

  function saveGodviewSnapshot(rec = {}) {
    const snapshot = {
      id: crypto.randomUUID(),
      roomCode: normCode(rec.roomCode),
      capturedBy: rec.capturedBy ?? null,
      visibilityLevel: rec.visibilityLevel || 'masked',
      publicState: rec.publicState && typeof rec.publicState === 'object' ? clone(rec.publicState) : {},
      playersPrivate: clone(rec.playersPrivate ?? []),
      pendingAsks: clone(rec.pendingAsks ?? []),
      thoughts: clone(rec.thoughts ?? []),
      events: clone(rec.events ?? []),
      createdAt: nowMs(),
    };
    snapshots.push(snapshot);
    return clone(snapshot);
  }

  function recordGodviewRead({ snapshot = {}, audit = {} } = {}) {
    const snap = saveGodviewSnapshot(snapshot);
    const aud = appendAuditLog(audit);
    return { snapshotId: snap.id, audit: aud };
  }

  /* ---------- world settings ---------- */

  function getWorldSettings() {
    return [...worldSettings.values()]
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)))
      .map((row) => ({
        key: row.key,
        value: clone(row.value),
        description: row.description,
      }));
  }

  function setWorldSetting(key, value, { updatedBy = null, description } = {}) {
    const name = String(key);
    const existing = worldSettings.get(name);
    const ts = nowMs();
    const row = {
      key: name,
      value: value === undefined ? null : clone(value),
      description: description != null
        ? String(description)
        : (existing ? existing.description : ''),
      updatedBy: updatedBy ?? null,
      createdAt: existing ? existing.createdAt : ts,
      updatedAt: ts,
    };
    worldSettings.set(name, row);
    return {
      key: row.key,
      value: clone(row.value),
      description: row.description,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  return {
    // rooms
    createRoom,
    getRoom,
    updateRoom,
    listRooms,
    loadRoomFacts,
    commitRoom,
    // players
    addPlayer,
    getPlayer,
    getPlayerByTokenHash,
    updatePlayer,
    listPlayers,
    // events
    appendEvents,
    listEvents,
    getRoomEvents,
    maxEventSeq,
    // actions
    appendAction,
    listActions,
    // thoughts
    appendThought,
    listThoughts,
    getRoomArchive,
    // admin
    findAdminByUsername,
    getAdminById,
    createAdmin,
    updateAdmin,
    createAdminSession,
    getAdminSessionByTokenHash,
    touchAdminSession,
    getSessionContext,
    revokeAdminSession,
    appendAuditLog,
    listAuditLogs,
    countRawRevealsToday,
    countAgentsPresent,
    adminStats,
    saveGodviewSnapshot,
    recordGodviewRead,
    getWorldSettings,
    setWorldSetting,
  };
}
