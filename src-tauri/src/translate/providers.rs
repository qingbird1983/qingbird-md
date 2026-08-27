//! Translation provider implementations, ported from the Electron
//! `src/translators/*.js`. All are pure (take an `&dyn HttpClient`) so they can
//! be tested offline with the mock client.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::http::HttpClient;
use super::sign::{hmac_sha256, md5, sha256_hex};

/// Credentials for a provider (map of field key -> value). Never serialized
/// into the front end in the original app; in this app it lives in settings.
#[derive(Default, Clone)]
pub struct Creds(pub HashMap<String, String>);

impl Creds {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(|s| s.as_str())
    }
}

/// A provider's translate function signature.
pub type ProviderFn = fn(&str, &Creds, &dyn HttpClient) -> Result<String, String>;

/// Dispatch to a single provider by name.
pub fn provider(provider: &str, text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    match provider {
        "mymemory" => mymemory(text, creds, http),
        "youdao" => youdao(text, creds, http),
        "tencent" => tencent(text, creds, http),
        "baidu" => baidu(text, creds, http),
        "llm" => llm(text, creds, http),
        "transmart" => transmart(text, creds, http),
        "iciba" => iciba(text, creds, http),
        "auto" => auto(text, creds, http),
        other => Err(format!("未知翻译源：{other}")),
    }
}

// ---- helpers ----

fn now_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn now_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn salt() -> String {
    // Numeric string (like JS Math.random().slice(2)).
    format!("{}", now_nanos() % 100_000_000_000)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn truncate(q: &str) -> String {
    let n = q.chars().count();
    if n > 20 {
        let front: String = q.chars().take(10).collect();
        let back: String = q.chars().skip(n - 10).take(10).collect();
        format!("{front}{n}{back}")
    } else {
        q.to_string()
    }
}

fn query_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn parse_json(body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|e| format!("响应解析失败：{e}"))
}

