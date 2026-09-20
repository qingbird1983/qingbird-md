/**
 * S4 #13 —— 面板「流式滚动跟随」（2026-09-19）。
 *
 * 场景：核查在面板里一条条吐 issue，用户可能正滚上去看某一条 ——
 * **这时绝不能把他拽回底部**。四个要点缺一个都会出 bug
 * （见 `docs/superpowers/plans/2026-09-16-translation-correctness.md` §8.5）：
 *
 * ① `wheel` / `touchstart` / `pointerdown` 判**用户意图**，**禁监听 `scroll`**
 *    ——程序化滚动同样触发 `scroll`，用它判定会把自己的滚动误判成用户操作。
 * ② `programmaticUntil` 时间戳护栏（120ms 窗口内的事件不算数）。
 * ③ `interrupted` **锁存**：用户一旦滚离底部，**本次流式期间不再拽回**，
 *    即使他后来又自己滚回到底。
 * ④ 滚动写入走 **rAF 合并**（同一个 tick 里多次请求只写一次）。
 *    **不引 `setInterval`** —— WebView2 会把它节流到 ≥1000ms，
 *    与 `useTranslationStore.pumpReveal` 里那条注释同源。
 *
 * 核心是普通类（不碰 React、不碰真实滚动条），因此可以离线单测；
 * `useStreamFollow` 只是把它接到一个 DOM 元素上。
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 流刚开始时的宽限：用户本来就在读末尾，别急着判他"离开了"。 */
export const STREAM_START_FOLLOW_PX = 180;

/** 流式过程中的阈值：往上看了一点点就算离开，不再拽。 */
export const STREAM_GROWTH_FOLLOW_PX = 120;

/** 判定"在底部"的容差，也用于「回到底部」钮的显隐。 */
export const STREAM_BOTTOM_GAP_PX = 96;

/** 程序化写入后的静默窗口：这期间到达的用户意图事件不算数（要点 2）。 */
export const PROGRAMMATIC_SCROLL_GUARD_MS = 120;

/** 滚动盒子只需要这三个读数 —— 真实 `HTMLElement` 结构上就满足它。 */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 距底部还有多少像素（负数=已越界，理论上不会）。 */
export function bottomGap(box: ScrollBox): number {
  return box.scrollHeight - box.clientHeight - box.scrollTop;
}

/** 是否在底部容差内。 */
export function atBottom(box: ScrollBox, gapPx = STREAM_BOTTOM_GAP_PX): boolean {
  return bottomGap(box) <= gapPx;
}

export interface StreamFollowDeps {
  now?: () => number;
  schedule?: (fn: () => void) => number;
  cancel?: (id: number) => void;
}

/** 流式跟随器（要点见 streamFollow.test.ts 头注）。
 * 导出兼作测试入口（streamFollow.test.ts 直测状态机），勿因「外部无生产
 * import」误删——文件内 useStreamFollow hook 生产使用（P2-6 红线标注）。 */
export class StreamFollower {
  /** 要点 ③：锁存的中断标志。`reset()` 之外任何路径都不解除。 */
  private interruptedFlag = false;
  /** 要点 ②：这个时间戳之前收到的意图事件一律忽略。 */
  private programmaticUntil = 0;
  /** 要点 ④：挂起的 rAF 句柄，非 0 表示已排帧（用于合并）。 */
  private frame = 0;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => number;
  private readonly cancel: (id: number) => void;

