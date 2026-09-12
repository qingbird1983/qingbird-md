// 格式工具栏（常驻显示）。
//
// 布局：左侧 = ① 撤销/重做 → ② 格式(粗体/斜体/删除线/行内代码/代码块/分隔线)
//   → ③ 下拉组(标题/列表/插入) → ④ 阅读模式(原文/译文/中英对照)；
// 右对齐（tb-gap 弹性占位之后）= ⑤ 视图切换(源码⇄预览合并钮 / 分栏) → ⑥ 划词翻译
//   → ⑦ 正文宽版 → ⑧ 面板开关(大纲)。
//
// 文件操作按钮(新建/打开/保存/新建标签)已移除：入口保留在汉堡菜单、
// 命令面板、Ctrl+S 与标签条「+」。编辑类按钮 disabled=doc==null；
// 视图/翻译/面板按钮不受文档状态影响（阅读模式按 TranslateMenu 语义在无文档时禁用）。
import {
  Bold,
  ChevronDown,
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
  Plus,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
  Undo2,
  Workflow,
  Sigma,
  TextSelect,
  StretchHorizontal,
  FoldHorizontal,
  PanelRightClose,
} from "lucide-react";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore, CONTENT_WIDTH_LABEL } from "../stores/useUiStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { insertFormula, insertMermaid } from "../lib/inserts";
import Menu, { MenuItem } from "./menus/Menu";

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
  // 工作区切换已搬到 TitleBar（PanelLeft），明暗主题搬进窗控组，这里只剩大纲切换 + 宽度档。
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const contentWidth = useUiStore((s) => s.contentWidth);
  const cycleContentWidth = useUiStore((s) => s.cycleContentWidth);
  const customWidth = useUiStore((s) => s.customWidth);

  // 划词翻译开关：与设置弹窗同一持久化通道（settings.selection_translate）。
  // 关闭时 SelectionPopup 的 on 订阅失效会自动清浮窗 + 防抖定时器。
  const selTranslate = useSettingsStore((s) => s.settings?.selection_translate ?? false);
  const toggleSelTranslate = () => {
    const cur = useSettingsStore.getState().settings;
    if (!cur) return;
    void useSettingsStore.getState().save({ ...cur, selection_translate: !cur.selection_translate });
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

      {/* ── ② 格式：一键按钮 ── */}
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
      <button type="button" className="menu-btn tool-btn" title="行内代码" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("code")}>
        <Code size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="代码块" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("codeblock")}>
        <SquareCode size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="分隔线" disabled={disabled}
        onClick={() => void useDocStore.getState().applyFormat("hr")}>
        <Minus size={15} />
      </button>
      <Sep />

      {/* ── ③ 下拉组：标题 / 列表 / 插入 ── */}
      <Menu title="标题" disabled={disabled}
        label={<span className="tb-dd"><Heading1 size={15} /><ChevronDown size={11} /></span>}>
        {(close) => (
          <>
            <MenuItem label="一级标题" icon={<Heading1 size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("h1"); }} />
            <MenuItem label="二级标题" icon={<Heading2 size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("h2"); }} />
            <MenuItem label="三级标题" icon={<Heading3 size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("h3"); }} />
          </>
        )}
      </Menu>
      <Menu title="列表" disabled={disabled}
        label={<span className="tb-dd"><List size={15} /><ChevronDown size={11} /></span>}>
        {(close) => (
          <>
            <MenuItem label="无序列表" icon={<List size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("ul"); }} />
            <MenuItem label="有序列表" icon={<ListOrdered size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("ol"); }} />
            <MenuItem label="任务列表" icon={<ListTodo size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("task"); }} />
            <MenuItem label="引用" icon={<TextQuote size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("quote"); }} />
          </>
        )}
      </Menu>
      <Menu title="插入" disabled={disabled}
        label={<span className="tb-dd"><Plus size={15} /><ChevronDown size={11} /></span>}>
        {(close) => (
          <>
            <MenuItem label="Mermaid 图表" icon={<Workflow size={14} />} disabled={disabled} onSelect={() => { close(); insertMermaid(); }} />
            <MenuItem label="公式" icon={<Sigma size={14} />} disabled={disabled} onSelect={() => { close(); insertFormula(); }} />
            <MenuItem label="链接" icon={<Link size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("link"); }} />
            <MenuItem label="图片" icon={<Image size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("image"); }} />
            <MenuItem label="表格" icon={<Table size={14} />} disabled={disabled} onSelect={() => { close(); void useDocStore.getState().applyFormat("table"); }} />
          </>
        )}
      </Menu>
      <Sep />

      {/* ── ④ 阅读模式（下划线文字分段，DESIGN.md §4 modeseg）──
           点击非激活项进对应模式（switchMode 到非 original 自动 startIfFresh）；
           点击激活项退回原文——保留旧 toggle 的退出语义。 */}
      <div className="modeseg" role="group" aria-label="阅读模式">
        <button type="button" className={mode === "original" ? "on" : ""}
          title="阅读原文" disabled={disabled}
          onClick={() => switchMode("original")}>
          原文
        </button>
        <button type="button" className={mode === "translation" ? "on" : ""}
          title={mode === "translation" ? "退出译文（回到原文）" : "翻译为译文"} disabled={disabled}
          onClick={() => switchMode(mode === "translation" ? "original" : "translation")}>
          译文
        </button>
        <button type="button" className={mode === "bilingual" ? "on" : ""}
          title={mode === "bilingual" ? "退出中英对照（回到原文）" : "阅读模式：中英对照"} disabled={disabled}
          onClick={() => switchMode(mode === "bilingual" ? "original" : "bilingual")}>
          双语
        </button>
      </div>

      {/* 弹性占位：从此处之后的按钮全部右对齐（源码视图起） */}
      <span className="tb-gap" />

      {/* ── ⑤ 视图切换（胶囊分段：源码/分栏/预览，DESIGN.md §4 viewseg）── */}
      <div className="viewseg" role="group" aria-label="视图">
        <button type="button" className={view === "source" ? "on" : ""}
          title="源码视图" onClick={() => switchView("source")}>
          源码
        </button>
        <button type="button" className={view === "split" ? "on" : ""}
          title="分栏视图" onClick={() => switchView("split")}>
          分栏
        </button>
        <button type="button" className={view === "preview" ? "on" : ""}
          title="预览视图" onClick={() => switchView("preview")}>
          预览
        </button>
      </div>
      <Sep />

      {/* ── ⑤b 划词翻译开关（选中即译；复制文字前先关掉，省 token）── */}
      <button type="button" className={`menu-btn tool-btn${selTranslate ? " active" : ""}`}
        title={selTranslate ? "划词翻译：开（点击关闭，复制选区不触发查词）" : "划词翻译：关（点击开启，选中即译）"}
        onClick={toggleSelTranslate}>
        <TextSelect size={15} />
      </button>
      <Sep />

      {/* ── ⑥ 正文宽度档（循环：紧凑→标准→宽→全宽）── 图标语义：StretchHorizontal=可放宽 / FoldHorizontal=到顶收窄；
           拖宽自定义态：四档都不算选中，title 报实时 px，图标恒可放宽 */}
      <button type="button" className={`menu-btn tool-btn${contentWidth !== "normal" || customWidth !== null ? " active" : ""}`}
        title={customWidth !== null
          ? `正文宽度：自定义 ${Math.round(customWidth)}px（点击切换下一档）`
          : `正文宽度：${CONTENT_WIDTH_LABEL[contentWidth]}（点击切换下一档）`}
        onClick={cycleContentWidth}>
        {contentWidth === "full" && customWidth === null ? <FoldHorizontal size={15} /> : <StretchHorizontal size={15} />}
      </button>
      <Sep />

      {/* ── ⑦ 面板开关（仅切换显示/隐藏，无持续高亮态）──
           工作区切换已搬到 TitleBar（PanelLeft 图标），这里只留大纲开关。 */}
      <button type="button" className="menu-btn tool-btn" title={showOutline ? "隐藏大纲" : "显示大纲"}
        onClick={() => toggleOutline()}>
        <PanelRightClose size={15} />
      </button>
    </div>
  );
}
