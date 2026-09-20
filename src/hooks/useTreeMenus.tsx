// 侧栏四套右键菜单的构造器（P2-8d 自 components/Sidebar.tsx 纯提取）：
// recentMenu（最近条目）/ folderMenu（文件夹头）/ nodeMenu（树行）/ blankMenu
// （文件夹区空白），共用段 newFileEntries 与模板清单也在本文件内。
// 菜单项与快捷键提示逐字保留——只写真实接线过的键（Ctrl+O / Ctrl+Shift+O /
// Ctrl+N / F5 / F2 / Del），非破坏红线（移除/清除绝不碰磁盘）不动。
// 注：菜单项 icon 是 JSX 字面量，故扩展名为 .tsx（处方原文 .ts 的最小等价处理）。
import { useState } from "react";
import {
  Copy,
  Eraser,
  FilePlus2,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  ListX,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import type { CtxEntry } from "../components/ContextMenu";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { copyText } from "../lib/clipboard";
import type { WorkspaceFolder } from "../stores/useWorkspaceStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useRecentStore, type RecentDoc } from "../stores/useRecentStore";
import { useUiStore } from "../stores/useUiStore";

/** api 调用统一错误提示（路径操作是 IO，失败不能让异常冒到事件处理器外）。 */
async function apiSafe(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    useUiStore.getState().addToast("error", String(e));
  }
}

/** 模板清单（kind 与 Rust workspace::template_body 一致）。 */
const TEMPLATES: Array<{ kind: string; label: string }> = [
  { kind: "blank", label: "空白文档" },
  { kind: "note", label: "读书笔记" },
  { kind: "meeting", label: "会议记录" },
  { kind: "plan", label: "项目计划" },
  { kind: "daily", label: "日报" },
];

/** 组件态依赖：菜单构造器需要的壳侧值与回调（动作类由 hook 自行订阅）。 */
export interface TreeMenusDeps {
  folders: WorkspaceFolder[];
  activePath: string | null;
  filterActive: boolean;
  startRename: (p: string) => void;
  doRefresh: () => Promise<void>;
}

