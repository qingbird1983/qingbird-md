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
    introPhase: "idle",
    showNav: true,
    showOutline: false,
    outlineSide: "right",
    outlineWidth: 200,
    showReview: false,
    reviewSide: "right",
    reviewWidth: 320,
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

// AI 核查面板开关：v1 冲突（两面板同侧）自动把大纲翻到对侧，给出四栏并存。
describe("useUiStore AI 核查面板 toggleReview 冲突化解", () => {
  beforeEach(reset);

  it("默认收起、右停靠、宽 320", () => {
    const s = useUiStore.getState();
    expect(s.showReview).toBe(false);
    expect(s.reviewSide).toBe("right");
    expect(s.reviewWidth).toBe(320);
  });

  it("无冲突时开起 review 不动大纲（大纲本就开着、在对侧）", () => {
    useUiStore.setState({ showOutline: true, outlineSide: "left", reviewSide: "right" });
    useUiStore.getState().toggleReview();
    expect(useUiStore.getState().showReview).toBe(true);
    expect(useUiStore.getState().outlineSide).toBe("left"); // 未被翻动
  });

  it("冲突时开起 review：大纲自动翻到对侧，且写回 localStorage", () => {
    useUiStore.setState({ showOutline: true, outlineSide: "right", reviewSide: "right" });
    useUiStore.getState().toggleReview();
    expect(useUiStore.getState().showReview).toBe(true);
    expect(useUiStore.getState().outlineSide).toBe("left"); // 翻到对侧
    expect(localStorage.getItem("qb.outline-side")).toBe("left"); // 持久化
  });

  it("关起 review 不动大纲（即便此时同侧，也是用户的主动选择）", () => {
    useUiStore.setState({ showReview: true, showOutline: true, outlineSide: "right", reviewSide: "right" });
    useUiStore.getState().toggleReview();
    expect(useUiStore.getState().showReview).toBe(false);
    expect(useUiStore.getState().outlineSide).toBe("right"); // 未被拽回
  });

  it("outline 关闭时开起 review：不触发翻边逻辑（无冲突可翻）", () => {
    useUiStore.setState({ showOutline: false, reviewSide: "right" });
    useUiStore.getState().toggleReview();
    expect(useUiStore.getState().showReview).toBe(true);
    expect(useUiStore.getState().outlineSide).toBe("right"); // 默认值，未被动
  });

  it("reviewSide 持久化（localStorage）", () => {
    useUiStore.getState().setReviewSide("left");
    expect(useUiStore.getState().reviewSide).toBe("left");
    expect(localStorage.getItem("qb.review-side")).toBe("left");
  });

  it("setReviewSide 冲突时同样自动翻大纲（与 toggleReview 共享不变量）", () => {
    useUiStore.setState({ showReview: true, showOutline: true, outlineSide: "right" });
    useUiStore.getState().setReviewSide("right");
    expect(useUiStore.getState().reviewSide).toBe("right");
    expect(useUiStore.getState().outlineSide).toBe("left"); // 自动翻到对侧
    expect(localStorage.getItem("qb.outline-side")).toBe("left");
  });

  it("setReviewSide 无冲突时不动大纲", () => {
    useUiStore.setState({ showReview: true, showOutline: true, outlineSide: "left" });
    useUiStore.getState().setReviewSide("right");
    expect(useUiStore.getState().outlineSide).toBe("left"); // 未被翻动
  });
});

// 启动仪式感动画状态机：乱序调用只能空转，不能把界面拽回起始态。
describe("useUiStore 启动动画 introPhase 状态机", () => {
  beforeEach(reset);

  it("初始为 idle（窗口 reveal 前的起始态）", () => {
    expect(useUiStore.getState().introPhase).toBe("idle");
  });

  it("正常路径 idle → playing → done", () => {
    useUiStore.getState().startIntro();
    expect(useUiStore.getState().introPhase).toBe("playing");
    useUiStore.getState().finishIntro();
    expect(useUiStore.getState().introPhase).toBe("done");
  });

  it("skipIntro：idle → skipped，之后 start/finish 都无效", () => {
    useUiStore.getState().skipIntro();
    expect(useUiStore.getState().introPhase).toBe("skipped");
    useUiStore.getState().startIntro();
    expect(useUiStore.getState().introPhase).toBe("skipped");
    useUiStore.getState().finishIntro();
    expect(useUiStore.getState().introPhase).toBe("skipped");
  });

  it("finishIntro 在 idle 下无效（不能跳过 playing）", () => {
    useUiStore.getState().finishIntro();
    expect(useUiStore.getState().introPhase).toBe("idle");
  });

  it("done 为终态：start/skip/finish 全部空转", () => {
    useUiStore.getState().startIntro();
    useUiStore.getState().finishIntro();
    useUiStore.getState().startIntro();
    useUiStore.getState().skipIntro();
    useUiStore.getState().finishIntro();
    expect(useUiStore.getState().introPhase).toBe("done");
  });
});
