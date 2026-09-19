// 全局 UI 杂项状态：面板折叠、分栏宽度、toast 队列、弹层开关。
// 本 store 不读取其它 store（依赖边界的终点）。
import { create } from "zustand";
import { MIN_CONTENT_WIDTH } from "../lib/contentWidth";

export type ToastKind = "success" | "info" | "error";

/** 供其它 store 在 catch 里取错误文案的统一小工具（不打印凭据载荷）。 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

/** 正文宽度四档（markdown.css .w-*；标准档不挂类，恒 A4 794px） */
export type ContentWidth = "compact" | "normal" | "wide" | "full";

/**
 * 启动动画状态机（2026-09-15 欢迎页仪式感动画）：
 * - idle：初始。窗口还没 show，面板读 introFromWidth 摆出「两栏展开到最宽」起始态。
 * - playing：已放行 show 且起始帧上屏，宽度切回终值，CSS 过渡开始收缩。
 * - skipped：本次不演（静默启动 / 带文件参数 / 恢复出文档 / 看门狗抢先），直接终态。
 * - done：动画播完（时长见 --intro-anim），摘除 intro 状态避免后续面板操作误走进起始态。
 */
export type IntroPhase = "idle" | "playing" | "skipped" | "done";

/** 大纲栏停靠侧：right = 窗口右缘（默认）；left = 吸附在工作区左缘（侧栏与主区之间） */
export type OutlineSide = "left" | "right";
/** 侧栏槽位停靠侧（大纲与 AI 核查共用槽位抽象，各自独立记忆 side） */
export type PanelSide = "left" | "right";

export const CONTENT_WIDTHS: ContentWidth[] = ["compact", "normal", "wide", "full"];

export const CONTENT_WIDTH_LABEL: Record<ContentWidth, string> = {
  compact: "紧凑 640",
  normal: "标准 794",
  wide: "宽 1000",
  full: "全宽 1200",
};

interface UiState {
  showNav: boolean;
  showOutline: boolean;
  outlineSide: OutlineSide;
  sidebarWidth: number;
  outlineWidth: number;
  // AI 核查面板（§八）：与大纲栏共用两个侧栏槽（col3/col4 左、col6/col7 右）。
  // 不新增网格列——只是把「大纲专属列」泛化为「槽位双宿主」。
  // 每面板各自记忆 side/width，互不耦合（§9.7）；show 跨启动由 Rust 休眠快照带，
  // side 走 localStorage（同 outlineSide 先例，不进快照避免动契约）。
  showReview: boolean;
  reviewSide: PanelSide;
  reviewWidth: number;
  // 侧栏最小宽度：由 TitleBar 实测写入（baseX - RESIZER_W，见 TitleBar.tsx）——
  // 拉到最小时侧栏那条分割线正好与标题栏的竖线共线。初值 160 兜底（测量完成前一帧）。
  minSidebarWidth: number;
  // 首启默认宽度是否还待回填（见 applyDefaultSidebarWidth）。任何宽度来源
  // ——用户拖拽、休眠快照恢复——都会把它置 false：「有记忆」永远压过默认值。
  // 放 state 里而非模块级变量，是为了测试能复位它。
  bootWidthPending: boolean;
  splitRatio: number; // split 视图左栏占比（Task 22；存 store 跨视图切换保持）
  contentWidth: ContentWidth; // 正文宽度档（markdown.css .markdown-body.w-*）
  customWidth: number | null; // 拖宽产物（null = 跟随四档档位）
  toasts: Toast[];
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  /** 启动仪式感动画阶段，见 IntroPhase 注释。 */
  introPhase: IntroPhase;

  /** idle → playing：窗口已 show 且起始帧被看见，两栏开始向终态收缩。 */
  startIntro(): void;
  /** idle → skipped：本次不演（静默 / 带文件参数 / 恢复出文档 / 减动效 / 看门狗抢先）。 */
  skipIntro(): void;
  /** playing → done：动画播完，摘除 intro 渲染分支。 */
  finishIntro(): void;

