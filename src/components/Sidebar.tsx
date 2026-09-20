// 侧栏（2026-09-12 改版）：自上而下 —— 品牌头 / 细分割线 / 过滤胶囊 /
// 细分割线 / 最近打开文档 / 细分割线 / 文件夹区。
//
// 非破坏红线（用户明确要求）：移除 / 清除类动作绝不碰磁盘。全应用唯一的磁盘
// 删除是树内的「删除」，强制过 ConfirmDialog（默认焦点落在取消）。
//
// （P2-8d 拆分）品牌头在 sidebar/BrandHead，最近列表在 sidebar/RecentList，
// 文件夹区与树在 sidebar/WorkspaceTree + sidebar/Row（Row 的 9 props 已压成
// shared 对象 + node/depth，家族内部 API）；四套右键菜单构造器收进
// hooks/useTreeMenus；剪贴板助手在 lib/clipboard。本文件只留壳编排：
// 重命名状态机、刷新转圈、过滤胶囊与 ContextMenu 挂载。CSS 类名不变。
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useRecentStore } from "../stores/useRecentStore";
import { useTreeMenus } from "../hooks/useTreeMenus";
import BrandHead from "./sidebar/BrandHead";
import RecentList from "./sidebar/RecentList";
import WorkspaceTree from "./sidebar/WorkspaceTree";

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
  const clearFolders = useWorkspaceStore((s) => s.clearFolders);
  const toggleFolderOpen = useWorkspaceStore((s) => s.toggleFolderOpen);
  const renameNode = useWorkspaceStore((s) => s.renameNode);
  const selectFile = useWorkspaceStore((s) => s.selectFile);

  const recent = useRecentStore((s) => s.items);
  const clearRecent = useRecentStore((s) => s.clear);

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

  // ── 菜单构造（四套 + 共用段，见 hooks/useTreeMenus）──
  const { menu, setMenu, recentMenu, folderMenu, nodeMenu, blankMenu } = useTreeMenus({
    folders,
    activePath,
    filterActive,
    startRename,
    doRefresh,
  });

  return (
    <>
      <BrandHead
        filterOpen={filterOpen}
        setFilterOpen={setFilterOpen}
        spinning={spinning}
        doRefresh={doRefresh}
        openWorkspace={openWorkspace}
        folders={folders}
      />

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

      <RecentList
        recent={recent}
        selectedPath={selectedPath}
        selectFile={selectFile}
        clearRecent={clearRecent}
        recentMenu={recentMenu}
      />

      <div className="ws-sep" />

      <WorkspaceTree
        folders={folders}
        activePath={activePath}
        filterActive={filterActive}
        clearFolders={clearFolders}
        openWorkspace={openWorkspace}
        toggleFolderOpen={toggleFolderOpen}
        folderMenu={folderMenu}
        blankMenu={blankMenu}
        rowShared={{
          filterActive,
          renaming,
          onMenu: nodeMenu,
          onStartRename: startRename,
          onCommitRename: commitRename,
          onCancelRename: () => setRenaming(null),
        }}
      />

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
