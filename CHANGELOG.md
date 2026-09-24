# Changelog

All notable changes to qingbird-md are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.4] - 2026-09-24

翻译从「能看」走到「可信交付」：新增 **AI 语义核查**，让大模型逐条挑出术语、指代、语域这类
只有读懂才看得出的问题，可单条接受或拒绝。预览侧另修了三处「内容看不见」：文首 YAML 元数据
不再被吞，富文本编辑器粘进 Markdown 的表格/卡片不再整块消失，列表的层级关系多了一根发丝细的
引线把同级圆点串起来（可在设置里关掉）。

### Added

- **导出时重排版**（设置 · 翻译 ·「导出时重排版」，默认开）：点「另存为」导出 `.md` 时，对译文
  施加一组**纯确定性、可预期、幂等**的排版规则——中英之间自动留空格（盘古之白）、标点按方向转
  全/半角（`3.14`、英文句末点号刻意不动，宁可漏转不错转）、省略号与破折号归一。**只影响导出的
  那份文件，屏幕上的译文一字不改**；且**只改写译文文本、绝不动块编号**，双语对照的段段对齐不受
  影响。关掉即回到逐字导出。（A 计划第 5 步 22；第 23 项「拆合段」另立工单，本轮未含。）
- **列表层级引线**（设置 · 外观 · 列表 ·「层级引线」，默认开）：同级圆点之间连一根 1px 竖线，
  嵌套列表各自在**自己的缩进槽**里再画一条，层级关系一眼可见。关掉走**选择器门控**
  （整段规则不生成，不留可命中的透明靶子），不是透明度隐藏。偏好落 `useUiStore`（localStorage），
  不进 Rust 设置、不进会话草稿
- **文首 YAML front matter 渲染为只读键值表**：`---` 分隔符是语法、不上屏，但**每个键值都看得见**。
  靠 `name` / `description` 承载语义的文档（SKILL.md / Jekyll / Hugo / Obsidian）读起来不再是残缺的；
  预览与导出内容从此一致（此前预览吞掉它、导出却原样拼回文首）
- **AI 语义核查**（核查面板底部「开始核查」）：在零 AI 成本的确定性检查之外，再让大模型挑出术语
  不一致、指代、语域、数字/专名、句法崩坏这类**只有读懂才看得出来**的问题。每条给「当前 / 建议 /
  理由」，可**单条接受**（译文与预览同步更新）或**拒绝**；结果按块锚点定位，点卡片即跳转并高亮。
  长文档按块窗口**分批**送检（`max_len` 3000 字符/请求、并发 6），时间线显示「N/N 批」进度
- **核查模型可选**（设置 · LLM ·「核查模型」）：留空回落主模型；填了就只让核查走这个模型，划词
  查词仍用原来那个——核查要质量、划词要延迟，两者的取舍方向相反

### Fixed

- **富文本编辑器导出的表格/卡片整块消失**：块级 HTML（如 `<table class="tiptap-table">…`）原先落进
  解析器的空段落兜底分支被吃掉。现按 `Block::Html` 建模并经**净化器**上屏——白名单标签、
  属性只放行数值 `colspan`/`rowspan`、脚本类**连内容一起丢弃**、文本转义 `<`/`>`。
  影响面是**所有** tiptap / Notion / Word 导出的 Markdown，不只某一个文件
- **层级引线根本没穿过圆点**：原先照任务勾选框中心（`-1.075em`）画线，实测**浮在圆点左侧 4.83px**、
  完全碰不到圆点，而且不报任何错。根因是原生 `disc` 的中线由浏览器引擎的 marker 排布算法决定
  （实测 li 内容盒左缘 `-0.763em`），CSS 无从约束。现改为**自绘圆点**，与引线、勾选框同取一条
  `--md-marker-x`，「线过圆点」从「引擎常量碰巧对上了」变成一条 **CSS 恒等式**（实测三者误差 ≤ 0.17px）
- **完成态任务勾选框比未完成态小一圈**：`font-size: 12px` 写在画盒子的伪元素上，让 `1.05em` 的盒子
  跟着缩成 12.59px（未完成态 16.27px）、还高 1px。勾号改由 `::after` 承载、字形用 `transform: scale()` 缩
- **嵌套列表之后层级引线断 10px**：末位块的下边距会**从 `li` 里逃逸**（嵌套 `ul` 0.9em、代码卡 1.2em），
  原来的 `bottom: -0.25em` 只桥得住 `li + li` 的项间距。改为 `-1em`，覆盖到 1.25em 的逃逸量

### Changed

- **翻译缓存后端由 JSON 换为 SQLite**（S9 · C 计划 Step 1–3，纯后端，行为对用户透明）：译文缓存
  与划词查词缓存从「全量重写的 `qingbird-cache.json`」迁到 `qingbird-cache.db`（rusqlite + WAL +
  内存热层预热最新 1000 条）。收益：写盘不再随缓存规模线性膨胀、重启后 FIFO 淘汰顺序真实（旧
  JSON 版做不到）、读路径不写库。老用户首次启动时旧 JSON **一次性导入**空库，成功后原文件
  **重命名保留为 `qingbird-cache.json.imported-<时间戳>`（不删除，可回滚）**；`translate/` 保持同步、
  缓存库不进 IPC 契约、`types/ipc.ts` 零改动。（真机冒烟验收通过）

## [0.2.3] - 2026-09-19

翻译链路补上了「检查」这一环：译完不再只能肉眼看，而能跑一遍**零 AI 成本的结构检查**
（漏译、原文充译、标记丢失、结构不对等、代码被侵入），并在新的 **AI 核查面板** 里按类别看计数。
导出这边补上对照稿——**译文另存为**在对照模式下直接产出「原文 + 译文」逐段对照的 Markdown。
同时修掉一条会把整棵组件树卸载的启动白屏，以及面板把手/边线的若干视觉瑕疵。

### Added

- **AI 核查面板**（状态栏右端「AI」钮 / 快捷键 `Ctrl+J`）
  - 侧栏槽位泛化：原「大纲栏专属列」改为**双宿主侧栏槽**，核查面板与大纲栏共用两个既有槽位。
    **不新增网格列**，列编号、拖宽条数量、入场动画两态一律不动
  - 与大纲同侧时，核查栏是**外一级高栏**（占外侧列，纵向从上抵标签栏、下至状态栏），
    大纲栏顺势内移一列——推移而非覆盖，不翻对侧
  - 面板开合只走状态栏开关（不设把手）；大纲栏保留原有槽边缘把手
  - 关闭状态进会话快照（`SessionUi.show_review` / `review_width`，均带 `#[serde(default)]`，
    旧快照照常读，**不 bump** `SESSION_VERSION`）
  - 空态引导卡分列「确定性检查」与「AI 语义核查」两组；AI 侧未配大模型时**按钮禁用 + 明示原因**，不静默降级
