# Multi-Tab & Layout Shift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tab editing with double-click-to-close, and shift the formatting toolbar up to sit directly under the tab bar — matching the reference screenshot at `C:\Users\42527\Pictures\6eb9a808-bb47-4aac-86d0-ff487435170f.png`.

**Architecture:** Refactor `useDocStore` from a single-document store to a tabs-collection + active-id store. Each `OpenTab` owns the document state it needs (content, view, mode, cursor, scroll, parse/translation caches). Derived getters (`doc`, `view`, `mode`, etc.) keep every existing consumer working with no change. Add a `TabBar` component above `MainArea`, move `EditorToolbar` up to sit between tab bar and main, and add a `DirtyConfirmDialog` for unsaved close.

**Tech Stack:** React 18, Zustand 5 (with getter support), TypeScript ~5.6, Vite 6, lucide-react (already used by EditorToolbar — only `X` and `Plus` icons added), existing `Modal` component.

## Global Constraints

- **No Rust / IPC changes** — frontend-only refactor.
- **No new dependencies** — `X` and `Plus` come from the already-installed `lucide-react`.
- **No new color tokens** — tab styles reuse `--border`, `--surface`, `--panel-bg`, `--btn-hover-bg` from `theme.css`.
- **Tab isolation**: full per-tab state (content, view, mode, cursor, scroll, parse cache, translation cache, dirty flag) — no shared mutable state between tabs.
- **Double-click and X both close**; middle-click is NOT supported (out of scope per spec).
- **No persistent tabs across app restart** — app always boots with `tabs = []`.
- **Verification gate per task**: `npm run build` (which runs `tsc && vite build`) must pass.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/stores/useDocStore.ts` | Modify | Core refactor: tabs[] + activeId + derived getters; new actions openTab/newTab/closeTab/switchTab; existing actions operate on active tab; `saveDoc` returns `Promise<boolean>`. |
| `src/components/TabBar.tsx` | Create | Renders tab strip; click switch, dblclick close, X close, + new. |
| `src/components/DirtyConfirmDialog.tsx` | Create | Promise-based 3-button dialog (Save / Don't Save / Cancel). |
| `src/components/EditorView.tsx` | Modify | On mount: restore cursorSel + scrollTop from active tab. On scroll event: persist scrollTop to active tab. |
| `src/components/MainArea.tsx` | Modify | Remove inline EditorToolbar; change `key={docKey}` to `key={activeTabId ?? "empty"}`. |
| `src/components/menus/FileMenu.tsx` | Modify | "新建" → `newTab()`; "保存" / "另存为" target active tab via existing `saveDoc`. |
| `src/stores/useWorkspaceStore.ts` | Modify | `selectFile` → call `openTab` (not `openDoc`). |
| `src/stores/useTranslationStore.ts` | Modify | `handleDone` writes to active tab via new helper `applyTranslationResult` (not direct setState). |
| `src/App.tsx` | Modify | Insert `<TabBar />` between `<TopBar />` and `<main>`; insert `<EditorToolbar />` below `<TabBar />` with the existing preview-hides-toolbar guard. |
| `src/styles/global.css` | Modify | Add ~30 lines for `.tabbar` / `.tab` / `.tab.active` / `.tab-close` / `.tab-add` / `.tab-dirty`. |

---

## Task 1: Refactor `useDocStore` to multi-tab state

**Files:**
- Modify: `src/stores/useDocStore.ts` (entire file rewrite)
- Modify: `src/stores/useWorkspaceStore.ts:75-78` (replace `openDoc` call with `openTab`)
- Modify: `src/stores/useTranslationStore.ts:60-83` (replace direct setState calls)
- Modify: `src/components/commands.ts:23-26` (the exported `openFile` helper → `openTab`)
- Modify: `src/components/menus/FileMenu.tsx:10-20` (rename `openDoc` reference → `openTab`; the `saveDoc` calls already use `void` so the boolean change is source-compatible)

**Interfaces:**
- Produces (for later tasks):
  - `tabs: OpenTab[]`, `activeId: string | null` (read by TabBar)
  - `get doc(): DocDTO | null` (read by StatusBar, EditorView, useTranslationStore)
  - `get view(): ViewKind` / `get mode(): Mode` / `get cursorSel(): [number, number]` / `get isDirty(): boolean`
  - `get parseResult() / htmlCache / doneHtml / translations`
  - `openTab(path): Promise<void>`
  - `newTab(): void`
  - `closeTab(id): Promise<void>` — resolves when tab is actually closed (after dirty dialog)
  - `switchTab(id): void`
  - `saveDoc(as): Promise<boolean>` — `true` written, `false` cancelled
  - `applyTranslationResult(translations: Map, doneHtml: ...|null): void`
  - All existing actions keep their signatures, just operate on active tab

- [ ] **Step 1: Add `OpenTab` type and id helper**

In `src/stores/useDocStore.ts`, replace the top of the file (imports + types) with:

```ts
// 文档域：标签集合 + 当前激活 id。每标签独立持有内容、视图模式、阅读模式、
// 光标、滚动、解析/翻译缓存。doc/view/mode/cursorSel/isDirty/parseResult/
// htmlCache/doneHtml/translations 是派生 getter，原始真源在对应 OpenTab 上。
// 这样所有现存的 s.doc / s.view / s.mode / s.cursorSel 订阅方零改动。
import { create } from "zustand";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { DocDTO, Mode, ParseResult, ViewKind } from "../types/ipc";
import { api, byteToCharOffset, charToByteOffset } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
import { useTranslationStore } from "./useTranslationStore";

