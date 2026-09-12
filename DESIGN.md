# DESIGN.md — 青鸟 Markdown 设计系统

> 「纸上翻译」：宣纸为底，墨色为界，青花点译，朱砂为印。
> 本文档是 qingbird-md GUI 重构的唯一视觉规范，供 AI 编程代理与人类开发者直接消费。
> 原型对照：`docs/redesign/mockup-v2.html`（定稿基准）；`docs/redesign/mockup.html` 为弃用的第一稿。
> 参考血统：floral-notepaper 的纸感人文路线 + Codex/Linear 的克制与信息密度。

---

## 1. Visual Theme & Atmosphere（视觉主题与氛围）

**设计哲学**：翻译工具的灵魂在「读」，不在「操作」。界面是安静的案头，文档才是主角——界面用无衬线与暖灰退后，文档层用衬线与墨色站到台前。品牌情绪取自「青鸟传书」：一只衔着译文的信使鸟，落在宣纸上。

**视觉基调**：温暖人文 × 文人书卷 × 极简克制。

**核心关键词**：
1. **纸感** — 暖米色多层纸面 + 3% 噪点纹理，拒绝纯白
2. **墨色** — 界面控件一律用墨的深浅表达层级，不用彩色
3. **青花** — 唯一彩色强调，只属于「翻译」语义
4. **朱砂** — 印章红，只属于「品牌 / 未保存 / 危险」语义
5. **留白** — 宽行距、大字距微标签、发丝分隔线

**光影与质感**：纯扁平 + 微阴影（悬浮卡才允许阴影，贴面元素一律 1px 发丝线）；全局噪点纹理叠加（`feTurbulence`，opacity ≤ .03）。

---

## 2. Color Palette & Roles（调色板与角色）

### 纸（表面色阶）

| Token | HEX | 用途 |
|---|---|---|
| `--paper` | `#F7F4EC` | 主画布、预览底 |
| `--paper-warm` | `#F1ECE0` | 侧栏、状态栏（略深一档） |
| `--paper-deep` | `#E8E1D1` | hover 底、分段控件轨道、缩进块 |
| `--paper-line` | `#E3DCC9` | 发丝分隔线（面板/工具条/标签条） |
| `--paper-line-soft` | `#ECE6D8` | 更弱的分隔（内容区内） |
| `--cloud` | `#FFFDF8` | 浮起卡、选中行、输入框底（最亮面） |

### 墨（文字色阶）

| Token | HEX | 用途 |
|---|---|---|
| `--ink` | `#211F1A` | 主文字、墨块按钮底、激活标签 |
| `--ink-soft` | `#4C4A40` | 次级文字、译文正文、树行默认 |
| `--ink-faint` | `#8F8B7C` | 弱文字、图标默认、placeholder 辅 |
| `--ink-ghost` | `#BCB7A5` | 最弱文字（行号、微标签）、禁用态 |
| `--stone` | `#6E6A5E` | 中性辅助（备用） |

### 青花（翻译语义强调，唯一的彩色）

| Token | 值 | 用途 |
|---|---|---|
| `--qing` | `#31678E` | 译文竖线、进度条、选中文件左标、链接下划线色 |
| `--qing-deep` | `#285677` | 青花文字态（链接、激活模式文字） |
| `--qing-mist` | `#E6EDF2` | 青花浅底 chip |
| `--qing-wash` | `rgba(49,103,142,.08)` | focus 光晕、选中态底 |

**使用铁律**：青花只允许出现在与「翻译产物 / 翻译状态」相关的地方（译文标记、翻译进度、双语模式激活、划词结果、provider 在线点）。导航、格式化按钮、文件操作一律禁用彩色。

### 朱砂（品牌与警示）

| Token | 值 | 用途 |
|---|---|---|
| `--zhu` | `#B3483A` | 品牌印章、未保存脏标、危险动作 hover |
| `--zhu-wash` | `rgba(179,72,58,.08)` | 危险 hover 底、行内代码底 |

### 阴影色

