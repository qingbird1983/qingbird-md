/**
 * S5 —— AI 语义核查状态机（工单 17–20 的前端半边）。
 *
 * 职责边界：
 * - 只管「语义核查」这一次 AI 调用的生命周期：idle → running → done/failed、
 *   分批进度（`review-progress` 事件）、逐条 accept/reject、锚点漂移守卫。
 * - 不碰确定性检查（ReviewPanel 自有 runCheck 防抖链），两边在面板里合流展示。
 *
 * 红线（与 translate/review.rs 头注释同源）：
 * - provider 只用 llm 凭据——`llmReady` 由面板把门，这里以 creds 非空兜底；
 * - 结果不落任何持久层（不进 Cache）；取消 = stop_translation（REL-7 共享旗标）。
 *
 * 锚点漂移守卫（工单 19，借鉴 B3）：核查落定后记录发起时的**文档全文快照**，
 * 应用建议前全文比对——文档变过则 run 索引可能错位，一律拒改并把条目标 stale；
 * 另校验该 run 的现译文仍等于 AI 引用的 `current`，双保险。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { errText } from "../stores/useUiStore";
import { useDocStore } from "../stores/useDocStore";
import type { Mode, ReviewIssue, TargetLang } from "../types/ipc";

/** 单条 AI 问题的处置态。accepted/rejected 是终态，卡片折成已处置样式。 */
export type AiIssueStatus = "open" | "accepted" | "rejected";

export interface AiIssueView extends ReviewIssue {
  /** 列表内稳定序号（1 起）：卡片 key 与 accept/reject 的条目 id。 */
  seq: number;
  status: AiIssueStatus;
}

export type ReviewPhase = "idle" | "running" | "done" | "failed";

export interface SemanticReview {
  phase: ReviewPhase;
  /** 已处置（接受或拒绝）是否至少一条——决定「重新核查」按钮的强调。 */
  issues: AiIssueView[];
  progress: { done: number; total: number };
  error: string | null;
  /** 落定摘要：「模型 xxx · review-v1 · N 批失败」，时间线 detail 用。 */
  summary: string;
  /** 漂移守卫命中：文档在核查发起后变过，open 条目不可再应用。 */
  stale: boolean;
  /** 阶段派生：可否发起（面板按钮/Composer 的 disabled 用）。 */
  canStart: boolean;
  start: (instruction?: string) => void;
  cancel: () => void;
  accept: (seq: number) => Promise<boolean>;
  reject: (seq: number) => void;
}

