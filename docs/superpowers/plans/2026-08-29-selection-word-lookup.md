# 选区查词（LLM 富卡片）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把划词翻译浮窗升级为 LLM 驱动的富查词卡片（词 → 音标/词性/用法/例句/生僻词；句 → 整句翻译），并给 LLM 翻译源加查词模型、厂商预设与在线模型拉取。

**Architecture:** 新 Rust 模块 `translate/lookup.rs` 承载查词纯函数（prompt、解析容错、缓存三件套、模型拉取），lib.rs 加两个薄命令（`lookup_word` 带缓存、`llm_list_models`）；前端 SelectionState 拆为 plain/rich/error 三形态，SelectionPopup 按 `kind` 分支渲染；SettingsModal 对 llm 源特判渲染预设下拉与拉取按钮。既有翻译流水线与 IPC 契约零改动。

**Tech Stack:** Rust (ureq/serde，无新依赖) + React 18 + zustand + Tauri 2 IPC。

**Spec:** `docs/superpowers/specs/2026-08-29-selection-word-lookup-design.md`（决策：范围 A+C、配置 B1、路由 R1、卡片形态 A）。

## Global Constraints

- **线格式 snake_case**：Rust serde 不改名，TS 同名字段（`src/types/ipc.ts` 头注惯例）；`Option<T>` → `| null`。
- **零新依赖**：Rust 与前端均不加任何包。
- **凭据安全**：apiKey 等凭据绝不打印、toast、进日志（`src/lib/ipc.ts` 门面安全不变量）。
- **缓存锁纪律**：`AppTxn.cache` 的 `Mutex` 绝不跨网络请求持有（lib.rs AppTxn 注释先例）——短锁读、网络、短锁写。
- **URL 拼接**：`baseUrl` 统一 `trim().trim_end_matches('/')` 后拼 `/chat/completions` 或 `/models`。
- **验证命令**：Rust 侧 `cargo test --workspace`（在 `src-tauri/` 下）；前端 `npm run build`（tsc 严格 + vite）。两条全绿才算完成。
- **提交风格**：`feat(lookup): …` / `docs: …` 中文描述，匹配仓库历史。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/dto.rs` | 修改 | 追加 `WordLookupDTO`/`LookupExample`/`LookupTerm`（IPC 线格式） |
| `src-tauri/src/translate/lookup.rs` | 新建 | 查词纯函数：prompt、请求构造、解析容错、缓存三件套、`fetch_models`/`parse_models_body` |
| `src-tauri/src/translate/mod.rs` | 修改 | `pub mod lookup;` |
| `src-tauri/src/translate/http.rs` | 修改 | trait 加 `get_headers_timeout`（默认回落 `get`）；UreqClient 覆写；MockClient 覆写 + `/models`/lookup happy-path 假响应 |
| `src-tauri/src/lib.rs` | 修改 | `lookup_word` / `llm_list_models` 命令 + 注册 |
| `src-tauri/src/translate/providers_meta.rs` | 修改 | LLM_FIELDS 加 `lookup_model` 字段、占位文案更新、测试断言 3→4 |
| `src/types/ipc.ts` | 修改 | `WordLookupDTO` 等线类型 |
| `src/lib/ipc.ts` | 修改 | `api.lookupWord` / `api.llmListModels` |
| `src/stores/useTranslationStore.ts` | 修改 | `SelectionState` 拆三形态 + `translateSelection` R1 分流 |
| `src/components/SelectionPopup.tsx` | 修改 | 富卡片渲染（卡片 A） |
| `src/styles/global.css` | 修改 | `.sel-pop-*` 富卡片样式 |
| `src/components/SettingsModal.tsx` | 修改 | llm 源：预设下拉 + `lookup_model` 字段 + 拉取模型按钮 + datalist |
| `docs/regression-checklist.md` | 修改 | 追加手工回归条目 |

---

### Task 1: Rust 查词核心 — DTO + `lookup.rs`（prompt/解析/缓存）

**Files:**
- Create: `src-tauri/src/translate/lookup.rs`
- Modify: `src-tauri/src/dto.rs`（文件末尾 tests 模块之前）
- Modify: `src-tauri/src/translate/mod.rs`
- Modify: `src-tauri/src/translate/http.rs`（test_mock 的 `resp_for`）

**Interfaces:**
- Consumes: `super::http::HttpClient`（trait）、`super::providers::Creds(pub HashMap<String,String>)`、`super::cache::Cache`（`get/set/Cache::key`）
- Produces（后续任务依赖的精确签名）:
  - `pub const CACHE_PROVIDER: &str = "llm-lookup"`
  - `pub fn llm_lookup(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<crate::dto::WordLookupDTO, String>`
  - `pub fn parse_lookup_json(content: &str) -> Result<crate::dto::WordLookupDTO, String>`
  - `pub fn cache_get_lookup(cache: &Cache, text: &str) -> Option<WordLookupDTO>`
  - `pub fn cache_put_lookup(cache: &mut Cache, text: &str, dto: &WordLookupDTO)`

- [ ] **Step 1: dto.rs 追加线格式 DTO**

在 `src-tauri/src/dto.rs` 的 `ProviderInfoDto` 结构体之后、`#[cfg(test)]` 之前插入：

```rust
/// 选区查词：一条双语例句（spec 2026-08-29 §5.1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupExample {
    pub en: String,
    pub zh: String,
}

/// 选区查词：一个生僻词解释。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupTerm {
    pub word: String,
    pub phonetic: String,
    pub explanation: String,
}

/// 选区查词结果。`kind = "word"` 时全部字段有效；`"sentence"` 时 phonetic
/// 及以下为 None / 空数组。serde 不改名（snake_case 线格式，ipc.ts 同名对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordLookupDTO {
    pub kind: String, // "word" | "sentence"
    pub translation: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Option<String>,
    pub usage: Option<String>,
    pub examples: Vec<LookupExample>,
    pub terms: Vec<LookupTerm>,
}
```

- [ ] **Step 2: 写 lookup.rs 失败测试（含 happy-path 假响应）**

先改 `src-tauri/src/translate/http.rs` 的 `test_mock::resp_for`，加两个 URL 分支（放在 `chat/completions` 分支之前）：

```rust
        } else if url.contains("/models") {
            // llm_list_models：两模型 + 一重复项 + 一空 id（测试去重/排序/过滤）
            r#"{"object":"list","data":[{"id":"m-b"},{"id":"m-a"},{"id":"m-b"},{"id":""}]}"#
        } else if url.contains("lookup-mock.test") {
            // 选区查词 happy path：content 本身是合法查词 JSON（JSON-in-JSON 转义）
            r#"{"choices":[{"message":{"content":"{\"type\":\"word\",\"translation\":\"便利设施\",\"phonetic\":\"/əˈmenəti/\",\"partOfSpeech\":\"n.\",\"usage\":\"指提升舒适度的设施。\",\"examples\":[],\"terms\":[]}"}}]}"#
```

再新建 `src-tauri/src/translate/lookup.rs`，只写模块头与测试（实现函数暂缺，编译失败即红灯）：

```rust
//! LLM 选区查词（spec 2026-08-29-selection-word-lookup）：词/句分流 +
//! 富结果。与 providers.rs 的整篇 `llm()` 共用 HttpClient 抽象，但 prompt、
//! 解析容错与缓存独立演进；模型选择按 B1（lookup_model 优先，空回落 model）。

use serde_json::Value;

use super::cache::Cache;
use super::http::HttpClient;
use super::providers::Creds;

/// 查词结果在翻译缓存中的 provider 名（与整篇翻译键空间隔离）。
pub const CACHE_PROVIDER: &str = "llm-lookup";
const LOOKUP_TIMEOUT_MS: u64 = 30_000;
const MODELS_TIMEOUT_MS: u64 = 15_000;

const LOOKUP_SYSTEM_PROMPT: &str = "你是一个中英翻译助手。用户会输入一个词/短语，或一句话/一段话。\n\n只输出一个 JSON 对象，不要输出任何额外文字，不要用代码块包裹。JSON 结构：\n{\"type\":\"word\"|\"sentence\",\"translation\":\"翻译结果\",\"phonetic\":\"音标或null\",\"partOfSpeech\":\"词性或null\",\"usage\":\"用法说明或null\",\"examples\":[{\"en\":\"英文例句\",\"zh\":\"中文翻译\"}],\"terms\":[{\"word\":\"英文词\",\"phonetic\":\"音标\",\"explanation\":\"中文解释\"}]}\n\n规则：\n1. 自动判断输入是中文还是英文，做中英互译（中→英、英→中）。\n2. 自动判断输入是「词/短语」还是「句子/段落」，填入 type。\n3. type 为 word 时（输入是词/短语）：\n   - translation：核心翻译，简洁\n   - phonetic：英文那一侧单词的 IPA 音标（带斜杠），无法给出为 null\n   - partOfSpeech：词性，如 n./v./adj./adv.，无法确定为 null\n   - usage：2-4 句简明中文，讲常见搭配、使用语境、易混淆点或近义辨析\n   - examples：2-3 个例句，例句要自然、能体现该词的典型用法\n   - terms：空数组 []\n4. type 为 sentence 时：\n   - translation：整句翻译\n   - phonetic、partOfSpeech、usage 为 null，examples 为空数组 []\n   - terms：从英文那一侧（输入英文则原文、输入中文则译文）挑出的较生僻、较难的单词，每个给 word、IPA 音标 phonetic、简洁中文 explanation；常见简单词不挑，没有则空数组\n5. 音标只针对英文单词，使用 IPA；中文不需要音标。";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;
    use std::collections::HashMap;

    fn creds(base: &str, model: &str, lookup_model: &str) -> Creds {
        let mut m = HashMap::new();
        if !base.is_empty() { m.insert("baseUrl".to_string(), base.to_string()); }
        if !model.is_empty() { m.insert("model".to_string(), model.to_string()); }
        if !lookup_model.is_empty() { m.insert("lookup_model".to_string(), lookup_model.to_string()); }
        Creds(m)
    }

    const WORD_JSON: &str = r#"{"type":"word","translation":" 便利设施 ","phonetic":"/əˈmenəti/","partOfSpeech":"n.","usage":"用法说明","examples":[{"en":"The hotel has amenities.","zh":"酒店有设施。"},{"en":"","zh":"仅中文"}],"terms":[{"word":"lavish","phonetic":"/ˈlævɪʃ/","explanation":"奢华的"},{"word":" ","phonetic":"","explanation":"空白应被过滤"}]}"#;

    // ---- 请求构造 ----

    #[test]
    fn builds_request_with_lookup_model_priority() {
        let http = MockClient::new();
        let _ = llm_lookup("amenity", &creds("https://api.deepseek.com", "main-model", "fast-model"), &http);
        let r = &http.take_records()[0];
        assert_eq!(r.url, "https://api.deepseek.com/chat/completions");
        assert!(r.body.contains("\"model\":\"fast-model\""), "lookup_model 优先: {}", r.body);
        assert!(r.body.contains("0.2"), "temperature 0.2: {}", r.body);
        assert!(r.body.contains("中英翻译助手"), "system prompt 在场");
    }

    #[test]
    fn falls_back_to_model_and_normalizes_trailing_slash() {
        let http = MockClient::new();
        let _ = llm_lookup("hi", &creds("https://x.io/", "main-model", ""), &http);
        let r = &http.take_records()[0];
        assert_eq!(r.url, "https://x.io/chat/completions");
        assert!(r.body.contains("\"model\":\"main-model\""));
    }

    #[test]
    fn sends_bearer_only_when_key_present() {
        let mut c = creds("https://x.io", "m", "");
        c.0.insert("apiKey".to_string(), "sk-1".to_string());
        let http = MockClient::new();
        let _ = llm_lookup("hi", &c, &http);
        assert_eq!(
            http.take_records()[0].headers,
            vec![("Authorization".to_string(), "Bearer sk-1".to_string())]
        );
        let c2 = creds("https://x.io", "m", "");
        let http2 = MockClient::new();
        let _ = llm_lookup("hi", &c2, &http2);
        assert!(http2.take_records()[0].headers.is_empty(), "无 key 不带 Authorization");
    }

    #[test]
    fn missing_base_or_model_is_actionable_error() {
        let http = MockClient::new();
        let e = llm_lookup("hi", &creds("", "m", ""), &http).unwrap_err();
        assert!(e.contains("API 地址"), "{e}");
        let e = llm_lookup("hi", &creds("https://x.io", "", ""), &http).unwrap_err();
        assert!(e.contains("模型名"), "{e}");
        // lookup_model 为空但 model 有值 → 不报错（回落），MockClient 返回
        // lookup-mock happy path 之外的内容可能失败，这里只验错误分支即可。
    }

    // ---- happy path（走 MockClient 的 lookup-mook.test 分支）----

    #[test]
    fn end_to_end_happy_path_maps_keys() {
        let http = MockClient::new();
        let dto = llm_lookup("amenity", &creds("https://lookup-mock.test/v1", "m", ""), &http).unwrap();
        assert_eq!(dto.kind, "word");
        assert_eq!(dto.translation, "便利设施");
        assert_eq!(dto.part_of_speech.as_deref(), Some("n."));
    }

    #[test]
    fn non_json_content_is_explicit_error() {
        let http = MockClient::new();
        let e = llm_lookup("hi", &creds("https://x.io", "m", ""), &http).unwrap_err();
        assert!(e.contains("不是有效 JSON"), "{e}");
    }

    // ---- 解析容错（纯函数）----

    #[test]
    fn parses_word_json_with_key_mapping_and_cleanup() {
        let dto = parse_lookup_json(WORD_JSON).unwrap();
        assert_eq!(dto.kind, "word");
        assert_eq!(dto.translation, "便利设施"); // trim
        assert_eq!(dto.phonetic.as_deref(), Some("/əˈmenəti/"));
        assert_eq!(dto.part_of_speech.as_deref(), Some("n."));
        assert_eq!(dto.examples.len(), 2, "en 空 zh 非空的例句保留");
        assert_eq!(dto.terms.len(), 1, "word 为空白的生僻词被过滤");
        assert_eq!(dto.terms[0].word, "lavish");
    }

    #[test]
    fn sentence_maps_to_nulls_and_strips_fence() {
        let raw = "```json\n{\"type\":\"sentence\",\"translation\":\"你好。\",\"phonetic\":null,\"partOfSpeech\":null,\"usage\":null,\"examples\":[],\"terms\":[]}\n```";
        let dto = parse_lookup_json(raw).unwrap();
        assert_eq!(dto.kind, "sentence");
        assert_eq!(dto.phonetic, None);
        assert_eq!(dto.part_of_speech, None);
        assert_eq!(dto.usage, None);
        assert!(dto.examples.is_empty() && dto.terms.is_empty());
    }

    #[test]
    fn tolerates_prose_around_json() {
        let dto = parse_lookup_json(&format!("好的：{WORD_JSON} 以上。")).unwrap();
        assert_eq!(dto.translation, "便利设施");
    }

    #[test]
    fn rejects_non_json_with_snippet() {
        let e = parse_lookup_json("这不是 JSON").unwrap_err();
        assert!(e.contains("不是有效 JSON"), "{e}");
    }

    // ---- 契约（spec §10.6：线格式逐字段对齐）----

    #[test]
    fn word_lookup_dto_serializes_snake_case_for_ipc() {
        let dto = parse_lookup_json(WORD_JSON).unwrap();
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"part_of_speech\""), "线格式 snake_case: {json}");
        assert!(!json.contains("partOfSpeech"), "禁止 camelCase 泄入线格式: {json}");
        assert!(json.contains("\"kind\"") && json.contains("\"translation\""));
    }

    // ---- 缓存三件套 ----

    #[test]
    fn cache_roundtrip_and_malformed_self_heal() {
        let mut c = Cache::new();
        assert!(cache_get_lookup(&c, "w").is_none(), "未命中");
        let dto = parse_lookup_json(WORD_JSON).unwrap();
        cache_put_lookup(&mut c, "w", &dto);
        assert_eq!(cache_get_lookup(&c, "w").unwrap().translation, "便利设施");
        c.set(Cache::key(CACHE_PROVIDER, "bad"), "not-json".into());
        assert!(cache_get_lookup(&c, "bad").is_none(), "坏 JSON 自愈为未命中");
        assert_eq!(Cache::key(CACHE_PROVIDER, "w"), "llm-lookup\u{0}w", "键空间与整篇翻译隔离");
    }

    // ---- 模型列表 ----

    #[test]
    fn fetch_models_sends_bearer_and_parses_sorted() {
        let http = MockClient::new();
        let ids = fetch_models("https://x.io/", "sk-1", &http).unwrap();
        assert_eq!(ids, vec!["m-a", "m-b"], "去重 + 排序 + 过滤空 id");
        let r = &http.take_records()[0];
        assert_eq!(r.url, "https://x.io/models");
        assert_eq!(
            r.headers,
            vec![("Authorization".to_string(), "Bearer sk-1".to_string())]
        );
    }

    #[test]
    fn fetch_models_requires_base_url() {
        let http = MockClient::new();
        let e = fetch_models("", "sk-1", &http).unwrap_err();
        assert!(e.contains("Base URL"), "{e}");
    }

    #[test]
    fn parse_models_body_rejects_missing_data() {
        assert!(parse_models_body(r#"{"object":"list"}"#).is_err());
        assert!(parse_models_body("not json").is_err());
    }
}
```

- [ ] **Step 3: 运行确认红灯**

Run（workdir `src-tauri/`）: `cargo test --workspace lookup`
Expected: 编译失败（`llm_lookup`/`parse_lookup_json`/`cache_get_lookup`/`cache_put_lookup`/`fetch_models`/`parse_models_body` 未定义）。

- [ ] **Step 4: 写最小实现**

在 `lookup.rs` 的 `LOOKUP_SYSTEM_PROMPT` 常量之后、`#[cfg(test)]` 之前补齐实现：

```rust
/// 选区查词主入口：POST {base}/chat/completions（B1 模型回落），30s 超时。
pub fn llm_lookup(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<crate::dto::WordLookupDTO, String> {
    let base = creds
        .get("baseUrl")
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_default();
    if base.is_empty() {
        return Err("请先在「设置」中填写自定义大模型的 API 地址".to_string());
    }
    let lookup_model = creds.get("lookup_model").map(|s| s.trim().to_string()).unwrap_or_default();
    let model = if lookup_model.is_empty() {
        creds.get("model").map(|s| s.trim().to_string()).unwrap_or_default()
    } else {
        lookup_model
    };
    if model.is_empty() {
        return Err("请先在「设置」中填写模型名".to_string());
    }
    let url = format!("{base}/chat/completions");
    let api_key = creds.get("apiKey").map(|s| s.trim()).unwrap_or("").to_string();
    let mut headers: Vec<(&str, &str)> = Vec::new();
    let auth_owned;
    if api_key.is_empty() {
        auth_owned = String::new();
    } else {
        auth_owned = format!("Bearer {api_key}");
        headers.push(("Authorization", auth_owned.as_str()));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": LOOKUP_SYSTEM_PROMPT },
            { "role": "user", "content": text },
        ],
        "temperature": 0.2,
    })
    .to_string();

    let r = http.post_json_timeout(&url, &body, &headers, LOOKUP_TIMEOUT_MS)?;
    if r.status >= 400 {
        let mut detail = String::new();
        if let Ok(v) = serde_json::from_str::<Value>(&r.body) {
            if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|x| x.as_str()) {
                detail = format!("：{msg}");
            }
        }
        return Err(format!("查词请求返回 {}{detail}", r.status));
    }
    let v = serde_json::from_str::<Value>(&r.body).map_err(|e| format!("查词响应解析失败：{e}"))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str())
        .ok_or("查词响应无内容")?;
    parse_lookup_json(content)
}

/// 模型回复 → DTO。容错顺序：剥 ``` 围栏 → 截取首 `{` 至末 `}` → serde →
/// 键映射（type→kind、partOfSpeech→part_of_speech）与字段规整（空串 → None、
/// 无效数组项过滤）。仍失败报 Err（含回复前 200 字符截断）。
pub fn parse_lookup_json(content: &str) -> Result<crate::dto::WordLookupDTO, String> {
    use crate::dto::{LookupExample, LookupTerm, WordLookupDTO};

    let mut json_text = content.trim();
    if json_text.starts_with("```") {
        let inner = json_text.strip_prefix("```").unwrap_or(json_text);
        let inner = inner.split_once('\n').map(|(_, rest)| rest).unwrap_or(inner);
        let inner = inner.strip_suffix("```").unwrap_or(inner).trim();
        if !inner.is_empty() {
            json_text = inner;
        }
    }
    let start = json_text.find('{').unwrap_or(0);
    let end = json_text.rfind('}').map(|i| i + 1).unwrap_or(json_text.len());
    let slice = &json_text[start..end];
    let v: Value = serde_json::from_str(slice).map_err(|_| {
        let short: String = content.trim().chars().take(200).collect();
        format!("查词返回不是有效 JSON：{short}")
    })?;

    let kind = match v.get("type").and_then(|x| x.as_str()) {
        Some("sentence") => "sentence",
        _ => "word",
    };
    let opt_str = |key: &str| -> Option<String> {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let empty_arr: Vec<Value> = Vec::new();
    let examples = v
        .get("examples")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty_arr)
        .iter()
        .filter_map(|it| {
            let en = it.get("en").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let zh = it.get("zh").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if en.is_empty() && zh.is_empty() { None } else { Some(LookupExample { en, zh }) }
        })
        .collect();
    let terms = v
        .get("terms")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty_arr)
        .iter()
        .filter_map(|it| {
            let word = it.get("word").and_then(|x| x.as_str())?.trim().to_string();
            if word.is_empty() { return None; }
            let phonetic = it.get("phonetic").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let explanation = it.get("explanation").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            Some(LookupTerm { word, phonetic, explanation })
        })
        .collect();

    Ok(WordLookupDTO {
        kind: kind.to_string(),
        translation: v.get("translation").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
        phonetic: opt_str("phonetic"),
        part_of_speech: opt_str("partOfSpeech"),
        usage: opt_str("usage"),
        examples,
        terms,
    })
}

