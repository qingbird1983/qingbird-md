import { type CSSProperties, useEffect } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";
import { useUiStore } from "./stores/useUiStore";
import { useRecentStore } from "./stores/useRecentStore";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import AppMenu from "./components/AppMenu";
import EditorToolbar from "./components/EditorToolbar";
import MainArea from "./components/MainArea";
import Sidebar from "./components/Sidebar";
import OutlinePanel from "./components/OutlinePanel";
import SelectionPopup from "./components/SelectionPopup";
import SettingsModal from "./components/SettingsModal";
import CloseAskDialog from "./components/CloseAskDialog";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/ToastContainer";
import { PanelResizer } from "./components/PanelResizer";
import { PanelHandle } from "./components/PanelHandle";
import { runBootIntro } from "./lib/bootIntro";
import { listenCloseRequested } from "./lib/ipc";
import { INTRO_FROM_WIDTH, INTRO_ANIM_MS } from "./stores/useUiStore";
import { useAppHotkeys } from "./hooks/useAppHotkeys";
import { listenHibernateOnce } from "./hooks/useHibernate";
import { useSettled } from "./hooks/useSettled";

// 面板收展过渡时长：与 global.css 的 --panel-anim 保持一致。--col-main 的
// 切换必须等收起动画播完（否则主区提前跨列会盖住正在收缩的面板），所以
// JS 侧比 CSS 略长 40ms 兜底。
const PANEL_ANIM_MS = 340;

