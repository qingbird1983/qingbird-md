# Changelog

All notable changes to qingbird-md are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- 翻译逐块流式回填（打字机效果）：点翻译后译文按文档序逐块上屏，不再等整篇完成；
  bilingual 逐块追加译文框，translation 逐 run 替换浮现。渲染层新增 data-bi/data-ri
  锚点（与翻译单元索引空间一致），前端打字机缓冲把完成序重排为文档序，网络吞吐不变。

### Fixed

- 修复：预览里点击 Markdown 链接会把整个主窗口导航到外部网站——窗口被站点顶掉，
  自定义标题栏的最小化/最大化/关闭键随页面消失，只能强杀进程。链接渲染统一加
  `target="_blank" rel="noopener noreferrer"`；前端 capture 委托接管点击：http(s)/
  mailto/tel 走系统默认浏览器打开（新增 `open_external` 命令，Rust 侧 URL scheme
  白名单，`javascript:` 等危险协议一律拒绝），`#` 锚点改手动滚动（避开 target=_blank
  的新窗语义），相对路径等一律吞掉不让 WebView 处理；休眠冷重建窗口另挂
  `on_navigation` 兜底，外部站点导航直接拦下。

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