/// 命中读取；缓存里的坏 JSON 自愈为未命中（下次网络结果会覆写）。
pub fn cache_get_lookup(cache: &Cache, text: &str) -> Option<crate::dto::WordLookupDTO> {
    let json = cache.get(&Cache::key(CACHE_PROVIDER, text))?;
    serde_json::from_str(json).ok()
}

/// 回写（不落盘——落盘由命令层在短锁内完成）。
pub fn cache_put_lookup(cache: &mut Cache, text: &str, dto: &crate::dto::WordLookupDTO) {
    let json = serde_json::to_string(dto).unwrap_or_default();
    cache.set(Cache::key(CACHE_PROVIDER, text), json);
}

/// 拉取 OpenAI 兼容 GET {base}/models：Bearer（key 非空时）、15s 超时、
/// 解析 data[].id 去重排序。
pub fn fetch_models(base_url: &str, api_key: &str, http: &dyn HttpClient) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 API 地址 (Base URL)".to_string());
    }
    let url = format!("{base}/models");
    let mut headers: Vec<(&str, &str)> = Vec::new();
    let key = api_key.trim();
    let auth_owned;
    if key.is_empty() {
        auth_owned = String::new();
    } else {
        auth_owned = format!("Bearer {key}");
        headers.push(("Authorization", auth_owned.as_str()));
    }
    let r = http.get_headers_timeout(&url, &headers, MODELS_TIMEOUT_MS)?;
    if r.status >= 400 {
        return Err(format!("拉取模型列表返回 {}", r.status));
    }
    parse_models_body(&r.body)
}

