// 格式工具栏（Task 22 增强版）：常驻显示。
//
// 按钮分组与顺序参考 SuperMarkdown：
//   ① 撤销/重做  →  ② 文件操作(新建/打开/保存)  →  ③ 格式(B/I/S/标题/列表/引用/代码/链接/图片/表格/分隔线)  →  ④ 视图切换  →  ⑤ 面板开关(侧栏/大纲)
//
// 所有按钮 disabled=doc==null（无文档时禁用编辑类按钮；文件/视图/面板按钮不受文档状态影响）。
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
  FilePlus,
  FolderOpen,
  Save,
  Eye,
  Code2,
  Columns,
  PanelLeftClose,
  PanelRightClose,
} from "lucide-react";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore } from "../stores/useUiStore";
import { api } from "../lib/ipc";

// ── 分隔线 ──
function Sep() {
  return <span className="tb-sep" />;
}

export default function EditorToolbar() {
  const doc = useDocStore((s) => s.doc);
  const disabled = doc === null;
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const hasRoot = useWorkspaceStore((s) => !!s.root);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openTab = useDocStore((s) => s.openTab);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);

  const pickOpen = async () => {
    const p = await api.pickFile();
    if (p) await openTab(p);
  };

  return (
    <div className="editor-toolbar">
      {/* ── ① 撤销/重做 ── */}
      <button type="button" className="menu-btn tool-btn" title="撤销（Ctrl+Z）" disabled={disabled}
        onClick={() => useDocStore.getState().dispatchUndo()}>
        <Undo2 size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="重做（Ctrl+Y）" disabled={disabled}
        onClick={() => useDocStore.getState().dispatchRedo()}>
        <Redo2 size={15} />
      </button>
      <Sep />

      {/* ── ② 文件操作 ── */}
      <button type="button" className="menu-btn tool-btn" title="新建文件" disabled={!hasRoot}
        onClick={() => { const name = window.prompt("新文件名（创建于工作区根目录）："); if (name?.trim()) void createFile(name.trim()); }}>
        <FilePlus size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="打开文件…"
        onClick={() => void pickOpen()}>
        <FolderOpen size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="保存（Ctrl+S）" disabled={disabled}
        onClick={() => void saveDoc(false)}>
        <Save size={15} />
      </button>
      <Sep />

      {/* ── ③ 格式按钮 ── */}
      <button type="button" className="menu-btn tool-btn" title="粗体（Ctrl+B）" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("bold")}>
        <Bold size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="斜体（Ctrl+I）" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("italic")}>
        <Italic size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="删除线" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("strike")}>
        <Strikethrough size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="一级标题" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("h1")}>
        <Heading1 size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="二级标题" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("h2")}>
        <Heading2 size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="三级标题" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("h3")}>
        <Heading3 size={15} />
      </button>
      <Sep />
      <button type="button" className="menu-btn tool-btn" title="无序列表" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("ul")}>
        <List size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="有序列表" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("ol")}>
        <ListOrdered size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="任务列表" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("task")}>
        <ListTodo size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="引用" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("quote")}>
        <TextQuote size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="行内代码" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("code")}>
        <Code size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="代码块" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("codeblock")}>
        <SquareCode size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="链接" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("link")}>
        <Link size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="图片" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("image")}>
        <Image size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="表格" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("table")}>
        <Table size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="分隔线" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("hr")}>
        <Minus size={15} />
      </button>
      <Sep />

      {/* ── ④ 视图切换 ── */}
      <button type="button" className={`menu-btn tool-btn${view === "source" ? " active" : ""}`} title="源码视图"
        onClick={() => switchView("source")}>
        <Code2 size={15} />
      </button>
      <button type="button" className={`menu-btn tool-btn${view === "preview" ? " active" : ""}`} title="预览视图"
        onClick={() => switchView("preview")}>
        <Eye size={15} />
      </button>
      <button type="button" className={`menu-btn tool-btn${view === "split" ? " active" : ""}`} title="分栏视图"
        onClick={() => switchView("split")}>
        <Columns size={15} />
      </button>
      <Sep />

      {/* ── ⑤ 面板开关 ── */}
      <button type="button" className={`menu-btn tool-btn${showNav ? " active" : ""}`} title={showNav ? "隐藏侧栏" : "显示侧栏"}
        onClick={() => toggleNav()}>
        <PanelLeftClose size={15} />
      </button>
      <button type="button" className={`menu-btn tool-btn${showOutline ? " active" : ""}`} title={showOutline ? "隐藏大纲" : "显示大纲"}
        onClick={() => toggleOutline()}>
        <PanelRightClose size={15} />
      </button>

      {/* 弹性占位，把按钮推到左边 */}
      <span className="tb-gap" />
    </div>
  );
}
