// @vitest-environment happy-dom
// S4 #16 守卫：issue 跳转的「三步顺序」与「非 actionable 态」。
//
// 为什么必须钉住这几条（都是"旧代码会变红"的形态）：
// 1. 顺序错 → 观感是「跳过去又被拽回来」。断言 `lockSplitSide("preview")` 真的
//    先于 `scrollIntoView` 生效（跳完 preview 仍处于锁窗内），而不是"看结果对就行"。
// 2. `behavior` 必须是 `auto`：`smooth` 要跑 300ms 上下，早就冲出 180ms 锁窗，
//    中途的 scroll 事件照样外发 —— 这正是锁窗要拦的东西。
// 3. 跳不动时必须**返回原因**而不是静默：面板要把卡片画成禁用态并写明为什么。
//    旧实现"查不到就 return"在这里会变红（拿到 undefined 而非 reason）。
// 4. 渲染期探测与点击期探测**必须同源**：否则会出现"画着能点、点了没反应"。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../types/ipc";
import {
  ISSUE_FLASH_CLASS,
  findIssueAnchor,
  flashIssueTarget,
  jumpBlockReason,
  jumpFailureHint,
  jumpToIssue,
  previewScrollEl,
  probeIssueAnchor,
} from "./reviewJump";
import { resetSplitSync, splitSyncLocked, subscribeSplitSync } from "./splitSync";

const mkIssue = (over: Partial<Issue> = {}): Issue => ({
  run: 7,
  kind: "OmittedUntranslated",
  severity: "Warning",
  src_excerpt: "Hello world",
  dst_excerpt: "",
  ...over,
});

/** happy-dom 不保证实现 scrollIntoView；换成 spy，同时拿到"调用参数"这个证据。 */
const scrollIntoView = vi.fn();

function mountPreview(inner: string): void {
  document.body.innerHTML = `<div class="preview-scroll"><div class="markdown-body">${inner}</div></div>`;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetSplitSync();
  scrollIntoView.mockClear();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
});

describe("previewScrollEl / findIssueAnchor", () => {
  it("没有 .preview-scroll（源码单栏）时返回 null", () => {
    document.body.innerHTML = `<div class="markdown-body"><p data-ri="7">x</p></div>`;
    expect(previewScrollEl()).toBeNull();
  });

  it("锚点优先 data-ri（run 空间），回退 data-bi（块空间）", () => {
    mountPreview(`<p data-bi="7">bi</p><p data-ri="7">ri</p>`);
    const scroll = previewScrollEl()!;
    expect(findIssueAnchor(scroll, 7)!.textContent).toBe("ri");

    mountPreview(`<p data-bi="7">bi</p>`);
    expect(findIssueAnchor(previewScrollEl()!, 7)!.textContent).toBe("bi");

    mountPreview(`<p data-ri="8">其它 run</p>`);
    expect(findIssueAnchor(previewScrollEl()!, 7)).toBeNull();
  });
});

