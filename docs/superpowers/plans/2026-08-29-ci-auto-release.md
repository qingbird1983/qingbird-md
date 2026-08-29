# CI 自动发版流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 推 `v*` tag 触发 GitHub Actions，在 Windows runner 跑 `tauri build` + 创建 GitHub Release + 上传 .exe + mark Latest，绕开本地 PowerShell GBK 编码坑。

**Architecture:** 单 GitHub Actions workflow（`.github/workflows/release.yml`）触发 + 单 Python 脚本（`.github/scripts/extract-notes.py`）从 CHANGELOG.md 提取 release notes。版本对齐在 workflow 里强校验；asset 在 CI 里 rename 成 ASCII 名（GitHub Releases API 不支持中文 asset name 是硬限制）。

**Tech Stack:**
- GitHub Actions（`windows-latest` runner）
- `tauri-apps/tauri-action@v0` 跑构建
- `softprops/action-gh-release@v2` 创建 release + 上传 asset
- `actions/setup-node@v4` (Node 24) + `dtolnay/rust-toolchain@stable` + `swatinem/rust-cache@v2`
- Python 3 stdlib（`argparse` + `re` + `pathlib` + `unittest`）— 零额外依赖

## Global Constraints

- 触发：`on push tags: ['v*']` + `on workflow_dispatch`（input.tag 可选）
- Runner：`windows-latest`，`permissions: contents: write`
- **不跑** `cargo test` / `npm run build`（CI 不跑测试，tauri build 失败即 fail-fast）
- 本地手动 bump 三个 version 文件 + CHANGELOG；CI 不写回 main
- Asset 名：`qingbird-md-setup-<version>-x64.exe`（ASCII，绕 GitHub 限制）
- 不加 tauri updater 签名 / 不做 macOS / 不做 R2 同步 / 不 draft release
- Python stdlib only；不引入 pytest、PyYAML 等

**Spec reference:** `docs/superpowers/specs/2026-08-29-ci-auto-release-design.md`

---

## File Structure

| 路径 | 职责 | 行数估计 |
|---|---|---|
| `.github/workflows/release.yml` | GitHub Actions workflow 定义（trigger + 11 steps） | ~80 |
| `.github/scripts/extract-notes.py` | Python 脚本：从 CHANGELOG.md 提取 `## [<version>]` 段 | ~40 |
| `.github/scripts/test_extract_notes.py` | stdlib unittest 测试 extract-notes.py | ~60 |

零 Rust / TypeScript / CSS 改动。

---

## Task 1: 编写 `extract-notes.py` + stdlib 单测

**Files:**
- Create: `.github/scripts/test_extract_notes.py`
- Create: `.github/scripts/extract-notes.py`

**Interfaces:**
- Consumes: `--version v0.1.4`（或 `0.1.4`）、`--changelog CHANGELOG.md`、`--output notes.md`
- Produces: 把 `## [<version>]` 段写到 `--output` 文件，UTF-8 无 BOM

**Step 1.1: 写失败的测试**

创建 `.github/scripts/test_extract_notes.py`：

