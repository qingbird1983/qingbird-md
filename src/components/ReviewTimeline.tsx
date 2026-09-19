/**
 * S4 #11 —— 核查进度时间线（照 Guanmo `AgentTimeline`）。
 *
 * 默认**折叠**：只显最新一步 + 状态点。核查步骤会越来越多（确定性 → 分批语义核查
 * → 重排版建议），全展开会把 issue 列表挤到屏幕外，而用户真正要看的永远是
 * 「现在跑到哪了」。
 *
 * S4 **只接确定性检查这一步**（"确定性检查 · N 处"）——壳先搭好，
 * AI 语义核查的步骤由 S5 往 `steps` 里加，本组件不用改。
 */
import { useState } from "react";

export type ReviewStepType = "deterministic" | "semantic";
export type ReviewStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface ReviewStep {
  type: ReviewStepType;
  status: ReviewStepStatus;
  /** 主文案，如「确定性检查 · 3 处」。 */
  summary: string;
  /** 次文案（可省），如失败原因 / 分批进度。 */
  detail?: string;
}

/**
 * 状态 → 视觉色调。`satisfies Record<ReviewStepStatus, string>` 保证**穷尽**：
 * 将来加一个状态（如 `cancelled`）而忘了配色，这里立刻 tsc 报错。
 */
export const STEP_STATUS_TONE = {
  pending: "idle",
  running: "busy",
  done: "ok",
  skipped: "idle",
  failed: "bad",
} satisfies Record<ReviewStepStatus, string>;

/** 折叠态下的 aria 文案（读屏用户看不到"只显示最新一步"这件事）。 */
const FOLD_HINT = "只显示最新一步";

export default function ReviewTimeline({ steps }: { steps: ReviewStep[] }) {
  const [open, setOpen] = useState(false);
  // 只有一步时不给折叠开关——那个开关点了没有任何视觉变化，纯噪声。
  const foldable = steps.length > 1;
  const visible = foldable && !open ? steps.slice(-1) : steps;

  if (steps.length === 0) return null;

  return (
    <section className="review-timeline" aria-label="核查进度">
      <div className="review-timeline-head">
        <span className="review-timeline-title">进度</span>
        {foldable && (
          <button
            type="button"
            className="review-timeline-toggle"
            aria-expanded={open}
            title={open ? "收起，只看最新一步" : `展开全部 ${steps.length} 步`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "收起" : `全部 ${steps.length} 步`}
          </button>
        )}
      </div>
      <ol className="review-timeline-list" aria-live="polite">
        {visible.map((step, i) => {
          const tone = STEP_STATUS_TONE[step.status];
          return (
            <li key={`${step.type}-${i}`} className="review-step" data-tone={tone}>
              <span className="review-step-dot" aria-hidden="true" />
              <span className="review-step-text">
                <span className="review-step-summary">{step.summary}</span>
                {step.detail && <span className="review-step-detail">{step.detail}</span>}
              </span>
              <span className="review-step-status">
                {tone === "busy" ? "进行中" : tone === "bad" ? "失败" : tone === "ok" ? "完成" : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {foldable && !open && <p className="review-timeline-folded">{FOLD_HINT}</p>}
    </section>
  );
}
