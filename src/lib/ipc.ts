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
  DonePayload,
  Mode,
} from "../types/ipc";

export const api = {
  // ---- 文件 ----
  openFile: (p: string) => invoke<DocDTO>("open_file", { path: p }),
  saveFile: (p: string, c: string) => invoke<void>("save_file", { path: p, content: c }),

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

  // ---- 翻译 ----
  getProviders: () => invoke<ProviderInfo[]>("get_providers"),
  getProviderMeta: (k: string) => invoke<ProviderInfo | null>("get_provider_meta", { key: k }),
  translateText: (t: string, p: string, c: Record<string, string>) =>
    invoke<string>("translate_text", { text: t, provider: p, creds: c }),
  translateDocument: (c: string, m: Mode, p: string, creds: Record<string, string>) =>
    invoke<number>("translate_document", { content: c, mode: m, provider: p, creds }),
  stopTranslation: () => invoke<void>("stop_translation"),

  // ---- 事件（事件名与 lib.rs .emit(...) 注册逐字一致）----
  listenDocumentChanged: (cb: (p: string) => void) =>
    listen<{ path: string }>("document-changed", (e) => cb(e.payload.path)),
  listenProgress: (cb: (p: ProgressPayload) => void) =>
    listen<ProgressPayload>("translation-progress", (e) => cb(e.payload)),
  listenDone: (cb: (p: DonePayload) => void) =>
    listen<DonePayload>("translation-done", (e) => cb(e.payload)),
  listenSettingsUpdated: (cb: (s: Settings) => void) =>
    listen<Settings>("settings-updated", (e) => cb(e.payload)),
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
