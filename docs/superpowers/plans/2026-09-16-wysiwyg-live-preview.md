# 所见即所得编辑：选型调研与落地建议

**Date:** 2026-09-16
**触发:** 用户提出为 qingbird-md 增加所见即所得（WYSIWYG）编辑能力，提供 4 份同类产品源码作参考
**调研样本:** `F:\AI\SuperMarkdown`、`F:\AI\InkNote`、`F:\Warehouse\Github\Guanmo-open`、`F:\AI\mark2`
**方式:** 读源码与设计文档，提炼思路，不做照搬

> **v2 更新（2026-09-16 18:07）**：用户已拍板产品方向——**翻译供阅读使用，不进编辑器**；加入 WYSIWYG 的理由是**市场竞争**（同类产品不论重阅读还是重编辑，都有这个能力，缺了就没有竞争力）。据此重写 §一、§五、§六，新增 §四「竞争力基线」，其余调研结论不变。
>
> **v3 更新（2026-09-16 18:16）**：用户提出两个新问题——① "就地编辑一般是在预览界面直接编辑，会不会破坏翻译？" ② 翻译能力应向**双向互译 + 译文另存为 md** 扩展。据此重写 §六（明确"就地编辑"分两种形态，我们只做**编辑器层**那一种，从根上避开冲突），新增 §十一「翻译能力扩展」。

---

## 结论先行

1. **不换内核。** 在现有 CodeMirror 6 上做「Decoration 装饰式 Live Preview」。
2. **CodeMirror 路线有结构性优势**：文档在内存里就是那串 Markdown 原文，装饰只作用于渲染层 → **天然不会破坏用户文件**。Tiptap/ProseMirror 路线必须额外造"保源序列化器"才逼近（Mark2 为此写了 18KB 序列化器 + 一整套字节级往返测试；SuperMarkdown 没做 → 毁 front matter）。
3. **翻译不进编辑器，是本次最大的架构利好**：预览面板仍是一等公民，翻译渲染的宿主（`.markdown-body`）**不需要迁移**。原先设想的 `TranslationSurface` 抽象**降级为非必需**，只剩一条轻量的视图状态约束（见 §六）。
4. **值得抄的是 InkNote**（同内核 + 已生产验证），但**必须补上它没做的视口裁剪**——我们的文档更偏长文。

---

## 一、产品定位（已拍板）

用户 2026-09-16 决策：

> "翻译是供阅读使用的，不需要进编辑器。"
> "我调研了市面上大量同类产品，重阅读的、重编辑的**基本都有**这个功能，所以我们的产品如果缺少这个功能，在市面上**没有任何竞争力**。当然我们的流式翻译目前是市面上独一的存在，但也不能靠这一个功能去竞争。"

**结论：定位从"翻译阅读器"扩展为"阅读优先，但编辑能力齐备"。**

这修正了 `docs/superpowers/plans/2026-09-02-inknote-gap-iteration.md` 里"明确不做：Mermaid/公式的就地块编辑器"的旧结论——**那条作废**，本方案正式立项。

同时明确**不做什么**：翻译不迁入编辑器。编辑器负责"写得顺"，预览面板负责"读得好 + 译得准"，两者职责不混。

四家样本的 WYSIWYG 地位（供参照）：

| 产品 | 主推方向 | WYSIWYG 的地位 |
| --- | --- | --- |
| SuperMarkdown | 超越 Typora 的写作体验 | **就是产品本身**（单栏所见即所得） |
| InkNote | 本地优先，"像写普通文档一样写 Markdown" | **就是产品本身**（Live Preview 已取代独立预览） |
| Guanmo（观墨） | 阅读与理解 Markdown | **刻意不做**；只提供预览内 Alt+点击的原位编辑 |
| Mark2 | 全能型文档工具（多格式 + AI 写作 + 卡片导出） | 核心卖点之一，与源码模式并存 |

> 注：Guanmo 是四家里唯一"不做也活得不错"的，但它靠的是阅读标记 / 知识组织 / AI 另一套差异化。我们的差异化是流式翻译，而编辑能力属于**行业基线**——这在用户的判断里已确认。

