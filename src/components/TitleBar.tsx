// 自定义标题栏（替代 Tauri 原生标题栏）。
//
// 布局：左侧汉堡菜单按钮 ☰ | 中间拖拽区域（data-tauri-drag-region） | 右侧窗控按钮组（最小化/最大化/关闭）。
// 汉堡菜单点击后由 TopBar 的 AppMenu 弹出面板覆盖在下层。
import { useState, useEffect } from "react";
import { Minus, Square, X, Maximize2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    });
    return () => { void unlisten.then((f) => f()); };
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* 左侧：汉堡菜单按钮 —— 由外部 AppMenu 组件在此绝对定位弹出 */}
      <div className="titlebar-left">
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

      {/* 中间拖拽区域 —— data-tauri-drag-region 已在 header 上 */}
      <span className="titlebar-title">青鸟 Markdown</span>

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
