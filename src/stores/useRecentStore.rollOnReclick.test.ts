// @vitest-environment happy-dom
// 达上限后列表冻结的根因回归测试：命中已开标签的「再打开」也必须登记最近打开。
import { describe, expect, it, vi } from "vitest";

/** vi.mock 被提升到 import 之前，桩掉 open_file 的 IPC（形状照 DocDTO 关键字段）。 */
vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      openFile: async (p: string) => ({
        name: p.split("/").pop() ?? p,
        content: `# ${p}`,
        mtime: 0,
        encoding: "UTF-8",
        parse: { html: "<p>mock</p>", outline: [] },
      }),
    },
  };
});

describe("最近打开滚动登记", () => {
  it("重新打开已开标签：条目置顶且列表仍 ≤ RECENT_MAX", async () => {
    const { useDocStore } = await import("./useDocStore");
    const { useRecentStore, RECENT_MAX } = await import("./useRecentStore");
    for (let i = 0; i < RECENT_MAX; i++) await useDocStore.getState().openTab(`C:/d/f${i}.md`);
    for (let i = 0; i < RECENT_MAX; i++) await useDocStore.getState().openTab(`C:/d/g${i}.md`);
    expect(useRecentStore.getState().items.length).toBe(RECENT_MAX);
    expect(useRecentStore.getState().items[0]!.path).toBe("C:/d/g9.md");
    // 点第 0 个（它一直在标签页里 open 过 → 命中 existing 分支）：应滚回置顶
    await useDocStore.getState().openTab("C:/d/f0.md");
    expect(useRecentStore.getState().items[0]!.path).toBe("C:/d/f0.md");
    expect(useRecentStore.getState().items.length).toBe(RECENT_MAX);
  });
});
