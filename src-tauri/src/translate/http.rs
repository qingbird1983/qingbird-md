//! Minimal HTTP abstraction so providers can be tested offline with a mock.
//! The real client wraps a pooled `ureq::Agent`.
//!
//! Pooling matters more than it looks: the previous code called the top-level
//! `ureq::post()` helpers, which build a throwaway agent per call — meaning a
//! fresh DNS lookup, TCP handshake and TLS handshake (100–400 ms) on *every*
//! request, including every selection lookup.

use std::io::{BufRead, BufReader, Cursor, Read};
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
    ///
    /// `timeout_ms` 对流式响应**不是**整包 deadline（ureq 的 `Request::timeout`
    /// 会覆盖逐读超时、把仍在正常收流的长批次在到点时掐断），而是语义为：
    /// 空闲(idle)保护回落到 agent 的 `timeout_read`，外加 `STREAM_TOTAL_FACTOR`
    /// × `timeout_ms` 的整包宽松兜底。
    fn post_json_stream(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<StreamResp, String>;
}

/// 流式整包宽松兜底倍数：总时长上限 = 倍数 × timeout_ms。批量翻译传
/// 120 s → 兜底 20 分钟；期间只要流没断（单次读不超 agent 的 30 s 空闲），
/// 长流可以一直收。
const STREAM_TOTAL_FACTOR: u64 = 10;

/// base_url scheme 校验（SEC-4）：`https` 一律放行；`http` 仅放行本机地址
/// （localhost / 127.0.0.0/8 / ::1 / 未指定地址 / *.localhost），其余拒绝——
/// 非本机明文 http 会让 Bearer key 裸奔过网。无 scheme 的地址原样发给 ureq
/// 也必然失败，这里提前给出可读错误。
pub fn validate_base_url_scheme(base_url: &str) -> Result<(), String> {
    let b = base_url.trim();
    if b.starts_with("https://") {
        return Ok(());
    }
    let Some(rest) = b.strip_prefix("http://") else {
        return Err(format!(
            "API 地址需以 https:// 开头（本机服务可用 http://localhost）：{b}"
        ));
    };
    // host 位置：第一个 /、?、# 之前；剥离 userinfo（user@host）、端口与
    // IPv6 方括号（[::1]:11434 → ::1）。
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or(v6)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    let host = host.split('%').next().unwrap_or(host); // IPv6 zone id
    let lower = host.to_ascii_lowercase();
    let is_local = lower == "localhost"
        || lower.ends_with(".localhost") // RFC 6761：*.localhost 恒指本机
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback() || ip.is_unspecified())
            .unwrap_or(false)
        || host
            .parse::<std::net::Ipv6Addr>()
            .map(|ip| ip.is_loopback() || ip.is_unspecified())
            .unwrap_or(false);
    if is_local {
        Ok(())
    } else {
        Err(format!(
            "API 地址使用了明文 http://（{host}）。为保护 API 密钥，仅本机地址 \
             （localhost / 127.x.x.x / ::1）允许 http，请改用 https://"
        ))
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

/// 非流式响应体的硬上限：模型列表 / 词典 / 翻译 API 的响应都是 KB 量级，
/// 16 MiB 已极宽裕。
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// 流式读取的整包宽松兜底：只在每次 read 之间检查总时长，不干预单次读取
/// （空闲保护由 agent 的 `timeout_read` 提供）。与 ureq 的整包 deadline 的
/// 区别在于后者把"读超时"直接改写成"距 deadline 的剩余时间"，长流必被掐断。
struct LooseDeadlineReader<R> {
    inner: R,
    deadline: std::time::Instant,
}

impl<R: Read> Read for LooseDeadlineReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if std::time::Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "流式响应总时长超过兜底上限",
            ));
        }
        self.inner.read(buf)
    }
}