/// OpenAI 兼容模型列表体 → 排序去重的 id 列表。
pub fn parse_models_body(body: &str) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("模型列表响应解析失败：{e}"))?;
    let data = v
        .get("data")
        .and_then(|x| x.as_array())
        .ok_or("模型列表响应缺少 data 字段")?;
    let mut ids: Vec<String> = data
        .iter()
        .filter_map(|m| m.get("id").and_then(|x| x.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}
```

同时给 `src-tauri/src/translate/http.rs` 的 trait 加方法（默认实现照 `post_json_timeout` 模式）、`UreqClient` 覆写、`MockClient` 覆写：

trait 内（`post_json_timeout` 之后）追加：

```rust
    /// GET with per-request headers + timeout. Default falls back to
    /// [`Self::get`] ignoring both (used by mocks) — mirrors post_json_timeout.
    fn get_headers_timeout(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let _ = (headers, timeout_ms);
        self.get(url)
    }
```

`impl HttpClient for UreqClient` 内追加：

```rust
    fn get_headers_timeout(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let mut req = ureq::get(url).timeout(std::time::Duration::from_millis(timeout_ms));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        map(req.call())
    }
```

`impl HttpClient for MockClient` 内追加（记录 headers 供断言）：

```rust
        fn get_headers_timeout(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            _timeout_ms: u64,
        ) -> Result<HttpResp, String> {
            self.record(url, "", headers);
            Ok(resp_for(url))
        }
```

`src-tauri/src/translate/mod.rs` 追加一行 `pub mod lookup;`（按字母序插在 `pub mod cache;` 与 `pub mod http;` 之间）。

- [ ] **Step 5: 运行测试确认绿灯**

Run（workdir `src-tauri/`）: `cargo test --workspace lookup`
Expected: 全部 PASS（本任务 11 个 lookup 测试）。

Run（workdir `src-tauri/`）: `cargo test --workspace`
Expected: 全仓 PASS（确认没有破坏既有测试）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/dto.rs src-tauri/src/translate/lookup.rs src-tauri/src/translate/mod.rs src-tauri/src/translate/http.rs
git commit -m "feat(lookup): 选区查词 Rust 核心 — 词/句分流 prompt、解析容错、缓存三件套、模型拉取"
```

---

### Task 2: IPC 命令接线 — `lookup_word`（带缓存）+ `llm_list_models`

**Files:**
- Modify: `src-tauri/src/lib.rs`（命令区 ~L388 `translate_text` 之后；注册表 L611-637）

**Interfaces:**
- Consumes: Task 1 的 `llm_lookup` / `cache_get_lookup` / `cache_put_lookup` / `fetch_models` / `CACHE_PROVIDER`；`AppTxn.cache: Arc<Mutex<Cache>>`；`storage::cache_path()`
- Produces: Tauri 命令 `lookup_word(text, creds) -> Result<WordLookupDTO, String>`、`llm_list_models(base_url, api_key) -> Result<Vec<String>, String>`（Task 3 的 `api.lookupWord`/`api.llmListModels` 按此接线；Tauri v2 默认 camelCase 参数映射 `{ baseUrl, apiKey }`）

本任务是测试过的纯函数之上的薄编排（锁窗口 + 注册），验证以全仓测试与编译为准。

- [ ] **Step 1: lib.rs 追加两个命令**

在 `translate_text` 函数（约 L403 `}` 之后）插入：

```rust
/// 选区查词（spec 2026-08-29）：LLM 词/句分流 + 富结果；结果进翻译缓存
/// （provider 名 "llm-lookup"），命中零网络。async 同 translate_text 先例：
/// 阻塞网络离开主线程。缓存锁纪律：短锁读 → 网络（不持锁）→ 短锁写 + 落盘。
#[tauri::command(async)]
fn lookup_word(
    text: String,
    creds: HashMap<String, String>,
    st: tauri::State<AppTxn>,
) -> Result<dto::WordLookupDTO, String> {
    // 1. 短锁命中检查（缓存坏 JSON 自愈为未命中，见 cache_get_lookup）
    {
        let c = st.cache.lock().expect("cache mutex poisoned");
        if let Some(dto) = translate::lookup::cache_get_lookup(&c, &text) {
            return Ok(dto);
        }
    }
    // 2. 网络调用绝不持锁
    let http = translate::http::UreqClient;
    let dto = translate::lookup::llm_lookup(&text, &translate::providers::Creds(creds), &http)?;
    // 3. 短锁回写 + 落盘；落盘失败仅丢持久性（内存已有），不向用户报错
    {
        let mut c = st.cache.lock().expect("cache mutex poisoned");
        translate::lookup::cache_put_lookup(&mut c, &text, &dto);
        let _ = c.save(&storage::cache_path());
    }
    Ok(dto)
}

/// 拉取 LLM 厂商可用模型列表（OpenAI 兼容 GET /models），供设置弹窗点选，
/// 消除模型 ID 手填错误。编排已在 lookup::fetch_models（可测），此处薄壳。
#[tauri::command(async)]
fn llm_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let http = translate::http::UreqClient;
    translate::lookup::fetch_models(&base_url, &api_key, &http)
}
```

在 `invoke_handler` 注册表 `translate_text,`（L627）之后插入：

```rust
            // 选区查词（2026-08-29 spec）
            lookup_word,
            llm_list_models,
```

- [ ] **Step 2: 验证**

Run（workdir `src-tauri/`）: `cargo test --workspace`
Expected: 全仓 PASS。

Run（workdir `src-tauri/`）: `cargo build`
Expected: 编译通过（命令签名经 generate_handler 校验）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lookup): lookup_word/llm_list_models IPC 命令接线（缓存短锁纪律）"
```

---

### Task 3: 前端管线 — 线类型 + api 门面 + store 分流

**Files:**
- Modify: `src/types/ipc.ts`（末尾追加）
- Modify: `src/lib/ipc.ts`（类型 import + 翻译段追加）
- Modify: `src/stores/useTranslationStore.ts`（L12-16 `SelectionState`、L140-164 `translateSelection`、L4 import）

**Interfaces:**
- Consumes: Task 2 的命令名与参数（`lookup_word`/`llm_list_models`）
- Produces（Task 4/5 依赖）:
  - `types/ipc.ts`: `export interface WordLookupDTO { kind: "word" | "sentence"; translation: string; phonetic: string | null; part_of_speech: string | null; usage: string | null; examples: LookupExample[]; terms: LookupTerm[] }`（`LookupExample`/`LookupTerm` 同文件）
  - `api.lookupWord(t: string, c: Record<string, string>) => Promise<WordLookupDTO>`
  - `api.llmListModels(baseUrl: string, apiKey: string) => Promise<string[]>`
  - `SelectionState = { text: string; loading: boolean; plain: string | null; rich: WordLookupDTO | null; error: string | null }`

前端无单测 runner，验证 = `npm run build`（tsc 严格编译）。

- [ ] **Step 1: types/ipc.ts 追加线类型**

在文件末尾（`ViewKind` 之后）追加：

```ts
/** dto.rs LookupExample */
export interface LookupExample {
  en: string;
  zh: string;
}

