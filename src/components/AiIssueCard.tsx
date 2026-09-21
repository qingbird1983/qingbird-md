/**
 * S5 #19 —— AI 语义问题卡片：跳转 + 逐条 接受/拒绝。
 *
 * 与确定性 `ReviewIssueCard` 的分工：那张卡只「可看可跳」；这张多两个处置
 * 动作——**接受**把 `suggested` 写回翻译表对应 run（走 useSemanticReview 的
 * 双重守卫：全文快照比对 + `current` 比对），**拒绝**纯标记。每一条处置
 * 都可追溯（AI 只出清单、用户逐条定夺——correctness §L2 的红线形态）。
 *
 * 非 actionable 态照 S4 #16 铁律：跳不了要**禁用并写明原因**，不许隐藏。
 */
import { useState } from "react";
import type { AiIssueView } from "../hooks/useSemanticReview";
import { aiKindLabel, SEVERITY_LABEL } from "../lib/issueKind";
import { type JumpBlockReason, jumpFailureHint, jumpToIssue } from "../lib/reviewJump";

export interface AiIssueCardProps {
  issue: AiIssueView;
  /** 漂移守卫命中（文档在核查后变过）：接受禁用并说明。 */
  stale: boolean;
  blockReason: JumpBlockReason | null;
  onAccept: (seq: number) => void;
  onReject: (seq: number) => void;
}

export default function AiIssueCard({ issue, stale, blockReason, onAccept, onReject }: AiIssueCardProps) {
  const [staleHint, setStaleHint] = useState<string | null>(null);
  const handled = issue.status !== "open";
  const blocked = blockReason !== null;
  const hint = staleHint ?? (blockReason ? jumpFailureHint(blockReason) : null);

  const onClick = () => {
    const res = jumpToIssue(issue);
    setStaleHint(res.ok ? null : jumpFailureHint(res.reason));
  };

  return (
    <li
      className={`review-issue ai ${issue.status}${stale ? " stale" : ""}${blocked ? " blocked" : ""}`}
      data-kind={issue.kind}
      data-severity={issue.severity}
    >
      <button
        type="button"
        className="review-issue-hit"
        disabled={blocked}
        aria-label={`跳转到正文对应位置：${aiKindLabel(issue.kind)}`}
        title={blocked ? (hint ?? undefined) : undefined}
        onClick={onClick}
      >
        <span className="review-issue-head">
          <span className="review-issue-seq">{issue.seq}</span>
          <span className="review-issue-sev" data-severity={issue.severity}>
            {SEVERITY_LABEL[issue.severity] || issue.severity}
          </span>
          <span className="review-issue-kind">{aiKindLabel(issue.kind)}</span>
          {handled && <span className="review-issue-done">{issue.status === "accepted" ? "已接受" : "已拒绝"}</span>}
        </span>
        <span className="review-issue-reason">{issue.reason}</span>
        <span className="review-issue-dst">{issue.current}</span>
        <span className="review-issue-suggested">→ {issue.suggested}</span>
      </button>
      {hint && <p className="review-issue-hint">{hint}</p>}
      {issue.status === "open" && (
        <div className="review-issue-actions">
          <button
            type="button"
            className="review-issue-btn accept"
            disabled={stale}
            title={stale ? "文档已变更，请重新核查后再应用" : "把建议写回译文"}
            onClick={() => onAccept(issue.seq)}
          >
            接受
          </button>
          <button type="button" className="review-issue-btn reject" onClick={() => onReject(issue.seq)}>
            拒绝
          </button>
        </div>
      )}
    </li>
  );
}
