# qingbird-md (Rust)

带中英翻译的 Markdown 编辑阅读器 — **纯 Rust** 桌面应用（eframe/egui）。

这是把原 Electron 版 `qingbird-md` 用 Rust 重写的全新项目，功能保持一致。无 webview、无 JavaScript。

## 功能

- **Markdown 渲染阅读**：标题、列表（含任务）、表格、代码高亮（syntect）、引用、图片（相对路径）、行内格式、链接
- **中英翻译**：7 种翻译源 + auto 兜底（腾讯 Transmart → 金山 iCiba → MyMemory），译文/原文/中英对照三种阅读模式；翻译缓存（内存 + 磁盘）、相邻短段合并、长段分块、并发翻译
- **编辑**：源码/预览/分栏视图，格式工具栏（粗体/斜体/删除线、标题、列表、引用、代码、链接/图片/表格/分割线），撤销/重做，保存与脏点
- **左侧文档树**：打开工作区文件夹，按目录浏览全部 `.md` 文档，搜索过滤
- **右侧大纲**：自动提取 h1–h3 标题生成目录
- **主题切换**（亮/暗，并记住选择）
- **状态栏**：路径、字符/行数

## 运行

```bash
cargo run
```

## 测试

```bash
cargo test
```

## 打包（Windows 安装器）

1. `cargo build --release`（产物 `target\release\qingbird-md.exe`，已复制到 `release\qingbird-md.exe` 作为免安装绿色版）
2. 用 NSIS 打包（脚本注册 `.md`/`.markdown` 文件关联 + 桌面/开始菜单快捷方式，升级保留用户数据目录）：

```bash
# 需先安装 NSIS(Makensis) 并在 PATH 里
powershell -File scripts\package.ps1
# 或直接：makensis scripts\installer.nsi
# 产物：release\qingbird-md-setup-<版本>.exe
```

> 已产出：`release\qingbird-md-setup-0.1.0.exe`（本轮用 Electron 项目带的 NSIS 工具链构建成功）。它注册 `.md`/`.markdown` 文件关联、创建桌面/开始菜单快捷方式、支持覆盖升级并保留 `%APPDATA%` 用户数据。本机若没装 `makensis`，可直接复制 `release\qingbird-md.exe` 作为免安装绿色版。

## 项目结构

```
src/
├── main.rs            # eframe 入口 + 应用外壳（顶栏/侧栏/状态栏）
├── state.rs           # 运行时状态（文档、设置、缓存、翻译、主题、视图、工作区）
├── storage.rs         # 设置持久化（appdata\qingbird-md\*.json）
├── editor.rs          # Markdown 编辑操作（纯逻辑，可测试）
├── fileopen.rs        # 原生打开/保存/选目录对话框
├── workspace.rs       # 工作区 .md 树遍历 + 搜索过滤
├── markdown/          # 文档模型 + pulldown-cmark 解析 + egui 渲染器 + syntect 高亮
└── translate/         # 签名、7 翻译源、缓存、分批/分块/并发流水线
scripts/installer.nsi  # Windows NSIS 安装器
```

## 数据目录

设置与翻译缓存写于 `%APPDATA%\qingbird-md\`（`qingbird-settings.json`、`qingbird-cache.json`）。密钥不出本进程。
