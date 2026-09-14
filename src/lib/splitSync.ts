// 分栏（split）左右同步总线：编辑器 ⇄ 预览，以**源行号**为唯一坐标。
//
// 为什么不用像素比例：两侧高度结构完全不同——一张图或一段代码块在两边的像素
// 高差可达十倍，按比例同步必然越滚越偏，而且偏了不会自己回来。行号是两侧天然
// 共有的坐标：Rust 在每个顶层块前写了 `<!--sl:N-->` 注释
// （src-tauri/src/markdown/html.rs::render_top_blocks），预览侧把注释与紧跟的块
// 元素配成锚点表，编辑器侧用 CodeMirror 的 lineBlockAtHeight 取当前顶行。
//
// 回环抑制：程序化滚动会触发对侧的 scroll 事件，不拦就来回弹。规则——把行号推给
// 对侧时给**对侧**上锁 LOCK_MS，锁内对侧自己的滚动不再外发（它正被程序化拖动）。
// 锁只拦「被动跟随」的一侧，用户手动滚另一侧仍立即生效。
//
// 本模块刻意只做「行号 → 订阅者」这一层最薄的中转，不含任何 DOM/CSS 知识，
// 两个视图各自决定怎么把行号换成滚动位置——因此逻辑可离线单测。
export type SplitSide = "editor" | "preview";

/** 锁窗口：程序化滚动触发的 scroll 事件总在同一帧附近到达，180ms 富余。 */
export const SPLIT_SYNC_LOCK_MS = 180;

/** 预览侧锚点：顶层块在源码里的起始行 + 它在滚动内容坐标系里的顶边。 */
export interface SplitAnchor {
  line: number;
  top: number;
}

type Listener = (line: number) => void;

const listeners: Record<SplitSide, Set<Listener>> = {
  editor: new Set(),
  preview: new Set(),
};
const lockedUntil: Record<SplitSide, number> = { editor: 0, preview: 0 };

function other(side: SplitSide): SplitSide {
  return side === "editor" ? "preview" : "editor";
}

/** 订阅「对侧滚到了第 line 行」。返回退订函数（组件卸载必须调用）。 */
export function subscribeSplitSync(side: SplitSide, fn: Listener): () => void {
  const set = listeners[side];
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** 本侧滚动 → 通知对侧跟随（并给对侧上锁，见文件头）。 */
export function emitSplitSync(side: SplitSide, line: number, now = Date.now()): void {
  if (!Number.isFinite(line) || line < 1) return;
  const target = other(side);
  lockedUntil[target] = now + SPLIT_SYNC_LOCK_MS;
  for (const fn of listeners[target]) fn(line);
}

/** 主动给某侧上锁：该侧即将被程序化滚动，这次滚动不该外发给对侧。 */
export function lockSplitSide(side: SplitSide, now = Date.now()): void {
  lockedUntil[side] = now + SPLIT_SYNC_LOCK_MS;
}

/** 本侧是否正被对侧程序化拖动（是则本侧的 scroll 不要外发，否则回环）。 */
export function splitSyncLocked(side: SplitSide, now = Date.now()): boolean {
  return now < lockedUntil[side];
}

/** 清空订阅与锁（测试用；运行时请用 subscribe 返回的退订函数）。 */
export function resetSplitSync(): void {
  listeners.editor.clear();
  listeners.preview.clear();
  lockedUntil.editor = 0;
  lockedUntil.preview = 0;
}

/** 升序数组里「取值 <= key 的最后一个」下标；无匹配返回 -1。 */
function lastAtOrBefore(n: number, key: number, get: (i: number) => number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (get(mid) <= key) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 编辑器滚到第 line 行 → 预览该对齐到哪个锚点（最后一个起始行不超过 line 的块）。 */
export function anchorIndexForLine(anchors: ReadonlyArray<SplitAnchor>, line: number): number {
  return lastAtOrBefore(anchors.length, line, (i) => anchors[i]!.line);
}

/** 预览滚到 top 像素 → 取当前顶块（最后一个顶边不超过 top 的块）。 */
export function anchorIndexForTop(anchors: ReadonlyArray<SplitAnchor>, top: number): number {
  return lastAtOrBefore(anchors.length, top, (i) => anchors[i]!.top);
}
