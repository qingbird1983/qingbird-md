//! LLM 选区查词：两阶段并发。
//!
//! 单请求出完整 JSON 的旧实现慢在**输出量**：划一个单词也要生成
//! translation + phonetic + partOfSpeech + usage + 2 例句 + terms，
//! 200+ token 之后用户才看到第一个字，而卡片上真正被先读的只有译文。
//!
//! 现在拆成两个**同时发出**的请求：
//!
//! * 阶段一（快）：极短 prompt、短字段名、`max_tokens: 96`，只回
//!   `{"t":译文,"p":音标,"pos":词性}`。输出约 30 token，TTFT 后不到 1 秒到手，
//!   边生成边经 `on_stage1` 推给前端。
//! * 阶段二（全）：用法、例句、生僻词等富信息。慢一点无所谓——用户已经在看
//!   译文了；即便它失败，阶段一的结果依然完整可用。
//!
//! 并发而非串行：总墙钟时间取两者较慢者，而不是两者之和。

use serde_json::Value;

use super::cache::{Cache, CacheBackend};
use super::http::HttpClient;
use super::openai::{ChatRequest, chat_stream, strip_fence};
use super::providers::Creds;

/// 查词结果在翻译缓存中的 provider 名（与整篇翻译键空间隔离）。
pub const CACHE_PROVIDER: &str = "llm-lookup";

/// 缓存 variant 版本：改 prompt 或解析规则时 +1，旧缓存自动失效。
pub const CACHE_VARIANT: &str = "v2";

const STAGE1_TIMEOUT_MS: u64 = 15_000;
const STAGE2_TIMEOUT_MS: u64 = 30_000;
const MODELS_TIMEOUT_MS: u64 = 15_000;

/// 阶段一：只问用户第一眼要看的东西。字段名缩短为了省输出 token —— 输出
/// token 数直接等于等待时间。
const STAGE1_SYSTEM: &str = "中英互译。只输出一个 JSON 对象，不要任何多余文字、不要代码块：\
{\"t\":\"译文\",\"p\":\"英文侧单词的 IPA 音标，无则 null\",\"pos\":\"词性如 n./v./adj.，无则 null\"}\
中译英时 p 为 null。";

/// 阶段二：富信息。仍在 JSON 的最前面带上 translation 作为阶段一失败时的
/// 兜底——它不阻塞任何东西，因为阶段一已在独立连接上先返回。
const STAGE2_SYSTEM: &str = "中英翻译助手。输入是一个词/短语，或一句话/一段话。\n\
只输出一个 JSON 对象，不要代码块，不要多余文字：\n\
{\"translation\":\"译文\",\"type\":\"word\"|\"sentence\",\"usage\":\"用法说明或null\",\
\"examples\":[{\"en\":\"英文例句\",\"zh\":\"中文翻译\"}],\
\"terms\":[{\"word\":\"英文词\",\"phonetic\":\"IPA音标\",\"explanation\":\"中文解释\"}]}\n\
规则：\n\
1. type：输入是词/短语填 word，是句子/段落填 sentence。\n\
2. word：usage 用一句中文讲最典型的搭配或语境，务必精简；examples 至多 2 个自然例句；terms 为 []。\n\
3. sentence：usage 为 null，examples 为 []；terms 从英文侧挑较生僻的词（常见词不挑），每个给 word、IPA 音标、简洁中文解释，没有则 []。";

/// 阶段一结果（阶段二尚未到达时的最小可展示卡片）。
#[derive(Debug, Clone, PartialEq)]
pub struct Stage1 {
    pub translation: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Option<String>,
}

