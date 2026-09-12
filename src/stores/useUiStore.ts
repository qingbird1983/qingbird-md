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

/** 大纲栏停靠侧：right = 窗口右缘（默认）；left = 吸附在工作区左缘（侧栏与主区之间） */
export type OutlineSide = "left" | "right";

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
  // 工作区最小宽度：由 TitleBar 按标签条归位临界实测写入（baseX+3，见
  // TitleBar.tsx），拖拽钳制用它——拉到最小时分隔线正好是标签条贴最左的位置。
  // 初值 160 为兜底（测量完成前的一帧）。
  minSidebarWidth: number;
  splitRatio: number; // split 视图左栏占比（Task 22；存 store 跨视图切换保持）
  contentWidth: ContentWidth; // 正文宽度档（markdown.css .markdown-body.w-*）
  customWidth: number | null; // 拖宽产物（null = 跟随四档档位）
  toasts: Toast[];
  commandPaletteOpen: boolean;
  settingsOpen: boolean;

  toggleNav(): void;
  toggleOutline(): void;
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
  setSplitRatio(r: number): void;
  setMinSidebarWidth(px: number): void;
}

let toastSeq = 0;

// 宽度偏好跨启动保留：Tauri WebView2 的 localStorage 随应用数据目录持久化，
// 一个档位值不值得走 Rust 设置文件。旧布尔键一次性迁移（"1"→wide，"0"/缺失→normal）。
const WIDTH_KEY = "qb.content-width";
const CUSTOM_WIDTH_KEY = "qb.content-width-custom";
const LEGACY_WIDE_KEY = "qb.wide-content";
// 大纲栏停靠侧：纯 UI 偏好，走 localStorage（不进 Rust 会话快照，避免动契约）
const OUTLINE_SIDE_KEY = "qb.outline-side";

function loadOutlineSide(): OutlineSide {
  return localStorage.getItem(OUTLINE_SIDE_KEY) === "left" ? "left" : "right";
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
  showOutline: true,
  outlineSide: loadOutlineSide(),
  sidebarWidth: 240,
  outlineWidth: 200,
  minSidebarWidth: 160,
  splitRatio: 0.5,
  contentWidth: loadContentWidth(),
  customWidth: loadCustomWidth(),
  toasts: [],
  commandPaletteOpen: false,
  settingsOpen: false,

  toggleNav: () => set((s) => ({ showNav: !s.showNav })),
  toggleOutline: () => set((s) => ({ showOutline: !s.showOutline })),
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

  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setOutlineWidth: (w) => set({ outlineWidth: w }),
  setOutlineSide: (s) => {
    localStorage.setItem(OUTLINE_SIDE_KEY, s);
    return set({ outlineSide: s });
  },
  setSplitRatio: (r) => set({ splitRatio: r }),
  setMinSidebarWidth: (px) => set({ minSidebarWidth: px }),

  setCustomWidth: (px) => {
    // 上限在拖拽处钳（那里才有面板实时宽），store 只保底下限
    const w = Math.max(MIN_CONTENT_WIDTH, px);
    localStorage.setItem(CUSTOM_WIDTH_KEY, String(w));
    set({ customWidth: w });
  },
}));
