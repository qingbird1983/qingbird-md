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
import type { DocDTO, Mode, ParseResult, SessionSnapshot, SessionTab, TargetLang, ViewKind } from "../types/ipc";
import { api, byteToCharOffset, charToByteOffset } from "../lib/ipc";
import { baseName } from "../lib/wsPath";
import { SESSION_VERSION } from "../lib/sessionVersion";
import { useUiStore, errText } from "./useUiStore";
import { useTranslationStore } from "./useTranslationStore";
import { useSettingsStore } from "./useSettingsStore";
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
  /**
   * 内容 → 解析结果的缓存。**方向也要进 key**（`target` 字段）：`data-bi`
   * 的占号随方向变，同一份内容在 zh / en 下是不同的 html。只比 contentKey
   * 会让切方向后沿用旧方向的 DOM 编号，而本轮翻译按新方向收集 → 流式译文
   * 贴错块（终态由 doneHtml 兜住，中途那几秒是错的）。
   */
  htmlCache: { contentKey: string; target: TargetLang; result: ParseResult } | null;
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
  htmlCache: { contentKey: string; target: TargetLang; result: ParseResult } | null;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  translations: Map<number, string>;

  // —— 动作 ——
  openTab(path: string): Promise<void>;
  newTab(): void;
  /**
   * 打开一份**内置内容**（欢迎页「打开示例文档」，内容来自 lib/demoDoc.ts）。
   * 没有 path：不在磁盘上留副本、不会被存回安装目录；同名标签已存在则切过去。
   */
  openExampleTab(name: string, content: string): void;
  closeTab(id: string): Promise<void>;
  /** 放弃指定标签的未保存改动：savedContent 对齐 content（工作区删除脏文件的
   *  「不保存」分支用）。必须走 patchTab 集中写路径——isDirty 投影与写入在
   *  同一次 set 内重算；跨 store 直接 setState 会漏掉这一步（BUG-6：脏标
   *  停留到下一次任意写动作才自愈）。 */
  discardChanges(id: string): void;
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
  /**
   * 切换翻译方向（中 ⇄ 英）。**与 switchMode 同级的一次索引空间变更**：
   * 落偏好 + `resetDisplay()` + 清 `translations` + 清 `doneHtml` + 按新方向
   * 重解析基础 html，最后在阅读模式下重跑。UI 必须走这个动作，不要直接调
   * `useSettingsStore.setTarget`（那会漏掉整套 reset）。
   */
  setTranslateTarget(t: TargetLang): Promise<void>;
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

/**
 * doc.base_dir：路径的父目录。与 wsPath.dirName 的两处语义差异是有意的——
 * 无分隔符（裸文件名）返 null 而非原样返回；盘根不做 "C:\foo"→"C:\" 特判
 * （保持 "C:"）。base_dir 只作后端 resolve 的 join 基准，维持原 pathParts
 * 行为避免无谓的入参变化；文件名半径已统一走 wsPath.baseName（P2-3）。
 */
function baseDirOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : null;
}

function activeTab(state: DocState): OpenTab | null {
  return state.activeId ? state.tabs.find((t) => t.id === state.activeId) ?? null : null;
}

