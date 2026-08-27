// 主区装配（Task 22）：按 docStore.view 路由 source / preview / split 三形态。
//
// source = 编辑器通栏；preview = 预览通栏（不显示工具栏——延续旧版）；
// split = 左 EditorView 右 PreviewView（同组件复用），中间 4px 竖向 resizer。
//
// 分栏拖动：mousedown 记起点与容器宽度，window mousemove 里算新比例
// （钳制 0.2~0.8，任一侧至少留两成），requestAnimationFrame 合并 setState
// 推 uiStore.splitRatio（存 store ⇒ 跨视图切换保持，默认 0.5）。拖动期间
// body.userSelect=none 防拖拽选中两侧文本、body.cursor=col-resize 防指针
// 离开 4px 条时光标闪变，mouseup 一并恢复。
import { type MouseEvent as ReactMouseEvent } from "react";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";
import EditorView from "./EditorView";
import EditorToolbar from "./EditorToolbar";
import PreviewView from "./PreviewView";

// 分栏比例钳制（brief 未给数值，取常规经验值：两侧各留至少 20%）
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;

function SplitBody() {
  const ratio = useUiStore((s) => s.splitRatio);

  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    // resizer 恒为 .main-body 直接子元素，取父容器宽度做比例分母
    const body = e.currentTarget.parentElement;
    if (!body) return;
    const startX = e.clientX;
    const startRatio = useUiStore.getState().splitRatio;
    const width = body.clientWidth;
    if (width <= 0) return;
    let raf = 0;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: MouseEvent) => {
      const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, startRatio + (ev.clientX - startX) / width));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => useUiStore.getState().setSplitRatio(r));
    };
    const up = () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      <div className="split-half" style={{ flex: `0 0 ${ratio * 100}%` }}>
        <EditorView />
      </div>
      <div
        className="resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startDrag}
      />
      <div className="split-half">
        <PreviewView />
      </div>
    </>
  );
}

export default function MainArea() {
  const view = useDocStore((s) => s.view);
  return (
    <>
      {/* 预览模式不显示工具栏（延续旧版） */}
      {view !== "preview" && <EditorToolbar />}
      <div className="main-body">
        {view === "source" && <EditorView />}
        {view === "preview" && <PreviewView />}
        {view === "split" && <SplitBody />}
      </div>
    </>
  );
}
