// 设置：从后端 load_settings 读全量 Settings（含按 provider 分组凭据）。
// 每次变更即持久化（save_settings 成功后后端广播 settings-updated，
// 本 store 的监听回调只在 theme 变化时收敛 theme 并提示——绝不回写，防广播风暴）。
import { create } from "zustand";
import type { Settings, TargetLang } from "../types/ipc";
import { api } from "../lib/ipc";
import { normalizePalette, type PaletteId } from "../lib/paletteSeeds";
import { useUiStore, errText } from "./useUiStore";

export type Theme = "light" | "dark" | "auto";

interface SettingsState {
  settings: Settings | null;
  theme: Theme;
  /** 主题配色（与明暗正交）；真源清单见 lib/paletteSeeds.ts */
  palette: PaletteId;
  /** 翻译方向（目标语言）。默认 zh = 改动前行为；落盘在 settings.translate_target */
  target: TargetLang;

  /** 启动加载 + 注册 settings-updated 监听（整个应用生命周期只挂一次）。 */
  load(): Promise<void>;
  save(next: Settings): Promise<void>;
  updateProvider(k: string): void;
  updateCredentials(k: string, v: Record<string, string>): void;
  setTheme(t: Theme): void;
  setPalette(p: PaletteId): void;
  setTarget(t: TargetLang): void;
  credsFor(provider: string): Record<string, string>;
}

const normalizeTheme = (t: string): Theme => (t === "light" || t === "dark" ? t : "auto");

/**
 * 方向归一化：只认 "en"，其余（空串/未知/未来新语种）一律 `zh`。
 *
 * 与 Rust `TargetLang::from_tag` 同一口径——**两边必须一致**：前端拿它去起跑
 * 与渲染，后端拿它算缓存键与 `data-bi` 占号，任一边多认一个字面量都会让
 * 「同一篇文档两处算出不同索引空间」。
 */
export const normalizeTarget = (t: string | undefined): TargetLang => (t === "en" ? "en" : "zh");

/**
 * 跨源同步（监听回调专用，不落盘）：广播来的设置只收敛「外观」两项
 * （theme / palette），不整包覆写 settings——否则会打翻正在编辑的表单草稿。
 * 本地态先改再判断，是为了防止 echo → save → 广播 → echo 死循环。
 *
 * **刻意不收 translations_target（方向）**：外观是纯展示，收敛即刻生效；
 * 方向却是**索引空间的一部分**（`data-bi` 占号随它变），必须与「清显示 + 清
 * translations + 清 doneHtml」那一整套 reset 一起走（useDocStore.setTranslateTarget）。
 * 在这里顺手收敛，等于制造一次「方向变了但没有 reset」的静默错位。
 */
function applyRemote(incoming: Settings) {
  const t = normalizeTheme(incoming.theme);
  const p = normalizePalette(incoming.palette);
  const s = useSettingsStore.getState();
  if (s.theme === t && s.palette === p && s.settings?.theme === t && s.settings?.palette === p) {
    return;
  }
  useSettingsStore.setState(
    s.settings
      ? { theme: t, palette: p, settings: { ...s.settings, theme: t, palette: p } }
      : { theme: t, palette: p },
  );
}

let listening = false;

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  theme: "auto",
  palette: normalizePalette(""),
  target: "zh",

  load: async () => {
    try {
      const s = await api.loadSettings();
      set({
        settings: s,
        theme: normalizeTheme(s.theme),
        palette: normalizePalette(s.palette),
        target: normalizeTarget(s.translate_target),
      });
    } catch (e) {
      useUiStore.getState().addToast("error", `读取设置失败：${errText(e)}`);
      return;
    }
    if (!listening) {
      listening = true;
      // 后端在每次 save_settings 落盘后广播；回调用作跨源同步点。
      // 只做 theme/palette 收敛 + toast，不整包覆写 settings（避免打翻表单草稿）。
      api.listenSettingsUpdated((incoming) => {
        applyRemote(incoming);
        useUiStore.getState().addToast("info", "设置已同步");
      });
    }
  },

  save: async (next) => {
    const prev = get().settings;
    set({
      settings: next,
      theme: normalizeTheme(next.theme),
      palette: normalizePalette(next.palette),
      // 方向同样由 settings 派生（单源）：设置弹窗整包保存时也保持镜像一致。
      target: normalizeTarget(next.translate_target),
    });
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

  // 与 setTheme 同构：守卫必须读 cur.palette（归一化后），别先本地 set——
  // 那样守卫恒假、盘上无落痕，下次启动读回旧值（与主题那个坑同源）。
  setPalette: (p) => {
    const cur = get().settings;
    if (!cur) {
      useSettingsStore.setState({ palette: p });
      return;
    }
    if (normalizePalette(cur.palette) === p) return;
    void get().save({ ...cur, palette: p });
  },

  credsFor: (provider) => get().settings?.providers[provider] ?? {},

  // 与 setTheme/setPalette 同构的守卫写法：必须读 cur 上的**归一化值**再比，
  // 不能先本地 set——那样守卫恒假、盘上无落痕，下次启动读回旧值。
  //
  // ⚠️ **本动作只负责"偏好落盘"，不负责 reset 显示态**。方向变更必须连带
  // `resetDisplay()` + 清 translations + 清 doneHtml（索引空间变了），那套动
  // 作在 `useDocStore.setTranslateTarget` 里、与 switchMode 同级。UI 不要直接
  // 调本动作，否则会造出"方向变了但旧译文还在"的错位态。
  setTarget: (t) => {
    const cur = get().settings;
    if (!cur) {
      // 设置尚未加载（load 还没 resolve）：仅本地翻转，等 load 完成再覆盖。
      set({ target: t });
      return;
    }
    if (normalizeTarget(cur.translate_target) === t) return;
    void get().save({ ...cur, translate_target: t });
  },
}));

// T30 主题 → DOM 贯通：body[data-theme] 恒为解析后的 dark|light。
// 显式档由 store 订阅写入；auto 档由 matchMedia watch 随系统实时切换。
// CSS 侧只需 body[data-theme="dark"] 一套覆盖（styles/theme.css）。
//
// 2026-09-14 起这里同时写 body[data-palette]（恒为合法 id，含默认档 xuan）：
// 明暗由 data-theme 表达、纸色由 data-palette 表达，两者正交，
// 于是 CSS 只有「浅档一层属性 × 深档两层属性」两种选择器（palettes.css）。
export const sysDark = matchMedia("(prefers-color-scheme: dark)");

/** 解析后的暗色判定（EditorView/commands 统一口径）：dark 直取，auto 跟随系统。 */
export function isDarkTheme(): boolean {
  const t = useSettingsStore.getState().theme;
  return t === "dark" || (t !== "light" && sysDark.matches);
}

// 记忆的是「明暗:配色」整个键——只记明暗的话，换配色不会触发写入。
let lastDomKey: string | null = null;
function syncDomTheme() {
  const resolved = isDarkTheme() ? "dark" : "light";
  const paletteId = normalizePalette(useSettingsStore.getState().palette);
  const key = `${resolved}:${paletteId}`;
  if (key === lastDomKey) return;
  lastDomKey = key;
  document.body.dataset.theme = resolved;
  document.body.dataset.palette = paletteId;
}
useSettingsStore.subscribe(syncDomTheme);
sysDark.addEventListener("change", syncDomTheme);
syncDomTheme(); // subscribe 只推变更，启动须手动同步一次（防暗色系统白闪）
