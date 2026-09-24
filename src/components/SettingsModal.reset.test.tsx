// @vitest-environment happy-dom
// 设置面板左下角「一键恢复全局默认设置」（Task 12 / 需求 7）。
//
// 为什么单独开一份文件而不是续在 SettingsModal.test.tsx：那份已 674 行，
// 预算红线是任何单文件总量 ≤700（src/lib/codeSizeBudget.test.ts 每次 npm test 强判），
// 两件事再叠上来必红——与其把欠账留给以后，不如按职责切片（同 P2 拆分口径）。
// 挂载骨架（rAF 同步桩 + 异步 act 排空 IPC promise）逐字沿用那份文件的既有口径。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 后端全不在：IPC 里本次链路要动的口子全部打桩（resetSettings/loadSettings），
// 其余挂载期会发的请求给静默成功桩，避免 error toast 干扰断言。
// 元数据在工厂内部自建：vi.mock 会被提升到 import 之前执行，引用顶层常量会撞 TDZ。
vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      getProviders: async () => [],
      userDataDir: async () => "C:/Users/x/AppData/Roaming/qingbird-md",
      dataDirLabel: async () => "%APPDATA%\\qingbird-md",
      listenSettingsUpdated: async () => () => {},
    },
  };
});

import SettingsModal from "./SettingsModal";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";
import type { Settings } from "../types/ipc";

/** 改动过的现状（草稿类字段 provider/hotkeys/凭据都偏离出厂值，供恢复后对照）。 */
const SEED: Settings = {
  provider: "llm",
  providers: { llm: { baseUrl: "https://api.deepseek.com", apiKey: "sk-test", model: "m" } },
  workspace: null,
  last_file: null,
  hotkeys: { original: "Ctrl+1", translation: "", bilingual: "", capture: "" },
  selection_translate: false,
  outline: "off",
  nav: "on",
  theme: "light",
  palette: "qing",
  llm_profiles: [],
  llm_active: "",
  autostart: false,
  translate_target: "zh",
  relayout_on_export: true,
  capture_enabled: true,
  close_action: "ask",
};

/** 出厂值镜像：与 Rust storage::Settings::default() 逐字段一致（hotkeyRegistry 同表）。 */
const DEFAULTS: Settings = {
  provider: "auto",
  providers: {},
  workspace: null,
  last_file: null,
  hotkeys: { original: "Ctrl+Alt+1", translation: "Ctrl+Alt+2", bilingual: "Ctrl+Alt+3", capture: "Ctrl+Shift+X" },
  selection_translate: true,
  outline: "on",
  nav: "on",
  theme: "",
  palette: "",
  llm_profiles: [],
  llm_active: "",
  autostart: false,
  translate_target: "",
  relayout_on_export: true,
  capture_enabled: true,
  close_action: "ask",
};

let host: HTMLDivElement;
let root: Root;

const origRaf = globalThis.requestAnimationFrame;
const drain = () => new Promise((r) => setTimeout(r, 0));
const renderModal = async () => {
  await act(async () => {
    root.render(<SettingsModal />);
    await drain();
  });
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
  useSettingsStore.setState({ settings: { ...SEED }, theme: "light", palette: "qing" });
  useUiStore.setState({ settingsOpen: true, toasts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await renderModal();
});

afterEach(() => {
  act(() => root.unmount());
  globalThis.requestAnimationFrame = origRaf;
  vi.restoreAllMocks();
  host.remove();
});

const resetBtn = () => host.querySelector<HTMLButtonElement>(".set-nav-reset")!;

describe("设置面板左下角一键恢复", () => {
  it("两段式确认：首次点击只变红提示，再点才执行；成功拉回全量并复位两条 UI 偏好", async () => {
    const { api } = await import("../lib/ipc");
    const reset = vi.spyOn(api, "resetSettings").mockResolvedValue(undefined);
    const load = vi.spyOn(useSettingsStore.getState(), "load").mockResolvedValue(undefined);
    // 恢复前把两条 localStorage 纯偏好拨偏离出厂值（引线出厂开 / 宽度出厂 normal）。
    // setState 会驱动已挂载的 GeneralTab 重渲，必须在 act 里发生（Task 9 评审口径）。
    act(() => {
      useUiStore.getState().setContentWidth("wide");
      useUiStore.getState().setListGuide(false);
    });

    expect(resetBtn().textContent).toBe("一键恢复默认设置");
    act(() => resetBtn().click());
    expect(reset).not.toHaveBeenCalled(); // 第一击绝不执行
    expect(resetBtn().className).toContain("armed");
    expect(resetBtn().textContent).toBe("再点一次确认恢复（不可撤销）");

    await act(async () => {
      resetBtn().click();
      await drain();
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1); // 全量设置从盘上拉回
    expect(resetBtn().className).not.toContain("armed");
    expect(useUiStore.getState().contentWidth).toBe("normal");
    expect(useUiStore.getState().listGuide).toBe(true);
    const toasts = useUiStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toBe("已恢复全局默认设置（不含最近打开与翻译缓存）");
  });

  it("失败路径：命令报错给 error toast，armed 解除、UI 偏好不动", async () => {
    const { api } = await import("../lib/ipc");
    vi.spyOn(api, "resetSettings").mockRejectedValue(new Error("boom"));
    act(() => useUiStore.getState().setContentWidth("wide"));
    act(() => resetBtn().click());
    await act(async () => {
      resetBtn().click();
      await drain();
    });
    expect(resetBtn().className).not.toContain("armed");
    const toasts = useUiStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toBe("恢复默认失败：boom");
    expect(useUiStore.getState().contentWidth).toBe("wide"); // 没走成功分支
  });

  it("恢复后关窗不吃旧草稿：load() 重种草稿，关窗落盘的是出厂值而不是恢复前快照", async () => {
    // 回归钉（Task 10/11 覆盖问题的全量版）：draft 是恢复前的快照，不重种草的话，
    // 关窗 saveAndClose 会把旧 provider/凭据/热键整包写回盘，等于把恢复作废。
    const { api } = await import("../lib/ipc");
    vi.spyOn(api, "resetSettings").mockResolvedValue(undefined);
    // 真 load()：让 loadGeneration 递增触发重种草（桩掉它这条链路就测不到）
    const loadSettings = vi.spyOn(api, "loadSettings").mockResolvedValue({ ...DEFAULTS });
    act(() => resetBtn().click());
    await act(async () => {
      resetBtn().click();
      await drain();
    });
    expect(loadSettings).toHaveBeenCalledTimes(1);

    const save = vi.spyOn(useSettingsStore.getState(), "save").mockResolvedValue(undefined);
    act(() => host.querySelector<HTMLButtonElement>(".set-x")!.click());
    const written = save.mock.calls[0]![0] as Settings;
    expect(written.provider).toBe("auto"); // 草稿类字段：恢复前是 "llm"
    expect(written.hotkeys.original).toBe("Ctrl+Alt+1"); // 恢复前是 "Ctrl+1"
    expect(written.providers.llm).toBeUndefined(); // 旧凭据不回写
    expect(written.selection_translate).toBe(true); // 恢复前被草稿拨成了 false
    save.mockRestore();
  });
});
