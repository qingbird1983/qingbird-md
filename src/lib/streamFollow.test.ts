// S4 #13 守卫：流式滚动跟随的四个要点。
//
// 这些断言为什么值钱 —— 每一条都对应一个真实会发生、但**只看结果看不出来**的 bug：
// · 用 `scroll` 判用户意图 → 面板自己滚的那一下被当成用户操作，跟随自己把自己关掉；
// · 没有时间戳护栏 → 惯性滚动 / 程序化滚动的伴生事件误判成"用户离开了"；
// · 中断不锁存 → 用户滚上去看图，流每来一条就把他拽回底部；
// · 不合并 rAF → 长列表流式更新时每一段都写一次 scrollTop，反复触发布局。
//
// 最后一条是**源码级**守卫：直接读源码确认没有注册 `scroll` 监听、也没引
// `setInterval`（WebView2 会把它节流到 >=1000ms，与打字机那套保持同源）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROGRAMMATIC_SCROLL_GUARD_MS,
  STREAM_GROWTH_FOLLOW_PX,
  STREAM_START_FOLLOW_PX,
  StreamFollower,
  atBottom,
  bottomGap,
  type ScrollBox,
} from "./streamFollow";

/** 假滚动盒：真 DOM 在无布局环境里 clientHeight/scrollHeight 恒为 0，测不出来。 */
const box = (scrollTop: number, scrollHeight = 1000, clientHeight = 400): ScrollBox => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

/** 可控时钟 + 可控 rAF：不依赖 happy-dom 是否实现 requestAnimationFrame。 */
function harness(startTime = 0) {
  let t = startTime;
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  const follower = new StreamFollower({
    now: () => t,
    schedule: (fn) => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    cancel: (id) => {
      scheduled.delete(id);
    },
  });
  return {
    follower,
    pending: () => scheduled.size,
    advance: (ms: number) => {
      t += ms;
    },
    /** 跑掉当前排队的帧（模拟下一帧到来）。 */
    flush: () => {
      const entries = Array.from(scheduled.values());
      scheduled.clear();
      for (const fn of entries) fn();
    },
  };
}

describe("底部判定", () => {
  it("bottomGap / atBottom 用容差而不是严格相等", () => {
    expect(bottomGap(box(600))).toBe(0);
    expect(atBottom(box(600))).toBe(true);
    // 离底 90px：在 96px 容差内 → 仍算"在底部"
    expect(bottomGap(box(510))).toBe(90);
    expect(atBottom(box(510))).toBe(true);
    // 离底 200px：不算
    expect(atBottom(box(400))).toBe(false);
    // 容差可收紧（做"严格贴底"的判定时用）
    expect(atBottom(box(510), 10)).toBe(false);
  });
});

describe("要点 ④：rAF 合并写入", () => {
  it("内容不可滚时不排帧（白排帧会在每次 issue 变化时白跑一轮）", () => {
    const h = harness();
    expect(h.follower.follow(box(0, 400, 400))).toBe(false);
    expect(h.pending()).toBe(0);
    expect(h.follower.interrupted).toBe(false);
  });

  it("同一个 tick 内多次请求只写一次", () => {
    const h = harness();
    const b = box(600);
    expect(h.follower.follow(b, "start")).toBe(true);
    expect(h.follower.follow(b, "start")).toBe(true);
    expect(h.follower.follow(b, "start")).toBe(true);
    expect(h.pending()).toBe(1);

    h.flush();
    expect(b.scrollTop).toBe(600); // = scrollHeight - clientHeight
    expect(h.pending()).toBe(0);
  });

  it("卸载时取消挂起帧（不留下悬空的写入）", () => {
    const h = harness();
    const b = box(600);
    h.follower.follow(b, "start");
    h.follower.destroy();
    expect(h.pending()).toBe(0);
    h.flush();
    expect(b.scrollTop).toBe(600); // 未被改写（初始值就是 600）
  });
});

