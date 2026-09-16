import { describe, expect, it } from "vitest";
import { earlyPush, earlyStart, earlyTake } from "./earlyPartial";
import type { TranslationPartialPayload } from "../types/ipc";

function p(gen: number, index: number): TranslationPartialPayload {
  return { gen, index, text: `T${index}`, from_cache: false, streaming: false, failed: false };
}

describe("earlyPartial 早期事件缓冲（Started 未到前的 cache 命中 partial）", () => {
  it("空缓冲以首事件 gen 起头", () => {
    const b = earlyPush(earlyStart(), p(3, 0));
    expect(b.gen).toBe(3);
    expect(b.items).toHaveLength(1);
  });

  it("同 gen 追加，保持到达顺序", () => {
    let b = earlyPush(earlyStart(), p(3, 0));
    b = earlyPush(b, p(3, 2));
    b = earlyPush(b, p(3, 1));
    expect(b.items.map((x) => x.index)).toEqual([0, 2, 1]);
  });

  it("异代事件丢弃（不污染在途缓冲）", () => {
    let b = earlyPush(earlyStart(), p(3, 0));
    b = earlyPush(b, p(4, 1)); // 未知代：丢弃
    expect(b.gen).toBe(3);
    expect(b.items.map((x) => x.index)).toEqual([0]);
  });

  it("Started 落定后按 gen 取回，缓冲清空", () => {
    let b = earlyPush(earlyStart(), p(3, 0));
    b = earlyPush(b, p(3, 1));
    const { buf, items } = earlyTake(b, 3);
    expect(items.map((x) => x.index)).toEqual([0, 1]);
    expect(buf.gen).toBeNull();
    expect(buf.items).toHaveLength(0);
  });

  it("gen 不匹配取不回（保留缓冲）", () => {
    const b = earlyPush(earlyStart(), p(3, 0));
    const { buf, items } = earlyTake(b, 4);
    expect(items).toHaveLength(0);
    expect(buf).toBe(b);
  });

  it("earlyStart 即空缓冲", () => {
    const b = earlyStart();
    expect(b.gen).toBeNull();
    expect(b.items).toHaveLength(0);
  });
});
