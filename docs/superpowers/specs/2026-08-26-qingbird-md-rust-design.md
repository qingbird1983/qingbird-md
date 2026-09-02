# qingbird-md Rust Rewrite — Design

**Date:** 2026-08-26 · **Status:** Draft for review · **Author:** agent

## 1. Summary

Rewrite the existing Electron-based Markdown editor/reader (`qingbird-md`) as a **new, pure-native Rust desktop application** with **feature parity**. No webview link, no JavaScript — the entire core and UI are Rust.

- New project: `F:\AIwork\qingbird-md-rust` (standalone sibling; the existing `F:\AIwork\qingbird-MD` Electron project is **not** modified).
- GUI: **eframe / egui** (confirmed).
- Target: **Windows x64**, shipped as an **NSIS installer** that registers `.md` / `.markdown` file association, desktop + start-menu shortcuts, and supports overwrite-upgrade preserving the user-data dir.
- Delivery: **phased**, each phase ends in something runnable (confirmed).

## 2. Goals

Feature parity with the Electron version:

1. **Markdown read/rendering**: headings, paragraphs, lists (ordered/unordered/task), blockquotes, inline code, fenced code blocks with syntax highlighting, tables, images (relative paths resolved against the `.md` file dir → `file://`), links, horizontal rules, strikethrough.
2. **Chinese translation** from 7 sources: `mymemory`, `youdao`, `tencent`, `baidu`, `llm` (OpenAI-compatible), `transmart`, `iciba`, plus `auto` (Transmart → iCiba → MyMemory fallback chain).
3. **Translation optimizations**: in-memory + disk cache (key `provider\x00text`, 20k cap with 25% prune, debounced disk save), skip text with no English letters, merge adjacent short runs into one request, split long runs at sentence/word/hard boundaries, bounded concurrency (per-provider `maxLen` / `maxConcurrency` / `chunkConcurrency`).
4. **Three reading modes**: original / translation / bilingual (bilingual appends a styled `.tr`-like block under each rendered block).
5. **Left workspace document tree**: open a folder, recursive `.md` tree (depth ≤10, ≤3000 files, skip `node_modules/.git/dist/build/.vscode/.workbuddy/.idea`, symlink-loop guard via canonical path set), live search filter that keeps ancestors and auto-expands matches.
6. **Right outline**: h1–h3 TOC with slug-unique ids, click-to-scroll, scroll-highlight current heading, empty-state text.
7. **Editing**: source / preview / split views; formatting toolbar (bold/italic/strike, H1–H3, ul/ol/task, quote, inline code, code block, link, image, table, hr, undo/redo); line-number gutter; `Ctrl+E` preview/source toggle, `Ctrl+\` split, `Ctrl+B` (editor=bold else toggle outline), `Ctrl+I` italic, `Ctrl+S` save, `Ctrl+O` open; dirty-dot indication.
8. **Settings modal**: provider picker, dynamic credential fields, per-provider note, test-connection button, clear-cache, hotkey recorder (original/translation/bilingual combos, must include Ctrl/Alt/Shift/Meta), selection-translation toggle.
9. **Selection-translation popup**: selecting text in the preview shows a floating popup with source / translated text / source tag / copy button; respects the enable toggle and view mode.
10. **Theme toggle** (light/dark), persisted; respects system preference on first run.
11. **Status bar**: breadcrumb (relative to workspace), dirty dot, status text, char/line counts.
12. **Single-instance + file association**: launching with a `.md`/`.markdown`/`.txt` argument opens it; if already running, forwards the path to the existing window; startup does not clobber an OS-passed file with the remembered last-file.
13. **Storage** in the platform user-data dir: `qingbird-settings.json` and `qingbird-cache.json`.

## 3. Non-goals

- Cross-platform builds (Windows-primary, matching the current release). macOS/Linux may work but are not a target.
- Pixel-identical UI. Layout and behavior match; the native egui look is acceptable.
- Modifying or reusing the existing Electron project.
- Realtime collaborative editing, plugins, or a mobile/web build.

## 4. Tech stack

| Concern | Crate / approach | Notes |
|---|---|---|
| GUI | `eframe` + `egui` | Immediate-mode; panels, toolbars, floating popup, modal, scroll areas. |
| Markdown parse | `pulldown-cmark` | Event stream; we render it ourselves so we can inject translation blocks (stock widgets can't). GFM options: tables, task lists, strikethrough, autolink, footnotes off. |
| Code highlight | `syntect` | Syntax highlighting for fenced blocks in the read view. |
| HTTP | `reqwest` (blocking) | On worker threads; results returned to the UI via channels. |
| Signing/hash | `md-5`, `sha2`, `hmac`, `base64` | Port Youdao v3 (sha256), Tencent TC3-HMAC-SHA256, Baidu md5, iCiba md5. |
| Security | `rand` | Salt + timestamp generation where the JS used `Math.random().slice(2)`. |
| Persistence | `serde` + `serde_json` | Settings + cache JSON. |
| FS tree | `walkdir` + `std::fs::canonicalize` | Recursive `.md` walk, caps, skip list, symlink loop guard. |
| User-data dir | `dirs` | `app_data_dir`/`data_local_dir` (Windows `%APPDATA%`/`%LOCALAPPDATA%`). |
| Single-instance + arg forwarding | `single-instance` crate | Forward `.md` path to an already-running instance. |
| Installer | NSIS via a small script (or `cargo-wix`) | Registers `.md`/`.markdown`, desktop/start shortcuts, upgrade preserving user-data. |
| Logging (optional) | `env_logger`/`log` | For translation/FS errors. |

## 5. Architecture / modules

```
qingbird-md-rust/
├── Cargo.toml
├── build.rs                       (optional: embed icons/assets)
├── docs/superpowers/specs/*.md    (this design + implementation plan)
├── assets/                        (icon.ico / icon.png)
├── src/
│   ├── main.rs                    # eframe entry point + App shell
│   ├── app.rs                     # AppState, top-level UI layout, event routing
│   ├── markdown/                  # custom renderer over pulldown-cmark events
│   │   ├── mod.rs                 # Rendering, TextRun collection, heading extraction
│   │   └── syntax.rs              # syntect wrapper for code blocks
│   ├── translate/                 # translation engine
│   │   ├── mod.rs                 # provider trait + registry + auto chain
│   │   ├── sign.rs                # md5/sha256/hmac/base64 utils
│   │   ├── {mymemory,youdao,tencent,baidu,llm,transmart,iciba}.rs
│   │   ├── cache.rs               # memory+disk cache, prune, debounce save
│   │   ├── pipeline.rs            # run collection → batching → chunking → concurrency → results
│   │   └── providers_meta.rs      # per-provider meta (label/needsKey/maxLen/concurrency/fields)
│   ├── editor/                    # editor pane
│   │   ├── mod.rs                 # TextEdit wrapper + line gutter
│   │   ├── ops.rs                 # wrap/linePrefix/heading/codeblock/table + ops
│   │   └── undo.rs                # undo/redo history
│   ├── workspace/                 # fs tree walk + filter + breadcrumb
│   ├── outline.rs                 # h1–h3 TOC + scroll highlight
│   ├── storage.rs                 # settings + cache load/save
│   ├── selection_translate.rs     # preview selection → floating popup translate
│   └── ui/                        # panels: topbar, formatbar, nav, doc, outline, statusbar, settings modal
├── scripts/                       # make-icon, nsis packaging
│   └── installer.nsi
├── tests/                         # offline signature/request-construction tests
└── README.md
```

Each module is a small, single-purpose unit with a clear interface and no hard coupling to egui where the logic is pure (translation signing, batching, cache, markdown parsing) so it can be unit-tested independently.

## 6. Data flow / AppState

`AppState` (owned by the eframe `App`):

```
doc:
  name, path, content (source), dirty,
  mode: Original|Translation|Bilingual,
  view: Preview|Source|Split,
  render_epoch
settings: { provider, providers{...}, workspace, lastFile, hotkeys{original,translation,bilingual},
           selectionTranslate, outline, nav }
ui: nav pane tree + filter, outline items + active, editor cursor/selection, gutter, theme,
    status text, counts, settings modal (open, form, test result, recording hotkey), sel-popup state
translation: in-flight map, results channel, done/percent, cache
```

Translation flow:

1. A render is requested (`render_epoch` bumps). In the read/translate modes we walk the parsed markdown, producing `Vec<TextRun>` for inline translation or `Vec<Block>` for bilingual.
2. Runs are batched/chunked per provider meta and pushed to a thread pool.
3. Each worker calls a provider over `reqwest` (blocking), then sends `(batch_key, Ok(result)|Err)` into an `mpsc` channel and updates a shared cache (with a mutex / lock-free map).
4. The egui UI polls the channel each frame (`ctx.request_repaint` while jobs pending) and applies results to the model; progress = chars done / total.
5. An epoch guard (like the JS `transToken`) discards stale results: only the latest render's results are applied.

Disk save of settings/cache is debounced (cache ~1.5s; settings on change).

## 7. Error handling

- Provider credential validation: at request time, check `needsKey` fields non-empty; otherwise raise a user-facing message ("请先在「设置」中填写…").
- Network/HTTP/parse errors surface in the status bar as `翻译失败：<message>`; a failing run/batch does not fail the whole document (mirrors current logic where each run is independent, but `auto` chain tries the next source).
- File read errors (moved file, permission) shown in status; `fs::listDir` errors degrade to an empty tree.
- Cache save failures are non-fatal (log + continue).

## 8. Testing

- **Offline unit tests** (`cargo test`), no network/keys, by abstracting HTTP behind a trait that a mock implements in tests:
  - Signing vectors: `md5("abc")`, `sha256("abc")` exact hex (ported from `test/translators.test.js`).
  - Youdao request body contains v3 sign (64-hex), `from=en`, `to=zh-CHS`, `appKey`; parses `translation`.
  - Baidu `sign = md5(appid+q+salt+key)` and `trans_result[].dst` join.
  - Tencent TC3-HMAC-SHA256 self-consistency + `Authorization` header shape + `TargetText`.
  - MyMemory URL contains `langpair=en|zh-CN`.
  - llm: URL normalization (trailing slash), Authorization header present/absent, request body `model/messages/temperature`, error when baseUrl/model missing.
- **Pipeline** tests: batching merge cap, long-run splitting at sentence boundaries, needs-translation filter, cache key/hit/prune logic.
- **Editor** ops: wrapping/prepend correctness on a sample string, undo/redo re-applies states.
- Each phase ships its unit tests; the app is verified manually (open a real `.md`, translate, edit) and, at the end, by building the installer.

## 9. Packaging (Windows NSIS)

Steps:
1. `cargo build --release` → `target/release/qingbird-md.exe`.
2. Icon assets (`scripts/make-icon` or a committed `.ico`) → Windows icon.
3. NSIS script (`scripts/installer.nsi`):
   - Installs the exe (+ any assets) into `$PROGRAMFILES\青鸟Markdown阅读器`.
   - Registers `.md`/`.markdown` shell association → `qingbird-md.exe "%1"` (+ `DefaultIcon`), via NSIS `WriteRegStr`.
   - Creates desktop + start-menu shortcuts named 青鸟Markdown阅读器.
   - Allows choosing install dir; on upgrade, does not delete the user-data dir (under `%APPDATA%`, outside the install dir); if the app is running, prompts to close.
4. Produce `release/qingbird-md-setup-<version>.exe`; also keep the unzipped runnable folder for portable use.

## 10. Phased plan (each phase runnable)

1. **Phase 1 — Core skeleton**: crate, eframe shell, open `.md` (dialog/drag), render read-only markdown (headings/lists/tables/code/inline, images relative to file, code highlight), char/line counts, theme. Runnable.
2. **Phase 2 — Translation engine**: signing utils + all providers + `auto` chain + cache (memory/disk/prune/debounce) + batching/chunking/concurrency + settings modal (provider/creds/test/clear-cache) + original/translation/bilingual rendering. Runnable.
3. **Phase 3 — Editing**: editor pane with line gutter, source/split/preview views, toolbar ops, undo/redo, save (dialog + write-through), dirty dot. Runnable.
4. **Phase 4 — Workspace & outline**: folder open, tree walk + search filter, outline TOC + scroll highlight, breadcrumb. Runnable.
5. **Phase 5 — Extras & packaging**: theme persistence, hotkey recorder, selection-translation popup, single-instance + file-assoc arg forwarding, NSIS installer, icon, README. Runnable + distributable.

## 11. Risks & mitigations

- **Editor undo/redo + selection formatting** (fiddliest): build a thin, tested editor abstraction over egui `TextEdit`; keep ops pure and unit-tested; own undo stack (egui `TextEdit` has none).
- **Bilingual translation layout**: requires a custom markdown renderer (chosen) rather than a stock widget; render each top-level block and append a styled translation block.
- **syntect compile size / startup**: acceptable for a desktop tool; lazily build the syntax set on first read.
- **Translation run-splitting correctness**: port the exact batching/chunking logic and cover with tests to preserve the quality/speed balance.
- **Installer/file-association on Windows**: validate on a real machine; NSIS registry writes are config-only and reversible.