- **确定性检查**（`translate/check.rs`）：五类零成本结构比对——漏译 / 原文充译 / 标记丢失 /
  结构不对等 / 代码被侵入。复用 `data-ri` run 空间，**不调任何大模型**；面板打开且有译文时自动跑
- **双语对照导出**（`translate/export.rs`）：对照模式下「译文另存为…」输出逐段对照稿，
  原文后紧跟译文、空行隔开。按 `data-bi` **块空间**编号，与 `units::walk_collect` 占号逐位对齐，
  判定复用 `block_translatable`，**不自造第二份判据**。代码块 / 公式 / 图片等不可译块只出原文

### Changed

- **CSS 按域拆分**：`global.css` 3636 行 → 52 行 manifest（13 条 `@import`）+ 13 个域文件
  （最大 694 行）。拆分依据是原文件内已有的注释分隔，**无一行逻辑改动**
- 工具栏移除大纲开关钮（入口保留在汉堡菜单与槽边缘把手）

### Fixed

- **启动白屏**（严重）：`credsFor` 在 settings 异步加载完成前返回 `?? {}` —— 每次都是新对象。
  它被首次用作 zustand v5 selector 后，`useSyncExternalStore` 的 `getSnapshot` 引用不再稳定
  → 无限重渲染 → React 抛 `Maximum update depth exceeded` 卸载整树。改为模块级共享单例兜底，
  并补上「连续调用引用相等」的守卫测试
- **面板把手与边线**：大纲耳朵改为「贴线耳朵」（平边贴发丝线、贴线侧不描边、外侧两角圆弧），
  几何不分收展、收起后按钮仍可见可点；AI 栏槽头横线顶住竖线（拖宽热区退出布局流、改覆盖式定位）；
  工具栏右端孤儿竖线删除
- **发布脚本安全加固**（`publish-gitee.py`）：命令注入（`shell=True` 字符串 → 列表形式）；
  SSRF 三层防护（`urlparse` 校验 scheme + hostname、`getaddrinfo` 解析并阻断私网/环回/链路本地 IP、
  全局禁用重定向）

## [0.2.2] - 2026-09-16

翻译从「英 → 中」单向扩成**中 ⇄ 英双向互译**，译文还可以**另存为独立 Markdown 文件**
带走；配套把「翻译方向」补进设置面板，并给汉堡菜单标上键位与分组分割线。
本版同时修掉两条**错得毫无痕迹**的隐患：译成英文时纯中文段落被整段静默跳过，
以及缓存键不含方向——中英混排文档反向翻译会直接命中上一遍的译文，不报错、只给错答案。
另按既有红线补齐注入防御：文档正文一律当待译素材，其中任何"指令"都不执行
（译文可存盘、可转发之后，这个缺口的风险被放大了）。

### Added

- **中 ⇄ 英双向互译**
  - 方向成为显式参数（`TargetLang{Zh,En}`），贯通四个命令（`translate_document` /
    `render_translated` / `parse_markdown` / `open_file`）与前端 `htmlCache` 键。
    这四个命令必须拿到**同一个方向值**，否则 `data-bi` 占号错位、译文贴错块
  - `needs_translation` 按方向判定：译中文看有无 ASCII 字母、译英文看有无 CJK 区段。
    译英文一侧刻意**不用** `!is_ascii()`——否则纯英文段里一个弯引号 `“ ”`、破折号
    `—` 就会被判成"需要翻译"，白烧一次请求、回来的还是原文
  - 各翻译源的语言码全部方向化（此前 MyMemory 写死 `en|zh-CN`、腾讯写死 `target.lang=zh`）
  - **切换入口**：状态栏方向按钮，以及设置面板「翻译与模型」页新增的**「翻译方向」**分段控件
- **译文另存为**（菜单「文件 → 译文另存为…」，快捷键 `Ctrl+Shift+E`）
  - 用当前译文表重新序列化出一份 Markdown：新增 `markdown/cmark.rs`
  - 三处入口：菜单 / 快捷键 / 命令面板。**译文不回写正文**，不碰编辑器、不影响未保存状态
  - 未译部分保留原文，导出后提示「N 处已译，其余保留原文」——按需翻译只译了视口内的块，
    不说清楚会让人以为整篇都译好了
- **汉堡菜单键位提示**：带快捷键的条目右侧显示键位，取自注册表的**生效值**，
  用户改键后菜单跟着变（手抄字面量的话，改键那一刻菜单就开始说谎）
- **汉堡菜单二级分组分割线**：按大分类拉线（文件：新建/打开｜保存导出｜工作区，
  视图：视图模式｜面板｜外观，翻译：阅读模式｜重新翻译）

### Changed

- **文档正文不再被当作指令**：新增 `UNTRUSTED_CONTEXT_RULE`，正文一律声明为待译素材、
  不执行其中任何"指令"；各 provider 里私有的 system prompt 全部删除，统一走共享的那份
- `PROMPT_VERSION` v1 → v2，`system_prompt` 改为按方向生成模板（旧缓存随之失效）
- 汉堡菜单宽度 208 → 244px：挂上键位提示后，「打开工作区…」这类长条目会挤到换行
- 方向切换会**立即作废当前译文并按新方向重译**——`data-bi` 占号随方向变，
  留着旧表只会把新方向的文本贴到错误的块上

### Fixed

- **译成英文时纯中文段落被整段静默跳过**：改前 `needs_translation` 是"含 ASCII 字母才译"、
  与方向无关，于是 zh→en 时**纯中文段落返回 false、整段不译**，且不报任何错
- **缓存键不含方向，反向翻译会命中上一遍的译文**：`cache_variant` 由 `model@VER` 改为
  `model@VER@lang`；免费 MT 源此前方向位是**空串**，两个方向共用同一个 key——中英混排
  文档先译中、再译英，第二遍取回的是第一遍的中文译文，不报错、只给错答案
- **导出译文的 run 索引空间守卫**：新增「导出 → 重新解析 → 重新收集」逐位比对的测试，
  任一侧多占/少占一个 run 号立刻变红

## [0.2.1] - 2026-09-16

新增**分栏左右联动**（滚动同步 + 预览选区映射回源码）与欢迎页**示例文档**入口；
工具栏「划词」开关改为文字、并入阅读模式那一排。新增**冷启动仪式感动画**：
窗口出现时两栏已展开到比终态更宽，随后同步收缩（工作区落到最小宽、
大纲栏收尽），欢迎内容同时从无到有放大落定，三者同一时长、同一节奏。
到位后三处都有"微弱回弹"——侧栏/标签条用 `cubic-bezier(0.34, 1.32, 0.64, 1)`
过冲曲线实现宽度回弹；大纲栏因终值 0、负宽会被钳，改用专属 keyframes
末段弹回一小条再收尽；欢迎内容同样用专属 keyframes 放大过头再回 1。
并修掉**翻译打字机「前几行有打字效果、其余等进度条跑完一次性回填」**的顽疾——
根因是 `Started` 响应竞态（详见 Fixed 首条）。

