# 多游戏玩法与实现执行手册

> 状态：提案 v0.1。本文件定义 8 款游戏的**规则锁定版**与**引擎映射**，落地前须同步修改 `CONTRACT.md`（v2 → v3）。
> 规则基线：全部采用基础规则；村规、扩展角色、计分模式不进核心。同一款游戏只保留一种判定口径，避免 agent 学到多套规则。
> 现有代码事实：`engine.mjs` 把 BOMB TABLE 规则写死在 `drive/drawPhase/resolveCard`；`seats` 上限 6；`secret` 固定为 `{topCard}`。这三点必须先改。

---

## 0. 共用底座（前置任务，不得跳过）

### 0.1 目标

把「房间 / 轮询 / ask 挂起 / 超时 / 思考链 / SSE / bot 填座」留在公共层，把「玩法」做成规则插件。新增游戏只写插件，不改 HTTP 与前端。

### 0.2 规则插件接口

| 方法 | 职责 | 现有对应 |
|---|---|---|
| `start()` | 发身份、发牌、初始化私有状态 | `Game.start` |
| `async *drive()` | 主循环，产出事件与 `askFor` | `Game.drive` |
| `publicState()` | 全场可见状态 | `Game.publicState` |
| `selfState(p)` | 仅本人可见（身份 / 手牌 / 线索） | `Game.selfState` |
| `validate(ask, act, game)` | action 合法性 | `validateAction` |
| `autoAction(ask)` | 超时保守代打 | `autoAction` |
| `botThought/botAction` | 内置 bot 决策与投屏 | 同名函数 |
| `brief(room, baseUrl)` | `/join/:id` 的规则说明 | `server/brief.mjs` |

公共层新增：房间 `POST /api/rooms` 接受 `gameType`，默认 `bomb-table`；按 `gameType` 构造引擎；`joinUrl` 指向的动态 brief 由插件提供。

### 0.3 状态与私有信息

- `PublicState` 增加 `phase`（如 `night/day/vote/showdown`）、`round`、`pot`、`board`（可选）、`publicCards`（可选）。
- `PlayerSelf.secret` 由 `{topCard}` 升级为通用结构：

```json
{ "kind": "word" | "hand" | "role" | "keycard" | "dice" | "cards", "data": {} }
```

- 私有信息只通过 `selfState(p)` 与 `ask.context` 下发；`emit` 事件里禁止夹带他人私有数据，只有 `secretFor` 指定玩家可见。
- 玩家通用字段新增 `role`、`team`、`chips`、`hand`、`dice`、`folded`，按游戏选用，不用的留空。

### 0.4 ask 类型扩展（v2 的 5 种保留）

| 新 kind | payload | 合法 action | 用途 |
|---|---|---|---|
| `free` | `{"prompt":"..."}` | `{"type":"text","text":"..."}` | 描述、发言、线索词 |
| `multi-pick` | `{"candidates":[],"min":1,"max":2}` | `{"type":"pick-many","ids":[]}` | 阿瓦隆组队 |
| `vote` | `{"candidates":[],"allowAbstain":false}` | `{"type":"vote","targetId":"p2"}` / `{"type":"vote","approve":true}` | 放逐 / 表决 |
| `bet` | `{"min":20,"max":200,"legal":["fold","check","call","raise","allin"]}` | `{"type":"bet","move":"raise","amount":60}` | 德州扑克 |
| `play-card` | `{"hand":[],"top":{},"legal":[]}` | `{"type":"play","cardId":"c7"}` / `{"type":"draw"}` | UNO |
| `challenge` | `{"claimerId":"p1","claim":{}}` | `{"type":"challenge","accept":true}` | +4 质疑 |
| `declare` | `{"fields":["word","number"]}` | `{"type":"declare","word":"海","number":2}` | 密码名牌线索 / 指认三元组 |
| `confirm` | `{"prompt":"..."}` | `{"type":"confirm","use":true}` | 技能是否发动 |

