# 代码审查与整改拆分规划

**Date:** 2026-09-19
**触发:** 用户要求对全项目（Rust 后端 + React/TS 前端）做一次审查，找出屎山代码、无用重复代码、漏洞代码、臃肿可拆分代码，并给出整改与拆分规划。
**定位:** 本文档是**审查结论 + 整改处方**。只描述，不实施。实施由后续任务按批次独立提交、独立过门禁。
**已知债对照:** `docs/superpowers/plans/2026-09-16-module-splits.md`（下称《拆分记录》）已登记部分超长文件的拆分债；本文档**不重复**该文件的结论，只标注"新发现 / 已登记"并补齐该文件遗漏项。

---

## 〇、审查方法与证据口径

- **行数口径**：遵循《拆分记录》第一节——统一用 `.Count`，生产/内联测试以第一个 `#[cfg(test)]` 为界，`*_tests.rs` 整体计测试。本文所有行数均按此口径。
- **复核原则**：所有"高严重度"结论均由作者二次读源码确认（`✅ 已复核`）；未能本地运行验证的标注 `⚠️ 待复核`，不当作既成事实。
- **门禁命令**（与《拆分记录》第五节一致）：Rust `cargo check` / `cargo test`；前端 `npx tsc --noEmit` / `npx vitest run`；CSS `python tools/css-probe.py`。构建走 PowerShell。
- **信任模型**：Tauri 2 中 app 自定义 `#[tauri::command]` **不受 capability 约束**，WebView 里的任意 JS 都能调用。因此"前端是否可能被注入"是安全结论的关键变量；`csp:null` + `assetProtocol.scope:["**"]` 使一旦注入即全盘沦陷（见 §二.SEC-1）。

---

## 一、执行摘要

审查后最该先处理的，不是"文件太长"，而是几条**不报错、只给错结果/静默丢数据**的正确性缺陷：

| 编号 | 严重度 | 一句话 | 复核 |
|---|---|---|---|
| BUG-1 | 🔴 高 | 双语对照导出漏掉表格占号 → 含表格的文档，表格之后所有段落译文**错位** | ✅ |
| BUG-2 | 🔴 高 | AI 核查用"顶层块下标"查"run/块空间"的译文表，且不递归 → 核查清单系统性错误 | ✅ |
| BUG-3 | 🔴 高 | 保存期间继续输入，`savedContent` 写成最新内容 → 脏标消失 → **未落盘改动被静默丢弃** | ✅ |
| BUG-4 | 🔴 高 | 批量翻译分隔符可被正文注入 → 单元被截断，且已标记投递**不重试** → 静默丢字 | ✅ |
| BUG-5 | 🟠 中高 | 翻译起跑成功分支缺代际守卫 → `stop()` 后响应回来会把已取消轮次"复活" → 状态永久卡 running | ✅ |
| BUG-6 | 🟠 中 | 删除工作区文件时跨 store `setState` 绕过 `commit()` → `isDirty` 投影失真 | ✅ |
| BUG-7 | 🟠 中 | 图片 alt 解析遇嵌套行内标签提前收尾 → 同段后续文本被静默丢弃 | ✅ |
| SEC-1 | 🟠 中高 | `csp:null` + asset scope `**` → 零纵深；任何一处注入即任意文件读写删 + 命令执行 | ✅ |
| PERF-1 | 🟠 中 | `ReviewPanel` 把 `doc` 对象放进 effect 依赖 → 翻译停后**每敲一个键发一次 IPC** | ✅ |
| PERF-2 | 🟠 中 | `translate_document` 是同步命令，在主线程解析 + 克隆整缓存 + 最多 3 次整树渲染 | ✅ |
| CQ-1 | 🟢 低 | `TopBar.tsx` + 5 个菜单文件是死代码（~350 行），且与 `AppMenu` 双实现 | ✅ |
| CQ-2 | 🟢 低 | `Cargo.toml` 注释声称 `panic = "abort"`，实际**没有这一行** | ✅ |

完整的分类清单见 §二，臃肿与拆分见 §三，整改规划见 §四。

---

## 二、缺陷清单

### A. 正确性 / 数据安全（优先）

#### BUG-1 🔴 双语导出漏掉表格占号 ✅
**位置**：`src-tauri/src/translate/export.rs:152-177`（`emit_translation`）、`:122-142`（`walk_bilingual` 容器分支）、`:186-218`（`emit_children_translations`）；对照 `src-tauri/src/markdown/units.rs:274-295`（`walk_collect` 的 Table 分支）。

`emit_translation` 的可译判定只覆盖 `Heading` / `Paragraph`：
```rust
let translatable = match b {
    Block::Heading { level, .. } => block_translatable(st, Some(*level), &plain, target),
    Block::Paragraph { .. }     => block_translatable(st, None, &plain, target),
    _ => false,   // ← Table 落这里，counter 不推进
};
```
而 `units::walk_collect`（`data-bi` 的唯一判定点）对表格**逐表头、逐单元格**推进 `counter`（`units.rs:274-295`）。两处不一致 → 只要文档含表格，表格之后的可译块在导出侧对号**整体前移**，`translations.get(&idx)` 取到别的段的译文。

文件头注释（`export.rs:19-21`）明确写"Heading/Paragraph/Table 各自推进一次"，与实现自相矛盾；现有测试无一含表格，故未暴露。

**修复**：给 `walk_bilingual` 与 `emit_children_translations` 补 `Block::Table` 分支，按 `walk_collect` 的顺序对每个 header/cell 调 `block_translatable`、推进 counter、发射译文（译文取 `inline_plain_text(cell)`）。补一条"表格前后各一段"的回归，断言对号正确。
**验收**：新增回归在修复前必红；`cargo test` 全绿。

#### BUG-2 🔴 AI 核查索引空间错误 ✅
**位置**：`src-tauri/src/translate/check.rs:74-107`；前端 `src/lib/checkTranslation.ts:14-21`、`src/components/ReviewPanel.tsx:63`；对照 `src-tauri/src/bridge.rs:372-380`。

`check_translation` 用**顶层块的 `enumerate()` 下标**当 key：
```rust
for (i, block) in blocks.iter().enumerate() {
    match translations.get(&i) { ... }
}
```
但 `translations` 的 key 实际是：
- `translation` 模式 = **data-ri run 空间**（`bridge.rs:373` → `collect_text_runs_windowed_blocks`）；
- `bilingual` 模式 = **data-bi 块空间**（`bridge.rs:375`）。

前端 `checkTranslation()` 不传 mode，`i` 又只是顶层块下标、不递归进 Quote/List/Table/FootnoteDef。于是 `a **b**` 这种一段两 run 的文档，检查用块 0/1 去查 run 表 → 大量**假漏译 / 假回声 / 张冠李戴的结构对比**。`Issue.run` 的文档注释（`check.rs:20`）自称 data-ri，与实现矛盾；单测全用"块下标=key"的输入，所以永远绿。

**修复**：`check_translation` 增加 `mode`（`translation`/`bilingual`）与 `target_lang` 参数，按模式复用在对应索引空间收集（translation 用 `units::collect_text_runs*`，bilingual 用 `collect_translatable*`），并递归覆盖嵌套块；前端 `checkTranslation(content, translations, mode, target)` 同步补齐，`ReviewPanel` 传 `mode`/`target`。补"含行内格式 + 嵌套列表 + 表格"的端到端守卫。
**验收**：新增守卫在修复前必红；前端 `tsc`/`vitest` 全绿。

#### BUG-3 🔴 保存基线写错导致静默丢改动 ✅
**位置**：`src/stores/useDocStore.ts:601-611`。
```ts
const mtime = await api.saveFile(target, t.content);   // 写盘的是快照 t.content
...
patchTab(myId, (cur) => ({
  ...cur, path: target!, name,
  savedContent: cur.content,   // ← cur 是 await 之后的最新内容
  mtime,
}));
```
若 `saveFile` 往返期间用户继续输入，`cur.content ≠ t.content`，`isDirty = content !== savedContent`（`:157`）变 false → 关闭标签不再弹保存确认 → 未落盘的改动被静默丢弃。注释只考虑了"active tab 切走"，漏了"同一 tab 内容变了"。