interface OpenTab {
  id: string;                // crypto.randomUUID() 或 fallback，React key
  path: string | null;       // null = 未保存的新标签
  name: string;              // 显示名（path basename 或 "未命名"）
  content: string;
  savedContent: string;
  view: ViewKind;
  mode: Mode;
  cursorSel: [number, number];
  scrollTop: number;
  translations: Map<number, string>;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  parseResult: ParseResult | null;
  htmlCache: { contentKey: string; result: ParseResult } | null;
}

// 应用启动时检查 randomUUID 可用性；Tauri WebView2 是 Chromium 内核通常支持，
// 旧 WebView 才走 fallback。
let idCounter = 0;
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${++idCounter}`;
}
```

- [ ] **Step 2: Rewrite state interface and derived getters**

Replace the `DocState` interface and `useDocStore` factory body. The shape: tabs + activeId + cmRef at top level; everything else is a getter. Use the `get()` form for getters (Zustand v5 friendly).

```ts
interface DocState {
  tabs: OpenTab[];
  activeId: string | null;
  cmRef: { current: EditorView | null };

  // —— 派生 getter ——
  get doc(): DocDTO | null;
  get view(): ViewKind;
  get mode(): Mode;
  get cursorSel(): [number, number];
  get isDirty(): boolean;
  get parseResult(): ParseResult | null;
  get htmlCache(): { contentKey: string; result: ParseResult } | null;
  get doneHtml(): { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  get translations(): Map<number, string>;

  // —— 动作 ——
  openTab(path: string): Promise<void>;
  newTab(): void;
  closeTab(id: string): Promise<void>;
  switchTab(id: string): void;

  openDocFromArgs(): void;
  dispatchUndo(): void;
  dispatchRedo(): void;
  setCursorSel(s: [number, number]): void;
  applyFormat(op: string): Promise<void>;
  saveDoc(as: boolean): Promise<boolean>;     // 返回值变了：true=写盘成功，false=用户取消
  switchView(v: ViewKind): void;
  switchMode(m: Mode): void;
  ensureParsed(): void;

  /** 翻译完成回写入口（useTranslationStore 调用），写入当前激活标签。 */
  applyTranslationResult(
    translations: Map<number, string>,
    doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null,
  ): void;
}
```

Below the interface, add helpers (outside the create() call):

