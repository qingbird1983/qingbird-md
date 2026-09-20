//! 免用户密钥族：MyMemory / Tencent Transmart / iCiba（key 内置但带 md5
//! 签名，不需用户凭据，故归 free）与 auto 降级链。

use serde_json::Value;

use super::signed::{now_millis, query_encode};
use super::{codes, parse_json, Creds};
use crate::translate::http::HttpClient;
use crate::translate::policy::TargetLang;
use crate::translate::sign::md5;

// ---- MyMemory (free) ----
pub(super) fn mymemory(
    text: &str,
    _creds: &Creds,
    http: &dyn HttpClient,
    target: TargetLang,
) -> Result<String, String> {
    let (from, to) = codes(target, ("en", "zh-CN"));
    let url = format!(
        "https://api.mymemory.translated.net/get?q={}&langpair={from}|{to}",
        query_encode(text)
    );
    let r = http.get(&url)?;
    let v = parse_json(&r.body)?;
    if let Some(status) = v.get("responseStatus").and_then(|x| x.as_i64()) {
        if status != 200 {
            let details = v.get("responseDetails").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("MyMemory：{details}"));
        }
    }
    match v.get("responseData").and_then(|d| d.get("translatedText")).and_then(|x| x.as_str()) {
        Some(t) => Ok(t.to_string()),
        None => Err("MyMemory 无结果".to_string()),
    }
}

// ---- Tencent Transmart (free browser endpoint) ----
pub(super) fn transmart(text: &str, _creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    // 源侧吃 `"auto"`（自动识别），只有目标语言需要方向。
    let (_, dst) = codes(target, ("en", "zh"));
    let body = serde_json::json!({
        "header": {
            "fn": "auto_translation_block",
            "client_key": "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487",
        },
        "type": "plain",
        "model_category": "normal",
        "source": { "lang": "auto", "text_block": text },
        "target": { "lang": dst },
    })
    .to_string();
    let headers: Vec<(&str, &str)> = vec![
        ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"),
        ("Referer", "https://yi.qq.com/zh-CN/index"),
    ];
    let r = http.post_json("https://transmart.qq.com/api/imt", &body, &headers)?;
    if r.status >= 400 {
        return Err(format!("Transmart HTTP {}", r.status));
    }
    let v = parse_json(&r.body)?;
    let s = match v.get("auto_translation") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    if s.trim().is_empty() {
        let preview: String = r.body.chars().take(200).collect();
        Err(format!("Transmart 无结果：{preview}"))
    } else {
        Ok(s)
    }
}

// ---- iCiba (free, md5 sign) ----
const ICIBA_PATH: &str = "/dictionary/fy/batch";
const ICIBA_CLIENT: &str = "6";
const ICIBA_KEY: &str = "1000006";
const ICIBA_SALT: &str = "7ece94d9f9c202b0d2ec557dg4r9bc";

pub(super) fn iciba(text: &str, _creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let timestamp = now_millis();
    let signature = md5(&format!("{ICIBA_PATH}{ICIBA_CLIENT}{ICIBA_KEY}{timestamp}{ICIBA_SALT}"));
    let url = format!(
        "https://dictionary.iciba.com/dictionary/fy/batch?client={ICIBA_CLIENT}&key={ICIBA_KEY}&timestamp={timestamp}&signature={signature}"
    );
    let (_, dst) = codes(target, ("en", "zh"));
    let body = serde_json::json!({ "from": "auto", "to": dst, "textList": [text] }).to_string();
    let headers: Vec<(&str, &str)> = vec![
        ("Origin", "https://www.iciba.com"),
        ("Referer", "https://www.iciba.com/"),
        ("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"),
    ];
    let r = http.post_json(&url, &body, &headers)?;
    if r.status >= 400 {
        return Err(format!("iCiba HTTP {}", r.status));
    }
    let v = parse_json(&r.body)?;
    let code = v.get("code").and_then(|x| x.as_i64()).or_else(|| v.get("code").and_then(|x| x.as_str()).and_then(|s| s.parse().ok()));
    if code != Some(1) {
        let preview: String = r.body.chars().take(200).collect();
        return Err(format!("iCiba error：{preview}"));
    }
    let arr = v.get("data").and_then(|x| x.as_array());
    let mut lines = Vec::new();
    if let Some(a) = arr {
        for item in a {
            if let Some(s) = item.as_str() {
                lines.push(s.to_string());
            } else if let Some(out) = item.get("out").and_then(|x| x.as_str()) {
                lines.push(out.to_string());
            }
        }
    }
    if lines.is_empty() {
        Err("iCiba 无结果".to_string())
    } else {
        Ok(lines.join("\n"))
    }
}

// ---- auto chain ----
pub(super) fn auto(text: &str, creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let chain: [super::ProviderFn; 3] = [transmart, iciba, mymemory];
    let mut last_err = String::new();
    for f in chain {
        match f(text, creds, http, target) {
            Ok(t) => return Ok(t),
            Err(e) => last_err = e,
        }
    }
    Err(format!("全部翻译源失败：{last_err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;
    use crate::translate::policy::TargetLang;

    const ZH: TargetLang = TargetLang::Zh;

    #[test]
    fn mymemory_url_has_langpair() {
        let http = MockClient::new();
        let r = mymemory("hello", &Creds::default(), &http, ZH).unwrap();
        assert_eq!(r, "你好");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("mymemory")).unwrap();
        assert!(rec.url.contains("langpair=en|zh-CN") || rec.url.contains("langpair=en%7Czh-CN"));
    }

    #[test]
    fn iciba_parses_data_out() {
        let http = MockClient::new();
        let r = iciba("hello", &Creds::default(), &http, ZH).unwrap();
        assert_eq!(r, "你好");
    }

    #[test]
    fn transmart_parses_auto_translation() {
        let http = MockClient::new();
        let r = transmart("hello world", &Creds::default(), &http, ZH).unwrap();
        assert_eq!(r, "你好，世界");
    }

    #[test]
    fn auto_chain_falls_through() {
        let http = MockClient::new();
        let r = auto("hello world", &Creds::default(), &http, ZH).unwrap();
        assert_eq!(r, "你好，世界");
    }
}