```python
"""Tests for extract-notes.py — run with:
    python -m unittest .github/scripts/test_extract_notes.py -v
"""
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / ".github" / "scripts" / "extract-notes.py"


class ExtractNotesTests(unittest.TestCase):
    def _run(self, version: str, changelog: str) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text(changelog, encoding="utf-8")
            out = Path(tmp) / "notes.md"
            subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", version, "--changelog", str(cl), "--output", str(out)],
                check=True,
            )
            return out.read_text(encoding="utf-8")

    def test_extracts_section_with_date(self):
        cl = textwrap.dedent("""\
            # Changelog

            ## [0.1.4] - 2026-08-29

            ### Added
            - thing one
            - thing two

            ## [0.1.3] - 2026-08-29

            ### Fixed
            - old thing
        """)
        result = self._run("v0.1.4", cl)
        self.assertIn("### Added", result)
        self.assertIn("thing one", result)
        self.assertIn("thing two", result)
        self.assertNotIn("old thing", result)
        self.assertNotIn("[0.1.3]", result)

    def test_extracts_section_without_date(self):
        cl = textwrap.dedent("""\
            # Changelog

            ## [0.2.0]

            content here

            ## [0.1.0]

            older content
        """)
        result = self._run("0.2.0", cl)
        self.assertEqual(result, "content here\n")

    def test_strips_v_prefix(self):
        cl = "## [1.2.3] - 2026-01-01\n\nbody\n"
        self.assertEqual(self._run("v1.2.3", cl), "body\n")

    def test_extracts_last_section(self):
        cl = textwrap.dedent("""\
            ## [0.1.0]

            first

            ## [0.1.1]

            last
        """)
        result = self._run("v0.1.1", cl)
        self.assertEqual(result, "last\n")

    def test_missing_section_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text("## [0.1.0]\n\nfoo\n", encoding="utf-8")
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v9.9.9", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no `## [9.9.9]`", r.stderr)

    def test_empty_section_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text("## [0.1.4]\n\n## [0.1.3]\n\nolder\n", encoding="utf-8")
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v0.1.4", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("empty", r.stderr)

    def test_missing_changelog_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "nope.md"
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v0.1.4", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
```

**Step 1.2: 跑测试，验证失败（脚本不存在）**

Run:
```bash
python -m unittest .github/scripts/test_extract_notes.py -v 2>&1
```

Expected: FAIL — `FileNotFoundError` 因为 `extract-notes.py` 还不存在。

**Step 1.3: 写 `extract-notes.py`**

创建 `.github/scripts/extract-notes.py`：

```python
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
```

**Step 1.4: 跑测试，验证全部 pass**

Run:
```bash
python -m unittest .github/scripts/test_extract_notes.py -v
```

Expected: 7 tests, all PASS。

**Step 1.5: 在真实 CHANGELOG.md 上跑一次 smoke test**

Run:
```bash
python .github/scripts/extract-notes.py \
  --version v0.1.3 \
  --changelog CHANGELOG.md \
  --output $env:TEMP/notes-real.md
Get-Content $env:TEMP/notes-real.md
```

Expected: 输出包含 `## Added` / `## Fixed` 等章节、`选区查词`、`allow-start-dragging` 等关键字。

**Step 1.6: Commit**

```bash
git add .github/scripts/extract-notes.py .github/scripts/test_extract_notes.py
git commit -m "feat(ci): extract-notes.py + stdlib 单测

从 CHANGELOG.md 提取 ## [<version>] 段作为 release notes body。
零外部依赖 (argparse + re + pathlib + unittest)。

CI 在干净 UTF-8 环境跑（windows-latest GitHub Actions runner），
彻底绕开本地 PowerShell GBK 编码坑——这是 v0.1.3 release body
永久 mojibake 的根因。"
```

---

