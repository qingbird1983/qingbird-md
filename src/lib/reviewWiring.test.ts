// S4 #14 接线守卫：**Ctrl+J 的入口必须走 `ensureReviewPanelOpen`**。
//
// 为什么读源码而不是跑行为：这张执行体表是 App.tsx 里的模块级常量，不导出，
// 没有可断言的接缝；而"退化成直接 toggleReview()"这件事本身不会抛错 ——
// 它只会让落点偏一截（面板开完才量布局）。
// 与 hotkeyRegistry.test.ts 读 AppMenu.tsx 源码同款做法（项目惯例）。
//
// 本文件必须是 **node 环境**（默认）：happy-dom 下 `import.meta.url` 不是
// file: 协议，fileURLToPath 会抛 "The URL must be of scheme file"。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

/** 取 App.tsx 里那一项执行体的源码片段（从 `toggle_review:` 到下一个键 `bold:`）。 */
function toggleReviewBlock(): string {
  const src = read("../App.tsx");
  const start = src.indexOf("toggle_review:");
  const end = src.indexOf("bold:", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Ctrl+J / toggle_review 的接线", () => {
  it("开面板走 ensureReviewPanelOpen（不是直接 toggleReview）", () => {
    const block = toggleReviewBlock();
    expect(block).toContain("ensureReviewPanelOpen(");
    // 直接调 store 的 toggleReview 会跳过"等布局落定"这一步
    expect(block).not.toContain("toggleReview()");
  });

  it("开着时仍是收起（Ctrl+J 是开关，不是单向打开）", () => {
    expect(toggleReviewBlock()).toContain("setReviewOpen(false)");
  });

  it("打开后把 issue 清单滚进视野（消费点存在，revealReviewIssues 不是死代码）", () => {
    expect(toggleReviewBlock()).toContain("revealReviewIssues");
  });
});
