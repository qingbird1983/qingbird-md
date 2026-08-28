// 主区装配（Task 22）：按 docStore.view 路由 source / preview / split 三形态。
//
// source = 编辑器通栏；preview = 预览通栏（不显示工具栏——延续旧版）；
// split = 左 EditorView 右 PreviewView（同组件复用），中间竖向 resizer。
//
// 分栏拖动：与壳层面板拖宽条共用 lib/colDrag（纯 Pointer Events + capture +
// rAF 合并 setState），mousedown 记起点与容器宽度，mousemove 里算新比例
// （钳制 0.2~0.8，任一侧至少留两成）推 uiStore.splitRatio（存 store ⇒ 跨视图
// 切换保持，默认 0.5）。
import { type PointerEvent as ReactPointerEvent } from "react";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";
import { startColDrag } from "../lib/colDrag";
import EditorView from "./EditorView";
import EditorToolbar from "./EditorToolbar";
import PreviewView from "./PreviewView";
import TranslationBar from "./TranslationBar";

// 分栏比例钳制（brief 未给数值，取常规经验值：两侧各留至少 20%）
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;

function SplitBody() {
  const ratio = useUiStore((s) => s.splitRatio);
  // key = doc.path：换文档时重挂 EditorView，清空 CM undo 历史，
  // 杜绝跨文档 Ctrl+Z 把 A 的内容回写进 B（数据覆盖事故）
  const docKey = useDocStore((s) => s.doc?.path ?? "empty");

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    // resizer 恒为 .main-body 直接子元素，取父容器宽度做比例分母
    const body = e.currentTarget.parentElement;
    if (!body) return;
    const startRatio = useUiStore.getState().splitRatio;
    const width = body.clientWidth;
    if (width <= 0) return;
    startColDrag(e, (dx) => {
      const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, startRatio + dx / width));
      useUiStore.getState().setSplitRatio(r);
    });
  };

  return (
    <>
      <div className="split-half" style={{ flex: `0 0 ${ratio * 100}%` }}>
        <EditorView key={docKey} />
      </div>
      <div
        className="resizer"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startDrag}
      />
      <div className="split-half">
        <PreviewView />
      </div>
    </>
  );
}

export default function MainArea() {
  const view = useDocStore((s) => s.view);
  const docKey = useDocStore((s) => s.doc?.path ?? "empty");
  return (
    <>
      {/* 预览模式不显示工具栏（延续旧版） */}
      {view !== "preview" && <EditorToolbar />}
      {/* T23：整篇翻译进度条（仅翻译进行中占位） */}
      <TranslationBar />
      <div className="main-body">
        {view === "source" && <EditorView key={docKey} />}
        {view === "preview" && <PreviewView />}
        {view === "split" && <SplitBody />}
      </div>
    </>
  );
}
