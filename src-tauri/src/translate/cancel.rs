//! Cancellable HTTP wrapper: fail-fast once the stop flag is set.
//! egui/pollster-free; safe to call from plain background threads.

use std::sync::atomic::{AtomicBool, Ordering};

use super::http::{HttpClient, HttpResp};

/// Wraps any [`HttpClient`] plus a stop flag. Once the flag is set, every
/// request returns `Err("已取消")` without touching the network, so batch
/// pipelines drain out through their normal Err paths (uncached batches exit
/// at the next batch boundary).
///
/// The same flag instance should be shared with the worker thread that owns
/// cancellation (e.g. via `Arc<AtomicBool>`); `&AtomicBool` reads are
/// lock-free and safe from plain threads.
pub struct CancelableClient<'a> {
    pub inner: &'a dyn HttpClient,
    pub cancel: &'a AtomicBool,
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
}

#[test]
fn cancelled_client_fails_fast() {
    use crate::translate::cancel::CancelableClient;
    let mock = crate::translate::http::test_mock::MockClient::new();
    let f = AtomicBool::new(false);
    let c = CancelableClient { inner: &mock, cancel: &f };
    assert!(c.get("https://x").is_ok());
    f.store(true, Ordering::Relaxed);
    let e = c.get("https://x").unwrap_err();
    assert_eq!(e, "已取消");
    // Compile-time check: usable from plain background threads (Send + Sync).
    fn assert_send_sync<T: Send + Sync>(_: &T) {}
    assert_send_sync(&c);
}