统一约定：`say` 仍为「说出口的话」，`thought` 为思考链片段，二者与 `action` 正交，任何 ask 都可携带。

### 0.5 底座验收

1. `bomb-table` 原有流程、HTTP、SSE、bot 全部回归通过（改造范围控制：先跑旧用例）。
2. `gameType` 无效返回 400；不同房间可同时跑不同游戏，互不干扰。
3. `/join/:id` 能按 `gameType` 输出对应规则，含完整 curl 示例。
4. 任意玩家的 `selfState` 不含他人私有字段；全员 `publicState` 快照一致。

---

## 1. 谁是卧底（Spyfall / 谁是卧底）

### 定位
4–8 人（引擎范围 2–6 时先做 4–6），单局 5–10 分钟。语言描述 + 投票找异类。改造量最小，作为插件架构的首个验证游戏。

### 规则（锁定版）
1. 准备一对相近词（平民词 / 卧底词），按人数分配卧底：3–5 人 1 卧底，6–8 人 2 卧底。
2. 每人私下收到自己的词，只有自己可见。本版不开「白板」。
3. 每轮从首位玩家开始，每人用一句话描述自己的词。约束：不得说出词中任一字；不得描述明显虚假的内容；不得复述他人描述。
4. 全员描述完，投票指认卧底。得票唯一且最高者出局并公开身份；平票本轮无人出局。
5. 卧底全部出局 → 平民胜；存活卧底数 ≥ 存活平民数 → 卧底胜。

### 私有信息
`secret: {kind:"word", data:{word:"豆浆", isSpy:true}}`。卧底只知道自己的词，不知道平民词。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 描述 | `free` | `{"type":"text","text":"圆圆的，早上常见"}` |
| 投票 | `vote` | `{"type":"vote","targetId":"p3"}` |

### 新增数据与改造点
- `data.mjs` 增词库表 `WORD_PAIRS`（成对词），按局随机。
- 引擎增 `eliminate(p)` 与身份公开事件 `reveal`。
- `say` 直接作为描述文本投屏；投票结果公开。

### 验收
- 6 人 2 卧底可完整跑到胜负；平票不淘汰。
- AI 描述含禁字时服务端不自动判罚（本版只记录，不自动判违规），但 brief 必须写清禁字规则。

---

## 2. 大话骰（Liar's Dice / 大话骰）

### 定位
2–6 人，每人 5 颗六面骰，单局 5–15 分钟。叫点 + 质疑 + 开盅。与现有 `answer`(说谎) / `verdict`(质疑) / `truth`(揭晓) 契约高度同构。

### 规则（锁定版）
1. 所有人摇骰，只看自己的 5 颗，不公开。全场骰数 = 人数 × 5。
2. 首叫喊 `X个Y`，X ≥ 玩家人数（如 4 人起叫 4 个）。后续叫点必须「数量变大」或「数量相同且点数变大」。
3. `非斋`：1 为百搭，可算任意点数；`斋`：1 只算 1。当轮口径随叫点声明。首叫默认非斋。
4. 轮到下家时二选一：加码叫点，或质疑（`开`）上家。
5. 开盅统计：实际数量 ≥ 上家叫点 → 质疑者输；实际数量 < 上家叫点 → 叫点者输。
6. 输者掉 1 颗骰，下一局由输者先叫；骰子归零淘汰，最后存活者胜。
7. 本版不启用围骰加倍、劈、投降、天黑黑。

### 私有信息
`secret: {kind:"dice", data:[3,3,1,5,2]}`。只下发本人骰面。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 叫点 | `declare` | `{"type":"declare","count":5,"face":3,"wild":true}` |
| 质疑 | `confirm` | `{"type":"confirm","use":true}`（true=开盅；false=继续加码） |

### 新增数据与改造点
- 公共状态增 `currentBid:{count,face,wild}`、`diceLeft`；事件增 `bid`、`open`（只广播统计结果）。
- 开盅结算先算 `1` 的百搭规则再判定；输家扣骰，重摇。
- bot 决策用二项分布估算 `P(实际 >= 叫点)`，低于阈值则开盅。

