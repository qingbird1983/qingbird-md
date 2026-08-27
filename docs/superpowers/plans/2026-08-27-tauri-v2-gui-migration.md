# Tauri 2 GUI 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Tauri 2 + React + TypeScript 替换 eframe/egui GUI 层，保留全部现有 Rust 核心逻辑（Markdown 模型、7 路翻译流水线、编辑操作、工作区、设置持久化、单实例），实现功能平替 + 视觉升级，可打 NSIS 安装器。

**Architecture:** 现有 Rust 业务代码整体迁入 `src-tauri/` 成为 Tauri 后端（lib 型 crate），通过 `#[tauri::command]` + Event 向前端暴露；删掉 eframe 壳与 egui 渲染层，新增 `markdown/html.rs` 把 Block 模型渲染成 HTML（含 syntect 高亮与翻译替换三种模式）。前端为 Vite + React + TS + Zustand 五个 store + CodeMirror 6 编辑器。

**Tech Stack:** Rust（tauri 2、tauri-plugin-dialog、pulldown-cmark、syntect、ureq、hmac/sha2/md-5/base64、fs2、dirs）· TypeScript（React 18、Zustand、CodeMirror 6、lucide-react、Vite）

## 规格来源

`docs/superpowers/specs/2025-06-16-tauri-v2-design.md`（决策点均已由用户确认）。

## Global Constraints

- 项目根：`F:\AIwork\qingbird-md-rust`。规格的每条约束逐字有效：窗口 1280×860 / min 800×600；`security.csp: null`；插件 dialog + GlobalShortcut + 单实例；文件关联 `.md/.markdown/.txt`；NSIS 打包。
- 不改翻译流水线语义（`translate/` 目录核心资产）；provider 的签名、URL、解析逻辑不动。
- 现有 Rust 单元测试必须持续通过（storage / workspace / editor / pipeline / cache / providers / sign / syntax / markdown/model）。
- 对规格的两处**有意偏差**（已按更简实现记录，执行者不得再扩大）：
  1. 不引入 `tauri-plugin-fs` —— 所有文件 IO 已经由 Rust command 覆盖，前端无需直接 fs 权限；
  2. 不用官方 single-instance 插件 —— 复用现有 `single_instance.rs` 文件锁方案，行为一致且已测试。
- 每个 Task 结束提交一次 commit（Conventional Commits）。前端不做单元测试基建（YAGNI），前端正确性以 `cargo test` + `npm run build`（含 tsc 类型检查）+ 任务内手动验证步骤兜底；所有算法性逻辑保留在 Rust 端并带测试。

---

## Phase 1 — 后端重组（Rust → src-tauri）

### Task 1: 建 workspace，代码迁入 src-tauri/

**Files:**
- Modify: `Cargo.toml`（根，改为 workspace）
- Create: `src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/main.rs`
- Move(git mv): `src/editor.rs` `src/storage.rs` `src/workspace.rs` `src/single_instance.rs` `src/fileopen.rs` `src/markdown/` `src/translate/` → `src-tauri/src/`
- Delete: `src/`（旧目录清空后移除）
- Create: `src-tauri/tauri.conf.json`、`src-tauri/icons/icon.ico`（先用 `tauri icon` 或占位 32×32 ico，Task 28 再换正式图标）

**Interfaces:**
- Consumes: 现有全部模块（原样搬移，不改内容）。
- Produces: 可 `cargo test` 全绿的 workspace；`qingbird_md_lib::run()` 尚未含命令但可编译。

- [ ] **Step 1: 迁移文件**

```powershell
git mv src editor-tmp; git mv markdown translate storage-editor-marking -ErrorAction SilentlyContinue
```
逐条执行（不要用上面这行，逐条写）：
```powershell
New-Item -ItemType Directory -Force src-tauri\src | Out-Null
git mv src\editor.rs src-tauri\src\editor.rs
git mv src\storage.rs src-tauri\src\storage.rs
git mv src\workspace.rs src-tauri\src\workspace.rs
git mv src\single_instance.rs src-tauri\src\single_instance.rs
git mv src\fileopen.rs src-tauri\src\fileopen.rs
git mv src\markdown src-tauri\src\markdown
git mv src\translate src-tauri\src\translate
Remove-Item -Recurse -Force src
```
注：旧 `main.rs`（eframe 壳）与 `state.rs` 不迁移，直接留在被删除的 src 里废弃。`fileopen.rs` 中 `pick_markdown_file/pick_folder/pick_save_path` 将在后续任务删除（对话框走 tauri 插件），先原样带入。

- [ ] **Step 2: 根 Cargo.toml 改 workspace**

```toml
[workspace]
members = ["src-tauri"]
resolver = "2"
```

- [ ] **Step 3: 写 src-tauri/Cargo.toml**

```toml
[package]
name = "qingbird-md"
version = "0.1.0"
edition = "2024"

[lib]
name = "qingbird_md_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[[bin]]
name = "qingbird-md"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
base64 = "0.23"
dirs = "6.0"
fs2 = "0.4"
hmac = "0.13"
md-5 = "0.11"
pulldown-cmark = "0.13"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
sha2 = "0.11"
syntect = { version = "5.3", default-features = false, features = ["default-fancy"] }
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
ureq = "2"
image = "0.25"

[profile.release]
codegen-units = 1
lto = true
strip = true
```
注意：**不**再引入 eframe/egui/rfd/crossbeam-channel。暂留 `image`（Task 2 删）。

- [ ] **Step 4: 写 build.rs 与 main.rs / lib.rs**

`src-tauri/build.rs`：
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/lib.rs`（临时最小版）：
```rust
mod editor;
mod fileopen;
mod markdown;
mod single_instance;
mod storage;
mod translate;
mod workspace;

pub fn run() {
    // Task 12 起填充真正入口
}

#[cfg(test)]
mod tests_import_check {
    #[test]
    fn modules_compile() {
        assert!(true);
    }
}
```

`src-tauri/src/main.rs`：
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qingbird_md_lib::run()
}
```

- [ ] **Step 5: 验证测试仍全绿**

Run: `cargo test --workspace`
Expected: 全部 PASS（editor/workspace/storage/pipeline/cache/providers/sign/model/syntax 各组测试均在）。若失败，只修路径问题不修逻辑。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(tauri): move rust core into src-tauri, set up cargo workspace"
```

---

### Task 2: 剥离 egui——删除渲染层，state 收敛

**Files:**
- Modify: `src-tauri/Cargo.toml`（去 image、移除对已删模块引用前的准备）
- Delete: `src-tauri/src/markdown/render.rs`（其纯函数在 Step 2 先迁出）、`src-tauri/src/markdown/mod.rs` 中相关声明
- 说明: 本任务做"逻辑迁移"，`state.rs` 不迁移即消失——文档/工作区/视图状态全部归前端 store，后端不需要 state.rs。

**Interfaces:**
- Consumes: `markdown/model.rs`、`translate/pipeline.rs`。
- Produces: 新文件 `src-tauri/src/markdown/units.rs`，暴露三个纯函数（从旧 render.rs 平移，零逻辑改动）：
  - `pub fn inline_plain_text(inlines: &[Inline]) -> String`
  - `pub fn collect_text_runs(blocks: &[Block]) -> Vec<(usize, String)>`
  - `pub fn collect_translatable(blocks: &[Block]) -> Vec<(usize, String)>`

- [ ] **Step 1: 先写迁移后的单元测试锚点**

创建 `src-tauri/src/markdown/units.rs`，底部放以下测试（作为行为不变的安全网）：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{parse_blocks};

    #[test]
    fn collect_runs_indexes_all_texts() {
        let blocks = parse_blocks("Hi\n\n中文 skip");
        let runs = collect_text_runs(&blocks);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0], (0, "Hi".into()));
    }

    #[test]
    fn collect_translatable_uses_block_plain_text() {
        let blocks = parse_blocks("# Eng title\n\n## 中文标题");
        let u = collect_translatable(&blocks);
        assert_eq!(u.len(), 1);          // 中文标题被 needs_translation 跳过
        assert_eq!(u[0].1, "Eng title");  // inline 前缀不带 "# "
    }
}
```

- [ ] **Step 2: 创建 units.rs 并从旧 render.rs 平移函数**

从 `git show HEAD~1 2>/dev/null || git log` 找回原 render.rs 内容；将 `inline_plain_text`、`collect_text_runs` + 私有 `walk_run_collect`/`collect_runs_inline`、`collect_translatable` + 私有 `walk_collect` 及顶部 `use crate::translate::pipeline::needs_translation;` 原样复制到 units.rs（保留原有注释），并把 `_nested` 参数连同调用一并去掉（它未被使用）。
`use super::model::{Block, Inline};` 按 model 导出路径调整。

- [ ] **Step 3: 在 mod.rs 注册并删除 render.rs**

