# BOMB TABLE · Apple 流体 UI / UX 设计规范

> 版本 v1.0 · 面向 Web（Vercel 静态部署）· 浅色主题
> 品牌基线：**1960s 冷战审讯档案 / 米黄纸墨 / 朱红印章** —— 保留既有识别，叠加 Apple 流体交互层。
> 参考指南：`apple-design`（弹簧 / 手势 / 材质 / 八大原则）+ `ui-ux-pro-max`（调色板 / 模式 / 启发式）。
> 所有弹簧参数严格引用 `apple-design/references/spring‑param‑ref.md`，未编造。

---

## 1. 设计目标与信息架构

### 1.1 设计目标

| 目标 | 含义 | 衡量 |
|---|---|---|
| 品牌不失血 | 米黄纸、墨黑字、朱红印章必须第一眼可辨 | 三页共用同一 palette，玻璃层下仍透出纸纹 |
| 手感像物理世界 | 即时响应、连续运动、携带动量、边界阻力、可随时打断 | 评审模板 7 条核心交互全通过 |
| 可访问 | WCAG AA、键盘可达、尊重减弱动效/高对比/低透明 | 正文对比 ≥ 4.5:1，focus 可见 |
| 静态可交付 | 三份单文件 HTML，file:// 离线可开，无 CDN/框架 | 双击即看，依赖为零 |

核心思想（来自 `apple-design/SKILL.md`）：**当界面对齐人的思考与运动方式，就不再像一台计算机，而是无缝的延伸。**

### 1.2 三页信息架构

#### A. 大厅 `lobby.html` —— 「立案 / CASE INTAKE」
关键区块与状态：

| 区块 | 内容 | empty | loading | error | success |
|---|---|---|---|---|---|
| Masthead | BOMB TABLE 标识 + 卷宗号 + TOP SECRET 印章 | — | — | — | — |
| 立案表单 | 游戏类型 ×9、人数、模式、名字 | 未选游戏时占位 | 选项加载中骨架 | 游戏列表拉取失败提示 | 表单可提交 |
| 游戏选择 | 9 款游戏卡片（BOMB TABLE / 谁是卧底 / 大话骰 / 狼人杀 / 阿瓦隆 / 密码名牌 / 妙探寻凶 / 德州扑克 / UNO） | 默认选中 BOMB TABLE | 卡片 skeleton | — | 弹簧 hover + 选中朱红描边 |
| 席位/模式 | 2–6 人分段控件；「与 AI 同桌 / 只看 AI 打」 | 默认 4 人 | — | 人数 < min 提示 | 分段弹簧滑动 |
| 开桌 CTA | 大号朱红按钮 + 规则次要按钮 | 禁用态 | 按钮内 spinner、防重复提交 | 开桌失败近字段提示 | 切到「等待入席」 |
| 接入令 | join URL + 复制 + 邀请话术折叠 | 待开桌隐藏 | 生成中 | 复制失败 toast | 链接与话术展示 |
| 等待入席 | 席位票根、入座计数、开始/强制结束 | 0/4 空席 | 监听中跳动点 | 接入异常 | 满员可开局 |

#### B. 牌桌 `table.html` —— 「审讯现场 / TABLE」
布局：左玩家 · 中央桌面（特效条 / 骰子舞台） · 右日志 · 底部操作区。

| 区块 | 内容 | empty | loading | error | success |
|---|---|---|---|---|---|
| Topbar | 游戏名 / 房号 / 模式 / token 输入 / 大厅入口 | 房号“——” | 连接中 mode chip | 连接失败 | SSE 已连接 |
| 左：在场人员 | 座位票根、生命/道具/身份 | 等待入座 | 骨架票根 | — | 实时更新 |
| 中央：桌面 | 阶段标题、轮次 chip、特效条、骰子舞台、公开行 | 等待开局 | 特效播放 | — | 牌局推进 |
| 中央：底部操作 | ask 控件（vote / confirm / bet）、倒计时、说话输入 | 待命 | 倒计时进度条 | 非法 action 提示 | 提交成功 |
| 思考气泡 | AI 公开内心独白，带打字机/渐显 | 无独白 | 逐字显现 | — | 显示真实意图揭晓 |
| 右：监听记录 | 公开日志、SSE 状态、CH 编号 | 0 条 | 新条目渐入 | 断线标记 | 滚动追加 |

