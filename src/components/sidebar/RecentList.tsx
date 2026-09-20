// 侧栏「最近打开」区（P2-8d 自 components/Sidebar.tsx 纯提取，JSX 逐字）：
// useRecentStore（上限 10 条、跨会话），条目与「清空」都只动列表（非破坏红线）。
import { Eraser, FileText } from "lucide-react";
import { parentLabel } from "../../lib/wsPath";
import type { RecentDoc } from "../../stores/useRecentStore";

export interface RecentListProps {
  recent: RecentDoc[];
  selectedPath: string | null;
  selectFile: (p: string) => void;
  clearRecent: () => void;
  recentMenu: (r: RecentDoc, x: number, y: number) => void;
}

export default function RecentList({
  recent,
  selectedPath,
  selectFile,
  clearRecent,
  recentMenu,
}: RecentListProps) {
  return (
    /* ── 最近打开文档（记忆，最多 10 条）── */
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
  );
}
