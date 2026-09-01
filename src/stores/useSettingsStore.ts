// 设置：从后端 load_settings 读全量 Settings（含按 provider 分组凭据）。
// 每次变更即持久化（save_settings 成功后后端广播 settings-updated，
// 本 store 的监听回调只在 theme 变化时收敛 theme 并提示——绝不回写，防广播风暴）。
import { create } from "zustand";
import type { Settings } from "../types/ipc";
import { api } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";

export type Theme = "light" | "dark" | "auto";

interface SettingsState {
  settings: Settings | null;
  theme: Theme;

  /** 启动加载 + 注册 settings-updated 监听（整个应用生命周期只挂一次）。 */
  load(): Promise<void>;
  save(next: Settings): Promise<void>;
  updateProvider(k: string): void;
  updateCredentials(k: string, v: Record<string, string>): void;
  setTheme(t: Theme): void;
  credsFor(provider: string): Record<string, string>;
}

const normalizeTheme = (t: string): Theme => (t === "light" || t === "dark" ? t : "auto");

// 本地态切换（不落盘）：监听回调专用，防止 echo → save → 广播 → echo 死循环
function applyTheme(t: Theme) {
  const s = useSettingsStore.getState();
  if (s.theme === t && s.settings?.theme === t) return;
  if (s.settings) useSettingsStore.setState({ theme: t, settings: { ...s.settings, theme: t } });
  else useSettingsStore.setState({ theme: t });
}

let listening = false;

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  theme: "auto",

  load: async () => {
    try {
      const s = await api.loadSettings();
      set({ settings: s, theme: normalizeTheme(s.theme) });
    } catch (e) {
      useUiStore.getState().addToast("error", `读取设置失败：${errText(e)}`);
      return;
    }
    if (!listening) {
      listening = true;
      // 后端在每次 save_settings 落盘后广播；回调用作跨源同步点。
      // 只做 setTheme + toast，不整包覆写 settings（避免打翻正在编辑的表单草稿）。
      api.listenSettingsUpdated((incoming) => {
        applyTheme(normalizeTheme(incoming.theme));
        useUiStore.getState().addToast("info", "设置已同步");
      });
    }
  },

  save: async (next) => {
    const prev = get().settings;
    set({ settings: next, theme: normalizeTheme(next.theme) });
    try {
      await api.saveSettings(next);
    } catch (e) {
      set({ settings: prev }); // 回滚乐观更新
      useUiStore.getState().addToast("error", `保存设置失败：${errText(e)}`);
    }
  },

  updateProvider: (k) => {
    const cur = get().settings;
    if (!cur || cur.provider === k) return;
    void get().save({ ...cur, provider: k });
  },

  // v 为该 provider 的完整凭据分组替换（与 Settings.providers 的形状直接对应）
  updateCredentials: (k, v) => {
    const cur = get().settings;
    if (!cur) return;
    void get().save({ ...cur, providers: { ...cur.providers, [k]: v } });
  },

  setTheme: (t) => {
    // 不能先 applyTheme：它会把 settings.theme 同步改成 t，导致下面的
    // cur.theme !== t 守卫永远为 false，api.saveSettings 永不发出，盘上无落痕，
    // 下次启动读回旧值（或默认空串→auto）→ "主题切了不持久"。
    // save 自身先 set 再 await 写盘，本地点亮 + 落盘一次完成。
    const cur = get().settings;
    if (!cur) {
      // 设置尚未加载（load 还没 resolve）：仅本地翻转，等 load 完成再覆盖。
      useSettingsStore.setState({ theme: t });
      return;
    }
    if (cur.theme === t) return;
    void get().save({ ...cur, theme: t });
  },

  credsFor: (provider) => get().settings?.providers[provider] ?? {},
}));

// T30 主题 → DOM 贯通：body[data-theme] 恒为解析后的 dark|light。
// 显式档由 store 订阅写入；auto 档由 matchMedia watch 随系统实时切换。
// CSS 侧只需 body[data-theme="dark"] 一套覆盖（styles/theme.css）。
const sysDark = matchMedia("(prefers-color-scheme: dark)");

/** 解析后的暗色判定（EditorView/commands 统一口径）：dark 直取，auto 跟随系统。 */
export function isDarkTheme(): boolean {
  const t = useSettingsStore.getState().theme;
  return t === "dark" || (t !== "light" && sysDark.matches);
}

let lastDomTheme: string | null = null;
function syncDomTheme() {
  const resolved = isDarkTheme() ? "dark" : "light";
  if (resolved === lastDomTheme) return;
  lastDomTheme = resolved;
  document.body.dataset.theme = resolved;
}
useSettingsStore.subscribe(syncDomTheme);
sysDark.addEventListener("change", syncDomTheme);
syncDomTheme(); // subscribe 只推变更，启动须手动同步一次（防暗色系统白闪）
