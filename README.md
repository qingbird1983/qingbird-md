# qingbird-md (Rust + Tauri 2)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](CHANGELOG.md)

带中英翻译的 Markdown 编辑阅读器桌面应用 — **Rust 核心 + React/TypeScript 前端 + Tauri 2 IPC**。

这是把原 Electron 版 `qingbird-md` 迁移到 Tauri 2 的项目（中间经历 eframe/egui 纯 Rust 版，本轮迁回 webview 方案），功能与旧版保持一致：Rust 核心承载全部业务逻辑（Markdown 解析与 HTML 渲染、7 种翻译源签名/分批/并发流水线与缓存、设置持久化、工作区遍历、单实例与全局热键），React 前端（CodeMirror 6 编辑器 + zustand 状态）负责交互，两者经 Tauri 2 的 invoke 命令与事件通信，线格式契约由 `src/types/ipc.ts` 与 Rust DTO 逐字段对齐并测试锁定。

**文档打开预览的 IPC 流程**：`open_file` 为 async 命令，读取文件后顺带把首次 markdown 渲染结果装进 `DocDTO.parse` 一趟下发到前端 —— 预览打开即有首帧内容，不再走"打开文档 → 再调一次 `parse_markdown`"的两趟往返。`parse_markdown` 仍保留，专给编辑期内容变化后的重解析用（前端 150 ms 防抖，只解析停顿时的最终内容）。

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
npm i
npx tauri dev
```

（首次运行会自动执行 `npm run dev` 起 vite（localhost:5173），Rust 侧编译时间较长属正常。）

## 测试

```bash
cargo test --workspace   # Rust 核心单测（src-tauri）
npm run build            # tsc 严格编译 + vite 构建
```

## 打包（Windows 安装器）

```bash
npx tauri build
```

产物为 NSIS 安装器（`src-tauri/target/release/bundle/nsis/`）。`scripts/package.ps1` 是旧 eframe 版遗留脚本，未随本次迁移更新。

## 性能

冷启动目标：与旧 eframe exe 相近（webview 冷启动一般 ~600ms 内达标）。实测数据待人工回填，记录表见 [docs/regression-checklist.md](docs/regression-checklist.md) §0。

## 项目结构

```
src-tauri/src/            # Rust 核心
├── lib.rs                # Tauri setup + IPC 命令/事件接线
├── markdown/             # pulldown-cmark 解析 + HTML 渲染 + syntect 高亮
├── translate/            # 签名、7 翻译源、缓存、分批/分块/并发流水线
├── editor.rs             # Markdown 编辑操作（纯逻辑，可测试）
├── workspace.rs          # 工作区 .md 树遍历 + 搜索过滤
├── storage.rs            # 设置/缓存持久化（.bak 防损坏）
├── fileopen.rs           # 原生对话框参数冻结
├── single_instance.rs    # 单实例锁 + 第二实例文件参数 handoff
└── hotkeys.rs            # 全局热键注册（tauri-plugin-global-shortcut）
src/                      # React 前端
├── components/           # CodeMirror 6 编辑器、预览、工具栏、菜单、模态、命令面板
├── stores/               # zustand 状态（doc/translation/settings/ui/workspace）
├── lib/                  # ipc.ts 类型化调用层、api.ts、hotkeys.ts
└── types/ipc.ts          # Rust↔TS 线格式契约
docs/regression-checklist.md  # 人工回归手测清单
docs/superpowers/             # 设计 spec 与实施计划
LICENSE                       # MIT License
CHANGELOG.md                  # 版本变更记录
```

## 设计与计划文档

- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 许可证：[LICENSE](LICENSE)（MIT）
- 设计 spec：[docs/superpowers/specs/2025-06-16-tauri-v2-design.md](docs/superpowers/specs/2025-06-16-tauri-v2-design.md)
- 实施计划：[docs/superpowers/plans/2026-08-27-tauri-v2-gui-migration.md](docs/superpowers/plans/2026-08-27-tauri-v2-gui-migration.md)
- 回归手测清单：[docs/regression-checklist.md](docs/regression-checklist.md)

## 数据目录与凭据安全

设置与翻译缓存写于 `%APPDATA%\qingbird-md\`：

- `qingbird-settings.json` —— 翻译源选择、API 凭据、工作区路径、快捷键、主题等
- `qingbird-cache.json` —— 翻译结果缓存（按 provider + 文本 hash 索引）

**凭据（API key / secret）** 仅落本机 `qingbird-settings.json`，由用户本人在设置弹窗内输入（`secret: true` 字段以 `type="password"` 渲染，不进入任何日志 / toast / 截图）。**不出本进程、不上传、不进 git 历史**——此仓库的代码、提交记录、release 产物中均不包含任何真实凭据，`.gitignore` 也确保 `%APPDATA%` 路径不会被误纳入仓库。

损坏防护：加载时若发现 JSON 解析失败，会自动备份为 `*.bak` 并回退到默认值，下次保存即重建。

## 贡献与反馈

- **Bug / 需求**：在 [Gitee Issues](https://gitee.com/muyan1983/qingbird-md/issues) 提交，请附最小复现路径与系统信息（Windows 版本、WebView2 版本号）。
- **人工回归手测**：见 [docs/regression-checklist.md](docs/regression-checklist.md)，按节逐条勾选。
- **变更记录**：[CHANGELOG.md](CHANGELOG.md)。当前最新为 `0.1.0`。

## 已知限制

以下为迁移后如实记录的遗留项（来源见各任务报告）：

1. **事件无重放**：冷启动后前端监听挂载前（约数百 ms）到达的 `document-changed`、全局热键、单实例首开事件会丢失，再触发一次即可。单实例首开若实测证实丢失，将改拉取式（pull-command）兜底（T10/T29）。
2. **翻译 worker panic 会闩住 running 标志**：如验收出现一次即作为加 `catch_unwind` 兜底的依据（T8）。
3. **模态打开时 Mod+B/I 仍作用于背后文档**：旧 egui 行为平移，未加弹窗门控（T29）。
4. **旧设置文件含 Meta(Win) 组合**：静默不注册/不匹配，下次保存才出提示 toast（T29）。
5. **codemirror-lang-math**：低信任小型个人包（MIT，SRI 锚定），math 仅支持 fenced block，渲染质量待复验或替换（T13/T21）。
6. **工作区新建目录仅面向 Windows**：`joinUnderRoot` 硬编码 `\` 分隔符（T15）。
7. **清除翻译缓存不置文档脏标记**；被丢弃批次的旧 toast 可能残留（T26）。
8. **外观小项**：侧栏路径截断无省略号；第二实例经文件参数打开文档不点亮侧栏选中项；光标选区不随 source↔split 切换恢复（T16/T18/T22）。
9. **icon.ico 需 BMP 小帧**：`npx tauri icon` 会把全部帧写成 PNG 压缩（Windows 仅官方支持 256px 帧 PNG），winres 嵌入失败时 exe 回退 Tauri 默认图标。现用 Pillow 以 `bitmap_format="bmp"` 重造（源图 `src-tauri/icons/icon-source.png`）；将来重新生成图标后须照此检查帧格式。
