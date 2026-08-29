// T26 共用模态壳：遮罩 + 居中卡片。关闭路径 = Esc / 点击遮罩空白处 /
// 调用方主动 onClose（取消、保存成功）。Esc 监听尊重 defaultPrevented——
// 内层（如快捷键录制）在 capture 阶段吃掉按键时，壳层让路不关窗。
import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export default function Modal({ title, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-title">{title}</div>
        {/* 三段式模态：body 承载内容并自成滚动；.modal-actions 以负边距贴底成 foot */}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
