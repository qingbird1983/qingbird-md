// 侧栏（2026-09-12 改版）：自上而下 —— 品牌头 / 细分割线 / 过滤胶囊 /
// 细分割线 / 最近打开文档 / 细分割线 / 文件夹区。
//
// 品牌头：左侧「Markdown」+ 下方小圆点与版本号；右侧四枚图标钮
// （打开文档 / 打开文件夹 / 筛选 / 刷新），全部接线，title 里带真实快捷键。
// 最近打开：useRecentStore（上限 10 条、跨会话），条目与「清空」都只动列表。
// 文件夹：多文件夹列表，每个可展开成树；「清空」同样只动列表。
//
// 非破坏红线（用户明确要求）：移除 / 清除类动作绝不碰磁盘。全应用唯一的磁盘
// 删除是树内的「删除」，强制过 ConfirmDialog（默认焦点落在取消）。
//
// 菜单上的快捷键提示只写**真实接线过**的键：Ctrl+O / Ctrl+Shift+O / Ctrl+N /
// F5（App.tsx 全局 keydown）、F2 / Del（树行 onKeyDown，见下）。
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Copy,
  Eraser,
  FilePlus2,
  FileText,
  Filter,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  ListX,
  Pencil,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import ContextMenu, { type CtxEntry } from "./ContextMenu";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { parentLabel } from "../lib/wsPath";
import { useWorkspaceStore, type WorkspaceFolder } from "../stores/useWorkspaceStore";
import { useRecentStore, type RecentDoc } from "../stores/useRecentStore";
import { useUiStore } from "../stores/useUiStore";
import { openFile } from "./commands";

// ────────────────────────────── 树 ──────────────────────────────

interface RowProps {
  /** 所属文件夹根（toggleDir 需要它定位是哪一棵树） */
  folderPath: string;
  node: TreeNodeDTO;
  depth: number;
  filterActive: boolean;
  renaming: string | null;
  onMenu: (node: TreeNodeDTO, folderPath: string, x: number, y: number) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}

