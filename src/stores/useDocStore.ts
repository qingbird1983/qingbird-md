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
import type { DocDTO, Mode, ParseResult, SessionSnapshot, SessionTab, ViewKind } from "../types/ipc";
import { api, byteToCharOffset, charToByteOffset } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
import { useTranslationStore } from "./useTranslationStore";
import { useRecentStore } from "./useRecentStore";

interface OpenTab {
  id: string;                // crypto.randomUUID() 或 fallback，React key
  path: string | null;       // null = 未保存的新标签
  name: string;              // 显示名（path basename 或 "未命名"）
  content: string;
  savedContent: string;
  /** 打开/保存时的磁盘 mtime（毫秒）；外部修改检测与保存冲突检测基线 */
  mtime: number | null;
  /** 打开时实际解码编码（"UTF-8"/"GB18030"）；状态栏标注 */
  encoding: string | null;
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

  openDocFromArgs(): Promise<void>;
  /** 恢复上次休眠留下的会话快照；无快照 / 版本不符则静默回落冷启动。 */
  restoreSession(): Promise<void>;
  dispatchUndo(): void;
  dispatchRedo(): void;
  setCursorSel(s: [number, number]): void;
  /** 编辑器内容+选区原子写入 active tab（EditorView updateListener 用）。 */
  applyEdit(content: string, cursorSel: [number, number]): void;
  /** 滚动事件落库到指定 tab；切回本标签时恢复。 */
  setScrollTop(id: string, n: number): void;
  /** 磁盘重命名/移动后同步标签路径与显示名（内容/撤销栈不动）。 */
  retargetPath(oldPath: string, newPath: string): void;
  applyFormat(op: string): Promise<void>;
  saveDoc(as: boolean): Promise<boolean>;     // 返回值变了：true=写盘成功，false=用户取消
  /** 从磁盘重读指定标签（T6「重新加载」）：内容/解析/翻译态全量重置。 */
  reloadTab(id: string): Promise<void>;
  /** 窗口聚焦时检查当前文档是否被外部修改（T6）：变了则弹重载确认。 */
  checkExternalChange(): Promise<void>;
  switchView(v: ViewKind): void;
  switchMode(m: Mode): void;
  ensureParsed(): void;

  /** 翻译完成回写入口（useTranslationStore 调用），写入当前激活标签。 */
  applyTranslationResult(
    translations: Map<number, string>,
    doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null,
  ): void;
  /** 窗口化 run 的增量合并：pairs 并入当前累积表（不整表 replace）。 */
  mergeTranslations(pairs: Array<[number, string]>): void;
  /** 内容与上轮 run 不符时整表作废 active tab 的 translations（终审 I2，
   * resetDisplayIfStale 调用；已空时不动，避免无谓的 Map 身份变更）。 */
  clearTranslations(): void;
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
    encoding: t.encoding ?? "UTF-8",
    mtime: t.mtime,
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

/** 与 hibernate.rs SESSION_VERSION 一致；改动须同步（src/lib/session.ts 同值）。 */
const SESSION_VERSION = 1;

// 快照字段是字符串，回填前收敛到联合类型：脏数据/跨版本残留不得污染 store。
function normView(v: string): ViewKind {
  return v === "source" || v === "split" ? v : "preview";
}
function normMode(m: string): Mode {
  return m === "translation" || m === "bilingual" ? m : "original";
}

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

  // 按 id 定位写入：用于跨 await 后 active tab 可能已变更的场景（滚动刷新、saveDoc）。
  // 仍走 commit()，投影在同一次 set 内重算，doc/isDirty/view 不脱节。
  function patchTab(id: string, mut: (t: OpenTab) => OpenTab): void {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return; // tab 已被关
    const tabs = [...s.tabs];
    tabs[idx] = mut(tabs[idx]);
    const nextActiveId = s.activeId;
    // 投影仍按当前 activeId 算（不变）。本写入不动 activeId。
    set({ tabs, ...projection(tabs, nextActiveId) });
  }