describe("要点 ①②：用户意图 + 程序化滚动的护栏", () => {
  it("写入后的静默窗口内，意图事件不算数", () => {
    const h = harness();
    const b = box(600);
    h.follower.follow(b, "start");
    h.flush();

    // 紧接着（护栏窗口内）收到 wheel：忽略 —— 那多半是程序化滚动的伴生物
    h.advance(PROGRAMMATIC_SCROLL_GUARD_MS - 40);
    h.follower.onUserIntent(box(0)); // 假设此刻用户其实已经被带到别处
    expect(h.follower.interrupted).toBe(false);
  });

  it("过了护栏窗口，同样的意图事件就生效", () => {
    const h = harness();
    const b = box(600);
    h.follower.follow(b, "start");
    h.flush();

    h.advance(PROGRAMMATIC_SCROLL_GUARD_MS + 1);
    h.follower.onUserIntent(box(0));
    expect(h.follower.interrupted).toBe(true);
  });
});

describe("要点 ③：中断锁存", () => {
  it("用户滚离底部后，本次流式期间不再拽回 —— 即使他后来又滚回底部", () => {
    const h = harness();

    h.follower.onUserIntent(box(0)); // 用户往上翻了
    expect(h.follower.interrupted).toBe(true);

    // 内容继续增长，他还在底部附近 → 仍然不跟
    expect(h.follower.follow(box(600), "grow")).toBe(false);
    expect(h.pending()).toBe(0);

    // 他手动滚回底部 —— 锁存**不解除**（这正是"别跟他抢滚动条"的关键）
    expect(h.follower.follow(box(600), "grow")).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("reset() 才解除锁存（新一次流式会话 / 用户点「回到底部」）", () => {
    const h = harness();
    h.follower.onUserIntent(box(0));
    expect(h.follower.interrupted).toBe(true);

    h.follower.reset();
    expect(h.follower.interrupted).toBe(false);
    expect(h.follower.follow(box(600), "start")).toBe(true);
  });
});

describe("阈值：流起步宽（180）、增长期紧（120）", () => {
  it("离底 150px：流刚开始跟，增长期不跟（并判为离开）", () => {
    // gap = 1000 - 400 - 450 = 150
    const startPhase = harness();
    expect(bottomGap(box(450))).toBe(150);
    expect(STREAM_START_FOLLOW_PX).toBe(180);
    expect(startPhase.follower.follow(box(450), "start")).toBe(true);
    expect(startPhase.follower.interrupted).toBe(false);

    const growPhase = harness();
    expect(STREAM_GROWTH_FOLLOW_PX).toBe(120);
    expect(growPhase.follower.follow(box(450), "grow")).toBe(false);
    expect(growPhase.follower.interrupted).toBe(true);
  });

  it("增长期里内容变多把他甩在后面时，也会判为离开（不再反复拽）", () => {
    const h = harness();
    // 一开始贴底：跟着
    expect(h.follower.follow(box(600), "grow")).toBe(true);
    // 内容变长 400px，他还停在原处 → gap 400 > 120 → 判离开
    expect(h.follower.follow(box(600, 1400, 400), "grow")).toBe(false);
    expect(h.follower.interrupted).toBe(true);
  });
});

describe("源码级守卫：判意图只认三个事件，且不引 setInterval", () => {
  const src = readFileSync(fileURLToPath(new URL("./streamFollow.ts", import.meta.url)), "utf-8");

  it("注册了 wheel / touchstart / pointerdown", () => {
    for (const ev of ["wheel", "touchstart", "pointerdown"]) {
      expect(src).toMatch(new RegExp(`addEventListener\\(\\s*"${ev}"`));
    }
  });

  it('**没有**注册 "scroll" 监听（程序化滚动也发 scroll，监听它等于自我误判）', () => {
    expect(src).not.toMatch(/addEventListener\(\s*"scroll"/);
  });

  it("没有 setInterval（WebView2 会把它节流到 >=1000ms）", () => {
    expect(src).not.toMatch(/setInterval\s*\(/);
  });
});
