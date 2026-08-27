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
