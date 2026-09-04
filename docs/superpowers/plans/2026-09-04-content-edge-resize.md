# 正文栏边缘拖宽把手（内容宽度实时拖拽）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预览视图正文栏左右边缘悬停出现跟随鼠标的高亮药丸，拖拽实时连续调宽（DSH Desktop 同款交互），自定义宽度与四档菜单共存。

**Architecture:** 四档 px 值收编进 `src/lib/contentWidth.ts` 纯函数模块（单一事实来源）；`.markdown-body` 宽度改吃 CSS 变量 `--qb-content-w`；PreviewView 加 `preview-wrap` 定位层挂两个边缘热区，拖拽复用 `lib/colDrag`（pointer capture + rAF），拖拽中直写 CSS 变量绕过 React，松手经 `useUiStore.customWidth` 落库。

**Tech Stack:** React 18 + zustand 5 + 纯 CSS（无新依赖）；vitest 4 + happy-dom 测试。

**Spec:** `docs/superpowers/specs/2026-09-04-content-edge-resize-design.md`（已批准）

## Global Constraints

- **沙箱内禁止用 vite/vitest 做验证**：`vite build` 与 `vitest run` 都会 spawn esbuild 子进程报 `EPERM -4048`（已实测确认，不要尝试升级沙箱模式）。会话内验证一律 `npx tsc --noEmit -p tsconfig.json`；`npx vitest run` 步骤照常执行——若报 EPERM，记录"沙箱阻塞"并继续，合并前由用户本地 `pnpm test` 兜底。
- **拖宽条必须复用 `src/lib/colDrag.ts` 的 `startColDrag`**，不新写 mousemove 监听（WebView2 下 capture 重定向后兼容 mousemove 不可靠）。
- **拖拽态反馈用 `.dragging` 类**（colDrag 开关），不依赖 `:hover`（capture 下指针漂移会失效）。
- 拖宽钳制：下限 **480**（`MIN_CONTENT_WIDTH`），上限 **预览面板实时宽度**（非写死值）。
- localStorage 键：四档沿用 `qb.content-width`；自定义新增 `qb.content-width-custom`。不迁移旧键。
- XSS 边界（PreviewView 文件头注释）不触碰：本功能不引入任何 HTML 字符串拼接。
- 不加新 npm 依赖；不动编辑器（source 视图）布局。
- 提交信息用 `feat:`/`test:` 前缀 + 中文描述（对齐仓库现状）。

---

### Task 1: 纯函数模块 contentWidth.ts（TDD）

**Files:**
- Create: `src/lib/contentWidth.ts`
- Test: `src/lib/contentWidth.test.ts`

**Interfaces:**
- Consumes: `ContentWidth` 类型（`src/stores/useUiStore.ts:19` 已定义，type-only 导入，运行时零依赖不成环）。
- Produces（后续所有任务依赖的精确签名）:
  - `MIN_CONTENT_WIDTH = 480`
  - `CONTENT_WIDTH_PX: Record<ContentWidth, number>`（compact 640 / normal 794 / wide 1000 / full 1200）
  - `clampContentWidth(px: number, maxPx: number): number`
  - `contentWidthPx(preset: ContentWidth, custom: number | null): number`
  - `edgeDragWidth(side: "left" | "right", basePx: number, dx: number, maxPx: number): number`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/contentWidth.test.ts`（node 环境，无需 DOM，不加 happy-dom 头）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/contentWidth.test.ts`
Expected: FAIL——`Cannot find module './contentWidth'`（沙箱内若直接报 `spawn EPERM -4048` 属预期阻塞，记录后靠 Step 4 的 tsc + 用户本地跑测兜底，勿恋战）。

- [ ] **Step 3: 写最小实现**

创建 `src/lib/contentWidth.ts`：

