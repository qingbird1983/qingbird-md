# 界面统一与设置扩展（12 条）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按用户 2026-09-24 提出的 12 条需求，统一阅读区/大纲/胶囊按钮视觉，扩展设置面板（常规分类、关闭行为、开机自启、截图翻译、一键恢复默认），并修复最近打开与「打开文件位置」两个 bug。

**Architecture:** Tauri 2 + React 19 + zustand 前端（`src/`），Rust 后端（`src-tauri/`）。阅读区样式单一来源 `src/styles/markdown.css`；设置持久化真源是 `src-tauri/src/storage.rs` 的 `Settings`（整包 serde，新字段必须 `#[serde(default = ...)]` 且同步登记到 `src/types/ipc.ts`，否则整包 save 会静默丢字段）。

**Tech Stack:** React/TS + vitest（node/happy-dom）、CSS 守卫测试（读源码断言）、Rust cargo test、Tauri invoke。

## 需求 → 任务对照

| 用户条目 | 任务 |
|---|---|
| 9 最近打开达上限不滚动 | Task 1 |
| 8 打开文件位置开错目录 | Task 2 |
| 12 斜置图标改正 | Task 3 |
| 1 表格圆角统一代码块 | Task 4 |
| 3 层级引线同色、上不出头 | Task 5 |
| 2 正文标题折叠三角（出字列/空心/hover 触发区） | Task 6 |
| 4 大纲 H1/H2 左对齐 + hover 空心三角 | Task 7 |
| 11 设置面板新增「常规」分类，迁入正文宽度/列表/导出重排版 | Task 8 |
| 6 全站胶囊按钮统一滑动动效 | Task 9 |
| 10 开机自启 + 截图翻译开关 | Task 10 |
| 5 关闭时询问（退出/托盘）+ 记忆 + 设置项 | Task 11 |
| 7 设置面板左下角一键恢复全局默认 | Task 12 |

## Global Constraints

- 全程在 feature 分支 `feat/ui-batch-2026-09-24` 上提交（用户既定工作方式：实施计划走 feature 分支）。
- 行数预算红线（CLAUDE.md + `src/lib/codeSizeBudget.test.ts`）：生产文件 ≤400 行、CSS ≤800 行；`GRANDFATHERED` 快照**只许收紧不许放松**——SettingsModal.tsx 冻结在 455，任何净增行都判红，先减后加。
- 所有面向用户的文案用中文。
- `Settings` 新字段三件套：Rust `#[serde(default = "...")]` + `Default` impl + `src/types/ipc.ts` 类型登记；并同步 3 份测试夹具的字面量（`SettingsModal.test.tsx:87` 附近、`useDocStore.direction.test.ts:66` 附近、`useTranslationStore.inflightStop.test.ts:55` 附近）。
- 每任务收尾四道门：`npx vitest run`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml`（纯前端任务可跳过 cargo）、真机/浏览器肉眼验收（UI 类条目）。
- 提交信息风格照 `git log`：`feat(ui): ...` / `fix(...): ...`，中文描述。

## 开工前

- [ ] **Step 0: 建分支**

```bash
git status
git checkout -b feat/ui-batch-2026-09-24
```

若 `git status` 有未提交改动，先停下问用户，不要混车。

---

### Task 1: 最近打开——重开已开标签也置顶滚动（需求 9）

**Files:**
- Modify: `src/stores/useDocStore.ts:74-79`（openTab 的 existing 提前返回分支）
- Test: `src/stores/useRecentStore.rollOnReclick.test.ts`（新建，mock 头照抄 `src/stores/useDocStore.direction.test.ts` 顶部的 `vi.mock("../lib/ipc", ...)` 结构与环境设置）

**Interfaces:**
- Produces: 行为——任何一次「按路径打开」（含命中已开标签）都调 `useRecentStore.push(path, name)`。`push` 本身已正确（头插去重 + `slice(0, RECENT_MAX)`），不改。

- [ ] **Step 1: 写失败测试**

```ts
// 达上限后列表冻结的根因回归测试：命中已开标签的「再打开」也必须登记最近打开。
import { describe, expect, it } from "vitest";

describe("最近打开滚动登记", () => {
  it("重新打开已开标签：条目置顶且列表仍 ≤ RECENT_MAX", async () => {
    const { useDocStore } = await import("./useDocStore");
    const { useRecentStore, RECENT_MAX } = await import("./useRecentStore");
    for (let i = 0; i < RECENT_MAX; i++) await useDocStore.getState().openTab(`C:/d/f${i}.md`);
    for (let i = 0; i < RECENT_MAX; i++) await useDocStore.getState().openTab(`C:/d/g${i}.md`);
    expect(useRecentStore.getState().items.length).toBe(RECENT_MAX);
    expect(useRecentStore.getState().items[0]!.path).toBe("C:/d/g9.md");
    // 点第 0 个（它一直在标签页里 open 过 → 命中 existing 分支）：应滚回置顶
    await useDocStore.getState().openTab("C:/d/f0.md");
    expect(useRecentStore.getState().items[0]!.path).toBe("C:/d/f0.md");
    expect(useRecentStore.getState().items.length).toBe(RECENT_MAX);
  });
});
```

注：`openTab` 失败只 toast 不抛错；mock 的 `openFile` 返回值形状照 `useDocStore.direction.test.ts` 里现成的 mock（`{ name, content, mtime, encoding, parse }`）。文件路径唯一即新建 tab，RECENT_MAX=10 时共 21 个 tab，无碍。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/useRecentStore.rollOnReclick.test.ts`
Expected: FAIL —— `items[0].path` 仍是 `C:/d/g9.md`（existing 分支没 push）。

- [ ] **Step 3: 实现**

`src/stores/useDocStore.ts` L75-79 改为：

```ts
const existing = get().tabs.find((t) => t.path === path);
if (existing) {
  get().switchTab(existing.id);
  // 命中已开标签同样算「一次打开」：最近打开必须跟着滚动置顶
  // （修 2026-09-24「达上限后列表冻结」——启动恢复后文件常年开着，
  //  旧代码在此 return，L104 的 push 永远够不到）。
  useRecentStore.getState().push(existing.path, existing.name);
  return;
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/stores/useRecentStore.rollOnReclick.test.ts` → PASS；再 `npx vitest run` 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/stores/useDocStore.ts src/stores/useRecentStore.rollOnReclick.test.ts
git commit -m "fix(recent): 重开已开标签也登记最近打开——修达上限后列表冻结"
```

---

### Task 2: 「打开文件位置」explorer 转义修复（需求 8）

**Files:**
- Modify: `src-tauri/src/commands/workspace_ops.rs:113-129`（`reveal_path`）

**Interfaces:**
- Produces: `pub(crate) fn reveal_select_arg(path: &str) -> String`（纯函数，单测对象）；前端调用链（`useTreeMenus.tsx` 传 `r.path`、`ipc.ts:71`）已核实无误，不动。

- [ ] **Step 1: 写失败测试**（Rust 内联 `#[cfg(test)] mod tests`，追加到 workspace_ops.rs）

