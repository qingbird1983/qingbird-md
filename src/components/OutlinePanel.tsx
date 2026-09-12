// 大纲面板：消费 docStore.parseResult.outline（单一来源），内容变化经
// ensureParsed 幂等重解析。翻译/对照形态下跟随 doneHtml（与 PreviewView 同
// 判据）从译文 html 提取，大纲与正文所见一致。点击项滚动 preview 到锚点
// （html 元素带同名 id h-N，译文两形态均保留）；preview 尚未挂载时 optional
// chaining 静默跳过。
import { useEffect, useMemo, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, PanelLeft, PanelRight } from "lucide-react";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";
import type { OutlineItem } from "../types/ipc";

// 译文 html 的大纲提取：只读解析受信 HTML（XSS 边界见 PreviewView 头注释），
// 不向任何字符串拼文档派生内容。
// - translation 形态：标题文本即译文。
// - bilingual 形态：标题保持原文、译文在紧随的 .tr-box 里，优先取 tr-box
//   （未翻译的标题无 tr-box，自然回退原文）。
function outlineFromHtml(html: string): OutlineItem[] {
  const dom = new DOMParser().parseFromString(html, "text/html");
  return Array.from(dom.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => {
    const box = h.nextElementSibling;
    const text =
      box?.classList.contains("tr-box") && box.textContent
        ? box.textContent
        : (h.textContent ?? "");
    return { level: Number(h.tagName[1]), text, id: h.id };
  });
}

export default function OutlinePanel() {
  const content = useDocStore((s) => s.doc?.content ?? null);
  const mode = useDocStore((s) => s.mode);
  const parseOutline = useDocStore((s) => s.parseResult?.outline ?? null);
  const doneHtml = useDocStore((s) => s.doneHtml);
  const ensureParsed = useDocStore((s) => s.ensureParsed);

  // 打开文档或内容变更后保证解析结果最新（缓存命中则零开销）
  useEffect(() => {
    if (content !== null) void ensureParsed();
  }, [content, ensureParsed]);

  // 与 PreviewView 同判据：done html 形态与当前阅读模式/内容一致时，大纲从
  // 译文 html 提取（memo 防每次渲染重复 DOMParser）；否则维持原文 outline。
  const payloadHtml =
    mode !== "original" && doneHtml && doneHtml.mode === mode && doneHtml.contentKey === content
      ? doneHtml.html
      : null;
  const outline = useMemo(
    () => (payloadHtml ? outlineFromHtml(payloadHtml) : parseOutline),
    [payloadHtml, parseOutline],
  );

  // 折叠态：collapsed 收「被点收缩按钮的标题 id」。可见性用 barrier 扫描：
  // 收缩某级后，其后所有更深层级隐藏，直到出现不深于该级的标题。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items = useMemo(() => {
    if (!outline) return null;
    // 有子级的标题（全量 outline 上判定，与折叠态无关）才显示展开钮
    const withChildren = new Set<string>();
    for (let i = 0; i < outline.length; i++) {
      const next = outline[i + 1];
      if (next && next.level > outline[i].level) withChildren.add(outline[i].id);
    }
    const visible: OutlineItem[] = [];
    let barrier = Infinity;
    for (const it of outline) {
      if (it.level <= barrier) {
        visible.push(it);
        barrier = collapsed.has(it.id) ? it.level : Infinity;
      }
    }
    return { visible, withChildren };
  }, [outline, collapsed]);

  const outlineSide = useUiStore((s) => s.outlineSide);
  const setOutlineSide = useUiStore((s) => s.setOutlineSide);
  // 全部折叠/全部展开：一键在「只留顶层」与「全展」之间切。
  // 判据 = 所有可折叠项是否都已折叠（全折 → 按钮转为展开）。
  const foldable = items?.withChildren;
  const allFolded = !!foldable && foldable.size > 0 && [...foldable].every((id) => collapsed.has(id));
  const toggleAll = () =>
    setCollapsed(allFolded ? new Set() : new Set(foldable ?? []));

  // 分区标题常驻（对齐 SuperMarkdown 的 .ol-title），空态也保持面板形态。
  // 右侧工具：一键收展全部 + 停靠靠左/靠右（左 = 吸附在工作区左缘）。
  const title = (
    <div className="outline-title">
      <span className="outline-title-text">大纲</span>
      <div className="outline-tools">
        <button
          type="button"
          className="outline-tool"
          disabled={!foldable || foldable.size === 0}
          title={allFolded ? "展开全部" : "折叠全部"}
          aria-label={allFolded ? "展开全部" : "折叠全部"}
          onClick={toggleAll}
        >
          {allFolded ? (
            <ChevronsUpDown size={13} strokeWidth={1.9} />
          ) : (
            <ChevronsDownUp size={13} strokeWidth={1.9} />
          )}
        </button>
        <button
          type="button"
          className={`outline-tool${outlineSide === "left" ? " active" : ""}`}
          title="停靠到左侧（吸附工作区）"
          aria-label="停靠到左侧"
          aria-pressed={outlineSide === "left"}
          onClick={() => setOutlineSide("left")}
        >
          <PanelLeft size={13} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          className={`outline-tool${outlineSide === "right" ? " active" : ""}`}
          title="停靠到右侧（窗口右缘）"
          aria-label="停靠到右侧"
          aria-pressed={outlineSide === "right"}
          onClick={() => setOutlineSide("right")}
        >
          <PanelRight size={13} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
  if (content === null || !items || items.visible.length === 0) {
    return (
      <>
        {title}
        <div className="outline-empty">{content === null ? "未打开文档" : "无标题"}</div>
      </>
    );
  }

  return (
    <>
      {title}
      <ul className="outline-list" aria-label="大纲">
        {items.visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`outline-item outline-lv${Math.min(6, Math.max(1, item.level))}${
                collapsed.has(item.id) ? " is-collapsed" : ""
              }`}
              style={{ paddingLeft: 8 + Math.max(0, item.level - 1) * 13 }}
              title={item.text}
              onClick={() =>
                document
                  .getElementById(item.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {items.withChildren.has(item.id) && (
                <span
                  className="outline-toggle"
                  role="button"
                  aria-label={collapsed.has(item.id) ? "展开" : "收缩"}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapsed(item.id);
                  }}
                >
                  <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                    <path d="M2 1l4 3-4 3z" fill="currentColor" />
                  </svg>
                </span>
              )}
              <span className="outline-text">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </>

  );
}
