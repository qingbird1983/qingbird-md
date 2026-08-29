# qingbird-md-rust — CI 自动发版流水线 — Design

**Date:** 2026-08-29 · **Status:** Draft for review · **Author:** agent

参考实现：mark2 `.github/workflows/build-windows.yml`（release-published 触发 + 三文件版本对齐 + tauri-action 构建 + softprops 上传）。本设计的关键差异：

- **触发改为 tag push**（不是 release-published），CI 负责创建 release，避免人工手动写 release notes 的编码坑。
- **范围只 Windows**（mark2 跨平台，qingbird-md 事实 Windows-only）。
- **本地手动 bump**（不是 CI 自动 bump），避免 CI 写回 main 触发的递归 / 权限 / 并发问题。

## 1. Summary

把当前的「本地手动跑 tauri build + 手动 `gh release create` + 手动上传 exe + 手动写 release notes」改为 **Git tag 推送触发 GitHub Actions**：

- 本地 bump 三个 version 文件 + 写 CHANGELOG 段 → commit → push
- `git tag v0.1.4 && git push --tags`
- CI 收到 tag push → 校验三文件版本 → `tauri build` → 从 CHANGELOG 提取段作 release notes → 创建 release → 上传 .exe → 自动 mark Latest

整条流水线在 GitHub Actions Linux/Windows runner 上跑，**绕开本地 PowerShell GBK 编码坑**（这是 v0.1.3 手动发布踩到的根因：PowerShell `Get-Content` 默认系统代码页读 UTF-8 文件，`gh CLI` 写文件也走 GBK，导致 release body 永久 mojibake；CI 在干净 UTF-8 环境跑，无此问题）。

## 2. Goals

1. **发版触发极简**：开发者只做 `git tag && git push --tags` 这一个动作，剩下的全是 CI 自动完成。
2. **版本强对齐**：CI 校验 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三个文件的 `version` 跟 git tag 一致，**不一致 fail-fast**（防止出现「tag 是 v0.1.4 但 Cargo.toml 是 0.1.3」这种半发版状态）。
3. **Release notes 自动从 CHANGELOG 提取**：CI 解析 `CHANGELOG.md` 的 `## [<version>]` 段作为 release body，开发者不再需要在 GitHub UI 写 notes（也彻底规避编码问题）。
4. **Asset 命名 ASCII-only**：CI 把 NSIS 输出的 `青鸟 Markdown_0.1.4_x64-setup.exe` rename 成 `qingbird-md-setup-0.1.4-x64.exe` 再上传（GitHub Release asset name 不支持非 ASCII，硬限制——v0.1.2 / v0.1.3 都是手动 rename 传的）。
5. **可手动重跑**：保留 `workflow_dispatch` 入口，CI 失败时无需 force-push tag 就能重跑。

## 3. Non-goals

- **macOS / Linux workflow**：项目事实 Windows-only（NSIS bundle target、`icons/icon.ico` 是 Windows 格式、README 仅提及 Windows 安装器）。以后真有跨平台需求再补 workflow。
- **CI 跑 `cargo test` / `npm run build`**：`npx tauri build` 失败 = workflow 失败 = 不创建 release，已经 fail-fast 了。CI 时间省 5–8 分钟。本地 pre-push 由开发者自己跑测试。
- **CI 自动 bump version**：版本号在本地随代码改动一起 commit（语义单元内聚）。CI 不写回 main。
- **tauri updater 签名**（`TAURI_SIGNING_PRIVATE_KEY` / `update.json`）：项目目前无 in-app update 需求。YAGNI。
- **R2 / Cloudflare / Site API 同步**：mark2 自家基础设施需要，qingbird-md 没有。YAGNI。
- **Draft release**：CI 直接 publish。Tag 触发本身就是「这一版要发」的明示信号，不需要二次确认。
- **多 asset 上传**（如 .sig、.msi、 portable .zip）：先单 NSIS .exe。后续要 MSI / portable 用 `tauri bundle` 加 target 即可。

## 4. 现状与改动面

### 4.1 现状（手动流程，v0.1.2 / v0.1.3 实操）

1. 本地 bump 三个 version 文件 + 写 CHANGELOG 段
2. `cargo update -p qingbird-md` 同步 `Cargo.lock`
3. `cargo test --workspace` + `npm run build` 验证
4. `git commit && git push origin main`
5. `git tag vX.Y.Z && git push origin vX.Y.Z`
6. `npx tauri build --bundles nsis`（本地 Windows 环境，~3 分钟）
7. 本地 rename NSIS 输出为 ASCII 名
8. `gh release create vX.Y.Z --title "..." --notes-file notes.md` + `gh release upload vX.Y.Z ...exe --clobber`

