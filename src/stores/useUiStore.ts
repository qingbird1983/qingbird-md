// 全局 UI 杂项状态：面板折叠、分栏宽度、toast 队列、弹层开关。
// 本 store 不读取其它 store（依赖边界的终点）。
import { create } from "zustand";

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
  sidebarWidth: number;
  outlineWidth: number;
  splitRatio: number; // split 视图左栏占比（Task 22；存 store 跨视图切换保持）
  contentWidth: ContentWidth; // 正文宽度档（markdown.css .markdown-body.w-*）
  toasts: Toast[];
  commandPaletteOpen: boolean;
  settingsOpen: boolean;

  toggleNav(): void;
  toggleOutline(): void;
  setContentWidth(w: ContentWidth): void;
  cycleContentWidth(): void;
  addToast(kind: ToastKind, text: string): void;
  removeToast(id: number): void;
  openPalette(): void;
  closePalette(): void;
  openSettings(): void;
  closeSettings(): void;
  setSidebarWidth(w: number): void;
  setOutlineWidth(w: number): void;
  setSplitRatio(r: number): void;
}

let toastSeq = 0;

// 宽度偏好跨启动保留：Tauri WebView2 的 localStorage 随应用数据目录持久化，
// 一个档位值不值得走 Rust 设置文件。旧布尔键一次性迁移（"1"→wide，"0"/缺失→normal）。
const WIDTH_KEY = "qb.content-width";
const LEGACY_WIDE_KEY = "qb.wide-content";

function loadContentWidth(): ContentWidth {
  const saved = localStorage.getItem(WIDTH_KEY) as ContentWidth | null;
  if (saved && CONTENT_WIDTHS.includes(saved)) return saved;
  return localStorage.getItem(LEGACY_WIDE_KEY) === "1" ? "wide" : "normal";
}

export const useUiStore = create<UiState>()((set) => ({
  showNav: true,
  showOutline: true,
  sidebarWidth: 240,
  outlineWidth: 200,
  splitRatio: 0.5,
  contentWidth: loadContentWidth(),
  toasts: [],
  commandPaletteOpen: false,
  settingsOpen: false,

  toggleNav: () => set((s) => ({ showNav: !s.showNav })),
  toggleOutline: () => set((s) => ({ showOutline: !s.showOutline })),
  setContentWidth: (w) => {
    localStorage.setItem(WIDTH_KEY, w);
    return set({ contentWidth: w });
  },
  cycleContentWidth: () =>
    set((s) => {
      const next = CONTENT_WIDTHS[(CONTENT_WIDTHS.indexOf(s.contentWidth) + 1) % CONTENT_WIDTHS.length]!;
      localStorage.setItem(WIDTH_KEY, next);
      return { contentWidth: next };
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
  setSplitRatio: (r) => set({ splitRatio: r }),
}));
