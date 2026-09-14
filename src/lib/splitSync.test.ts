// 分栏同步总线的纯逻辑单测（无 DOM）。emit/锁的时间用注入的 now，测试可控。
import { describe, expect, it, beforeEach } from "vitest";
import {
  SPLIT_SYNC_LOCK_MS,
  anchorIndexForLine,
  anchorIndexForTop,
  emitSplitSync,
  lockSplitSide,
  resetSplitSync,
  splitSyncLocked,
  subscribeSplitSync,
  type SplitAnchor,
} from "./splitSync";

describe("splitSync", () => {
  beforeEach(resetSplitSync);

  it("把行号推给对侧，并锁住对侧防止回环", () => {
    const got: number[] = [];
    subscribeSplitSync("preview", (l) => got.push(l));
    emitSplitSync("editor", 12, 1000);
    expect(got).toEqual([12]);
    // 对侧（预览）被锁：它自己的 scroll 不该外发
    expect(splitSyncLocked("preview", 1000)).toBe(true);
    expect(splitSyncLocked("preview", 1000 + SPLIT_SYNC_LOCK_MS - 1)).toBe(true);
    expect(splitSyncLocked("preview", 1000 + SPLIT_SYNC_LOCK_MS)).toBe(false);
    // 发起侧不上锁：用户马上滚编辑器仍要生效
    expect(splitSyncLocked("editor", 1000)).toBe(false);
  });

  it("反方向对称", () => {
    const got: number[] = [];
    subscribeSplitSync("editor", (l) => got.push(l));
    emitSplitSync("preview", 7, 500);
    expect(got).toEqual([7]);
    expect(splitSyncLocked("editor", 500)).toBe(true);
    expect(splitSyncLocked("preview", 500)).toBe(false);
  });

  it("非法行号不外发（不锁、不通知）", () => {
    const got: number[] = [];
    subscribeSplitSync("preview", (l) => got.push(l));
    emitSplitSync("editor", 0, 0);
    emitSplitSync("editor", -3, 0);
    emitSplitSync("editor", Number.NaN, 0);
    expect(got).toEqual([]);
    expect(splitSyncLocked("preview", 0)).toBe(false);
  });

  it("退订后不再收到通知", () => {
    const got: number[] = [];
    const off = subscribeSplitSync("preview", (l) => got.push(l));
    emitSplitSync("editor", 3, 0);
    off();
    emitSplitSync("editor", 4, 0);
    expect(got).toEqual([3]);
  });

  it("lockSplitSide 只锁指定一侧（选区同步用）", () => {
    lockSplitSide("editor", 10);
    expect(splitSyncLocked("editor", 10)).toBe(true);
    expect(splitSyncLocked("preview", 10)).toBe(false);
  });
});

describe("splitSync 锚点查找", () => {
  // 行号与顶边都单调递增（DOM 顺序 = 文档顺序）
  const anchors: SplitAnchor[] = [
    { line: 1, top: 0 },
    { line: 5, top: 120 },
    { line: 9, top: 400 },
    { line: 20, top: 900 },
  ];

  it("行号取「起始行不超过 line 的最后一个块」", () => {
    expect(anchorIndexForLine(anchors, 1)).toBe(0);
    expect(anchorIndexForLine(anchors, 4)).toBe(0);
    expect(anchorIndexForLine(anchors, 5)).toBe(1);
    expect(anchorIndexForLine(anchors, 19)).toBe(2);
    expect(anchorIndexForLine(anchors, 999)).toBe(3);
  });

  it("行号小于首块起始行（前导空行/元数据区）也落回首块", () => {
    expect(anchorIndexForLine(anchors, 0)).toBe(-1);
    const late: SplitAnchor[] = [{ line: 4, top: 0 }];
    expect(anchorIndexForLine(late, 4)).toBe(0);
    expect(anchorIndexForLine(late, 1)).toBe(-1);
  });

  it("像素取当前顶块，且与行号查找同口径", () => {
    expect(anchorIndexForTop(anchors, 0)).toBe(0);
    expect(anchorIndexForTop(anchors, 119)).toBe(0);
    expect(anchorIndexForTop(anchors, 120)).toBe(1);
    expect(anchorIndexForTop(anchors, 899)).toBe(2);
    expect(anchorIndexForTop(anchors, 5000)).toBe(3);
  });

  it("空表返回 -1（调用方据此跳过，不要拿 0 当兜底）", () => {
    expect(anchorIndexForLine([], 10)).toBe(-1);
    expect(anchorIndexForTop([], 10)).toBe(-1);
  });
});
