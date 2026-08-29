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
    let auth_owned = if api_key.is_empty() {
        String::new()
    } else {
        format!("Bearer {api_key}")
    };
    if !api_key.is_empty() {
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
    let auth_owned = if key.is_empty() {
        String::new()
    } else {
        format!("Bearer {key}")
    };
    if !key.is_empty() {
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

    // ---- happy path（走 MockClient 的 lookup-mock.test 分支）----

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