ask 控件示例（沿用 GAME_PLAYBOOK.md 的 kind 定义）：
- `vote`：候选人列表单选 + 弃权开关 → `{"type":"vote","targetId":"p3"}`
- `confirm`：技能发动确认 → `{"type":"confirm","use":true}`
- `bet`：下注滑杆 + 合法动作（fold/check/call/raise/allin）→ `{"type":"bet","move":"raise","amount":60}`

#### C. 造物主后台 `godview.html` —— 「全局视图 / GODVIEW」
体现「权力与约束」：能看私有信息、能强制干预，但每一步都二次确认并留审计。

| 区块 | 内容 | empty | loading | error | success |
|---|---|---|---|---|---|
| 全局房间表 | 房号/游戏/阶段/人数/开始时间/状态 | 无房间 | 骨架行 | 拉取失败 | 实时刷新 |
| 筛选栏 | 按游戏、状态、房号搜索 | 空结果提示 | — | — | 弹簧分段筛选 |
| 私有信息揭示 | 服务端 masked 示意：redacted 标记 + 计数，token 不返回 | masked 默认态 | 请求中骨架 | 无权限 / reason 为空 400 | 显式 reason 弹窗后返回 raw 并写审计 |
| 强制干预 | 强制结束 / 踢人 / 改阶段 | 无选中房间 | — | 二次确认弹窗 | 操作成功 toast |
| 审计记录 | 谁、何时、对哪间房、做了什么 | 0 条 | — | — | 追加一条不可删记录 |

示例数据全部虚构：玩家「零和」「弈者」「豆包」。`BT-0417` 是 **displayCode 展示别名**，真实协议键为 6 位 `roomId`（如 `K7M2QX`）；token 只展示末 4 位、接口绝不返回 token/token_hash。字段映射与权限约束以 `docs/ADMIN_GODVIEW.md` §6 为准：**CSS 遮蔽不是安全边界**，masked 态 DOM/内存/网络面板不得出现 `secret.data`、手牌数组或完整 context；raw 档必须由用户点按并在弹窗填 `reason` 后显式请求，禁止放进 3s 轮询（轮询仅 `GET /admin/rooms`）。干预按钮 `abort / kick / advance-phase` 均需二次确认 + `reason` 非空，后端强制校验，前端勾选框不能替代。

---

## 2. 设计 Token

完整可运行变量见 `tokens.css`。摘要如下。

### 2.1 Spacing scale（4pt 基准）
`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64` px，另有流体档 `clamp(8px,1.2vw,12px)` / `clamp(16px,2.4vw,24px)` / `clamp(24px,4vw,48px)`。

### 2.2 Type scale（光学字号：字号大则收紧字距，小则放宽）

| Token | 字号 | 字间距 | 行高 | 用途 |
|---|---|---|---|---|
| display | 54px（流体 34–54） | -0.022em | 1.06 | 大标题 |
| h1 | 38px | -0.018em | 1.12 | 页标题 |
| h2 | 28px | -0.012em | 1.18 | 区块标题 |
| h3 | 20px | -0.008em | 1.26 | 卡片标题 |
| body | 17px | 0.004em | 1.58 | 正文 |
| small | 14px | 0.012em | 1.50 | 辅助 |
| caption | 12px | 0.06em | 1.42 | 标签/印章小字 |
| mono | 13px | 0.02em | 1.5 | token / 日志 |

