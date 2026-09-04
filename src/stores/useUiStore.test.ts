// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MIN_CONTENT_WIDTH, contentWidthPx } from "../lib/contentWidth";
import { useUiStore } from "./useUiStore";

// store 是模块级单例：直接 setState 复位与本文件相关的切片。
const reset = () => {
  localStorage.clear();
  useUiStore.setState({ contentWidth: "normal", customWidth: null });
};

describe("useUiStore 正文宽度（自定义拖宽档）", () => {
  beforeEach(reset);

  it("setCustomWidth：落 store + localStorage，保底钳 480", () => {
    useUiStore.getState().setCustomWidth(853);
    expect(useUiStore.getState().customWidth).toBe(853);
    expect(localStorage.getItem("qb.content-width-custom")).toBe("853");

    useUiStore.getState().setCustomWidth(100);
    expect(useUiStore.getState().customWidth).toBe(MIN_CONTENT_WIDTH);
  });

  it("setContentWidth：回档位并清自定义（store 与 localStorage 两处）", () => {
    useUiStore.getState().setCustomWidth(900);
    useUiStore.getState().setContentWidth("wide");
    expect(useUiStore.getState().contentWidth).toBe("wide");
    expect(useUiStore.getState().customWidth).toBeNull();
    expect(localStorage.getItem("qb.content-width-custom")).toBeNull();
  });

  it("cycleContentWidth：同样清自定义（工具栏循环 = 回档位）", () => {
    useUiStore.getState().setCustomWidth(900);
    useUiStore.getState().cycleContentWidth();
    expect(useUiStore.getState().customWidth).toBeNull();
    expect(useUiStore.getState().contentWidth).toBe("wide"); // normal 的下一档
  });

  it("contentWidthPx 合成：null 跟随档位，自定义优先", () => {
    const s0 = useUiStore.getState();
    expect(contentWidthPx(s0.contentWidth, s0.customWidth)).toBe(794);
    useUiStore.getState().setCustomWidth(1000);
    const s1 = useUiStore.getState();
    expect(contentWidthPx(s1.contentWidth, s1.customWidth)).toBe(1000);
  });
});
