// AI 核查面板（§八）：侧栏槽位双宿主之一，与大纲栏共用两个侧栏槽。
// v1 壳层：槽头（标题 + 关闭）+ 空态引导卡（确定性检查计数 + 禁用"开始核查"钮）。
// ReviewTimeline / ReviewComposer / ReviewIssueCard 随后续项（§8.4）逐条落地。
//
// 确定性检查（checkTranslation IPC）零 AI 成本——纯结构对比，已在面板
// 打开时自动跑一遍。语义核查（AI，锁定 llm 大模型）是另一条路径，
// 依赖 LLM 凭据齐全（baseUrl + model），未配置则按钮禁用 + 明示原因（§七.1 R2）。
import { useCallback, useEffect, useState } from "react";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";
import { checkTranslation, countByKind } from "../lib/checkTranslation";
import type { Issue } from "../types/ipc";

/** 确定性检查结果的短标签（面板顶部徽标用） */
const CHECK_LABEL: Record<string, string> = {
  OmittedUntranslated: "漏译",
  EchoOfSource: "译文=原文",
  MarksLost: "标记丢失",
  StructureMismatch: "结构不对等",
  CodeInvaded: "代码被侵入",
};

export default function ReviewPanel() {
  const doc = useDocStore((s) => s.doc);
  const translations = useDocStore((s) => s.translations);
  const mode = useDocStore((s) => s.mode);
  const toggleReview = useUiStore((s) => s.toggleReview);
  const creds = useSettingsStore((s) => s.credsFor("llm"));

  // LLM 凭据齐全（baseUrl + model 均非空）——§七.1 R1。
  // credsFor 返回 {} 时 baseUrl/model 为 undefined，?. 是真实守卫。
  const llmReady = Boolean(creds.baseUrl?.trim() && creds.model?.trim());

  const [issues, setIssues] = useState<Issue[]>([]);
  const [checking, setChecking] = useState(false);

  // 面板打开 + 有译文 + 翻译模式 → 自动跑确定性检查（零 AI 成本，纯结构对比）。
  // 内容与译文变化时重新检查；原文模式或无译文时清空。
  const runCheck = useCallback(async () => {
    if (mode === "original" || translations.size === 0 || !doc) return;
    setChecking(true);
    try {
      const result = await checkTranslation(doc.content, translations);
      setIssues(result);
    } catch {
      setIssues([]);
    } finally {
      setChecking(false);
    }
  }, [mode, translations, doc]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const counts = countByKind(issues);
  const totalIssues = issues.length;
  const hasIssues = totalIssues > 0;

  // 检查项说明（§8.3 ③ 空态引导卡）
  const checkItems = [
    { label: "结构对等 / 标记完整 / 代码块未侵入 / 无漏译", tag: "确定性", det: true },
    { label: "术语一致 / 指代清晰 / 语域统一 / 数字与专名", tag: "AI 语义", det: false },
  ];

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

      {/* 空态引导卡（§8.3 ③） */}
      <div className="review-empty">
        <h3 className="review-empty-title">将检查什么</h3>
        <ul className="review-empty-checks">
          {checkItems.map((item) => (
            <li key={item.label}>
              <span className={`tag ${item.det ? "det" : ""}`}>{item.tag}</span>
              {item.label}
            </li>
          ))}
        </ul>

        {/* 确定性检查结果条 */}
        {(hasIssues || (mode !== "original" && translations.size > 0)) && (
          <div className={`review-checks-bar ${hasIssues ? "warn" : "ok"}`}>
            {checking ? (
              <span>检查中…</span>
            ) : hasIssues ? (
              <span>
                <span className="count">{totalIssues}</span> 处确定性检查问题：
                {Object.entries(counts)
                  .filter(([, n]) => n > 0)
                  .map(([kind, n]) => `${n} 处${CHECK_LABEL[kind] ?? kind}`)
                  .join(" · ")}
              </span>
            ) : (
              <span>
                <span className="count">0</span> 处确定性检查问题
              </span>
            )}
          </div>
        )}

        {/* 开始核查钮 + 提示 */}
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