字体栈（无外部依赖）：展示/正文用宋体系 `"Songti SC","STSong","SimSun","Noto Serif SC",serif`；UI 用 `"PingFang SC","Microsoft YaHei",sans-serif`；代码用 `"Courier New",monospace`。对应 `typography.csv` 的 **Retro Vintage / Editorial Classic**（serif + serif）气质，但用系统字体实现以保离线。

### 2.3 Color tokens

品牌原色（沿用 `public/styles.css` 与 `table.css`，不改）：

| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `#EDE4CF` | 档案纸主底 |
| `--paper-hi` | `#FAF5E7` | 高光纸 |
| `--paper-lo` | `#DFD3B8` | 阴影纸 |
| `--ink` | `#17130C` | 正文墨色 |
| `--red` | `#B23A28` | 朱红印章 / CTA |
| `--red-deep` | `#86281A` | 印章深边 |
| `--olive` / `--steel` / `--gold` | `#55604E` / `#3A6B80` / `#A07C34` | 辅色 |

语义色（纸面上深色保证 AA）：`--c-danger=--red`（炸弹/强结束）、`--c-warn=#8A6410`（质询/倒计时）、`--c-success=#3E5B3A`（安全/成功）、`--c-info=--steel`（链接/监听）。**颜色永不单独承载信息**，必配文字或图标（`ux-guidelines.csv` #37）。

### 2.4 Radius / Shadow / Depth

- Radius：`4 / 8 / 12 / 18 / 26px` + pill `999px`。大圆角用于玻璃面板与抽屉，档案票根保留小圆角保留档案感。
- Shadow：`--sh-1`（微浮起）→ `--sh-2`（卡片）→ `--sh-3`（弹窗）；`--sh-sheet` 向上投影；保留 `--edge` 大扩散阴影。
- 玻璃层阴影靠 `backdrop-filter` + 半透明白描边（`1px solid rgba(255,255,255,.48)`）实现 Z-depth，符合 `styles.csv` Glassmorphism。

### 2.5 材质层级（Material Stack，自下而上）

| 层 | 材质 | 用途 |
|---|---|---|
| L0 纸底 | 不透明 `--paper` + 噪点/晕影 | 全页背景，品牌识别根基 |
| L1 玻璃薄 | `rgba(250,245,231,.55)` + blur 10px | 游戏卡、分段控件 |
| L2 玻璃中 | `rgba(237,228,207,.72)` + blur 16px | 面板、topbar、日志 |
| L3 玻璃厚 | `rgba(250,245,231,.88)` + blur 20px | sheet / modal / 抽屉 |
| L4 Vibrancy | `rgba(23,19,12,.92)` 高对比文字 | 玻璃上的正文，保证可读 |

降低透明度偏好开启时，L1–L3 退化为不透明纸色、blur 归零（见 `tokens.css` 的 `prefers-reduced-transparency`）。

---

## 3. 弹簧参数表（来源：`spring‑param‑ref.md`）

### 3.1 官方原始参数（逐字引用，禁止改动）

| 交互类型 | 阻尼比 | 响应时间 (s) |
|---|---|---|
| 移动 / 画中画 | 1.0 | 0.4 |
| 旋转动画 | 0.8 | 0.4 |
| 抽屉 / 底部弹窗 sheet | 0.8 | 0.3 |

Web 映射规则（同文档）：
1. 默认普通 UI：`damping = 1.0`（临界阻尼，无弹跳）
2. 手势抛动 / 轻扫：`damping ≈ 0.8`，**仅在手势带有动量时使用**

概念：阻尼比 1.0 临界无弹跳，<1 产生弹跳且越小越强；响应时间单位是秒，代表趋近目标的速度，**弹簧没有固定时长**。

### 3.2 本项目交互 → 参数映射