export function useTreeMenus(deps: TreeMenusDeps) {
  const { folders, activePath, filterActive, startRename, doRefresh } = deps;
  const createFileIn = useWorkspaceStore((s) => s.createFileIn);
  const createFolderIn = useWorkspaceStore((s) => s.createFolderIn);
  const createFromTemplateIn = useWorkspaceStore((s) => s.createFromTemplateIn);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const closeFolder = useWorkspaceStore((s) => s.closeFolder);
  const clearFolders = useWorkspaceStore((s) => s.clearFolders);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const removeRecent = useRecentStore((s) => s.remove);
  const clearRecent = useRecentStore((s) => s.clear);

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(null);

  /** 菜单项：在 dir（文件则其父目录）内新建。 */
  const newFileEntries = (dir: string, withHotkey: boolean): CtxEntry[] => {
    const dirName = dir.slice(Math.max(dir.lastIndexOf("\\"), dir.lastIndexOf("/")) + 1) || dir;
    return [
      {
        label: "新建文件",
        icon: <FilePlus2 size={14} />,
        // Ctrl+N 恒落在「活动文件夹」根；只有目标就是活动文件夹时才敢标出来
        shortcut: withHotkey ? "Ctrl+N" : undefined,
        onSelect: () => {
          const n = window.prompt(`新文件名（创建于「${dirName}」）：`, "未命名.md");
          if (n?.trim()) void createFileIn(dir, n.trim());
        },
      },
      {
        label: "从模板新建",
        icon: <FolderInput size={14} />,
        children: TEMPLATES.map((t) => ({
          label: t.label,
          onSelect: () => {
            const n = window.prompt(`新文件名（${t.label}）：`, t.label);
            if (n?.trim()) void createFromTemplateIn(dir, n.trim(), t.kind);
          },
        })),
      },
      {
        label: "新建文件夹",
        icon: <FolderPlus size={14} />,
        onSelect: () => {
          const n = window.prompt(`新文件夹名（创建于「${dirName}」）：`);
          if (n?.trim()) void createFolderIn(dir, n.trim());
        },
      },
    ];
  };

  /** 最近打开条目的菜单：全部非破坏（移除只动列表）。 */
  const recentMenu = (r: RecentDoc, x: number, y: number) => {
    setMenu({
      x,
      y,
      entries: [
        {
          label: "打开",
          icon: <FileText size={14} />,
          shortcut: "Enter",
          onSelect: () => selectFile(r.path),
        },
        { kind: "sep" },
        { label: "复制文件路径", icon: <Copy size={14} />, onSelect: () => void copyText(r.path) },
        {
          label: "打开文件位置",
          icon: <FolderSearch size={14} />,
          onSelect: () => void apiSafe(() => api.revealPath(r.path)),
        },
        { kind: "sep" },
        {
          label: "从列表移除",
          icon: <ListX size={14} />,
          danger: true,
          onSelect: () => removeRecent(r.path),
        },
        {
          label: "清空最近打开",
          icon: <Eraser size={14} />,
          danger: true,
          onSelect: () => clearRecent(),
        },
      ],
    });
  };

  /** 文件夹条目菜单：第一段是新建（落在这个文件夹），末段全是非破坏移除。 */
  const folderMenu = (f: WorkspaceFolder, x: number, y: number) => {
    setActive(f.path); // 让 Ctrl+N 的落点与这份菜单的「新建文件」一致
    setMenu({
      x,
      y,
      entries: [
        ...newFileEntries(f.path, true),
        { kind: "sep" },
        {
          label: "刷新",
          icon: <RefreshCw size={14} />,
          shortcut: "F5",
          onSelect: () => void refresh(f.path),
        },
        {
          label: "在资源管理器中显示",
          icon: <FolderSearch size={14} />,
          onSelect: () => void apiSafe(() => api.revealPath(f.path)),
        },
        { label: "复制文件夹路径", icon: <Copy size={14} />, onSelect: () => void copyText(f.path) },
        {
          label: "在此打开终端",
          icon: <Terminal size={14} />,
          onSelect: () => void apiSafe(() => api.openTerminal(f.path)),
        },
        { kind: "sep" },
        {
          label: "从列表移除",
          icon: <ListX size={14} />,
          danger: true,
          onSelect: () => closeFolder(f.path),
        },
        {
          label: "清空文件夹列表",
          icon: <Eraser size={14} />,
          danger: true,
          onSelect: () => clearFolders(),
        },
      ],
    });
  };

  const nodeMenu = (node: TreeNodeDTO, folderPath: string, x: number, y: number) => {
    const p = node.path ?? "";
    const dir = node.is_dir
      ? p
      : p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
    const openDirs = folders.find((f) => f.path === folderPath)?.openDirs;
    const entries: CtxEntry[] = [
      node.is_dir
        ? {
            label: filterActive || openDirs?.has(p) ? "折叠" : "展开",
            icon: <FolderOpen size={14} />,
            onSelect: () => toggleDir(folderPath, p),
          }
        : {
            label: "打开",
            icon: <FileText size={14} />,
            shortcut: "Enter",
            onSelect: () => selectFile(p),
          },
      { kind: "sep" },
      // 这里的「新建」落在右键的那个目录里，与 Ctrl+N（活动文件夹根）不同 → 不标键
      ...newFileEntries(dir, false),
      { kind: "sep" },
      {
        label: "在资源管理器中显示",
        icon: <FolderSearch size={14} />,
        onSelect: () => void apiSafe(() => api.revealPath(p)),
      },
      { label: "复制文件路径", icon: <Copy size={14} />, onSelect: () => void copyText(p) },
      {
        label: "在此打开终端",
        icon: <Terminal size={14} />,
        onSelect: () => void apiSafe(() => api.openTerminal(p)),
      },
      { kind: "sep" },
      {
        label: "移动到…",
        icon: <FolderInput size={14} />,
        onSelect: () => {
          void (async () => {
            const dest = await api.pickFolder();
            if (dest) await useWorkspaceStore.getState().moveNode(p, dest);
          })();
        },
      },
      {
        label: "重命名",
        icon: <Pencil size={14} />,
        shortcut: "F2",
        onSelect: () => startRename(p),
      },
      {
        label: "删除",
        icon: <Trash2 size={14} />,
        shortcut: "Del",
        danger: true,
        onSelect: () => void deleteNode(p, node.is_dir),
      },
    ];
    setMenu({ x, y, entries });
  };

  /** 文件夹区空白处：新建 + 刷新；没有文件夹时只给「打开文件夹」。 */
  const blankMenu = (x: number, y: number) => {
    if (!folders.length) {
      setMenu({
        x,
        y,
        entries: [
          {
            label: "打开文件夹…",
            icon: <FolderOpen size={14} />,
            shortcut: "Ctrl+Shift+O",
            onSelect: () => void openWorkspace(),
          },
        ],
      });
      return;
    }
    const anchor = activePath ?? folders[0].path;
    setMenu({
      x,
      y,
      entries: [
        ...newFileEntries(anchor, true),
        { kind: "sep" },
        {
          label: "刷新",
          icon: <RefreshCw size={14} />,
          shortcut: "F5",
          onSelect: () => void doRefresh(),
        },
        {
          label: "打开文件夹…",
          icon: <FolderOpen size={14} />,
          shortcut: "Ctrl+Shift+O",
          onSelect: () => void openWorkspace(),
        },
        {
          label: "复制文件夹路径",
          icon: <Copy size={14} />,
          onSelect: () => void copyText(anchor),
        },
        {
          label: "在资源管理器中显示",
          icon: <FolderSearch size={14} />,
          onSelect: () => void apiSafe(() => api.revealPath(anchor)),
        },
        { kind: "sep" },
        {
          label: "清空文件夹列表",
          icon: <Eraser size={14} />,
          danger: true,
          onSelect: () => clearFolders(),
        },
      ],
    });
  };

  return { menu, setMenu, recentMenu, folderMenu, nodeMenu, blankMenu };
}