痛点：
- 第 6 步要求本地有 Windows + Rust + Node + NSIS 工具链，开发者机器绑定
- 第 8 步的 `--notes-file` 在 PowerShell 下走系统代码页（GBK）读 UTF-8 文件，导致 v0.1.3 release body 永久 mojibake（已修）
- Asset 上传要走两次（gh CLI create 不带 file + 单独 upload）
- 编码坑需要「用 Python 直接调 GitHub API + curl `--data-binary` + 手动 ASCII rename」这种绕过手段才能解

### 4.2 改动面

新增 3 个文件：

| 路径 | 用途 |
|---|---|
| `.github/workflows/release.yml` | GitHub Actions workflow 定义 |
| `.github/scripts/extract-notes.py` | 从 CHANGELOG.md 提取 `## [<version>]` 段的 Python 脚本 |
| `.github/scripts/test_extract_notes.py` | stdlib unittest 覆盖脚本（7 个测试，覆盖正常/缺段/缺文件/v 前缀等路径） |

零代码逻辑改动（`.rs` / `.ts` / `.css` 不动）。`tauri.conf.json` / `Cargo.toml` / `package.json` 仅作为被读取的 source of truth，不改 workflow 契约。

## 5. 触发模型

```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing tag to rebuild (e.g. v0.1.3)'
        required: false
```

- **`push tags: ['v*']`**：匹配 `v0.1.4` / `v1.0.0` / `v2.3.4-rc1` 等。不匹配 `release-0.1.4` / `0.1.4`（无 `v` 前缀）。
- **`workflow_dispatch`**：手动重跑入口。输入 `tag` 时用指定 tag 重建（用于 CI 中途失败时），不填则走 fallback（见 §6.2 step 1）。

CI 不会因为普通 commit push、PR、main 分支 push 触发——只有 tag push 或手动 dispatch。

## 6. Workflow 步骤

### 6.1 Runner 与权限

```yaml
jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write   # 创建 release + 上传 asset
```

`windows-latest` 跑 NSIS（GitHub-hosted runner 自动装 NSIS）。`contents: write` 是 `softprops/action-gh-release` 创建 release 所必需。

### 6.2 步骤清单（顺序）

#### Step 1: Resolve tag

```yaml
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
```

三种来源优先级：`push` event 的 ref name > `inputs.tag` > `package.json` version 加 `v` 前缀。

输出 `tag` 形如 `v0.1.4`。

#### Step 2: Validate versions

```yaml
- name: Validate version sources
  shell: bash
  run: |
    set -euo pipefail
    TAG="${{ steps.tag.outputs.tag }}"
    VERSION="${TAG#v}"
    PKG="$(node -p "require('./package.json').version")"
    TAURI="$(node -p "require('./src-tauri/tauri.conf.json').version")"
    CARGO="$(python -c "import re,pathlib; t=pathlib.Path('src-tauri/Cargo.toml').read_text(encoding='utf-8'); m=re.search(r'^version\s*=\s*\"([^\"]+)\"', t, re.MULTILINE); print(m.group(1) if m else (_ for _ in ()).throw(SystemExit('no version in Cargo.toml')))")"
    echo "tag=${TAG}, package.json=${PKG}, tauri.conf.json=${TAURI}, Cargo.toml=${CARGO}"
    [ "${PKG}" = "${VERSION}" ]
    [ "${TAURI}" = "${VERSION}" ]
    [ "${CARGO}" = "${VERSION}" ]
```

`[ "${X}" = "${VERSION}" ]` 在不一致时 exit 1。Python 用 `pathlib.read_text(encoding='utf-8')`（CI runner 默认 UTF-8，无编码坑）。

#### Step 3: Extract release notes

```yaml
- name: Extract release notes from CHANGELOG.md
  shell: bash
  run: |
    python .github/scripts/extract-notes.py \
      --version "${{ steps.tag.outputs.tag }}" \
      --changelog CHANGELOG.md \
      --output "${{ runner.temp }}/release-notes.md"
```

脚本逻辑见 §7。失败时 exit 1（找不到对应段 / CHANGELOG 缺失）。

#### Step 4: Setup toolchain

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0   # 需要完整 git history 验证 tag

- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: npm

- uses: dtolnay/rust-toolchain@stable

- uses: swatinem/rust-cache@v2
  with:
    workspaces: src-tauri

- run: npm ci
```

按 mark2 经验配：Node 24、npm cache、Rust cache（避免每次重编）。

#### Step 5: Build Tauri

```yaml
- name: Build Tauri
  uses: tauri-apps/tauri-action@v0
  with:
    tauriScript: npx tauri
