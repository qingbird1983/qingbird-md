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
  SettingsBroadcast,
  ProgressPayload,
  TranslationPartialPayload,
  DonePayload,
  Mode,
  TargetLang,
  WordLookupDTO,
  LookupDeltaPayload,
  TranslateStart,
  SessionSnapshot,
  Issue,
} from "../types/ipc";

/** Step 2 导出模式：单语译文 vs 双语对照。键空间完全不同（见 ExportMode 说明）。 */
export type ExportMode = "translation" | "bilingual";

export const api = {
  // ---- 文件 ----
  // targetLang：翻译方向（"zh"/"en"）。首渲的 data-bi 占号随方向变，必须与
  // 随后 translate_document 传的是同一个值（详见 types/ipc.ts 的 TargetLang）。
  openFile: (p: string, targetLang: TargetLang) =>
    invoke<DocDTO>("open_file", { path: p, targetLang }),
  saveFile: (p: string, c: string) =>
    invoke<number | null>("save_file", { path: p, content: c }),
  /** 当前磁盘 mtime（毫秒）；文件不存在/不可访问为 null。 */
  fileMtime: (p: string) => invoke<number | null>("file_mtime", { path: p }),

  // ---- 设置 ----
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (s: Settings) => invoke<void>("save_settings", { settings: s }),
  clearCache: () => invoke<void>("clear_cache"),
  userDataDir: () => invoke<string>("get_user_data_dir"),
  // 数据目录的**显示**形态（`%APPDATA%\qingbird-md`）。与 userDataDir 分开：
  // 那个是喂给 revealPath 的真路径，这个只写给人看——绝不可用它去开目录。
  dataDirLabel: () => invoke<string>("get_data_dir_label"),

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
  // 树右键菜单（2026-09-12）：重命名返回新路径；删除走回收站；移动返回新路径
  renamePath: (p: string, newName: string) =>
    invoke<string>("rename_path", { path: p, newName }),
  deletePath: (p: string) => invoke<void>("delete_path", { path: p }),
  revealPath: (p: string) => invoke<void>("reveal_path", { path: p }),
  openTerminal: (p: string) => invoke<void>("open_terminal", { path: p }),
  movePath: (p: string, destDir: string) =>
    invoke<string>("move_path", { path: p, destDir }),
  createFromTemplate: (dir: string, name: string, kind: string) =>
    invoke<string>("create_from_template", { dir, name, kind }),

  // ---- 编辑器 / 预览 ----
  applyOp: (o: EditOp) => invoke<EditResult>("apply_op", { op: o }),
  parse: (c: string, targetLang: TargetLang) =>
    invoke<ParseResult>("parse_markdown", { content: c, targetLang }),
  resolveImage: (s: string, b: string | null) =>
    invoke<string | null>("resolve_image", { src: s, baseDir: b }),
  // T25: 预览链接外部打开（Rust 侧 scheme 白名单，拒绝 javascript: 等）
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  // ---- 翻译 ----
  getProviders: () => invoke<ProviderInfo[]>("get_providers"),
  translateText: (t: string, p: string, c: Record<string, string>) =>
    invoke<string>("translate_text", { text: t, provider: p, creds: c }),
  translateDocument: (
    c: string,
    m: Mode,
    p: string,
    creds: Record<string, string>,
    window: [number, number] | null,
    targetLang: TargetLang,
  ) =>
    invoke<TranslateStart>("translate_document", {
      content: c,
      mode: m,
      provider: p,
      creds,
      window,
      targetLang,
    }),
  /** 会话收口重建：用累积 translations 渲染整树 canonical html（Task: 收口） */
  renderTranslated: (
    c: string,
    m: "translation" | "bilingual",
    translations: Array<[number, string]>,
    targetLang: TargetLang,
  ) =>
    invoke<ParseResult>("render_translated", {
      content: c,
      mode: m,
      translations,
      targetLang,
    }),
  stopTranslation: () => invoke<void>("stop_translation"),
  /**
   * 译文另存为（Step 2）：`mode` 决定 `translations` 的 key 索引空间——
   * - `"translation"`（默认、单语）：key = `data-ri` run 空间，方向无关，
   *   与 translateDocument 的收集共用同一索引空间。
   * - `"bilingual"`（对照，§五 第 2 步 #9）：key = `data-bi` 块空间，方向相关
   *   ——哪些块"可译"取决于翻译方向，所以 `targetLang` 必须传入。后端用它
   *   判定"这一块是不是该出译文、出译文时用哪个块号"。
   *
   * 调用方必须在调用前断言 `mode === useTranslationStore.lastRunMode`
   * （见 `exportGate` 的 lastRunMode 检查）——否则会拿到「每段都对不上」
   * 的错位文件。这是单语/双语共用同一 IPC 命令、却各自有独立键空间
   * 的代价：判据必须在调用方做掉，不能让后端猜。
   */
  exportTranslation: (
    c: string,
    translations: Array<[number, string]>,
    mode: ExportMode,
    targetLang: TargetLang,
  ) =>
    invoke<string>("export_translation", {
      content: c,
      translations,
      mode,
      targetLang,
    }),

  /**
   * 确定性检查（Step 3 #15）：漏译 / 标记丢失 / 结构不对等 / 代码被侵入
   * 四类同时返回。零 AI 成本；面板拿这份数据决定要展示哪些 issue、要
   * 追问 AI 哪几条。**translations 的 key 索引空间由 `mode` 决定**（P0-2）：
   * `"translation"` = `data-ri` run 空间，`"bilingual"` = `data-bi` 块空间
   * ——与 translateDocument 的收集共用同一索引空间（同 exportTranslation 的
   * 约束）；`targetLang` 必须与产出该表的那轮翻译同方向（可译判定随方向变）。
   */
  checkTranslation: (
    c: string,
    translations: Array<[number, string]>,
    mode: ExportMode,
    targetLang: TargetLang,
  ) =>
    invoke<Issue[]>("check_translation", {
      content: c,
      translations,
      mode,
      targetLang,
    }),

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

  // ---- 启动动画握手（lib.rs SHOWN 闩；窗口 visible:false 首帧补偿）----
  /** 本次启动的环境信息：静默驻留 / 带首开文件参数时不演启动动画。 */
  bootInfo: () => invoke<{ silent: boolean; hasFileArg: boolean }>("boot_info"),
  /** 首帧起始态已上屏，放行窗口 show；返回 false = 看门狗已抢先显示，放弃动画。 */
  bootReady: () => invoke<boolean>("boot_ready"),

  // ---- 事件（事件名与 lib.rs .emit(...) 注册逐字一致）----
  listenDocumentChanged: (cb: (p: string) => void) =>
    listen<{ path: string }>("document-changed", (e) => cb(e.payload.path)),
  listenProgress: (cb: (p: ProgressPayload) => void) =>
    listen<ProgressPayload>("translation-progress", (e) => cb(e.payload)),
  listenPartial: (cb: (p: TranslationPartialPayload) => void) =>
    listen<TranslationPartialPayload>("translation-partial", (e) => cb(e.payload)),
  listenDone: (cb: (p: DonePayload) => void) =>
    listen<DonePayload>("translation-done", (e) => cb(e.payload)),
  // SEC-3：settings-updated 只广播脱敏摘要 {theme, palette}（Rust
  // settings_broadcast_payload），整份 Settings 含明文凭据、不进事件。
  listenSettingsUpdated: (cb: (s: SettingsBroadcast) => void) =>
    listen<SettingsBroadcast>("settings-updated", (e) => cb(e.payload)),
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
