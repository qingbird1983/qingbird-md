// @vitest-environment happy-dom
// discardChanges（放弃未保存改动）守卫测试：投影必须与写入同一次 set 内重算。
//
// BUG-6 / P0-6（docs/superpowers/plans/2026-09-19-code-audit-and-remediation.md）：
// 工作区删除脏文件时曾跨 store 直接 useDocStore.setState 只改 savedContent，
// 绕过 useDocStore 的集中写路径（patchActive/patchTab/commit）——isDirty 投影
// （content !== savedContent）不在同一次 set 里重算，脏标停留到下一次任意写
// 动作才自愈。useDocStore 暴露 discardChanges(id) 走 patchTab 后，「放弃改动
// 后 isDirty 立即为 false」。
import { beforeEach, describe, expect, it } from "vitest";

import { useDocStore } from "./useDocStore";
import { useTranslationStore } from "./useTranslationStore";

function reset() {
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

describe("useDocStore.discardChanges（放弃改动走集中写路径）", () => {
  beforeEach(reset);

  it("激活标签：放弃改动后 isDirty 立即为 false，savedContent 对齐内容", () => {
    useDocStore.getState().newTab();
    const id = useDocStore.getState().activeId!;
    useDocStore.getState().applyEdit("草稿内容", [0, 0]);
    expect(useDocStore.getState().isDirty).toBe(true);

    useDocStore.getState().discardChanges(id);

    // 修复前：跨 store 直接 setState 不重算投影 → isDirty 仍为 true，
    // 脏标要等下一次任意写动作才消失。
    expect(useDocStore.getState().isDirty, "投影必须与写入同次重算").toBe(false);
    const tab = useDocStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.savedContent).toBe("草稿内容");
    expect(tab.content).toBe("草稿内容");
  });

  it("非激活标签：按 id 只对齐该标签的基线，不扰动激活标签的脏态", () => {
    useDocStore.getState().newTab(); // A
    const a = useDocStore.getState().activeId!;
    useDocStore.getState().applyEdit("A 的草稿", [0, 0]);
    useDocStore.getState().newTab(); // B（新建即激活）
    const b = useDocStore.getState().activeId!;
    useDocStore.getState().applyEdit("B 的草稿", [0, 0]);
    expect(useDocStore.getState().isDirty).toBe(true); // 激活的是 B，B 脏

    useDocStore.getState().discardChanges(a); // 放弃非激活的 A

    // 激活标签 B 的脏态不受扰（投影仍按 activeId=B 重算）
    expect(useDocStore.getState().isDirty).toBe(true);
    // 切回 A：放弃已生效，不再追问保存
    useDocStore.getState().switchTab(a);
    expect(useDocStore.getState().isDirty).toBe(false);
    const tabA = useDocStore.getState().tabs.find((t) => t.id === a)!;
    expect(tabA.savedContent).toBe("A 的草稿");
    expect(tabA.id).not.toBe(b);
  });
});
