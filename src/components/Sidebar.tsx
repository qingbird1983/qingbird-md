// 侧栏：顶部过滤输入 + 工具按钮行（新建文件/文件夹、刷新）+ 工作区树。
// 展开态仅存本地 Set<path>（brief 规范）；搜索激活时强制全展开，
// 让过滤出的叶子直接可见。树行递归渲染，深度由数据结构自然限定。
// 新建名称沿用 FileMenu 同款原生 window.prompt 路线；createFile/Folder
// 在 store 内成功后已自行 refresh + toast，这里不再重复调用。
import { useState } from "react";
import type { TreeNodeDTO } from "../types/ipc";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";

interface RowProps {
  node: TreeNodeDTO;
  depth: number;
  open: boolean;
  filterActive: boolean;
  openSet: Set<string>;
  onToggle: (p: string) => void;
}

/** 单个树节点行；dir 点击 toggle 展开，叶点击 selectFile。 */
function Row({ node, depth, open, filterActive, openSet, onToggle }: RowProps) {
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const p = node.path ?? "";
  const selected = !node.is_dir && !!p && selectedPath === p;
  const indent = 8 + depth * 14;

  return (
    <li role="none">
      <button
        type="button"
        className="tree-row"
        style={{ paddingLeft: indent }}
        role="treeitem"
        aria-expanded={node.is_dir ? open : undefined}
        aria-selected={selected}
        onClick={() => {
          if (node.is_dir && p) onToggle(p);
          else if (p) selectFile(p);
        }}
      >
        <span className="tree-caret">{node.is_dir ? (open ? "▾" : "▸") : ""}</span>
        <span className="tree-icon" aria-hidden>
          {node.is_dir ? "📁" : "📄"}
        </span>
        {node.name}
      </button>
      {node.is_dir && node.children.length > 0 && (open || filterActive) && (
        <ul className="tree-group">
          {node.children.map((c) => (
            <Row
              key={c.path ?? c.name}
              node={c}
              depth={depth + 1}
              open={filterActive || openSet.has(c.path ?? "")}
              filterActive={filterActive}
              openSet={openSet}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Sidebar() {
  const root = useWorkspaceStore((s) => s.root);
  const tree = useWorkspaceStore((s) => s.tree);
  const search = useWorkspaceStore((s) => s.search);
  const searchFilter = useWorkspaceStore((s) => s.searchFilter);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  // 展开态（Set<path>）——只增删不重建，刷新后路径仍在则继续展开
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const filterActive = search.trim() !== "";

  const toggle = (p: string) =>
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <>
      <div className="ws-tools">
        <input
          type="search"
          className="ws-filter"
          placeholder="过滤…"
          value={search}
          onChange={(e) => void searchFilter(e.target.value)}
          disabled={!root}
        />
        <button
          type="button"
          className="menu-btn tool-btn"
          title="新建文件"
          disabled={!root}
          onClick={() => {
            const n = window.prompt("新文件名（创建于工作区根目录）：");
            if (n?.trim()) void createFile(n.trim());
          }}
        >
          ＋📄
        </button>
        <button
          type="button"
          className="menu-btn tool-btn"
          title="新建文件夹"
          disabled={!root}
          onClick={() => {
            const n = window.prompt("新文件夹名（创建于工作区根目录）：");
            if (n?.trim()) void createFolder(n.trim());
          }}
        >
          ＋📁
        </button>
        <button
          type="button"
          className="menu-btn tool-btn"
          title="刷新"
          disabled={!root}
          onClick={() => void refresh()}
        >
          ⟳
        </button>
      </div>

      {!root ? (
        <div className="ws-empty">
          未打开工作区
          <button type="button" className="menu-btn" onClick={() => void openWorkspace()}>
            打开…
          </button>
        </div>
      ) : tree.length === 0 ? (
        <div className="ws-empty">{filterActive ? "无匹配项" : "空目录"}</div>
      ) : (
        <ul className="tree-root" role="tree" aria-label="工作区">
          {tree.map((n) => (
            <Row
              key={n.path ?? n.name}
              node={n}
              depth={0}
              open={!filterActive && openSet.has(n.path ?? "")}
              filterActive={filterActive}
              openSet={openSet}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </>
  );
}
