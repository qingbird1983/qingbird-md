// 代码块「纯代码」取文（2026-09-14）。
//
// 渲染契约（src-tauri/src/markdown/html.rs `push_code_block`）每行是
//   <span class="cl"><span class="ln">行号</span><span class="lc">内容</span></span>
// ——.ln 与 .lc 是兄弟节点，但**两者都在 <code> 子树里**，所以
// `code.textContent` 是「行号 + 内容」交替的串（"1fn a() {}"），
// 一键复制会把行号一起带走。必须只收 .lc 列。
//
// 行尾 '\n' 已由后端收进 .lc（末行除外），故逐行拼接即源码原文，
// 不需要额外补换行。

/** 从代码卡片的 `<code>` 元素取纯代码文本（排除 .ln 行号列）。 */
export function codeTextFrom(code: Element): string {
  const lines = code.querySelectorAll(".lc");
  // 兜底：非卡片结构（无 .lc，如外部/旧版缓存 HTML）退回原始 textContent。
  if (lines.length === 0) return code.textContent ?? "";
  let out = "";
  for (const line of Array.from(lines)) out += line.textContent ?? "";
  return out;
}