| Token | 值 |
|---|---|
| `--shadow` | `rgba(33,31,26,.06)` |
| `--shadow-deep` | `rgba(33,31,26,.14)` |

### 深色主题（草案，结构与浅色严格同构）

| 语义 | 值 |
|---|---|
| paper / warm / deep | `#232220` / `#2B2925` / `#39362F` |
| line / line-soft | `#3B3830` / `#332F29` |
| cloud（最亮面） | `#2E2B26` |
| ink / soft / faint / ghost | `#E6E1D4` / `#B8B3A4` / `#8B8778` / `#6B6759` |
| qing / deep / mist | `#6FA3C4` / `#8FBAD6` / `#22323D` |
| zhu | `#C96A5C` |
| shadow | `rgba(0,0,0,.3)` / `rgba(0,0,0,.5)` |

---

## 3. Typography Rules（排版规则）

### 字体栈

```css
/* UI 无衬线：不内置，走系统栈（零体积） */
--sans: "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;

/* 文档衬线：内置思源宋体，SIL OFL 可内嵌商用 */
--serif: "Source Han Serif SC", "Noto Serif SC", "Songti SC", STSong, STZhongsong, "SimSun", serif;

/* 代码等宽：系统栈 */
--mono: "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;
```

**内置字体清单**（放 `src/assets/fonts/`，`@font-face` + `font-display: swap`）：

| 文件 | 字重 | 体积 | 内部 family 名 |
|---|---|---|---|
| `SourceHanSerifSC-400.woff2` | 400 | 1.5 MB | `Source Han Serif SC` |
| `SourceHanSerifSC-700.woff2` | 700 | 1.5 MB | `Source Han Serif SC` |

字体铁律：**衬线只出现在文档层**（预览正文/标题/引文/词典卡/品牌印字），UI 框架一律无衬线；内存治理红线——字体实装后必须纳入空闲内存测试，超标则用 `cn-font-split` 切片。

### Type Scale

| 层级 | 字体 | Size px/rem | Weight | Line-height | Letter-spacing | 用途 |
|---|---|---|---|---|---|---|
| Display | serif | 27 / 1.6875 | 700 | 1.5 | .015em | 预览 H1 |
| Heading | serif | 19 / 1.1875 | 700 | 1.4 | .01em | 预览 H2 |
| Brand | serif | 14.5 / 0.9063 | 700 | 1.2 | .06em | 标题栏品牌名 |
| Prose EN | sans | 15.5 / 0.9688 | 400 | 2.0 | 0 | 双语对·原文 |
| Prose ZH | serif | 15.5 / 0.9688 | 400 | 2.05 | .015em | 双语对·译文 |
| UI Body | sans | 13 / 0.8125 | 400–600 | 1.5 | 0 | 默认 UI 文字 |
| UI Secondary | sans | 12.5 / 0.7813 | 400–600 | 1.5 | 0 | 树行、tab、次级按钮 |
| Caption | sans | 12 / 0.75 | 400–600 | 1.4 | 0 | 分段控件、chip 辅文 |
| Micro | sans | 9.5 / 0.5938 | 500 | 1.2 | **.18em 大写** | 面板眉标（`SOURCE · 原文`） |
| Status | sans | 11 / 0.6875 | 400 | 1.2 | .03em | 状态栏 |
| Code | mono | 13 / 0.8125 | 400 | 1.8 | 0 | 编辑器、代码块（块内 12.5/1.85） |

**设计哲学**：UI 走紧凑小字（13px 基准）换取信息密度；文档层反向放大到 15.5px 并把行高推到 2.0+——「界面让人找得到，文章让人读得进」。中英文双语对必须同字号异字族（EN 无衬线 / ZH 衬线），用字体差异替代颜色差异区分两种语言。

---

## 4. Component Stylings（组件样式）

### Buttons

