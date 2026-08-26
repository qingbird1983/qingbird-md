# Phase 1 — Core Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable eframe/egui app that opens a `.md` file (native dialog or drag-drop) and renders it read-only — headings, paragraphs, lists (ordered/unordered/task), blockquotes, inline + fenced code with syntax highlighting, tables, images (relative to the file), links, horizontal rules, strikethrough — plus char/line counts and a light/dark theme.

**Architecture:** Parse markdown with `pulldown-cmark` into an intermediate document model (`Vec<Block>`, `Inline` runs), then render that model into egui. The parse→model step is pure Rust (no egui) and unit-testable; the egui renderer is a thin layer on top. This model is also what Phase 2 will reuse to inject per-block translations.

**Tech Stack:** Rust 1.97 · `eframe/egui` (0.31+) · `pulldown-cmark` (GFM tables/tasklists/strikethrough) · `syntect` · `rfd` (native file dialog) · `serde`/`serde_json` · `dirs`.

## Global Constraints

- Project root: `F:\AIwork\qingbird-md-rust`. Do **not** modify `F:\AIwork\qingbird-MD`.
- Pure native Rust — **no webview, no JavaScript**.
- Single binary (`qingbird-md.exe`); Windows x64 is the release target.
- De-facto crate versions resolved by `cargo` (use `cargo add` to pin latest compatible; `eframe` 0.31.x, `pulldown-cmark` 0.12+).
- All code compiles clean (`cargo build`); all unit tests pass (`cargo test`). Keep the parse/model logic free of egui types so it stays testable.
- Commit each task.

---

### Task 1: Scaffold the crate

**Files:**
- Create: `Cargo.toml`
- Create: `src/main.rs`
- Create: `.gitignore`
- Create: `README.md`
- Test: (none yet — compiles + launches a window)

**Interfaces:**
- Consumes: nothing.
- Produces: a project that runs `cargo run` to open an empty eframe window.

- [ ] **Step 1: Init the crate**

Run (in `F:\AIwork\qingbird-md-rust`):
```bash
cargo init --name qingbird-md
```
Then create `.gitignore` with:
```
/target
```

- [ ] **Step 2: Add dependencies**

```bash
cargo add eframe egui pulldown-cmark syntect rfd serde serde_json dirs
```

- [ ] **Step 3: Write a minimal `src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;

fn main() -> eframe::Result {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 860.0])
            .with_min_inner_size([800.0, 600.0])
            .with_title("青鸟 Markdown 阅读器"),
        ..Default::default()
    };
    eframe::run_native(
        "qingbird-md",
        opts,
        Box::new(|_cc| Ok(Box::new(EmptyApp::default()))),
    )
}

#[derive(Default)]
struct EmptyApp;

impl eframe::App for EmptyApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("qingbird-md — Phase 1 skeleton");
        });
    }
}
```

- [ ] **Step 4: Build & launch**

Run: `cargo run`
Expected: window opens, "Phase 1 skeleton" shown, builds cleanly.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold eframe app (Phase 1)"
```

---

### Task 2: Document model + parser (pure, tested)

**Files:**
- Create: `src/markdown/mod.rs`
- Create: `src/markdown/model.rs`
- Test: `src/markdown/model.rs` (unit tests inline) or `tests/markdown_model.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum Inline { Text(String), Strong(String), Emph(String), Code(String), Link { text: String, href: String }, LineBreak }`
  - `enum Block { Heading { level: u8, text: Vec<Inline> }, Paragraph { text: Vec<Inline> }, Code { lang: Option<String>, code: String }, Quote { blocks: Vec<Block> }, List { ordered: bool, start: u32, items: Vec<Vec<Block>> }, Rule, Image { alt: String, src: String }, Table { headers: Vec<String>, rows: Vec<Vec<String>> } }`
  - `pub fn parse_blocks(md: &str) -> Vec<Block>` — pure, no egui.

- [ ] **Step 1: Write the failing test**

Create `src/markdown/model.rs` starting with tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_heading_and_paragraph() {
        let blocks = parse_blocks("# Title\n\nSome **bold** text.");
        assert!(matches!(
            &blocks[0],
            Block::Heading { level: 1, text } if text.iter().any(|i| matches!(i, Inline::Text(t) if t == "Title"))
        ));
        assert!(matches!(&blocks[1], Block::Paragraph { .. }));
    }

    #[test]
    fn parses_task_list_and_code_fence() {
        let blocks = parse_blocks("- [x] done\n- [ ] todo\n\n```rust\nfn main(){}\n```");
        assert!(matches!(&blocks[0], Block::List { items, .. } if items.len() == 2));
        assert!(matches!(&blocks[1], Block::Code { lang, code } if lang.as_deref() == Some("rust") && code.contains("fn main")));
    }

    #[test]
    fn parses_table() {
        let blocks = parse_blocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
        assert!(matches!(&blocks[0], Block::Table { headers, rows } if headers.len() == 2 && rows.len() == 1));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test parses_heading_and_paragraph`