**修复**：`savedContent: t.content`（写盘内容）。顺带在 `patchTab` 回调里若 `cur.content !== t.content` 保持脏（即 `savedContent` 用 `t.content` 后自然成立）。
**验收**：加一条"保存往返期间编辑"的单测，断言保存后仍 `isDirty === true`。

#### BUG-4 🔴 批量分隔符可被正文注入 ✅
**位置**：`src-tauri/src/translate/batch.rs:36-50`（`encode`）、`:216-221`（`next_unit` 取首个 `<<<END>>>`）。

`encode` 把用户正文**原样**夹在 `<<<B<slot>>>` 与 `<<<END>>>` 之间。若正文本身含 `<<<END>>>`，解码在第一个 `<<<END>>>` 处收尾，该单元被截断；此时它已被标记 `delivered=true`（`engine.rs` 流式分支），**不会重试** → 静默丢字。正文含 `<<<B1>>>` 还能把内容写到别的槽位。属"不可信文本放回协议层"造成的注入，非 prompt 注入。

**修复**（二选一）：
1. 每次请求生成随机 nonce 分隔符，把 nonce 写进 `INSTRUCTION` 与 `encode`，解码只认该 nonce；
2. 编码时对正文里的 `<<<B` / `<<<END>>>` 做转义，解码还原。
另加一条"正文含分隔符"的回归测试。
**验收**：新增回归必红；现有批处理测试全绿。

#### BUG-5 🟠 翻译起跑成功分支缺代际守卫 ✅
**位置**：`src/stores/useTranslationStore.ts:592`（`genBefore`）、`:654-668`（成功 `set({gen:r.gen,...})`）、`:681`（catch 分支**有**守卫）、`:708` `resetDisplay`、`:776` `stop`。

`catch` 分支用 `if (get().gen === genBefore)` 收口，成功分支没有。若 `await api.translateDocument(...)` 期间用户按停止（`stop()` 令 gen 前跳）或切模式/方向（`resetDisplay()` gen 前跳 + `api.stopTranslation()`），响应回来仍无条件 `set({gen:r.gen, status:"running"})` → 后端已取消、不再发同 gen 事件 → **status 永久卡 running**，后续翻译全被挡死。

**修复**：成功分支落 `set` 前统一 `if (get().gen !== genBefore) return;`（或丢弃并回滚），与 catch 分支同口径。
**验收**：加一条"在飞 invoke 期间调用 stop"的单测，断言最终 status 不为 running。

#### BUG-6 🟠 跨 store 越权写导致投影失真 ✅
**位置**：`src/stores/useWorkspaceStore.ts:577-581`。
```ts
useDocStore.setState((s) => ({
  tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, savedContent: t.content } : t)),
}));
```
`useDocStore` 头部把"所有写路径集中 `patchActive/commit`、同一次 set 重算投影"定为硬约束。此举直接 setState 改 `savedContent`，而投影 `isDirty` 由 `content !== savedContent` 派生（`useDocStore.ts:157`）→ 投影不更新，脏标停留到下一次任意写动作才自愈。

**修复**：在 `useDocStore` 暴露 `discardChanges(id)`（内部走 `patchTab`），workspace 调它。
**验收**：加一条"放弃改动后 `isDirty` 立即为 false"的 store 测试。

#### BUG-7 🟠 图片 alt 解析提前收尾 ✅
**位置**：`src-tauri/src/markdown/model.rs:588-600`。
```rust
fn collect_raw_text(...) -> String {
    while let Some(ev) = it.next() {
        match ev {
            Event::End(_) => break,   // ← 只看第一个 End
            ...
```
对 `![**b**](x)`，事件序是 `Start(Image) → Start(Strong) → Text("b") → End(Strong) → End(Image)`。它在 `End(Strong)` 收尾，**没有消费 `End(Image)`**；返回后 `collect_inlines` 遇到 `End(Image)` 判为容器结束而返回，其后同段文本被顶层兜底静默吞掉。pulldown 自己的 `raw_text()` 用嵌套深度计数正是为此。附带 `Code` 未计入 alt。

**修复**：照抄 pulldown 的深度计数（`Start => nest += 1`；`End if nest == 0 => break`），并收 `Event::Code`。补 `![**b**](x) tail` 回归。
**验收**：新增回归必红。

### B. 安全（纵深与健壮性）

#### SEC-1 🟠 `csp:null` + asset scope `**`：零纵深，单点注入即全盘沦陷 ✅
**位置**：`src-tauri/tauri.conf.json:25-31`（`csp:null`、`assetProtocol.scope:["**"]`）；`src-tauri/src/lib.rs:445-471`（`resolve` 明确不做 `..` 归一，注释承认依赖 scope `**`）；`src/components/PreviewView.tsx:365`（`innerHTML = html`）。

当前 HTML 转义链完整（后端 `html.rs:40-53` 全量转义；前端 `linkSafety.ts` 协议白名单；`patchPartial.ts` 全走 `textContent`），**未发现可直接利用的注入**。但 `csp:null` 使一旦出现任意一处注入（本次或未来），攻击脚本即可 `fetch(convertFileSrc('.../qingbird-settings.json'))` 外带凭据，并直接调用 50 个命令（含 `delete_path`/`save_file`/`open_terminal`）→ 同用户级任意文件读写删 + 命令执行。

**修复**：设最小 CSP（至少 `default-src 'self'; script-src 'self'; object-src 'none'`，按 mermaid/KaTeX 实测微调 `style-src`），asset scope 收窄为"当前文档目录 + 工作区根 + 图片目录"，或 `resolve` 做 `..` 归一 + 根校验。
**注意**：这是"新增约束"，需真机验证 mermaid/KaTeX/字体加载不受影响；建议先记录为独立任务。

#### SEC-2 🟠 路径类 IPC 命令零约束 ⚠️
**位置**：`lib.rs:84-96`（`open_file`/`save_file`）、`:286-315`（`rename/delete`）、`:386-431`（`move/create`）、`:445-471`（`resolve`）。
威胁模型是"前端被污染后"（见 SEC-1），非当前可直接利用。`resolve` 的 `..` 逃逸 + scope `**` 让恶意 `.md` 可读文档目录外图片。
**修复**：命令层 `canonicalize` 后校验落在工作区/文档根内；或统一改用 `tauri-plugin-fs` 的 scope 机制。改动面大，随 SEC-1 之后排期。

#### SEC-3 🟠 凭据明文落盘 + 注释自相矛盾 ✅
**位置**：`storage.rs:1-2`（注释"Credentials never leave this process"）、`:33/:44-49`（`api_key`/`providers`/`llm_profiles` 明文 JSON）；`lib.rs:187-194`（`settings-updated` 广播整份含 key）。
注释与实现矛盾，会误导后续安全审查。**修复**：至少更正注释为"凭据以明文存于用户数据目录（当前账户可读），不做加密"；若要真正保护，走 Windows DPAPI/凭据管理器（产品决策）。

#### SEC-4 🟠 网络层：无界缓冲 + 明文 base_url + 绝对超时 ⚠️
- **无界缓冲**：`translate/sse.rs:35-46`（`buf` 无上限）、`openai.rs:187-204/238-252`（单行/整包读入）、`http.rs` 的 `into_string`；畸形/恶意端点可 OOM。建议各设 8–16 MiB 上限。
- **明文 HTTP**：`base_url` 未强制 https（`openai.rs:44-46`、`lookup.rs`）；非 localhost 的 `http://` 会让 Bearer key 明文过网。建议对非本机端点强制 https 或告警。
- **绝对超时**：`http.rs:176-204` 的 `.timeout()` 经核实是**整包 deadline** 且包住流读取；长流式批次可能被"正在收流"时掐断。建议 SSE 路径改用 idle 超时 + 宽松兜底。
- **重定向/证书**：已核实 TLS 默认校验、ureq 跨域重定向剥离 `Authorization`，**这两项无问题**。

