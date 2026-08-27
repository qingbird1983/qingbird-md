# 青鸟 Markdown — Tauri 2 GUI 重构设计

## 背景

`qingbird-md-rust` 当前是一个基于 **eframe/egui** 的纯 Rust 桌面应用，已经具备完整的 Markdown 渲染、7 路翻译流水线、工作区树、大纲、编辑工具栏、主题切换、设置持久化等能力，并能打包 Windows 安装器。

现决定改用 **Tauri 2 + React + TypeScript** 重构 GUI 层，同时**保留并复用现有 Rust 核心逻辑**，实现功能平替 + 视觉升级。

## 约束与决策（已由用户确认）

| 决策点 | 结论 |
|-------|------|
| 后端复用 | 现有 Rust 业务逻辑通过 Tauri commands 暴露给前端 |
| 前端框架 | React + TypeScript + Vite |
| 重构范围 | 平替迁移 + 视觉升级 |
| 编辑器 | CodeMirror 6（轻量、Markdown 友好） |

## 设计一：架构

```
qingbird-md-rust/
├── Cargo.toml                ← [workspace] members = ["src-tauri"]
├── src-tauri/
│   ├── Cargo.toml            ← lib 类型，依赖 tauri + serde
│   ├── tauri.conf.json
│   ├── build.rs
│   └── src/
│       ├── lib.rs            ← Tauri 入口 + 所有 #[tauri::command]
│       ├── markdown/         ← 原样保留（Block / parse / render / syntax）
│       ├── translate/        ← 原样保留（pipeline / 7 providers / cache / sign / http）
│       ├── editor.rs         ← 原样保留（apply_op）
│       ├── workspace.rs      ← 原样保留（walk / filter）
│       ├── state.rs          ← 缩为纯 DTO（去掉 egui / 纹理 / lock 等 UI 耦合）
│       ├── storage.rs        ← 原样保留
│       ├── fileopen.rs       ← 原样保留
│       └── single_instance.rs← 保留（Windows 文件关联去重）
├── src/                      ← React + TypeScript 前端
├── package.json
├── vite.config.ts
└── index.html
```

**迁移要点：**
- 现有 `main.rs` 的 eframe 应用壳（顶栏/侧栏/状态栏/菜单/快捷键）全部删除，改由前端实现
- `state.rs` 的 `doc.textures`（egui TextureHandle）删除 —— 图片改由 Tauri `tauri://asset` 协议在前端 `<img>` 加载
- `main.rs` 的 CJK 字体加载逻辑（Windows 雅黑/宋体扫描）移到前端 CSS `@font-face`
- `main.rs` 的快捷键绑定逻辑移到前端：全局热键用 Tauri `GlobalShortcut` 插件，编辑器内快捷键用前端键盘事件
- 翻译流水线（`translate/pipeline`）完全保留，这是项目核心资产

## 设计二：Tauri 2 配置

- **窗口**：`1280×860`，min `800×600`，居中 —— 对齐现有 eframe 设定
- **安全**：`security.csp: null`（因 Markdown HTML 渲染需内联内容）；通过 Tauri 权限白名单约束 IPC
- **插件**：`fs`（读写 appdata + 工作区）、`dialog`（文件/目录/保存选择）、`GlobalShortcut`（全局热键）
- **单实例**：Tauri 2 `singleInstance` 事件 + 现有 `single_instance` 文件锁，处理 Windows 文件关联去重
- **文件关联**：注册 `.md` / `.markdown` / `.txt`
- **打包**：继续使用 NSIS 安装器（Tauri 2 原生 bundler 支持 NSIS），保留现有 `scripts/installer.nsi` 思路

## 设计三：后端暴露的 Tauri commands

| 分组 | 命令 | 说明 |
|------|------|------|
| 文件 | `open_file(path)` | 读文件并解析，返回 DocDTO |
| 文件 | `save_file(path, content)` | 写文件 |
| 文件 | `pick_file()` / `pick_folder()` / `pick_save_path(default)` | 调用原生对话框 |
| 工作区 | `open_workspace(path)` | 递归遍历 .md 树 |
| 工作区 | `filter_workspace(tree, query)` | 搜索过滤，保留祖先目录 |
| 工作区 | `create_file(path)` / `create_folder(path)` | 新建 |
| 编辑 | `apply_op(content, sel, op)` | 纯函数格式化操作 |
| Markdown | `parse_markdown(content)` | 返回 `{ html, outline }` |
| Markdown | `image_path(local_path)` | 转 `tauri://asset` 协议 |
| 翻译 | `translate_document(content, settings, handle)` | 整篇翻译，带进度推送 |
| 翻译 | `translate_text(text, settings)` | 划词翻译 |
| 翻译 | `get_providers()` | 返回 7 个 provider 元数据 |
| 翻译 | `stop_translation()` | 取消进行中翻译 |
| 设置 | `load_settings()` / `save_settings(settings)` | 持久化 |
| 设置 | `get_user_data_dir()` | 返回 `%APPDATA%\qingbird-md` |

**Rust → 前端 Events：**
- `document-changed`：单实例收到待打开文件时推送
- `translation-progress`：整篇翻译进度推送
- `settings-updated`：设置变更通知

## 设计四：前端组件树

