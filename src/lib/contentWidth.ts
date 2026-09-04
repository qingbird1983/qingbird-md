// 正文宽度纯函数：四档 px 表 + 生效宽度合成 + 边缘拖宽换算 + 钳制。
//
// 四档 px 原先散在 markdown.css 的 .w-* 类里，本模块收编为单一事实来源：
// CSS 侧只消费 .preview-wrap 上的 --qb-content-w 变量（Task 4 挂载），
// 拖宽与档位都在这里算，store 只存值。
//
// 上限动态：maxPx = 预览面板实时宽度（窗口越宽可拖越宽，分栏下为半栏宽），
// 拖到留白归零即达上限。恢复旧值不回钳——存的自定义宽度大于当前面板时
// 由 CSS max-width 自然填满面板，存值不动（面板变宽后原值生效）。
import type { ContentWidth } from "../stores/useUiStore";

/** 拖宽下限：再窄伤排版（代码块/表格挤压）。 */
export const MIN_CONTENT_WIDTH = 480;

/** 四档 px 表（标准档 = A4 @96dpi 794px）。 */
export const CONTENT_WIDTH_PX: Record<ContentWidth, number> = {
  compact: 640,
  normal: 794,
  wide: 1000,
  full: 1200,
};

/** 钳进 [MIN_CONTENT_WIDTH, maxPx]；maxPx 极端窄于下限时保底 MIN。 */
export function clampContentWidth(px: number, maxPx: number): number {
  return Math.max(MIN_CONTENT_WIDTH, Math.min(maxPx, px));
}

/** 生效宽度：拖宽自定义优先，null（未拖过/已回档位）跟随四档。 */
export function contentWidthPx(preset: ContentWidth, custom: number | null): number {
  return custom ?? CONTENT_WIDTH_PX[preset];
}

/**
 * 边缘拖宽换算（列保持居中，两边对称开合）：
 * 右缘向右拖（dx>0）拉宽；左缘向左拖（dx<0）拉宽——统一 base ± dx 后钳制。
 */
export function edgeDragWidth(
  side: "left" | "right",
  basePx: number,
  dx: number,
  maxPx: number,
): number {
  return clampContentWidth(side === "right" ? basePx + dx : basePx - dx, maxPx);
}
