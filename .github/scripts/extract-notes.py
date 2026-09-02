#!/usr/bin/env python3
"""从 CHANGELOG.md 提取 `## [<version>]` 段的 release notes。

用法:
    python extract-notes.py --version v0.1.4 --changelog CHANGELOG.md --output notes.md

`--version` 接受 `v0.1.4` 或 `0.1.4`（自动 strip `v` 前缀）。

约定 CHANGELOG 段标题:
    ## [<version>]
    ## [<version>] - <YYYY-MM-DD>     <- 日期部分可选

失败模式:
    - CHANGELOG 不存在 → FileNotFoundError (exit 1)
    - 找不到对应段 → stderr + exit 1
    - 段为空 → stderr + exit 1
"""
import argparse
import re
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", required=True,
                   help="Release version (e.g. v0.1.4 or 0.1.4)")
    p.add_argument("--changelog", required=True,
                   help="Path to CHANGELOG.md")
    p.add_argument("--output", required=True,
                   help="Path to write extracted notes")
    args = p.parse_args()

    version = args.version.lstrip("v")
    # 段标题正则: `## [<version>]` 后可选 ` - <date>`
    header_re = re.compile(
        rf"^## \[{re.escape(version)}\](?:\s*-\s*\d{{4}}-\d{{2}}-\d{{2}})?\s*$",
        re.MULTILINE,
    )
    # 下一个段标题
    next_header_re = re.compile(r"^## \[[^\]]+\]", re.MULTILINE)

    text = Path(args.changelog).read_text(encoding="utf-8")
    match = header_re.search(text)
    if not match:
        print(f"ERROR: no `## [{version}]` section found in {args.changelog}",
              file=sys.stderr)
        return 1

    start = match.end()
    next_match = next_header_re.search(text, pos=start)
    end = next_match.start() if next_match else len(text)
    body = text[start:end].strip("\n").rstrip() + "\n"

    if not body.strip():
        print(f"ERROR: `## [{version}]` section is empty in {args.changelog}",
              file=sys.stderr)
        return 1

    Path(args.output).write_text(body, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
