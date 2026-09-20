// （P2-8f 自 App.tsx 纯提取，体逐字。）与主区 SplitBody 中缝共用
// lib/colDrag 的纯 Pointer Events 拖拽。
// place 决定「条贴在哪块面板的哪条边」，同时决定拖拽方向的符号：
// - sidebar：贴文件栏右缘，右拖增宽（+dx）——独立网格列 col2；
// - outline-right / review-right：贴右停靠面板左缘，左拖增宽（-dx）；
// - outline-left / review-left：贴左停靠面板右缘，右拖增宽（+dx）。
// 大纲/核查的条**内嵌在 .panel-slot 里**（2026-09-19 同侧共存重构：不再是
// 独立网格列 col4/col6——两面板同侧时各槽自带一条，发丝线仍贴主区那侧）。
// 宽度存 uiStore，跨视图切换保持。
import type { PointerEvent as ReactPointerEvent } from "react";
import { startColDrag } from "../lib/colDrag";
import { useUiStore } from "../stores/useUiStore";

// 面板宽度钳制：左右栏与主区之间拖宽条的取值范围（默认 240/200 落在其中）
export const PANEL_MIN = 160;
export const PANEL_MAX = 480;

export type ResizerPlace = "sidebar" | "outline-right" | "outline-left" | "review-right" | "review-left";

export function PanelResizer({ place, hidden }: { place: ResizerPlace; hidden: boolean }) {
  // CSS 类映射：sidebar→res-left（独立 col2 网格条）；面板槽内的条共用 in-slot，
  // 线的朝向（贴主区那侧）由 .panel-slot[data-side] 规则决定，不在这里分叉。
  const cls = place === "sidebar" ? "res-left" : "in-slot";
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
