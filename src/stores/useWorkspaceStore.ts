// 工作区：**多文件夹**列表，每个文件夹各自持有一棵目录树。
//
// 结构（2026-09-12 改版，从单 root 扩到多 folder）：
//   folders[]  —— 侧栏「文件夹」区一行一个条目，每个条目有自己的树与展开态
//   activePath —— 当前活动文件夹（新建文件 / 过滤 / 刷新的锚点）
//   selectedPath —— 全局唯一的选中文件（各文件夹共用）
//
// 「最近打开文档」不在本 store：它挂在 useDocStore.openTab 这一「按路径打开」的
// 唯一漏斗上，见 useRecentStore。
//
// 非破坏红线：closeFolder / clearFolders / 最近列表的移除一律**只动记忆**，
// 绝不碰磁盘。全应用唯一的磁盘删除是 deleteNode，且必须过 ConfirmDialog。
//
// 记忆全部走 localStorage（不进 Rust 会话快照，避免动契约）：
//   qb.ws-folders   文件夹列表 + 各自展开态（顺序即侧栏显示顺序）
//   qb.ws-memory    按文件夹记「展开了哪些子目录」（兼容旧的 {open,selected} 形状）
//   qb.ws-selected  选中的文件路径
//   qb.ws-filter    过滤胶囊是否展开
import { create } from "zustand";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { baseName, dirName, folderOfPath, joinUnderRoot, normPath } from "../lib/wsPath";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";
import { useRecentStore } from "./useRecentStore";

/** 侧栏「文件夹」区的一个条目。 */
export interface WorkspaceFolder {
  path: string;
  name: string;
  /** 展示树：search 为空时等于磁盘最新结果，否则是过滤结果 */
  tree: TreeNodeDTO[];
  /** 该文件夹在侧栏是否展开（折叠时不渲染树，但仍持有数据） */
  open: boolean;
  /** 该文件夹内已展开的子目录（跨会话记忆） */
  openDirs: Set<string>;
  /** 打开失败原因（目录被移动/删除/无权限）；有值时条目置灰且不可展开 */
  error?: string;
}

/** 命令面板检索用的扁平文件项。 */
export interface WorkspaceFile {
  path: string;
  name: string;
  /** 所属文件夹根，用于展示相对路径 */
  root: string;
}

interface WorkspaceState {
  folders: WorkspaceFolder[];
  activePath: string | null;
  selectedPath: string | null;
  search: string;
  /** 过滤胶囊是否展开（「筛选」图标钮开关，记忆到 qb.ws-filter） */
  filterOpen: boolean;
  /** 全文件夹文件的扁平索引（树刷新时重建，命令面板用） */
  fileIndex: WorkspaceFile[];

  /** 选目录 → 加入列表并展开 */
  openWorkspace(): Promise<void>;
  /** 把一个已知道路加入列表（已存在则聚焦并重读磁盘）。silent 时不弹错误 toast。 */
  addFolder(p: string, silent?: boolean): Promise<void>;
  /** 仅从列表移除（非破坏，不关标签、不动磁盘） */
  closeFolder(p: string): void;
  /** 清空整个文件夹列表（非破坏） */
  clearFolders(): void;
  toggleFolderOpen(p: string): void;
  /** 指定活动文件夹（新建文件的落点锚）。右键某文件夹时也调它，
   *  这样菜单上标的 Ctrl+N 与「在此新建」是同一个目标，提示才不算骗人。 */
  setActive(p: string): void;
  /** 启动时按记忆恢复文件夹列表（含展开态、选中项、子目录展开态） */
  restoreFolders(): Promise<void>;
  /** 休眠恢复用：确保该目录在列表里并置为活动。 */
  restoreWorkspace(p: string): Promise<void>;
  /** 重读磁盘。不传 = 全部；传 = 单个 */
  refresh(folderPath?: string): Promise<void>;

  setFilterOpen(v: boolean): void;
  searchFilter(q: string): Promise<void>;
  selectFile(p: string): void;
  toggleDir(folderPath: string, dir: string): void;

