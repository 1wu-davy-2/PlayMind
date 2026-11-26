# 管理员后门登录与全局造物主视角（Godview）API 设计

> **结论：** 后门登录走**独立入口 + 独立账号表 + 独立会话**，不复用玩家的 `token` / `hostToken`。所有管理员读操作（尤其是造物主视角）与写操作（干预）都**先写 `audit_logs` 再返回**，审计表 append-only + sha256 哈希链，任何干预都必须有 `who/when/target/before/after/reason`。权限默认最小：`viewer` 只能看脱敏视图，`operator` 可结束/踢人，`root` 才可回档/代打/改全局设定。本文已对齐 `design/mockups/godview.html` 的界面结构（见 §6.3），但房间号展示格式等差异仍需确认（见 §7.5）。

依赖表：`admin_users`、`admin_sessions`、`audit_logs`、`godview_snapshots`、`world_settings`（见 `db/schema.sql` / `DATABASE_DESIGN.md`）。

---

## 1. 管理员后门登录流程

### 1.1 入口与凭据

| 项 | 设计 |
|---|---|
| 入口 | `POST /admin/login`（独立路由前缀 `/admin/*`，不与 `/api/*` 玩家路由混用）；后台页面 `/admin`（前端静态页） |
| 凭据 | `username` + `password`；可选 `totp`（TOTP 6 位码，root 强制开启） |
| 密码存储 | `admin_users.password_hash` 存 **argon2id（首选）/ bcrypt** hash，应用层计算与校验；数据库永不存明文 |
| TOTP | `totp_secret_encrypted` 由应用层密钥（环境变量 `ADMIN_TOTP_KEY`，**不入库**）AES-GCM 加密后存储；校验时解密，失败不回显密钥 |
| 白名单 | `admin_users.ip_allowlist INET[]`；空数组 = 不限制；命中规则 `client_ip <<= ANY(ip_allowlist)`（CIDR/IP） |
| 会话 | `POST /admin/login` 成功设置 `HttpOnly; Secure; SameSite=Strict` Cookie；token 只在此次响应里出现一次，DB 只存 HMAC-SHA256（`admin_sessions.token_hash`） |
| 过期 | 绝对 TTL 30 分钟 + 空闲 10 分钟（`last_seen_at`）；`POST /admin/logout` 置 `revoked_at` |
| 失败锁定 | 连续 5 次失败 → `locked_until = NOW() + 15 min`；成功登录清零 `failed_attempts` |
| 审计 | 登录成功/失败/锁定/登出均写 `audit_logs`（`action` = `admin.login.success` / `admin.login.fail` / `admin.login.lock` / `admin.logout`） |

### 1.2 登录请求 / 响应示例

```json
// POST /admin/login 请求
{
  "username": "demo_operator",
  "password": "<由客户端提交，服务端只校验 hash>",
  "totp": "123456"
}
```

```json
// 成功响应
{
  "ok": true,
  "adminId": "9f1c…",
  "username": "demo_operator",
  "role": "operator",
  "expiresAt": "2026-11-26T15:30:00Z"
}
```

> `Set-Cookie: admin_session=<opaque-token>; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/admin`

### 1.3 每个管理请求的事务模板

Neon transaction pooling 下会话状态不可靠，必须在**每个事务开头**用 `SET LOCAL` 注入 claim：

```sql
BEGIN;
SET LOCAL app.is_admin = 'on';
SET LOCAL app.current_admin_id = '9f1c...';
SET LOCAL app.current_room_id = 'K7M2QX';  -- 仅房间相关请求需要
-- 鉴权通过后执行业务查询 / 干预
-- 同一事务内 INSERT INTO audit_logs (...)
COMMIT;
```

**注意**：`action`/`target` 参数必须用绑定变量传入，禁止字符串拼接；TOTP 校验与失败计数更新要在同一事务内完成，避免竞态绕过锁定。

---

## 2. 权限分级与最小权限矩阵

