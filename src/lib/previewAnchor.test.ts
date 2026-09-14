// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { collectLineAnchors, lineStarts, sourceRangeForSelection } from "./previewAnchor";

describe("collectLineAnchors", () => {
  it("把 sl 注释与紧跟的块元素配对（块间换行文本节点跳过）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<!--sl:1--><h1 id="h-1">标题</h1>\n<!--sl:3--><p>段落</p>\n<!--sl:5--><ul><li>项</li></ul>\n`;
    const a = collectLineAnchors(el);
    expect(a.map((x) => x.line)).toEqual([1, 3, 5]);
    expect(a.map((x) => x.el.tagName)).toEqual(["H1", "P", "UL"]);
  });

  it("文末 footnotes 区无前置注释 → 不入表", () => {
    const el = document.createElement("div");
    el.innerHTML = `<!--sl:1--><p>正文</p>\n<section class="footnotes"><ol><li>定义</li></ol></section>\n`;
    const a = collectLineAnchors(el);
    expect(a).toHaveLength(1);
    expect(a[0]!.el.tagName).toBe("P");
  });

  it("非 sl 注释不误配（也不会把它后面的元素吞掉）", () => {
    const el = document.createElement("div");
    el.innerHTML = `<!--about--><p>甲</p><!--sl:2--><p>乙</p>`;
    const a = collectLineAnchors(el);
    expect(a.map((x) => x.line)).toEqual([2]);
    expect(a[0]!.el.textContent).toBe("乙");
  });

  it("无注释（老渲染产物）返回空表，不抛", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p>甲</p><p>乙</p>`;
    expect(collectLineAnchors(el)).toEqual([]);
  });
});

describe("lineStarts", () => {
  it("逐行起始偏移", () => {
    expect(lineStarts("a\nbb\nccc")).toEqual([0, 2, 5]);
    expect(lineStarts("")).toEqual([0]);
  });
});

describe("sourceRangeForSelection", () => {
  const src = [
    "# 标题", // 1
    "", // 2
    "第一段正文。", // 3
    "", // 4
    "Hello **world** of markdown.", // 5
    "", // 6
    "软换行", // 7
    "折成两行的句子。", // 8
  ].join("\n");

  it("纯文本精确命中，只选中的那一段", () => {
    // 第 3 行是段落，下一顶层块在第 5 行
    const r = sourceRangeForSelection(src, 3, 5, "正文");
    expect(src.slice(r![0], r![1])).toBe("正文");
  });

  it("选区被软换行折断 → 用 \\s+ 相连救回", () => {
    const r = sourceRangeForSelection(src, 7, null, "软换行 折成两行");
    expect(src.slice(r![0], r![1])).toBe("软换行\n折成两行");
  });

  it("选区跨了行内标记 → 退回整块（不把光标丢到别处）", () => {
    const r = sourceRangeForSelection(src, 5, 7, "Hello world of markdown.");
    expect(src.slice(r![0], r![1])).toBe("Hello **world** of markdown.");
  });

  it("空选区/纯空白 → 退回整块", () => {
    const r = sourceRangeForSelection(src, 3, 5, "   ");
    expect(src.slice(r![0], r![1])).toBe("第一段正文。");
  });

  it("只在块范围内找：同样的字出现在别处不会被误选", () => {
    const dup = "甲\n\n共\n\n乙\n\n共\n";
    const r = sourceRangeForSelection(dup, 5, null, "共");
    expect(r![0]).toBe(dup.lastIndexOf("共"));
  });

  it("最后一个块 toLine=null 取到文末；行号越界返回 null", () => {
    const r = sourceRangeForSelection(src, 7, null, "折成两行的句子。");
    expect(src.slice(r![0], r![1])).toBe("折成两行的句子。");
    expect(r![1]).toBe(src.length); // 末块一直管到内容末尾
    // 只选中末句的一部分时，结尾不该被撑到文末
    const part = sourceRangeForSelection(src, 7, null, "句子");
    expect(src.slice(part![0], part![1])).toBe("句子");
    expect(sourceRangeForSelection(src, 0, 1, "x")).toBeNull();
    expect(sourceRangeForSelection(src, 99, null, "x")).toBeNull();
  });

  it("正则元字符按字面处理（不抛也不误匹配）", () => {
    const md = "价格是 3.5*(1+2) 元。";
    const r = sourceRangeForSelection(md, 1, null, "3.5*(1+2)");
    expect(md.slice(r![0], r![1])).toBe("3.5*(1+2)");
  });
});