export function useSemanticReview(args: {
  docContent: string | null;
  translations: Map<number, string>;
  mode: Mode;
  target: TargetLang;
  creds: Record<string, string>;
  llmReady: boolean;
  translating: boolean;
}): SemanticReview {
  const { docContent, translations, mode, target, creds, llmReady, translating } = args;

  const [phase, setPhase] = useState<ReviewPhase>("idle");
  const [issues, setIssues] = useState<AiIssueView[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  /** 重入闸：异步闭包里读 state 永远是旧值，飞不飞行只有 ref 说了算（runCheck 同款）。 */
  const runningRef = useRef(false);
  /** 生成号：过期落定（取消/重开）不得覆盖新一轮的状态。 */
  const genRef = useRef(0);
  /** 漂移守卫基准：核查发起时的文档全文。null = 没发起过。 */
  const snapshotRef = useRef<string | null>(null);
  /** 译文表身份追踪：上一次见过的表 / 自己 accept 写回的表（免自_Reset）。 */
  const seenTransRef = useRef(translations);
  const selfTransRef = useRef<Map<number, string> | null>(null);

  // 分批进度事件（挂载期订阅一次；unlisten 是 Promise，卸载时兑现再调）。
  useEffect(() => {
    const un = api.listenReviewProgress((p) => setProgress(p));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setIssues([]);
    setError(null);
    setSummary("");
    setProgress({ done: 0, total: 0 });
    snapshotRef.current = null;
  }, []);

  // 译文表换了身份（重译 merge / 清空 / 别处写回）且不是自己 accept 写的 →
  // 旧清单的 run 语义整体失效，整个核查归零。自己写回的那张表放行，
  // 否则刚点「接受」清单就被自己的副作用洗掉。
  useEffect(() => {
    if (seenTransRef.current === translations) return;
    seenTransRef.current = translations;
    if (selfTransRef.current === translations) return;
    reset();
  }, [translations, reset]);

  const start = useCallback(
    (instruction?: string) => {
      if (!llmReady || translating || runningRef.current) return;
      if (mode === "original" || translations.size === 0 || docContent === null) return;
      runningRef.current = true;
      const gen = ++genRef.current;
      snapshotRef.current = docContent;
      setPhase("running");
      setError(null);
      setIssues([]);
      setProgress({ done: 0, total: 0 });
      void api
        .reviewSemantic(
          docContent,
          Array.from(translations),
          mode,
          target,
          instruction?.trim() || null,
          creds,
        )
        .then((out) => {
          if (gen !== genRef.current) return;
          setSummary(
            `模型 ${out.model} · ${out.fingerprint}` +
              (out.batch_failed ? ` · ${out.batch_failed}/${out.batch_total} 批失败` : "") +
              (out.batch_total ? ` · ${out.batch_total} 批` : ""),
          );
          setIssues(out.issues.map((i, k) => ({ ...i, seq: k + 1, status: "open" as const })));
          setPhase("done");
        })
        .catch((e: unknown) => {
          if (gen !== genRef.current) return;
          setError(errText(e));
          setPhase("failed");
        })
        .finally(() => {
          runningRef.current = false;
        });
    },
    [llmReady, translating, mode, translations, docContent, target, creds],
  );

  // 取消 = 掐共享旗标（后端在途批在流式行边界失败退出）+ 本地立即归 idle。
  // bump gen：慢一拍落定的 Err("核查已取消") 不得把 idle 打回 failed。
  const cancel = useCallback(() => {
    if (!runningRef.current) return;
    genRef.current += 1;
    runningRef.current = false;
    setPhase("idle");
    setProgress({ done: 0, total: 0 });
    void api.stopTranslation();
  }, []);

  /** 接受：把建议写回译文表并重建 done html。返回是否成功（卡片据此消 toast）。 */
  const accept = useCallback(
    async (seq: number): Promise<boolean> => {
      if (mode === "original" || docContent === null) return false;
      if (snapshotRef.current !== null && snapshotRef.current !== docContent) return false;
      const issue = issues.find((i) => i.seq === seq);
      if (!issue || issue.status !== "open") return false;
      // 双保险之二：该 run 的现译文必须仍是 AI 引用的那份
      if (translations.get(issue.run) !== issue.current) return false;
      const next = new Map(translations);
      next.set(issue.run, issue.suggested);
      selfTransRef.current = next;
      try {
        const html = await api.renderTranslated(
          docContent,
          mode,
          Array.from(next),
          target,
        );
        useDocStore.getState().applyTranslationResult(next, {
          contentKey: docContent,
          mode,
          html: html.html,
        });
        seenTransRef.current = next;
        setIssues((list) =>
          list.map((i) => (i.seq === seq ? { ...i, status: "accepted" as const } : i)),
        );
        return true;
      } catch {
        selfTransRef.current = null;
        return false;
      }
    },
    [mode, docContent, issues, translations, target],
  );

  /** 拒绝：纯标记，不动任何数据。 */
  const reject = useCallback((seq: number) => {
    setIssues((list) =>
      list.map((i) => (i.seq === seq && i.status === "open" ? { ...i, status: "rejected" as const } : i)),
    );
  }, []);

  const stale = snapshotRef.current !== null && snapshotRef.current !== docContent;
  const checkable = llmReady && !translating && mode !== "original" && translations.size > 0;
  const canStart = checkable && phase !== "running";

  return { phase, issues, progress, error, summary, stale, canStart, start, cancel, accept, reject };
}
