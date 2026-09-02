//! OpenAI-compatible chat client, streaming-first.
//!
//! Everything LLM-shaped in the app (document translation, selection lookup)
//! goes through [`chat_stream`]: one request builder, one SSE reader, one
//! place to tune latency. Streaming is used unconditionally because
//! time-to-first-token is the only thing users actually feel — a batch
//! finished 20% sooner but delivered all at once is still a 20 second wait.
//!
//! Pure over `&dyn HttpClient`, so every path is testable offline.

use std::io::BufRead;

use serde_json::Value;

use super::http::{HttpClient, StreamResp};
use super::sse::{Frame, SseParser, delta_content, frame_error};

/// A single chat completion request.
pub struct ChatRequest<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    pub temperature: f32,
    /// Hard ceiling on generated tokens. This is a latency control as much as
    /// a cost control: for a single word lookup we only need ~40 tokens, and
    /// letting the model write 300 instead is pure waiting.
    pub max_tokens: Option<u32>,
    /// Ask for a JSON object reply. Silently dropped and retried when the
    /// endpoint rejects it (Ollama and several gateways do).
    pub json_mode: bool,
    /// Ask the endpoint to skip chain-of-thought. Qwen3 / GLM style models
    /// think by default, and the thinking tokens land entirely before the
    /// first visible character — fatal for a word lookup. Sent as two
    /// vendor-specific fields (`enable_thinking: false` for Qwen/DashScope,
    /// `thinking: {"type":"disabled"}` for Zhipu/GLM); endpoints that reject
    /// unknown fields are remembered and the fields are never sent again.
    pub thinking_off: bool,
    pub timeout_ms: u64,
}

impl<'a> ChatRequest<'a> {
    pub fn url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim().trim_end_matches('/'))
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        let key = self.api_key.trim();
        if key.is_empty() {
            Vec::new() // local runtimes (Ollama, llama.cpp) need no auth
        } else {
            vec![("Authorization".to_string(), format!("Bearer {key}"))]
        }
    }

    pub fn body(&self, json_mode: bool, thinking_off: bool) -> String {
        let mut payload = serde_json::json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": self.system },
                { "role": "user", "content": self.user },
            ],
            "temperature": self.temperature,
            "stream": true,
        });
        if let Some(mt) = self.max_tokens {
            payload["max_tokens"] = serde_json::json!(mt);
        }
        if json_mode {
            payload["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        if thinking_off {
            // Both shapes live together: Qwen/DashScope reads
            // `enable_thinking`, Zhipu/GLM reads `thinking`. Lenient
            // gateways ignore the one they don't know; strict ones (OpenAI)
            // 400 both and are remembered, so the cost is one round trip ever.
            payload["enable_thinking"] = serde_json::json!(false);
            payload["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        payload.to_string()
    }
}

/// Run one streaming chat completion.
///
/// `on_delta` receives the *accumulated* content after each delta (not the
/// bare delta), matching what the front end needs to re-render progressively.
/// Returns the full content on success.
///
/// Errors are actionable: HTTP status, vendor message, or "empty reply".
pub fn chat_stream(
    req: &ChatRequest,
    http: &dyn HttpClient,
    on_delta: &mut dyn FnMut(&str),
) -> Result<String, String> {
    if req.base_url.trim().is_empty() {
        return Err("请先在「设置」中填写自定义大模型的 API 地址".to_string());
    }
    if req.model.trim().is_empty() {
        return Err("请先在「设置」中填写模型名".to_string());
    }

    let url = req.url();
    let headers_owned = req.headers();
    let headers: Vec<(&str, &str)> = headers_owned
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    // Optional features (`response_format`, thinking-off fields) are
    // negotiated per endpoint: a feature the endpoint 400-rejects is
    // remembered and never sent again, so the extra round trip is paid at
    // most once per feature — not on every word lookup.
    let use_json = req.json_mode && !json_mode_rejected(&req.base_url);
    let mut use_toff = req.thinking_off && !thinking_off_rejected(&req.base_url);
    let mut resp =
        stream_once(&url, &req.body(use_json, use_toff), &headers, req.timeout_ms, http)?;
    if resp.status >= 400 && use_toff {
        mark_thinking_off_rejected(&req.base_url);
        use_toff = false;
        resp = stream_once(&url, &req.body(use_json, use_toff), &headers, req.timeout_ms, http)?;
    }
    if resp.status >= 400 && use_json {
        mark_json_mode_rejected(&req.base_url);
        resp = stream_once(&url, &req.body(false, false), &headers, req.timeout_ms, http)?;
    }
    if resp.status >= 400 {
        return Err(read_error(resp));
    }
    consume(resp, on_delta)
}

/// Optional features observed to be rejected by an endpoint. Keys are
/// `"<feature>|<normalized base URL>"`. In-process only: forgetting on
/// restart costs one 400 per feature, once.
fn feature_registry() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn feature_rejected(feature: &str, base_url: &str) -> bool {
    let key = format!("{feature}|{}", normalize_base(base_url));
    feature_registry().lock().map(|set| set.contains(&key)).unwrap_or(false)
}

fn mark_feature_rejected(feature: &str, base_url: &str) {
    if let Ok(mut set) = feature_registry().lock() {
        set.insert(format!("{feature}|{}", normalize_base(base_url)));
    }
}

/// Whether this endpoint is already known to reject `response_format`.
pub fn json_mode_rejected(base_url: &str) -> bool {
    feature_rejected("json", base_url)
}

fn mark_json_mode_rejected(base_url: &str) {
    mark_feature_rejected("json", base_url);
}

/// Whether this endpoint is already known to reject the thinking-off fields.
pub fn thinking_off_rejected(base_url: &str) -> bool {
    feature_rejected("thinking", base_url)
}

fn mark_thinking_off_rejected(base_url: &str) {
    mark_feature_rejected("thinking", base_url);
}

fn stream_once(
    url: &str,
    body: &str,
    headers: &[(&str, &str)],
    timeout_ms: u64,
    http: &dyn HttpClient,
) -> Result<StreamResp, String> {
    http.post_json_stream(url, body, headers, timeout_ms)
}

/// Drain an SSE stream, accumulating content and notifying after each delta.
fn consume(mut resp: StreamResp, on_delta: &mut dyn FnMut(&str)) -> Result<String, String> {
    let mut parser = SseParser::new();
    let mut content = String::new();
    let mut line: Vec<u8> = Vec::new();

    loop {
        line.clear();
        let n = resp
            .reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("读取模型响应失败：{e}"))?;
        if n == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&line);
        let frames = parser.feed(&chunk);
        apply(&mut parser, frames, &mut content, on_delta)?;
    }
    let tail = parser.finish();
    apply(&mut parser, tail, &mut content, on_delta)?;

    if content.trim().is_empty() {
        return Err("模型返回内容为空".to_string());
    }
    Ok(content)
}

