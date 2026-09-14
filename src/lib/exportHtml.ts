// 独立 HTML 导出（InkNote 对齐项）：纯前端拼装，零新 IPC——保存走现有
// pick_save_path + save_file。
//
// 组成：<style> 内联 theme.css（设计令牌/明暗变量）+ palettes.css（配色覆盖）
// + katex.min.css + markdown.css（?raw 原文，随源文件自动同步，无双源漂移）；
// 正文优先取预览活 DOM（mermaid SVG 与 KaTeX HTML 已渲染就位，导出即所见），
// 预览未挂载（源码视图）时回退 parseResult.html。body 上的 data-theme /
// data-palette 按导出时刻解析出的明暗与配色写入（配色为默认档 xuan 时其取值
// 与 theme.css 相等，所以挂不挂属性都一样），宽度以内联变量 --qb-content-w
// 随当前生效档位（含自定义）输出。
//
// ponytail 已知天花板：
// - katex.min.css 内联后字体 url（woff2）不可达，公式回退系统衬线渲染，简单公式可读；
//   需要完美公式时把字体 base64 内联（~200KB）。
// - 回退路径（源码视图导出）里 mermaid/math 只有占位 div；需要时把渲染管线提升到
//   离屏容器再序列化。
// - 本机图片以 file:/// 绝对路径引用（换机器/移动文件夹会断）；内嵌图片属后续增强。
import themeCss from "../styles/theme.css?raw";
import palettesCss from "../styles/palettes.css?raw";
import markdownCss from "../styles/markdown.css?raw";
import katexCss from "katex/dist/katex.min.css?raw";
import { api } from "./ipc";
import { contentWidthPx } from "./contentWidth";
import { normalizePalette } from "./paletteSeeds";
import { useDocStore } from "../stores/useDocStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";

/** 仅用于 <title> 标签：文档名来自文件路径，尖括号/引号转义防破结构。 */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 本机绝对路径 → file:// URL（逐段 encode，处理空格/CJK/#）。 */
function fileUrl(abs: string): string {
  const norm = abs.replace(/\\/g, "/").replace(/^\/+/, "");
  return "file:///" + norm.split("/").map(encodeURIComponent).join("/");
}

/** 还原后端 escape_html 写进原始渲染串的属性值（路径里常见的四个实体）。 */
function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * 组装当前文档的独立 HTML 字符串。无打开文档时返回 null。
 * 正文来源：预览活 DOM（含 mermaid/公式/复制按钮等注入件——注入按钮在序列化前剥离），
 * 活 DOM 不在场则回退 parseResult.html 原文渲染。
 */
export async function buildActiveDocHtml(): Promise<string | null> {
  const doc = useDocStore.getState();
  if (!doc.doc) return null;
  const dark = isDarkTheme();
  const paletteId = normalizePalette(useSettingsStore.getState().palette);
  const widthPx = contentWidthPx(useUiStore.getState().contentWidth, useUiStore.getState().customWidth);

  const live = document.querySelector(".markdown-body");
  let bodyHtml: string;
  if (live) {
    const clone = live.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".copy-btn,.h-toggle").forEach((n) => n.remove());
    // 剥掉源行锚点注释（`<!--sl:N-->`）：那是分栏左右同步在应用内部用的定位标记
    // （markdown/html.rs::render_top_blocks），导出件里没有任何消费者，留着只是
    // 把内部实现泄进用户拿走的文件。
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments: Comment[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode as Comment);
    for (const c of comments) c.remove();

    // 图片：活 DOM 的 src 已被改写成 asset:// 协议（浏览器外无效），按 document
    // 顺序对回原始渲染串里的相对路径逐个重解析为 file:// 绝对路径；数量不等
    // （渲染后内容又变了）时放弃改写保持原样——宁要旧图不可用，不要错位配对。
    const origSrcs = Array.from(
      doc.parseResult?.html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g) ?? [],
      (m) => decodeHtmlAttr(m[1]!),
    );
    const imgs = Array.from(clone.querySelectorAll("img[src]"));
    if (origSrcs.length === imgs.length && origSrcs.length > 0) {
      const baseDir = doc.doc.base_dir;
      await Promise.all(
        imgs.map(async (img, i) => {
          const abs = await api.resolveImage(origSrcs[i]!, baseDir);
          if (abs) img.setAttribute("src", fileUrl(abs));
        }),
      );
    }
    bodyHtml = clone.innerHTML;
  } else {
    // 回退路径（源码视图导出）同样剥掉源行锚点注释，与活 DOM 路径口径一致
    bodyHtml = (doc.parseResult?.html ?? "").replace(/<!--sl:\d+-->/g, "");
  }

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>",
    escapeHtmlText(doc.doc.name),
    "</title>",
    "<style>",
    themeCss,
    palettesCss,
    katexCss,
    markdownCss,
    "</style>",
    "</head>",
    `<body data-theme="${dark ? "dark" : "light"}" data-palette="${paletteId}">`,
    `<div class="markdown-body" style="--qb-content-w:${widthPx}px">`,
    bodyHtml,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * 导出流程一体式：弹原生保存框（默认名 = 文档名换 .html）→ 组装 → 落盘。
 * 返回是否实际保存（取消/false、成功/true），错误经 toast 上抛给用户。
 */
export async function exportActiveDocHtml(): Promise<boolean> {
  const { addToast } = useUiStore.getState();
  const doc = useDocStore.getState().doc;
  if (!doc) return false;
  try {
    const target = await api.pickSavePath(doc.name.replace(/\.md$/i, "") + ".html");
    if (!target) return false;
    const html = await buildActiveDocHtml();
    if (html === null) return false;
    await api.saveFile(target, html);
    addToast("success", "已导出 HTML");
    return true;
  } catch (e) {
    addToast("error", `导出失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