`src-tauri/src/markdown/mod.rs` 最终形态：
```rust
pub mod html;     // Task 3 创建前会报错——本任务暂注释此行，Task 3 打开
pub mod model;
pub mod syntax;
pub mod units;

pub use model::{parse_blocks, Block};
```
本任务先写成无 `pub mod html;`。删除 `render.rs` 文件。检查 `grep -rn "render::"` src-tauri —— 仅 main.rs（未迁移，无关）。

- [ ] **Step 4: 运行测试**

Run: `cargo test --workspace`
Expected: PASS（旧 render.rs 无测试依赖它的断言；syntax 测试独立存活）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(markdown): drop egui renderer, keep translation unit collectors as pure funcs"
```

---

### Task 3: markdown/html.rs —— Block 模型 → HTML（原文/译文/对照三模式 + syntect）

**Files:**
- Create: `src-tauri/src/markdown/html.rs`
- Modify: `src-tauri/src/markdown/mod.rs`（加 `pub mod html;`）

**Interfaces:**
- Consumes: `model::{Block, Inline}`、`units::{collect_text_runs, collect_translatable, inline_plain_text}`、`syntax::highlight_spans`、`pipeline::needs_translation`。
- Produces（`ParseResult` 即 Task 9 的 command 返回值、DTO 目标形状之一）：

```rust
#[derive(serde::Serialize)]
pub struct OutlineItem { pub level: u8, pub text: String, pub id: String }

#[derive(serde::Serialize)]
pub struct ParseResult {
    pub html: String,
    pub outline: Vec<OutlineItem>,
}

/// 三种阅读模式的渲染：trans 为空 => 原文。
/// substituted：把每个可翻译 text run 按索引换成译文（保留粗体/链接/code 包裹）。
/// bilingual=true：在每个可翻译段落/标题原文下追加 <div class="tr-box">译文</div>。
pub fn render_html(content: &str, trans: &HashMap<usize, String>, bilingual: bool) -> ParseResult
```
HTML 输出元素：h1..h6（附 `id="h-{n}"` 锚点）、p（包裹行内 span 结构 `<strong><em><del><code>`）、blockquote、ul/ol/li（任务项加 class task done/todo）、table/thead/tbody/tr/th/td、hr、img（src 原样输出，相对路径由前端经 `convertFileSrc` 无法感知——由 `image_path` command 提供，见 Task 7：这里对相对路径直接输出 `<img data-src="{resolved_abs}" src="{data_src_即_convertFileSrc结果}">`？不行——后端算不出 convertFileSrc。改为输出绝对路径进 `src="/{abs_path}"`？Tauri asset 协议要求特定 host。**定案：html 里 img src 原样填后端拼好的相对/原始 src，预览组件在前端 DOM ready 后自行对每个 img 做 resolve+convertFileSrc 替换**（见 Task 16），后端不管图片）、code block：`<pre class="code-block"><div class="code-lang">{lang}</div><div class="code-copy"></div><code>含 syntect span（style=color:#rrggbb）</code></pre>` + 行号列 `<span class="ln">`。转义所有文本节点（`&<>"'`）。

- [ ] **Step 1: 先写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_mode_renders_basic_markdown() {
        let r = render_html("# Ti\n\ntext **b**.", &HashMap::new(), false);
        assert!(r.html.contains("<h1 id=\"h-1\">Ti</h1>"));
        assert!(r.html.contains("<strong>b</strong>"));
        assert_eq!(r.outline.len(), 1);
        assert_eq!(r.outline[0].text, "Ti");
    }

    #[test]
    fn substitution_replaces_runs_keeps_wrappers() {
        let md = "Hello **world** more";
        let _r = render_html(md, &HashMap::new(), false); // 触发首轮收集编号
        // run0=Hello, run1=world, run2=more（Run 序号跳过空格增量见 units 实现）
    }

    #[test]
    fn bilingual_appends_tr_box_below_paragraph() {
        let mut m = HashMap::new();
        m.insert(0usize, "你好世界".into());
        let r = render_html("Hello world", &m, true);
        assert!(r.html.contains(r#"<div class="tr-box">你好世界</div>"#));
    }
}
```
注意 substitution 编号规则以 `units::collect_text_runs` 实测为准：**执行时先跑一个 println 探针确认序列化编号，测试期望以实际编号修正后固定**（这是平替而非新发明——编号必须与 egui 版渲染完全一致：每个 Inline::Text 都 ++counter，可翻译者才入选）。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --package qingbird-md html`
Expected: FAIL 编译错误（html 未定义）。

- [ ] **Step 3: 实现 render_html**

骨架（完整实现约 300 行，结构如下，任何部分不得省略转义或编号一致性逻辑）：

```rust
//! Render the Block model to standalone HTML for the webview preview,
//! mirroring the deleted egui renderer's traversal orders exactly.

use std::collections::HashMap;

use super::model::{Block, Inline};
use super::syntax::highlight_spans;
use super::units::{collect_text_runs, inline_plain_text};
use crate::translate::pipeline::needs_translation;

// escape_html, render_inlines(html: &mut String, inlines, trans: Option<&HashMap>, counter: &mut usize)
// 结构照旧 renderer 的 push_inline / push_inline_sub 双份合并：trans=None 时用原文本，
// Some 时按 counter 查译文替换。LineBreak => "<br>"，Link => <a href=escaped>,
// Image inline => <img alt>, Code inline => <code>.

pub fn render_html(content: &str, trans: &HashMap<usize, String>, bilingual: bool) -> ParseResult {
    let blocks = super::model::parse_blocks(content);
    let outline = walk_outline(&blocks);
    let mut html = String::new();
    let empty = HashMap::new();
    let sub = if trans.is_empty() && !bilingual { None } else { Some(trans) };
    if !bilingual {
        for b in &blocks { block_to_html(&mut html, b, sub.clone_map()); }
    } else {
        for b in &blocks { block_bilingual(&mut html, b, trans, counter0()); }
    }
    ParseResult { html, outline }
}
```
辅助函数清单（都要落盘）：`walk_outline`（递归 Quote/List 收集 h1-h3，id = "h-{全局序号}"，与 egui 版 outline_items 同序）；`block_to_html`（Heading/Paragraph/Code/Quote/List/Rule/Image/Table 分派）；`inline_list_to_html`；`code_block_to_html`（调 highlight_spans；None 时整段单色 escape；行号 = `enumerate` 行数生成左侧 gutter div）；`block_substituted`（复用 block_to_html 但传入 trans 计数器）；`block_bilingual`（仅 Heading/Paragraph 参与，其余直通 block_to_html；可翻项 `needs_translation(plain)` 时在其后 append tr-box div）。其中 substituted 路径中 inline 渲染需携带 `(trans, &mut usize)`——用一个小结构体 `Sub<'t>{map:&'t HashMap,counter:Option<&mut usize>}` 传递避免双胞胎函数复制粘贴出错。counter 初值 0 全局贯穿一次调用。

定义时注意：Substituted 与 Original 共用一个 inline 渲染函数，签名为 `fn push_inline(out:&mut String, ils:&[Inline], s:&mut Sub)`，`Sub.counter: Option<usize>` 为 None 表示原文模式。table cells 同样走 push_inline。

- [ ] **Step 4: 运行测试通过**

Run: `cargo test --package qingbird-md html`
Expected: PASS。

- [ ] **Step 5: 在 mod.rs 加 `pub mod html;` 并全量回归**

Run: `cargo test --workspace`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(markdown): html renderer w/ outline, syntect spans, translation substitution + bilingual"
```

---

### Task 4: 取消能力——CancelableHttpClient（不改 pipeline 签名）

**Files:**
- Create: `src-tauri/src/translate/cancel.rs`
- Modify: `src-tauri/src/translate/mod.rs`（加 pub mod cancel）

**Interfaces:**
- Consumes: `http::HttpClient` trait；`std::sync::Arc<AtomicBool>`。
- Produces:
```rust
/// 包装任何 HttpClient；flag 变 true 后所有请求立即返回 Err("已取消")，
/// 让 pipeline 现有 Err 路径自然熔断（非缓存命中的批次会在下一批退出）。
pub struct CancelableClient<'a> { pub inner: &'a dyn HttpClient, pub cancel: &'a AtomicBool }

impl HttpClient for CancelableClient<'_> {
    fn get(&self, url:&str)      -> Result<HttpResp,String> { self.guard().and_then(|_| self.inner.get(url)) }
    fn post_form(...)            -> Result<HttpResp,String> { self.guard().and_then(|_| self.inner.post_form(url,params)) }
    fn post_json(...)            -> Result<HttpResp,String> { self.guard().and_then(|_| self.inner.post_json(url,body,headers)) }
    fn post_json_timeout(...){ same delegation }
}
fn guard(&self)->Result<(),String>{ if self.cancel.load(Ordering::Relaxed){Err("已取消".into())}else{Ok(())} }
```

- [ ] **Step 1: 写失败测试**
```rust
#[test]
fn cancelled_client_fails_fast(){
    let mock = MockClient::new();
    let f = AtomicBool::new(false);
    let c = CancelableClient{inner:&mock, cancel:&f};
    assert!(c.get("https://x").is_ok());
    f.store(true, Ordering::Relaxed);
    let e = c.get("https://x").unwrap_err();
    assert_eq!(e, "已取消");
}
```
（Mock 从现有 `http.rs` test_mock 引入——把它从 `#[cfg(test)]` 单测私有 mod 提升为 `pub(crate)`（仅保留 cfg(test) 门禁即可跨模块使用：在同一 crate 内 test cfg 已开启）。做法：`http.rs` 中 `#[cfg(test)] pub mod test_mock {...}` 改为 `#[cfg(test)] pub(crate) mod test_mock {...}`。）

