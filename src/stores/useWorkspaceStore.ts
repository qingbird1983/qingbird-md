// 工作区：root 下的目录树。rawTree 缓存自 root 打开时刻，search 只作用于展示树
// （filterWorkspace 走后端过滤 rawTree），不回写 rawTree。
import { create } from "zustand";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";

interface WorkspaceState {
  root: string | null;
  tree: TreeNodeDTO[]; // 展示树（受 search 过滤）
  search: string;
  selectedPath: string | null;

  openWorkspace(): Promise<void>;
  selectFile(p: string): void;
  searchFilter(q: string): Promise<void>;
  /** name 为 root 下的一级名称；创建成功后刷新树。 */
  createFile(name: string): Promise<void>;
  createFolder(name: string): Promise<void>;
  refresh(): Promise<void>;
}

// 树内 path 均为后端 PathBuf 原生分隔符字符串，这里按原样拼接即可
function joinUnderRoot(root: string, name: string) {
  const sep = /[\\\/]$/;
  return sep.test(root) ? root + name : `${root}\\${name}`;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  let rawTree: TreeNodeDTO[] = []; // 缓存自 root 打开/刷新时刻

  const setTree = (t: TreeNodeDTO[]) => {
    rawTree = t;
    // 若当前有过滤词，保持“搜索只作用于展示树”的语义
    return get().search.trim() ? applySearch() : Promise.resolve();
  };

  async function applySearch(): Promise<void> {
    const q = get().search;
    if (!q.trim()) {
      set({ tree: rawTree });
      return;
    }
    try {
      const filtered = await api.filterWorkspace(rawTree, q);
      set({ tree: filtered });
    } catch (e) {
      useUiStore.getState().addToast("error", `过滤失败：${errText(e)}`);
    }
  }

  return {
    root: null,
    tree: [],
    search: "",
    selectedPath: null,

    openWorkspace: async () => {
      const p = await api.pickFolder();
      if (!p) return; // 用户取消
      try {
        const t = await api.openWorkspace(p);
        set({ root: p, tree: t, search: "", selectedPath: null });
        rawTree = t;
      } catch (e) {
        useUiStore.getState().addToast("error", `打开工作区失败：${errText(e)}`);
      }
    },

    selectFile: (p) => {
      set({ selectedPath: p });
      void useDocStore.getState().openDoc(p);
    },

    searchFilter: async (q) => {
      set({ search: q });
      await applySearch();
    },

    createFile: async (name) => {
      const root = get().root;
      if (!root || !name.trim()) return;
      try {
        await api.createFile(joinUnderRoot(root, name));
        useUiStore.getState().addToast("success", `已创建 ${name}`);
        await get().refresh();
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    createFolder: async (name) => {
      const root = get().root;
      if (!root || !name.trim()) return;
      try {
        await api.createFolder(joinUnderRoot(root, name));
        useUiStore.getState().addToast("success", `已创建 ${name}`);
        await get().refresh();
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
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