```

`tauri-action` 自动跑 `npx tauri build`，产出 NSIS 安装器到 `src-tauri/target/release/bundle/nsis/`。Windows runner 已预装 NSIS 工具，无需额外配置。

不传 `tagName` / `releaseName` / `releaseBody` / `releaseDraft`——这些交给后续的 `softprops/action-gh-release` 统一处理。

不传 `tauriUpdaterArtifacts`——本设计明确不要 updater 签名。

#### Step 6: Rename installer

```yaml
- name: Rename installer to ASCII filename
  shell: bash
  run: |
    set -euo pipefail
    VERSION="${${{ steps.tag.outputs.tag }}#v}"
    cd src-tauri/target/release/bundle/nsis
    # 兼容可能的 productName 变体（中英文混合、含空格等）
    for f in *.exe; do
      [ -f "$f" ] || continue
      mv "$f" "qingbird-md-setup-${VERSION}-x64.exe"
    done
    ls -la
```

匹配所有 `*.exe`，rename 为约定的 ASCII 名 `qingbird-md-setup-<version>-x64.exe`（沿用 v0.1.2 命名风格）。多个 .exe 时全部 rename——后续 upload 用通配符 `qingbird-md-setup-*.exe`。

#### Step 7: Create release + upload asset

```yaml
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

- `body_path`：从 step 3 提取的 notes 文件。`softprops` 会读这个文件当 release body（在 GitHub UI 显示的就是它）。
- `fail_on_unmatched_files: true`：找不到 .exe 时 fail，避免「release 创建了但没 asset」的半发版状态。
- `generate_release_notes: false`：不用 GitHub 自动生成的 PR-based notes（那会塞一堆 PR 列表，跟项目当前的「中文段 + Added/Fixed」风格不一致）。

softprops action 自动把新 release 标为 Latest（因为是按 tag 创建的最新 release）。

### 6.3 完整 workflow yaml 骨架

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
          echo "tag=${TAG}, package.json=${PKG}, tauri.conf.json=${TAURI}, Cargo.toml=${CARGO}"
          [ "${PKG}" = "${VERSION}" ]
          [ "${TAURI}" = "${VERSION}" ]
          [ "${CARGO}" = "${VERSION}" ]

      - name: Extract release notes from CHANGELOG.md
        shell: bash
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

> 注：本设计 §6.3 中已统一采用「先赋值 TAG 变量再剥前缀」写法，避免 `${${{ ... }}#v}` 嵌套 hack。
>
## 7. `extract-notes.py` 脚本规格

### 7.1 接口

```python
# .github/scripts/extract-notes.py
"""
从 CHANGELOG.md 提取 `## [<version>]` 段的 release notes。

约定 CHANGELOG 格式（参考现有 CHANGELOG.md）：
- 段标题：`## [<version>] - <YYYY-MM-DD>` 或 `## [<version>]` 两种都允许
- 段间用空行分隔
- 段内可以是任意 markdown（CI 透传给 GitHub release body）