| 项目交互 | damping | response | 取值理由（对齐来源） |
|---|---|---|---|
| 抽屉 / 邀请话术展开 / 规则 sheet | **0.8** | **0.3s** | 直接采用官方「抽屉/底部弹窗 sheet」 |
| 弹窗（二次确认、强制结束确认） | **0.8** | **0.3s** | 弹窗即 sheet 类表面，复用官方 sheet 参数 |
| 卡片展开 / 私有信息揭示 / 面板位移 | **1.0** | **0.4s** | 采用官方「移动/画中画」；信息揭示以位移为主，不要弹跳以免抖读 |
| 按钮按下→释放 | **1.0** | **0.4s** | 采用「默认普通 UI damping=1.0」；按下瞬间 0ms，释放走弹簧 |
| 列表重排 / 席位票根拖动 | **≈0.8** | **0.4s** | 手势驱动且释放带动量 → 采用「手势抛动 damping≈0.8」；响应取官方旋转动画 0.4s（同为带惯性的位移动画） |
| 骰子舞台翻转 / 印章旋转 | **0.8** | **0.4s** | 直接采用官方「旋转动画」 |
| 分段控件选中滑块 | **1.0** | **0.4s** | 普通 UI 位移，无动量，临界阻尼 |

> 说明：官方表只有 3 行。凡本项目交互不在表中（卡片展开、按钮、列表重排、分段控件），均按同文档的「Web 映射」规则推导，并在理由列注明所依据的官方行；未编造新数值。

### 3.3 速度移交与动量投射（官方公式）

```js
// 速度移交：相对速度 = 释放速度 / (目标值 − 当前值)
// Framer-Motion / Motion 可直接传 px/s 绝对速度，无需手动归一化

// 动量投射（Apple 官方）
// decelerationRate: 0.998 普通滚动；0.99 更干脆
function project(initialVelocity, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}
const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);
```

---

## 4. 交互规格

| 规格 | 要求 | 落地方式 |
|---|---|---|
| 响应延迟 | 按下瞬间必须有反馈，不等抬起；目标 < 100ms 视觉响应 | `:active` 用 0ms transform/opacity，见下方片段 |
| 可中断 | 动画随时可被新手势打断，从屏幕**实时位置**起新动画 | JS 读 `getComputedStyle().transform` 当前值作为新动画起点；禁止从 0 重启 |
| 手势 1:1 | 拖拽跟随手指，尊重抓取偏移（grab offset） | `pointerdown` 记录 `offset = pointer - element`，move 时 `translate = pointer - offset` |
| 橡皮筋 | 边界用橡胶缓冲，不硬截断 | 越界位移按 `d = c * (1 - exp(-x/c))` 压缩，松手回弹 |
| 滚动动量 | 释放移交原始速度，投射吸附点 | 用 §3.3 `project()` + 最近吸附点 |
| 出场入场对称 | 弹窗从触发源弹出，关闭回原处 | Web Animations API 记录触发元素 rect 作 transform-origin |
| 焦点态 | 所有可交互元素有可见 focus ring | `:focus-visible { box-shadow: var(--focus-ring) }`，禁止 `outline:none` 无替代 |
| 键盘导航 | 全页 Tab 可达；ask 控件方向键选项、Esc 关弹窗 | `role`/`aria-*`，方向键管理 `aria-activedescendant` |
| 防重复提交 | 异步按钮 loading 时禁用 | `[disabled]` + 文本改“处理中…”（`ux-guidelines.csv` #32） |
| 反馈就近 | 错误显示在问题字段旁，不静默 | 字段级 `aria-live` 错误文本（`ux-guidelines.csv` #33） |

---

## 5. 无障碍

