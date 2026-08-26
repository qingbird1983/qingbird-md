# Phase 2 — Translation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use `- [ ]` syntax.

**Goal:** Port the Electron translation engine to Rust: 7 providers + auto chain, cache (mem+disk), batching/chunking/concurrency, settings modal, and original/translation/bilingual reading modes over the existing `Block` model.

**Architecture:** Pure-Rust `translate` module (signing, providers, cache, pipeline) that is egui-free and unit-tested with a mocked HTTP client; a thin settings storage layer; and UI wiring in `main.rs`/a new `ui` module. Providers use `reqwest` (blocking) on worker threads; results flow back via an `mpsc` channel that the UI polls.

**Tech Stack:** `reqwest`, `md-5`, `sha2`, `hmac`, `base64`, `serde`/`serde_json`, `dirs`, `crossbeam-channel` (or std `mpsc`). No new GUI deps beyond egui already present.

## Global Constraints
- Builds on Phase 1. Do **not** alter the `markdown` model's public shape except where this phase extends rendering.
- All provider request construction & signing covered by offline unit tests (mock HTTP); no network/keys required for `cargo test`.
- Credentials never leave the main process; they live only in settings state.
- Keep `translate` modules free of egui types so they stay testable.
- Commit each task.

---

### Task 1: Crypto + provider metadata + registry
**Files:** `src/translate/sign.rs` · `src/translate/providers_meta.rs` · `src/translate/mod.rs`

**Interfaces:**
- Produces:
  - `pub fn md5(s: &str) -> String`, `pub fn sha256_hex(s: &str) -> String`
  - `pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8>`
  - `pub struct FieldDef { pub key: &'static str, pub label: &'static str, pub secret: bool, pub placeholder: &'static str }`
  - `pub struct ProviderMeta { pub label: &'static str, pub needs_key: bool, pub max_len: usize, pub max_concurrency: usize, pub chunk_concurrency: usize, pub fields: Vec<FieldDef>, pub note: &'static str }`
  - `pub fn meta() -> &'static [(&'static str, ProviderMeta)]` (ordered registry)
- Steps: `cargo add reqwest md-5 sha2 hmac base64 crossbeam-channel`; write `sign.rs`; write `providers_meta.rs` (port the 7 entries + auto from the JS `providers-meta.js`); write `mod.rs` (`pub mod sign; pub mod providers_meta;`). Add `#[test]` for `md5("abc")`/`sha256_hex("abc")` vectors. Commit.

### Task 2: HTTP client abstraction
**Files:** `src/translate/http.rs`
- `pub trait HttpClient { fn get(&self, url: &str) -> Result<HttpResp, String>; fn post_form(&self, url: &str, params: &[(String,String)]) -> Result<HttpResp,String>; fn post_json(&self, url: &str, body: serde_json::Value, headers: &[(String,String)]) -> Result<HttpResp,String>; }`
  with `pub struct HttpResp { pub status: u16, pub body: String }`.
- `pub struct ReqwestClient` implementing it over `reqwest::blocking`.
- A `MockClient` in tests (`#[cfg(test)]`) that captures requests and returns canned responses by URL substring (mirrors the JS mock). Commit.

### Task 3: Provider implementations
**Files:** `src/translate/providers/{mymemory,youdao,tencent,baidu,llm,transmart,iciba}.rs` + `src/translate/auto.rs`
- `pub struct Creds(pub std::collections::HashMap<String,String>)` with `get`.
- Each provider: `pub fn translate(text:&str, creds:&Creds, http:&dyn HttpClient) -> Result<String,String>`, porting exact signing + params + parsing from the JS files (Youdao v3 sha256 truncate, Tencent TC3-HMAC-SHA256, Baidu md5, iCiba md5, MyMemory query, Transmart client_key, LLM /chat/completions + clean()).
- `auto.rs` tries `[transmart, iciba, mymemory]` in order, returning the first success.
- Tests per provider (mock): request body/query/headers + response parsing (Youdao `translation` join, Baidu `trans_result[].dst` join, Tencent `Response.TargetText`, MyMemory `responseData.translatedText`, LLM `choices[0].message.content`, iCiba `data[].out`, Transmart `auto_translation`). Reuse the JS test assertions. Commit.