/** dto.rs LookupTerm */
export interface LookupTerm {
  word: string;
  phonetic: string;
  explanation: string;
}

/** dto.rs WordLookupDTO：kind="sentence" 时 phonetic 及以下为 null / 空数组 */
export interface WordLookupDTO {
  kind: "word" | "sentence";
  translation: string;
  phonetic: string | null;
  part_of_speech: string | null;
  usage: string | null;
  examples: LookupExample[];
  terms: LookupTerm[];
}
```

- [ ] **Step 2: ipc.ts 门面追加两个调用**

`import type { … } from "../types/ipc"` 列表加 `WordLookupDTO`；`// ---- 翻译 ----` 段 `stopTranslation` 之后追加：

```ts
  // 选区查词（2026-08-29 spec）：LLM 词/句分流富结果；结果缓存于 Rust 侧
  lookupWord: (t: string, c: Record<string, string>) =>
    invoke<WordLookupDTO>("lookup_word", { text: t, creds: c }),
  // 拉取 OpenAI 兼容 /models 供设置弹窗点选（Tauri v2 默认 camelCase 参数映射）
  llmListModels: (baseUrl: string, apiKey: string) =>
    invoke<string[]>("llm_list_models", { baseUrl, apiKey }),
```

- [ ] **Step 3: store 分流改造**

