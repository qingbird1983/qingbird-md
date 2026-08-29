// 大纲面板：消费 docStore.parseResult.outline（单一来源），内容变化经
// ensureParsed 幂等重解析。翻译/对照形态下跟随 doneHtml（与 PreviewView 同
// 判据）从译文 html 提取，大纲与正文所见一致。点击项滚动 preview 到锚点
// （html 元素带同名 id h-N，译文两形态均保留）；preview 尚未挂载时 optional
// chaining 静默跳过。
import { useEffect, useMemo } from "react";
import { useDocStore } from "../stores/useDocStore";
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

  if (content === null) return <div className="outline-empty">未打开文档</div>;
  if (!outline || outline.length === 0) return <div className="outline-empty">无标题</div>;

  return (
    <ul className="outline-list" aria-label="大纲">
      {outline.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="outline-item"
            style={{ paddingLeft: Math.max(0, item.level - 1) * 12 }}
            title={item.text}
            onClick={() =>
              document
                .getElementById(item.id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {item.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
