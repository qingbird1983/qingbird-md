//! Minimal HTTP abstraction so providers can be tested offline with a mock.
//! The real client wraps a pooled `ureq::Agent`.
//!
//! Pooling matters more than it looks: the previous code called the top-level
//! `ureq::post()` helpers, which build a throwaway agent per call — meaning a
//! fresh DNS lookup, TCP handshake and TLS handshake (100–400 ms) on *every*
//! request, including every selection lookup.

use std::io::{BufRead, BufReader, Cursor};
use std::time::Duration;

/// A finished HTTP response: status code + response body text.
#[derive(Debug, Clone)]
pub struct HttpResp {
    pub status: u16,
    pub body: String,
}

/// 流式 POST 响应：状态码 + 可逐行读的响应体（SSE 用）。错误状态码时
/// reader 内是错误体文本，由调用方 read_to_string 后报错。
pub struct StreamResp {
    pub status: u16,
    pub reader: Box<dyn BufRead + Send>,
}

/// Small HTTP surface used by providers. Tests provide a `MockClient`.
/// `Send + Sync`: clients are shared across plain background threads
/// (the cancelable wrapper and the stop flag rely on this).
pub trait HttpClient: Send + Sync {
    fn get(&self, url: &str) -> Result<HttpResp, String>;
    fn post_form(&self, url: &str, params: &[(String, String)]) -> Result<HttpResp, String>;
    fn post_json(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResp, String>;

    /// Like [`Self::post_json`] but with a per-request overall timeout. The
    /// default implementation ignores the timeout (used by mocks).
    fn post_json_timeout(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let _ = timeout_ms;
        self.post_json(url, body, headers)
    }

    /// GET with per-request headers + timeout. Default falls back to
    /// [`Self::get`] ignoring both — mirrors post_json_timeout. 默认实现供
    /// mock 回落；UreqClient/MockClient 均已覆写。
    #[allow(dead_code)]
    fn get_headers_timeout(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let _ = (headers, timeout_ms);
        self.get(url)
    }

    /// POST JSON 并返回可流式读取的响应体（SSE 渐进渲染用）。
    fn post_json_stream(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<StreamResp, String>;
}

/// Pooled client. Cloning is cheap (the pool and TLS config are behind an
/// `Arc`), so one instance can serve every background worker.
#[derive(Clone)]
pub struct UreqClient {
    agent: ureq::Agent,
}

impl UreqClient {
    pub fn new() -> Self {
        let agent = ureq::AgentBuilder::new()
            // Fail fast on an unreachable host instead of hanging a worker.
            .timeout_connect(Duration::from_secs(5))
            // Per-read timeout: LLM streams pause while decoding, so this must
            // be generous, but it still catches a silently dropped connection.
            .timeout_read(Duration::from_secs(30))
            .max_idle_connections(16)
            .max_idle_connections_per_host(8)
            .build();
        UreqClient { agent }
    }

    /// Process-wide shared client. The whole point of a pooled agent is that
    /// idle connections survive between requests — a fresh `UreqClient` per
    /// call drops them, so every lookup pays DNS + TCP + TLS again
    /// (100–400 ms, which for a selection lookup is half the budget).
    /// Cloning is cheap but *keeping one alive* is what actually reuses
    /// connections, so all call sites must go through this.
    pub fn shared() -> &'static UreqClient {
        static SHARED: std::sync::OnceLock<UreqClient> = std::sync::OnceLock::new();
        SHARED.get_or_init(UreqClient::new)
    }
}

impl Default for UreqClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Streaming responses must not be compressed: a gzip decoder buffers, which
/// turns incremental SSE deltas into one lump delivered at the end — silently
/// defeating the entire point of streaming. `ureq` enables gzip by default and
/// advertises it, so we have to opt out explicitly.
const IDENTITY_ENCODING: (&str, &str) = ("Accept-Encoding", "identity");

impl HttpClient for UreqClient {
    fn get(&self, url: &str) -> Result<HttpResp, String> {
        map(self.agent.get(url).call())
    }