```
App
├── TopBar
│   ├── FileMenu       新建/打开/保存/另存/打开工作区/退出
│   ├── ViewMenu       视图切换/侧栏/大纲/主题
│   ├── TranslateMenu  原文/译文/中英对照
│   ├── SettingsMenu
│   └── HelpMenu
├── AppShell (CSS Grid 主布局 + 拖拽分割)
│   ├── Sidebar (left, 可折叠)
│   │   ├── SearchFilter         工作区文件搜索
│   │   ├── WorkspaceTree        TreeNode 递归渲染
│   │   └── WorkspaceToolbar     新建文件/文件夹/刷新/打开工作区
│   ├── MainArea
│   │   ├── EditorToolbar        15 个格式按钮 + 插入 + 翻译 + 撤销重做
│   │   ├── EditorArea           条件渲染
│   │   │   ├── EditorView       CodeMirror 6 源码编辑器
│   │   │   ├── PreviewView      Markdown HTML 渲染
│   │   │   └── SplitView        源码 + 预览左右各半
│   │   ├── TranslationBar       整篇翻译进度条 / 取消
│   │   └── BilingualOverlay     对照模式下译文浮层
│   ├── OutlinePanel (right, 可折叠)
│   │   └── OutlineList          h1/h2/h3 + 锚点跳转
│   └── StatusBar                路径 / 字符数 / 行数 / provider / 翻译状态
├── SettingsModal                  翻译源/凭据/主题/快捷键
├── CommandPalette                 Ctrl+Shift+P 全局命令面板
└── ToastContainer                 通知队列
```

## 设计五：视觉升级点

1. **侧栏树**：可折叠、层级缩进、文件图标、选中高亮、搜索过滤
2. **工具栏**：Lucide React 图标，hover 提示，按功能分组
3. **Markdown 预览**：GitHub 风格 CSS，代码块行号 + syntect 配色高亮 + 复制按钮
4. **中英对照**：译文以浅色背景浮在原段下方，不遮挡原文
5. **划词翻译**：选中文本后浮动 tooltip 显示译文
6. **命令面板**（Ctrl+Shift+P）：全局搜索动作
7. **主题**：CSS 变量 + `prefers-color-scheme` 自动跟随 + 平滑过渡
8. **Toast 通知**：保存成功、翻译完成、错误提示
9. **CJK 字体**：`@font-face` 加载微软雅黑 / 苹方 / Noto Sans SC

## 设计六：Store 设计（Zustand）

| Store | 关键字段 | 关键 Action |
|-------|---------|-------------|
| `useDocStore` | `doc`, `mode`, `view`, `cursorSel`, `isDirty` | `openDoc`, `setContent`, `applyFormat`, `saveDoc`, `switchView`, `switchMode`, `setCursorSel` |
| `useWorkspaceStore` | `root`, `tree`, `search`, `selectedPath` | `openWorkspace`, `selectFile`, `searchFilter`, `createFile`, `createFolder`, `refresh` |
| `useTranslationStore` | `mode`, `provider`, `result`, `status`, `progress`, `selection` | `translateDocument`, `translateSelection`, `stopTranslation`, `clearResult` |
| `useSettingsStore` | `settings`, `theme` | `load`, `save`, `updateProvider`, `updateCredentials`, `setTheme` |
| `useUiStore` | `showNav`, `showOutline`, `sidebarWidth`, `outlineWidth`, `toasts`, `commandPaletteOpen`, `settingsOpen` | `toggleNav`, `toggleOutline`, `addToast`, `openCommandPalette` |

## 设计七：编辑器选型

**CodeMirror 6**（不用 Monaco）：
- 核心 ~50KB，比 Monaco (~900KB) 小一个数量级 —— Tauri 冷启动是关键体验
- `@codemirror/lang-markdown` + `@replit/codemirror-lang-math` 即支持 Markdown
- `EditorView` 支持多视图共享同一 `State`，源码/预览双向同步光标
- `@codemirror/theme-one-dark` 一键切换，配合 CSS 变量做亮/暗

## 设计八：Rust 端 DTO（示意）

```rust
#[derive(serde::Serialize)]
pub struct DocDTO {
    pub name: String,
    pub path: Option<String>,
    pub content: String,
    pub base_dir: Option<String>,
    pub char_count: usize,
    pub line_count: usize,
}

#[derive(serde::Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: Option<String>,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

#[derive(serde::Deserialize)]
pub struct EditOp {
    pub content: String,
    pub sel: [usize; 2],
    pub op: String,
}
#[derive(serde::Serialize)]
pub struct EditResult {
    pub content: String,
    pub sel: [usize; 2],
}

#[derive(serde::Serialize)]
pub struct ParseResult {
    pub html: String,
    pub outline: Vec<OutlineItem>,
}
#[derive(serde::Serialize)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
}
```

## 不做的事（YAGNI）

- 不做协同编辑 / 多人实时同步
- 不做插件市场 / 第三方扩展
- 不做移动端（Tauri 2 的 mobile 支持单独处理）
- 不做完整的 Markdown 实时同步光标（先做基础源码↔预览联动即可）

## 成功标准

1. 现有功能全部可运行：Markdown 渲染、7 路翻译、工作区树、大纲、编辑工具栏、主题切换、设置持久化
2. Windows 单实例 + 文件关联正常
3. 可打包为 NSIS 安装器
4. 冷启动性能不低于现有 egui 版本
5. 现有 Rust 单元测试（`storage` / `workspace` / `editor`）通过
