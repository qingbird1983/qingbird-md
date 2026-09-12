// 工作区：root 下的目录树。rawTree 缓存自 root 打开时刻，search 只作用于展示树
// （filterWorkspace 走后端过滤 rawTree），不回写 rawTree。
//
// 树记忆（2026-09-12）：展开目录集合 + 选中文件按 root 持久化到 localStorage；
// 另记「上次工作区」，启动时自动恢复（不依赖休眠快照）。文件操作（重命名/
// 删除/移动/模板新建）走 Rust 命令，成功后刷新树并同步标签。
import { create } from "zustand";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";

interface TreeMemory {
  open: string[];
  selected: string | null;
}

interface WorkspaceState {
  root: string | null;
  tree: TreeNodeDTO[]; // 展示树（受 search 过滤）
  search: string;
  selectedPath: string | null;
  /** 展开的目录路径集合（重启后按 root 还原） */
  openDirs: Set<string>;

  openWorkspace(): Promise<void>;
  /** 休眠恢复用：按已知道路打开工作区，跳过目录选择对话框。 */
  restoreWorkspace(p: string): Promise<void>;
  /** 启动时按上次工作区自动恢复（无记录 / 目录已失效则静默跳过）。 */
  restoreLastWorkspace(): Promise<void>;
  selectFile(p: string): void;
  toggleDir(p: string): void;
  searchFilter(q: string): Promise<void>;
  /** name 为 root 下的一级名称；创建成功后刷新树。 */
  createFile(name: string): Promise<void>;
  createFolder(name: string): Promise<void>;
  /** 在指定目录（默认 root）下创建；成功后打开新文件。 */
  createFileIn(dir: string | null, name: string): Promise<void>;
  createFolderIn(dir: string | null, name: string): Promise<void>;
  createFromTemplateIn(dir: string | null, name: string, kind: string): Promise<void>;
  renameNode(p: string, newName: string): Promise<void>;
  deleteNode(p: string): Promise<void>;
  moveNode(p: string, destDir: string): Promise<void>;
  refresh(): Promise<void>;
}

// 树内 path 均为后端 PathBuf 原生分隔符字符串，这里按原样拼接即可
function sepOf(dir: string) {
  return dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
}

function joinUnderRoot(root: string, name: string) {
  const sep = /[\\\/]$/;
  return sep.test(root) ? root + name : `${root}${sepOf(root)}${name}`;
}

// ---- 树记忆持久化（localStorage；不进 Rust 设置文件，避免动契约）----
const WS_MEM_KEY = "qb.ws-memory";
const WS_LAST_KEY = "qb.ws-last";