// ---- MyMemory (free) ----
fn mymemory(text: &str, _creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let url = format!(
        "https://api.mymemory.translated.net/get?q={}&langpair=en|zh-CN",
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

// ---- Youdao (v3 sign) ----
fn youdao(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let app_key = creds.get("appKey").ok_or("请先在「设置」中填写有道 App Key")?;
    let app_secret = creds.get("appSecret").ok_or("请先在「设置」中填写有道 App Secret")?;
    let salt = salt();
    let curtime = now_secs();
    let sign = sha256_hex(&format!("{app_key}{}{salt}{curtime}{app_secret}", truncate(text)));

    let params: Vec<(String, String)> = vec![
        ("q".into(), text.into()),
        ("from".into(), "en".into()),
        ("to".into(), "zh-CHS".into()),
        ("appKey".into(), app_key.into()),
        ("salt".into(), salt),
        ("sign".into(), sign),
        ("signType".into(), "v3".into()),
        ("curtime".into(), curtime),
    ];
    let r = http.post_form("https://openapi.youdao.com/api", &params)?;
    let v = parse_json(&r.body)?;
    let ec = v.get("errorCode").and_then(|x| x.as_str()).unwrap_or("");
    if ec != "0" {
        let msg = v.get("errorMsg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("有道翻译错误 {ec}：{msg}"));
    }
    let lines: Vec<String> = v.get("translation").and_then(|t| t.as_array()).map(|a| {
        a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect()
    }).unwrap_or_default();
    if lines.is_empty() {
        return Err("有道翻译无结果".to_string());
    }
    Ok(lines.join("\n"))
}

// ---- Baidu (md5 sign) ----
fn baidu(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let appid = creds.get("appid").ok_or("请先在「设置」中填写百度 APP ID")?;
    let key = creds.get("key").ok_or("请先在「设置」中填写百度密钥")?;
    let salt = salt();
    let sign = md5(&format!("{appid}{text}{salt}{key}"));

    let params: Vec<(String, String)> = vec![
        ("q".into(), text.into()),
        ("from".into(), "en".into()),
        ("to".into(), "zh".into()),
        ("appid".into(), appid.into()),
        ("salt".into(), salt),
        ("sign".into(), sign),
    ];
    let r = http.post_form("https://fanyi-api.baidu.com/api/trans/vip/translate", &params)?;
    let v = parse_json(&r.body)?;
    if let Some(ec) = v.get("error_code") {
        let msg = v.get("error_msg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("百度翻译错误 {ec}：{msg}"));
    }
    let dst: Vec<String> = v.get("trans_result").and_then(|t| t.as_array()).map(|a| {
        a.iter().filter_map(|e| e.get("dst").and_then(|x| x.as_str())).map(|s| s.to_string()).collect()
    }).unwrap_or_default();
    if dst.is_empty() {
        return Err("百度翻译无结果".to_string());
    }
    Ok(dst.join("\n"))
}

// ---- Tencent TMT (TC3-HMAC-SHA256) ----
fn tencent(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let secret_id = creds.get("secretId").ok_or("请先在「设置」中填写腾讯 SecretId")?;
    let secret_key = creds.get("secretKey").ok_or("请先在「设置」中填写腾讯 SecretKey")?;
    let region = creds.get("region").unwrap_or("ap-beijing");
    let host = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let action = "TextTranslate";
    let version = "2018-03-01";

    let payload = serde_json::json!({
        "SourceText": text,
        "Source": "en",
        "Target": "zh",
        "ProjectId": 0,
    })
    .to_string();

    let timestamp = now_secs();
    let date = utc_date(&timestamp);
    let credential_scope = format!("{date}/{service}/tc3_request");
    let hashed_payload = sha256_hex(&payload);
    let canonical_headers = format!("content-type:application/json; charset=utf-8\nhost:{host}\n");
    let signed_headers = "content-type;host";
    let canonical_request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}");
    let string_to_sign = format!("TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}", sha256_hex(&canonical_request));

    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex(&hmac_sha256(&secret_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let headers: Vec<(&str, &str)> = vec![
        ("Host", host),
        ("Authorization", authorization.as_str()),
        ("X-TC-Action", action),
        ("X-TC-Timestamp", timestamp.as_str()),
        ("X-TC-Version", version),
        ("X-TC-Region", region),
    ];

    let r = http.post_json(&format!("https://{host}/"), &payload, &headers)?;
    let v = parse_json(&r.body)?;
    if let Some(err) = v.get("Response").and_then(|x| x.get("Error")) {
        let code = err.get("Code").and_then(|x| x.as_str()).unwrap_or("");
        let msg = err.get("Message").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("腾讯云翻译错误：{code} {msg}"));
    }
    match v.get("Response").and_then(|x| x.get("TargetText")).and_then(|x| x.as_str()) {
        Some(t) => Ok(t.to_string()),
        None => Err("腾讯云翻译无结果".to_string()),
    }
}

fn utc_date(timestamp: &str) -> String {
    let secs: i64 = timestamp.parse().unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    (y, m, d)
}

// ---- Tencent Transmart (free browser endpoint) ----
fn transmart(text: &str, _creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let body = serde_json::json!({
        "header": {
            "fn": "auto_translation_block",
            "client_key": "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487",
        },
        "type": "plain",
        "model_category": "normal",
        "source": { "lang": "auto", "text_block": text },
        "target": { "lang": "zh" },
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

fn iciba(text: &str, _creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let timestamp = now_millis();
    let signature = md5(&format!("{ICIBA_PATH}{ICIBA_CLIENT}{ICIBA_KEY}{timestamp}{ICIBA_SALT}"));
    let url = format!(
        "https://dictionary.iciba.com/dictionary/fy/batch?client={ICIBA_CLIENT}&key={ICIBA_KEY}&timestamp={timestamp}&signature={signature}"
    );
    let body = serde_json::json!({ "from": "auto", "to": "zh", "textList": [text] }).to_string();
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

// ---- Custom LLM (OpenAI-compatible) ----
const SYSTEM_PROMPT: &str = "你是一名专业的中英翻译。把用户给出的文本翻译成简体中文，保留原文的格式、语气和段落结构，各段之间用换行分隔。只输出译文本身，不要添加任何解释、注释或前后缀。";

fn llm(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let base = creds.get("baseUrl").map(|s| s.trim_end_matches('/').to_string()).unwrap_or_default();
    let model = creds.get("model").map(|s| s.trim().to_string()).unwrap_or_default();
    if base.is_empty() {
        return Err("请先在「设置」中填写自定义大模型的 API 地址".to_string());
    }
    if model.is_empty() {
        return Err("请先在「设置」中填写模型名".to_string());
    }
    let url = format!("{base}/chat/completions");
    let api_key = creds.get("apiKey").map(|s| s.trim()).unwrap_or("").to_string();
    let auth_owned = if api_key.is_empty() {
        String::new()
    } else {
        format!("Bearer {api_key}")
    };
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if !auth_owned.is_empty() {
        headers.push(("Authorization", auth_owned.as_str()));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": text },
        ],
        "temperature": 0.1,
    })
    .to_string();

    let r = http.post_json_timeout(&url, &body, &headers, 120_000)?;
    if r.status >= 400 {
        let mut detail = String::new();
        if let Ok(v) = parse_json(&r.body) {
            if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|x| x.as_str()) {
                detail = format!("：{msg}");
            }
        }
        return Err(format!("自定义大模型返回 {}{detail}", r.status));
    }
    let v = parse_json(&r.body)?;
    let content = v.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str());
    match content {
        Some(c) => Ok(clean(c)),
        None => Err("自定义大模型无返回内容".to_string()),
    }
}

fn clean(s: &str) -> String {
    let t = s.trim();
    if t.starts_with("```") {
        let mut inner = t;
        inner = inner.strip_prefix("```").unwrap_or(inner);
        inner = inner.split_once('\n').map(|(_, rest)| rest).unwrap_or(inner);
        inner = inner.strip_suffix("```").unwrap_or(inner);
        return inner.trim().to_string();
    }
    t.to_string()
}

// ---- auto chain ----
fn auto(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<String, String> {
    let chain: [ProviderFn; 3] = [transmart, iciba, mymemory];
    let mut last_err = String::new();
    for f in chain {
        match f(text, creds, http) {
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

    fn creds(pairs: &[(&str, &str)]) -> Creds {
        let m = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Creds(m)
    }

    #[test]
    fn youdao_request_body_has_v3_sign_and_parses() {
        let http = MockClient::new();
        let c = creds(&[("appKey", "k"), ("appSecret", "s")]);
        let r = youdao("hello world", &c, &http).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("youdao")).unwrap();
        for k in ["q=hello+world", "from=en", "to=zh-CHS", "appKey=k", "signType=v3"] {
            assert!(rec.body.contains(k), "missing {k}");
        }
        assert!(rec.body.contains("sign="), "missing sign");
    }

    #[test]
    fn baidu_sign_is_md5_of_appid_q_salt_key() {
        let http = MockClient::new();
        let c = creds(&[("appid", "a"), ("key", "b")]);
        let r = baidu("hello", &c, &http).unwrap();
        assert_eq!(r, "你好");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("baidu")).unwrap();
        assert!(rec.body.contains("appid=a"));
        assert!(rec.body.contains("from=en") && rec.body.contains("to=zh"));
        let salt = rec.body.split("salt=").nth(1).and_then(|s| s.split('&').next()).unwrap();
        assert!(rec.body.contains(&format!("sign={}", md5(&format!("ahello{salt}b")))), "sign mismatch");
    }

    #[test]
    fn tencent_tc3_signature_self_consistent() {
        let http = MockClient::new();
        let c = creds(&[("secretId", "AKID"), ("secretKey", "SECRET"), ("region", "ap-beijing")]);
        let r = tencent("hello world", &c, &http).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("tmt.tencentcloudapi.com")).unwrap();
        let h = |k: &str| rec.headers.iter().find(|(hk, _)| hk == k).map(|(_, v)| v.as_str()).unwrap_or("");
        assert_eq!(h("X-TC-Action"), "TextTranslate");
        assert!(h("Authorization").starts_with("TC3-HMAC-SHA256 Credential=AKID/"));
        assert!(h("Authorization").contains("SignedHeaders=content-type;host"));
        let ts = h("X-TC-Timestamp");
        let date = utc_date(ts);
        let scope = format!("{date}/tmt/tc3_request");
        let hp = sha256_hex(&rec.body);
        let ch = format!("content-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\n");
        let cr = format!("POST\n/\n\n{ch}\ncontent-type;host\n{hp}");
        let sts = format!("TC3-HMAC-SHA256\n{ts}\n{scope}\n{}", sha256_hex(&cr));
        let sd = hmac_sha256(b"TC3SECRET", date.as_bytes());
        let ss = hmac_sha256(&sd, b"tmt");
        let ssign = hmac_sha256(&ss, b"tc3_request");
        let sig = hex(&hmac_sha256(&ssign, sts.as_bytes()));
        assert!(h("Authorization").contains(&format!("Signature={sig}")), "TC3 signature mismatch");
    }

    #[test]
    fn mymemory_url_has_langpair() {
        let http = MockClient::new();
        let r = mymemory("hello", &Creds::default(), &http).unwrap();
        assert_eq!(r, "你好");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("mymemory")).unwrap();
        assert!(rec.url.contains("langpair=en|zh-CN") || rec.url.contains("langpair=en%7Czh-CN"));
    }

    #[test]
    fn llm_builds_openai_request() {
        let http = MockClient::new();
        let c = creds(&[("baseUrl", "https://api.deepseek.com/v1"), ("apiKey", "sk-test"), ("model", "deepseek-chat")]);
        let r = llm("hello world", &c, &http).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("chat/completions")).unwrap();
        assert_eq!(rec.url, "https://api.deepseek.com/v1/chat/completions");
        let auth = rec.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.as_str()).unwrap_or("");
        assert_eq!(auth, "Bearer sk-test");
        let body: Value = serde_json::from_str(&rec.body).unwrap();
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hello world");
        assert_eq!(body["temperature"], 0.1);
    }

    #[test]
    fn llm_normalizes_trailing_slash_and_no_key() {
        let http = MockClient::new();
        let c = creds(&[("baseUrl", "http://127.0.0.1:11434/v1/"), ("model", "qwen2.5:7b")]);
        let r = llm("hi", &c, &http).unwrap();
        assert_eq!(r, "你好，世界");
        let rec = http.take_records().into_iter().find(|x| x.url.contains("11434")).unwrap();
        assert_eq!(rec.url, "http://127.0.0.1:11434/v1/chat/completions");
        assert!(!rec.headers.iter().any(|(k, _)| k == "Authorization"));
    }

    #[test]
    fn iciba_parses_data_out() {
        let http = MockClient::new();
        let r = iciba("hello", &Creds::default(), &http).unwrap();
        assert_eq!(r, "你好");
    }

    #[test]
    fn transmart_parses_auto_translation() {
        let http = MockClient::new();
        let r = transmart("hello world", &Creds::default(), &http).unwrap();
        assert_eq!(r, "你好，世界");
    }

    #[test]
    fn auto_chain_falls_through() {
        let http = MockClient::new();
        let r = auto("hello world", &Creds::default(), &http).unwrap();
        assert_eq!(r, "你好，世界");
    }

    #[test]
    fn clean_strips_fences() {
        assert_eq!(clean("```\n你好\n```"), "你好");
        assert_eq!(clean("  你好  "), "你好");
    }
}