### 验收
- 4 人局能走到有人淘汰；`count=5,face=3,wild=false` 时 1 不计入。
- 非法叫点（数量减少、同数量点数变小）返回 400，同一 ask 可重试。

---

## 3. 狼人杀（Werewolf）

### 定位
6 人明牌局：2 狼人 + 预言家 + 猎人 + 2 平民。单局 10–20 分钟。**阶段机分水岭**，后续阿瓦隆复用同一套 phase 切换。

### 规则（锁定版）
1. 开局随机分配身份，狼人互相知晓同伴；其余玩家只知道自己的身份。
2. 夜晚顺序：狼人共同选择 1 名目标击杀 → 预言家查验 1 名玩家阵营（好/狼）→ 天亮。
3. 白天：公布死亡信息 → 存活玩家依次发言 → 全员投票，得票唯一且最高者放逐 → 被放逐者遗言。
4. 猎人被狼人击杀或被投票放逐时，可开枪带走 1 名存活玩家；被毒杀不可开枪（本版无女巫）。
5. 狼人全部出局 → 好人胜；好人全部出局 → 狼人胜（屠城版）。
6. 首夜死亡有遗言，之后夜晚死亡无遗言。平票无人放逐。

### 私有信息
- 狼人：`secret:{kind:"role", data:{role:"wolf", allies:["p3"]}}`
- 预言家：`secret:{kind:"role", data:{role:"seer"}}`，查验结果通过 `ask.context` 单独下发。
- 猎人：`secret:{kind:"role", data:{role:"hunter"}}`。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 夜·刀人 | `vote` | `{"type":"vote","targetId":"p0"}`（ wolves 各自提交，多数决；平分随机） |
| 夜·查验 | `vote` | `{"type":"vote","targetId":"p1"}` |
| 白天发言 | `free` | `{"type":"text","text":"我昨晚看到 3 号动过"}` |
| 放逐投票 | `vote` | `{"type":"vote","targetId":"p2"}` |
| 猎人开枪 | `confirm` + `vote` | 先问是否发动，再选目标 |

### 新增数据与改造点
- `phase` 机：`night-wolf → night-seer → dawn → speech → vote → lastword → night`，用 `drive()` 顺序 `yield`。
- 玩家增 `role/team/allies/revealed`；夜晚事件只对对应角色可见。
- 并行夜间动作：狼人各投一票，聚合后再推进预言家；超时按 `autoAction` 随机存活目标。
- 发言用现有 `askTimeoutMs`；本版不设独立发言倒计时。

### 验收
- 6 人局跑通至少 3 个昼夜；预言家查验结果不出现在 `publicState`。
- 猎人被放逐后能开枪；狼人全灭即结束。

---

## 4. 阿瓦隆（The Resistance: Avalon）

### 定位
5–10 人（引擎 `seats` 上限须从 6 放宽到 10），单局 15–30 分钟。无出局淘汰，靠组队、任务与刺杀定胜负。

### 规则（锁定版）
1. 阵营：好人（梅林、派西维尔、忠臣）与坏人（莫甘娜、刺客、爪牙）。梅林开局可见所有坏人，但看不见莫德雷德（本版不含莫德雷德）。
2. 每轮由当前队长选队员，人数按表：5人[2,3,2,3,3]、6人[2,3,4,3,4]、7人[2,3,3,4,4]、8人[3,4,4,5,5]。
3. 全员对队伍投票，赞成过半通过；平票/反对过半则否决，队长顺时针传给下一人。累计 5 次否决 → 坏人直接胜。
4. 队员秘密提交任务牌：好人只能成功；坏人可成功（伪装）或失败。出现至少 1 张失败牌 → 任务失败（7 人及以上第 4 轮需 2 张）。任务结果只公布成功/失败，不公布失败票数量。
5. 先完成 3 次任务的一方：坏人达到 3 次失败直接胜；好人达到 3 次成功进入刺杀阶段。
6. 刺客指认 1 人：命中梅林 → 坏人胜；否则好人胜。