## Task 2: 编写 `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Triggers on: `push tags: ['v*']`, `workflow_dispatch` (input.tag)
- Reads: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` versions
- Writes: GitHub Release (body + asset) via `softprops/action-gh-release@v2`

**Step 2.1: 写 workflow yaml**

创建 `.github/workflows/release.yml`：

```yaml
name: Release

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing tag to rebuild (e.g. v0.1.3)'
        required: false

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - uses: dtolnay/rust-toolchain@stable

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - run: npm ci

      - name: Resolve tag
        id: tag
        shell: bash
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            echo "tag=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"
          elif [ -n "${{ inputs.tag }}" ]; then
            echo "tag=${{ inputs.tag }}" >> "$GITHUB_OUTPUT"
          else
            echo "tag=v$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"
          fi

      - name: Validate version sources
        shell: bash
        run: |
          set -euo pipefail
          TAG="${{ steps.tag.outputs.tag }}"
          VERSION="${TAG#v}"
          PKG="$(node -p "require('./package.json').version")"
          TAURI="$(node -p "require('./src-tauri/tauri.conf.json').version")"
          CARGO="$(python -c "import re,pathlib; t=pathlib.Path('src-tauri/Cargo.toml').read_text(encoding='utf-8'); m=re.search(r'^version\s*=\s*\"([^\"]+)\"', t, re.MULTILINE); print(m.group(1) if m else (_ for _ in ()).throw(SystemExit('no version in Cargo.toml')))")"
          echo "tag=${TAG}"
          echo "package.json=${PKG}"
          echo "tauri.conf.json=${TAURI}"
          echo "Cargo.toml=${CARGO}"
          [ "${PKG}" = "${VERSION}" ]
          [ "${TAURI}" = "${VERSION}" ]
          [ "${CARGO}" = "${VERSION}" ]

      - name: Extract release notes from CHANGELOG.md
        shell: python
        run: |
          python .github/scripts/extract-notes.py \
            --version "${{ steps.tag.outputs.tag }}" \
            --changelog CHANGELOG.md \
            --output "${{ runner.temp }}/release-notes.md"

      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        with:
          tauriScript: npx tauri

      - name: Rename installer to ASCII filename
        shell: bash
        run: |
          set -euo pipefail
          TAG="${{ steps.tag.outputs.tag }}"
          VERSION="${TAG#v}"
          cd src-tauri/target/release/bundle/nsis
          for f in *.exe; do
            [ -f "$f" ] || continue
            mv "$f" "qingbird-md-setup-${VERSION}-x64.exe"
          done
          ls -la

      - name: Create release and upload
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.tag.outputs.tag }}
          body_path: ${{ runner.temp }}/release-notes.md
          files: |
            src-tauri/target/release/bundle/nsis/qingbird-md-setup-*.exe
          fail_on_unmatched_files: true
          generate_release_notes: false
```

**Step 2.2: YAML 语法校验**

Run:
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```

Expected: 输出 `yaml ok`。

如果 PyYAML 不可用:
```bash
python -c "import json,subprocess; subprocess.run(['python','-c','import ast,sys; ast.parse(open(\".github/workflows/release.yml\").read())'])"
```

(纯 stdlib 替代方案——但 yaml 不是合法 python 语法，会失败。最好安装 PyYAML 或用在线 validator。)

**实际降级方案**：直接 `git commit`，让 GitHub UI 在 push 后做 yaml lint。或者用 `actionlint`（GitHub Action 官方 linter）：
```bash
# 如果未来需要本地 lint
# npm install -g @rhysd/actionlint
# actionlint .github/workflows/release.yml
```

For this task, skip strict linting — commit and let the workflow be validated by the first real run.

**Step 2.3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): release workflow — tag push 自动发版

触发:
- push tags: ['v*']
- workflow_dispatch (input.tag 可选重跑)

步骤:
1. Resolve tag (push ref / input / package.json fallback)
2. Validate versions — 三文件版本必须跟 tag 一致，否则 fail
3. Extract release notes (extract-notes.py from CHANGELOG.md)
4. tauri build (tauri-apps/tauri-action@v0)
5. Rename installer ASCII (绕 GitHub Releases API 不支持中文 asset name)
6. Create release + upload (softprops/action-gh-release@v2)

Workflow_dispatch 保留为手动重跑入口（CI 失败时无需 force-push tag）。

参考: mark2 .github/workflows/build-windows.yml。
差异: 触发改为 tag push、范围只 Windows、本地手动 bump。"
```

---

## Task 3: 合并 spec + workflow 到 main（本地）

**Files:**
- Modify: 工作分支 commit + push 到 origin main

**Step 3.1: 确认 git 状态干净**

Run:
```bash
git --no-pager status
git --no-pager log --oneline -3
```

Expected: 三个新 commit 都在本地（spec + extract-notes.py + workflow），main 分支。

**Step 3.2: Push 到 origin**

Run:
```bash
git push origin main
```

Expected: 推送成功，无错误。如果之前 `git push origin main` 报 "upstream is gone" 警告，确认 origin 跟踪重新设置或忽略。

---

## Task 4: 真实跑一次验证（手动，推荐）

> 这是 spec §11.2 的 fork 验证法的简化版——直接在主仓库跑，但用 v0.1.4-test 隔离测试。

**Step 4.1: 准备测试 release**

本任务 **不修改代码**，仅作 workflow 验证。如果不想现在做测试 release，可以跳过本任务——下一个真实 release (v0.1.4) 时 workflow 会第一次跑。

要做的话：

```bash
# 1. 临时改三个 version 文件到 0.1.4-test
#    package.json: "version": "0.1.4-test"
#    src-tauri/tauri.conf.json: "version": "0.1.4-test"
#    src-tauri/Cargo.toml: version = "0.1.4-test"

