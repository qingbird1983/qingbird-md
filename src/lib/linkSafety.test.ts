// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyPreviewHref,
  handlePreviewLinkClick,
  scrollToPreviewAnchor,
} from "./linkSafety";

describe("classifyPreviewHref", () => {
  it("http/https/mailto/tel 判 external", () => {
    expect(classifyPreviewHref("https://gitee.com/muyan1983/qingbird-md")).toBe("external");
    expect(classifyPreviewHref("http://a.b/c?x=1#y")).toBe("external");
    expect(classifyPreviewHref("mailto:a@b.c")).toBe("external");
    expect(classifyPreviewHref("tel:+8613800000000")).toBe("external");
    expect(classifyPreviewHref("  HTTP://UP.CASE/x  ")).toBe("external"); // 大小写与首尾空白
  });

  it("# 锚点与空 href 判 anchor", () => {
    expect(classifyPreviewHref("#h-1")).toBe("anchor");
    expect(classifyPreviewHref("#")).toBe("anchor");
    expect(classifyPreviewHref("")).toBe("anchor");
    expect(classifyPreviewHref("   ")).toBe("anchor");
  });

  it("危险/未知协议与相对路径一律 block", () => {
    expect(classifyPreviewHref("javascript:alert(1)")).toBe("block");
    expect(classifyPreviewHref("data:text/html,<b>x</b>")).toBe("block");
    expect(classifyPreviewHref("vbscript:msgbox(1)")).toBe("block");
    expect(classifyPreviewHref("file:///C:/x")).toBe("block"); // 本地文件不通过页面打开
    expect(classifyPreviewHref("docs/a.md")).toBe("block"); // 相对路径
    expect(classifyPreviewHref("//evil.com/x")).toBe("block"); // 协议相对 URL
  });
});

describe("scrollToPreviewAnchor", () => {
  beforeEach(() => {
    // happy-dom 无平滑滚动实现；stub 只验证调用与定位
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("命中 id 时滚动并返回 true", () => {
    const scope = document.createElement("div");
    scope.innerHTML = `<h1 id="h-1">Ti</h1>`;
    expect(scrollToPreviewAnchor(scope, "h-1")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("找不到目标返回 false，不抛错", () => {
    const scope = document.createElement("div");
    scope.innerHTML = `<p>x</p>`;
    expect(scrollToPreviewAnchor(scope, "no-such")).toBe(false);
  });

  it("id 含引号/反斜杠也能命中（属性值全等，无 selector 注入）", () => {
    const scope = document.createElement("div");
    scope.innerHTML = `<h1 id='a"b\\c'>x</h1>`;
    expect(scrollToPreviewAnchor(scope, 'a"b\\c')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("handlePreviewLinkClick（document capture 真实派发）", () => {
  let scope: HTMLElement;
  let open: (url: string) => void;

  // 命名 handler：beforeEach/afterEach 用同一引用挂/卸，避免监听器累积
  function onClick(e: MouseEvent) {
    handlePreviewLinkClick(e, scope, open);
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    scope = document.createElement("div");
    scope.id = "scope";
    document.body.appendChild(scope);
    open = vi.fn<(url: string) => void>();
    document.addEventListener("click", onClick, true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    document.removeEventListener("click", onClick, true);
    document.body.innerHTML = "";
  });

  /** 在 scope 内插入内容并点击其中第一个 a[href]，返回事件默认行为是否被拦。 */
  function clickAnchor(html: string): boolean {
    scope.innerHTML = html;
    const a = scope.querySelector<HTMLAnchorElement>("a[href]")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("外部链接：preventDefault 且调 open（走系统浏览器，绝不整窗导航）", () => {
    const prevented = clickAnchor(
      `<p><a href="https://example.com/x" target="_blank">官网</a></p>`,
    );
    expect(prevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://example.com/x");
  });

  it("mailto 同样走 open", () => {
    clickAnchor(`<a href="mailto:hi@example.com">写信</a>`);
    expect(open).toHaveBeenCalledWith("mailto:hi@example.com");
  });

  it("javascript: 危险链接：preventDefault 且不调 open（不执行、不导航）", () => {
    const prevented = clickAnchor(`<a href="javascript:alert(1)">x</a>`);
    expect(prevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("相对路径：吞掉点击，不调 open（预览无路由概念）", () => {
    const prevented = clickAnchor(`<a href="docs/a.md">x</a>`);
    expect(prevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("# 锚点：preventDefault 并滚动到目标，不调 open", () => {
    const prevented = clickAnchor(`<h1 id="h-1">Ti</h1><a href="#h-1">回顶</a>`);
    expect(prevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("容器外的链接不干预（默认行为保留）", () => {
    const outside = document.createElement("a");
    outside.href = "https://example.com";
    document.body.appendChild(outside);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
