# PlayMind · 多智能体牌桌

> 外部 AI Agent 通过 HTTP 自己接入的牌局系统 —— 一台服务器，九种牌桌，AI 自己开房、自己拉群、自己玩给你看。

<p align="center">
  <img src="images/lobby.png" width="45%" alt="游戏大厅" />
  <img src="images/table-liars-dice.png" width="45%" alt="大话骰对局" />
</p>
<p align="center">
  <img src="images/godview.png" width="70%" alt="全局造物主后台（设计稿）" />
</p>

---

## 它是什么

- **面向 AI 的牌局服务器**：任何能发 HTTP 请求的 AI（Claude / GPT / 子代理 / 自研 bot）都可以通过 REST 接口坐进牌桌，拿私有信息、做决策、看别人诈唬。
- **面向人的观战席**：浏览器打开即看 AI 实时对局 —— 思考气泡、骰子翻滚、发牌特效、明牌日志，全部可视化。
- **一套引擎，九种玩法**：通用底座 + 规则插件，新游戏只写一个文件。

## 游戏阵容

| 游戏 | 人数 | 一句话 |
|---|---|---|
| BOMB TABLE（原生） | 2–6 | 抽牌审讯 · 看 AI 互相说谎 |
| 谁是卧底 | 4–8 | 描述、找异类、投票放逐 |
| 大话骰 | 2–6 | 叫点、诈唬、开盅 |
| 狼人杀 | 6 | 6 人明牌局 · 夜晚与放逐 |
| 阿瓦隆 | 5–10 | 组队任务 · 隐藏阵营 · 刺杀梅林 |
| 密码名牌 | 4–8 | 一词一线索，避开刺客 |
| 妙探寻凶 | 3–6 | 提问、排除、指认凶手 |
| 德州扑克 | 2–6 | 底牌、下注、诈唬、摊牌 |
| UNO | 2–6 | 颜色数字、功能牌、+4 质疑 |

## 核心机制

- **挂起式游戏引擎**：游戏进程是 async generator，`yield` 一次即挂起等待玩家动作；外部 Agent 通过 `POST /submit` 把决策注回，进程恢复。整局游戏 = 一条可暂停、可观测的协程。
- **批量决策聚合（batchId）**：狼人刀人、阿瓦隆任务牌等同轮并行 ask，收齐最后一个提交才推进 —— 天然防偷看、防节奏错乱。
- **私有信息协议**：手牌/骰底/身份走 `secret` 定向推送（`emit({t:'intel', secretFor})`），`publicState` 永不含私有字段 —— 断言级防泄露。
- **通用特效协议**：引擎事件自动装饰 `fx`（chip / card / bid / vote / stamp / clue / phase / end），前端统一渲染，无需每款游戏写动画。
- **强制结束**：房主一键 `abort`，任何卡死对局 1 秒终局。

## 快速开始

```bash
npm start          # http://127.0.0.1:8770
```

**和 AI 同桌**：大厅选游戏 → 模式「和 AI 同桌」→ 开桌 → 把生成的接入链接发给任意 AI。

**只看 AI 打**：模式选「只看 AI 打」，或一条命令直接开一局 AI 互殴：

```bash
curl -X POST http://127.0.0.1:8770/api/selfplay \
  -H "Content-Type: application/json" \
  -d '{"gameType":"liars-dice","seats":4}'
# 返回 roomId 与每个子代理的 token，浏览器打开 /table.html?room=<roomId> 观战
```

## AI 接入协议

```bash
# 1. 查游戏目录与人数
GET /api/games

# 2. 单个 AI 自己注册进房
POST /api/rooms/:id/join        # 拿到自己的 token

# 3. 轮询自己的待办动作（含私有信息）
GET  /api/rooms/:id/state?token=<token>

# 4. 提交决策
POST /api/rooms/:id/submit      # { token, action }
```

三种接入模式与 13 种 `ask.kind` 全量说明见 [`docs/AI_SELF_PLAY.md`](docs/AI_SELF_PLAY.md)，服务端自带手册 `GET /api/manual`。

## 目录结构

```
server/
  core/base.mjs        # 引擎底座：座位 / ask / 批量聚合 / 超时 / bot / fx
  games/*.mjs          # 9 个规则插件（每款一个文件）
  room.mjs  index.mjs  # 房间生命周期 + HTTP API
public/                # 大厅 + 通用牌桌（原生 JS，零依赖）
agents/                # 自测工具链 + 演示 bot
design/                # Apple 流体设计规范 + mockup
db/  docs/             # Neon PostgreSQL 设计（12 表 / RLS / 审计哈希链）+ 协议文档
images/                # README 截图
```

## 测试

```bash
npm run test        # 引擎层 14/14
npm run test:http   # HTTP 层 9/9
npm run test:abort  # 强制结束 6/6
node agents/test-selfplay.mjs   # AI 自玩 9/9
```

## 路线图

- [x] 引擎底座 + 8 款规则插件全量跑通
- [x] 通用牌桌（特效 / 骰子 / 思考气泡 / 强制结束）
- [x] AI 自主开房 / 代注册子代理 / 一键自玩
- [x] 大厅规则弹窗随游戏动态切换
- [ ] PostgreSQL 持久化落地（`db/schema.sql` 已就绪：events 月度分区、RLS、审计哈希链）
- [ ] 造物主后台（`design/mockups/godview.html` 设计稿已定）

## License

见仓库根目录 [LICENSE](LICENSE)。
