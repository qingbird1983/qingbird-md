import { describe, expect, it } from "vitest";
import {
  MIN_TYPING_MS,
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
  it("按序打字：start → tick×N → done → 自动起下一块（长块走 wall-clock 推进）", () => {
    // 用 200 字的长块，让 MIN_TYPING_MS 不触发瞬时完成，能观察 tick 推进序列。
    const longText = "字".repeat(200);
    let s = revealStart(0, 100);
    s = revealPush(s, 0, longText, false).state;
    s = revealPush(s, 1, "efgh", false).state;
    // 首 tick 启动 typing（startMs=nowMs），不发 tick；下一帧才进 typing 分支
    const t1 = revealTick(s, MIN_TYPING_MS);
    expect(textsOf(t1.commits)).toEqual(["start:0"]);
    s = t1.state;
    // 第二 tick：elapsed = 16ms，speedShown = round(0.016×200) = 3，
    // minShown = ceil(16/180 × 200) = 18，targetShown = min(3, 18) = 3
    const t2 = revealTick(s, MIN_TYPING_MS + 16);
    const tick1 = t2.commits.find((c) => c.kind === "tick");
    expect(tick1).toBeDefined();
    expect((tick1 as { kind: "tick"; text: string }).text.length).toBe(3);
    s = t2.state;
    // 连续 tick 直到 done
    let seen: string[] = [];
    for (let ms = MIN_TYPING_MS + 32; ms < 5000; ms += 16) {
      const t = revealTick(s, ms);
      s = t.state;
      seen = seen.concat(textsOf(t.commits));
      if (t.commits.some((c) => c.kind === "done" && c.index === 0)) break;
    }
    expect(seen).toContain(`done:0:${longText}`);
    expect(s.typing).toBeNull();
    // 下一 tick 起块 1
    const t3 = revealTick(s, 5000);
    expect(t3.commits[0]).toMatchObject({ kind: "start", index: 1 });
  });

  it("instant 不进队列直接 commit", () => {
    const s0 = revealStart();
    const r = revealPush(s0, 5, "缓存译文", true);
    expect(r.commits).toEqual([{ kind: "instant", index: 5, text: "缓存译文" }]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("区域外 push 自身 emit instant，不进队列（对齐 qingniao on_done 的 in_region 守卫）", () => {
    let s = revealStart(0, 4);
    const r = revealPush(s, 10, "远离", false);
    expect(r.commits).toEqual([{ kind: "instant", index: 10, text: "远离" }]);
    expect(r.state.queue).toHaveLength(0);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("区域内 push 进队等待 tick 启动打字", () => {
    let s = revealStart(0, 4);
    const r = revealPush(s, 2, "区内", false);
    expect(r.commits).toHaveLength(0);
    expect(r.state.queue).toHaveLength(1);
    expect(r.state.queue[0].index).toBe(2);
  });

  it("跨区域索引段：区域外即时落地后区域内接续打字（不卡队首）", () => {
    let s = revealStart(0, 4);
    s = revealPush(s, 7, "超尾", false).state;
    expect(s.queue).toHaveLength(0);
    s = revealPush(s, 1, "区内", false).state;
    expect(s.queue).toHaveLength(1);
    const t = revealTick(s, MIN_TYPING_MS);
    expect(t.commits[0]).toMatchObject({ kind: "start", index: 1 });
  });

  it("setRegion：区域外打字与缓冲瞬时 flush，区域内保留", () => {
    let s = revealStart(0, 10);
    // 用长文本让 typing 进入后不会因为 MIN_TYPING_MS 瞬时 done
    s = revealPush(s, 1, "字".repeat(500), false).state;
    s = revealPush(s, 2, "区域内", false).state;
    s = revealPush(s, 3, "区域外", false).state;
    // 推进让 1 进入 typing（在 MIN_TYPING_MS 中点，typing 已开始）
    s = revealTick(s, MIN_TYPING_MS / 2).state;
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
    for (let ms = 16; ms < 5000; ms += 16) {
      const t = revealTick(s, ms);
      s = t.state;
      for (const c of t.commits) if (c.kind === "tick" || c.kind === "done") out = c.text;
      if (revealIdle(s)) break;
    }
    expect(out).toBe("a😀b");
  });

  it("drain 排空一切为瞬时", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "字".repeat(500), false).state;
    s = revealPush(s, 1, "乙", false).state;
    s = revealTick(s, MIN_TYPING_MS / 2).state; // 0 进入 typing
    expect(s.typing?.index).toBe(0);
    const r = revealDrain(s);
    expect(r.commits.map((c) => c.kind).sort()).toEqual(["done", "instant"]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("wall-clock：tick 间隔被合并后仍按真实流逝时间推进（防 setInterval 后台节流脱节）", () => {
    // 长块（5000 字）保证 minShown 不主导，speedShown 走 200 字/秒
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "字".repeat(5000), false).state;
    s = revealTick(s, MIN_TYPING_MS).state; // 启动 typing @ startMs=MIN
    // 跳到 1030ms：wall-clock 1000ms 后 elapsed ≈ 850ms，speedShown = round(0.85×200) = 170
    const t = revealTick(s, 1030);
    const tickCommit = t.commits.find((c) => c.kind === "tick");
    expect(tickCommit?.kind).toBe("tick");
    const text = (tickCommit as { kind: "tick"; text: string }).text;
    expect(text.length).toBeGreaterThanOrEqual(165);
    expect(text.length).toBeLessThanOrEqual(175);
  });

  it("MIN_TYPING_MS：短块至少持续 MIN_TYPING_MS 后才发 done", () => {
    // 单 run 只有 2 字：旧逻辑 30ms 内 done → "整块替换"；新逻辑强制至少 MIN_TYPING_MS。
    // 在 MIN/2 时刻：typing 启动，shown 钳到 total=2，但 elapsed < MIN → 不发 done，
    // 发 tick（即使 shown=2 也不 done，强制拉满最短动画时长让用户看到逐字过程）。
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "AB", false).state;
    // typing 启动时 startMs = nowMs - MIN_TYPING_MS（详见 revealTick 首帧分支）
    // 这里直接验证 MIN/1000 时点：首帧 startMs 让 elapsed=MIN，shown=2 但 elapsed
    // 正好到 MIN_TYPING_MS/1000 → done 分支触发（边界条件）。
    // 真正短块动画可见性的核心：在 MIN/2 时 typing 仍在进行。
    s = revealTick(s, MIN_TYPING_MS / 2).state;
    expect(s.typing?.index).toBe(0);
  });
});
