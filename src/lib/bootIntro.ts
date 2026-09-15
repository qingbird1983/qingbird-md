// 启动仪式感动画编排（2026-09-15）：双击启动 → 窗口 reveal 时两栏已展开到最宽，
// 两栏同步向终态收缩（左栏落到最小宽、大纲栏收尽），欢迎页内容同时从小放大。
//
// 时序（全部在窗口 visible:false 的隐藏期内完成准备）：
//   1. React 首帧就是 introArmed 起始态（两栏 480 强制可见）；
//   2. 查 bootInfo（静默驻留 / 带首开文件参数则不演）；
//   3. 跑原有启动序列 openDocFromArgs（快照恢复 / pending 文件 / 工作区恢复）；
//   4. 终态仍是欢迎页（无任何文档）且非减动效 → 等 TitleBar 实测完最小宽、
//      双 rAF 确保起始帧已绘制 → 通知 Rust 显示窗口；
//   5. 再等两帧让起始态被看见，startIntro 开演，INTRO_ANIM_MS 后收尾。
// 任何意外（IPC 失败、看门狗抢先 show）都走 skipIntro：窗口必须照常出现，
// 仪式感是锦上添花，绝不能拖住启动。
import { useUiStore, INTRO_ANIM_MS } from "../stores/useUiStore";
import { useDocStore } from "../stores/useDocStore";
import { api } from "./ipc";

// StrictMode 下 effect 双跑：与 hibernateRegistered 同款闩，保证启动序列只跑一次。
let bootStarted = false;

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** 等 TitleBar 实测出首启最小宽（applyDefaultSidebarWidth 会关掉 bootWidthPending）。
 *  正常一两帧内完成（在多个 IPC 往返期间早就测完了），1s 兜底防止极端环境死等。 */
async function waitForSidebarMeasure() {
  const started = performance.now();
  while (useUiStore.getState().bootWidthPending) {
    if (performance.now() - started > 1000) return;
    await nextFrame();
  }
}

export async function runBootIntro() {
  if (bootStarted) return;
  bootStarted = true;

  const ui = useUiStore.getState();

  let info: { silent: boolean; hasFileArg: boolean };
  try {
    info = await api.bootInfo();
  } catch {
    // IPC 挂了也得让窗口出现：直接放弃动画（Rust 看门狗 3s 也会兜底 show）。
    ui.skipIntro();
    await nextFrame();
    await nextFrame();
    await api.bootReady().catch(() => {});
    return;
  }

  // 原有启动序列（快照恢复 → pending 文件 → 工作区记忆）。必须在判定前跑完：
  // 恢复出任何文档，欢迎页就留不住，动画不演。
  await useDocStore.getState().openDocFromArgs();

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const landsOnWelcome = useDocStore.getState().doc === null;
  if (info.silent || info.hasFileArg || reduceMotion || !landsOnWelcome) {
    // 先落终态、过两帧（让终态完成布局+绘制）再 show：用户看到的就是正常首屏。
    ui.skipIntro();
    await nextFrame();
    await nextFrame();
    await api.bootReady().catch(() => {});
    return;
  }

  await waitForSidebarMeasure();
  await nextFrame(); // 起始态（两栏 480）在隐藏窗口里完成绘制
  let shown = true;
  try {
    // Rust 收到后 show + 焦点；返回 false = 3s 看门狗已抢先显示，放弃动画。
    shown = await api.bootReady();
  } catch {
    shown = false;
  }
  if (!shown) {
    ui.skipIntro();
  } else {
    await nextFrame(); // 起始帧在屏幕上停留两帧，收缩才有「起手式」
    await nextFrame();
    // 仪式感"起手式"：reveal 后让 armed 起始态（两栏展开 + 欢迎内容极小）
    // 在屏幕上停留一会——用户能看见"展开最大化"才感觉到收缩是「过程」不是
    // 「瞬变」。这是启动动画独有的展示时间，不算在 INTRO_ANIM_MS 里。
    // 1000ms 来自用户反馈（2026-09-15）：再短就"刷的一下就过"看不出感觉；
    // 1000ms armed + 1280ms playing = 2.28s 是用户认可的演示节奏。
    await new Promise<void>((r) => setTimeout(r, 1000));
    ui.startIntro();
    window.setTimeout(() => useUiStore.getState().finishIntro(), INTRO_ANIM_MS + 100);
  }
}
