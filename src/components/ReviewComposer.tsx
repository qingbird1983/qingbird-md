/**
 * S5 #12 —— ReviewComposer：AI 核查的追问输入（原 S4 工单第 5 项并入 S5）。
 *
 * 行为规格（工单原文）：Enter 发送 / Shift+Enter 换行 / 自动增高 / 核查中
 * disabled + 取消。发送 = 以输入为 `instruction`（followup）重跑语义核查——
 * 后端把它并进请求体，围绕追问重点复查（translate/review.rs SYSTEM 规则 6）。
 *
 * IME 守卫照 CommandPalette 惯例：`isComposing || keyCode === 229` 时不吃
 * Enter——中文输入法选词回车是组词，不是发送。
 */
import { useRef, useState } from "react";

export interface ReviewComposerProps {
  /** 输入框禁用：核查中，或当前不可核查（原文模式/无译文/未配 LLM）。 */
  disabled: boolean;
  /** 核查进行中：右侧按钮变「取消」（工单：流式中 disabled + 取消）。 */
  running: boolean;
  /** 占位文案随状态换：首轮「让核查重点关注…」，追轮「继续追问…」。 */
  placeholder: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}

/** 自动增高的上限：追问是短指令，再高就该换编辑器写了。 */
const MAX_HEIGHT_PX = 120;

export default function ReviewComposer({
  disabled,
  running,
  placeholder,
  onSend,
  onCancel,
}: ReviewComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoresize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    // 清空后下一帧再量高度，避免残留的 scrollHeight 撑着框
    requestAnimationFrame(autoresize);
  };

  return (
    <div className="review-composer">
      <textarea
        ref={ref}
        rows={1}
        className="review-composer-input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="核查追问"
        onChange={(e) => {
          setValue(e.target.value);
          autoresize();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          send();
        }}
      />
      {running ? (
        <button
          type="button"
          className="review-composer-send cancel"
          aria-label="取消核查"
          title="取消核查"
          onClick={onCancel}
        >
          ✕
        </button>
      ) : (
        <button
          type="button"
          className="review-composer-send"
          disabled={disabled || !value.trim()}
          aria-label="发送追问"
          title="发送（Enter）"
          onClick={send}
        >
          ↑
        </button>
      )}
    </div>
  );
}
