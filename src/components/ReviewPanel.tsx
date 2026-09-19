// AI 核查面板（§八）：侧栏槽位双宿主之一，与大纲栏共用两个侧栏槽。
//
// S4 已落地：槽头 + 进度时间线 + issue 可点列表（含非 actionable 态）+ 滚动跟随。
// `ReviewComposer`（AI 追问输入）整体并入 S5 —— 它的数据源语义核查在 S5。
//
// 确定性检查（checkTranslation IPC）零 AI 成本——纯结构对比，面板一有译文就跑。
// 语义核查（AI，锁定 llm 大模型）是另一条路径，依赖 LLM 凭据齐全
// （baseUrl + model），未配置则按钮禁用 + 明示原因（§七.1 R2），**不静默降级**。
import { useCallback, useEffect, useMemo, useState } from "react";
import ReviewIssueCard from "./ReviewIssueCard";
import ReviewTimeline, { type ReviewStep } from "./ReviewTimeline";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";
import { checkTranslation, countByKind } from "../lib/checkTranslation";
import { issueKindLabel } from "../lib/issueKind";
import { type JumpBlockReason, jumpBlockReason } from "../lib/reviewJump";
import { useStreamFollow } from "../lib/streamFollow";
import type { Issue } from "../types/ipc";

/** 稳定空表：翻译进行中拿它顶替清单，避免每次渲染都造新数组触发无谓重渲。 */
const EMPTY_ISSUES: Issue[] = [];