fn apply(
    _parser: &mut SseParser,
    frames: Vec<Frame>,
    content: &mut String,
    on_delta: &mut dyn FnMut(&str),
) -> Result<(), String> {
    for f in frames {
        match f {
            Frame::Done => {}
            Frame::Json(v) => {
                if let Some(e) = frame_error(&v) {
                    return Err(format!("模型返回错误：{e}"));
                }
                if let Some(d) = delta_content(&v) {
                    content.push_str(d);
                    on_delta(content);
                }
            }
        }
    }
    Ok(())
}

/// Render an HTTP error into an actionable message.
fn read_error(mut resp: StreamResp) -> String {
    let mut body = String::new();
    let _ = resp.reader.read_to_string(&mut body);
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message").or_else(|| e.get("msg")))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .map(|s| format!("：{s}"))
        .unwrap_or_default();
    format!("模型返回 {}{detail}", resp.status)
}

/// Strip a markdown code fence if the model wrapped its reply in one.
pub fn strip_fence(s: &str) -> String {
    let t = s.trim();
    if !t.starts_with("```") {
        return t.to_string();
    }
    let inner = t.strip_prefix("```").unwrap_or(t);
    let inner = inner.split_once('\n').map(|(_, rest)| rest).unwrap_or(inner);
    let inner = inner.strip_suffix("```").unwrap_or(inner);
    inner.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;

    fn req<'a>(base: &'a str, model: &'a str) -> ChatRequest<'a> {
        ChatRequest {
            base_url: base,
            api_key: "",
            model,
            system: "sys",
            user: "hello",
            temperature: 0.1,
            max_tokens: None,
            json_mode: false,
            thinking_off: false,
            timeout_ms: 30_000,
        }
    }

    #[test]
    fn builds_url_and_body() {
        let r = req("https://api.deepseek.com/v1/", "deepseek-chat");
        assert_eq!(r.url(), "https://api.deepseek.com/v1/chat/completions");
        let body = r.body(false, false);
        assert!(body.contains("\"model\":\"deepseek-chat\""));
        assert!(body.contains("\"stream\":true"));
        assert!(!body.contains("response_format"));
        assert!(!body.contains("enable_thinking"));
        let json_body = r.body(true, false);
        assert!(json_body.contains("\"response_format\""));
        let toff_body = r.body(false, true);
        assert!(toff_body.contains("\"enable_thinking\":false"));
        assert!(toff_body.contains("\"thinking\":{\"type\":\"disabled\"}"));
    }

    #[test]
    fn headers_omit_auth_for_local_runtimes() {
        assert!(req("http://127.0.0.1:11434/v1", "qwen").headers().is_empty());
        let mut r = req("https://x.io", "m");
        r.api_key = "sk-1";
        assert_eq!(r.headers(), vec![("Authorization".to_string(), "Bearer sk-1".to_string())]);
    }

    #[test]
    fn missing_credentials_are_actionable() {
        let http = MockClient::new();
        let mut noop = |_: &str| {};
        let e = chat_stream(&req("", "m"), &http, &mut noop).unwrap_err();
        assert!(e.contains("API 地址"), "{e}");
        let e = chat_stream(&req("https://x.io", ""), &http, &mut noop).unwrap_err();
        assert!(e.contains("模型名"), "{e}");
    }

    #[test]
    fn streams_deltas_cumulatively() {
        let http = MockClient::new();
        let mut seen: Vec<String> = Vec::new();
        let out = chat_stream(&req("https://x.io", "m"), &http, &mut |acc| {
            seen.push(acc.to_string())
        })
        .unwrap();
        assert_eq!(out, "你好，世界");
        assert_eq!(seen, vec!["你好，世界".to_string()]);
    }

    #[test]
    fn max_tokens_is_forwarded() {
        let http = MockClient::new();
        let mut r = req("https://x.io", "m");
        r.max_tokens = Some(96);
        let mut noop = |_: &str| {};
        chat_stream(&r, &http, &mut noop).unwrap();
        let rec = http.take_records().pop().unwrap();
        assert!(rec.body.contains("\"max_tokens\":96"), "{}", rec.body);
    }

    #[test]
    fn json_mode_rejection_is_remembered_per_endpoint() {
        let a = "https://gate-a.test/v1/";
        let b = "https://gate-b.test/v1";
        assert!(!json_mode_rejected(a));
        mark_json_mode_rejected(a);
        assert!(json_mode_rejected(a));
        assert!(json_mode_rejected("https://gate-a.test/v1"), "尾斜杠归一后仍命中");
        assert!(!json_mode_rejected(b), "别的端点不受影响");

        // 两个特性互相独立，各记各的键
        assert!(!thinking_off_rejected(a));
        mark_thinking_off_rejected(a);
        assert!(thinking_off_rejected(a));
        assert!(!thinking_off_rejected(b), "别的端点不受影响");
    }

    #[test]
    fn thinking_off_fields_are_negotiated_away_on_400() {
        fn sse(content: &str) -> String {
            let payload =
                serde_json::json!({ "choices": [ { "delta": { "content": content } } ] }).to_string();
            format!("data: {payload}\n\ndata: [DONE]\n\n")
        }
        let http = MockClient::new();
        // 网关拒绝 thinking-off 字段：第一次 400 后记忆，重试成功且不再携带
        http.script_stream_raw_status(400, "{}".to_string());
        http.script_stream(sse("你好"));
        let mut r = req("https://toff-strict.test/v1", "m");
        r.thinking_off = true;
        let mut noop = |_: &str| {};
        let out = chat_stream(&r, &http, &mut noop).unwrap();
        assert_eq!(out, "你好");
        let records = http.take_records();
        assert_eq!(records.len(), 2, "一次 400 + 一次成功重试");
        assert!(records[0].body.contains("enable_thinking"), "{}", records[0].body);
        assert!(!records[1].body.contains("enable_thinking"), "{}", records[1].body);
        // 第二次请求直接跳过被拒字段：单发即成功
        http.script_stream(sse("你好"));
        let out2 = chat_stream(&r, &http, &mut noop).unwrap();
        assert_eq!(out2, "你好");
        let rec2 = http.take_records().pop().unwrap();
        assert!(!rec2.body.contains("enable_thinking"), "{}", rec2.body);
        assert_eq!(http.take_records().len(), 0, "无隐藏重试");
    }

    #[test]
    fn strip_fence_handles_wrapped_and_plain() {
        assert_eq!(strip_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fence("  plain  "), "plain");
        assert_eq!(strip_fence("```\nx\n```"), "x");
    }
}
