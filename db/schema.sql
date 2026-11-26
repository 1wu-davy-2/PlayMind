-- =============================================================================
-- AI-Game-Workshop · Neon（Serverless PostgreSQL）初始化脚本
-- -----------------------------------------------------------------------------
-- 版本要求：PostgreSQL 16+（Neon 当前稳定版满足）。
-- 用法：    psql "$DATABASE_URL" -f db/schema.sql
--           DATABASE_URL 由环境注入，禁止把连接串或任何密钥写进本文件。
--
-- 设计前提：
--   1. 数据库只存 hash，永远不存明文。管理员密码用 argon2id/bcrypt（慢 KDF，
--      按 username 取行后验证）；hostToken / 玩家 token / 会话 token 是高熵 bearer
--      token，用服务端密钥的 HMAC-SHA256（确定性，可索引查找）后入库。
--      bcrypt 带随机盐、结果不确定，无法做 `WHERE token_hash = $1` 查找。
--   2. gen_random_uuid() 自 PG13 起为核心内置函数；pgcrypto 仅用于 digest()
--      计算审计哈希链，故仍显式启用。
--   3. 时间统一 TIMESTAMPTZ；动态状态用 JSONB；枚举类字段用 TEXT + CHECK，
--      便于新增 gameType / ask.kind 时无需 ALTER TYPE。
--   4. events 按 created_at 做月度 RANGE 分区；本脚本用于新库初始化，索引直接创建。
--      对已上线的大表，应改用 CREATE INDEX CONCURRENTLY（注意它不能包在事务块内）。
--
-- ⚠️ 安全声明：本脚本只含 CREATE / ALTER / COMMENT，不含 DROP、TRUNCATE、
--    无 WHERE 的 UPDATE/DELETE，也不含任何真实密钥或生产数据。
--    在已有数据的库上执行任何 DDL 前，请先备份（pg_dump / Neon 分支）并在测试环境验证。
--
-- Neon 连接池注意（transaction 模式）：
--   - 禁止依赖会话级 SET / 临时表 / advisory 会话锁跨请求存活。
--   - RLS 依赖的 app.* claim 必须在每个事务内用 SET LOCAL 设置。
--   - 审计哈希链用 pg_advisory_xact_lock（事务级锁），兼容 transaction pooling。
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 通用 updated_at 维护函数（PG14+ 可用 generated 列的部分场景见文档说明）。
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- RLS 帮助函数：应用在每个事务内 SET LOCAL app.is_admin = 'on' 后返回 TRUE。
CREATE OR REPLACE FUNCTION app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(current_setting('app.is_admin', true), 'off') = 'on';
$$;

-- -----------------------------------------------------------------------------
-- 1. agents — AI 身份 / 人设 / owner
-- -----------------------------------------------------------------------------
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    owner TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT '',
    model TEXT,
    brand TEXT NOT NULL DEFAULT 'unknown',
    avatar_url TEXT,
    persona JSONB NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_agents_handle CHECK (handle ~ '^[A-Za-z0-9_-]{2,64}$')
);

COMMENT ON TABLE agents IS 'AI 身份注册表：一个外部 agent 的稳定身份与人设，跨房间复用；owner 为虚构归属标识。';
COMMENT ON COLUMN agents.persona IS '人设扩展：语气、策略偏好、禁句等；结构由应用定义，使用 JSONB 以支持局部更新。';
COMMENT ON COLUMN agents.owner IS '归属标识（脱敏）；生产环境应接真实账号系统，不在本表存邮箱/手机号。';

CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. rooms — 房间主表
-- -----------------------------------------------------------------------------
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    game_type TEXT NOT NULL,
    game_title TEXT,
    status TEXT NOT NULL DEFAULT 'lobby',
    mode TEXT NOT NULL DEFAULT 'mixed',
    seats SMALLINT NOT NULL,
    ask_timeout_ms INTEGER NOT NULL DEFAULT 120000,
    auto_start BOOLEAN NOT NULL DEFAULT FALSE,
    host_name TEXT,
    host_token_hash TEXT NOT NULL,
    created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
    winner JSONB,
    state JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_rooms_code CHECK (code ~ '^[A-Z2-9]{6}$'),
    CONSTRAINT ck_rooms_status CHECK (status IN ('lobby', 'playing', 'ended')),
    CONSTRAINT ck_rooms_mode CHECK (mode IN ('mixed', 'ai')),
    CONSTRAINT ck_rooms_seats CHECK (seats BETWEEN 2 AND 10),
    CONSTRAINT ck_rooms_timeout CHECK (ask_timeout_ms BETWEEN 5000 AND 600000)
);

COMMENT ON TABLE rooms IS '房间：一局游戏的主实体。code 为对外 6 位房间号，id 为内部 UUID 主键。';
COMMENT ON COLUMN rooms.host_token_hash IS '房主 token 的 HMAC-SHA256 值（服务端密钥在应用侧）；明文只在创建响应里返回一次，绝不入库。';
COMMENT ON COLUMN rooms.state IS '当前 PublicState 的热快照（读优化）；事件流才是可回放的事实源，二者不一致时以事件为准。';
COMMENT ON COLUMN rooms.created_by IS 'AI 自建房时关联 agents；人类建房为 NULL。ON DELETE SET NULL 保留房间历史。';

CREATE INDEX idx_rooms_status_created ON rooms (status, created_at DESC);
CREATE INDEX idx_rooms_created_by ON rooms (created_by) WHERE created_by IS NOT NULL;
CREATE TRIGGER trg_rooms_updated_at
    BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. room_players — 座位 / 私有信息
-- -----------------------------------------------------------------------------
CREATE TABLE room_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    seat SMALLINT NOT NULL,
    player_key TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    title TEXT,
    glyph TEXT,
    hue SMALLINT,
    model TEXT,
    brand TEXT NOT NULL DEFAULT 'unknown',
    avatar_url TEXT,
    role TEXT,
    team TEXT,
    team_public BOOLEAN NOT NULL DEFAULT FALSE,
    role_public BOOLEAN NOT NULL DEFAULT FALSE,
    secret JSONB NOT NULL DEFAULT '{}',
    alive BOOLEAN NOT NULL DEFAULT TRUE,
    hp INTEGER NOT NULL DEFAULT 1,
    max_hp INTEGER NOT NULL DEFAULT 1,
    items JSONB NOT NULL DEFAULT '[]',
    hand JSONB NOT NULL DEFAULT '[]',
    dice JSONB NOT NULL DEFAULT '[]',
    chips INTEGER NOT NULL DEFAULT 0,
    caught INTEGER NOT NULL DEFAULT 0,
    folded BOOLEAN NOT NULL DEFAULT FALSE,
    say TEXT NOT NULL DEFAULT '',
    thought TEXT NOT NULL DEFAULT '',
    meta JSONB NOT NULL DEFAULT '{}',
    last_seen TIMESTAMPTZ,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    CONSTRAINT uq_room_players_seat UNIQUE (room_id, seat),
    CONSTRAINT uq_room_players_key UNIQUE (room_id, player_key),
    CONSTRAINT ck_room_players_kind CHECK (kind IN ('human', 'agent', 'bot')),
    CONSTRAINT ck_room_players_seat CHECK (seat BETWEEN 0 AND 9),
    CONSTRAINT ck_room_players_hp CHECK (hp >= 0 AND max_hp >= 0)
);

