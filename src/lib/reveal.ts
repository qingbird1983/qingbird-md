// 逐字 reveal 队列（qingniao reveal.rs 的 TS 移植，纯逻辑、无 React/DOM 依赖）。
//
// 输入：已按文档序放行的**块**（前端按 TranslateStart.indices_blocks 把同一块的
// run 组装成 RevealBlock）+ 是否跳过动画（缓存命中/流式直显过）。
// 输出：commit 流——start（开始打字，UI 锁行高）/ tick（切片上屏）/
// done（完整定格）/ instant（跳过动画直接完整上屏）/
// stream（单单元裸发增量直写，由 store 直接发出、不经本状态机）。
// tick 由 store 的 rAF 循环驱动；DOM 写入由 PreviewView 的 patcher 承担，
// 本模块只做状态推进，可离线注入 tick 测试。
//
// 打字单元 = **整块**（对齐 qingniao reveal.rs：typing 单元是整段译文，几十字，
// 200 字/秒一次连续打完，块与块之间零停顿连锁）。块内多个 inline run 拼成一段
// 连续文本，tick 跨 run 边界无缝推进（当前 run 打满后下一帧自动接下一 run），
// 视觉上"一段一行"地往下走，而不是 run 级一卡一卡。
export const TYPE_SPEED = 200; // 字/秒（qingniao round2 定值：整段 ≈0.3s）
export const MIN_TYPING_MS = 180; // 整段打字动画的最小可见持续时间（ms）

/** 块内一个 run（translation 模式 = 行内原文片段；bilingual 模式 = 块自身）。 */
export interface RevealRun {
  /** run 索引（translation：data-ri 空间；bilingual：= 块索引 data-bi） */
  index: number;
  text: string;
  /** 该 run 翻译失败：text = 原文回退。打字时跳过它（DOM 保持原文、不发
   * tick），但照常占用字符推进与 done/instant 落地（回打原文 = no-op）。 */
  failed?: boolean;
}

/** 打字单元：一个块（段落/标题/单元格），含块内全部已收集 run。 */
export interface RevealBlock {
  /** 块索引（data-bi 空间）：区域判定与 start/done/instant 定位统一用它 */
  index: number;
  /** 块内 run（文档序）；bilingual 模式恰好 1 个且 index === 块索引 */
  runs: RevealRun[];
}

export type RevealCommit =
  | { kind: "start"; index: number } // 块索引（UI 锁行高/定位）
  | { kind: "tick"; index: number; text: string } // run 索引 + 该 run 的部分文本
  | { kind: "done"; index: number; runs: RevealRun[] } // 块索引 + 块内全量 run
  | { kind: "instant"; index: number; runs: RevealRun[] }
  // 单单元裸发路径的实时增量（灰字+省略号直写）；store 直接发出，不经 reveal 状态机
  | { kind: "stream"; index: number; text: string };

interface RevealEntry {
  index: number; // 块索引
  runs: RevealRun[];
  chars: string[]; // 整块拼接文本（Array.from 切分：代理对安全）
  runEnds: number[]; // 各 run 的累积字符边界（打字跨 run 用）
}

export interface RevealState {
  /** 当前波次区域 [regionStart, regionEnd)：块索引空间，区域内按序打字，区域外瞬时上屏 */
  regionStart: number;
  regionEnd: number;
  queue: RevealEntry[];
  typing: (RevealEntry & { startMs: number; shown: number }) | null;
}

function toEntry(b: RevealBlock): RevealEntry {
  const chars: string[] = [];
  const runEnds: number[] = [];
  for (const r of b.runs) {
    const a = Array.from(r.text);
    chars.push(...a);
    runEnds.push(chars.length);
  }
  return { index: b.index, runs: b.runs, chars, runEnds };
}

/** 空块（译文全空）视为无需打字，直接 instant——避免 180ms 空转占队。 */
function isEmpty(b: RevealBlock): boolean {
  return b.runs.every((r) => r.text.length === 0);
}

export function revealStart(regionStart = 0, regionEnd = Number.POSITIVE_INFINITY): RevealState {
  return { regionStart, regionEnd, queue: [], typing: null };
}

export function revealIdle(s: RevealState): boolean {
  return s.queue.length === 0 && s.typing === null;
}

