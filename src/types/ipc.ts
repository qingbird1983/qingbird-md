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

/**
 * lib.rs TranslationDoneEvt：{gen, ok, translations?, error?,
 * html_original?, html_translation?, html_bilingual?, outline?}。
 * None 字段经 skip_serializing_if 整体缺席——用可选属性匹配。
 * translations 为按下标升序的 [原文索引, 译文] 对数组。
 * Task 8 扩展：完成路径附带 html 形态 + 原文结构 outline（OutlineItem[]）。
 * 译文形态只出与批次索引空间匹配的一种：translation 批次出 html_translation
 * （run 空间替换渲染），bilingual 批次出 html_bilingual（块空间 tr-box 渲染），
 * 另一种缺席；html_original 与 outline 恒在（ok=true 时）。
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
