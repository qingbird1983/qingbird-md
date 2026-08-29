// 格式工具栏（Task 22，常驻显示）。
//
// 格式键 → docStore.applyFormat(op)：Rust apply_op 以 store.cursorSel（CM 码点
// 偏移，store 内完成字节换算）为选区上下文；无文档时全部禁用（disabled=doc==null）。
// 撤销/重做 → CodeMirror 命令（@codemirror/commands undo/redo），实例经
// docStore.cmRef 由 EditorView 挂载时写入——编辑器未挂载（preview 视图 CM 不存在，
// dispatchUndo/Redo 内部 if (v) 守卫 → no-op）或无文档时不可用。Ctrl+B / Ctrl+S
// 等键盘入口在 EditorView keymap。
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
  Undo2,
} from "lucide-react";
import { Fragment } from "react";
import { useDocStore } from "../stores/useDocStore";

// 分组渲染：撤销/重做 · 行内格式 · 标题 · 块级 · 插入。组间竖线由
// .editor-toolbar .tb-sep 绘制（见 global.css），视觉分组不影响 op 语义。
const GROUPS = [
  [
    { op: "bold", Icon: Bold, title: "粗体（Ctrl+B）" },
    { op: "italic", Icon: Italic, title: "斜体（Ctrl+I）" },
    { op: "strike", Icon: Strikethrough, title: "删除线" },
    { op: "code", Icon: Code, title: "行内代码" },
  ],
  [
    { op: "h1", Icon: Heading1, title: "一级标题" },
    { op: "h2", Icon: Heading2, title: "二级标题" },
    { op: "h3", Icon: Heading3, title: "三级标题" },
  ],
  [
    { op: "quote", Icon: TextQuote, title: "引用" },
    { op: "ul", Icon: List, title: "无序列表" },
    { op: "ol", Icon: ListOrdered, title: "有序列表" },
    { op: "task", Icon: ListTodo, title: "任务列表" },
  ],
  [
    { op: "link", Icon: Link, title: "链接" },
    { op: "image", Icon: Image, title: "图片" },
    { op: "table", Icon: Table, title: "表格" },
    { op: "codeblock", Icon: SquareCode, title: "代码块" },
    { op: "hr", Icon: Minus, title: "分隔线" },
  ],
] as const;

const HISTORY_BTNS = [
  { Icon: Undo2, title: "撤销（Ctrl+Z）", run: () => useDocStore.getState().dispatchUndo() },
  { Icon: Redo2, title: "重做（Ctrl+Y）", run: () => useDocStore.getState().dispatchRedo() },
] as const;

function Sep() {
  return <span className="tb-sep" aria-hidden />;
}

export default function EditorToolbar() {
  const disabled = useDocStore((s) => s.doc === null);
  return (
    <div className="editor-toolbar">
      {HISTORY_BTNS.map(({ Icon, title, run }) => (
        <button key={title} type="button" title={title} disabled={disabled} onClick={run}>
          <Icon size={16} />
        </button>
      ))}
      {GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          <Sep />
          {group.map(({ op, Icon, title }) => (
            <button
              key={op}
              type="button"
              title={title}
              disabled={disabled}
              onClick={() => void useDocStore.getState().applyFormat(op)}
            >
              <Icon size={16} />
            </button>
          ))}
        </Fragment>
      ))}
      <span className="tb-gap" />
    </div>
  );
}
