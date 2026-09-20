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
import ReviewPanel from "./components/ReviewPanel";
import SelectionPopup from "./components/SelectionPopup";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/ToastContainer";
import { PanelResizer } from "./components/PanelResizer";
import { PanelHandle } from "./components/PanelHandle";
import { runBootIntro } from "./lib/bootIntro";
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

  // T29 快捷键收口：应用内组合键 + Rust 系统热键回调（接线见 hooks/useAppHotkeys）。
  useAppHotkeys();

  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const outlineSide = useUiStore((s) => s.outlineSide);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const outlineWidth = useUiStore((s) => s.outlineWidth);
  const showReview = useUiStore((s) => s.showReview);
  const reviewSide = useUiStore((s) => s.reviewSide);
  const reviewWidth = useUiStore((s) => s.reviewWidth);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
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
  // armed 期宽度语义："比终态宽一些"的展开态。
  // 侧栏用 INTRO_FROM_WIDTH（= PANEL_MAX 480），比默认 240 宽 240px，
  // "展开最大化"语义足；窗口通常够放（1296 常见窗口下 480 + 主区 ≥800）。
  // 大纲栏 armed 期 width 用 outlineWidth（默认 200）——若也用 480，1296 窗口
  // 下 480 侧栏 + 480 大纲栏 + 边距 ≈ 990 > 主区可用宽度，会把主区压成 0 宽
  // 露出 outline-panel 纯白盖住欢迎页。armed 用 outlineWidth，playing 用
  // 专属 keyframes 从 --panel-w 变量（armed 时已写好）收到 0。
  const navPanelW = introArmed ? INTRO_FROM_WIDTH : sidebarWidth;
  const outlinePanelW = outlineWidth;

  // 网格（7 列）：col1 文件栏 / col2 文件栏拖宽条 / col3 左外槽（核查高栏）/
  // col4 左内槽（大纲左停靠让位列）/ col5 主区(1fr) / col6 右内槽（大纲右停靠
  // 让位列）/ col7 右外槽（核查高栏）。拖宽条已内嵌进各槽，col4/col6 只在
  // 「大纲让位」时才有内容，其余时刻恒 0 宽。
  // 工作区隐藏时主内容区左缘直接顶到 col1；这样 TabBar/EditorToolbar/MainArea
  // 一起左移，不会出现「左侧 4 列留白、右侧才是内容」的撕裂。CSS 读 --col-main
  // 与 --main-span：--main-span=1 时 main-area 占 col5 一列（1fr）；
  // --main-span=5 时 main-area 占 col1-5（吸收掉隐藏的侧栏、拖宽条与空列）。
  // 面板改为常挂载 + 宽度过渡后，跨列切换必须等收起动画播完（navGone），
  // 否则主区提前跨列会盖住正在收缩的侧栏——动画就看不见了。
  // 左槽有实体面板时（大纲或核查左停靠），不能再跨列吸收（会被主区盖住），
  // 此时主区固定占 col5，靠空列自然收窄。
  // 收缩延迟随动画时长走：intro 播放时面板过渡被拉到 INTRO_ANIM_MS，
  // 主区跨列吸收空列也必须等这么久，否则会在收缩中途盖住侧栏。
  const navGone = useSettled(
    !navVisible,
    introPlaying ? INTRO_ANIM_MS : PANEL_ANIM_MS,
  );
  // 左槽被占用（大纲或核查任一左停靠）时不能吸收。
  // review 不参与 intro armed（首屏不显示核查面板），所以不加 introArmed 门。
  const outlineDockedLeft = !introArmed && showOutline && outlineSide === "left";
  const reviewDockedLeft = showReview && reviewSide === "left";
  const leftSlotOccupied = outlineDockedLeft || reviewDockedLeft;
  const absorb = navGone && !leftSlotOccupied;
  // 同侧共存（§8.2 二轮，2026-09-19）：核查与大纲同侧时，核查是「外一级」
  // 高栏——占外侧列（右 col7 / 左 col3）且跨 row 2-4（上抵标签栏下）；
  // 大纲栏让位内移一列（右 →col6 / 左 →col4）。分侧时各回原列（7/3）。
  // 推移而非覆盖、也不翻对侧（旧版 toggleReview 的自动翻边已删）。
  const reviewOpenRight = showReview && reviewSide === "right";
  const reviewOpenLeft = reviewDockedLeft;
  const outlineCol = outlineSide === "right" ? (reviewOpenRight ? 6 : 7) : reviewOpenLeft ? 4 : 3;
  const mainStyle = {
    ["--col-main" as string]: String(absorb ? 1 : 5),
    ["--main-span" as string]: String(absorb ? 5 : 1),
    // 工具条左缘：与「工作区带」左端对齐（侧栏拖宽条之后，含左停靠大纲栏），
    // 右端 -1 覆盖到窗口右缘（第 2 行只有侧栏与工具条，无面板占位冲突）。
    ["--col-ws" as string]: String(absorb ? 1 : 3),
    // 核查高栏占住 row 2 一角时工具栏让位（见 03-toolbar.css）：
    // 右同侧止于 col7 线前，左同侧从 col4 起（col3 被核查栏占住）。
    ...(reviewOpenRight ? { ["--tb-end" as string]: "7" } : {}),
    ...(reviewOpenLeft ? { ["--tb-start" as string]: "4" } : {}),
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
          width: navVisible ? navPanelW : 0,
          opacity: navVisible ? 1 : 0,
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
          §8.2 同侧共存：核查同侧时本槽内移一列（outlineCol），核查栏占外侧高栏。
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
      {/* AI 核查面板（§八）：与大纲各自独立选边；同侧时核查占外侧列 + row 2/4
          （高栏，上抵标签栏下），大纲让位内移——推移而非覆盖。列号/行号内联，
          线的朝向交给 .panel-slot[data-side] CSS。面板开合走 v1 的直接挂载/卸载
          （无收展过渡）。2026-09-19 三轮：AI 栏不再设把手——开合只走状态栏
          开关（用户拍板）；拖宽热区保留。 */}
      {showReview && (
        <div
          className="panel-slot review-slot"
          data-side={reviewSide}
          style={{
            gridColumn: reviewSide === "right" ? 7 : 3,
            gridRow: "2 / 4",
          }}
        >
          <PanelResizer
            place={reviewSide === "right" ? "review-right" : "review-left"}
            hidden={false}
          />
          <div
            className="panel-unit"
            style={{
              width: reviewWidth,
              opacity: 1,
              ["--panel-w" as string]: `${reviewWidth}px`,
            }}
          >
            <aside className="review-panel">
              <div className="panel-clip">
                <ReviewPanel />
              </div>
            </aside>
          </div>
        </div>
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
