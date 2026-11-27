# Vercel + Neon 迁移规格（v4）— subagent 共享契约

> 本文件是本轮重构的唯一规格源。三个 subagent（backend / frontend / deploy）都以此为准。
> 旧实现全部在 `legacy/`（只读参考，不修改）；新代码只写在 `app/`、`lib/`、`db/`、根目录配置。

## 0. 目标

1. 前端与 API 全面迁移到 **Next.js 15 App Router（JavaScript，非 TypeScript）**，可零改动部署 Vercel
2. 数据持久化落地 **Neon PostgreSQL**（`db/schema.sql` 已定稿：12 表、events 月度分区、RLS、审计哈希链）
3. 造物主后台落地（`design/mockups/godview.html` 设计稿 → 真实页面 + 后门管理员登录）
4. **API 路径与响应结构对 CONTRACT v3 全兼容** —— AI 接入方无感迁移

## 1. 目录结构（最终态）

```
app/                        # Next.js App Router
  page.mjs                  # 大厅
  table/[id]/page.mjs       # 牌桌（观战+人类操作）
  godview/page.mjs          # 造物主后台（含登录）
  join/[id]/route.mjs       # AI 接入说明书 markdown（CONTRACT 2.2）
  api/...                   # 全部 REST API（§3）
lib/
  engine/                   # 引擎（从 legacy/server/core/base.mjs + room.mjs 改造）
    base.mjs                # GameBase：seeded RNG + 重放 + 可序列化
    registry.mjs            # 9 款游戏注册表（从 legacy/server/games/index.mjs 迁移）
    games/*.mjs             # 9 款插件（从 legacy/server/games 迁移，仅改 RNG 调用）
    roomStore.mjs           # 事件溯源：加载/重放/持久化（§2 核心设计）
    brief-kit.mjs           # 从 legacy/server/core/brief-kit.mjs 原样迁移
  db/
    index.mjs               # 数据访问层：双模式（§4）
    memoryStore.mjs         # 无 DATABASE_URL 时的内存实现（本地开发/测试）
  auth.mjs                  # HMAC token 工具 + admin 会话
  brand.mjs                 # 从 legacy/server/pitch.mjs 或 brands.js 需要的部分迁移
legacy/                     # 旧实现（只读参考）
db/schema.sql               # 已定稿，不修改
design/tokens.css           # 纸墨设计 token（前端移植用）
design/mockups/*.html       # 视觉参照
vercel.json  .env.example   # deploy agent 负责
```

## 2. 引擎 serverless 化 —— 事件溯源重放（backend agent 核心）

### 2.1 问题
挂起式 async generator 驻留内存，serverless 无常驻进程。

### 2.2 方案：重放（replay）
- **事实源 = DB**：`actions` 表存每个 accepted action（含 thought/say/source），`events` 表存每个 emit 的事件（seq 房间内单调递增）
- **冷恢复**：`loadRoom(code)` → 读 rooms.state（元数据）+ 按 seq 读全部 accepted actions → 新建引擎实例（setup）→ 依序重放 actions（直接注入 submit，跳过等待）→ 引擎推进到当前挂起点 → 返回 {room, pendingAsks}
- **确定性**：所有随机操作（洗牌/摇骰/暗牌抽选）必须用 **seeded RNG**：`lib/engine/base.mjs` 提供 `this.rng()`，内部 mulberry32；seed = `roomId:actionSeq:callIndex`（action 处理器内第几次随机调用），由 GameBase 自动维护计数并在 action 执行前重置 → 重放结果与首次完全一致。**9 款插件里的 `Math.random` 全部替换为 `this.rng()`**（这是插件唯一允许的改动）
- **新动作到达**：loadRoom（重放）→ 校验 action 与当前挂起 ask 匹配（validate）→ 注入 → pump 推进到下一挂起点 → 新产生的事件与 action 写回 DB → 返回
- **拒绝的 action 不落库**（与现在一致：同 ask 可重试），只有 accepted 才 append
- **batchId 聚合保持**：同批未收齐不推进（重放时同样按批聚合，语义与 legacy/server/core/base.mjs `submit()` 一致）

### 2.3 超时与 bot
- 挂起点把 `pending = {asks:[{playerId,batchId,kind,deadline}]}` 序列化进 rooms.state
- **惰性检查**：任何请求 loadRoom 后若 `now > deadline` → 对超时 ask 注入 `{source:'timeout'}`（走插件 botAct/autoAct 兜底）→ 推进
- **Cron 兜底**：`GET/POST /api/cron/tick`（vercel.json 每分钟触发）扫描 status=playing 且有过期 deadline 的房间，逐个 loadRoom+推进

### 2.4 前端事件流
- 废弃 SSE；牌桌/观战改 **1s 轮询** `GET /api/rooms/:id/events?since=<seq>&token=<可选>`，返回 `{events:[{seq,type,payload,text,fx,secretFor}], state}`（token 存在时附带定向 secret 事件）
- `rooms.state` 存最新 PublicState 热快照（读优化），事件为准

