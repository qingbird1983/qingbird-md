// @vitest-environment happy-dom
// S4 #11 守卫：进度时间线的「默认折叠只显最新一步」。
// 核查步骤会越来越多（确定性 → 分批语义核查 → 重排版建议），全展开会把 issue
// 列表挤出屏幕；而用户真正要看的永远是"现在跑到哪了"。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ReviewTimeline, { STEP_STATUS_TONE, type ReviewStep } from "./ReviewTimeline";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (steps: ReviewStep[]) =>
  act(() => {
    root.render(<ReviewTimeline steps={steps} />);
  });

const rows = () => Array.from(host.querySelectorAll<HTMLLIElement>(".review-step"));
const summaries = () => rows().map((r) => r.querySelector(".review-step-summary")!.textContent);
const toggle = () => host.querySelector<HTMLButtonElement>(".review-timeline-toggle");

const step = (over: Partial<ReviewStep> = {}): ReviewStep => ({
  type: "deterministic",
  status: "done",
  summary: "确定性检查 · 通过",
  ...over,
});

describe("ReviewTimeline", () => {
  it("没有步骤时整块不渲染（不留空壳把 issue 列表往下挤）", () => {
    render([]);
    expect(host.querySelector(".review-timeline")).toBeNull();
  });

  it("只有一步：显示它，且**不给折叠开关**（点了没有任何视觉变化的开关是纯噪声）", () => {
    render([step({ summary: "确定性检查 · 3 处" })]);
    expect(summaries()).toEqual(["确定性检查 · 3 处"]);
    expect(toggle()).toBeNull();
  });

  it("多步：默认折叠只显最新一步，展开后才全显", () => {
    render([
      step({ summary: "确定性检查 · 3 处", detail: "3 处漏译" }),
      step({ type: "semantic", status: "running", summary: "语义核查 · 第 1/2 批" }),
    ]);

    expect(summaries()).toEqual(["语义核查 · 第 1/2 批"]);
    const btn = toggle()!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    act(() => btn.click());
    expect(summaries()).toEqual(["确定性检查 · 3 处", "语义核查 · 第 1/2 批"]);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");

    // 再点收起
    act(() => toggle()!.click());
    expect(summaries()).toEqual(["语义核查 · 第 1/2 批"]);
  });

  it("状态 → 色调 走 data-tone（不在 JSX 里散写颜色）", () => {
    render([
      step({ status: "running", summary: "跑" }),
      step({ status: "failed", summary: "炸" }),
    ]);
    act(() => toggle()!.click()); // 展开才看得到两行
    expect(rows().map((r) => r.getAttribute("data-tone"))).toEqual(["busy", "bad"]);
  });

  it("tone 表对所有状态穷尽（加状态忘了配色会在这里红）", () => {
    expect(Object.keys(STEP_STATUS_TONE).sort()).toEqual([
      "done",
      "failed",
      "pending",
      "running",
      "skipped",
    ]);
  });
});