COMMENT ON TABLE room_players IS '房间内玩家与座位。每个玩家持独立 token_hash，用于轮询鉴权；私有字段靠 API 投影 + RLS 双重约束。';
COMMENT ON COLUMN room_players.token_hash IS '玩家 token 的 HMAC-SHA256 值。当前实现用 Math.random 生成弱 token，迁移时必须改为 CSPRNG（crypto.randomBytes）并只存 hash。';
COMMENT ON COLUMN room_players.secret IS '仅本人可见的私有数据：{kind,data}（词/手牌/骰面/身份/关键卡等），godview raw 档可解封。';
COMMENT ON COLUMN room_players.team_public IS '对应 GameBase.publicState() 的 teamPublic/rolePublic 开关，控制公开状态是否泄露阵营/身份。';

CREATE INDEX idx_room_players_token ON room_players (token_hash);
CREATE INDEX idx_room_players_agent ON room_players (agent_id) WHERE agent_id IS NOT NULL;
CREATE TRIGGER trg_room_players_updated_at
    BEFORE UPDATE ON room_players
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. asks — 挂起中的决策（design addition，供 actions/thoughts 外键引用）
-- -----------------------------------------------------------------------------
CREATE TABLE asks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    player_id UUID NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    context JSONB NOT NULL DEFAULT '{}',
    deadline TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    CONSTRAINT ck_asks_status CHECK (status IN ('pending', 'answered', 'expired', 'cancelled'))
);

COMMENT ON TABLE asks IS '待决策事项：对应 GameBase.askMany() 产生的 ask，同一 batch_id 为并行挂起的一组。';
COMMENT ON COLUMN asks.context IS '只下发该玩家的上下文（可能含 secret），godview 可查看但普通 SSE 必须按 secretFor 过滤。';

CREATE INDEX idx_asks_room_status ON asks (room_id, status, deadline);
CREATE INDEX idx_asks_player_status ON asks (player_id, status);

-- -----------------------------------------------------------------------------
-- 5. actions — 已提交的决策
-- -----------------------------------------------------------------------------
CREATE TABLE actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
    ask_id UUID REFERENCES asks(id) ON DELETE SET NULL,
    action JSONB NOT NULL,
    thought TEXT,
    say TEXT,
    source TEXT NOT NULL DEFAULT 'agent',
    accepted BOOLEAN NOT NULL DEFAULT TRUE,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_actions_source CHECK (source IN ('agent', 'human', 'bot', 'host', 'admin', 'timeout'))
);

COMMENT ON TABLE actions IS '一次 act 提交：action/thought/say 三者正交，与 CONTRACT.md §2.6 一致。';
COMMENT ON COLUMN actions.source IS '来源标记；admin/host 来源用于与正常玩家行为区分，是审计与 godview 的关键维度。';

CREATE INDEX idx_actions_room_created ON actions (room_id, created_at DESC);
CREATE INDEX idx_actions_player_created ON actions (player_id, created_at DESC);
CREATE INDEX idx_actions_ask ON actions (ask_id) WHERE ask_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 6. thoughts — 分段思考流
-- -----------------------------------------------------------------------------
CREATE TABLE thoughts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
    ask_id UUID REFERENCES asks(id) ON DELETE SET NULL,
    seq INTEGER NOT NULL,
    delta TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_thoughts_player_seq UNIQUE (player_id, seq)
);

COMMENT ON TABLE thoughts IS 'POST /think 的每一段增量，按 seq 顺序重放得到完整思考链；提交 act 后归档、清空当前 thought。';