function App() {
  useEffect(() => {
    // 应用级一次性初始化：设置加载（含 settings-updated 监听）、
    // document-changed 监听（首开参数 + 单实例 handoff 统一入口）、
    // 翻译进度/完成事件监听。各 listen* 自带只挂一次闩，StrictMode 双跑无副作用。
    void useSettingsStore.getState().load();
    useRecentStore.getState().load(); // 最近打开文档：读盘一次，之后随打开自动登记
    // 启动序列（含 openDocFromArgs）与启动动画编排共用一个入口：编排器要在
    // 快照/pending 恢复完成后才能判定「是否落在欢迎页、该不该演动画」。
    void runBootIntro();
    void useTranslationStore.getState().listenProgress();
    void useTranslationStore.getState().listenDone();
    void useTranslationStore.getState().listenPartial();
    void listenHibernateOnce();
    // Task 11 关窗询问：close_action=ask 时后端拦下关闭请求后广播
    // close-requested，这里唤起询问弹窗（与 listenHibernateOnce 同样只挂一次）。
    void listenCloseRequested(() => useUiStore.getState().setCloseAskOpen(true));
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

  // T29 快捷键收口：应用内组合键 + Rust 系统热键回调（接线见 hooks/useAppHotkeys）。
  useAppHotkeys();

  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const outlineSide = useUiStore((s) => s.outlineSide);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const outlineWidth = useUiStore((s) => s.outlineWidth);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const closeAskOpen = useUiStore((s) => s.closeAskOpen);
  const paletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const introPhase = useUiStore((s) => s.introPhase);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  // armed = 窗口 reveal 前的起始态（两栏展开到比终态更宽）；playing = 收缩进行中。
  const introArmed = introPhase === "idle";
  const introPlaying = introPhase === "playing";
  // armed 期间显隐/宽度/停靠侧全部以起始态为准，快照恢复对 store 的改动要等
  // startIntro 那一帧才生效——否则隐藏期里就会先演一半。
  const navVisible = introArmed || showNav;
  const outlineVisible = introArmed || showOutline;
  // armed 期宽度语义："两栏都展开到最宽"的起始态。
  // 左栏 sidebar 与右栏 outline 统一用 INTRO_FROM_WIDTH（= PANEL_MAX 480），
  // 起手时两栏各占 480 向窗口两侧铺开；playing 由对称 keyframes 从 --panel-w
  // 收到 0（左栏朝左收尽、右栏朝右收尽），终帧只剩中间欢迎页。
  // --panel-w 必须在 armed 与 playing 两帧都钉在 480，keyframes 0% 才不会跳变；
  // done 后恢复各自 store 宽度（此时两栏已隐藏，width 归 0 不受影响）。
  const introWide = introArmed || introPlaying;
  const navPanelW = introWide ? INTRO_FROM_WIDTH : sidebarWidth;
  const outlinePanelW = introWide ? INTRO_FROM_WIDTH : outlineWidth;

  // 网格（7 列）：col1 文件栏 / col2 文件栏拖宽条 / col3 左空槽 /
  // col4 左内槽（大纲左停靠让位列）/ col5 主区(1fr) / col6 右内槽（大纲右停靠
  // 让位列）/ col7 右外槽（大纲右停靠）。拖宽条已内嵌进各槽，col3/col6 恒 0 宽。
  // （原核查高栏已随 AI 功能移除，col3/col7 只留大纲单宿主。）
  // 工作区隐藏时主内容区左缘直接顶到 col1；这样 TabBar/EditorToolbar/MainArea
  // 一起左移，不会出现「左侧 4 列留白、右侧才是内容」的撕裂。CSS 读 --col-main
  // 与 --main-span：--main-span=1 时 main-area 占 col5 一列（1fr）；
  // --main-span=5 时 main-area 占 col1-5（吸收掉隐藏的侧栏、拖宽条与空列）。
  // 面板改为常挂载 + 宽度过渡后，跨列切换必须等收起动画播完（navGone），
  // 否则主区提前跨列会盖住正在收缩的侧栏——动画就看不见了。
  // 左槽有实体面板时（大纲左停靠），不能再跨列吸收（会被主区盖住），
  // 此时主区固定占 col5，靠空列自然收窄。
  // 收缩延迟随动画时长走：intro 播放时面板过渡被拉到 INTRO_ANIM_MS，
  // 主区跨列吸收空列也必须等这么久，否则会在收缩中途盖住侧栏。
  const navGone = useSettled(
    !navVisible,
    introPlaying ? INTRO_ANIM_MS : PANEL_ANIM_MS,
  );
  // 大纲槽同一铁律（常挂载 + 宽度过渡后）：让位「展开当帧生效、收回等
  // 收起动画播完」（同 navGone）——否则主区提前跨列吸收/大纲提前挪列，会叠进
  // 正在收缩的槽里。xGone 在面板可见或收缩中恒 false，收完后才翻 true；
  // 占位 = 可见 || 未收完（展开首帧 xGone 还没来得及翻，补上可见项）。
  const outlineGone = useSettled(!outlineVisible, PANEL_ANIM_MS);
  const outlineOccupied = outlineVisible || !outlineGone;
  // 左槽被占用（大纲左停靠）时不能吸收。
  // intro 全程（含 playing）大纲栏固定在 armed 那一列，避免左停靠时从右列
  // 瞬移到左列再收缩；done 后恢复用户偏好的停靠侧。
  const outlineDockedLeft = !introWide && outlineOccupied && outlineSide === "left";
  const absorb = navGone && !outlineDockedLeft;
  // 大纲栏单宿主：右停靠占 col7、左停靠占 col3（不再是"让位内移"，
  // 让位列 col4/col6 恒空）。
  const outlineCol = outlineSide === "right" ? 7 : 3;
  const mainStyle = {
    ["--col-main" as string]: String(absorb ? 1 : 5),
    ["--main-span" as string]: String(absorb ? 5 : 1),
    // 工具条左缘：与「工作区带」左端对齐（侧栏拖宽条之后，含左停靠大纲栏），
    // 右端 -1 覆盖到窗口右缘（第 2 行只有侧栏与工具条，无面板占位冲突）。
    ["--col-ws" as string]: String(absorb ? 1 : 3),
    // intro 播放期间把面板过渡时长整体拉长（侧栏/大纲栏/拖宽条/标签条都继承
    // 这一个变量），三处动画共用同一时长 → 同时落定，不需要按距离分别算。
    ...(introPlaying
      ? { ["--panel-anim" as string]: `${INTRO_ANIM_MS}ms` }
      : {}),
  } as CSSProperties;
  const shellClass = introArmed
    ? "intro-armed"
    : introPlaying
      ? "intro-playing"
      : undefined;

  return (
    <div id="app-shell" className={shellClass} style={mainStyle}>
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
          // playing 期不内联 width/opacity，交给 sidebar-collapse keyframes 与
          // 右栏对称地收缩（左栏朝左收尽、带微弱回弹）；--panel-w 仍是 480 起手宽。
          width: introPlaying ? undefined : navVisible ? navPanelW : 0,
          opacity: introPlaying ? undefined : navVisible ? 1 : 0,
          ["--panel-w" as string]: `${navPanelW}px`,
        }}
      >
        <div className="panel-clip">
          <Sidebar />
        </div>
      </nav>
      {/* 面板与主区的分隔/拖宽条（1px 发丝线 + 7px 热区，悬停提示可拖拽） */}
      <PanelResizer place="sidebar" hidden={!navVisible} />
      {/* T22 MainArea：source/preview/split 路由（格式工具栏已上移至 tab 条下）；T23 TranslationBar 宿主 */}
      <main className="main-area">
        <MainArea />
      </main>
      {/* T19 OutlinePanel 挂入点；ui.showOutline 折叠（同 Sidebar 常挂载 + 过渡）。
          右停靠占 col7 / 左停靠占 col3。
          宽度/透明度 inline style 落在 .panel-unit（intro keyframes 同改这一层，
          见 12-welcome.css）；把手挂在槽上（不在 unit 内）——贴发丝线主区那侧、
          收起时贴窗缘，两种状态同一几何，永不被 unit 的 opacity 收走。
          拖宽条内嵌槽内，不再是独立网格列；intro-playing 期 width 不内联，
          让 keyframes 接管收缩 + 回弹（inline 会盖过 animation）。 */}
      <div
        className="panel-slot outline-slot"
        data-side={outlineSide}
        data-open={outlineVisible}
        style={{ gridColumn: outlineCol }}
      >
        <PanelHandle
          side={outlineSide}
          showPanel={outlineVisible}
          onToggle={toggleOutline}
          label={outlineVisible ? "收起大纲" : "展开大纲"}
        />
        <PanelResizer
          place={outlineSide === "right" ? "outline-right" : "outline-left"}
          hidden={!outlineVisible}
        />
        <div
          className="panel-unit"
          style={{
            width: introPlaying ? undefined : outlineVisible ? outlinePanelW : 0,
            opacity: outlineVisible ? 1 : 0,
            ["--panel-w" as string]: `${outlinePanelW}px`,
          }}
        >
          <aside className="outline-panel">
            <div className="panel-clip">
              <OutlinePanel />
            </div>
          </aside>
        </div>
      </div>
      <StatusBar />
      {/* T24 划词翻译浮窗：fixed 定位，DOM 位置仅作挂载点 */}
      <SelectionPopup />
      {/* T26 设置弹窗：ui.settingsOpen 门控，条件挂载保证每次打开都是新草稿 */}
      {settingsOpen && <SettingsModal />}
      {/* Task 11 关窗询问框：ui.closeAskOpen 门控，条件挂载（同 SettingsModal）
          保证每次弹出都是全新勾选态——remember 绝不跨开合残留；
          close-requested 事件唤起；勾选「记住」直接落 close_action 不再弹框 */}
      {closeAskOpen && <CloseAskDialog />}
      {/* T28 命令面板：ui.commandPaletteOpen 门控，条件挂载保证每次打开都是全新查询 */}
      {paletteOpen && <CommandPalette />}
      {/* T27 toast 容器：fixed 定位，随应用生命周期挂载 */}
      <ToastContainer />
    </div>
  );
}

export default App;