### Task 4: Cache
**Files:** `src/translate/cache.rs`
- `pub struct Cache { map: HashMap<String,String>, path: Option<PathBuf>, dirty: bool }`
- Key = `format!("{}\x00{}", provider, text)`; `get`, `set` (marks dirty, prunes at 20 000 by dropping oldest 25%), `load`, `save` (debounced in the UI layer), `clear`.
- Persist via `serde_json` at `{user_data}/qingbird-cache.json` (path from `dirs`).
- Tests: key format, prune-at-cap, round-trip save/load. Commit.

### Task 5: Pipeline (collect → batch → chunk → translate → write back)
**Files:** `src/translate/pipeline.rs`
- `pub fn needs_translation(text:&str) -> bool` (has an ASCII letter, no whitespace-only).
- `pub fn split_long(text:&str, max_len:usize) -> Vec<String>` port of the JS sentence/word/hard split.
- `pub fn merge_batches(segments: &[String], max_len:usize) -> Vec<Vec<usize>>` (index groups; merge adjacent short segments, cap ~0.8*max_len, long ones solo).
- `pub struct TransReq { pub id: usize, pub text: String }` / `pub struct TransBatcher`.
- `pub fn translate_segments(segs:&[String], creds, provider, pool, http, sink:&dyn Fn(usize, Result<String,String>))` — runs batches on a thread pool, chunks oversized batches, calls back with results; returns when all done.
- A `TranslateOrder`/epoch token to discard stale results is handled at the UI layer.
- Tests: `needs_translation`, `split_long` boundaries, `merge_batches` caps. Commit.

### Task 6: Settings storage + modal UI
**Files:** `src/storage.rs` · `src/ui/settings.rs` · modify `src/main.rs`
- `storage`: `load_settings() -> Settings`, `save_settings(&Settings)` at `{user_data}/qingbird-settings.json`; `Settings { provider:String, providers: HashMap<String,HashMap<String,String>>, workspace:Option<String>, last_file:Option<String>, hotkeys: HashMap<String,String>, selection_translate:bool, outline:String, nav:String }` (serde).
- `ui/settings`: modal window with provider dropdown, dynamic credential fields (text/password), note hint, Test-connection button (calls the pipeline for one short sentence using the form values, without saving), clear-cache button, hotkey recorder (original/translation/bilingual), selection-translate toggle.
- Wire into `main.rs` (Settings opens via a 🔧 button; Ctrl+click etc.).
- Tests: storage round-trip; form→creds collection. Commit.

### Task 7: Reading modes over the model
**Files:** extend `src/markdown/render.rs` + `src/state.rs`
- Add `TranslationStore`: `HashMap<usize, String>` mapping a block/segment id to its translation.
- `original` mode: render model as-is.
- `translation` mode: render each translatable block using its translated text (inline runs replaced).
- `bilingual` mode: render original block then an indented, muted-background translation block below.
- Wire a "翻译" button and a reading-mode selector (original/translation/bilingual) into `main.rs`; translation runs in the background thread pool with progress in the status bar.
- Manual verification: open an English `.md`, translate with a working provider.

## Self-review
- Spec coverage: signing ✓(T1,T3), 7 sources+auto ✓(T3), cache ✓(T4), batching/chunking/concurrency ✓(T5), needs-translation skip ✓(T5), settings modal ✓(T6), 3 reading modes ✓(T7). Credentials stay in main process ✓(T6). Offline tests ✓(T1–T5).
- Placeholders: none — provider code ports the JS exactly; tests given.
- Types consistent: `Creds`, `HttpClient`, `ProviderMeta`, `Cache`, `needstranslation`/`merge_batches` signatures match across tasks.