  toggleNav(): void;
  toggleOutline(): void;
  toggleReview(): void;
  /** 显式开合。`toggleReview` 做不到「确保打开」——S4 #14 的
   *  `ensureReviewPanelOpen()` 需要幂等语义（already open 时不能再翻成关）。 */
  setReviewOpen(open: boolean): void;
  setContentWidth(w: ContentWidth): void;
  setCustomWidth(px: number): void;
  cycleContentWidth(): void;
  addToast(kind: ToastKind, text: string): void;
  removeToast(id: number): void;
  openPalette(): void;
  closePalette(): void;
  openSettings(): void;
  closeSettings(): void;
  setSidebarWidth(w: number): void;
  setOutlineWidth(w: number): void;
  setOutlineSide(s: OutlineSide): void;
  setReviewWidth(w: number): void;
  setReviewSide(s: PanelSide): void;
  setSplitRatio(r: number): void;
  setMinSidebarWidth(px: number): void;
  /** 首次启动回填侧栏宽度（只在「无宽度记忆」时生效一次，见实现）。 */
  applyDefaultSidebarWidth(px: number): void;
}

/** 启动动画起始态两栏宽度（= 拖宽上限 PANEL_MAX，App.tsx 同值）：「展开最大化」。 */
export const INTRO_FROM_WIDTH = 480;
/** 启动动画时长：左右栏收缩与欢迎内容放大共用，三者同时落定（CSS 变量 --intro-anim 同值）。
 *  2026-09-15 二轮调优：从 760 提到 1280（用户反馈"一闪而过"，且需要留足尾部回弹空间）。 */
export const INTRO_ANIM_MS = 1280;

let toastSeq = 0;

// 宽度偏好跨启动保留：Tauri WebView2 的 localStorage 随应用数据目录持久化，
// 一个档位值不值得走 Rust 设置文件。旧布尔键一次性迁移（"1"→wide，"0"/缺失→normal）。
const WIDTH_KEY = "qb.content-width";
const CUSTOM_WIDTH_KEY = "qb.content-width-custom";
const LEGACY_WIDE_KEY = "qb.wide-content";
// 大纲栏停靠侧：纯 UI 偏好，走 localStorage（不进 Rust 会话快照，避免动契约）
const OUTLINE_SIDE_KEY = "qb.outline-side";
// AI 核查面板停靠侧：同上先例，走 localStorage。review 与 outline 各自独立
// 记忆 side、互不干涉——同侧时由渲染层「外一级高栏 + 大纲让位」化解（App.tsx）。
const REVIEW_SIDE_KEY = "qb.review-side";

function loadOutlineSide(): OutlineSide {
  return localStorage.getItem(OUTLINE_SIDE_KEY) === "left" ? "left" : "right";
}

function loadReviewSide(): PanelSide {
  return localStorage.getItem(REVIEW_SIDE_KEY) === "left" ? "left" : "right";
}

function loadContentWidth(): ContentWidth {
  const saved = localStorage.getItem(WIDTH_KEY) as ContentWidth | null;
  if (saved && CONTENT_WIDTHS.includes(saved)) return saved;
  return localStorage.getItem(LEGACY_WIDE_KEY) === "1" ? "wide" : "normal";
}

// 自定义拖宽恢复：只挡非法值（NaN / 低于下限）；大于当前面板宽不回钳——
// CSS max-width 让列自然填满面板，存值不动（面板变宽后原值生效）。
function loadCustomWidth(): number | null {
  const saved = localStorage.getItem(CUSTOM_WIDTH_KEY);
  if (saved === null) return null;
  const px = Number(saved);
  return Number.isFinite(px) && px >= MIN_CONTENT_WIDTH ? px : null;
}

