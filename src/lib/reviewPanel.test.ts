// @vitest-environment happy-dom
// S4 #14 守卫：入口层「先开面板，再注入」。
//
// 为什么值钱：面板是**条件挂载**的，`setReviewOpen(true)` 只是把状态改掉，
// 槽位真正进 DOM 要等 React 提交、主区重排才落定。如果 `then` 被同步执行，
// 调用方会在"旧宽度"的布局上量坐标 / 往不存在的监听器上发事件 ——
// 表现就是"跳过去偏一截"或"注入的草稿没反应"。
// 所以第一条断言就是"**不在同一 tick 里执行 then**"，旧写法在这里必红。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterLayoutStable, ensureReviewPanelOpen, revealReviewIssues } from "./reviewPanel";
import { useUiStore } from "../stores/useUiStore";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** 轮询若干帧直到条件成立（不 sleep，避免依赖具体帧数）。 */
async function until(cond: () => boolean, frames = 8): Promise<boolean> {
  for (let i = 0; i < frames && !cond(); i += 1) await nextFrame();
  return cond();
}

beforeEach(() => {
  useUiStore.setState({ showReview: false });
});

describe("afterLayoutStable", () => {
  it("等两帧，不是一帧（一帧时槽位可能还没被 React 提交进 DOM）", () => {
    const origRaf = globalThis.requestAnimationFrame;
    const calls: Array<() => void> = [];
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      calls.push(fn as unknown as () => void);
      return calls.length;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      let done = false;
      afterLayoutStable(() => {
        done = true;
      });

      expect(calls.length).toBe(1); // 排了第 1 帧
      calls.shift()!(); // 跑第 1 帧 → 应只排出第 2 帧，回调还没执行
      expect(done).toBe(false);
      expect(calls.length).toBe(1);

      calls.shift()!(); // 跑第 2 帧 → 回调执行
      expect(done).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });
});

describe("ensureReviewPanelOpen", () => {
  it("面板未开：立刻打开，但**不在同一 tick** 里执行 then", () => {
    const then = vi.fn();
    ensureReviewPanelOpen(then);

    expect(useUiStore.getState().showReview).toBe(true);
    expect(then).not.toHaveBeenCalled();
  });

  it("等布局落定后才执行 then", async () => {
    const order: string[] = [];
    ensureReviewPanelOpen(() => order.push("then"));
    expect(order).toEqual([]);
    expect(await until(() => order.length > 0)).toBe(true);
    expect(order).toEqual(["then"]);
  });

  it("面板已开：同步执行（布局本来就稳，不必空等两帧造成一次闪现）", () => {
    useUiStore.setState({ showReview: true });
    const then = vi.fn();
    ensureReviewPanelOpen(then);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it("幂等：开着就保持开（不能像 toggle 那样把已开的关掉）", () => {
    useUiStore.setState({ showReview: true });
    ensureReviewPanelOpen();
    expect(useUiStore.getState().showReview).toBe(true);

    useUiStore.setState({ showReview: false });
    ensureReviewPanelOpen();
    ensureReviewPanelOpen();
    expect(useUiStore.getState().showReview).toBe(true);
  });

  it("不传 then 也不炸（“只把面板打开”是合法用法）", () => {
    expect(() => ensureReviewPanelOpen()).not.toThrow();
    expect(useUiStore.getState().showReview).toBe(true);
  });
});

describe("revealReviewIssues", () => {
  let scrolled: Element | null;

  beforeEach(() => {
    scrolled = null;
    // 不用 spy：直接记 `this`，比从 mock.instances / contexts 里掏稳定。
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (
      this: Element,
    ) {
      scrolled = this;
    };
    document.body.innerHTML = "";
  });

  it("有计数条时落在计数条上（清单紧随其下，「多少条」与「哪几条」同时可见）", () => {
    document.body.innerHTML = `
      <div class="review-body">
        <section class="review-timeline"></section>
        <div class="review-checks-bar warn"></div>
        <ul class="review-issues"><li></li></ul>
      </div>`;
    expect(revealReviewIssues()).toBe(true);
    expect((scrolled as Element | null)?.className).toBe("review-checks-bar warn");
  });

  it("只有清单时退而求其次落清单", () => {
    document.body.innerHTML = `<div class="review-body"><ul class="review-issues"><li></li></ul></div>`;
    expect(revealReviewIssues()).toBe(true);
    expect((scrolled as Element | null)?.className).toBe("review-issues");
  });

  it("两者都没有（还没译文 / 没查出问题）→ 不滚、返回 false，让空态卡自己居中", () => {
    document.body.innerHTML = `<div class="review-body"><div class="review-empty"></div></div>`;
    expect(revealReviewIssues()).toBe(false);
    expect(scrolled).toBeNull();
  });
});