### 私有信息
- 梅林：`secret:{kind:"role", data:{role:"merlin", evilIds:[]}}`
- 坏人：`secret:{kind:"role", data:{role:"assassin", evilIds:[]}}`
- 派西维尔：可见梅林与莫甘娜二人但分不清谁是谁（本版可选，建议实现以体现信息差）。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 组队 | `multi-pick` | `{"type":"pick-many","ids":["p1","p2"]}` |
| 表决 | `vote` | `{"type":"vote","approve":true}` |
| 任务出牌 | `confirm` | `{"type":"confirm","use":true}`（true=失败票，仅坏人可选） |
| 刺杀 | `vote` | `{"type":"vote","targetId":"p4"}` |

### 新增数据与改造点
- 公共状态增 `missionIdx`、`leaderId`、`teamProposed`、`votesFailCount`、`missions:["success","fail"]`。
- 任务牌提交必须**同时**到达：先挂起所有队员的 `confirm`，收齐后统一揭晓；服务端不得先到先暴露。
- 5 次否决、任务计数、刺杀三个终局分支单独测试。

### 验收
- 8 人局 5 轮任务表正确；否决 5 次坏人胜；刺杀梅林反转胜。
- 队员任务选择不出现在 `publicState` 与 SSE 事件流。

---

## 5. 密码名牌（Codenames / 行动代号）

### 定位
4–8 人分两队，每队 1 名队长（spymaster）+ 猜手，单局约 15 分钟。核心是「一个词 + 一个数字」的线索协商与踩雷风险。

### 规则（锁定版）
1. 桌面摆 25 张词卡（5×5）：先手队 9 张、后手队 8 张、中立 7 张、刺客 1 张。
2. 两名队长共享关键卡，可见每张词卡的归属；猜手只看到词，不知道归属。
3. 队长回合给出一个线索：一个词 + 一个数字 N，N 表示与该词相关的己方卡数量。禁止谐音、位置、拼写线索。
4. 猜手逐张猜，最多可猜 N+1 次（最后一次为额外猜测）。猜中己方卡可继续猜；猜中对方卡或中立卡立即结束本轮；猜中刺客立即判负。
5. 一方猜完所有己方卡即胜。

### 私有信息
- 队长：`secret:{kind:"keycard", data:{"词A":"red","词B":"blue","词C":"neutral","词D":"assassin"}}`
- 猜手：`secret:null`（只看公共词表）。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 给线索 | `declare` | `{"type":"declare","word":"海洋","number":2}` |
| 猜词 | `vote` | `{"type":"vote","cardId":"w12"}` |

### 新增数据与改造点
- 公共状态增 `words:[25]`、`revealed:{cardId:team}`、`turnTeam`、`clue:{word,number,guessesLeft}`。
- `drive()` 内层循环：队长给线索 → 最多 N+1 次猜词 → 结算切换队伍。
- 服务端校验线索词不得包含词卡原文（防作弊）；无脑力判定语义相关性，靠玩家自律。
- 词库从中文词表随机抽 25 张并随机分配身份。

### 验收
- 猜中刺客立即终局；猜错归属切队；N+1 次限制生效。
- 猜手轮询拿不到关键卡，SSE 不泄露未翻开卡的归属。

---

## 6. 妙探寻凶（Cluedo）

### 定位
3–6 人，单局 20–40 分钟。用「提问 + 私下展示一张牌」的排除法推理凶手、凶器、房间。棋盘是可选层，**第一版砍掉移动与骰子**，只保留推理核心。

### 规则（锁定版）
1. 21 张线索牌：6 嫌疑人、6 凶器、9 房间。各抽 1 张放入信封（答案），其余分发给玩家。
2. 轮到玩家时提出「假设」：嫌疑人 + 凶器 + 房间（本版房间任选，不要求棋子位置）。
3. 从下家开始顺时针，第一个持有假设中任一牌的玩家，**私下**展示其中一张给提问者看；其他人看不到展示内容。
4. 没人能展示时，提问者可选择结束回合或立即「指控」。
5. 指控：指定嫌疑人 + 凶器 + 房间，全局仅 1 次。三张全对则胜；错则出局（仍须配合展示牌）。

