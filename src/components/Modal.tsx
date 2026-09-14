// T26 共用模态壳：遮罩 + 居中卡片。关闭路径 = Esc / 点击遮罩空白处 /
// 调用方主动 onClose（取消、保存成功）。Esc 监听尊重 defaultPrevented——
// 内层（如快捷键录制）在 capture 阶段吃掉按键时，壳层让路不关窗。
//
// 尺寸（2026-09-14 加）：md = 表单类窄弹窗（默认，单列）；lg = 左右分栏的
// 设置面板。只切宽度与固定高度两件事，内容布局由调用方负责。
//
// title 可省（2026-09-14）：设置面板去掉了「上眉」，自己带一条工具条
// （搜索框 + 关闭叉）。壳层此时不渲染标题条，只把 aria-label 留给
// role="dialog" 的无障碍名。
import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  /** 标题条文案；省略即不渲染标题条（调用方自带头部） */
  title?: string;
  onClose: () => void;
  children: ReactNode;
  /** 弹窗尺寸档。默认 md（460–580 单列）；lg 给左右分栏用（720–980）。 */
  size?: "md" | "lg";
  /** 无障碍名；省略时用 title */
  ariaLabel?: string;
}

export default function Modal({ title, onClose, children, size = "md", ariaLabel }: ModalProps) {
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
      <div
        className={`modal${size === "lg" ? " modal-lg" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        ref={ref}
      >
        {title !== undefined && <div className="modal-title">{title}</div>}
        {/* 三段式模态：body 承载内容并自成滚动；.modal-actions 以负边距贴底成 foot */}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
