import { type PointerEvent as ReactPointerEvent, type CSSProperties, useEffect, useState } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";
import { useUiStore } from "./stores/useUiStore";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
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
import { openFile } from "./components/commands";
import { exportActiveTranslation } from "./lib/exportTranslation";
import { comboMatches } from "./lib/hotkeys";
import { HOTKEYS, effectiveHotkeys, type AppHotkeyId } from "./lib/hotkeyRegistry";
import type { Mode } from "./types/ipc";
import { startColDrag } from "./lib/colDrag";
import { api } from "./lib/ipc";
import { collectSnapshot } from "./lib/session";
import { runBootIntro } from "./lib/bootIntro";
import { INTRO_FROM_WIDTH, INTRO_ANIM_MS } from "./stores/useUiStore";

/**
 * 应用内快捷键的**执行体**：键 = lib/hotkeyRegistry 的 id。
 *
 * 这里只回答「做什么」，「什么键触发」全在注册表里（含用户改键）。
 * 系统级的项（截图翻译、三个模式键）不出现在这张表：
 *   · capture → Rust 侧注册，触发截图流程，前端不参与；
 *   · 模式键 → 上面 onKey 里的 group === "mode" 分支统一处理。
 * 类型写成 `Record<AppHotkeyId, …>`：注册表加了 id 却忘了写执行体时
 * `tsc` 直接报错（漏项不会再变成「按了没反应」的静默故障）。
 */
const APP_ACTIONS: Record<AppHotkeyId, () => void> = {
  open_file: () => void openFile(),
  open_folder: () => void useWorkspaceStore.getState().openWorkspace(),
  new_file: () => {
    // 新建文件落当前活动文件夹；没有文件夹时不静默吞键，给一句提示
    const ws = useWorkspaceStore.getState();
    if (!ws.activePath) {
      useUiStore.getState().addToast("info", "先打开一个文件夹，再新建文件");
      return;
    }
    const n = window.prompt("新文件名（创建于当前文件夹）：", "未命名.md");
    if (n?.trim()) void ws.createFileIn(null, n.trim());
  },
  save: () => void useDocStore.getState().saveDoc(false),
  // 不可导出时（无译文 / 双语模式 / 翻译中）与菜单同款：给一句说明的 toast，
  // 而不是静默无动作——快捷键路径没有禁用态可看，不提示就等于"按了没反应"。
  export_translation: () => void exportActiveTranslation(),
  refresh_ws: () => {
    if (useWorkspaceStore.getState().folders.length > 0) {
      void useWorkspaceStore.getState().refresh();
    }
  },
  toggle_view: () => {
    const dd = useDocStore.getState();
    dd.switchView(dd.view === "source" ? "preview" : "source");
  },
  split_view: () => useDocStore.getState().switchView("split"),
  palette: () => useUiStore.getState().openPalette(),
  // AI 核查面板开关（§八）：Ctrl+J 与 Guanmo 同键。
  toggle_review: () => useUiStore.getState().toggleReview(),
  bold: () => void useDocStore.getState().applyFormat("bold"),
  italic: () => void useDocStore.getState().applyFormat("italic"),
};

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
// - review-right：贴 AI 核查栏（右停靠）左缘，左拖增宽（-dx）
// - review-left：贴 AI 核查栏（左停靠）右缘，右拖增宽（+dx）
// 宽度存 uiStore，跨视图切换保持。
type ResizerPlace = "sidebar" | "outline-right" | "outline-left" | "review-right" | "review-left";