/// 选区查词主入口。
///
/// `on_stage1` 在阶段一每次收到 delta 时被调用，参数是**累积**内容（与前端
/// `lookup-delta` 契约一致），因此阶段一刚生成一半也能先渲染出来。
///
/// 两个阶段任一成功即有结果：阶段一提供译文，阶段二补充富信息。
pub fn lookup(
    text: &str,
    creds: &Creds,
    http: &(dyn HttpClient + Sync),
    on_stage1: &mut (dyn FnMut(&str) + Send),
) -> Result<crate::dto::WordLookupDTO, String> {
    let base = creds
        .get("baseUrl")
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_default();
    if base.is_empty() {
        return Err("请先在「设置」中填写自定义大模型的 API 地址".to_string());
    }
    let model = resolve_model(creds);
    if model.is_empty() {
        return Err("请先在「设置」中填写模型名".to_string());
    }
    let api_key = creds.get("apiKey").unwrap_or_default().to_string();

    let s1 = ChatRequest {
        base_url: &base,
        api_key: &api_key,
        model: &model,
        system: STAGE1_SYSTEM,
        user: text,
        temperature: 0.0,
        max_tokens: Some(96),
        json_mode: true,
        thinking_off: true,
        timeout_ms: STAGE1_TIMEOUT_MS,
    };
    let s2 = ChatRequest {
        base_url: &base,
        api_key: &api_key,
        model: &model,
        system: STAGE2_SYSTEM,
        user: text,
        temperature: 0.2,
        max_tokens: Some(512),
        json_mode: true,
        thinking_off: true,
        timeout_ms: STAGE2_TIMEOUT_MS,
    };

    // 两阶段并发：慢的富信息请求不拖快译，快的也不必等富信息。
    let (r1, r2) = std::thread::scope(|s| {
        let t1 = s.spawn(|| chat_stream(&s1, http, &mut |acc: &str| on_stage1(acc)));
        let t2 = s.spawn(|| {
            let mut noop = |_: &str| {};
            chat_stream(&s2, http, &mut noop)
        });
        (
            t1.join().map_err(|_| "查词线程崩溃".to_string()).and_then(|r| r),
            t2.join().map_err(|_| "查词线程崩溃".to_string()).and_then(|r| r),
        )
    });

    let stage1 = r1.as_ref().ok().and_then(|c| parse_stage1(c));
    let stage2 = r2.as_ref().ok().and_then(|c| parse_stage2(c));

    match merge(stage1, stage2, &text) {
        Some(dto) if !dto.translation.trim().is_empty() => Ok(dto),
        _ => Err(first_error(&r1, &r2)),
    }
}

/// Both requests failed: surface whichever error is actionable. Stage one
/// fails first (shorter budget), so it usually carries the real cause.
fn first_error(r1: &Result<String, String>, r2: &Result<String, String>) -> String {
    match (r1, r2) {
        (Err(e), _) => e.clone(),
        (_, Err(e)) => e.clone(),
        _ => "查词结果为空".to_string(),
    }
}

/// 模型选择：`lookup_model` 优先，留空则回落主模型。划词对延迟极敏感，
/// 推荐在设置里单独指定一个轻量模型。
fn resolve_model(creds: &Creds) -> String {
    let lookup_model = creds.get("lookup_model").map(|s| s.trim()).unwrap_or_default();
    if !lookup_model.is_empty() {
        return lookup_model.to_string();
    }
    creds.get("model").map(|s| s.trim()).unwrap_or_default().to_string()
}

/// 合并两阶段结果：译文以阶段一为准（它先到且更精简），富信息来自阶段二。
///
/// 阶段二失败**不影响**可用性：富信息请求更慢、输出更长，是最容易超时的一环。
/// 此时用阶段一拼一张只有译文/音标/词性的最小卡片——用户要的是释义，不是空卡片。
fn merge(
    stage1: Option<Stage1>,
    stage2: Option<crate::dto::WordLookupDTO>,
    text: &str,
) -> Option<crate::dto::WordLookupDTO> {
    let mut out = match stage2 {
        Some(d) => d,
        None => {
            let s1 = stage1.clone()?;
            crate::dto::WordLookupDTO {
                kind: kind_for(text).to_string(),
                translation: s1.translation,
                phonetic: s1.phonetic,
                part_of_speech: s1.part_of_speech,
                usage: None,
                examples: Vec::new(),
                terms: Vec::new(),
            }
        }
    };
    if let Some(s1) = stage1 {
        // 阶段一是权威译文：它先到、更短、更不容易跑偏。
        // 解构避免部分移动后再读字段。
        let Stage1 { translation, phonetic, part_of_speech } = s1;
        out.translation = translation;
        if phonetic.is_some() {
            out.phonetic = phonetic;
        }
        if part_of_speech.is_some() {
            out.part_of_speech = part_of_speech;
        }
    }
    Some(out)
}