| 项 | 策略 | 来源 |
|---|---|---|
| prefers-reduced-motion | 位移/缩放动画归零，仅保留 ≤1ms 透明度交接；`project()` 动量吸附直接关闭 | `ux-guidelines.csv` #9 |
| 高对比度 | `prefers-contrast: more` 加深 ink 透明度至 .95，玻璃描边转实墨色 | #36 |
| 降低透明度 | `prefers-reduced-transparency: reduce` 玻璃退化为不透明纸，blur=0 | Glassmorphism 可读性约束 |
| 强制颜色 | `forced-colors: active` 面板加 `CanvasText` 描边 | — |
| WCAG AA | 正文对纸底 ≥ 4.5:1（墨 `#17130C` on `#EDE4CF` ≈ 13:1）；朱红仅用于 ≥18px 粗体或图标，小字用 `--red-deep` | #36 |
| 非色彩语义 | 状态同时用文字/图标（炸弹「爆」、安全「安」） | #37 |
| 键盘 | 可见 focus、顺序 DOM、Esc 关闭、方向键选项、跳过链接 | #28 #40 |
| ARIA | 图标按钮 `aria-label`；ask 容器 `aria-live="polite"`；模态 `role="dialog" aria-modal` | #40 |
| 标题层级 | h1→h2→h3 顺序，不用 CSS 跳级 | #39 |
| 加载反馈 | 骨架屏/spinner，禁止白屏冻结；无限动画仅用于 loading | #10 #12 |

---

## 6. Web 可运行关键片段

> 完整 token 见 `tokens.css`；以下为可直接复制的核心模式。三份 mockup 已内置这些实现，且均为原生 JS、无框架。

### 6.1 毛玻璃（保留纸纹、Vibrancy 文字）

```css
.glass {
  background: var(--glass-bg);                 /* rgba(237,228,207,.72) */
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.4);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.4);
  border: var(--glass-border);
  box-shadow: var(--sh-2), inset 0 1px 0 rgba(255,255,255,.42);
  color: var(--vibrancy-text);                  /* 高对比，纸面上可读 */
}
.glass::before {                                /* 玻璃高光 */
  content:""; position:absolute; inset:0;
  background: var(--glass-sheen); pointer-events:none; border-radius:inherit;
}
```

### 6.2 弹簧过渡（CSS 优雅降级 + JS 精确弹簧）

```css
/* CSS：按下 0ms，释放走弹簧近似曲线 */
.card { transition: transform var(--dur-release) var(--ease-spring),
                    box-shadow var(--dur-release) var(--ease-spring); }
.card:active { transform: scale(.97); transition-duration: var(--dur-press); }
```

```js
// JS：精确弹簧（damping/response 来自官方表），可中断、从实时位置起
function springTo(el, target, damping = 1.0, response = 0.4) {
  const current = new DOMMatrix(getComputedStyle(el).transform).m41;
  let x = current, v = 0, last = performance.now();
  cancelAnimationFrame(el._raf);
  function tick(now) {
    const dt = Math.min((now - last) / 1000, 1 / 60); last = now;
    // 简化临界/欠阻尼弹簧： stiffness 由 response 推得 ω = 2π/response
    const w = 2 * Math.PI / response;
    const a = w * w * (target - x) - 2 * damping * w * v;
    v += a * dt; x += v * dt;
    el.style.transform = `translateX(${x}px)`;
    if (Math.abs(target - x) > .5 || Math.abs(v) > .5) el._raf = requestAnimationFrame(tick);
    else el.style.transform = `translateX(${target}px)`;
  }
  el._raf = requestAnimationFrame(tick);
}
```

### 6.3 可打断拖拽 + 抓取偏移 + 橡皮筋

```js
let off = 0, dragX = 0, vel = 0, tLast = 0;
el.addEventListener('pointerdown', e => {
  const r = el.getBoundingClientRect();
  off = e.clientX - r.left;                 // 尊重抓取偏移
  el.setPointerCapture(e.pointerId);
  el.style.transition = 'none';
});
el.addEventListener('pointermove', e => {
  const now = performance.now();
  vel = (e.clientX - dragX) / Math.max(now - tLast, 1) * 1000; // px/s
  dragX = e.clientX - off; tLast = now;
  const max = 240;
  const shown = Math.abs(dragX) > max
    ? Math.sign(dragX) * (max + 22 * (1 - Math.exp(-(Math.abs(dragX)-max)/22))) // 橡皮筋
    : dragX;
  el.style.transform = `translateX(${shown}px)`;
});
el.addEventListener('pointerup', () => {
  const end = dragX + project(vel);           // §3.3 动量投射
  springTo(el, clampSnap(end), 0.8, 0.4);     // 手势带动量 → damping≈0.8
});
```

