// @vitest-environment happy-dom
// P2-2（CQ-14）：四对话框的单例 host 样板收拢进 createDialogHost 工厂后，
// 为 Conflict/Dirty/Reload 三者补最小契约测试（ConfirmDialog 已有专测，不重复）：
//   1. 并发覆盖语义：第二次调用先把前者按该对话框的「取消」语义结算，
//      再接管单例——工厂把这个语义推广到了全部对话框（原实现这三者的
//      首个 awaiter 永不 settle，P2-2 顺带修复）；
//   2. 单次结算：点按钮 → 按钮值结算，对话框卸载；
//   3. 三个对话框各持独立单例，互不覆盖、互不结算。
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showConflict } from "./ConflictDialog";
import { showDirtyConfirm } from "./DirtyConfirmDialog";
import { showReloadConfirm } from "./ReloadDialog";

/** 给 Promise 外挂记账：结算与否、结算值，都从测试侧可观察。 */
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    s.done = true;
    s.value = v;
  });
  return s;
}

/** show* 渲染发生在 React 之外，统一裹 act 免告警并确保同步提交。 */
async function open<T>(show: () => Promise<T>) {
  let p!: Promise<T>;
  await act(async () => {
    p = show();
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
  // 兜底收尾：三个对话框各持独立单例 host（模块级，不随用例重建），至多各挂
  // 一个未决弹窗；逐个点掉首个还能点到的按钮，避免污染下一用例。
  for (let i = 0; i < 3; i++) {
    const stray = actionButtons()[0];
    if (!stray) break;
    await act(async () => stray.click());
  }
});

describe("showConflict 单例契约（P2-2）", () => {
  it("并发第二次调用把前者按「取消」结算，界面被后者接管", async () => {
    const s1 = await open(() => showConflict("a.md"));
    expect(s1.done).toBe(false); // 前置：尚未结算

    const s2 = await open(() => showConflict("b.md"));
    // 契约：被覆盖时按取消语义结算，不再挂死
    expect(s1.done).toBe(true);
    expect(s1.value).toBe("cancel");
    expect(document.body.textContent).toContain("b.md");

    await act(async () => findByLabel("覆盖")!.click());
    expect(s2).toEqual({ done: true, value: "overwrite" });
  });

  it("单次流程：覆盖→overwrite、取消→cancel，结算后卸载", async () => {
    const s = await open(() => showConflict("a.md"));
    await act(async () => findByLabel("覆盖")!.click());
    expect(s).toEqual({ done: true, value: "overwrite" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();

    const s2 = await open(() => showConflict("a.md"));
    await act(async () => findByLabel("取消")!.click());
    expect(s2).toEqual({ done: true, value: "cancel" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });
});

describe("showDirtyConfirm 单例契约（P2-2）", () => {
  it("并发第二次调用把前者按「取消」结算，界面被后者接管", async () => {
    const s1 = await open(() => showDirtyConfirm("a.md"));
    expect(s1.done).toBe(false);

    const s2 = await open(() => showDirtyConfirm("b.md"));
    expect(s1.done).toBe(true);
    expect(s1.value).toBe("cancel");
    expect(document.body.textContent).toContain("b.md");

    await act(async () => findByLabel("保存")!.click());
    expect(s2).toEqual({ done: true, value: "save" });
  });

  it("单次流程：不保存→discard、取消→cancel，结算后卸载", async () => {
    const s = await open(() => showDirtyConfirm("a.md"));
    await act(async () => findByLabel("不保存")!.click());
    expect(s).toEqual({ done: true, value: "discard" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();

    const s2 = await open(() => showDirtyConfirm("a.md"));
    await act(async () => findByLabel("取消")!.click());
    expect(s2).toEqual({ done: true, value: "cancel" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });
});

describe("showReloadConfirm 单例契约（P2-2）", () => {
  it("并发第二次调用把前者按「保留」结算（非破坏性默认），界面被后者接管", async () => {
    const s1 = await open(() => showReloadConfirm("a.md", true));
    expect(s1.done).toBe(false);

    const s2 = await open(() => showReloadConfirm("b.md", false));
    expect(s1.done).toBe(true);
    expect(s1.value).toBe("keep");
    expect(document.body.textContent).toContain("b.md");

    await act(async () => findByLabel("重新加载")!.click());
    expect(s2).toEqual({ done: true, value: "reload" });
  });

  it("单次流程：保留→keep、重载→reload，结算后卸载；dirty 提示随参数渲染", async () => {
    const s = await open(() => showReloadConfirm("a.md", true));
    expect(document.body.textContent).toContain("重新加载将丢失这些编辑");
    await act(async () => findByLabel("保留我的版本")!.click());
    expect(s).toEqual({ done: true, value: "keep" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();

    const s2 = await open(() => showReloadConfirm("a.md", false));
    expect(document.body.textContent).not.toContain("重新加载将丢失这些编辑");
    await act(async () => findByLabel("重新加载")!.click());
    expect(s2).toEqual({ done: true, value: "reload" });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });
});

describe("createDialogHost 独立单例（P2-2）", () => {
  it("三个对话框各持独立 host：互不覆盖、互不结算", async () => {
    const c = await open(() => showConflict("a.md"));
    const d = await open(() => showDirtyConfirm("a.md"));
    const r = await open(() => showReloadConfirm("a.md", false));

    // 三个弹窗同时挂着，且后到者不结算先到者（各一份单例闭包）
    expect(document.body.querySelectorAll(".modal-backdrop").length).toBe(3);
    expect(c.done).toBe(false);
    expect(d.done).toBe(false);
    expect(r.done).toBe(false);

    // 结算其一不影响其余两个
    await act(async () => findByLabel("重新加载")!.click());
    expect(r).toEqual({ done: true, value: "reload" });
    expect(c.done).toBe(false);
    expect(d.done).toBe(false);
  });
});
