# LLM 翻译对齐 qingniao（视口按需 · 逐字打字机 · 文献跳过 · 缓存瞬时）+ 把手微调 设计

日期：2026-09-06
状态：已与用户逐项确认（范围=全部四项；默认=视口按需；架构=前端调度器；附两项把手微调）
参照项目：`F:\AI data\work\qingniao`（crates/core 翻译管线 + 两轮精化 spec）；
把手视觉参照 `F:\AI data\work\dsh_desktop`（dsh-client-ui-layout handle CSS）。

## 0. 背景与差异盘点

qingniao 的引擎层蓝本即 qingbird 现有翻译引擎（流式批次协议、缺口并发重试、缓存
变体键同源）。qingniao 在两轮精化中多出的能力，qingbird 缺失的共四项：

| # | qingniao 特性 | qingbird 现状 |
|---|---|---|
| 1 | 视口按需翻译（窗口 [top, bottom+PREFETCH)、滚到哪译到哪、会话门、RunDone 边界自动扩展） | 永远整篇跑 |
| 2 | 逐字打字机（~200 字/秒、重锚 flush、行高锁定）+ 缓存命中瞬时上屏 | 打字机仅做块级按文档序放行，整块瞬移 |
| 3 | 参考文献区段自动跳过 | 无 |
| 4 | Done 载荷携带 from_cache，缓存块不打字动画 | 缓存命中先行发事件，但前端无法区分 |

非移植项（有明确理由）：两步降级重试（qingbird 用 HTML run 级替换保结构，无 ⟦⟧
占位符，token 损坏问题不存在）；虚拟化正文（浏览器渲染，非 windui O(N) 重建问题）；
清理缓存按钮 / LLM 厂商预设（qingbird 已有）。

**已确认的用户决策**：
- 四项全部移植。
- 切到译文/双语模式默认**视口按需**；「翻译全文」保留为菜单次要入口。
- 视口状态机放**前端**（React store），后端保持一次性 run 模型，只加窗口参数。

## 1. 决策表

| 决策 | 选择 | 理由 |
|---|---|---|
| 调度器位置 | 前端 useTranslationStore | 复用现有 gen/mode/runContent 护栏；浏览器滚动观察（getBoundingClientRect）远比 windui 容易；避免 bridge 从一次性 run 改常驻控制器的双源冲突 |
| 后端形态 | translate_document 增 `window: Option<[usize;2]>`，引擎仍一次性 run | 改动最小；重叠窗口的缓存命中让反复起跑近乎零成本 |
| 窗口空间 | data-bi 块索引空间（translatable 块计数），`[top, bottom+PREFETCH)`，PREFETCH=4 | 与 html.rs 锚点、bilingual units 同空间；PREFETCH 用 qingniao 实测定值 |
| 视口观察 | rAF 节流 scroll handler + data-bi 锚点 offsetTop 缓存 + 二分 | 不用 IntersectionObserver（滚动中不停留在视口内的块拿不到持续位置）；锚点缓存失效于 innerHTML 重建；估算误差由 PREFETCH 吸收 |
| 自动扩展评估 | 运行中只记锚点；run done 后评估：当前窗口 ≠ 上轮窗口 → 起新 run；相同 → 收口 | 对齐 qingniao「绝不取消在跑批」；无需后端暴露 units 清单（窗口内 units 全部缓存命中时后端秒回） |
| 窗口化 done 载荷 | 不带整树 html，只带窗口 pairs | 后端只有窗口 pairs，整树渲染会把已译块打回原文 |
| 翻译态显示真源 | 会话期间 = partial patch 的 DOM + 累积 partial 状态；收口（静默防抖）= render_translated 重建 canonical html | 对齐 qingniao「已译内容保持不动」；切视图/重渲靠水位复位重 patch 兜底 |
| 打字机形态 | 两段：文档序放行（现有）→ reveal 队列逐字显现 | 放行重排逻辑零改动；逐字只是显示层动画 |
| 行高锁定 | 打字起始 min-height=锚点当前渲染高度，commit 移除 | 浏览器逐字更新只在行数变化时回流 → 位移按行阶跃（每块 1-2 次），无需估高 |
| 文献跳过归属 | 新 `translate/skip.rs` 规则模块，units.rs 两收集器与 html.rs 占号共用同一判定 | 三处索引空间必须逐位一致，判定只能有一份 |
| 取消语义 | stop() → scope=off：滚动不再触发，直到再次显式触发 | 对齐 qingniao「取消=真停」 |