```ts
// 正文宽度纯函数：四档 px 表 + 生效宽度合成 + 边缘拖宽换算 + 钳制。
//
// 四档 px 原先散在 markdown.css 的 .w-* 类里，本模块收编为单一事实来源：
// CSS 侧只消费 .preview-wrap 上的 --qb-content-w 变量（Task 4 挂载），
// 拖宽与档位都在这里算，store 只存值。
//
// 上限动态：maxPx = 预览面板实时宽度（窗口越宽可拖越宽，分栏下为半栏宽），
// 拖到留白归零即达上限。恢复旧值不回钳——存的自定义宽度大于当前面板时
// 由 CSS max-width 自然填满面板，存值不动（面板变宽后原值生效）。
import type { ContentWidth } from "../stores/useUiStore";

/** 拖宽下限：再窄伤排版（代码块/表格挤压）。 */
export const MIN_CONTENT_WIDTH = 480;

/** 四档 px 表（标准档 = A4 @96dpi 794px）。 */
export const CONTENT_WIDTH_PX: Record<ContentWidth, number> = {
  compact: 640,
  normal: 794,
  wide: 1000,
  full: 1200,
};

/** 钳进 [MIN_CONTENT_WIDTH, maxPx]；maxPx 极端窄于下限时保底 MIN。 */
export function clampContentWidth(px: number, maxPx: number): number {
  return Math.max(MIN_CONTENT_WIDTH, Math.min(maxPx, px));
}

/** 生效宽度：拖宽自定义优先，null（未拖过/已回档位）跟随四档。 */
export function contentWidthPx(preset: ContentWidth, custom: number | null): number {
  return custom ?? CONTENT_WIDTH_PX[preset];
}

/**
 * 边缘拖宽换算（列保持居中，两边对称开合）：
 * 右缘向右拖（dx>0）拉宽；左缘向左拖（dx<0）拉宽——统一 base ± dx 后钳制。
 */
export function edgeDragWidth(
  side: "left" | "right",
  basePx: number,
  dx: number,
  maxPx: number,
): number {
  return clampContentWidth(side === "right" ? basePx + dx : basePx - dx, maxPx);
}
```

- [ ] **Step 4: 验证**

Run: `npx vitest run src/lib/contentWidth.test.ts`
Expected: PASS（沙箱内 EPERM 时改跑 `npx tsc --noEmit -p tsconfig.json`——无输出即类型通过，测试留待用户本地确认）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/contentWidth.ts src/lib/contentWidth.test.ts
git commit -m "feat(content-width): 四档 px 表与拖宽换算纯函数（TDD）"
```

---

### Task 2: useUiStore 加自定义宽度档

**Files:**
- Modify: `src/stores/useUiStore.ts`
- Test: `src/stores/useUiStore.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 的 `MIN_CONTENT_WIDTH`（import 路径 `../lib/contentWidth`）。
- Produces:
  - state 新增 `customWidth: number | null`（`null` = 跟随四档，`loadCustomWidth()` 初始化）
  - action 新增 `setCustomWidth(px: number): void`（保底钳 `MIN_CONTENT_WIDTH`，写 localStorage）
  - `setContentWidth` / `cycleContentWidth` 行为变更：清 `customWidth` 并移除 localStorage 键
  - 常量 `CUSTOM_WIDTH_KEY = "qb.content-width-custom"`（模块内私有）

- [ ] **Step 1: 写失败测试**

创建 `src/stores/useUiStore.test.ts`（store 初始化读 localStorage，需 DOM 环境）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/useUiStore.test.ts`
Expected: FAIL——`customWidth` 不存在 / `setCustomWidth` 不是函数（EPERM 同 Task 1 处理）。

- [ ] **Step 3: 改 store**

`src/stores/useUiStore.ts` 全部改动如下（其余内容不动）：

3a. 文件头 import 区（第 3 行 `import { create } from "zustand";` 之后）加：

```ts
import { MIN_CONTENT_WIDTH } from "../lib/contentWidth";
```

3b. `const WIDTH_KEY = "qb.content-width";`（第 60 行）之后加：

```ts
const CUSTOM_WIDTH_KEY = "qb.content-width-custom";
```

3c. `loadContentWidth()` 函数（第 63-67 行）之后加：

```ts
// 自定义拖宽恢复：只挡非法值（NaN / 低于下限）；大于当前面板宽不回钳——
// CSS max-width 让列自然填满面板，存值不动（面板变宽后原值生效）。
function loadCustomWidth(): number | null {
  const saved = localStorage.getItem(CUSTOM_WIDTH_KEY);
  if (saved === null) return null;
  const px = Number(saved);
  return Number.isFinite(px) && px >= MIN_CONTENT_WIDTH ? px : null;
}
```

3d. `UiState` 接口 `contentWidth: ContentWidth;`（第 36 行）之后加一行，action 声明区 `setContentWidth(w: ContentWidth): void;`（第 43 行）之后加一行：

```ts
  customWidth: number | null; // 拖宽产物（null = 跟随四档档位）
```

```ts
  setCustomWidth(px: number): void;
```

3e. store 初始值 `contentWidth: loadContentWidth(),`（第 75 行）之后加：

```ts
  customWidth: loadCustomWidth(),
