// AI 核查面板（§八）：侧栏槽位双宿主之一，与大纲栏共用两个侧栏槽。
//
// S4 已落地：槽头 + 进度时间线 + issue 可点列表（含非 actionable 态）+ 滚动跟随。
// `ReviewComposer`（AI 追问输入）整体并入 S5 —— 它的数据源语义核查在 S5。
//
// 确定性检查（checkTranslation IPC）零 AI 成本——纯结构对比，面板一有译文就跑。
// 语义核查（AI，锁定 llm 大模型）是另一条路径，依赖 LLM 凭据齐全
// （baseUrl + model），未配置则按钮禁用 + 明示原因（§七.1 R2），**不静默降级**。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AiIssueCard from "./AiIssueCard";
import ReviewComposer from "./ReviewComposer";
import ReviewIssueCard from "./ReviewIssueCard";
import ReviewTimeline, { type ReviewStep } from "./ReviewTimeline";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";
import { useSemanticReview, type AiIssueView } from "../hooks/useSemanticReview";
import { checkTranslation, countByKind } from "../lib/checkTranslation";
import { aiKindLabel, countByAiKind, issueKindLabel } from "../lib/issueKind";
import { type JumpBlockReason, jumpBlockReason } from "../lib/reviewJump";
import { buildReviewSteps } from "../lib/reviewSteps";
import { useStreamFollow } from "../lib/streamFollow";
import type { Issue } from "../types/ipc";

/** 稳定空表：翻译进行中拿它顶替清单，避免每次渲染都造新数组触发无谓重渲。 */
const EMPTY_ISSUES: Issue[] = [];
const EMPTY_AI_ISSUES: AiIssueView[] = [];

/** 防抖窗口（PERF-1）：内容/mode/target 停变这么久后才真正发查词 IPC。 */
const CHECK_DEBOUNCE_MS = 250;