describe("jumpToIssue 的失败分支（非 actionable）", () => {
  it("预览未挂载 → reason=preview-hidden，且不碰分栏联动总线", () => {
    document.body.innerHTML = `<div class="markdown-body"><p data-ri="7">x</p></div>`;
    const editorSeen: number[] = [];
    subscribeSplitSync("editor", (l) => editorSeen.push(l));

    const res = jumpToIssue(mkIssue());

    expect(res).toEqual({ ok: false, reason: "preview-hidden" });
    // 跳不成就不该留下锁：否则 180ms 内编辑器自己的滚动会被静默吞掉。
    expect(splitSyncLocked("preview")).toBe(false);
    expect(editorSeen).toEqual([]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("锚点缺失 → reason=anchor-missing（不是静默 return）", () => {
    mountPreview(`<p data-ri="1">别的块</p>`);
    const res = jumpToIssue(mkIssue({ run: 7 }));
    expect(res).toEqual({ ok: false, reason: "anchor-missing" });
    expect(splitSyncLocked("preview")).toBe(false);
  });

  it("渲染期探测与点击期探测同源（不会「画着能点、点了没反应」）", () => {
    mountPreview(`<p data-ri="1">别的块</p>`);
    const issue = mkIssue({ run: 7 });
    const atRender = jumpBlockReason(issue);
    const atClick = jumpToIssue(issue);
    expect(atRender).toBe("anchor-missing");
    expect(atClick.ok).toBe(false);
    expect(atClick.ok ? null : atClick.reason).toBe(atRender);

    // 反过来：锚点在时两处都必须判"可跳"。
    mountPreview(`<p data-ri="7">命中</p>`);
    expect(jumpBlockReason(issue)).toBeNull();
    expect(probeIssueAnchor(issue).ok).toBe(true);
  });

  it("两种原因都有可读措辞（非 actionable 态不能只画灰不说原因）", () => {
    for (const reason of ["preview-hidden", "anchor-missing"] as const) {
      expect(jumpFailureHint(reason).length).toBeGreaterThan(6);
    }
    expect(jumpFailureHint("preview-hidden")).not.toBe(jumpFailureHint("anchor-missing"));
  });
});

describe("jumpToIssue 的成功路径：锁窗 → 滚动", () => {
  it("先给预览上锁、再滚动；不再向分栏总线推坐标（P2-4 删恒 0 的 src_line）", () => {
    mountPreview(`<p data-ri="7">命中</p>`);
    const editorSeen: number[] = [];
    const previewSeen: number[] = [];
    subscribeSplitSync("editor", (l) => editorSeen.push(l));
    subscribeSplitSync("preview", (l) => previewSeen.push(l));

    const res = jumpToIssue(mkIssue({ run: 7 }));

    expect(res.ok).toBe(true);
    // ② 落点滚动参数：behavior 必须 auto（smooth 会冲出 180ms 锁窗）
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0]![0]).toMatchObject({ behavior: "auto", block: "center" });
    // ① 预览仍处锁窗内 —— 证明 lockSplitSide("preview") 确实生效过
    expect(splitSyncLocked("preview")).toBe(true);
    // ③ 历史行为是向编辑器推恒 0 的 src_line（无信息量）；字段删除后总线全静默
    expect(editorSeen).toEqual([]);
    expect(previewSeen).toEqual([]);
  });

  it("落点高亮是纯装饰：只加 class，不动正文", () => {
    mountPreview(`<p data-ri="7">命中</p>`);
    const target = previewScrollEl()!.querySelector<HTMLElement>('[data-ri="7"]')!;
    const before = target.innerHTML;

    const res = jumpToIssue(mkIssue({ run: 7 }));

    expect(res.ok && res.target).toBe(target);
    expect(target.classList.contains(ISSUE_FLASH_CLASS)).toBe(true);
    // 核心不变量：装饰性改动**永不写回 content**
    expect(target.innerHTML).toBe(before);
    expect(target.textContent).toBe("命中");
  });

  it("高亮会自己退场（并在提前清除时不留残影）", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("p");
      document.body.appendChild(el);
      const clear = flashIssueTarget(el, 1000);
      expect(el.classList.contains(ISSUE_FLASH_CLASS)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(el.classList.contains(ISSUE_FLASH_CLASS)).toBe(false);

      // 提前清除：定时器再走也不该复活
      const clear2 = flashIssueTarget(el, 1000);
      clear2();
      expect(el.classList.contains(ISSUE_FLASH_CLASS)).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(el.classList.contains(ISSUE_FLASH_CLASS)).toBe(false);
      clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flash:false 时不加高亮（供「只滚不闪」的调用方用）", () => {
    mountPreview(`<p data-ri="7">命中</p>`);
    const target = previewScrollEl()!.querySelector<HTMLElement>('[data-ri="7"]')!;
    jumpToIssue(mkIssue({ run: 7 }), { flash: false });
    expect(target.classList.contains(ISSUE_FLASH_CLASS)).toBe(false);
  });
});