#### SEC-5 🟠 深层嵌套 Markdown 可能爆栈 ⚠️
**位置**：`markdown/model.rs:186-231`（`consume_block` ↔ `collect_blocks` 互递归）、`:472-490`、`units.rs:109-184`。
构造 `>` × 10 万（或深嵌套列表/强调）经文件关联打开，递归爆栈。**栈溢出是 abort，不受 panic 配置影响** → 直接闪退。建议设最大嵌套深度（超限降级纯文本）或改显式栈。**待复核**（本地未构造验证）。

#### SEC-6 🟢 依赖/供应链 ✅
`.github/workflows/release.yml:21,25,30,32,76,94` 的 actions 均用可变 tag（`@v4`/`@stable`/`@v0`），未 pin commit SHA；`@stable`/`@v0` 尤宽。建议 pin SHA。`cargo audit` 未安装，本次未做依赖漏洞扫描，建议纳入 CI。

### C. 性能 / 卡顿

#### PERF-1 🟠 核查面板每按键发一次 IPC ✅
**位置**：`src/components/ReviewPanel.tsx:26`（订阅 `s.doc` 对象）、`:53-74`（`runCheck` 依赖 `[..., doc, translations]`，`useEffect` 每次 `runCheck` 变即跑）。
`useDocStore` 的 `tabToDoc()`（`useDocStore.ts:135-147`）每次 `commit()` 返回**新对象**，每次按键 `applyEdit` → 新 `doc` → 新 `runCheck` → 重跑 → `api.checkTranslation` IPC。触发条件现实中可达（翻译模式 + 有译文 + 开面板 + 编辑）。
**修复**：依赖改 `doc?.content` 并加 200–300ms 防抖 + `checking` 重入闸；或只在 `translations` 变化/翻译停止时跑。

#### PERF-2 🟠 `translate_document` 同步命令阻塞主线程 ✅
**位置**：`bridge.rs:350` 是 `#[tauri::command]`（非 `(async)`），函数内 `parse_blocks`（`:364`）+ 整缓存 `clone()`（`:381`）+ 最多 3 次整树 `render_html`（`:389`→`html_payload_parts`）。Tauri 同步命令在主线程执行，大文档下直接冻结窗口，与 `open_file`/`parse_markdown` 刻意 async 的初衷相悖。
**修复**：改 `#[tauri::command(async)]`（或在函数内 `spawn` 后 join）；整缓存克隆考虑只读快照/COW。

#### PERF-3 🟠 每按键约 4 遍全文扫描 ⚠️
`useDocStore.ts:135-147` 的 `tabToDoc` 每次 `commit` 都 `[...content]` + `split("\n")`；`StatusBar.tsx:43-47` 又算一遍；`EditorView.tsx:93-97` 的 store 订阅在任何变更（含光标/滚动）都做 `doc.toString()`；编辑更新回调再 `doc.toString()`。大文档下单次按键 O(n) 多次。
**修复**：投影只放 `content`，`char_count/line_count` 改惰性/按需；`EditorView` 订阅按 tab+version 短路；`StatusBar` 直接用 store 值。

### D. 无用 / 重复代码

| 编号 | 位置 | 说明 | 复核 |
|---|---|---|---|
| CQ-1 | `src/components/TopBar.tsx` + `menus/{File,View,Translate,Settings,Help}Menu.tsx` | 全文件无外部引用（仅自身与注释），且与 `AppMenu.tsx` 是两套并行菜单实现。删除约 350 行，消除"菜单两处真源"漂移。保留 `menus/Menu.tsx`（EditorToolbar 在用） | ✅ |
| CQ-2 | `Cargo.toml:5-10` | 注释声称 release `panic = "abort"`，文件里**没有该行**，也无 `.cargo/config`。注释与实现不符，误导审查与 panic 定性 | ✅ |
| CQ-3 | `src/lib/session.ts:55-57` `dirtyCount` | 全仓 0 引用；同逻辑在 `useDocStore.ts:504` 内联。删除或让 `restoreSession` 复用 | ✅ |
| CQ-4 | `src/lib/ipc.ts:81` `getProviderMeta` | 全仓 0 调用；Rust 侧 `get_provider_meta` 命令保留与否另行决定 | ✅ |
| CQ-5 | `baseName` 三处 | `lib/wsPath.ts:11`（正牌）、`useRecentStore.ts:20-23`、`useDocStore.ts:125-128`（`pathParts`）。统一 import `wsPath` | ✅ |
| CQ-6 | `SESSION_VERSION` 双定义 | `lib/session.ts:15` 与 `useDocStore.ts:175`（注释承认"两处同值"）。下沉到 `lib/sessionVersion.ts` 或 `types/ipc.ts` 避免环 | ✅ |
| CQ-7 | `translate/sign.rs:27-33` vs `providers.rs:95-101` | `hex` 两份完全相同；`providers.rs` 的 `clean` 与 `openai.rs` 的 `strip_fence` 语义重叠 | ⚠️ |
| CQ-8 | `translate/check.rs:27-28` | `src_line`/`dst_line` 恒为 0。实现行号或从 DTO 删除（前端 `types/ipc.ts` 同步） | ✅ |
| CQ-9 | `batch.rs:71/147/154/160` | `map_slots`/`ignored_protocol`/`has_leftover`/`fed_len` 生产零调用（`#[allow(dead_code)]`，注释称预留）。接上或删除，避免腐烂 | ✅ |
| CQ-10 | `dto.rs:97/110` | `#[allow(dead_code)]` 与"unused until Task 8"注释均已过期（`ProviderInfoDto` 已在 `bridge.rs:252/257`、`lib.rs:718-719` 使用） | ✅ |
| CQ-11 | `lib.rs:854-856` | 空的过期脚手架注释（Task 6/7），下面无测试 | ✅ |
| CQ-12 | `ExportMode` / `OutlineSide` / `PanelSide` 等同形别名；一批仅测试用 export | 收窄导出面，减少噪音。注意 `classifyPreviewHref`/`StreamFollower`/`resetSplitSync` 是**故意为测试导出**，勿误删 | ⚠️ |
| CQ-13 | `EditorToolbar.tsx:49` / `StatusBar.tsx:20` / `ReviewPanel.tsx:26` | 订阅整个 `doc` 对象（只用到 `!!doc` 或 `doc.content`），应改字段级选择器 | ✅ |
| CQ-14 | 四个 `*Dialog.tsx`（Confirm/Conflict/DirtyConfirm/Reload） | 同一 `createRoot` 单例样板复制四遍（各 `:70-91`/`:57-77`/`:62-83`/`:63-84`）。可抽 `createDialogHost<T>(render)` | ✅ |

### E. 竞态 / 可靠性（本轮未逐一跑测，标注待复核）

