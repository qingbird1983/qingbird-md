// 层级引线接线守卫：CSS 规则 + 预览容器类名 + 设置面板入口，三处缺一即失效。
//
// 为什么要有它：这是一个「三处接线型」功能——CSS 里少一条规则、PreviewView 忘了
// 挂类名、设置面板少一个开关，**都不会报错**，只表现为「用户以为关掉了线还在」
// 或者「设置里改了半天没反应」。tsc 看不见，只能靠读源码钉住。
//
// 第二组断言钉的是**共线**这件事：圆点、勾选框、引线必须落在同一条中线上，而中线
// 位置本身（-0.763em = 原生 disc 的实测中线）是引擎常量，**源码里看不出对错**。
// 所以这里退一步，把「三者同取 --md-marker-x，且左缘偏移恰好是自身宽度的一半」
// 这条恒等式钉死——只要有人改了盒子宽度却没同步左缘偏移，测试立刻变红。
// （中线数值本身由 headless Chromium 实测得出，改样式后需重跑测量，见提交说明。）
//
// 本文件必须是 **node 环境**（默认）：happy-dom 下 `import.meta.url` 不是 file:
// 协议，fileURLToPath 会抛 "The URL must be of scheme file"（同 scrollbarUnified）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
/** 读 CSS 并剥注释：注释里会写示例选择器，不剥掉断言全对不上。 */
const CSS = read("../styles/markdown.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某条规则的声明体（本项目 CSS 扁平、无嵌套）。 */
function bodyOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m?.[1] ?? "";
}

const GUIDE_LI = ".markdown-body:not(.no-list-guide) ul > li:not(.task)";
const GUIDE = `${GUIDE_LI}::after`;
/** 末项规则：`:last-child` 必须落在 `::after` **之前**（伪类属于元素，伪元素在最后）。 */
const GUIDE_LAST = `${GUIDE_LI}:last-child::after`;

