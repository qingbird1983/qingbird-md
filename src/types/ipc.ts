// IPC wire types —— 与 src-tauri 的 serde 输出逐字段对应。Rust serde 默认
// 不改名字段名，TS 保持同名 snake_case 字段；Option<T> → `| null`。

/** dto.rs DocDTO：parse 为后端随文档一次下发的渲染结果（打开预览零延迟首帧） */
export interface DocDTO {
  name: string;
  path: string | null;
  content: string;
  base_dir: string | null;
  char_count: number;
  line_count: number;
  /** 实际解码编码（"UTF-8"/"GB18030"）；状态栏标注 */
  encoding: string;
  /** 打开时磁盘 mtime（毫秒），外部修改/保存冲突检测基线 */
  mtime: number | null;
  parse: ParseResult;
}

/** dto.rs TreeNodeDTO */
export interface TreeNodeDTO {
  name: string;
  path: string | null;
  is_dir: boolean;
  children: TreeNodeDTO[];
}

/** dto.rs EditOp：sel 为字节偏移对（前端先把 CodeMirror 码点偏移转字节） */
export interface EditOp {
  content: string;
  sel: [number, number];
  op: string;
}

/** dto.rs EditResult */
export interface EditResult {
  content: string;
  sel: [number, number];
}

/** markdown/html.rs OutlineItem */
export interface OutlineItem {
  level: number;
  text: string;
  id: string;
}

/** markdown/html.rs ParseResult */
export interface ParseResult {
  html: string;
  outline: OutlineItem[];
}

/** dto.rs ProviderFieldDto */
export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

/** dto.rs ProviderInfoDto */
export interface ProviderInfo {
  key: string;
  label: string;
  note: string;
  needs_key: boolean;
  max_len: number;
  max_concurrency: number;
  fields: ProviderField[];
}

/** storage.rs Settings：providers 按源名分组凭据，绝不离开本进程 */
export interface Settings {
  provider: string;
  providers: Record<string, Record<string, string>>;
  workspace: string | null;
  last_file: string | null;
  hotkeys: Record<string, string>;
  selection_translate: boolean;
  outline: string;
  nav: string;
  theme: string;
}

/** lib.rs TranslationProgressEvt：序列化为 {gen, done, total}（r#gen → "gen"） */
export interface ProgressPayload {
  gen: number;
  done: number;
  total: number;
}

/** lib.rs TranslationPartialEvt：{gen, index, text, from_cache}。
 * index 与 translation-done 的 pair 首元素同一索引空间：
 * translation 模式 = text runs（data-ri），bilingual 模式 = translatable 块（data-bi）。
 * from_cache = 缓存命中（前端跳过打字动画直接上屏）。 */
export interface TranslationPartialPayload {
  gen: number;
  index: number;
  text: string;
  from_cache: boolean;
}

/**
 * lib.rs TranslationDoneEvt：{gen, ok, translations?, error?,
 * html_original?, html_translation?, html_bilingual?, outline?}。
 * None 字段经 skip_serializing_if 整体缺席——用可选属性匹配。
 * translations 为按下标升序的 [原文索引, 译文] 对数组。
 * Task 8 扩展：完成路径附带 html 形态 + 原文结构 outline（OutlineItem[]）。
 * 译文形态只出与批次索引空间匹配的一种：translation 批次出 html_translation
 * （run 空间替换渲染），bilingual 批次出 html_bilingual（块空间 tr-box 渲染），
 * 另一种缺席；html_original 与 outline 恒在（ok=true 时）。
 * 窗口化 run 的 done 不携带 html_*／outline 字段（键整体缺席，非 null）。
 */
export interface DonePayload {
  gen: number;
  ok: boolean;
  translations?: Array<[number, string]>;
  error?: string;
  html_original?: string;
  html_translation?: string;
  html_bilingual?: string;
  outline?: OutlineItem[];
}

export type Mode = "original" | "translation" | "bilingual";
export type ViewKind = "source" | "preview" | "split";

/**
 * lib.rs TranslateStart：translate_document 的返回。
 * started = 已起跑（gen 号，进度/完成走事件）；cached = 缓存全命中，
 * done 产物随本调用同步直达（无进度条、不经事件通道——事件/invoke
 * 到达顺序竞态从根上消除）。
 */
export type TranslateStart =
  | { kind: "started"; gen: number; first_index: number }
  | { kind: "cached"; done: DonePayload };

/** dto.rs LookupExample */
export interface LookupExample {
  en: string;
  zh: string;
}

/** dto.rs LookupTerm */
export interface LookupTerm {
  word: string;
  phonetic: string;
  explanation: string;
}

/** dto.rs WordLookupDTO：kind="sentence" 时 phonetic 及以下为 null / 空数组 */
export interface WordLookupDTO {
  kind: "word" | "sentence";
  translation: string;
  phonetic: string | null;
  part_of_speech: string | null;
  usage: string | null;
  examples: LookupExample[];
  terms: LookupTerm[];
}

/** lib.rs LookupDeltaEvt：划词查词流式 delta，content 为截止当前的累积输出 */
export interface LookupDeltaPayload {
  text: string;
  content: string;
}

/** hibernate.rs SessionTab：一个标签的休眠快照 */
export interface SessionTab {
  id: string;
  path: string | null;
  name: string;
  /** null = 干净（重建时从 path 重读）；字符串 = 未保存的草稿内容 */
  content: string | null;
  mtime: number | null;
  encoding: string | null;
  view: string;
  mode: string;
  cursor_sel: [number, number];
  scroll_top: number;
}

/** hibernate.rs SessionUi：面板折叠与分栏宽度 */
export interface SessionUi {
  show_nav: boolean;
  show_outline: boolean;
  sidebar_width: number;
  outline_width: number;
  split_ratio: number;
}

/** hibernate.rs SessionSnapshot：仅休眠时落草稿，恢复成功后即删（一次性） */
export interface SessionSnapshot {
  /** 恒为 SESSION_VERSION；不符即丢弃 */
  version: number;
  saved_at: number;
  tabs: SessionTab[];
  active_id: string | null;
  workspace_root: string | null;
  ui: SessionUi | null;
}
