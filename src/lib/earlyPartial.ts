// 在途 run 的早期事件缓冲（翻译打字机缺位卡死的根因修复）。
//
// 问题链路：translate_document 是同步命令，spawn_translation 起 worker 后立即
// 返回 Started；worker 线程在起跑瞬间（毫秒级）先做 cache 命中扫荡并发出
// from_cache:true 的 partial——这些事件几乎必然先于 Started 的 invoke 响应到达
// 前端。此时前端 st.gen 还是上一轮、status 还是 idle，handlePartial 的
// `p.gen !== st.gen || st.status !== "running"` 护栏把它们全部丢弃。被丢弃的 run
// 在打字机放行序列 seq 中永远缺位 → seq[pos] 等不到 → 其后所有 run 永久 pending
// → 块永不满桶、reveal 队列只进缺失前的块 → 用户看到"前面几行打完就停住"；
// done 到达后 merge + 整树重建 → "一次性回填"。
//
// 本模块提供按 gen 键控的早期事件缓冲：gen 失配且空闲时先入缓冲，Started
// 响应落定（translateDocument 把 st.gen 置为新值）后按 gen 取回并回放。纯函数、
// 无 React/Tauri 依赖，可离线测试。
import type { TranslationPartialPayload } from "../types/ipc";

export interface EarlyBuffer {
  /** 缓冲所属 gen；null = 空 */
  gen: number | null;
  items: TranslationPartialPayload[];
}

export function earlyStart(): EarlyBuffer {
  return { gen: null, items: [] };
}

/** 记录在途 run 的早期事件。空缓冲以该事件 gen 起头；同 gen 追加；
 * 异代/未知代丢弃（不匹配任何在途 run，属陈旧或编造事件）。 */
export function earlyPush(buf: EarlyBuffer, p: TranslationPartialPayload): EarlyBuffer {
  if (buf.gen === null) return { gen: p.gen, items: [p] };
  if (buf.gen === p.gen) return { gen: buf.gen, items: [...buf.items, p] };
  return buf;
}

/** Started 落定后取出对应代的事件；gen 不匹配返回空且保留原缓冲
 * （留给未来代匹配，或由下一次 run 起跑时显式作废）。 */
export function earlyTake(
  buf: EarlyBuffer,
  gen: number,
): { buf: EarlyBuffer; items: TranslationPartialPayload[] } {
  if (buf.gen === gen) return { buf: earlyStart(), items: buf.items };
  return { buf, items: [] };
}
