# 正文栏边缘拖宽把手（内容宽度实时拖拽）设计

日期：2026-09-04
状态：已获用户批准（交互细节两轮修订后确认）

## 背景与目标

参照 DSH Desktop（`F:\AI data\work\dsh_desktop`，`dsh-client-ui-layout` 的 AppFrame
DragHandle 模式）：鼠标放到正文栏左右边缘时出现一小段高亮"药丸"，可实时拖宽拉窄
页面宽度。

本应用现状：正文宽度是四档制（紧凑 640 / 标准 794 / 宽 1000 / 全宽 1200，
`useUiStore.contentWidth` → markdown.css `.markdown-body.w-*` 类），仅作用于预览
视图；编辑器（source 视图）通栏无定宽。已有拖拽基建 `lib/colDrag.ts`
（pointer capture + rAF 合并），侧栏/大纲/分栏 resizer 共用。

目标：把"四档制"接上"边缘悬停高亮 + 实时连续拖宽"。

## 范围决策（用户已确认）

1. **作用范围**：仅预览视图（`.markdown-body`）。编辑器保持通栏不变。
2. **宽度模型**：连续拖 + 四档保留。拖出多少是多少，拖过后成为"自定义"档；
   菜单/工具栏四档仍可一键回位。
3. **药丸跟随**：高亮药丸不固定居中，出现在指针进入热区的位置，上下移动实时
   跟随（修正了 DSH 原版"垂直居中固定"的做法）。
4. **动态上限**：拖宽上限 = 预览面板实时宽度（窗口越大可拖越宽；分栏下为半栏宽），
   不用写死的绝对上限。

## 1. 交互与视觉

- **热区**：8px 宽 × 预览面板全高，绝对定位在正文栏左右边缘（`position:absolute`，
  不随滚动），`cursor: col-resize`，平时完全透明。左右各一个，对称。
- **跟随药丸**：`::after` 画 12×32px 圆角胶囊（DSH 同款尺寸），垂直位置 = 指针
  当前 Y：
  - 进入热区即出现在指针处，上下移动实时跟随，钳在热区范围内不出界；
  - 离开热区淡出（`opacity 0 → 1` 过渡）；
  - 拖拽中变主题色（`--accent`）加深保持可见。
- **拖拽方向**：向左拖左缘 / 向右拖右缘 = 拉宽，反向拉窄，实时跟手，松手记住。
- **显示条件**：仅当面板有留白可调（面板宽 > 正文栏宽 + 16px）时渲染热区；
  正文栏被钳满时隐藏。
- 刻意不抄 DSH 的"悬停相邻面板也显示"：正文栏内部悬停弹把手会干扰阅读，
  只在边缘热区触发。

### 药丸跟随的实现（避 React 重渲）

- 药丸位置走热区上的 CSS 变量：`::after { top: var(--pill-y, 50%) }`；
- 热区 `onPointerMove` 直接 `style.setProperty("--pill-y", …)` 写值——纯指针移动
  零重渲；
- 拖拽中 pointer capture 把 move 事件重定向到热区自身，**同一个监听器继续生效，
  药丸拖拽中照样跟手**；colDrag 加的 `.dragging` 类负责保持可见（规避 capture
  下 `:hover` 失效，与现有 resizer 同一套路）。

## 2. 状态模型（useUiStore）

- 新增 `customWidth: number | null`（`null` = 跟随四档），localStorage 持久化，
  新键 `qb.content-width-custom`（旧键不迁移）。
- 四档 px 表收编进 TS 常量（单一事实来源）：
  `PRESET_PX = { compact: 640, normal: 794, wide: 1000, full: 1200 }`。
- 派生值 `contentWidthPx = customWidth ?? PRESET_PX[contentWidth]`。
- action：
  - `setContentWidth(档位)`：清掉 `customWidth`（点菜单 = 回档位）；
  - `setCustomWidth(px)`：保底钳下限 480 后写入并持久化（上限在拖拽处钳，
    那里才有面板宽）。
- 拖拽钳制范围：**480 ～ 面板实时宽度**，在拖拽 onMove 处钳。
- ViewMenu / AppMenu：四档项照旧；自定义态下四项都不高亮。
  EditorToolbar 循环按钮 title 自定义态显示 `自定义 Npx`。

## 3. 组件与数据流（实现路线 A：CSS 变量统一驱动）

- **CSS**（markdown.css）：`.markdown-body { max-width: var(--qb-content-w, 794px) }`；
  删除 `.w-compact/.w-wide/.w-full` 三条（px 值已收编进 TS）。
- **PreviewView** DOM 结构加一层：

  ```
  preview-wrap (relative; 挂 --qb-content-w 与把手定位基准)
    ├─ preview-scroll (原滚动容器，内容不变)
    ├─ content-resizer.left   (有留白时渲染)
    └─ content-resizer.right  (有留白时渲染)
  ```

- 把手渲染条件：ResizeObserver 观察 preview-wrap 宽度，
  `面板宽 > contentWidthPx + 16` 才渲染；split 视图下预览半栏窄于设定宽度时
  自动隐藏（免费获得）。
- 拖拽复用 `lib/colDrag.startColDrag`（pointer capture + rAF，与现有三个
  resizer 同套路）：
  - 右缘：`宽度 + dx`；左缘：`宽度 − dx`（向左拖为正增）；
  - 起手（pointerdown）时读 `contentWidthPx` 作基准；
  - **拖拽中不 setState**：onMove 直接
    `wrap.style.setProperty("--qb-content-w", …)`——大文档回流不经过 React；
  - 松手（pointerup）一次 `setCustomWidth` 落库，重渲写回同值（幂等）。
- 列保持居中：拖哪边，两边同时对称开合（保住"居中阅读"版式假设）。

## 4. 边界情况

- **上限随窗口实时走**：拖到留白归零即达上限（= 面板宽），松手后正文栏填满
  面板、把手隐藏；想再拉宽先拉大窗口。
- **恢复旧值不回钳**：localStorage 自定义宽度 > 当前面板宽时（如上次全屏拖到
  1400，这次分栏只剩 600），列自动填满面板即可，**存的值不动**——面板变宽后
  原值还在、把手回来。
- `preview-empty`（未开文档）无把手；split 视图自动生效（PreviewView 复用）。
- 拖拽期间 `userSelect`/光标由 colDrag 统一处理；把手在正文栏外的空白留白区，
  不遮内容、不与滚动条打架。
- 极值（480 / 面板宽）拖到即停，rAF 合并保证跟手。

## 5. 测试与验证

- 纯函数单测（vitest，同现有 `*.test.ts` 套路）：
  - 拖拽宽度换算：左右缘 dx 方向（`base + dx` / `base − dx`）；
  - 钳制：下限 480、上限面板宽的边界值；
  - `contentWidthPx`：null 跟随档位 / 自定义优先。
- `npx tsc --noEmit` 类型验证（沙箱内 vite build 会 spawn EPERM——esbuild
  子进程受限，既往结论：不要尝试升级沙箱，用 tsc 验证类型）。

## 6. 不做的事（non-goals）

- 不动编辑器（source 视图）的通栏布局；
- 不做拖动吸附到四档（连续制为准）；
- 不做"悬停正文栏内部显示把手"；
- 不迁移旧 localStorage 键，不引入 Rust 侧设置存储。
