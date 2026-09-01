// 自定义标题栏（替代 Tauri 原生标题栏）。
//
// 布局：左侧 应用名 + 工作区切换按钮（PanelLeft 图标）+ 汉堡菜单按钮 ☰ |（标题栏中部不再放文档名——文档名走 TabBar 即可，避免重复占位）| 右侧窗控按钮组（最小化/最大化/关闭）。
// 汉堡菜单点击后由 AppMenu 弹出二级分类面板覆盖在下层。
// 工作区切换按钮：图标为 lucide PanelLeft（方框内偏左一根竖线），toggleNav
// 控制 showNav；隐藏工作区时本按钮依旧留在标题栏可见——视觉锚点不丢。
import { useState, useEffect } from "react";
import { Minus, Square, X, Maximize2, PanelLeft } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiStore } from "../stores/useUiStore";
import TabBar from "./TabBar";
import qingniaoLogo from "../assets/qingniao-logo.png";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const showNav = useUiStore((s) => s.showNav);
  const toggleNav = useUiStore((s) => s.toggleNav);

  useEffect(() => {
    void appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    });
    return () => { void unlisten.then((f) => f()); };
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      {/* deep：tauri drag.js 的 composedPath 检测要求点击目标带属性或祖先为
          deep——裸属性只有正中标题穿透带（title span pe:none）能拖，应用名/
          窗控间隙落在无属性子 div 上全部失效。deep 让整个标题栏子树可拖，
          BUTTON 类（工作区切换/汉堡/窗控）仍自动豁免走自身点击。 */}
      {/* 左侧：应用名 + 工作区切换按钮 + 汉堡菜单按钮 —— AppMenu 在汉堡按钮下方绝对定位弹出 */}
      <div className="titlebar-left">
        <span className="titlebar-brand">
          <img src={qingniaoLogo} className="titlebar-logo" alt="青鸟" />
          <span>Markdown</span>
        </span>
        <button
          type="button"
          className="menu-btn ws-toggle-btn"
          id="app-ws-toggle"
          aria-label={showNav ? "隐藏工作区" : "显示工作区"}
          title={showNav ? "隐藏工作区" : "显示工作区"}
          onClick={() => toggleNav()}
        >
          {/* PanelLeft：方框 + 偏左竖线（lucide rect rx=2 + M9 3v18 内部竖线） */}
          <PanelLeft size={18} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="menu-btn hamburger-btn"
          id="app-hamburger"
          aria-label="菜单"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>

      {/* 汉堡按钮之后的竖向分割线：分隔左侧「应用名/工作区切换/菜单」与标签条。
          aria-hidden 纯装饰；非 BUTTON，位于 deep 拖拽区但空白处可拖窗，不影响
          两侧 button 的豁免。 */}
      <span className="titlebar-divider" aria-hidden="true" />

      {/* 中部：标签条（已并入标题栏）。tab 元素带 role="tab"、关闭/新建按钮为
          button，均属 Tauri drag-region 的 clickable 元素 → 点击不触发窗口拖动；
          标签条的空白处（无标签/尾部空隙）才作为可拖拽区域，满足「按住菜单栏
          自由拖动窗口」。 */}
      <TabBar />

      {/* 右侧窗控按钮 */}
      <div className="window-controls">
        <button
          type="button"
          className="win-btn"
          title="最小化"
          onClick={() => void appWindow.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className="win-btn"
          title={maximized ? "还原" : "最大化"}
          onClick={() => {
            if (maximized) { void appWindow.unmaximize(); }
            else { void appWindow.maximize(); }
          }}
        >
          {maximized ? <Square size={12} /> : <Maximize2 size={14} />}
        </button>
        <button
          type="button"
          className="win-btn win-close"
          title="关闭"
          onClick={() => void appWindow.close()}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