| 编号 | 位置 | 说明 | 复核 |
|---|---|---|---|
| REL-1 | `bridge.rs:409-412` 抢占 / `:666` 释放 | 翻译 worker 任一处 panic 会跳过 `running.store(false)` → 此后所有翻译返回"已有翻译在进行"，直到重启。建议 RAII guard 或 `catch_unwind` 兜底 | ✅ 逻辑 |
| REL-2 | `lib.rs`/`bridge.rs`/`hibernate.rs` 多处 `.lock().expect("... poisoned")` | 持锁线程 panic → 锁中毒 → 后续全部级联 panic。建议统一 `unwrap_or_else(\|e\| e.into_inner())` 或封装访问器 | ✅ |
| REL-3 | `lib.rs:93-96` `save_file`、`storage.rs:233-239`、`hibernate.rs:390-399`、`cache.rs:147-154` | 直接覆盖写，非原子。崩溃/断电会截断用户文档/设置/缓存。建议"临时文件 + rename" | ⚠️ |
| REL-4 | `ConfirmDialog.tsx:73` vs `:80-90` | 注释称"重复调用覆盖前者并解析为 false"，实现不会 resolve 前一个 Promise → 并发调用时先一个 awaiter 永久挂起。修正实现或注释（至少加应用级"正在显示"闸） | ✅ |
| REL-5 | `hibernate.rs:185-203` | 取消检查与 `destroy()` 之间 TOCTOU → 窗口可能闪现又消失 | ⚠️ |
| REL-6 | `capture/window.rs:58-86`、`ocr.rs:73-77` | capture 事件循环 `expect`/固定切片无护栏；线程崩溃或极端输入可能导致截图会话永久卡死。建议加边界守卫 | ⚠️ |
| REL-7 | `translate/cancel.rs:23-29` + `openai.rs:187-204` | 取消只在请求前检查；长流式响应中途无法取消。建议流读取定期查 cancel | ⚠️ |
| REL-8 | `translate/cache.rs:129-134` | `from_json` 用 `HashMap` 迭代序重建 FIFO → 冷启动后淘汰顺序随机，与注释契约不符。建议磁盘格式改有序数组 | ⚠️ |
| REL-9 | `useUiStore.ts:126-235` | localStorage 读取无 try/catch（与其它 store 的 safeGet/safeSet 口径不一致），隐私模式可能白屏 | ⚠️ |
| REL-10 | `lib/colDrag.ts:21-38` | body 样式清理只在 pointerup/cancel；拖拽中卸载会残留 `userSelect:none`。建议幂等 cleanup + window 兜底 | ⚠️ |
| REL-11 | `stores/useDocStore.ts:17` ↔ `useTranslationStore.ts:27` | 两个 store 静态循环 import（靠函数体内引用侥幸不炸）；而 workspace 那对用动态 import 绕环，策略不一致。建议统一延迟取用 | ✅ |
| REL-12 | `useSettingsStore.ts:105-119` | `save` 失败只回滚 `settings`，不回滚 `theme/palette/target` 派生值 → 明暗/方向失配 | ⚠️ |
| REL-13 | `previewExtensions.ts:85-97` | SVG 缓存用 32 位 hash 且无上限；碰撞会把别的图渲染进来且不自愈 | ⚠️ |
| REL-14 | `src/lib/session.ts` 等 | Tauri `listen*` 返回的 `UnlistenFn` 全部丢弃（应用级单例，运行时正确；多窗口/测试隔离时会残留） | ✅ |

### F. 已确认**不是**问题（避免误报与白干）

- **HTML 转义链完整**：`markdown/html.rs:40-53` 覆盖所有文本与属性（含 `href`/`src`/`alt`/脚注 label），引号被转义；原始 HTML 在 block 层被丢弃、inline 层经转义。未见可用注入点。
- **链接拦截正确**：`lib/linkSafety.ts:16-26,56-88` 白名单 `http/https/mailto/tel`，`javascript:`/`data:`/相对路径一律 block + preventDefault；Rust `open_external` 二次白名单。
- **译文注入安全**：`lib/patchPartial.ts` 全走 `textContent`/`createElement`，不拼 HTML。
- **`open_external` 无命令注入**：`open` crate 未启 `shellexecute-on-windows`，目标经环境变量传入。
- **TLS/重定向/签名安全**：`http.rs:85-93` 未关证书校验；ureq 跨域重定向剥离 `Authorization`；`sign.rs` 无自创加密、无密钥比较。
- **`translate_document` 返回长度不变量**：`engine::run` 返回长度恒等于 `units.len()`，故 `bridge.rs:609` 的 `texts[i]` / `indices[i]` 不越界。
- **`apply_op` 切片已加固**：`lib.rs:504-520` 先钳到 char boundary。
- **单遍遍历未被误拆**：`html.rs` 的 `collect_fn_labels`/`top_level_block_lines` 不推进 `sub/bi/ref` 计数器。

---

## 三、臃肿与拆分规划

### 3.1 量测（`.Count` 口径，2026-09-19 复测）

**Rust（生产 / 总量 / 测试）**

| 生产 | 总量 | 测试 | 文件 | 状态 |
|---|---|---|---|---|
| 823 | 1010 | 187 | `lib.rs` | 已知债 P2-1 |
| 751 | 781 | 30 | `capture/window.rs` | 已知债 P2-2 |
| 670 | 1025 | 355 | `bridge.rs` | 已知债 P1-5 |
| 601 | 809 | 208 | `markdown/model.rs` | 已知债 P2-3 |
| 559 | 562 | 3 | `markdown/html.rs` | 已知债 P1-6 |
| 440 | 681 | 241 | `hibernate.rs` | 已知债 P2-4 |
| 439 | 660 | 221 | `translate/providers.rs` | **未登记（新）** |
| 426 | 621 | 195 | `markdown/cmark.rs` | **未登记（新，文档遗漏）** |
| 366 | 678 | 312 | `translate/engine.rs` | 达标（拆后） |
| 366 | 605 | 239 | `translate/lookup.rs` | 达标 |

> 对照《拆分记录》，`lib.rs`/`bridge.rs`/`hibernate.rs` 因后续功能又长了（文档记 999/886/652，现 1010/1025/681）。`providers.rs`（439）与 `cmark.rs`（426）此前未进表。

**前端（总量）**

| 行数 | 文件 | 状态 |
|---|---|---|
| 1294 | `components/SettingsModal.tsx` | 已知债 P2-5 |
| 849 | `stores/useTranslationStore.ts` | 已知债 P1-1 |
| 807 | `components/Sidebar.tsx` | 已知债 P2-6 |
| 735 | `stores/useDocStore.ts` | 已知债 P1-3 |
| 715 | `components/PreviewView.tsx` | 已知债 P1-4 |
| 640 | `stores/useWorkspaceStore.ts` | 已知债 P2-7 |
| 519 | `src/App.tsx` | **未登记（新）** |
| 486 | `lib/paletteSeeds.ts` | 已知债 P2-8 |
| 314 | `components/AppMenu.tsx` | 未超线，但内含巨型 Record（见 §四.P2） |

CSS 已在 P1-2 拆成 13 个 ≤ 800 行域文件（最大 694/691），本次复测无新增超标。

### 3.2 拆分处方（按边界）

**Rust**

| 目标 | 现文件 | 拆法 | 硬约束 |
|---|---|---|---|
| `commands/{file,workspace_ops,dialogs,settings}.rs` + `window_boot.rs` | `lib.rs` | 文件/编辑器 IO、工作区右键一族、dialog 薄壳、设置/会话转发布；启动标志（`SHOWN`/`SILENT`/`INITIAL_FILE_PENDING`/`reset_startup_flags`）收进 `window_boot` | 纯提取；命令注册名不变 |
| `bridge/{commands,payload,worker,events}.rs` | `bridge.rs` | 命令外壳 / 载荷组装（`done_payload_parts`/`html_payload_parts`/`cached_done_evt`/`sweep_cached_pairs`）/ worker（`spawn_translation`/`shrink_if_idle`）/ wire 事件类型 | 先拆再改 PERF-2（async 化），否则改动混在千行文件里 |
| `hibernate/{state,window,session,handoff}.rs` | `hibernate.rs` | 状态机 / 建窗 / 快照 / 前端 handoff | 边界天然 |
| `markdown/model/{parse,anchors,types}.rs` | `model.rs` | walker / 行号锚点 / 类型与 options | `parse_blocks` 与 `top_level_block_lines` 必须共用同一 `options()` 与事件序；只搬家不改遍历 |
| `markdown/cmark/{escape,writer}.rs` | `cmark.rs` | 纯转义函数 / writer 与 run 计数 | `data-ri` run 计数恒只由 `Inline::Text` 推进，一行不动 |
| `markdown/html/{inline,code,footnote}.rs` | `html.rs` 生产 | 按"给谁 write"拆函数 | **绝不能按渲染阶段拆遍历轮次**（`sub/bi/ref` 单遍推进） |
| `translate/providers/{mod,free,signed,llm}.rs` | `providers.rs` | 免密钥族 / 签名族 / LLM 族 / 分发 | 改一个供应商不再翻 660 行 |
| `translate/{runner,events}.rs` | `engine.rs` | 把 `process_batch`/`translate_one`/`llm_once` 移出，`engine.rs` 只留 `run`+重导出 | 与 P0-1 的 `pub use` 纪律一致 |
| `capture/window/*` | `window.rs` | 会话状态机 / 像素绘制 / 编码裁剪 | **先给 `blit_pixels`/`draw_border` 补边界测试再拆**（生产占比 96%，无测试兜底） |