### 私有信息
- 每人手牌：`secret:{kind:"cards", data:["plum","rope","kitchen"]}`
- 答案信封：任何玩家可见不到。

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 假设 | `declare` | `{"type":"declare","suspect":"plum","weapon":"rope","room":"library"}` |
| 展示 | `multi-pick`（私有候选） | 服务端自动选牌更稳妥；`secretFor` 推给提问者 |
| 指控 | `declare` | `{"type":"declare","suspect":"green","weapon":"knife","room":"kitchen"}` |

### 新增数据与改造点
- 公共状态增 `suggestions:[]`、`accused:[]`；展示事件用 `intel` + `secretFor` 定向推送。
- 显示牌选择：服务端固定按手牌顺序取第一张符合条件的牌，避免 agent 靠展示顺序读心。
- 不支持重复指控；错误指控后 `alive=false` 但保留展示义务。

### 验收
- 3 人局能完成发牌、假设、定向展示、指控全流程。
- 提问者收到的展示牌不出现在公共日志；错指控后不可再指控。

---

## 7. 德州扑克（Texas Hold'em）

### 定位
2–6 人（引擎上限），单局 5–15 分钟。改造量最大：需要筹码、下注轮、牌力评估。**纯计分，禁止任何现金属性。**

### 规则（锁定版）
1. 52 张牌去大小王。每人 2 张底牌，仅自己可见。每局按钮顺时针轮转，按钮左一位小盲（0.5 BB）、再左一位大盲（1 BB）。本版固定盲注 10/20，不加盲注上涨。
2. 四轮下注：翻牌前（preflop）、翻牌（flop，3 张公共牌）、转牌（turn，第 4 张）、河牌（river，第 5 张）。每轮前烧 1 张牌。
3. 动作：`fold` 弃牌、`check` 过牌（无人下注时可用）、`call` 跟注、`bet/raise` 下注/加注、`allin` 全下。一轮结束条件：所有未弃牌玩家投入额相等。
4. 摊牌：从 2 底牌 + 5 公共牌中选最好的 5 张。牌型由大到小：皇家同花顺 > 同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌。同型比点数，再比踢脚；完全相同平分底池。
5. 只剩 1 名未弃牌玩家时直接获胜，不必摊牌。

### 私有信息
`secret:{kind:"cards", data:[{"s":"h","r":"A"},{"s":"c","r":"9"}]}`

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 下注 | `bet` | `{"type":"bet","move":"raise","amount":60}`；`move` ∈ fold/check/call/raise/allin |

### 新增数据与改造点
- 公共状态增 `pot`、`currentBet`、`buttonId`、`board:[5]`、`street`、`stacks`。
- 需要先实现正确的「行动权轮转 + 加注重开一圈」逻辑；这是最容易写错的地方，单独写状态机测试。
- 边池（all-in 分池）第一版不做：全下时按短码上限封顶，剩余退还。
- `say` 用于诈唬台词，`thought` 投屏推理，正好复用现有思考链。

### 验收
- 3 人局走完 4 轮下注与摊牌；牌型比较覆盖同型比踢脚。
- 弃牌后立即不再收到 ask；玩家筹码归零后出局。

---

## 8. UNO

### 定位
2–6 人，单局 10–20 分钟。私有手牌 + 出牌 + +4 质疑，天然复用 `play-card / challenge / truth`。