| 能力 | `viewer` | `operator` | `root` |
|---|:---:|:---:|:---:|
| `GET /admin/rooms` | ✓ | ✓ | ✓ |
| `GET /admin/rooms/:id/godview?level=masked` | ✓ | ✓ | ✓ |
| `GET /admin/rooms/:id/godview?level=raw` | ✗（403） | ✓（需 `reason`，写审计） | ✓（需 `reason`，写审计） |
| `POST /admin/rooms/:id/intervene` `abort` | ✗ | ✓ | ✓ |
| `POST /admin/rooms/:id/intervene` `kick` | ✗ | ✓ | ✓ |
| `POST /admin/rooms/:id/intervene` `rewind` | ✗ | ✗ | ✓ |
| `POST /admin/rooms/:id/intervene` `force-act` | ✗ | ✗ | ✓ |
| `GET /admin/audit` | 仅自己的操作 | 全部（脱敏 before/after） | 全部（含 raw） |
| `POST /admin/world/settings` | ✗ | ✗ | ✓ |
| 管理 `admin_users`（创建/改角色/解锁） | ✗ | ✗ | ✓ |
| 校验审计哈希链 | ✗ | ✗ | ✓ |

**最小权限原则落地：**

1. 新建管理员默认 `viewer`，升级角色需 root 操作并写审计。
2. `raw` 档属于**敏感提升**：operator 每次请求必须带 `reason`，服务端二次校验 TOTP 会话新鲜度（`last_seen_at` 在 5 分钟内）。
3. `rewind` / `force-act` 等高危干预建议**双人复核**（root 发起 + 另一 root 批准），本期先记为未决项（§7）。
4. 会话 Cookie 仅 `Path=/admin`，不与玩家 token 共享作用域。

---

## 3. 全局造物主视角 API

### 3.1 `GET /admin/rooms` — 全量房间

```json
{
  "rooms": [
    {
      "roomId": "K7M2QX",
      "displayCode": "BT-0417",
      "gameType": "avalon",
      "gameTitle": "阿瓦隆",
      "status": "playing",
      "uiState": "playing",
      "phase": "vote",
      "mode": "ai",
      "seats": 5,
      "filled": 5,
      "hostName": "agent_001",
      "askPlayerIds": ["p1", "p3"],
      "createdAt": "2026-11-26T14:00:00Z",
      "canIntervene": true
    }
  ],
  "stats": {
    "activeRooms": 12,
    "agentsPresent": 38,
    "revealsToday": 3,
    "unloggedOps": 0
  },
  "total": 1
}
```

**实现**：`SELECT ... FROM rooms ORDER BY created_at DESC`（管理员 claim 下 RLS 不过滤）。索引 `idx_rooms_status_created`。
**字段映射（对齐 mockup）**：`uiState` 把 DB 的 `lobby` 映射成 mockup 的 `waiting`；`displayCode` 是给 UI 展示用的别名（mockup 用 `BT-0417`），**真实协议 ID 仍是 `roomId`**（6 位 `K7M2QX`，见 `CONTRACT.md`），映射规则待确认（§7.5）。
**列表不返回** `state.secret`、token hash 等私有字段；逐房间详情走 godview。
**刷新频率**：mockup 标注「每 3s 刷新」，仅允许轮询本接口（轻量）；`godview?level=raw` 必须用户主动点击触发，禁止 3s 轮询——否则会产生大量审计记录与快照，且极易被用作批量爬取私有信息。

### 3.2 `GET /admin/rooms/:id/godview` — 房间上帝视角

查询参数：`level=masked|raw`（默认 `masked`）；`reason`（`raw` 必填）。

```json
{
  "room": {
    "roomId": "K7M2QX",
    "gameType": "avalon",
    "status": "playing",
    "phase": "vote",
    "round": 2,
    "hostName": "agent_001",
    "createdAt": "2026-11-26T14:00:00Z",
    "winner": null
  },
  "publicState": { "players": [], "askPlayerIds": ["p1"], "log": [] },
  "players": [
    {
      "playerId": "p1",
      "seat": 1,
      "name": "墨菲",
      "kind": "agent",
      "model": "deepseek-v4.1-flash",
      "brand": "deepseek",
      "alive": true,
      "hp": 1,
      "role": "merlin",
      "team": "good",
      "secret": { "kind": "role", "data": { "evilIds": ["p3"] } },
      "hand": [],
      "dice": [],
      "thought": "他刚才那句话在试探我…",
      "say": "我怀疑 p3。",
      "lastSeen": "2026-11-26T14:05:00Z"
    }
  ],
  "asks": [
    {
      "askId": "a17",
      "playerId": "p1",
      "kind": "vote",
      "deadline": "2026-11-26T14:06:00Z",
      "payload": { "candidates": ["p2", "p3"] },
      "context": { "note": "仅 p1 可见的上下文" }
    }
  ],
  "thoughts": [
    { "playerId": "p1", "seq": 3, "delta": "他不敢指控我。", "at": "2026-11-26T14:04:30Z" }
  ],
  "events": [
    { "seq": 42, "type": "vote-cast", "text": "p1 投给 p3", "visibility": "public", "at": "2026-11-26T14:05:10Z" }
  ],
  "meta": {
    "capturedAt": "2026-11-26T14:05:20Z",
    "visibilityLevel": "raw",
    "eventCount": 42
  }
}
```

