// @vitest-environment happy-dom
//
// P0-2 的守卫测试：**锚点缺失必须留下痕迹**。
// 这些用例在旧实现（三处 `if (!host) return` 静默跳过）下必然变红——
// 那正是这条技术债的症状："翻译没反应，且无迹可查"。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockTypingHost, patchPartial, setStreamingFlag, unlockTypingHost } from "./patchPartial";

describe("patchPartial（流式回填 + P0-2 锚点缺失日志）", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const lastWarn = () => String(warn.mock.calls.at(-1)?.[0] ?? "");

  it("bilingual：锚点存在 → 源块后插入 tr-box，不打日志", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="3">源文</p>`;

    patchPartial(el, "bilingual", 3, "译文");

    expect(el.querySelector(".tr-box")?.textContent).toBe("译文");
    expect(warn).not.toHaveBeenCalled();
  });

  it("bilingual：锚点缺失 → 打日志并跳过（P0-2，不再静默）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="3">源文</p>`;

    patchPartial(el, "bilingual", 9, "译文");

    expect(el.querySelector(".tr-box")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastWarn()).toContain("patchPartial/bilingual");
    expect(lastWarn()).toContain("index=9");
    expect(lastWarn()).toContain('[data-bi="9"]');
  });

  it("bilingual：已有 tr-box → 更新文本，不新插一个（否则整条 partial 流被吞）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="1">源</p><div class="tr-box">旧译文</div>`;

    patchPartial(el, "bilingual", 1, "新译文");

    expect(el.querySelectorAll(".tr-box")).toHaveLength(1);
    expect(el.querySelector(".tr-box")?.textContent).toBe("新译文");
    expect(warn).not.toHaveBeenCalled();
  });

  it("translation：锚点存在 → 改写 run 文本", () => {
    const el = document.createElement("div");
    el.innerHTML = `<span data-ri="0">Hello</span>`;

    patchPartial(el, "translation", 0, "你好");

    expect(el.textContent).toBe("你好");
    expect(warn).not.toHaveBeenCalled();
  });

  it("translation：锚点缺失 → 打日志（指出的是 data-ri run 空间）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p>纯文本，无 run 锚点</p>`;

    patchPartial(el, "translation", 2, "译文");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastWarn()).toContain("patchPartial/translation");
    expect(lastWarn()).toContain('[data-ri="2"]');
  });

  it("setStreamingFlag：锚点缺失同样记日志（不再是哑失败）", () => {
    const el = document.createElement("div");

    setStreamingFlag(el, "translation", 5, true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastWarn()).toContain("setStreamingFlag");
    expect(lastWarn()).toContain('[data-ri="5"]');
  });

  it("setStreamingFlag：bilingual 作用于 tr-box，正常路径不打日志", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="0">源</p><div class="tr-box">译</div>`;

    setStreamingFlag(el, "bilingual", 0, true);
    expect(el.querySelector(".tr-box")?.classList.contains("tr-streaming")).toBe(true);

    setStreamingFlag(el, "bilingual", 0, false);
    expect(el.querySelector(".tr-box")?.classList.contains("tr-streaming")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lockTypingHost：锚点缺失 → 返回 null 并记日志", () => {
    const el = document.createElement("div");

    expect(lockTypingHost(el, "bilingual", 7)).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastWarn()).toContain("lockTypingHost");
    expect(lastWarn()).toContain('[data-bi="7"]');
  });

  it("lockTypingHost：translation 模式本就不锁定，且不该报锚点缺失（设计如此）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<span data-ri="0">x</span>`;

    expect(lockTypingHost(el, "translation", 0)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("unlockTypingHost：清掉 min-height；传 null 安全", () => {
    const box = document.createElement("div");
    box.style.minHeight = "42px";

    unlockTypingHost(box);
    expect(box.style.minHeight).toBe("");

    expect(() => unlockTypingHost(null)).not.toThrow();
  });
});