---

## 二、四家样本：思路提炼（重思路，轻照搬）

### SuperMarkdown（MIT｜Electron + 手写 ProseMirror）

- **内核**：11 个 `prosemirror-*` 包手写 schema，编辑器核心约 2100 行。nodeview 全为原生 DOM（无 React）。
- **独到处**：
  - 代码块与 mermaid **共用同一个 `code_block` 节点**（靠 `language === 'mermaid'` 区分）。
  - 表格**自建**（不用 `prosemirror-tables`）→ **没有列宽、合并单元格、增删行列**。
  - `image` 刻意**不设 `atom:true`**（让 link mark 能包裹 `<a><img></a>`），靠 NodeView 保证整体感。
  - 渲染态/源码态切换：代码块用"编辑代码"按钮开 Modal；公式用**双击**。
- **致命短板（反面教材）**：`serializer.ts` 是**纯语义序列化，无任何原始文本保留**。打开再保存会：
  - `-`/`+` 全变 `*`；缩进硬编码 2 空格；`1)` 变 `1.`
  - Setext 标题变 ATX；`~~~` 围栏变反引号
  - 松散列表被压紧；段内软换行被合并
  - `_x_`/`__x__` 归一化；`***`/`___` 分隔线全变 `---`
  - **不支持 YAML front matter**，`---` 开头被解析成 HR + 正文，保存即破坏
  - 引用式链接全部内联化；schema 无法表达的 HTML **静默丢弃**
- **可借鉴**：nodeview 的"渲染态 vs 源码态"交互；`atom` 的取舍判断。
- **不可借鉴**：它的序列化器。

### InkNote（MIT｜Tauri 2 + React 19 + **CodeMirror 6**）★ 主参照

- **为什么最关键**：**内核与 qingbird 完全同源**（CodeMirror 6 + `@codemirror/lang-markdown`），已生产验证。
- **四个核心机制**：

  1. **显形三层强度**（整套方案的心脏）
     - `HIDE_MARK = Decoration.replace({})` —— 光标压上即显形（行内标记）
     - 带 `revealFrom/revealTo` 的 replace —— 进入节点范围才显形
     - `NEVER_REVEAL = { from: 1, to: 0 }` —— 空区间使判定 `head < revealFrom || head > revealTo` **恒真** → 永不显形。用于列表符号、引用标记、**全部块级 widget**（`-`/`>`/`1.` 由 CSS `::before` 绘制）
     - `hideChildren` 把 reveal 设为整节点 from/to → 光标落在 `**粗体**` 中间也显形

  2. **性能分层**
     - `buildPreviewSets` 只在 `docChanged` 全量 `tree.iterate` 产出 `statics`
     - `applySelection` 只在选区变化时 `statics.update({ filter, filterFrom: 光标行.from, filterTo: 光标行.to })`
     - → **移动光标开销与文档长度无关**；readOnly 时直接返回 `statics`

  3. **原子块四件套**
     - `atomicBlocks[]` → `EditorView.atomicRanges.of` → 选区整块跳过
     - `Decoration.replace({ block: true })`
     - `stampBlockRange` 写 `data-block-len`，`currentBlockRange` 用 `view.posAtDOM` **反查**（注释明确：绝对位置会因 CM 复用 DOM 而过期）
     - Backspace/Delete 整块删（`userEvent: "delete.block"`）

  4. **原位编辑不弹窗**：块内藏 `display:none` 的 `.md-block-source`（`contentEditable="plaintext-only"`），聚焦才加 `.md-block--editing` 显形 → "临时暴露源码，原地改"。写回用整块 replace + `blockSyncing` 防自触发。

- **短板（我们必须补的）**：
  - **没有视口裁剪**（未用 `view.viewport`/`visibleRanges`）
  - `previewSyntaxTree` 用 `ensureSyntaxTree(state, doc.length, 100)` —— Lezer 默认只解析前半段，明确的性能妥协
  - 已彻底取代独立预览面板（`components/` 下无预览组件）——**这点我们不走**