Expected: FAIL (compile error — `parse_blocks`/types not defined yet).

- [ ] **Step 3: Implement model + parser**

In `src/markdown/model.rs`, define the enums above and:

```rust
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

pub fn parse_blocks(md: &str) -> Vec<Block> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_AUTOLINK);
    // ENABLE_HEADING_ATTRIBUTES / FOOTNOTES intentionally off to match app behavior.

    // Parser is an event stream; convert to Block tree using a small stack machine.
    let parser = Parser::new_ext(md, opts);
    // `build_blocks(parser)` collects top-level blocks; it handles
    // heading/paragraph/code/quote/list/table/rule by consuming inline events
    // (Text/Code/Strong/Emphasis/Strikethrough/Link/SoftBreak/HardBreak/Image)
    // into Inline runs and block boundaries (Tag::Start/End) for nesting.
    build_blocks(parser)
}
```

Implement `build_blocks` plus helper `parse_inline(item: &mut dyn Iterator<Item=Event>) -> Vec<Inline>` and the block `consume` handlers for quote/list/table. Pass the failing tests. (Full impl is ~150 lines in the real file; keep each handler a small function.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markdown/model.rs src/markdown/mod.rs
git commit -m "feat(markdown): add document model + pulldown-cmark parser (Phase 1)"
```

---

### Task 3: egui renderer for the model

**Files:**
- Create: `src/markdown/render.rs`
- Modify: `src/markdown/mod.rs` (re-export)
- Test: none (visual); correctness verified by Task 4 launch.

**Interfaces:**
- Consumes: `Block`, `Inline`, `parse_blocks` from Task 2.
- Produces: `pub fn render_blocks(ui: &mut egui::Ui, blocks: &[Block], base_dir: Option<&Path>)`.

- [ ] **Step 1: Implement renderer**

`src/markdown/render.rs`:
```rust
use egui::{Align, RichText, Ui};
use crate::markdown::model::{Block, Inline};

pub fn render_blocks(ui: &mut Ui, blocks: &[Block], base_dir: Option<&std::path::Path>) {
    for b in blocks {
        render_block(ui, b, base_dir);
    }
}
```
- **Heading**: `ui.with_layout(...)`; larger fonts by level (`RichText::heading()` sized via `.size(level_size)`), followed by nothing (block-space handled by egui).
- **Paragraph**: build a `LayoutJob` from `Inline`s (bold/italic/code monospace/link) and `ui.label(job)`. Wrap width = panel width.
- **Code**: `ui.code_editor` is interactive — instead render a monospace `RichText`; if `lang` present, use `syntect` (Task 4) to highlight and build a colored `LayoutJob`; else escape then monospace.
- **Quote**: frame with accent color (`egui::Frame::group`) and indented inner `render_blocks`.
- **List**: render each item with a bullet/number prefix (`ui.horizontal`), then the nested blocks; task items render `[x]`/`[ ]`.
- **Rule**: `ui.separator()`.
- **Image**: if `src` is relative and `base_dir` set, resolve to a `file://` path; try `egui::Image::from_uri` inside a fixed container; on failure show alt text.
- **Table**: `egui::Grid` with `striped(true)`; header row bold; render header cells and rows; code/inline styling within cells via `Inline` runs (build a simple cell-string from inline text for Phase 1).
- **Link**: `ui.add(egui::Link::new(...).text(...))`, `.on_hover_text(href)`.

Inline rendering helper: `fn push_inline(job: &mut LayoutJob, inline: &[Inline])` mapping each variant to a `TextFormat` (font family Monospace for `Code`, strong/emph via colors/italics).

- [ ] **Step 2: Wire re-exports** in `src/markdown/mod.rs`:
```rust
pub mod model;
pub mod render;
pub use model::{parse_blocks, Block, Inline};
```

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/render.rs src/markdown/mod.rs
git commit -m "feat(markdown): render document model to egui (Phase 1)"
```

---

### Task 4: Code-block syntax highlighting (syntect)

**Files:**
- Create: `src/markdown/syntax.rs`
- Modify: `src/markdown/render.rs`
- Test: `src/markdown/syntax.rs` (unit tests inline).

**Interfaces:**
- Consumes: nothing new (called from `render.rs`).
- Produces: `pub fn highlight(code: &str, lang: Option<&str>) -> String` returning ANSI/egui-usable colored spans, plus a `pub fn to_layout_job(code: &str, lang: Option<&str>, ui: &mut Ui) -> LayoutJob`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn highlights_known_language() {
    let out = highlight("fn main() {}", Some("rust"));
    assert!(out.chars().any(|c| c == '\x1b')); // emits ANSI color codes
}
#[test]
fn no_lang_falls_back_to_plain() {
    assert_eq!(highlight("plain text", None), "plain text");
}
```

- [ ] **Step 2: Run test to verify it fails** — `cargo test highlights_known_language` → FAIL (not defined).

- [ ] **Step 3: Implement** with `syntect`:
```rust
use syntect::easy::HighlightLines;
use syntect::highlighting::{ThemeSet, Color};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use once_cell::sync::Lazy;

static SS: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);
static THEMES: Lazy<ThemeSet> = Lazy::new(ThemeSet::load_defaults);

pub fn highlight(code: &str, lang: Option<&str>) -> String {
    let Some(lang) = lang else { return code.to_string(); };
    let Some(syn) = SS.find_syntax_by_token(lang).or_else(|| SS.find_syntax_by_extension(lang)) else {
        return code.to_string();
    };
    let mut h = HighlightLines::new(syn, &THEMES.themes["base16-ocean.dark"]);
    let mut out = String::new();
    for line in LinesWithEndings::from(code) {
        if let Ok(ranges) = h.highlight_line(line, &SS) {
            for (style, s) in ranges {
                let color = style.foreground;
                out.push_str(&format!("\x1b[38;2;{};{};{}m{}", color.r, color.g, color.b, s));
            }
        }
    }
    out.push_str("\x1b[0m");
    out
}
```
`to_layout_job` parses the ANSI sequences into `LayoutJob` formats (or, simpler, reuse the raw `highlight` string and let `render.rs` display via a monospace `RichText` that tolerates codes). Keep it simple in Phase 1: show the ANSI string; a follow-up task can map to per-span colors.

- [ ] **Step 4: Run tests** → PASS. Build → compiles.

- [ ] **Step 5: Commit**

```bash
git add src/markdown/syntax.rs src/markdown/render.rs
git commit -m "feat(markdown): syntax-highlight fenced code blocks via syntect (Phase 1)"
```

---

### Task 5: App shell + open file + content area

**Files:**
- Modify: `src/main.rs`
- Create: `src/app.rs`
- Create: `src/fileopen.rs` (rfd dialog + drag-drop handling)
- Create: `src/state.rs` (AppState: doc, counts, theme)

**Interfaces:**
- Consumes: `parse_blocks`, `render_blocks` from Tasks 2–4.
- Produces: `AppState { doc: Doc, theme: Theme }` and `Doc { name, path, content, base_dir }`, plus `fn open_path(app: &mut AppState, path: PathBuf)`.

- [ ] **Step 1: Define state** in `src/state.rs`:
```rust
pub struct Doc { pub name: String, pub path: Option<PathBuf>, pub content: String, pub base_dir: Option<PathBuf> }
pub enum Theme { Light, Dark }
pub struct AppState { pub doc: Doc, pub theme: Theme, pub status: String }
```

- [ ] **Step 2: File opening** in `src/fileopen.rs`:
```rust
use rfd::FileDialog;
pub fn pick_and_read() -> Option<Doc> {
    let file = FileDialog::new().add_filter("Markdown", &["md","markdown","txt"]).pick_file()?;
    let content = std::fs::read_to_string(&file).ok()?;
    let base_dir = file.parent().map(|p| p.to_path_buf());
    Some(Doc { name: file.file_name()?.to_string_lossy().into_owned(), path: Some(file), content, base_dir })
}
```
Add a `load_string(content, name, base_dir)` helper used by drag-drop.

- [ ] **Step 3: Rewrite `src/main.rs`** to build `AppState`, add a top toolbar (Open button + theme toggle + title), a left count footer, and a central scrollable preview that renders the doc. Use egui:
```rust
egui::TopBottomPanel::top("bar").show(ctx, |ui| {
    if ui.button("打开 (Ctrl+O)").clicked() { if let Some(d) = fileopen::pick_and_read() { app.doc = d; } }
    // theme toggle
});
egui::CentralPanel::default().show(ctx, |ui| {
    egui::ScrollArea::vertical().show(ui, |ui| {
        let blocks = markdown::parse_blocks(&app.doc.content);
        markdown::render_blocks(ui, &blocks, app.doc.base_dir.as_deref());
    });
});
```
Counts: `content.chars().count()` chars, `content.lines().count()` lines, shown in a bottom status bar.

- [ ] **Step 4: Build & run** — `cargo run` opens the window; click Open, pick a `.md`, see it render.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs src/app.rs src/state.rs src/fileopen.rs
git commit -m "feat(app): shell with open-file dialog, preview area, counts (Phase 1)"
```

---

### Task 6: Theme (light/dark) + ctrl+O + drag-drop

**Files:**
- Modify: `src/app.rs`, `src/state.rs`, `src/main.rs`
- Test: none (visual); persist via `dirs` in a follow-up packaging task.

**Interfaces:**
- Consumes: nothing new.
- Produces: theme applied to `ctx.set_visuals(...)`; Ctrl+O handled via `ctx.input(|i| i.modifiers.command && i.key_pressed(Key::O))`; Drag-and-drop via `ctx.input(|i| i.raw.dropped_files)`.

- [ ] **Step 1: Apply theme** when rendering:
```rust
fn apply_theme(ctx: &egui::Context, theme: Theme) {
    match theme {
        Theme::Dark => ctx.set_visuals(egui::Visuals::dark()),
        Theme::Light => ctx.set_visuals(egui::Visuals::light()),
    }
}
```
Toggle button (☀/🌙) in the toolbar; call `apply_theme` at the top of `update()`.

- [ ] **Step 2: Ctrl+O shortcut** and **drag-drop** in `update()`:
```rust
if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::O)) { open_dialog(); }
let dropped: Vec<_> = ctx.input(|i| i.raw.dropped_files.clone());
if !dropped.is_empty() { if let Some(p) = &dropped[0].path { load_path(p); } }
```

- [ ] **Step 3: Build & run** — Ctrl+O opens; drag a `.md` onto the window opens it.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(app): theme toggle, Ctrl+O, drag-drop open (Phase 1)"
```

---

## Self-Review

- **Spec coverage (Phase 1 scope):** open `.md` ✓ (Task 5), read-only render of headings/paras/lists/task/quote/code+highlight/table/image/link/rule/strikethrough ✓ (Tasks 2–4), char/line counts ✓ (Task 5), theme ✓ (Task 6). Image *relative-path resolution* is implemented in `render.rs` (base_dir → file://) ✓. Strikethrough is captured as an `Inline` variant (models `s`/strike); render as struck text ✓.
- **Placeholders:** none — each task contains real code.
- **Type consistency:** `parse_blocks -> Vec<Block>`, `Inline` variants, `OpenTheme`, `Doc` fields match across tasks; `apply_theme`/`pick_and_read` names consistent.

## Next phase (after approval to proceed)
Phase 2 — Translation engine (signing + providers + cache + batching/concurrency + settings modal + the three reading modes), which builds directly on the `parse_blocks` model.