### Added

- **冷启动仪式感动画**（仅冷启动且最终落在欢迎页时演）
  - 窗口 reveal 前由前端摆好「两栏展开到比终态更宽」起始帧，再通知 Rust 显示窗口；
    两侧宽度与欢迎内容缩放共用 1280ms 同一时长，同时落定
  - 三处到位后都有"微弱回弹"：侧栏 / 标签条 margin 用
    `cubic-bezier(0.34, 1.32, 0.64, 1)` 过冲曲线；大纲栏 width 终值 0、
    负宽会被钳 0 看不到回弹，改用专属 keyframes 末段弹一小条再收尽；
    欢迎内容用专属 keyframes 放大过头再回 1
  - 静默驻留启动（`--minimized`）、双击 .md 文件带参启动、恢复出文档的休眠
    冷重建、系统开启「减少动画」时一律直接显示正常首屏，不演
  - Rust 侧 3s 看门狗兜底：前端握手未到也强制显示窗口，动画失败绝不拖启动

- **分栏左右联动**（仅分栏视图生效）
  - 左右滚动同步：以**源行号**为公共坐标——Rust 给每个顶层块写一行 `<!--sl:N-->`
    源行锚点，左侧按 CodeMirror 顶行、右侧按块元素顶边互相跟随。按比例同步在
    图 / 代码块面前会越滚越偏，行号不会
  - **预览区选中的文字，源码区同样被选中**：松手即把选区换算成源码字符区间并选中、
    居中显示、光标落进编辑器，方便直接定位修改。换算不中（选区跨了行内标记或
    多个块）时退回「整个块」，绝不把光标丢到别处
- **欢迎页「打开示例文档」**：内容随包内联，以未命名标签打开（不写磁盘、不标脏，
  要留就 Ctrl+S 另存）
- **预览右下角「回到顶部」**：滚过一屏才淡入，点击平滑滚回顶部；分栏下两侧一起回顶

### Changed

- 工具栏「划词翻译」由右端的图标按钮改为**「划词」文字**，紧跟「双语」之后（发丝线
  分隔）；开关态改用 `aria-pressed` 表达
- 欢迎页四个起手式按钮改为**并排一行**，「打开示例文档」挪到最后一个——尝鲜入口
  不该挡在常规动作前面

### Fixed

- **翻译打字机「只有前几行有打字效果，其余等进度条跑完一次性回填」**——连续四轮
  验收未达标的顽疾，本轮为根因修复：`translate_document` 是**同步**命令，spawn
  完 worker 立即返回 `Started`，而 worker 起跑瞬间的 cache 命中扫描在微秒级就发出
  了 `partial`，**几乎必然抢在 `Started` 的 invoke 响应之前**到达前端；此时前端
  看到的还是上一轮的 `gen` 与 idle 状态，`handlePartial` 的 `gen/status` 护栏把这批
  事件**整批丢弃**。被丢的 run 在打字机放行序列里永久缺位，其后所有块卡在 pending，
  直到 done 触发整树重建才一起上屏——表现就是「前面几行打完就停住，进度条走完
  一次性回填」，且反复实测同一文档时停住点恰好落在第一个缓存块的位置（前几轮
  翻译已落盘的块）。现在：早期事件按 gen 缓冲、`Started` 落定后回放（缓存块照旧
  整块瞬时上屏、不打字）；`invoke` 在飞闩防住「自动续跑 × setViewport」双发竞态
  导致的整轮卡死；done 时新增 `drainPendingToDom` 兜底排空，即使事件真丢也不再等
  整树重建回声。另加运行时诊断：done 时比对已收事件与应到 run，缺失即
  `console.warn` 列出清单
- 引擎 `Failed` 事件此前被 bridge 静默丢弃，失败的翻译单元在前端无声缺位、同样会
  拖停打字机；现在带原文以 `failed:true` 转发，前端原文回退、跳过打字、照常放行
- **`npm run dev` 下示例文档里的 mermaid 图表与公式不渲染**：dev 下 Vite 把 mermaid
  预打包成「入口 + 60 余 chunk」的异步依赖图，加载偶发**挂起**（不是报错），而旧实现
  把失败的 promise 缓存进单例、调用方又用 `void …then()` 把 rejection 吞掉 —— 结果
  整个会话只看到一块空白，且永不重试，还分不清是「加载失败」还是「文档本来没图」。
  现在：失败即拆单例（下次进预览自动重试）、15s 超时护栏把挂起转成可重试的失败、
  失败原因直接写进占位符。**发布版（build 单 chunk）本来就正常**，仅 dev 受影响

## [0.2.0] - 2026-09-14

新增**主题配色系统**（明暗 × 六套纸色）与**设置面板整体重写**；快捷键改为单一真源表驱动、
全部可自定义；大模型配置从单一槽扩成**多档案**。

### Added

- **主题配色系统**
  - 六套纸色配色（宣纸 / 青花 / 墨玉…）× 明暗两档，共 12 种组合；配色与明暗**正交**，
    可任意搭配
  - 配色单一真源 `src/lib/paletteSeeds.ts` → `npm run gen:palettes` 生成 `palettes.css`，
    生成物逐字节受测试锁定；12 档对比度门槛由测试守住
  - 阅读区、代码块卡片、标题栏、面板与控件全部随配色联动
- **设置面板重写**
  - 左栏五大分类（外观 / 翻译与模型 / 快捷键 / 数据与维护 / 关于）+ 朱砂「青」印
  - 顶部**胶囊搜索**直达任意设置项；无眉头无页脚，**关窗即自动保存**（叉 / Esc / 点遮罩三条路径）
  - 大模型页「翻译源」下拉改为**接口协议**胶囊（OpenAI 兼容可用；Anthropic 兼容占位待支持）
  - 「关于」页新增作者仓库入口
- **快捷键自定义**
  - 新增单一真源 `src/lib/hotkeyRegistry.ts`：一张表驱动 App 匹配，不再硬编 switch
  - 快捷键页可视化管理，冲突检测；前端表、Rust 默认值、模式表**三方对齐由测试钉死**
  - 键位白名单：F1–F12 与符号键可绑，裸字母 / 裸数字 / Space 拒绝（避免劫持正常打字）
- **大模型多档案**：可保存多份 LLM 配置（接口地址 / Key / 模型名）随时切换；
  厂商预设降级为「新建档案时的模板」，不再互相覆盖；拉取的模型列表持久化