  // —— 休眠恢复（docs/webview-hibernate-plan.md 步骤 7）——
  // 从快照恢复单个 tab，返回新 tab 的 id（无法恢复为 null）。
  async function restoreTab(t: SessionTab): Promise<string | null> {
    const draft = t.content; // 先取出：TS 才能在后续闭包里保持 string | null 窄化
    const view = normView(t.view);
    const mode = normMode(t.mode);
    const cursorSel: [number, number] = [t.cursor_sel?.[0] ?? 0, t.cursor_sel?.[1] ?? 0];

    // 有 path 的一律先按 path 打开：靠 openTab 拿磁盘基线（savedContent /
    // mtime / encoding / parse），脏 tab 再用草稿覆盖 content——isDirty 与
    // 保存冲突检测的基线因此都是正确的，不需要快照里多存一份磁盘内容。
    if (t.path) {
      await get().openTab(t.path);
      const opened = get().tabs.find((x) => x.path === t.path);
      if (opened) {
        patchTab(opened.id, (cur) => ({
          ...cur,
          content: draft ?? cur.content,
          view,
          mode,
          cursorSel,
          scrollTop: t.scroll_top,
        }));
        return opened.id;
      }
      // 文件已被删除/移走：草稿不能丢，落到下面的无 path 分支重建
    }

    // 无 path（未命名新标签）或原文件已消失：直接构造 tab。
    // savedContent 留空 → 有草稿即标脏、无草稿则干净，与 newTab 同口径。
    const tab: OpenTab = {
      id: newId(),
      path: null,
      name: t.name || "未命名",
      content: draft ?? "",
      savedContent: "",
      mtime: t.mtime,
      encoding: t.encoding,
      view,
      mode,
      cursorSel,
      scrollTop: t.scroll_top,
      translations: new Map(),
      doneHtml: null,
      parseResult: null,
      htmlCache: null,
    };
    set((s) => commit([...s.tabs, tab], s.activeId));
    return tab.id;
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
          mtime: d.mtime,
          encoding: d.encoding,
          view: "preview",
          mode: "original",
          cursorSel: [0, 0],
          scrollTop: 0,
          translations: new Map(),
          doneHtml: null,
          parseResult: d.parse,
          htmlCache: { contentKey: d.content, result: d.parse },
        };
        set((s) => commit([...s.tabs, tab], tab.id));
        // 最近打开文档登记：这里是所有「按路径打开」的唯一漏斗，记在这儿才不漏
        // （树点击 / Ctrl+O / 命令面板 / 文件关联 / 休眠交接 / 欢迎页 / 菜单）。
        useRecentStore.getState().push(path, d.name);
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
        mtime: null,
        encoding: null,
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