export default function ReviewPanel() {
  // 字段级订阅（CQ-13）：tabToDoc 每次 commit 都造新 doc 对象，订阅整个对象
  // 会让面板每敲一键重渲一次。这里只挑用到的字段——原始值，引用稳定。
  const docContent = useDocStore((s) => s.doc?.content ?? null);
  const docPath = useDocStore((s) => s.doc?.path ?? null);
  const translations = useDocStore((s) => s.translations);
  const mode = useDocStore((s) => s.mode);
  // 翻译方向：收集单元的「可译」判定随方向变，检查必须与产出译文表那轮
  // 同方向（P0-2），否则索引空间错位 → 假漏译/假回声。
  const target = useSettingsStore((s) => s.target);
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
  /** IPC 飞行中旗标（重入闸）。不读 `checking` state：异步闭包里拿到的永远是旧值。 */
  const checkingRef = useRef(false);
  /** 飞行中被闸拦下的触发 → 落定后补一查，最后一次变更不能被闸吞掉。 */
  const rerunRef = useRef(false);
  /** 最新一帧的 runCheck：补查走它，避免旧闭包拿旧内容又查一遍过期的。 */
  const runCheckRef = useRef<() => void>(() => {});
  /** 渲染期探测出的不可跳原因，下标对齐 `issues`。 */
  const [blockReasons, setBlockReasons] = useState<Record<number, JumpBlockReason>>({});

  const checkable = mode !== "original" && translations.size > 0 && docContent !== null;

  // S5：语义核查状态机（见 hooks/useSemanticReview.ts）。panel 只消费。
  const ai = useSemanticReview({
    docContent,
    translations,
    mode,
    target,
    creds,
    llmReady,
    translating,
  });
  /** 渲染期探测 AI 条目「能不能跳」，与确定性列表同一套 rAF 手法。 */
  const [aiBlockReasons, setAiBlockReasons] = useState<Record<number, JumpBlockReason>>({});
  const aiVisible = ai.phase === "running" || translating ? EMPTY_AI_ISSUES : ai.issues;
  const aiOpen = ai.issues.filter((i) => i.status === "open");
  const aiIssueCount = aiVisible.filter((i) => i.status === "open").length;
  const aiBreakdown = useMemo(
    () =>
      Object.entries(countByAiKind(aiOpen))
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} 处${aiKindLabel(kind)}`)
        .join(" · "),
    [aiOpen],
  );

  // 面板打开 + 有译文 + 翻译模式 + **翻译已停** → 跑确定性检查。
  //
  // 为什么必须等翻译停：译文表是 `mergeTranslations` **逐批** merge 进来的，
  // 流式期查一遍会把"还没轮到"的 run 全报成 `OmittedUntranslated` ——
  // 面板被假问题刷屏，而用户完全没做错什么；顺带每批都要跑一次 IPC。
  // 依赖里同时留 `translations` 与 `translationStatus`：两者谁后落地都能触发
  // 最后一查（只留状态会漏掉"状态先停、表后到"的窗口）。
  const runCheck = useCallback(async () => {
    if (translating) return;
    // `checkable` 是 mode/docContent/translations 的别名条件（TS 4.4 起按 const
    // 布尔窄化）：往下走时 mode 已被窄成 "translation" | "bilingual"，检查才知道
    // 在哪个键空间对号（P0-2）。
    if (!checkable) {
      // 「原文模式或无译文时清空」——原先只剩注释、没有代码：切回原文模式
      // 会留着上一次的清单，配上"预览未挂载"的禁用卡片，读起来像是误报。
      setIssues([]);
      return;
    }
    // 重入闸（PERF-1）：上一查还在飞就不并发第二个 IPC，只记「待补查」——
    // finally 里会用最新一帧的 runCheck 补上，最后一次变更不会被吞。
    if (checkingRef.current) {
      rerunRef.current = true;
      return;
    }
    checkingRef.current = true;
    setChecking(true);
    try {
      const result = await checkTranslation(docContent, translations, mode, target);
      setIssues(result);
    } catch {
      setIssues([]);
    } finally {
      checkingRef.current = false;
      setChecking(false);
      if (rerunRef.current) {
        rerunRef.current = false;
        void runCheckRef.current();
      }
    }
  }, [translating, checkable, docContent, translations, mode, target]);

  useEffect(() => {
    runCheckRef.current = runCheck;
  }, [runCheck]);

  // 防抖（PERF-1）：`runCheck` 的依赖随每次按键（新 doc.content）换新实例，
  // effect 借依赖变更实现尾沿防抖——内容/mode/target 停变 CHECK_DEBOUNCE_MS
  // 后才发查词 IPC，敲键期间一直重置计时器。不再「每键一发」。
  useEffect(() => {
    const t = setTimeout(() => void runCheck(), CHECK_DEBOUNCE_MS);
    return () => clearTimeout(t);
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

  // 确定性检查这一步的进度 + S5 追加的语义核查步骤（派生逻辑在 lib/reviewSteps.ts）。
  const steps: ReviewStep[] = useMemo(
    () =>
      buildReviewSteps({
        mode,
        translating,
        hasTranslations: translations.size > 0,
        checking,
        hasIssues,
        totalIssues,
        breakdown,
        llmReady,
        aiPhase: ai.phase,
        aiProgress: ai.progress,
        aiError: ai.error,
        aiIssueCount: ai.issues.filter((i) => i.status !== "rejected").length,
        aiSummary: ai.summary,
        aiBreakdown,
      }),
    [mode, translating, translations, checking, hasIssues, totalIssues, breakdown, llmReady, ai, aiBreakdown],
  );

  // AI 条目的不可跳探测：与确定性列表同一渲染期 rAF 手法（等预览落 DOM）。
  useEffect(() => {
    if (aiVisible.length === 0) {
      setAiBlockReasons({});
      return;
    }
    const raf = requestAnimationFrame(() => {
      const next: Record<number, JumpBlockReason> = {};
      aiVisible.forEach((issue) => {
        const reason = jumpBlockReason(issue);
        if (reason) next[issue.seq] = reason;
      });
      setAiBlockReasons(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [aiVisible, mode]);

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
  const { ref: scrollRef, follow, jumpToBottom, interrupted } = useStreamFollow<HTMLDivElement>(docPath);
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

        {hasIssues && (
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
        )}
        {aiVisible.length > 0 && (
          <>
            <div className="review-checks-bar ai">
              <span>
                <span className="count">{aiIssueCount}</span> 处语义问题：{aiBreakdown}
              </span>
              {ai.stale && <span className="review-stale-note">文档已变更，建议需重新核查后应用</span>}
            </div>
            <ul className="review-issues" aria-label="语义问题清单">
              {aiVisible.map((issue) => (
                <AiIssueCard
                  key={issue.seq}
                  issue={issue}
                  stale={ai.stale}
                  blockReason={aiBlockReasons[issue.seq] ?? null}
                  onAccept={(seq) => void ai.accept(seq)}
                  onReject={ai.reject}
                />
              ))}
            </ul>
          </>
        )}
        {!hasIssues && aiVisible.length === 0 && (
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

      {/* 动作区（不随内容滚动）：追问输入 + 确定性计数条 + 语义核查入口 */}
      <div className="review-actions">
        {/* S5 #12：AI 追问输入（发送 = 以追问为 instruction 重跑核查） */}
        {llmReady && (
          <ReviewComposer
            disabled={ai.phase === "running" || !checkable}
            running={ai.phase === "running"}
            placeholder={ai.phase === "idle" ? "让核查重点关注…（Enter 发送）" : "继续追问…"}
            onSend={(t) => ai.start(t)}
            onCancel={ai.cancel}
          />
        )}
        {/* 只在"用户已滚离"时出现——正常跟随状态下它是个纯噪声按钮 */}
        {interrupted && (
          <button type="button" className="review-follow-btn" onClick={jumpToBottom}>
            回到底部 ↓
          </button>
        )}
        <button
          type="button"
          className="review-start-btn"
          disabled={!llmReady || ai.phase === "running" || !checkable}
          title={
            !llmReady
              ? "核查需要配置大模型 → 设置 · LLM"
              : ai.phase === "running"
                ? "核查进行中…"
                : !checkable
                  ? "先翻译文档再核查"
                  : "开始语义核查（需大模型）"
          }
          aria-label={llmReady ? "开始语义核查" : "开始语义核查（需配置大模型）"}
          onClick={() => ai.start()}
        >
          {ai.phase === "running" ? "核查中…" : "开始核查"}
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
