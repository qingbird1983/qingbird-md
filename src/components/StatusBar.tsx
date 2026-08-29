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

  const pathLabel = doc ? (doc.path ?? doc.name) : "未打开文档";
  // 实时统计：char_count/line_count 是 open_file 时的 DTO 快照，编辑后即过期。
  // 字符按 code point 展开（"字符"语义），行数按 \n 切分。
  const stats = doc
    ? `${[...doc.content].length} 字 · ${doc.content.split("\n").length} 行`
    : null;

  return (
    <footer className="status-bar">
      {/* 左侧：文件路径（可收缩出省略号）+ 脏标记 */}
      <div className="status-left">
        <span className="status-path">{pathLabel}</span>
        {isDirty && (
          <span className="status-dot" title="未保存的更改">
            ● 未保存
          </span>
        )}
      </div>
      {/* 右侧：字数/行数 · 阅读模式 · 翻译源 · 翻译状态 */}
      <div className="status-right">
        {stats && <span>{stats}</span>}
        <span>{MODE_LABEL[mode] ?? mode}</span>
        <span>{provider ?? "—"}</span>
        <span>{transLabel}</span>
      </div>
    </footer>
  );
}