function PanelResizer({ place, hidden }: { place: ResizerPlace; hidden: boolean }) {
  // CSS 类映射：sidebar→res-left, outline-left/review-left→res-olutl,
  // outline-right/review-right→res-right。右停靠面板共享 col6 拖宽条，
  // 左停靠共享 col4——两个面板分侧时各占一条，同侧时 store 保证不会同时渲染。
  const cls =
    place === "sidebar"
      ? "res-left"
      : place === "outline-left" || place === "review-left"
        ? "res-olutl"
        : "res-right";
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = useUiStore.getState();
    const toSidebar = place === "sidebar";
    const toReview = place.startsWith("review");
    const startW = toSidebar ? st.sidebarWidth : toReview ? st.reviewWidth : st.outlineWidth;
    // 左侧下限动态（标签条归位临界，TitleBar 实测写入 store，兜底 PANEL_MIN）；
    // 大纲/核查面板无对齐诉求，保持静态下限。
    const min = toSidebar ? Math.max(PANEL_MIN, st.minSidebarWidth) : PANEL_MIN;
    startColDrag(e, (dx) => {
      // 右停靠：左拖增宽（-dx）；左停靠：右拖增宽（+dx）
      const isRightDock = place.endsWith("-right");
      const w = isRightDock ? startW - dx : startW + dx;
      const clamped = Math.min(PANEL_MAX, Math.max(min, w));
      if (toSidebar) useUiStore.getState().setSidebarWidth(clamped);
      else if (toReview) useUiStore.getState().setReviewWidth(clamped);
      else useUiStore.getState().setOutlineWidth(clamped);
    });
  };
  return (
    <div
      className={`resizer app-resizer ${cls}`}
      style={hidden ? { width: 0, opacity: 0 } : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={
        place === "sidebar"
          ? "调整文件栏宽度"
          : place.startsWith("review")
            ? "调整 AI 核查栏宽度"
            : "调整大纲栏宽度"
      }
      aria-hidden={hidden || undefined}
      onPointerDown={hidden ? undefined : startDrag}
    />
  );
}

