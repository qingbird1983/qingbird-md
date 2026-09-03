// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { patchPartial } from "../lib/patchPartial";

describe("patchPartial", () => {
  it("bilingual：锚点后已有 tr-box → 更新文本而非跳过（重跑路径不吞流）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="0">原文</p><div class="tr-box">旧译文</div>`;
    patchPartial(el, "bilingual", 0, "新译文");
    const boxes = el.querySelectorAll(".tr-box");
    expect(boxes.length).toBe(1); // 更新，不新增
    expect(boxes[0].textContent).toBe("新译文");
  });

  it("bilingual：无 tr-box → 在锚点后插入", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p data-bi="1">原文</p>`;
    patchPartial(el, "bilingual", 1, "译文");
    const box = el.querySelector('[data-bi="1"]')!.nextElementSibling!;
    expect(box.className).toBe("tr-box");
    expect(box.textContent).toBe("译文");
  });

  it("translation：run.textContent 直接覆盖", () => {
    const el = document.createElement("div");
    el.innerHTML = `<span data-ri="0">hello</span>`;
    patchPartial(el, "translation", 0, "你好");
    expect(el.querySelector('[data-ri="0"]')!.textContent).toBe("你好");
  });

  it("锚点缺失静默跳过", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p>无锚点</p>`;
    expect(() => patchPartial(el, "bilingual", 9, "x")).not.toThrow();
    expect(() => patchPartial(el, "translation", 9, "x")).not.toThrow();
    expect(el.querySelector(".tr-box")).toBeNull();
  });
});
