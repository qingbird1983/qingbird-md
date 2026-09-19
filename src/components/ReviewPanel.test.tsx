// @vitest-environment happy-dom
// S4 面板本体冒烟：把「壳」变成「完整面板」之后，三种状态都要能挂上去。
//
// 为什么必须挂载而不是只测子组件：面板是条件渲染的多分支 JSX，任一分支写错
// tsc 不一定拦得住，挂上去就会炸（与 SettingsModal.test.tsx 同一理由）。
// 这里钉住的是三件用户看得见的事：
//   1. 原文模式 → 空态引导卡，且进度时间线明说"未运行"（不是静默什么都不显示）
//   2. 有译文 + 查出问题 → 出**可点列表**，能跳的能点、跳不了的**禁用且写明原因**
//   3. 未配大模型 → 语义核查入口禁用 + 明示原因（§七.1 R2「不静默降级」）
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 检查结果与调用次数放在 `vi.hoisted` 持有：`vi.mock` 会被提升到 import 之前执行，
// 工厂里引用模块顶层常量会撞 TDZ（SettingsModal.test.tsx 同款坑）。用 holder 而不是
// 把数据写死进工厂，是为了能断言「流式期根本没调过 IPC」。
const h = vi.hoisted(() => ({
  calls: 0,
  /** 最近一次 checkTranslation 的实参列表（P0-2：钉住 mode/target 必须传）。 */
  lastArgs: null as unknown[] | null,
  issues: [] as Issue[],
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      checkTranslation: async (...args: unknown[]) => {
        h.calls += 1;
        h.lastArgs = args;
        return h.issues;
      },
    },
  };
});

import ReviewPanel from "./ReviewPanel";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { resetSplitSync } from "../lib/splitSync";
import type { DocDTO, Issue } from "../types/ipc";

/** run=7 在假预览里有锚点（可跳）；run=99 故意没有（非 actionable）。 */
const ISSUES: Issue[] = [
  {
    run: 7,
    kind: "OmittedUntranslated",
    severity: "Warning",
    src_excerpt: "Hello",
    dst_excerpt: "",
    src_line: 12,
    dst_line: 14,
  },
  {
    run: 99,
    kind: "StructureMismatch",
    severity: "Warning",
    src_excerpt: "World",
    dst_excerpt: "World",
    src_line: 40,
    dst_line: 41,
  },
];

const DOC: DocDTO = {
  name: "demo.md",
  path: "F:/tmp/demo.md",
  content: "# t\n\nHello\n\nWorld\n",
  base_dir: null,
  char_count: 20,
  line_count: 5,
  encoding: "UTF-8",
  mtime: null,
  parse: { html: "", outline: [] },
};

let host: HTMLDivElement;
let root: Root;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function until(cond: () => boolean, frames = 10): Promise<boolean> {
  for (let i = 0; i < frames && !cond(); i += 1) {
    await act(async () => {
      await nextFrame();
    });
  }
  return cond();
}

/** 假预览：只有 run=7 的锚点，用来分别命中"可跳"与"锚点缺失"。 */
const mountPreview = (present = true) => {
  document.body.innerHTML = present
    ? `<div class="preview-scroll"><div class="markdown-body"><p data-ri="7">Hello</p></div></div>`
    : `<div class="markdown-body"><p data-ri="7">Hello</p></div>`;
  document.body.appendChild(host);
};

const cards = () => Array.from(host.querySelectorAll<HTMLLIElement>(".review-issue"));
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".review-issue-hit"));
const stepSummary = () => host.querySelector(".review-step-summary")?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
  resetSplitSync();
  h.calls = 0;
  h.lastArgs = null;
  h.issues = ISSUES;
  host = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(host);
  root = createRoot(host);
  // 未配置大模型（credsFor 读到 settings 为 null → 空凭据）
  useSettingsStore.setState({ settings: null });
  useTranslationStore.setState({ status: "idle" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useDocStore.setState({ doc: null, translations: new Map(), mode: "original" });
  useTranslationStore.setState({ status: "idle" });
});

const renderPanel = () => act(() => root.render(<ReviewPanel />));

