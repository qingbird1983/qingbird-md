// @vitest-environment happy-dom
//
// 为什么专门钉这几个行为：dev 下 Vite 把 mermaid 预打包成「入口 + 60 余 chunk」的
// 异步图，加载偶发失败；而原实现把失败**静默吞掉**（调用方是 `void ...then(...)`），
// 用户只在示例文档里看到一块空白，分不清「加载挂了」和「文档本来没图」。更要命的是
// rejected promise 被缓存在单例里 → 本次会话再也不会有图。
//
// 这里不测「mermaid 画得对不对」（那是库的事），只测我们自己的三条契约：
//   1. 文档里没有图 → 不付动态导入的代价
//   2. 加载失败 → 必须写进 DOM，且**不**写 data-rendered（失败不是终态）
//   3. 失败之后下一次调用能重试成功（rejected promise 不留在单例里）
//
// 注意：这些用例共享模块级的 mermaidPromise 单例，**声明顺序即执行顺序，不可随意调换**。

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    /** 被读过几次 initialize —— 读一次就代表真去加载 mermaid 了 */
    initializeReads: 0,
    /** true = 模拟加载失败（模块拿到了但初始化炸了，等价于依赖没就绪） */
    failLoad: true,
    render: undefined as undefined | ((id: string, src: string) => Promise<{ svg: string }>),
  };
  const api: Record<string, unknown> = {};
  // 真实 mermaid 是 default 导出；vitest 的 ESM mock 对「访问未声明的 default」会直接
  // 抛错（No "default" export is defined），所以这里补个自引用，让 mock 与真实模块的
  // 导出形态一致——否则测出来的是 harness 的脾气，不是我们的代码。
  Object.defineProperty(api, "default", { configurable: true, get: () => api });
  Object.defineProperty(api, "initialize", {
    configurable: true,
    get() {
      state.initializeReads++;
      // 返回 undefined → 调用处 `mermaid.initialize(...)` 抛 TypeError → load 链 reject
      return state.failLoad ? undefined : () => {};
    },
  });
  Object.defineProperty(api, "render", {
    configurable: true,
    get() {
      return state.render;
    },
  });
  return { api, state };
});

vi.mock("mermaid", () => h.api);
// katex / 设置 store 与本组用例无关，mock 掉以免把真实依赖（含 Tauri 调用）拖进来
vi.mock("katex", () => ({ default: { render: vi.fn() } }));
vi.mock("../stores/useSettingsStore", () => ({ isDarkTheme: () => false }));

import { renderMermaidPlaceholders } from "./previewExtensions";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("previewExtensions · mermaid 懒加载契约", () => {
  beforeEach(() => {
    h.state.initializeReads = 0;
    h.state.failLoad = true;
    h.state.render = undefined;
    document.body.innerHTML = "";
  });

  it("文档里没有 mermaid 占位符 → 完全不碰 mermaid（省一次动态导入）", async () => {
    const el = mount(`<p>只有正文和公式</p><div class="math block" data-source="x^2"></div>`);
    await renderMermaidPlaceholders(el);
    expect(h.state.initializeReads).toBe(0);
  });

  it("加载失败 → 写进 DOM 且不写 data-rendered（失败不是终态）", async () => {
    const el = mount(`<div class="mermaid" data-source="graph TD;A-->B"></div>`);

    await renderMermaidPlaceholders(el); // 不该抛：失败要就地可见，不能冒泡被调用方吞掉

    const err = el.querySelector(".mermaid-error");
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain("mermaid 加载失败");
    // 关键：留空才能让下次重试。写了就等于把「加载失败」钉成终态。
    expect(el.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBeUndefined();
  });

  it("失败之后下一次调用能重试成功（rejected promise 不留在单例里）", async () => {
    const el = mount(`<div class="mermaid" data-source="graph TD;B-->C"></div>`);

    await renderMermaidPlaceholders(el); // 第一次：失败
    expect(el.querySelector(".mermaid-error")).not.toBeNull();

    // 依赖就绪（Vite 预打包抖动过去之后就是这个状态）
    h.state.failLoad = false;
    h.state.render = async () => ({ svg: `<svg data-ok="1"></svg>` });

    await renderMermaidPlaceholders(el); // 第二次：必须重试，而不是复用上次的失败

    expect(el.querySelector(".mermaid-error")).toBeNull();
    expect(el.querySelector("svg[data-ok]")).not.toBeNull();
    expect(el.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("graph TD;B-->C");
  });
});