### 6.4 弹窗从触发源出场（路径对称）

```js
function openSheet(trigger, sheet) {
  const r = trigger.getBoundingClientRect();
  sheet.style.transformOrigin = `${r.left + r.width/2}px ${r.top}px`;
  sheet.animate(
    [{ opacity:0, transform:'scale(.9) translateY(24px)' },
     { opacity:1, transform:'none' }],
    { duration:300, easing:'cubic-bezier(.22,1.2,.36,1)' } // ≈ sheet 0.8/0.3
  );
}
```

---

## 7. 从 `public/table.html` 迁移到新设计的分阶段路径

原则：**只加不改，逐阶段可回滚**。新设计落到 `design/` 与后续新建的 `public/fluid/` 资产，现有 `public/**` 全程不动直到 Phase 4 验收。

| 阶段 | 文件级改动 | 风险 | 回滚点 |
|---|---|---|---|
| **P0 建基线** | 新建 `design/tokens.css` + 三份 mockup（本次交付）。不碰 `public/**` | 无（纯新增） | 删除 `design/` 即可 |
| **P1 token 对齐** | 在 `public/` 新增 `fluid-tokens.css`（复制 `design/tokens.css`），现有 HTML `<link>` **追加**一行引入，不改原选择器 | 变量同名覆盖原值 → 逐个核对色值一致；冲突则只加前缀 `--f-` | 移除新增 `<link>` |
| **P2 材质叠加** | 新增 `fluid-layer.css`：对 `.panel/.sheet/.topbar` 追加 `backdrop-filter` 与半透明背景（不删原背景，用增量为玻璃层） | 老浏览器无 `backdrop-filter` → 有 `@supports` 回退到原纸色 | 移除新增 `<link>` |
| **P3 交互增强** | 对 `table.js` 新增 `fluid-interactions.js`（不改动原文件），在 `script` 后追加加载，接管 `.opt`/`.seg__btn` 的 hover 弹簧与 sheet 动画 | 事件重复绑定 → 用 `dataset.fluidBound` 幂等守卫；点击行为双触发 → 只做视觉层，不碰业务 click | 移除 `<script>` |
| **P4 结构迁移** | 新建 `public/table-fluid.html` 作为新结构页，与 `table.html` 并存；SSE/ask 逻辑继续复用 `table.js`（DOM id 保持一致） | 两套 DOM id 冲突 → 新页独立 id 前缀或分路由；静态部署多一页 | 保留 `table.html` 为入口，随时切回 |
| **P5 切换入口** | 确认三页 AA 对比、键盘、减弱动效全过后，再决定把链接指向新页 | 用户习惯变化 | 入口链接一行回退 |

不变量：所有业务接口（`/api/rooms/:id/join`、SSE、`ask.kind`）与 DOM id 不改；玻璃层是视觉增量，不是重写。

---

## 8. 八大原则自评（依据 `apple‑ui‑review‑template.md`）

模板第 7 节八大原则：**目的性、用户控制权、责任、熟悉感、灵活性、简洁、工艺、愉悦感**。评分 1–5。

| 原则 | 分 | 说明 / 已落实点 |
|---|---|---|
| 目的性 Purpose | 5 | 每页单一主任务：开桌 / 做决策 / 全局监管；CTA 唯一且朱红高对比 |
| 用户控制权 Control | 4 | 动画可中断、拖拽 1:1、可撤销关闭抽屉；扣 1 分：造物主强制操作虽二次确认但不可撤销（业务约束） |
| 责任 Responsibility | 5 | 强制结束/踢人/揭示私有信息均二次确认 + 审计记录，系统“告知后果” |
| 熟悉感 Familiarity | 5 | 沿用档案票根/印章/监听记录等既有语汇，未推倒成 iOS 风 |
| 灵活性 Flexibility | 4 | 9 款游戏、2–6 人、两种模式；扣 1 分：mockup 为静态，筛选仅示例 |
| 简洁 Simplicity | 4 | token 分层清晰；扣 1 分：牌桌信息密度高（思考链公开是业务必需） |
| 工艺 Craft | 5 | 4pt 间距、光学字号、玻璃高光、橡皮筋边界、Vibrancy 文字，细节一致 |
| 愉悦感 Delight | 4 | 弹簧 hover、骰子舞台、印章动画提供手感；扣 1 分：静态 mockup 无法呈现全部动效 |