```rust
#[cfg(test)]
mod tests {
    use super::reveal_select_arg;

    #[test]
    fn select_arg_keeps_verbatim_quoting_for_explorer() {
        // explorer 自己解析原始命令行：必须是 /select,"<path>" 这个裸形态。
        // 旧实现交给 std 的 MSVCRT 转义（含空格参数被整枚再包一层引号、内引号变 \"），
        // explorer 解析失败 → 打开默认位置而不是文件所在目录（2026-09-24 用户报障）。
        assert_eq!(
            reveal_select_arg(r#"C:\我的 文档\a.md"#),
            r#"/select,"C:\我的 文档\a.md""#
        );
        assert_eq!(reveal_select_arg(r"C:\d\b.md"), r#"/select,"C:\d\b.md""#);
    }
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml reveal_select_arg`
Expected: 编译错误 `cannot find function reveal_select_arg`。

- [ ] **Step 3: 实现**

`reveal_path` 的 `else` 分支（文件）改为 raw_arg 直发；新增纯函数。先读现文件确认现有错误处理/日志写法，保持同构：

```rust
use std::os::windows::process::CommandExt; // 与现有 fn 同层级 import 亦可，就近即可

/// 给 explorer 的「选中文件」原始参数：`/select,"<完整路径>"`。
/// 必须经 `CommandExt::raw_arg` 原样写进命令行——std 默认转义会给这枚
/// 含空格+引号的参数再包一层壳，explorer 就解析不出目标了。
pub(crate) fn reveal_select_arg(path: &str) -> String {
    format!("/select,\"{path}\"")
}
```

```rust
if p.is_dir() {
    cmd.arg(&path);
} else {
    cmd.raw_arg(reveal_select_arg(&path));
}
```

（`Command::new("explorer")` 顺带改为 `Command::new("explorer.exe")`。）

- [ ] **Step 4: 跑测试 + 真机冒烟**

Run: `cargo test --manifest-path src-tauri/Cargo.toml reveal_select_arg` → PASS。
真机：`npm run tauri dev`，左栏最近打开里对一个路径**含空格**的文件右键「打开文件位置」，资源管理器须打开其所在目录且**高亮选中该文件**。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workspace_ops.rs
git commit -m "fix(reveal): explorer /select 改 raw_arg 原样传参——修含空格路径开错位置"
```

---

### Task 3: 斜置图标全部摆正（需求 12）

**Files:**
- Modify: `src/styles/01-titlebar.css:97,116`
- Modify: `src/styles/07-taskcard.css:78,85,88`
- Modify: `src/styles/10-settings.css:562`

**Interfaces:** 纯 CSS，无生产方。

- [ ] **Step 1: 先读三处的上下文块**（L90-120 / L70-95 / L555-565），确认 rotate 是「静态斜置 + hover 归正/微转」的装饰动效。

- [ ] **Step 2: 去斜置**

规则：所有 `transform: rotate(-3deg)` / `rotate(-1deg)` 的**静态**声明删掉 rotate 分量（无其它分量则删整条声明）；hover 态里 `rotate(0deg)` 随之删掉，**保留** scale 等非旋转分量不动。已知落点：
- 01-titlebar.css:97 静态 `rotate(-3deg)` → 删；:116 hover `rotate(0deg) scale(0.85)` → 只留 `scale(0.85)`。
- 07-taskcard.css:78/85 静态 `rotate(-3deg)` → 删；:88 hover `rotate(-1deg) scale(1.06)` → 只留 `scale(1.06)`。
- 10-settings.css:562 `.pal-preview .seal` 的 `transform: rotate(-3deg)` → 删整条 transform。
若相邻 `transition: transform ...` 因再无 transform 分量而纯装饰，可保留不动（无害），不引发额外改动。

- [ ] **Step 3: 肉眼验收 + Commit**

`npm run build` 通过；dev 里看标题栏印章、任务卡印章、设置配色小样三处印均为正。

```bash
git add src/styles/01-titlebar.css src/styles/07-taskcard.css src/styles/10-settings.css
git commit -m "style(icon): 全局印章/徽标去斜置——静态 rotate 全摆正"
```

---

### Task 4: 表格圆角统一代码卡片（需求 1）

**Files:**
- Modify: `src/styles/markdown.css:492-519`（表格段）
- 视需要: `src/styles/markdown.css:627-654`（`.front-matter` 表，读后同构处理）

**Interfaces:** 表格 DOM 无外层 wrapper（`src-tauri/src/markdown/html.rs:222-254` 裸 `<table>`），故圆角全靠 CSS 实现，**不改 Rust**。基准：代码卡片 `border-radius: 10px`（markdown.css:351-357）。

- [ ] **Step 1: 改表格规则**

L492-505 替换为（斑马纹 L512-514 与 hover L517-519 不动）：

```css
.markdown-body table {
  /* 圆角与代码卡片同款 10px。border-collapse: collapse 下圆角不生效（边框合并
     绘制），故换 separate + 零间距：外框画在 table 上（整圈圆角），
     单元格只画右/下内分隔线，末列末行收口，overflow 裁掉四角背景溢出。 */
  width: 100%;
  margin: 1.1em 0;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--md-border);
  border-radius: 10px;
  overflow: hidden;
}

.markdown-body th,
.markdown-body td {
  padding: 8px 14px;
  border: none;
  border-right: 1px solid var(--md-border);
  border-bottom: 1px solid var(--md-border);
  text-align: left;
}

.markdown-body th:last-child,
.markdown-body td:last-child {
  border-right: none;
}

