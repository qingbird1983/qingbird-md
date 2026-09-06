// 前端唯一 IPC 门面：所有 invoke/listen 集中于此，类型来自 types/ipc.ts。
// 禁止在本层打印或弹吐任何包含 settings/providers 凭据的载荷。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DocDTO,
  TreeNodeDTO,
  EditOp,
  EditResult,
  ParseResult,
  ProviderInfo,
  Settings,
  ProgressPayload,
  TranslationPartialPayload,
  DonePayload,
  Mode,
  WordLookupDTO,
  LookupDeltaPayload,
  TranslateStart,
  SessionSnapshot,
} from "../types/ipc";

export const api = {
  // ---- 文件 ----
  openFile: (p: string) => invoke<DocDTO>("open_file", { path: p }),
  saveFile: (p: string, c: string) =>
    invoke<number | null>("save_file", { path: p, content: c }),
  /** 当前磁盘 mtime（毫秒）；文件不存在/不可访问为 null。 */
  fileMtime: (p: string) => invoke<number | null>("file_mtime", { path: p }),

  // ---- 设置 ----
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (s: Settings) => invoke<void>("save_settings", { settings: s }),
  clearCache: () => invoke<void>("clear_cache"),
  userDataDir: () => invoke<string>("get_user_data_dir"),

  // ---- 对话框（Rust 参数 default_name 按 Tauri v2 默认 camelCase 匹配）----
  pickFile: () => invoke<string | null>("pick_file"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickSavePath: (d: string) => invoke<string | null>("pick_save_path", { defaultName: d }),

  // ---- 工作区 ----
  openWorkspace: (p: string) => invoke<TreeNodeDTO[]>("open_workspace", { path: p }),
  filterWorkspace: (t: TreeNodeDTO[], q: string) =>
    invoke<TreeNodeDTO[]>("filter_workspace", { tree: t, query: q }),
  createFile: (p: string) => invoke<void>("create_file", { path: p }),
  createFolder: (p: string) => invoke<void>("create_folder", { path: p }),

  // ---- 编辑器 / 预览 ----
  applyOp: (o: EditOp) => invoke<EditResult>("apply_op", { op: o }),
  parse: (c: string) => invoke<ParseResult>("parse_markdown", { content: c }),
  resolveImage: (s: string, b: string | null) =>
    invoke<string | null>("resolve_image", { src: s, baseDir: b }),
  // T25: 预览链接外部打开（Rust 侧 scheme 白名单，拒绝 javascript: 等）
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  // ---- 翻译 ----
  getProviders: () => invoke<ProviderInfo[]>("get_providers"),
  getProviderMeta: (k: string) => invoke<ProviderInfo | null>("get_provider_meta", { key: k }),
  translateText: (t: string, p: string, c: Record<string, string>) =>
    invoke<string>("translate_text", { text: t, provider: p, creds: c }),
  translateDocument: (
    c: string,
    m: Mode,
    p: string,
    creds: Record<string, string>,
    window: [number, number] | null,
  ) =>
    invoke<TranslateStart>("translate_document", {
      content: c,
      mode: m,
      provider: p,
      creds,
      window,
    }),
  /** 会话收口重建：用累积 translations 渲染整树 canonical html（Task: 收口） */
  renderTranslated: (
    c: string,
    m: "translation" | "bilingual",
    translations: Array<[number, string]>,
  ) => invoke<ParseResult>("render_translated", { content: c, mode: m, translations }),
  stopTranslation: () => invoke<void>("stop_translation"),

  // 选区查词（2026-08-29 spec）：LLM 词/句分流富结果；结果缓存于 Rust 侧
  lookupWord: (t: string, c: Record<string, string>) =>
    invoke<WordLookupDTO>("lookup_word", { text: t, creds: c }),
  // 查词流式 delta（SSE 渐进渲染）：content 为截止当前的累积 LLM 输出
  listenLookupDelta: (cb: (p: LookupDeltaPayload) => void) =>
    listen<LookupDeltaPayload>("lookup-delta", (e) => cb(e.payload)),
  // 拉取 OpenAI 兼容 /models 供设置弹窗点选（Tauri v2 默认 camelCase 参数映射）
  llmListModels: (baseUrl: string, apiKey: string) =>
    invoke<string[]>("llm_list_models", { baseUrl, apiKey }),

  // ---- 休眠会话快照（hibernate.rs；见 docs/webview-hibernate-plan.md）----
  // 休眠握手固定顺序：saveSession → hibernateReady。
  saveSession: (s: SessionSnapshot) => invoke<void>("save_session", { snapshot: s }),
  hibernateReady: () => invoke<void>("hibernate_ready"),
  loadSession: () => invoke<SessionSnapshot | null>("load_session"),
  clearSession: () => invoke<void>("clear_session"),
  /** 取走休眠期间积攒的 handoff 文件（休眠态 emit 无人接收，改由前端启动拉取） */
  takePendingOpen: () => invoke<string[]>("take_pending_open"),

  // ---- 事件（事件名与 lib.rs .emit(...) 注册逐字一致）----
  listenDocumentChanged: (cb: (p: string) => void) =>
    listen<{ path: string }>("document-changed", (e) => cb(e.payload.path)),
  listenProgress: (cb: (p: ProgressPayload) => void) =>
    listen<ProgressPayload>("translation-progress", (e) => cb(e.payload)),
  listenPartial: (cb: (p: TranslationPartialPayload) => void) =>
    listen<TranslationPartialPayload>("translation-partial", (e) => cb(e.payload)),
  listenDone: (cb: (p: DonePayload) => void) =>
    listen<DonePayload>("translation-done", (e) => cb(e.payload)),
  listenSettingsUpdated: (cb: (s: Settings) => void) =>
    listen<Settings>("settings-updated", (e) => cb(e.payload)),
  // T29 全局热键回调（Rust hotkeys.rs emit）；payload 为模式字符串，由调用方校验
  listenHotkeyMode: (cb: (m: string) => void) => listen<string>("hotkey-mode", (e) => cb(e.payload)),
  // 休眠握手：Rust 侧倒计时到点下发，前端须同步收集快照并回 hibernateReady。
  // 不回则 3s 后 Rust 强制销毁（内存释放优先于草稿完整性）。
  listenHibernate: (cb: () => void) => listen<null>("session-hibernate", () => cb()),
};

// ---- 偏移换算：CodeMirror 位置 ↔ Rust UTF-8 字节 ----
// CM6 文档位置按 UTF-16 code unit 计数（BMP 字符 1 单位、代理对 2 单位，与 JS
// string 下标一致）；editor::apply_op 的 sel 是 UTF-8 字节偏移。按 code point
// 逐个累加两种单位完成换算，永不落在 code point 内部（Rust wrap 边界恒在
// code point 边界，见 types/ipc.ts EditOp 契约）。
//
// 行内用例（往返恒等 byteToCharOffset(s, charToByteOffset(s, i)) === i）：
//   "abc"    : 字节==字符，i 0..3 直通
//   "中文a"  : char 2（'a'）→ byte 6；byte 4（'文' 内部）→ char 1（下取到边界）
//   "a😀b"   : 😀 占 CM 2 单位 / UTF-8 4 字节；char 2 → byte 5，往返成立
//   ""       : 任意入参 → 0；charIdx/byteIdx 越界 → 钳到全长（对齐 Rust clamp_sel）
function utf8Len(cp: number): number {
  return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
}

/** CM 字符（code unit）偏移 -> UTF-8 字节偏移（Rust apply_op 需要）。中文每字 +3 字节。 */
export function charToByteOffset(s: string, charIdx: number): number {
  let bytes = 0;
  let units = 0;
  for (const cp of s) {
    if (units >= charIdx) break;
    units += cp.length;
    bytes += utf8Len(cp.codePointAt(0)!);
  }
  return bytes;
}

/** UTF-8 字节偏移 -> CM 字符偏移；byteIdx 落在 code point 内部时下取到其起点边界。 */
export function byteToCharOffset(s: string, byteIdx: number): number {
  let bytes = 0;
  let units = 0;
  for (const cp of s) {
    const b = utf8Len(cp.codePointAt(0)!);
    if (bytes + b > byteIdx) break;
    bytes += b;
    units += cp.length;
  }
  return units;
}
