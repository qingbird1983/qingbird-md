// 树行组件（P2-8d 自 components/Sidebar.tsx 纯提取，体逐字）。
// RowProps 的 9 个 props 压成对象：每棵树内不变的 7 项收进 shared，
// 仅 node/depth 逐行变化（本家族内部 API，行为与 DOM 零变化）。
import { ChevronRight, FilePlus2, FileText, Folder, FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { TreeNodeDTO } from "../../types/ipc";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

/** 每棵树内不变的那部分行属性（原 RowProps 除 node/depth 外的 7 项）。 */
export interface RowShared {
  /** 所属文件夹根（toggleDir 需要它定位是哪一棵树） */
  folderPath: string;
  filterActive: boolean;
  renaming: string | null;
  onMenu: (node: TreeNodeDTO, folderPath: string, x: number, y: number) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}

interface RowProps {
  shared: RowShared;
  node: TreeNodeDTO;
  depth: number;
}

/** 单个树节点行；dir 点击 toggle 展开，叶点击 selectFile。 */
function Row({ shared, node, depth }: RowProps) {
  const { folderPath, filterActive, renaming, onMenu, onStartRename, onCommitRename, onCancelRename } = shared;
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
              shared={shared}
              node={c}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default Row;
