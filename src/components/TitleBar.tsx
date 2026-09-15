// 自定义标题栏（替代 Tauri 原生标题栏）。
//
// 布局：左侧 朱砂印章钮（hover 显工作区开关图标，点击 toggleNav——logo 与开关
// 二合一，DESIGN.md §4）+ 衬线品牌名 + 汉堡菜单按钮 ☰ |（标题栏中部不再放
// 文档名——文档名走 TabBar 即可，避免重复占位）| 右侧窗控按钮组。
// 汉堡菜单点击后由 AppMenu 弹出二级分类面板覆盖在下层。
import { useState, useEffect, useRef } from "react";
import { Minus, Square, X, Maximize2, Moon, PanelLeft, Settings, Sun } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sysDark, useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore, INTRO_FROM_WIDTH } from "../stores/useUiStore";
import TabBar from "./TabBar";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const showNav = useUiStore((s) => s.showNav);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  // 启动动画起始态：工作区在屏幕上是 480 宽，标签条要跟那条可见分割线对齐，
  // 而不是跟 store 里已实测出的终态最小宽。开演那一帧二者一起切回，margin 与
  // 面板宽度共用 --panel-anim 过渡，天然同步滑回。
  const introArmed = useUiStore((s) => s.introPhase) === "idle";
  const effShowNav = introArmed || showNav;
  const effSidebarWidth = introArmed ? INTRO_FROM_WIDTH : sidebarWidth;
  // ── 标签条起点跟随工作区分割线 ──
  // 下方工作区右缘分割线的窗口 x = sidebarWidth + 7（col1 面板 + col2 resizer 热区，
  // 7px 与 global.css .app-resizer 宽度一致，见下方 RESIZER_W）。标签条左缘 =
  // max(分割线x, 标题栏分割线x)：工作区拉宽标签条跟着右移（与主区左缘对齐），
  // 拉窄到最小宽度（见下）或隐藏时归位到分割线右侧的静止位。位移差用 margin-left
  // 实现，过渡时长与面板收展动画一致（--panel-anim），视觉同步滑动。
  const leftRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLSpanElement>(null);
  const [baseX, setBaseX] = useState(0);
  // baseX = 标题栏分割线右缘（titlebar 已 position:relative，offsetLeft 即窗口系 x）
  const measure = () => {
    const d = dividerRef.current;
    if (d) setBaseX(d.offsetLeft + d.offsetWidth);
  };
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (leftRef.current) ro.observe(leftRef.current);
    return () => ro.disconnect();
  }, []);
  // 补偿：divider 流内还有 margin-right 8px（把 TabBar 往右推），tabbar 自身
  // padding-left 2px（第一个标签再右移）——合计 10px；再加 1px 视觉微调
  // （offsetLeft 整数舍入 + 分割线右缘 vs 线体中心的感知差），共 11px。
  const TAB_ALIGN_COMPENSATION = 11;
  // 左侧拖宽条热区宽度，须与 global.css `.app-resizer { width }` 一致：
  // 工作区分割线由 `.app-resizer.res-left::before`（left:auto / right:0 / 1px）
  // 贴其右缘绘制，故线体 = [sidebarWidth + RESIZER_W - 1, sidebarWidth + RESIZER_W)。
  const RESIZER_W = 7;
  const tabMargin = effShowNav
    ? Math.max(0, effSidebarWidth + RESIZER_W - baseX - TAB_ALIGN_COMPENSATION)
    : 0;

  // ── 工作区最小宽度：让上下两条竖线共线 ──
  // 标题栏分割线线体 = [baseX - 1, baseX)，工作区分割线线体 =
  // [sidebarWidth + RESIZER_W - 1, sidebarWidth + RESIZER_W)。令右缘相等即
  // sidebarWidth = baseX - RESIZER_W，此时两条 1px 竖线在窗口纵向上连成一条直线
  // （2026-09-12 修正：原式 `baseX + 11 - 7` 会让最窄时下方分割线比上方那条右移
  // 11px，看起来错位）。
  // 代价：sidebarWidth ∈ [baseX - 7, baseX + 4] 这 11px 区间内 tabMargin 恒为 0，
  // 标签条停在「分割线右侧」的静止位、不再跟着线左移。这是共线必须付的代价，且
  // 静止位下标签条左缘距线 8px，与标题栏那一行（divider margin-right 8px）同规格。
  // 全新安装的首屏宽度：侧栏直接落在上面这个最小宽度上（首启即「最窄 + 共线」形态）。
  // 「只做一次」由 store 侧保证——applyDefaultSidebarWidth 自带 bootWidthPending
  // 门，用户拖拽 / 休眠快照回填都会关门；这里重复调用（字体加载引发的重测）是空操作。
  useEffect(() => {
    if (baseX <= 0) return;
    const min = baseX - RESIZER_W;
    useUiStore.getState().setMinSidebarWidth(min);
    useUiStore.getState().applyDefaultSidebarWidth(min);
  }, [baseX]);
  // 明暗主题按钮（自 EditorToolbar 搬入）：解析后的明暗态仅决定图标/提示，
  // 切换走 setTheme；sysMatches 订阅让 auto 档随系统变化时图标实时刷新。
  const theme = useSettingsStore((s) => s.theme);
  const [sysMatches, setSysMatches] = useState(sysDark.matches);
  useEffect(() => {
    const f = () => setSysMatches(sysDark.matches);
    sysDark.addEventListener("change", f);
    return () => sysDark.removeEventListener("change", f);
  }, []);
  const dark = theme === "dark" || (theme !== "light" && sysMatches);

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
      {/* 左侧：印章品牌钮（含工作区开关）+ 品牌名 + 汉堡菜单 —— AppMenu 在汉堡按钮下方绝对定位弹出 */}
      <div className="titlebar-left" ref={leftRef}>
        <button
          type="button"
          className="menu-btn seal-btn"
          id="app-ws-toggle"
          aria-label={showNav ? "隐藏工作区" : "显示工作区"}
          title={showNav ? "隐藏工作区" : "显示工作区"}
          onClick={() => toggleNav()}
        >
          {/* 双层：默认朱砂「青」印，hover 淡出、原位浮现开关图标（CSS .seal-btn） */}
          <span className="seal-face" aria-hidden="true">青</span>
          <span className="seal-ico" aria-hidden="true">
            <PanelLeft size={15} strokeWidth={2} />
          </span>
        </button>
        <span className="titlebar-brand">
          <span>青鸟 Markdown</span>
        </span>
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
      <span className="titlebar-divider" aria-hidden="true" ref={dividerRef} />

      {/* 中部：标签条（已并入标题栏）。tab 元素带 role="tab"、关闭/新建按钮为
          button，均属 Tauri drag-region 的 clickable 元素 → 点击不触发窗口拖动；
          标签条的空白处（无标签/尾部空隙）才作为可拖拽区域，满足「按住菜单栏
          自由拖动窗口」。
          marginLeft：标签条起点跟随下方工作区分割线（拉宽右移、过窄归位）。 */}
      <TabBar style={{ marginLeft: tabMargin }} />

      {/* 右侧窗控按钮；最前为明暗主题切换 + 设置入口（与窗控同款 win-btn 样式） */}
      <div className="window-controls">
        <button
          type="button"
          className="win-btn"
          title={`切换明暗主题（当前${dark ? "暗色" : "亮色"}）`}
          onClick={() => useSettingsStore.getState().setTheme(dark ? "light" : "dark")}
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button
          type="button"
          className="win-btn"
          title="设置"
          aria-label="设置"
          onClick={() => useUiStore.getState().openSettings()}
        >
          <Settings size={14} />
        </button>
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
