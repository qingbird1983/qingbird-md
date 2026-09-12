import { type PointerEvent as ReactPointerEvent, type CSSProperties, useEffect, useState } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";
import { useUiStore } from "./stores/useUiStore";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import AppMenu from "./components/AppMenu";
import EditorToolbar from "./components/EditorToolbar";
import MainArea from "./components/MainArea";
import Sidebar from "./components/Sidebar";
import OutlinePanel from "./components/OutlinePanel";
import SelectionPopup from "./components/SelectionPopup";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/ToastContainer";
import { openFile } from "./components/commands";
import { comboMatches } from "./lib/hotkeys";
import { startColDrag } from "./lib/colDrag";
import { api } from "./lib/ipc";
import { collectSnapshot } from "./lib/session";

// 面板宽度钳制：左右栏与主区之间拖宽条的取值范围（默认 240/200 落在其中）
const PANEL_MIN = 160;
const PANEL_MAX = 480;

// 面板收展过渡时长：与 global.css 的 --panel-anim 保持一致。--col-main 的
// 切换必须等收起动画播完（否则主区提前跨列会盖住正在收缩的面板），所以
// JS 侧比 CSS 略长 40ms 兜底。
const PANEL_ANIM_MS = 340;

/** 延迟确认：hidden 变 true 后等 ms 再返回 true（展开时立即 false）。
 *  用于把「主区跨列吸收空列」推迟到面板宽度过渡播完之后。 */
function useSettled(hidden: boolean, ms: number) {
  const [settled, setSettled] = useState(hidden);
  useEffect(() => {
    if (!hidden) {
      setSettled(false);
      return;
    }
    const t = window.setTimeout(() => setSettled(true), ms);
    return () => window.clearTimeout(t);
  }, [hidden, ms]);
  return settled;
}

// 休眠握手（docs/webview-hibernate-plan.md 步骤 6）：关窗后空闲 5 分钟，Rust
// 侧下发 session-hibernate，前端同步收集快照落盘再回 hibernateReady，随后
// WebView 被销毁。Rust 只等 3s，超时就强杀（内存释放优先于草稿完整性），
// 因此这里必须快：collectSnapshot 全同步，只有在等 IPC 返回。
let hibernateRegistered = false;
function listenHibernateOnce() {
  if (hibernateRegistered) return; // 防 StrictMode 双跑重复注册
  hibernateRegistered = true;
  void api.listenHibernate(async () => {
    try {
      await api.saveSession(collectSnapshot());
      await api.hibernateReady();
    } catch (e) {
      // 落盘失败也要回 ready：让 Rust 立刻销毁，别白等那 3 秒超时。
      console.error("[hibernate] 保存会话快照失败:", e);
      await api.hibernateReady().catch(() => {});
    }
  });
}

// 面板拖宽条：与主区 SplitBody 中缝共用 lib/colDrag 的纯 Pointer Events 拖拽。
// place 决定「条贴在哪块面板的哪条边」，同时决定拖拽方向的符号：
// - sidebar：贴文件栏右缘，右拖增宽（+dx）
// - outline-right：贴大纲栏（右停靠）左缘，左拖增宽（-dx）
// - outline-left：贴大纲栏（左停靠）右缘，右拖增宽（+dx）
// 宽度存 uiStore，跨视图切换保持。
type ResizerPlace = "sidebar" | "outline-right" | "outline-left";

function PanelResizer({ place, hidden }: { place: ResizerPlace; hidden: boolean }) {
  const cls =
    place === "sidebar" ? "res-left" : place === "outline-left" ? "res-olutl" : "res-right";
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = useUiStore.getState();
    const toSidebar = place === "sidebar";
    const startW = toSidebar ? st.sidebarWidth : st.outlineWidth;
    // 左侧下限动态（标签条归位临界，TitleBar 实测写入 store，兜底 PANEL_MIN）；
    // 大纲面板无对齐诉求，保持静态下限。
    const min = toSidebar ? Math.max(PANEL_MIN, st.minSidebarWidth) : PANEL_MIN;
    startColDrag(e, (dx) => {
      const w = place === "outline-right" ? startW - dx : startW + dx;
      const clamped = Math.min(PANEL_MAX, Math.max(min, w));
      if (toSidebar) useUiStore.getState().setSidebarWidth(clamped);
      else useUiStore.getState().setOutlineWidth(clamped);
    });
  };
  return (
    <div
      className={`resizer app-resizer ${cls}`}
      style={hidden ? { width: 0, opacity: 0 } : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={place === "sidebar" ? "调整文件栏宽度" : "调整大纲栏宽度"}
      aria-hidden={hidden || undefined}
      onPointerDown={hidden ? undefined : startDrag}
    />
  );
}

