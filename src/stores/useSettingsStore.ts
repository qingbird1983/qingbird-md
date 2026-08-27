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
    applyTheme(t);
    const cur = get().settings;
    if (cur && cur.theme !== t) void get().save({ ...cur, theme: t });
  },

  credsFor: (provider) => get().settings?.providers[provider] ?? {},
}));
