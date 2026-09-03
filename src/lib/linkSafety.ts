// 预览链接点击安全分类（T25：点 Markdown 链接导致整窗导航的修复）。
//
// 渲染层 html.rs 给所有 <a> 统一加了 target="_blank"，前端在此用 capture
// 委托接管点击：桌面阅读器没有「新标签页」概念，链接一律交给系统浏览器/
// 程序打开，绝不让 WebView2 发生整窗导航——否则窗口会被外部站点顶掉，
// 自定义标题栏的最小化/最大化/关闭按钮随页面消失，用户只能强杀进程。

export type PreviewHrefKind = "external" | "anchor" | "block";

/** href 分类：
 *  - external：http/https/mailto/tel → 交系统默认浏览器/程序打开
 *  - anchor：  `#…` 或空 → 文档内定位，由 scrollToPreviewAnchor 手动接管
 *  - block：   其余（javascript:/data:/vbscript:/相对路径/无协议…）→ 拦截并忽略，
 *              WebView 永不导航或执行
 */
export function classifyPreviewHref(href: string): PreviewHrefKind {
  const t = href.trim();
  if (t === "" || t.startsWith("#")) return "anchor";
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t);
  if (!m) return "block"; // 无协议 = 相对路径：预览文档没有路由概念
  const scheme = m[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") {
    return "external";
  }
  return "block"; // javascript:、data: 等一律不放行
}

/** 在预览容器内按 id 定位并滚动到可见；找不到目标静默返回 false。
 *  遍历 `[id]` 按属性值全等匹配——不经 selector 拼接，任何特殊字符
 *  （引号/反斜杠/空格）都无法注入，也无需转义。 */
export function scrollToPreviewAnchor(scope: Element, id: string): boolean {
  let dst: Element | null = null;
  for (const el of scope.querySelectorAll("[id]")) {
    if (el.getAttribute("id") === id) {
      dst = el;
      break;
    }
  }
  if (!dst) return false;
  try {
    dst.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    dst.scrollIntoView();
  }
  return true;
}

/**
 * 预览内 <a> 点击的统一接管（供 PreviewView 的 document capture 委托调用）：
 *  - external → preventDefault + open(url)，走系统浏览器；
 *  - anchor   → preventDefault + 手动滚动（链接被 html.rs 加了 target=_blank，
 *               若放行会被 WebView 当作新窗请求处理）；
 *  - block    → preventDefault + 静默忽略。
 * 只处理 scope 内（预览容器）的 <a>；其它点击原样放行。返回是否吞掉了事件。
 */
export function handlePreviewLinkClick(
  ev: MouseEvent,
  scope: Element | null,
  open: (url: string) => void,
): boolean {
  if (!scope) return false;
  const target = ev.target;
  if (!(target instanceof Element)) return false;
  const a = target.closest<HTMLAnchorElement>("a[href]");
  if (!a || !scope.contains(a)) return false;
  const href = a.getAttribute("href");
  if (href === null) return false;

  const kind = classifyPreviewHref(href);
  if (kind === "anchor") {
    ev.preventDefault();
    ev.stopPropagation();
    const id = href.trim().slice(1); // 去掉前导 '#'
    if (id) scrollToPreviewAnchor(scope, id);
    return true;
  }
  // external / block 统一吞掉：external 交系统浏览器，其余绝不让 WebView 处理。
  ev.preventDefault();
  ev.stopPropagation();
  if (kind === "external") {
    try {
      open(href);
    } catch {
      // 打开失败静默放弃：点击已被吞，无整窗导航风险
    }
  }
  return true;
}