```

3f. `setContentWidth` 与 `cycleContentWidth` 两个 action（第 82-91 行）整体替换为：

```ts
  setContentWidth: (w) => {
    localStorage.setItem(WIDTH_KEY, w);
    // 点菜单四档 = 放弃拖宽自定义：两处（store + localStorage）同步清
    localStorage.removeItem(CUSTOM_WIDTH_KEY);
    return set({ contentWidth: w, customWidth: null });
  },
  cycleContentWidth: () =>
    set((s) => {
      const next = CONTENT_WIDTHS[(CONTENT_WIDTHS.indexOf(s.contentWidth) + 1) % CONTENT_WIDTHS.length]!;
      localStorage.setItem(WIDTH_KEY, next);
      localStorage.removeItem(CUSTOM_WIDTH_KEY);
      return { contentWidth: next, customWidth: null };
    }),
```

3g. `setSplitRatio` 之后（接口与实现各一处，紧挨着加）：

```ts
  setCustomWidth: (px) => {
    // 上限在拖拽处钳（那里才有面板实时宽），store 只保底下限
    const w = Math.max(MIN_CONTENT_WIDTH, px);
    localStorage.setItem(CUSTOM_WIDTH_KEY, String(w));
    set({ customWidth: w });
  },
```

（对应接口声明见 3d。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/useUiStore.test.ts`
Expected: PASS 4 条（EPERM 时 `npx tsc --noEmit -p tsconfig.json` + 留待本地）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/useUiStore.ts src/stores/useUiStore.test.ts
git commit -m "feat(content-width): useUiStore 支持拖宽自定义档（持久化 + 回档位清理）"
```

---

### Task 3: 菜单与工具栏的自定义态显示

**Files:**
- Modify: `src/components/menus/ViewMenu.tsx`（第 19-20 行、第 54-64 行）
- Modify: `src/components/AppMenu.tsx`（第 125-126 行、第 169-173 行）
- Modify: `src/components/EditorToolbar.tsx`（第 100-101 行附近、第 227-231 行）

**Interfaces:**
- Consumes: Task 2 的 `customWidth` state（`useUiStore((s) => s.customWidth)`）。
- Produces: 无（纯展示层）。规则：**自定义态下四档菜单项全部不高亮**；工具栏 title 显示 `自定义 Npx`。

- [ ] **Step 1: ViewMenu.tsx**

第 19-20 行之后（`setContentWidth` 订阅旁）加一行：

```tsx
  const customWidth = useUiStore((s) => s.customWidth);
```

第 54-64 行的四档 map 里，`active={contentWidth === w}` 改为：

```tsx
              active={customWidth === null && contentWidth === w}
```

- [ ] **Step 2: AppMenu.tsx**

第 125-126 行之后加一行（订阅区）：

```tsx
  const customWidth = useUiStore((s) => s.customWidth);
```

第 169-173 行的四档 map 里，className 改为：

```tsx
          {CONTENT_WIDTHS.map((w) => (
            <button
              key={w}
              className={customWidth === null && contentWidth === w ? "active" : ""}
              onClick={() => { close(); setContentWidth(w); }}
            >
              正文宽度：{CONTENT_WIDTH_LABEL[w]}
            </button>
          ))}
```

- [ ] **Step 3: EditorToolbar.tsx**

订阅区（第 100-101 行 `contentWidth` / `cycleContentWidth` 旁）加一行：

```tsx
  const customWidth = useUiStore((s) => s.customWidth);
```

第 227-231 行的正文宽度按钮整体替换为：

```tsx
      {/* ── ⑥ 正文宽度档（循环：紧凑→标准→宽→全宽）── 图标语义：StretchHorizontal=可放宽 / FoldHorizontal=到顶收窄；
           拖宽自定义态：四档都不算选中，title 报实时 px，图标恒可放宽 */}
      <button type="button" className={`menu-btn tool-btn${contentWidth !== "normal" || customWidth !== null ? " active" : ""}`}
        title={customWidth !== null
          ? `正文宽度：自定义 ${Math.round(customWidth)}px（点击切换下一档）`
          : `正文宽度：${CONTENT_WIDTH_LABEL[contentWidth]}（点击切换下一档）`}
        onClick={cycleContentWidth}>
        {contentWidth === "full" && customWidth === null ? <FoldHorizontal size={15} /> : <StretchHorizontal size={15} />}
      </button>
