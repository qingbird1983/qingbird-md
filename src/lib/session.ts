// 休眠快照收集：把当前会话压成一份可落盘的 SessionSnapshot。
//
// 只落「脏 tab 的 content + 干净 tab 的 path」：解析结果可由 content 重算
// （ensureParsed 的 contentKey 比对天然失效重算），翻译结果走 Rust 侧磁盘缓存，
// 落盘性价比低且会让草稿文件体积失控。
//
// 依赖方向：本模块读 store，store 不读本模块（恢复逻辑在 useDocStore 内，
// 避免循环 import）。
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import type { SessionSnapshot, SessionTab } from "../types/ipc";

/** 与 hibernate.rs SESSION_VERSION 一致；改动须同步。 */
export const SESSION_VERSION = 1;

/** 同步读 store 组装快照。无 await：休眠握手的 3s 超时不等异步。 */
export function collectSnapshot(): SessionSnapshot {
  const d = useDocStore.getState();
  const ui = useUiStore.getState();
  const tabs: SessionTab[] = d.tabs.map((t) => ({
    id: t.id,
    path: t.path,
    name: t.name,
    // 干净 tab 不落内容，重建时从 path 重读（省体积，也避免覆盖磁盘新版本）
    content: t.content !== t.savedContent ? t.content : null,
    mtime: t.mtime,
    encoding: t.encoding,
    view: t.view,
    mode: t.mode,
    cursor_sel: [t.cursorSel[0], t.cursorSel[1]] as [number, number],
    scroll_top: t.scrollTop,
  }));
  return {
    version: SESSION_VERSION,
    saved_at: Date.now(),
    tabs,
    active_id: d.activeId,
    // 会话快照只带「活动文件夹」一个根（字段名与 Rust 契约不变）；完整的多文件夹
    // 列表由前端 localStorage 自行恢复（见 useWorkspaceStore.restoreFolders）。
    workspace_root: useWorkspaceStore.getState().activePath,
    ui: {
      show_nav: ui.showNav,
      show_outline: ui.showOutline,
      sidebar_width: ui.sidebarWidth,
      outline_width: ui.outlineWidth,
      split_ratio: ui.splitRatio,
    },
  };
}

/** 草稿 tab 数；>0 表示恢复后要提示「已恢复上次未保存的内容」。 */
export function dirtyCount(snap: SessionSnapshot): number {
  return snap.tabs.filter((t) => t.content !== null).length;
}