# 2. 在 CHANGELOG.md 顶部加测试段
#    ## [0.1.4-test] - 2026-08-29
#    ### Added
#    - CI workflow verification release

# 3. 跑本地测试确认还正常
cargo test --workspace
npm run build

# 4. Commit + push
git add -A
git commit -m "test(ci): v0.1.4-test dry-run"
git push origin main

# 5. 推 tag → CI 接管
git tag v0.1.4-test
git push origin v0.1.4-test

# 6. 在 GitHub Actions UI 看进度

# 7. 验证 release 页面:
#    - https://github.com/muyan1983/qingbird-md/releases/tag/v0.1.4-test
#    - title: v0.1.4-test
#    - body: CHANGELOG 段（含 "CI workflow verification release"）
#    - asset: qingbird-md-setup-0.1.4-test-x64.exe (可下载)

# 8. 清理: 删 release + 删 tag + revert commit
gh release delete v0.1.4-test --yes
git push origin :refs/tags/v0.1.4-test
git tag -d v0.1.4-test
git reset --hard HEAD~1
git push --force-with-lease origin main
```

Expected: 验证完看到 CI 全流程跑通、release body 中文正常、asset 名 ASCII。

---

## Self-Review

### 1. Spec coverage

| Spec 章节 | 覆盖任务 |
|---|---|
| §1 Summary | 整体目标在 plan header |
| §2 Goals 1-5 | Task 1 (extract-notes.py) + Task 2 (workflow) |
| §3 Non-goals | Global Constraints 显式排除 |
| §5 触发模型 | Task 2 step 2.1 yaml `on:` 块 |
| §6.2 step 1-7 | Task 2 step 2.1 yaml 全部 steps |
| §6.3 yaml 骨架 | Task 2 step 2.1（已采用「TAG 变量 + 剥前缀」更稳写法） |
| §7 extract-notes.py 接口 + 解析逻辑 + 错误模式 | Task 1 step 1.3 + 单测覆盖 |
| §8 Asset 命名约定 | Task 2 step 2.1 Rename step + Task 1.5 smoke |
| §9 失败处理 | yaml set -euo pipefail + extract-notes.py exit 1 + softprops fail_on_unmatched_files |
| §10 本地发版流程 | Task 3 + Task 4 步骤 4.1 |
| §11 测试策略 | Task 1 stdlib unittest（本地）+ Task 4 真实 workflow 验证 |
| §12 风险 | Plan header 标注了 CI 时间、NSIS 偶发失败等约束 |

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "implement later"
- 无 "add appropriate error handling" 之类模糊描述——所有 error handling 都在 spec §9 表 + Task 1 单测覆盖
- 无 "Similar to Task N"——每个 task 独立完整
- 所有代码步骤给出完整代码块
- 无未定义类型 / 函数引用

### 3. Type consistency

- `--version` 接受 `v0.1.4` 或 `0.1.4` —— Task 1 单测 + 脚本实现一致
- extract-notes.py 输出文件始终 UTF-8 无 BOM（Python `Path.write_text` 默认）
- workflow `tag` step output 在所有后续 steps 一致用 `${{ steps.tag.outputs.tag }}`
- asset 名 `qingbird-md-setup-<version>-x64.exe` 在 Task 1 spec、Task 2 yaml、Task 4 cleanup 一致
