// Neon PostgreSQL 数据访问层（@neondatabase/serverless）。
// 注意：本模块不在顶层建立连接；只有 createNeonStore(url) 被调用时才会创建 sql 客户端。
// 表字段 snake_case ↔ JS camelCase；JSONB 直接返回对象/数组；时间戳统一返回 epoch 毫秒。
import { neon } from '@neondatabase/serverless';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return new Date(value);
}

function json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normCode(code) {
  return String(code == null ? '' : code).toUpperCase();
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'NOT_FOUND';
  return err;
}

function asConflict(err, message) {
  if (err && err.code === '23505') {
    const conflict = new Error(message || '唯一约束冲突');
    conflict.code = 'CONFLICT';
    conflict.cause = err;
    throw conflict;
  }
  throw err;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ---------- 行映射 ---------- */

function mapRoom(row, { withToken = true } = {}) {
  if (!row) return null;
  const room = {
    id: row.id,
    code: row.code,
    gameType: row.game_type,
    gameTitle: row.game_title ?? null,
    status: row.status,
    mode: row.mode,
    seats: num(row.seats),
    askTimeoutMs: num(row.ask_timeout_ms),
    autoStart: !!row.auto_start,
    hostName: row.host_name ?? null,
    winner: row.winner ?? null,
    state: row.state && typeof row.state === 'object' ? row.state : {},
    createdAt: toMs(row.created_at),
    startedAt: toMs(row.started_at),
    endedAt: toMs(row.ended_at),
    updatedAt: toMs(row.updated_at),
  };
  if (withToken) room.hostTokenHash = row.host_token_hash;
  if (row.filled != null) room.filled = num(row.filled);
  return room;
}

function mapPlayer(row) {
  if (!row) return null;
  const rawMeta = row.meta && typeof row.meta === 'object' ? { ...row.meta } : {};
  const style = rawMeta.style ?? '';
  delete rawMeta.style;
  return {
    id: row.id,
    playerKey: row.player_key,
    seat: num(row.seat),
    tokenHash: row.token_hash,
    kind: row.kind,
    name: row.name,
    style,
    title: row.title ?? null,
    glyph: row.glyph ?? null,
    hue: num(row.hue),
    model: row.model ?? null,
    brand: row.brand,
    avatarUrl: row.avatar_url ?? null,
    alive: !!row.alive,
    hp: num(row.hp),
    maxHp: num(row.max_hp),
    items: row.items ?? [],
    hand: row.hand ?? [],
    dice: row.dice ?? [],
    chips: num(row.chips),
    caught: num(row.caught),
    folded: !!row.folded,
    say: row.say ?? '',
    thought: row.thought ?? '',
    role: row.role ?? null,
    team: row.team ?? null,
    teamPublic: !!row.team_public,
    rolePublic: !!row.role_public,
    secret: row.secret && typeof row.secret === 'object' ? row.secret : {},
    meta: rawMeta,
    lastSeen: toMs(row.last_seen),
    joinedAt: toMs(row.joined_at),
    leftAt: toMs(row.left_at),
    updatedAt: toMs(row.updated_at),
  };
}

function mapEvent(row) {
  return {
    seq: num(row.seq),
    type: row.type,
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    text: row.text ?? null,
    fx: row.fx ?? null,
    visibility: row.visibility,
    secretForPlayerId: row.secret_for_key ?? null,
    createdAt: toMs(row.created_at),
  };
}

function mapAction(row, playerKey) {
  return {
    id: row.id,
    playerKey: row.player_key ?? playerKey ?? null,
    action: row.action && typeof row.action === 'object' ? row.action : {},
    thought: row.thought ?? null,
    say: row.say ?? null,
    source: row.source,
    accepted: !!row.accepted,
    createdAt: toMs(row.created_at),
  };
}

function mapAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    totpSecretEncrypted: row.totp_secret_encrypted ?? null,
    role: row.role,
    ipAllowlist: row.ip_allowlist ?? [],
    failedAttempts: num(row.failed_attempts),
    lockedUntil: toMs(row.locked_until),
    lastLoginAt: toMs(row.last_login_at),
    active: !!row.active,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash ?? null,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: toMs(row.created_at),
    expiresAt: toMs(row.expires_at),
    lastSeenAt: toMs(row.last_seen_at),
    revokedAt: toMs(row.revoked_at),
  };
}