export const useUiStore = create<UiState>()((set) => ({
  showNav: true,
  // 大纲默认收起：全新安装的首屏是空白欢迎页（没有文档，大纲本来就是空的），
  // 开着只是白占一列。用户的开/关状态跨启动由 Rust 休眠快照带（show_outline），
  // 所以这里只决定「第一次启动」长什么样，老用户照旧恢复自己的选择。
  showOutline: false,
  outlineSide: loadOutlineSide(),
  sidebarWidth: 240,
  outlineWidth: 200,
  // AI 核查面板默认收起（与大纲同口径：首屏空白页不需要它）；默认右停靠
  // （§9.5 状态栏 AI 钮入口 + §8.2 参考图右栏）。宽度默认 320（§10：面板
  // 首次打开时槽宽 <320 提到 320，这里直接给 320 兜底）。
  showReview: false,
  reviewSide: loadReviewSide(),
  reviewWidth: 320,
  minSidebarWidth: 160,
  bootWidthPending: true,
  splitRatio: 0.5,
  contentWidth: loadContentWidth(),
  customWidth: loadCustomWidth(),
  toasts: [],
  commandPaletteOpen: false,
  settingsOpen: false,
  introPhase: "idle",

  // 转换都带阶段门：乱序调用（StrictMode 双跑、看门狗与握手竞争）只能空转，
  // 不能把已演完的界面拽回起始态。
  startIntro: () => set((s) => (s.introPhase === "idle" ? { introPhase: "playing" } : {})),
  skipIntro: () => set((s) => (s.introPhase === "idle" ? { introPhase: "skipped" } : {})),
  finishIntro: () => set((s) => (s.introPhase === "playing" ? { introPhase: "done" } : {})),

  toggleNav: () => set((s) => ({ showNav: !s.showNav })),
  toggleOutline: () => set((s) => ({ showOutline: !s.showOutline })),
  // AI 核查面板开关。与大纲同侧时**不翻边**（2026-09-19 二轮，用户实测定案）：
  // 渲染层让核查占外侧列 + row 2/4 高栏、大纲栏顺势内移一列——推移而非覆盖，
  // 形如左贴边大纲栏与主区的关系。旧版「开起时把大纲翻到对侧」已删。
  toggleReview: () => set((s) => ({ showReview: !s.showReview })),
  setReviewOpen: (open) => set({ showReview: open }),
  setContentWidth: (w) => {
    localStorage.setItem(WIDTH_KEY, w);
    // 点菜单四档 = 放弃拖宽自定义：两处（store + localStorage）同步清
    localStorage.removeItem(CUSTOM_WIDTH_KEY);
    return set({ contentWidth: w, customWidth: null });
  },
  cycleContentWidth: () =>
    set((s) => {
      const next = CONTENT_WIDTHS[(CONTENT_WIDTHS.indexOf(s.contentWidth) + 1) % CONTENT_WIDTHS.length]!;
      localStorage.setItem(WIDTH_KEY, next);
      localStorage.removeItem(CUSTOM_WIDTH_KEY);
      return { contentWidth: next, customWidth: null };
    }),

  addToast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    // 自动 3s 清除；removeToast 幂等，早手动删掉后此回调为空操作
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3000);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  openPalette: () => set({ commandPaletteOpen: true }),
  closePalette: () => set({ commandPaletteOpen: false }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  setSidebarWidth: (w) => set({ sidebarWidth: w, bootWidthPending: false }),
  setOutlineWidth: (w) => set({ outlineWidth: w }),
  /* 首启回填：全新安装（无休眠快照、用户也没拖过）把侧栏直接落在默认最小宽度上
     ——首屏就是「侧栏最窄 + 上下两条分割线共线」的形态。由 TitleBar 首次实测出
     baseX 后调用；只生效一次，之后任何实测变化都不再覆盖（避免字体加载等引发的
     二次测量把用户后来拖的宽度改回去）。px<=0 = 尚未测出，忽略。 */
  applyDefaultSidebarWidth: (px) =>
    set((s) =>
      s.bootWidthPending && px > 0
        ? { sidebarWidth: px, bootWidthPending: false }
        : {},
    ),
  setOutlineSide: (s) => {
    localStorage.setItem(OUTLINE_SIDE_KEY, s);
    return set({ outlineSide: s });
  },
  // AI 核查 side 变更同 outline：写 localStorage + 改 state。side 纯属偏好，
  // 与大纲选边互不干涉（同侧共存由渲染层的列让位化解，见 App.tsx outlineCol）。
  setReviewSide: (s) => {
    localStorage.setItem(REVIEW_SIDE_KEY, s);
    return set({ reviewSide: s });
  },
  setReviewWidth: (w) => set({ reviewWidth: w }),
  setSplitRatio: (r) => set({ splitRatio: r }),
  setMinSidebarWidth: (px) => set({ minSidebarWidth: px }),

  setCustomWidth: (px) => {
    // 上限在拖拽处钳（那里才有面板实时宽），store 只保底下限
    const w = Math.max(MIN_CONTENT_WIDTH, px);
    localStorage.setItem(CUSTOM_WIDTH_KEY, String(w));
    set({ customWidth: w });
  },
}));