```css
/* Primary 墨块：全局唯一主操作（翻译全文） */
.btn-ink{
  background:var(--ink);color:var(--paper);
  padding:7px 15px;border-radius:8px;
  font-size:12.5px;font-weight:600;letter-spacing:.03em;
  box-shadow:0 2px 6px rgba(33,31,26,.22);
}
.btn-ink:hover{background:#35332C;transform:translateY(-1px);
  box-shadow:0 3px 10px rgba(33,31,26,.26)}
.btn-ink kbd{background:rgba(249,243,234,.16);border:none;color:rgba(249,243,234,.75)}

/* Ghost 安静钮（视口翻译等次操作） */
.btn-quiet{padding:6px 11px;border-radius:6px;color:var(--ink-faint);font-size:12.5px}
.btn-quiet:hover{background:var(--paper-deep);color:var(--ink-soft)}

/* Icon 钮（工具条/标题栏） */
.tbtn{width:29px;height:29px;border-radius:6px;color:var(--ink-faint)}
.tbtn:hover{background:var(--paper-deep);color:var(--ink-soft)}

/* Danger 安静危险钮（取消翻译等） */
.tc-cancel{font-size:11.5px;color:var(--ink-faint);padding:3.5px 12px;
  border-radius:99px;border:1px solid var(--paper-line)}
.tc-cancel:hover{color:var(--zhu);border-color:rgba(179,72,58,.35);background:var(--zhu-wash)}
```

### Segmented Controls（两种）

```css
/* 胶囊分段（视图切换：编辑/分栏/预览）——放在标签条右端 */
.viewseg{background:var(--paper-deep);border-radius:99px;padding:3px;gap:2px}
.viewseg button{padding:4px 14px;border-radius:99px;font-size:12px;color:var(--ink-faint)}
.viewseg button.on{background:var(--cloud);color:var(--ink);font-weight:600;
  box-shadow:0 1px 3px var(--shadow)}

/* 下划线分段（阅读模式：原文/译文/双语）——放在工具条 */
.modeseg button{padding:5px 11px;font-size:12px;letter-spacing:.05em;color:var(--ink-faint)}
.modeseg button.on{color:var(--qing-deep);font-weight:600}
.modeseg button.on::after{content:"";position:absolute;left:10px;right:10px;bottom:0;
  height:2px;border-radius:2px;background:var(--qing)}
```

### Inputs（搜索框）

```css
.search-box{background:var(--cloud);border:1px solid var(--paper-line);
  border-radius:99px;padding:6.5px 12px;color:var(--ink-ghost)}
.search-box:focus-within{border-color:var(--qing);box-shadow:0 0 0 3px var(--qing-wash)}
.search-box input{font-size:12.5px;color:var(--ink)}
.search-box input::placeholder{color:var(--ink-ghost)}
```

### Cards（悬浮层）

```css
/* 译中任务卡 / 划词词典卡 / 一切悬浮纸片 */
.floating-card{background:var(--cloud);border:1px solid var(--paper-line);
  border-radius:12px;
  box-shadow:0 14px 44px rgba(33,31,26,.14),0 2px 8px rgba(33,31,26,.06)}

/* 代码块：贴面卡（阴影仅 1px 级） */
.pv-code{background:var(--cloud);border:1px solid var(--paper-line);
  border-radius:10px;padding:15px 18px;
  font-family:var(--mono);font-size:12.5px;line-height:1.85;
  box-shadow:0 1px 3px var(--shadow)}

/* 双语对：翻译工具的核心组件 */
.pair{padding:8px 0;border-radius:8px}
.pair:hover{background:rgba(33,31,26,.025)}
.pair .en{font-size:15.5px;line-height:2;color:var(--ink)}
.pair .zh{font-family:var(--serif);font-size:15.5px;line-height:2.05;
  color:var(--ink-soft);letter-spacing:.015em;margin-top:6px;
  padding-left:14px;position:relative}
.pair .zh::before{content:"";position:absolute;left:0;top:7px;bottom:7px;
  width:2.5px;border-radius:2px;background:var(--qing);opacity:.5}
.pair:hover .zh::before{opacity:1}
```

### Navigation（骨架四层）