CREATE INDEX idx_thoughts_room_created ON thoughts (room_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 7. events — 事件流（按 created_at 月度 RANGE 分区）
-- -----------------------------------------------------------------------------
CREATE TABLE events (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL,
    seq BIGINT NOT NULL,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    text TEXT,
    fx JSONB,
    visibility TEXT NOT NULL DEFAULT 'public',
    secret_for_player_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (room_id, seq, created_at),
    CONSTRAINT ck_events_visibility CHECK (visibility IN ('public', 'private', 'secret_for', 'admin'))
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE events IS '房间事件流（事实源）。seq 为房间内单调递增序号；visibility + secret_for_player_id 控制广播可见性。';
COMMENT ON COLUMN events.visibility IS 'public=全员可见；secret_for=仅 secret_for_player_id 可见；admin=仅造物主后台可见；private=仅当事方可见。';
COMMENT ON COLUMN events.payload IS '事件特有字段，保持 GameBase.emit 的扁平结构（draw/say/truth/damage 等）。';

-- 初始分区（新库可直接创建；已上线大表建议 pg_partman 自动滚动）。
CREATE TABLE events_2026_10 PARTITION OF events
    FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');
CREATE TABLE events_2026_11 PARTITION OF events
    FOR VALUES FROM ('2026-11-01T00:00:00Z') TO ('2026-12-01T00:00:00Z');
CREATE TABLE events_2026_12 PARTITION OF events
    FOR VALUES FROM ('2026-12-01T00:00:00Z') TO ('2027-01-01T00:00:00Z');
CREATE TABLE events_2027_01 PARTITION OF events
    FOR VALUES FROM ('2027-01-01T00:00:00Z') TO ('2027-02-01T00:00:00Z');
CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE INDEX idx_events_room_created ON events (room_id, created_at DESC);
CREATE INDEX idx_events_room_type ON events (room_id, type, created_at DESC);
CREATE INDEX idx_events_payload_gin ON events USING GIN (payload);

-- -----------------------------------------------------------------------------
-- 8. admin_users — 后门管理员账号
-- -----------------------------------------------------------------------------
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    totp_secret_encrypted TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    ip_allowlist INET[],
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_admin_users_role CHECK (role IN ('viewer', 'operator', 'root'))
);

COMMENT ON TABLE admin_users IS '后门管理员：凭据只存 hash；TOTP 密钥由应用层密钥加密后存储，数据库不持有解密密钥。';
COMMENT ON COLUMN admin_users.password_hash IS 'argon2id 或 bcrypt hash，由应用层计算；任何情况下不得写入明文密码。';
COMMENT ON COLUMN admin_users.ip_allowlist IS '可选 CIDR/IP 白名单，空数组表示不限制；校验用 client_ip <<= ANY(ip_allowlist) 的等价写法。';

CREATE INDEX idx_admin_users_active_role ON admin_users (active, role);
CREATE TRIGGER trg_admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 9. admin_sessions — 管理员会话
-- -----------------------------------------------------------------------------
CREATE TABLE admin_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT ck_admin_sessions_expiry CHECK (expires_at > created_at)
);

COMMENT ON TABLE admin_sessions IS '管理员会话：只存 HMAC-SHA256 token hash；过期/吊销双通道，短 TTL + 空闲超时由应用层执行。';

CREATE INDEX idx_admin_sessions_user ON admin_sessions (admin_user_id, expires_at DESC);
CREATE INDEX idx_admin_sessions_active ON admin_sessions (expires_at) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- 10. audit_logs — append-only 审计日志 + 哈希链
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    session_id UUID,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    before JSONB,
    after JSONB,
    reason TEXT,
    ip_address INET,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);

COMMENT ON TABLE audit_logs IS 'append-only 审计：每次 godview 读取与干预都记 who/when/target/before/after/reason；hash 链用于篡改检测。';
COMMENT ON COLUMN audit_logs.prev_hash IS '上一条记录的 hash， genesis 为 64 个 0；并发写入用事务级 advisory lock 串行化。';
COMMENT ON COLUMN audit_logs.hash IS 'sha256(prev_hash | 规范化字段串)，由 BEFORE INSERT 触发器计算，应用层不可覆盖。';

CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs (action, created_at DESC);

