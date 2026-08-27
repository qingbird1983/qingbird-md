// 底部状态条：doc.path ●脏标 · 字符 X · 行 Y · 阅读模式 · provider · 翻译状态。
// 纯展示组件——全部订阅走各 store 的字段级选择器，不在壳层放逻辑。
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";

const MODE_LABEL: Record<string, string> = {
  original: "原文",
  translation: "译文",
  bilingual: "双语",
};

export default function StatusBar() {
  const doc = useDocStore((s) => s.doc);
  const isDirty = useDocStore((s) => s.isDirty);
  const mode = useDocStore((s) => s.mode);
  const provider = useSettingsStore((s) => s.settings?.provider ?? null);
  const trStatus = useTranslationStore((s) => s.status);
  const progress = useTranslationStore((s) => s.progress);

  // 翻译状态段：running 时带上进度 done/total，失败显式标出
  const transLabel =
    trStatus === "running"
      ? progress
        ? `翻译中 ${progress.done}/${progress.total}`
        : "翻译中…"
      : trStatus === "error"
        ? "翻译失败"
        : "待机";

  const segments = [
    doc ? `${doc.path ?? doc.name}${isDirty ? " ●" : ""}` : "未打开文档",
    doc ? `字符 ${doc.char_count} · 行 ${doc.line_count}` : null,
    MODE_LABEL[mode] ?? mode,
    provider ?? "—",
    transLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return <footer className="status-bar">{segments}</footer>;
}