### 规则（锁定版）
1. 108 张牌：四色 0–9、跳过、反转、+2 各一套，万能牌 Wild 与 Wild+4 各 4 张。每人 7 张，翻 1 张数字牌开局，庄家左一位先出。
2. 每回合出 1 张：颜色、数字或功能与弃牌堆顶相同即可；万能牌任意可出。无可出牌则抽 1 张，可立即打出或保留。
3. 功能牌：跳过（下家停一轮）、反转（改变方向，2 人局视同跳过）、+2（下家罚抽 2 张并停一轮）。
4. Wild 由出牌者指定后续颜色；Wild+4 仅当手中**没有**与顶牌同色的牌时合法（万能牌不计入同色），下家可选择接受罚抽 4 张并停一轮，或质疑。
5. 质疑：出牌者公开手牌验证。合法 → 质疑者抽 6 张并停一轮；违规 → 出牌者抽 4 张，+4 作废，下家按原顶牌继续。
6. 打出倒数第 2 张牌时须喊「UNO」，用 `say` 字段承载；未喊且被指出罚抽 2 张（本版由服务端在 `say` 缺失时提示，不做自动惩罚）。
7. 先出完手牌者胜；牌堆用尽时洗弃牌堆（保留顶牌）继续。

### 私有信息
`secret:{kind:"hand", data:["r3","b7","skip-y","wild+4"]}`

### ask / action 映射

| 阶段 | ask.kind | action |
|---|---|---|
| 出牌 | `play-card` | `{"type":"play","cardId":"c3"}` 或 `{"type":"draw"}` |
| 指定颜色 | `declare` | `{"type":"declare","color":"red"}` |
| +4 质疑 | `challenge` | `{"type":"challenge","accept":true}` |

### 新增数据与改造点
- 公共状态增 `topCard`、`drawPileLeft`、`direction`、`currentColor`、`handsCount`、`unoCalled`。
- 事件增 `play`、`draw`、`color`、`penalty`。
- `+2` 连锁本版不做（第一版逐张结算），减少状态机复杂度。
- 2 人局反转按「跳过」处理，写进 brief。

### 验收
- 6 人局能出完手牌分胜负；颜色声明后必须匹配新颜色。
- +4 质疑两种结果都正确罚抽；私牌不出现在 `publicState`。

---

## 9. 实施排期与风险

| 批次 | 游戏 | 前置 | 说明 |
|---|---|---|---|
| P0 | 底座抽象 | — | 抽 `Game` 基类 + 规则插件 + `gameType` + secret 升级；旧游戏回归 |
| P1 | 谁是卧底、大话骰 | P0 | 几乎只换规则与词库；验证插件接口是否够用 |
| P2 | 狼人杀 | P1 | 首个阶段机；跑通后阿瓦隆可直接复用 |
| P3 | 阿瓦隆、密码名牌 | P2 | `seats` 放宽到 10；多人同时提交与定向私有信息 |
| P4 | 妙探寻凶、UNO | P3 | 定向展示与持久手牌状态 |
| P5 | 德州扑克 | P4 | 下注状态机 + 牌力评估，复杂度最高 |

主要风险：
- **规则变体冲突**：村规差异大。每款游戏开头已锁定版本，brief 必须与本文一致，否则 AI 学到的是另一套规则。
- **私有信息泄露**：`emit` 与 `publicState` 是两条最易漏数据的通道，需写断言测试。
- **并行 ask**：阿瓦隆任务牌、狼人杀狼人刀人需要多人同时提交，现有 `this.ask` 单槽不够，公共层须支持 `asks: Ask[]` 或临时聚合器。
- **`askTimeoutMs` 全局值**：狼人杀发言、德州下注的合理超时不同，房间可覆盖，但本版先沿用统一值。

---

## 10. 规则来源

| 游戏 | 来源 |
|---|---|
| 谁是卧底 | 搜狗百科《谁是卧底》、Who is Spy 规则页、卧底游戏规则 FAQ |
| 大话骰 | 百度百科《大话骰》、Wikiwand《大話骰》、PartyGameLab 规则页 |
| 狼人杀 | 网易狼人杀官方规则页、狼人杀 Wiki、12 人标准局规则整理 |
| 阿瓦隆 | 百度百科《阿瓦隆》、搜狗百科《阿瓦隆》、Avalon Game 中文规则指南 |
| 密码名牌 | Czech Games Edition 官方规则页与中文规则 PDF、百度百科《行动代号》 |
| 妙探寻凶 | Hasbro Clue 官方说明书（1950/2002）、Wikiwand《妙探尋兇》、百度百科 |
| 德州扑克 | 德州扑克标准规则整理（盲注、四轮下注、牌型与踢脚、All-in） |
| UNO | 官方 UNO Rules PDF、百度百科《UNO》、UNO 规则汇总 |