- **不可直接搬**：图片走 Electron 协议 `smimg://`（我们用 `convertFileSrc`/`asset://`）；i18n 与 Tauri bridge 需按我们的桥接层重写；`editor.integration.test.ts` 把实现细节当契约，无法移植。
- **npm 缺口**：`@codemirror/autocomplete`、`@codemirror/search`、`@lezer/common`、`@lezer/highlight`、`highlight.js`、`@tauri-apps/plugin-opener`。

### Guanmo（观墨｜MIT｜Tauri 2 + React + CodeMirror 6）

- **主推**：阅读与理解 Markdown。README 原文："如果你追求更便捷的 Markdown 编辑体验，推荐使用 typora.io 等专注写作的编辑器"——**明确不做 Typora 式 WYSIWYG**。它的"编辑"= 预览内 Alt+点击弹 CodeMirror 浮层，编辑的仍是 `rawSource`。
- **两个有价值的技术资产**：

  1. **虚拟化预览**（自研，1M 字符文档生产实测 **1.356s**，优化前 10.25s，提升约 87–89%）。滚动锚定 `PreviewViewportAnchor{blockId, blockIndex, sourceOffset, viewportOffset}` + `pendingLineCorrectionRef` 幂等校正一次。
  2. **可见文本投影**（`VisibleTextProjection`）——**思路极值得学**：
     - 结构 `{ text, parts[]{ projFrom, text, srcFrom, sourceBoundaries?, blockIndex } }`
     - **核心洞察**：mdast 的 `position` **本身就只覆盖标记之外的文本 run**（`**加粗**` 的 text 节点 position 不含 `**`）→ "标记从一开始就没进投影"，段内可见下标 `i` → 源码 `from + i`，**天然精确，不需要双向映射表**
     - 非线性处（HTML 实体 5→1、反斜杠转义、CRLF）用双指针建 `sourceBoundaries`；**未识别差异直接 `return null`，宁可放弃也不猜**
     - 目的：让"复制域 = 搜索域"，杜绝搜到 `https://`、`**`、`](` 这类**无幽灵命中**
- **短板**：`MarkdownPreview.tsx` 达 142KB；无障碍被列为"架构边界"。
- **可借鉴**：① 可见文本投影**思想**；② 性能基线方法论（见 §八）；③ `getSourceOffsetForLine` 的契约（gap 返回 `undefined` 由调用方兜底，不抛错）。
- **不该借鉴**：它的虚拟化实现——它预览是**前端渲染**，我们是 **Rust 渲染**，块级产出在 Rust 侧做反而更容易。

### Mark2（Tauri + 原生 JS + **Tiptap 3 真 WYSIWYG**）

- **主推**：全能型文档工具（多格式 + AI 写作 + 卡片导出 + 翻译）。
- **核心创新：源码保留序列化**（`SourcePreservingMarkdownSerializer`，18KB）
  - **快照**：加载时遍历 doc **顶层**子节点，用 `node.attrs.sourcepos`（行号来自 markdown-it 的 `token.map`）建 `{ startLine, endLine, startOffset, contentEndOffset, raw, node }`
  - **"未编辑"判定**：无 hash、无 dirty 标记，靠 `markdownNodesEqual` **递归比对**（比 type/attrs/marks/text/childCount，剔 `sourcepos`）；命中即 `entry.raw` **逐字节复用**
  - **仅文字变化**：`patchTextOnly` 用 `rawSource.indexOf(pair.original, searchOffset)` **顺序非回溯**定位替换（**没引入任何 diff 库**）
  - **marks 变了**：返回 null → 整块重序列化，该块标记被规范化
  - **front matter 安全**：剥离后原样拼回
  - **测试**：`assert.equal(session.serialize(), source)` —— **字节级全等**
- **已知真实退化**：粒度只在顶层块；结构一变就整块归一化；`SourceScrollManager` 的 `sourcepos` 是加载期快照、编辑后不更新，行号映射会过期。
- **可借鉴**：**字节级 round-trip 测试思路**；`SourceScrollManager` 的"行号↔PM pos"换算（`textBetween` 数换行，`hardBreak` 计 1 行）。
- **关键教训**：**真 WYSIWYG 的代价是"必须再造一个保源序列化器"**。