**两档差异：**

| 字段 | `masked` | `raw` |
|---|---|---|
| `players[].secret` | `{"redacted": true, "kind": "role"}` | 完整 `{kind,data}` |
| `players[].hand` / `dice` | 仅计数 `handCount` / `diceCount` | 完整数组 |
| `players[].thought` | 最近 1 段且截断 120 字 | 完整思考链 |
| `asks[].context` | `{"redacted": true}` | 完整上下文 |
| `events` | 仅 `visibility='public'` | 含 `secret_for` / `private` / `admin` |

**实现要点：**

1. 单事务内：读 `rooms` / `room_players` / `asks` / `thoughts` / `events` → `INSERT INTO godview_snapshots` 保存当次返回体 → `INSERT INTO audit_logs(action='admin.godview.read', before=NULL, after={'level':..., 'eventCount':...}, reason=...)` → `COMMIT`。
2. **绝不返回任何 token hash 或 TOTP 字段**；`players` 里即使 raw 也不含 `token_hash`。
3. `events` 必须带 `created_at` 谓词以触发分区裁剪（见 `DATABASE_DESIGN.md` §4.3）。

### 3.3 `POST /admin/rooms/:id/intervene` — 干预

请求与响应示例（`abort`）：

```json
// 请求
{
  "action": "abort",
  "reason": "牌局卡在某个 ask 超过 10 分钟，人工结束",
  "expectedStatus": "playing"
}
```

```json
// 响应
{
  "ok": true,
  "action": "abort",
  "before": { "status": "playing", "askPlayerIds": ["p1"] },
  "after": { "status": "ended", "winner": { "id": "none", "name": "强制结束" } },
  "auditId": 128
}
```

五种动作：

| action | 语义 | 权限 | 风险 |
|---|---|---|---|
| `abort` | 调用现有 `Room.abort()` 语义（`server/room.mjs:115`），结束房间 | operator+ | 低（不可逆的对局终止） |
| `kick` | 踢出指定玩家并清理其 ask / timer | operator+ | 中（该玩家 token 失效） |
| `rewind` | 回退到指定 `seq` 之前的状态，需以事件回放重建 | root | **高**：可能丢失后续状态 |
| `force-act` | 代替某玩家提交 action，写 `actions.source='admin'` | root | **高**：直接改变胜负 |
| `advance-phase` | 跳过当前阶段（对应 mockup 的「跳到下一阶段」） | operator+ | 中：跳过玩家决策，需 `reason` |

`kick` / `rewind` / `force-act` 需额外参数：`targetPlayerId` / `toSeq` / `action`。`advance-phase` 应通过引擎公开的阶段推进入口实现，不直接改 `phase` 字符串（否则 `asks`/计时器会残留）。

> mockup 的三个干预按钮（`end` / `kick` / `phase`）分别对应 `abort` / `kick` / `advance-phase`，权限与审计规则一致；`rewind` / `force-act` 是 API 预留的高危能力，mockup 暂未露出入口。

⚠️ 危险操作警告（执行 `rewind` / `force-act` 前必须向使用者展示并确认）：

```text
⚠️ 危险操作警告
该操作会改写进行中对局的状态，可能导致玩家已看到的局面被回滚、结果不可复现。执行前请：
1. 先取一次 godview（raw）快照并确认 before 字段
2. 在测试分支/影子房间验证回放结果
3. 在同一事务内完成状态更新 + audit_logs 写入，验证结果后 COMMIT，异常则 ROLLBACK
4. 确认没有并行写（其他玩家正在 act）；必要时先把房间置为维护态
5. 通知受影响玩家，并保留 audit 记录用于事后追溯
```

### 3.4 `GET /admin/audit` — 审计检索

查询参数：`targetId`、`actorId`、`action`、`from`、`to`、`limit`（默认 50，上限 500）。

