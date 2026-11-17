// 划词翻译浮窗：选中文本 → 走全局翻译源译出纯文本 → 弹窗展示。
// 选区捕获、300ms 防抖、乱序保护在 store；本组件纯渲染 + Esc/点外关闭。
import { useEffect, useRef } from "react";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useSettingsStore } from "../stores/useSettingsStore";

export default function SelectionPopup() {
  const sel = useTranslationStore((s) => s.selection);
  const clearSelection = useTranslationStore((s) => s.clearSelection);
  const on = useSettingsStore((s) => s.settings?.selection_translate ?? false);
  const ref = useRef<HTMLDivElement>(null);

  // 开关关闭：render 即时隐藏之外还要清态——clearSelection 连带清防抖定时器，
  // 在途请求结果也因子代失配（selection 已为 null）被丢弃，重开不闪旧结果。
  useEffect(() => {
    if (!on) clearSelection();
  }, [on, clearSelection]);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    const onDown = (e: MouseEvent) => {
      // 浮窗外按下（含在编辑器里开始新的拖选）即关闭；新选区随后自然重触发
      if (ref.current && !ref.current.contains(e.target as Node)) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [sel, clearSelection]);

  if (!on || !sel) return null;

  return (
    <div className="sel-pop" ref={ref} role="dialog" aria-label="划词翻译">
      <div className="sel-pop-head">
        <span className="sel-pop-title">划词翻译</span>
        <button type="button" className="sel-pop-clear" onClick={clearSelection}>
          清除
        </button>
      </div>
      {sel.loading ? (
        <div className="sel-pop-spin" aria-label="翻译中" />
      ) : sel.error ? (
        <div className="sel-pop-res sel-pop-err">{sel.error}</div>
      ) : (
        <>
          <div className="sel-pop-src">{sel.text}</div>
          <div className="sel-pop-sep" />
          <div className="sel-pop-res">{sel.plain}</div>
        </>
      )}
    </div>
  );
}