### Changed

- 数据目录在界面上显示为 `%APPDATA%\qingbird-md` 形态（不再显示绝对路径，换电脑观感一致）；
  「打开缓存目录」仍走绝对路径
- 欢迎页、关于页、标题栏统一为「纸上翻译」视觉语言
- 正文宽度入口收敛到外观页与命令面板，工具栏按钮移除（边缘可自由拖拽后预设使用率低）

### Fixed

- **代码块「一键复制」会把行号一起复制**：行号 `.ln` 与内容 `.lc` 同在 `<code>` 子树内，
  `textContent` 会带上行号；新增 `codeTextFrom()` 只取内容列，复制走它
- 快捷键页说明过长会把「恢复默认」按钮挤成两行（说明精简 + `flex:none` 兜底）
- 删除最后一份 LLM 档案后被迁移逻辑立刻复活（改为一次性闩锁）

### Security

- 外部链接统一走 `open_external`，仅放行 `http` / `https` / `mailto` / `tel`

## [0.1.10] - 2026-09-12

工作区侧栏重排为「品牌头 / 过滤 / 最近打开 / 文件夹」四段，工作区从单根扩成多文件夹；
同步补齐右键菜单体系（树 / 文件夹 / 最近打开 / 预览区）、空文档欢迎页、快捷键提示，
并细化大纲栏排版与停靠。**文件树右键删除不再一键即删**（改为强制确认、默认取消）。

### Added

- **工作区侧栏重排**（自上而下）：品牌头 / 细分割线 / 过滤胶囊 / 细分割线 /
  最近打开文档 / 细分割线 / 文件夹区
  - 品牌头：左侧「Markdown」+ 朱砂圆点与版本号（版本号由 `vite.config.ts` 从
    `package.json` 注入，前端不再手抄）；右侧四枚图标钮全部接线——打开文档
    （`Ctrl+O`）、打开文件夹（`Ctrl+Shift+O`）、筛选（开关过滤胶囊）、
    刷新工作区（带转圈反馈）
  - 过滤胶囊右端加搜索图标（有输入时换成清空钮）
  - **最近打开文档**：跨会话记忆、上限 10 条、一键清除；条目右侧显示父目录名消歧
  - **文件夹区**：支持**多个文件夹**，各自独立展开成目录树；一键清除
- **右键菜单体系**（全部菜单支持右侧快捷键提示）：
  - 文件树节点：展开/折叠、新建文件、从模板新建（笔记 / 会议 / 计划 / 日记）、
    新建文件夹、在资源管理器中显示、复制路径、在此打开终端、移动到…、重命名、删除
  - 文件夹条目：新建（落该文件夹）、刷新、在资源管理器中显示、复制文件夹路径、
    在此打开终端、从列表移除、清空文件夹列表
  - 最近打开条目：打开、复制文件路径、打开文件位置、从列表移除、清空最近打开
  - 预览区：复制 / 复制全文 Markdown / 全选，插入子菜单（段落 / 标题 1-3 / 引用 /
    代码块 / 分割线 / 表格 / 公式 / Mermaid 图片 / 链接），在源码中编辑
  - 空白区：新建、刷新、打开文件夹、复制路径、清空列表
- **行内操作**：树行 hover 按钮（目录 = 新建文件/文件夹，文件 = 重命名/删除）、
  行内重命名输入框（Enter 提交 / Esc 取消 / 失焦提交）
- **删除语义分级**（数据安全）：
  - 记忆类列表（最近打开文档 / 文件夹列表）的「移除 / 清除」**只动列表、绝不碰磁盘**，
    并以 toast 明确告知「磁盘文件未改动」
  - 文件树内的「删除」保留（Windows 回收站），但强制二次确认，**默认焦点落在「取消」**
- 新增通用确认弹窗 `ConfirmDialog.showConfirm`（Promise 式，危险操作走描边朱砂钮
  且默认取消）
- 新增快捷键并全部接进菜单提示：`Ctrl+N` 新建文件、`F5` 刷新工作区、
  树行 `F2` 重命名 / `Del` 删除 / `Enter` 打开
- 空文档欢迎页：朱砂「青」印 + 新建文档 / 打开文件 / 打开文件夹 + 快捷键提示
- 大纲栏：标题栏细分隔线、一键展开/收展全部、左右停靠切换（靠左吸附工作区边）、
  内容超出高度可滚动
- 后端文件操作命令：`rename_path` / `delete_path`（回收站）/ `reveal_path` /
  `open_terminal` / `move_path`（含跨盘回退）/ `create_from_template`
- 路径工具抽成 `src/lib/wsPath.ts` 纯函数模块（+20 条单测）

### Changed

- 工作区从单根扩成**多文件夹**，记忆随之升级：`qb.ws-folders`（列表 + 各自展开态）、
  `qb.ws-memory`（按文件夹记已展开子目录，**兼容旧的 `{open, selected}` 形状**）、
  `qb.ws-selected`、`qb.ws-filter`；均走 localStorage，不动 Rust 会话快照契约
- 「最近打开文档」挂在 `useDocStore.openTab` 这一唯一「按路径打开」漏斗上，树点击 /
  `Ctrl+O` / 命令面板 / 文件关联 / 休眠交接 / 欢迎页 / 菜单各入口一律登记
- 命令面板的文件检索改为跨全部文件夹的扁平索引（不再只看单一根），并显示相对路径
- `F5` 由「纯拦截防重载」改为「无文件夹时拦截、有文件夹时刷新工作区」
- 大纲栏行距回调、改用内置思源宋体、各级标题层级区分度提升

### Fixed

