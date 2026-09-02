// 竖向拖宽条共享拖拽：App 壳层左右栏与主区之间、split 中缝两处复用。
//
// 全程纯 Pointer Events（pointerdown 起手 + setPointerCapture，move/up 监听
// 挂在捕获元素自身）——capture 保证拖出元素甚至窗口外事件仍按原 clientX
// 送达，不依赖 window 上的 mousemove 兼容事件（WebView2 下捕获重定向后
// 兼容事件不可靠，曾出现拖拽只能落在极值的失灵）。rAF 合并 setState，
// userSelect/cursor 防拖拽选中与光标闪变；.dragging 类供 CSS 做拖拽反馈
// （capture 下 :hover 会随指针漂移失效，不能靠它）。
export function startColDrag(e: React.PointerEvent<HTMLElement>, onMove: (dx: number) => void) {
  e.preventDefault();
  const startX = e.clientX;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  let raf = 0;
  let dx = 0;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  el.classList.add("dragging");
  const move = (ev: PointerEvent) => {
    dx = ev.clientX - startX;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => onMove(dx));
  };
  const up = () => {
    cancelAnimationFrame(raf);
    el.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}