function readMemory(): Record<string, TreeMemory> {
  try {
    const raw = localStorage.getItem(WS_MEM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TreeMemory>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeMemory(root: string, mem: TreeMemory) {
  try {
    const all = readMemory();
    all[root] = mem;
    localStorage.setItem(WS_MEM_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式/配额满：记忆功能静默降级 */
  }
}

/** 该 root 的记录 → 可直接展开进 set() 的补丁（无记录则回默认：全折叠、无选中）。 */
function memoryFor(root: string): { openDirs: Set<string>; selectedPath: string | null } {
  const mem = readMemory()[root];
  return {
    openDirs: new Set(mem?.open ?? []),
    selectedPath: mem?.selected ?? null,
  };
}

/** 写回当前 root 的展开态 + 选中项（root 未打开时不动）。 */
function persistMemory(s: { root: string | null; openDirs: Set<string>; selectedPath: string | null }) {
  if (!s.root) return;
  writeMemory(s.root, { open: [...s.openDirs], selected: s.selectedPath });
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  let rawTree: TreeNodeDTO[] = []; // 缓存自 root 打开/刷新时刻
  // applySearch 乱序护栏：连续输入时丢弃过期 IPC 响应（T15 review 遗留，随 T18 侧栏接线补齐）
  let searchGen = 0;

  const setTree = (t: TreeNodeDTO[]) => {
    rawTree = t;
    // 若当前有过滤词，保持“搜索只作用于展示树”的语义
    return get().search.trim() ? applySearch() : Promise.resolve();
  };

  async function applySearch(): Promise<void> {
    const q = get().search;
    const gen = ++searchGen;
    if (!q.trim()) {
      set({ tree: rawTree }); // 同步分支，无 await，天然有序
      return;
    }
    try {
      const filtered = await api.filterWorkspace(rawTree, q);
      if (gen === searchGen) set({ tree: filtered });
    } catch (e) {
      if (gen === searchGen)
        useUiStore.getState().addToast("error", `过滤失败：${errText(e)}`);
    }
  }

  return {
    root: null,
    tree: [],
    search: "",
    selectedPath: null,
    openDirs: new Set<string>(),

    openWorkspace: async () => {
      const p = await api.pickFolder();
      if (!p) return; // 用户取消
      try {
        const t = await api.openWorkspace(p);
        set({ root: p, tree: t, search: "", ...memoryFor(p) });
        rawTree = t;
        try {
          localStorage.setItem(WS_LAST_KEY, p);
        } catch {
          /* 配额满则放弃记忆上次工作区 */
        }
      } catch (e) {
        useUiStore.getState().addToast("error", `打开工作区失败：${errText(e)}`);
      }
    },

    // 休眠恢复：目录已失效（被移动/删除）时静默跳过——不阻塞启动，
    // 也不必弹 toast 打扰用户（他没主动要求打开工作区）。
    restoreWorkspace: async (p) => {
      try {
        const t = await api.openWorkspace(p);
        set({ root: p, tree: t, search: "", ...memoryFor(p) });
        rawTree = t; // 与 openWorkspace 同口径：refresh 依赖它
      } catch {
        /* 静默 */
      }
    },

    // 冷启动恢复上次工作区：settings/休眠快照都可能已经打开了工作区，
    // 此时不重复打开（幂等）。目录被删时清掉记录，下次不再试。
    restoreLastWorkspace: async () => {
      if (get().root) return;
      let last: string | null = null;
      try {
        last = localStorage.getItem(WS_LAST_KEY);
      } catch {
        return;
      }
      if (!last) return;
      try {
        const t = await api.openWorkspace(last);
        set({ root: last, tree: t, search: "", ...memoryFor(last) });
        rawTree = t;
      } catch {
        try {
          localStorage.removeItem(WS_LAST_KEY);
        } catch {
          /* ignore */
        }
      }
    },

    selectFile: (p) => {
      set({ selectedPath: p });
      persistMemory(get());
      void useDocStore.getState().openTab(p);
    },

    toggleDir: (p) => {
      set((s) => {
        const next = new Set(s.openDirs);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        persistMemory({ ...s, openDirs: next });
        return { openDirs: next };
      });
    },

    searchFilter: async (q) => {
      set({ search: q });
      await applySearch();
    },

    createFile: async (name) => {
      await get().createFileIn(null, name);
    },

    createFolder: async (name) => {
      await get().createFolderIn(null, name);
    },

    createFileIn: async (dir, name) => {
      const root = get().root;
      const base = dir ?? root;
      if (!base || !name.trim()) return;
      const target = joinUnderRoot(base, name.trim());
      try {
        await api.createFile(target);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        // 展开目标目录，让新文件可见
        set((s) => ({ openDirs: new Set(s.openDirs).add(base) }));
        await get().refresh();
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    createFolderIn: async (dir, name) => {
      const root = get().root;
      const base = dir ?? root;
      if (!base || !name.trim()) return;
      const target = joinUnderRoot(base, name.trim());
      try {
        await api.createFolder(target);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        set((s) => ({ openDirs: new Set(s.openDirs).add(base) }));
        await get().refresh();
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    createFromTemplateIn: async (dir, name, kind) => {
      const root = get().root;
      const base = dir ?? root;
      if (!base || !name.trim()) return;
      try {
        const created = await api.createFromTemplate(base, name.trim(), kind);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        set((s) => ({ openDirs: new Set(s.openDirs).add(base) }));
        await get().refresh();
        // 模板新建后直接打开，省一次点击
        get().selectFile(created);
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    renameNode: async (p, newName) => {
      try {
        const next = await api.renamePath(p, newName);
        // 打开中的标签跟着改路径，避免保存回已改名的旧路径
        useDocStore.getState().retargetPath(p, next);
        if (get().selectedPath === p) set({ selectedPath: next });
        await get().refresh();
        useUiStore.getState().addToast("success", `已重命名为 ${newName.trim()}`);
      } catch (e) {
        useUiStore.getState().addToast("error", `重命名失败：${errText(e)}`);
      }
    },

    deleteNode: async (p) => {
      const doc = useDocStore.getState();
      const tab = doc.tabs.find((t) => t.path === p);
      // 占用该路径的标签若有未保存改动，先走与其他关闭路径同款的三选确认：
      // 取消 = 中止删除；保存 = 先落盘再删；不保存 = 直接删。
      if (tab && tab.content !== tab.savedContent) {
        const { showDirtyConfirm } = await import("../components/DirtyConfirmDialog");
        const choice = await showDirtyConfirm(tab.name);
        if (choice === "cancel") return;
        if (choice === "save") {
          doc.switchTab(tab.id);
          const ok = await useDocStore.getState().saveDoc(false);
          if (!ok) return; // 另存为里取消 → 中止
        } else {
          // 放弃改动：把磁盘基线对齐内容，closeTab 便不再弹确认
          useDocStore.setState((s) => ({
            tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, savedContent: t.content } : t)),
          }));
        }
      }
      try {
        await api.deletePath(p);
        const live = useDocStore.getState().tabs.find((t) => t.path === p);
        if (live) await useDocStore.getState().closeTab(live.id);
        if (get().selectedPath === p) set({ selectedPath: null });
        await get().refresh();
        useUiStore.getState().addToast("success", "已删除到回收站");
      } catch (e) {
        useUiStore.getState().addToast("error", `删除失败：${errText(e)}`);
      }
    },

    moveNode: async (p, destDir) => {
      try {
        const next = await api.movePath(p, destDir);
        useDocStore.getState().retargetPath(p, next);
        if (get().selectedPath === p) set({ selectedPath: next });
        set((s) => ({ openDirs: new Set(s.openDirs).add(destDir) }));
        await get().refresh();
        useUiStore.getState().addToast("success", "已移动");
      } catch (e) {
        useUiStore.getState().addToast("error", `移动失败：${errText(e)}`);
      }
    },

    refresh: async () => {
      const root = get().root;
      if (!root) return;
      try {
        await setTree(await api.openWorkspace(root));
      } catch (e) {
        useUiStore.getState().addToast("error", `刷新失败：${errText(e)}`);
      }
    },
  };
});