```css
/* 标题栏 46px：印章(21×21, rotate -3deg) + 品牌名 + 面包屑 + 图标 + 窗口控制 */
/* 印章即侧栏开关：hover 印章 opacity→0 缩至 .85，开关图标 opacity→1，点击切换 */

/* 标签条 40px：下划线 tab（非药丸），激活 = 墨色 2px 底线 */
.tab{height:100%;padding:0 13px;color:var(--ink-faint);font-size:12.5px}
.tab.on{color:var(--ink);font-weight:600}
.tab.on::after{position:absolute;left:12px;right:12px;bottom:-1px;height:2px;
  border-radius:2px;background:var(--ink)}

/* 工具条 42px：格式图标 | 模式分段 … 视口翻译 | 翻译全文(墨块) */

/* 侧栏 256px：--paper-warm 底 + 右发丝线；选中行 = cloud 浮起 + 青花左标 2.5px */
.tree-row.sel{background:var(--cloud);color:var(--ink);font-weight:500;
  box-shadow:0 1px 3px var(--shadow),inset 0 0 0 1px var(--paper-line)}
.tree-row.sel::before{content:"";position:absolute;left:0;top:7px;bottom:7px;
  width:2.5px;border-radius:2px;background:var(--qing)}
```

### Badges / Chips

```css
.chip{display:inline-flex;align-items:center;gap:5px;
  background:var(--cloud);border:1px solid var(--paper-line);
  border-radius:99px;padding:2.5px 10px;font-size:11px;color:var(--ink-faint)}
.chip.qing{background:var(--qing-mist);border-color:transparent;
  color:var(--qing-deep);font-weight:600}
```

### Modals / Dialogs

```css
.modal-mask{background:rgba(33,31,26,.28);backdrop-filter:blur(2px)}
.modal{background:var(--paper);border:1px solid var(--paper-line);border-radius:14px;
  box-shadow:0 24px 70px rgba(33,31,26,.25);
  animation:scale-in .45s cubic-bezier(.22,1,.36,1)}
/* scale-in: from scale(.96)/opacity 0 → 1；退出反向 .15s，pointer-events:none */
```

---

## 5. Layout Principles（布局原则）

- **间距基数 4px**，实用刻度：4 / 8 / 12 / 14 / 16 / 22 / 34；面板内边距 12–16，内容区 32–34。
- **骨架**（自上而下）：标题栏 46 → 标签条 40 → 工具条 42 → 内容 flex → 状态栏 28。全 app 只用 1px 发丝线分区，无第二重边框。
- **列**：侧栏 256px（可拖 160–480，可收起）；编辑/预览分栏默认 0.5，拖动钳制 0.2–0.8；中央缝即分隔线（7px 热区）。
- **内容容器**：编辑器 `max-width:740px` 居中，预览 `max-width:700px` 居中——两侧留白是纸的边缘，不铺满。
- **窗体**：圆角 14px，最小窗口 800×600，默认 1440×880。
- **留白哲学**：贴面元素靠发丝线分区、靠底色深浅分层，永远不用阴影和粗边框制造区块感；密的地方（工具条）靠 4px 级微间距，松的地方（预览）一屏只允许一个视觉重心（标题）。

---

## 6. Depth & Elevation（深度与层级）

### Shadow System

```css
--shadow-xs:  0 1px 2px rgba(33,31,26,.05);                        /* 树行 hover 提示级 */
--shadow-sm:  0 1px 3px rgba(33,31,26,.06);                        /* 选中树行、代码块 */
--shadow-md:  0 2px 8px rgba(33,31,26,.08);                        /* 胶囊分段激活态 */
--shadow-lg:  0 12px 36px rgba(33,31,26,.16), 0 2px 6px rgba(33,31,26,.06);  /* 划词卡 */
--shadow-xl:  0 14px 44px rgba(33,31,26,.14), 0 2px 8px rgba(33,31,26,.06);  /* 译中卡 */
--shadow-ink: 0 2px 6px rgba(33,31,26,.22);                        /* 墨块按钮专用 */
--shadow-win: 0 30px 90px rgba(40,36,26,.28), 0 4px 16px rgba(40,36,26,.12); /* 窗口外阴影 */
```