**前端**

| 目标 | 现文件 | 拆法 |
|---|---|---|
| `lib/translationStream.ts` + `lib/lookupStream.ts` + 薄 store | `useTranslationStore.ts` | 把 14 个模块级可变单例（`:82-116`）收进 `translationStream` 类实例；store 只留 React 可见状态与薄动作。**先做这步再修 BUG-5/REL-2 的清理不一致** |
| `stores/docTabs.ts` + `lib/sessionRestore.ts` + 薄 store | `useDocStore.ts` | 纯函数/投影 / 快照恢复 / 生命周期动作 |
| `components/settings/*Tab.tsx` + `hooks/useSettingsDraft.ts`/`useLlmProfiles.ts`/`useHotkeyRecorder.ts` | `SettingsModal.tsx` | 5 个 tab 各一子组件；草稿合并、档案 CRUD、录制各一 hook；`PaletteCard`/`SwitchRow`/`Bar` 已可复用 |
| `components/sidebar/*` + `useTreeMenus.ts` + `lib/clipboard.ts` | `Sidebar.tsx` | 品牌头 / 最近 / 工作区树 / 行组件；4 套菜单构造器收进 hook；`Row` 的 9 props 压成对象 |
| 4 个 hook + `lib/previewInject.ts` | `PreviewView.tsx` | 渲染注入 / 滚动同步 / 划词 / 菜单构造；本体只留 refs 接线与 JSX |
| `hooks/{useAppHotkeys,useHibernate,useSettled}.ts` + `components/Panel{Resizer,Handle}.tsx` | `App.tsx` | 新发现，超"单组件 ≤400"线 |
| `lib/paletteSeeds/<id>.ts` + `index.ts` + `lib/paletteCss.ts` | `paletteSeeds.ts` | 种子表与生成算法分离；保持 `PALETTE_IDS` 顺序稳定 |

**拆分纪律（照《拆分记录》第五节，违反等于白拆）**：纯提取零行为改动；拆分提交独立于功能提交；可见性不外扩（同 crate 用 `pub(crate)`）；旧路径 `pub use` 保留；CSS 保序 + 真引擎校验；每批过门禁；拆完复测行数并更新表。

---

## 四、整改规划（分批，独立提交）

### P0 — 正确性与数据安全（挡在继续叠功能之前）

| # | 项 | 依据 | 改动 | 验收 |
|---|---|---|---|---|
| P0-1 | 双语导出补 Table 占号 | BUG-1 | `export.rs` 补 Table 分支，与 `units::walk_collect` 逐位一致 | 新增"表格前后各一段"回归，修复前必红；`cargo test` 绿 |
| P0-2 | 核查索引空间与 mode | BUG-2 | `check_translation` 加 `mode`/`target_lang`；前端同步传参 | 新增嵌套/表格端到端守卫；`cargo test`+`tsc`+`vitest` 绿 |
| P0-3 | 保存基线写对 | BUG-3 | `savedContent: t.content` | 新增"往返期间编辑"单测 |
| P0-4 | 批处理分隔符转义/nonce | BUG-4 | `batch.rs` 编码转义或随机 nonce | 新增"正文含分隔符"回归 |
| P0-5 | 起跑成功分支代际守卫 | BUG-5 | 成功 `set` 前比 `genBefore` | 新增"在飞 stop"单测 |
| P0-6 | `discardChanges` 收敛写路径 | BUG-6 | useDocStore 暴露动作，workspace 调用 | 新增投影即时更新测试 |
| P0-7 | 图片 alt 深度计数 | BUG-7 | `collect_raw_text` 改嵌套计数 | 新增 `![**b**](x) tail` 回归 |
| P0-8 | `translate_document` async 化 + 去全量克隆 | PERF-2/PERF-3 | 命令改 `async`；缓存快照降本 | 大文档实测不冻结；现有测试绿 |
| P0-9 | `running` RAII + 锁中毒策略 | REL-1/REL-2 | guard 复位；统一 `unwrap_or_else(into_inner)` | 注入 panic 用例后功能可继续 |
| P0-10 | 修正 `panic` 注释 | CQ-2 | 删除误导注释或补 `panic="abort"`（需与 REL-1 一起决策） | 配置与注释一致 |

> P0-8/P0-9 建议**先跑 P1 的 `bridge.rs` 拆分**再动，否则改动面淹没在千行文件里；若想先止血，也可先打小补丁、拆分时再整理。

### P1 — 安全纵深与可靠性

| # | 项 | 依据 | 备注 |
|---|---|---|---|
| P1-1 | CSP + asset scope 收窄 | SEC-1 | 需真机验证 mermaid/KaTeX/字体；独立任务 |
| P1-2 | 路径 IPC 根校验 / `resolve` 归一 | SEC-2 | 改动面最大，随 P1-1 |
| P1-3 | 凭据存储决策（注释/DPAPI） | SEC-3 | 至少先改注释 |
| P1-4 | 无界缓冲上限 + 非本机 https | SEC-4 | SSE/单行/错误体各设上限 |
| P1-5 | 嵌套深度上限 | SEC-5 | 防恶意文件闪退 |
| P1-6 | 原子写（文档/设置/缓存/快照） | REL-3 | 临时文件 + rename |
| P1-7 | `ConfirmDialog` 覆盖前 resolve | REL-4 | 修注释或实现 |
| P1-8 | 取消语义覆盖流式与查词 | REL-7 | |
| P1-9 | 核查面板防抖 + 字段级订阅 | PERF-1/CQ-13 | |
| P1-10 | CI actions pin SHA + `cargo audit` | SEC-6 | |
| P1-11 | `hibernate` TOCTOU / capture 护栏 / localStorage 兜底 | REL-5/6/9 | 逐条小补丁 |

### P2 — 清理与拆分

| # | 项 | 依据 |
|---|---|---|
| P2-1 | 删除 `TopBar.tsx` + 5 个菜单文件（保留 `Menu.tsx`） | CQ-1（~350 行，先删） |
| P2-2 | 抽 `createDialogHost` 合并四对话框 | CQ-14 |
| P2-3 | `baseName`/`SESSION_VERSION`/`hex`/`clean` 去重 | CQ-5/6/7 |
| P2-4 | 删 `dirtyCount`/`getProviderMeta`/过期 `allow(dead_code)`/空注释 | CQ-3/4/8/10/11 |
| P2-5 | `batch.rs` 预留 API 接上或删除 | CQ-9 |
| P2-6 | 收窄多余 export / 同形别名 | CQ-12 |
| P2-7 | Rust 拆分：`bridge` → `lib` → `model`/`html`/`cmark`/`hibernate`/`providers`/`capture` | §三 |
| P2-8 | 前端拆分：`useTranslationStore` → `useDocStore`/`Sidebar`/`PreviewView`/`SettingsModal`/`App.tsx`/`paletteSeeds` | §三 |
| P2-9 | `AppMenu` 二级菜单拆子组件 | 新发现 |

---

## 五、修复优先级与门禁

**建议顺序**（投入产出比从高到低）：

1. **P0-1 ~ P0-7**（准确性与数据安全，改动小、边界清晰、都有可加的回归）——这是本次审查真正的"止血"。
2. **P0-8 ~ P0-10**（性能与可靠性）——先拆 `bridge.rs`，再动。
3. **P1-1**（CSP/scope）——单点收益最大的安全项，但需真机验证。
4. **P1 其余**（原子写、缓冲上限、深度上限、CI pin）——成本低、收益明确。
5. **P2 清理**（先删死代码，再拆）。
6. **P2 拆分**（按《拆分记录》纪律逐批）。