// 侧栏把手（"舌"）：钉在槽边缘垂直中点，48×20 高而窄，只圆内侧两角，
// 底色透明（滚动条从下方穿过），无阴影（DESIGN.md 贴面零阴影）。
// 箭头方向 = side × collapsed 两个布尔共同决定（§9.2 物理规则）：
//   箭头 = 面板那条边「将要移动」的方向。
//   右停靠 未展开 ‹ ／ 已展开 ›
//   左停靠 未展开 › ／ 已展开 ‹
// 只做「展开/收起」，不兼停靠切换（§9.2：两件事两个控件）。
function PanelHandle({
  side,
  showPanel,
  onToggle,
  label,
}: {
  side: "left" | "right";
  showPanel: boolean;
  onToggle: () => void;
  label: string;
}) {
  // 箭头朝向：已展开时朝外（远离主区），未展开时朝内（指向主区）
  const arrowRight = (side === "right" && showPanel) || (side === "left" && !showPanel);
  const d = arrowRight ? "M9 18l6-6-6-6" : "M15 18l-6-6 6-6";
  return (
    <button
      type="button"
      className="panel-handle"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={showPanel}
      title={label}
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    </button>
  );
}

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

  useEffect(() => {
    // T29 快捷键收口：应用内全部组合键唯一入口。
    // 2026-09-14 改成**表驱动**：键位清单一律查 lib/hotkeyRegistry.ts
    // （settings.hotkeys 里录过就用用户的，没录过用出厂默认），这里只留
    // 「按 id 做什么」的执行体——旧版每个键一个 if/switch 分支，加键要改两处。
    // - 总闸：IME 组合期按键不是快捷键意图（T28 先例）；defaultPrevented =
    //   编辑器/内层已处理（CM keymap 的 Mod+S/B/I 走 preventDefault），不重复
    //   触发——防 CM 与本 handler 双发的唯一闸门。
    // - requireModifier=false：F5 这类键天生没有修饰键（扩展白名单见
    //   lib/hotkeys.ts allowsBare）。模式热键带修饰，两种取值结果一致。
    // - global 项（截图翻译、模式键的系统级注册）由 Rust 侧负责，
    //   这里 **先跳过再 preventDefault**，否则会把全局触发也吞掉。
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      // WebView2 加速键 Ctrl+R 会整页重载（未保存文档全丢），无条件拦下。
      // 同族的 F5 已收进注册表（默认仍是 F5），不再在这里特判。
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyR") {
        e.preventDefault();
        return;
      }
      const hk = effectiveHotkeys(useSettingsStore.getState().settings?.hotkeys);
      for (const def of HOTKEYS) {
        const combo = hk[def.id];
        if (!combo || def.global) continue; // 空串=用户禁用；global 交给 Rust
        if (!comboMatches(e, combo, false)) continue;
        e.preventDefault();
        if (def.group === "mode") {
          useDocStore.getState().switchMode(def.id as Mode);
          return;
        }
        // 非模式组必然是 AppHotkeyId（global 项上面已 continue）。
        // 仍留 `?.` 兜一层：注册表若哪天多出个非 app 分组，宁可无动作也别崩。
        APP_ACTIONS[def.id as AppHotkeyId]?.();
        return;
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
  const showReview = useUiStore((s) => s.showReview);
  const reviewSide = useUiStore((s) => s.reviewSide);
  const reviewWidth = useUiStore((s) => s.reviewWidth);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const paletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const introPhase = useUiStore((s) => s.introPhase);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const toggleReview = useUiStore((s) => s.toggleReview);
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

  // 网格（7 列）：col1 文件栏 / col2 文件栏拖宽条 / col3 左停靠槽 /
  // col4 左槽拖宽条 / col5 主区(1fr) / col6 右停靠槽拖宽条 / col7 右停靠槽。
  // 左/右槽各可挂 大纲 或 AI 核查（各面板独立选边），或两者分侧并存（真四栏）。
  // 未使用的空列（auto 且无在流项）恒为 0 宽。
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
          §8.2 槽位泛化：grid-column 已从 .outline-panel 上移到 .panel-slot；
          .panel-handle 钉在槽边缘垂直中点（§9.2），不参与面板的 overflow:hidden
          裁切/opacity 淡出——收起态把手仍可见，落在窗口边缘垂直中点。
          ui.outlineSide 切换停靠侧：左停靠吸附在工作区左缘（侧栏与主区之间），
          拖宽条随之换到 col4，主区仍在 col5。 */}
      <PanelResizer
        place="outline-left"
        // armed 起始态大纲栏固定在右缘展开，col4 不能冒出左停靠的拖宽条
        hidden={introArmed || !outlineDockedLeft}
      />
      <PanelResizer
        place="outline-right"
        hidden={!introArmed && (!showOutline || outlineSide !== "right")}
      />
      <div className="panel-slot" data-side={outlineSide}>
        <PanelHandle
          side={outlineSide}
          showPanel={outlineVisible}
          onToggle={toggleOutline}
          label={outlineVisible ? "收起大纲" : "展开大纲"}
        />
        <aside
          className="outline-panel"
          style={{
            // intro-playing 期 width 不内联：让 CSS keyframes 接管收缩 + 回弹。
            // inline style 与 keyframe animation 同改 width 时，内联胜出 → 看不到
            // 回弹。armed 期仍要钉起始宽，所以这条三元只在 playing 为 false 时设值。
            width: introPlaying ? undefined : outlineVisible ? outlinePanelW : 0,
            opacity: outlineVisible ? 1 : 0,
            ["--panel-w" as string]: `${outlinePanelW}px`,
          }}
        >
          <div className="panel-clip">
            <OutlinePanel />
          </div>
        </aside>
      </div>
      {/* AI 核查面板（§八）：与大纲共用两个侧栏槽，各自独立选边。
          冲突（两面板同侧）由 store 的 toggleReview/setReviewSide 自动翻边化解，
          渲染层直接读 showReview——store 保证 showReview && showOutline 时
          outlineSide !== reviewSide，两面板不会挤一个槽。 */}
      {showReview && (
        <>
          <PanelResizer
            place="review-left"
            hidden={reviewSide !== "left"}
          />
          <PanelResizer
            place="review-right"
            hidden={reviewSide !== "right"}
          />
          <div className="panel-slot" data-side={reviewSide}>
            <PanelHandle
              side={reviewSide}
              showPanel={true}
              onToggle={toggleReview}
              label="收起 AI 核查"
            />
            <aside
              className="review-panel"
              style={{
                width: reviewWidth,
                opacity: 1,
                ["--panel-w" as string]: `${reviewWidth}px`,
              }}
            >
              <div className="panel-clip">
                <ReviewPanel />
              </div>
            </aside>
          </div>
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