`useTranslationStore.ts` 的 import 行（L4）改为：

```ts
import type { DonePayload, Mode, ProgressPayload, WordLookupDTO } from "../types/ipc";
```

`SelectionState`（L12-16）替换为：

```ts
interface SelectionState {
  text: string;
  loading: boolean;
  plain: string | null; // 现状路径结果（未配 LLM 时走全局翻译源）
  rich: WordLookupDTO | null; // LLM 查词富结果
  error: string | null; // 显式失败（不静默回落，spec §9.2）
}
```

`translateSelection`（L140-164）整体替换为：

```ts
  translateSelection: (text) => {
    clearTimeout(selTimer);
    if (!text.trim()) {
      set({ selection: null });
      return;
    }
    set({ selection: { text, loading: true, plain: null, rich: null, error: null } });
    selTimer = setTimeout(async () => {
      const sp = useSettingsStore.getState().settings;
      const cur = () => get().selection;
      const settle = (patch: Partial<SelectionState>) => {
        // 防乱序：只有仍是本次请求在展示时才回填
        if (cur()?.text === text) set({ selection: { text, loading: false, ...patch } });
      };
      if (!sp) {
        settle({ plain: null, rich: null, error: "设置尚未加载" });
        return;
      }
      // R1 分流：LLM 凭据齐全（baseUrl + model 均非空）→ 查词；否则现状全局源。
      // 与全局翻译源选择无关——划词只认 LLM 是否配置（spec §8.1）。
      const llmCreds = useSettingsStore.getState().credsFor("llm");
      const llmReady = Boolean(llmCreds.baseUrl?.trim() && llmCreds.model?.trim());
      try {
        if (llmReady) {
          const rich = await api.lookupWord(text, llmCreds);
          settle({ plain: null, rich, error: null });
        } else {
          const r = await api.translateText(text, sp.provider, useSettingsStore.getState().credsFor(sp.provider));
          settle({ plain: r, rich: null, error: null });
        }
      } catch (e) {
        settle({ plain: null, rich: null, error: errText(e) });
      }
    }, 300);
  },
```

