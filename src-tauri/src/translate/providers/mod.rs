//! Translation provider implementations, ported from the Electron
//! `src/translators/*.js`. All are pure (take an `&dyn HttpClient`) so they can
//! be tested offline with the mock client.
//!
//! **方向是入参**（Step 1）：每个源都把 [`TargetLang`] 翻成自己那套语言码
//! （`zh` / `zh-CN` / `zh-CHS`）写进请求体。改动前这些码全是写死的
//! （MyMemory `langpair=en|zh-CN`、腾讯 `Target:"zh"`、LLM 常量 prompt），
//! 于是 zh→en 会拿回中文译文——**不报错、只给错答案**。
//!
//! P2-7i 拆分布局（按「是否要求用户凭据」归族）：free = 免用户密钥族
//! （mymemory/transmart/iciba——iciba 的 key 内置但带 md5 签名，不需用户
//! 凭据，故归 free——及 auto 链）；signed = 签名族（youdao/baidu/tencent +
//! 时间/签名助手）；llm = OpenAI 兼容单串；本文件 = Creds / provider 分发 /
//! 语言码与 JSON 解析共享件。

use std::collections::HashMap;

use serde_json::Value;

use super::http::HttpClient;
use super::policy::TargetLang;

mod free;
mod llm;
mod signed;

use free::{auto, iciba, mymemory, transmart};
use llm::llm;
use signed::{baidu, tencent, youdao};

/// Credentials for a provider (map of field key -> value). Never serialized
/// into the front end in the original app; in this app it lives in settings.
#[derive(Default, Clone)]
pub struct Creds(pub HashMap<String, String>);

impl Creds {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(|s| s.as_str())
    }
}

/// A provider's translate function signature. The trailing `TargetLang` is the
/// translation direction — every engine needs it, so it belongs in the type
/// rather than in each implementation's hardcoded body.
pub type ProviderFn = fn(&str, &Creds, &dyn HttpClient, TargetLang) -> Result<String, String>;

/// Dispatch to a single provider by name.
pub fn provider(
    provider: &str,
    text: &str,
    creds: &Creds,
    http: &dyn HttpClient,
    target: TargetLang,
) -> Result<String, String> {
    match provider {
        "mymemory" => mymemory(text, creds, http, target),
        "youdao" => youdao(text, creds, http, target),
        "tencent" => tencent(text, creds, http, target),
        "baidu" => baidu(text, creds, http, target),
        "llm" => llm(text, creds, http, target),
        "transmart" => transmart(text, creds, http, target),
        "iciba" => iciba(text, creds, http, target),
        "auto" => auto(text, creds, http, target),
        other => Err(format!("未知翻译源：{other}")),
    }
}

/// 「译成中文」时的 (source, target) 语言码对；译成英文一律互换。
///
/// 各家用字不同（`zh` / `zh-CN` / `zh-CHS`），所以只统一**方向**，不强行统一
/// 字面量——按 provider 各写一张两行表比再包一层映射更好读。
fn codes(
    target: TargetLang,
    zh: (&'static str, &'static str),
) -> (&'static str, &'static str) {
    match target {
        TargetLang::Zh => zh,
        TargetLang::En => (zh.1, zh.0),
    }
}

fn parse_json(body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|e| format!("响应解析失败：{e}"))
}

#[cfg(test)]
fn creds(pairs: &[(&str, &str)]) -> Creds {
    let m = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Creds(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;

    /// 方向是显式入参，每个用例自己挑一个（同 `policy.rs` 的 `ZH` 惯例）。
    const EN: TargetLang = TargetLang::En;

    /// 全源凭据：一个 mock 客户端跑完所有 provider，便于逐条核对请求体。
    fn all_creds() -> Creds {
        creds(&[
            ("appKey", "k"),
            ("appSecret", "s"),
            ("appid", "a"),
            ("key", "b"),
            ("secretId", "AKID"),
            ("secretKey", "SECRET"),
            ("baseUrl", "https://api.deepseek.com/v1"),
            ("apiKey", "sk-test"),
            ("model", "deepseek-chat"),
        ])
    }

    /// **H4 回归**：方向必须进每一个 provider 的请求体。
    ///
    /// 改动前这些码全是写死的（MyMemory `langpair=en|zh-CN`、腾讯
    /// `"Target":"zh"`、LLM 那个自己一份的 `SYSTEM_PROMPT`……），所以 zh→en
    /// 这一遍会拿回中文译文——**不报错、只给错答案**，是最难被发现的一类坏。
    /// 这个用例是那批硬编码点的哨兵：少接一个源就会变红。
    #[test]
    fn every_provider_request_carries_the_direction() {
        let http = MockClient::new();
        let c = all_creds();
        for name in ["mymemory", "youdao", "baidu", "tencent", "transmart", "iciba", "llm"] {
            let _ = provider(name, "你好", &c, &http, EN).expect(name);
        }
        // auto 是 [transmart, iciba, mymemory] 的链，链路每个成员都在上面单测过；
        // 这里只确认它把方向透传下去了（首源成功即返回，故只打 transmart 一条）。
        let _ = provider("auto", "你好", &c, &http, EN).unwrap();

        let recs = http.take_records();
        let find = |needle: &str| recs.iter().find(|r| r.url.contains(needle)).expect(needle).clone();

        // MyMemory / iCiba / Transmart：URL 或 body 里的语言码反向
        let m = find("mymemory");
        assert!(
            m.url.contains("langpair=zh-CN|en") || m.url.contains("langpair=zh-CN%7Cen"),
            "MyMemory langpair 没反向：{}",
            m.url
        );
        let tr: Value = serde_json::from_str(&find("transmart").body).unwrap();
        assert_eq!(tr["target"]["lang"], "en", "Transmart target.lang 没反向");
        let ic: Value = serde_json::from_str(&find("dictionary.iciba.com").body).unwrap();
        assert_eq!(ic["to"], "en", "iCiba to 没反向");

        // 有道 / 百度：表单字段 from/to 互换
        let youdao_body = find("youdao").body;
        assert!(
            youdao_body.contains("from=zh-CHS") && youdao_body.contains("to=en"),
            "有道 from/to 没互换：{youdao_body}"
        );
        let baidu_body = find("baidu").body;
        assert!(
            baidu_body.contains("from=zh") && baidu_body.contains("to=en"),
            "百度 from/to 没互换：{baidu_body}"
        );

        // 腾讯云：JSON 字段是大写族
        let t: Value = serde_json::from_str(&find("tmt.tencentcloudapi.com").body).unwrap();
        assert_eq!(
            (t["Source"].as_str(), t["Target"].as_str()),
            (Some("zh"), Some("en")),
            "腾讯云 Source/Target 没互换"
        );

        // LLM：方向在 prompt 措辞里，且不能两套方向指令并存
        let l: Value = serde_json::from_str(&find("chat/completions").body).unwrap();
        let sys = l["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("英文"), "LLM prompt 没带方向：{sys}");
        assert!(!sys.contains("简体中文"), "LLM prompt 残留中文方向指令：{sys}");
    }
}