```json
{
  "records": [
    {
      "id": 128,
      "createdAt": "2026-11-26T14:05:20Z",
      "actorUsername": "demo_operator",
      "action": "admin.room.intervene",
      "targetType": "room",
      "targetId": "K7M2QX",
      "before": { "status": "playing" },
      "after": { "status": "ended" },
      "reason": "牌局卡死，人工结束",
      "hash": "9f86d0…",
      "seal": "9f86d0"
    }
  ],
  "nextCursor": null
}
```

**实现**：`idx_audit_logs_target` / `idx_audit_logs_actor` / `idx_audit_logs_action`；`viewer` 角色服务端强制附加 `actor_id = current_admin`，不允许看他人操作。

### 3.5 `POST /admin/world/settings` — 全局设定

```json
// 请求
{
  "key": "maintenance_mode",
  "value": { "enabled": true, "message": "系统维护中" },
  "reason": "紧急修复事件回放缺陷"
}
```

写入 `world_settings` 用 `INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = ..., updated_at = NOW()`（带明确 key，非无 WHERE 的 UPDATE），并在同事务写 `audit_logs(action='admin.world.settings.update', before=旧 value, after=新 value)`。仅 `root` 可调用。

---

## 4. 审计不可篡改方案

### 4.1 append-only

- `audit_logs` 上的 `BEFORE UPDATE OR DELETE` 触发器直接 `RAISE EXCEPTION`（`db/schema.sql` 的 `deny_audit_mutation()`），对表所有者同样生效。
- 纠错只能**追加**一条 compensating 记录（例如 `action='admin.audit.correction'`，`reason` 引用原 `auditId`），不能修改或删除历史。
- 应用层的 DB 角色只授予 `SELECT` / `INSERT`，不授予 `UPDATE` / `DELETE`（GRANT 变更需先在 Neon 分支验证）。

### 4.2 哈希链

- 每条记录：`hash = sha256(prev_hash || '|' || concat_ws('|', created_at, actor_username, action, target_type, target_id, before, after, reason, ip_address, session_id))`，`prev_hash` 为上一条的 `hash`，genesis 为 64 个 `0`。
- `BEFORE INSERT` 触发器计算 hash，`pg_advisory_xact_lock(714624001)` 串行化并发插入，兼容 Neon transaction pooling。
- 校验：按 `id` 顺序重算，找到第一条 `hash` 不匹配即为篡改起点（SQL 见 `DATABASE_DESIGN.md` §4.4）。校验应在只读分支离线执行。
- 局限：若攻击者同时改写全链并持有数据库写权限，链本身无法自证；因此需把**最新 hash 定期外部存证**（日志系统/对象存储，本期为未决项），并把 `audit_logs` 的写权限限定到单一受控应用角色。

### 4.3 每次干预的必填字段

```text
who      = actor_id + actor_username（快照）+ session_id + ip_address
when     = created_at（DB 默认 NOW()，不由客户端提供）
target   = target_type + target_id（房间号 / 玩家 ID / 配置 key）
before   = 干预前状态快照（JSONB）
after    = 干预后状态快照（JSONB）
reason   = 人类可读理由（非空，服务端校验）
```

**强制约束**：`POST /admin/rooms/:id/intervene` 与 `GET .../godview?level=raw` 若没有 `reason`，服务端返回 400，**不执行业务操作**。干预与 audit 写入必须在同一事务，任一步失败整体 ROLLBACK。

---

## 5. 与现有 `POST /api/rooms/:id/abort` 的关系

当前房主强制结束路径（`server/index.mjs:389-400`，`server/room.mjs:115`）：

- 校验 `body.hostToken` 或 `X-Host-Token` 与 `Room.hostToken` 完全相等 → 否则 403。
- 调用 `room.abort(reason)`，产生 `t:'end'` 事件，`winner = {id:'none', name:'强制结束'}`。

管理员路径的关系：

1. **同一业务动作，不同鉴权源**：管理员 `intervene{action:'abort'}` **不需要 hostToken**，用管理员会话 + 角色鉴权；最终复用相同的 `abort()` 语义，保证引擎状态变化一致。
2. **管理员可覆盖房主**：即使房主未授权（如房主 token 丢失、恶意房主拒绝结束），operator/root 都能强制结束。这是「造物主」的定义所决定的能力。
3. **留痕更强**：管理员路径额外写 `audit_logs`（房主路径当前不写审计，迁移后建议也写一条 `room.host.abort` 作为对比），并写 `actions.source='admin'`（若伴随代打）。
4. **事件文本区分**：管理员 abort 发出的 `end` 事件 `text` 标记为「管理员强制结束：{reason}」，房主路径保持原文案，避免玩家混淆。
5. **权限不要下放**：不要把 `hostToken` 存进 `admin_users` 或 godview 响应；管理员永远通过独立会话操作。