**每批必过门禁**：`cargo check`、`cargo test`；`npx tsc --noEmit`、`npx vitest run`；涉及 CSS 跑 `python tools/css-probe.py`。拆分批次必须"忽略 `mod`/`use`/签名搬家后 `git diff` 为空"。

---

## 六、需人工确认清单

1. `check.rs` 的权威索引空间应以 data-ri 还是 data-bi 为准？前端未传 mode 是遗漏还是设计？（BUG-2，倾向遗漏）
2. `Cargo.toml` 注释声称 abort：是有意保留 unwind 还是漏配？（CQ-2；影响 REL-1 的定性）
3. `export.rs` 未处理 Table 是已知未实现还是漏写？（BUG-1，倾向漏写——同文件头注释宣称与 `walk_collect` 逐位一致）
4. `order_batches` 的 `viewport` 生产恒 `None`，是否还有接线计划？
5. `batch.rs` 四个预留 API 近期接还是删？
6. `csp:null` + scope `**` 是否有意为之（本地工具、暂缓）？若是，需在配置里写明理由。
7. `AppMenu.tsx:286` 的"退出"用 `window.close()` 在 WebView2 是否有效？（可能死项）
8. 是否要做"文件拖入即打开"？（全库无拖放处理）

---

## 附录：本次审查覆盖与未覆盖

- **已覆盖**：Rust `src-tauri/src` 全部 40 个文件；前端 `src/**`（stores/lib/components/App/types，CSS 未逐文件细看，已有 P1-2 专项与 `css-probe.py`）。
- **未覆盖**：`target/`、`node_modules/`、`dist/`、`docs/redesign/` 原型；`cargo audit`（未安装，未做依赖漏洞扫描）。
- **复核状态说明**：标 ✅ 的结论经作者二次读源码确认；标 ⚠️ 的为子代理报告、逻辑可信但未本地运行验证，实施前需先复现。

---

## 执行记录（2026-09-19，P0 批次）

本批次按 §四.P0 处方完成 P0 全部 10 项（P0-8 与 P0-9 合并为一个提交），共 9 个执行单元、10 个提交，逐项经独立代码评审，结论均为「评审通过、无需返工」。其中 7 项提供修复前必红、修复后转绿的 TDD 证据；P0-8+9 与 P0-10 为结构/注释类改动（redAttested=false，与处方预期一致）。批次收口门禁四项全绿：`cargo check`、`cargo test`、`npx tsc --noEmit`、`npx vitest run` 退出码均为 0（批次执行流程实跑；撰写本记录时未复跑）。

| 计划项 | 提交 | 要点 | 验收状态（含评审结论） |
|---|---|---|---|
| P0-1 双语导出补 Table 占号 | afa774e | `export.rs` 补 `Block::Table` 两处分支（`emit_table_translations`/`emit_table_cell_translation`），按 `units::walk_collect` 同序（先表头、再逐行逐格）占号，缺段回退原文，嵌套表格同覆盖 | ✅ 评审通过。回归「表格前后各一段」修复前实跑必红（表头译文错贴为表后段），修复后绿 |
| P0-2 核查索引空间与 mode | 80cd9ef | `check_translation` 增加 mode/target_lang 参数，按模式复用 units 真实收集器（translation=data-ri run 空间 / bilingual=data-bi 块空间，递归 Quote/List/Table/FootnoteDef），bridge 与前端同步传参 | ✅ 评审通过。两条端到端守卫修复前必红；MarksLost/CodeInvaded 常规输入结构性不可达，保留为 IssueKind 契约安全网（检测能力收缩已在代码注释如实交代） |
| P0-3 保存基线改用写盘内容 | 6202ada | saveDoc 保存基线由 await 后的 `cur.content` 改为写盘快照 `t.content`，写盘往返期间的继续输入保持脏标 | ✅ 评审通过。挂起 saveFile mock 回归修复前必红（`isDirty` 断言失败），修复后绿 |
| P0-4 批量分隔符防正文注入 | baac91b | 选随机 nonce 方案：`new_nonce`（std RandomState 熵源，零新依赖）贯通 encode/instruction/BatchDecoder，nonce 不匹配的标记只跳过；PROMPT_VERSION v2→v3，既有协议测试按新 API 迁移 | ✅ 评审通过。回归修复前实跑必红（单元 0/1 被字面量标记截断）；评审标注一处低危遗留（见下方遗留清单） |
| P0-5 起跑成功分支代际守卫 | d75e592 | started 成功分支落 set 前补 `if (gen !== genBefore) return`，与 catch 分支同口径；在飞 stop/resetDisplay 后迟到响应不再把 status 拉回 running | ✅ 评审通过。在飞 stop 单测修复前必红；cached 分支未被守卫覆盖属既有行为，建议后续上提统一收口 |
| P0-6 discardChanges 收敛写路径 | 11c02b6 | useDocStore 暴露 `discardChanges(id)`（内部走 patchTab，投影与写入同一次 set 重算），workspace deleteNode「不保存」分支改调之 | ✅ 评审通过。回归修复前红（方法不存在）、修复后绿；deleteNode 回收站取消后不再追问保存为既有语义，建议另开条目评估 |
| P0-7 图片 alt 解析深度计数 | 8ecdd02 | `collect_raw_text` 照 pulldown 自带 raw_text 改嵌套深度计数（End 且深度 0 才 break），`Event::Code` 计入 alt，同段后续文本不再被吞 | ✅ 评审通过。两条回归修复前实跑必红（尾段被吞 / Code 缺失），修复后绿 |
| P0-8+9 translate_document 异步化 + running RAII/锁中毒策略 | fd11057 | `translate_document` 改 `#[tauri::command(async)]`（解析+渲染不再占主线程）；新增 RunningGuard（Drop 复位 running，panic 展开亦复位）；lib.rs/bridge.rs/hibernate.rs 全部 `.lock().expect("…poisoned")` 统一 `unwrap_or_else(into_inner)` | ✅ 评审通过。REL-2 半边真红（投毒测试转换前实跑必红）；async 化与 guard 挂接需 Tauri runtime，单测不可驱动，redAttested=false 与处方预期一致；「缓存快照降本」半项延后至 P2-7 |
| P0-10 修正 Cargo.toml 失实 panic 注释 | 24548b4 + a2ca74d | 两轮返工后注释收窄为「三文件锁访问已统一（P0-9）」并如实标注 engine.rs:126 尚有一处 expect 待补遗；纯注释零行为改动 | ✅ 评审通过（复审确认首轮意见已解决）。redAttested=false |

### 遗留与移交

