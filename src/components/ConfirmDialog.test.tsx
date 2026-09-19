// @vitest-environment happy-dom
// P1-7（REL-4）回归：showConfirm 的注释契约「重复调用覆盖前者，解析为 false」。
//
// 修复前：并发第二次调用直接重渲单例 root，前一个 Promise 的 resolve 永远
// 无人调用 → 首个 awaiter 挂死。这里的钉法是给 Promise 挂 then 记账后断言
// 「已结算且值为 false」：坏实现下 s1 永远停在 { done: false }，断言失败
// （而不是测试进程超时挂起）。
//
// 顺带钉住两条相邻契约，防实现回退：
//   1. 单例闸：并发时界面上至多一个弹窗，且是后到者的内容；
//   2. 单次流程：确认 → true、取消 → false，结算后对话框卸载（root 渲染 null）。
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showConfirm } from "./ConfirmDialog";

/** 给 Promise 外挂记账：结算与否、结算值，都从测试侧可观察。 */
function track(p: Promise<boolean>) {
  const s: { done: boolean; value?: boolean } = { done: false };
  void p.then((v) => {
    s.done = true;
    s.value = v;
  });
  return s;
}

/** showConfirm 渲染发生在 React 之外，统一裹 act 免告警并确保同步提交。 */
async function ask(title: string) {
  let p!: Promise<boolean>;
  await act(async () => {
    p = showConfirm({ title, body: `${title}-body` });
  });
  return track(p);
}

const actionButtons = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>(".modal-actions button"));
const findByLabel = (label: string) =>
  actionButtons().find((b) => (b.textContent ?? "").trim() === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  // 兜底收尾：若上一用例留了未决弹窗（异常路径），点掉它，避免污染下一
  // 用例共享的模块级单例（host/root 在模块顶层，不随用例重建）。注意不能
  // 清空 document.body：那会把单例 host 从 DOM 摘走，后续用例就渲染进
  // 游离节点了——与应用内「host 常驻」的生命周期保持一致。
  const stray = actionButtons()[0];
  if (stray) await act(async () => stray.click());
});

describe("showConfirm 单例契约（REL-4）", () => {
  it("并发第二次调用把前者解析为 false，不再挂死", async () => {
    const s1 = await ask("第一个");
    expect(s1.done).toBe(false); // 前置：尚未结算

    const s2 = await ask("第二个");
    // 契约：前者被覆盖时按注释语义解析为 false（= 取消，调用方据此中止）
    expect(s1.done).toBe(true);
    expect(s1.value).toBe(false);

    // 界面被后者接管；用户点「确定」→ 后者解析 true
    expect(document.body.textContent).toContain("第二个");
    const confirm = findByLabel("确定");
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    expect(s2.done).toBe(true);
    expect(s2.value).toBe(true);
  });

  it("同一时刻至多一个弹窗：后者覆盖前者的 DOM", async () => {
    await ask("第一个");
    expect(document.body.querySelectorAll(".modal-backdrop").length).toBe(1);

    await ask("第二个");
    // 闸生效：仍只有一个模态，且标题是后到者
    expect(document.body.querySelectorAll(".modal-backdrop").length).toBe(1);
    expect(document.body.querySelector(".modal-title")?.textContent).toBe("第二个");
  });

  it("单次流程：确认→true、取消→false，结算后对话框卸载", async () => {
    const ok = await ask("确认框");
    await act(async () => findByLabel("确定")!.click());
    expect(ok).toEqual({ done: true, value: true });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();

    const no = await ask("取消框");
    await act(async () => findByLabel("取消")!.click());
    expect(no).toEqual({ done: true, value: false });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });
});