/** 单个树节点行；dir 点击 toggle 展开，叶点击 selectFile。 */
function Row({
  folderPath,
  node,
  depth,
  filterActive,
  renaming,
  onMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: RowProps) {
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const openDirs = useWorkspaceStore(
    (s) => s.folders.find((f) => f.path === folderPath)?.openDirs,
  );
  const createFileIn = useWorkspaceStore((s) => s.createFileIn);
  const createFolderIn = useWorkspaceStore((s) => s.createFolderIn);
  const p = node.path ?? "";
  const selected = !node.is_dir && !!p && selectedPath === p;
  const isRenaming = renaming === p;
  const indent = 8 + depth * 14;

  const askName = (what: "文件" | "文件夹") =>
    window.prompt(`新${what}名（创建于「${node.name}」内）：`);

  /** 行内键盘：Enter 打开/展开、F2 重命名、Del 删除（走确认框）。 */
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 重命名输入框内的按键交给输入框自己，冒泡上来的一律忽略
    if (isRenaming || !p) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (node.is_dir) toggleDir(folderPath, p);
      else selectFile(p);
    } else if (e.key === "F2") {
      e.preventDefault();
      onStartRename(p);
    } else if (e.key === "Delete") {
      e.preventDefault();
      void deleteNode(p, node.is_dir);
    }
  };

  return (
    <li role="none">
      <div
        className={`tree-row${selected ? " on" : ""}${isRenaming ? " renaming" : ""}`}
        style={{ paddingLeft: indent }}
        role="treeitem"
        aria-expanded={node.is_dir ? filterActive || !!openDirs?.has(p) : undefined}
        aria-selected={selected}
        tabIndex={0}
        onClick={() => {
          if (node.is_dir && p) toggleDir(folderPath, p);
          else if (p) selectFile(p);
        }}
        onKeyDown={onRowKey}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (p) onMenu(node, folderPath, e.clientX, e.clientY);
        }}
      >
        <span className="tree-caret" aria-hidden>
          {node.is_dir ? (
            <ChevronRight
              size={12}
              className={filterActive || openDirs?.has(p) ? "caret-open" : undefined}
            />
          ) : null}
        </span>
        <span className="tree-icon" aria-hidden>
          {node.is_dir ? <Folder size={14} /> : <FileText size={14} />}
        </span>
        {isRenaming ? (
          <input
            className="tree-rename"
            defaultValue={node.name}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onCommitRename(p, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename(p, e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
          />
        ) : (
          <span className="tree-name">{node.name}</span>
        )}
        {/* hover 操作条：目录 = 新建文件/文件夹；文件 = 重命名/删除 */}
        <span className="tree-acts" onClick={(e) => e.stopPropagation()}>
          {node.is_dir ? (
            <>
              <button
                type="button"
                className="tree-act"
                title="新建文件"
                onClick={() => {
                  const n = askName("文件");
                  if (n?.trim()) void createFileIn(p, n.trim());
                }}
              >
                <FilePlus2 size={12} />
              </button>
              <button
                type="button"
                className="tree-act"
                title="新建文件夹"
                onClick={() => {
                  const n = askName("文件夹");
                  if (n?.trim()) void createFolderIn(p, n.trim());
                }}
              >
                <FolderPlus size={12} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="tree-act"
                title="重命名（F2）"
                onClick={() => onStartRename(p)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="tree-act danger"
                title="删除（Del）"
                onClick={() => void deleteNode(p, node.is_dir)}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </span>
      </div>
      {node.is_dir && node.children.length > 0 && (filterActive || openDirs?.has(p)) && (
        <ul className="tree-group">
          {node.children.map((c) => (
            <Row
              key={c.path ?? c.name}
              folderPath={folderPath}
              node={c}
              depth={depth + 1}
              filterActive={filterActive}
              renaming={renaming}
              onMenu={onMenu}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ────────────────────────────── 工具 ──────────────────────────────

/** 复制文本到剪贴板：navigator.clipboard 失败时退回 textarea + execCommand。 */
async function copyText(text: string, what = "路径") {
  const ui = useUiStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    ui.addToast("success", `已复制${what}`);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      ui.addToast("success", `已复制${what}`);
    } catch {
      ui.addToast("error", "复制失败");
    }
  }
}

/** api 调用统一错误提示（路径操作是 IO，失败不能让异常冒到事件处理器外）。 */
async function apiSafe(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    useUiStore.getState().addToast("error", String(e));
  }
}

/** 父目录末级名见 lib/wsPath.parentLabel（有单测）。 */

/** 模板清单（kind 与 Rust workspace::template_body 一致）。 */
const TEMPLATES: Array<{ kind: string; label: string }> = [
  { kind: "blank", label: "空白文档" },
  { kind: "note", label: "读书笔记" },
  { kind: "meeting", label: "会议记录" },
  { kind: "plan", label: "项目计划" },
  { kind: "daily", label: "日报" },
];

// ────────────────────────────── 侧栏 ──────────────────────────────

export default function Sidebar() {
  const folders = useWorkspaceStore((s) => s.folders);
  const activePath = useWorkspaceStore((s) => s.activePath);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const search = useWorkspaceStore((s) => s.search);
  const filterOpen = useWorkspaceStore((s) => s.filterOpen);
  const setFilterOpen = useWorkspaceStore((s) => s.setFilterOpen);
  const searchFilter = useWorkspaceStore((s) => s.searchFilter);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const closeFolder = useWorkspaceStore((s) => s.closeFolder);
  const clearFolders = useWorkspaceStore((s) => s.clearFolders);
  const toggleFolderOpen = useWorkspaceStore((s) => s.toggleFolderOpen);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const createFileIn = useWorkspaceStore((s) => s.createFileIn);
  const createFolderIn = useWorkspaceStore((s) => s.createFolderIn);
  const createFromTemplateIn = useWorkspaceStore((s) => s.createFromTemplateIn);
  const renameNode = useWorkspaceStore((s) => s.renameNode);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);

  const recent = useRecentStore((s) => s.items);
  const removeRecent = useRecentStore((s) => s.remove);
  const clearRecent = useRecentStore((s) => s.clear);

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const filterActive = search.trim() !== "";
  // 重命名提交只在同一次交互里生效一次（blur 与 Enter 可能连发）
  const renameGuard = useRef(false);

  useEffect(() => {
    renameGuard.current = false;
  }, [renaming]);

  const startRename = (p: string) => {
    setMenu(null);
    setRenaming(p);
  };

  const commitRename = (p: string, name: string) => {
    if (renameGuard.current) return;
    renameGuard.current = true;
    setRenaming(null);
    const next = name.trim();
    const cur = p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
    if (next && next !== cur) void renameNode(p, next);
  };

  const doRefresh = async () => {
    if (!folders.length) return;
    setSpinning(true);
    try {
      await refresh();
    } finally {
      // 转够一圈再停：纯视觉反馈，失败与否都停
      window.setTimeout(() => setSpinning(false), 500);
    }
  };

  // ── 菜单构造 ──────────────────────────────────────────────

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

  return (
    <>
      {/* ── 品牌头：左标题 + 版本号，右四枚图标钮 ── */}
      <div className="ws-head">
        <div className="ws-brand">
          <span className="ws-brand-name">Markdown</span>
          <span className="ws-brand-ver">
            <i className="ws-brand-dot" aria-hidden />
            v{__APP_VERSION__}
          </span>
        </div>
        <div className="ws-head-acts">
          <button
            type="button"
            className="ws-icon"
            title="打开文档（Ctrl+O）"
            onClick={() => void openFile()}
          >
            <FileText size={15} />
          </button>
          <button
            type="button"
            className="ws-icon"
            title="打开文件夹（Ctrl+Shift+O）"
            onClick={() => void openWorkspace()}
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            className={`ws-icon${filterOpen ? " on" : ""}`}
            title={filterOpen ? "隐藏过滤框" : "筛选文件"}
            aria-pressed={filterOpen}
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter size={15} />
          </button>
          <button
            type="button"
            className={`ws-icon${spinning ? " spin" : ""}`}
            title="刷新工作区（F5）"
            disabled={!folders.length}
            onClick={() => void doRefresh()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="ws-sep" />

      {/* ── 过滤胶囊（由「筛选」钮开关）── */}
      {filterOpen && (
        <>
          <div className="ws-searchwrap">
            <input
              type="text"
              className="ws-filter"
              placeholder="过滤文件…"
              value={search}
              disabled={!folders.length}
              onChange={(e) => void searchFilter(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="ws-filter-ico clear"
                title="清空过滤"
                onClick={() => void searchFilter("")}
              >
                <X size={13} />
              </button>
            ) : (
              <span className="ws-filter-ico" aria-hidden>
                <Search size={13} />
              </span>
            )}
          </div>
          <div className="ws-sep" />
        </>
      )}

      {/* ── 最近打开文档（记忆，最多 10 条）── */}
      <section className="ws-sec">
        <div className="ws-sec-head">
          <span className="ws-sec-title">最近打开</span>
          <button
            type="button"
            className="ws-sec-clear"
            title="清空最近打开（只清列表，磁盘文件不动）"
            disabled={!recent.length}
            onClick={() => clearRecent()}
          >
            <Eraser size={13} />
          </button>
        </div>
        {recent.length === 0 ? (
          <div className="ws-sec-empty">暂无记录</div>
        ) : (
          <ul className="ws-list">
            {recent.map((r) => (
              <li key={r.path}>
                <div
                  className={`ws-item${selectedPath === r.path ? " on" : ""}`}
                  role="button"
                  tabIndex={0}
                  title={r.path}
                  onClick={() => selectFile(r.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      selectFile(r.path);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    recentMenu(r, e.clientX, e.clientY);
                  }}
                >
                  <FileText size={13} className="ws-item-ico" />
                  <span className="ws-item-name">{r.name}</span>
                  <span className="ws-item-dim">{parentLabel(r.path)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ws-sep" />

      {/* ── 文件夹区 ── */}
      <section className="ws-folders">
        <div className="ws-sec-head">
          <span className="ws-sec-title">文件夹</span>
          <button
            type="button"
            className="ws-sec-clear"
            title="清空文件夹列表（只清列表，磁盘文件不动）"
            disabled={!folders.length}
            onClick={() => clearFolders()}
          >
            <Eraser size={13} />
          </button>
        </div>
        <div
          className="ws-tree-area"
          onContextMenu={(e) => {
            e.preventDefault();
            blankMenu(e.clientX, e.clientY);
          }}
        >
          {folders.length === 0 ? (
            <div className="ws-empty">
              <FolderOpen size={26} strokeWidth={1.4} />
              <p>还没有打开文件夹</p>
              <button
                type="button"
                className="ws-empty-btn"
                onClick={() => void openWorkspace()}
              >
                打开文件夹
              </button>
              <span className="ws-empty-tip">Ctrl+Shift+O</span>
            </div>
          ) : (
            folders.map((f) => {
              const expanded = filterActive || f.open;
              return (
                <div key={f.path} className={`ws-folder${f.error ? " bad" : ""}`}>
                  <div
                    className={`ws-folder-head${activePath === f.path ? " on" : ""}`}
                    role="button"
                    tabIndex={0}
                    title={f.error ? `${f.path}\n${f.error}` : f.path}
                    onClick={() => toggleFolderOpen(f.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        toggleFolderOpen(f.path);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      folderMenu(f, e.clientX, e.clientY);
                    }}
                  >
                    <ChevronRight
                      size={12}
                      className={expanded ? "caret-open" : undefined}
                      aria-hidden
                    />
                    <Folder size={13} aria-hidden />
                    <span className="ws-folder-name">{f.name}</span>
                    {f.error ? <span className="ws-folder-bad">不可用</span> : null}
                  </div>
                  {expanded && !f.error && (
                    <ul className="tree-root" role="tree" aria-label={f.name}>
                      {f.tree.map((n) => (
                        <Row
                          key={n.path ?? n.name}
                          folderPath={f.path}
                          node={n}
                          depth={0}
                          filterActive={filterActive}
                          renaming={renaming}
                          onMenu={nodeMenu}
                          onStartRename={startRename}
                          onCommitRename={commitRename}
                          onCancelRename={() => setRenaming(null)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })
          )}
          {filterActive && folders.length > 0 && folders.every((f) => f.error || !f.tree.length) ? (
            <div className="ws-sec-empty">无匹配项</div>
          ) : null}
        </div>
      </section>

      {menu && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          entries={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