/** 构造一份 DocDTO 形态的快照给派生投影用。 */
function tabToDoc(t: OpenTab): DocDTO {
  return {
    name: t.name,
    path: t.path,
    base_dir: t.path ? baseDirOf(t.path) : null,
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

// SESSION_VERSION 自 P2-3 起从 ../lib/sessionVersion 引入（原本地常量删除）。

// 快照字段是字符串，回填前收敛到联合类型：脏数据/跨版本残留不得污染 store。
function normView(v: string): ViewKind {
  return v === "source" || v === "split" ? v : "preview";
}
function normMode(m: string): Mode {
  return m === "translation" || m === "bilingual" ? m : "original";
}

/**
 * 当前翻译方向。**单源** = `useSettingsStore.target`（由 settings 派生）。
 *
 * 凡是「结果要落进某个索引空间」的调用（open_file / parse_markdown /
 * translate_document / render_translated）都必须经由此函数取方向——四处传的
 * 必须是同一个值，任一处不同就会让占号与收集对不上。
 */
const currentTarget = (): TargetLang => useSettingsStore.getState().target;

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

  /**
   * 按当前方向重解析指定 tab 的 markdown，落地 parseResult + htmlCache。
   *
   * 与 `ensureParsed` 共用同一段逻辑，差别只在**是否去抖**：编辑期连续重解析
   * 要走 150ms 去抖（ensureParsed），而切方向必须**立刻且等它落地**——
   * 流式 partial 是按 `data-bi` 往 DOM 里贴的（lib/patchPartial.ts），基础 html
   * 若还停在旧方向的编号上，那几秒的译文就会贴到别的块。
   *
   * 三道过期护栏：tab 被关、内容被改、方向又被切走 —— 任一命中即丢弃结果。
   */
  async function reparseTab(id: string, target: TargetLang): Promise<void> {
    const t0 = get().tabs.find((x) => x.id === id);
    if (!t0) return;
    const key = t0.content;
    try {
      const r = await api.parse(key, target);
      const cur = get().tabs.find((x) => x.id === id);
      if (!cur || cur.content !== key) return;
      if (cur.htmlCache?.contentKey === key && cur.htmlCache.target === target) return;
      patchTab(id, (c) => ({
        ...c,
        parseResult: r,
        htmlCache: { contentKey: key, target, result: r },
      }));
    } catch (e) {
      useUiStore.getState().addToast("error", `解析失败：${errText(e)}`);
    }
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
      // 打开时就按当前方向首渲：parse 里的 data-bi 占号要跟随后续翻译的同方向。
      const target = currentTarget();
      try {
        const d = await api.openFile(path, target);
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
          htmlCache: { contentKey: d.content, target, result: d.parse },
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

    openExampleTab: (name, content) => {
      // 去重：示例只会有一份，重复点按钮应当切过去而不是叠出第二个标签
      // （与 openTab 对同一路径的处理同口径）。
      const existing = get().tabs.find((t) => t.path === null && t.name === name);
      if (existing) {
        get().switchTab(existing.id);
        return;
      }
      const tab: OpenTab = {
        id: newId(),
        path: null,
        name,
        content,
        // savedContent 与内容等值 ⇒ **不标脏**：用户不动它，关标签时不会被追问
        // 保存；动过之后照常进脏态，Ctrl+S 因 path 为空自然走「另存为」。
        savedContent: content,
        mtime: null,
        encoding: null,
        // 预览态：示例是用来「看」的（渲染、公式、图表一屏尽收），要改再切源码。
        view: "preview",
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

    /** 放弃未保存改动（BUG-6 收口）：savedContent 对齐 content。走 patchTab
     *  集中写路径，isDirty 投影在同一次 set 内重算——工作区删除脏文件曾直接
     *  setState 只改真源，脏标停留到下一次任意写动作才自愈。 */
    discardChanges: (id) => {
      patchTab(id, (t) => ({ ...t, savedContent: t.content }));
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
        if (snap.ui.review_width > 0) ui.setReviewWidth(snap.ui.review_width);
        if (snap.ui.split_ratio > 0 && snap.ui.split_ratio < 1) {
          ui.setSplitRatio(snap.ui.split_ratio);
        }
        if (useUiStore.getState().showNav !== snap.ui.show_nav) ui.toggleNav();
        if (useUiStore.getState().showOutline !== snap.ui.show_outline) ui.toggleOutline();
        // AI 核查面板：restore 走 toggleReview——快照由 toggleReview 自身维护一致性
        // （开起时冲突自动翻大纲），所以这里不会有「先翻边后被 outline 恢复覆盖」的
        // 乱序问题。
        if (useUiStore.getState().showReview !== snap.ui.show_review) ui.toggleReview();
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
        const name = baseName(newPath);
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
        const name = baseName(target);
        // 按 id 写：await 期间 active tab 可能已切走（如 closeTab 的 save-then-close），
        // 内容也可能已变（用户在写盘往返期间继续输入）。基线必须取**写盘的那份
        // 快照 t.content**——写 cur.content 会让这段领先于磁盘的编辑被错误地
        // 记为已保存（isDirty 变 false → 关标签不弹确认 → 静默丢改动）。
        patchTab(myId, (cur) => ({
          ...cur,
          path: target!,
          name,
          savedContent: t.content,
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
      const target = currentTarget();
      try {
        const d = await api.openFile(t.path, target);
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
          htmlCache: { contentKey: d.content, target, result: d.parse },
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

    setTranslateTarget: async (t) => {
      const cur = activeTab(get());
      const split = useTranslationStore.getState();
      if (!cur) {
        // 无文档：只有偏好要落，没有索引空间要重置。
        useSettingsStore.getState().setTarget(t);
        return;
      }
      if (useSettingsStore.getState().target === t) return;
      // 1) 偏好先落（乐观更新是同步的）——下面的重解析与起跑都从 settings 取方向。
      useSettingsStore.getState().setTarget(t);
      // 2) **与 switchMode 同级的一次索引空间变更**（H2 红线）：`data-bi` 的
      //    占号由方向决定，所以旧显示、旧打字流、旧译文表、旧 doneHtml 全部作废。
      //    resetDisplay 会 gen 前跳并通知后端取消在途 run——迟到的事件自然失配丢弃。
      split.resetDisplay();
      patchActive((c) => ({ ...c, translations: new Map(), doneHtml: null }));
      // 3) 基础 html 按新方向重解析，并**等它落地**（理由见 reparseTab 注释）。
      //    顺带让后端有一点时间把上一轮 run 收干净，降低"已有翻译在进行"的撞车概率。
      await reparseTab(cur.id, t);
      // 4) 阅读模式下重跑（resetDisplay 已把 gen 前跳、译文表已清 ⇒ startIfFresh
      //    必然判 fresh，除非用户此刻已切到原文模式）。
      if (activeTab(get())?.mode !== "original") useTranslationStore.getState().startIfFresh();
    },

    ensureParsed: () => {
      const t = activeTab(get());
      if (!t) return;
      // 方向也要比：同一份内容在 zh / en 下是不同的 html（data-bi 占号不同）。
      if (t.htmlCache?.contentKey === t.content && t.htmlCache.target === currentTarget()) return;
      clearTimeout(parseTimer);
      const myId = t.id;
      parseTimer = setTimeout(() => void reparseTab(myId, currentTarget()), 150);
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
