import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TICK,
  revealDrain,
  revealIdle,
  revealPush,
  revealSetRegion,
  revealStart,
  revealTick,
  type RevealCommit,
} from "./reveal";

const textsOf = (cs: RevealCommit[]) => cs.map((c) => c.kind === "start" ? (`start:${c.index}`) : `${c.kind}:${c.index}:${"text" in c ? c.text : ""}`);

describe("reveal 队列", () => {
  it("按序打字：start → tick×N → done → 自动起下一块", () => {
    let s = revealStart(0, 100);
    s = revealPush(s, 0, "abcdefgh", false).state;
    s = revealPush(s, 1, "efgh", false).state;
    const t1 = revealTick(s);
    expect(textsOf(t1.commits)).toEqual(["start:0", `tick:0:abc`].map((x) => x.replace("abc", "abcdefgh".slice(0, CHARS_PER_TICK))));
    s = t1.state;
    // 连续 tick 直到 done
    let seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = revealTick(s);
      s = t.state;
      seen = seen.concat(textsOf(t.commits));
      if (t.commits.some((c) => c.kind === "done" && c.index === 0)) break;
    }
    expect(seen).toContain("done:0:abcdefgh");
    expect(s.typing).toBeNull();
    // 下一 tick 起块 1
    const t2 = revealTick(s);
    expect(t2.commits[0]).toMatchObject({ kind: "start", index: 1 });
  });

  it("instant 不进队列直接 commit", () => {
    const s0 = revealStart();
    const r = revealPush(s0, 5, "缓存译文", true);
    expect(r.commits).toEqual([{ kind: "instant", index: 5, text: "缓存译文" }]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("队首在区域外不启动打字", () => {
    let s = revealStart(0, 4);
    s = revealPush(s, 10, "远离", false).state;
    const t = revealTick(s);
    expect(t.commits).toHaveLength(0);
  });

  it("setRegion：区域外打字与缓冲瞬时 flush，区域内保留", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 1, "打字中的测试文本", false).state;
    s = revealPush(s, 2, "区域内", false).state;
    s = revealPush(s, 3, "区域外", false).state;
    // 推进让 1 进入 typing
    s = revealTick(s).state;
    expect(s.typing?.index).toBe(1);
    const r = revealSetRegion(s, 2, 3);
    const kinds = r.commits.map((c) => c.kind);
    expect(kinds).toContain("done"); // 打字中的 1 在区域外 → done 瞬时
    expect(kinds).toContain("instant"); // 3 在区域外 → instant
    expect(r.state.queue.map((e) => e.index)).toEqual([2]); // 2 保留
    expect(r.state.typing).toBeNull();
  });

  it("字节安全：代理对不被劈半", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "a😀b", false).state;
    let out = "";
    for (let i = 0; i < 10; i++) {
      const t = revealTick(s);
      s = t.state;
      for (const c of t.commits) if (c.kind === "tick" || c.kind === "done") out = c.text;
      if (revealIdle(s)) break;
    }
    expect(out).toBe("a😀b");
  });

  it("drain 排空一切为瞬时", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "甲乙丙丁戊己庚辛", false).state;
    s = revealPush(s, 1, "乙", false).state;
    s = revealTick(s).state; // 0 进入 typing
    const r = revealDrain(s);
    expect(r.commits.map((c) => c.kind).sort()).toEqual(["done", "instant"]);
    expect(revealIdle(r.state)).toBe(true);
  });
});
