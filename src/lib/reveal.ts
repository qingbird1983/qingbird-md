// 逐字 reveal 队列（qingniao reveal.rs 的 TS 移植，纯逻辑、无 React/DOM 依赖）。
//
// 输入：已按文档序放行的块（typewriterPush 产物）+ 是否跳过动画（缓存命中）。
// 输出：commit 流——start（开始打字，UI 锁行高）/ tick（切片上屏）/
// done（完整定格）/ instant（跳过动画直接完整上屏）。
// tick 由 store 的 30ms 定时器驱动；DOM 写入由 PreviewView 的 patcher 承担，
// 本模块只做状态推进，可离线注入 tick 测试。
export const TYPE_SPEED = 200; // 字/秒（qingniao round2 定值：整行 ≈0.3s）
export const TICK_MS = 30;
/** 每 tick 推进字符数 = 200 × 0.03 = 6。 */
export const CHARS_PER_TICK = Math.round((TYPE_SPEED * TICK_MS) / 1000);

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
  typing: (RevealEntry & { shown: number }) | null;
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
  const queue = [...s.queue, { index, chars: Array.from(text) }];
  return { state: { ...s, queue }, commits: [] };
}

/** 推进一个 tick：空闲则尝试从队首起块（须在区域内），否则打字切片推进。 */
export function revealTick(s: RevealState): { state: RevealState; commits: RevealCommit[] } {
  let typing = s.typing;
  let queue = s.queue;
  if (typing === null) {
    const head = queue[0];
    if (!head || head.index < s.regionStart || head.index >= s.regionEnd) {
      return { state: s, commits: [] }; // 空转：队列空或队首在区域外
    }
    queue = queue.slice(1);
    typing = { ...head, shown: 0 };
    // 首个 tick 即吐出第一批字符（start + tick 合并发送，节奏更顺）
    const shown = Math.min(CHARS_PER_TICK, typing.chars.length);
    const text = typing.chars.slice(0, shown).join("");
    if (shown >= typing.chars.length) {
      return {
        state: { ...s, queue, typing: null },
        commits: [
          { kind: "start", index: typing.index },
          { kind: "done", index: typing.index, text: typing.chars.join("") },
        ],
      };
    }
    return {
      state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: { ...typing, shown } },
      commits: [
        { kind: "start", index: typing.index },
        { kind: "tick", index: typing.index, text },
      ],
    };
  }
  const shown = Math.min(typing.shown + CHARS_PER_TICK, typing.chars.length);
  const text = typing.chars.slice(0, shown).join("");
  if (shown >= typing.chars.length) {
    return {
      state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: null },
      commits: [{ kind: "done", index: typing.index, text: typing.chars.join("") }],
    };
  }
  return {
    state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: { ...typing, shown } },
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
