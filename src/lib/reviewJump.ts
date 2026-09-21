/**
 * S4 #16 —— issue 跳转的**唯一实现点**（2026-09-19 拍板：方案 B）。
 *
 * 为什么必须收敛成一个函数（而不是散写在面板组件里）：
 * 这一步的顺序（锁窗 → 滚动 → 同步）**错一格就会「跳过去又被拽回来」**；
 * 而 WYSIWYG 之后要把分栏联动从「像素反查」换成「行号 → offset 直接映射」，
 * 只要这个函数的**内部实现**换掉，调用方一行不用改。散写则每个点都要重改。
 * —— 见 `docs/superpowers/plans/2026-09-18-sqlite-translation-cache.md` 附 8.4。
 *
 * 锚点不新增机制，`Issue` 自带现成坐标：
 *   - `run`      → `data-ri` run 空间（translation 模式）
 *   - `run` 回退  → `data-bi` 块空间（bilingual 模式只渲染源块 + tr-box）
 *
 * （历史注：曾用恒为 0 的 `src_line` 作分栏联动坐标，P2-4/CQ-8 随字段一并
 * 删除——跳转只滚到锚点，不再向编辑器推坐标。）
 *
 * 「能不能跳」与「跳」共用同一个探测函数（`probeIssueAnchor`）：面板要在**渲染时**
 * 就知道该不该把卡片画成禁用态，运行时点击又要再判一次——两处判定必须同源，
 * 否则会出现"画着可点、点了没反应"的静默态。
 */
import { lockSplitSide } from "./splitSync";

/** 跳不了的原因。**必须让用户看见**（非 actionable 态），不许静默。 */
export type JumpBlockReason = "preview-hidden" | "anchor-missing";

/**
 * 跳转锚点的最小形状：只用 `run` 一个字段（run 空间优先、回退块空间）。
 * 确定性 `Issue` 与 S5 的 `ReviewIssue` 都天然满足——跳转实现不关心问题
 * 是谁报的。
 */
export type JumpAnchor = { run: number };

export type JumpResult =
  | { ok: true; target: HTMLElement }
  | { ok: false; reason: JumpBlockReason };

/** 探测结果：比 `JumpResult` 多带滚动容器（成功路径内部用）。 */
export type JumpProbe =
  | { ok: true; scroll: HTMLElement; target: HTMLElement }
  | { ok: false; reason: JumpBlockReason };

/** 落点高亮 class（样式在 `styles/05-panels.css`）。纯装饰，不写回 content。 */
export const ISSUE_FLASH_CLASS = "issue-flash";

/** 高亮停留时长：够看清落点，又不至于让人以为这是"选中态"。 */
export const ISSUE_FLASH_MS = 1200;

/** 预览滚动容器。源码单栏时 PreviewView 不挂载 → 返回 null（跳转的"非 actionable"分支）。 */
export function previewScrollEl(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(".preview-scroll");
}

/** issue 的锚点候选：run 空间优先，回退块空间。 */
export function findIssueAnchor(scroll: ParentNode, run: number): HTMLElement | null {
  return (
    scroll.querySelector<HTMLElement>(`[data-ri="${run}"]`) ??
    scroll.querySelector<HTMLElement>(`[data-bi="${run}"]`)
  );
}

/**
 * 能不能跳 / 跳到哪。**纯读**，无副作用 —— 面板渲染期可以放心调用来决定卡片态，
 * 运行时点击前再调一次（DOM 可能在两次之间变了：面板收起、重解析、切模式）。
 */
export function probeIssueAnchor(anchor: JumpAnchor, doc: Document = document): JumpProbe {
  const scroll = previewScrollEl(doc);
  if (!scroll) return { ok: false, reason: "preview-hidden" };
  const target = findIssueAnchor(scroll, anchor.run);
  if (!target) return { ok: false, reason: "anchor-missing" };
  return { ok: true, scroll, target };
}

/** 面板渲染期用：跳不了则返回原因，能跳返回 null。 */
export function jumpBlockReason(anchor: JumpAnchor, doc: Document = document): JumpBlockReason | null {
  const probe = probeIssueAnchor(anchor, doc);
  return probe.ok ? null : probe.reason;
}

/**
 * 跳到某条 issue 对应的正文位置。**两步顺序不可换**：
 *
 * ① `lockSplitSide("preview")` —— 预览即将被程序化滚动，先压掉它自己外发的
 *    中间态。否则滚动途经的每一块都会报给编辑器，编辑器被拽到半路，观感就是
 *    「跳过去又被拽回来」。
 * ② `scrollIntoView({ behavior: "auto" })` —— **不用 `smooth`**：平滑滚动要跑
 *    300ms 上下，早就冲出 180ms 的锁窗，中途的 scroll 事件照样外发（这正是
 *    ①要拦的东西）。
 *
 * （不再向编辑器 `emitSplitSync`：原先喂的 `src_line` 恒为 0，无信息量，
 * 字段已随 CQ-8 删除。锁窗仍要先行——scrollIntoView 引发的滚动事件同样
 * 会被联动总线听到。）
 */
export function jumpToIssue(anchor: JumpAnchor, opts: { flash?: boolean; doc?: Document } = {}): JumpResult {
  const probe = probeIssueAnchor(anchor, opts.doc ?? document);
  if (!probe.ok) return { ok: false, reason: probe.reason };

  lockSplitSide("preview");
  probe.target.scrollIntoView({ behavior: "auto", block: "center" });

  if (opts.flash !== false) flashIssueTarget(probe.target);
  return { ok: true, target: probe.target };
}

/** 落点闪烁高亮。返回清除函数（便于测试与提前取消）。 */
export function flashIssueTarget(target: HTMLElement, ms = ISSUE_FLASH_MS): () => void {
  target.classList.add(ISSUE_FLASH_CLASS);
  const timer = window.setTimeout(() => target.classList.remove(ISSUE_FLASH_CLASS), ms);
  return () => {
    window.clearTimeout(timer);
    target.classList.remove(ISSUE_FLASH_CLASS);
  };
}

/** 面板侧对失败原因的措辞——「非 actionable 态」要说明为什么点不动，别静默。 */
export function jumpFailureHint(reason: JumpBlockReason): string {
  return reason === "preview-hidden"
    ? "当前是源码视图，切到分栏或预览后即可跳转"
    : "这一条在正文里找不到对应锚点（可能来自不可译块或旧渲染产物）";
}