---

## 三、关键判断：我们的路线天然不需要"保源序列化"

**这是本次调研最有价值的结论。**

- **Tiptap/ProseMirror 路线**：文档在内存里是**对象树**，写盘要**重新生成** Markdown → 必须维护"块级原文快照 + 差异比对 + 局部复用"。
- **CodeMirror 路线**：文档在内存里**就是那串原文**，编辑是字符级编辑，装饰只作用于**渲染层** → 保真不需要额外机制。

→ qingbird 走 Decoration 路线，`content` 永远是用户原始字节。**"打开、只看不编辑、保存"逐字节不变**——天然满足。

→ 还白送四个不变量：**划词 offset 语义、翻译选区映射、`apply_op` 的字节契约、行号↔offset 映射**，全部不用动。

---

## 四、竞争力基线（新增，对齐用户诉求）

对标四家的编辑能力，列出"行业基线"与我们的现状。**这是"有竞争力"的最小集合**，不是功能军备竞赛。

### 竞品均已具备

| 能力 | InkNote | Mark2 | SuperMarkdown | 我们 |
| --- | --- | --- | --- | --- |
| 行内标记隐藏/实时渲染 | ✓ | ✓ | ✓ | **缺** |
| 标题分级样式（非等宽正文） | ✓ | ✓ | ✓ | **缺** |
| 列表/引用/任务列表 渲染态 | ✓ | ✓ | ✓ | **缺** |
| 代码块语法高亮 | ✓ | ✓ | ✓ | 预览有，编辑无 |
| 代码块行号 / 复制按钮 | ✓ | — | — | 预览有复制✓ |
| 表格原位编辑 + Tab 导航 | ✓ | ✓ | ✓ | **缺** |
| 表格气泡工具条 | — | ✓ | — | **缺** |
| 公式行内/块级原位编辑 | ✓ | ✓ | ✓（双击） | **缺**（预览可渲） |
| mermaid 原位编辑 | ✓ | ✓ | ✓ | **缺**（预览可渲） |
| front matter 支持 | ✓ | ✓ | ✗ | **缺** |
| 任务列表点击勾选 | ✓ | ✓ | ✓ | **缺** |
| 专注模式 / 打字机模式 | ✓ | — | ✓ | 部分（`typewriter.ts`） |
| 多格式导出 | ✓ HTML/PDF | ✓ 多格式 | ✓ HTML/PDF/JSON/文本 | HTML（计划中） |

### 建议的竞争力基线（按性价比排序）

**第一梯队（观感提升最大、成本最低，必须做）**
1. **行内标记隐藏**：`**` `*` `_` `~~` `` ` `` 成对标记 + `[text](url)` 的 URL 段
2. **标题分级样式 + `#` 标记隐藏**（含标题上方留白）
3. **列表/引用标记隐藏**：`-` / `>` / `1.` 用 CSS `::before` 绘制，`NEVER_REVEAL`
4. **任务列表可点击勾选**（便宜且讨喜）

**第二梯队（专业感门面，应当做）**
5. **代码块**：编辑区渲染态 + 语言标签 + 复制按钮（可复用预览侧已有的 `addCopyButtons` 逻辑）
6. **表格 Tab / Shift+Tab 单元格导航**（用户痛点）
7. **front matter 显示与编辑**（原计划就有，顺带做）

**第三梯队（加分项，按需做）**
8. **公式 / mermaid 原位编辑**（双击进源码态，参考 SuperMarkdown / InkNote）
9. **选中即现的气泡工具条**（参考 Mark2 的 `TableBubbleToolbar`）
10. **专注模式**（我们已有打字机的一半基础）

> **立场**：建议把目标定在"**观感上不输**"，而不是"**每个语法都能原位编辑**"。后者会把我们拖进一场旷日持久的追平战，而我们的护城河是流式翻译。第一 + 第二梯队做完，产品观感上已经不输 InkNote；第三梯队作为迭代储备。