-- 哈希链：事务级锁保证 Neon transaction pooling 下并发插入的链顺序正确。
CREATE OR REPLACE FUNCTION audit_seal_chain()
RETURNS TRIGGER
AS $$
DECLARE
    v_prev TEXT;
    v_payload TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(714624001);
    SELECT hash INTO v_prev FROM audit_logs ORDER BY id DESC LIMIT 1;
    v_prev := COALESCE(v_prev, repeat('0', 64));

    v_payload := concat_ws('|',
        NEW.created_at::text,
        NEW.actor_username,
        COALESCE(NEW.action, ''),
        COALESCE(NEW.target_type, ''),
        COALESCE(NEW.target_id, ''),
        COALESCE(NEW.before::text, ''),
        COALESCE(NEW.after::text, ''),
        COALESCE(NEW.reason, ''),
        COALESCE(NEW.ip_address::text, ''),
        COALESCE(NEW.session_id::text, '')
    );
    NEW.prev_hash := v_prev;
    NEW.hash := encode(digest(v_prev || '|' || v_payload, 'sha256'), 'hex');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_seal_chain
    BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_seal_chain();

-- append-only：任何 UPDATE / DELETE 直接报错（对表所有者同样生效）。
CREATE OR REPLACE FUNCTION deny_audit_mutation()
RETURNS TRIGGER
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs 为 append-only，禁止 %（如需纠错请追加一条 compensating 记录）', TG_OP
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();

-- -----------------------------------------------------------------------------
-- 11. godview_snapshots — 造物主视角快照（取阅即留痕）
-- -----------------------------------------------------------------------------
CREATE TABLE godview_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    captured_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    visibility_level TEXT NOT NULL,
    public_state JSONB NOT NULL,
    players_private JSONB NOT NULL DEFAULT '[]',
    pending_asks JSONB NOT NULL DEFAULT '[]',
    thoughts JSONB NOT NULL DEFAULT '[]',
    events JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_godview_snapshots_level CHECK (visibility_level IN ('masked', 'raw'))
);

COMMENT ON TABLE godview_snapshots IS '每次 GET /admin/rooms/:id/godview 的返回留档，便于事后回答“谁在何时看过哪些私有信息”。';
COMMENT ON COLUMN godview_snapshots.players_private IS 'raw 档含全部 secret/手牌/思考链，属高敏数据；建议设置短保留期（见设计文档未决项）。';

CREATE INDEX idx_godview_room_created ON godview_snapshots (room_id, created_at DESC);
CREATE INDEX idx_godview_captured_by ON godview_snapshots (captured_by, created_at DESC);

-- -----------------------------------------------------------------------------
-- 12. world_settings — 全局世界设定
-- -----------------------------------------------------------------------------
CREATE TABLE world_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE,
    value JSONB NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE world_settings IS '全局配置键值表：维护模式、默认 askTimeoutMs、feature flag 等；value 用 JSONB 支持异构结构。';

CREATE TRIGGER trg_world_settings_updated_at
    BEFORE UPDATE ON world_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 13. RLS 策略（默认 ENABLE；是否 FORCE 见 DATABASE_DESIGN.md §5）
-- -----------------------------------------------------------------------------
-- 语义提醒：PG 中表所有者默认绕过 RLS。生产应让应用以专用非 owner 角色连接，
-- 并在确认 claim 注入链路正确后再对敏感表执行 FORCE ROW LEVEL SECURITY。
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE thoughts ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE godview_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;

-- 房间：管理员全通；普通请求只能访问 app.current_room_id 指定的房间。
CREATE POLICY rooms_scope ON rooms
    FOR ALL
    USING (
        app_is_admin()
        OR id::text = COALESCE(current_setting('app.current_room_id', true), '')
    )
    WITH CHECK (
        app_is_admin()
        OR id::text = COALESCE(current_setting('app.current_room_id', true), '')
    );

-- 玩家行：管理员全通；普通请求限定房间 + 本人（其余玩家信息由公开投影提供）。
CREATE POLICY room_players_scope ON room_players
    FOR ALL
    USING (
        app_is_admin()
        OR (
            room_id::text = COALESCE(current_setting('app.current_room_id', true), '')
            AND id::text = COALESCE(current_setting('app.current_player_id', true), '')
        )
    )
    WITH CHECK (
        app_is_admin()
        OR room_id::text = COALESCE(current_setting('app.current_room_id', true), '')
    );