- [ ] **Step 4: 验证**

Run: `npm run build`
Expected: tsc 严格编译 + vite 构建成功（SelectionPopup 此时若因 `sel.result` 报类型错误属预期——Task 4 修；若报错，先确认报错仅限 SelectionPopup.tsx 再继续）。

- [ ] **Step 5: Commit**

```bash
git add src/types/ipc.ts src/lib/ipc.ts src/stores/useTranslationStore.ts
git commit -m "feat(lookup): 前端线类型 + api 门面 + 划词 R1 分流（LLM 配置完整走查词）"
```

---

### Task 4: SelectionPopup 富卡片渲染 + 样式

**Files:**
- Modify: `src/components/SelectionPopup.tsx`（整体重写）
- Modify: `src/styles/global.css`（L1087 `@keyframes sel-pop-rot` 块之后插入）

**Interfaces:**
- Consumes: Task 3 的 `WordLookupDTO`、`SelectionState`（`plain/rich/error`）
- Produces: 渲染完成；卡片 A（纵向层级）——word 词头/译文/用法/例句（原词着重）/生僻词；sentence 只出译文

- [ ] **Step 1: 重写 SelectionPopup.tsx**

整文件替换为：

```tsx
// T24 划词翻译浮窗 → 选区查词富卡片（spec 2026-08-29 §8.2，卡片 A 纵向层级）：
// rich(word) = 词头(原词+IPA+词性)/译文/用法/例句(原词着重)/生僻词；
// rich(sentence) = 整句译文；plain = 未配 LLM 的现状回落；error = 显式失败。
// 选区捕获、300ms 防抖、乱序保护在 store；本组件纯渲染 + Esc/点外关闭（不变）。
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { WordLookupDTO } from "../types/ipc";

/** 例句原词着重（大小写不敏感）。纯节点切分，不走 innerHTML（LLM 输出不可信）。 */
function Emphasized({ text, word }: { text: string; word: string }) {
  if (!word) return <>{text}</>;
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(w, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<em key={hit}>{text.slice(hit, hit + w.length)}</em>);
    i = hit + w.length;
  }
  return <>{parts}</>;
}

function WordCard({ rich, word }: { rich: WordLookupDTO; word: string }) {
  if (rich.kind === "sentence") {
    return <div className="sel-pop-res">{rich.translation}</div>;
  }
  return (
    <div className="sel-pop-rich">
      <div className="sel-pop-wordhead">
        <span className="sel-pop-term">{word}</span>
        {rich.phonetic && <span className="sel-pop-phon">{rich.phonetic}</span>}
        {rich.part_of_speech && <span className="sel-pop-pos">{rich.part_of_speech}</span>}
      </div>
      <div className="sel-pop-main">{rich.translation}</div>
      {rich.usage && <div className="sel-pop-usage">{rich.usage}</div>}
      {rich.examples.length > 0 && (
        <div className="sel-pop-block">
          <div className="sel-pop-label">例句</div>
          {rich.examples.map((ex, i) => (
            <div className="sel-pop-example" key={i}>
              <div className="sel-pop-en">
                <Emphasized text={ex.en} word={word} />
              </div>
              {ex.zh && <div className="sel-pop-zh">{ex.zh}</div>}
            </div>
          ))}
        </div>
      )}
      {rich.terms.length > 0 && (
        <div className="sel-pop-block sel-pop-terms">
          <div className="sel-pop-label">生僻词</div>
          {rich.terms.map((t, i) => (
            <div className="sel-pop-termrow" key={i}>
              <b>{t.word}</b>
              {t.phonetic && <span className="sel-pop-phon">{t.phonetic}</span>}
              {t.explanation && <span className="sel-pop-termexp"> — {t.explanation}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SelectionPopup() {
  const sel = useTranslationStore((s) => s.selection);
  const clearSelection = useTranslationStore((s) => s.clearSelection);
  const on = useSettingsStore((s) => s.settings?.selection_translate ?? false);
  const ref = useRef<HTMLDivElement>(null);

  // 开关关闭：render 即时隐藏之外还要清态——clearSelection 连带清防抖定时器，
  // 在途请求结果也因子代失配（selection 已为 null）被丢弃，重开不闪旧结果。
  useEffect(() => {
    if (!on) clearSelection();
  }, [on, clearSelection]);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    const onDown = (e: MouseEvent) => {
      // 浮窗外按下（含在编辑器里开始新的拖选）即关闭；新选区随后自然重触发
      if (ref.current && !ref.current.contains(e.target as Node)) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [sel, clearSelection]);

  if (!on || !sel) return null;

  return (
    <div className="sel-pop" ref={ref} role="dialog" aria-label="划词翻译">
      <div className="sel-pop-head">
        <span className="sel-pop-title">划词翻译</span>
        <button type="button" className="sel-pop-clear" onClick={clearSelection}>
          清除
        </button>
      </div>
      {sel.loading ? (
        <div className="sel-pop-spin" aria-label="翻译中" />
      ) : sel.error ? (
        <div className="sel-pop-res sel-pop-err">{sel.error}</div>
      ) : sel.rich ? (
        <WordCard rich={sel.rich} word={sel.text} />
      ) : (
        <>
          <div className="sel-pop-src">{sel.text}</div>
          <div className="sel-pop-sep" />
          <div className="sel-pop-res">{sel.plain}</div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: global.css 追加富卡片样式**

在 `@keyframes sel-pop-rot { … }` 块（L1083-1087）之后插入。只用该区域已验证存在的 CSS 变量（`--fg3/--note-fg/--sep-bg/--accent/--border`），亮暗主题自动生效：

```css
/* ---- 选区查词富卡片（spec 2026-08-29 §8.2，卡片 A 纵向层级）---- */
.sel-pop-err {
  color: #e06c75; /* 亮暗主题均可读的错误红，不依赖主题变量 */
}