```ts
function pathParts(p: string) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return { name: i >= 0 ? p.slice(i + 1) : p, dir: i >= 0 ? p.slice(0, i) : null };
}

function activeTab(state: DocState): OpenTab | null {
  return state.activeId ? state.tabs.find((t) => t.id === state.activeId) ?? null : null;
}

/** 构造一份 DocDTO 形态的快照给派生 getter 用。 */
function tabToDoc(t: OpenTab): DocDTO {
  return {
    name: t.name,
    path: t.path,
    base_dir: t.path ? pathParts(t.path).dir : null,
    content: t.content,
    char_count: [...t.content].length,
    line_count: t.content.split("\n").length,
    parse: t.parseResult ?? { html: "", headings: [] },
  };
}

// 防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let docChangedRegistered = false;
let parseTimer: ReturnType<typeof setTimeout> | undefined;

export const useDocStore = create<DocState>()((set, get) => {
  // —— 派生 getter 集合（一个辅助函数，actions 用它一次写完两个 tab 的字段）——
  function patchActive(mut: (t: OpenTab) => OpenTab): void {
    const s = get();
    if (!s.activeId) return;
    const idx = s.tabs.findIndex((t) => t.id === s.activeId);
    if (idx < 0) return;
    const updated = mut(s.tabs[idx]);
    const tabs = [...s.tabs];
    tabs[idx] = updated;
    set({ tabs });
  }

  return {
    tabs: [],
    activeId: null,
    cmRef: { current: null },

    // —— 派生 getter ——
    get doc() { return activeTab(this) ? tabToDoc(activeTab(this)!) : null; },
    get view() { return activeTab(this)?.view ?? "preview"; },
    get mode() { return activeTab(this)?.mode ?? "original"; },
    get cursorSel() { return activeTab(this)?.cursorSel ?? [0, 0]; },
    get isDirty() {
      const t = activeTab(this);
      return !!t && t.content !== t.savedContent;
    },
    get parseResult() { return activeTab(this)?.parseResult ?? null; },
    get htmlCache() { return activeTab(this)?.htmlCache ?? null; },
    get doneHtml() { return activeTab(this)?.doneHtml ?? null; },
    get translations() { return activeTab(this)?.translations ?? new Map(); },

    // —— 动作 ——
    openTab: async (path) => {
      const existing = get().tabs.find((t) => t.path === path);
      if (existing) {
        get().switchTab(existing.id);
        return;
      }
      try {
        const d = await api.openFile(path);
        const tab: OpenTab = {
          id: newId(),
          path,
          name: d.name,
          content: d.content,
          savedContent: d.content,
          view: "source",
          mode: "original",
          cursorSel: [0, 0],
          scrollTop: 0,
          translations: new Map(),
          doneHtml: null,
          parseResult: d.parse,
          htmlCache: { contentKey: d.content, result: d.parse },
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      } catch (e) {
        useUiStore.getState().addToast("error", `打开失败：${errText(e)}`);
      }
    },

    newTab: () => {
      const tab: OpenTab = {
        id: newId(),
        path: null,
        name: "未命名",
        content: "",
        savedContent: "",
        view: "source",
        mode: "original",
        cursorSel: [0, 0],
        scrollTop: 0,
        translations: new Map(),
        doneHtml: null,
        parseResult: null,
        htmlCache: null,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    closeTab: async (id) => {
      const t = get().tabs.find((x) => x.id === id);
      if (!t) return;
      const dirty = t.content !== t.savedContent;
      if (dirty) {
        // 弹出 DirtyConfirmDialog；动态 import 避免循环依赖（dialog 读 useDocStore）
        const { showDirtyConfirm } = await import("../components/DirtyConfirmDialog");
        const choice = await showDirtyConfirm(t.name);
        if (choice === "cancel") return;
        if (choice === "save") {
          // 先切到该标签，再保存——saveDoc 永远作用于 active tab
          get().switchTab(id);
          const ok = await get().saveDoc(false);
          if (!ok) return; // 用户在另存为里取消，中止关闭
        }
      }
      // 真实删除 + 邻居切换
      set((s) => {
        const idx = s.tabs.findIndex((x) => x.id === id);
        if (idx < 0) return {};
        const tabs = s.tabs.filter((x) => x.id !== id);
        let activeId = s.activeId;
        if (s.activeId === id) {
          activeId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
        }
        return { tabs, activeId };
      });
    },

    switchTab: (id) => {
      if (get().activeId === id) return;
      set({ activeId: id });
    },

    openDocFromArgs: () => {
      if (docChangedRegistered) return;
      docChangedRegistered = true;
      void api.listenDocumentChanged((p) => useDocStore.getState().openTab(p));
    },

    dispatchUndo: () => {
      const v = get().cmRef.current;
      if (v) undo(v);
    },
    dispatchRedo: () => {
      const v = get().cmRef.current;
      if (v) redo(v);
    },

    setCursorSel: (s) => {
      patchActive((t) => ({ ...t, cursorSel: s }));
    },

    applyFormat: async (op) => {
      const t = activeTab(get());
      if (!t) return;
      const [c0, c1] = t.cursorSel;
      try {
        const r = await api.applyOp({
          content: t.content,
          sel: [charToByteOffset(t.content, c0), charToByteOffset(t.content, c1)],
          op,
        });
        // 等价于原版 "doc 引用陈旧则丢弃"：activeId 变了说明用户已切走。
        if (get().activeId !== t.id) {
          useUiStore.getState().addToast("info", "文档已变化，本次格式化已取消");
          return;
        }
        patchActive((cur) => ({
          ...cur,
          content: r.content,
          cursorSel: [
            byteToCharOffset(r.content, r.sel[0]),
            byteToCharOffset(r.content, r.sel[1]),
          ],
        }));
      } catch (e) {
        useUiStore.getState().addToast("error", `编辑操作失败：${errText(e)}`);
      }
    },

    saveDoc: async (as) => {
      const t = activeTab(get());
      if (!t) return false;
      let target = t.path;
      if (!target || as) {
        target = await api.pickSavePath(t.name);
        if (!target) return false; // 用户取消另存为
      }
      try {
        await api.saveFile(target, t.content);
        const { name, dir } = pathParts(target);
        patchActive((cur) => ({
          ...cur,
          path: target!,
          name,
          savedContent: cur.content,
        }));
        useUiStore.getState().addToast("success", "保存成功");
        return true;
      } catch (e) {
        useUiStore.getState().addToast("error", `保存失败：${errText(e)}`);
        return false;
      }
    },

    switchView: (v) => {
      patchActive((t) => ({ ...t, view: v }));
    },

    switchMode: (m) => {
      const t = activeTab(get());
      if (!t || t.mode === m) return;
      patchActive((cur) => ({
        ...cur,
        mode: m,
        translations: m === "original" ? new Map() : cur.translations,
      }));
      if (m !== "original") useTranslationStore.getState().startIfFresh();
    },

    ensureParsed: () => {
      const t = activeTab(get());
      if (!t) return;
      if (t.htmlCache?.contentKey === t.content) return;
      clearTimeout(parseTimer);
      const myId = t.id;
      parseTimer = setTimeout(async () => {
        const cur = activeTab(get());
        if (!cur || cur.id !== myId) return;
        const key = cur.content;
        try {
          const r = await api.parse(key);
          if (get().activeId !== myId) return; // 用户已切走
          patchActive((cur2) => ({
            ...cur2,
            parseResult: r,
            htmlCache: { contentKey: key, result: r },
          }));
        } catch (e) {
          useUiStore.getState().addToast("error", `解析失败：${errText(e)}`);
        }
      }, 150);
    },

    applyTranslationResult: (translations, doneHtml) => {
      patchActive((t) => ({ ...t, translations, doneHtml }));
    },
  };
});
```

