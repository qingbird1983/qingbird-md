/**
 * S5 —— 核查时间线 steps 的派生（面板拆分的当场处方，预算红线 401→线内）。
 *
 * 输入全是原始值/稳定引用，输出确定性 steps 数组——纯函数，面板的 useMemo
 * 只负责缓存。两条派生规则：
 *
 * 1. 确定性步骤随翻译/检查状态走（S4 原样）；语义步骤随 ai.phase 走（S5）。
 * 2. **排序 = 折叠语义**：ReviewTimeline 默认只显「最新一步」。语义还没跑
 *    （pending）或无从跑（skipped）时，最新发生的事件是确定性检查的结果——
 *    语义占位排在前面，不盖住已有发现；一旦语义跑起来/有结论，它才是
 *    最新一步，排在后面接管折叠位。
 */
import type { ReviewStep } from "../components/ReviewTimeline";
import type { ReviewPhase } from "../hooks/useSemanticReview";

export interface ReviewStepsInput {
  mode: "original" | "translation" | "bilingual";
  translating: boolean;
  hasTranslations: boolean;
  checking: boolean;
  hasIssues: boolean;
  totalIssues: number;
  breakdown: string;
  llmReady: boolean;
  aiPhase: ReviewPhase;
  aiProgress: { done: number; total: number };
  aiError: string | null;
  /** 非拒绝（open + accepted）的语义条数：时间线的「N 处」口径。 */
  aiIssueCount: number;
  aiSummary: string;
  aiBreakdown: string;
}

export function buildReviewSteps(inp: ReviewStepsInput): ReviewStep[] {
  const det: ReviewStep[] = [];
  if (inp.mode === "original")
    det.push({ type: "deterministic", status: "skipped", summary: "确定性检查 · 未运行", detail: "当前为原文模式" });
  else if (inp.translating)
    det.push({
      type: "deterministic",
      status: "running",
      summary: "确定性检查 · 等翻译停",
      detail: "流式期查会把还没轮到的段落全报成漏译",
    });
  else if (!inp.hasTranslations)
    det.push({ type: "deterministic", status: "pending", summary: "确定性检查 · 待翻译", detail: "先翻译文档" });
  else if (inp.checking)
    det.push({ type: "deterministic", status: "running", summary: "确定性检查 · 进行中" });
  else
    det.push({
      type: "deterministic",
      status: "done",
      summary: inp.hasIssues ? `确定性检查 · ${inp.totalIssues} 处` : "确定性检查 · 通过",
      detail: inp.hasIssues ? inp.breakdown : "未发现结构性问题",
    });

  const semantic: ReviewStep =
    inp.mode === "original"
      ? { type: "semantic", status: "skipped", summary: "语义核查 · 未运行", detail: "当前为原文模式" }
      : inp.aiPhase === "idle"
        ? {
            type: "semantic",
            status: "pending",
            summary: "语义核查 · 未运行",
            detail: inp.llmReady ? "点下方「开始核查」" : "需配置大模型 → 设置 · LLM",
          }
        : inp.aiPhase === "running"
          ? {
              type: "semantic",
              status: "running",
              summary: inp.aiProgress.total
                ? `语义核查 · ${inp.aiProgress.done}/${inp.aiProgress.total} 批`
                : "语义核查 · 进行中",
              detail: "AI 只出问题清单，不改动文档",
            }
          : inp.aiPhase === "failed"
            ? { type: "semantic", status: "failed", summary: "语义核查 · 失败", detail: inp.aiError ?? undefined }
            : {
                type: "semantic",
                status: "done",
                summary: inp.aiIssueCount > 0 ? `语义核查 · ${inp.aiIssueCount} 处` : "语义核查 · 通过",
                detail: inp.aiIssueCount > 0 ? inp.aiBreakdown : inp.aiSummary || "未发现语义问题",
              };

  return semantic.status === "pending" || semantic.status === "skipped"
    ? [semantic, ...det]
    : [...det, semantic];
}
