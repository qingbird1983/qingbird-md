// 格式工具栏（常驻显示）。
//
// 布局：左侧 = ① 撤销/重做 → ② 文件操作(新建/打开/保存/新建标签) → ③ 格式(B/I/S/标题/列表/引用/代码/链接/图片/表格/分隔线) → ④ 阅读模式(原文/译文/中英对照)；
// 右对齐（tb-gap 弹性占位之后）= ⑤ 视图切换(源码/预览/分栏) → ⑥ 正文宽版 → ⑦ 明暗主题 → ⑧ 面板开关(侧栏/大纲，仅切换无高亮)。
//
// 编辑类按钮 disabled=doc==null；文件/视图/阅读/主题/面板按钮不受文档状态影响（阅读模式按 TranslateMenu 语义在无文档时禁用）。
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
  Moon,
  Plus,
  Redo2,
  SquareCode,
  Workflow,
  Sigma,
  Strikethrough,
  Sun,
  Table,
  TextQuote,
  Undo2,
  FilePlus,
  FolderOpen,
  Save,
  Eye,
  Code2,
  Columns,
  Type,
  Languages,
  Rows2,
  StretchHorizontal,
  FoldHorizontal,
  PanelLeftClose,
  PanelRightClose,
  TextSelect,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore } from "../stores/useUiStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { api } from "../lib/ipc";

// ── 插入工具：mermaid 围栏 / $...$ 公式 ──
function insertMermaid() {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return;
  const from = v.state.selection.main.from;
  // 模板：\n```mermaid\n\n```\n（光标落在中间空行开头）
  const template = "\n```mermaid\n\n```\n";
  v.dispatch({
    changes: { from, insert: template },
    selection: { anchor: from + "\n```mermaid\n".length },
  });
  v.focus();
}

function insertFormula() {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return;
  const { from, to } = v.state.selection.main;
  const sel = v.state.sliceDoc(from, to);
  if (sel) {
    // wrap 选区为 $...$；新光标落在 $ 之后（即 sel 末尾 + 1）
    v.dispatch({
      changes: { from, to, insert: `$${sel}$` },
      selection: { anchor: from + sel.length + 1 },
    });
  } else {
    // 无选区：插入 $$$ 光标留中间
    v.dispatch({
      changes: { from, insert: "$$$" },
      selection: { anchor: from + 1 },
    });
  }
  v.focus();
}

// ── 分隔线 ──
function Sep() {
  return <span className="tb-sep" />;
}

export default function EditorToolbar() {
  const doc = useDocStore((s) => s.doc);
  const disabled = doc === null;
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const mode = useDocStore((s) => s.mode);
  const switchMode = useDocStore((s) => s.switchMode);
  const hasRoot = useWorkspaceStore((s) => !!s.root);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openTab = useDocStore((s) => s.openTab);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const newTab = useDocStore((s) => s.newTab);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const wideContent = useUiStore((s) => s.wideContent);
  const toggleWideContent = useUiStore((s) => s.toggleWideContent);

  // 划词翻译开关：与设置弹窗同一持久化通道（settings.selection_translate）。
  // 关闭时 SelectionPopup 的 on 订阅失效会自动清浮窗 + 防抖定时器。
  const selTranslate = useSettingsStore((s) => s.settings?.selection_translate ?? false);
  const toggleSelTranslate = () => {
    const cur = useSettingsStore.getState().settings;
    if (!cur) return;
    void useSettingsStore.getState().save({ ...cur, selection_translate: !cur.selection_translate });
  };

  // 解析后的明暗态（auto 档跟随系统）：仅用于切换按钮的图标/提示，逻辑与
  // 命令面板「切换明暗主题」同源（isDarkTheme 统一口径）。
  const theme = useSettingsStore((s) => s.theme);
  const sysDark = useMemo(() => matchMedia("(prefers-color-scheme: dark)"), []);
  const [sysMatches, setSysMatches] = useState(sysDark.matches);
  useEffect(() => {
    const f = () => setSysMatches(sysDark.matches);
    sysDark.addEventListener("change", f);
    return () => sysDark.removeEventListener("change", f);
  }, [sysDark]);
  const dark = theme === "dark" || (theme !== "light" && sysMatches);

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
      <button type="button" className="menu-btn tool-btn" title="新建标签"
        onClick={() => newTab()}>
        <Plus size={15} />
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
      <button type="button" className="menu-btn tool-btn" title="Mermaid 图表（插入 ```mermaid 围栏）" disabled={disabled}
        onClick={insertMermaid}>
        <Workflow size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="公式（$…$ 包裹选区或插入空占位）" disabled={disabled}
        onClick={insertFormula}>
        <Sigma size={15} />
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

      {/* ── ④ 阅读模式（翻译）── 图标语义：Type=原文字符 / Languages=翻译 / Rows2=逐行对照 */}
      <button type="button" className={`menu-btn tool-btn${mode === "original" ? " active" : ""}`} title="阅读模式：原文" disabled={disabled}
        onClick={() => switchMode("original")}>
        <Type size={15} />
      </button>
      <button type="button" className={`menu-btn tool-btn${mode === "translation" ? " active" : ""}`} title="阅读模式：译文" disabled={disabled}
        onClick={() => switchMode("translation")}>
        <Languages size={15} />
      </button>
      <button type="button" className={`menu-btn tool-btn${mode === "bilingual" ? " active" : ""}`} title="阅读模式：中英对照" disabled={disabled}
        onClick={() => switchMode("bilingual")}>
        <Rows2 size={15} />
      </button>

      {/* 弹性占位：从此处之后的按钮全部右对齐（源码视图起） */}
      <span className="tb-gap" />

      {/* ── ⑤ 视图切换 ── */}
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

      {/* ── ⑤b 划词翻译开关（选中即译；复制文字前先关掉，省 token）── */}
      <button type="button" className={`menu-btn tool-btn${selTranslate ? " active" : ""}`}
        title={selTranslate ? "划词翻译：开（点击关闭，复制选区不触发查词）" : "划词翻译：关（点击开启，选中即译）"}
        onClick={toggleSelTranslate}>
        <TextSelect size={15} />
      </button>
      <Sep />

      {/* ── ⑥ 正文宽版/窄版 ── 图标语义：StretchHorizontal=可放宽 / FoldHorizontal=可收窄 */}
      <button type="button" className={`menu-btn tool-btn${wideContent ? " active" : ""}`}
        title={wideContent ? "正文宽版（点击切换窄版）" : "正文窄版（点击切换宽版）"}
        onClick={() => toggleWideContent()}>
        {wideContent ? <FoldHorizontal size={15} /> : <StretchHorizontal size={15} />}
      </button>
      <Sep />

      {/* ── ⑦ 明暗主题 ── */}
      <button type="button" className="menu-btn tool-btn"
        title={`切换明暗主题（当前${dark ? "暗色" : "亮色"}）`}
        onClick={() => useSettingsStore.getState().setTheme(dark ? "light" : "dark")}>
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <Sep />

      {/* ── ⑧ 面板开关（仅切换显示/隐藏，无持续高亮态）── */}
      <button type="button" className="menu-btn tool-btn" title={showNav ? "隐藏侧栏" : "显示侧栏"}
        onClick={() => toggleNav()}>
        <PanelLeftClose size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title={showOutline ? "隐藏大纲" : "显示大纲"}
        onClick={() => toggleOutline()}>
        <PanelRightClose size={15} />
      </button>
    </div>
  );
}
