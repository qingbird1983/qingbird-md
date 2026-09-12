// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MIN_CONTENT_WIDTH, contentWidthPx } from "../lib/contentWidth";
import { useUiStore } from "./useUiStore";

// store 是模块级单例：直接 setState 复位与本文件相关的切片。
const reset = () => {
  localStorage.clear();
  useUiStore.setState({
    contentWidth: "normal",
    customWidth: null,
    sidebarWidth: 240,
    bootWidthPending: true,
  });
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

// 首启形态：全新安装打开是空白欢迎页，不该出现「侧栏默认 240 宽 / 空大纲栏」。
describe("useUiStore 首次启动的默认面板形态", () => {
  beforeEach(reset);

  it("大纲默认收起（首屏是欢迎页，开着只是白占一列）", () => {
    expect(useUiStore.getState().showOutline).toBe(false);
  });

  it("applyDefaultSidebarWidth：没宽度记忆就回填默认最小宽度，且只回填一次", () => {
    useUiStore.getState().applyDefaultSidebarWidth(199);
    expect(useUiStore.getState().sidebarWidth).toBe(199);
    // 之后的二次实测（字体加载等引起的 baseX 变化）不许再改宽度
    useUiStore.getState().applyDefaultSidebarWidth(230);
    expect(useUiStore.getState().sidebarWidth).toBe(199);
  });

  it("applyDefaultSidebarWidth：拖过 / 快照回填过就不再回填", () => {
    useUiStore.getState().setSidebarWidth(300); // 用户拖拽或休眠快照恢复
    useUiStore.getState().applyDefaultSidebarWidth(199);
    expect(useUiStore.getState().sidebarWidth).toBe(300);
  });

  it("applyDefaultSidebarWidth：非正值忽略，且不关掉「待回填」", () => {
    useUiStore.getState().applyDefaultSidebarWidth(0); // 测量未完成
    expect(useUiStore.getState().sidebarWidth).toBe(240);
    expect(useUiStore.getState().bootWidthPending).toBe(true);
  });
});
