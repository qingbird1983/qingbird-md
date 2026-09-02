# 迭代计划：对标 InkNote 差距补齐（v0.2）

**Date:** 2026-09-02
**Goal:** 对照 InkNote（F:\AI\InkNote，同栈 Tauri + 前端渲染）补齐我们作为 Markdown 编辑器的基础能力面，同时保住翻译流水线这一独有差异化。
**来源:** InkNote 全量对比分析（对话记录 2026-09-02）+ 用户实测发现的三个渲染/排版差距。

## 背景结论（InkNote 对比）

- 我们的独有能力（不对齐、不丢弃）：3 源翻译流水线（签名/分批/并发/缓存）、单实例 handoff、全局热键、IPC 契约测试。
- InkNote 已有、我们缺失：导出 HTML/PDF、工作区内容搜索、Quick Open、front matter、HTML 粘贴转 Markdown、非 UTF-8 编码兼容、外部修改重载提示、文件冲突检测、自动更新、UI i18n、主题/排版多档、聚焦/打字机模式、最近文件。
- 已完成不重排：KaTeX + Mermaid 渲染（2026-08-30 计划已落地，`previewExtensions.ts` + `katex`/`mermaid` 依赖在位）。
- 工程面差距：InkNote 前端几乎每个纯逻辑模块配 `.test.ts`；我们前端测试偏薄。

## 用户实测发现的三项渲染差距（本轮新增，优先级最高）

1. **表格不随页面宽度拉伸**：`markdown.css` 的 `.markdown-body table` 只有 `margin/border-collapse`，没有 `width: 100%`，列宽只随内容收缩，与 InkNote 的"表格跟满正文宽度"观感差距明显。
2. **正文宽度只有两档**：硬编码 794px（A4）+ `.wide` 1200px，InkNote 提供多档页面宽度选择。
3. **设置界面排版**：InkNote 的 Settings 分区布局（`Settings.tsx`）是后期学习的排版方向，本轮先记录，不阻塞功能迭代。

---

## Phase 1 — 渲染排版修正（小 diff，先做）

### T1 表格自适应宽度
- 文件：`src/styles/markdown.css`
- 改动：`.markdown-body table { width: 100%; }`；`.markdown-body th, td` 补 `text-align: left`（长单元格配合现有 `word-wrap: break-word` 防溢出）。
- 验收：含表格的文档在预览/分栏下表格占满正文宽度；窄分栏下不横向溢出；双语 tr-box 在单元格内不撑高行（现有行为不回归）。

### T2 正文宽度多档化
- 文件：`src/styles/markdown.css`、`src/stores/useUiStore.ts`、`src/components/menus/ViewMenu.tsx`
- 改动：把「窄 / 宽」两档扩展为「紧凑 640 / 标准 794 / 宽 1000 / 全宽 1200」四档（`.w-compact` / 默认 / `.w-wide` / `.w-full`），偏好沿用 uiStore/localStorage 现有持久化路径，菜单从布尔切换改四选一。
- 验收：四档切换即时生效且重启记住；默认档仍为 794（不改变现有用户观感）。

## Phase 2 — 导出与查找

### T3 导出独立 HTML
- 文件：`src-tauri/src/`（新 `export.rs` 或并入现有命令模块）、`src/lib/ipc.ts`、`src/components/menus/FileMenu.tsx`
- 改动：复用 `parse_markdown` 的渲染产物，包上 markdown.css 内联样式 + 当前主题变量落盘；走现有 `save_file` 原生对话框路径。PDF 明确后置（webview 打印跨平台坑多，等真实需求）。
- 验收：导出的 HTML 双击打开即可读，暗色/亮色主题正确，代码高亮保留；文件菜单出现「导出 HTML」项。

### T4 CommandPalette 升级为文件模糊搜索（半个 Quick Open）
- 文件：`src/components/CommandPalette.tsx`、`src/stores/useWorkspaceStore.ts`
- 改动：命令面板输入时同时 fuzzy 匹配工作区文件名（复用工作区树已有数据，零新 IPC），选中即 `open_file`；前缀区分命令/文件（如无前缀混排、`>` 只搜命令）。
- 验收：输入文件名片段能秒开工作区文件；原命令功能不回归。

### T5 工作区内容搜索（可后置到下轮）
- 文件：`src-tauri/src/workspace.rs`（新命令 `search_workspace_content`，rayon 多线程读 + 大小写不敏感子串匹配 + 结果分页下发）、前端结果列表 + 跳转。
- 验收：10k 文档级工作区搜索 < 2s；点击结果打开文档并定位行。

## Phase 3 — 数据安全与中文场景

### T6 外部修改检测与重载提示
- 参考 InkNote `ReloadDialog.tsx`。监听已打开文档的修改（tauri fs notify 或保存前后 mtime 比对），弹「文件已被外部修改 — 重新加载 / 保留我的版本」。**不做会丢用户改动，列入 regression-checklist。**

### T7 非 UTF-8 编码读取兜底
- 文件：`src-tauri/src/`（读文件路径处）+ `Cargo.toml` 加 `encoding_rs`
- 改动：UTF-8 解码失败时尝试 GBK/GB18030（中文用户主场景），状态栏标注实际编码。
- 验收：GBK 文档打开不乱码；UTF-8 路径行为不变（加 Rust 单测）。

### T8 保存前文件冲突检测
- 参考 InkNote `FileConflictDialog.tsx`：保存时 mtime 与打开时不一致则提示覆盖/另存。依赖 T6 的 mtime 机制，一并做。

## Phase 4 — 长线（backlog，按需启动）

- **UI i18n**：组件尚少时做最划算；建 `src/lib/i18n.ts` 词表，先覆盖菜单+设置。
- **自动更新**：Tauri 官方 updater 插件，等开始正式发版再接 CI。
- **front matter 编辑器 / HTML 粘贴转 Markdown / 最近文件 / 聚焦模式**：各自独立小项，按用户反馈排。
- **设置界面重排版**：学习 InkNote `Settings.tsx` 的分区布局，随功能增多自然触发，不单独立项。
- **前端纯函数层测试补齐**：参照 InkNote 的 `*.test.ts` 密度，优先 `lib/` 下模块。

## 排序与依赖

```
T1 ─┐
T2 ─┴─ Phase 1（独立，最先）
T3、T4 独立可并行
T6 → T8（共享 mtime 机制）
T5、T7 独立
```

建议一轮只做 Phase 1 + T3/T4，验证后再排后续；避免一轮塞太多导致回归面失控。

## 明确不做 / 降级

- PDF 导出：后置，等真实用户需求。
- Mermaid/公式的就地块编辑器（InkNote widgets 级）：工程量大，当前渲染已够用。
- 对齐 InkNote 的所有功能清单：翻译阅读器是我们的定位，功能对齐服务于定位而非清单本身。
