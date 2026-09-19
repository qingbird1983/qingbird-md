//! Cancellable HTTP wrapper: fail-fast once the stop flag is set.
//! egui/pollster-free; safe to call from plain background threads.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::http::{HttpClient, HttpResp};

/// Wraps any [`HttpClient`] plus a stop flag. Once the flag is set, every
/// request returns `Err("已取消")` without touching the network, so batch
/// pipelines drain out through their normal Err paths (uncached batches exit
/// at the next batch boundary).
///
/// Streaming responses get the same treatment mid-flight (REL-7): a
/// successful `post_json_stream` body is wrapped in [`CancelReader`], so the
/// read loop in `openai::consume` — which checks the flag at every fill/read
/// boundary via this wrapper — aborts at the next line boundary instead of
/// draining a long stream to the end. Selection lookup shares the same loop
/// and wrapper, so one flag covers both.
///
/// The same flag instance should be shared with the worker thread that owns
/// cancellation (e.g. via `Arc<AtomicBool>`); reads are lock-free and safe
/// from plain threads. The `Arc` (not a bare borrow) is required because the
/// wrapped reader must own its flag — it outlives the request call.
pub struct CancelableClient<'a> {
    pub inner: &'a dyn HttpClient,
    pub cancel: &'a Arc<AtomicBool>,
}

impl<'a> CancelableClient<'a> {
    /// Fail fast if translation was cancelled.
    fn guard(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("已取消".into())
        } else {
            Ok(())
        }
    }
}

impl HttpClient for CancelableClient<'_> {
    fn get(&self, url: &str) -> Result<HttpResp, String> {
        self.guard().and_then(|_| self.inner.get(url))
    }

    fn post_form(&self, url: &str, params: &[(String, String)]) -> Result<HttpResp, String> {
        self.guard().and_then(|_| self.inner.post_form(url, params))
    }

    fn post_json(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResp, String> {
        self.guard()
            .and_then(|_| self.inner.post_json(url, body, headers))
    }

    fn post_json_timeout(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<HttpResp, String> {
        self.guard()
            .and_then(|_| self.inner.post_json_timeout(url, body, headers, timeout_ms))
    }

    fn post_json_stream(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<super::http::StreamResp, String> {
        self.guard()?;
        let mut resp = self.inner.post_json_stream(url, body, headers, timeout_ms)?;
        // REL-7：请求边界之后的取消靠读循环兜——包装响应体，让 openai::consume
        // 的每次 fill/read 之间都查一次旗标（与 http.rs 的 LooseDeadlineReader
        // 同款「读间隙检查」模式）。错误状态码的短错误体也一并包装：旗标置位
        // 时「已取消」优先于状态码错误，语义一致。
        resp.reader = Box::new(CancelReader { inner: resp.reader, cancel: Arc::clone(self.cancel) });
        Ok(resp)
    }
}

/// 流式响应体的取消感知包装（REL-7）：每次读取边界（行/块到来）之间查一次
/// stop 旗标，置位即以「已取消」io 错误中止读取。于是长流响应中途可取消，
/// 而不是只在请求边界——消费方 `openai::consume` 把该错误照常包装成
/// 「读取模型响应失败：已取消」走既有 Err 路径，不会把半截译文当成功提交。
struct CancelReader<R> {
    inner: R,
    cancel: Arc<AtomicBool>,
}

impl<R: io::Read> io::Read for CancelReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Other, "已取消"));
        }
        self.inner.read(buf)
    }
}

impl<R: io::BufRead> io::BufRead for CancelReader<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Other, "已取消"));
        }
        self.inner.fill_buf()
    }

    fn consume(&mut self, amt: usize) {
        self.inner.consume(amt);
    }
}

#[test]
fn cancelled_client_fails_fast() {
    use crate::translate::cancel::CancelableClient;
    let mock = crate::translate::http::test_mock::MockClient::new();
    let f = Arc::new(AtomicBool::new(false));
    let c = CancelableClient { inner: &mock, cancel: &f };
    assert!(c.get("https://x").is_ok());
    f.store(true, Ordering::Relaxed);
    let e = c.get("https://x").unwrap_err();
    assert_eq!(e, "已取消");
    // Compile-time check: usable from plain background threads (Send + Sync).
    fn assert_send_sync<T: Send + Sync>(_: &T) {}
    assert_send_sync(&c);
}

// ---- REL-7 回归：流式响应中途取消 ----

#[test]
fn stream_cancel_aborts_mid_read() {
    use crate::translate::http::test_mock::MidStreamCancelMock;
    use crate::translate::openai::{ChatRequest, chat_stream};

    let mock = MidStreamCancelMock::new();
    let flag = std::sync::Arc::clone(&mock.cancel);
    let c = CancelableClient { inner: &mock, cancel: &flag };
    let req = ChatRequest {
        base_url: "https://x.io/v1",
        api_key: "",
        model: "m",
        system: "sys",
        user: "hello",
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        thinking_off: false,
        timeout_ms: 30_000,
    };
    let mut deltas: Vec<String> = Vec::new();
    let r = chat_stream(&req, &c, &mut |acc: &str| deltas.push(acc.to_string()));
    // 修复前：consume 一路读到 EOF，返回完整拼接内容，取消旗标无人理会。
    let e = r.expect_err("流中途取消仍把整条流读完");
    assert!(e.contains("已取消"), "{e}");
    assert_eq!(
        deltas,
        vec![r#"{"t":"你"#.to_string()],
        "取消点之前已到的行照常回调，其后不得再读"
    );
}