  constructor(deps: StreamFollowDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule =
      deps.schedule ??
      ((fn) =>
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(fn)
          : window.setTimeout(fn, 16));
    this.cancel =
      deps.cancel ??
      ((id) =>
        typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id));
  }

  get interrupted(): boolean {
    return this.interruptedFlag;
  }

  /** 新的一次流式会话（或用户手动"回到底部"）→ 清中断锁存与挂起帧。 */
  reset(): void {
    this.interruptedFlag = false;
    this.programmaticUntil = 0;
    if (this.frame) {
      this.cancel(this.frame);
      this.frame = 0;
    }
  }

  /**
   * 用户意图事件到达。返回（是否已中断）。
   * **调用方只应从 `wheel` / `touchstart` / `pointerdown` 三个事件调进来**（要点 ①）。
   */
  onUserIntent(box: ScrollBox | null): boolean {
    if (!box) return this.interruptedFlag;
    if (this.now() < this.programmaticUntil) return this.interruptedFlag; // 要点 ②
    if (!atBottom(box)) this.interruptedFlag = true; // 要点 ③
    return this.interruptedFlag;
  }

  /**
   * 新内容到达 → 请求跟随。返回是否真的（或已排队）会滚到底。
   * `phase`：`start` 用宽阈值，`grow` 用紧阈值。
   */
  follow(box: ScrollBox | null, phase: "start" | "grow" = "grow"): boolean {
    if (!box) return false;
    if (box.scrollHeight <= box.clientHeight) return false; // 没得滚，别白排帧
    if (this.interruptedFlag) return false; // 要点 ③
    const gap = phase === "start" ? STREAM_START_FOLLOW_PX : STREAM_GROWTH_FOLLOW_PX;
    if (bottomGap(box) > gap) {
      // 内容变多了但他已经离底 → 视为离开，本次不再跟。
      this.interruptedFlag = true;
      return false;
    }
    if (this.frame) return true; // 要点 ④：已排帧 → 合并，不再排
    this.frame = this.schedule(() => {
      this.frame = 0;
      this.write(box);
    });
    return true;
  }

  /** 实际写入（rAF 回调的动作；测试直接调用，不必等帧）。 */
  write(box: ScrollBox): void {
    this.programmaticUntil = this.now() + PROGRAMMATIC_SCROLL_GUARD_MS; // 要点 ②
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  }

  /** 组件卸载：只取消挂起帧（不动滚动位置）。 */
  destroy(): void {
    if (this.frame) {
      this.cancel(this.frame);
      this.frame = 0;
    }
  }
}

/**
 * 把 `StreamFollower` 接到一个滚动容器上。
 * 返回的 `ref` 是**回调 ref**（元素可能后挂载），`follow` 由调用方在内容变化时调。
 */
export function useStreamFollow<T extends HTMLElement>(runKey?: unknown) {
  const [el, setEl] = useState<T | null>(null);
  const followerRef = useRef<StreamFollower | null>(null);
  if (followerRef.current === null) followerRef.current = new StreamFollower();
  const follower = followerRef.current;

  const [interrupted, setInterrupted] = useState(false);

  // 换会话（新一次核查）→ 清锁存：上一次的中断不该带到这一次。
  useEffect(() => {
    follower.reset();
    setInterrupted(false);
  }, [follower, runKey]);

  useEffect(() => {
    if (!el) return;
    const onIntent = () => {
      if (follower.onUserIntent(el)) setInterrupted(true);
    };
    // 要点 ①：只认这三个。**这里绝不能出现 "scroll"** ——
    // 程序化滚动也会发 scroll，监听它等于把自己滚的那一下当成用户操作。
    el.addEventListener("wheel", onIntent, { passive: true });
    el.addEventListener("touchstart", onIntent, { passive: true });
    el.addEventListener("pointerdown", onIntent);
    return () => {
      el.removeEventListener("wheel", onIntent);
      el.removeEventListener("touchstart", onIntent);
      el.removeEventListener("pointerdown", onIntent);
    };
  }, [el, follower]);

  useEffect(() => () => follower.destroy(), [follower]);

  const follow = useCallback(
    (phase: "start" | "grow" = "grow") => {
      const ok = follower.follow(el, phase);
      setInterrupted(follower.interrupted);
      return ok;
    },
    [el, follower],
  );

  /** 「回到底部」：解除锁存并立刻滚到底（唯一能解除锁存的用户动作）。 */
  const jumpToBottom = useCallback(() => {
    follower.reset();
    if (el) follower.write(el);
    setInterrupted(false);
  }, [el, follower]);

  return { ref: setEl, follow, jumpToBottom, interrupted };
}