CREATE POLICY asks_scope ON asks
    FOR ALL
    USING (
        app_is_admin()
        OR (
            room_id::text = COALESCE(current_setting('app.current_room_id', true), '')
            AND player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
        )
    )
    WITH CHECK (
        app_is_admin()
        OR room_id::text = COALESCE(current_setting('app.current_room_id', true), '')
    );

-- 事件：管理员全通；普通请求可见 public 事件或定向给自己的 secret_for 事件。
CREATE POLICY events_scope ON events
    FOR SELECT
    USING (
        app_is_admin()
        OR visibility = 'public'
        OR secret_for_player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
    );

CREATE POLICY events_insert ON events
    FOR INSERT
    WITH CHECK (
        app_is_admin()
        OR room_id::text = COALESCE(current_setting('app.current_room_id', true), '')
    );

-- 思考流 / 行为：仅本人与管理员可见。
CREATE POLICY thoughts_scope ON thoughts
    FOR SELECT
    USING (
        app_is_admin()
        OR player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
    );
CREATE POLICY thoughts_insert ON thoughts
    FOR INSERT
    WITH CHECK (
        app_is_admin()
        OR player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
    );

CREATE POLICY actions_scope ON actions
    FOR SELECT
    USING (
        app_is_admin()
        OR player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
    );
CREATE POLICY actions_insert ON actions
    FOR INSERT
    WITH CHECK (
        app_is_admin()
        OR player_id::text = COALESCE(current_setting('app.current_player_id', true), '')
    );

-- 审计 / 快照 / 会话：仅管理员可读；写入时必须带 app.is_admin。
CREATE POLICY audit_admin_read ON audit_logs
    FOR SELECT USING (app_is_admin());
CREATE POLICY audit_admin_insert ON audit_logs
    FOR INSERT WITH CHECK (app_is_admin());

CREATE POLICY godview_admin_all ON godview_snapshots
    FOR ALL
    USING (app_is_admin())
    WITH CHECK (app_is_admin());

CREATE POLICY admin_sessions_scope ON admin_sessions
    FOR ALL
    USING (
        app_is_admin()
        OR admin_user_id::text = COALESCE(current_setting('app.current_admin_id', true), '')
    )
    WITH CHECK (
        app_is_admin()
        OR admin_user_id::text = COALESCE(current_setting('app.current_admin_id', true), '')
    );

-- -----------------------------------------------------------------------------
-- 示例数据（虚构脱敏，默认注释；仅在测试库按需取消注释）
-- -----------------------------------------------------------------------------
-- INSERT INTO agents (handle, display_name, owner, model, brand, persona) VALUES
--     ('agent_001', '墨菲', 'demo_owner', 'deepseek-v4.1-flash', 'deepseek',
--      '{"tone": "冷峻", "maxThoughtChars": 2000}');
--
-- INSERT INTO rooms (code, game_type, game_title, status, mode, seats, host_token_hash) VALUES
--     ('K7M2QX', 'bomb-table', 'BOMB TABLE', 'lobby', 'mixed', 4, 'EXAMPLE_ONLY_HMAC_SHA256_HEX_PLACEHOLDER');
--
-- INSERT INTO admin_users (username, password_hash, role) VALUES
--     ('demo_viewer', '$2b$12$EXAMPLE_ONLY_NOT_A_REAL_HASH', 'viewer');
--
-- INSERT INTO world_settings (key, value, description) VALUES
--     ('maintenance_mode', '{"enabled": false}', '全局维护开关');
--
-- 密码 hash 用 argon2id/bcrypt；bearer token 用 HMAC-SHA256（服务端密钥不入库）。
--
-- 注意：示例 hash 仅为占位符，不可用于任何真实登录；实际 hash 必须由应用层生成。
