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

/**
 * storage.rs LlmProfile：一套已保存的 OpenAI 兼容大模型配置。
 *
 * 翻译链路只认 `providers["llm"]`（bridge 的两个翻译命令都由前端显式传
 * creds），所以档案库是纯前端概念：选中哪套，就把它的四个值镜像进
 * `providers["llm"]`。Rust 侧不认识「档案」，只负责把它原样存下来。
 */
export interface LlmProfile {
  /** 前端生成的不透明 id（改名不改 id） */
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  lookup_model: string;
  /** 语义核查模型（S5），留空回落 model */
  review_model: string;
  /** 上次 /models 拉到的清单，持久化后重启仍可下拉选用 */
  models: string[];
}

/**
 * storage.rs Settings：providers 按源名分组凭据。
 * ⚠️ 凭据以明文 JSON 落盘用户数据目录（SEC-3，未加密，产品决策待定）；
 * 但**不经 settings-updated 广播**——事件只发 SettingsBroadcast 脱敏摘要。
 */
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
  /** 主题配色 id（xuan/su/qing/tan/ci/ye）；"" = 用默认档 xuan */
  palette: string;
  /** 大模型配置档案库（可多套并存）；老配置缺字段 → [] */
  llm_profiles: LlmProfile[];
  /** 当前生效档案的 id；"" = 没有选中任何档案 */
  llm_active: string;
  /**
   * 开机自启（托盘菜单写、启动时 apply 到 autostart 插件）。
   * 前端不展示也不改它，但必须列在类型里：整包 `save_settings` 走 serde 反序列化，
   * 字段名没登记就会被静默丢成 false。当前 save 路径都是 `{...cur}` 整包展开
   * 因而侥幸无损——写死字面量时就会踩坑，所以这里钉住。
   */
  autostart: boolean;
  /**
   * 翻译方向（"zh" / "en"；空串或未知值由前端 `normalizeTarget` 回落 "zh"）。
   * 同 `autostart`：整包 `save_settings` 走 serde 反序列化，字段名没登记就会
   * 被静默丢成默认值——必须列在类型里。
   */
  translate_target: string;
}

/**
 * lib.rs settings_broadcast_payload：settings-updated 事件的脱敏广播（SEC-3）。
 * 只含跨窗口要收敛的外观两项——整份 Settings 带明文 api_key，不再整包广播；
 * 全量设置走 load_settings IPC 按需拉取。扩字段须 Rust/前端两侧同步，且永不放凭据。
 */
export interface SettingsBroadcast {
  theme: string;
  palette: string;
}

/** lib.rs TranslationProgressEvt：序列化为 {gen, done, total}（r#gen → "gen"） */
export interface ProgressPayload {
  gen: number;
  done: number;
  total: number;
}

/** lib.rs TranslationPartialEvt：{gen, index, text, from_cache, streaming?}。
 * index 与 translation-done 的 pair 首元素同一索引空间：
 * translation 模式 = text runs（data-ri），bilingual 模式 = translatable 块（data-bi）。
 * from_cache = 缓存命中（前端跳过打字动画直接上屏）。
 * streaming = 单单元裸发路径的实时增量（累积文本，随 SSE 增长）：前端直写
 * 灰字省略号、不经过打字机队列；false/缺席 = 完整单元（走打字动画）。 */
export interface TranslationPartialPayload {
  gen: number;
  index: number;
  text: string;
  from_cache: boolean;
  streaming?: boolean;
  /** 单元翻译失败：text 为原文回退。前端照常推进打字机放行（失败 run 跳过
   * 打字、显示原文），避免该 run 缺失导致其后所有块永久等位。 */
  failed?: boolean;
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
 * 翻译方向（目标语言）。
 *
 * 与 Rust `translate::policy::TargetLang` 一一对应，字面量就是 `TargetLang::tag()`
 * ——**它就是缓存键里的那个短标签**，不是展示文案（改它作废全部译文缓存）。
 * 目前只有中/英两档（UI 是双向切换）；要扩语种时这里加字面量、UI 换成下拉。
 */
export type TargetLang = "zh" | "en";

/**
 * lib.rs TranslateStart：translate_document 的返回。
 * started = 已起跑（gen 号，进度/完成走事件）；cached = 缓存全命中，
 * done 产物随本调用同步直达（无进度条、不经事件通道——事件/invoke
 * 到达顺序竞态从根上消除）。
 * indices（终审 C1）：本轮收集索引的完整文档序序列——窗口化/文献区段跳过
 * 使收集索引带缺口（如 [1,3,5]），打字机按此序列放行而非"连续 +1"游标。
 * first_index 兼容保留 = 序列首元素（空收集为 0）。
 */
export type TranslateStart =
  | {
      kind: "started";
      gen: number;
      first_index: number;
      indices: number[];
      /** 与 indices 等长、一一对应：每个收集单元所属的块索引（data-bi 空间）。
       *  translation 模式 = run 所属块；bilingual 模式 = 块自身。前端据此把
       *  同一块的 run 组装成"整段"打字单元（对齐 qingniao 节奏）。 */
      indices_blocks: number[];
    }
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
  // AI 核查面板（§八）：与大纲栏共用槽位，各自独立 show/width。
  // side 走前端 localStorage（不进快照，同 outlineSide 先例）。
  show_review: boolean;
  review_width: number;
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

// ---- 确定性检查（translate/check.rs 端到端） ----
//
// 字段顺序 / 命名必须与 Rust 端 `Issue` 严格一致；守卫测试见
// src/lib/checkTranslation.test.ts。任何一边的字段改名 / 加删都会立刻变红。

export type IssueKind =
  | "OmittedUntranslated"
  | "EchoOfSource"
  | "MarksLost"
  | "StructureMismatch"
  | "CodeInvaded";

export type Severity = "Warning";

export interface Issue {
  run: number;
  kind: IssueKind;
  severity: Severity;
  src_excerpt: string;
  dst_excerpt: string;
}

/**
 * S5：AI 语义核查问题（translate/review.rs `AiIssue` 镜像，两侧同形）。
 * kind/severity 的合法值由 Rust 端白名单强校验；前端类型只作展示与分组，
 * 后端将来扩枚举时这里落下窗口期由 `aiKindLabel` 的 `||` 兜底。
 */
export type ReviewIssueKind =
  | "term_inconsistency"
  | "pronoun_reference"
  | "register"
  | "number_propernoun"
  | "syntax_breakdown";

export type ReviewSeverity = "high" | "medium" | "low";

export interface ReviewIssue {
  /** 与 translations 同键空间的单元索引（可跳转锚点，同 Issue.run）。 */
  run: number;
  kind: ReviewIssueKind;
  severity: ReviewSeverity;
  /** 译文现状摘句（AI 引用，仅展示）。 */
  current: string;
  /** 建议改法：用户「接受」时写回翻译表的内容。 */
  suggested: string;
  reason: string;
}

/** translate/review.rs `ReviewOutcome` 镜像。 */
export interface ReviewOutcome {
  issues: ReviewIssue[];
  fingerprint: string;
  batch_total: number;
  batch_failed: number;
  model: string;
}