describe("层级引线接线", () => {
  it("关掉时整段规则不生成（.no-list-guide 门控，而不是 opacity 隐藏）", () => {
    // 门控写在选择器上 → 关掉后连伪元素都不存在，不留可命中的透明靶子。
    // 只门控**引线**：圆点自绘后与开关无关，关引线不能让圆点一起消失。
    expect(bodyOf(GUIDE).length, "竖线规则必须由 .no-list-guide 门控").toBeGreaterThan(0);
    expect(CSS).not.toMatch(/\.no-list-guide[^{]*\{[^}]*opacity/);
    expect(
      /\.no-list-guide[^{]*li[^{]*::before/.test(CSS),
      "圆点不得被开关门控——关掉引线后圆点仍要在",
    ).toBe(false);
  });

  it("竖线画在 li::after 上：能逐项定端点，末项不出线头", () => {
    const last = bodyOf(GUIDE_LAST);
    expect(last, "缺末项规则 → 列表尾巴会垂一根多余的线头").toContain("height");
    // 非末项必须桥过「本项底 → 下一项顶」的空白，否则线是断的。空白不止 li+li 的
    // 0.25em：末位块的下边距会从 li 里逃逸（嵌套 ul 0.9em / 代码卡 1.2em），
    // 实测嵌套列表后 level-1 的线断 10px —— 所以这里要的是 1em，不是 0.25em。
    expect(bodyOf(GUIDE), "竖线要用负 bottom 桥过项间距与逃逸边距").toMatch(/bottom:\s*-1em/);
  });

  it("圆点自绘：用自绘而非原生 disc，中线才受 CSS 约束", () => {
    const dot = bodyOf(".markdown-body ul > li:not(.task)::before");
    expect(dot, "圆点必须自绘（原生 disc 的中线是引擎常量，CSS 管不住）").toBeTruthy();
    expect(dot).toContain("left: var(--md-marker-x)");
    expect(dot, "点要对到中线上，而不是把盒子左上角放到中线上").toContain(
      "translate(-50%, -50%)",
    );
    expect(bodyOf(".markdown-body ul > li:not(.task)")).toContain("list-style: none");
  });

  it("三个标记共线：引线与圆点用同一套居中机制，勾选框左缘偏移恰为半盒宽", () => {
    const mx = /--md-marker-x:\s*(-?[\d.]+)em/.exec(bodyOf(".markdown-body"))?.[1];
    expect(mx, "缺 --md-marker-x（三者共同的中线）").toBeTruthy();

    // 引线：**必须**与圆点同机制（left 取中线 + translateX(-50%) 自居中）。
    // 写成「左缘 = 中线 − 半线宽」在 CSS 里同样成立，但 Chrome 会把未加 transform
    // 的 1px 矩形吸附到整设备像素列，圆点却走 transform 的不吸附路径 → 屏幕上差
    // 半像素，且方向随各层缩进的小数位置翻转（2026-09-27 用户报「有的偏左有的偏右」，
    // 实测偏 +0.44~+0.54 CSS px）。故这里钉机制，不钉算式。
    const guide = bodyOf(GUIDE);
    const gw = Number(/width:\s*([\d.]+)px/.exec(guide)?.[1]);
    expect(Number.isFinite(gw) && gw > 0, `引线宽度读不到: ${guide}`).toBe(true);
    expect(guide, "引线 left 必须直接取中线（半线宽交给 transform，不手让）").toContain(
      "left: var(--md-marker-x)",
    );
    expect(guide, "引线必须 translateX(-50%) 自居中，否则与圆点不同路径、会差半像素").toContain(
      "translateX(-50%)",
    );
    expect(guide).not.toMatch(/left:\s*calc\(var\(--md-marker-x\)\s*-/);

    // 勾选框：同理，左缘 = 中线 - 半盒宽
    const cb = bodyOf(".markdown-body li.task::before");
    const cbw = Number(/width:\s*([\d.]+)em/.exec(cb)?.[1]);
    expect(Number.isFinite(cbw) && cbw > 0, `勾选框宽度读不到: ${cb}`).toBe(true);
    expect(cb, "勾选框左缘必须是「中线 - 半盒宽」").toContain(
      `left: calc(var(--md-marker-x) - ${cbw / 2}em)`,
    );
  });

  it("引线同色同墨：与圆点共用淡墨 --md-marker，且首项线头挂在自己圆心", () => {
    // 「同色」是这里的不变量（线灰淡脱节就难看）；具体那枚墨多深可以调，
    // 2026-09-27 用户反馈满墨 currentColor 太深 → 收进 --md-marker 一枚令牌。
    const guide = bodyOf(GUIDE);
    const dot = bodyOf(".markdown-body ul > li:not(.task)::before");
    expect(guide, "线必须走 --md-marker").toContain("background: var(--md-marker)");
    expect(dot, "圆点必须走 --md-marker").toContain("background: var(--md-marker)");
    // 令牌本身：淡墨 = 本项文字色混向纸面，且**只声明在 li 上**（外层声明会让
    // currentColor 按正文墨定死，引用块里的点就不跟引文淡了）。
    const decl = bodyOf(".markdown-body ul > li:not(.task)");
    expect(decl, "缺 --md-marker 令牌（圆点与引线共用的那枚淡墨）").toContain("--md-marker:");
    expect(decl, "标记墨必须是淡墨：向纸面混色，不得退回满墨 currentColor 直接作色").toMatch(
      /--md-marker:\s*color-mix\(in srgb,\s*currentColor\s+\d+%,\s*var\(--bg\)\)/,
    );
    expect(decl, "必须是实色而非 alpha——线穿过圆心，半透明会在重叠处二次混色").not.toMatch(
      /--md-marker:[^;]*transparent/,
    );
    const first = bodyOf(`${GUIDE_LI}:first-child::after`);
    expect(first, "首项线头必须从自己圆点圆心（top: 1em，与 ::before 同值）起笔，不出头").toContain(
      "top: 1em",
    );
  });

  it("勾号不落在盒子层：::before 一旦写 font-size，1.05em 的盒子会跟着缩", () => {
    // 旧版把 font-size:12px 写在画盒子的 ::before 上，em 换基准 → 完成态盒子缩成
    // 12.6px（比未完成态小一圈、还高 1px）。勾号挪到 ::after 才修得掉。
    const doneBox = bodyOf(".markdown-body li.task.done::before");
    expect(doneBox, "完成态盒子层不得出现 font-size").not.toContain("font-size");
    const tick = bodyOf(".markdown-body li.task.done::after");
    expect(tick, "勾号应在 ::after 上").toContain("✓");
    expect(tick, "勾号靠 scale 缩字形，字号保持继承").toContain("scale(");
  });

  it("预览容器按开关挂类名", () => {
    const view = read("../components/PreviewView.tsx");
    expect(view).toContain('listGuide ? "markdown-body" : "markdown-body no-list-guide"');
    expect(view, "开关必须订阅 store，否则点了不生效").toContain("s.listGuide");
  });

  it("设置面板有开关且绑定 store（纯外观偏好，不走草稿/不进 Rust 设置）", () => {
    // 2026-09-24 分类重整：这一节随「层级引线」一起从 LookTab 迁到 GeneralTab
    const tab = read("../components/settings/GeneralTab.tsx");
    expect(tab, "设置面板缺开关 → 用户无法关闭").toContain("SwitchRow");
    expect(tab).toContain("层级引线");
    expect(tab).toContain("useUiStore((s) => s.listGuide)");
    expect(tab).toContain("useUiStore((s) => s.setListGuide)");
  });
});