```

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出（类型通过）。

- [ ] **Step 5: 提交**

```bash
git add src/components/menus/ViewMenu.tsx src/components/AppMenu.tsx src/components/EditorToolbar.tsx
git commit -m "feat(content-width): 菜单/工具栏展示拖宽自定义态（四档不高亮 + 自定义 Npx）"
```

---

### Task 4: PreviewView 边缘把手 + CSS 变量切换（原子落地）

> 本任务四个文件一起改：CSS 先删 `.w-*` 再由 PreviewView 停挂类，必须同提交，否则中间态丢宽度档。

**Files:**
- Modify: `src/lib/colDrag.ts`（可选 `onEnd` 回调）
- Modify: `src/components/PreviewView.tsx`（结构 + 拖拽逻辑）
- Modify: `src/styles/markdown.css`（宽度改 CSS 变量，删 `.w-*`）
- Modify: `src/styles/global.css`（`.preview-wrap` + `.content-resizer` 样式，插在 `.preview-empty` 块之后）

**Interfaces:**
- Consumes: Task 1 `contentWidthPx` / `edgeDragWidth`；Task 2 `customWidth` / `setCustomWidth`；`startColDrag`（签名本次扩展）。
- Produces:
  - `startColDrag(e, onMove, onEnd?)` —— `onEnd?: (dx: number) => void`，pointerup 时回传最终 dx（原三处调用不传即行为不变）
  - DOM 契约：`.preview-wrap` 持 `--qb-content-w`；`.content-resizer.left/.right` 为热区；`.dragging` 类由 colDrag 开关

- [ ] **Step 1: colDrag.ts 加可选 onEnd**

第 9 行签名替换为：

```ts
export function startColDrag(
  e: React.PointerEvent<HTMLElement>,
  onMove: (dx: number) => void,
  onEnd?: (dx: number) => void,
) {
```

`up` 回调（第 24-32 行）整体替换为（挂最终回传：colDrag 在 pointerup 会 cancel 掉待发的 rAF 帧，最终 dx 不回传就丢一帧）：

```ts
  const up = () => {
    cancelAnimationFrame(raf);
    el.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    onEnd?.(dx); // 清理之后回传——onEnd 抛错也不漏监听器
  };
```

文件头注释第 8 行 `（capture 下 :hover 会随指针漂移失效，不能靠它）。` 后补一句：

```
// onEnd(dx) 可选：pointerup 时回传最终 dx（最后一次 rAF 待发帧不丢）。
```

- [ ] **Step 2: global.css 加把手样式**

`.preview-empty { … }` 块（第 1064-1071 行）之后插入：

```css
/* 正文宽度拖宽把手（DSH 式）：preview-wrap 定位基准，热区贴正文栏左右边缘。
   • 热区 8px 全高全透明，cursor col-resize；药丸 ::after 12x32 跟随指针 Y
     （--pill-y 由 onPointerMove 直写，钳在热区内），hover 淡入、拖拽中 accent 加深。
   • .dragging 由 lib/colDrag 开关——capture 下 :hover 随指针漂移失效，不能只靠它。
   • 位置与正文栏吃同一个 --qb-content-w：左缘 50%-w/2、右缘 50%+w/2，
     热区自身 8px 宽（-4px 回拉半宽），与栏边缘对齐。 */
.preview-wrap {
  position: relative;
  height: 100%;
}

.content-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 5;
  touch-action: none;
}

.content-resizer.left {
  left: calc(50% - var(--qb-content-w, 794px) / 2 - 4px);
}

.content-resizer.right {
  left: calc(50% + var(--qb-content-w, 794px) / 2 - 4px);
}

.content-resizer::after {
  content: "";
  position: absolute;
  top: var(--pill-y, 50%);
  left: 50%;
  width: 12px;
  height: 32px;
  border-radius: 10px;
  background: var(--bg3);
  box-shadow: 0 0 0 1px var(--border-strong);
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  pointer-events: none;
}

.content-resizer:hover::after,
.content-resizer.dragging::after {
  opacity: 1;
}

.content-resizer.dragging::after {
  background: var(--accent);
  box-shadow: none;
}
```

- [ ] **Step 3: markdown.css 宽度切 CSS 变量**

第 31-36 行（`/* A4 纸面定宽 … */` 注释 + `box-sizing` + `max-width` + `margin-inline`）替换为：

```css
  /* 正文宽度由 --qb-content-w 驱动（挂在 .preview-wrap 上，值 = 四档或拖宽
     自定义，四档 px 表在 src/lib/contentWidth.ts——单一事实来源）；
     窗口/分栏窄于该值时自然收缩回流式排版。 */
  box-sizing: border-box;
  max-width: var(--qb-content-w, 794px);
  margin-inline: auto;
