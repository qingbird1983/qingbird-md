import { describe, expect, it } from "vitest";
import {
  MIN_TYPING_MS,
  revealDrain,
  revealIdle,
  revealPush,
  revealSetRegion,
  revealStart,
  revealTick,
  type RevealBlock,
  type RevealCommit,
} from "./reveal";

const block = (index: number, runs: Array<[number, string]>): RevealBlock => ({
  index,
  runs: runs.map(([i, t]) => ({ index: i, text: t })),
});

const textsOf = (cs: RevealCommit[]) =>
  cs.map((c) => {
    if (c.kind === "start") return `start:${c.index}`;
    if (c.kind === "done" || c.kind === "instant") {
      return `${c.kind}:${c.index}:${c.runs.map((r) => r.text).join("")}`;
    }
    return `${c.kind}:${c.index}:${"text" in c ? c.text : ""}`;
  });

describe("reveal 队列（块级打字单元）", () => {
  it("整段打字：start → run0 tick → 跨 run 边界 → run1 tick → done（一次连续动画）", () => {
    // 一块含两个 run（模拟段落内被 **bold** 拆成多个 inline run）：
    // 打字应整段连续——run0 打满后下一帧自动接 run1 的开头，绝不在 run 边界停顿。
    let s = revealStart(0, 100);
    s = revealPush(s, block(0, [[0, "你好"], [1, "世界"]]), false).state;
    const t1 = revealTick(s, MIN_TYPING_MS);
    expect(textsOf(t1.commits)).toEqual(["start:0"]);
    s = t1.state;
    const ticks: string[] = [];
    let done = "";
    for (let ms = MIN_TYPING_MS + 16; ms < 5000; ms += 16) {
      const t = revealTick(s, ms);
      s = t.state;
      for (const c of t.commits) {
        if (c.kind === "tick") ticks.push(`${c.index}:${c.text}`);
        if (c.kind === "done") done = textsOf([c])[0];
      }
      if (revealIdle(s)) break;
    }
    expect(done).toBe("done:0:你好世界");
    // run0 逐字先出（"你"→"你好"），随后 run1 接续（"世"→"世界"），无 run 间停顿
    expect(ticks).toContain("0:你");
    expect(ticks).toContain("0:你好");
    expect(ticks).toContain("1:世");
    expect(ticks).toContain("1:世界");
    expect(s.typing).toBeNull();
    // 下一个 tick 自动起下一块（块间零停顿连锁，对齐 qingniao advance）
    s = revealPush(s, block(1, [[2, "下一段"]]), false).state;
    const t2 = revealTick(s, 5000);
    expect(t2.commits[0]).toMatchObject({ kind: "start", index: 1 });
  });

  it("instant 不进队列直接 commit（携带整块 runs）", () => {
    const s0 = revealStart();
    const r = revealPush(s0, block(5, [[5, "缓存译文"]]), true);
    expect(r.commits).toEqual([{ kind: "instant", index: 5, runs: [{ index: 5, text: "缓存译文" }] }]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("区域外 push 自身 emit instant，不进队列（块索引空间判定）", () => {
    let s = revealStart(0, 4);
    const r = revealPush(s, block(10, [[10, "远离"], [11, "段尾"]]), false);
    expect(r.commits).toEqual([
      { kind: "instant", index: 10, runs: [{ index: 10, text: "远离" }, { index: 11, text: "段尾" }] },
    ]);
    expect(r.state.queue).toHaveLength(0);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("区域内 push 进队等待 tick 启动打字", () => {
    let s = revealStart(0, 4);
    const r = revealPush(s, block(2, [[2, "区内"]]), false);
    expect(r.commits).toHaveLength(0);
    expect(r.state.queue).toHaveLength(1);
    expect(r.state.queue[0].index).toBe(2);
  });

  it("区域是块索引空间：run 序号再大也不误伤同块（修复 run/块空间错配）", () => {
    // 视口窗口 [0, 3)（data-bi 块空间），块 0 内含 5 个 run（run 索引 0..4）：
    // 旧实现把 run 索引当块索引比对，run 4 ≥ 3 → 误判区域外即时上屏。
    // 新实现整块 0 < 3 → 进队打字。
    let s = revealStart(0, 3);
    const r = revealPush(s, block(0, [[0, "A"], [1, "B"], [2, "C"], [3, "D"], [4, "E"]]), false);
    expect(r.commits).toHaveLength(0);
    expect(r.state.queue).toHaveLength(1);
  });

  it("setRegion：区域外打字与缓冲瞬时 flush，区域内保留", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, block(1, [[10, "字".repeat(500)]]), false).state;
    s = revealPush(s, block(2, [[11, "区域内"]]), false).state;
    s = revealPush(s, block(3, [[12, "区域外"]]), false).state;
    s = revealTick(s, MIN_TYPING_MS / 2).state;
    expect(s.typing?.index).toBe(1);
    const r = revealSetRegion(s, 2, 3);
    const kinds = r.commits.map((c) => c.kind);
    expect(kinds).toContain("done"); // 打字中的 1 在区域外 → done 瞬时
    expect(kinds).toContain("instant"); // 3 在区域外 → instant
    expect(r.state.queue.map((e) => e.index)).toEqual([2]); // 2 保留
    expect(r.state.typing).toBeNull();
  });

  it("字节安全：代理对不被劈半（单 run 内）", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, block(0, [[0, "a😀b"]]), false).state;
    let out = "";
    for (let ms = 16; ms < 5000; ms += 16) {
      const t = revealTick(s, ms);
      s = t.state;
      for (const c of t.commits) {
        if (c.kind === "tick" || c.kind === "done") out = c.kind === "done" ? c.runs[0].text : c.text;
      }
      if (revealIdle(s)) break;
    }
    expect(out).toBe("a😀b");
  });

  it("空块（译文全空）不进打字队列直接 instant", () => {
    let s = revealStart(0, 10);
    const r = revealPush(s, block(0, [[0, ""], [1, ""]]), false);
    expect(r.commits[0]?.kind).toBe("instant");
    expect(revealIdle(r.state)).toBe(true);
  });

  it("drain 排空一切为瞬时", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, block(0, [[0, "字".repeat(500)]]), false).state;
    s = revealPush(s, block(1, [[1, "乙"]]), false).state;
    s = revealTick(s, MIN_TYPING_MS / 2).state;
    expect(s.typing?.index).toBe(0);
    const r = revealDrain(s);
    expect(r.commits.map((c) => c.kind).sort()).toEqual(["done", "instant"]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("wall-clock：tick 间隔被合并后仍按真实流逝时间推进（防 setInterval 后台节流脱节）", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, block(0, [[0, "字".repeat(5000)]]), false).state;
    s = revealTick(s, MIN_TYPING_MS).state;
    const t = revealTick(s, 1030);
    const tickCommit = t.commits.find((c) => c.kind === "tick");
    expect(tickCommit?.kind).toBe("tick");
    const text = (tickCommit as { kind: "tick"; text: string }).text;
    expect(text.length).toBeGreaterThanOrEqual(165);
    expect(text.length).toBeLessThanOrEqual(175);
  });

  it("MIN_TYPING_MS：短块至少持续 MIN_TYPING_MS 后才发 done", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, block(0, [[0, "AB"]]), false).state;
    s = revealTick(s, MIN_TYPING_MS / 2).state;
    expect(s.typing?.index).toBe(0);
  });

  it("failed run 跳过打字：不发 tick、块内其余 run 照常打、块正常 done", () => {
    // 块 = [失败 run(10 字, 原文), 正常 run(10 字)]：失败 run 占据字符但不发 tick，
    // 跨过后正常 run 按字打，最终 done 带全部 runs。
    let s = revealStart(0, 10);
    s = revealPush(
      s,
      {
        index: 0,
        runs: [
          { index: 0, text: "ABCDEFGHIJ", failed: true },
          { index: 1, text: "0123456789" },
        ],
      },
      false,
    ).state;
    s = revealTick(s, 0).state;
    expect(s.typing?.index).toBe(0);
    let sawFailedTick = false;
    let sawNormalTick = false;
    for (let ms = 16; ms < 2000 && s.typing; ms += 16) {
      const out = revealTick(s, ms);
      s = out.state;
      for (const c of out.commits) {
        if (c.kind === "tick" && c.index === 0) sawFailedTick = true;
        if (c.kind === "tick" && c.index === 1) sawNormalTick = true;
        if (c.kind === "done") {
          expect(c.runs.length).toBe(2); // done 带全部 run（含失败）
        }
      }
    }
    expect(sawFailedTick).toBe(false); // 失败 run 永不被打字
    expect(sawNormalTick).toBe(true); // 块内正常 run 照常打字
    expect(revealIdle(s)).toBe(true);
  });
});
