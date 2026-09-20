//! LLM 族（OpenAI 兼容单串翻译）：经流式客户端统一请求构造、SSE 读取与
//! 错误格式；base_url 的 scheme 白名单校验在 `openai::chat_stream` 内完成
//! （P1-4），本族不另设判定。

use super::super::http::HttpClient;
use super::super::openai;
use super::super::policy::{system_prompt, TargetLang};
use super::Creds;

// ---- Custom LLM (OpenAI-compatible) ----

/// Single-shot LLM translation (the `translate_text` command and the `auto`
/// chain's callers). Routed through the streaming client so every LLM call in
/// the app shares one request builder, one SSE reader and one error format —
/// and so time-to-first-token is the same everywhere instead of depending on
/// which code path happened to be used.
///
/// Prompt 走 [`system_prompt`]——**同一份措辞、同一份注入防御**。改动前这里
/// 另有一个写死"简体中文"的 `SYSTEM_PROMPT` 常量，与批量路径的 prompt 各写
/// 各的：后来给 prompt 加不可信上下文声明时，这条路径就被漏掉了。
pub(super) fn llm(text: &str, creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let prompt = system_prompt(target, None);
    let req = openai::ChatRequest {
        base_url: creds.get("baseUrl").unwrap_or_default(),
        api_key: creds.get("apiKey").unwrap_or_default(),
        model: creds.get("model").unwrap_or_default(),
        system: &prompt,
        user: text,
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        thinking_off: true,
        timeout_ms: 120_000,
    };
    let mut noop = |_: &str| {};
    // strip_fence 与本文件原 clean 逐点等价（trim→剥围栏→丢语言行→去尾围栏→
    // 再 trim），P2-3 合并到 openai 的单份实现（自带单测）。
    openai::chat_stream(&req, http, &mut noop).map(|c| openai::strip_fence(&c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;
    use crate::translate::providers::creds;
    use serde_json::Value;

    const ZH: TargetLang = TargetLang::Zh;

    #[test]
    fn llm_builds_openai_request() {
        let http = MockClient::new();
        let c = creds(&[("baseUrl", "https://api.deepseek.com/v1"), ("apiKey", "sk-test"), ("model", "deepseek-chat")]);
        let r = llm("hello world", &c, &http, ZH).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("chat/completions")).unwrap();
        assert_eq!(rec.url, "https://api.deepseek.com/v1/chat/completions");
        let auth = rec.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.as_str()).unwrap_or("");
        assert_eq!(auth, "Bearer sk-test");
        let body: Value = serde_json::from_str(&rec.body).unwrap();
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hello world");
        // f32 经 JSON 是 0.10000000149011612，按数值近似比较
        let t = body["temperature"].as_f64().unwrap();
        assert!((t - 0.1).abs() < 1e-6);
    }

    #[test]
    fn llm_normalizes_trailing_slash_and_no_key() {
        let http = MockClient::new();
        let c = creds(&[("baseUrl", "http://127.0.0.1:11434/v1/"), ("model", "qwen2.5:7b")]);
        let r = llm("hi", &c, &http, ZH).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("11434")).unwrap();
        assert_eq!(rec.url, "http://127.0.0.1:11434/v1/chat/completions");
        assert!(!rec.headers.iter().any(|(k, _)| k == "Authorization"));
    }

    /// 单串 LLM 路径与 `engine::llm_once` 共用同一份 prompt（含注入防御）。
    /// 这两条路径历史上各写各的 prompt，加防御时漏了一条——这个断言钉住它们。
    #[test]
    fn llm_prompt_is_the_shared_one_with_injection_defence() {
        let http = MockClient::new();
        let c = creds(&[("baseUrl", "https://x.test/v1"), ("model", "m")]);
        let _ = llm("hi", &c, &http, ZH).unwrap();
        let body: Value = serde_json::from_str(
            &http.take_records().into_iter().find(|x| x.url.contains("chat/completions")).unwrap().body,
        )
        .unwrap();
        let sys = body["messages"][0]["content"].as_str().unwrap();
        assert_eq!(sys, system_prompt(ZH, None), "单串路径必须复用共享 prompt");
    }
}
