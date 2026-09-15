// 逐字 reveal 队列（qingniao reveal.rs 的 TS 移植，纯逻辑、无 React/DOM 依赖）。
//
// 输入：已按文档序放行的块（typewriterPush 产物）+ 是否跳过动画（缓存命中）。
// 输出：commit 流——start（开始打字，UI 锁行高）/ tick（切片上屏）/
// done（完整定格）/ instant（跳过动画直接完整上屏）。
// tick 由 store 的 rAF 循环驱动；DOM 写入由 PreviewView 的 patcher 承担，
// 本模块只做状态推进，可离线注入 tick 测试。
export const TYPE_SPEED = 200; // 字/秒（qingniao round2 定值：整行 ≈0.3s）

/** 打字动画的最小可见持续时间（ms）。
 *  qingniao 的 typing 单元是整段（几十字），200 字/秒打 0.3s 用户清楚看见。
 *  本项目的 typing 单元是单个 inline run（几字到十几字），200 字/秒下 30ms
 *  就打完一 run，动画对用户不可见——表现为"整块替换"。强制最少 180ms 保证
 *  至少 ~10 帧 (60Hz) 让用户看到逐字推进，仍短于读一行所需。 */
export const MIN_TYPING_MS = 180;

export type RevealCommit =
  | { kind: "start"; index: number }
  | { kind: "tick"; index: number; text: string }
  | { kind: "done"; index: number; text: string }
  | { kind: "instant"; index: number; text: string };

interface RevealEntry {
  index: number;
  chars: string[]; // Array.from 切分：UTF-16 代理对安全（emoji/CJK 不劈半）
}

export interface RevealState {
  /** 当前波次区域 [regionStart, regionEnd)：区域内按序打字，区域外瞬时上屏 */
  regionStart: number;
  regionEnd: number;
  queue: RevealEntry[];
  typing: (RevealEntry & { startMs: number; shown: number }) | null;
}

export function revealStart(regionStart = 0, regionEnd = Number.POSITIVE_INFINITY): RevealState {
  return { regionStart, regionEnd, queue: [], typing: null };
}

export function revealIdle(s: RevealState): boolean {
  return s.queue.length === 0 && s.typing === null;
}

export function revealPush(
  s: RevealState,
  index: number,
  text: string,
  instant: boolean,
): { state: RevealState; commits: RevealCommit[] } {
  if (instant) {
    return { state: s, commits: [{ kind: "instant", index, text }] };
  }
  // 区域外即时上屏（对齐 qingniao reveal.rs::on_done 的 in_region 守卫）：
  // partial 流并发到达 + 视口重锚间隙，队首若停在区域外，revealTick 会空转
  // 不出队，把后续 in-region 项一起卡死。在 push 端即时落地是唯一安全点。
  if (index < s.regionStart || index >= s.regionEnd) {
    return { state: s, commits: [{ kind: "instant", index, text }] };
  }
  const queue = [...s.queue, { index, chars: Array.from(text) }];
  return { state: { ...s, queue }, commits: [] };
}

/**
 * 推进一个 tick：nowMs 必须由调用方传入（对齐 qingniao reveal.rs::tick(now_ms)）。
 * 用 wall-clock 算 shown 字符数，不依赖 TICK_MS 的精确频率——浏览器对 setInterval
 * 在标签页非激活/系统繁忙时会合并到 ≥1000ms，累计步进（shown += N）会脱节，
 * wall-clock 自校准：哪怕两次 tick 间隔 100ms，shown 也按 (elapsed × TYPE_SPEED)
 * 推进到正确位置。
 */
export function revealTick(
  s: RevealState,
  nowMs: number,
): { state: RevealState; commits: RevealCommit[] } {
  let typing = s.typing;
  let queue = s.queue;
  if (typing === null) {
    const head = queue[0];
    if (!head || head.index < s.regionStart || head.index >= s.regionEnd) {
      return { state: s, commits: [] }; // 空转：队列空或队首在区域外
    }
    queue = queue.slice(1);
    typing = { ...head, startMs: nowMs, shown: 0 };
    // 首帧只发 start；下一帧再进 typing 分支推 tick/done。
    return {
      state: { ...s, queue, typing },
      commits: [{ kind: "start", index: typing.index }],
    };
  }
  const elapsed = (nowMs - typing.startMs) / 1000;
  const elapsedMs = elapsed * 1000;
  // shown 由两个上限的较小者决定：
  //   speedShown = elapsed × TYPE_SPEED（长内容自然进度，受 200 字/秒约束）
  //   minShown   = elapsed / MIN_TYPING_MS × chars.length（短内容按时间比例
  //                渐进，强制拉出至少 MIN_TYPING_MS / rAF 周期的可见帧数）
  // 二者取 min：长内容被 speedShown 主导不会拖慢；短内容被 minShown 主导逐字
  // 显示，2 字也能在 180ms 内分 ~10 帧逐字呈现。
  const speedShown = Math.round(elapsed * TYPE_SPEED);
  // ceil 保证短块每帧至少多显 1 字（floor 在低 elapsed 时常为 0，stuck）。
  // MIN_TYPING_MS=180 + chars=2 + 60fps 下：第 1 帧 16ms→ceil(0.18)=1、
  // 第 2 帧 32ms→ceil(0.36)=1、第 3 帧 50ms→ceil(0.55)=2（满），后续等 180ms done。
  const minShown = Math.min(
    typing.chars.length,
    Math.max(1, Math.ceil((elapsedMs / MIN_TYPING_MS) * typing.chars.length)),
  );
  const targetShown = Math.min(speedShown, minShown);
  const shown = Math.max(typing.shown, targetShown);
  const text = typing.chars.slice(0, shown).join("");
  if (shown >= typing.chars.length && elapsedMs >= MIN_TYPING_MS) {
    return {
      state: { ...s, queue, typing: null },
      commits: [{ kind: "done", index: typing.index, text: typing.chars.join("") }],
    };
  }
  if (shown <= typing.shown) {
    return { state: s, commits: [] };
  }
  return {
    state: { ...s, queue, typing: { ...typing, shown } },
    commits: [{ kind: "tick", index: typing.index, text }],
  };
}

/** 重锚：新区域外的打字/缓冲全部瞬时上屏，区域内保留继续按序。 */
export function revealSetRegion(
  s: RevealState,
  start: number,
  end: number,
): { state: RevealState; commits: RevealCommit[] } {
  const commits: RevealCommit[] = [];
  let typing = s.typing;
  if (typing && (typing.index < start || typing.index >= end)) {
    commits.push({ kind: "done", index: typing.index, text: typing.chars.join("") });
    typing = null;
  }
  const keep: RevealEntry[] = [];
  for (const e of s.queue) {
    if (e.index < start || e.index >= end) {
      commits.push({ kind: "instant", index: e.index, text: e.chars.join("") });
    } else {
      keep.push(e);
    }
  }
  return { state: { regionStart: start, regionEnd: end, queue: keep, typing }, commits };
}

/** 全部排空为瞬时上屏（resetDisplay / 会话清理用）。 */
export function revealDrain(s: RevealState): { state: RevealState; commits: RevealCommit[] } {
  const commits: RevealCommit[] = [];
  if (s.typing) {
    commits.push({ kind: "done", index: s.typing.index, text: s.typing.chars.join("") });
  }
  for (const e of s.queue) {
    commits.push({ kind: "instant", index: e.index, text: e.chars.join("") });
  }
  return { state: revealStart(s.regionStart, s.regionEnd), commits };
}
