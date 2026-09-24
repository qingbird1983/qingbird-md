// 全站统一的胶囊分段控件：选中项由一枚浮层「滑块」承载，横移+变宽走同一动效。
// 容器类名沿用各挂载点的既有皮肤（viewseg / setseg / setseg sm），
// 样式只多一条 .seg + .seg-thumb（10-settings.css），杜绝两套动效漂移（2026-09-24 需求）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** 禁用占位小尾巴（如「暂未支持」），仅 setseg 皮肤用得到该样式 */
  tag?: string;
  title?: string;
}

export function Seg<T extends string>(props: {
  options: readonly SegOption<T>[];
  value: T;
  onChange?: (v: T) => void;
  variant: "viewseg" | "setseg" | "setseg sm";
  ariaLabel?: string;
}) {
  const { options, value, onChange, variant, ariaLabel } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const btns = useRef(new Map<T, HTMLButtonElement | null>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = btns.current.get(value);
    const box = wrap.current;
    if (el && box) setThumb({ x: el.offsetLeft - box.clientLeft, w: el.offsetWidth });
    else setThumb(null);
    // options 入依赖：文案/条数变化后重测（value 不变时也保准确）
  }, [value, options]);

  useEffect(() => {
    const onResize = () => {
      const el = btns.current.get(value);
      const box = wrap.current;
      if (el && box) setThumb({ x: el.offsetLeft - box.clientLeft, w: el.offsetWidth });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [value, options]);

  // 首帧无过渡（防止滑块从 0 滑入的穿帮），量完下一拍才允许动画
  useEffect(() => {
    if (!ready && thumb) requestAnimationFrame(() => setReady(true));
  }, [thumb, ready]);

  return (
    <div ref={wrap} className={`seg ${variant}`} role="group" aria-label={ariaLabel}>
      <span
        aria-hidden
        className={`seg-thumb${ready ? " seg-ready" : ""}`}
        style={thumb ? { transform: `translateX(${thumb.x}px)`, width: thumb.w } : { opacity: 0 }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          title={o.title ?? o.label}
          ref={(el) => { btns.current.set(o.value, el); }}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
          {o.tag && <span className="setseg-tag">{o.tag}</span>}
        </button>
      ))}
    </div>
  );
}