- [ ] **Step 2: 失败运行** `cargo test cancel` → FAIL 编译错。
- [ ] **Step 3: 实现 CancelableClient**（如上，约 60 行）。
- [ ] **Step 4:** `cargo test --workspace` 全绿。
- [ ] **Step 5: Commit**: `feat(translate): cancellable http client wrapper for stop_translation`

---

### Task 5: Tauri 入口 + State + 文件/设置 commands

**Files:**
- Modify: `src-tauri/src/lib.rs`（重写为真正的 Tauri 入口）
- Modify: `src-tauri/Cargo.toml`（去掉 image、不再需要其它增项）

**Interfaces:**
- Produces（Task 14 的 ipc.ts 以这些确切名字为准）：
  - ManagedState:
    ```rust
    pub struct AppTxn {                 // .manage(AppTxn::default())
        pub cache: Mutex<Cache>,             // 翻译缓存共享
        pub cancel: Arc<AtomicBool>,         // 当前批次取消旗标
        pub running: Arc<AtomicBool>,
        pub gen: AtomicU64,                  // 代次：新一轮翻译 +1；事件里带上，前端丢弃过期
        pub lock_file: Mutex<Option<File>>,  // 单实例锁持有物，保进程生命周期
    }
    ```
  - commands：`load_settings()->Settings`、`save_settings(settings: Settings)`、`get_user_data_dir()->String`、
    `open_file(path: String) -> Result<DocDTO, String>`、
    `save_file(path: String, content: String) -> Result<(), String>`
  - DocDTO（spec 设计八）：
    ```rust
    #[derive(serde::Serialize)]
    pub struct DocDTO { name:String, path:Option<String>, content:String, base_dir:Option<String>, char_count:usize, line_count:usize }
    ```

- [ ] **Step 1: 定义 DTO 与 state**

新建 `src-tauri/src/dto.rs`：放 `DocDTO`、`TreeNodeDTO{name,path:Option,is_dir,children}`（spec 设计八 TreeNode）、`EditOp/EditResult/ParseResult 引用 markdown::html`、`ProviderInfoDto{key,label,note,needs_key,max_len,max_concurrency,fields:[{key,label,secret,placeholder}]}`。均 derive Serialize/Deserialize（Deserialize 仅 EditOp/settings 需要）。

settings 直接复用 `storage::Settings`（已有 serde derive）。

- [ ] **Step 2: lib.rs 重写**

```rust
mod dto;
mod editor;
mod fileopen;
mod markdown;
mod single_instance;
mod storage;
mod translate;
mod workspace;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

use translate::cache::Cache;

#[derive(Default)]   // File 不能 Default，稍后手工塞
struct AppTxn { /* 见上 */ }

impl AppTxn { fn new(lock: Option<std::fs::File>) -> Self {...} }

// ---- 文件 ----
#[tauri::command]
fn open_file(path: String) -> Result<dto::DocDTO, String> {
    let p = std::path::PathBuf::from(&path);
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(dto::DocDTO{
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "?".into()),
        path: Some(path),
        base_dir: p.parent().map(|d| d.to_string_lossy().into_owned()),
        char_count: content.chars().count(),
        line_count: content.lines().count(),
        content,
    })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---- 设置 ----
#[tauri::command]
fn load_settings() -> storage::Settings { storage::load_settings() }

#[tauri::command]
fn save_settings(settings: storage::Settings) {
    storage::save_settings(&settings);
}

#[tauri::command]
fn get_user_data_dir() -> String { storage::user_data_dir().to_string_lossy().into_owned() }

pub fn run() {
    let lock = single_instance::acquire_lock();
    if lock.is_none() {
        if let Some(p) = fileopen::file_arg_from_args(std::env::args().skip(1)) {
            single_instance::write_pending(&p);
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppTxn::new(lock))
        .invoke_handler(tauri::generate_handler![
            open_file, save_file, load_settings, save_settings, get_user_data_dir,
            // Task 7-11 追加于此
        ])
        .setup(|app| {
            // Task 10: 启动 pending 轮询线程 / 文件关联首启打开（暂略）
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
`AppTxn::new(lock)` 组装字段；`Default` 手工 impl（不给 File Default）。

- [ ] **Step 3: tauri.conf.json 初版**（细节 Task 12 补齐启动项）

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "青鸟 Markdown",
  "version": "0.1.0",
  "identifier": "com.qingbird.md",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [{
      "title": "青鸟 Markdown 阅读器",
      "width": 1280, "height": 860,
      "minWidth": 800, "minHeight": 600,
      "center": true
    }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": ["nsis"] }
}
```
需要先存在 `../dist` 才能编译通过吗？tauri context 要求 dist 存在于 build 时——本阶段前端尚未建立，devUrl 模式下可先行：`npm create vite@latest temp-ui -- --template react-ts` 不必，直接建一个 `dist/index.html` 占位（Task 13 会真正脚手架，届时删除占位重建）。

- [ ] **Step 4: capabilities**

Create `src-tauri/capabilities/default.json`:
```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "core:event:default"
  ]
}
```

- [ ] **Step 5: 编译验证**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 编译成功（会自动下载 tauri 系依赖）。若 Windows 缺 WebView2/LINK 工具报错，报告执行环境问题不要绕过（下一 Task 继续命令级验证不依赖运行）。

- [ ] **Step 6: Commit**: `feat(tauri): entry point, managed txn state, file & settings commands`

---

### Task 6: 工作区 + 编辑器纯逻辑 commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:
  - `open_workspace(path: String) -> Vec<TreeNodeDTO>`（内部 `workspace::walk` 转 DTO 递归）
  - `filter_workspace(tree: Vec<TreeNodeDTO>, query: String) -> Vec<TreeNodeDTO>`（内部 DTO 转回/直接保留 DTO 结构在 Rust 端 filter？—— 定案：filter 逻辑已在 workspace::filter 针对 crate::workspace::TreeNode 实现，此处递归转换 DTO→TreeNode→filter→DTO，纯机械映射）
  - `create_file(path: String) -> Result<(),String>`（不存在才创建，`OpenOptions::create_new`，Err 时返回 "已存在"）
  - `create_folder(path: String) -> Result<(),String>`
  - `apply_op(op: EditOp) -> EditResult`（`editor::apply_op(content,(s,e),op_str)` 包装）

- [ ] **Step 1: 实现**上述命令（DTO 转换手写两个小函数 `tree_out(&Vec<TreeNode>)->Vec<TreeNodeDTO>`、`tree_in(...)`，递归各 ~10 行）。
- [ ] **Step 2: 行为冒烟测试**（复用既有纯函数测试保证内核；这里补一条 apply_op 映射测试到 lib.rs tests mod）:
```rust
#[test] fn apply_op_maps_types(){ let op=dto::EditOp{content:"hi".into(), sel:[0,2], op:"bold".into()}; let r=super::apply_op_map(op); assert_eq!(r.content,"**hi**"); assert_eq!(r.sel,[0,6]); }
```
apply_op 命令本体包装 `apply_op_map`（便于测试的薄壳）。
- [ ] **Step 3:** `cargo test --workspace` 绿；`cargo build` 通过；generate_handler 数组追加 6 个新命令名。
- [ ] **Step 4: Commit**: `feat(tauri): workspace tree/filter/create + pure editor op commands`

---

### Task 7: 图片解析 + Markdown 解析 command

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `parse_markdown(content: String) -> ParseResult` —— 直通 `markdown::html::render_html(content, &HashMap::new(), false)`（原文模式；译文/对照两形态由 Task 8 翻译完成事件附带，不走此命令）。generate_handler 注册时与 `resolve_image` 同批加入。
- Produces: `resolve_image(src: String, base_dir: Option<String>) -> Option<String>` —— 返回本地绝对路径字符串（供前端 `convertFileSrc(absPath)` 得到可用 URL）：
```rust
fn resolve(src:&str, base_dir:Option<&str>) -> Option<PathBuf> {   // 逻辑 = 旧 render.rs::resolve_src 平移
    strip file:// ; 拒 http(s)/data:; base_dir.join(rel)
}
```
另在 `tauri.conf.json` 开启 asset 协议：
```json
"security": { "csp": null,
  "assetProtocol": { "enable": true, "scope": ["**"] } }
```
scope 用 `**`：本地 markdown 工作区位置不可预知（文档可能在任意盘符目录），这是功能性需求而非漏洞放宽 —— 明确记录于注释。