---

## 五、推荐路线

### L0 · 排版提示（零风险）

纯 CSS + `HighlightStyle`，**不动任何文档结构**：
- 标题分级放大、上方留白
- 行内标记淡色（`t.processingInstruction` → `var(--fg-faint)`）
- 当前行强调（`highlightActiveLine`）

**不做**：任何 `Decoration.replace`。**风险几乎为零**。

### L1 · 行内标记隐藏 + 列表/引用（第一梯队）

引入 `livePreview` StateField，照搬 InkNote 两层结构：
- `statics` 只在 `docChanged` 重建；`visible` 在选区变化时用 `filterFrom/filterTo` **框住光标所在行**
- 三档强度：`HIDE_MARK` / 带 reveal 区间 / `NEVER_REVEAL`
- 覆盖 §四 第一梯队全部四项
- **必须按视口裁剪**（`view.viewport`）—— 与 InkNote 的关键差异
- `Compartment.reconfigure` 切 preview/source，不重建 EditorView（历史/光标天然保留）

**回滚点**：`previewExt(mode)` 返回 `[]` 即纯源码。

### L2 · 原子块 widget（第二梯队）

- 原子性四件套：`atomicRanges` + `block:true` + `stampBlockRange`（`posAtDOM` 反查）+ 整块删除
- 原位编辑：块内藏 `display:none` 源码区，聚焦才显形（**不做弹窗**）
- 顺序：**代码块**（高亮已有基础）→ **表格**（最难，可降级为"只做 Tab 导航不做 widget"）→ **front matter**

### L3 · 第三梯队（加分项）

公式 / mermaid 双击进源码态、气泡工具条、专注模式。

### 关于模式切换

保留三态：**源码 / Live Preview / 双栏**，`Ctrl+/` 或现有快捷键循环。
**翻译与预览绑定**：预览面板始终保留，翻译渲染不迁移（见 §六）。

---

## 六、就地编辑的两种形态，以及翻译冲突的真相

**用户提出的疑虑是对的，但只在其一种形态下成立。**

"所见即所得就地编辑"在业界有两种落点，对翻译的影响截然相反：

| | **A. 编辑器层就地编辑**（InkNote / 我们选的） | **B. 预览层就地编辑**（Guanmo） |
| --- | --- | --- |
| 编辑对象 | CodeMirror 里的 Markdown **源码**，标记被 Decoration 隐藏 | 预览 DOM 本身变成可编辑 |
| 编辑宿主 | 编辑器 DOM | **与翻译渲染共用同一个 DOM** |
| 与翻译的关系 | **物理隔离**（两个 DOM、两个写者） | **正面冲突**（同一 DOM 两个写者） |

**B 的冲突是真实且严重的**（将来若有人提议做 B，务必先看这段）：

1. **写者争抢**：翻译流式 patch 直接改 `[data-ri]` 的 `textContent`；用户正在同一块里打字时，**刚敲的字会被译文覆盖**（或反之）。
2. **双语模式下更危险**：预览里显示的是译文，用户若在译文上编辑并回写，回写的将是**译文本身** → **直接污染源文件**。
3. **回写必然清空译文**：编辑都走 `applyEdit` → 全串替换 content → `resetDisplayIfStale` 判定 `runContent !== content` → **`clearTranslations()`，译文全丢**。
4. **锚点失效**：编辑态下 DOM 结构被改，`data-bi`/`data-ri` 索引对不上 → `patchPartial` **静默跳过**（连报错都没有）。

若坚持要做 B，前置条件至少包括：编辑态下对该块加**互斥锁**禁止 patch 写入、**双语模式禁止就地编辑**（只允许在原文侧编辑）、编辑提交时把"整篇译文失效"改为"**按块增量失效**"。成本远高于收益。

**我们选 A，于是冲突从根上不存在：**

