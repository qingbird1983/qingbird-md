// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// AI 核查面板开关：2026-09-19 二轮定案——同侧共存，**不翻边**。同侧时渲染层
// 让核查占外侧列 + row 2/4 高栏、大纲栏顺势内移一列（App.tsx outlineCol），
// store 里 side 纯属各自偏好，互不干涉。
describe("useUiStore AI 核查面板开关与停靠侧（同侧共存，不翻边）", () => {
  beforeEach(reset);

  it("默认收起、右停靠、宽 320", () => {
    const s = useUiStore.getState();
    expect(s.showReview).toBe(false);
    expect(s.reviewSide).toBe("right");
    expect(s.reviewWidth).toBe(320);
  });

  it("toggleReview 纯开关：开起时即便与大纲同侧，也不动大纲", () => {
    useUiStore.setState({ showOutline: true, reviewSide: "right" });
    useUiStore.getState().setOutlineSide("right"); // 走真动作，先让 localStorage 有值
    useUiStore.getState().toggleReview();
    const s = useUiStore.getState();
    expect(s.showReview).toBe(true);
    expect(s.outlineSide).toBe("right"); // 不翻边：同侧共存由渲染层化解
    expect(localStorage.getItem("qb.outline-side")).toBe("right"); // 未被改写
  });

  it("toggleReview 关起不动大纲", () => {
    useUiStore.setState({ showReview: true, showOutline: true, outlineSide: "left" });
    useUiStore.getState().toggleReview();
    expect(useUiStore.getState().showReview).toBe(false);
    expect(useUiStore.getState().outlineSide).toBe("left");
  });

  it("reviewSide 持久化（localStorage）", () => {
    useUiStore.getState().setReviewSide("left");
    expect(useUiStore.getState().reviewSide).toBe("left");
    expect(localStorage.getItem("qb.review-side")).toBe("left");
  });

  it("setReviewSide 只改自己，outlineSide 与大纲开关都不受牵连", () => {
    useUiStore.setState({ showReview: true, showOutline: true, outlineSide: "right" });
    useUiStore.getState().setReviewSide("right");
    const s = useUiStore.getState();
    expect(s.reviewSide).toBe("right");
    expect(s.outlineSide).toBe("right"); // 同侧合法，不翻边
    expect(s.showOutline).toBe(true);
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

// REL-9 兜底：隐私模式 / 存储被禁时 localStorage 读写会抛 SecurityError——
// 读在 store 模块初始化时跑（四个 load*），旧实现一炸就是整个启动白屏；
// 写散在五个动作里，一炸就是点击无响应。全部必须 try/catch 降级：
// 读回默认值，写只影响落盘、内存态照常切换。
describe("useUiStore localStorage 异常兜底（隐私模式不白屏）", () => {
  function throwingStorage(): Storage {
    const boom = (): never => {
      throw new Error("存储不可用（隐私模式模拟）");
    };
    // 只桩 useUiStore 用到的三个方法
    return { getItem: boom, setItem: boom, removeItem: boom } as unknown as Storage;
  }

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("读取抛异常：store 仍能创建，宽度/停靠侧回默认（修复前模块初始化直接炸）", async () => {
    vi.stubGlobal("localStorage", throwingStorage());
    const fresh = await import("./useUiStore");
    const s = fresh.useUiStore.getState();
    expect(s.contentWidth).toBe("normal");
    expect(s.customWidth).toBeNull();
    expect(s.outlineSide).toBe("right");
    expect(s.reviewSide).toBe("right");
  });

  it("写入抛异常：动作不抛、内存态照常切换", async () => {
    vi.stubGlobal("localStorage", throwingStorage());
    const fresh = await import("./useUiStore");
    const store = fresh.useUiStore.getState();
    expect(() => store.setContentWidth("wide")).not.toThrow();
    expect(fresh.useUiStore.getState().contentWidth).toBe("wide");
    expect(fresh.useUiStore.getState().customWidth).toBeNull();
    expect(() => store.cycleContentWidth()).not.toThrow();
    expect(fresh.useUiStore.getState().contentWidth).toBe("full"); // wide 的下一档
    expect(() => store.setOutlineSide("left")).not.toThrow();
    expect(fresh.useUiStore.getState().outlineSide).toBe("left");
    expect(() => store.setReviewSide("left")).not.toThrow();
    expect(fresh.useUiStore.getState().reviewSide).toBe("left");
    expect(() => store.setCustomWidth(900)).not.toThrow();
    expect(fresh.useUiStore.getState().customWidth).toBe(900);
  });
});
