// 整篇翻译进度条（Task 23）：仅 status==="running" 时渲染，否则完全不占位。
// 内容：批次模式与 provider 标签、进度条(done/total)、百分比、取消按钮——
// stop 使 gen 前跳，同轮迟到的 done/progress 事件因子代失配而被丢弃。
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";

const MODE_LABEL: Record<string, string> = { translation: "译文", bilingual: "中英对照" };

export default function TranslationBar() {
  const running = useTranslationStore((s) => s.status === "running");
  const progress = useTranslationStore((s) => s.progress);
  const stop = useTranslationStore((s) => s.stop);
  const mode = useDocStore((s) => s.mode);
  const provider = useSettingsStore((s) => s.settings?.provider ?? "—");

  if (!running) return null;
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="translation-bar" role="status">
      <span className="tb-label">
        {MODE_LABEL[mode] ?? "翻译"} · {provider}
      </span>
      <div className="tb-track" aria-hidden="true">
        <div className="tb-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="tb-pct">{pct === null ? "…" : `${pct}%`}</span>
      <span className="tb-count">{progress ? `${progress.done}/${progress.total}` : ""}</span>
      <button type="button" className="tb-stop" onClick={stop}>
        取消
      </button>
    </div>
  );
}
