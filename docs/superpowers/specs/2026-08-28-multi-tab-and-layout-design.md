# qingbird-md-rust — Multi-Tab & UI Layout — Design

**Date:** 2026-08-28 · **Status:** Draft for review · **Author:** agent

## 1. Summary

Replace the current single-document layout with a multi-tab editor that matches the reference UI:

1. **Multi-tab** — multiple `.md` files openable in parallel, each with full isolated state. Click switches tab; double-click closes it.
2. **Layout shift** — the formatting toolbar moves up out of `MainArea` and sits directly under the new tab bar. The rest of the layout (TopBar menus, Sidebar file tree, OutlinePanel, StatusBar) is unchanged.

No changes to Rust side, IPC, file format, settings, or translation pipeline. This is a frontend-only change.

Reference screenshot: `C:\Users\42527\Pictures\6eb9a808-bb47-4aac-86d0-ff487435170f.png`.

## 2. Goals

1. Multiple `.md` files open simultaneously; switching preserves content, scroll position, cursor selection, view mode, reading mode, dirty flag, translation cache, parse cache.
2. Double-click a tab closes it. The X button on the tab also closes it.
3. Unsaved tab close shows a 3-button dialog: Save / Don't Save / Cancel. Save paths through the existing `saveDoc` flow — if the user cancels the OS Save-As dialog, the close is aborted.
4. The formatting toolbar appears above the editor, immediately below the tab bar (matches reference layout).
5. Visual style (close icons, +, toolbar icons) uses `lucide-react` SVG icons for consistency with the existing EditorToolbar.
6. All existing shortcuts (`Ctrl+O` open, `Ctrl+S` save, `Ctrl+E` view toggle, `Ctrl+B/I/\` format/shortcuts, `Ctrl+Shift+P` palette) keep working — they target the active tab.

## 3. Non-goals

- Middle-click close (not requested).
- Drag-to-reorder tabs (not requested).
- `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle tabs (YAGNI).
- Tab overflow → dropdown menu. Use horizontal scroll instead.
- Persistent tab list across app restarts. App always starts with zero tabs.
- Restoring previously-open files on launch.
- Changing the single-file IPC contract.
- Modifying Rust backend.

## 4. State model

### 4.1 Current `useDocStore` (single-document)

```
doc: DocDTO | null
view: ViewKind
mode: Mode
cursorSel: [number, number]
isDirty: boolean
savedContent: string
translations: Map<number, string>
doneHtml: { contentKey; mode; html } | null
parseResult: ParseResult | null
htmlCache: { contentKey; result } | null
cmRef: { current: EditorView | null }
```

### 4.2 New `useDocStore` (multi-tab)

```
tabs: OpenTab[]        // ordered list, left-to-right as displayed
activeId: string | null
```

```
interface OpenTab {
  id: string                  // crypto.randomUUID(), stable React key
  path: string | null         // null for unsaved/new tabs
  name: string                // display name (basename or "未命名")
  content: string
  savedContent: string        // for dirty check
  view: "source" | "preview" | "split"
  mode: "original" | "translation" | "bilingual"
  cursorSel: [number, number]
  scrollTop: number           // restored on tab switch
  translations: Map<number, string>
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null
  parseResult: ParseResult | null
  htmlCache: { contentKey: string; result: ParseResult } | null
  cmRef: { current: EditorView | null }
}
```

`doc` is **derived** from the active tab — kept as a getter (`get doc(): DocDTO | null`) so every existing consumer that reads `useDocStore(s => s.doc)` continues to work unchanged.

### 4.3 New actions

| Action | Behavior |
|---|---|
| `openTab(path)` | If `tabs` already has a tab with this path → `switchTab` to it. Else create new `OpenTab`, push, `switchTab`. |
| `newTab()` | Push empty `OpenTab { path: null, name: "未命名", content: "", savedContent: "", view: "source", mode: "original", ... }`, `switchTab`. |
| `closeTab(id)` | See §5 for flow. |
| `switchTab(id)` | Persist current active tab's `scrollTop`/`cursorSel` (EditorView owns `scrollTop` via `cmRef`, see §6), set `activeId`. |

### 4.4 Modified actions (now operate on active tab)

| Action | Change |
|---|---|
| `applyFormat(op)` | Read active tab, write back to it. |
| `saveDoc(as)` | Save active tab's content; on success set `savedContent = content` on the tab. |
| `switchView(v)` | Set active tab's `view`. |
| `switchMode(m)` | Set active tab's `mode`. |
| `ensureParsed()` | Use active tab's content as the cache key; write `parseResult`/`htmlCache` to the active tab. |
| `dispatchUndo`/`dispatchRedo` | Call `activeTab.cmRef.current`. |
| `setCursorSel(s)` | Set active tab's `cursorSel`. |

### 4.5 Selectors that stay working as-is

`doc` (derived), `view`, `mode`, `cursorSel`, `isDirty` (= `activeTab.content !== activeTab.savedContent`), `cmRef`, `parseResult`, `htmlCache`, `doneHtml`, `translations` — all become **computed from the active tab** via selector functions or getter accessors. Components do not need to change.

`StatusBar.tsx` already reads `s.doc`, `s.isDirty`, `s.mode` — works unchanged.
`Sidebar.tsx`, `OutlinePanel.tsx`, `EditorView.tsx`, `PreviewView.tsx` — work unchanged.
`useDocStore.subscribe((s, prev) => s.cursorSel !== prev.cursorSel)` in `App.tsx` still fires when active tab's cursor moves.

## 5. Close flow

```
closeTab(id):
  tab = tabs.find(t => t.id === id)
  if !tab: return
  if tab.content === tab.savedContent:
    removeTab(id)                                 // not dirty → silent close
    return
  // dirty → confirm dialog (blocking promise)
  await DirtyConfirmDialog:
    "保存"   → await saveDoc(false) on tab
              if user cancelled Save-As (saveDoc returned with no path):
                abort close (return)
              else removeTab(id)
    "不保存" → removeTab(id)
    "取消"   → return (no-op)

  removeTab(id):
    tabs = tabs.filter(t => t.id !== id)
    if activeId === id:
      switch to right neighbor if any, else left neighbor
      if tabs.length === 0: activeId = null
```

Save-As cancel detection: `saveDoc` already early-returns when `pickSavePath` yields empty string (user dismissed the dialog). The new `saveDoc` signature changes from `Promise<void>` to `Promise<boolean>` (true = written, false = cancelled) so `closeTab` can distinguish.

## 6. UI components

### 6.1 `TabBar.tsx` (new, ~80 lines)

- Wrapper `<div class="tabbar">` with `overflow-x: auto`, no wrap.
- For each tab: `<div class={"tab" + (active ? " active" : "")}>`
  - Click → `switchTab(id)`
  - Double-click → `closeTab(id)`
  - Title text = tab.name; if dirty append `●` (rendered as a separate `<span class="tab-dirty">`)
  - `<button class="tab-close" aria-label="关闭">` with `<X size={14} />` from lucide-react; click → `closeTab(id)`; stopPropagation to avoid switching tabs.
- Right end: `<button class="tab-add" aria-label="新建标签">` with `<Plus size={14} />`; click → `newTab()`.

### 6.2 `DirtyConfirmDialog.tsx` (new, ~50 lines)

Reuses the existing `Modal` component. Three buttons:
- 保存 (primary)
- 不保存 (secondary)
- 取消 (default cancel / escape)

Returns a promise resolving to `"save" | "discard" | "cancel"`.

### 6.3 `App.tsx` (modified)

Insert `<TabBar />` between `<TopBar />` and `<main class="main-area">`. Move `<EditorToolbar />` out of `MainArea.tsx` and place it in `App.tsx` between `<TabBar />` and `<main>`. The existing preview-mode-hides-toolbar rule (`{view !== "preview" && <EditorToolbar />}`) follows the toolbar up — it reads the active tab's `view` and behaves identically.

### 6.4 `MainArea.tsx` (modified)

Remove `import EditorToolbar` and the `{view !== "preview" && <EditorToolbar />}` line. `TranslationBar` and `main-body` stay. EditorView key changes from `key={docKey}` to `key={activeTabId ?? "empty"}` for the source view; split-half editor likewise.

## 7. EditorView mount / scroll restore

`MainArea.tsx` already uses `key={docKey}` so `EditorView` fully unmounts on doc change. Extend to `key={activeTabId ?? "empty"}`. On mount:

1. `cmRef` on the new active tab is populated.
2. CM dispatch to set selection from `cursorSel`.
3. After CM's first paint, call `view.scrollDOM.scrollTop = scrollTop` to restore scroll.

Saving scroll back to the tab: do it on every `scroll` event on the CM scrollDOM (debounced ~100ms via a small setTimeout, or compared against last-saved value to skip no-op writes). Avoid the alternative of saving in `updateListener` — that fires per keystroke, not per scroll, and would miss programmatic scrolls (wheel/touchpad/keyboard). The tab's `scrollTop` is only consumed when the tab becomes active again; mid-edit loss is harmless because the user is still on the same tab.

## 8. Styling (~30 new lines in `global.css`)

```css
.tabbar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  background: var(--panel-bg);
  border-bottom: 1px solid var(--border);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 12px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.tab.active {
  background: var(--surface);
  border-bottom: 1px solid var(--surface); /* visual lift */
  margin-bottom: -1px;
}
.tab-close, .tab-add {
  background: none; border: none; padding: 2px;
  border-radius: 3px; cursor: pointer; color: inherit;
}
.tab-close:hover { background: var(--btn-hover-bg); }
.tab-dirty { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.6; }
```

No new color tokens. Reuses `--border`, `--surface`, `--panel-bg`, `--btn-hover-bg` already defined in `theme.css`.

## 9. Empty state

`tabs.length === 0`:
- TabBar still renders, showing only the `+` button.
- `MainArea` body shows "未打开文档" placeholder (small, centered, gray).

## 10. Files

| File | Change |
|---|---|
| `src/stores/useDocStore.ts` | Major refactor: tabs + activeId, derived `doc`, all actions operate on active tab. |
| `src/components/TabBar.tsx` | New. |
| `src/components/DirtyConfirmDialog.tsx` | New. |
| `src/App.tsx` | Insert `<TabBar />` and move `<EditorToolbar />` out of MainArea. |
| `src/components/MainArea.tsx` | Remove `<EditorToolbar />`, change `key` to `activeTabId`. |
| `src/components/EditorView.tsx` | Mount: restore `cursorSel` + `scrollTop`; updateListener: persist `scrollTop`. |
| `src/styles/global.css` | Add tab styles (~30 lines). |

No Rust changes. No new dependencies. `lucide-react` already used by EditorToolbar — its `X` and `Plus` icons are added there.

## 11. Testing strategy

Manual smoke (since no frontend test framework exists in this repo per design §5 non-goal):

1. Open 3 different `.md` files. Verify 3 tabs appear; click each → content switches; switch back → original content restored byte-for-byte.
2. Edit tab A; switch to tab B; switch back to A → edit preserved.
3. Change view mode in A (source→split); switch tabs; back to A → still split.
4. Change reading mode in A; switch tabs; back → preserved.
5. Double-click tab to close when dirty → dialog appears → 保存 / 不保存 / 取消 each tested.
6. Double-click when not dirty → silent close.
7. X button on tab → same close behavior as double-click.
8. `+` button → new empty tab; type something; close → dirty dialog → 不保存 → tab closes.
9. Last tab closed → empty state shown.
10. Close middle tab → adjacent neighbor (right or left) becomes active.
11. `Ctrl+S` saves active tab only; other tabs unaffected.
12. Sidebar click on already-open file → switches to that tab, no duplicate.
13. Sidebar click on new file → new tab opened.
14. `Ctrl+O` → open dialog → opens into new tab.
15. App restart → no tabs restored; clean empty state.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `EditorView` key change causes CM undo history loss on every tab switch (already exists on single-doc) — acceptable, was already the case. | Documented; same behavior. |
| Translation in-flight when closing the active tab — cancellation not currently implemented; translation store has no per-tab awareness. | Out of scope for this spec. Translation keeps running and its results land in the (now-removed) tab; subsequent re-open of the same path starts fresh translation. User sees no broken UI. |
| `cmRef` swap during async action (e.g., `applyFormat` finishes after user switched tabs). | Existing `if (get().doc !== d) return` guard becomes `if (get().activeId !== oldActiveId) return`. |
| `crypto.randomUUID()` not in older WebView2 builds. | Fallback: `Date.now() + "-" + counter++`. |