### 核心交互校验（模板第 2 节，逐条）

- [x] 按下即反馈，不在抬起后才响应（`:active` 0ms）
- [x] 拖拽 1:1 跟随手指，尊重抓取偏移（§6.3 `off`）
- [x] 动画随时可打断，从屏幕实时位置起新动画（§6.2 读 computed transform）
- [x] 使用弹簧而非固定时长 transition（§3 参数 + §6.2）
- [x] 手势释放移交原始速度，动量投射计算吸附点（§3.3 `project()`）
- [x] 边界使用橡胶缓冲而非硬截断（§6.3 指数压缩）
- [x] 出场入场路径对称，弹窗从触发源弹出（§6.4 `transformOrigin`）

### 物理参数（模板第 3 节）
弹簧阻尼比：`1.0`（UI 位移/卡片/按钮）/ `0.8`（抽屉/弹窗/旋转/手势动量）
响应时间：`0.4s`（移动、旋转）/ `0.3s`（抽屉、弹窗）—— 来源见 §3.1。

### 材质 & 层级（第 4 节）
毛玻璃 blur 10–20px + 半透明白描边 + Vibrancy 文字；阴影三级 + sheet 上投影，见 §2.5。

### 排版光学字号（第 5 节）
字号大收紧字距（-0.022em @54px），小字放宽（+0.06em @12px），行高 1.06–1.58 随字号递减，见 §2.2。

### 无障碍（第 6 节）
减弱动效 / 高对比 / 降低透明度 / 强制颜色四档媒体查询 + WCAG AA + 键盘 + ARIA，见 §5 与 `tokens.css` 尾部。

### 优化建议（第 8 节）
1. 部署 Vercel 后补真实 Lighthouse a11y 跑分，重点核对玻璃层文字对比。
2. 将 `project()` 与 `springTo()` 抽为 `public/fluid-motion.js` 供三页复用（P3）。
3. 若接入 Framer Motion，直接传 `damping/response`（ Motion 单位 `stiffness` 需按 `ω=2π/response` 换算），避免 CSS 近似曲线误差。

---

## 附：本规范引用的参考来源
- `apple‑design/references/spring‑param‑ref.md`：弹簧阻尼比、响应时间、速度移交、动量投射公式（§3 全部数值）
- `apple‑design/references/wwdc‑design‑rules.md` + `templates/apple‑ui‑review‑template.md`：8 条核心交互校验、八大原则、报告结构（§8）
- `apple‑design/SKILL.md`：流体交互核心思想、授权输出模块（§1.1）
- `ui‑ux‑pro‑max/assets/data/styles.csv`：Glassmorphism（blur 10–20px / 白描边 / Z-depth）、Minimalism & Swiss（Beige #F5F1E8 中性色）
- `ui‑ux‑pro‑max/assets/data/typography.csv`：Retro Vintage / Editorial Classic（serif 气质）
- `ui‑ux‑pro‑max/assets/data/ux-guidelines.csv`：reduced-motion #9、loading #10、focus #28、double-submit #32、error #33、contrast #36、color-only #37、ARIA #40
- 现有 `public/styles.css`、`public/table.css`、`public/index.html`、`public/table.html`：品牌色板与字体栈（§2.3）
- `server/games/index.mjs`、`GAME_PLAYBOOK.md`：9 款游戏清单与 ask kind 定义（§1.2）