describe("ReviewPanel 冒烟", () => {
  it("原文模式：空态引导卡 + 时间线明说「未运行」+ 语义入口禁用并给出原因", async () => {
    mountPreview();
    useDocStore.setState({ doc: DOC, translations: new Map(), mode: "original" });
    renderPanel();

    expect(host.querySelector(".review-empty")).not.toBeNull();
    expect(cards().length).toBe(0);
    expect(stepSummary()).toBe("确定性检查 · 未运行");

    const start = host.querySelector<HTMLButtonElement>(".review-start-btn")!;
    expect(start.disabled).toBe(true);
    // 不静默降级：必须写明去哪里配
    expect(host.querySelector(".review-start-hint")!.textContent).toContain("设置 · LLM");
  });

  it("有译文 + 查出问题：出可点列表，可跳的能点、锚点缺失的禁用且写明原因", async () => {
    mountPreview();
    useDocStore.setState({
      doc: DOC,
      translations: new Map([[7, "你好"]]),
      mode: "translation",
    });
    renderPanel();

    expect(await until(() => cards().length === 2)).toBe(true);
    expect(stepSummary()).toBe("确定性检查 · 2 处");
    expect(host.querySelector(".review-checks-bar")!.textContent).toContain("2");

    // 等渲染期探测落定（rAF）
    expect(await until(() => host.querySelector(".review-issue.blocked") !== null)).toBe(true);

    expect(buttons()[0]!.disabled).toBe(false);
    expect(buttons()[1]!.disabled).toBe(true);
    // 禁用 ≠ 隐藏：两条都在，且第二条说出了为什么点不动
    expect(cards().length).toBe(2);
    expect(cards()[1]!.querySelector(".review-issue-hint")!.textContent).toContain("找不到对应锚点");
  });

  it("预览未挂载（源码单栏）：整个列表都判为不可跳，但一条都不少", async () => {
    mountPreview(false);
    useDocStore.setState({
      doc: DOC,
      translations: new Map([[7, "你好"]]),
      mode: "translation",
    });
    renderPanel();

    expect(await until(() => cards().length === 2)).toBe(true);
    expect(await until(() => host.querySelectorAll(".review-issue.blocked").length === 2)).toBe(true);
    for (const b of buttons()) {
      expect(b.disabled).toBe(true);
      expect(b.title).toContain("源码视图");
    }
  });

  it("检查跑完后动作区仍有语义核查入口（不随内容滚走）", async () => {
    mountPreview();
    useDocStore.setState({
      doc: DOC,
      translations: new Map([[7, "你好"]]),
      mode: "translation",
    });
    renderPanel();
    expect(await until(() => cards().length === 2)).toBe(true);

    const actions = host.querySelector(".review-actions")!;
    expect(actions.querySelector(".review-start-btn")).not.toBeNull();
    // 滚动区与动作区是兄弟节点：动作区不在 .review-body 里面
    expect(host.querySelector(".review-body .review-start-btn")).toBeNull();
  });

  it("翻译进行中：不跑检查、也不展示上一版译文的清单（避免照假清单改译法）", async () => {
    mountPreview();
    // 译文表已有内容（流式中间态）且状态是 running
    useDocStore.setState({
      doc: DOC,
      translations: new Map([[7, "你好"]]),
      mode: "translation",
    });
    useTranslationStore.setState({ status: "running" });
    renderPanel();

    // 给足时间：若实现没拦，IPC 早就被调了
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });

    expect(h.calls).toBe(0);
    expect(cards().length).toBe(0);
    expect(stepSummary()).toBe("确定性检查 · 等翻译停");
    expect(host.querySelector(".review-checks-bar")).toBeNull();
  });

  it("翻译停下后自动补跑一次（不靠用户手动刷新）", async () => {
    mountPreview();
    useDocStore.setState({
      doc: DOC,
      translations: new Map([[7, "你好"]]),
      mode: "translation",
    });
    useTranslationStore.setState({ status: "running" });
    renderPanel();
    await act(async () => {
      await nextFrame();
    });
    expect(h.calls).toBe(0);

    await act(async () => {
      useTranslationStore.setState({ status: "idle" });
    });

    expect(await until(() => cards().length === 2)).toBe(true);
    expect(h.calls).toBe(1);
    expect(stepSummary()).toBe("确定性检查 · 2 处");
    // P0-2：检查必须带上模式与方向——键空间由 mode 决定（translation =
    // data-ri run 空间），方向决定可译判定；缺了就在错误空间里对号。
    expect(h.lastArgs?.[2]).toBe("translation");
    expect(h.lastArgs?.[3]).toBe("zh");
  });
});