.sel-pop-wordhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.sel-pop-term {
  font-size: 19px;
  font-weight: 700;
}

.sel-pop-phon {
  color: var(--fg3);
}

.sel-pop-pos {
  font-size: 11px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--accent);
}

.sel-pop-main {
  font-size: 15px;
  font-weight: 600;
  margin-top: 6px;
}

.sel-pop-usage {
  margin-top: 8px;
  color: var(--note-fg);
}

.sel-pop-block {
  margin-top: 10px;
}

.sel-pop-terms {
  border-top: 1px dashed var(--sep-bg);
  padding-top: 8px;
}

.sel-pop-label {
  font-size: 11px;
  color: var(--fg3);
  letter-spacing: 0.06em;
}

.sel-pop-example {
  margin-top: 5px;
}

.sel-pop-en em {
  font-style: normal;
  font-weight: 600;
  color: var(--accent);
}

.sel-pop-zh {
  color: var(--fg3);
}

.sel-pop-termrow {
  margin-top: 4px;
}

.sel-pop-termexp {
  color: var(--fg3);
}
```

- [ ] **Step 3: 验证**

Run: `npm run build`
Expected: tsc + vite 构建成功。

手工冒烟（`npx tauri dev`，配好 LLM 源后）：划英文单词出富卡片；划整句只出译文；清空 LLM baseUrl 后划词回到纯文本三行式；断网划词出红色错误文案。

- [ ] **Step 4: Commit**

```bash
git add src/components/SelectionPopup.tsx src/styles/global.css
git commit -m "feat(lookup): 选区查词富卡片渲染（卡片 A）— 词/句/plain/error 四态"
```

---

### Task 5: 设置增强 — lookup_model 字段 + 预设下拉 + 拉取模型

**Files:**
- Modify: `src-tauri/src/translate/providers_meta.rs`（L76-95 LLM_FIELDS、L103 note、L197 测试断言）
- Modify: `src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: Task 2 的 `api.llmListModels`（`llm_list_models` 命令）、Task 1 的字段 key 约定 `lookup_model`（凭据随 Creds HashMap 直通）
- Produces: 设置保存后 `providers.llm = { baseUrl, apiKey, model, lookup_model? }`；Task 1 的模型回落链直接消费 `lookup_model`

- [ ] **Step 1: providers_meta.rs 扩字段 + 改文案**

`LLM_FIELDS`（L76-95）替换为：

```rust
const LLM_FIELDS: &[FieldDef] = &[
    FieldDef {
        key: "baseUrl",
        label: "API 地址 (Base URL)",
        secret: false,
        placeholder: "https://api.deepseek.com 或 http://127.0.0.1:11434/v1",
    },
    FieldDef {
        key: "apiKey",
        label: "API Key",
        secret: true,
        placeholder: "本地服务（如 Ollama）可留空",
    },
    FieldDef {
        key: "model",
        label: "模型名",
        secret: false,
        placeholder: "如 deepseek-v4-flash、qwen2.5:7b",
    },
    FieldDef {
        key: "lookup_model",
        label: "查词模型（可选，留空同翻译模型）",
        secret: false,
        placeholder: "如 deepseek-v4-flash；划词查词走这个模型",
    },
];
```

`LLM` 的 `note`（L103）末尾追加一句：

```rust
    note: "任意 OpenAI 兼容接口：云端（DeepSeek / 通义 / 智谱等）填官方地址 + Key + 模型名；本机 Ollama 填 http://127.0.0.1:11434/v1 且 Key 留空。更换模型后建议清除翻译缓存。划词查词复用此凭据，可用「查词模型」单独指定轻量模型。",
```

测试 `providers_info_roundtrip`（L197）断言改 `assert_eq!(llm.fields.len(), 4);`。

- [ ] **Step 2: SettingsModal 预设下拉 + 拉取按钮 + datalist**

文件顶部 import 区追加 `useCallback` 到 react import，并加预设常量（`TEST_TEXT` 之后）：

```tsx
import { useCallback, useEffect, useState } from "react";
```

```tsx
/** LLM 厂商预设（spec §7；数据核验 2026-08-29）：选中即覆盖 baseUrl 字段；
 *  models 为未拉取时的静态 datalist 建议。 */
const LLM_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-flash", "qwen-plus", "qwen-max"] },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3-flash", "glm-4.7-flash", "glm-5.3"] },
  { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", models: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"] },
  { name: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] },
];
```

组件内 state 区（`recording` 之后）追加：

```tsx
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
```

`changeProvider`（L105-109）函数体末尾追加 `setLlmModels([]);`（换源清拉取结果）。

`testConn` 之后追加：

```tsx
  /** 拉取 OpenAI 兼容 /models 填充 datalist（spec §7：点选为主路径，手填兜底）。 */
  const fetchModels = useCallback(async () => {
    const baseUrl = (formCreds.baseUrl ?? "").trim();
    if (!baseUrl) {
      setTestResult("请先填写 API 地址 (Base URL)");
      return;
    }
    setFetching(true);
    try {
      const list = await api.llmListModels(baseUrl, formCreds.apiKey ?? "");
      setLlmModels(list);
      setTestResult(`已拉取 ${list.length} 个模型，点击模型名输入框从下拉选择。`);
    } catch (e) {
      setTestResult(`拉取失败：${errText(e)}（仍可手动填写模型名）`);
    } finally {
      setFetching(false);
    }
  }, [formCreds]);
```