function App() {
  useEffect(() => {
    // 应用级一次性初始化：设置加载（含 settings-updated 监听）、
    // document-changed 监听（首开参数 + 单实例 handoff 统一入口）、
    // 翻译进度/完成事件监听。各 listen* 自带只挂一次闩，StrictMode 双跑无副作用。
    void useSettingsStore.getState().load();
    void useDocStore.getState().openDocFromArgs();
    void useTranslationStore.getState().listenProgress();
    void useTranslationStore.getState().listenDone();
    void useTranslationStore.getState().listenPartial();
    void useTranslationStore.getState().listenLookupDelta();
    void listenHibernateOnce();
  }, []);

  useEffect(
    () =>
      // T21 划词翻译外置订阅：cursorSel（CM code unit 偏移，与 JS 下标同口径）
      // 变化即取选中文本交给 translateSelection——其内置 300ms 防抖，拖选期间
      // 只在停顿后发起一次；selection_translate 关闭时不触发；空选区清空浮窗。
      useDocStore.subscribe((s, prev) => {
        if (s.cursorSel === prev.cursorSel) return;
        if (!useSettingsStore.getState().settings?.selection_translate) return;
        const [from, to] = s.cursorSel;
        const text = from !== to && s.doc ? s.doc.content.slice(from, to) : "";
        useTranslationStore.getState().translateSelection(text);
      }),
    [],
  );

  useEffect(() => {
    // T29 快捷键收口：应用内全部组合键唯一入口（旧 egui main.rs 键位平移）。
    // - 总闸：IME 组合期按键不是快捷键意图（T28 先例）；defaultPrevented =
    //   编辑器/内层已处理（CM keymap 的 Mod+S/B/I 走 preventDefault），不重复
    //   触发——防 CM 与本 handler 双发的唯一闸门。
    // - Mod+Shift+P palette（T28 行为原样保留，Ctrl 或 Meta 皆可）。
    // - Mod+S/E/B/I/\：S/B/I 编辑器聚焦时由 CM 先处理（defaultPrevented 拦下），
    //   其余焦点（预览/侧栏/工具栏）由此处兜底；分支要求 !alt 防吞用户录制的
    //   Ctrl+Alt+X 模式热键。
    // - Alt+1/2/3 类：settings.hotkeys 用户录制动态值比对，先到先得；Meta 组合
    //   在 parseCombo 已拒绝（Win 键不稳定，见 lib/hotkeys.ts 注释）。
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      // WebView2 加速键 F5/Ctrl+R 同样整页重载（与右键菜单"刷新"同源）——
      // 桌面应用没有"刷新"语义，拦下防误触清空未保存文档。
      if (e.code === "F5" || ((e.ctrlKey || e.metaKey) && e.code === "KeyR")) {
        e.preventDefault();
        return;
      }
      const dd = useDocStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        useUiStore.getState().openPalette();
        return;
      }
      // Mod+Shift+O：打开文件夹作为工作区（欢迎页提示的快捷键，与 Ctrl+O 成对）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        void useWorkspaceStore.getState().openWorkspace();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        switch (e.code) {
          case "KeyO":
            e.preventDefault();
            void openFile();
            return;
          case "KeyE":
            e.preventDefault();
            dd.switchView(dd.view === "source" ? "preview" : "source");
            return;
          case "KeyS":
            e.preventDefault();
            void dd.saveDoc(false);
            return;
          case "KeyB":
            e.preventDefault();
            void dd.applyFormat("bold");
            return;
          case "KeyI":
            e.preventDefault();
            void dd.applyFormat("italic");
            return;
          case "Backslash":
            e.preventDefault();
            dd.switchView("split");
            return;
        }
      }
      const hk = useSettingsStore.getState().settings?.hotkeys;
      if (!hk) return;
      for (const [mode, combo] of Object.entries(hk)) {
        if (mode === "capture") continue; // 全局热键，Rust 侧注册处理
        if (comboMatches(e, combo)) {
          e.preventDefault();
          if (mode === "original" || mode === "translation" || mode === "bilingual") {
            dd.switchMode(mode);
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // T29 全局热键（Rust 侧注册，程序未聚焦也可换模式）：回调 emit `hotkey-mode`
    // （payload = 模式字符串）→ switchMode。StrictMode 双跑安全：listen promise
    // 晚到且已卸载时由 alive 闩立刻解绑。
    let un: (() => void) | undefined;
    let alive = true;
    void api.listenHotkeyMode((m) => {
      if (m === "original" || m === "translation" || m === "bilingual") {
        useDocStore.getState().switchMode(m);
      }
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const outlineSide = useUiStore((s) => s.outlineSide);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const outlineWidth = useUiStore((s) => s.outlineWidth);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const paletteOpen = useUiStore((s) => s.commandPaletteOpen);

  // 网格（7 列）：col1 文件栏 / col2 文件栏拖宽条 / col3 大纲栏·左停靠 /
  // col4 该停靠的拖宽条 / col5 主区(1fr) / col6 大纲栏·右停靠的拖宽条 /
  // col7 大纲栏·右停靠。未使用的空列（auto 且无在流项）恒为 0 宽。
  // 工作区隐藏时主内容区左缘直接顶到 col1；这样 TabBar/EditorToolbar/MainArea
  // 一起左移，不会出现「左侧 4 列留白、右侧才是内容」的撕裂。CSS 读 --col-main
  // 与 --main-span：--main-span=1 时 main-area 占 col5 一列（1fr）；
  // --main-span=5 时 main-area 占 col1-5（吸收掉隐藏的侧栏、拖宽条与空列）。
  // 面板改为常挂载 + 宽度过渡后，跨列切换必须等收起动画播完（navGone），
  // 否则主区提前跨列会盖住正在收缩的侧栏——动画就看不见了。
  // 大纲栏左停靠时 col3 有实体面板，不能再跨列吸收（会被主区盖住），
  // 此时主区固定占 col5，靠空列自然收窄。
  const navGone = useSettled(!showNav, PANEL_ANIM_MS);
  const outlineDockedLeft = showOutline && outlineSide === "left";
  const absorb = navGone && !outlineDockedLeft;
  const mainStyle = {
    ["--col-main" as string]: String(absorb ? 1 : 5),
    ["--main-span" as string]: String(absorb ? 5 : 1),
    // 工具条左缘：与「工作区带」左端对齐（侧栏拖宽条之后，含左停靠大纲栏），
    // 右端 -1 覆盖到窗口右缘（第 2 行只有侧栏与工具条，无面板占位冲突）。
    ["--col-ws" as string]: String(absorb ? 1 : 3),
  } as CSSProperties;

  return (
    <div id="app-shell" style={mainStyle}>
      <TitleBar />
      <AppMenu />
      {/* EditorToolbar 常驻显示（源/预览/分栏均渲染，MainArea 不再渲染）。
          撤销/重做依赖 cmRef，preview 时为 no-op；格式按钮读 store.cursorSel，
          preview 时用上次切走前的选区位置——点击行为视为已知约束。 */}
      <EditorToolbar />
      {/* T18 Sidebar 挂入点；ui.showNav 折叠。
          面板常挂载，宽度/透明度过渡做平滑收展（--panel-anim）；内容包在
          .panel-clip 里保持固定宽（store 值），收缩时只被裁切不被挤压。
          隐藏态 width:0 + overflow:hidden，无残留热区。 */}
      <nav
        className="sidebar"
        style={{
          width: showNav ? sidebarWidth : 0,
          opacity: showNav ? 1 : 0,
          ["--panel-w" as string]: `${sidebarWidth}px`,
        }}
      >
        <div className="panel-clip">
          <Sidebar />
        </div>
      </nav>
      {/* 面板与主区的分隔/拖宽条（1px 发丝线 + 7px 热区，悬停提示可拖拽） */}
      <PanelResizer place="sidebar" hidden={!showNav} />
      {/* T22 MainArea：source/preview/split 路由（格式工具栏已上移至 tab 条下）；T23 TranslationBar 宿主 */}
      <main className="main-area">
        <MainArea />
      </main>
      {/* T19 OutlinePanel 挂入点；ui.showOutline 折叠（同 Sidebar 常挂载 + 过渡）。
          ui.outlineSide 切换停靠侧：左停靠吸附在工作区左缘（侧栏与主区之间），
          拖宽条随之换到 col4，主区仍在 col5。 */}
      <PanelResizer
        place="outline-left"
        hidden={!outlineDockedLeft}
      />
      <PanelResizer
        place="outline-right"
        hidden={!showOutline || outlineSide !== "right"}
      />
      <aside
        className={`outline-panel${outlineDockedLeft ? " dock-left" : ""}`}
        style={{
          width: showOutline ? outlineWidth : 0,
          opacity: showOutline ? 1 : 0,
          ["--panel-w" as string]: `${outlineWidth}px`,
        }}
      >
        <div className="panel-clip">
          <OutlinePanel />
        </div>
      </aside>
      <StatusBar />
      {/* T24 划词翻译浮窗：fixed 定位，DOM 位置仅作挂载点 */}
      <SelectionPopup />
      {/* T26 设置弹窗：ui.settingsOpen 门控，条件挂载保证每次打开都是新草稿 */}
      {settingsOpen && <SettingsModal />}
      {/* T28 命令面板：ui.commandPaletteOpen 门控，条件挂载保证每次打开都是全新查询 */}
      {paletteOpen && <CommandPalette />}
      {/* T27 toast 容器：fixed 定位，随应用生命周期挂载 */}
      <ToastContainer />
    </div>
  );
}

export default App;
