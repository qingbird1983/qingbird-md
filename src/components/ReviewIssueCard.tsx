/**
 * S4 #16 —— 单条 issue 卡片（照 Guanmo `PendingEditCard`）。
 *
 * 两条不可省的约束：
 *
 * ① **必须含非 actionable 态**：跳不了的时候（预览未挂载 / 正文里没有对应锚点）
 *    **禁用跳转、并把原因说出来**，而不是把卡片隐藏掉。
 *    隐藏 = 用户看到"3 处问题"却只列出 2 条，会以为面板漏报。
 * ② 点卡片**只调 `jumpToIssue()`**（`lib/reviewJump.ts`）—— 锁窗 → 滚动 → 同步
 *    的三步顺序封装在那一个函数里，这里不许自己写 `scrollIntoView`。
 */
import { useState } from "react";
import type { Issue } from "../types/ipc";
import { issueKindLabel } from "../lib/issueKind";
import { type JumpBlockReason, jumpFailureHint, jumpToIssue } from "../lib/reviewJump";

export interface ReviewIssueCardProps {
  issue: Issue;
  /** 列表序号（1 起），仅用于视觉定位。 */
  seq: number;
  /** 渲染时探测到的不可跳原因；`null` = 可跳。 */
  blockReason: JumpBlockReason | null;
}

export default function ReviewIssueCard({ issue, seq, blockReason }: ReviewIssueCardProps) {
  // 渲染时判为可跳、但点下去时 DOM 已经变了（切了模式 / 面板收起 / 重新解析）
  // → 仍要把原因显出来，不能静默无反应。
  const [staleHint, setStaleHint] = useState<string | null>(null);

  const blocked = blockReason !== null;
  const hint = staleHint ?? (blockReason ? jumpFailureHint(blockReason) : null);

  const onClick = () => {
    const res = jumpToIssue(issue);
    setStaleHint(res.ok ? null : jumpFailureHint(res.reason));
  };

  return (
    <li className={`review-issue${blocked ? " blocked" : ""}`} data-kind={issue.kind}>
      <button
        type="button"
        className="review-issue-hit"
        disabled={blocked}
        aria-label={`跳转到第 ${issue.src_line} 行：${issueKindLabel(issue.kind)}`}
        title={blocked ? (hint ?? undefined) : `跳到 L${issue.src_line}`}
        onClick={onClick}
      >
        <span className="review-issue-head">
          <span className="review-issue-seq">{seq}</span>
          <span className="review-issue-kind">{issueKindLabel(issue.kind)}</span>
          <span className="review-issue-line">
            L{issue.src_line} → L{issue.dst_line}
          </span>
        </span>
        <span className="review-issue-src">{issue.src_excerpt}</span>
        {issue.dst_excerpt ? <span className="review-issue-dst">{issue.dst_excerpt}</span> : null}
      </button>
      {hint && <p className="review-issue-hint">{hint}</p>}
    </li>
  );
}
