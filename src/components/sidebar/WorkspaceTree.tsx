// 侧栏「文件夹区」（P2-8d 自 components/Sidebar.tsx 纯提取，JSX 逐字）：
// 多文件夹列表，每个可展开成树；空白处右键走 blankMenu，文件夹头走 folderMenu，
// 树行走 nodeMenu。展开/高亮/错误标记的渲染条件零变化。
import { ChevronRight, Eraser, Folder, FolderOpen } from "lucide-react";
import type { WorkspaceFolder } from "../../stores/useWorkspaceStore";
import Row, { type RowShared } from "./Row";

/** 每棵树不变的行属性（folderPath 由树自己填——同前）。 */
type TreeRowShared = Omit<RowShared, "folderPath">;

export interface WorkspaceTreeProps {
  folders: WorkspaceFolder[];
  activePath: string | null;
  filterActive: boolean;
  clearFolders: () => void;
  openWorkspace: () => Promise<void> | void;
  toggleFolderOpen: (path: string) => void;
  folderMenu: (f: WorkspaceFolder, x: number, y: number) => void;
  blankMenu: (x: number, y: number) => void;
  /** 传给每棵树所有 Row 的不变属性包（本家族内部 API；folderPath 逐树填充）。 */
  rowShared: TreeRowShared;
}

export default function WorkspaceTree({
  folders,
  activePath,
  filterActive,
  clearFolders,
  openWorkspace,
  toggleFolderOpen,
  folderMenu,
  blankMenu,
  rowShared,
}: WorkspaceTreeProps) {
  return (
    /* ── 文件夹区 ── */
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
                        shared={{ ...rowShared, folderPath: f.path }}
                        node={n}
                        depth={0}
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
  );
}
