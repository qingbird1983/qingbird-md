//! 签名族（要求用户凭据）：有道 v3 / 百度 md5 / 腾讯云 TC3-HMAC-SHA256，
//! 以及时间与签名参数助手。

use std::time::{SystemTime, UNIX_EPOCH};

use super::{codes, parse_json, Creds};
use crate::translate::http::HttpClient;
use crate::translate::policy::TargetLang;
use crate::translate::sign::{hmac_sha256, hex, md5, sha256_hex};

// ---- helpers ----

fn now_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub(super) fn now_millis() -> String {
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

pub(super) fn query_encode(s: &str) -> String {
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

// ---- Youdao (v3 sign) ----
pub(super) fn youdao(text: &str, creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let app_key = creds.get("appKey").ok_or("请先在「设置」中填写有道 App Key")?;
    let app_secret = creds.get("appSecret").ok_or("请先在「设置」中填写有道 App Secret")?;
    let salt = salt();
    let curtime = now_secs();
    let sign = sha256_hex(&format!("{app_key}{}{salt}{curtime}{app_secret}", truncate(text)));

    let (from, to) = codes(target, ("en", "zh-CHS"));
    let params: Vec<(String, String)> = vec![
        ("q".into(), text.into()),
        ("from".into(), from.into()),
        ("to".into(), to.into()),
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
pub(super) fn baidu(text: &str, creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let appid = creds.get("appid").ok_or("请先在「设置」中填写百度 APP ID")?;
    let key = creds.get("key").ok_or("请先在「设置」中填写百度密钥")?;
    let salt = salt();
    let sign = md5(&format!("{appid}{text}{salt}{key}"));

    let (from, to) = codes(target, ("en", "zh"));
    let params: Vec<(String, String)> = vec![
        ("q".into(), text.into()),
        ("from".into(), from.into()),
        ("to".into(), to.into()),
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
pub(super) fn tencent(text: &str, creds: &Creds, http: &dyn HttpClient, target: TargetLang) -> Result<String, String> {
    let secret_id = creds.get("secretId").ok_or("请先在「设置」中填写腾讯 SecretId")?;
    let secret_key = creds.get("secretKey").ok_or("请先在「设置」中填写腾讯 SecretKey")?;
    let region = creds.get("region").unwrap_or("ap-beijing");
    let host = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let action = "TextTranslate";
    let version = "2018-03-01";

    // 语言码是大写字段值（`"Source"/"Target"`），与 URL 里的小写码不同族。
    let (source, dst) = codes(target, ("en", "zh"));
    let payload = serde_json::json!({
        "SourceText": text,
        "Source": source,
        "Target": dst,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;
    use crate::translate::providers::creds;

    const ZH: TargetLang = TargetLang::Zh;

    #[test]
    fn youdao_request_body_has_v3_sign_and_parses() {
        let http = MockClient::new();
        let c = creds(&[("appKey", "k"), ("appSecret", "s")]);
        let r = youdao("hello world", &c, &http, ZH).unwrap();
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
        let r = baidu("hello", &c, &http, ZH).unwrap();
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
        let r = tencent("hello world", &c, &http, ZH).unwrap();
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
}