- 大纲栏内容超出可视高度被裁切且无法滚动（`.panel-clip` 补纵向 flex 容器约束）
- 路径归属判定补盘根分支：`C:\` 自带尾分隔符会让「取下一位字符」的边界检查全部
  返回 false，`C:\a.md` 此前无法归属到 `C:\`
- 休眠恢复与记忆恢复改为**合并式**，避免先恢复的活动文件夹把其余记忆条目挤掉


## [0.1.9] - 2026-09-12

界面整体重设计「纸上翻译」：宣纸暖底 + 墨色界面 + 青花强调 + 朱砂印章品牌，
文档层内置思源宋体衬线排版，桌面图标同步换新。

### Added

- 全新「纸上翻译」界面设计系统（DESIGN.md）：宣纸三层底色（#f7f4ec 系）+
  全局纸纹噪点、墨色三级前景、青花 #31678E 唯一彩色强调（仅翻译语义）、
  朱砂 #B3483A 品牌印 / 警示语义；贴面零阴影发丝线体系 + 暗色主题全套映射
- 内置思源宋体（SIL OFL，400/700 woff2 共 3MB）：预览文档层整体衬线化
  （15.5px / 行高 2.0），双语译文改青花左标对照行；UI 无衬线走系统栈零体积
- 桌面图标换朱砂「青」印：底斜字正（印斜 4°、字正置），全套尺寸再生成
- 标题栏朱砂印章钮：品牌 logo 与工作区开关二合一（hover 显开关图标）
- 整篇翻译进度改右下悬浮任务卡：朱砂「译」印 + 流光进度条 + 取消钮
- 划词翻译浮窗词典卡化：衬线词头 + 青花释义 + 词性标签

### Changed

- 标签页改下划线式（激活 = 墨色底线），未保存脏标换朱砂点
- 阅读模式切换改下划线文字分段（原文/译文/双语，青花下划线）；
  视图切换改胶囊分段（源码/分栏/预览三态直切）
- 工作区文件树选中态：cloud 浮起 + 青花左标；搜索框胶囊化；
  侧栏/大纲分区标题改大字距微标签

## [0.1.8] - 2026-09-11

渲染细节打磨与工作区联动：代码块卡片重构（行号分隔线位数进位修复）、
Markdown 语法覆盖补齐（脚注 / `==高亮==` / 表格对齐 / front matter）、
汉堡菜单二级卡片独立弹出、面板收展过渡动画、标签条起点跟随工作区分隔线。

### Added

- 代码块卡片重构：头栏（语言标签 + 复制按钮）+ 主体两段式布局，行号 gutter
  按总行数位数自适应宽度（`--ln-digits` 烘进 `<code>`），token 配色随明暗主题
- Markdown 语法覆盖补齐（对照语法全覆盖测试文档逐项排查）：
  - front matter（文首 `---` YAML）剥离，不再泄漏成伪分割线/伪标题
  - 脚注：正文上标引用（`[^label]`）+ 文末定义区（可点击跳转/返回），无定义引用按字面渲染
  - 表格列对齐：`:---` / `:---:` / `---:` 产出 `text-align`，表头表体同步
  - `==高亮==` 标记：琥珀底 `<mark>` 明暗两档；micromark-mark 侧翼规则
    （开右/闭左非空白、跨节点折叠、`===` 长连跑字面、未闭合自愈退回不劈裂 run）
- 标题栏「设置」按钮：明暗主题切换按钮旁直达设置弹窗

### Changed

- 汉堡菜单：二级菜单改为独立卡片，贴在所选分类右侧弹出（与一级卡片 0px 无缝
  相接）；一级分类激活态只做高亮（去 ✓ 前缀）；二级卡片视口底缘防溢出
- 工作区/大纲面板收展改为 300ms 宽度过渡动画：内容固定宽裁切不挤压、分隔条
  同步淡出、主区逐帧吸收空列；拖拽调宽时自动关闭过渡保证跟手
- 标签条起点跟随工作区分隔线：工作区拉宽标签条同步右移（与主区左缘对齐），
  拉窄/隐藏时归位标题栏分割线；工作区最小宽度动态等于标签条归位临界
  （拉到最小时分隔线与标签条贴左位置重合，对齐零死区）

### Fixed

- 修复：代码块行号分隔线在 1→9、10→99、100→999 位数进位处断裂/错位。三因
  叠加：行容器 flex-start 使边框不随行拉伸、gutter 列宽逐行突变、全局
  `box-sizing: border-box` 让 `min-width` 连 padding 一起算——行号列显式
  `content-box` + 整块统一 `--ln-digits` 后分隔线连续且列宽恒定

## [0.1.7] - 2026-09-06

翻译体验对齐 qingniao 参考实现：视口按需翻译滚到哪译到哪、逐字打字机上屏、
参考文献区段自动跳过；翻译进度条改悬浮层不再推挤正文；修复缓存全命中只
刷新视口窗口的问题。

### Added

- 视口按需翻译：切到译文/双语默认只译“可见区+预取”，滚到哪译到哪；菜单新增「翻译全文」
- 逐字打字机：译文按文档序 200 字/秒逐字显现；缓存命中瞬时上屏；快速滚动自动 flush
- 参考文献区段自动跳过：References/参考文献 等标题区段不送译
- 拖宽把手：热区放宽至 20px，药丸改灰色梭形

### Fixed

- 修复：第二次点翻译（缓存全命中）只替换视口那几行，要滚动才逐段补齐。根因是窗口化
  缓存载荷只携带窗口内的缓存对——文档其余部分的缓存命中后端从不回带，前端无从展示。
  现在窗口化缓存全命中时顺带**整篇扫荡**：与该模式同一索引空间收集全文可译单元、逐
  单元查缓存，命中即一并回带；前端凭完整表 merge+瞬时上屏+canonical 重建，一次整屏
  替换（缓存瞬时上屏的本意）。未命中块维持原文，滚动触发的视口运行照旧补齐。
- 修复：翻译进度条挤压正文。进度条原是文档流内 flex 条，翻译开始占一行、结束释放
  一行——滚动触发翻译/翻译结束时正文上下跳。改为悬浮层：absolute 钉在主区顶缘、
  不占布局，滚动与正文无关，附阴影分层。
- 修复：开机自启驻留托盘后双击 .md 打开文档，弹出的窗口是纯白屏（什么都没有），
  只有从托盘退出、再双击才正常。根因是 T25 给休眠冷重建窗口加的 `on_navigation`
  兜底白名单只认 host 恰为 `localhost`/`127.0.0.1`，而 Windows 发布版的前端资源
  URL 是 `http://tauri.localhost/`（Tauri 2 的 custom protocol，见
  `manager::get_app_url`），首屏导航被自己的兜底拦下 → 页面永远空白。dev 下 URL
  是 `localhost:5173` 恰好命中白名单，所以开发期怎么测都正常——只有发布版走得到
  这条路径。白名单改为本机 host 判定（`localhost` 及其子域 + 回环 IP），新增 6 条
  离线单测锁住 `tauri.localhost` 放行与 `tauri.localhost.evil.com` 这类伪造后缀拦截。
- 顺带修同源的 handoff 时序缺陷：冷重建的窗口对象已存在、但页面还在加载（React
  未挂载、`document-changed` 监听未注册）时，单实例 handoff 直接 emit 必丢——emit
  无缓冲也无重放。新增前端就绪标志，这段窗口期（含进程刚启动那几秒）的 handoff
  一律缓冲到 `PENDING_OPEN`，等前端 `take_pending_open` 取走；附 10s 超时兜底，
  避免前端异常时文件关联彻底静默。

### Changed