## 2. 后端改动（src-tauri）

### 2.1 `translate/skip.rs`（新）：参考文献区段规则

- 入口标题：`Heading(level)` 的纯文本 trim 后整串（英文不区分大小写）等于
  `references` / `bibliography` / `works cited` / `literature cited` /
  `参考文献` / `参考资料` / `参考书目` / `引用文献`。
- 区段内所有块不可译（含入口标题本身），直到 `Heading(l2)` 且 `l2 <= level` 复位
  （复位标题自身重新判定）。区段状态沿文档序 DFS 遍历传递（quote/list 内嵌块跟随）。
- API：`pub struct RefSkipState { in_section: bool, entry_level: u8 }` + 纯状态机
  `fn feed(&mut self, kind: RefKind<'_>) -> bool`（`RefKind::Heading(u8, &str)` /
  `RefKind::Other`），返回该块是否被区段跳过；供 units.rs / html.rs 在各自遍历里
  逐块调用（`Block::Heading { level, text }` 的 plain text 作标题输入）。
- 测试：H1/H2/H3 入口、同级复位、子级标题不复位、无命中零行为变化、
  "6.4 参考实现" 不触发、区段内 list/quote/table 全部标记。

### 2.2 `markdown/units.rs`：窗口化收集

- `collect_translatable_windowed(blocks, window: (usize, usize))`：bilingual 用，
  仅收集块索引 ∈ [top, end) 的单元（索引空间 = 现有 data-bi 空间）。
- `collect_text_runs_windowed(blocks, window)`：substituted 用，walk 同时维护
  「当前所属块的 data-bi 影子计数」（判定规则与 html.rs 逐位一致），仅收集
  所属块在窗口内的 run（run 自身索引语义不变）。
- 两个收集器与 skip 规则整合：不可译判定 = 现有 `needs_translation` && !文献区段。

### 2.3 `markdown/html.rs`：占号一致

- data-bi/data-ri 的占号与「是否可译」判定改为调用 2.1 的同一规则
  （文献区段块不占号不渲染锚点，与 units 计数保持逐位对齐）。
- 回归测试：构造含文献区段文档，断言 data-bi 序列 == collect_translatable 索引序列。

### 2.4 `translate/engine.rs`：from_cache

- `EngineEvent::Unit` 增 `from_cache: bool`（缓存命中路径 true，网络路径 false）。

### 2.5 `bridge.rs`：窗口参数与载荷形态

- `translate_document` 增可选参数 `window: Option<[usize;2]>`；None = 全文（现行为）。
- 窗口化 run：units 走 2.2 收集器；`translation-partial` 事件增 `from_cache` 字段；
  done/cached 载荷**省略** html_original/html_translation/html_bilingual（outline 照旧）。
- 新命令 `render_translated(content, mode, translations) -> { html_original, html, outline }`
  （复用 `html_payload_parts`），供前端会话收口重建 canonical html。

## 3. 前端调度状态机（useTranslationStore 扩展）

- 状态：`scope: "off" | "viewport" | "full"`；`viewportAnchor: {top, bottom} | null`。
- 触发：
  - `switchMode` 到译文/双语 → scope=viewport，窗口 = 当前视口（锚点缺失回退 `[0, 4)`）。
  - 菜单「翻译全文」→ scope=full，window=null（现行为）。
  - 「重新翻译」→ 按当前 scope 重跑。
- 会话门：scope=off 时 SetViewport 只记录，绝不发起（对齐 qingniao 初始 gate）。
- 运行中：滚动只更新锚点，不取消在跑 run；done 评估：当前锚点窗口 ≠ 上轮窗口 →
  起新窗口 run；相同 → 收口。done(ok) 后窗口内全部命中 = 自然终止（无需 units 清单）。
- done 处理：窗口化 → pairs merge 进 `tab.translations`（新增 merge 语义，不整表
  replace）；full → 现行为。失败 toast + scope=off（防自动扩展无限重试）。
- 收口：静默（无 run + reveal 队列空）防抖 ~300ms 调 `render_translated` 重建
  doneHtml；响应落地前复查仍在静默且 contentKey 一致，否则丢弃。
- stop()：scope=off（gen 前跳 + 现有取消语义不变）。

## 4. 滚动观察（PreviewView）

