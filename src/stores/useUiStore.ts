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

interface UiState {
  showNav: boolean;
  showOutline: boolean;
  sidebarWidth: number;
  outlineWidth: number;
  splitRatio: number; // split 视图左栏占比（Task 22；存 store 跨视图切换保持）
  toasts: Toast[];
  commandPaletteOpen: boolean;
  settingsOpen: boolean;

  toggleNav(): void;
  toggleOutline(): void;
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

export const useUiStore = create<UiState>()((set) => ({
  showNav: true,
  showOutline: true,
  sidebarWidth: 240,
  outlineWidth: 200,
  splitRatio: 0.5,
  toasts: [],
  commandPaletteOpen: false,
  settingsOpen: false,

  toggleNav: () => set((s) => ({ showNav: !s.showNav })),
  toggleOutline: () => set((s) => ({ showOutline: !s.showOutline })),

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
