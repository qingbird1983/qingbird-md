// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { codeTextFrom } from "./codeText";

const codeOf = (inner: string): HTMLElement => {
  const box = document.createElement("div");
  box.innerHTML = `<pre class="code-block"><code>${inner}</code></pre>`;
  return box.querySelector("code")!;
};

describe("codeTextFrom：一键复制必须排除行号", () => {
  it("只收 .lc 列，行号 .ln 不进结果", () => {
    const code = codeOf(
      '<span class="cl"><span class="ln">1</span><span class="lc">fn a() {}\n</span></span>' +
        '<span class="cl"><span class="ln">2</span><span class="lc">fn b() {}</span></span>',
    );
    expect(codeTextFrom(code)).toBe("fn a() {}\nfn b() {}");
    // 反例锚点：直接读 textContent 会带行号——这条断言是本次修复的动因。
    expect(code.textContent).toBe("1fn a() {}\n2fn b() {}");
  });

  it("高亮 token 的嵌套 span 原样保留", () => {
    const code = codeOf(
      '<span class="cl"><span class="ln">1</span>' +
        '<span class="lc"><span style="--cl:#ff0000">let</span> x = 1;\n</span></span>',
    );
    expect(codeTextFrom(code)).toBe("let x = 1;\n");
  });

  it("三位数行号（--ln-digits=3）也只取内容列", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      `<span class="cl"><span class="ln">${i + 1}</span><span class="lc">L${i + 1}${i < 11 ? "\n" : ""}</span></span>`,
    ).join("");
    const out = codeTextFrom(codeOf(rows));
    expect(out.startsWith("L1\nL2\n")).toBe(true);
    expect(out.endsWith("L12")).toBe(true);
    expect(out).not.toContain("10L10");
    expect(out.split("\n")).toHaveLength(12);
  });

  it("无 .lc 结构兜底回退 textContent", () => {
    expect(codeTextFrom(codeOf("plain text"))).toBe("plain text");
  });

  it("空代码块返回空串", () => {
    expect(codeTextFrom(codeOf(""))).toBe("");
  });
});
