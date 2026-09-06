// 打字机缓冲：把"按完成序到达"的译文块重排成"按文档序放行"。
//
// 引擎并发 worker 先完成先发事件，直接上屏会出现"哪块先译完哪块先出现"。
// 这里用游标 + 等位缓冲实现严格文档序：index === cursor 的块立即放行并把
// 连续命中的后续块一并放行；index 超前（缺口未填）的块在 pending 等位。
// 网络吞吐不变，纯显示层重排。全部不可变更新（zustand setState 惯例）。
//
// 窗口化 run（视口按需）的索引不从 0 开始：typewriterStart(base) 携带本轮
// 最小索引（后端 TranslateStart.first_index），游标从基址起算。
// fromCache 随条目走放行链路（放行批次可能混着缓存/网络单元），由 reveal
// 层决定是否跳过打字动画。
export interface Released {
  index: number;
  text: string;
  fromCache: boolean;
}

export interface TypewriterState {
  /** 已放行的连续前缀上界（exclusive）：base..cursor 全部已放行 */
  cursor: number;
  /** 序号 ≥ cursor 的到货块，等位中 */
  pending: Map<number, Released>;
}

export function typewriterStart(base = 0): TypewriterState {
  return { cursor: base, pending: new Map() };
}

export function typewriterPush(
  s: TypewriterState,
  index: number,
  text: string,
  fromCache: boolean,
): { state: TypewriterState; released: Released[] } {
  const pending = new Map(s.pending);
  pending.set(index, { index, text, fromCache });
  const released: Released[] = [];
  let cursor = s.cursor;
  while (pending.has(cursor)) {
    released.push(pending.get(cursor)!);
    pending.delete(cursor);
    cursor += 1;
  }
  return { state: { cursor, pending }, released };
}
