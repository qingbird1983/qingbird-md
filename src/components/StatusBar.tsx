// 底部状态条：doc.path ●脏标 · 字符 X · 行 Y · 阅读模式 · 翻译方向 · provider
// · 翻译状态。纯展示组件——全部订阅走各 store 的字段级选择器，不在壳层放逻辑。
// 唯一例外是「翻译方向」那一段：它是个双向切换钮（中 ⇄ 英），但同样只做
// "把点击转交给 store 动作"这一件事，不在这里持有任何方向状态。
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";

const MODE_LABEL: Record<string, string> = {
  original: "原文",
  translation: "译文",
  bilingual: "双语",
};

/** 方向短标签。文案是"译成什么"，不是"什么语言"——后者歧义（源还是目标？）。 */
const DIR_LABEL: Record<string, string> = { zh: "译成中文", en: "译成英文" };

export default function StatusBar() {
  const doc = useDocStore((s) => s.doc);
  const isDirty = useDocStore((s) => s.isDirty);
  const mode = useDocStore((s) => s.mode);
  const setTranslateTarget = useDocStore((s) => s.setTranslateTarget);
  const provider = useSettingsStore((s) => s.settings?.provider ?? null);
  const target = useSettingsStore((s) => s.target);
  const creds = useSettingsStore((s) => s.credsFor("llm"));
  const trStatus = useTranslationStore((s) => s.status);
  const progress = useTranslationStore((s) => s.progress);
  const showReview = useUiStore((s) => s.showReview);
  const toggleReview = useUiStore((s) => s.toggleReview);

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

  // LLM 凭据齐全（baseUrl + model 均非空）——§七.1 R1，与 useTranslationStore 同口径。
  // credsFor 返回 {} 时 baseUrl/model 为 undefined，?. 是真实守卫。
  const llmReady = Boolean(creds.baseUrl?.trim() && creds.model?.trim());

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
      {/* 右侧：字数/行数 · 编码 · 阅读模式 · 翻译方向 · 翻译源 · 翻译状态 */}
      <div className="status-right">
        {stats && <span>{stats}</span>}
        {doc?.encoding && doc.path && <span>{doc.encoding}</span>}
        <span>{MODE_LABEL[mode] ?? mode}</span>
        {/* 双向切换：点一次换一个方向。切换走 useDocStore.setTranslateTarget
            （不是直接改设置）——它会连带清显示/清译文表/按新方向重解析，
            因为 data-bi 的占号随方向变（见该动作注释）。 */}
        <button
          type="button"
          className="status-dir"
          title={`翻译方向：${DIR_LABEL[target]}（点击切换为${target === "zh" ? "英文" : "中文"}）`}
          aria-label={`翻译方向：${DIR_LABEL[target]}，点击切换`}
          onClick={() => void setTranslateTarget(target === "zh" ? "en" : "zh")}
        >
          {DIR_LABEL[target]}
        </button>
        <span>{provider ?? "—"}</span>
        <span>{transLabel}</span>
        {/* AI 核查入口（§9.5）：面板开关始终可点（无 LLM 也能开面板看历史清单），
            禁用的是面板内的「开始核查」钮。title 带 LLM 就绪态——顺带补上
            状态栏此前只显示 provider、不显示 LLM 是否配好的缺口。 */}
        <button
          type="button"
          className={`status-ai${showReview ? " active" : ""}`}
          title={llmReady ? "AI 核查 · 就绪" : "AI 核查 · 未配置 LLM"}
          aria-label={showReview ? "收起 AI 核查" : `打开 AI 核查${llmReady ? "" : "（未配置 LLM）"}`}
          onClick={toggleReview}
        >
          AI
        </button>
      </div>
    </footer>
  );
}
