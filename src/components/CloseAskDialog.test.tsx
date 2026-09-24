// @vitest-environment happy-dom
// 终审修复 #1：「记住我的选择」勾选态不得跨开合残留。旧实现常驻挂载 + 组件内
// !open 早退门卫，remember 的 useState 会跨开合存活——下次关窗用户随手点
// 「隐藏到托盘」就被静默落盘固化。修复 = App.tsx 条件挂载（SettingsModal 同款先例），
// 卸载即归零。本测钉住完整闭环：
//   1. 勾选后取消，重开时复选框回到未勾选；
//   2. 重开当次（未勾选）点「隐藏到托盘」不触发 save 落盘，只走 applyCloseDecision。
// Gate 逐字复刻 App.tsx 挂载点的条件挂载（若改回常驻挂载 + 内部门卫，本测即红）。
// act 取自 react-dom/test-utils：本仓库解析到 React 18.3，主包尚无 React.act
// （19 才有）——import { act } from "react" 会在运行时拿到 undefined。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ipc 打桩只需 applyCloseDecision（记账 spy，vi.mock 工厂提升 → 必须 hoisted）；
// 其余导出保留真实模块：useSettingsStore 等链路同样引用 ../lib/ipc。
const { closeDecision } = vi.hoisted(() => ({
  closeDecision: vi.fn(async (_d: "tray" | "exit") => undefined),
}));
vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return { ...real, api: { ...real.api, applyCloseDecision: closeDecision } };
});

import CloseAskDialog from "./CloseAskDialog";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";

/** App.tsx 挂载点同款条件渲染：ui.closeAskOpen 真才挂弹窗。 */
function Gate() {
  const open = useUiStore((s) => s.closeAskOpen);
  return open ? <CloseAskDialog /> : null;
}

let root: Root;
const chk = () => document.querySelector<HTMLInputElement>(".close-ask-remember input")!;
const btn = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-actions button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  closeDecision.mockClear();
  useUiStore.getState().setCloseAskOpen(false);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("CloseAskDialog 勾选态跨开合归零（终审 #1）", () => {
  it("勾选→取消→重开：复选框未勾选，且此时点「隐藏到托盘」不落盘", () => {
    act(() => root.render(<Gate />));
    // 第一次弹出：勾上「记住我的选择」，然后取消
    act(() => useUiStore.getState().setCloseAskOpen(true));
    act(() => chk().click());
    expect(chk().checked).toBe(true);
    act(() => btn("取消")!.click());
    expect(useUiStore.getState().closeAskOpen).toBe(false);
    expect(document.querySelector(".close-ask-remember input")).toBeNull(); // 已卸载

    // 第二次弹出：勾选态必须归零（条件挂载白送的语义）
    act(() => useUiStore.getState().setCloseAskOpen(true));
    expect(chk().checked).toBe(false);

    // 旧 bug 的固化路径负向钉死：未勾选时点「隐藏到托盘」只执行动作、绝不调 save
    const save = vi.spyOn(useSettingsStore.getState(), "save");
    act(() => btn("隐藏到托盘")!.click());
    expect(save).not.toHaveBeenCalled();
    expect(closeDecision).toHaveBeenCalledWith("tray");
    expect(useUiStore.getState().closeAskOpen).toBe(false);
    save.mockRestore();
  });
});