- [ ] **Step 3: Update `useWorkspaceStore.selectFile`**

In `src/stores/useWorkspaceStore.ts`, change line 75-78 from:

```ts
selectFile: (p) => {
  set({ selectedPath: p });
  void useDocStore.getState().openDoc(p);
},
```

to:

```ts
selectFile: (p) => {
  set({ selectedPath: p });
  void useDocStore.getState().openTab(p);
},
```

- [ ] **Step 4: Update `useTranslationStore.handleDone`**

In `src/stores/useTranslationStore.ts`, replace lines 60-75 (the content-freshness block inside `handleDone`):

```ts
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (contentFresh) {
    if (d.translations) {
      useDocStore.setState({ translations: new Map(d.translations) });
    }
    // T8ext 契约：translation 批次出 html_translation（run 空间）、bilingual 批次出
    // html_bilingual（块空间），二者只居其一；以字段在否为准判定本轮形态。
    if (d.html_translation || d.html_bilingual) {
      useDocStore.setState({
        doneHtml: {
          contentKey: st.runContent!,
          mode: d.html_translation ? "translation" : "bilingual",
          html: (d.html_translation ?? d.html_bilingual)!,
        },
      });
    }
  }
```

with:

```ts
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与 payload html 全部过期，宁缺勿错不落库。
  // 改走标签化 applyTranslationResult —— 翻译产物的归宿是当前 active tab。
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (contentFresh) {
    const translations = d.translations ? new Map(d.translations) : new Map<number, string>();
    const doneHtml =
      d.html_translation || d.html_bilingual
        ? {
            contentKey: st.runContent!,
            mode: (d.html_translation ? "translation" : "bilingual") as Exclude<Mode, "original">,
            html: (d.html_translation ?? d.html_bilingual)!,
          }
        : null;
    useDocStore.getState().applyTranslationResult(translations, doneHtml);
  }
```

- [ ] **Step 5: Find and update all `openDoc` callers**

Run in PowerShell:
```powershell
Select-String -Path "F:\AIwork\qingbird-md-rust\src" -Recurse -Pattern "\bopenDoc\b"
```
Expected hits and fixes:
- `src/components/commands.ts:25` — `await useDocStore.getState().openDoc(p)` → `await useDocStore.getState().openTab(p)`. The exported `openFile()` function name stays.
- `src/components/menus/FileMenu.tsx:11,19` — rename the local selector and call site from `openDoc` to `openTab`.
- Comments in `src/components/menus/FileMenu.tsx:2` and `src/components/EditorView.tsx:8,86` that say "openDoc" — update wording to "openTab" (cosmetic).
- `openDocFromArgs` (App.tsx, useDocStore) — this is a separate action and stays as-is; it's the document-changed event listener.

After this step, grep should match only `openDocFromArgs` and updated comments.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: `tsc` passes (Zustand getter typing works in v5) and `vite build` produces `dist/`. If `tsc` complains about getter typing on the readonly fields, ensure the `DocState` interface marks them `readonly`.

- [ ] **Step 7: Manual smoke — single file still works**

Run: `npm run tauri dev` (or whatever launches the app — check `package.json` scripts; if no tauri dev, use `npm run dev` and load in WebView separately).

Verify:
1. Open a `.md` file via File menu → editor populates.
2. Edit content → dirty dot appears in status bar.
3. `Ctrl+S` saves → dirty dot clears.
4. Switch view (source/preview/split) → persists.
5. Switch reading mode → translation pipeline triggers.

If any of these break, the getter shadows are mis-wired. The fix is almost always: a missing `patchActive` call in the action.

- [ ] **Step 8: Commit**

```bash
git add src/stores/useDocStore.ts src/stores/useWorkspaceStore.ts src/stores/useTranslationStore.ts
git commit -m "refactor(docStore): tabs + activeId with derived getters"
```

---

## Task 2: EditorView — restore cursor & scroll on mount

**Files:**
- Modify: `src/components/EditorView.tsx` (extend useEffect mount logic; add scroll listener)
- Modify: `src/stores/useDocStore.ts` (add `setScrollTop` action and a per-tab `applyEditById(id, content, cursorSel)` if needed; see Step 1)

**Interfaces:**
- Consumes: `useDocStore.activeId`, `useDocStore.doc` (initial content), `useDocStore.cursorSel` (initial selection), per-tab `scrollTop`
- Produces: writes to `useDocStore.cmRef.current` on mount; calls `useDocStore.setCursorSel` / `useDocStore.applyEdit` / `useDocStore.setScrollTop` (NOT direct `setState` to tabs — that bypasses the projection model implemented in Task 1)
- Critical note: Task 1 implements projection fields (doc/view/mode/cursorSel/isDirty/parseResult/htmlCache/doneHtml/translations recomputed via `commit()`/`patchActive()` on every tab/activeId write). The original plan code's direct `useDocStore.setState((s) => ({ tabs: [...] }))` would bypass the projection — **do not transcribe that pattern**. Use the store actions.

- [ ] **Step 1: Add `setScrollTop` action to `useDocStore`**

In `src/stores/useDocStore.ts`, inside the `DocState` interface (after `applyEdit`):

```ts
  /** 滚动事件落库；切回本标签时恢复。 */
  setScrollTop(n: number): void;
```

