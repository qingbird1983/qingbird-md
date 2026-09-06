import { describe, expect, it } from "vitest";
import { typewriterPush, typewriterStart } from "./typewriter";

describe("typewriterPush", () => {
  it("顺序到达立即逐块放行", () => {
    let s = typewriterStart([0, 1, 2]);
    for (const [i, txt] of ["甲", "乙", "丙"].entries()) {
      const r = typewriterPush(s, i, txt, false);
      s = r.state;
      expect(r.released).toEqual([{ index: i, text: txt, fromCache: false }]);
    }
    expect(s.pos).toBe(3);
    expect(s.pending.size).toBe(0);
  });

  it("乱序到达先缓冲，缺口填上后连续放行", () => {
    let s = typewriterStart([0, 1, 2]);
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
    expect(s.pos).toBe(3);
  });

  it("index 0 迟到时全部卡住等位（严格文档序的代价，done 事件兜底）", () => {
    let s = typewriterStart([0, 1]);
    const r = typewriterPush(s, 1, "乙", false);
    s = r.state;
    expect(r.released).toEqual([]);
    expect(s.pos).toBe(0);
    expect(s.pending.get(1)).toEqual({ index: 1, text: "乙", fromCache: false });
  });

  it("放行后 pending 中同序号条目被删除，不重复放行", () => {
    let s = typewriterStart([0, 1]);
    s = typewriterPush(s, 0, "甲", false).state;
    s = typewriterPush(s, 1, "乙", false).state;
    const again = typewriterPush(s, 1, "乙", false); // 引擎不会重复 emit；防御性用例
    expect(again.released).toEqual([]); // pos 已过 1，重复条目留在 pending 不放行
    expect(again.state.pos).toBe(2);
  });
});

describe("窗口化基址", () => {
  it("放行序列不从 0 起，乱序到达按序放行", () => {
    let s = typewriterStart([37, 38]);
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

describe("缺口序列放行（终审 C1 回归）", () => {
  it("seq=[1,3,5] 乱序到达：缺口不再永久停摆，按文档序渐进放行", () => {
    // 窗口化收集的真实形态：needs_translation 跳过中文/数字/符号块后，窗口内
    // 收集索引形如 [1,3,5]。旧 scalar 游标放行 1 后卡在缺口 2，后到的 3/5
    // 永卡 pending，只能等 done 兜底（≥400ms + 整树重渲）——本用例锚定修复。
    let s = typewriterStart([1, 3, 5]);
    // 5 先到（乱序）：等位，不放行
    const r5 = typewriterPush(s, 5, "戊", false);
    s = r5.state;
    expect(r5.released).toEqual([]);
    // 1 到：放行 1（前方 3 缺——缺口不误卡后续放行）
    const r1 = typewriterPush(s, 1, "甲", false);
    s = r1.state;
    expect(r1.released).toEqual([{ index: 1, text: "甲", fromCache: false }]);
    expect(s.pos).toBe(1);
    // 3 到：放行 3 并连带等位中的 5（旧游标在此处放行 0 个——C1 停摆点）
    const r3 = typewriterPush(s, 3, "丙", false);
    s = r3.state;
    expect(r3.released.map((r) => [r.index, r.text])).toEqual([
      [3, "丙"],
      [5, "戊"],
    ]);
    expect(s.pos).toBe(3);
    expect(s.pending.size).toBe(0);
  });

  it("已缓冲满员的乱序到达一次性按文档序级联放行", () => {
    // 3、5 先等位，1 压轴到：一波按文档序全放（放行批次内保持文档序）。
    let s = typewriterStart([1, 3, 5]);
    s = typewriterPush(s, 3, "丙", false).state;
    s = typewriterPush(s, 5, "戊", false).state;
    const r = typewriterPush(s, 1, "甲", false);
    expect(r.released.map((r2) => r2.index)).toEqual([1, 3, 5]);
    expect(r.state.pos).toBe(3);
    expect(r.state.pending.size).toBe(0);
  });

  it("序列外条目滞留 pending 不放行（bounded，重置时清）", () => {
    // 防御性：不在本轮收集序列里的 partial（理论上引擎不会发）只等位、
    // 不推进 pos，也不阻塞序列内条目的放行。
    let s = typewriterStart([1, 3]);
    const r99 = typewriterPush(s, 99, "序外", false);
    s = r99.state;
    expect(r99.released).toEqual([]);
    expect(s.pending.get(99)).toEqual({ index: 99, text: "序外", fromCache: false });
    expect(s.pos).toBe(0);
    // 序列内条目照常放行，序外条目留在 pending
    const r1 = typewriterPush(s, 1, "甲", false);
    s = r1.state;
    expect(r1.released).toEqual([{ index: 1, text: "甲", fromCache: false }]);
    expect(s.pending.has(99)).toBe(true);
  });

  it("空序列（clearAll/stop 重置形态）不放行任何条目", () => {
    const s0 = typewriterStart();
    const r = typewriterPush(s0, 0, "甲", false);
    expect(r.released).toEqual([]);
    expect(r.state.pos).toBe(0);
  });
});
