// 预览 DOM ⇄ 源码 的定位换算（纯逻辑，无 React）。
//
// 两块内容：
// 1. `collectLineAnchors` —— 把 Rust 埋在 HTML 里的顶层块源行注释
//    （`<!--sl:N-->`，见 src-tauri/src/markdown/html.rs::render_top_blocks）
//    与紧跟其后的块元素配成「行号 → 元素」锚点。分栏左右同步滚动与
//    「预览选区 → 源码选区」都以此为公共坐标。
// 2. `sourceRangeForSelection` —— 预览里的一段选区换回源码里的字符区间。
//
// 为什么不让 Rust 直接把源偏移写进块属性：块的开标签串（`<p data-bi="1">` 等）
// 被大量 Rust 断言与前端逻辑当作契约字面量，插属性会全线抖；注释是独立兄弟
// 节点，不参与布局、不进 textContent/Range.toString（全选、复制、代码取文都不受
// 影响），升级成本最低。

/** 行号 → 预览块元素。行号与元素都按文档序，故两侧同序。 */
export interface LineAnchor {
  line: number;
  el: HTMLElement;
}

/** 注释节点类型码（不依赖全局 Node，happy-dom / 浏览器通用）。 */
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;

/**
 * 收集顶层块源行锚点。规则：遇到 `sl:N` 注释就记为「待配对」，配对给紧随的
 * 第一个元素节点；块之间的换行文本节点跳过；文末 footnotes 区没有前置注释，
 * 天然不入表（脚注定义块被搬到文末渲染，行号在 DOM 序里已不单调）。
 */
export function collectLineAnchors(scope: HTMLElement): LineAnchor[] {
  const out: LineAnchor[] = [];
  let pending: number | null = null;
  for (const node of Array.from(scope.childNodes)) {
    if (node.nodeType === COMMENT_NODE) {
      const m = /^sl:(\d+)$/.exec((node as Comment).data);
      pending = m ? Number(m[1]) : null;
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    if (pending !== null) out.push({ line: pending, el: node as HTMLElement });
    pending = null;
  }
  return out;
}

/** 各行起始字符偏移（下标 = 0 起行号）。 */
export function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * 预览选区 → 源码字符区间 `[start, end)`；`fromLine`/`toLine` 是选区所在块与
 * 下一顶层块的 1 起源行号（`toLine` 为 null 表示该块是最后一个）。
 *
 * 两级策略：
 * ① 选中文本在「本块的源码行范围」内精确命中——源码里的文字与渲染后的文字
 *    大部分逐字相同（实体已还原、行内标记之外的文字原样保留），所以这是主力路径；
 * ② 没命中就把选区按空白切成词、以 `\s+` 相连再找一次——救回被软换行折断的段落。
 * 两级都不中（选区跨了 `**加粗**` / `` `代码` `` 之类行内标记，或跨了多个块）
 * **退回整块**：定位到那一段文本比什么都不选有用，且绝不会把光标丢到别处。
 */
export function sourceRangeForSelection(
  content: string,
  fromLine: number,
  toLine: number | null,
  text: string,
): [number, number] | null {
  if (fromLine < 1) return null;
  const starts = lineStarts(content);
  const start = starts[fromLine - 1];
  if (start === undefined) return null;
  const end = toLine === null ? content.length : starts[toLine - 1] ?? content.length;
  const block = content.slice(start, end);

  const trimmed = text.trim();
  if (trimmed) {
    const at = block.indexOf(trimmed);
    if (at >= 0) return [start + at, start + at + trimmed.length];
    const words = trimmed.split(/\s+/).map((w) => w.replace(REGEX_SPECIALS, "\\$&"));
    if (words.length > 1) {
      const m = new RegExp(words.join("\\s+")).exec(block);
      if (m) return [start + m.index, start + m.index + m[0].length];
    }
  }
  // 兜底：整个块（含行内标记的源码形态）。块尾的空行/换行不属于内容，
  // 结尾空白要剪掉——否则选中范围会拖着一串看不见的空行。
  const keep = block.replace(/\s+$/, "").length;
  return keep > 0 ? [start, start + keep] : null;
}
