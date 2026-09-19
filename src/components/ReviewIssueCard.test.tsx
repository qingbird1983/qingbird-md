// @vitest-environment happy-dom
// S4 #16 守卫：issue 卡片的**非 actionable 态**。
//
// 这是本项唯一"必须含"的形态要求，也是最容易被简化掉的一条：
// 跳不动时**禁用跳转、并把原因说出来**，而不是把卡片隐藏掉。
// 隐藏会让「N 处问题」和「列出 M 条」对不上，看着像面板漏报。
// 所以下面的断言同时检查两件事：按钮确实禁用 **且** 卡片仍在 DOM 里、**且** 有原因文案。
//
// 另一条：`blockReason` 是**渲染期快照**，点下去时 DOM 可能已经变了
// （切模式 / 面板收起 / 重解析）。那时也必须出文案，不能静默无反应。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReviewIssueCard from "./ReviewIssueCard";
import { resetSplitSync, subscribeSplitSync } from "../lib/splitSync";
import type { Issue } from "../types/ipc";

const mkIssue = (over: Partial<Issue> = {}): Issue => ({
  run: 7,
  kind: "OmittedUntranslated",
  severity: "Warning",
  src_excerpt: "Hello world",
  dst_excerpt: "",
  src_line: 12,
  dst_line: 14,
  ...over,
});

const scrollIntoView = vi.fn();

let host: HTMLDivElement;
let root: Root;

const mountPreview = (present: boolean, anchor = true) => {
  const body = anchor ? `<p data-ri="7">命中</p>` : `<p data-ri="1">别的块</p>`;
  document.body.innerHTML = present
    ? `<div class="preview-scroll"><div class="markdown-body">${body}</div></div>`
    : `<div class="markdown-body">${body}</div>`;
  // preview 的 DOM 由上面 innerHTML 重建，host 要重新挂回去
  document.body.appendChild(host);
};

const render = (blockReason: "preview-hidden" | "anchor-missing" | null) =>
  act(() => {
    root.render(
      <ul>
        <ReviewIssueCard issue={mkIssue()} seq={1} blockReason={blockReason} />
      </ul>,
    );
  });

const btn = () => host.querySelector<HTMLButtonElement>(".review-issue-hit")!;
const hint = () => host.querySelector(".review-issue-hint")?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  scrollIntoView.mockClear();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
  resetSplitSync();
  host = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("可跳转态", () => {
  beforeEach(() => mountPreview(true));

  it("渲染类别标签 + 行号区间 + 摘录，且不带提示文案", () => {
    render(null);
    expect(btn().textContent).toContain("漏译");
    expect(btn().textContent).toContain("L12 → L14");
    expect(btn().textContent).toContain("Hello world");
    expect(btn().disabled).toBe(false);
    expect(hint()).toBeNull();
    expect(host.querySelector(".review-issue")!.classList.contains("blocked")).toBe(false);
  });

  it("点一下：预览滚到落点、行号推给编辑器、卡片自身不出现提示", () => {
    const seen: number[] = [];
    subscribeSplitSync("editor", (l) => seen.push(l));
    render(null);

    act(() => btn().click());

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([12]);
    expect(btn().classList.contains("issue-flash")).toBe(false); // 高亮落在预览块上，不在卡片上
    expect(hint()).toBeNull();
  });
});

describe("非 actionable 态（必须禁用而不是隐藏）", () => {
  it("预览未挂载：按钮禁用、卡片仍在、写明原因", () => {
    mountPreview(false);
    render("preview-hidden");

    expect(btn().disabled).toBe(true);
    // 卡片**没有被隐藏** —— 这是"漏报"错觉的防线
    expect(host.querySelectorAll(".review-issue").length).toBe(1);
    expect(hint()).toBe("当前是源码视图，切到分栏或预览后即可跳转");
    expect(btn().title).toBe(hint());
  });

  it("锚点缺失：禁用 + 另一套措辞（不能两种原因说同一句话）", () => {
    mountPreview(true, false);
    render("anchor-missing");

    expect(btn().disabled).toBe(true);
    expect(hint()).toBe("这一条在正文里找不到对应锚点（可能来自不可译块或旧渲染产物）");
  });

  it("禁用的按钮点不动，也不会留下分栏锁", () => {
    mountPreview(false);
    render("preview-hidden");
    act(() => btn().click());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("渲染后 DOM 变了（快照过期）", () => {
  it("渲染时判为可跳、点下去时预览已经不在 → 仍要出原因，不能静默", () => {
    mountPreview(false); // 没有 .preview-scroll
    render(null); // 但快照说"可跳"

    expect(btn().disabled).toBe(false);
    expect(hint()).toBeNull();

    act(() => btn().click());

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(hint()).toBe("当前是源码视图，切到分栏或预览后即可跳转");
  });

  it("点成功后会把上一次的过期提示清掉", () => {
    mountPreview(false);
    render(null);
    act(() => btn().click());
    expect(hint()).not.toBeNull();

    // 预览回来了，再点一次
    mountPreview(true);
    act(() => btn().click());
    expect(hint()).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