---

## 6. 前端入口：造物主后台数据契约

> **状态**：`design/mockups/godview.html` 与 `design/APPLE_FLUID_UI.md` 已按本节契约完成对齐（general-purpose-2 落地），当前为纯前端静态演示（`ROOMS` / `addAudit()` 是本地假数据）。下面给出把它接到真实 API 所需的字段映射与约束。

### 6.1 mockup 区块 → API 字段映射

| mockup 区块 | 对应 API 字段 | 说明 |
|---|---|---|
| 顶部统计条 | `GET /admin/rooms` 的 `stats{activeRooms, agentsPresent, revealsToday, unloggedOps}` | `revealsToday` = 今日 `action='admin.godview.read' AND reason<>''` 且 `visibilityLevel='raw'` 的快照数；`unloggedOps` 正常恒为 0，非 0 即告警 |
| 全局房间列表 | `GET /admin/rooms` 的 `rooms[]` | 每 3s 轮询本接口；搜索同时匹配 `roomId` / `displayCode` / `gameTitle`，筛选按 `uiState` |
| 房间卡 | `roomId` / `displayCode` / `gameTitle` / `uiState` / `filled`+`seats` / `createdAt` | 主显 `displayCode`、副行标 `roomId`；状态映射 `lobby → waiting`，`playing → playing`，`ended → ended` |
| 房间详情公开状态 | `godview.room` + `godview.publicState` | 阶段文案用 `phase`；牌堆数对应 `publicState.table` / `deckLeft`（按 gameType 取） |
| 私有信息揭示 | `GET /admin/rooms/:id/godview?level=masked` → 显式申请 `level=raw&reason=...` | mockup 已改为默认 masked（DOM/JS 不含明文），点击后弹窗填 `reason` 才申请 raw；真实实现由服务端写审计后返回 |
| token 展示 | 不返回 token | 仅展示 `displayCode` 末 4 位；**绝不返回 token 或 token_hash** |
| 干预按钮 | `POST .../intervene` `action=abort/kick/advance-phase` | 二次确认 + `reason` 必填 textarea + 勾选「知悉不可撤销」；后端仍强制校验 `reason` 非空 |
| 审计记录 | `GET /admin/audit` 的 `records[]` + `seal` 字段 | `seal` = `hash` 前 8 位；展示 `action` / `roomId` / `reason`；系统事件 `actorUsername='system'`（`audit_logs.actor_id` 为 NULL） |
| 二次确认弹窗 | 前端交互 | 确认后才发 `POST`；`checkbox` 不能替代后端 `reason` 校验 |

### 6.2 对 UI 的硬性要求

1. `masked` 档不得在 DOM、内存变量或网络面板里出现 `secret.data`、手牌数组、完整 `context`；脱敏必须在**服务端**完成。mockup 已按此修正：锁定态只渲染 `{"redacted":true}`、`handCount`/`diceCount`、截断思考，raw 态只显示「<服务端返回 …>」占位，不内嵌明文。
2. `raw` 档入口：二次确认弹窗 + `reason` 输入 + 审计提示文案（"本次查看将被记录"），按钮点击后才发请求；raw 永不随轮询自动刷新。
3. `players[].playerId` 用 `p0/p1…`（与 `CONTRACT.md` 一致），不要另造 ID；mockup 里的人名（零和、弈者）是示例，真实值来自 `players[].name`。
4. `events[].seq` 与 `thoughts[].seq` 保持 number，前端排序不做字符串比较。
5. 干预按钮按 `role` 与 `room.status` 禁用/启用（后端仍做权威校验，前端只做体验优化）。
6. 3s 轮询只用于 `GET /admin/rooms`；`godview?level=raw` 必须由用户显式触发，禁止放进定时器。

### 6.3 待决策后补的 UI 项

- **房间号格式**：双轨展示（`BT-0417` / `K7M2QX`）已落地；但 `BT-0417` 是否要成为真实 ID 仍未决——若是，需改 `rooms.code` 的 CHECK 与所有路由正则（影响面大，需 team-lead 决策）。
- 思考链面板：当前只有静态私有信息块，没有按 `playerId` 分组的 `thoughts[]` 时间线。
- `rewind` / `force-act` 入口与「双人复核」UI（§7 未决项）。

---

