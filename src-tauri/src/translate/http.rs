//! Minimal HTTP abstraction so providers can be tested offline with a mock.
//! The real client wraps a pooled `ureq::Agent`.
//!
//! Pooling matters more than it looks: the previous code called the top-level
//! `ureq::post()` helpers, which build a throwaway agent per call — meaning a
//! fresh DNS lookup, TCP handshake and TLS handshake (100–400 ms) on *every*
//! request.

use std::io::Read;
use std::time::Duration;

/// A finished HTTP response: status code + response body text.
#[derive(Debug, Clone)]
pub struct HttpResp {
    pub status: u16,
    pub body: String,
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
}

/// 整包读入响应体并设硬上限：超出 `cap` 即报错，防畸形端点把内存吃穿。
/// 不依赖 ureq `into_string` 的内部 10 MiB 上限（response.rs
/// INTO_STRING_LIMIT，库实现细节）；非严格 UTF-8 按替换字符容错，与
/// charset feature 关闭时的 `into_string` 行为一致。
fn bounded_body(reader: impl Read, cap: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > cap {
        return Err(format!("响应体超过上限（{cap} 字节），已中止读取"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 非流式响应体的硬上限：词典 / 翻译 API 的响应都是 KB 量级，
/// 16 MiB 已极宽裕。
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

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
            // Per-read timeout: catches a silently dropped connection.
            .timeout_read(Duration::from_secs(30))
            .max_idle_connections(16)
            .max_idle_connections_per_host(8)
            .build();
        UreqClient { agent }
    }

    /// Process-wide shared client. The whole point of a pooled agent is that
    /// idle connections survive between requests — a fresh `UreqClient` per
    /// call drops them, so every request pays DNS + TCP + TLS again
    /// (100–400 ms). Cloning is cheap but *keeping one alive* is what actually
    /// reuses connections, so all call sites must go through this.
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

impl HttpClient for UreqClient {
    fn get(&self, url: &str) -> Result<HttpResp, String> {
        map(self.agent.get(url).call())
    }

    fn post_form(&self, url: &str, params: &[(String, String)]) -> Result<HttpResp, String> {
        let body = form_encode(params);
        map(self
            .agent
            .post(url)
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body))
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
        let mut req = self
            .agent
            .get(url)
            .timeout(Duration::from_millis(timeout_ms));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        map(req.call())
    }
}

fn map(res: Result<ureq::Response, ureq::Error>) -> Result<HttpResp, String> {
    match res {
        Ok(r) => {
            let status = r.status();
            let body = bounded_body(r.into_reader(), MAX_BODY_BYTES)?;
            Ok(HttpResp { status, body })
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = bounded_body(r.into_reader(), MAX_BODY_BYTES).unwrap_or_default();
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
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
    use super::{HttpClient, HttpResp};
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    pub struct Record {
        pub url: String,
        pub body: String,
        pub headers: Vec<(String, String)>,
    }

    pub struct MockClient {
        store: Mutex<Vec<Record>>,
    }

    impl MockClient {
        pub fn new() -> Self {
            MockClient {
                store: Mutex::new(Vec::new()),
            }
        }

        pub fn take_records(&self) -> Vec<Record> {
            std::mem::take(&mut *self.store.lock().unwrap())
        }

        fn record(&self, url: &str, body: &str, headers: &[(&str, &str)]) {
            let h = headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            self.store.lock().unwrap().push(Record {
                url: url.to_string(),
                body: body.to_string(),
                headers: h,
            });
        }
    }

    impl Default for MockClient {
        fn default() -> Self {
            Self::new()
        }
    }

    pub fn resp_for(url: &str) -> HttpResp {
        let body = if url.contains("youdao") {
            r#"{"errorCode":"0","translation":["你好，世界"]}"#
        } else if url.contains("baidu") {
            r#"{"trans_result":[{"src":"hello","dst":"你好"}]}"#
        } else if url.contains("tmt.tencentcloudapi.com") {
            r#"{"Response":{"TargetText":"你好，世界"}}"#
        } else if url.contains("transmart") {
            r#"{"auto_translation":"你好，世界"}"#
        } else if url.contains("dictionary.iciba.com") {
            r#"{"code":1,"data":[{"out":"你好"}]}"#
        } else {
            r#"{"responseData":{"translatedText":"你好"},"responseStatus":200}"#
        };
        HttpResp {
            status: 200,
            body: body.to_string(),
        }
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
    use std::io::Cursor;

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

    #[test]
    fn bounded_body_caps_and_tolerates_non_utf8() {
        assert_eq!(
            bounded_body(Cursor::new(b"hello".to_vec()), 16).unwrap(),
            "hello"
        );
        // 非严格 UTF-8：替换字符容错（与 charset 关闭时 ureq into_string 一致）
        assert_eq!(
            bounded_body(Cursor::new(vec![0xff, 0xfe]), 16).unwrap(),
            "\u{fffd}\u{fffd}"
        );
        // 超上限：报错而不是整包读入
        let e = bounded_body(Cursor::new(vec![b'x'; 17]), 16).unwrap_err();
        assert!(e.contains("上限"), "{e}");
    }
}
