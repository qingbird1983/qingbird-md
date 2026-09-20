// 侧栏品牌头（P2-8d 自 components/Sidebar.tsx 纯提取）：左标题 + 版本号，
// 右四枚图标钮（打开文档 / 打开文件夹 / 筛选 / 刷新），全部接线，title 里带
// 真实快捷键。刷新的转圈反馈由壳的 doRefresh 驱动。
import { FileText, Filter, FolderOpen, RefreshCw } from "lucide-react";
import { openFile } from "../commands";
import type { WorkspaceFolder } from "../../stores/useWorkspaceStore";

export interface BrandHeadProps {
  filterOpen: boolean;
  setFilterOpen: (v: boolean) => void;
  spinning: boolean;
  doRefresh: () => Promise<void>;
  openWorkspace: () => Promise<void> | void;
  folders: WorkspaceFolder[];
}

export default function BrandHead({
  filterOpen,
  setFilterOpen,
  spinning,
  doRefresh,
  openWorkspace,
  folders,
}: BrandHeadProps) {
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
    </>
  );
}