- 后台内存只涨不跌的三处源头同时治理（用户报告：开机自启 ~5MB，操作多后涨到
  80MB+ 无回收）：
  - **翻译缓存上限 20000 → 5000 条**：`cache::MAX` 下调，长期占用上限从
    ~40MB 降到 ~10MB。超过 5000 即 FIFO 裁 1/4，命中模式不变。
  - **空闲自动收缩**：翻译 worker 收尾时检测距离上次翻译 IPC（translate_text /
    lookup_word / translate_document 任一）已超 10 分钟，则把内存里的 cache
    裁到 1000 条并 save 重写磁盘，下次冷启动也保持小容量。新增 `Cache::shrink_to`
    方法（带 4 条离线单测，含「收缩→save→reload 仍保持小容量」的回归项）。
  - **主动 trim 工作集**：截图窗口 close 后、翻译 worker 收尾（且触发
    shrink）后调 `SetProcessWorkingSetSize(GetCurrentProcess(), -1, -1)`，
    把 Windows 堆保留的空闲页还给 OS——Rust 默认 HeapAlloc 不会自动 decommit，
    这是截图流程 ~25MB 高水位、翻译中间缓冲堆积的根因。新增 `trim.rs` 与
    `windows-sys` 显式依赖（winit 已间接引入，零新增编译量）。

## [0.1.6] - 2026-09-03

预览内点击 Markdown 链接改由系统浏览器打开，主窗口不再被外部网站顶掉；
翻译结果按文档序逐块流式上屏（打字机效果），不再等整篇完成。

### Added

- 翻译逐块流式回填（打字机效果）：点翻译后译文按文档序逐块上屏，不再等整篇完成；
  bilingual 逐块追加译文框，translation 逐 run 替换浮现。渲染层新增 data-bi/data-ri
  锚点（与翻译单元索引空间一致），前端打字机缓冲把完成序重排为文档序，网络吞吐不变。
  （2026-09-03 真机手工验收通过）

### Fixed

- 修复：预览里点击 Markdown 链接会把整个主窗口导航到外部网站——窗口被站点顶掉，
  自定义标题栏的最小化/最大化/关闭键随页面消失，只能强杀进程。链接渲染统一加
  `target="_blank" rel="noopener noreferrer"`；前端 capture 委托接管点击：http(s)/
  mailto/tel 走系统默认浏览器打开（新增 `open_external` 命令，Rust 侧 URL scheme
  白名单，`javascript:` 等危险协议一律拒绝），`#` 锚点改手动滚动（避开 target=_blank
  的新窗语义），相对路径等一律吞掉不让 WebView 处理；休眠冷重建窗口另挂
  `on_navigation` 兜底，外部站点导航直接拦下。（2026-09-03 真机手工验收通过）

## [0.1.5] - 2026-09-03

托盘常驻 + 截图翻译 + 开机自启落地，主窗口 WebView 按需休眠把常驻内存还给系统；
编辑器可靠性补齐（外部修改检测 / 保存前冲突检测 / 非 UTF-8 编码兜底），
导出独立 HTML、命令面板文件直开，预览排版与浮层交互修整。

### Added

- 新增：外部修改检测（窗口聚焦时比对 mtime，弹「重新加载/保留我的版本」；
  「保留」记为新基线，一次外部修改只打扰一次）
- 新增：保存前冲突检测（磁盘 mtime 与打开时不一致 → 弹「覆盖/另存为/取消」）
- 新增：非 UTF-8 编码读取兜底（UTF-8 解码失败自动按 GB18030 解码，
  状态栏标注实际编码；保存始终 UTF-8）
- 新增：导出独立 HTML（文件菜单/应用菜单「导出 HTML…」；内联主题与正文样式、
  按导出时刻明暗落盘，mermaid/KaTeX 取预览已渲染产物，本机图片转 file:// 绝对路径）
- 新增：命令面板文件直开（Ctrl+Shift+P 输入文件名片段即搜工作区文件并打开，
  相对路径匹配、短路径优先、结果截 20 条；`>` 前缀只搜命令）
- 新增：主窗口 WebView 按需休眠（docs/webview-hibernate-plan.md）。
  关窗隐藏后空闲 5 分钟真正销毁 WebView，把常驻内存还给系统；开机自启
  （`--minimized`）不再养一个从没显示过的 WebView。托盘/热键/截图翻译/翻译
  缓存均不经 WebView，休眠零影响。唤醒：5 分钟内秒回，休眠后冷重建并恢复
  会话（标签、未保存草稿、光标/滚动/面板宽度；仅脏 tab 落草稿，一次性，
  恢复即删）。休眠期间双击 .md 能正常重建窗口并打开文件。验收可设
  `QINGBIRD_HIBERNATE_DELAY_SECS` 缩短等待（2026-09-03 沙箱 + 真机手工验收通过）
- 新增：截图翻译（全局热键框选屏幕，有道 OCR 实时译文浮窗覆盖原位；热键可在设置中自定义）
- 新增：系统托盘常驻（关闭主窗口=隐藏到托盘；菜单含显示窗口/截图翻译/开机自启/退出）
- 新增：开机自启动（默认关闭，托盘菜单开关；开机静默驻留托盘）

### Changed

- 变更：预览表格自适应正文宽度（`table { width: 100% }`，列宽仍按内容分配，
  长单元格折行不横溢）
- 变更：正文宽度两档扩四档（紧凑 640 / 标准 794 / 宽 1000 / 全宽 1200；视图菜单
  四选一、工具栏按钮循环切换；旧「宽版」localStorage 偏好自动迁移为「宽」档）

### Fixed

- 修复：命令面板与划词翻译浮窗弹出时先右偏半宽、动画结束后跳回居中——入场动画
  关键帧的 transform 覆盖了 translateX(-50%) 居中；两处改用独立 `translate` 属性

## [0.1.4] - 2026-09-01

品牌换新 + 标题栏交互整理。全新应用图标（`qingniao-md.png` 一源生成全套
ico/icns/PNG/Appx/iOS/Android）、标题栏品牌「青鸟」文字换成 logo 图；
工作区切换按钮从工具栏搬到标题栏；隐藏工作区后主内容区零留白；修复主题
切换不持久。

### Added

- **预览渲染：Mermaid 图表与 KaTeX 数学公式**：预览视图新增 ```mermaid 围
  栏渲染（SVG）、行内 `$...$` 与块状 `$$...$$` / ```math 围栏的 KaTeX 排版
  ；mermaid 通过 `securityLevel: 'strict'` 拒绝执行源码脚本，KaTeX 走
  `throwOnError: false` 错误降级；math / mermaid 块不进双语 `sub_counter`，
  翻译管线零变化。工具栏新增两个插入按钮（Workflow 图标插入空 mermaid 围
  栏、Sigma 图标 wrap 选区或插入空 `$|$` 占位），后端走
  `Options::ENABLE_MATH` 识别，识别不到的 `$$…$$` 在行文中间按 inline
  span 渲染避免非法 HTML。

