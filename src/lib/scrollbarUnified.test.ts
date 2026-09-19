// 滚动条统一守卫：**全应用滚动条只有一个来源**（2026-09-19 定红线）。
//
// 为什么要有这个测试：滚动条原先是「按容器列白名单」的写法——名单里 9 个容器
// 各自继承 --sb-thumb、各自挂 webkit 规则。S4 新加的 `.review-body` 没登记，
// 于是当场掉回原生滚动条：异形（粗细/圆角不同）+ 常驻显示（不会静止隐形）。
// 这类 bug 不会抛错、tsc 也看不见，只能靠「不许再出现第二个来源」来兜。
//
// 现在的实现是「默认全覆盖 + 显式豁免」：`*::-webkit-scrollbar` 一次覆盖所有
// 容器，`@property --sb-thumb` 的 transparent 初值让一切容器静止隐形。因此
// **本测试的判红条件 = 有人在别处又手写了一条滚动条规则**。
//
// 本文件必须是 **node 环境**（默认）：happy-dom 下 `import.meta.url` 不是
// file: 协议，fileURLToPath 会抛 "The URL must be of scheme file"。
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

/** 滚动条真源文件（唯一允许出现 ::-webkit-scrollbar 的地方，豁免除外）。 */
const SOURCE_FILE = "11-toast-command.css";
/** 显式豁免：标签条从光学上必须隐藏滚动条。新增豁免要同时改这里与该 CSS。 */
const EXEMPT_FILES = ["02-tabs.css"];

/** 读 CSS 并剥掉注释：注释里会写示例选择器（本文件头顶就写了 `*::-webkit-scrollbar`），
 *  不剥掉的话 `blocks()` 会把注释文本当成选择器的一部分，断言全部对不上。 */
const readCss = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
const SOURCE_CSS = readCss(`../styles/${SOURCE_FILE}`);

/** 读 src/styles 下所有 CSS，去掉注释（避免注释里的示例被当成真规则）。 */
function styleFiles(): { name: string; text: string }[] {
  const dir = fileURLToPath(new URL("../styles", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((name) => ({ name, text: readCss(`../styles/${name}`) }));
}

/** 展开扁平 CSS 里的 `selector { body }` 块（本项目 CSS 无嵌套）。 */
function blocks(text: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].replace(/\s+/g, " ").trim(), body: m[2] });
  }
  return out;
}

/** 所有写了 ::-webkit-scrollbar 的规则（含 thumb / track 等派生伪元素）。 */
function scrollbarRules() {
  return styleFiles().flatMap(({ name, text }) =>
    blocks(text)
      .filter((b) => b.selector.includes("::-webkit-scrollbar"))
      .map((b) => ({ file: name, ...b })),
  );
}

describe("滚动条全局统一", () => {
  it("样式只有一个来源：其余文件不得手写 ::-webkit-scrollbar", () => {
    const stray = scrollbarRules().filter(
      ({ file, selector, body }) =>
        file !== SOURCE_FILE &&
        // 豁免：标签条 display:none（既无尺寸也无配色，不会造出第二套外观）
        !(EXEMPT_FILES.includes(file) && selector.includes(".tabbar") && body.includes("display: none")),
    );
    expect(
      stray.map((s) => `${s.file} :: ${s.selector}`),
      "滚动条样式必须只留在 11-toast-command.css（唯一真源）；豁免见测试顶部 EXEMPT_FILES",
    ).toEqual([]);
  });

  it("默认全覆盖：* 上挂一次尺寸与滑块，新增容器无需登记", () => {
    const src = SOURCE_CSS;
    const star = blocks(src).filter((b) => b.selector === "*::-webkit-scrollbar");
    expect(star, "缺 `*::-webkit-scrollbar` 兜底 → 新滚动容器会掉回原生异形条").toHaveLength(1);
    expect(star[0].body).toMatch(/width:\s*10px/);
    expect(star[0].body).toMatch(/height:\s*10px/);

    const thumb = blocks(src).filter((b) => b.selector === "*::-webkit-scrollbar-thumb");
    expect(thumb).toHaveLength(1);
    expect(thumb[0].body).toContain("var(--sb-thumb)");

    const track = blocks(src).filter((b) => b.selector === "*::-webkit-scrollbar-track");
    expect(track).toHaveLength(1);
    expect(track[0].body).toMatch(/background:\s*transparent/);
  });

  it("尺寸唯一：全库没有任何非 10px 的滚动条粗细", () => {
    const odd = scrollbarRules().filter(({ body }) => {
      const size = body.match(/(?:width|height)\s*:\s*([^;]+)/)?.[1]?.trim();
      return size !== undefined && size !== "10px";
    });
    expect(
      odd.map((s) => `${s.file} :: ${s.selector} → ${s.body.replace(/\s+/g, " ")}`),
      "滚动条粗细必须恒为 10px（曾经代码块自挂 8px，与全局形状不符）",
    ).toEqual([]);
  });

  it("状态统一：静止透明（@property 初值）+ 滚动中 .scrolling 渐显", () => {
    const src = SOURCE_CSS;
    expect(src).toMatch(/@property\s+--sb-thumb\s*\{[^}]*initial-value:\s*transparent/);
    const scrolling = blocks(src).filter((b) => b.selector === ".scrolling");
    expect(scrolling, "缺通用 .scrolling → 新容器静止隐形了却滚不出来").toHaveLength(1);
    expect(scrolling[0].body).toMatch(/--sb-thumb:\s*var\(--scrollbar-thumb\)/);
  });

  it("渐显过渡用长写属性，不覆盖各处已有的 transition 简写", () => {
    const src = SOURCE_CSS;
    const star = blocks(src).filter((b) => b.selector === "*");
    expect(star, "缺 `*` 上的 --sb-thumb 过渡宿主 → 滑块会硬切不渐显").toHaveLength(1);
    expect(star[0].body).toMatch(/transition-property:\s*--sb-thumb/);
    // 全库其它地方一律用 `transition:` 简写（简写会带全四个长写，特异性高于 `*`，
    // 因此不会与这条互相覆盖）；一旦有人改用长写，就可能出现"某个属性被 * 抢走"。
    const longhands = styleFiles()
      .filter(({ name }) => name !== SOURCE_FILE)
      .flatMap(({ name, text }) =>
        [...text.matchAll(/transition-(?:property|duration|delay|timing-function)\s*:/g)].map(
          (m) => `${name} :: ${m[0]}`,
        ),
      );
    expect(longhands).toEqual([]);
  });

  it("--sb-thumb 只被真源文件碰过（不存在第二条白名单）", () => {
    const others = styleFiles()
      .filter(({ name, text }) => name !== SOURCE_FILE && text.includes("--sb-thumb"))
      .map(({ name }) => name);
    expect(others).toEqual([]);
  });

  it("前端仍在全局委托滚动事件（CSS 的 .scrolling 依赖它）", () => {
    const main = read("../main.tsx");
    expect(main).toContain('classList.add("scrolling")');
    expect(main).toContain('.remove("scrolling")');
  });
});
