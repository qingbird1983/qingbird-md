// @vitest-environment happy-dom
// credsFor 引用稳定性的守卫测试（2026-09-19 启动白屏回归钉）。
//
// 背景：zustand v5 的 selector 走 React useSyncExternalStore，getSnapshot
// 结果必须引用稳定。credsFor 曾经用 `?? {}` 兜底——settings 尚未从后端
// 加载完成时（启动的头几百毫秒，settings 为 null）每次调用都返回新对象，
// 把它用作 selector 的常驻组件（StatusBar）立即陷入无限重渲染，React
// 崩溃、整窗白屏。此处把「同一状态下连续调用返回同一引用」钉死：
//   - settings 为 null（启动未加载）
//   - settings 已加载但该 provider 没配过凭据
// 两种情形都必须稳定，否则 selector 化的任何组件都会复现白屏。
import { beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../types/ipc";
import { useSettingsStore } from "./useSettingsStore";

// 本文件只关心 credsFor 的取值路径（settings.providers[provider]），
// 其余字段与本主题无关——最小形状 + 断言，Settings 加字段也不必跟着改。
const settingsWith = (providers: Settings["providers"]): Settings =>
  ({ provider: "llm", providers }) as unknown as Settings;

describe("credsFor 引用稳定性（zustand v5 selector 前提）", () => {
  beforeEach(() => {
    // 回到「后端设置尚未加载」的出厂态
    useSettingsStore.setState({ settings: null });
  });

  it("settings 为 null 时，多次调用返回同一引用", () => {
    const s = useSettingsStore.getState();
    expect(s.settings).toBeNull();
    expect(s.credsFor("llm")).toBe(s.credsFor("llm"));
    expect(s.credsFor("llm")).toBe(s.credsFor("deepl"));
  });

  it("settings 已加载但 provider 缺失时，同样返回共享空对象", () => {
    useSettingsStore.setState({ settings: settingsWith({}) });
    const s = useSettingsStore.getState();
    expect(s.credsFor("llm")).toBe(s.credsFor("llm"));
  });

  it("provider 已配置时返回 settings 里的原对象（状态不变则引用不变）", () => {
    const creds = { baseUrl: "https://example.com", model: "x" };
    useSettingsStore.setState({ settings: settingsWith({ llm: creds }) });
    const s = useSettingsStore.getState();
    expect(s.credsFor("llm")).toBe(creds);
  });
});