### Changed

- **应用图标全面换新**：以 `qingniao-md.png`（2000×2000）为源经
  `tauri icon` 重新生成 `src-tauri/icons/` 全套（icon.ico / icon.icns /
  各尺寸 PNG / Appx Square Logo / StoreLogo / iOS / Android mipmap），
  Windows 任务栏、安装器、文件关联图标随之更新。
- **标题栏品牌 logo 化**：「青鸟 Markdown」中的「青鸟」文字换成品牌小图
  （`src/assets/qingniao-logo.png`，源 `qingniao.png` 缩至 128×128），
  「Markdown」文字保留；logo 容器继承 `pointer-events: none`，标题栏拖拽
  行为不变。
- **工作区切换按钮搬到标题栏**：TitleBar 新增 PanelLeft 图标按钮（汉堡
  按钮左侧），隐藏工作区后按钮仍留在标题栏作视觉锚点；EditorToolbar 的
  PanelLeftClose 开关移除，只留大纲开关。
- **隐藏工作区零留白**：工作区隐藏时主内容区左缘直接顶到第一列
  （`--col-main` / `--main-span` CSS 变量切换），TabBar / EditorToolbar /
  MainArea 一起左移，不再出现「左侧两列空白、右侧才有内容」的撕裂。
- **正文宽版加宽**：`.markdown-body.wide` 由 1000px 提至 1200px。
- **标签条并入标题栏**：TabBar 由 App shell 独立行移入 TitleBar 内渲染，
  标题栏中部即标签条，文档名不再重复占位。

### Fixed

- **主题切换不持久**：`setTheme` 先 `applyTheme`（其内部同步写
  `settings.theme`）导致 `cur.theme !== t` 守卫永远为 false、
  `saveSettings` 永不发出，盘上无落痕，重启后回退旧值；调整为先守卫后
  落盘，并补设置未加载（load 未 resolve）时的本地翻转分支。

## [0.1.3] - 2026-08-29

选区查词（Selection word lookup）端到端打通 — 从 Rust 核心查词流水线，
到 IPC 命令、前端 R1 划词分流、富卡片四态渲染、设置面板独立查词模型与在线
拉取。同时补两个标题栏 / 预览态划词的 ACL 与事件路径回归。

### Added

- **选区查词（LLM 富卡片）端到端**：在预览视图划词触发 R1 路径（与翻译 R0
  分流），按词 / 句长度走两套 prompt，由独立的 `lookup_model` 走 LLM
  provider 拿到结构化 JSON，前端把结果渲染为四态卡片（词 / 句 / plain /
  error）。卡片有专属样式，与选区翻译的浮层样式分开。覆盖 `lookup_word`
  IPC、词 / 句分流 prompt、解析容错（容忍 prose 包裹 / 剔除 code fence）、
  磁盘缓存三件套（key 标准化 / `prune_to_cap` / 损坏自愈）。
- **`llm_list_models` IPC 命令**：设置面板点选「拉取模型」按钮，在线调用
  provider 的 `/models` 端点，返回排序后的模型列表。配 Bearer 头、按
  `data: []` / `data[].id` 解析、缺失字段显式报错、URL trailing slash
  归一化。设置里点选后写入 `lookup_model`，不再要求手填模型 ID。
- **设置面板：查词模型独立字段 + 厂商预设下拉**：与翻译 `llm_model` 分开
  的 `lookup_model` 字段；厂商预设继续走统一的下拉选择器（DeepSeek /
  豆包 / GLM / Gemini / Qwen / OpenAI 兼容 / 自定义），baseUrl 与模型
  名按 spec 校正过（豆包官方端点 `ark.cn-beijing.volces.com` 等）。
- **划词 R1 分流**：选中文本经 `R1` 路由走查词 IPC；查词配置缺位时
  退回 `auto` 翻译链，与翻译 R0 行为不冲突。

### Fixed

- **标题栏拖拽被 ACL 拒绝**：自定义标题栏整域 `data-tauri-drag-region`
  触发 `core:window:start-dragging` 但 capabilities 漏声明；补
  `core:window:allow-start-dragging`。
- **预览态划词捕获**：预览视图（HTML）划词不再被原生事件吞掉，监听路径
  补全，划词后弹出查词 / 翻译选择面板。
- **`llmCreds` 可选链守卫还原**：全新安装（`settings.json` 不存在）时
  `baseUrl` 运行时为 `undefined`，去掉守卫会让设置面板在加载阶段卡死；
  恢复 `?.` 链。
- **`fetch_models` 错误补服务端 message**：上游返回非 2xx 时把 body 里的
  `message` / `error` 字段透出，避免只看到状态码；查词入口文本做 `trim`，
  防止首尾空白触发缓存 miss；摘除 spec 中过时的标注。

### Docs

- `docs/superpowers/specs/2026-08-29-selection-word-lookup-design.md`：
  选区查词设计 spec（词 / 句分流 + 查词模型 + 预设下拉 + `llm_list_models`
  模型在线拉取），预设表校正。
- `docs/superpowers/plans/2026-08-29-selection-word-lookup.md`：6 任务
  TDD 实施计划 + 线格式 snake_case 约定。
- `docs/regression-checklist.md`：选区查词手工回归清单（spec §10）。

## [0.1.2] - 2026-08-29

Title bar / hamburger menu / toolbar refinements plus true dark-mode code
blocks. Adds four Tauri window permissions (minimize / maximize /
unmaximize / close) that the custom title bar was silently missing.

### Added

- **Title bar rework**: app name "青鸟 Markdown" now sits before the
  hamburger button; the title bar centre shows the active document name.
- **Two-level hamburger menu**: first level is 文件 / 视图 / 翻译 /
  设置 / 关于 / 退出. 文件 / 视图 / 翻译 expand a second-level flyout to
  the right on hover (180 ms dwell) or click; hovering 设置 / 关于 / 退出
  collapses any open flyout; leaving the panel for 300 ms auto-closes it.
  The panel is edge-aligned with the ☰ button.
- **Toolbar additions**: reading-mode buttons (原文 / 译文 / 中英对照 as
  `Type` / `Languages` / `Rows2` icons), new-tab button after Save,
  wide/narrow content toggle (`StretchHorizontal` / `FoldHorizontal`),
  and a light/dark theme toggle (`Moon` / `Sun`). Everything from the
  source-view button onwards is right-aligned. Sidebar / outline toggles
  no longer keep a persistent active highlight.
- **Theme switch in the menu**: "切换明暗主题" lives in the 视图 submenu.

### Fixed