- Live Preview 只作用于**编辑区**；预览区维持现状（Rust 渲染 + 翻译渲染），是**只读的阅读/翻译视图**。
- 两个渲染管线各管一侧 DOM，互不干扰；`.markdown-body` 宿主不变 → `patchPartial` 的 `querySelector` **零改动**。
- 这同时**强化了定位**：编辑区负责"写得顺"，阅读区负责"读得好 + 译得准"，职责不混。

**只需一条视图约束**：翻译渲染依赖预览面板挂载。因此

> **规则：开始翻译时，若当前处于单栏 Live Preview / 纯源码模式，自动确保预览面板可见（切到分栏）。**

实现上是 `useUiStore` 的视图状态联动，几十行的事，不是抽象层。**原先设想的 `TranslationSurface` 抽象因此不必做。**

**建议顺手修一个既有隐患**：`patchPartial.ts` 目前"锚点缺失**静默跳过**"，导致翻译"看起来没反应"且无迹可查 → 改为打日志（低成本，高排障收益）。

---

## 七、红线（必须遵守）

1. **装饰/widget 永不写回 content**。任何 `dispatch` 都不得携带 `changes`。
2. **不做任何 content 规范化**（自动补 `*`、闭合围栏、补空格）——会触发 `resetDisplayIfStale` → `clearTranslations`，把译文全清掉。
3. **装饰必须是 `StateField` 派生的纯函数**（doc 变了自动重算），不能命令式累积——否则 `applyEdit` 的全串替换会冲掉装饰状态。
4. **翻译渲染不进编辑器**。译文只存在于预览面板（`tab.translations` + `doneHtml`），绝不写入 `content`——否则 `isDirty` 变脏、保存污染。
5. **新增快捷键必须同步 `hotkeyRegistry.ts`**，并让三方对齐测试通过。
6. **门禁**：`tsc --noEmit` + `vitest run`（现 204 用例）+ `cargo check`；新写的守卫测试**必须验证"旧代码会让它变红"**。
7. **构建走 PowerShell**（Bash 通道会静默失败）。

---

## 八、可复用的工程方法论（借 Guanmo）

1. **先定义并复测基线，再实施**——"不得先改代码后补性能故事"
2. **确定性匿名夹具**：生成 50K/200K/500K/1M 文档，不记路径与正文
3. **单开关 A/B 原型**：一个 `virtualize: true/false` 式的开关切换两套实现，不污染生产入口；指标 = 首次可渲染 median/P95 + DOM 节点数 + 挂载块数
4. **性能与语义双门槛**：语义样本（表格/跨块 reference/footnote/公式/HTML/details）做功能守门
5. **止损规则**："第二次仍无收益必须停止、回退该方向并写止损记录"
6. **JSDOM 数据仅供趋势**（Guanmo 自注与真实 WebView 差约 34 倍），绝对门槛必须回到真实 WebView2 复评

对 L1 的启示：**先把"万行文档 + 光标移动"的基线测出来**，再动手做装饰。

---

## 九、风险清单

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 装饰全量重建（InkNote 未做视口裁剪） | 长文档掉帧 | `statics`/`visible` 分层 + **viewport 裁剪** |
| `lineBlockAtHeight` 像素反查在 widget 下失效（依赖"块高≈行高"） | 分栏滚动对齐跳错 | 改为**行号→offset 直接映射**（`doc.line(n).from` + `coordsAtPos`）——这是改进 |
| 单栏 Live Preview 下预览未挂载 | 翻译无宿主、静默不显示 | §六 视图约束：翻译前确保预览可见 |
| `patchPartial` 锚点缺失静默跳过 | 翻译"没反应"且无报错 | 改为打日志 |
| 渲染侧内存（记忆：Syntect OnceLock 是常驻大户） | 叠加装饰后内存上升 | L2 做代码块 widget 时评估 |
| 表格 widget 复杂度 | 工期失控 | 允许降级为"只做 Tab 导航" |
| 无障碍：`Decoration.replace` 让标记不可见 | 朗读行为变化 | 实测确认；我们不分块虚拟化文档，风险低于 Guanmo |
| **范围蔓延**（追平每家每项） | 拖进旷日持久战 | 严守 §四 梯队制，第三梯队作为储备 |

