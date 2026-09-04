import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH_PX,
  clampContentWidth,
  contentWidthPx,
  edgeDragWidth,
} from "./contentWidth";

describe("clampContentWidth", () => {
  it("低于下限钳到 480", () => {
    expect(clampContentWidth(100, 1200)).toBe(480);
  });

  it("高于面板宽钳到 maxPx（上限随窗口实时走）", () => {
    expect(clampContentWidth(5000, 1400)).toBe(1400);
  });

  it("区间内原样返回", () => {
    expect(clampContentWidth(794, 1400)).toBe(794);
  });

  it("maxPx 比 MIN 还小（极端窄栏）仍保底 480", () => {
    expect(clampContentWidth(490, 300)).toBe(480);
  });
});

describe("contentWidthPx", () => {
  it("无自定义 → 跟随四档", () => {
    expect(contentWidthPx("normal", null)).toBe(794);
    expect(contentWidthPx("wide", null)).toBe(1000);
    expect(contentWidthPx("compact", null)).toBe(640);
    expect(contentWidthPx("full", null)).toBe(1200);
  });

  it("自定义优先于档位", () => {
    expect(contentWidthPx("normal", 853)).toBe(853);
  });

  it("四档 px 表与菜单档位一致（单一事实来源）", () => {
    expect(CONTENT_WIDTH_PX).toEqual({ compact: 640, normal: 794, wide: 1000, full: 1200 });
  });
});

describe("edgeDragWidth", () => {
  it("右缘：dx>0 拉宽", () => {
    expect(edgeDragWidth("right", 794, 60, 1400)).toBe(854);
  });

  it("左缘：dx<0（向左拖）拉宽", () => {
    expect(edgeDragWidth("left", 794, -60, 1400)).toBe(854);
  });

  it("左缘：dx>0（向右拖）拉窄", () => {
    expect(edgeDragWidth("left", 794, 100, 1400)).toBe(694);
  });

  it("钳到下限 480", () => {
    expect(edgeDragWidth("left", 500, 400, 1400)).toBe(480);
  });

  it("钳到面板宽 maxPx（留白归零即上限）", () => {
    expect(edgeDragWidth("right", 1200, 900, 1300)).toBe(1300);
  });
});