## 3. API 清单（route handlers，路径全兼容 CONTRACT v3）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/games | 游戏目录 |
| GET | /api/games/[type]/rules | 规则 markdown（从插件 brief 抽「规则」段） |
| POST | /api/rooms | 建房（gameType/seats/mode/humanName/askTimeoutMs）|
| GET | /api/rooms/[id] | PublicState（热快照） |
| POST | /api/rooms/[id]/join | 注册（name/style）→ token |
| POST | /api/rooms/[id]/start | 开局（hostToken）|
| POST | /api/rooms/[id]/agents | 房主代注册子代理（数组）→ 各自 token |
| POST | /api/rooms/[id]/abort | 强制结束（hostToken + reason）|
| GET | /api/agent/[id]/[token] | 玩家轮询：{you, ask, state, hint} |
| POST | /api/agent/[id]/[token]/think | 思考分段（thoughts 表）|
| POST | /api/agent/[id]/[token]/act | 提交决策（thought/say/action）|
| GET | /api/rooms/[id]/events | 增量事件轮询（§2.4）|
| POST | /api/selfplay | 一键 AI 自建房自玩 |
| GET | /api/manual | Markdown 手册 |
| GET | /api/ai/capabilities | 能力清单 JSON |
| GET/POST | /api/cron/tick | 超时兜底 |
| POST | /api/admin/login | 后门登录（bcryptjs 校验 admin_users；首次无用户时从 env ADMIN_USERNAME/ADMIN_PASSWORD bootstrap）|
| GET | /api/admin/rooms | 全局房间列表（masked）|
| GET | /api/admin/rooms/[id]/godview?level=masked|raw | 详情（masked/raw 双轨，raw 需 reason，写 godview_snapshots + audit_logs）|
| POST | /api/admin/rooms/[id]/intervene | 干预（abort/force-act/advance，root，必填 reason，写审计）|
| GET | /api/admin/audit | 审计流水 |
| GET | /join/[id] | AI 接入说明书（markdown，renderBrief 生成）|

鉴权：玩家/host token 为高熵随机（crypto.randomBytes(32)），DB 只存 HMAC-SHA256 hash（TOKEN_SECRET env）；admin session token 同理。RLS claim 在每个事务 `SET LOCAL app.is_admin / app.current_player_id / app.current_room_id`。

**响应结构与错误码以 legacy/server/index.mjs 现实现为准（逐条对照迁移）。**

## 4. 数据层双模式（lib/db/index.mjs）

```js
// DATABASE_URL 存在 → Neon（@neondatabase/serverless 的 neon() + sql 模板）
// 不存在 → memoryStore（lib/db/memoryStore.mjs，Map 实现同接口；建表语义对齐 schema 字段名）
export const db = ...   // 统一接口：query(sql, params) / tx(fn)
```
- memoryStore 不必实现 RLS/哈希链/分区，只需字段与语义对齐（token 也存 hash，保证代码路径一致）
- Neon driver：`import { neon } from '@neondatabase/serverless'`；事务用 `neon(dbUrl).transaction()` 或拆单条（Neon HTTP driver 无真事务时，审计哈希链在应用层用 `pg_advisory_xact_lock` 等价的顺序保证：同一房间写操作串行化由 roomStore 内存互斥 + DB 行级 SELECT FOR UPDATE 兜底）

## 5. 前端（frontend agent）

- **零 UI 框架依赖**（不引 Tailwind/MUI），全局样式 = `design/tokens.css` 移植进 `app/globals.css` + 纸墨风（参照 legacy/public/styles.css、design/mockups/*.html 的视觉）
- 三个页面：
  1. `/` 大厅：游戏类型下拉（动态 /api/games）、模式（和 AI 同桌/只看 AI 打）、座位数、开桌 → 跳牌桌；规则弹窗随游戏切换（/api/games/[type]/rules）；底部 AGENT 入口
  2. `/table/[id]` 牌桌：三栏（座位/牌局/公开记录）；1s 轮询 events 增量 + state；思考气泡打字机、骰子翻滚、8 类 fx 特效（对齐 legacy/public/table.js 的 #fx-stage 协议：chip/card/bid/vote/stamp/clue/phase/end）；人类玩家有 token 时可操作（act 按钮组）；房主 abort 按钮
  3. `/godview` 造物主后台：登录表单 → 统计卡（活跃房间/在线 AI/今日揭示/未审计操作）→ 房间列表（搜索/按游戏/按状态筛选）→ 房间详情（公开状态 + masked/raw 私有揭示（raw 必填 reason 二次确认 modal）+ 强制干预按钮）→ 审计流水表
- token 存 localStorage（键兼容 legacy 的 `bt_token_<room>`）

## 6. deploy agent 交付

- `package.json`（根）：Next.js 15 + react 19 + @neondatabase/serverless + bcryptjs；scripts：`dev/build/start`、`db:migrate`、`test`（新冒烟）、`legacy:*`（指向 legacy 的旧脚本，仅供参考）
- `next.config.mjs`（最小）、`jsconfig.json`（`@/*` → `./`）
- `vercel.json`：crons 每分钟 `GET /api/cron/tick`
- `.env.example`：DATABASE_URL / TOKEN_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD
- `db/migrate.mjs`：读 schema.sql 按 `;` 分段经 Neon driver 执行（跳过已存在对象报错），`npm run db:migrate`
- `README.md` 更新：部署 Vercel 步骤、Neon 建库 + migrate、环境变量表
- 冒烟测试 `lib/__tests__/smoke.mjs`（node 直跑，非 jest）：内存模式下建 BOMB TABLE 房 → join → start → agent 轮询 → act（draw）→ 读 events 增量 → abort；断言全程 200 与状态流转。**验证方式：`npm run build` 必须零错误 + smoke 通过**（dev server 用 `next build && next start -p 8790` 后跑 smoke，测完杀进程）

## 7. 验收标准（全部满足才算完成）

1. `npm run build` 零错误
2. 内存模式 smoke：建房→对局→事件轮询→abort 全流程通过（等价 legacy 的 HTTP 9/9 场景）
3. API 路径与响应字段与 CONTRACT v3 一致（对照 legacy/server/index.mjs）
4. 9 款插件 RNG 替换后重放确定性：同一 action 序列重放两次，公开状态哈希一致
5. godview：登录 → masked/raw → 干预 → 审计流水闭环（内存模式）
6. 无 UI 框架依赖；三个页面视觉对齐 design/mockups 与 legacy 纸墨风
