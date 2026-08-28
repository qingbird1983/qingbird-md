# Changelog

All notable changes to qingbird-md are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-28

First public release. Tauri 2 desktop app — Rust core + React/TypeScript UI
— bringing the bilingual Markdown editor/reader to a smaller, faster
native shell. Functionally equivalent to the prior Electron build; this
round is the webview-frontend rewrite of the intermediate eframe/egui
experiment.

### Added

- **Markdown render & read**: headings, ordered/unordered/task lists, tables,
  fenced code with `syntect` highlighting, blockquotes, inline formatting,
  relative-path images, links, horizontal rules.
- **Bilingual translation**: seven providers (`tencent`, `youdao`, `baidu`,
  `mymemory`, `llm`, `transmart`, `iciba`) plus an `auto` fallback chain
  (Transmart → iCiba → MyMemory). Three reading modes: original /
  translation / side-by-side bilingual.
- **Translation pipeline**: in-memory + on-disk cache (provider-keyed,
  capped at 20k entries with 25% prune, debounced disk save); adjacent
  short-run merging; long-run splitting at sentence/word boundaries;
  bounded per-provider concurrency.
- **Editor**: CodeMirror 6 source view with formatting toolbar
  (bold/italic/strike, headings, lists, quote, code, link/image/table/hr);
  source / preview / split views; undo/redo; dirty-dot indicator; save
  with `Ctrl+S`.
- **Workspace tree** (left pane): recursive `.md` walk (depth ≤ 10, ≤ 3000
  files, symlink-loop guarded) with live search filter that keeps
  ancestors and auto-expands matches.
- **Outline** (right pane): h1–h3 TOC, slug-unique ids, click-to-scroll.
- **Settings modal**: provider picker with dynamic credential fields,
  per-provider notes, test-connection button, cache clear, hotkey
  recorder, selection-translation toggle.
- **Selection-translation popup**: floating card over selected preview
  text with source / translated text / copy button.
- **Light / dark theme** (CSS variable driven), remembered across
  launches; first run follows system.
- **Status bar**: breadcrumb, dirty dot, char/line counts, provider and
  translation status.
- **Single instance** with file-argument handoff (`.md` / `.markdown` /
  `.txt`); second launch forwards the path to the running window.
- **Global hotkeys** for mode switching (`tauri-plugin-global-shortcut`).
- **NSIS installer** for Windows x64; `.md` / `.markdown` / `.txt` file
  associations registered; install mode `currentUser`.

### Changed (this commit window)

- `open_file` is now `async` and ships the first markdown render in one
  trip — the preview's first frame is populated by `DocDTO.parse` instead
  of an extra `parse_markdown` round-trip after the document opens.
  The render is CPU-bound for large docs, so it is off the UI thread.
- `ensureParsed` (TS) now debounces 150 ms: every keystroke lands in the
  miss branch, but only the content at rest is parsed.
- `ParseResult` / `OutlineItem` derive `Default` + `Deserialize` so
  `DocDTO` can be serde-roundtripped.

### Known limitations

See [README → Known limitations](README.md#已知限制) for the full list,
including: events fired before the frontend listener mounts are lost
(planned: pull-command fallback), `Mod+B` / `Mod+I` still act on the
document behind an open settings modal (legacy behaviour carried over),
`codemirror-lang-math` is a low-trust small personal package (MIT,
SRI-pinned) and math is fenced-block only, the workspace new-directory
helper is Windows-only, clearing the translation cache does not dirty
the document, and the `icon.ico` must use BMP frames for `winres` to
embed (rebuild via Pillow with `bitmap_format="bmp"`).