  createFile(name: string): Promise<void>;
  createFolder(name: string): Promise<void>;
  /** dir 为绝对路径；null = 当前活动文件夹根 */
  createFileIn(dir: string | null, name: string): Promise<void>;
  createFolderIn(dir: string | null, name: string): Promise<void>;
  createFromTemplateIn(dir: string | null, name: string, kind: string): Promise<void>;
  renameNode(p: string, newName: string): Promise<void>;
  /** 磁盘删除（回收站）。isDir 只影响确认框文案。 */
  deleteNode(p: string, isDir?: boolean): Promise<void>;
  moveNode(p: string, destDir: string): Promise<void>;
}

// ---- 路径工具：统一在 lib/wsPath（纯函数 + 单测覆盖前缀边界与盘根两个坑）----

// ---- 持久化（全部 localStorage；任何异常静默降级，不影响主流程）----

const FOLDERS_KEY = "qb.ws-folders";
const MEM_KEY = "qb.ws-memory";
const SEL_KEY = "qb.ws-selected";
const FILTER_KEY = "qb.ws-filter";

function readFolders(): Array<{ path: string; open: boolean }> {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ path: string; open: boolean }> = [];
    for (const x of parsed) {
      if (typeof x === "string") out.push({ path: x, open: true }); // 旧形状：裸路径
      else if (x && typeof x === "object" && typeof (x as { path?: unknown }).path === "string") {
        const o = x as { path: string; open?: unknown };
        out.push({ path: o.path, open: o.open !== false });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeFolders(folders: WorkspaceFolder[]) {
  try {
    localStorage.setItem(
      FOLDERS_KEY,
      JSON.stringify(folders.map((f) => ({ path: f.path, open: f.open }))),
    );
  } catch {
    /* ignore */
  }
}

/** 按文件夹读展开的子目录。兼容旧形状 `{ open: string[], selected }`。 */
function readMem(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(MEM_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const arr = Array.isArray(v)
        ? v
        : v && typeof v === "object" && Array.isArray((v as { open?: unknown }).open)
          ? (v as { open: unknown[] }).open
          : [];
      out[k] = arr.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function writeMem(root: string, openDirs: Set<string>) {
  try {
    const all = readMem();
    all[root] = [...openDirs];
    localStorage.setItem(MEM_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function readSel(): string | null {
  try {
    return localStorage.getItem(SEL_KEY);
  } catch {
    return null;
  }
}

function writeSel(p: string | null) {
  try {
    if (p) localStorage.setItem(SEL_KEY, p);
    else localStorage.removeItem(SEL_KEY);
  } catch {
    /* ignore */
  }
}

function readFilterOpen(): boolean {
  try {
    return localStorage.getItem(FILTER_KEY) !== "0"; // 默认展开
  } catch {
    return true;
  }
}

function writeFilterOpen(v: boolean) {
  try {
    localStorage.setItem(FILTER_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function collectFiles(nodes: TreeNodeDTO[], root: string, out: WorkspaceFile[]) {
  for (const n of nodes) {
    if (n.is_dir) collectFiles(n.children ?? [], root, out);
    else if (n.path) out.push({ path: n.path, name: n.name, root });
  }
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  // 未过滤的原始树，按文件夹缓存。search 只作用于展示树（folders[].tree），
  // 恢复/刷新/再过滤都从这里取，避免反复读盘。
  const rawTrees = new Map<string, TreeNodeDTO[]>();
  // 过滤乱序护栏：连续输入时丢弃过期 IPC 响应
  let searchGen = 0;

  const patchFolder = (path: string, patch: Partial<WorkspaceFolder>) =>
    set((s) => ({ folders: s.folders.map((f) => (f.path === path ? { ...f, ...patch } : f)) }));

  const reindex = () => {
    const out: WorkspaceFile[] = [];
    for (const f of get().folders) {
      const raw = rawTrees.get(f.path);
      if (raw) collectFiles(raw, f.path, out);
    }
    set({ fileIndex: out });
  };

  /** 逐层展开 target 到 folderPath 之间的全部目录（target 自身也展开）。 */
  const expandChain = (folderPath: string, target: string) => {
    const f = get().folders.find((x) => x.path === folderPath);
    if (!f) return;
    const next = new Set(f.openDirs);
    let cur = target;
    while (cur.length > folderPath.length && cur.startsWith(folderPath)) {
      next.add(cur);
      cur = dirName(cur);
    }
    patchFolder(folderPath, { openDirs: next, open: true });
    writeMem(folderPath, next);
  };

  async function applySearch(): Promise<void> {
    const q = get().search.trim();
    const gen = ++searchGen;
    if (!q) {
      // 同步分支，无 await，天然有序
      set((s) => ({
        folders: s.folders.map((f) => ({ ...f, tree: rawTrees.get(f.path) ?? [] })),
      }));
      return;
    }
    try {
      const pairs = await Promise.all(
        get().folders.map(async (f): Promise<[string, TreeNodeDTO[]]> => {
          const raw = rawTrees.get(f.path) ?? [];
          if (f.error) return [f.path, []];
          return [f.path, await api.filterWorkspace(raw, q)];
        }),
      );
      if (gen !== searchGen) return;
      const map = new Map(pairs);
      set((s) => ({
        folders: s.folders.map((f) => ({ ...f, tree: map.get(f.path) ?? f.tree })),
      }));
    } catch (e) {
      if (gen === searchGen) {
        useUiStore.getState().addToast("error", `过滤失败：${errText(e)}`);
      }
    }
  }

  return {
    folders: [],
    activePath: null,
    selectedPath: null,
    search: "",
    filterOpen: readFilterOpen(),
    fileIndex: [],

    openWorkspace: async () => {
      const p = await api.pickFolder();
      if (!p) return; // 用户取消
      await get().addFolder(normPath(p));
    },

    addFolder: async (p, silent) => {
      const path = normPath(p);
      if (!path) return;

      // 已在列表：聚焦 + 重读磁盘（用户可能刚在外部改过这个目录）
      if (get().folders.some((f) => f.path === path)) {
        patchFolder(path, { open: true, error: undefined });
        set({ activePath: path });
        writeFolders(get().folders);
        try {
          const t = await api.openWorkspace(path);
          rawTrees.set(path, t);
          reindex();
          await applySearch();
        } catch {
          /* 保留旧树 */
        }
        return;
      }

      try {
        const t = await api.openWorkspace(path);
        rawTrees.set(path, t);
        set((s) => ({
          folders: [
            ...s.folders,
            {
              path,
              name: baseName(path) || path,
              tree: t,
              open: true,
              openDirs: new Set(readMem()[path] ?? []),
            },
          ],
          activePath: path,
        }));
        reindex();
        writeFolders(get().folders);
        if (!silent) useUiStore.getState().addToast("success", `已打开 ${baseName(path) || path}`);
      } catch (e) {
        if (silent) return;
        useUiStore.getState().addToast("error", `打开文件夹失败：${errText(e)}`);
      }
    },

    closeFolder: (p) => {
      const f = get().folders.find((x) => x.path === p);
      if (!f) return;
      set((s) => {
        const folders = s.folders.filter((x) => x.path !== p);
        return {
          folders,
          activePath: s.activePath === p ? (folders[0]?.path ?? null) : s.activePath,
        };
      });
      rawTrees.delete(p);
      reindex();
      writeFolders(get().folders);
      // 明确告知用户这是非破坏操作——避免误以为文件被删
      useUiStore.getState().addToast("info", `已从列表移除「${f.name}」，磁盘文件未改动`);
    },

    clearFolders: () => {
      const n = get().folders.length;
      if (!n) return;
      set({ folders: [], activePath: null, selectedPath: null });
      rawTrees.clear();
      reindex();
      writeFolders([]);
      writeSel(null);
      useUiStore.getState().addToast("info", `已清空文件夹列表（${n} 项），磁盘文件未改动`);
    },

    toggleFolderOpen: (p) => {
      const f = get().folders.find((x) => x.path === p);
      if (!f || f.error) return;
      patchFolder(p, { open: !f.open });
      set({ activePath: p });
      writeFolders(get().folders);
    },

    setActive: (p) => {
      if (!get().folders.some((f) => f.path === p)) return;
      set({ activePath: p });
    },

    restoreFolders: async () => {
      // 合并式而非「有事就跳过」：休眠快照恢复可能已经塞进来一个活动文件夹
      // （见 restoreWorkspace），此时其余记忆条目仍要补上。已存在的跳过。
      const existing = new Set(get().folders.map((f) => f.path));
      const remembered = readFolders()
        .map((r) => ({ path: normPath(r.path), open: r.open }))
        .filter((r) => !!r.path && !existing.has(r.path));
      if (!remembered.length) return;
      const mem = readMem();

      const added: WorkspaceFolder[] = [];
      for (const r of remembered) {
        try {
          const t = await api.openWorkspace(r.path);
          rawTrees.set(r.path, t);
          added.push({
            path: r.path,
            name: baseName(r.path) || r.path,
            tree: t,
            open: r.open,
            openDirs: new Set(mem[r.path] ?? []),
          });
        } catch (e) {
          // 目录被移动/删除：保留条目并标注原因，让用户自己决定去留
          // （静默丢弃会让记忆无声消失，更难排查）
          added.push({
            path: r.path,
            name: baseName(r.path) || r.path,
            tree: [],
            open: false,
            openDirs: new Set(),
            error: errText(e),
          });
        }
      }
      set((s) => ({
        folders: [...s.folders, ...added],
        activePath: s.activePath ?? added[0]?.path ?? null,
        selectedPath: s.selectedPath ?? readSel(),
      }));
      reindex();
      writeFolders(get().folders);
    },

    restoreWorkspace: async (p) => {
      const path = normPath(p);
      if (!path) return;
      if (get().folders.some((f) => f.path === path)) {
        patchFolder(path, { open: true, error: undefined });
        set({ activePath: path });
        return;
      }
      await get().addFolder(path, true); // 休眠恢复静默失败，不打扰用户
    },

    refresh: async (folderPath) => {
      const targets = folderPath
        ? get().folders.filter((f) => f.path === folderPath)
        : get().folders;
      if (!targets.length) return;
      let failed = 0;
      for (const f of targets) {
        try {
          const t = await api.openWorkspace(f.path);
          rawTrees.set(f.path, t);
          patchFolder(f.path, { error: undefined });
        } catch (e) {
          failed++;
          patchFolder(f.path, { error: errText(e) });
        }
      }
      reindex();
      await applySearch();
      if (failed) useUiStore.getState().addToast("error", `${failed} 个文件夹读取失败`);
    },

    setFilterOpen: (v) => {
      set({ filterOpen: v });
      writeFilterOpen(v);
    },

    searchFilter: async (q) => {
      set({ search: q });
      await applySearch();
    },

    selectFile: (p) => {
      set({ selectedPath: p });
      writeSel(p);
      const owner = folderOfPath(get().folders, p);
      if (owner) {
        expandChain(owner.path, dirName(p));
        set({ activePath: owner.path });
        writeFolders(get().folders);
      }
      void useDocStore.getState().openTab(p);
    },

    toggleDir: (folderPath, dir) => {
      const f = get().folders.find((x) => x.path === folderPath);
      if (!f) return;
      const next = new Set(f.openDirs);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      patchFolder(folderPath, { openDirs: next });
      set({ activePath: folderPath });
      writeMem(folderPath, next);
    },

    createFile: async (name) => {
      await get().createFileIn(null, name);
    },

    createFolder: async (name) => {
      await get().createFolderIn(null, name);
    },

    createFileIn: async (dir, name) => {
      const base = dir ?? get().activePath;
      if (!base || !name.trim()) return;
      const target = joinUnderRoot(base, name.trim());
      try {
        await api.createFile(target);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        const owner = folderOfPath(get().folders, base);
        if (owner) {
          expandChain(owner.path, base);
          await get().refresh(owner.path);
        }
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    createFolderIn: async (dir, name) => {
      const base = dir ?? get().activePath;
      if (!base || !name.trim()) return;
      const target = joinUnderRoot(base, name.trim());
      try {
        await api.createFolder(target);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        const owner = folderOfPath(get().folders, base);
        if (owner) {
          expandChain(owner.path, base);
          await get().refresh(owner.path);
        }
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    createFromTemplateIn: async (dir, name, kind) => {
      const base = dir ?? get().activePath;
      if (!base || !name.trim()) return;
      try {
        const created = await api.createFromTemplate(base, name.trim(), kind);
        useUiStore.getState().addToast("success", `已创建 ${name.trim()}`);
        const owner = folderOfPath(get().folders, base);
        if (owner) {
          expandChain(owner.path, base);
          await get().refresh(owner.path);
        }
        get().selectFile(created); // 模板新建后直接打开，省一次点击
      } catch (e) {
        useUiStore.getState().addToast("error", `新建失败：${errText(e)}`);
      }
    },

    renameNode: async (p, newName) => {
      try {
        const next = await api.renamePath(p, newName);
        // 打开中的标签跟着改路径，避免保存回已改名的旧路径
        useDocStore.getState().retargetPath(p, next);
        retargetRecent(p, next);
        if (get().selectedPath === p) {
          set({ selectedPath: next });
          writeSel(next);
        }
        await get().refresh();
        useUiStore.getState().addToast("success", `已重命名为 ${newName.trim()}`);
      } catch (e) {
        useUiStore.getState().addToast("error", `重命名失败：${errText(e)}`);
      }
    },

    deleteNode: async (p, isDir) => {
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

      // 这是全应用唯一会动磁盘的删除动作 → 强制二次确认，且默认焦点落在
      // 「取消」（见 ConfirmDialog：danger 时默认焦点=取消），防回车误伤。
      const { showConfirm } = await import("../components/ConfirmDialog");
      const name = baseName(p);
      const body = isDir
        ? `确定把文件夹“${name}”移入系统回收站吗？\n其中的全部内容会一并移入，可从回收站还原。`
        : `确定把文件“${name}”移入系统回收站吗？\n可从回收站还原。`;
      const ok = await showConfirm({
        title: "移入回收站",
        body,
        confirmLabel: "移入回收站",
        danger: true,
      });
      if (!ok) return;

      try {
        await api.deletePath(p);
        // 最近列表里的这条记录已指向不存在的文件，顺手摘掉
        useRecentStore.getState().remove(p);
        const live = useDocStore.getState().tabs.find((t) => t.path === p);
        if (live) await useDocStore.getState().closeTab(live.id);
        if (get().selectedPath === p) {
          set({ selectedPath: null });
          writeSel(null);
        }
        await get().refresh();
        useUiStore.getState().addToast("success", "已移入回收站");
      } catch (e) {
        useUiStore.getState().addToast("error", `删除失败：${errText(e)}`);
      }
    },

    moveNode: async (p, destDir) => {
      try {
        const next = await api.movePath(p, destDir);
        useDocStore.getState().retargetPath(p, next);
        retargetRecent(p, next);
        if (get().selectedPath === p) {
          set({ selectedPath: next });
          writeSel(next);
        }
        await get().refresh();
        useUiStore.getState().addToast("success", "已移动");
      } catch (e) {
        useUiStore.getState().addToast("error", `移动失败：${errText(e)}`);
      }
    },
  };
});

/** 改名/移动后把最近列表里的旧路径换成新路径（否则记录会指向不存在的文件）。 */
function retargetRecent(oldPath: string, newPath: string) {
  const recent = useRecentStore.getState();
  if (!recent.items.some((r) => r.path === oldPath)) return;
  recent.remove(oldPath);
  recent.push(newPath);
}