## 7. 安全边界与滥用风险

### 7.1 谁能看私有信息

- `viewer`：**永远不能**看 `secret`、`hand`、`dice`、完整 `context`、完整思考链；只有 `masked` 档。
- `operator`：可在填写 `reason` 且会话新鲜（5 分钟内活跃）时看 `raw`；每次查看都写快照 + 审计。
- `root`：可看 `raw`，仍必须填 `reason`。
- **RLS 只保护行，不保护列**：`room_players.secret` 的行隔离无法阻止同房间玩家互看，公开 API 必须靠投影（只返回 `selfState` 允许的字段）。godview 是唯一允许跨玩家读私有列的入口，因此必须走独立鉴权与审计。
- 任何响应都不得包含 `token_hash`、`password_hash`、`totp_secret_encrypted`、HMAC 密钥。

### 7.2 谁能强行改局

| 动作 | 最低角色 | 说明 |
|---|---|---|
| `abort` / `kick` | operator | 终止对局或移出玩家，影响可控 |
| `rewind` / `force-act` | root | 可改变胜负，必须双人复核（建议） |
| `world_settings` | root | 全局影响，必须审计 |

### 7.3 如何审计与回滚

- 每次读取（尤其 raw）与每次干预都写 `audit_logs`；干预与审计同事务。
- 审计表 append-only + 哈希链；定期外部存证最新 hash（未决项）。
- 回滚**不做** `DELETE`/`UPDATE` 清理：用 Neon PITR/分支恢复到事故前状态，再把事故记录作为审计证据保留。
- `rewind` 本身是业务级回滚：按事件 `seq` 重建状态，但必须把「原状态」写进 `audit_logs.before`，并保留原事件（不删除，只标记）。

### 7.4 滥用风险清单

| 风险 | 场景 | 缓解 |
|---|---|---|
| 批量爬取私有信息 | root/operator 账号遍历所有房间 `raw` | 速率限制（如 20 次/分钟）、单日 raw 配额、异常访问告警 |
| 账号被盗 | 密码泄露 | argon2id + TOTP（root 强制）+ IP 白名单 + 短会话 |
| 会话固定 / CSRF | 跨站触发干预 | `HttpOnly; Secure; SameSite=Strict` Cookie + CSRF token 双提交 + 干预只接受 POST |
| 内部人合谋 | 管理员帮某 agent 作弊 | `force-act` 写 `actions.source='admin'` 且双人复核；所有干预公开可查 |
| 审计被篡改 | 有 DB 写权限的内部人 | append-only 触发器 + 哈希链 + 外部存证 + 最小 GRANT |
| 误操作 | 点错 rewind 目标 | `expectedStatus`/`toSeq` 校验、二次确认、先在影子房演练 |
| 日志泄露 | godview_snapshots 长期留存 raw | 短保留期（建议 raw 7 天）+ 加密存储 + 访问审计 |
| 玩家 token 弱随机 | 原 `Math.random()`（`server/index.mjs:346`） | **已修复**：`server/index.mjs:234、475` 改用 `crypto.randomBytes(32)`；godview 不展示任何 token |

### 7.5 未决项（需 team-lead / UI 负责人确认）

1. **房间号格式**：mockup 的 `BT-0417` 是展示别名还是真实 ID（§6.3）；改真实 ID 会影响 `rooms.code` CHECK 与全部路由正则。
2. `rewind` / `force-act` 是否强制双人复核（本期设计为建议，未实现）。
3. raw 快照保留期（建议 7 天）与加密密钥管理。
4. 审计链最新 hash 的外部存证周期与存储位置。
5. 房主 `abort` 是否也补写 `audit_logs`（建议补，便于对照管理员干预）。
6. 管理员账号的初始引导方式（首个 root 如何安全创建，避免硬编码凭据）。
7. mockup 的「跳到下一阶段」需要引擎暴露阶段推进入口；当前 `GameBase` 没有该 API（需 backend 配合）。

---

## 8. 附：约定

- 所有 SQL 示例遵循关键字大写、4 空格缩进、每子句独占一行、snake_case、字符串单引号。
- 示例中的 `demo_operator`、`agent_001`、`K7M2QX`、`test@example.invalid` 均为虚构脱敏数据；示例 hash 为占位符，不可用于登录。
- 危险操作（`rewind` / `force-act` / 任何 DB 层 DROP/TRUNCATE）必须展示 §3.3 的风险警告模板，并在事务中验证后再提交。