### Surface Layers（由暗到亮）

`paper-warm`（侧栏/状态栏）→ `paper`（主画布）→ `paper-deep`（凹陷/hover）→ `cloud`（浮起：选中行、输入框、悬浮卡）。**同屏相邻层至多差一档**。

### Z-index Scale

| 值 | 层 |
|---|---|
| 10 | pane-head 眉标（sticky） |
| 20 | 面板/分栏 resizer 热区 |
| 30 | 标题栏、状态栏（吸底吸顶） |
| 90 | 译中任务卡 |
| 100 | 划词浮窗 |
| 150 | 下拉菜单 |
| 200 | 模态弹窗 + 遮罩 |
| 300 | toast |
| -1 | 噪点纹理（`isolation:isolate` 隔离，`pointer-events:none`） |

### 纹理与动效

```css
/* 纸纹：全局唯一质感来源，opacity 不得超过 .03 */
.grain::before{content:"";position:absolute;inset:0;z-index:-1;opacity:.03;
  background-image:url("data:image/svg+xml,…feTurbulence baseFrequency='0.85'…");
  background-size:180px 180px;pointer-events:none;border-radius:inherit}

/* 动效统一曲线：入场 .2–.45s / 退场 .12–.2s；只动 opacity/transform，禁动 layout */
--ease: cubic-bezier(.22,1,.36,1);
```

---

## 7. Do's and Don'ts（设计规范与禁忌）

**Do's**
1. 青花只给翻译语义（译文标记、进度、双语激活态、划词结果），其余交互一律墨色系
2. 衬线只给文档层；UI 控件保持无衬线小字
3. 分区用 1px 发丝线 + 底色深浅一档；悬浮才用阴影
4. 微标签统一 9.5px / .18em 大写（`SOURCE · 原文`），是面板的「眉批」
5. hover 反馈统一 `paper-deep` 底或 opacity 过渡，时长 ≤ .16s
6. 数字用 tabular-nums（进度、字数统计）
7. 未保存/危险一律朱砂，且朱砂出现即意味着「需要注意」
8. 空状态用 ghost 色 + 一枚线稿鸟图标，不放大段说明文字

**Don'ts**
1. 禁止纯白 `#FFF` / 纯黑 `#000` 上屏（最亮是 cloud `#FFFDF8`，最深是 ink `#211F1A`）
2. 禁止彩色按钮、彩色图标按钮（青花只出现在语义位）
3. 禁止给贴面元素（tab、树行、工具条）加阴影或圆角卡片化
4. 禁止衬线用于按钮/标签/状态栏（廉价感来源）
5. 禁止同时出现两种彩色强调（青花与朱砂不同框，印章除外）
6. 禁止动画动 layout 属性（width/left/top），只动 opacity/transform
7. 禁止 > .03 的噪点、> 14px 的圆角（模态与窗体除外）
8. 禁止在预览层放 UI 控件（预览是纸，不是面板）

---

## 8. Responsive Behavior（响应式行为）

桌面应用语境，断点按**窗口宽度**定义：

| 窗口宽 | 行为 |
|---|---|
| ≥ 1280px | 完整布局：侧栏 + 分栏（编辑/预览同屏） |
| 1000–1279px | 分栏比例自动让给预览（≥ 0.45）；侧栏保持可开 |
| 800–999px | 强制单栏（预览态优先，编辑态手动切换）；侧栏自动收起为印章开关 |
| < 800px | 低于最小窗宽，禁止继续缩小 |

