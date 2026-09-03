// 打字机缓冲：把"按完成序到达"的译文块重排成"按文档序放行"。
//
// 引擎并发 worker 先完成先发事件，直接上屏会出现"哪块先译完哪块先出现"。
// 这里用游标 + 等位缓冲实现严格文档序：index === cursor 的块立即放行并把
// 连续命中的后续块一并放行；index 超前（缺口未填）的块在 pending 等位。
// 网络吞吐不变，纯显示层重排。全部不可变更新（zustand setState 惯例）。
export interface Released {
  index: number;
  text: string;
}

export interface TypewriterState {
  /** 已放行的连续前缀上界（exclusive）：0..cursor 全部已放行 */
  cursor: number;
  /** 序号 ≥ cursor 的到货块，等位中（序号 < cursor 的已放行即删） */
  pending: Map<number, string>;
}

export function typewriterStart(): TypewriterState {
  return { cursor: 0, pending: new Map() };
}

export function typewriterPush(
  s: TypewriterState,
  index: number,
  text: string,
): { state: TypewriterState; released: Released[] } {
  const pending = new Map(s.pending);
  pending.set(index, text);
  const released: Released[] = [];
  let cursor = s.cursor;
  while (pending.has(cursor)) {
    released.push({ index: cursor, text: pending.get(cursor)! });
    pending.delete(cursor);
    cursor += 1;
  }
  return { state: { cursor, pending }, released };
}
