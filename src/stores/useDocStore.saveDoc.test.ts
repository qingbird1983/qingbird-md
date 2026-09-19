// @vitest-environment happy-dom
// 保存基线（savedContent）守卫测试：基线必须是**写盘的那份内容**。
//
// BUG-3 / P0-3（docs/superpowers/plans/2026-09-19-code-audit-and-remediation.md）：
// saveDoc 捕获快照 t.content 去写盘，await 往返期间用户继续输入会让
// cur.content 领先于磁盘内容。若把基线写成 await 之后的 cur.content，
// isDirty = content !== savedContent 便错误地变 false → 关标签不再弹保存
// 确认 → 未落盘的改动被静默丢弃。基线只能取写盘的 t.content。
import { beforeEach, describe, expect, it, vi } from "vitest";

/** IPC 调用记录（vi.mock 被提升到 import 之前，必须用 vi.hoisted 避免 TDZ）。 */
const h = vi.hoisted(() => ({
  saveCalls: [] as Array<[string, string]>,
  resolveSave: null as null | ((v: number | null) => void),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      // 只桩掉本文件会走到的两个：另存为路径 + 写盘。
      pickSavePath: async () => "C:\\doc\\a.md",
      // saveFile 挂起不返回：测试用 resolveSave 控制写盘往返何时落地，
      // 中间窗口里模拟「用户继续输入」。
      saveFile: (p: string, c: string) => {
        h.saveCalls.push([p, c]);
        return new Promise<number | null>((resolve) => {
          h.resolveSave = resolve;
        });
      },
    },
  };
});

import { useDocStore } from "./useDocStore";
import { useTranslationStore } from "./useTranslationStore";

function reset() {
  h.saveCalls.length = 0;
  h.resolveSave = null;
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

/** 微任务排水：等到 saveFile 真正被调用（saveDoc 内部要过 pickSavePath 一跳）。 */
async function untilSaveCalled() {
  for (let i = 0; i < 100 && h.saveCalls.length === 0; i++) await Promise.resolve();
}

describe("useDocStore.saveDoc（保存基线 = 写盘内容）", () => {
  beforeEach(reset);

  it("保存往返期间继续输入：保存完成后仍 isDirty === true，且 savedContent 等于写盘内容", async () => {
    useDocStore.getState().newTab();
    useDocStore.getState().applyEdit("v1", [0, 0]);

    // 不 await：让写盘往返挂起
    const saving = useDocStore.getState().saveDoc(true);
    await untilSaveCalled();
    // 写盘的是发起保存那一刻的快照
    expect(h.saveCalls[0]).toEqual(["C:\\doc\\a.md", "v1"]);

    // 往返期间用户继续输入
    useDocStore.getState().applyEdit("v1 往返期间的输入", [2, 2]);

    h.resolveSave!(12345); // 写盘落地，saveDoc 继续
    expect(await saving).toBe(true);

    // 修复前：savedContent 被写成 await 之后的最新内容 → isDirty 错误变 false，
    // 关标签不再弹保存确认，「往返期间的输入」被静默丢弃。
    expect(useDocStore.getState().isDirty, "往返期间的编辑必须保持脏").toBe(true);
    const tab = useDocStore.getState().tabs[0];
    expect(tab.savedContent).toBe("v1"); // 基线 = 磁盘上真实的内容
    expect(tab.content).toBe("v1 往返期间的输入");
  });

  it("保存往返期间没有编辑：基线正常推进，isDirty === false", async () => {
    useDocStore.getState().newTab();
    useDocStore.getState().applyEdit("v1", [0, 0]);

    const saving = useDocStore.getState().saveDoc(true);
    await untilSaveCalled();
    h.resolveSave!(12345);
    expect(await saving).toBe(true);

    expect(h.saveCalls[0]).toEqual(["C:\\doc\\a.md", "v1"]);
    expect(useDocStore.getState().isDirty).toBe(false);
    const tab = useDocStore.getState().tabs[0];
    expect(tab.savedContent).toBe("v1");
    expect(tab.mtime).toBe(12345);
  });
});