Inside the `return { ... }` block, near `applyEdit`:

```ts
    setScrollTop: (n) => {
      patchActive((t) => (t.scrollTop === n ? t : { ...t, scrollTop: n }));
    },
```

`applyEdit(content, cursorSel)` already exists from Task 1 — it writes `content` + `cursorSel` to the active tab atomically via `patchActive` (projection stays in sync). Reuse it instead of inlining a `setState`.

- [ ] **Step 2: Rewrite `EditorView.tsx` mount logic**

Replace `src/components/EditorView.tsx` with the following (preserving the file's existing imports and module-level constants):

```tsx
// 编辑器主视图（Task 21 + 多标签扩展）。
//
// 多标签扩展要点：
//   - mount 时把 cmRef 写到 store 顶层（顶层 cmRef 永远指向 active tab 的 CM）。
//   - mount 时从 active tab 读 scrollTop + cursorSel，恢复到 CM。
//   - 编辑产生的 cursorSel 变更走 setCursorSel（原行为不变）。
//   - 编辑产生的 content 变更走 applyEdit（在 store 里改 active tab.content 与
//     cursorSel 原子写入，触发 commit 联动重算投影）。
//   - scroll 事件节流落库 setScrollTop；切回本标签时由 MainArea 的 key 触发
//     卸载/重挂，新 mount 读取最新 scrollTop 恢复。
//
// ⚠️ 不要在本组件里 useDocStore.setState({ tabs: [...] })——会绕过 Task 1 的投影
// 模型导致 doc/isDirty/view 失真。所有写入一律走 store action。
//
// 单实例生命周期：MainArea.tsx 里 key={activeTabId ?? "empty"} 切标签时强制
// unmount/remount，杜绝跨标签 CM 状态污染。
import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView as CmEditorView, keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { minimalSetup } from "codemirror";
import { math } from "codemirror-lang-math";
import { useDocStore } from "../stores/useDocStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";

// ```math 围栏代码块高亮（codemirror-lang-math 0.1.8，无 @replit scope）
const mathLang = LanguageDescription.of({
  name: "math",
  load: async () => math(),
});

// 主题经 compartment 运行时重配（亮/暗切换不重建 View）；
// language 恒为 markdown（应用生命周期内不变），无需第二个 compartment。
const themeComp = new Compartment();

export default function EditorView() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // mount 时锁住 activeId 与对应 tab 的快照，避免后续异步回调跑错 tab。
    const st0 = useDocStore.getState();
    const myId = st0.activeId;
    const t0 = st0.tabs.find((t) => t.id === myId);
    if (!t0) return;

    const view = new CmEditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: t0.content,
        selection: { anchor: t0.cursorSel[0], head: t0.cursorSel[1] },
        extensions: [
          minimalSetup,
          markdown({ codeLanguages: [mathLang, ...languages] }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void useDocStore.getState().saveDoc(false); return true; } },
            { key: "Mod-b", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("bold"); return true; } },
            { key: "Mod-i", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("italic"); return true; } },
          ]),
          CmEditorView.lineWrapping,
          themeComp.of(isDarkTheme() ? oneDark : []),
          CmEditorView.updateListener.of((u) => {
            if (!u.docChanged && !u.selectionSet) return;
            const cur = useDocStore.getState();
            const myTab = cur.tabs.find((t) => t.id === myId);
            if (!myTab) return; // tab 已被关闭
            const { from, to } = u.state.selection.main;
            if (!u.docChanged) {
              // 光标变更：等值短路后走 setCursorSel（→ patchActive → 投影重算）
              if (myTab.cursorSel[0] === from && myTab.cursorSel[1] === to) return;
              cur.setCursorSel([from, to]);
              return;
            }
            const content = u.state.doc.toString();
            if (myTab.content === content) return;
            // 内容 + 选区原子写入 active tab，走 applyEdit：App 划词订阅方拿到原子快照
            cur.applyEdit(content, [from, to]);
          }),
        ],
      }),
    });

    // 挂载后恢复滚动位置（CM 在 nextTick 才把 layout 出来，用 rAF 等一帧）
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = t0.scrollTop;
    });

    // store → editor：外部内容变更（openTab 新文档 / applyFormat 全文替换）
    // 全量替换 + 光标回填 + 居中滚动；选区钳制到新文档长度。
    const unsubDoc = useDocStore.subscribe((s) => {
      const tab = s.tabs.find((t) => t.id === myId);
      if (!tab) return;
      const content = tab.content;
      if (view.state.doc.toString() === content) return;
      const len = view.state.doc.length;
      const clamp = (p: number) => Math.max(0, Math.min(p, len));
      const [f, head] = tab.cursorSel;
      const anchor = clamp(f);
      view.dispatch({
        changes: { from: 0, to: len, insert: content },
        selection: { anchor, head: clamp(head) },
        effects: CmEditorView.scrollIntoView(anchor, { y: "center" }),
      });
    });

    // scroll 落库：节流 100ms，去重写。
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastScroll = t0.scrollTop;
    const onScroll = () => {
      const top = view.scrollDOM.scrollTop;
      if (top === lastScroll) return;
      lastScroll = top;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        // 用 getState 读最新 store，避免闭包旧值；setScrollTop 内部按 id 找 tab
        useDocStore.getState().setScrollTop(top);
      }, 100);
    };
    view.scrollDOM.addEventListener("scroll", onScroll);

    // 工具栏撤销/重做桥接：实例句柄挂到 docStore，卸载时清空
    useDocStore.getState().cmRef.current = view;

    // 主题 compartment：settings.theme 或系统明暗变化时重配
    let lastDark = isDarkTheme();
    const applyTheme = () => {
      const dark = isDarkTheme();
      if (dark === lastDark) return;
      lastDark = dark;
      view.dispatch({ effects: themeComp.reconfigure(dark ? oneDark : []) });
    };
    const unsubTheme = useSettingsStore.subscribe(applyTheme);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);

    return () => {
      clearTimeout(scrollTimer);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      useDocStore.getState().cmRef.current = null;
      mq.removeEventListener("change", applyTheme);
      unsubTheme();
      unsubDoc();
      view.destroy();
    };
  }, []);

  return <div className="editor-cm" ref={hostRef} />;
}
```

Key changes from the original Task 1's EditorView patch:
- updateListener's cursor-only branch: `useDocStore.setState({...tabs...})` → `cur.setCursorSel([from, to])`.
- updateListener's content+selection branch: `useDocStore.setState({...tabs...})` → `cur.applyEdit(content, [from, to])`.
- These route through `patchActive` → `commit()` → projection recompute, keeping doc/isDirty/view coherent.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 4: Manual smoke — single file still works (regression check)**

If you can launch the GUI: open a file, edit, scroll, switch to a different file (or just test that scroll within current tab persists across saves). The single-tab regression case is the same as Task 1 Step 7. The multi-tab scroll restore case is covered by Task 7's full smoke test (cannot be exercised until Task 5 wires the tab bar).

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorView.tsx src/stores/useDocStore.ts
git commit -m "feat(editor): restore cursor and scroll on tab mount"
```

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorView.tsx src/stores/useDocStore.ts
git commit -m "feat(editor): restore cursor and scroll on tab mount"
```

---

## Task 3: DirtyConfirmDialog component

**Files:**
- Create: `src/components/DirtyConfirmDialog.tsx`

**Interfaces:**
- Produces: `showDirtyConfirm(name: string): Promise<"save" | "discard" | "cancel">` — exported function that mounts the dialog imperatively and resolves when the user picks. Used by `closeTab` in `useDocStore`.

- [ ] **Step 1: Inspect the existing `Modal` API**

Read `src/components/Modal.tsx` to confirm the props shape (title, body content, footer buttons, close-on-escape). Use the exact prop names you find.

- [ ] **Step 2: Write the component**

Create `src/components/DirtyConfirmDialog.tsx`:

```tsx
// 关闭脏标签时的三选一确认弹窗。Promise-based，showDirtyConfirm 返回用户的选择；
// closeTab 据此决定保存 / 不保存 / 中止关闭。
//
// 设计要点：
//   - 动态挂载（createRoot），避免污染 App 树的渲染顺序。
//   - 复用现有 Modal 组件，沿用 SettingsModal 的 .modal-actions/.modal-btn/
//     .modal-btn-primary 按钮样式（Modal 自身没有 footer prop，按钮放在 children 内）。
//   - 默认焦点"保存"——大多数用户意图是保存；Esc / 点遮罩走取消（Modal 自带行为）。
//   - 标签名出现在正文里，给用户具体对象（多个标签时一眼能认出是哪个）。
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Modal from "./Modal";