export default function ReviewPanel() {
  const doc = useDocStore((s) => s.doc);
  const translations = useDocStore((s) => s.translations);
  const mode = useDocStore((s) => s.mode);
  const toggleReview = useUiStore((s) => s.toggleReview);
  const creds = useSettingsStore((s) => s.credsFor("llm"));
  /** 翻译运行的实时状态：用来把「流式期」和「已定稿」分开，见 runCheck。 */
  const translationStatus = useTranslationStore((s) => s.status);
  const translating = translationStatus === "running";

  // LLM 凭据齐全（baseUrl + model 均非空）——§七.1 R1。
  // credsFor 返回 {} 时 baseUrl/model 为 undefined，?. 是真实守卫。
  const llmReady = Boolean(creds.baseUrl?.trim() && creds.model?.trim());

  const [issues, setIssues] = useState<Issue[]>([]);
  const [checking, setChecking] = useState(false);
  /** 渲染期探测出的不可跳原因，下标对齐 `issues`。 */
  const [blockReasons, setBlockReasons] = useState<Record<number, JumpBlockReason>>({});

  const checkable = mode !== "original" && translations.size > 0 && !!doc;

  // 面板打开 + 有译文 + 翻译模式 + **翻译已停** → 跑确定性检查。
  //
  // 为什么必须等翻译停：译文表是 `mergeTranslations` **逐批** merge 进来的，
  // 流式期查一遍会把"还没轮到"的 run 全报成 `OmittedUntranslated` ——
  // 面板被假问题刷屏，而用户完全没做错什么；顺带每批都要跑一次 IPC。
  // 依赖里同时留 `translations` 与 `translationStatus`：两者谁后落地都能触发
  // 最后一查（只留状态会漏掉"状态先停、表后到"的窗口）。
  const runCheck = useCallback(async () => {
    if (translating) return;
    if (!checkable) {
      // 「原文模式或无译文时清空」——原先只剩注释、没有代码：切回原文模式
      // 会留着上一次的清单，配上"预览未挂载"的禁用卡片，读起来像是误报。
      setIssues([]);
      return;
    }
    setChecking(true);
    try {
      const result = await checkTranslation(doc.content, translations);
      setIssues(result);
    } catch {
      setIssues([]);
    } finally {
      setChecking(false);
    }
  }, [translating, checkable, doc, translations]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  // 翻译进行中：`issues` 里的结果是**上一版译文**的，已经不对应当前内容了 →
  // 先收起来别展示（时间线会说明"等翻译停再查"），免得用户照着假清单去改译法。
  const visibleIssues = translating ? EMPTY_ISSUES : issues;
  const counts = countByKind(visibleIssues);
  const totalIssues = visibleIssues.length;
  const hasIssues = totalIssues > 0;

  const breakdown = useMemo(
    () =>
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} 处${issueKindLabel(kind as Issue["kind"])}`)
        .join(" · "),
    [counts],
  );

  // 确定性检查这一步的进度（S5 的语义核查步骤往同一个数组里追加）。
  const steps: ReviewStep[] = useMemo(() => {
    if (mode === "original")
      return [{ type: "deterministic", status: "skipped", summary: "确定性检查 · 未运行", detail: "当前为原文模式" }];
    if (translating)
      return [
        {
          type: "deterministic",
          status: "running",
          summary: "确定性检查 · 等翻译停",
          detail: "流式期查会把还没轮到的段落全报成漏译",
        },
      ];
    if (translations.size === 0)
      return [{ type: "deterministic", status: "pending", summary: "确定性检查 · 待翻译", detail: "先翻译文档" }];
    if (checking) return [{ type: "deterministic", status: "running", summary: "确定性检查 · 进行中" }];
    return [
      {
        type: "deterministic",
        status: "done",
        summary: hasIssues ? `确定性检查 · ${totalIssues} 处` : "确定性检查 · 通过",
        detail: hasIssues ? breakdown : "未发现结构性问题",
      },
    ];
  }, [mode, translating, translations, checking, hasIssues, totalIssues, breakdown]);

  // 渲染期探测「这条能不能跳」。必须等一帧：issue 由 IPC 异步返回时，
  // 预览的重解析可能还没落 DOM，立刻探测会把可跳的全判成不可跳。
  // 依赖里带 `mode`：切到分栏/预览会让 `.preview-scroll` 出现或消失。
  useEffect(() => {
    if (visibleIssues.length === 0) {
      setBlockReasons({});
      return;
    }
    const raf = requestAnimationFrame(() => {
      const next: Record<number, JumpBlockReason> = {};
      visibleIssues.forEach((issue, i) => {
        const reason = jumpBlockReason(issue);
        if (reason) next[i] = reason;
      });
      setBlockReasons(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleIssues, mode]);

  // 滚动跟随（§8.5 四要点）：会话键 = 当前文档路径，换文档即解除"已滚离"锁存。
  const { ref: scrollRef, follow, jumpToBottom, interrupted } = useStreamFollow<HTMLDivElement>(doc?.path);
  useEffect(() => {
    follow("grow");
  }, [visibleIssues.length, follow]);

  return (
    <>
      {/* 槽头（§8.3 ①）：标题「AI 核查」+ 关闭 */}
      <div className="review-title">
        <span className="review-title-text">AI 核查</span>
        <button
          type="button"
          className="review-close"
          title="收起 AI 核查"
          aria-label="收起 AI 核查"
          onClick={toggleReview}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 滚动区（§8.5 的跟随对象）：进度 + issue 列表 / 空态引导卡 */}
      <div className="review-body" ref={scrollRef}>
        <ReviewTimeline steps={steps} />

        {hasIssues ? (
          <>
            <div className="review-checks-bar warn">
              <span>
                <span className="count">{totalIssues}</span> 处确定性检查问题：{breakdown}
              </span>
            </div>
            <ul className="review-issues" aria-label="确定性问题清单">
              {visibleIssues.map((issue, i) => (
                <ReviewIssueCard
                  key={`${issue.run}-${issue.kind}-${i}`}
                  issue={issue}
                  seq={i + 1}
                  blockReason={blockReasons[i] ?? null}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="review-empty">
            <h3 className="review-empty-title">将检查什么</h3>
            <ul className="review-empty-checks">
              <li>
                <span className="tag det">确定性</span>
                结构对等 / 标记完整 / 代码块未侵入 / 无漏译
              </li>
              <li>
                <span className="tag">AI 语义</span>
                术语一致 / 指代清晰 / 语域统一 / 数字与专名
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* 动作区（不随内容滚动）：确定性计数条 + 语义核查入口 */}
      <div className="review-actions">
        {/* 只在"用户已滚离"时出现——正常跟随状态下它是个纯噪声按钮 */}
        {interrupted && (
          <button type="button" className="review-follow-btn" onClick={jumpToBottom}>
            回到底部 ↓
          </button>
        )}
        <button
          type="button"
          className="review-start-btn"
          disabled={!llmReady}
          title={llmReady ? "开始语义核查（需大模型）" : "核查需要配置大模型 → 设置 · LLM"}
          aria-label={llmReady ? "开始语义核查" : "开始语义核查（需配置大模型）"}
        >
          开始核查
        </button>
        {!llmReady && (
          <p className="review-start-hint">
            核查需要配置大模型 → 设置 · LLM
            {mode === "original" && "（当前为原文模式，请先切换到译文或双语）"}
            {mode !== "original" && translations.size === 0 && "（尚未翻译，请先翻译文档）"}
          </p>
        )}
      </div>
    </>
  );
}