function mapAudit(row) {
  return {
    id: num(row.id),
    createdAt: toMs(row.created_at),
    actorId: row.actor_id ?? null,
    actorUsername: row.actor_username,
    sessionId: row.session_id ?? null,
    action: row.action,
    targetType: row.target_type ?? null,
    targetId: row.target_id ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason ?? null,
    ipAddress: row.ip_address ?? null,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

const ROOM_PATCH = {
  gameTitle: 'game_title',
  status: 'status',
  mode: 'mode',
  seats: 'seats',
  askTimeoutMs: 'ask_timeout_ms',
  autoStart: 'auto_start',
  hostName: 'host_name',
  winner: 'winner',
  state: 'state',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

const PLAYER_PATCH = {
  seat: 'seat',
  tokenHash: 'token_hash',
  kind: 'kind',
  name: 'name',
  title: 'title',
  glyph: 'glyph',
  hue: 'hue',
  model: 'model',
  brand: 'brand',
  avatarUrl: 'avatar_url',
  alive: 'alive',
  hp: 'hp',
  maxHp: 'max_hp',
  items: 'items',
  hand: 'hand',
  dice: 'dice',
  chips: 'chips',
  caught: 'caught',
  folded: 'folded',
  say: 'say',
  thought: 'thought',
  role: 'role',
  team: 'team',
  teamPublic: 'team_public',
  rolePublic: 'role_public',
  secret: 'secret',
  meta: 'meta',
  lastSeen: 'last_seen',
};

const ADMIN_PATCH = {
  failedAttempts: 'failed_attempts',
  lockedUntil: 'locked_until',
  lastLoginAt: 'last_login_at',
  active: 'active',
};

const JSON_COLUMNS = new Set(['winner', 'state', 'items', 'hand', 'dice', 'secret', 'meta']);

/* ---------- 工厂 ---------- */

export function createNeonStore(databaseUrl) {
  if (!databaseUrl) throw new Error('createNeonStore 需要 DATABASE_URL');
  let client = null;
  const sql = () => (client ||= neon(databaseUrl));

  async function roomRow(code) {
    const rows = await sql().query('SELECT * FROM rooms WHERE code = $1 LIMIT 1', [normCode(code)]);
    return rows[0] || null;
  }

  async function playerRow(roomId, playerKey) {
    const rows = await sql().query(
      'SELECT * FROM room_players WHERE room_id = $1 AND player_key = $2 LIMIT 1',
      [roomId, String(playerKey)],
    );
    return rows[0] || null;
  }

  async function playerIdsByKey(roomId) {
    const rows = await sql().query(
      'SELECT id, player_key FROM room_players WHERE room_id = $1',
      [roomId],
    );
    const map = new Map();
    for (const row of rows) map.set(row.player_key, row.id);
    return map;
  }

  /* ---------- rooms ---------- */

  async function createRoom(rec = {}) {
    const code = normCode(rec.code);
    if (!code) throw new Error('createRoom 需要 code');
    const params = [
      code,
      rec.gameType,
      rec.gameTitle ?? null,
      rec.status || 'lobby',
      rec.mode || 'mixed',
      num(rec.seats),
      num(rec.askTimeoutMs),
      !!rec.autoStart,
      rec.hostName ?? null,
      rec.hostTokenHash ?? '',
      rec.winner == null ? null : json(rec.winner),
      json(rec.state && typeof rec.state === 'object' ? rec.state : {}),
    ];
    try {
      const rows = await sql().query(
        `INSERT INTO rooms
            (code, game_type, game_title, status, mode, seats, ask_timeout_ms,
             auto_start, host_name, host_token_hash, winner, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
         RETURNING *`,
        params,
      );
      const room = mapRoom(rows[0]);
      room.filled = 0;
      return room;
    } catch (err) {
      return asConflict(err, `房间号已存在：${code}`);
    }
  }

  async function getRoom(code) {
    const rows = await sql().query(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM room_players rp WHERE rp.room_id = r.id) AS filled
       FROM rooms r
       WHERE r.code = $1
       LIMIT 1`,
      [normCode(code)],
    );
    return mapRoom(rows[0]);
  }

  // 按白名单拼 UPDATE rooms；run 既可以是 sql().query 也可以是事务内的 txn.query
  function roomUpdateQuery(run, code, patch = {}) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(ROOM_PATCH)) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      let param;
      if (JSON_COLUMNS.has(key)) param = value == null ? null : json(value);
      else if (key === 'startedAt' || key === 'endedAt') param = toDate(value);
      else if (key === 'autoStart') param = !!value;
      else if (key === 'seats' || key === 'askTimeoutMs') param = num(value);
      else param = value == null ? null : value;
      params.push(param);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return null;
    params.push(normCode(code));
    // filled 用 RETURNING 里的子查询算，省掉回读一次
    return run(
      `UPDATE rooms SET ${sets.join(', ')} WHERE code = $${params.length}
       RETURNING *, (SELECT COUNT(*)::int FROM room_players rp WHERE rp.room_id = rooms.id) AS filled`,
      params,
    );
  }

  async function updateRoom(code, patch = {}) {
    const query = roomUpdateQuery((text, params) => sql().query(text, params), code, patch);
    if (!query) return getRoom(code);
    const rows = await query;
    if (!rows.length) return null;
    return mapRoom(rows[0]);
  }

  async function listRooms() {
    // 列表只需要 state 的几个片段：整份 state 含玩家/日志/_oob，传输约多花 300ms
    const rows = await sql().query(
      `SELECT r.id, r.code, r.game_type, r.game_title, r.status, r.mode, r.seats,
              r.ask_timeout_ms, r.auto_start, r.host_name, r.winner,
              jsonb_build_object(
                'phase', r.state->'phase',
                'pending', r.state->'pending',
                'askPlayerIds', r.state->'askPlayerIds',
                'gameTitle', r.state->'gameTitle',
                'filled', r.state->'filled'
              ) AS state,
              r.created_at, r.started_at, r.ended_at, r.updated_at,
              (SELECT COUNT(*)::int FROM room_players rp WHERE rp.room_id = r.id) AS filled
       FROM rooms r
       ORDER BY r.created_at DESC`,
    );
    return rows.map((row) => {
      const room = mapRoom(row, { withToken: false });
      room.phase = room.state && typeof room.state === 'object' && room.state.phase != null
        ? room.state.phase
        : null;
      return room;
    });
  }

  /* ---------- 批量读写（一次 HTTP 往返） ---------- */

  // loadRoom 所需的全部事实：room(+filled) / players / actions / maxSeq —— 一条事务 4 条查询
  async function loadRoomFacts(code) {
    const normalized = normCode(code);
    const [roomRows, playerRows, actionRows, seqRows] = await sql().transaction((txn) => [
      txn.query(
        `SELECT r.*,
                (SELECT COUNT(*)::int FROM room_players rp WHERE rp.room_id = r.id) AS filled
         FROM rooms r
         WHERE r.code = $1
         LIMIT 1`,
        [normalized],
      ),
      txn.query(
        `SELECT rp.*
         FROM room_players rp
         JOIN rooms r ON r.id = rp.room_id
         WHERE r.code = $1
         ORDER BY rp.seat ASC`,
        [normalized],
      ),
      txn.query(
        `SELECT a.*, rp.player_key
         FROM actions a
         JOIN room_players rp ON rp.id = a.player_id
         JOIN rooms r ON r.id = a.room_id
         WHERE r.code = $1
         ORDER BY a.created_at ASC, a.id ASC`,
        [normalized],
      ),
      txn.query(
        `SELECT COALESCE(MAX(e.seq), 0) AS seq
         FROM events e
         JOIN rooms r ON r.id = e.room_id
         WHERE r.code = $1`,
        [normalized],
      ),
    ]);
    return {
      room: mapRoom(roomRows[0]),
      players: playerRows.map(mapPlayer),
      actions: actionRows.map((row) => mapAction(row)),
      maxSeq: num(seqRows[0] && seqRows[0].seq) ?? 0,
    };
  }

  // persist 的全部写入：actions + events + rooms patch —— 一条事务
  async function commitRoom(code, plan = {}) {
    const normalized = normCode(code);
    const actionList = Array.isArray(plan.actions) ? plan.actions : [];
    const eventList = Array.isArray(plan.events) ? plan.events : [];
    const patch = plan.patch && typeof plan.patch === 'object' ? plan.patch : {};

    const queries = [];
    for (const rec of actionList) {
      if (!rec || rec.playerKey == null) continue;
      queries.push(sql().query(
        `INSERT INTO actions (room_id, player_id, action, thought, say, source, accepted)
         SELECT rp.room_id, rp.id, $3::jsonb, $4, $5, $6, $7
         FROM room_players rp
         WHERE rp.room_id = (SELECT id FROM rooms WHERE code = $1)
           AND rp.player_key = $2
         RETURNING id`,
        [
          normalized,
          String(rec.playerKey),
          json(rec.action && typeof rec.action === 'object' ? rec.action : {}),
          rec.thought ?? null,
          rec.say ?? null,
          rec.source || 'agent',
          rec.accepted !== false,
        ],
      ));
    }

    for (const ev of eventList) {
      if (!ev || ev.seq == null) continue;
      const rawSecret = ev.secretForPlayerId == null ? null : String(ev.secretForPlayerId);
      // 与原 appendEvents 一致：先按 player_key 解析，解析不到再看是否本身就是 UUID
      const secretUuid = rawSecret && UUID_RE.test(rawSecret) ? rawSecret : null;
      queries.push(sql().query(
        `INSERT INTO events
            (room_id, seq, type, payload, text, fx, visibility,
             secret_for_player_id, created_at)
         SELECT rm.id, $2::bigint, $3, $4::jsonb, $5, $6::jsonb, $7,
                COALESCE(
                  (SELECT rp.id FROM room_players rp
                   WHERE rp.room_id = rm.id AND rp.player_key = $8
                   LIMIT 1),
                  $9::uuid
                ),
                NOW()
         FROM rooms rm
         WHERE rm.code = $1
           -- events 主键含 created_at，无法靠 ON CONFLICT 去重 (room_id, seq)
           AND NOT EXISTS (
               SELECT 1 FROM events e WHERE e.room_id = rm.id AND e.seq = $2::bigint
           )
         ON CONFLICT DO NOTHING
         RETURNING seq`,
        [
          normalized,
          num(ev.seq),
          ev.type,
          json(ev.payload && typeof ev.payload === 'object' ? ev.payload : {}),
          ev.text ?? null,
          ev.fx == null ? null : json(ev.fx),
          ev.visibility || 'public',
          rawSecret,
          secretUuid,
        ],
      ));
    }

    let patchIndex = -1;
    const patchQuery = roomUpdateQuery((text, params) => sql().query(text, params), normalized, patch);
    if (patchQuery) {
      patchIndex = queries.length;
      queries.push(patchQuery);
    }

    if (!queries.length) return { room: null };
    const results = await sql().transaction(queries);
    const patchRows = patchIndex >= 0 ? results[patchIndex] : null;
    return { room: patchRows && patchRows[0] ? mapRoom(patchRows[0]) : null };
  }

  // 事件轮询：room / events（viewer 用 token_hash 子查询过滤）/ maxSeq —— 一条事务
  async function getRoomEvents(code, opts = {}) {
    const {
      since = 0, viewerTokenHash = null, limit = 500, includeAll = false,
    } = opts || {};
    const normalized = normCode(code);
    const sinceN = num(since) ?? 0;
    const limitN = num(limit);
    const maxRows = limitN != null && limitN > 0 ? limitN : 500;
    const viewerHash = viewerTokenHash == null ? null : String(viewerTokenHash);
    const visibilityClause = includeAll
      ? ''
      : `AND (
           e.visibility = 'public'
           OR (e.visibility IN ('secret_for', 'private') AND rp.player_key = (
             SELECT rp2.player_key
             FROM room_players rp2
             WHERE rp2.room_id = e.room_id AND rp2.token_hash = $3
             LIMIT 1
           ))
         )`;
    const params = includeAll
      ? [normalized, sinceN, maxRows]
      : [normalized, sinceN, viewerHash, maxRows];
    const [roomRows, eventRows, seqRows] = await sql().transaction((txn) => [
      txn.query(
        `SELECT r.*,
                (SELECT COUNT(*)::int FROM room_players rp WHERE rp.room_id = r.id) AS filled
         FROM rooms r
         WHERE r.code = $1
         LIMIT 1`,
        [normalized],
      ),
      txn.query(
        `SELECT e.seq, e.type, e.payload, e.text, e.fx, e.visibility,
                e.created_at, rp.player_key AS secret_for_key
         FROM events e
         JOIN rooms rm ON rm.id = e.room_id
         LEFT JOIN room_players rp ON rp.id = e.secret_for_player_id
         WHERE rm.code = $1
           AND e.seq > $2
           ${visibilityClause}
         ORDER BY e.seq ASC
         LIMIT $${params.length}`,
        params,
      ),
      txn.query(
        `SELECT COALESCE(MAX(e.seq), 0) AS seq
         FROM events e
         JOIN rooms rm ON rm.id = e.room_id
         WHERE rm.code = $1`,
        [normalized],
      ),
    ]);
    return {
      room: mapRoom(roomRows[0]),
      events: eventRows.map(mapEvent),
      maxSeq: num(seqRows[0] && seqRows[0].seq) ?? 0,
    };
  }

  // 在线 AI 计数（一次聚合，避免按房间 N+1）
  async function countAgentsPresent() {
    const rows = await sql().query(
      `SELECT COUNT(*)::int AS n
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       WHERE rp.kind = 'agent'`,
    );
    return num(rows[0] && rows[0].n) ?? 0;
  }

  // 后台统计卡：活跃房间 / 在线 AI / 今日揭示，一次聚合
  async function adminStats() {
    const results = await sql().transaction((txn) => [
      txn.query("SET LOCAL app.is_admin = 'on'"),
      txn.query(
        `SELECT
           (SELECT COUNT(*)::int FROM rooms WHERE status = 'playing') AS active_rooms,
           (SELECT COUNT(*)::int FROM room_players rp
              JOIN rooms r ON r.id = rp.room_id
             WHERE rp.kind = 'agent') AS agents_present,
           (SELECT COUNT(*)::int FROM godview_snapshots
             WHERE visibility_level = 'raw' AND created_at >= $1) AS reveals_today`,
        [toDate(startOfToday())],
      ),
    ]);
    const row = results[1][0] || {};
    return {
      activeRooms: num(row.active_rooms) ?? 0,
      agentsPresent: num(row.agents_present) ?? 0,
      revealsToday: num(row.reveals_today) ?? 0,
    };
  }

  /* ---------- players ---------- */

  async function addPlayer(roomCode, rec = {}) {
    const normalized = normCode(roomCode);
    const playerKey = String(rec.playerKey);
    if (!playerKey) throw new Error('addPlayer 需要 playerKey');
    const meta = { ...(rec.meta && typeof rec.meta === 'object' ? rec.meta : {}) };
    if (rec.style !== undefined) meta.style = rec.style;
    const params = [
      normalized,
      num(rec.seat),
      playerKey,
      rec.tokenHash ?? '',
      rec.kind || 'agent',
      rec.name ?? '',
      rec.title ?? null,
      rec.glyph ?? null,
      rec.hue == null ? null : num(rec.hue),
      rec.model ?? null,
      rec.brand || 'unknown',
      rec.avatarUrl ?? null,
      rec.role ?? null,
      rec.team ?? null,
      !!rec.teamPublic,
      !!rec.rolePublic,
      json(rec.secret && typeof rec.secret === 'object' ? rec.secret : {}),
      rec.alive !== false,
      num(rec.hp) ?? 1,
      num(rec.maxHp) ?? 1,
      json(rec.items ?? []),
      json(rec.hand ?? []),
      json(rec.dice ?? []),
      num(rec.chips) ?? 0,
      num(rec.caught) ?? 0,
      !!rec.folded,
      rec.say ?? '',
      rec.thought ?? '',
      json(meta),
      rec.lastSeen == null ? null : toDate(rec.lastSeen),
      rec.joinedAt == null ? new Date() : toDate(rec.joinedAt),
    ];
    try {
      // 用 code 子查询定位 room_id，省掉先查 room 的一次往返
      const rows = await sql().query(
        `INSERT INTO room_players
            (room_id, seat, player_key, token_hash, kind, name, title, glyph, hue,
             model, brand, avatar_url, role, team, team_public, role_public, secret,
             alive, hp, max_hp, items, hand, dice, chips, caught, folded, say, thought,
             meta, last_seen, joined_at)
         SELECT rm.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17::jsonb, $18, $19, $20, $21::jsonb, $22::jsonb,
                $23::jsonb, $24, $25, $26, $27, $28, $29::jsonb, $30, $31
         FROM rooms rm
         WHERE rm.code = $1
         RETURNING *`,
        params,
      );
      if (!rows.length) throw notFound(`房间不存在：${normalized}`);
      return mapPlayer(rows[0]);
    } catch (err) {
      return asConflict(err, `玩家或座位已存在：${playerKey}`);
    }
  }

  async function getPlayer(roomCode, playerKey) {
    const rows = await sql().query(
      `SELECT rp.*
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       WHERE r.code = $1 AND rp.player_key = $2
       LIMIT 1`,
      [normCode(roomCode), String(playerKey)],
    );
    return mapPlayer(rows[0]);
  }

  async function getPlayerByTokenHash(roomCode, tokenHash) {
    if (tokenHash == null) return null;
    const rows = await sql().query(
      `SELECT rp.*
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       WHERE r.code = $1 AND rp.token_hash = $2
       LIMIT 1`,
      [normCode(roomCode), String(tokenHash)],
    );
    return mapPlayer(rows[0]);
  }

  async function updatePlayer(roomCode, playerKey, patch = {}) {
    const normalized = normCode(roomCode);
    const key = String(playerKey);
    const next = { ...patch };
    if (next.style !== undefined && next.meta === undefined) {
      const rows = await sql().query(
        `SELECT rp.meta
         FROM room_players rp
         JOIN rooms r ON r.id = rp.room_id
         WHERE r.code = $1 AND rp.player_key = $2
         LIMIT 1`,
        [normalized, key],
      );
      if (!rows.length) return null;
      next.meta = { ...(rows[0].meta && typeof rows[0].meta === 'object' ? rows[0].meta : {}) };
      next.meta.style = next.style;
    }
    const sets = [];
    const params = [];
    for (const [name, column] of Object.entries(PLAYER_PATCH)) {
      if (next[name] === undefined) continue;
      const value = next[name];
      let param;
      if (JSON_COLUMNS.has(name)) param = value == null ? null : json(value);
      else if (name === 'lastSeen') param = toDate(value);
      else if (name === 'alive' || name === 'folded' || name === 'teamPublic' || name === 'rolePublic') param = !!value;
      else if (name === 'seat' || name === 'hue' || name === 'hp' || name === 'maxHp' || name === 'chips' || name === 'caught') param = num(value);
      else param = value == null ? null : value;
      params.push(param);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return getPlayer(normalized, key);
    // 按 code 直接定位，省掉先查一次 room 的往返
    params.push(normalized, key);
    const rows = await sql().query(
      `UPDATE room_players rp SET ${sets.join(', ')}
       FROM rooms r
       WHERE r.id = rp.room_id
         AND r.code = $${params.length - 1}
         AND rp.player_key = $${params.length}
       RETURNING rp.*`,
      params,
    );
    return mapPlayer(rows[0]);
  }

  async function listPlayers(roomCode) {
    const rows = await sql().query(
      `SELECT rp.*
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       WHERE r.code = $1
       ORDER BY rp.seat ASC`,
      [normCode(roomCode)],
    );
    return rows.map(mapPlayer);
  }

  /* ---------- events ---------- */

  async function appendEvents(roomCode, batch) {
    const room = await roomRow(roomCode);
    if (!room) throw notFound(`房间不存在：${normCode(roomCode)}`);
    const list = Array.isArray(batch) ? batch : [];
    if (!list.length) return 0;
    const idByKey = await playerIdsByKey(room.id);
    const queries = [];
    for (const ev of list) {
      if (!ev || ev.seq == null) continue;
      let secretId = null;
      if (ev.secretForPlayerId != null) {
        const raw = String(ev.secretForPlayerId);
        secretId = idByKey.get(raw) || (UUID_RE.test(raw) ? raw : null);
      }
      queries.push(
        sql().query(
          `INSERT INTO events
              (room_id, seq, type, payload, text, fx, visibility,
               secret_for_player_id, created_at)
           SELECT $1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::uuid, NOW()
           WHERE NOT EXISTS (
               SELECT 1 FROM events WHERE room_id = $1 AND seq = $2
           )
           ON CONFLICT DO NOTHING
           RETURNING seq`,
          [
            room.id,
            num(ev.seq),
            ev.type,
            json(ev.payload && typeof ev.payload === 'object' ? ev.payload : {}),
            ev.text ?? null,
            ev.fx == null ? null : json(ev.fx),
            ev.visibility || 'public',
            secretId,
          ],
        ),
      );
    }
    if (!queries.length) return 0;
    const results = await sql().transaction(queries);
    return results.reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
  }

  async function listEvents(roomCode, opts = {}) {
    const {
      since = 0, viewerPlayerId = null, limit = 500, includeAll = false,
    } = opts || {};
    const room = await roomRow(roomCode);
    if (!room) return [];
    const viewer = viewerPlayerId == null ? null : String(viewerPlayerId);
    const limitN = num(limit);
    const maxRows = limitN != null && limitN > 0 ? limitN : 500;
    // includeAll（管理员 raw 档）：跳过 visibility 过滤；RLS 由 app.is_admin / owner 关系兜底
    const visibilityClause = includeAll
      ? ''
      : `AND (
           e.visibility = 'public'
           OR (e.visibility IN ('secret_for', 'private') AND rp.player_key = $3)
         )`;
    const params = includeAll
      ? [room.id, num(since) ?? 0, maxRows]
      : [room.id, num(since) ?? 0, viewer, maxRows];
    const rows = await sql().query(
      `SELECT e.seq, e.type, e.payload, e.text, e.fx, e.visibility,
              e.created_at, rp.player_key AS secret_for_key
       FROM events e
       LEFT JOIN room_players rp ON rp.id = e.secret_for_player_id
       WHERE e.room_id = $1
         AND e.seq > $2
         ${visibilityClause}
       ORDER BY e.seq ASC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapEvent);
  }

  async function maxEventSeq(roomCode) {
    const room = await roomRow(roomCode);
    if (!room) return 0;
    const rows = await sql().query(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE room_id = $1',
      [room.id],
    );
    return num(rows[0] && rows[0].seq) ?? 0;
  }

  /* ---------- actions ---------- */

  async function appendAction(roomCode, rec = {}) {
    const room = await roomRow(roomCode);
    if (!room) throw notFound(`房间不存在：${normCode(roomCode)}`);
    const player = await playerRow(room.id, rec.playerKey);
    if (!player) throw notFound(`玩家不存在：${rec.playerKey}`);
    const rows = await sql().query(
      `INSERT INTO actions (room_id, player_id, action, thought, say, source, accepted)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING *`,
      [
        room.id,
        player.id,
        json(rec.action && typeof rec.action === 'object' ? rec.action : {}),
        rec.thought ?? null,
        rec.say ?? null,
        rec.source || 'agent',
        rec.accepted !== false,
      ],
    );
    return mapAction(rows[0], rec.playerKey);
  }

  async function listActions(roomCode) {
    const room = await roomRow(roomCode);
    if (!room) return [];
    const rows = await sql().query(
      `SELECT a.*, rp.player_key
       FROM actions a
       JOIN room_players rp ON rp.id = a.player_id
       WHERE a.room_id = $1
       ORDER BY a.created_at ASC, a.id ASC`,
      [room.id],
    );
    return rows.map((row) => mapAction(row));
  }

  /* ---------- thoughts ---------- */

  async function appendThought(roomCode, playerKey, delta) {
    const normalized = normCode(roomCode);
    const rows = await sql().query(
      `INSERT INTO thoughts (room_id, player_id, seq, delta)
       SELECT rp.room_id, rp.id,
              COALESCE((SELECT MAX(t.seq) FROM thoughts t WHERE t.player_id = rp.id), 0) + 1,
              $3
       FROM room_players rp
       WHERE rp.room_id = (SELECT id FROM rooms WHERE code = $1)
         AND rp.player_key = $2
       RETURNING seq`,
      [normalized, String(playerKey), String(delta ?? '')],
    );
    if (!rows.length) {
      // 失败路径才多查一次，保持原有 NOT_FOUND 语义
      const roomRows = await sql().query('SELECT id FROM rooms WHERE code = $1 LIMIT 1', [normalized]);
      if (!roomRows.length) throw notFound(`房间不存在：${normalized}`);
      throw notFound(`玩家不存在：${playerKey}`);
    }
    return { seq: num(rows[0] && rows[0].seq) };
  }

  async function listThoughts(roomCode) {
    const room = await roomRow(roomCode);
    if (!room) return [];
    const rows = await sql().query(
      `SELECT t.seq, t.delta, t.created_at, rp.player_key
       FROM thoughts t
       JOIN room_players rp ON rp.id = t.player_id
       WHERE t.room_id = $1
       ORDER BY t.created_at ASC, t.seq ASC`,
      [room.id],
    );
    return rows.map((row) => ({
      playerKey: row.player_key,
      seq: num(row.seq),
      delta: row.delta,
      createdAt: toMs(row.created_at),
    }));
  }

  // 思考链 + 事件流一次取回（godview 专用，一次 HTTPS 往返）
  async function getRoomArchive(roomCode, { includeAll = false, limit = 1000 } = {}) {
    const code = normCode(roomCode);
    const maxRows = num(limit) != null && num(limit) > 0 ? Math.min(num(limit), 2000) : 1000;
    const results = await sql().transaction((txn) => [
      txn.query(
        `SELECT t.seq, t.delta, t.created_at, rp.player_key
         FROM thoughts t
         JOIN room_players rp ON rp.id = t.player_id
         WHERE t.room_id = (SELECT id FROM rooms WHERE code = $1)
         ORDER BY t.created_at ASC, t.seq ASC`,
        [code],
      ),
      txn.query(
        `SELECT e.seq, e.type, e.payload, e.text, e.fx, e.visibility,
                e.created_at, rp.player_key AS secret_for_key
         FROM events e
         LEFT JOIN room_players rp ON rp.id = e.secret_for_player_id
         WHERE e.room_id = (SELECT id FROM rooms WHERE code = $1)
           AND ($2::boolean OR e.visibility = 'public')
         ORDER BY e.seq ASC
         LIMIT $3`,
        [code, !!includeAll, maxRows],
      ),
    ]);
    return {
      thoughts: results[0].map((row) => ({
        playerKey: row.player_key,
        seq: num(row.seq),
        delta: row.delta,
        createdAt: toMs(row.created_at),
      })),
      events: results[1].map(mapEvent),
    };
  }

  /* ---------- admin users / sessions ---------- */

  async function findAdminByUsername(username) {
    const rows = await sql().query(
      'SELECT * FROM admin_users WHERE username = $1 LIMIT 1',
      [String(username)],
    );
    return mapAdmin(rows[0]);
  }

  async function getAdminById(id) {
    const rows = await sql().query('SELECT * FROM admin_users WHERE id = $1 LIMIT 1', [String(id)]);
    return mapAdmin(rows[0]);
  }

  async function createAdmin({ username, passwordHash, role } = {}) {
    try {
      const rows = await sql().query(
        `INSERT INTO admin_users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [String(username), String(passwordHash ?? ''), role || 'viewer'],
      );
      return mapAdmin(rows[0]);
    } catch (err) {
      return asConflict(err, `管理员已存在：${username}`);
    }
  }

  async function updateAdmin(id, patch = {}) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(ADMIN_PATCH)) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      let param;
      if (key === 'lockedUntil' || key === 'lastLoginAt') param = toDate(value);
      else if (key === 'active') param = !!value;
      else param = num(value);
      params.push(param);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return getAdminById(id);
    params.push(String(id));
    const rows = await sql().query(
      `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return mapAdmin(rows[0]);
  }

  async function createAdminSession({ adminUserId, tokenHash, ipAddress, userAgent, expiresAt } = {}) {
    try {
      const rows = await sql().query(
        `INSERT INTO admin_sessions (admin_user_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1::uuid, $2, $3::inet, $4, $5)
         RETURNING *`,
        [
          adminUserId,
          String(tokenHash ?? ''),
          ipAddress ?? null,
          userAgent ?? null,
          toDate(expiresAt),
        ],
      );
      return mapSession(rows[0]);
    } catch (err) {
      return asConflict(err, '会话 token 已存在');
    }
  }

  async function getAdminSessionByTokenHash(tokenHash) {
    const rows = await sql().query(
      'SELECT * FROM admin_sessions WHERE token_hash = $1 LIMIT 1',
      [String(tokenHash ?? '')],
    );
    return mapSession(rows[0]);
  }

  async function touchAdminSession(id) {
    const rows = await sql().query(
      'UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1 RETURNING *',
      [String(id)],
    );
    return mapSession(rows[0]);
  }

  async function revokeAdminSession(id) {
    const rows = await sql().query(
      `UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, NOW())
       WHERE id = $1
       RETURNING *`,
      [String(id)],
    );
    return mapSession(rows[0]);
  }

  // 会话校验 + 管理员资料 + last_seen 刷新：一条事务（一次 HTTPS 往返）
  async function getSessionContext(tokenHash) {
    const hash = String(tokenHash ?? '');
    const results = await sql().transaction((txn) => [
      txn.query(
        `SELECT s.id, s.admin_user_id, s.csrf_token_hash, s.ip_address, s.user_agent,
                s.created_at, s.expires_at, s.last_seen_at, s.revoked_at,
                a.id AS admin_id, a.username, a.password_hash, a.role, a.active,
                a.failed_attempts, a.locked_until, a.last_login_at,
                a.created_at AS admin_created_at, a.updated_at AS admin_updated_at
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_user_id
         WHERE s.token_hash = $1
         LIMIT 1`,
        [hash],
      ),
      txn.query(
        'UPDATE admin_sessions SET last_seen_at = NOW() WHERE token_hash = $1 RETURNING last_seen_at',
        [hash],
      ),
    ]);
    const s = results[0][0];
    if (!s) return null;
    const touchedAt = results[1][0] ? toMs(results[1][0].last_seen_at) : toMs(s.last_seen_at);
    return {
      session: {
        id: s.id,
        adminUserId: s.admin_user_id,
        tokenHash: hash,
        csrfTokenHash: s.csrf_token_hash ?? null,
        ipAddress: s.ip_address ?? null,
        userAgent: s.user_agent ?? null,
        createdAt: toMs(s.created_at),
        expiresAt: toMs(s.expires_at),
        lastSeenAt: touchedAt,
        revokedAt: toMs(s.revoked_at),
      },
      admin: {
        id: s.admin_id,
        username: s.username,
        passwordHash: s.password_hash,
        role: s.role,
        active: !!s.active,
        failedAttempts: num(s.failed_attempts),
        lockedUntil: toMs(s.locked_until),
        lastLoginAt: toMs(s.last_login_at),
        createdAt: toMs(s.admin_created_at),
        updatedAt: toMs(s.admin_updated_at),
      },
    };
  }

  /* ---------- audit（哈希链由 DB 触发器计算） ---------- */

  const AUDIT_INSERT_SQL = `INSERT INTO audit_logs
      (actor_id, actor_username, session_id, action, target_type, target_id,
       before, after, reason, ip_address)
   VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::inet)
   RETURNING id, prev_hash, hash`;

  function auditParams(fields = {}) {
    return [
      fields.actorId ?? null,
      String(fields.actorUsername ?? 'system'),
      fields.sessionId ?? null,
      String(fields.action ?? ''),
      fields.targetType ?? null,
      fields.targetId == null ? null : String(fields.targetId),
      fields.before === undefined || fields.before === null ? null : json(fields.before),
      fields.after === undefined || fields.after === null ? null : json(fields.after),
      fields.reason ?? null,
      fields.ipAddress ?? null,
    ];
  }

  async function appendAuditLog(fields = {}) {
    const results = await sql().transaction((txn) => [
      txn.query("SET LOCAL app.is_admin = 'on'"),
      txn.query(AUDIT_INSERT_SQL, auditParams(fields)),
    ]);
    const row = results[1][0];
    return { id: num(row.id), hash: row.hash, prevHash: row.prev_hash };
  }

  async function listAuditLogs({ limit = 100, actorId = null, targetId = null } = {}) {
    const where = [];
    const params = [];
    if (actorId != null) {
      params.push(String(actorId));
      where.push(`actor_id = $${params.length}::uuid`);
    }
    if (targetId != null) {
      params.push(String(targetId));
      where.push(`target_id = $${params.length}`);
    }
    const limitN = num(limit);
    params.push(limitN != null && limitN > 0 ? Math.min(limitN, 5000) : 100);
    const rows = await sql().query(
      `SELECT * FROM audit_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapAudit);
  }

  async function countRawRevealsToday() {
    const results = await sql().transaction((txn) => [
      txn.query("SET LOCAL app.is_admin = 'on'"),
      txn.query(
        `SELECT COUNT(*)::int AS n FROM godview_snapshots
         WHERE visibility_level = 'raw' AND created_at >= $1`,
        [toDate(startOfToday())],
      ),
    ]);
    return num(results[1][0] && results[1][0].n) ?? 0;
  }

  /* ---------- godview snapshots ---------- */

  async function saveGodviewSnapshot(rec = {}) {
    const room = await roomRow(rec.roomCode);
    if (!room) throw notFound(`房间不存在：${normCode(rec.roomCode)}`);
    const results = await sql().transaction((txn) => [
      txn.query("SET LOCAL app.is_admin = 'on'"),
      txn.query(
        `INSERT INTO godview_snapshots
            (room_id, captured_by, visibility_level, public_state,
             players_private, pending_asks, thoughts, events)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
         RETURNING *`,
        [
          room.id,
          rec.capturedBy ?? null,
          rec.visibilityLevel || 'masked',
          json(rec.publicState && typeof rec.publicState === 'object' ? rec.publicState : {}),
          json(rec.playersPrivate ?? []),
          json(rec.pendingAsks ?? []),
          json(rec.thoughts ?? []),
          json(rec.events ?? []),
        ],
      ),
    ]);
    const row = results[1][0];
    return {
      id: row.id,
      roomCode: room.code,
      capturedBy: row.captured_by ?? null,
      visibilityLevel: row.visibility_level,
      publicState: row.public_state ?? {},
      playersPrivate: row.players_private ?? [],
      pendingAsks: row.pending_asks ?? [],
      thoughts: row.thoughts ?? [],
      events: row.events ?? [],
      createdAt: toMs(row.created_at),
    };
  }

  /* ---------- world settings ---------- */

  // godview 快照 + 审计一次事务写入（一次 HTTPS 往返）
  async function recordGodviewRead({ snapshot = {}, audit = {} } = {}) {
    const code = normCode(snapshot.roomCode);
    const results = await sql().transaction((txn) => [
      txn.query("SET LOCAL app.is_admin = 'on'"),
      txn.query(
        `INSERT INTO godview_snapshots
            (room_id, captured_by, visibility_level, public_state,
             players_private, pending_asks, thoughts, events)
         SELECT r.id, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb
         FROM rooms r WHERE r.code = $1
         RETURNING id`,
        [
          code,
          snapshot.capturedBy ?? null,
          snapshot.visibilityLevel || 'masked',
          json(snapshot.publicState && typeof snapshot.publicState === 'object' ? snapshot.publicState : {}),
          json(snapshot.playersPrivate ?? []),
          json(snapshot.pendingAsks ?? []),
          json(snapshot.thoughts ?? []),
          json(snapshot.events ?? []),
        ],
      ),
      txn.query(AUDIT_INSERT_SQL, auditParams(audit)),
    ]);
    const snap = results[1][0];
    if (!snap) throw notFound(`房间不存在：${code}`);
    const row = results[2][0];
    return {
      snapshotId: snap.id,
      audit: { id: num(row.id), hash: row.hash, prevHash: row.prev_hash },
    };
  }

  async function getWorldSettings() {
    const rows = await sql().query(
      'SELECT key, value, description FROM world_settings ORDER BY key ASC',
    );
    return rows.map((row) => ({
      key: row.key,
      value: row.value ?? null,
      description: row.description ?? '',
    }));
  }

  async function setWorldSetting(key, value, { updatedBy = null, description = '' } = {}) {
    const rows = await sql().query(
      `INSERT INTO world_settings (key, value, description, updated_by)
       VALUES ($1, $2::jsonb, $3, $4::uuid)
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(NULLIF(EXCLUDED.description, ''), world_settings.description),
           updated_by = EXCLUDED.updated_by
       RETURNING key, value, description, updated_by, updated_at`,
      [String(key), json(value), description == null ? '' : String(description), updatedBy],
    );
    const row = rows[0];
    return {
      key: row.key,
      value: row.value ?? null,
      description: row.description ?? '',
      updatedBy: row.updated_by ?? null,
      updatedAt: toMs(row.updated_at),
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
