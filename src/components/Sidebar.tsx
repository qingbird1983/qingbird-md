// 侧栏：顶部过滤输入 + 工具按钮行（新建文件/文件夹、刷新）+ 工作区树。
//
// 2026-09-12 改版（参考同类 Markdown 编辑器的文件树）：
// - 树行 hover 显示操作按钮（目录 = 新建文件/新建文件夹；文件 = 重命名/删除），
//   右键弹出完整菜单（新建/模板/定位/复制路径/终端/移动/重命名/删除）。
// - 展开态与选中项由 workspaceStore 持有并落 localStorage（树记忆，见 store）。
// - 重命名为行内输入：Enter 提交、Esc 取消、失焦提交。
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Copy,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import ContextMenu, { type CtxEntry } from "./ContextMenu";
import type { TreeNodeDTO } from "../types/ipc";
import { api } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore } from "../stores/useUiStore";

interface RowProps {
  node: TreeNodeDTO;
  depth: number;
  open: boolean;
  filterActive: boolean;
  renaming: string | null;
  onMenu: (node: TreeNodeDTO, x: number, y: number) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}

/** 单个树节点行；dir 点击 toggle 展开，叶点击 selectFile。 */
function Row({
  node,
  depth,
  open,
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
  const openDirs = useWorkspaceStore((s) => s.openDirs);
  const createFileIn = useWorkspaceStore((s) => s.createFileIn);
  const createFolderIn = useWorkspaceStore((s) => s.createFolderIn);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const p = node.path ?? "";
  const selected = !node.is_dir && !!p && selectedPath === p;
  const isRenaming = renaming === p;
  const indent = 8 + depth * 14;

  const askName = (what: "文件" | "文件夹") =>
    window.prompt(`新${what}名（创建于「${node.name}」内）：`);

  return (
    <li role="none">
      <div
        className={`tree-row${selected ? " on" : ""}${isRenaming ? " renaming" : ""}`}
        style={{ paddingLeft: indent }}
        role="treeitem"
        aria-expanded={node.is_dir ? open : undefined}
        aria-selected={selected}
        tabIndex={0}
        onClick={() => {
          if (node.is_dir && p) toggleDir(p);
          else if (p) selectFile(p);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (p) onMenu(node, e.clientX, e.clientY);
        }}
      >
        <span className="tree-caret" aria-hidden>
          {node.is_dir ? <ChevronRight size={12} className={open ? "caret-open" : undefined} /> : null}
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
              <button type="button" className="tree-act" title="重命名" onClick={() => onStartRename(p)}>
                <Pencil size={12} />
              </button>
              <button type="button" className="tree-act danger" title="删除" onClick={() => void deleteNode(p)}>
                <Trash2 size={12} />
              </button>
            </>
          )}
        </span>
      </div>
      {node.is_dir && node.children.length > 0 && (open || filterActive) && (
        <ul className="tree-group">
          {node.children.map((c) => (
            <Row
              key={c.path ?? c.name}
              node={c}
              depth={depth + 1}
              open={filterActive || openDirs.has(c.path ?? "")}
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

/** 复制文本到剪贴板：navigator.clipboard 失败时退回 textarea + execCommand。 */
async function copyText(text: string) {
  const ui = useUiStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    ui.addToast("success", "已复制路径");
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
      ui.addToast("success", "已复制路径");
    } catch {
      ui.addToast("error", "复制失败");
    }
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

export default function Sidebar() {
  const root = useWorkspaceStore((s) => s.root);
  const tree = useWorkspaceStore((s) => s.tree);
  const search = useWorkspaceStore((s) => s.search);
  const searchFilter = useWorkspaceStore((s) => s.searchFilter);
  const openDirs = useWorkspaceStore((s) => s.openDirs);
  const createFileIn = useWorkspaceStore((s) => s.createFileIn);
  const createFolderIn = useWorkspaceStore((s) => s.createFolderIn);
  const createFromTemplateIn = useWorkspaceStore((s) => s.createFromTemplateIn);
  const renameNode = useWorkspaceStore((s) => s.renameNode);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const moveNode = useWorkspaceStore((s) => s.moveNode);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
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

  /** 菜单项：在 dir（文件则其父目录）内新建。 */
  const newFileEntries = (dir: string): CtxEntry[] => {
    const dirName = dir.slice(Math.max(dir.lastIndexOf("\\"), dir.lastIndexOf("/")) + 1) || dir;
    return [
      {
        label: "新建文件",
        icon: <FilePlus2 size={14} />,
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

  const nodeMenu = (node: TreeNodeDTO, x: number, y: number) => {
    const p = node.path ?? "";
    const dir = node.is_dir ? p : p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
    const entries: CtxEntry[] = [
      node.is_dir
        ? {
            label: openDirs.has(p) ? "折叠" : "展开",
            icon: <FolderOpen size={14} />,
            onSelect: () => useWorkspaceStore.getState().toggleDir(p),
          }
        : {
            label: "打开",
            icon: <FileText size={14} />,
            onSelect: () => useWorkspaceStore.getState().selectFile(p),
          },
      { kind: "sep" },
      ...newFileEntries(dir),
      { kind: "sep" },
      {
        label: "打开文件位置",
        icon: <FolderSearch size={14} />,
        onSelect: () => void apiSafe(() => api.revealPath(p)),
      },
      {
        label: "复制文件路径",
        icon: <Copy size={14} />,
        onSelect: () => void copyText(p),
      },
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
            if (dest) await moveNode(p, dest);
          })();
        },
      },
      { label: "重命名", icon: <Pencil size={14} />, onSelect: () => startRename(p) },
      {
        label: "删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => void deleteNode(p),
      },
    ];
    setMenu({ x, y, entries });
  };

  const rootMenu = (x: number, y: number) => {
    if (!root) {
      setMenu({
        x,
        y,
        entries: [
          { label: "打开文件夹…", icon: <FolderOpen size={14} />, onSelect: () => void openWorkspace() },
        ],
      });
      return;
    }
    setMenu({
      x,
      y,
      entries: [
        ...newFileEntries(root),
        { kind: "sep" },
        { label: "刷新", icon: <RefreshCw size={14} />, onSelect: () => void refresh() },
        {
          label: "打开文件位置",
          icon: <FolderSearch size={14} />,
          onSelect: () => void apiSafe(() => api.revealPath(root)),
        },
        { label: "复制工作区路径", icon: <Copy size={14} />, onSelect: () => void copyText(root) },
        {
          label: "在此打开终端",
          icon: <Terminal size={14} />,
          onSelect: () => void apiSafe(() => api.openTerminal(root)),
        },
      ],
    });
  };

  return (
    <>
      {/* 分区标题 + 工具行：标题「工作区」，右侧切换工作区入口 */}
      <div className="sb-title">
        工作区
        <button type="button" className="sb-action" onClick={() => void openWorkspace()}>
          {root ? "切换…" : "打开…"}
        </button>
      </div>
      <div className="ws-tools">
        <input
          type="search"
          className="ws-filter"
          placeholder="过滤文件…"
          value={search}
          onChange={(e) => void searchFilter(e.target.value)}
          disabled={!root}
        />
        <button
          type="button"
          className="tool-btn"
          title="新建文件"
          disabled={!root}
          onClick={() => {
            const n = window.prompt("新文件名（创建于工作区根目录）：", "未命名.md");
            if (n?.trim()) void createFileIn(null, n.trim());
          }}
        >
          <FilePlus2 size={15} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="新建文件夹"
          disabled={!root}
          onClick={() => {
            const n = window.prompt("新文件夹名（创建于工作区根目录）：");
            if (n?.trim()) void createFolderIn(null, n.trim());
          }}
        >
          <FolderPlus size={15} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="刷新"
          disabled={!root}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* 树区：空白处右键 = 根菜单（未打开工作区时也能从菜单里打开） */}
      <div className="ws-tree-area" onContextMenu={(e) => { e.preventDefault(); rootMenu(e.clientX, e.clientY); }}>
        {!root ? (
          <div className="ws-empty">
            <FolderOpen size={26} strokeWidth={1.4} />
            <p>还没有打开文件夹</p>
            <button type="button" className="ws-empty-btn" onClick={() => void openWorkspace()}>
              打开文件夹
            </button>
            <span className="ws-empty-tip">Ctrl+Shift+O</span>
          </div>
        ) : tree.length === 0 ? (
          <div className="ws-empty">
            <p>{filterActive ? "无匹配项" : "空目录"}</p>
          </div>
        ) : (
          <ul className="tree-root" role="tree" aria-label="工作区">
            {tree.map((n) => (
              <Row
                key={n.path ?? n.name}
                node={n}
                depth={0}
                open={!filterActive && openDirs.has(n.path ?? "")}
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

      {menu && (
        <ContextMenu anchor={{ x: menu.x, y: menu.y }} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

// api 调用统一错误提示（路径操作是 IO，失败不能让异常冒到事件处理器外）
async function apiSafe(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    useUiStore.getState().addToast("error", String(e));
  }
}
