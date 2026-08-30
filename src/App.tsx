import { type PointerEvent as ReactPointerEvent, useEffect } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";
import { useUiStore } from "./stores/useUiStore";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import AppMenu from "./components/AppMenu";
import TabBar from "./components/TabBar";
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

// 面板宽度钳制：左右栏与主区之间拖宽条的取值范围（默认 240/200 落在其中）
const PANEL_MIN = 160;
const PANEL_MAX = 480;

// 面板拖宽条：与主区 SplitBody 中缝共用 lib/colDrag 的纯 Pointer Events 拖拽。
// 左栏向右拖增宽，右大纲向左拖增宽，方向用 side 翻转；宽度存 uiStore，跨视图切换保持。
function PanelResizer({ side }: { side: "left" | "right" }) {
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = useUiStore.getState();
    const startW = side === "left" ? st.sidebarWidth : st.outlineWidth;
    startColDrag(e, (dx) => {
      const w = side === "left" ? startW + dx : startW - dx;
      const clamped = Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
      if (side === "left") useUiStore.getState().setSidebarWidth(clamped);
      else useUiStore.getState().setOutlineWidth(clamped);
    });
  };
  return (
    <div
      className={`resizer app-resizer ${side === "left" ? "res-left" : "res-right"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "调整文件栏宽度" : "调整大纲栏宽度"}
      onPointerDown={startDrag}
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
    void useTranslationStore.getState().listenLookupDelta();
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
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const outlineWidth = useUiStore((s) => s.outlineWidth);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const paletteOpen = useUiStore((s) => s.commandPaletteOpen);

  return (
    <div id="app-shell">
      <TitleBar />
      <AppMenu />
      <TabBar />
      {/* EditorToolbar 常驻显示（源/预览/分栏均渲染，MainArea 不再渲染）。
          撤销/重做依赖 cmRef，preview 时为 no-op；格式按钮读 store.cursorSel，
          preview 时用上次切走前的选区位置——点击行为视为已知约束。 */}
      <EditorToolbar />
      {/* T18 Sidebar 挂入点；ui.showNav 折叠 */}
      {showNav && (
        <>
          <nav className="sidebar" style={{ width: sidebarWidth }}>
            <Sidebar />
          </nav>
          {/* 面板与主区的分隔/拖宽条（1px 发丝线 + 7px 热区，悬停提示可拖拽） */}
          <PanelResizer side="left" />
        </>
      )}
      {/* T22 MainArea：source/preview/split 路由（格式工具栏已上移至 tab 条下）；T23 TranslationBar 宿主 */}
      <main className="main-area">
        <MainArea />
      </main>
      {/* T19 OutlinePanel 挂入点；ui.showOutline 折叠 */}
      {showOutline && (
        <>
          <PanelResizer side="right" />
          <aside className="outline-panel" style={{ width: outlineWidth }}>
            <OutlinePanel />
          </aside>
        </>
      )}
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