> 来源仅用于确定基础规则口径。所有变体裁减以本文「规则（锁定版）」为准。

---

## 11. 实现状态（v3 已落地）

### 11.1 文件清单

| 层 | 文件 | 说明 |
|---|---|---|
| 底座 | `server/core/base.mjs` | `GameBase`：座位、单/多 ask、超时、bot、状态骨架 |
| 底座 | `server/core/brief-kit.mjs` | `renderBriefBase`：接入说明书四步模板 |
| 注册 | `server/games/index.mjs` | 9 个 gameType、人数范围、类映射 |
| 规则 | `server/games/undercover.mjs` | 谁是卧底 |
| 规则 | `server/games/liars-dice.mjs` | 大话骰 |
| 规则 | `server/games/werewolf.mjs` | 狼人杀（6 人明牌局） |
| 规则 | `server/games/avalon.mjs` | 阿瓦隆 |
| 规则 | `server/games/codenames.mjs` | 密码名牌 |
| 规则 | `server/games/cluedo.mjs` | 妙探寻凶 |
| 规则 | `server/games/holdem.mjs` | 德州扑克 |
| 规则 | `server/games/uno.mjs` | UNO |
| 接入 | `server/room.mjs` `server/index.mjs` | `gameType` 路由、`askForPlayer`、通用牌桌页面分发 |
| 前端 | `public/table.html` `table.js` `table.css` | 通用牌桌，按 ask.kind 渲染 8 类操作 |
| 前端 | `public/index.html` `lobby.js` `styles.css` | 大厅新增「牌桌类型」下拉 |
| 工具 | `agents/test-engine.mjs` `test-all.mjs` | 进程内全 bot 对局自测 |
| 工具 | `agents/auto-play.mjs` `test-http-all.mjs` | HTTP 端到端自测（自启/自停服务） |

### 11.2 验收结果

```bash
npm test              # 14 局引擎自测
node agents/test-http-all.mjs   # 9 场 HTTP 端到端
```

| 验收 | 结果 |
|---|---|
| 引擎自测 | **14/14 PASS**：bomb-table 4p、undercover 6p、liars-dice 4p、werewolf 6p、avalon 5p/8p、codenames 4p/6p、cluedo 3p/5p、holdem 3p/5p、uno 4p/6p |
| HTTP 端到端 | **9/9 PASS**：9 个 gameType 各一局纯 AI 房，自动注册/轮询/提交，零错误 |
| BOMB TABLE 回归 | PASS，v2 接口与流程未变 |
| 路由 | `GET /api/games` 正常；无效 `gameType` 返回 400；`/play/:id` 按游戏分发页面；`/join/:id` 按游戏输出规则 |
| 私有信息 | 角色/手牌/骰面/关键卡只经 `selfState` 与 `secretFor` 下发；`publicState` 不含私有字段 |

### 11.3 已知简化与边界

- 大话骰：点数限 2–6，不主动叫 1；数量相同时禁止切换斋/非斋；未实现围骰加倍、劈、投降。
- 狼人杀：固定 6 人（2 狼/预言家/猎人/2 民），屠城局；无女巫、无警长、狼不自刀；仅首夜死亡有遗言。
- 阿瓦隆：不含莫德雷德；bot 刺客按好人随机指认；任务结果不公布失败票数。
- 密码名牌：bot 线索用通用词；额外支持 `cardId:'pass'` 提前收手；纯真人局不限制连续 pass。
- 妙探寻凶：砍掉棋盘移动，房间任选；展示牌由服务端按手牌顺序自动选，避免读心。
- 德州扑克：固定盲注 10/20，不做边池；all-in 按可跟注上限封顶；一手结束按钮位轮转。
- UNO：+2 不连锁；UNO 喊话仅记录 `say`，不自动罚抽；2 人局反转视同跳过。
- 通用前端：`declare` 未提供 `payload.fields` 时退化为单文本框；大话骰等需要多字段的 ask 已在服务端 payload 中给出字段信息。
- 通用前端与旧 `play.js` 并存：BOMB TABLE 仍走旧牌桌，其余 8 款走 `table.html`。
- `vote-result` 事件名被新游戏复用，旧 `play.js` 会按「停战」渲染；新牌桌只取 `ev.text`。

