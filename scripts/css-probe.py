#!/usr/bin/env python3
"""主题令牌的**浏览器级**关系探针（手动验收工具，不进 CI）。

为什么需要它：`--panel-bg: var(--bg2)` 这类「派生令牌」的取值取决于**声明位置**
——自定义属性在声明它的那个元素上就把 var() 换成具体值再继承下去，所以写在 :root
会锁定成默认档 xuan 的纸色、读不到 palettes.css 在 body 上的覆盖（2026-09-14
「换主题色只有标题栏不跟随」就是这个）。这类断言 happy-dom/jsdom 都做不了（不实现
真实级联），vitest 里只能退化成结构断言（见 src/lib/themeAlias.test.ts）；
真正的行为验证要靠浏览器引擎。

本脚本把真实的 theme.css + palettes.css + global.css 拼成一张静态页，用无头 Edge
（与 Tauri 用的 WebView2 同引擎）读计算值，对 6 套配色 × 明暗两档做**关系断言**：
「标题栏底色 == body 的 --bg2」——关系式而非硬编码色值，配色表改了也不用维护。

用法：
    python scripts/css-probe.py          # 全部 6 套配色 × 2 档
    python scripts/css-probe.py ci       # 只测 ci
退出码非 0 表示有关系不成立。
"""
from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
STYLES = ROOT / "src" / "styles"

PALETTES = ["xuan", "su", "qing", "tan", "ci", "ye"]
MODES = ["light", "dark"]

# (探针元素选择器, 期望与之相等的参考令牌)
PROBES: list[tuple[str, str]] = [
    (".titlebar", "--bg2"),  # 标题栏（Req 1 的直接受害者）
    (".set-nav", "--bg2"),  # 设置面板左栏
    (".set-nav-item.on", "--surface"),
    ('.tree-row[aria-selected="true"]', "--surface"),  # 树选中
    (".modal-btn", "--surface"),  # 普通按钮底
]

# 注：2026-09-14 第三轮把设置面板的页脚（.set-foot）整块删了（改「点叉即自动保存」），
# 原 (.set-foot, --bg2) 探针随之移除——它探的元素已不存在，不删就会恒报 MISMATCH
# 而掩盖真实回归。**不要拿 .set-bar 顶替**：新工具条是透明底（长在 .set-main 内，
# 只有 border-bottom），底色断言天然不成立，那是误报不是覆盖。
# --bg2 现在由 .titlebar / .set-nav 两处覆盖，--surface 由三处覆盖，关系断言不失守。

MARKUP = """
<div class="titlebar"></div>
<nav class="set-nav"></nav>
<button class="set-nav-item on">o</button>
<div class="tree-row" aria-selected="true">r</div>
<button class="modal-btn">b</button>
"""

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def find_browser() -> str:
    if os.environ.get("CSS_PROBE_BROWSER"):
        return os.environ["CSS_PROBE_BROWSER"]
    for c in EDGE_CANDIDATES:
        if pathlib.Path(c).exists():
            return c
    for name in ("msedge", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    sys.exit("找不到 Edge/Chrome，可用 CSS_PROBE_BROWSER 指定可执行文件路径。")


def read_css(name: str) -> str:
    # 去掉 @font-face 的字体 url：探针不加载字体，留着只是 404 噪音
    return re.sub(r"src:\s*url\([^)]*\);", "", (STYLES / name).read_text(encoding="utf-8"))


def build_page(palette: str, mode: str) -> str:
    refs = sorted({t for _, t in PROBES})
    ref_html = "\n".join(
        f'<div id="ref-{r[2:]}" style="background: var({r})"></div>' for r in refs
    )
    probes_js = "[" + ",".join(f"[{s!r},{t!r}]" for s, t in PROBES) + "]"
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
{read_css("theme.css")}
{read_css("palettes.css")}
{read_css("global.css")}
/* 关掉 modal-in 入场动画（opacity 0→1 的 0.16s），否则截图/量测会撞上首帧 */
.modal {{ animation: none !important; }}
</style></head>
<body data-theme="{mode}" data-palette="{palette}">
{MARKUP}
{ref_html}
<pre id="out"></pre>
<script>
const PROBES = {probes_js};
const bg = (el) => (el ? getComputedStyle(el).backgroundColor : "MISSING");
const out = [];
for (const [sel, token] of PROBES) {{
  const got = bg(document.querySelector(sel));
  const want = bg(document.getElementById("ref-" + token.slice(2)));
  out.push((got === want ? "MATCH   " : "MISMATCH") + " " +
           sel.padEnd(34) + got.padEnd(22) + "vs " + token);
}}
document.getElementById("out").textContent = out.join("\\n");
</script>
</body></html>
"""


def main() -> int:
    browser = find_browser()
    wanted = sys.argv[1:] or PALETTES
    bad: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for palette in wanted:
            for mode in MODES:
                page = pathlib.Path(tmp) / f"probe-{palette}-{mode}.html"
                page.write_text(build_page(palette, mode), encoding="utf-8")
                if os.environ.get("CSS_PROBE_KEEP"):
                    # 排查用：把生成的探针页留在仓库根，直接用浏览器打开看
                    (ROOT / f".tmp-probe-last-{palette}-{mode}.html").write_text(
                        page.read_text(encoding="utf-8"), encoding="utf-8"
                    )
                dom = subprocess.run(
                    [browser, "--headless=new", "--disable-gpu", "--no-first-run",
                     "--dump-dom", page.as_uri()],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                m = re.search(r'<pre id="out">(.*?)</pre>', dom.stdout, re.S)
                print(f"── {palette} / {mode}")
                if not m or not m.group(1).strip():
                    bad.append(f"{palette}/{mode}: 探针没产出结果")
                    print(f"   (无输出) rc={dom.returncode} stdout={len(dom.stdout)}B")
                    if dom.stderr.strip():
                        print("   stderr: " + dom.stderr.strip().splitlines()[-1][:200])
                    continue
                for line in m.group(1).strip().splitlines():
                    print("   " + line)
                    if line.startswith("MISMATCH"):
                        bad.append(f"{palette}/{mode}: {line}")

    print()
    if bad:
        print(f"✗ {len(bad)} 处不一致：")
        for b in bad:
            print("  " + b)
        return 1
    print(f"✓ {len(wanted) * len(MODES)} 组（配色 × 明暗）令牌关系全部成立")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