    fn post_form(&self, url: &str, params: &[(String, String)]) -> Result<HttpResp, String> {
        let body = form_encode(params);
        map(
            self.agent
                .post(url)
                .set("Content-Type", "application/x-www-form-urlencoded")
                .send_string(&body),
        )
    }

    fn post_json(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResp, String> {
        self.post_json_timeout(url, body, headers, 30_000)
    }

    fn post_json_timeout(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let mut req = self
            .agent
            .post(url)
            .set("Content-Type", "application/json")
            .timeout(Duration::from_millis(timeout_ms));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        map(req.send_string(body))
    }

    fn get_headers_timeout(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        let mut req = self.agent.get(url).timeout(Duration::from_millis(timeout_ms));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        map(req.call())
    }

    fn post_json_stream(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<StreamResp, String> {
        let mut req = self
            .agent
            .post(url)
            .set("Content-Type", "application/json")
            .set(IDENTITY_ENCODING.0, IDENTITY_ENCODING.1)
            .timeout(Duration::from_millis(timeout_ms));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        match req.send_string(body) {
            Ok(r) => {
                let status = r.status();
                Ok(StreamResp { status, reader: Box::new(BufReader::new(r.into_reader())) })
            }
            Err(ureq::Error::Status(code, r)) => {
                // 错误响应体整体读入后以 Cursor 兜底，调用方按 status 报错
                let text = r.into_string().unwrap_or_default();
                Ok(StreamResp { status: code, reader: Box::new(Cursor::new(text.into_bytes())) })
            }
            Err(e) => Err(e.to_string()),
        }
    }
}

fn map(res: Result<ureq::Response, ureq::Error>) -> Result<HttpResp, String> {
    match res {
        Ok(r) => {
            let status = r.status();
            let body = r.into_string().map_err(|e| e.to_string())?;
            Ok(HttpResp { status, body })
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Ok(HttpResp { status: code, body })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// application/x-www-form-urlencoded encoding (matches URLSearchParams).
fn form_encode(params: &[(String, String)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&form_escape(k));
        out.push('=');
        out.push_str(&form_escape(v));
    }
    out
}

fn form_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Offline mock used by provider tests. Captures requests and returns canned
/// responses by URL substring, mirroring the Electron `test/translators.test.js`.
/// Each `MockClient` owns its own record store so tests don't interfere.
#[cfg(test)]
pub(crate) mod test_mock {
    use super::{Cursor, HttpClient, HttpResp};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    pub struct Record {
        pub url: String,
        pub body: String,
        pub headers: Vec<(String, String)>,
    }

    pub struct MockClient {
        store: Arc<Mutex<Vec<Record>>>,
        /// Pre-baked raw stream bodies, returned one per `post_json_stream`
        /// call (FIFO). Lets tests script multi-chunk SSE and gap retries.
        streams: Arc<Mutex<VecDeque<String>>>,
    }

    impl MockClient {
        pub fn new() -> Self {
            MockClient {
                store: Arc::new(Mutex::new(Vec::new())),
                streams: Arc::new(Mutex::new(VecDeque::new())),
            }
        }

        pub fn take_records(&self) -> Vec<Record> {
            std::mem::take(&mut *self.store.lock().unwrap())
        }

        /// Queue a raw streaming response body (already in wire format).
        pub fn script_stream(&self, raw: String) {
            self.streams.lock().unwrap().push_back(raw);
        }

        fn next_stream(&self) -> Option<String> {
            self.streams.lock().unwrap().pop_front()
        }
    }

    impl Default for MockClient {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockClient {
        fn record(&self, url: &str, body: &str, headers: &[(&str, &str)]) {
            let h = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            self.store.lock().unwrap().push(Record {
                url: url.to_string(),
                body: body.to_string(),
                headers: h,
            });
        }
    }

    pub fn resp_for(url: &str) -> HttpResp {
        let body = if url.contains("youdao") {
            r#"{"errorCode":"0","translation":["你好，世界"]}"#
        } else if url.contains("baidu") {
            r#"{"trans_result":[{"src":"hello","dst":"你好"}]}"#
        } else if url.contains("tmt.tencentcloudapi.com") {
            r#"{"Response":{"TargetText":"你好，世界"}}"#
        } else if url.contains("/models") {
            // llm_list_models：两模型 + 一重复项 + 一空 id（测试去重/排序/过滤）
            r#"{"object":"list","data":[{"id":"m-b"},{"id":"m-a"},{"id":"m-b"},{"id":""}]}"#
        } else if url.contains("lookup-mock.test") {
            // 选区查词 happy path：content 本身是合法查词 JSON（JSON-in-JSON 转义）
            r#"{"choices":[{"message":{"content":"{\"type\":\"word\",\"translation\":\"便利设施\",\"phonetic\":\"/əˈmenəti/\",\"partOfSpeech\":\"n.\",\"usage\":\"指提升舒适度的设施。\",\"examples\":[],\"terms\":[]}"}}]}"#
        } else if url.contains("chat/completions") {
            r#"{"choices":[{"message":{"content":"你好，世界"}}]}"#
        } else if url.contains("transmart") {
            r#"{"auto_translation":"你好，世界"}"#
        } else if url.contains("dictionary.iciba.com") {
            r#"{"code":1,"data":[{"out":"你好"}]}"#
        } else {
            r#"{"responseData":{"translatedText":"你好"},"responseStatus":200}"#
        };
        HttpResp { status: 200, body: body.to_string() }
    }

    impl HttpClient for MockClient {
        fn get(&self, url: &str) -> Result<HttpResp, String> {
            self.record(url, "", &[]);
            Ok(resp_for(url))
        }
        fn post_form(&self, url: &str, params: &[(String, String)]) -> Result<HttpResp, String> {
            let body = crate::translate::http::form_encode_private(params);
            self.record(url, &body, &[]);
            Ok(resp_for(url))
        }
        fn post_json(
            &self,
            url: &str,
            body: &str,
            headers: &[(&str, &str)],
        ) -> Result<HttpResp, String> {
            self.record(url, body, headers);
            Ok(resp_for(url))
        }

        fn post_json_stream(
            &self,
            url: &str,
            body: &str,
            headers: &[(&str, &str)],
            _timeout_ms: u64,
        ) -> Result<super::StreamResp, String> {
            self.record(url, body, headers);
            // A scripted body wins over the canned one (tests control the wire).
            if let Some(raw) = self.next_stream() {
                return Ok(super::StreamResp {
                    status: 200,
                    reader: Box::new(Cursor::new(raw.into_bytes())),
                });
            }
            let resp = resp_for(url);
            // chat/completions 形态 → SSE delta 帧包装；其余原样一行（非 SSE 回落路径）
            let frame = if url.contains("chat/completions") {
                let content = serde_json::from_str::<serde_json::Value>(&resp.body)
                    .ok()
                    .and_then(|v| {
                        v.get("choices")?.get(0)?.get("message")?.get("content")?.as_str().map(String::from)
                    })
                    .unwrap_or_default();
                let payload =
                    serde_json::json!({"choices":[{"delta":{"content":content}}]}).to_string();
                format!("data: {payload}\n\ndata: [DONE]\n\n")
            } else {
                format!("{}\n", resp.body)
            };
            Ok(super::StreamResp {
                status: resp.status,
                reader: Box::new(Cursor::new(frame.into_bytes())),
            })
        }

        fn get_headers_timeout(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            _timeout_ms: u64,
        ) -> Result<HttpResp, String> {
            self.record(url, "", headers);
            Ok(resp_for(url))
        }
    }
}

// Expose the form encoder to the mock (tests-only helper).
#[cfg(test)]
pub(crate) fn form_encode_private(params: &[(String, String)]) -> String {
    form_encode(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_is_shareable_across_threads() {
        fn assert_send_sync<T: Send + Sync>(_: &T) {}
        let c = UreqClient::new();
        assert_send_sync(&c);
        let cloned = c.clone();
        std::thread::spawn(move || {
            let _ = &cloned;
        })
        .join()
        .unwrap();
    }

    #[test]
    fn form_encoding_matches_urlsearchparams() {
        assert_eq!(form_encode(&[]), "");
        assert_eq!(
            form_encode(&[("a b".into(), "c&d".into()), ("e".into(), "1".into())]),
            "a+b=c%26d&e=1"
        );
    }
}