    openDocFromArgs: async () => {
      if (docChangedRegistered) return;
      docChangedRegistered = true;
      void api.listenDocumentChanged((p) => useDocStore.getState().openTab(p));
      // T6：窗口重获焦点/切回前台时检查当前文档是否被外部修改。
      // 标签间切换不需要查——跨应用改动必然伴随本窗口失焦→聚焦。
      const onFocus = () => { void useDocStore.getState().checkExternalChange(); };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") onFocus();
      });
      // 先恢复休眠快照，再打开休眠期间到达的 handoff 文件：后者是用户刚刚
      // 双击的目标，它的 openTab 会把焦点抢到自己身上（覆盖快照的 activeId）。
      await useDocStore.getState().restoreSession();
      try {
        for (const p of await api.takePendingOpen()) {
          await useDocStore.getState().openTab(p);
        }
      } catch (e) {
        useUiStore.getState().addToast("error", `打开文件失败：${errText(e)}`);
      }
      // 工作区记忆兜底（放在快照恢复之后）：按 localStorage 记的文件夹列表恢复
      // 侧栏（含各文件夹展开态与选中项）。合并式恢复，已有 root 也不会漏条目。
      // 动态 import：useWorkspaceStore 反向依赖本 store，静态导入会成环。
      const { useWorkspaceStore: ws } = await import("./useWorkspaceStore");
      await ws.getState().restoreFolders();
    },

    restoreSession: async () => {
      let snap: SessionSnapshot | null;
      try {
        snap = await api.loadSession();
      } catch {
        return; // 快照读不出来：按冷启动继续，绝不阻塞启动
      }
      if (!snap) return;
      if (snap.version !== SESSION_VERSION) {
        await api.clearSession().catch(() => {}); // 旧版本快照作废
        return;
      }

      // 串行 await：openTab 内部会切 activeId，并发会让激活标签抢跑
      const idMap = new Map<string, string>();
      for (const t of snap.tabs) {
        const id = await restoreTab(t);
        if (id) idMap.set(t.id, id);
      }
      // activeId 最后设置：restoreTab 里每个 openTab 都会把它抢走
      const next = snap.active_id ? idMap.get(snap.active_id) : undefined;
      if (next && get().tabs.some((x) => x.id === next)) {
        set((s) => commit(s.tabs, next));
      }

      // UI 回填：宽度有 setter；折叠开关只有 toggle，按差值补一次。
      // 数值一律做健全性校验——快照是磁盘数据，坏值不能把面板拖成 0 宽。
      if (snap.ui) {
        const ui = useUiStore.getState();
        if (snap.ui.sidebar_width > 0) ui.setSidebarWidth(snap.ui.sidebar_width);
        if (snap.ui.outline_width > 0) ui.setOutlineWidth(snap.ui.outline_width);
        if (snap.ui.split_ratio > 0 && snap.ui.split_ratio < 1) {
          ui.setSplitRatio(snap.ui.split_ratio);
        }
        if (useUiStore.getState().showNav !== snap.ui.show_nav) ui.toggleNav();
        if (useUiStore.getState().showOutline !== snap.ui.show_outline) ui.toggleOutline();
      }
      if (snap.workspace_root) {
        // 动态 import 避免循环依赖（useWorkspaceStore 反过来读 useDocStore）
        const { useWorkspaceStore } = await import("./useWorkspaceStore");
        await useWorkspaceStore.getState().restoreWorkspace(snap.workspace_root);
      }

      const dirty = snap.tabs.filter((t) => t.content !== null).length;
      if (dirty > 0) {
        useUiStore.getState().addToast(
          "info",
          dirty > 1 ? `已恢复上次未保存的内容（${dirty} 个标签）` : "已恢复上次未保存的内容",
        );
      }
      await api.clearSession().catch(() => {}); // 一次性快照：恢复成功即删
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
      useTranslationStore.getState().resetDisplayIfStale(content);
      patchActive((t) => ({ ...t, content, cursorSel }));
    },

    setScrollTop: (id, n) => {
      patchTab(id, (t) => (t.scrollTop === n ? t : { ...t, scrollTop: n }));
    },

    // 磁盘重命名/移动后同步标签（路径 + 显示名）；内容与撤销栈保持不动，
    // 否则保存会把内容写回已失效的旧路径。
    retargetPath: (oldPath, newPath) => {
      set((s) => {
        if (!s.tabs.some((t) => t.path === oldPath)) return {};
        const name = pathParts(newPath).name;
        const tabs = s.tabs.map((t) => (t.path === oldPath ? { ...t, path: newPath, name } : t));
        return commit(tabs, s.activeId);
      });
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
        // 三向陈旧守卫：activeId 变了（切走）/ tab 已被关（id 不再）/ 内容被改（打字）
        // 任何一项命中都说明 r 是基于陈旧内容的结果，跳过覆盖。
        const cur = activeTab(get());
        if (!cur || cur.id !== t.id || cur.content !== t.content) {
          useUiStore.getState().addToast("info", "文档已变化，本次格式化已取消");
          return;
        }
        patchActive((cur2) => ({
          ...cur2,
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
      const myId = t.id; // 锁定目标 tab id
      let target = t.path;
      if (!target || as) {
        target = await api.pickSavePath(t.name);
        if (!target) return false; // 用户取消另存为
      } else {
        // T8 冲突检测：磁盘 mtime 与打开时基线不一致 → 覆盖/另存/取消。
        // 基线缺失（mtime=null）或文件已消失（disk=null，保存即重建）时跳过。
        const disk = await api.fileMtime(target);
        if (disk !== null && t.mtime !== null && disk !== t.mtime) {
          const { showConflict } = await import("../components/ConflictDialog");
          const choice = await showConflict(t.name);
          if (choice === "cancel") return false;
          if (choice === "saveas") {
            const alt = await api.pickSavePath(t.name);
            if (!alt) return false;
            target = alt;
          }
          // overwrite → 继续按原路径落盘
        }
      }
      try {
        const mtime = await api.saveFile(target, t.content);
        const { name } = pathParts(target);
        // 按 id 写：await 期间 active tab 可能已切走（如 closeTab 的 save-then-close）
        patchTab(myId, (cur) => ({
          ...cur,
          path: target!,
          name,
          savedContent: cur.content,
          mtime, // 新基线：下次冲突检测以此为准
        }));
        useUiStore.getState().addToast("success", "保存成功");
        return true;
      } catch (e) {
        useUiStore.getState().addToast("error", `保存失败：${errText(e)}`);
        return false;
      }
    },

    reloadTab: async (id) => {
      const t = get().tabs.find((x) => x.id === id);
      if (!t?.path) return;
      try {
        const d = await api.openFile(t.path);
        // 按 id 写：await 期间 active 可能已切走。视图/模式/滚动保留（用户语境），
        // 内容、解析、翻译态、光标全量重置（翻译按行号索引，旧内容下已失效）。
        patchTab(id, (cur) => ({
          ...cur,
          name: d.name,
          content: d.content,
          savedContent: d.content,
          mtime: d.mtime,
          encoding: d.encoding,
          parseResult: d.parse,
          htmlCache: { contentKey: d.content, result: d.parse },
          translations: new Map(),
          doneHtml: null,
          cursorSel: [0, 0],
        }));
      } catch (e) {
        useUiStore.getState().addToast("error", `重新加载失败：${errText(e)}`);
      }
    },

    checkExternalChange: async () => {
      const t = activeTab(get());
      if (!t?.path || t.mtime === null) return; // 新标签/基线缺失：无从比对
      const disk = await api.fileMtime(t.path);
      if (disk === null || disk === t.mtime) return; // 文件消失或未变
      const { showReloadConfirm } = await import("../components/ReloadDialog");
      const choice = await showReloadConfirm(t.name, t.content !== t.savedContent);
      if (choice === "reload") {
        void get().reloadTab(t.id);
      } else {
        // 保留我的版本：记下磁盘 mtime 作为新基线——用户已知情并选择保留，
        // 之后保存不再重复弹冲突（一次外部修改只打扰一次）。
        patchTab(t.id, (cur) => ({ ...cur, mtime: disk }));
      }
    },

    switchView: (v) => {
      patchActive((t) => ({ ...t, view: v }));
    },

    switchMode: (m) => {
      const t = activeTab(get());
      if (!t || t.mode === m) return;
      useTranslationStore.getState().resetDisplay(); // 旧模式显示/流全部作废（索引空间变）
      patchActive((cur) => ({
        ...cur,
        mode: m,
        // （终审 I3）任意模式切换都清表：translation 的键是 run 空间（data-ri）、
        // bilingual 是块空间（data-bi），跨模式混表会让另一空间的旧键在
        // render_translated 里错位到错误块/文本框。缓存使重译廉价，宁缺勿错。
        translations: new Map(),
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
          const cur2 = activeTab(get());
          if (!cur2 || cur2.id !== myId || cur2.content !== key) return; // 切走/关掉/内容被改 = 过期
          patchActive((c) => ({
            ...c,
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

    mergeTranslations: (pairs) => {
      if (pairs.length === 0) return;
      patchActive((t) => {
        const merged = new Map(t.translations);
        for (const [i, v] of pairs) merged.set(i, v);
        return { ...t, translations: merged };
      });
    },

    clearTranslations: () => {
      // （终审 I2）最小面入口：只动 translations 一个字段，走既有 patchActive
      // 通道（投影同次 set 重算）。已空时原对象透传——避免空表清空也换 Map
      // 身份触发无谓重渲。
      patchActive((t) => (t.translations.size === 0 ? t : { ...t, translations: new Map() }));
    },
  };
});