---

## 十、落地顺序

**第一阶段**
1. **L0 排版提示**（纯 CSS，立竿见影，零风险）
2. **L1-a 行内标记隐藏**（`**`/`*`/`` ` ``/链接 URL）+ 视口裁剪

**第二阶段**
3. **L1-b 标题分级 + 列表/引用标记隐藏 + 任务列表可勾选**
4. 分栏联动改为行号→offset 直接映射（顺手去掉像素反查的脆弱假设）

**第三阶段**
5. **代码块渲染态**（语言标签 + 复制）→ **表格 Tab 导航** → **front matter**
6. §六 视图约束（翻译前确保预览可见）

**第四阶段（储备）**
7. 公式 / mermaid 双击原位编辑、气泡工具条、专注模式

**每阶段独立可发布、独立回滚。** 建议第一、二阶段做完先发一版收反馈（这两阶段已能覆盖第一梯队全部观感提升）。

---

## 十一、翻译能力扩展：双向互译 + 译文另存为

> **⚠️ 本节已细化，请以 `2026-09-16-translation-correctness.md` 为准。**
> 用户随后追加了关键要求：**互译 + 存盘 = 交付物**，原先"允许有点不准"的口径不再成立，必须加入 **AI 助理核查与重排版**。新文档据此给出：Guanmo AI 助理的 7 处可借鉴点、我们自己代码里已查证的 6 处硬隐患（其中最严重的 `needs_translation()` 方向无关 + 缓存 key 不含方向 + 三处 walker 必须同步）、以及"确定性检查 / AI 语义核查"两层拆分。
> **本节保留作为背景与原始清单**；H1–H5 的隐患编号在那边继续使用，不重复展开。

用户提出的方向（2026-09-16）：翻译不应只服务"英 → 中"的阅读，应扩展为**双向互译**，并支持把译文**另存为一份 .md** —— 即从"翻译阅读器"走向"翻译机"。

### 现状盘点（已查证：语言方向目前是硬编码的）

| 位置 | 现状 |
| --- | --- |
| `src-tauri/src/translate/engine.rs:35` | `LLM_SYSTEM_PROMPT = "…把用户给出的文本翻译成简体中文…"` |
| `src-tauri/src/translate/providers.rs:349` | `SYSTEM_PROMPT` 同样写死"简体中文" |
| `src-tauri/src/translate/providers.rs:108` | MyMemory 走 `langpair=en\|zh-CN` |
| `src-tauri/src/translate/providers.rs:277` | 另一 provider 写死 `"target": { "lang": "zh" }` |
| `src-tauri/src/translate/engine.rs` | `needs_translation()` 语义是"含非中文才需翻译"，纯中文直接跳过 |

### 改造清单（按依赖顺序）

1. **语言方向参数化**：把 `target_lang`（及 `source_lang`，建议 `auto`）从硬编码提为 `translate_document` 的入参，贯穿到 prompt 模板与每个 provider 的请求体。
2. **`needs_translation()` 改为按方向判断**：目标为中文时"含非中文才翻"；目标为英文时反之。该函数是纯中文文档"零成本跳过"的依据，不能简单删。
3. **prompt 模板按方向选**：至少中 ↔ 英两个方向；若扩到更多语种，建议改成"目标是 X 语言"的**参数化模板**，而不是逐语言写死。
4. **⚠️ 缓存与签名必须带语言方向**（最隐蔽的坑）：`translate/sign.rs` 的签名与 `translate/cache.rs` 的缓存 key **若不含 `target_lang`**，英→中的缓存会被中→英直接复用，产出**方向串味的错误译文**。这条要进回归清单。
5. **UI**：`TranslationBar.tsx` 增加目标语言选择（先做中 / 英两档），偏好落 `useSettingsStore`。

### 译文另存为 md（建议优先做）

**为什么优先**：直接强化护城河（流式翻译），成本远低于 WYSIWYG 的 L2，而且是用户能立刻感知的功能。

**难点不在写文件，在"从什么重建 Markdown"**：译文当前**不存在于 `content` 里** —— 它只活在 `tab.translations: Map<number, string>`（块索引 → 译文）与 `doneHtml` 里，这是"译文不落文档"红线（§七.4）的直接结果。

**可行路径**（Rust 侧已有基础）：`src-tauri/src/markdown/units.rs` 已维护 `data-ri` 的 run 索引空间（`collect_text_runs`）。新增一个命令即可：

```rust
// 伪签名：按 run 索引把译文换回文本，其余（标记 / 代码块 / 非文本）原样保留
export_translation(content: String, translations: HashMap<usize, String>, mode: TranslateMode) -> String
```

- **单语导出**：文本 run 替换为译文，Markdown 标记与代码块**原样保留** → 产出结构完整的目标语言 md。
- **双语对照导出**：按块输出"原文块 + 译文块"（引用块 `> ` 或段落交替）。
- 落盘复用现有 `save_file(path, content)` + 原生保存对话框。
- **注意**：这是**另存为新文件**，不写回当前文档的 `content`，因此不违反 §七.4 红线，也不会把当前 tab 弄脏（`isDirty` 不受影响）。

**这条路径天然由 Rust 承担**（索引已在 Rust 侧），前端无需参与文本重组。

### 与 WYSIWYG 的关系

两者**互不阻塞**，可并行：
- WYSIWYG 让"**写得顺**"，作用于编辑区。
- 双向互译 + 另存为让"**译得出、带得走**"，作用于翻译链路与导出。

若排期紧张，**建议先做另存为 + 双向互译**：成本可控、直接强化差异点；WYSIWYG 按 §十 的分档慢慢推。

---

## 十二、已拍板与待拍板

**已拍板（2026-09-16）**
- ✅ 定位：阅读优先，编辑能力齐备；**WYSIWYG 属于行业基线，必须做**
- ✅ 翻译不进编辑器，预览面板保留 → `TranslationSurface` 抽象**不做**
- ✅ 技术路线：不换内核，CodeMirror Decoration
- ✅ **就地编辑只做"编辑器层"（A），不做"预览层"（B）**——后者与翻译渲染争抢同一 DOM，会覆盖用户输入、且在双语模式下污染源文件（详见 §六）
- ✅ 翻译能力扩展方向：**双向互译 + 译文另存为 md**（详见 §十一）
- ✅ 翻译质量门槛升级：**互译 + 存盘 = 交付物，须加 AI 助理核查与重排版**（详见 `2026-09-16-translation-correctness.md`）

**待拍板**
1. **第一刀**：先 L0（看得见、零风险）还是先 L1-a（收益大、需要设计显形规则）？建议 **L0 先行**，一两天内可见效果，同时并行设计 L1。
2. **表格做到哪一步**："只做 Tab 导航"（成本低）还是"完整 widget 原位编辑"（参考 InkNote，成本高）？
3. **是否引入 `highlight.js`**：InkNote 用它给代码块上色（约 20 语言）。预览侧代码高亮是 Rust 做的，编辑器侧若要一致需评估复用还是新引依赖。
4. **翻译扩展 vs WYSIWYG 的排期**：是否让"译文另存为 + 双向互译"先行（成本可控、直接强化差异点），WYSIWYG 随后分档推？

---

## 附：调研样本一句话速查

| 项目 | 内核 | 一句话 | 偷什么 |
| --- | --- | --- | --- |
| SuperMarkdown | ProseMirror 手写 | 真 WYSIWYG，但序列化会毁原文 | nodeview 交互设计 |
| **InkNote** | **CodeMirror 6** | **同栈 Live Preview 的成熟范本** | **显形三层 + 原子块四件套 + Compartment 切模式** |
| Guanmo | CodeMirror 6 | 阅读优先，刻意不做 WYSIWYG | 可见文本投影思想 + 性能基线方法论 |
| Mark2 | Tiptap 3 | 真 WYSIWYG + 18KB 保源序列化 | 字节级 round-trip 测试思路 |
