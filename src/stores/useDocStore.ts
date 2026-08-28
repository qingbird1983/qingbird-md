// 文档域：标签集合 + 当前激活 id。每标签独立持有内容、视图模式、阅读模式、
// 光标、滚动、解析/翻译缓存。doc/view/mode/cursorSel/isDirty/parseResult/
// htmlCache/doneHtml/translations 是 active tab 的派生投影，原始真源在对应
// OpenTab 上——所有现存的 s.doc / s.view / s.mode / s.cursorSel 订阅方零改动。
//
// 为什么是投影字段而不是 getter：zustand v5 的 setState 每次都用
// Object.assign({}, state, partial) 重建 state 对象，accessor getter 会被
// 求值成静态数据属性——第一次 setState 后 getter 全部冻结。因此改为
// commit() 辅助：所有写路径集中在 patchActive / commit，写 tabs/activeId
// 的同一 set 内同步重算投影，杜绝投影与真源脱节。
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

interface DocState {
  tabs: OpenTab[];
  activeId: string | null;
  cmRef: { current: EditorView | null };

  // —— 派生投影（active tab 的即时快照，写路径集中在下方动作）——
  doc: DocDTO | null;
  view: ViewKind;
  mode: Mode;
  cursorSel: [number, number];
  isDirty: boolean;
  parseResult: ParseResult | null;
  htmlCache: { contentKey: string; result: ParseResult } | null;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  translations: Map<number, string>;

  // —— 动作 ——
  openTab(path: string): Promise<void>;
  newTab(): void;
  closeTab(id: string): Promise<void>;
  switchTab(id: string): void;

  openDocFromArgs(): void;
  dispatchUndo(): void;
  dispatchRedo(): void;
  setCursorSel(s: [number, number]): void;
  /** 编辑器内容+选区原子写入 active tab（EditorView updateListener 用）。 */
  applyEdit(content: string, cursorSel: [number, number]): void;
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

function pathParts(p: string) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return { name: i >= 0 ? p.slice(i + 1) : p, dir: i >= 0 ? p.slice(0, i) : null };
}

function activeTab(state: DocState): OpenTab | null {
  return state.activeId ? state.tabs.find((t) => t.id === state.activeId) ?? null : null;
}

/** 构造一份 DocDTO 形态的快照给派生投影用。 */
function tabToDoc(t: OpenTab): DocDTO {
  return {
    name: t.name,
    path: t.path,
    base_dir: t.path ? pathParts(t.path).dir : null,
    content: t.content,
    char_count: [...t.content].length,
    line_count: t.content.split("\n").length,
    parse: t.parseResult ?? { html: "", outline: [] },
  };
}

/** active tab 的派生投影；与 tabs/activeId 在同一次 set 内联动写入。 */
function projection(tabs: OpenTab[], activeId: string | null) {
  const t = activeId ? tabs.find((x) => x.id === activeId) ?? null : null;
  return {
    doc: t ? tabToDoc(t) : null,
    view: t?.view ?? "preview",
    mode: t?.mode ?? "original",
    cursorSel: t?.cursorSel ?? ([0, 0] as [number, number]),
    isDirty: !!t && t.content !== t.savedContent,
    parseResult: t?.parseResult ?? null,
    htmlCache: t?.htmlCache ?? null,
    doneHtml: t?.doneHtml ?? null,
    translations: t?.translations ?? new Map<number, string>(),
  };
}

/** 写 tabs/activeId 的唯一入口：同一次 set 内带上重算后的投影。 */
function commit(tabs: OpenTab[], activeId: string | null) {
  return { tabs, activeId, ...projection(tabs, activeId) };
}

// 防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let docChangedRegistered = false;
let parseTimer: ReturnType<typeof setTimeout> | undefined;

export const useDocStore = create<DocState>()((set, get) => {
  // —— 派生投影集合（一个辅助函数，actions 用它一次写完 tab 与投影）——
  function patchActive(mut: (t: OpenTab) => OpenTab): void {
    const s = get();
    if (!s.activeId) return;
    const idx = s.tabs.findIndex((t) => t.id === s.activeId);
    if (idx < 0) return;
    const tabs = [...s.tabs];
    tabs[idx] = mut(tabs[idx]);
    set(commit(tabs, s.activeId));
  }

  return {
    tabs: [],
    activeId: null,
    cmRef: { current: null },
    ...projection([], null),

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
        set((s) => commit([...s.tabs, tab], tab.id));
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
      set((s) => commit([...s.tabs, tab], tab.id));
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
        return commit(tabs, activeId);
      });
    },

    switchTab: (id) => {
      if (get().activeId === id) return;
      set((s) => commit(s.tabs, id));
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

    applyEdit: (content, cursorSel) => {
      patchActive((t) => ({ ...t, content, cursorSel }));
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
        const { name } = pathParts(target);
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