export function revealPush(
  s: RevealState,
  block: RevealBlock,
  instant: boolean,
): { state: RevealState; commits: RevealCommit[] } {
  if (instant || isEmpty(block)) {
    return {
      state: s,
      commits: [{ kind: "instant", index: block.index, runs: block.runs }],
    };
  }
  // 区域外即时上屏（对齐 qingniao reveal.rs::on_done 的 in_region 守卫）：
  // partial 流并发到达 + 视口重锚间隙，队首若停在区域外，revealTick 会空转
  // 不出队，把后续 in-region 项一起卡死。在 push 端即时落地是唯一安全点。
  if (block.index < s.regionStart || block.index >= s.regionEnd) {
    return {
      state: s,
      commits: [{ kind: "instant", index: block.index, runs: block.runs }],
    };
  }
  const queue = [...s.queue, toEntry(block)];
  return { state: { ...s, queue }, commits: [] };
}

/**
 * 推进一个 tick：nowMs 必须由调用方传入（对齐 qingniao reveal.rs::tick(now_ms)）。
 * 用 wall-clock 算 shown 字符数，不依赖 TICK_MS 的精确频率——浏览器对 setInterval
 * 在标签页非激活/系统繁忙时会合并到 ≥1000ms，累计步进（shown += N）会脱节，
 * wall-clock 自校准：哪怕两次 tick 间隔 100ms，shown 也按 (elapsed × TYPE_SPEED)
 * 推进到正确位置。
 * tick 粒度 = 整块：shown 在整块字符序列上推进；当前落在哪个 run 就发哪个 run
 * 的部分文本，跨 run 边界无缝衔接（打满 run i 的下一帧自动接 run i+1 的开头）。
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
  // 显示，短块也能在 180ms 内分 ~10 帧逐字呈现。
  const speedShown = Math.round(elapsed * TYPE_SPEED);
  // ceil 保证短块每帧至少多显 1 字（floor 在低 elapsed 时常为 0，stuck）。
  const minShown = Math.min(
    typing.chars.length,
    Math.max(1, Math.ceil((elapsedMs / MIN_TYPING_MS) * typing.chars.length)),
  );
  const targetShown = Math.min(speedShown, minShown);
  const shown = Math.max(typing.shown, targetShown);
  const total = typing.chars.length;
  if (shown >= total && elapsedMs >= MIN_TYPING_MS) {
    return {
      state: { ...s, queue, typing: null },
      commits: [{ kind: "done", index: typing.index, runs: typing.runs }],
    };
  }
  if (shown <= typing.shown) {
    return { state: s, commits: [] };
  }
  // 定位当前 run：第一个 runEnds >= shown 的 run；runShown = 块内偏移减去前序边界。
  let runI = 0;
  while (runI < typing.runEnds.length - 1 && typing.runEnds[runI] < shown) {
    runI += 1;
  }
  const prevEnd = runI === 0 ? 0 : typing.runEnds[runI - 1];
  const runShown = shown - prevEnd;
  if (runShown <= 0) {
    // 恰好停在 run 边界：只推进状态不发空 tick（避免把 run span 清空闪一下）。
    return {
      state: { ...s, queue, typing: { ...typing, shown } },
      commits: [],
    };
  }
  if (typing.runs[runI].failed) {
    // 失败 run：跳过打字（DOM 保持原文、不发 tick），仅推进状态。
    return {
      state: { ...s, queue, typing: { ...typing, shown } },
      commits: [],
    };
  }
  const runText = Array.from(typing.runs[runI].text).slice(0, runShown).join("");
  return {
    state: { ...s, queue, typing: { ...typing, shown } },
    commits: [{ kind: "tick", index: typing.runs[runI].index, text: runText }],
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
    commits.push({ kind: "done", index: typing.index, runs: typing.runs });
    typing = null;
  }
  const keep: RevealEntry[] = [];
  for (const e of s.queue) {
    if (e.index < start || e.index >= end) {
      commits.push({ kind: "instant", index: e.index, runs: e.runs });
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
    commits.push({ kind: "done", index: s.typing.index, runs: s.typing.runs });
  }
  for (const e of s.queue) {
    commits.push({ kind: "instant", index: e.index, runs: e.runs });
  }
  return { state: revealStart(s.regionStart, s.regionEnd), commits };
}
