// 会话快照恢复 + 启动装载（P2-8b 自 useDocStore 纯提取）：restoreTab 从快照
// 重建单个标签、restoreSession 加载/校验/回填整个会话、openDocFromArgs 注册
// 启动监听并衔接「快照 → handoff 文件 → 工作区记忆」的装载顺序。
// 写路径经 SessionRestoreDeps 注入（get/set/patchTab），tab/投影写回仍走
// docTabs.commit 同一次 set 重算投影的集中通道。
import type { Mode, SessionSnapshot, SessionTab, ViewKind } from "../types/ipc";
import { api } from "./ipc";
// SESSION_VERSION 自 P2-3 起从 ../lib/sessionVersion 引入（原本地常量删除）。
import { SESSION_VERSION } from "./sessionVersion";
import { useUiStore, errText } from "../stores/useUiStore";
import { newId, commit, type DocState, type OpenTab } from "../stores/docTabs";
import { useDocStore } from "../stores/useDocStore";

// 快照字段是字符串，回填前收敛到联合类型：脏数据/跨版本残留不得污染 store。
function normView(v: string): ViewKind {
  return v === "source" || v === "split" ? v : "preview";
}
function normMode(m: string): Mode {
  return m === "translation" || m === "bilingual" ? m : "original";
}

/** store 侧注入的写路径句柄（薄动作把 create 工厂的 set/get/patchTab 传进来）。 */
export interface SessionRestoreDeps {
  get: () => DocState;
  set: (partial: Partial<DocState> | ((s: DocState) => Partial<DocState>)) => void;
  patchTab: (id: string, mut: (t: OpenTab) => OpenTab) => void;
}

// 防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let docChangedRegistered = false;

/**
 * 启动装载（原 openDocFromArgs 逐字）：注册文档变更监听与外部修改检查，
 * 先恢复休眠快照，再打开休眠期间到达的 handoff 文件，最后按工作区记忆兜底。
 */
export async function openDocFromArgs(): Promise<void> {
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
  const { useWorkspaceStore: ws } = await import("../stores/useWorkspaceStore");
  await ws.getState().restoreFolders();
}

// —— 休眠恢复（docs/webview-hibernate-plan.md 步骤 7）——
// 从快照恢复单个 tab，返回新 tab 的 id（无法恢复为 null）。
export async function restoreTab(t: SessionTab, deps: SessionRestoreDeps): Promise<string | null> {
  const draft = t.content; // 先取出：TS 才能在后续闭包里保持 string | null 窄化
  const view = normView(t.view);
  const mode = normMode(t.mode);
  const cursorSel: [number, number] = [t.cursor_sel?.[0] ?? 0, t.cursor_sel?.[1] ?? 0];

  // 有 path 的一律先按 path 打开：靠 openTab 拿磁盘基线（savedContent /
  // mtime / encoding / parse），脏 tab 再用草稿覆盖 content——isDirty 与
  // 保存冲突检测的基线因此都是正确的，不需要快照里多存一份磁盘内容。
  if (t.path) {
    await deps.get().openTab(t.path);
    const opened = deps.get().tabs.find((x) => x.path === t.path);
    if (opened) {
      deps.patchTab(opened.id, (cur) => ({
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
  deps.set((s) => commit([...s.tabs, tab], s.activeId));
  return tab.id;
}

/** 加载并应用会话快照（原 restoreSession 动作体逐字，get/set/patchTab 经 deps）。 */
export async function restoreSession(deps: SessionRestoreDeps): Promise<void> {
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
    const id = await restoreTab(t, deps);
    if (id) idMap.set(t.id, id);
  }
  // activeId 最后设置：restoreTab 里每个 openTab 都会把它抢走
  const next = snap.active_id ? idMap.get(snap.active_id) : undefined;
  if (next && deps.get().tabs.some((x) => x.id === next)) {
    deps.set((s) => commit(s.tabs, next));
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
    const { useWorkspaceStore } = await import("../stores/useWorkspaceStore");
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
}
