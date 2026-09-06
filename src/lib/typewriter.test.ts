import { describe, expect, it } from "vitest";
import { typewriterPush, typewriterStart } from "./typewriter";

describe("typewriterPush", () => {
  it("顺序到达立即逐块放行", () => {
    let s = typewriterStart();
    for (const [i, txt] of ["甲", "乙", "丙"].entries()) {
      const r = typewriterPush(s, i, txt, false);
      s = r.state;
      expect(r.released).toEqual([{ index: i, text: txt, fromCache: false }]);
    }
    expect(s.cursor).toBe(3);
    expect(s.pending.size).toBe(0);
  });

  it("乱序到达先缓冲，缺口填上后连续放行", () => {
    let s = typewriterStart();
    // 2 先到：等位，不放行
    const r2 = typewriterPush(s, 2, "丙", false);
    s = r2.state;
    expect(r2.released).toEqual([]);
    // 0 到：只放行 0（1 仍缺）
    const r0 = typewriterPush(s, 0, "甲", false);
    s = r0.state;
    expect(r0.released).toEqual([{ index: 0, text: "甲", fromCache: false }]);
    // 1 到：放行 1、2（连带等位中的 2）
    const r1 = typewriterPush(s, 1, "乙", false);
    s = r1.state;
    expect(r1.released).toEqual([
      { index: 1, text: "乙", fromCache: false },
      { index: 2, text: "丙", fromCache: false },
    ]);
    expect(s.cursor).toBe(3);
  });

  it("index 0 迟到时全部卡住等位（严格文档序的代价，done 事件兜底）", () => {
    let s = typewriterStart();
    const r = typewriterPush(s, 1, "乙", false);
    s = r.state;
    expect(r.released).toEqual([]);
    expect(s.cursor).toBe(0);
    expect(s.pending.get(1)).toEqual({ index: 1, text: "乙", fromCache: false });
  });

  it("放行后 pending 中同序号条目被删除，不重复放行", () => {
    let s = typewriterStart();
    s = typewriterPush(s, 0, "甲", false).state;
    s = typewriterPush(s, 1, "乙", false).state;
    const again = typewriterPush(s, 1, "乙", false); // 引擎不会重复 emit；防御性用例
    expect(again.released).toEqual([]); // cursor 已过 1，重复条目留在 pending 不放行
    expect(again.state.cursor).toBe(2);
  });
});

describe("窗口化基址", () => {
  it("cursor 从 base 起算，乱序到达按序放行", () => {
    let s = typewriterStart(37);
    const r1 = typewriterPush(s, 38, "乙", false);
    expect(r1.released).toHaveLength(0);
    s = r1.state;
    const r2 = typewriterPush(s, 37, "甲", true);
    expect(r2.released.map((r) => [r.index, r.text, r.fromCache])).toEqual([
      [37, "甲", true],
      [38, "乙", false],
    ]);
  });
});
