// 打字机缓冲：把"按完成序到达"的译文块重排成"按文档序放行"。
//
// 引擎并发 worker 先完成先发事件，直接上屏会出现"哪块先译完哪块先出现"。
// 这里用序列游标 + 等位缓冲实现严格文档序：到货 index === seq[pos]（本轮
// 放行序列的下一个）的块立即放行并把等位中连续命中的后续块一并放行；其余
// 块在 pending 等位。网络吞吐不变，纯显示层重排。全部不可变更新
// （zustand setState 惯例）。
//
// 放行序列不是"基址起连续 +1"（终审 C1 修复）：窗口化按需 + 文献区段跳过
// 使收集索引带缺口（如 [1,3,5]），scalar 基址游标在第一个缺口处永久停摆，
// 后续 partial 只能等 done 兜底（≥400ms + 整树重渲）。typewriterStart 改收
// 本轮完整收集索引序列（后端 TranslateStart.indices，与 spawn_translation
// 同一份、文档序），pos 沿序列推进。first_index 标量基址由此作废。
//
// fromCache 随条目走放行链路（放行批次可能混着缓存/网络单元），由 reveal
// 层决定是否跳过打字动画。
export interface Released {
  index: number;
  text: string;
  fromCache: boolean;
}

export interface TypewriterState {
  /** 本轮放行序列（文档序收集索引，可带缺口） */
  seq: number[];
  /** 已放行前缀在 seq 中的位置（exclusive）：seq[0..pos) 全部已放行 */
  pos: number;
  /** 暂未轮到（序号超前 / 不在本轮序列中）的到货块，等位中；重置时清空 */
  pending: Map<number, Released>;
}

export function typewriterStart(indices: number[] = []): TypewriterState {
  return { seq: indices.slice(), pos: 0, pending: new Map() };
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
  let pos = s.pos;
  // 沿放行序列推进：seq[pos] 已到货 → 放行并看下一位；缺口未到则停。
  while (pos < s.seq.length && pending.has(s.seq[pos])) {
    released.push(pending.get(s.seq[pos])!);
    pending.delete(s.seq[pos]);
    pos += 1;
  }
  return { state: { seq: s.seq, pos, pending }, released };
}
