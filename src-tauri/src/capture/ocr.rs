//! 有道 OCR 图片翻译客户端（平移自 Glance api.rs，reqwest→ureq 同步改造）。
//!
//! 已知风险（spec §2）：走有道词典 PC 客户端通道（clientele=deskdict + 抓包
//! secret），非官方接口，可能随版本更新失效——失效只影响截图翻译，换通道
//! 只改本文件。

use base64::Engine;
use serde::Deserialize;

const ENDPOINT: &str = "https://ocrtran.youdao.com/ocr/imgtranocr";
const IMAGE_TRANSLATE_SECRET: &str = "VPaHE3kX_vl4BhgYiu2n";
pub const CLIENTELE: &str = "deskdict";
// 有道接口校验 UA（Glance 抓包结论），照搬 Chrome UA
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct OcrResult {
    /// 翻译后整图（JPEG）的 base64——浮窗直接绘制。
    pub image_base64: String,
}

/// 阻塞网络调用：必须在 worker 线程上跑。
pub fn translate_image(png: &[u8], from: &str, to: &str) -> Result<OcrResult, String> {
    let salt = salt_string();
    let sign = upload_sign(png, &salt)?;
    let boundary = "qingbird-capture-9f2e7a1b";
    let fields = [
        ("clientele", CLIENTELE.to_string()),
        ("salt", salt),
        ("sign", sign),
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("isSaveHistory", "false".to_string()), // qingbird 不存有道云端历史
        ("isSyncSaveHistory", "false".to_string()),
        ("funDesc", "photo_translate".to_string()),
    ];
    let body = multipart_body(boundary, png, &fields);

    let resp = ureq::post(ENDPOINT)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .timeout(std::time::Duration::from_secs(30))
        .send(body.as_slice())
        .map_err(|e| format!("有道 OCR 请求失败: {e}"))?;
    let text = resp
        .into_string()
        .map_err(|e| format!("有道 OCR 响应读取失败: {e}"))?;
    parse_response(&text)
}

#[derive(Debug, Deserialize)]
struct RawResponse {
    #[serde(default, rename = "errorCode")]
    error_code: String,
    #[serde(default)]
    image: String,
}

fn parse_response(text: &str) -> Result<OcrResult, String> {
    let raw: RawResponse =
        serde_json::from_str(text).map_err(|e| format!("有道 OCR 响应解析失败: {e}"))?;
    if raw.error_code != "0" {
        return Err(format!("有道 OCR errorCode={}", raw.error_code));
    }
    if raw.image.is_empty() {
        return Err("未识别到文字".into());
    }
    Ok(OcrResult { image_base64: raw.image })
}

/// 平移自 Glance build_upload_sign：
/// md5(clientele + b64[..10] + b64.len() + b64[len-10..] + salt + SECRET)
///
/// REL-6 边界护栏：首尾固定取 10 字符，b64 少于 10 字符（≤6 字节的“图片”）
/// 会切片越界 panic。真实 PNG ≥ 8 字节签名头 → b64 ≥ 12 字符，正常路径永不
/// 触雷；极端输入显式报错走既有失败收尾（通知用户），不炸 capture-flow 线程。
fn upload_sign(png: &[u8], salt: &str) -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    if b64.len() < 10 {
        return Err(format!(
            "图片数据过小（base64 仅 {} 字符），无法构造上传签名",
            b64.len()
        ));
    }
    let digest_src = format!("{}{}{}", &b64[..10], b64.len(), &b64[b64.len() - 10..]);
    Ok(md5_hex(&format!(
        "{CLIENTELE}{digest_src}{salt}{IMAGE_TRANSLATE_SECRET}"
    )))
}

fn md5_hex(s: &str) -> String {
    // 复用既有 md5 封装（本仓库 md-5 未开 hex 特性，`{:x}` 不可用）
    crate::translate::sign::md5(s)
}

/// salt：纳秒时间戳字符串（有道仅要求唯一性；替代 Glance 的 uuid 依赖）。
fn salt_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

fn multipart_body(boundary: &str, png: &[u8], fields: &[(&str, String)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"multipartFile\"; filename=\"capture.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_hex_matches_known_vector() {
        // MD5("abc") 公认测试向量
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn upload_sign_rejects_tiny_image_without_panicking() {
        // REL-6 边界护栏：b64 不足 10 字符（≤6 字节“图片”）时旧实现固定切片
        // 直接 panic（修复前探针实跑：`end byte index 10 is out of bounds for
        // string of length 4`）。护栏后必须返回 Err，不炸 capture-flow 线程。
        assert!(matches!(upload_sign(b"", "42"), Err(_)));
        assert!(matches!(upload_sign(b"PNG", "42"), Err(_))); // b64 4 字符
        assert!(matches!(upload_sign(b"123456", "42"), Err(_))); // b64 8 字符
    }

    #[test]
    fn upload_sign_is_stable_hex_and_salt_sensitive() {
        let png = b"0123456789";
        let s1 = upload_sign(png, "42").expect("合法尺寸输入必须可签名");
        let s2 = upload_sign(png, "42").expect("合法尺寸输入必须可签名");
        let s3 = upload_sign(png, "43").expect("合法尺寸输入必须可签名");
        assert_eq!(s1, s2, "同输入同 salt 必须同签名");
        assert_ne!(s1, s3, "salt 参与签名");
        assert_eq!(s1.len(), 32);
        assert!(s1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn salt_is_nonempty_numeric() {
        let a = salt_string();
        assert!(!a.is_empty());
        assert!(a.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn multipart_body_structure() {
        let body = multipart_body(
            "BOUNDARY",
            b"\x89PNG-binary\xff",
            &[("clientele", CLIENTELE.to_string()), ("salt", "42".into())],
        );
        let s = String::from_utf8_lossy(&body);
        assert!(s.contains("--BOUNDARY\r\nContent-Disposition: form-data; name=\"clientele\"\r\n\r\ndeskdict\r\n"));
        assert!(s.contains("name=\"salt\"\r\n\r\n42\r\n"));
        // 文件段：头 + 原始字节（二进制不破坏）+ 收尾
        assert!(s.contains("name=\"multipartFile\"; filename=\"capture.png\"\r\nContent-Type: image/png\r\n\r\n"));
        // ponytail-fix: 简报笔误——b"\x89PNG-bin" 是 8 字节，windows(9) 永不相等
        assert!(body.windows(8).any(|w| w == b"\x89PNG-bin".as_slice()));
        assert!(body.ends_with(b"\r\n--BOUNDARY--\r\n"));
    }
}
