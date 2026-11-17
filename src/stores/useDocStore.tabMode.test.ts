// 标签页模式守卫（2026-11-18）：multi=多标签追加（改动前行为），
// single=打开/新建/示例文档都复用唯一标签，不叠加。
// 单源 = settings.tab_mode，由 normalizeTabMode 归一化；三处开标签动作
// （openTab / newTab / openExampleTab）都必须遵守，漏一处就会出现「切了单标签
// 但新建又冒出第二个」的错位。
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../types/ipc";

const h = vi.hoisted(() => ({
  opened: [] as string[],
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      openFile: async (path: string) => {
        h.opened.push(path);
        return {
          name: path.split(/[\\/]/).pop() ?? path,
          path,
          content: "正文",
          encoding: "UTF-8",
          mtime: 1,
          parse: { html: "<p>正文</p>", outline: [] },
        };
      },
    },
  };
});

import { useDocStore } from "./useDocStore";
import { normalizeTabMode, useSettingsStore } from "./useSettingsStore";
import { useRecentStore } from "./useRecentStore";

const SEED: Settings = {
  provider: "auto",
  providers: {},
  workspace: null,
  last_file: null,
  hotkeys: {},
  selection_translate: true,
  outline: "on",
  nav: "on",
  theme: "light",
  palette: "xuan",
  autostart: false,
  translate_target: "zh",
  relayout_on_export: true,
  capture_enabled: true,
  close_action: "ask",
  tab_mode: "multi",
};

function reset(tabMode: string) {
  h.opened.length = 0;
  useDocStore.setState({
    tabs: [],
    activeId: null,
    doc: null,
    view: "preview",
    mode: "original",
    cursorSel: [0, 0],
    isDirty: false,
    parseResult: null,
    htmlCache: null,
    doneHtml: null,
    translations: new Map(),
  });
  useSettingsStore.setState({
    settings: { ...SEED, tab_mode: tabMode },
    target: "zh",
    theme: "light",
    palette: "xuan",
  });
  useRecentStore.setState({ items: [] });
}

describe("normalizeTabMode", () => {
  it("只认 single，其余收敛到 multi", () => {
    expect(normalizeTabMode("single")).toBe("single");
    expect(normalizeTabMode("multi")).toBe("multi");
    expect(normalizeTabMode("")).toBe("multi");
    expect(normalizeTabMode(undefined)).toBe("multi");
    expect(normalizeTabMode("weird")).toBe("multi");
  });
});

describe("openTab 标签模式", () => {
  it("multi：连续打开两份文档 → 两个标签", async () => {
    reset("multi");
    await useDocStore.getState().openTab("C:\\a.md");
    await useDocStore.getState().openTab("C:\\b.md");
    expect(useDocStore.getState().tabs).toHaveLength(2);
  });

  it("single：连续打开两份文档 → 始终一个标签", async () => {
    reset("single");
    await useDocStore.getState().openTab("C:\\a.md");
    await useDocStore.getState().openTab("C:\\b.md");
    const tabs = useDocStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.path).toBe("C:\\b.md");
    expect(useDocStore.getState().activeId).toBe(tabs[0]!.id);
  });
});

describe("newTab / openExampleTab 标签模式", () => {
  it("multi：新建 + 示例 → 各占一个标签", () => {
    reset("multi");
    useDocStore.getState().newTab();
    useDocStore.getState().openExampleTab("示例", "内容");
    expect(useDocStore.getState().tabs).toHaveLength(2);
  });

  it("single：新建 + 示例 → 只留最后一个标签", () => {
    reset("single");
    useDocStore.getState().newTab();
    useDocStore.getState().openExampleTab("示例", "内容");
    const tabs = useDocStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.name).toBe("示例");
  });
});