- **Dark-mode code blocks are now truly dark**: syntax highlighting runs
  twice (InspiredGitHub for light, base16-ocean.dark for dark) and each
  token span carries both colors as CSS custom properties `--cl` / `--cd`,
  selected by `body[data-theme]`. Previously dark mode kept the light-gray
  code blocks with harsh contrast. Code-block background, line numbers,
  default text and the code-lang pill all gain dark variants. Rendered
  HTML stays theme-independent, so parse / translation caches are
  unaffected.
- **Window control buttons (minimize / maximize / close) now work**: the
  custom title bar invoked `core:window` setters that were not in the
  capability list; added `core:window:allow-minimize` / `allow-maximize` /
  `allow-unmaximize` / `allow-close`.

## [0.1.1] - 2026-08-28

Multi-tab editing plus a UI layout shift to match the in-app reference.
Source-only refactor of the frontend; no Rust / IPC contract changes, no
new dependencies, no new permission scopes.

### Added

- **Multi-tab editor**: open multiple `.md` / `.markdown` / `.txt` files
  side-by-side in a single window. Each tab keeps its own scroll position,
  cursor / selection, view mode, parsing cache, translation cache, and
  dirty state. Switching tabs re-mounts CodeMirror in place and restores
  cursor + scroll on the next frame.
- **Tab strip** (below the menu bar): close-via-`X`, close-via-double-click,
  `+` to add a new blank tab, inactive tabs show hover X, active tab fills
  the strip background. Newest tab opens at the right edge.
- **Dirty-confirm dialog** when closing a tab with unsaved changes: Save
  / Don't Save / Cancel, with `Esc` mapped to Cancel.
- **Layout shift** (per in-app reference image): top menu bar stays at
  row 1; tab strip on row 2 only spans the centre column; editor toolbar
  hoisted to row 3 (above the editor, not inside it); main editor +
  workspace tree + outline + resizers on row 4; status bar on row 5.
  Workspace tree's right divider and outline's left divider both span
  rows 2–5 so the side rails read as full-height panels.

### Changed

- **Default view on opening a file**: was `source`, now `preview`. The
  reading view is the most common first action for a reader-style app;
  use `Ctrl+Alt+S` (or View menu) to switch into `source` or `split`.
- **Editor toolbar is always visible**, including in `preview` mode
  (was previously hidden when `view === "preview"`). Undo/Redo are
  no-ops in preview (CM not mounted); format buttons operate on the
  last-known cursor position.

### Fixed

- `applyFormat` staleness guard now compares content (not just
  `activeId`), preventing the wrong-tab format-application race when the
  active tab changes during the Rust round-trip.
- `saveDoc` now writes path / name / `savedContent` to the tab whose id
  was captured at entry (via the new `patchTab(id, mut)` helper), not
  whichever tab is active after the file-dialog awaits. Closes a
  data-loss class bug in the close-tab save-then-close flow.
- `setScrollTop` is now id-scoped (signature `(id, n)`) so unmount-time
  scroll flush lands on the tab being unmounted, not the newly-active
  tab — restoring scroll position correctly across tab switches.
- Tab close-during-confirm: a `closingIds` set guards the `DirtyConfirmDialog`
  so concurrent close attempts resolve in order rather than deadlocking the
  promise chain.
- Right-side resizer divider spans rows 2–5 to match the left resizer,
  so the outline panel's left border reads as a single full-height line.

### Known limitations (carried over from 0.1.0)

See [README → Known limitations](README.md#已知限制) for the full list.

## [0.1.0] - 2026-08-28

First public release. Tauri 2 desktop app — Rust core + React/TypeScript UI
— bringing the bilingual Markdown editor/reader to a smaller, faster
native shell. Functionally equivalent to the prior Electron build; this
round is the webview-frontend rewrite of the intermediate eframe/egui
experiment.

### Added

- **Markdown render & read**: headings, ordered/unordered/task lists, tables,
  fenced code with `syntect` highlighting, blockquotes, inline formatting,
  relative-path images, links, horizontal rules.
- **Bilingual translation**: seven providers (`tencent`, `youdao`, `baidu`,
  `mymemory`, `llm`, `transmart`, `iciba`) plus an `auto` fallback chain
  (Transmart → iCiba → MyMemory). Three reading modes: original /
  translation / side-by-side bilingual.
- **Translation pipeline**: in-memory + on-disk cache (provider-keyed,
  capped at 20k entries with 25% prune, debounced disk save); adjacent
  short-run merging; long-run splitting at sentence/word boundaries;
  bounded per-provider concurrency.
- **Editor**: CodeMirror 6 source view with formatting toolbar
  (bold/italic/strike, headings, lists, quote, code, link/image/table/hr);
  source / preview / split views; undo/redo; dirty-dot indicator; save
  with `Ctrl+S`.
- **Workspace tree** (left pane): recursive `.md` walk (depth ≤ 10, ≤ 3000
  files, symlink-loop guarded) with live search filter that keeps
  ancestors and auto-expands matches.
- **Outline** (right pane): h1–h3 TOC, slug-unique ids, click-to-scroll.
- **Settings modal**: provider picker with dynamic credential fields,
  per-provider notes, test-connection button, cache clear, hotkey
  recorder, selection-translation toggle.
- **Selection-translation popup**: floating card over selected preview
  text with source / translated text / copy button.
- **Light / dark theme** (CSS variable driven), remembered across
  launches; first run follows system.
- **Status bar**: breadcrumb, dirty dot, char/line counts, provider and
  translation status.
- **Single instance** with file-argument handoff (`.md` / `.markdown` /
  `.txt`); second launch forwards the path to the running window.
- **Global hotkeys** for mode switching (`tauri-plugin-global-shortcut`).
- **NSIS installer** for Windows x64; `.md` / `.markdown` / `.txt` file
  associations registered; install mode `currentUser`.

### Changed (this commit window)

- `open_file` is now `async` and ships the first markdown render in one
  trip — the preview's first frame is populated by `DocDTO.parse` instead
  of an extra `parse_markdown` round-trip after the document opens.
  The render is CPU-bound for large docs, so it is off the UI thread.
- `ensureParsed` (TS) now debounces 150 ms: every keystroke lands in the
  miss branch, but only the content at rest is parsed.
- `ParseResult` / `OutlineItem` derive `Default` + `Deserialize` so
  `DocDTO` can be serde-roundtripped.

### Known limitations

See [README → Known limitations](README.md#已知限制) for the full list,
including: events fired before the frontend listener mounts are lost
(planned: pull-command fallback), `Mod+B` / `Mod+I` still act on the
document behind an open settings modal (legacy behaviour carried over),
`codemirror-lang-math` is a low-trust small personal package (MIT,
SRI-pinned) and math is fenced-block only, the workspace new-directory
helper is Windows-only, clearing the translation cache does not dirty
the document, and the `icon.ico` must use BMP frames for `winres` to
embed (rebuild via Pillow with `bitmap_format="bmp"`).