```

第 51-54 行（`/* 正文宽度非标准档 … */` 注释与 `.w-compact/.w-wide/.w-full` 三条规则）整块删除。

- [ ] **Step 4: PreviewView 装配**

4a. 第 17 行 import 区替换 + 追加：

```tsx
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
```

（原 `import { useEffect, useRef } from "react";` 删除。）

4b. 第 14 行 `import { startColDrag } …` 附近没有则新增（放在 `import { useUiStore } …` 之后）：

```tsx
import { contentWidthPx, edgeDragWidth } from "../lib/contentWidth";
import { startColDrag } from "../lib/colDrag";
```

4c. 第 122 行 `const contentWidth = useUiStore((s) => s.contentWidth);` 之后加订阅与把手逻辑（放在「译文形态直用」注释块之前）：

```tsx
  const customWidth = useUiStore((s) => s.customWidth);

  // ── 正文栏边缘拖宽把手（DSH 式）────────────────────────────
  // preview-wrap 是定位基准：把手贴 --qb-content-w 算出的栏边缘，
  // ResizeObserver 跟窗口/分栏拖动实时翻转显示（面板宽 > 生效宽 + 16 才
  // 有留白可调；rAF 合并防拖分栏时高频 setState）。
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paneW, setPaneW] = useState(0);
  const hasDoc = content !== null;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !hasDoc) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = 0;
        setPaneW(el.clientWidth);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasDoc]);
  const contentPx = contentWidthPx(contentWidth, customWidth);
  const showHandles = paneW > contentPx + 16;

  // 边缘拖宽：起手锁基准（getState 快照，不吃闭包旧 state）；拖拽中直接写
  // wrap 的 --qb-content-w（绕过 React——大文档回流不进 setState），松手
  // onEnd 一次落库 setCustomWidth，重渲写回同值（幂等）。
  const startEdgeDrag = (side: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const st = useUiStore.getState();
    const base = contentWidthPx(st.contentWidth, st.customWidth);
    const max = wrap.clientWidth;
    startColDrag(
      e,
      (dx) => wrap.style.setProperty("--qb-content-w", `${edgeDragWidth(side, base, dx, max)}px`),
      (dx) => useUiStore.getState().setCustomWidth(edgeDragWidth(side, base, dx, max)),
    );
  };

  // 药丸跟随：Y 直写热区 CSS 变量（零重渲），钳在热区内不出界（药丸半高 16）。
  // 拖拽中 pointer capture 把 move 重定向到热区自身，同一监听器继续生效。
  const trackPill = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const y = Math.max(16, Math.min(rect.height - 16, e.clientY - rect.top));
    el.style.setProperty("--pill-y", `${y}px`);
  };
```

4d. 第 234-238 行的 return 整体替换为：

```tsx
  return (
    <div
      className="preview-wrap"
      ref={wrapRef}
      style={{ "--qb-content-w": `${contentPx}px` } as CSSProperties}
    >
      <div className="preview-scroll">
        <div className="markdown-body" ref={ref} />
      </div>
      {showHandles && (
        <>
          <div className="content-resizer left" onPointerDown={startEdgeDrag("left")} onPointerMove={trackPill} />
          <div className="content-resizer right" onPointerDown={startEdgeDrag("right")} onPointerMove={trackPill} />
        </>
      )}
    </div>
  );
```

注意：第 236 行原 `className={contentWidth === "normal" ? "markdown-body" : `markdown-body w-${contentWidth}`}` 简化为 `className="markdown-body"`（四档类已废，宽度全走变量）。

- [ ] **Step 5: 验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出。

Run: `npx vitest run`
Expected: 全量 PASS（沙箱内 EPERM 属预期，记录并注明"用户本地 `pnpm test` 兜底"；Task 1/2 的新测试同样待本地确认）。

人工核对清单（本地 `pnpm dev` / `pnpm tauri dev`，合并前用户确认）：
- 预览两侧边缘出现药丸，上下移动跟随；拖动实时跟手，松手记住；
- 拖到窗口/分栏边缘停住（留白归零），松手后把手消失；拉大窗口把手回来；
- 菜单四档可回位（点后自定义失效）；工具栏 title 显示 `自定义 Npx`；
- 分栏模式下编辑半栏无把手、预览半栏正常；未开文档无把手。

- [ ] **Step 6: 提交**

```bash
git add src/lib/colDrag.ts src/components/PreviewView.tsx src/styles/markdown.css src/styles/global.css
git commit -m "feat(content-width): 预览正文栏边缘拖宽把手——悬停药丸跟随 + 实时连续调宽"
```