### 11.4 运行

```bash
npm start                       # http://127.0.0.1:8770
BT_PACE=0 npm start             # 关演出停顿，自测用
curl http://127.0.0.1:8770/api/games
curl -X POST http://127.0.0.1:8770/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"gameType":"avalon","seats":5,"mode":"mixed"}'

# 房主强制结束（进行中或未开局均可）
curl -X POST http://127.0.0.1:8770/api/rooms/<房间号>/abort \
  -H 'Content-Type: application/json' \
  -d '{"hostToken":"<创建房间时返回的 hostToken>","reason":"打太久了"}'
```

大厅房间卡与 `/play/:id` 牌桌顶部都有「强制结束」按钮（仅房主可见，需二次确认）。Agent 可用 `client.abort(roomId, hostToken, reason)`。自测：`npm run test:abort`。

---

## 12. 扩展能力索引（v3.1）

三路并行交付，均为新增文件，不改动既有游戏逻辑：

| 方向 | 文件 | 用途 |
|---|---|---|
| AI 自玩 | `server/manual.mjs`、`docs/AI_SELF_PLAY.md`、`agents/test-selfplay.mjs` | AI 读手册自主开房、邀请别的 AI、代注册子代理、一键自玩 |
| UI 设计 | `design/APPLE_FLUID_UI.md`、`design/tokens.css`、`design/mockups/{lobby,table,godview}.html` | Apple 流体界面规范 + 三页静态 mockup + 迁移路径 |
| 存储/管理 | `db/schema.sql`、`docs/DATABASE_DESIGN.md`、`docs/ADMIN_GODVIEW.md` | Neon/PostgreSQL 16+ schema、管理员后门登录、全局造物主视角 |

新增接口：

```
GET  /api/manual                 → Markdown 接入手册（AI 自助玩完整流程）
GET  /api/games/:gameType/rules  → 该游戏规则摘要（Markdown，大厅弹窗用）
GET  /api/ai/capabilities        → JSON 能力清单
POST /api/rooms/:roomId/agents   → {hostToken, agents:[{name,style}]} 代注册子代理，返回各自 token
POST /api/selfplay               → {gameType, seats, styles?} 一键建房+代理填满+开局
```

自测命令：`node agents/test-selfplay.mjs`、`npm run test:abort`、`npm test`、`npm run test:http`。

**安全提示**：造物主 mockup 的 CSS 遮蔽不是安全边界；私有信息必须靠服务端投影控制。管理员 raw 视角需带 reason 并写审计。当前玩家 token 生成正从 `Math.random()` 迁移到 `crypto.randomBytes(32)`。

**未决设计项与当前决策**（见 `docs/ADMIN_GODVIEW.md`）：
- 房间号：真实 ID 仍是 6 位 `K7M2QX` 格式；mockup 里的 `BT-0417` 仅作展示别名 `displayCode`，不改路由正则。
- rewind / force-act：暂不实现；先做 root-only + reason + 审计留痕，双人复核列为后续增强。
- thoughts 时间线：v1 不单开页面；沿用现有分段投屏，造物主 raw 视角读完整思考链。
- raw 快照保留期（建议 7 天）、审计链外部存证、首个 root 安全引导：待真实部署时定。
- 所有索引与查询需在真实数据量下 `EXPLAIN ANALYZE` 验证，当前属未实测的设计建议。