.markdown-body tbody tr:last-child td,
.markdown-body table > thead:last-child tr:last-child th {
  border-bottom: none;
}
```

（`> thead:last-child` = 「无 tbody 的病态表」兜底；常规表 thead 后必有 tbody，此分支不命中，表头分隔线由单元格的 border-bottom 保留。）

- [ ] **Step 2: 核对 `.front-matter` 表**（L627-654）：若它自带 `border-collapse: collapse` + 全边框，套用同款（separate/零间距/外框圆角/单元格右+下分隔），保留其原有 padding/字号差异；若它是无边框简化样式则不动。

- [ ] **Step 3: 验收 + Commit**

`npx vitest run`（`listGuide.test.ts` 会重扫 markdown.css，确认未误伤）；dev 里看常规表格、含代码卡同屏表格四角圆弧与代码块一致、斑马纹不溢出圆角、表头分隔线在。

```bash
git add src/styles/markdown.css
git commit -m "style(table): 表格圆角统一代码卡片 10px——collapse 改 separate+外框裁圆"
```

---

### Task 5: 层级引线同圆点色、线头收在首点圆心（需求 3）

**Files:**
- Modify: `src/styles/markdown.css:303-317`（引线规则）
- Test: `src/lib/listGuide.test.ts`（新增断言组）

**Interfaces:** 圆点：`::before`，`top: 1em`（首行行盒中心）、`background: currentColor`（markdown.css:225-236）。引线现 `top: 0`（出头）+ `var(--md-border)`（比点淡）。守卫测试的 `bodyOf`/`GUIDE_LI` 常量已存在，直接复用。

- [ ] **Step 1: 写失败测试**（listGuide.test.ts 里 `describe` 内追加）

```ts
it("引线同色同墨：与圆点同为 currentColor，且首项线头挂在自己圆心", () => {
  const guide = bodyOf(GUIDE);
  expect(guide, "线必须与圆点同一枚墨色（currentColor），否则灰淡脱节").toContain(
    "background: currentColor",
  );
  const first = bodyOf(`${GUIDE_LI}:first-child::after`);
  expect(first, "首项线头必须从自己圆点圆心（top: 1em，与 ::before 同值）起笔，不出头").toContain(
    "top: 1em",
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/listGuide.test.ts` → FAIL（现值是 `var(--md-border)` / 缺 first-child 规则）。

- [ ] **Step 3: 改 CSS**

L303-312 的 `background: var(--md-border);` → `background: currentColor;`；L314-317 之后新增：

```css
/* 首项的线从自己圆点圆心起笔（1em = ::before 圆点的 top 值，行盒中心，
   两者改动必须同值），不再向上出头压过点。 */
.markdown-body:not(.no-list-guide) ul > li:not(.task):first-child::after {
  top: 1em;
}
```

同时更新 L285-302 注释块里 ④ 的措辞（同色 + 首项圆心起笔）。

- [ ] **Step 4: 跑测试 + 肉眼验收 + Commit**

`npx vitest run` 全绿；dev 里看多级列表：线与点同墨色、列表顶端无出头、底部止于末点。

```bash
git add src/styles/markdown.css src/lib/listGuide.test.ts
git commit -m "style(list): 层级引线同圆点墨色、首项线头收在圆心"
```

---

### Task 6: 正文标题折叠三角——出字列、空心、hover 触发区（需求 2）

**Files:**
- Modify: `src/lib/previewInject.ts:78-104`（addHeadingToggles）
- Modify: `src/styles/markdown.css:473-488`（.h-toggle）+ 标题规则块 L81-91

**Interfaces:**
- Produces: caret 仍为 `h1` 前置 `<button class="h-toggle">`，内含空心 SVG；折叠态标记改为 caret 上的 `is-collapsed` 类（`h-collapsed` 保留在标题上，语义不变）。`exportHtml.ts:65` 的 `remove(".h-toggle")` 不受影响。触发区宽 36px 恰好落在 `.markdown-body` 左内边距 36px（L49 `padding: 28px 36px 180px`）内，不溢出裁切。

- [ ] **Step 1: 改 previewInject.ts**

L86 `caret.textContent = "▼";` → 

```ts
// 空心 V 形 chevron：stroke 描边、不填充（用户要求「换空心小三角」）。
caret.innerHTML =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M2.8 4.6 6 8.1l3.2-3.5" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
```

L91 `caret.textContent = collapsed ? "▶" : "▼";` → 

```ts
caret.classList.toggle("is-collapsed", collapsed);
```

- [ ] **Step 2: 改 CSS**

L473-488 整块（`.h-toggle` 及 hover）替换为：

```css
/* 标题需要定位上下文，让折叠触发区悬到正文文字之外的左侧留白里 */
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 { position: relative; }

/* 折叠触发区：整条 36px 宽的透明带悬在 .markdown-body 左内边距里（文字左对齐
   不受它影响）。默认不可见但可命中（opacity:0 仍收 :hover），鼠标进入触发区才显示。 */
.markdown-body .h-toggle {
  position: absolute;
  left: -36px;
  top: 0;
  height: 1.4em; /* = 标题单行行高（line-height:1.4），图标在其中垂直居中 */
  width: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px 0 0;
  margin: 0;
  border: none;
  background: none;
  color: var(--md-muted);
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s, color 0.14s;
}

.markdown-body .h-toggle:hover {
  opacity: 1;
  color: var(--md-fg);
}

.markdown-body .h-toggle svg {
  transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}

.markdown-body .h-toggle.is-collapsed svg {
  transform: rotate(-90deg);
}
```

- [ ] **Step 3: 验收 + Commit**

`npx vitest run` 全绿（无既有断言钉 `▼` 文本，若 `SettingsModal.test`/快照类有命中则同步更新）；dev：h1/h2 与正文严格左对齐、鼠标移到标题左缘空白天区域三角才淡入、点开折叠生效（箭头转 90°）、再点恢复；导出 HTML 无 caret。

```bash
git add src/lib/previewInject.ts src/styles/markdown.css
git commit -m "feat(ui): 正文标题折叠三角移到文字外触发区——空心、hover 才显形"
```

---

### Task 7: 大纲栏 H1/H2 左对齐、三级起缩进、hover 空心三角（需求 4）

**Files:**
- Modify: `src/components/OutlinePanel.tsx:158,177-179`
- Modify: `src/styles/05-panels.css:308-329`

**Interfaces:** `.outline-toggle` 仅在有子级项渲染（不变）；`is-collapsed` 旋转规则（05-panels.css:327-329）不变，空心 SVG 基础朝向为「下=展开」，与现有 rotate(-90deg)=折叠一致。

- [ ] **Step 1: 缩进公式**（OutlinePanel.tsx:158）

```tsx
style={{ paddingLeft: 8 + Math.max(0, item.level - 2) * 13 }}
```

（H1/H2 同值 8 = 左对齐；H3 起每级 +13px。）

- [ ] **Step 2: 三角换空心**（OutlinePanel.tsx:177-179）

```tsx
<svg viewBox="0 0 8 8" width="9" height="9" aria-hidden="true">
  <path d="M1.9 2.7 4 5.1 6.1 2.7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
</svg>
```

- [ ] **Step 3: hover 触发区显形**（05-panels.css，`.outline-toggle` 块 L308-323 内改/追加）

```css
.outline-toggle {
  /* 原属性保留，另加/改这几条：触发区放大到 16×16，负 margin 抵掉 flex gap，
     文字位置不随三角显隐跳动 */
  width: 16px;
  height: 16px;
  margin-right: -5px;
  opacity: 0; /* 默认隐藏但可命中 hover（同正文 caret 的口径） */
  transition: opacity 0.14s, background 0.14s, color 0.14s;
}
.outline-toggle:hover {
  opacity: 1;
  background: var(--item-hover-bg);
  color: var(--fg);
}
```

（删除原 `.outline-toggle:hover` 与新规则合并，避免双 hover 块漂移。`.outline-item` 的 `gap: 6px` 不动。）

- [ ] **Step 4: 验收 + Commit**

`npx vitest run` 全绿；dev：大纲 H1/H2 平齐、H3+ 逐级缩进、鼠标滑到条目左缘小空位三角淡入、点击折叠/展开正常、折叠态三角朝右。

```bash
git add src/components/OutlinePanel.tsx src/styles/05-panels.css
git commit -m "feat(outline): H1/H2 左对齐三级起缩进、折叠三角空心且 hover 显形"
```

---

### Task 8: 设置面板新增「常规」分类，迁入正文宽度/列表/导出重排版（需求 11）

**Files:**
- Create: `src/components/settings/SettingsParts.tsx`（自 SettingsModal 迁出 `Bar` + `SwitchRow`）
- Create: `src/components/settings/GeneralTab.tsx`
- Modify: `src/components/SettingsModal.tsx`（CATS/CatId/渲染/import；**必须先减后加**）
- Modify: `src/components/settings/LookTab.tsx`（删正文宽度 L147-179、列表 L180-188 两 section 及相应 props）
- Modify: `src/components/settings/TranslateTab.tsx`（删「导出时重排版」SwitchRow L351-358，划词翻译留在原处）
- Test: `src/lib/listGuide.test.ts:103-108`（改读 GeneralTab.tsx）；`src/lib/codeSizeBudget.test.ts`（按提示收紧快照）

**Interfaces:**
- Produces: `SettingsParts.tsx` 导出 `Bar`、`SwitchRow`（签名原样，仅换出处；全库 `from "../SettingsModal"` 的 import 一并改）；`GeneralTab`（无 props，store 自取——与 LookTab 里 listGuide 的「绕开冻结」先例同构）。`CatId` 新增值 `"general"`，`CATS` 首位为 general。

- [ ] **Step 1: 迁出公共件**

`Bar`（SettingsModal.tsx L390-419）与 `SwitchRow`（L421-455）整段搬进新文件 `SettingsParts.tsx`（文件头一行注释说明出处），SettingsModal 改为 `import { Bar, SwitchRow } from "./settings/SettingsParts";`，LookTab/TranslateTab 的 `import { SwitchRow } from "../SettingsModal"` → `"./SettingsParts"`。

- [ ] **Step 2: 建 GeneralTab.tsx**

```tsx
// 设置面板「常规」页：启动/正文/列表/导出等杂项偏好，全部「点即生效」，
// 不进草稿。正文宽度与层级引线自「外观」迁入（2026-09-24 用户分类重整），
// 导出时重排版自「翻译与模型」迁入并改点即生效。
import { Info } from "lucide-react";
import { CONTENT_WIDTHS, CONTENT_WIDTH_LABEL, useUiStore } from "../../stores/useUiStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { SwitchRow } from "./SettingsParts";

export default function GeneralTab() {
  const contentWidth = useUiStore((s) => s.contentWidth);
  const customWidth = useUiStore((s) => s.customWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);
  const listGuide = useUiStore((s) => s.listGuide);
  const setListGuide = useUiStore((s) => s.setListGuide);
  const relayout = useSettingsStore((s) => s.settings?.relayout_on_export ?? true);
  const setRelayout = (v: boolean) => {
    const cur = useSettingsStore.getState().settings;
    if (cur) void useSettingsStore.getState().save({ ...cur, relayout_on_export: v });
  };

  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">正文宽度</h3>
        <p className="set-sec-desc">预览区正文列的宽度。也可以直接拖预览区的边缘自由调宽。</p>
        <div className="setseg">
          {CONTENT_WIDTHS.map((w) => (
            <button key={w} type="button"
              className={customWidth === null && contentWidth === w ? "on" : ""}
              onClick={() => setContentWidth(w)}>
              {CONTENT_WIDTH_LABEL[w]}
            </button>
          ))}
        </div>
        {customWidth !== null && (
          <div className="set-hint">
            <Info size={13} />
            <span>
              当前是拖拽得到的自由宽度 {customWidth}px。
              <button type="button" className="set-link" onClick={() => setContentWidth(contentWidth)}>
                恢复为「{CONTENT_WIDTH_LABEL[contentWidth]}」档
              </button>
            </span>
          </div>
        )}
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">列表</h3>
        <SwitchRow label="层级引线"
          desc="给多级列表画出层级竖线，同级圆点串成一根发丝细的线，嵌套关系一眼可见。关掉即恢复无竖线的列表。"
          checked={listGuide} onChange={setListGuide} />
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">导出</h3>
        <SwitchRow label="导出时重排版"
          desc="另存为 .md 时对译文施加确定性排版：中英间距、标点全/半角、省略号、破折号。只影响导出文件，不改屏幕上的译文。"
          checked={relayout} onChange={setRelayout} />
      </section>
    </>
  );
}
```

- [ ] **Step 3: 接线 SettingsModal（先减后加）**

Step 1 已净减 ~60 行；现在：`CatId` 加 `"general"`；`CATS` 数组**最前**插：

```ts
{
  id: "general",
  label: "常规",
  icon: SlidersHorizontal,
  keys: ["常规", "正文宽度", "宽度", "列表", "引线", "导出", "重排", "开机自启", "截图", "关闭", "托盘"],
},
```

（`SlidersHorizontal` 从 lucide-react import；"正文宽度/宽度"两键从 look 的 keys 挪过来。）`useState<CatId>("look")` → `("general")`；pane 区加 `{activeCat === "general" && <GeneralTab />}`；LookTab 调用处删 `contentWidth/customWidth/setContentWidth` 三个 prop（其订阅挪进 GeneralTab）。

- [ ] **Step 4: LookTab/TranslateTab 收尾**

LookTab：删两 section + props 接口三字段 + 未用 import（CONTENT_WIDTHS 系、Info）。TranslateTab：删导出重排版 SwitchRow（保留划词翻译），若 `draft.relayout_on_export` 不再被此文件引用则留着 `useSettingsDraft` 的字段本身——**不要动** Rust/类型的这个字段，它仍由 GeneralTab 读写。

- [ ] **Step 5: 跑守卫测试并按提示收快照**

`npx vitest run src/lib/listGuide.test.ts src/lib/codeSizeBudget.test.ts src/components/SettingsModal.test.tsx`。
- listGuide.test.ts L104 的 `read("../components/settings/LookTab.tsx")` → `read("../components/settings/GeneralTab.tsx")`。
- codeSizeBudget 若提示 SettingsModal 已回线内 → 按提示删/调 `GRANDFATHERED` 条目；若仍超但变小 → 把快照数字改小。
- SettingsModal.test.tsx 若断言「明暗页含正文宽度」→ 按新分类改断言。

- [ ] **Step 6: 全绿 + 验收 + Commit**

`npx vitest run && npm run build`；dev 打开设置：左导航第一项「常规」，含正文宽度/列表/导出时重排版三节；外观页只剩明暗+配色；翻译页不再有导出重排版；搜索「正文宽度」能导航到常规页。

```bash
git add -A src/components src/lib
git commit -m "refactor(settings): 新增「常规」大分类，正文宽度/列表引线/导出重排版迁入"
```

---

### Task 9: 全站胶囊按钮统一滑动动效（需求 6）

**Files:**
- Create: `src/components/ui/Seg.tsx`
- Modify: `src/styles/10-settings.css:451-504`、`src/styles/03-toolbar.css:97-145`
- Modify: `src/components/EditorToolbar.tsx:180-194`、`src/components/settings/LookTab.tsx`（明暗 + 配色预览档）、`src/components/settings/GeneralTab.tsx`（正文宽度）、`src/components/settings/TranslateTab.tsx:114-125,133-144,151-164`（方向/分组/协议）

**Interfaces:**
- Produces: `Seg<T extends string>`（见 Step 1 完整实现）。容器沿用既有类（`viewseg` / `setseg` / `setseg sm`）以继承视觉，另加 `seg` 类挂滑块。选中钮不再自绘底色——由 `.seg-thumb` 浮层承载并位移动画（统一 `0.22s`，与 `--ease` 缓动）。
- 已知特例两条，照录不脑补：正文宽度在 `customWidth !== null` 时**无选中态**（传哨兵值）；接口协议胶囊本就是**静态展示**（supported=on、无 onClick），迁移后行为一致。

- [ ] **Step 1: 写 Seg.tsx**

```tsx
// 全站统一的胶囊分段控件：选中项由一枚浮层「滑块」承载，横移+变宽走同一动效。
// 容器类名沿用各挂载点的既有皮肤（viewseg / setseg / setseg sm），
// 样式只多一条 .seg + .seg-thumb（10-settings.css），杜绝两套动效漂移（2026-09-24 需求）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** 禁用占位小尾巴（如「暂未支持」），仅 setseg 皮肤用得到该样式 */
  tag?: string;
  title?: string;
}

export function Seg<T extends string>(props: {
  options: readonly SegOption<T>[];
  value: T;
  onChange?: (v: T) => void;
  variant: "viewseg" | "setseg" | "setseg sm";
  ariaLabel?: string;
}) {
  const { options, value, onChange, variant, ariaLabel } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const btns = useRef(new Map<T, HTMLButtonElement | null>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = btns.current.get(value);
    const box = wrap.current;
    if (el && box) setThumb({ x: el.offsetLeft - box.clientLeft, w: el.offsetWidth });
    else setThumb(null);
    // options 入依赖：文案/条数变化后重测（value 不变时也保准确）
  }, [value, options]);

  useEffect(() => {
    const onResize = () => {
      const el = btns.current.get(value);
      const box = wrap.current;
      if (el && box) setThumb({ x: el.offsetLeft - box.clientLeft, w: el.offsetWidth });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [value, options]);

  // 首帧无过渡（防止滑块从 0 滑入的穿帮），量完下一拍才允许动画
  useEffect(() => {
    if (!ready && thumb) requestAnimationFrame(() => setReady(true));
  }, [thumb, ready]);

  return (
    <div ref={wrap} className={`seg ${variant}`} role="group" aria-label={ariaLabel}>
      <span
        aria-hidden
        className={`seg-thumb${ready ? " seg-ready" : ""}`}
        style={thumb ? { transform: `translateX(${thumb.x}px)`, width: thumb.w } : { opacity: 0 }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          title={o.title ?? o.label}
          ref={(el) => { btns.current.set(o.value, el); }}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
          {o.tag && <span className="setseg-tag">{o.tag}</span>}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: CSS**

10-settings.css `.setseg` 区（L451-504）内：`.setseg` 与 `.setseg.sm` 规则各补 `position: relative;`，`.setseg button` 补 `position: relative; z-index: 1;`；`.setseg button.on`（L475-480）删去 `background`、`box-shadow` 两行（底色/阴影由滑块承载），保留 color/font-weight。03-toolbar.css 同步：`.editor-toolbar .viewseg` 补 `position: relative;`，其 `button` 补 `position: relative; z-index: 1;`，`.viewseg button.on`（L135-140）删 `background`、`box-shadow`。追加公共滑块样式：

```css
/* 统一胶囊滑块（Seg 组件配套，2026-09-24）：皮肤容器带 .seg 即生效 */
.seg { position: relative; }
.seg button { position: relative; z-index: 1; }
.seg-thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  z-index: 0;
  border-radius: var(--r-pill);
  background: var(--surface);
  box-shadow: var(--shadow-xs);
  pointer-events: none;
  opacity: 1;
}
.seg-thumb.seg-ready {
  transition: transform 0.22s var(--ease), width 0.22s var(--ease), opacity 0.14s;
}
```

（若 `--ease` 变量实际定义在别处名不同，以 theme.css 现名对齐——03-toolbar.css L121 已在用 `var(--ease)`，可直接引用。）

- [ ] **Step 3: 六处迁移**

1. EditorToolbar L181-194 整块 → 
```tsx
<Seg variant="viewseg" ariaLabel="视图" value={view}
  onChange={(v) => void switchView(v)}
  options={[
    { value: "source", label: "源码", title: "源码视图" },
    { value: "split", label: "分栏", title: "分栏视图" },
    { value: "preview", label: "预览", title: "预览视图" },
  ]}
/>
```
2. LookTab 明暗 L57-68 → `<Seg variant="setseg" ariaLabel="明暗" value={theme} onChange={setTheme} options={THEME_OPTIONS.map(([v, label]) => ({ value: v, label }))} />`
3. LookTab 配色预览 L77-92 → `<Seg variant="setseg sm" value={pvMode} onChange={setPvMode} options={[{value:"light",label:"浅色预览"},{value:"dark",label:"深色预览"}]} />`（T 泛型推 `"light"|"dark"`，与 setPvMode 签名一致）
4. GeneralTab 正文宽度 → `<Seg variant="setseg" ariaLabel="正文宽度" value={(customWidth === null ? contentWidth : "") as ContentWidth} onChange={(w) => setContentWidth(w)} options={CONTENT_WIDTHS.map((w) => ({ value: w, label: CONTENT_WIDTH_LABEL[w] }))} />`（空串哨兵匹配不到任何按钮 → 滑块隐藏，语义同旧「无 .on」）
5. TranslateTab 翻译方向 L114-125 → `<Seg variant="setseg" ariaLabel="翻译方向" value={translateTarget} onChange={(v) => void useDocStore.getState().setTranslateTarget(v)} options={TARGET_OPTIONS.map(([v, label]) => ({ value: v, label }))} />`
6. TranslateTab 分组 L133-144 → `<Seg variant="setseg" value={grp} onChange={changeGroup} options={PROV_GROUPS.map(([g, label]) => ({ value: g, label }))} />`；协议 L151-164 → `<Seg variant="setseg" ariaLabel="接口协议" value={(LLM_PROTOCOLS.find((p) => p.supported)?.id ?? "") as string} options={LLM_PROTOCOLS.map((p) => ({ value: p.id, label: p.label, disabled: !p.supported, tag: p.supported ? undefined : "暂未支持", title: p.supported ? undefined : "暂未支持，后续版本再考虑" }))} />`（无 onChange，维持静态展示语义）。若 `LLM_PROTOCOLS` 元组形状与此不合，读 `TranslateTab.tsx:20-23` 定义后按同语义映射，**不改数据**。

- [ ] **Step 4: 验收 + Commit**

`npx vitest run && npm run build`；dev 逐处点：工具栏三态、明暗三态、配色预览两档、正文宽度四档、翻译方向、翻译源分组、协议（不可点、无滑块错位）——选中块均为**滑过去**且首开面板不从 0 穿帮；拖窗口宽后胶囊仍对齐（resize 重测）。

```bash
git add src/components src/styles
git commit -m "feat(ui): 胶囊选中统一滑动动效——Seg 滑块组件收编全站六处分段控件"
```

---

### Task 10: 开机自启 + 截图翻译开关（需求 10）

**Files:**
- Modify: `src-tauri/src/storage.rs`（`capture_enabled` 字段）
- Modify: `src-tauri/src/hotkeys.rs:60`（注册门控）
- Modify: `src-tauri/src/tray.rs:37`（菜单触发门控）
- Modify: `src-tauri/src/commands/settings.rs`（`set_autostart` 命令）+ `window_boot.rs` invoke_handler 注册处（L201 一带，与 `reveal_path` 同列表）
- Modify: `src/types/ipc.ts`、`src/lib/ipc.ts`、`src/components/settings/GeneralTab.tsx`、三份 Settings 测试夹具

**Interfaces:**
- Produces: `Settings.capture_enabled: bool`（serde default = true）；IPC `set_autostart(enabled: bool)`。autostart 字段/启动 apply 已存在（storage.rs:85-87），本任务只加 UI 入口。托盘勾选态与设置面板在**本次会话内**可能短暂不同步（托盘 CheckMenuItem 构造时读盘），下次启动收敛——已接受，勿为此加状态管理。

- [ ] **Step 1: Rust 字段 + 测试**

storage.rs `Settings`（`relayout_on_export` 之后）加：

```rust
/// 截图翻译总开关。关 = 全局热键不注册、托盘菜单不触发（hotkeys.rs / tray.rs 双门控）。
/// `#[serde(default = "default_true")]` = 老配置文件读出来即「开」，升级零感知。
#[serde(default = "default_true")]
pub capture_enabled: bool,
```

`Default` impl 加 `capture_enabled: true,`。既有测试 `capture_hotkey_defaults_added_when_missing`（L402-415）里 `s2` 断言旁追加：`assert!(s2.capture_enabled);`（老配置缺字段 → true）。

- [ ] **Step 2: 双门控**

hotkeys.rs L58-75 的 capture 注册段整体包进 `if settings.capture_enabled { ... }`；tray.rs `on_menu_event` 的 `"capture" => trigger_capture(app),` → 

```rust
"capture" => {
    if storage::load_settings().capture_enabled {
        trigger_capture(app);
    }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS。

- [ ] **Step 3: set_autostart 命令**

commands/settings.rs 加（注册进 window_boot.rs 的 `generate_handler!` 列表）：

```rust
/// 设置面板「开机自启」开关：apply 到 autostart 插件 + 落盘（插件为即时权威，
/// settings.autostart 为持久化权威——与 tray.rs::toggle_autostart 同口径，
/// 只是触发方从托盘菜单换成前端）。
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    let mut s = storage::load_settings();
    s.autostart = enabled;
    storage::save_settings(&s)
}
```

- [ ] **Step 4: 前端接线**

`types/ipc.ts` Settings 加 `capture_enabled: boolean;`（注释同 autostart 的「整包 save 必须登记」告诫）；`lib/ipc.ts` api 加 `setAutostart: (enabled: boolean) => invoke("set_autostart", { enabled }),`。GeneralTab **最前**加一节：

```tsx
<section className="set-sec">
  <h3 className="set-sec-title">启动与截图</h3>
  <SwitchRow label="开机自启"
    desc="登录后自动启动青鸟。关闭后随系统登录不再拉起（托盘菜单里的同名勾选项与此同源）。"
    checked={autostart} onChange={(v) => void setAutostart(v)} />
  <SwitchRow label="截图翻译"
    desc="全局截图翻译的总开关。关闭后：截图热键不再响应、托盘菜单「截图翻译」不再触发；快捷键录制与翻译配置不受影响。"
    checked={captureOn}
    onChange={(v) => { const cur = useSettingsStore.getState().settings;
      if (cur) void useSettingsStore.getState().save({ ...cur, capture_enabled: v }); }} />
</section>
```

组件顶部取数（autostart 走订阅，别 getState——不订阅就不重渲染）：

```tsx
const autostart = useSettingsStore((s) => s.settings?.autostart ?? false);
const captureOn = useSettingsStore((s) => s.settings?.capture_enabled ?? true);
const setAutostart = async (v: boolean) => {
  try { await api.setAutostart(v); }
  catch (e) { useUiStore.getState().addToast("error", `设置开机自启失败：${errText(e)}`); return; }
  const cur = useSettingsStore.getState().settings;
  if (cur) useSettingsStore.setState({ settings: { ...cur, autostart: v } });
};
```

（GeneralTab 需新增 import：`api`、`errText`。`capture_enabled` 的切换走 `save`，落盘后后端 `hotkeys::sync` 自动重注册——即时生效，无需额外命令。）

- [ ] **Step 5: 夹具 + 全绿 + 真机验收 + Commit**

三份测试夹具加 `capture_enabled: true`。`npx vitest run && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`。
真机：关「截图翻译」→ 按 Ctrl+Shift+X 无反应、托盘菜单点了无反应；开回 → 恢复。拨「开机自启」→ Windows 设置里登录项同步增减、重启应用后托盘勾选一致。

```bash
git add src-tauri/src src/types/ipc.ts src/lib/ipc.ts src/components/settings/GeneralTab.tsx src
git commit -m "feat(settings): 常规页新增开机自启与截图翻译总开关（热键/托盘双门控）"
```

---

### Task 11: 关闭时询问「退出/常驻托盘」+ 记忆选择 + 设置项（需求 5）

**Files:**
- Modify: `src-tauri/src/storage.rs`（`close_action`）
- Modify: `src-tauri/src/window_boot.rs:97-111`（钩子三分支 + 复用函数）
- Modify: `src-tauri/src/commands/settings.rs`（`apply_close_decision`）+ invoke_handler 注册
- Modify: `src/types/ipc.ts`、`src/lib/ipc.ts`、`src/stores/useUiStore.ts`（弹窗开关态）
- Create: `src/components/CloseAskDialog.tsx`；Modify: `src/App.tsx`（挂监听 + 渲染）、`GeneralTab.tsx`（关闭行为 Seg——用 Task 9 的 `Seg`）

**Interfaces:**
- Produces: `Settings.close_action: String`，合法值 `"ask"|"tray"|"exit"`，serde default `"ask"`；后端事件 `close-requested`（emit 给前端弹框）；IPC `apply_close_decision(decision: "tray"|"exit")`；`window_boot::{to_tray, quit_app}`（pub(crate)，供钩子与命令两处复用，tray.rs quit 分支不改）。前端 `useUiStore.closeAskOpen/setCloseAskOpen`。

- [ ] **Step 1: Rust 字段**

storage.rs：`default_ask()` + 字段（放 `capture_enabled` 后）：

```rust
/// 右上角「关闭」的行为：ask=每次询问（前端弹框）、tray=隐藏到托盘常驻、
/// exit=直接退出应用。default ask——升级后第一次关窗由用户自选并记忆。
#[serde(default = "default_ask")]
pub close_action: String,
```

`fn default_ask() -> String { "ask".to_string() }`；`Default` impl `close_action: "ask".to_string(),`；测试 `capture_hotkey_defaults_added_when_missing` 加 `assert_eq!(s2.close_action, "ask");`。

- [ ] **Step 2: 钩子三分支**（window_boot.rs L97-111 整函数替换）

```rust
pub(crate) fn hook_main_window_close(win: &tauri::WebviewWindow) {
    let h = win.app_handle().clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            match storage::load_settings().close_action.as_str() {
                "exit" => { api.prevent_close(); quit_app(&h); }
                "tray" => { api.prevent_close(); to_tray(&h); }
                // ask：拦下后转交前端弹框（CloseAskDialog），选择经
                // apply_close_decision 命令回到下面两个动作之一。
                _ => {
                    api.prevent_close();
                    let _ = tauri::Emitter::emit(&h, "close-requested", ());
                }
            }
        }
    });
}

/// 关闭=隐藏到托盘 + 排定休眠（原「spec §5」行为的唯一归宿；冷重建窗口重挂钩子后同样生效）。
pub(crate) fn to_tray(h: &tauri::AppHandle) {
    if let Some(w) = h.get_webview_window(hibernate::MAIN_LABEL) {
        let _ = w.hide();
    }
    hibernate::schedule(h);
}

/// 真退出：不保留休眠草稿（与托盘「退出」同口径——用户意图是结束）。
pub(crate) fn quit_app(h: &tauri::AppHandle) {
    let _ = hibernate::clear_snapshot();
    h.exit(0);
}
```

（若 window_boot.rs 顶部已 `use tauri::Emitter;` 则 `_ => { let _ = h.emit(...); }` 直接用；以现文件 import 现状为准。注意窗口销毁路径仍会触发本钩子？——`hibernate` 销毁 WebView 走的是窗口关闭事件之外的内部流程，现网行为不变，真机验证休眠链路。）

- [ ] **Step 3: 命令**（commands/settings.rs，注册进 generate_handler）

```rust
/// 关窗询问弹窗的回答：按选择执行「隐藏到托盘」或「退出应用」。
#[tauri::command]
pub fn apply_close_decision(app: AppHandle, decision: String) {
    match decision.as_str() {
        "exit" => crate::window_boot::quit_app(&app),
        _ => crate::window_boot::to_tray(&app),
    }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS。

- [ ] **Step 4: 前端**

`types/ipc.ts`：`export type CloseAction = "ask" | "tray" | "exit";`，Settings 加 `close_action: string;`（注释同前「整包 save 必须登记」）。`lib/ipc.ts`：`applyCloseDecision: (decision: "tray" | "exit") => invoke("apply_close_decision", { decision }),` + 仿 `listenSettingsUpdated` 写 `export function listenCloseRequested(cb: () => void) { return listen("close-requested", cb); }`（listen import 照该文件现有方式）。`useUiStore.ts` 加 `closeAskOpen: boolean`（初始 false）+ `setCloseAskOpen: (v: boolean) => void`（纯内存态，不落 localStorage）。

新文件 `src/components/CloseAskDialog.tsx`：

```tsx
// 右上角关闭=「退出还是常驻托盘？」询问框（close_action=ask 时由后端
// close-requested 事件唤起）。勾「记住我的选择」即把 close_action 落盘，
// 下次关窗直接执行不再弹框；改回来在 设置→常规→关闭行为。
import { useState } from "react";
import Modal from "./Modal";
import { api } from "../lib/ipc";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore, errText } from "../stores/useUiStore";

export default function CloseAskDialog() {
  const open = useUiStore((s) => s.closeAskOpen);
  const setOpen = useUiStore((s) => s.setCloseAskOpen);
  const [remember, setRemember] = useState(false);
  if (!open) return null;
  const decide = (action: "tray" | "exit") => {
    if (remember) {
      const cur = useSettingsStore.getState().settings;
      if (cur) void useSettingsStore.getState().save({ ...cur, close_action: action });
    }
    setOpen(false);
    void api.applyCloseDecision(action).catch((e) =>
      useUiStore.getState().addToast("error", `关闭窗口失败：${errText(e)}`));
  };
  return (
    <Modal title="关闭窗口" onClose={() => setOpen(false)} ariaLabel="关闭窗口">
      <p className="modal-note">关闭窗口时，你想退出应用，还是隐藏到底部托盘常驻？</p>
      <label className="close-ask-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住我的选择，下次不再询问
      </label>
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={() => setOpen(false)}>取消</button>
        <button type="button" className="modal-btn" onClick={() => decide("tray")}>隐藏到托盘</button>
        <button type="button" className="modal-btn primary" onClick={() => decide("exit")}>退出应用</button>
      </div>
    </Modal>
  );
}
```

（`.modal-actions`/`.modal-btn`/`primary` 均为既有模态件样式——动手前先 grep `.modal-btn` 定位其所在样式文件；`.close-ask-remember` 加进**同一个**样式文件：13px、var(--fg2)、checkbox 竖排间距。）

App.tsx：boot useEffect 里与其它 `listen*` 并列挂一次（照 `listenHibernateOnce` 的只挂一次风格；若事件监听写在别处初始化文件，随大流）：

```ts
void listenCloseRequested(() => useUiStore.getState().setCloseAskOpen(true));
```

JSX 渲染区（`<SettingsModal />` 旁）加 `<CloseAskDialog />`。

GeneralTab（放「启动与截图」节之前）：

```tsx
<section className="set-sec">
  <h3 className="set-sec-title">关闭行为</h3>
  <p className="set-sec-desc">点右上角「关闭」按钮时发生什么。选「每次询问」后关窗会弹框，勾「记住」即回到固定行为。</p>
  <Seg variant="setseg" ariaLabel="关闭行为" value={closeAction}
    onChange={(v) => { const cur = useSettingsStore.getState().settings;
      if (cur) void useSettingsStore.getState().save({ ...cur, close_action: v }); }}
    options={[
      { value: "ask", label: "每次询问" },
      { value: "tray", label: "常驻托盘" },
      { value: "exit", label: "退出应用" },
    ]} />
</section>
```

组件顶部：`const closeAction = (useSettingsStore((s) => s.settings?.close_action ?? "ask")) as CloseAction;`（import type CloseAction）。

- [ ] **Step 5: 夹具 + 全绿 + 真机验收 + Commit**

三份夹具加 `close_action: "ask"`。全四道门。真机链路逐条过：默认关窗→弹框；点「隐藏到托盘」→ 窗口消失、托盘在、托盘唤醒可回；带「记住」再关一次→行为固化、设置页 Seg 同步；分别试 tray/exit 两档直关不再弹框；exit 档托盘「退出」链路不变；休眠（关窗 5 分钟销毁）链路不回归。

```bash
git add src-tauri/src src
git commit -m "feat(close): 关闭按钮三态（询问/托盘/退出）——弹框记忆选择 + 常规页设置项"
```

---

### Task 12: 设置面板左下角「一键恢复全局默认设置」（需求 7）

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`（`reset_settings`）+ invoke_handler 注册
- Modify: `src/lib/ipc.ts`（api）、`src/components/settings/SettingsParts.tsx`（`ResetAllButton`）、`src/components/SettingsModal.tsx`（nav 末尾挂一行）、`src/styles/10-settings.css`

**Interfaces:**
- Consumes: `Settings::default()`（storage.rs 已有）、`useSettingsStore.load()`、`useUiStore.setListGuide/setContentWidth`。
- Produces: IPC `reset_settings()`。恢复范围 = 后端 Settings 全量 + 两条纯 UI 偏好（引线、正文宽度档）；**不清**最近打开列表与翻译缓存（那是数据不是设置，弹窗文案里讲清楚）。

- [ ] **Step 1: Rust 命令**（commands/settings.rs，注册进 generate_handler；先跑 `cargo test` 保证编译）

```rust
/// 一键恢复全局默认设置（设置面板左下角）：Settings 整包回出厂值，
/// 开机自启同步关掉（插件是即时权威，别留一个盘外还活着的副作用），
/// 热键重注册、广播收敛各窗口。不清缓存/最近打开——那是数据不是设置。
#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let _ = app.autolaunch().disable(); // 失败不阻断：盘上 autostart 已回 false，下次启动自正
    let s = storage::Settings::default();
    storage::save_settings(&s)?;
    hotkeys::sync(&app, &s);
    let _ = app.emit("settings-updated", storage::settings_broadcast_payload(&s));
    Ok(())
}
```

- [ ] **Step 2: 前端按钮**

`lib/ipc.ts` api 加 `resetSettings: () => invoke("reset_settings"),`。SettingsParts.tsx 追加（该文件行数充裕）：

```tsx
/** 设置面板左下角「一键恢复默认」：两段式确认（点一次变红提示，再点执行，3s 自动撤销）。 */
export function ResetAllButton() {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const arm = () => {
    setArmed(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setArmed(false), 3000);
  };
  const run = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    setArmed(false);
    try {
      await api.resetSettings();
      await useSettingsStore.getState().load(); // 全量设置从盘上拉回（含明暗/配色/关闭行为…）
      useUiStore.getState().setListGuide(true); // 两条 localStorage 纯偏好跟随回出厂值
      useUiStore.getState().setContentWidth("normal");
      useUiStore.getState().addToast("info", "已恢复全局默认设置（不含最近打开与翻译缓存）");
    } catch (e) {
      useUiStore.getState().addToast("error", `恢复默认失败：${errText(e)}`);
    }
  };
  return (
    <button type="button" className={`set-nav-reset${armed ? " armed" : ""}`}
      onClick={() => (armed ? void run() : arm())}
      title="把全部设置项恢复为出厂默认">
      {armed ? "再点一次确认恢复（不可撤销）" : "一键恢复默认设置"}
    </button>
  );
}
```

（SettingsParts.tsx 需补 import：`useState/useEffect/useRef`、`api`、`useSettingsStore`、`useUiStore, errText`。正文宽度出厂档 `"normal"`——与 `useUiStore.ts:150 loadContentWidth` 的缺省回落一致，动手前对一眼。）

- [ ] **Step 3: 挂载 + 样式**

SettingsModal.tsx：`.set-nav` 的 `</nav>` 前加一行 `<ResetAllButton />`（净 +1 行，若触红 codeSizeBudget 按提示再外提等价行数）。10-settings.css：确认 `.set-nav` 为 flex 纵向容器后追加（若非 flex column，补 `display:flex; flex-direction:column;`）：

```css
/* 左下角钉底的一键恢复（margin-top:auto 沉到导航尽头） */
.set-nav-reset {
  margin-top: auto;
  align-self: stretch;
  padding: 6px 10px;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
  background: none;
  color: var(--fg3);
  font-size: 11.5px;
  cursor: pointer;
  transition: color 0.14s, border-color 0.14s;
}
.set-nav-reset:hover { color: var(--fg2); }
.set-nav-reset.armed {
  color: var(--accent);
  border: 1px solid var(--accent);
  border-style: solid;
}
```

- [ ] **Step 4: 全绿 + 真机验收 + Commit**

`npx vitest run && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`。真机：改过明暗/正文宽度/关闭行为若干项 → 点按钮（变红）→ 再点 → 全部回默认、明暗即时翻转、toast 出现；重开设置确认落盘；开机自启若开着会被一并关掉（Windows 登录项核对）。

```bash
git add src-tauri/src src/lib/ipc.ts src/components src/styles/10-settings.css
git commit -m "feat(settings): 设置面板左下角一键恢复全局默认（reset_settings IPC + 两段式确认）"
```

---

## 最终验收（全任务完成后）

- [ ] `npx vitest run`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml` 三道全绿。
- [ ] 按 12 条需求逐条真机过一遍（视觉条目以肉眼验收为准，后端条目以测试证据为准），逐条勾给用户看：1→T4，2→T6，3→T5，4→T7，5→T11，6→T9，7→T12，8→T2，9→T1，10→T10，11→T8，12→T3。
- [ ] 更新/合并回 main 的时机由用户决定（不自动 push）。
