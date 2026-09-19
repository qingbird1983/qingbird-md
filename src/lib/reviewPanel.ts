/**
 * S4 #14 —— 面板入口层：**先开面板，再注入**（顺序不能反）。
 *
 * 理由是我们自己踩过的坑：**emit 无重放**（见 `MEMORY-details.md` §Tauri）。
 * 面板未挂载时把草稿/滚动目标交出去，接收方还没监听 → 必丢。
 *
 * 这一层在 S4 只做「确保面板打开 + 等布局落定」，S5 的语义核查会在这里挂
 * `then: () => setDraftInput(prompt)` —— 那才是"注入"的一半。
 *
 * 为什么必须等：面板是**条件挂载**的（App.tsx 里 `showReview && <div className="panel-unit">`），
 * 从 `setReviewOpen(true)` 到槽位真正进 DOM 之间隔着 React 的提交；
 * 而且主区在这一刻变窄 → 预览重排 → 块高全变。
 * 所以"开面板"和"按坐标滚动"之间**必须夹一个布局等待**，
 * 否则 `scrollIntoView` 会按旧宽度算落点，滚完偏一截。
 */
import { useUiStore } from "../stores/useUiStore";

/**
 * 等布局落定后回调。
 *
 * 用**两帧**而不是一帧：第 1 帧的回调仍可能在 React 提交之前跑（此时槽位还没进
 * DOM），第 2 帧一定在"提交 + 重排"之后 —— `scrollIntoView` 在那一刻才量得到
 * 主区变窄后的真实几何。
 */
export function afterLayoutStable(cb: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(cb));
}

/**
 * 确保 AI 核查面板处于打开状态，**布局稳定后**再执行 `then`。
 * 已打开时**同步**执行（布局本来就稳，没必要再等两帧、徒增一次闪现）。
 */
export function ensureReviewPanelOpen(then?: () => void): void {
  const ui = useUiStore.getState();
  if (ui.showReview) {
    then?.();
    return;
  }
  ui.setReviewOpen(true);
  if (then) afterLayoutStable(then);
}

/**
 * 开面板后的落点：把 issue 清单滚进视野（跳过「进度」抬头，直接落到问题列表）。
 *
 * 为什么需要它：面板的滚动区顶部是进度时间线，下面是 issue 清单 ——
 * 打开面板的人想看的是**问题**，不是"检查跑完了"这一行字。
 * 优先落在计数条上（`N 处…：3 处漏译 · 1 处结构不对等`），清单就在它下面一行，
 * 这样"多少条"和"哪几条"同时可见；只有清单时退而求其次落清单。
 * 两者都没有（还没译文 / 没查出问题）→ 静默返回 false，让空态卡自己居中。
 */
export function revealReviewIssues(doc: Document = document): boolean {
  const anchor =
    doc.querySelector<HTMLElement>(".review-checks-bar") ?? doc.querySelector<HTMLElement>(".review-issues");
  if (!anchor) return false;
  anchor.scrollIntoView({ behavior: "auto", block: "start" });
  return true;
}
