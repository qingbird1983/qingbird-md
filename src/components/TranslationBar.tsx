// 整篇翻译进度条（Task 23）：仅 status==="running" 时渲染，否则完全不占位。
// 悬浮层（用户反馈）：absolute 钉在主区顶缘、不占文档流——出/入场不推挤
// 正文（滚动触发翻译/翻译结束时正文不再上下跳）。
// 内容：scope/批次模式与 provider 标签、进度条(done/total)、百分比、取消按钮——
// stop 使 gen 前跳，同轮迟到的 done/progress 事件因子代失配而被丢弃。
import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";

const MODE_LABEL: Record<string, string> = { translation: "译文", bilingual: "中英对照" };
const SCOPE_LABEL: Record<string, string> = { viewport: "视口翻译", full: "全文翻译" };

export default function TranslationBar() {
  const running = useTranslationStore((s) => s.status === "running");
  const progress = useTranslationStore((s) => s.progress);
  const stop = useTranslationStore((s) => s.stop);
  const mode = useDocStore((s) => s.mode);
  const scope = useTranslationStore((s) => s.scope);
  const providerKey = useSettingsStore((s) => s.settings?.provider ?? "—");
  // T23 评审清理：显示翻译源 label 而非 key；元数据缺失时回退 key
  const [providerLabel, setProviderLabel] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .getProviders()
      .then((m) => {
        if (alive) setProviderLabel(m.find((p) => p.key === providerKey)?.label ?? "");
      })
      .catch(() => {
        /* 拉取失败即回退 key，不打断进度条 */
      });
    return () => {
      alive = false;
    };
  }, [providerKey]);
  const provider = providerLabel || providerKey;

  if (!running) return null;
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="translation-bar" role="status">
      <span className="tb-label">
        {/* 朱砂「译」印：译中任务卡的品牌记忆点（DESIGN.md §4，CSS seal-pulse 动效） */}
        <span className="tb-seal" aria-hidden="true">译</span>
        {SCOPE_LABEL[scope] ?? "翻译"} · {MODE_LABEL[mode] ?? ""} · {provider}
      </span>
      <div className="tb-track" aria-hidden="true">
        <div className="tb-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="tb-pct">{pct === null ? "…" : `${pct}%`}</span>
      <span className="tb-count">{progress ? `${progress.done}/${progress.total} 段` : ""}</span>
      <button type="button" className="tb-stop" onClick={stop}>
        取消
      </button>
    </div>
  );
}