/// 阶段二缺席时的兜底判定：多词、较长文本或超长单词按句子展示，否则按词。
fn kind_for(text: &str) -> &'static str {
    let words = text.split_whitespace().count();
    let chars = text.chars().count();
    if words >= 3 || chars > 24 || (words == 1 && chars > 12) {
        "sentence"
    } else {
        "word"
    }
}

/// 解析阶段一的短字段 JSON。容错：剥围栏 → 截取首尾花括号 → 缺字段降级。
pub fn parse_stage1(content: &str) -> Option<Stage1> {
    let v = parse_json_object(content)?;
    let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("").trim();
    if t.is_empty() {
        return None;
    }
    Some(Stage1 {
        translation: t.to_string(),
        phonetic: opt_str(&v, "p"),
        part_of_speech: opt_str(&v, "pos"),
    })
}

/// 解析阶段二的完整 DTO。与旧实现同构（键映射、空值规整、坏项过滤）。
pub fn parse_stage2(content: &str) -> Option<crate::dto::WordLookupDTO> {
    use crate::dto::{LookupExample, LookupTerm, WordLookupDTO};

    let v = parse_json_object(content)?;
    let kind = match v.get("type").and_then(|x| x.as_str()) {
        Some("sentence") => "sentence",
        _ => "word",
    };
    let empty: Vec<Value> = Vec::new();
    let examples = v
        .get("examples")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty)
        .iter()
        .filter_map(|it| {
            let en = it.get("en").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let zh = it.get("zh").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if en.is_empty() && zh.is_empty() {
                None
            } else {
                Some(LookupExample { en, zh })
            }
        })
        .collect();
    let terms = v
        .get("terms")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty)
        .iter()
        .filter_map(|it| {
            let word = it.get("word").and_then(|x| x.as_str())?.trim().to_string();
            if word.is_empty() {
                return None;
            }
            Some(LookupTerm {
                word,
                phonetic: it.get("phonetic").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                explanation: it
                    .get("explanation")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            })
        })
        .collect();

    Some(WordLookupDTO {
        kind: kind.to_string(),
        translation: v.get("translation").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
        phonetic: opt_str(&v, "phonetic"),
        part_of_speech: opt_str(&v, "partOfSpeech"),
        usage: opt_str(&v, "usage"),
        examples,
        terms,
    })
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "null")
}

/// 从可能带围栏、前后有废话的回复里抠出一个 JSON 对象。
fn parse_json_object(content: &str) -> Option<Value> {
    let t = strip_fence(content);
    let t = t.trim();
    let start = t.find('{')?;
    let end = t.rfind('}').map(|i| i + 1)?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&t[start..end]).ok()
}

/// 命中读取；缓存里的坏 JSON 自愈为未命中（下次网络结果会覆写）。
pub fn cache_get_lookup(cache: &dyn CacheBackend, text: &str, variant: &str) -> Option<crate::dto::WordLookupDTO> {
    let json = cache.get(&Cache::key(CACHE_PROVIDER, variant, text))?;
    serde_json::from_str(json).ok()
}

/// 回写（不落盘——落盘由命令层在短锁内完成）。
pub fn cache_put_lookup(
    cache: &mut dyn CacheBackend,
    text: &str,
    variant: &str,
    dto: &crate::dto::WordLookupDTO,
) {
    let json = serde_json::to_string(dto).unwrap_or_default();
    cache.set(Cache::key(CACHE_PROVIDER, variant, text), json);
}

/// 查词缓存 variant：模型名 + 版本号。
pub fn cache_variant(model: &str) -> String {
    format!("{model}@{CACHE_VARIANT}")
}

/// 从凭据直接算出缓存 variant（命令层用它做命中检查与回写，必须与
/// [`lookup`] 实际使用的模型一致，否则缓存永不命中）。
pub fn cache_variant_for(creds: &Creds) -> String {
    cache_variant(&resolve_model(creds))
}