失败：
- 文件不存在 → exit 1
- 找不到对应段 → exit 1
- 段为空 → exit 1
"""
```

CLI：
```
python extract-notes.py --version v0.1.4 --changelog CHANGELOG.md --output notes.md
```

`--version` 接受 `v0.1.4` 或 `0.1.4`（自动 strip `v` 前缀）。

### 7.2 解析逻辑

```python
import argparse, re, sys
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--version', required=True)
    p.add_argument('--changelog', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()

    version = args.version.lstrip('v')
    # 段标题正则：`## [<version>]` 后可选 `- <date>`
    header_re = re.compile(rf'^## \[{re.escape(version)}\](?:\s*-\s*\d{{4}}-\d{{2}}-\d{{2}})?\s*$', re.MULTILINE)
    # 下一个段标题正则：`## [` 后跟任何 version 字符串
    next_header_re = re.compile(r'^## \[[^\]]+\]', re.MULTILINE)

    text = Path(args.changelog).read_text(encoding='utf-8')
    match = header_re.search(text)
    if not match:
        print(f'ERROR: no `## [{version}]` section found in {args.changelog}', file=sys.stderr)
        sys.exit(1)

    start = match.end()
    # 找下一个段标题位置
    next_match = next_header_re.search(text, pos=start)
    end = next_match.start() if next_match else len(text)
    body = text[start:end].strip('\n').rstrip() + '\n'

    if not body.strip():
        print(f'ERROR: `## [{version}]` section is empty', file=sys.stderr)
        sys.exit(1)

    Path(args.output).write_text(body, encoding='utf-8')

if __name__ == '__main__':
    main()
```

要点：
- 用 `^## \[<version>\]` 精确匹配版本段标题（不误匹配 `### Added` 这种子标题）
- 找下一个 `## [` 切尾，正确处理多版本并存
- 段尾 `\n` trim 到单个换行
- Python 默认 UTF-8，无编码坑

### 7.3 错误模式

| 情况 | 行为 |
|---|---|
| CHANGELOG.md 不存在 | `FileNotFoundError` → exit 1 |
| 找不到对应段 | stderr 输出 `ERROR: no ...` → exit 1 |
| 段内容为空 | stderr 输出 `ERROR: empty ...` → exit 1 |
| `--version` 格式异常 | argparse exit 2 |

## 8. Asset 命名约定

| 阶段 | 路径 | 来源 |
|---|---|---|
| NSIS 输出 | `src-tauri/target/release/bundle/nsis/青鸟 Markdown_<version>_x64-setup.exe` | `tauri build` 用 `tauri.conf.json` 的 `productName` 生成 |
| CI rename 后 | `src-tauri/target/release/bundle/nsis/qingbird-md-setup-<version>-x64.exe` | step 6 |
| Release asset | `qingbird-md-setup-<version>-x64.exe`（同 URL） | softprops 上传 |

为什么必须 rename：GitHub Releases API 对 asset name 的非 ASCII 字符硬限制 strip（v0.1.3 验证过：PATCH `{"name": "青鸟 ..."}` 返回 200 但 name 字段被服务端重写为 ASCII）。CI rename 一次性解决，避免依赖 GitHub 未来可能的变化。

为什么保留中文 `productName`：Windows 应用安装后的「开始菜单」「卸载程序」「任务栏」显示名都来自 `productName`。改成 ASCII 会让用户看到 `Qingbird Markdown` 而不是 `青鸟 Markdown`。这是产品体验问题，不能为发版便利牺牲。

## 9. 失败处理

| 失败点 | CI 表现 | Release 是否创建 | 修复路径 |
|---|---|---|---|
| 三个文件版本对不上 | validate step exit 1，workflow 红 | 不创建 | 本地改三个文件 + commit + force-push tag |
| CHANGELOG 找不到对应段 | extract step exit 1，workflow 红 | 不创建 | 本地补 CHANGELOG 段 + commit + 删旧 tag 重推 |
| `tauri build` 失败 | tauri-action step 红 | 不创建 | 修复代码 + 新 commit + 删旧 tag 重推 |
| Rename 找不到 .exe | mv 失败 exit 1，workflow 红 | 不创建 | 检查 `tauri.conf.json` 的 bundle 配置 |
| softprops 上传失败 | step 红 | release 已创建但 asset 可能未上传完整 | `gh release upload <tag> <file> --clobber` 补传，或 `gh release delete <tag> --yes` + 删 tag + 重推 |
| workflow_dispatch 输入无效 tag | resolve step 写出无效 tag，后续 step 全 fail | 不创建 | 修正输入重跑 |

**删 tag 重推的标准流程**（开发者侧）：
```bash
git tag -d v0.1.4
git push origin :refs/tags/v0.1.4
# 修复问题
git commit --amend  # 或新 commit
git push origin main
git tag v0.1.4
git push origin v0.1.4
```

或者用 `workflow_dispatch` 直接输入已存在的 tag 重跑，避免删 tag。

## 10. 本地发版流程（新）

```bash
# 1. 在 main 分支上做改动 + bump
#    - 改 package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml 的 version
#    - 在 CHANGELOG.md 顶部加 ## [<version>] - <date> 段
#    - cargo update -p qingbird-md 同步 Cargo.lock

# 2. 本地验证（CI 不跑这些，省时间）
cargo test --workspace
npm run build

# 3. commit + push
git add -A
git commit -m "release: v0.1.4 — <主题>"
git push origin main

# 4. 推 tag → CI 自动接管
git tag v0.1.4
git push origin v0.1.4

# 5. 在 GitHub Actions UI 看进度。CI 完成 → release 自动出现在 Releases 页面
```

## 11. 测试

### 11.1 不跑测试（在 CI 阶段）

CI 阶段不跑 `cargo test` / `npm run build`（见 §3 Non-goals）。理由：tag 触发意味着开发者已经主动声明「要发版」，本地产物验证是开发者责任。CI 的责任是「接收 tag → 跑完整 build 流水线 → 创建 release」，跑测试与流水线冗余且费时间。

### 11.2 验证 workflow 的方法（一次性，发版前）

workflow 第一次上线前在 fork repo（如 `muyan1983/qingbird-md-test`）跑一遍完整 tag push，验证全流程能跑通。再 merge 到主仓库。

具体步骤：
1. fork 仓库（或用临时 repo），push 此 workflow 的 commit 到一个 dev 分支
2. 模拟 bump：把三个 version 文件改成 `0.0.0-test`，加 CHANGELOG 段，commit + push
3. 推 `v0.0.0-test` tag → CI 跑通
4. 在 fork 上验证 release 页面：标题、body 中文显示正常、asset 名为 `qingbird-md-setup-0.0.0-test-x64.exe` 且能下载
5. 删除 fork 上的 release 和 tag，merge 此 spec 到主仓库

注意：`workflow_dispatch` 复用已存在 tag 时，softprops 默认 update 现有 release（不会新建），同名 asset 会被 GitHub 拒绝，softprops 会 fail。重跑时先 `gh release delete <tag> --yes` + 删 tag 或 `gh release delete-asset`。因此**不要**把 `workflow_dispatch` 当 dry-run 用——它是真的写。

### 11.3 后续 PR 阶段（可选，未在本 spec）

`on: pull_request` 阶段跑 lint + test 是更稳的模式，但本 spec 不实现。理由：
- 仓库当前没有 PR workflow，加 CI 是 scope creep
- 主流程（tag push 自动发版）已经能解决手动发布的痛点
- 后续要补 PR 检查单独一个 spec 写

## 12. 风险与限制

1. **GitHub-hosted runner 时间**：第一次 build ~15-20 分钟（含 Rust 依赖编译），后续 build 有 cache ~5-8 分钟。release 频率低（项目当前 < 1 次/周），成本可接受。
2. **Windows runner 偶发 NSIS 失败**：极少数情况 GitHub runner 的 NSIS 工具链抽风。缓解：失败时用 `workflow_dispatch` 重跑同一 tag（无需 force-push）。
3. **本地 push tag 后无法撤销**：误推了 `v0.1.4` tag 到错误的 commit 上，需 force-push tag 或 `git tag -d && git push origin :refs/tags/v0.1.4`。
4. **Release 一旦公开就难以完全删除**：GitHub Releases 即使删除也在 git history 里能恢复。Mitigation：tag push 前本地 `git log` + `git diff` 校验 commit 内容。
5. **GitHub asset name 的非 ASCII 限制**：未来如果 GitHub 改了这条限制，rename step 可以简化或删除。当前依赖此限制做 rename 是「约束驱动设计」。
6. **CI 自动创建的 release 公开后立即可下载**：没有 draft 阶段做最终 review。如果发版内容错了，需要 `gh release delete v0.1.4 --yes` + 删 tag + 修复 + 重推。

## 13. 未来扩展（不在本 spec）

| 需求 | 改造点 |
|---|---|
| macOS / Linux 构建 | 新增 `build-macos.yml` / `build-linux.yml`，matrix include；`tauri.conf.json` 加对应 bundle target |
| tauri in-app updater | 配 `tauri-plugin-updater` + `update.json` endpoint；workflow 加 `TAURI_SIGNING_PRIVATE_KEY` secret + 上传 `.sig` |
| PR 阶段 lint + test | 新增 `ci.yml`，`on: pull_request`，跑 `cargo test` + `npm run build` + ESLint |
| 多 asset（MSI / portable） | `tauri.conf.json` 的 `bundle.targets` 加 `["nsis", "msi"]`；rename step 改成 `for f in *.exe *.msi` |
| R2 / 自有 CDN 分发 | 仿 mark2 加 `Sync EXE to R2` step，需 `R2_ACCESS_KEY_ID` 等 secret |
| 草稿 release + 手动 publish | softprops 加 `draft: true`，开发者 GitHub UI 点 Publish |

## 14. 文件清单

**新增**：

| 路径 | 字节数估计 | 内容 |
|---|---|---|
| `.github/workflows/release.yml` | ~2 KB | §6.3 的 workflow yaml |
| `.github/scripts/extract-notes.py` | ~1 KB | §7 的 Python 脚本 |
| `.github/scripts/test_extract_notes.py` | ~2 KB | §7 行为的 stdlib unittest（7 个测试） |

**不动**：

- `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` — 它们的 `version` 是 source of truth，CI 只读不写
- `Cargo.lock` — CI 不需要改它（`tauri build` 会自动用现有的 lock）
- 任何 `.rs` / `.ts` / `.css` — 零代码改动

**可选后续**（不在本 spec）：

- `docs/regression-checklist.md` — 加「CI 发版验证」条目
- `CHANGELOG.md` — 本次不发版时不动；如果在 merge 此 spec 时顺便发 v0.1.4，则加一段