渲染段：`{meta.fields.map((f) => (…))}`（L180-194）整体替换为：

```tsx
                {formProvider === "llm" && (
                  <div className="modal-row">
                    <label htmlFor="set-llm-preset">厂商预设</label>
                    <select
                      id="set-llm-preset"
                      value=""
                      onChange={(e) => {
                        const url = e.target.value;
                        if (url) setFormCreds((c) => ({ ...c, baseUrl: url }));
                      }}
                    >
                      <option value="">自定义（不动当前 Base URL）…</option>
                      {LLM_PRESETS.map((p) => (
                        <option key={p.baseUrl} value={p.baseUrl}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {meta.fields.map((f) => {
                  const isModelField = formProvider === "llm" && (f.key === "model" || f.key === "lookup_model");
                  const preset = LLM_PRESETS.find(
                    (p) => p.baseUrl.replace(/\/+$/, "") === (formCreds.baseUrl ?? "").trim().replace(/\/+$/, ""),
                  );
                  const suggestions = llmModels.length > 0 ? llmModels : (preset?.models ?? []);
                  return (
                    <div className="modal-row" key={f.key}>
                      <label htmlFor={`set-f-${f.key}`}>{f.label}</label>
                      <input
                        id={`set-f-${f.key}`}
                        type={f.secret ? "password" : "text"}
                        value={formCreds[f.key] ?? ""}
                        placeholder={f.placeholder}
                        title={f.placeholder}
                        autoComplete="off"
                        list={isModelField ? "llm-model-list" : undefined}
                        onChange={(e) => setFormCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                      />
                      {isModelField && (
                        <button type="button" className="modal-btn" disabled={fetching} onClick={fetchModels}>
                          {fetching ? "拉取中…" : "拉取模型"}
                        </button>
                      )}
                    </div>
                  );
                })}
                {formProvider === "llm" && (
                  <datalist id="llm-model-list">
                    {(() => {
                      const preset = LLM_PRESETS.find(
                        (p) => p.baseUrl.replace(/\/+$/, "") === (formCreds.baseUrl ?? "").trim().replace(/\/+$/, ""),
                      );
                      return (llmModels.length > 0 ? llmModels : (preset?.models ?? [])).map((m) => (
                        <option key={m} value={m} />
                      ));
                    })()}
                  </datalist>
                )}
```

（`meta.fields.length === 0` 的"无需密钥"分支保持不动；llm 恒有字段，不冲突。）

- [ ] **Step 3: 验证**

Run（workdir `src-tauri/`）: `cargo test --workspace`
Expected: 全仓 PASS（含 fields.len()==4 新断言）。

Run: `npm run build`
Expected: 构建成功。

手工冒烟（`npx tauri dev`）：设置 → 选"自定义大模型"→ 出现 4 字段 + 厂商预设；选 DeepSeek 预设 → baseUrl 填入 `https://api.deepseek.com`；填 key → 点"拉取模型"→ 下拉出现 deepseek 系模型并可点选；清空 baseUrl 点拉取 → 提示先填地址；乱填 baseUrl 拉取 → 失败信息且仍可手填。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/translate/providers_meta.rs src/components/SettingsModal.tsx
git commit -m "feat(lookup): 设置增强 — lookup_model 字段、厂商预设下拉、在线拉取模型点选"
```

---

### Task 6: 回归清单 + 全量验证

**Files:**
- Modify: `docs/regression-checklist.md`（文件末尾追加一节）

**Interfaces:**
- Consumes: 全部前序任务的最终行为
- Produces: 手工回归清单条目（spec §10）

- [ ] **Step 1: 追加回归条目**

在 `docs/regression-checklist.md` 末尾追加：

```markdown
## 选区查词（LLM 富卡片，2026-08-29 spec）

- [ ] 配置完整 LLM 源（baseUrl+model）：划英文单词 → 富卡片（原词/IPA/词性/译文/用法/例句/生僻词），例句中原词有着重
- [ ] 划中文词 → 英文翻译 + 英文侧音标（方向自动）
- [ ] 划整句/段落 → 浮窗只显示整句译文（无音标等块）
- [ ] 同一词第二次划词 → 秒回（缓存命中，无 loading 闪烁）
- [ ] 查词模型 lookup_model 填轻量模型 → 划词走轻量模型（响应明显更快）；留空 → 同翻译模型
- [ ] 断网/错误 key 划词 → 浮窗红色错误文案，不静默回落普通翻译
- [ ] 清空 LLM baseUrl → 划词回到纯文本三行式（全局源行为，与 0.1.x 一致）
- [ ] 连续快速划两个词 → 只有第二个词的结果回填（防乱序）
- [ ] Esc / 点击浮窗外 / 关闭开关 → 浮窗消失且重开后无旧结果残留
- [ ] 暗色主题下富卡片各块可读（词头/标签/例句/生僻词分隔线）
- [ ] 设置：厂商预设选 DeepSeek → baseUrl 自动填 https://api.deepseek.com
- [ ] 设置：填 key 点「拉取模型」→ datalist 出现厂商模型可点选；改 baseUrl 后需重新拉取
- [ ] 设置：拉取失败（错误地址）→ 显示失败原因且模型名仍可手填
- [ ] 清除翻译缓存后再划已查过的词 → 重新走网络（缓存被清）
```

- [ ] **Step 2: 全量验证**

Run（workdir `src-tauri/`）: `cargo test --workspace`
Expected: 全仓 PASS。

Run: `npm run build`
Expected: tsc + vite 构建成功。

- [ ] **Step 3: Commit**

```bash
git add docs/regression-checklist.md
git commit -m "docs: 选区查词手工回归清单（spec §10）"
```

---

## 完成定义

- `cargo test --workspace` 与 `npm run build` 全绿
- 手工冒烟覆盖 Task 4/5 的冒烟项 + 回归清单核心条目（word 卡片、sentence、回落、拉取）
- spec §2 Goals 逐条可指认到任务：G1→Task 4、G2→Task 1（prompt 规则）、G3→Task 1/2（缓存）、G4→Task 3（分流回落）、G5→Task 5、G6→Task 4、G7→Task 1/5（拉取）