- **P1/P2 未动**：本批次仅覆盖 P0 十项，P1（P1-1~P1-11）与 P2（P2-1~P2-9）均未启动。评审已明确挂到后续批次的：P2-7 拆 `bridge.rs` 时补「缓存快照降本」（PERF-2 处方可选项，需显式记录避免静默丢失）与 worker 挂接级回归（现有测试只钉住 RunningGuard 原语，删掉挂接测试仍绿）；P0-9 补遗——`engine.rs:126` 最后一处 `poisoned` expect 与 `bridge.rs` 测试内一处 unwrap 的统一，留待单独决策。
- **需真机验证**：① PERF-2「大文档实测不冻结」——单测环境不可覆盖，提交信息已如实声明，仍待实测（评审另建议后续在函数内改 spawn_blocking，避免长解析占住 tokio worker）；② CSP（本计划 P1-1 / SEC-1，本批次未动）——落地时需真机验证 mermaid/KaTeX/字体加载不受最小 CSP 影响。
- **开放决策**：P0-10 的 panic=abort 取舍——评审核实当前配置未启用 abort、注释已改为如实陈述，但「有意保留 unwind 还是补配 abort」仍未决（对应 §六第 2 条人工确认项，影响 REL-1 定性）。
- **工作区残留（`git status --porcelain` 实测）**：仅两项未跟踪——`docs/superpowers/plans/2026-09-19-code-audit-and-remediation.md`（本文档自身，本节追加后仍未提交）与 `nul`（Windows 误重定向产生的文件名残留，建议清理）；无已跟踪文件的未提交改动。
- **评审遗留低危跟进（非阻塞，摘录备查）**：
  - P0-4：`batch.rs` `next_unit` 对 `-`/`>>>` 做全缓冲无界两段搜索，存在「伪开标记吞掉中间真实译文、按邻槽 delivered 不重试」的低概率路径（评审指出，batch.rs:236-253），建议先定位 OPEN_SUFFIX 再回验 nonce 结构；`engine.rs:412` 旧式协议 fixture 建议顺手换普通文本。
  - P0-3：closeTab「保存后关闭」分支 await saveDoc 后不复查脏态，写盘往返期间的继续输入仍会随关标签静默丢弃（评审指出，useDocStore.ts:408-413，既有缺口、恰为 BUG-3 同类丢失类）。
  - P0-5：代际守卫未覆盖两个 cached 早退分支（评审指出，useTranslationStore.ts:640-642），取消轮次的迟到 cached 响应仍会生效，建议守卫上提到 await 返回后统一收口。
  - P0-2：check 对未知 mode 静默回落 run 空间，与 translate_document 的硬报错口径不一致（评审指出，check.rs:97-99）；改用收集器后 MarksLost/CodeInvaded 检测能力收缩，建议在 BUG-2 条目补记。
  - P0-8+9：`src/lib/earlyPartial.ts:3` 注释仍称 translate_document 是同步命令，async 化后已过期，建议顺手更正。

---

## 执行记录（2026-09-20，P1 批次）

本批次按 §四.P1 处方完成 P1 全部 11 项（P1-11 按处方拆为三个小提交），共 11 个执行单元、13 个提交，逐项经独立代码评审，结论均为「评审通过、无返工」（reviewRounds 全为 0）。红证据口径：10 项提供修复前实跑红、修复后转绿的证据（redAttested=true），其中 P1-10 为 YAML-only 改动无法写单测回归，红绿对照用配置级 grep 前后检查代替；P1-11 整体记 redAttested=false——REL-5 与 capture/window.rs 两半项需 Tauri/winit 运行时不可离线单测、为代码级论证，但 ocr.rs 与 localStorage 两半项仍提供了修复前必红实跑证据。批次收口门禁四项全绿：`cargo check`、`cargo test`（lib 327 passed / 0 failed + 集成 asset_scope 2 passed / 0 failed）、`npx tsc --noEmit`、`npx vitest run`（35 files / 325 tests passed，输出含既有 SettingsModal `act()` 警告，不影响退出码）——均为批次执行流程实跑，撰写本记录时未复跑。

| 计划项 | 提交 | 要点 | 验收状态（含评审结论） |
|---|---|---|---|
| P1-1 CSP + asset scope 收窄 | ff53bf4 | `tauri.conf.json` 落地最小 CSP（`default-src 'self'`/`script-src 'self'`/`object-src 'none'`，`img-src` 含 `asset:`/`https:` 保留既有远程图，`style-src` 按处方备选取 `'unsafe-inline'` 供 KaTeX/mermaid）；asset scope 改 `[]`，`resolve_image` 运行时逐文件 `allow_file` 放行，任意盘符出图不回退；回归改真实 Wry 集成测试（测试二进制经 build.rs 嵌 manifest 解 0xc0000139） | ✅ 评审通过。`tauriSecurity` vitest 修复前实跑 5 failed（缺 `'self'`/含 `'**'`）→ 5 passed；集成测试两段红（scope 未收窄 / 未放行）→ 绿。CSP 生产态生效，mermaid/KaTeX/asset 图真机验证待人工 |
| P1-2 路径 IPC 根校验 / resolve 归一 | 10729be | `resolve` 增 `..` 词法归一 + `resolve_within` 根校验（文档目录 + open_workspace 登记的会话内存工作区根，canonicalize 剥 verbatim 前缀）；create/rename/delete/move/create_from_template 六写命令 fail-closed；open_file/save_file/reveal/open_terminal 等用户对话框入口有意不约束（约束即破坏合法流），纵深由 P1-1 承担 | ✅ 评审通过。⚠️ 项实跑复现：修复前 `resolve_image("../outside.png")` 未归一未拒绝、`create_file` 根外返回 Ok，修复后红转绿（集成 2 passed）。残余限制如实声明：允许根由 IPC 登记非对话框签发，capability 化留后续 |
| P1-3 凭据存储如实注释 + 广播脱敏 | 6e58d5c | storage.rs 头注释如实化（明文 JSON 落盘、同账户可读、不做加密，DPAPI 属产品决策未实施），`types/ipc.ts:91` 同源误导注释一并更正；`settings-updated` 广播由整份 Settings 收窄为 `{theme,palette}`（唯一消费方 applyRemote 只读这两字段），前端同步 `SettingsBroadcast` 类型 | ✅ 评审通过。广播脱敏回归修复前实跑必红（失败输出回显两处探针凭据字段），修复后 storage 12 passed。DPAPI 加密开放决策本批不做 |
| P1-4 无界缓冲上限 + 非本机 https + SSE 空闲超时 | 1777a2b | sse/openai/http 各设上限（SSE 缓冲 16MiB、content 累积 8MiB、错误体 1MiB、`bounded_body`）；`validate_base_url_scheme`：https 放行、http 仅限本机（剥端口/userinfo/zone id），chat_stream 与 fetch_models 两处接入；去请求级 `.timeout()`（ureq 整包 deadline 掐长流），空闲回落 timeout_read 30s + LooseDeadlineReader（批量 120s→20 分钟） | ✅ 评审通过。三条红测修复前实跑全 FAILED（10MiB 内容 Ok 收下 / 明文 http 放行），修后全绿；首轮红测暴露校验器漏剥端口的真 bug（127.0.0.1:11434 误拒）已修。OOM/超时两类 ⚠️ 按代码与 ureq 源码论证加固，未构造真实恶意端点/长流 |
| P1-5 嵌套深度上限 256 | 9930777 | `MAX_NESTING_DEPTH=256` 穿透块级（consume_block↔collect_blocks）与行级（collect_inlines↔push_inline）两条互递归，超限经迭代版 collect_raw_text 降级纯文本；units.rs walk 递归深度随之封顶并加不变量注释 | ✅ 评审通过。⚠️ 项已复现：仓库外探针实跑 10 万层引用 / 2 万层强调 parse_blocks 栈溢出 abort；修复后 deep 4 例全过（5 万层引用降级不崩、实测 257=MAX+1 恰降级），全量 322 passed。真实 GUI 打开恶意文件未真机验证 |
| P1-6 原子写（文档/设置/缓存/快照） | b0a40c5 | 新增 `atomic_write.rs` 统一工具（同目录 `.名称.tmp-<pid>-<纳秒>` create_new → write_all → sync_all → rename，任一步失败清临时文件并原样报错）；一行替换接入 save_file/save_settings_to/save_snapshot_to/Cache::save 四处 | ✅ 评审通过。⚠️ 项复现成功：独立进程 abort 实验下旧写法目标被 190MB 半截顶替、旧内容丢失，原子写目标完好仅留 .tmp；工具函数 todo!() 红（3 failed）→ 绿（含 Windows share_mode 失败注入实证 rename 覆盖语义） |
| P1-7 ConfirmDialog 覆盖前 resolve | 2f7c8cd | 选「修实现」：模块级 pending 持当前弹窗结算入口作应用级「正在显示」闸，第二次 showConfirm 先把前者 resolve(false) 再接管单例 host（兑现原注释契约）；唯一调用方把 false 当取消，被覆盖 awaiter 语义安全 | ✅ 评审通过。并发回归修复前实跑红（前者 awaiter 挂死，`expected false to be true`），修复后 3 passed，前端全量绿 |
| P1-8 取消语义覆盖流式与查词 | 204597c | 新增 CancelReader 包装流式响应体，read_until 每行边界查 cancel 旗标（与 LooseDeadlineReader 同款读间隙模式，openai.rs/sse.rs 零改动）；补查词接线——lookup_word 原用裸 UreqClient 根本不经 CancelableClient，空闲时复位陈旧旗标 | ✅ 评审通过。两条红测修复前实跑（取消后流仍被读完并出可用结果），修复后全量 327 passed。真实 SSE 长流不可离线验证，双段静态流 mock 覆盖同路径；engine.rs:126 expect 按最小改动未动 |
| P1-9 核查面板防抖 + 字段级订阅 | fc4ac32 | effect 依赖改 `doc.content` + 250ms 尾沿防抖 + checking 重入闸（被拦触发落定后按最新内容补查，末次变更不被吞）；ReviewPanel/EditorToolbar/StatusBar 三处整 doc 订阅改字段级选择器（只返回原始值，符合 zustand v5 铁律） | ✅ 评审通过。修复前红测实证 3 次按键发 4 次 IPC（另 mode/target 立即重查、慢查并发第二 IPC 两红），修复后 21 tests passed、前端全量 35 files / 325 tests。真机敲键延迟未测 |
| P1-10 CI actions pin SHA + cargo audit | f9a69f2 | release.yml 六 action pin commit SHA（GitHub API 逐一 /commits/{sha} 复核；dtolnay stable pin 分支头并注明日期）；新增独立 cargo-audit job（rustsec/audit-check@v2.0.0，无 needs 与 release 并行、结构上不阻塞发布，权限收窄 contents:read） | ✅ 评审通过。actionlint 零告警（对故意写坏的对照 workflow 实跑报错，证工具有效）。YAML-only 无法单测，红绿为配置级证据（修复前 grep 六处可变 tag，修复后残留可变 ref 检查零命中）。CI 真实运行待下次 tag push |
| P1-11 hibernate TOCTOU / capture 护栏 / localStorage 兜底 | 101879c + 7cb26fc + b7b3670 | hibernate destroy 前复检 CANCELLED 收窄 TOCTOU（清理逻辑抽 abandon_cancelled_hibernate 两处复用）；capture_proxy 改返回 Result、四处 expect 降级，初始化失败回发 Cancelled 不再卡死会话，ocr 固定切片加边界护栏；useUiStore localStorage 四读五写全 try/catch（读回默认值防模块初始化白屏） | ✅ 评审通过。ocr 与 localStorage 两半项修复前实跑必红（切片越界 panic / 隐私模式模拟抛错）转绿；REL-5 与 window.rs 半项需 Tauri/winit 运行时不可离线单测，代码级论证，整体 redAttested=false（同 P0-8+9 惯例） |