impl<R: BufRead> BufRead for LooseDeadlineReader<R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if std::time::Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "流式响应总时长超过兜底上限",
            ));
        }
        self.inner.fill_buf()
    }

    fn consume(&mut self, amt: usize) {
        self.inner.consume(amt);
    }
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
        // SEC-4：不设整包 deadline——ureq 的 Request::timeout 会覆盖逐读
        // 超时（stream.rs 以"距 deadline 的剩余时间"作为 read timeout），仍在
        // 正常收流的长批次会在到点时被掐断。改为：
        //   空闲(idle)保护：回落到 agent 的 timeout_read(30s)，单次读超过即断；
        //   宽松兜底：总时长上限 = STREAM_TOTAL_FACTOR × timeout_ms，由
        //   LooseDeadlineReader 在每次 read 之间检查，防"细水长流"永不终止。
        let mut req = self
            .agent
            .post(url)
            .set("Content-Type", "application/json")
            .set(IDENTITY_ENCODING.0, IDENTITY_ENCODING.1);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let total_deadline = std::time::Instant::now()
            + Duration::from_millis(timeout_ms.saturating_mul(STREAM_TOTAL_FACTOR));
        match req.send_string(body) {
            Ok(r) => {
                let status = r.status();
                let reader =
                    LooseDeadlineReader { inner: BufReader::new(r.into_reader()), deadline: total_deadline };
                Ok(StreamResp { status, reader: Box::new(reader) })
            }
            Err(ureq::Error::Status(code, r)) => {
                // 错误响应体设限读入后以 Cursor 兜底，调用方按 status 报错
                let text = bounded_body(r.into_reader(), MAX_BODY_BYTES).unwrap_or_default();
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
        /// Same FIFO, but each entry also carries an HTTP status. Checked
        /// before `streams` — lets tests script 400-retry negotiation paths.
        raws: Arc<Mutex<VecDeque<(u16, String)>>>,
        /// Dynamic variant: the reply is computed *from the request body*, for
        /// protocols whose markers embed per-request values (the batch nonce).
        /// Checked before `streams`.
        stream_fns: Arc<Mutex<VecDeque<Box<dyn Fn(&str) -> String + Send>>>>,
    }

    impl MockClient {
        pub fn new() -> Self {
            MockClient {
                store: Arc::new(Mutex::new(Vec::new())),
                streams: Arc::new(Mutex::new(VecDeque::new())),
                raws: Arc::new(Mutex::new(VecDeque::new())),
                stream_fns: Arc::new(Mutex::new(VecDeque::new())),
            }
        }

        pub fn take_records(&self) -> Vec<Record> {
            std::mem::take(&mut *self.store.lock().unwrap())
        }

        /// Queue a raw streaming response body (already in wire format).
        pub fn script_stream(&self, raw: String) {
            self.streams.lock().unwrap().push_back(raw);
        }

        /// Queue a reply computed from the request body — the model-echoes-
        /// the-protocol shape (batch markers carry a per-request nonce, so a
        /// faithful reply can't be pre-baked).
        pub fn script_stream_fn(&self, f: impl Fn(&str) -> String + Send + 'static) {
            self.stream_fns.lock().unwrap().push_back(Box::new(f));
        }

        /// Queue a stream response with an explicit HTTP status (e.g. a 400
        /// for capability-negotiation tests).
        pub fn script_stream_raw_status(&self, status: u16, raw: String) {
            self.raws.lock().unwrap().push_back((status, raw));
        }

        fn next_stream(&self, req_body: &str) -> Option<(u16, String)> {
            if let Some((code, raw)) = self.raws.lock().unwrap().pop_front() {
                return Some((code, raw));
            }
            if let Some(f) = self.stream_fns.lock().unwrap().pop_front() {
                return Some((200, f(req_body)));
            }
            self.streams.lock().unwrap().pop_front().map(|raw| (200, raw))
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
            if let Some((status, raw)) = self.next_stream(body) {
                return Ok(super::StreamResp {
                    status,
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

    // ---- SEC-4 加固 ----

    #[test]
    fn bounded_body_caps_and_tolerates_non_utf8() {
        assert_eq!(bounded_body(Cursor::new(b"hello".to_vec()), 16).unwrap(), "hello");
        // 非严格 UTF-8：替换字符容错（与 charset 关闭时 ureq into_string 一致）
        assert_eq!(bounded_body(Cursor::new(vec![0xff, 0xfe]), 16).unwrap(), "\u{fffd}\u{fffd}");
        // 超上限：报错而不是整包读入
        let e = bounded_body(Cursor::new(vec![b'x'; 17]), 16).unwrap_err();
        assert!(e.contains("上限"), "{e}");
    }

    #[test]
    fn loose_deadline_reader_enforces_total_time() {
        // 未到期：数据照常透传（Read 与 BufRead 两条路径）
        let mut r = LooseDeadlineReader {
            inner: Cursor::new(b"data\n".to_vec()),
            deadline: std::time::Instant::now() + Duration::from_secs(60),
        };
        let mut line = String::new();
        r.read_to_string(&mut line).unwrap();
        assert_eq!(line, "data\n");

        let mut r = LooseDeadlineReader {
            inner: Cursor::new(b"data\n".to_vec()),
            deadline: std::time::Instant::now() + Duration::from_secs(60),
        };
        assert!(r.fill_buf().is_ok());

        // 已到期：两种读路径都立即 TimedOut
        let past = std::time::Instant::now() - Duration::from_secs(1);
        let mut r = LooseDeadlineReader { inner: Cursor::new(b"data".to_vec()), deadline: past };
        let e = r.read(&mut [0u8; 4]).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut);
        let mut r = LooseDeadlineReader { inner: Cursor::new(b"data".to_vec()), deadline: past };
        let e = r.fill_buf().unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn stream_reader_is_send_and_bufread() {
        // StreamResp.reader: Box<dyn BufRead + Send> —— 兜底包装不能破坏该约束
        fn assert_send_bufread<T: BufRead + Send>(_: &T) {}
        let r = LooseDeadlineReader {
            inner: BufReader::new(Cursor::new(b"x".to_vec())),
            deadline: std::time::Instant::now() + Duration::from_secs(60),
        };
        assert_send_bufread(&r);
    }
}
