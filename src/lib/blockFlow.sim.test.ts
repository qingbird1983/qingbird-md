// 临时集成模拟：typewriter 放行 → 块组装 → reveal 打字，乱序批次 + 失败事件下的队列行为。
// 模拟后端：30 块 × 平均 2.5 run ≈ 75 run，8 run/批，6 路并发，乱序完成。
import { describe, expect, it } from "vitest";
import { typewriterPush, typewriterStart, type Released } from "./typewriter";
import { revealIdle, revealPush, revealStart, revealTick, type RevealBlock, type RevealRun } from "./reveal";

// ── 复制 store 的组装逻辑（与 useTranslationStore.ts handlePartial 同构）──
function simulate(
  indices: number[],
  indicesBlocks: number[],
  partials: Array<{ index: number; text: string; failed?: boolean }>,
  region: [number, number] = [0, Infinity],
) {
  let tw = typewriterStart(indices);
  let rv = revealStart(region[0], region[1]);
  const blockOfRun = new Map<number, number>();
  const blockRunCounts = new Map<number, number>();
  const blockAssembly = new Map<number, Map<number, Released>>();
  for (let i = 0; i < indices.length; i++) {
    blockOfRun.set(indices[i], indicesBlocks[i]);
    blockRunCounts.set(indicesBlocks[i], (blockRunCounts.get(indicesBlocks[i]) ?? 0) + 1);
  }
  let queued = 0;
  let failed = 0;
  for (const p of partials) {
    if (p.failed) failed += 1;
    const next = typewriterPush(tw, p.index, p.text, false);
    tw = next.state;
    for (const r of next.released) {
      const b = blockOfRun.get(r.index)!;
      let bucket = blockAssembly.get(b);
      if (!bucket) { bucket = new Map(); blockAssembly.set(b, bucket); }
      bucket.set(r.index, r);
      if (bucket.size < blockRunCounts.get(b)!) continue;
      blockAssembly.delete(b);
      const rels = Array.from(bucket.values()).sort((x, y) => x.index - y.index);
      const runs: RevealRun[] = rels.map((rel) => ({
        index: rel.index,
        text: rel.text,
        failed: p.failed && rel.index === p.index,
      }));
      const out = revealPush(rv, { index: b, runs } as RevealBlock, false);
      rv = out.state;
      if (out.commits.length === 0) queued += 1;
    }
  }
  return { tw, rv, queued, assemblyLeft: blockAssembly.size, failed };
}

function mkDoc(blocks: number, runsPerBlock: number[]): { indices: number[]; indicesBlocks: number[] } {
  const indices: number[] = [];
  const indicesBlocks: number[] = [];
  let ri = 0;
  for (let b = 0; b < blocks; b++) {
    for (let k = 0; k < runsPerBlock[b]; k++) {
      indices.push(ri++);
      indicesBlocks.push(b);
    }
  }
  return { indices, indicesBlocks };
}

function drainAll(rv: ReturnType<typeof revealStart>): number {
  let s = rv;
  let done = 0;
  for (let ms = 16; ms < 60000 && !revealIdle(s); ms += 16) {
    const t = revealTick(s, ms);
    s = t.state;
    if (t.commits.some((c) => c.kind === "done")) done += 1;
  }
  return done;
}

describe("块组装 + reveal 集成（乱序批次 + 失败事件）", () => {
  it("乱序 partial 全部到齐后，所有块都进队列并打完（无卡死）", () => {
    const runsPerBlock = Array.from({ length: 30 }, (_, i) => 1 + (i % 4));
    const { indices, indicesBlocks } = mkDoc(30, runsPerBlock);
    const partials = indices.map((idx) => ({ index: idx, text: `T${idx}` }));
    partials.sort((a, b) => ((a.index * 7) % 31) - ((b.index * 7) % 31));
    const r = simulate(indices, indicesBlocks, partials);
    expect(r.tw.pending.size).toBe(0);
    expect(r.assemblyLeft).toBe(0);
    expect(r.queued).toBe(30);
    expect(revealIdle(r.rv)).toBe(false);
    expect(drainAll(r.rv)).toBe(30);
  });

  it("失败 run（failed 事件携带原文）→ 照常放行，无卡死，全块打完", () => {
    // 复现用户症状的修复回归：某 run 引擎失败（Failed 事件此前被 bridge 丢弃
    // → 前端等位卡死）。修复后 Failed 携带原文照常放行 → 全程无卡。
    const runsPerBlock = Array.from({ length: 30 }, (_, i) => 1 + (i % 4));
    const { indices, indicesBlocks } = mkDoc(30, runsPerBlock);
    const partials = indices.map((idx) => ({ index: idx, text: `T${idx}`, failed: idx === 17 }));
    partials.sort((a, b) => ((a.index * 7) % 31) - ((b.index * 7) % 31));
    const r = simulate(indices, indicesBlocks, partials);
    expect(r.failed).toBe(1);
    expect(r.tw.pending.size).toBe(0); // 失败 run 已放行（原文回退）
    expect(r.assemblyLeft).toBe(0); // 全部块凑齐
    expect(r.queued).toBe(30); // 所有块都进打字队列
    expect(drainAll(r.rv)).toBe(30); // 全部打完
  });

  it("真缺失（某 run 完全无事件）→ 其后 pending 卡死，等 done 兜底（残余场景）", () => {
    const runsPerBlock = [2, 2, 2, 2, 2];
    const { indices, indicesBlocks } = mkDoc(5, runsPerBlock);
    const missing = 5; // 该 run 无任何事件（事件通道级丢失，非引擎失败）
    const partials = indices.filter((i) => i !== missing).map((idx) => ({ index: idx, text: `T${idx}` }));
    const r = simulate(indices, indicesBlocks, partials);
    expect(r.tw.pending.size).toBeGreaterThan(0);
    expect(r.assemblyLeft).toBe(1);
    expect(r.queued).toBe(2); // 缺失前的块已进队，其后全部等位
  });
});
