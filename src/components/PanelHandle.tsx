// （P2-8f 自 App.tsx 纯提取，体逐字。）
// 侧栏把手（"舌"）：钉在槽边缘垂直中点，48×20 高而窄，只圆内侧两角，
// 底色透明（滚动条从下方穿过），无阴影（DESIGN.md 贴面零阴影）。
// 箭头方向 = side × collapsed 两个布尔共同决定（§9.2 物理规则）：
//   箭头 = 面板那条边「将要移动」的方向。
//   右停靠 未展开 ‹ ／ 已展开 ›
//   左停靠 未展开 › ／ 已展开 ‹
// 只做「展开/收起」，不兼停靠切换（§9.2：两件事两个控件）。
import type { PanelSide } from "../stores/useUiStore";

export function PanelHandle({
  side,
  showPanel,
  onToggle,
  label,
}: {
  side: PanelSide;
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
