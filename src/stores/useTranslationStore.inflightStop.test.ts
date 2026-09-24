// @vitest-environment happy-dom
// 起跑成功分支代际守卫测试：被 stop()/resetDisplay() 取代的迟到响应不得复活。
//
// BUG-5 / P0-5（docs/superpowers/plans/2026-09-19-code-audit-and-remediation.md）：
// translateDocument 的 catch 分支有 if (get().gen === genBefore) 守卫，成功分支
// 没有——在飞 invoke 期间 stop()（gen 前跳、status 归 idle、已通知后端取消）后
// 响应回来仍无条件 set({gen: r.gen, status: "running"})。此后后端不再发同 gen
// 事件 → status 永久卡 running，translateDocument/startIfFresh 全被挡死。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types/ipc";

/** IPC 调用记录（vi.mock 被提升到 import 之前，必须用 vi.hoisted 避免 TDZ）。 */
const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  resolvers: [] as Array<(v: unknown) => void>,
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      // 只桩掉本文件会走到的两个：起跑（挂起，由测试控制何时返回）+ 取消。
      translateDocument: async (...args: unknown[]) => {
        h.calls.push(args);
        return new Promise((resolve) => {
          h.resolvers.push(resolve);
        });
      },
      stopTranslation: async () => {},
    },
  };
});

import { useDocStore } from "./useDocStore";
import { useSettingsStore } from "./useSettingsStore";
import { useTranslationStore } from "./useTranslationStore";

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
  llm_profiles: [],
  llm_active: "",
  autostart: false,
  translate_target: "zh",
  relayout_on_export: true,
  capture_enabled: true,
  close_action: "ask",
};

const CONTENT = "# 标题\n\n正文段落";

function started(gen: number) {
  return { kind: "started", gen, first_index: 0, indices: [], indices_blocks: [] };
}

/** 微任务排水：让挂起的 translateDocument 续体（含 finally）跑完。 */
async function drain() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function reset() {
  h.calls.length = 0;
  h.resolvers.length = 0;
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
  useSettingsStore.setState({ settings: { ...SEED }, target: "zh", theme: "light", palette: "xuan" });
  useTranslationStore.setState({
    status: "idle",
    progress: null,
    gen: 0,
    lastRunMode: null,
    runContent: null,
    scope: "off",
    viewport: null,
    lastWindow: null,
    partialBlocks: new Map(),
    partialCursor: 0,
    partialGen: 0,
  });
}

describe("useTranslationStore.translateDocument（起跑成功分支代际守卫）", () => {
  beforeEach(reset);

  it("在飞 invoke 期间 stop：迟到响应不得把 status 拉回 running，后续翻译不被挡死", async () => {
    // 准备：bilingual 模式（switchMode 会自动起跑 run#1，invoke 挂起在 mock 里）
    useDocStore.getState().newTab();
    useDocStore.getState().applyEdit(CONTENT, [0, 0]);
    useDocStore.getState().switchMode("bilingual");
    expect(h.calls).toHaveLength(1);
    const genBefore = useTranslationStore.getState().gen; // resetDisplay 已前跳到 1

    // 在飞期间用户按停止：gen 前跳、status 归 idle、后端收到取消
    useTranslationStore.getState().stop();
    expect(useTranslationStore.getState().gen).toBe(genBefore + 1);
    expect(useTranslationStore.getState().status).toBe("idle");

    // 迟到的起跑响应此刻才回来
    h.resolvers[0]!(started(100));
    await drain();

    // 修复前：成功分支无守卫 → status 被拉回 running，而同 gen 事件永不再来
    expect(
      useTranslationStore.getState().status,
      "被取代轮次的响应不得复活 running",
    ).not.toBe("running");
    expect(useTranslationStore.getState().gen).toBe(genBefore + 1); // gen 不被迟到响应回写

    // 守卫只挡「被取代的轮次」：stop 之后的再次起跑必须照常，不被卡死
    const rerun = useTranslationStore.getState().translateDocument("full");
    expect(h.calls, "status 卡 running 会挡死后续起跑").toHaveLength(2);
    h.resolvers[1]!(started(101));
    await rerun;
    expect(useTranslationStore.getState().status).toBe("running"); // 正常轮次照常进 running
    expect(useTranslationStore.getState().gen).toBe(101);
  });
});