/// 拉取 OpenAI 兼容 GET {base}/models：Bearer（key 非空时）、15s 超时、
/// 解析 data[].id 去重排序。
pub fn fetch_models(base_url: &str, api_key: &str, http: &dyn HttpClient) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 API 地址 (Base URL)".to_string());
    }
    super::http::validate_base_url_scheme(base)?;
    let url = format!("{base}/models");
    let mut headers: Vec<(&str, &str)> = Vec::new();
    let key = api_key.trim();
    let auth = format!("Bearer {key}");
    if !key.is_empty() {
        headers.push(("Authorization", auth.as_str()));
    }
    let r = http.get_headers_timeout(&url, &headers, MODELS_TIMEOUT_MS)?;
    if r.status >= 400 {
        let mut detail = String::new();
        if let Ok(v) = serde_json::from_str::<Value>(&r.body) {
            if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|x| x.as_str()) {
                detail = format!("：{msg}");
            }
        }
        return Err(format!("拉取模型列表返回 {}{detail}", r.status));
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

    fn creds(pairs: &[(&str, &str)]) -> Creds {
        let m = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Creds(m)
    }

    const S1_JSON: &str = r#"{"t":"便利设施","p":"/əˈmenəti/","pos":"n."}"#;
    const S2_JSON: &str = r#"{"translation":"便利设施","type":"word","usage":"指提升舒适度的设施。","examples":[{"en":"The hotel has amenities.","zh":"酒店有设施。"}],"terms":[{"word":"lavish","phonetic":"/ˈlævɪʃ/","explanation":"奢华的"}]}"#;

    fn sse(content: &str) -> String {
        let payload =
            serde_json::json!({ "choices": [ { "delta": { "content": content } } ] }).to_string();
        format!("data: {payload}\n\ndata: [DONE]\n\n")
    }

    // ---- 阶段一解析 ----

    #[test]
    fn stage1_parses_short_fields() {
        let s = parse_stage1(S1_JSON).unwrap();
        assert_eq!(s.translation, "便利设施");
        assert_eq!(s.phonetic.as_deref(), Some("/əˈmenəti/"));
        assert_eq!(s.part_of_speech.as_deref(), Some("n."));
    }

    #[test]
    fn stage1_tolerates_fence_and_prose() {
        let s = parse_stage1(&format!("```json\n{S1_JSON}\n```")).unwrap();
        assert_eq!(s.translation, "便利设施");
        let s = parse_stage1(&format!("好的：{S1_JSON} 以上")).unwrap();
        assert_eq!(s.translation, "便利设施");
    }

    #[test]
    fn stage1_rejects_missing_translation() {
        assert!(parse_stage1(r#"{"p":"/a/","pos":"n."}"#).is_none());
        assert!(parse_stage1("不是 JSON").is_none());
    }

    #[test]
    fn stage1_treats_string_null_as_none() {
        let s = parse_stage1(r#"{"t":"你好","p":"null","pos":"null"}"#).unwrap();
        assert_eq!(s.phonetic, None);
        assert_eq!(s.part_of_speech, None);
    }

    // ---- 阶段二解析 ----

    #[test]
    fn stage2_maps_fields_and_filters_blank_items() {
        let d = parse_stage2(S2_JSON).unwrap();
        assert_eq!(d.kind, "word");
        assert_eq!(d.translation, "便利设施");
        assert_eq!(d.usage.as_deref(), Some("指提升舒适度的设施。"));
        assert_eq!(d.examples.len(), 1);
        assert_eq!(d.terms.len(), 1);
        assert_eq!(d.terms[0].word, "lavish");
    }

    #[test]
    fn stage2_sentence_has_no_word_fields() {
        let d = parse_stage2(
            r#"{"translation":"你好。","type":"sentence","usage":null,"examples":[],"terms":[]}"#,
        )
        .unwrap();
        assert_eq!(d.kind, "sentence");
        assert_eq!(d.phonetic, None);
        assert!(d.examples.is_empty() && d.terms.is_empty());
    }

    #[test]
    fn stage2_drops_blank_term_words() {
        let d = parse_stage2(
            r#"{"translation":"x","type":"word","usage":null,"examples":[],"terms":[{"word":" ","phonetic":"","explanation":"应被过滤"},{"word":"ok","phonetic":"/ok/","explanation":"保留"}]}"#,
        )
        .unwrap();
        assert_eq!(d.terms.len(), 1);
        assert_eq!(d.terms[0].word, "ok");
    }

    // ---- 合并 ----

    #[test]
    fn merge_prefers_stage1_translation_and_keeps_stage2_richness() {
        let s1 = parse_stage1(r#"{"t":"A1","p":"/p1/","pos":"v."}"#);
        let s2 = parse_stage2(S2_JSON);
        let d = merge(s1, s2, "amenity").unwrap();
        assert_eq!(d.translation, "A1", "阶段一的译文优先");
        assert_eq!(d.phonetic.as_deref(), Some("/p1/"));
        assert_eq!(d.part_of_speech.as_deref(), Some("v."));
        assert_eq!(d.examples.len(), 1, "阶段二的富信息保留");
        assert_eq!(d.terms.len(), 1);
    }

    #[test]
    fn merge_without_stage1_falls_back_to_stage2() {
        let d = merge(None, parse_stage2(S2_JSON), "amenity").unwrap();
        assert_eq!(d.translation, "便利设施");
    }

    #[test]
    fn merge_without_stage2_still_yields_a_usable_card() {
        // 富信息请求最容易超时；它失败时用户仍应看到释义，而不是「查词失败」。
        let d = merge(parse_stage1(S1_JSON), None, "amenity").unwrap();
        assert_eq!(d.translation, "便利设施");
        assert_eq!(d.phonetic.as_deref(), Some("/əˈmenəti/"));
        assert_eq!(d.kind, "word");
        assert!(d.examples.is_empty() && d.terms.is_empty() && d.usage.is_none());
    }

    #[test]
    fn stage2_only_failure_kind_falls_back_to_text_heuristic() {
        assert_eq!(kind_for("amenity"), "word");
        assert_eq!(kind_for("a big red apple"), "sentence");
        assert_eq!(kind_for("uncharacteristically"), "sentence", "长词按句子展示");
    }

    #[test]
    fn both_stages_failing_reports_an_actionable_error() {
        let http = MockClient::new();
        // 空流 → openai 层报「模型返回内容为空」
        http.script_stream(String::new());
        http.script_stream(String::new());
        let c = creds(&[("baseUrl", "https://x.io/v1"), ("model", "m")]);
        let mut noop = |_: &str| {};
        let e = lookup("amenity", &c, &http, &mut noop).unwrap_err();
        assert!(!e.is_empty(), "失败必须给出可读原因，而不是空字符串");
    }

    // ---- 端到端（mock）----

    /// 同时含阶段一短字段与阶段二全字段：并发线程按 FIFO 抢流，顺序不定，
    /// 任一线程拿到任一条都必须可解析。
    const BOTH_JSON: &str = r#"{"t":"便利设施","p":"/əˈmenəti/","pos":"n.","translation":"便利设施","type":"word","usage":"指提升舒适度的设施。","examples":[{"en":"The hotel has amenities.","zh":"酒店有设施。"}],"terms":[{"word":"lavish","phonetic":"/ˈlævɪʃ/","explanation":"奢华的"}]}"#;

    #[test]
    fn lookup_runs_both_stages_concurrently() {
        let http = MockClient::new();
        http.script_stream(sse(BOTH_JSON));
        http.script_stream(sse(BOTH_JSON));
        let c = creds(&[("baseUrl", "https://x.io/v1"), ("model", "m")]);
        let mut deltas: Vec<String> = Vec::new();
        let dto = lookup("amenity", &c, &http, &mut |acc| deltas.push(acc.to_string()));
        // 两条流任序均可得到完整卡片
        assert!(dto.is_ok(), "{dto:?}");
        let d = dto.unwrap();
        assert_eq!(d.translation, "便利设施");
        assert_eq!(http.take_records().len(), 2, "两个并发请求");
    }

    #[test]
    fn lookup_streams_stage1_progressively() {
        let http = MockClient::new();
        // 阶段一先返回（脚本按 FIFO 弹出，但两条并发请求顺序不定，故都用
        // 同一份可解析内容；这里只断言 delta 至少被回调一次）
        http.script_stream(sse(BOTH_JSON));
        http.script_stream(sse(BOTH_JSON));
        let c = creds(&[("baseUrl", "https://x.io/v1"), ("model", "m")]);
        let mut deltas: Vec<String> = Vec::new();
        let _ = lookup("amenity", &c, &http, &mut |acc| deltas.push(acc.to_string()));
        assert!(!deltas.is_empty(), "阶段一应产生流式回调");
        assert!(deltas.iter().any(|d| d.contains("便利设施")));
    }

    // ---- REL-7 回归：查词流式中途取消 ----

    #[test]
    fn lookup_cancelled_midstream_fails_fast() {
        // 查词与整篇翻译共用 consume 读循环：流中途置位取消旗标后必须在
        // 行边界中止并报「已取消」，而不是把两条流读完、照常拼出完整卡片。
        use crate::translate::cancel::CancelableClient;
        use crate::translate::http::test_mock::MidStreamCancelMock;
        let mock = MidStreamCancelMock::new();
        let flag = std::sync::Arc::clone(&mock.cancel);
        let http = CancelableClient { inner: &mock, cancel: &flag };
        let c = creds(&[("baseUrl", "https://x.io/v1"), ("model", "m")]);
        let mut noop = |_: &str| {};
        let e = lookup("amenity", &c, &http, &mut noop)
            .expect_err("查词流中途取消仍把流读完");
        assert!(e.contains("已取消"), "{e}");
    }

    #[test]
    fn missing_credentials_are_actionable() {
        let http = MockClient::new();
        let mut noop = |_: &str| {};
        let e = lookup("hi", &creds(&[("model", "m")]), &http, &mut noop).unwrap_err();
        assert!(e.contains("API 地址"), "{e}");
        let e = lookup("hi", &creds(&[("baseUrl", "https://x.io")]), &http, &mut noop).unwrap_err();
        assert!(e.contains("模型名"), "{e}");
    }

    #[test]
    fn lookup_model_takes_priority() {
        assert_eq!(resolve_model(&creds(&[("model", "main"), ("lookup_model", "fast")])), "fast");
        assert_eq!(resolve_model(&creds(&[("model", "main"), ("lookup_model", "")])), "main");
        assert_eq!(resolve_model(&creds(&[("model", " main ")])), "main");
    }

    // ---- 缓存 ----

    #[test]
    fn cache_roundtrip_is_versioned_and_self_heals() {
        let mut c = Cache::new();
        let v = cache_variant("m");
        assert_eq!(v, "m@v2");
        assert!(cache_get_lookup(&c, "w", &v).is_none());
        let dto = parse_stage2(S2_JSON).unwrap();
        cache_put_lookup(&mut c, "w", &v, &dto);
        assert_eq!(cache_get_lookup(&c, "w", &v).unwrap().translation, "便利设施");
        assert!(
            cache_get_lookup(&c, "w", &cache_variant("other-model")).is_none(),
            "换模型必须 miss"
        );
        c.set(Cache::key(CACHE_PROVIDER, &v, "bad"), "not-json".into());
        assert!(cache_get_lookup(&c, "bad", &v).is_none(), "坏 JSON 自愈为未命中");
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
        assert!(fetch_models("", "sk-1", &http).unwrap_err().contains("Base URL"));
    }

    #[test]
    fn fetch_models_rejects_remote_http() {
        // SEC-4：拉模型列表同样带 Bearer key，非本机 http:// 必须拒绝。
        let http = MockClient::new();
        let e = fetch_models("http://attacker.test/v1", "sk-1", &http).unwrap_err();
        assert!(e.contains("https"), "{e}");
    }

    #[test]
    fn parse_models_body_rejects_missing_data() {
        assert!(parse_models_body(r#"{"object":"list"}"#).is_err());
        assert!(parse_models_body("not json").is_err());
    }

    #[test]
    fn word_lookup_dto_serializes_snake_case_for_ipc() {
        let dto = parse_stage2(S2_JSON).unwrap();
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"part_of_speech\""), "线格式 snake_case: {json}");
        assert!(!json.contains("partOfSpeech"), "禁止 camelCase 泄入线格式: {json}");
    }
}