- **Touch Targets**：最小可点热区 28×28（icon 钮 29×29、mini 钮 24×24 需配 8px 外边距热区）；resizer 一律 7px 视觉 + 7px 额外热区
- **折叠策略**：侧栏收起 = 宽度过渡 + opacity，280ms `cubic-bezier(.22,1,.36,1)`，收起后主区吸收空列必须等动画播完（现有 `PANEL_ANIM_MS + 40ms` 兜底约定沿用）
- **Font Scaling**：跟随 WebView2 缩放（Ctrl+滚轮），布局用 px 不用 vw；文档层字号在缩放下等比跟随，UI 骨架高度固定不缩
- **长文档**：编辑/预览各自独立滚动；眉标 sticky 置顶（z-index 10）

---

## 9. Agent Prompt Guide（AI 代理提示指南）

### Quick Reference

```
项目：Tauri 2 + React 18 + TS，桌面 Markdown 翻译器（Windows 优先）
画布：--paper #F7F4EC 暖纸底 + 3% 噪点；控件全部墨色系
强调：--qing #31678E（翻译语义专用）/ --zhu #B3483A（印章/警示专用）
字体：UI 系统无衬线 13px；文档层内置思源宋体 15.5px/行高2.0
圆角：贴面 6–8px，卡片 10–12px，窗体/模态 14px，胶囊/搜索 99px
阴影：贴面零阴影用发丝线；仅悬浮卡 --shadow-lg/xl
动效：cubic-bezier(.22,1,.36,1)，只动 opacity/transform
```

### Component Prompts

1. `生成一个「译中任务卡」：316px 宽 cloud 底圆角12悬浮卡，顶部 22×22 朱砂「译」印（sealPulse 动效 rotate -3°↔-1°）+ 标题 + 百分比，3px 青花进度条带 sheen 流光，底部 done/total + 胶囊取消钮（hover 变朱砂），--shadow-xl，入场 rise .4s`
2. `生成「双语对」组件：EN 行 sans 15.5/2.0 墨色，ZH 行 serif 15.5/2.05 ink-soft 且左侧 2.5px 青花竖线（默认 opacity .5，hover 整对浮现 paper 底且竖线实色），整对 padding 8px 0 圆角 8`
3. `生成「下划线标签条」：40px 高，tab 12.5px ink-faint，激活态 ink 600 + 底部 2px 墨色圆角短线（left/right 12px 内缩），dirty 用 13px 朱砂圆点，关闭钮 15×15 默认 opacity 0 hover 显`
4. `生成「搜索框」：99px 胶囊 cloud 底 paper-line 边，内置 13px 放大镜图标，focus-within 转青花边 + 3px qing-wash 光晕，placeholder ink-ghost`
5. `生成「印章品牌钮」：21×21 朱砂圆角4.5 旋转-3° 白色衬线「青」字，内描边 rgba(255,255,255,.18)，hover 印章 scale(.85) 淡出、原位浮现 15px 侧栏开关线稿图标，click 切换侧栏`
6. `生成「状态栏」：28px 高 paper-warm 底顶部发丝线，11px ink-faint 字距.03em，左：朱砂 5.5px 圆点未保存 + 路径；右：字数行数/编码/模式/provider/译中进度，可点项 hover paper-deep`

### Iteration Guide

1. 改任何组件前先读本文件 §2 确认语义色权限（该用墨还是青花还是朱砂）
2. 新控件先问「它是贴面还是悬浮」——贴面用发丝线，悬浮才许阴影
3. 任何新文字先归入 §3 Type Scale 已有层级，禁止发明新字号
4. 涉及文档渲染的改动必须在 mockup-v2 的双语对上验证中英混排效果
5. 动效一律套 `--ease` 曲线；新动效若超过 .45s 需给出理由
6. 深色主题改动必须同步维护 §2 深色草案表的两列对照
7. 图标统一 1.8 stroke 线稿风（lucide），尺寸 13–15px，颜色跟文字层级
8. 每次视觉改动同步回写 `docs/redesign/mockup-v2.html`（它是活的视觉真源）
9. 内存敏感改动（字体/纹理/动画）完成后跑一次空闲内存基线对比
10. 实装顺序建议：token 变量层 → 骨架四层 → 双语对/任务卡 → 微调动画，每步对照 mockup-v2 截图验收
