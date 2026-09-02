//! Hash/HMAC helpers used by the translation providers.
//! Ported from the Electron `src/translators/sign.js`.

use hmac::{Hmac, KeyInit, Mac};
use md5::{Digest, Md5};
use sha2::Sha256;

pub fn md5(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    hex(&h.finalize())
}

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex(&h.finalize())
}

/// HMAC-SHA256 over `data` with `key`; returns raw bytes (for Tencent TC3).
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_vector() {
        assert_eq!(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn sha256_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hmac_matches_js() {
        // Cross-check with the Node crypto output for these specific inputs.
        assert_eq!(
            hex(&hmac_sha256(b"key", b"The quick brown fox jumps over the lazy dog")),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }
}