- rAF 节流 scroll listener；维护 `{blockIndex, element, offsetTop}` 锚点表
  （querySelectorAll('[data-bi]') 建表，innerHTML 重建/打字 commit 后标脏重建）。
- scroll → scrollY + 二分 offsetTop → (top, bottom)（bottom = 视口底所在块索引）→
  store.SetViewport（去重：任一变化才上报）。
- 估算不追完美：PREFETCH=4 吸收误差；缓存命中让重复窗口零成本。

## 5. 逐字打字机（typewriter.ts 扩展 + reveal 队列）

- 保留现有文档序放行（typewriterPush）；放行块入 reveal 队列（新纯逻辑模块，
  tick 注入可测）：一次一块，~200 字/秒（30ms tick × ~6 字），char 边界切片
  （for..of / Array.from，UTF-16 代理对安全）。
- from_cache 块跳过动画：直接 commit 上屏（二次翻译整屏瞬时替换）。
- 重锚 flush：SetViewport 新区域与当前打字区域脱钩 → 区域外缓冲全部瞬时上屏，
  区域重置为新锚点继续按序（防"追字幕"）。
- 行高锁定：typing 起始给锚点元素设 min-height=当前渲染高度，commit 时清除。
- PreviewView patch：reveal tick 直接写锚点 textContent 切片（复用 patchPartial 的
  data-bi/data-ri 定位与 XSS 边界）；innerHTML 重建时打字水位复位、缓冲重 patch。

## 6. UI 入口与把手微调

- TranslateMenu：「译文/中英对照」= 视口按需；新增「翻译全文」项；「重新翻译」
  disabled 语义照旧。TranslationBar：标签显示「视口翻译 / 全文翻译」。
- **把手热区放宽**：`.content-resizer` 宽 8px → 20px（-10px 回拉半宽，仍贴栏缘）。
- **药丸改梭形**：`::after` 12×32 r10 → 4×140、`border-radius: 50%`（椭圆即
  中间粗两头尖），颜色灰（`--bg3`/`--border-strong` 体系）；拖拽态不再用 accent 蓝，
  改深一档灰（`--border-strong` 底 + 无阴影）。参照 DSH handle：
  相邻面板 hover 也应亮出（右把手监听右缘内侧近邻、左把手同理——热区已含
  内容侧 10px，自然覆盖）。

## 7. 错误与护栏

- runContent / mode / contentKey 护栏全部照旧（宁缺勿错）。
- 单段失败引擎层缺口重试兜底；done(err) = 系统性失败 → toast + scope=off。
- 划词翻译（translateSelection/lookup）零改动。

## 8. 测试与验收

自动化：
- Rust：skip 状态机表驱动；窗口化收集（含 skip 整合）；html 占号与 units 对齐；
  from_cache 标志；窗口化 done 无 html；render_translated 幂等。
- TS（vitest）：reveal 状态机（按序/阻塞/from_cache 瞬时/flush/字节安全/停机）；
  窗口评估纯函数（窗口变化→新 run、相同→收口）；merge 语义。
手动验收（改编 qingniao 清单）：
1. 切译文 → 当前屏自锚点向下逐字显现；停住不动 → 窗口译完即止（token 只花窗口内）。
2. 缓慢下滚 → 波浪跟随无闪烁；快速跳文末 → 重锚 flush 无追字幕。
3. 滚到底无残留未译；取消 → 滚动不再触发；再切模式恢复。
4. 菜单「翻译全文」→ 整篇行为回归；含文献区段文档 → 文献区零请求。
5. 翻译→原文→再翻译 → 缓存全命中整屏瞬时替换无动画。
6. 把手：热区变宽易命中；药丸灰色梭形 ~140px 长。

## 9. 风险

| 风险 | 处置 |
|---|---|
| html.rs 与 units.rs 占号对齐被 skip 规则打破 | 同一判定函数 + 对齐回归测试锚定 |
| 锚点 offsetTop 缓存在打字期漂移 | 标脏重建 + PREFETCH 吸收；不追求逐像素精确 |
| 收口重建与自动扩展新 run 竞态 | 落地前复查静默态，否则丢弃（patch 已是显示真源） |
| 逐字 tick 高频 setState | tick 只写 DOM textContent（零 React 重渲），队列纯模块驱动 |
| 窗口化 run 反复起跑放大请求数 | 缓存命中秒回 + 窗口去重评估；实测 token 曲线验证 |