- [ ] **Step 1:** 实现 `resolve_image` + 平移测试：
```rust
#[test] fn resolve_skips_remote_and_resolves_relative(){
    assert_eq!(resolve("https://a/b.png", Some("D:/w")), None);
    assert_eq!(resolve("data:image/png;base64,x", None), None);
    assert_eq!(resolve("img/logo.png", Some("D:/w")).unwrap().to_string_lossy(), "D:/w/img/logo.png");
    assert_eq!(resolve("file://C:/x.png", None).unwrap().to_string_lossy(), "C:/x.png");
}
```
- [ ] **Step 2:** `cargo test --workspace` 绿。generate_handler 追加。
- [ ] **Step 3: Commit**: `feat(tauri): image path resolution + asset protocol scope`

---

### Task 8: 翻译 commands（get_providers / translate_text / translate_document / stop_translation）

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/translate/providers_meta.rs`（**只追加** serde DTO 转换函数，注册表本体不动）

**Interfaces:**
- Produces:
  - `get_providers() -> Vec<ProviderInfoDto>`（遍历 REGISTRY 平铺 meta）
  - `get_provider_meta(key: String) -> Option<ProviderInfoDto>`
  - `translate_text(text: String, provider: String, creds: HashMap<String,String>) -> Result<String,String>`（起线程，join 后返回结果——划词场景等待可接受；上限 meta.max_len 单块直接调 providers::provider，超长过 split_long 循环？——不，划词文本天然短，直接 provider() 一发，超长 slice 由前端限制选区 500 字符内）
  - `stop_translation()`（cancel.store(true)）
  - `translate_document(app: AppHandle, content: String, mode: String, provider: String, creds: HashMap<String,String>) -> Result<u64, String>` —— 语义：即刻返回 gen 号，真正翻译在后台线程；进度和完成经 Event 推送：
    - 事件 `translation-progress` payload `{gen, done, total}`
    - 事件 `translation-done` payload `{gen, ok, translations?: [[usize, String]], error?: String}` —— translations 序列化为 pair 数组（HashMap<usize,String> 不稳定序，**排序后输出 Vec<(usize,String)>** 保证前端确定性渲染）
    - mode ∈ {"translation","bilingual"} 决定 collect_text_runs vs collect_translatable；"original" 报错
    - 忙碌检查：running.compare_exchange(expected=false,true) 成功才开工；新译开始时 cancel.store(false)、gen.fetch_add(1)+cache 克隆快照传递（Mutex<Cache> 只锁拷贝瞬间，worker 内全程局部副本，结束后回写 merge：lock 后把新键 set 回共享 cache 并落盘 storage::cache_path())
    - worker 里 `UreqClient` + `CancelableClient` 组合为 `&dyn HttpClient` 传给 `translate_units`，progress 闭包 emit 事件
- [ ] **Step 1:** 实现 `providers_meta::info(key)->Option<ProviderInfoDto>`、`all_infos()->Vec<ProviderInfoDto>`（追加，勿动常量表）。
- [ ] **Step 2:** 实现四个 command 与后台 worker 函数 `spawn_translation(app, gen, texts, indices, provider, creds, meta, state)`。
- [ ] **Step 3: 编排测试**
```rust
#[test] fn providers_info_roundtrip(){
    let v = translate::providers_meta::all_infos();
    assert_eq!(v.len(), 8);
    let auto = v.iter().find(|p| p.key=="auto").unwrap();
    assert!(!auto.needs_key);
    assert_eq!(auto.max_concurrency, 3);
}
```
其余翻译并发路径已被 pipeline/providers 测试覆盖；真实网络行为留给手动验收（success criteria）。
- [ ] **Step 4:** `cargo test --workspace` 绿。generate_handler 追加 4 个。
- [ ] **Step 5: Commit**: `feat(tauri): translation commands with background worker, progress + cancel events`

---

### Task 9: 对话框 commands + 打开初稿流

**Files:**
- Modify: `src-tauri/src/lib.rs`、删除 `src-tauri/src/fileopen.rs` 中 rfd 函数（仅留 `file_arg_from_args`）

**Interfaces:**
- Produces:
  - `pick_file() -> Option<String>` / `pick_folder() -> Option<String>` / `pick_save_path(default_name: String) -> Option<String>`：同步封装 `tauri_plugin_dialog::DialogExt::blocking_pick_file`(需在窗口上下文) —— 签名示意：
    ```rust
    use tauri_plugin_dialog::{DialogExt, FilePath};
    #[tauri::command]
    fn pick_file(window: tauri::Window) -> Option<String> {
        let (_, chosen) = window.dialog().blocking_pick_file(
            tauri_plugin_dialog::FileDialogBuilder::new()
                .add_filter("Markdown", &["md","markdown","txt"]));
        match chosen { Some(FilePath::Path(p))=>Some(p.to_string_lossy().into_owned()), _=>None }
    }
    ```
    （blocking API 实际返回值型别以 `docs.rs/tauri-plugin-dialog` 实测为准，先查文档再落笔；save 加 `set_file_name(default)`，folder 用 `blocking_pick_folder`。）
  - 删除 rfd 相关 import 后，`fileopen.rs` 保留单文件作用域（未来可能加拖拽扩展）。

- [ ] **Step 1:** 实现 3 个 picker command；`Cargo.toml` 移除 `rfd`（若无则跳过——已在 Task 1 未引入）。
- [ ] **Step 2:** cargo build 通过；generate_handler 追加。
- [ ] **Step 3: Commit**: `feat(tauri): native dialog picker commands via tauri-plugin-dialog`

---

### Task 10: 单实例 handoff → 事件推送

**Files:**
- Modify: `src-tauri/src/lib.rs`（setup 钩子）

**Interfaces:**
- Produces: Event `document-changed`，payload `{path: String}`（前端收到即 invoke open_file）
- [ ] **Step 1:** setup 中 spawn 轮询线程（间隔 500ms，使用 `app.get_handle()`）:
```rust
let h = app.handle().clone();
std::thread::spawn(move || loop {
    if let Some(p) = single_instance::take_pending() {
        let _ = h.emit("document-changed", serde_json::json!({ "path": p.to_string_lossy() }));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
});
```
另外：本轮启动带文件参数（文件关联双击首开）时直接在 setup 里 `emit` 同一事件让前端统一处理路径加载（替代旧 `state.open(args)`），参数路径取 `fileopen::file_arg_from_args`，须在 run() 内 capture。
- [ ] **Step 2:** cargo build 通过。
- [ ] **Step 3: Commit**: `feat(tauri): single-instance pending handoff emits document-changed event`

---

### Task 11: 设置变更事件

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `save_settings` 升级为 `(app: AppHandle, settings: Settings) -> Result<(), String>`：保存成功后 `app.emit("settings-updated", &settings)?`，返回 Result。
- [ ] **Step 1:** 改造 command。cargo build。generate_handler 名单不变。
- [ ] **Step 2: Commit**: `feat(tauri): broadcast settings-updated after persist`

---

### Task 12: conf 收口 —— 图标占位、单例配置复查

**Files:**
- Modify: `src-tauri/tauri.conf.json`、icons/
- Run tauri CLI 生成图标占位（任意 png 底图即可，先用项目 release/qingbird-md.exe 提不了就用纯色 1024×1024 生成，正式美术后续再说）：
```powershell
npx @tauri-apps/cli icon tools/app-icon.png
```
- [ ] **Step 1:** 产出 `src-tauri/icons/*`；conf `bundle.icon` 补 `"icons/icon.ico"`。
- [ ] **Step 2:** `cargo build` 通过（bundle 配置不会影响 debug 构建，成功即可）。
- [ ] **Step 3: Commit**: `chore(tauri): placeholder app icons + bundle icon reference`

---

## Phase 2 — 前端骨架

### Task 13: Vite + React + TS 脚手架落位

**Files:**
- Create: `package.json`、`vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`index.html`、`src/main.tsx`、`src/App.tsx`、`src/styles/global.css`
- Delete: Task 5 建的 `dist/` 占位（首次 `npm run build` 会重新生成）
- Create: `.gitignore` 增加 `node_modules/`、`dist/`

**Interfaces:**
- Consumes: devUrl = localhost:5173 已写死在 tauri.conf.json。
- Produces: `npm run dev`（端口 5173 固定）、`npm run build`（tsc + vite build → ../dist 相对根）。**dist 输出位置必须在 repo 根**（`outDir: 'dist'` 且 index.html 在根）——保持 conf frontendDist:"../dist" 对应关系。

- [ ] **Step 1: package.json**

```json
{
  "name": "qingbird-md-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@codemirror/lang-markdown": "^6",
    "@codemirror/language-data": "^6",
    "@codemirror/state": "^6",
    "@codemirror/theme-one-dark": "^6",
    "@codemirror/view": "^6",
    "@replit/codemirror-lang-math": "^0.1",
    "@tauri-apps/api": "^2",
    "@tauri-apps/cli": "^2",
    "codemirror": "^6",
    "lucide-react": "^0.469",
    "react": "^18.3",
    "react-dom": "^18.3",
    "zustand": "^5"
  },
  "devDependencies": {
    "@types/react": "^18.3",
    "@types/react-dom": "^18.3",
    "@vitejs/plugin-react": "^4",
    "typescript": "~5.6",
    "vite": "^6"
  },
  "@tauri-apps/plugin-dialog": "^2"
}
```
（`@tauri-apps/plugin-dialog` 属 dependencies——手工把它放进 dependencies 再核对 JSON 合法；JSON 中不允许 key 顺序错误，最终以 npm install 校验为准。）

- [ ] **Step 2: vite.config.ts / tsconfig**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "chrome105" },
});
```
tsconfig 标准 vite react-ts（strict: true, jsx: "react-jsx", moduleResolution bundler）。

- [ ] **Step 3: 最小可跑 UI**

`index.html`: div#root + script main.tsx；标题「青鸟 Markdown」。`src/App.tsx` 仅渲染 `<h1>青鸟 Markdown — Tauri 2</h1>`。`global.css` 暂设 `html,body,#root{height:100%;margin:0}`。
运行 `npm install`（国内镜像可 `--registry=https://registry.npmmirror.com`）。

- [ ] **Step 4:** `npm run build` 通过产出 dist/；`cargo tauri dev`（或退路 `cargo run --manifest-path src-tauri/Cargo.toml` 时 devUrl 由手动开启的 vite 提供）应弹出窗口显示标题。
  实际命令确认 CLI：npx tauri dev 也等价。
- [ ] **Step 5: Commit**: `feat(ui): vite react-ts scaffold wired to tauri dev server`

---

### Task 14: IPC 类型 + 调用层

**Files:**
- Create: `src/types/ipc.ts`、`src/lib/ipc.ts`

**Interfaces:**
- Consumes: Task 5–11 全部 command 签名 + 事件名。
- Produces（前端唯一 IPC 门面）：

```ts
// types/ipc.ts —— 与 Rust DTO 字段一一对应（snake_case 自动映射已关闭，
// Rust serde 默认小写下划线，TS 保持同名 snake_case 字段）
export interface DocDTO { name:string; path:string|null; content:string; base_dir:string|null; char_count:number; line_count:number }
export interface TreeNodeDTO { name:string; path:string|null; is_dir:boolean; children:TreeNodeDTO[] }
export interface EditOp { content:string; sel:[number,number]; op:string }
export interface EditResult { content:string; sel:[number,number] }
export interface OutlineItem { level:number; text:string; id:string }
export interface ParseResult { html:string; outline:OutlineItem[] }
export interface ProviderField { key:string; label:string; secret:boolean; placeholder:string }
export interface ProviderInfo { key:string; label:string; note:string; needs_key:boolean; max_len:number; max_concurrency:number; fields:ProviderField[] }
export interface Settings { provider:string; providers:Record<string,Record<string,string>>; workspace:string|null; last_file:string|null; hotkeys:Record<string,string>; selection_translate:boolean; outline:"on"|string; nav:"on"|string; theme:string }
export interface ProgressPayload { gen:number; done:number; total:number }
export interface DonePayload { gen:number; ok:boolean; translations?:Array<[number,string]>; error?:string }

export type Mode = "original"|"translation"|"bilingual";
export type ViewKind = "source"|"preview"|"split";
```

```ts
// lib/ipc.ts
import { invoke, listen, UnlistenFn } from "@tauri-apps/api/core";   // listen 来自 event.ts
import * as evt from "@tauri-apps/api/event";

export const api = {
  openFile: (p:string) => invoke<DocDTO>("open_file",{path:p}),
  saveFile: (p:string,c:string) => invoke<void>("save_file",{path:p,content:c}),
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (s:Settings) => invoke<void>("save_settings",{settings:s}),
  userDataDir: () => invoke<string>("get_user_data_dir"),
  pickFile: () => invoke<string|null>("pick_file"),
  pickFolder: () => invoke<string|null>("pick_folder"),
  pickSavePath:(d:string)=>invoke<string|null>("pick_save_path",{defaultName:d}),
  openWorkspace:(p:string)=>invoke<TreeNodeDTO[]>("open_workspace",{path:p}),
  filterWorkspace:(t:TreeNodeDTO[],q:string)=>invoke<TreeNodeDTO[]>("filter_workspace",{tree:t,query:q}),
  createFile:(p:string)=>invoke<void>("create_file",{path:p}),
  createFolder:(p:string)=>invoke<void>("create_folder",{path:p}),
  applyOp:(o:EditOp)=>invoke<EditResult>("apply_op",{op:o}),
  parse:(c:string)=>invoke<ParseResult>("parse_markdown",{content:c}),
  resolveImage:(s:string,b:string|null)=>invoke<string|null>("resolve_image",{src:s,baseDir:b}),
  getProviders:()=>invoke<ProviderInfo[]>("get_providers"),
  translateText:(t:string,p:string,c:Record<string,string>)=>invoke<string>("translate_text",{text:t,provider:p,creds:c}),
  translateDocument:(c:string,m:Mode,p:string,creds:Record<string,string>)=>invoke<number>(
      "translate_document",{content:c,mode:m,provider:p,creds}),
  stopTranslation:()=>invoke<void>("stop_translation"),
  listenDocumentChanged:(cb:(p:string)=>void)=>evt.listen<string>("document-changed",e=>cb(e.payload.path)),
  listenProgress:(cb:(p:ProgressPayload)=>void)=>evt.listen<ProgressPayload>("translation-progress",e=>cb(e.payload)),
  listenDone:(cb:(p:DonePayload)=>void)=>evt.listen<DonePayload>("translation-done",e=>cb(e.payload)),
  listenSettingsUpdated:(cb:(s:Settings)=>void)=>evt.listen<Settings>("settings-updated",e=>cb(e.payload)),
}
```
（JSON 参数 camelCase→Rust snake_case：tauri 2 默认按参数名精确匹配**大小写敏感**——采用后端 command fn 参数都设为单词命名避免歧义：pick_save_path(default_name) 传 `{defaultName}` 是否正确取决于 Tauri 参数约定（默认 camelCase 转换是关闭的；Tauri 默认**不**做驼峰转换？实测口径：Tauri v2 里 Rust 参数 `default_name` 接受 JS 侧 `defaultName`（自动 rename），因为 arg 匹配默认蛇形↔驼峰双向兼容）。**执行时首次连调以 `invoke` 报 unknown arg 即刻对照修正为准，此类字段级差异不许静默吞掉。**)

- [ ] **Step 1:** 建立 types + lib 两文件，`npm run build`（tsc strict）通过。
- [ ] **Step 2: Commit**: `feat(ui): typed ipc facade over tauri commands/events`

---

### Task 15: Zustand 五 store

**Files:**
- Create: `src/stores/useDocStore.ts` 等 5 个

**Interfaces:**
- Consumes: `api`、`types/ipc`。
- Produces（字段/Action 与 spec 设计六表格一致）：

```ts
// useDocStore.ts —— 关键片段骨架
interface DocState {
  doc: DocDTO|null; view: ViewKind; mode: Mode;
  cursorSel: [number,number]; isDirty: boolean;
  savedContent: string;      // 供 isDirty 比较
  htmlCache: Map<string,ParseResult>;  // content->result，简单的最近内容缓存（Map限1条也够：只存当前）
  openDoc(path:string):Promise<void>;
  openDocFromArgs():Promise<void>;      // 启动监听 document-changed 注册处（只挂一次）
  setContent(c:string):void;            // 编辑器输入
  setCursorSel(s:[number,number]):void;
  async applyFormat(op:string):Promise<void>;  // 经 api.applyOp 应用当前选区
  async saveDoc(as:boolean):Promise<void>;
  switchView(v:ViewKind):void; switchMode(m:Mode):void;
}
```
isDirty 派生字段存值，setContent 与保存动作同步维护。htmlCache 采用单槽 `{ contentKey, result }` 避免 Map 泛滥。

```ts
// useWorkspaceStore.ts
root: string|null; tree: TreeNodeDTO[]; search: string; selectedPath: string|null;
openWorkspace(){}           // pickFolder + api.openWorkspace
selectFile(p:string){}       // 调 docStore.openDoc
searchFilter(q:string){ setSearch(q); tree = q.trim()? await api.filterWorkspace(rawTree,q): rawTree }
createFile()/createFolder()/refresh()
```
注意 rawTree 缓存自 root 打开时刻，search 只作用于展示树。

```ts
// useTranslationStore.ts
mode 独立档在 docStore.mode？不重复——spec 表格 useTranslationStore.mode 即阅读模式；为避双源，阅读模式唯一真源在 useDocStore.mode，本 store 不存 mode。
status: "idle"|"running"|"error";
progress:{done,total}|null; gen:number;
selection:{text:string,result:string,loading:boolean}|null;
async translateDocument(){    // 由 mode!=original 时调
  const g = await api.translateDocument(doc.content, docStore.mode, sp.provider, credsOf(sp.provider));
  this.gen=g; this.status="running";
}
listenProgress(); listenDone();  // done: gen匹配才写入 result 到 useDocStore.translations: Map
stop(){ api.stopTranslation(); }
async translateSelection(text:string){ debounced; translateText; 更新 selection }
clearSelection();
```

```ts
// useSettingsStore.ts
settings: Settings|null; theme: "light"|"dark"|"auto";
load(){api.loadSettings(); theme=settings.theme||"auto"}
async save(next:Settings){this.settings=next; api.saveSettings(next)}   // 后端广播 settings-updated → 监听回调里 setTheme + toast
updateProvider(k)/updateCredentials(k,v)/setTheme(t)
credsFor(provider):Record<string,string>
```

```ts
// useUiStore.ts
showNav/showOutline/sidebarWidth:240/outlineWidth:200/toasts:Array<{id,text,kind}>/
commandPaletteOpen/settingsOpen
toggleNav/toggleOutline/addToast(kind,text)(自动 3s 清除)/removeToast(id)
openPalette/closePalette/openSettings/closeSettings/setSidebarWidth/setOutlineWidth
```

- [ ] **Step 1:** 依骨架落地五文件，store 间只允许 `useXStore.getState()` 单向调用（doc←workspace←translation 可反向读取 doc 的设置；避免环引用遵循：translation 读 docStore 与 settingsStore；workspace 写 docStore；ui 不读别人）。手动依赖注入不做——zustand getState 是官方便道。
- [ ] **Step 2:** `npm run build` 通过类型检查。App.tsx 在 useEffect 里初始化 `settingsStore.load()` + `docStore.openDocFromArgs()` + translationStore.listen*，确保整个应用挂载一次。
- [ ] **Step 3: Commit**: `feat(ui): zustand stores for doc/workspace/translation/settings/ui`

---

## Phase 3 — 布局与面板

### Task 16: AppShell Grid + StatusBar

**Files:**
- Modify: `src/App.tsx`、`src/styles/global.css`
- Create: `src/components/StatusBar.tsx`

**Interfaces:**
- Produces: CSS Grid 布局根（TopBar 42px auto-row；中部三列 sidebar|main|outline 可折叠；底 Statusbar 26px row）+ StatusBar 显示 `doc.path · 字符 X · 行 Y · provider · 翻译状态`.

```css
#app-shell{display:grid;height:100%;
  grid-template-rows:auto 1fr auto;
  grid-template-columns:auto 1fr auto;}
.sidebar{overflow-y:auto}
.main-area{overflow:hidden;display:flex;flex-direction:column}
.outline-panel{overflow-y:auto}
```

- [ ] **Step 1:** App.tsx 组装占位 TopBar/Sidebar/MainArea/OutlinePanel div（空），底部真 StatusBar。
- [ ] **Step 2:** `npm run build`；`npx tauri dev` 目视窗口无滚动溢出、暗色（若系统偏好）正常。
- [ ] **Step 3: Commit**: `feat(ui): app grid shell + status bar`

---

### Task 17: TopBar 菜单组

**Files:**
- Create: `src/components/TopBar.tsx` 及 `menus/FileMenu.tsx ViewMenu.tsx TranslateMenu.tsx SettingsMenu.tsx HelpMenu.tsx`（放入 `src/components/menus/`）

**Interfaces:**
- Consumes: `useUiStore`(主题切换入口 setTheme)、`useDocStore`(switchView/switchMode/saveDoc)、`useWorkspaceStore`。
- Produces: 点击展开的下拉菜单（自定义轻实现，不用库——button + absolute ul， onBlur 关闭）。
  FileMenu：新建(createFile 对话框输入)/打开(api.pickFile→docStore.openDoc)/保存(saveDoc(false))/另存(saveDoc(true))/打开工作区(ws.openWorkspace)/退出(`window.close()` 由 tauri 支持)。
  ViewMenu：源码/预览/分栏/侧栏开关/大纲开关。
  TranslateMenu：原文/译文/中英对照 + 「重新翻译」按钮（当前模式重跑 translateDocument）。
  SettingsMenu: 打开 uiStore.settingsOpen。HelpMenu: 关于弹窗（toast 即可）。
- [ ] **Step 1~2:** 实现并目视验证每个菜单能触发对应 action（此时多数 action 已通 IPC 生效——比如 打开 可真的读到文件并看到状态栏字符数变化）。
- [ ] **Step 3: Commit**: `feat(ui): menubar with working file/view/translate/settings/help menus`

---

### Task 18: Sidebar —— 搜索框 + 工作区树 + 工具条

**Files:**
- Create: `src/components/Sidebar.tsx`（内嵌 SearchFilter 输入与 WorkspaceToolbar 小按钮行，不单独拆文件）
- Consumes: `useWorkspaceStore` 全部 action。
- 行为：根节点展开态维护在本地 component state（Set<path>），点击 dir toggle；叶子点击 selectFile；选中高亮 = selectedPath。刷新按钮 refresh；新建文件/文件夹 弹 prompt（简易模态复用 Task 22 的 Modal 容器或原生 `window.prompt` —— webview 支持）→ 调 createFile/Folder 后 refresh。
- [ ] **Step 1:** 实现 + 打开工作区可见树渲染、过滤生效。
- [ ] **Step 2: Commit**: `feat(ui): workspace sidebar w/ search filter, tree toolbar`

---

### Task 19: OutlinePanel

**Files:**
- Create: `src/components/OutlinePanel.tsx`
- Consumes: `useDocStore.doc` + 最近一次 ParseResult.outline（需要 docStore 存最新 parse 结果：在 translateDocument 前、切换 preview 视图时机统一调 api.parse 缓存于 docStore.parseResult）。
  —— 修正接口：docStore 增加 `parseResult: ParseResult|null` 与 `ensureParsed(): Promise<void>`（content 变了就重 parse，幂等），OutlinePanel 与 Preview 共享这个单一来源（避免两处各自请求）。
- 渲染 level 缩进（indent=(level-1)*12px），点击项 → `document.getElementById(item.id)?.scrollIntoView({behavior:'smooth',block:'start'})`（Preview 所在容器为 scroll owner，配合 Task 20 里 html 元素拥有同名 id）。
- [ ] **Step 1:** 实现并验证：打开多级标题 md，大纲列出并可跳转（需要分栏视图中 preview 有滚动手感亦可）。
- [ ] **Step 2: Commit**: `feat(ui): outline panel with anchor jump`

---

## Phase 4 — 编辑器与预览

### Task 20: PreviewView（HTML 注入 + 图片 protocol 重写 + 复制按钮）

**Files:**
- Create: `src/components/PreviewView.tsx`、`src/styles/markdown.css`

**Interfaces:**
- Consumes: `docStore.ensureParsed`、`api.resolveImage`、浏览器 `convertFileSrc`（来自 `@tauri-apps/api/core`）。
- Produces: 
  - 渲染流程：useEffect([parseResult]) → 容器 innerHTML = parseResult.html → queryAll("img[src]") 对每个 src 调 api.resolveImage(src, doc.base_dir)，得 abs 后 `el.src = convertFileSrc(abs)`；
  - 每个代码块右上注入 copy 按钮（一次性 mutation 完成）：navigator.clipboard.writeText(code.textContent)，成功变 ✓ 2s；
  - 行号 gutter 由后端已生成的 .ln spans 显示，无前端逻辑。
  - Translations 应用：docStore.mode!="original" && translationStore.status==="done" → 使用 task 21 的代入式解析（由后端 translate-document 附带更新？—— 定案：**由后端 parse 补充**）。设计调整说明：**Task 8 中 translate-done 之后还应持久化保存 translations Map 于 docStore**（index->text），Preview 根据当前 mode：
    - translation 模式：请求后端 re-parse with substitutions → 新 ParseResult（后端加第二个 command `parse_markdown_translated(content, translations, mode)` —— 此时 translations 大，IPC 走 payload 没问题但要防截断；另有简化路径：**沿用已生成的 substitutions 不做二次后端调用**。三者权衡后选择后者 ⇒ **后端在 translation-done 的 payload 里直接附带新 html** —— 修改 Task 8 接口：DonePayload 增加 `html_original?:string; html_translation?:string; html_bilingual?:string; outline?:OutlineItem[]`，后端在完成后一次性产出三种形态给前端按需切模式零延迟。实施细则落到 Task 8 Step 2 内完成（worker 收尾时调用 render_html 三个变体 + outline 并 emit）。这改变了 Task 8 交付面 —— 在本 Task 之前完成该扩展属于追加序：若执行顺序线性推进，**在 Task 8 时就把三形态 html 一并入 payload**。
    
    （已达成共识的实现策略，后续 Task 21、22 均以此为前提。）
  - CSS：GitHub 风格的类（h1-h6 margin/font、p 行距、ul/ol/task checkbox 方形勾选框、table stripe、blockquote 左竖线、code inline 背景、pre.code-block 带圆角深底色、.tr-box 浅蓝底圆角浮出块、del、a 颜色、hr）——预期产出 ~180 行规则，覆盖上述 html 约定。
- [ ] **Step 1:** PreviewView + markdown.css 落地，明暗两种主题下目视核对基本排版。
- [ ] **Step 2: Commit**: `feat(ui): markdown preview view w/ asset imgs, copy btn, github css`

---

### Task 21: EditorView（CodeMirror 6）

**Files:**
- Create: `src/components/EditorView.tsx`

**Interfaces:**
- Consumes: `@codemirror/lang-markdown`(+language-data)、`@codemirror/view/state`、oneDark（dark 时启用）、docStore。
- Produces: 受控但高性能的映射——`compartment` 切 language/highlight（切换 tab/keymap 时不重建 View）；onSetDoc → store.setContent；外部 content 变化（openDoc/applyFormat）→ replaceRange 全量替换：
```ts
const CMdisp: Extension[] = [minimalSetup, markdown({codeLanguages: languages}), keymap.of([
  ...historyKeymap, ...defaultKeymap,
  {key:"Mod-s",preventDefault:true,run:()=>{docStore.saveDoc(false);return true}},
])]
```
光标同步：`updateListener` 截 selection 相关更新 → setCursorSel([from,to]); 反向 applyFormat 返回新 sel 后 dispatch selection & scrollIntoView center. keymap 加 Ctrl+B bold / Ctrl+I italic 快捷入口→ docStore.applyFormat（非 CodeMirror 命令，触发式即可，防止重复键）。
cursorSel 服务划词翻译：外置 subscription in App.tsx → debounce(300ms) 若 selection_translate 则 `translationStore.translateSelection(cm.getText(sel))`。

**偏移单位注意（中英混排正确性关键）**：CodeMirror 的 from/to 是 **字符（code point）偏移**，而 Rust 端 `editor::apply_op` 的 sel 是 **UTF-8 字节偏移**。在 `lib/ipc.ts` 增加一对纯函数并加单测式断言（行内注释给用例）：
```ts
/** CM 字符偏移 -> UTF-8 字节偏移（Rust apply_op 需要）。中文每字 +2。 */
export function charToByteOffset(s: string, charIdx: number): number
export function byteToCharOffset(s: string, byteIdx: number): number
```
实现：按 codePoint 遍历累加 `char.length`（UTF-16 代理对算 1 个 CM 字符但占 4 字节；CM 对代理对计 1 字符——以 `Array.from(s)` 切分为准逐个累加 `cp.length === 1 ? 1 : cp.length`… 实现以两函数互逆往返测试为准：`byteToCharOffset(s, charToByteOffset(s, i)) === i`（非切面处取 <=i 最大合法值亦可接受，但 applyOp 返回的 sel 永远落在 wrap 边界字符处，往返足够）。useDocStore.applyFormat 调 api.applyOp 前做 char→byte，收到 EditResult.sel 后做 byte→char 再 dispatch 给 CodeMirror。
[ ] 步骤：装载/目测中文输入法 composition 正常（IME 不丢字）、Ctrl+S 保存、undo 分支合理。
- [ ] **Step 1~3:** 按上实施并构建+手测。commit: `feat(ui): codemirror source editor with history keymap + cursor bridge`

---

### Task 22: MainArea 条件装配 + EditorToolbar + SplitView

**Files:**
- Create: `src/components/MainArea.tsx`、`src/components/EditorToolbar.tsx`
- Consumes: docStore.view；uiStore.sidebarWidth/outlineWidth 用于左右分割宽度 style prop（由格子父布局承接）。
- Toolbar 15 buttons（bold/italic/strike/h1/h2/h3/ul/ol/task/quote/code/codeblock/link/image/table/hr），lucide-react 选 Icon 映射，title 属性 hover 中文提示；每键 `disabled={doc==null}`；click → applyFormat(op)。撤销/重做右置按钮使用 CodeMirror 命令（store 提供 dispatchUndo/Redo 桥接：方式 = 在 ref 中保存 cm instance 操作 api —— EditorView 暴露到 docStore.cmRef）。
- SplitView：flex row 两半 min-width 0、中间 4px vertical resizer（mousedown-drag 更新 splitRatio 存 uiStore.splitRatio 默认 0.5），左 EditorView 右 PreviewView（同组件复用）。
- [ ] **Step 1:** MainArea 装配 source/preview/split + Toolbar（预览模式不显示 Toolbar——延续旧版）。
- [ ] **Step 2:** resizer 拖动流畅（requestAnimationFrame 包 setState）。
- [ ] **Step 3: Commit**: `feat(ui): main area routing, format toolbar, draggable split view`

---

## Phase 5 — 翻译 UI 层接线

### Task 23: TranslationBar + 模式切换联动

**Files:**
- Create: `src/components/TranslationBar.tsx`
- Modify: docStore.switchMode 收尾逻辑（在 Task 15 骨架内预留）：switchMode(m){ mode=m; if(m!=="original"){translationStore.startIfFresh()} else clearTranslations }
  startIfFresh = gen===0||translations.isEmpty||mode changed ⇒ translateDocument()
- Bar 内容：进度条(done/total)、百分比、取消按钮(stop→status idle)、当前 provider 标签。仅 status==="running" 显示 bar；完成后 toast 成功。
- [ ] **Step 1:** 实现并联调：选 free provider(auto/transmart) 对英文 demo 文档拉满 progress→done→Preview 切译文模式渲染替换文本。
- [ ] **Step 2: Commit**: `feat(ui): translation progress bar + reading-mode wiring`

---

### Task 24: 划词翻译浮窗

**Files:**
- Create: `src/components/SelectionPopup.tsx`
- Consumes: translationStore.selection, settings.selection_translate 开关。
- UX：popup 定位 fixed top-center（照抄旧版顶部 44px 布局），loading spinner / result 文本；内容变化防抖重新请求；`清除` 按钮。Esc 关闭。
- [ ] **Step 1:** 实现联调（编辑器与预览里的划词均可触发——**仅编辑器**做划词，预览选区监听放后续迭代 YAGNI）。
- [ ] **Step 2: Commit**: `feat(ui): selection-translate popup`

---

### Task 25: 对照模式下浮层（BilingualOverlay）

**Files:**
- Create: `src/components/BilingualOverlay.tsx`（实际以 tr-box 形式注入在 markdown.css 渲染路径内——组件薄化处理：提供样式 + docStore 里存当前 doneHtml 的指针即可）
- 结合 Task 20 结论：当 mode==="bilingual" 且 done payload 带 html_bilingual 时 Preview 直接换 innerHTML。Overlay 是残余概念：不再额外组件，仅创建 markdown.css .tr-box 样式效果并在 Task 23 中联调过。**此 Task 降级为：验证 bilingual 分支 + tr-box 滚动跟随正常**。
- [ ] **Step 1:** 手动验收 + 补录缺漏样式修复。commit: `polish(ui): bilingual overlay parity`

---

## Phase 6 — 模态框 & 全局件

### Task 26: SettingsModal

**Files:**
- Create: `src/components/SettingsModal.tsx`、共用 `src/components/Modal.tsx`
- Consumes: get_providers + settingsStore 全部。
- Form 字段布局完全对应旧版（provider select、动态凭据 inputs secret→password、note 文案、测试连接按钮（临时 translateText("Hello...") 展示结果/error）、清除缓存按钮——**清除翻译缓存**：后端没有专门 command。补充一个:`clear_cache(state: State<AppTxn>)`，lib.rs 加（放在本 Task Files Modify lib.rs 里）：
```rust
#[tauri::command]
fn clear_cache(st: State<AppTxn>) { st.cache.lock().unwrap().clear(); let _=st.cache.lock().unwrap().save(&storage::cache_path()); }
```
ipc 增加 clearCache。generate_handler 更新。
- hotkeys 三行（original/translation/bilingual）+「录制」交互：进入 recording 态捕获 keydown 组合串格式 `Ctrl+Shift+T`（Ctrl/Alt/Shift 顺序序；修饰必须有才收）→ 存储 settings.hotkeys —— 前端按下逻辑见 Task 29。
- selection_translate checkbox。取消/保存。
- [ ] **Step 1:** modal + form 完整实现（受控表单，provider 改变重载凭据子集）。
- [ ] **Step 2:** 测试连接可拿到中文回显、保存后 settings-updated 广播回到 store。
- [ ] **Step 3: Commit**: `feat(ui): settings modal w/ dynamic creds, test conn, cache clear, hotkey recorder`

---

### Task 27: ToastContainer + Modal 容器拆分复核

**Files:**
- Create: `src/components/ToastContainer.tsx`
-toast 动画 css 由 global.css 统一 slide+fade keyframes；kind success/info/error 色彩变量。
- [ ] **Step 1:** 容器 + keyframes + 在 saveDoc 成功、翻译完成、translateText error 等处已经有 addToast 调用点(回查 store 代码确保已埋点)。
- [ ] **Step 2: Commit**: `feat(ui): toast notifications`

---

### Task 28: CommandPalette (Ctrl+Shift+P)

**Files:**
- Create: `src/components/CommandPalette.tsx`、静态 `commands.ts`
- Actions 清单（首批 10 个足矣）：保存/另存/打开文件/打开工作区/切源码/预览/分栏/原文/译文/中英对照/打开设置/切换主题/清除缓存。
- 输入即时过滤 fzf 式 substring，↑↓ Enter Esc 键位导航。
- 监听全局 Ctrl+Shift+P 在 App.tsx（keydown preventDefault 避免冲突 Chrome devtools 用 F12 正常）。
- [ ] **Step 1~2:** 实现并全部 12 条命令可触发。commit: `feat(ui): command palette`

---

## Phase 7 — 视觉打磨 & 交付

### Task 29: 全局快捷键 & GlobalShortcut 插件取舍

**Files:**
- Modify: `src/App.tsx`、`src-tauri/Cargo.toml`、capabilities

编辑器/应用内快捷键收口：App.tsx 一个集中 handler（keydown 判组合）：Mod+S/E/B/I/\，Mod+Shift+P palette，Alt+1/2/3 → hotkeys 设置值比对触发三模式（用 settings.hotkeys 用户录制的动态值）。
全局热键（程序未聚焦也能换模式）：引入 `tauri-plugin-global-shortcut`：
- Register: 启动时把 settings.hotkeys 三项 register → callback emit 事件 `hotkey-mode` payload modeStr；前端监听后 switchMode。取消重注册在 settings-updated 回调时重新计算 diff 注册。
- capability 加 `global-shortcut:allow-register`,`global-shortcut:allow-unregister`。
[注]: 若人手资质难调，第一版可以只做应用内 Alt+数字（App 内 keydown 就覆盖大多数用户场景），全局热键留后续——**执行者遇到阻塞时允许降级并在 commit message 中标注 `WIP-global-hotkey-deferred`**，不许静默砍功能（记录到本计划此处视为已批准降级路径）。
- [ ] **Step 1~2:** 完成 in-app 部分 +（尽力）全局热键，commit: `feat(ui): keyboard shortcuts incl user-recorded mode hotkeys (+global plugin best effort)`

---

### Task 30: CJK 字体 @font-face + 主题 CSS 变量贯通

**Files:**
- Modify: `src/styles/global.css`、新建 `theme.css`
- Fonts: font-family stack `"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`——Tauri webview 走系统字体栈即可命中雅黑，无须下载字体文件（省 15MB），@font-face 留空仅注释说明何时该启用（装包字体否则）。CSS 变量亮暗两套（--bg/--fg/--accent/--border/--panel-bg/--code-bg/--tr-box-bg...），body[data-theme=dark|light]，watch prefers-color-scheme auto 档。
- 全部组件 CSS 引用 var()，杜绝硬编码色。
- [ ] **Step 1:** 亮暗快速过一遍全部界面截图比对，修补漏网硬编码颜色。
- [ ] **Step 2: Commit**: `style: css variable theming + cjk-first font stack`

---

### Task 31: 端到端冷启动 + 特征回归清单

这一步是成功标准的收口门（对应 spec 成功标准 1-5）：

- [ ] **Step 1: 功能矩阵手测**（每条都要真实点击验一遍）：
  打开/编辑/保存/另存/拖拽？——拖拽属增强不列入本次范围。逐条核：Markdown 全要素渲染、大纲跳转、工作区打开/搜索/新建、工具栏 15 格、四种视图切换、原文译文对照三模式 + 缓存生效（第二次翻译秒出）、划词浮窗、主题切换记忆、设置持久化（重启保留 provider+creds）、快捷键模式切换。
- [ ] **Step 2: cargo test --workspace 全绿**；旧模块（storage/workspace/editor/cache/pipeline/providers/sign/syntax/model/units/html/cancel）都有测试通过证明核心资产完好。
- [ ] **Step 3:** 冷启动体感记时 `npx tauri dev --release` 与旧 exe 对比不少于目标相近水平（webview 冷启动一般在 ~600ms 内达标——记录数据到 README「性能」一节）。
- [ ] **Step 4: 修订 README.md**（运行方式 = npm i + npx tauri dev；架构图；功能列表不变；移除"无 webview、无 JavaScript"的历史陈述段落改为准确表述）。
- [ ] **Step 5: Commit**: `docs: update README for tauri 2 migration, record smoke-test matrix`

---

### Task 32: NSIS 安装器（Tauri bundler）

**Files:**
- Modify: `src-tauri/tauri.conf.json` bundle 区块、`scripts/package.ps1`
- conf 追加：
```json
"bundle": { "active": true, "targets":["nsis"],
  "icon": ["icons/icon.ico"],
  "fileAssociations":[
    {"ext":"md","name":"青鸟 Markdown 文档","role":"Editor"},
    {"ext":"markdown","name":"青鸟 Markdown 文档","role":"Editor"},
    {"ext":"txt","name":"文本文件","role":"Editor"}],
  "windows": {"nsis": {"installMode":"currentUser","languages":["SimpChinese"],"displayLanguageSelector":false}} }
```
- scripts/package.ps1 重写为：npm ci → npm run build → cargo tauri build → 拷贝产物到 release\。
- [ ] **Step 1:** `npx tauri build` 出 `release\青鸟Markdown-setup-*.exe`（如果字体没改动为节省时间只校验产物存在）。
- [ ] **Step 2:** 装一遍验证文件关联双击 .md 启动进正文；开机旧版本并存时 pending handoff 依然把新双击交给老进程。卸载清理（conf uninstall 相关 nsis 默认模板即可）。
- [ ] **Step 3: Commit**: `build: tauri nsis bundler config replaces legacy makensis script`

---

### Task 33: 清理尾巴

- 删除旧 release/qingbird-md.exe？—— 不，release/ 在 gitignore，物理删除即可由人工决定。仓库内遗留 scripts/installer.nsi 删除（已被 bundler 替代）；README 的 NSIS 旧说明段落已在 Task 31 改掉。
- git status 检查无杂散文件。最后 commit: `chore: remove obsolete installer script leftovers`。

---

## Self-Review

**1. Spec coverage 对账：**

| spec 要素 | 覆盖 Task |
|---|---|
| 架构目录（src-tauri 拆分、markdown/translate 原样保留） | 1 |
| state.rs 缩为纯 DTO / textures 删除 | 1-2（不迁移 state.rs，UI 状态全部归前端 store——比"缩 DTO"更彻底，行为等价） |
| Tauri2 配置（窗口/安全/CSP null/assetProtocol） | 5、7 |
| 设计三命令表 15 个 | open/save/pick×3=5、7、6（工作区4+apply_op）、3(parse)、7(image)、8(翻译4)、5/11(设置3) ✔ |
| Rust→前端 Events ×3 | 10、11、8 ✔ |
| 设计四组件树（TopBar 5 menu / Sidebar 3 块 / MainArea 4 块 / OutlinePanel / StatusBar / SettingsModal / CommandPalette / ToastContainer） | 17、18、19、22、16、26、28、27 ✔ |
| 设计五视觉 9 点 | 30(主题变量+CJK)、22(lucide 工具栏)、20(GitHub CSS+复制+高亮)、25(tr-box)、24(划词)、28(palette)、30(平滑过渡)、27(toast)、30(字体栈) ✔ |
| 设计六 5 store | 15 ✔ |
| 设计七 CodeMirror 6 | 21 ✔ |
| 设计八 DTO | 3、5 ✔ |
| YAGNI 边界（不做协同/插件市场/移动端/同步光标） | 未引入任何上述机制 ✔ |
| 成功标准 1 功能平替 | 31 矩阵 |
| 2 单实例+文件关联 | 10、32 |
| 3 NSIS | 32 |
| 4 冷启动性能 | 31 记录对比 |
| 5 现有单元测试通过 | 1 后每 Task 均 `cargo test --workspace` 兜底 |

**2. Placeholder 扫描：** 所有 code step 都给出目标代码或精确移植来源（"自 render.rs 平移"指向明确可找回的内容——git 历史 + 本计划引用的函数名单）；无 TBD/"适当处理"字样。唯一"待实测修准"的是 Tauri IPC 参数命名细节与 tauri-plugin-dialog blocking API 返回型别——均标注了以实测修正的显式校准点而不是留白。

**3. 类型一致性：** DocDTO/TreeNodeDTO/ParseResult（rust 字段 snake_case ↔ ts 同名）在 Task 3/5/6/14 多处出现，名称一致；translations pair 数组 `[number,string]` 前后端一致；Mode/ViewKind 枚举串两侧统一；splitRatio/sideWidth 变量只在 uiStore 单点定义。

**风险披露（非缺口）：** CodeMirror 中文 IME 与 selectionchange 的互操作偶有边角（composition 中频繁 selection 通知），已在 Task 21 验收条目点名。悲观兜底计划存在：全局热键允许显式降级（Task 29 内已授权）。