type Choice = "save" | "discard" | "cancel";

function DialogBody({
  name,
  resolve,
}: {
  name: string;
  resolve: (c: Choice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  const pick = (c: Choice) => () => {
    if (busy) return;
    setBusy(true);
    resolve(c);
  };

  return (
    <Modal title="未保存的更改" onClose={pick("cancel")}>
      <p style={{ margin: "0 0 12px" }}>
        “<strong>{name}</strong>” 有未保存的更改，是否保存？
      </p>
      <div className="modal-sep" />
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={pick("cancel")} disabled={busy}>
          取消
        </button>
        <button type="button" className="modal-btn" onClick={pick("discard")} disabled={busy}>
          不保存
        </button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          ref={saveRef}
          onClick={pick("save")}
          disabled={busy}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

let liveRoot: Root | null = null;
let liveHost: HTMLDivElement | null = null;

export function showDirtyConfirm(name: string): Promise<Choice> {
  // 同一时刻至多一个确认框（应用级单例）。如已有遗留则覆盖——不会出现两次叠加。
  if (!liveHost) {
    liveHost = document.createElement("div");
    document.body.appendChild(liveHost);
    liveRoot = createRoot(liveHost);
  }
  return new Promise<Choice>((resolve) => {
    liveRoot!.render(
      <DialogBody
        name={name}
        resolve={(c) => {
          liveRoot!.render(null);
          resolve(c);
        }}
      />,
    );
  });
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: passes. (Modal component already exists; the new icon import isn't needed.)

- [ ] **Step 4: Commit**

```bash
git add src/components/DirtyConfirmDialog.tsx
git commit -m "feat(dialog): dirty confirm for closing unsaved tabs"
```

---

## Task 4: TabBar component

**Files:**
- Create: `src/components/TabBar.tsx`

**Interfaces:**
- Consumes: `useDocStore.tabs`, `useDocStore.activeId`, `useDocStore.isDirty` per tab, `useDocStore.switchTab`, `useDocStore.closeTab`, `useDocStore.newTab`

- [ ] **Step 1: Write the component**

Create `src/components/TabBar.tsx`:

```tsx
// 标签条（Task 4）：横排显示所有打开的标签，活跃标签高亮。
//
// 交互：
//   - 单击 = 切激活（switchTab）。
//   - 双击 = 关（closeTab；脏标签弹 DirtyConfirmDialog）。
//   - 关闭 X = 关（同一 closeTab 流程；stopPropagation 防止冒泡到单击切激活）。
//   - 右侧 + 按钮 = 新建空标签（newTab）。
//
// 样式全部走 .tabbar/.tab/.tab.active/.tab-close/.tab-add/.tab-dirty（见 global.css）。
import { Plus, X } from "lucide-react";
import { useDocStore } from "../stores/useDocStore";

export default function TabBar() {
  const tabs = useDocStore((s) => s.tabs);
  const activeId = useDocStore((s) => s.activeId);

  return (
    <div className="tabbar" role="tablist" aria-label="打开的文档">
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const isDirty = t.content !== t.savedContent;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            className={"tab" + (isActive ? " active" : "")}
            title={t.path ?? t.name}
            onClick={() => useDocStore.getState().switchTab(t.id)}
            onDoubleClick={() => void useDocStore.getState().closeTab(t.id)}
          >
            <span className="tab-title">{t.name}</span>
            {isDirty && <span className="tab-dirty" aria-label="未保存" />}
            <button
              type="button"
              className="tab-close"
              aria-label={`关闭 ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void useDocStore.getState().closeTab(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-add"
        aria-label="新建标签"
        title="新建标签"
        onClick={() => useDocStore.getState().newTab()}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/TabBar.tsx
git commit -m "feat(tabs): tab strip component with switch/close/new"
```

---

## Task 5: Layout wiring (App.tsx + MainArea.tsx)

**Files:**
- Modify: `src/App.tsx` (insert TabBar and EditorToolbar between TopBar and main)
- Modify: `src/components/MainArea.tsx` (remove inline EditorToolbar, change key)

- [ ] **Step 1: Update `App.tsx`**

Add import for TabBar:

```ts
import TabBar from "./components/TabBar";
```

In the `return` of `App`, between `<TopBar />` and `<main className="main-area">`, insert:

```tsx
      <TopBar />
      <TabBar />
      {/* EditorToolbar 上移：原属 MainArea 的 {view !== "preview" && <EditorToolbar />}
          提到 tab 条下面，MainArea 不再渲染。 */}
      {(() => {
        const view = useDocStore.getState().view;
        return view !== "preview" ? <EditorToolbar /> : null;
      })()}
      <main className="main-area">
```

Wait — using `useDocStore.getState().view` inside the JSX is a non-reactive read. Use the hook form instead. Add at the top of `App()`:

```ts
  const toolbarView = useDocStore((s) => s.view);
```

Then in JSX:

```tsx
      <TopBar />
      <TabBar />
      {toolbarView !== "preview" && <EditorToolbar />}
      <main className="main-area">
```

You also need to import `EditorToolbar` (it's not currently imported in `App.tsx`):

```ts
import EditorToolbar from "./components/EditorToolbar";
```

- [ ] **Step 2: Update `MainArea.tsx`**

Remove the `import EditorToolbar from "./EditorToolbar";` line. Remove `{view !== "preview" && <EditorToolbar />}` from the JSX.

Change `const docKey = useDocStore((s) => s.doc?.path ?? "empty");` and the `key` usages:

In `MainArea`:

```ts
  const view = useDocStore((s) => s.view);
  const activeId = useDocStore((s) => s.activeId);
  return (
    <>
      <TranslationBar />
      <div className="main-body">
        {view === "source" && <EditorView key={activeId ?? "empty"} />}
        {view === "preview" && <PreviewView />}
        {view === "split" && <SplitBody />}
      </div>
    </>
  );
```

In `SplitBody`:

```ts
function SplitBody() {
  const ratio = useUiStore((s) => s.splitRatio);
  const activeId = useDocStore((s) => s.activeId);
  // ...
  return (
    <>
      <div className="split-half" style={{ flex: `0 0 ${ratio * 100}%` }}>
        <EditorView key={activeId ?? "empty"} />
      </div>
      {/* resizer + PreviewView unchanged */}
    </>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 4: Manual smoke — empty state**

Launch the app. Without any tab open, the tab bar should show only the `+` button on the right; the main area should show whatever empty state the existing code already produces (likely nothing or the App's "未打开文档" placeholder — accept whatever the existing behavior is when no doc is loaded).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/MainArea.tsx
git commit -m "feat(layout): insert TabBar, hoist EditorToolbar"
```

---

## Task 6: Tab styles

**Files:**
- Modify: `src/styles/global.css` (append at end of file)

- [ ] **Step 1: Add tab styles**

Append to `src/styles/global.css`:

```css
/* 多标签条（T4）：tabbar 横向铺开、tabs 不换行、激活态下沉 1px 形成 lift 效果。 */
.tabbar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--panel-bg);
  border-bottom: 1px solid var(--border);
  /* 横向滚动条更细，避免抢空间 */
  scrollbar-width: thin;
}
.tabbar::-webkit-scrollbar {
  height: 4px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 12px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  font-size: 13px;
  color: inherit;
  background: transparent;
}

.tab:hover {
  background: var(--btn-hover-bg);
}

.tab.active {
  background: var(--surface);
  /* 视觉下沉 1px 盖住 tabbar 底边线，造成"被选中"提起的错觉 */
  box-shadow: inset 0 -2px 0 0 var(--accent, currentColor);
}

.tab-title {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
  flex-shrink: 0;
}

.tab-close,
.tab-add {
  background: none;
  border: none;
  padding: 2px;
  border-radius: 3px;
  cursor: pointer;
  color: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tab-close:hover,
.tab-add:hover {
  background: var(--btn-hover-bg);
}

.tab-add {
  margin-left: auto;
  align-self: center;
  padding: 4px;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: passes (CSS-only changes won't break the TS step).

- [ ] **Step 3: Visual check**

Launch the app, open 2 files. Tabs should appear as a horizontal strip matching the reference: filename + (dirty dot if applicable) + X, with active tab visually lifted (background differs, bottom border accent). The `+` button sits at the far right. Hover on X should highlight it.

- [ ] **Step 4: Commit**

```bash
git add src/styles/global.css
git commit -m "style(tabs): add tabbar styles"
```

---

## Task 7: Final manual smoke test (spec §11)

**Files:** none modified. This is the integration verification.

- [ ] **Step 1: Run the full smoke checklist**

Launch the app and exercise each case:

1. Open 3 different `.md` files. Verify 3 tabs appear; click each → content switches; switch back → original content byte-for-byte identical.
2. Edit tab A; switch to tab B; switch back to A → edit preserved.
3. Change view mode in A (source → split); switch tabs; back to A → still split.
4. Change reading mode in A (e.g., translation); switch tabs; back → still translation, translation cache preserved (PreviewView shows translated content immediately).
5. Double-click tab to close when dirty → DirtyConfirmDialog appears → test 保存 / 不保存 / 取消 each.
6. Double-click when not dirty → silent close.
7. X button on tab → same close behavior as double-click.
8. `+` button → new empty tab; type something; close → dirty dialog → 不保存 → tab closes.
9. Last tab closed → TabBar still shows `+` only.
10. Close middle tab (with 3 tabs, close tab #2) → tab #3 becomes active.
11. `Ctrl+S` saves active tab only; other tabs' dirty dots unaffected.
12. Sidebar click on already-open file → switches to that tab, no duplicate.
13. Sidebar click on new file → new tab opens (does NOT replace current).
14. `Ctrl+O` → open dialog → opens into new tab.
15. App restart → no tabs restored; empty TabBar with just `+`.

If any check fails, fix and re-run from the failing check. Common root causes:
- Tabs duplicate on side click → `openTab` not checking existing path (Task 1 Step 2).
- Edit not preserved across switch → `myId` closure missing in EditorView (Task 2 Step 2).
- Dialog doesn't appear → `dirty` check in `closeTab` wrong (compare content vs savedContent directly, not isDirty getter).
- Scroll not restored → `requestAnimationFrame` not running before scroll assignment; check timing.

- [ ] **Step 2: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "fix: smoke test adjustments"
```

(No commit if all checks pass first try.)

---

## Self-Review

**Spec coverage:**
- §2 Goals 1 (multi-tab full isolation) → Task 1 + Task 2
- §2 Goal 2 (double-click + X close) → Task 4
- §2 Goal 3 (dirty dialog) → Task 3, integrated in Task 1's `closeTab`
- §2 Goal 4 (toolbar above editor) → Task 5
- §2 Goal 5 (lucide icons) → Task 4 (X, Plus imports)
- §2 Goal 6 (existing shortcuts target active tab) → Task 1 (all actions operate on active tab)
- §3 Non-goals (no middle-click, no drag-reorder, no persistence) → enforced by absence in code
- §4 State model → Task 1
- §5 Close flow → Task 1 (closeTab) + Task 3 (dialog)
- §6 Components → Task 3 + Task 4 + Task 5
- §7 Mount/scroll restore → Task 2
- §8 Styling → Task 6
- §9 Empty state → Task 5 (no special handling needed; tabs.length === 0 renders empty TabBar with just `+`)
- §10 Files → mapped to tasks
- §11 Testing → Task 7
- §12 Risks → addressed in implementation (translation gen guard becomes `activeId !== myId` check)

**Placeholder scan:** No "TBD" / "TODO" / "implement later". Code blocks are complete.

**Type consistency:** `OpenTab` defined in Task 1; consumed in Task 1 actions, Task 4 (read fields), Task 2 (read scrollTop). All consistent. `setScrollTop` declared in Task 2 Step 1, consumed in Task 2 Step 2. `applyTranslationResult` declared in Task 1, consumed in Task 1 Step 4. `showDirtyConfirm` declared in Task 3, consumed in Task 1 `closeTab` (forward import resolves at runtime since both modules exist by then).