### 遗留与移交

- **P2 未动**：本批次仅覆盖 P1 十一项，P2（清理与拆分 P2-1~P2-9）均未启动。
- **需真机验证**（本批次仅做到编译/单测/集成层，均未运行真实窗口或真实网络）：① P1-1 CSP 为生产态生效（dev 页面由 Vite 直出不经过 CSP）——mermaid 图、KaTeX 公式（含字体）、asset: 本地图片（Windows `http://asset.localhost`）、窗口加载是否全部正常，待真机/生产构建验证；② P1-2 树右键 create→rename→move→delete 全流程与预览图实际渲染，建议人工过一遍；③ P1-4 真实长流（真模型/慢网）的超时与空闲超时行为；④ P1-5 文件关联双击打开恶意文件的 GUI 层验证；⑤ P1-11 hibernate 唤醒竞态、capture 线程崩溃路径、真实隐私模式 localStorage；⑥ P1-3 `app.emit` 跨窗口端到端行为（单测以纯函数 seam 覆盖）；⑦ P1-9 真机敲键延迟体感；⑧ P1-10 CI workflow 真实运行（本地无 runner），待下次 tag push 或 workflow_dispatch 在 GitHub 验证。
- **未复现声明**：P1-1 未复现可直接利用的注入（本项按处方做纵深加固，计划 §二.F 结论沿用）；P1-4 OOM/超时两类 ⚠️ 缺陷按代码与 ureq 2.12.1 源码论证加固，未构造真实恶意端点或真实长流复现。
- **开放决策**：① DPAPI/系统凭据管理器加密（SEC-3，对应 §六人工确认项）——本批明确不做，仅注释如实化 + 广播脱敏；② P1-2 残余限制——允许根由 open_workspace IPC 登记而非原生对话框签发、closeFolder 未向 Rust 反注销（陈旧根残留至重启），彻底解法需 tauri-plugin-fs scope capability 化，本批未走；③ P1-1 纯 `http:` 图片将被 CSP 拦（有意收紧），真机反馈需要时再议。
- **低危跟进（非阻塞）**：P1-11 hibernate 复检与 destroy 之间的指令级残余竞态仍在（处方明示接受的最小收口，完全关闭需序列化 cancel/destroy）；P1-8 `engine.rs:126` 最后一处 poisoned expect 留待后续（建议 `unwrap_or_else` 恢复，与 bridge.rs 既有口径一致）；P1-6 崩溃残留 `.tmp` 未加启动清扫（可按 `.名称.tmp-<pid>-*` 前缀清理，留作后续）；P1-10 dtolnay stable 为分支头 pin、随上游推进需定期更新，audit-check 为 node20 action（GitHub 未来全面切 node24 需跟进新版本），可选每周 cron 独立 audit 工作流未加（超最小处方，可作增强）。
- **实施中发现的计划外事项**：① 测试基建——tauri 自带 mock runtime 在本机使测试 exe 起步即 0xc0000139（上游已知问题 #13419/#13954），asset_scope 回归改真实 Wry 集成测试；集成测试链入 tauri app 后缺 Common-Controls v6 manifest 同样起步崩，按 tauri 官方同解在 build.rs 用 rustc-link-arg-tests 仅为测试二进制嵌 manifest（主程序不受影响）；`#[tauri::command]` 隐藏项与 pub fn 冲突（E0255），加 `resolve_image_for_test` 薄壳转发跑同一函数体。② P1-4 首轮红测暴露校验器漏剥端口的真 bug（127.0.0.1:11434 被误拒），修端口剥离后转绿；另核实 ureq 2.12.1 自带 10MiB 内部上限（计划称「无上限」不准确），改显式 16MiB 不再依赖库实现细节。③ P1-8 侦察假设与现状不符：查词 bridge.rs 此前用裸 `UreqClient::shared()`，根本没经过 CancelableClient，本项补上接线。④ P1-11 计划 REL-9「与 safeGet/safeSet 口径不一致」措辞不实（全仓无该助手），实际照 useWorkspaceStore/useRecentStore 逐点 try/catch 模式包裹；P1-9 计划 CQ-13 称 StatusBar「只用到 `!!doc` 或 `doc.content`」与实况不符（还用 path/name/encoding），按实际消费字段最小等价改写。⑤ P1-2 实施中一次 Edit 误改 workspace.rs 模板字符串，提交前 diff 审查发现并逐字还原（`git show HEAD` 复核无模板行变更）。⑥ P1-6 Windows 失败注入发现 `std::fs::File::open` 默认共享位含 FILE_SHARE_DELETE（拦不住 rename），测试改 `OpenOptionsExt::share_mode` 显式去 DELETE 位才稳定触发 sharing violation；P1-3 探针值改用非凭据形标记串 LEAK-PROBE-CANARY-*（Mimosa 两次拦截凭据形字面量，即便明显假密钥），防护效果等价。
- **Mimosa 备注**：本批次多轮提交前钩子提示扫描结论不完整（python_ast 不可用等，按兼容策略放行），本记录不构成项目级安全审计声明，仅各项改动经其检查。
- **门禁与工作区状态**：收口门禁四项全绿（数据来自批次收口材料，撰写本记录时未复跑）。工作区残留 `?? nul` 为基线已有（f9a69f2 时即存在），全程未触碰；本文档本节追加后随本提交入库。
