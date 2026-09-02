//! SSE (Server-Sent Events) frame parsing for OpenAI-compatible streaming.
//!
//! Pure, allocation-light and fully testable: feed raw byte chunks in, get
//! parsed frames out. Kept separate from the HTTP layer so the streaming
//! protocol can be exercised offline.
//!
//! Two shapes are tolerated (both occur in the wild):
//! - Standard SSE: `data: {...}\n\n` frames, terminated by `data: [DONE]`
//! - Non-SSE fallback: some vendors ignore `stream:true` and return one
//!   complete JSON body. That arrives as a single chunk with no `data:` prefix.

use serde_json::Value;

/// A parsed stream frame.
#[derive(Debug, PartialEq)]
pub enum Frame {
    /// A JSON payload (either a `data:` frame or a bare non-SSE body).
    Json(Value),
    /// The `data: [DONE]` terminator.
    Done,
}

/// Incremental SSE parser. Chunk boundaries rarely line up with frame
/// boundaries, so partial frames are buffered until the next feed.
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn new() -> Self {
        SseParser { buf: String::new() }
    }

    /// Feed a raw chunk, returning every frame that became complete.
    pub fn feed(&mut self, chunk: &str) -> Vec<Frame> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();

        // SSE frames are separated by a blank line. Keep the tail (an
        // incomplete frame) in the buffer.
        while let Some(sep) = self.buf.find("\n\n") {
            let raw: String = self.buf.drain(..sep + 2).collect();
            if let Some(f) = parse_frame(&raw) {
                out.push(f);
            }
        }

        // Non-SSE fallback: some vendors ignore `stream:true` and reply with a
        // single complete JSON body. Emit it as soon as it parses, rather than
        // waiting for a blank-line terminator that will never come.
        if self.buf.ends_with('\n') {
            let trimmed = self.buf.trim();
            if trimmed.is_empty() {
                self.buf.clear();
            } else if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                self.buf.clear();
                out.push(Frame::Json(v));
            }
        }
        out
    }

    /// Flush a trailing frame that had no blank-line terminator (some servers
    /// close the stream right after the last `data:` line).
    pub fn finish(&mut self) -> Vec<Frame> {
        if self.buf.trim().is_empty() {
            self.buf.clear();
            return Vec::new();
        }
        let raw = std::mem::take(&mut self.buf);
        parse_frame(&raw).into_iter().collect()
    }
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse one raw SSE block (`data: {...}` possibly spanning multiple `data:`
/// lines) into a [`Frame`]. Returns `None` for empty/comment blocks.
fn parse_frame(raw: &str) -> Option<Frame> {
    let mut payload = String::new();
    for line in raw.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with(':') {
            continue; // blank separator or SSE comment / heartbeat
        }
        let data = match l.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => l, // non-SSE fallback: the line *is* the payload
        };
        if !payload.is_empty() {
            payload.push('\n');
        }
        payload.push_str(data);
    }
    let payload = payload.trim();
    if payload.is_empty() {
        return None;
    }
    if payload == "[DONE]" {
        return Some(Frame::Done);
    }
    serde_json::from_str::<Value>(payload).ok().map(Frame::Json)
}

/// Extract the incremental text from a chunk object.
///
/// Covers both shapes: streaming deltas (`choices[0].delta.content`) and
/// whole-message bodies (`choices[0].message.content`) when a vendor ignores
/// `stream`. Also tolerates the bare `content` key some gateways emit.
pub fn delta_content(v: &Value) -> Option<&str> {
    v.pointer("/choices/0/delta/content")
        .or_else(|| v.pointer("/choices/0/message/content"))
        .or_else(|| v.pointer("/choices/0/text"))
        .and_then(|x| x.as_str())
}

/// Extract an error message if the frame carries one (mid-stream failures).
pub fn frame_error(v: &Value) -> Option<String> {
    v.get("error")
        .and_then(|e| e.get("message").or_else(|| e.get("msg")))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn parses_standard_sse_frames() {
        let mut p = SseParser::new();
        let f = p.feed("data: {\"a\":1}\n\ndata: {\"a\":2}\n\n");
        assert_eq!(f.len(), 2);
        assert_eq!(f[0], Frame::Json(json("{\"a\":1}")));
        assert_eq!(f[1], Frame::Json(json("{\"a\":2}")));
    }

    #[test]
    fn handles_chunk_split_mid_frame() {
        let mut p = SseParser::new();
        // A delta arrives split across three TCP reads, including inside the
        // `data:` prefix itself.
        assert!(p.feed("data: {\"choices\":[{\"delta\":{\"content\":\"hel").is_empty());
        assert!(p.feed("lo\"}]}").is_empty());
        let f = p.feed("\n\n");
        assert_eq!(f.len(), 1);
        assert_eq!(delta_content(&json_of(&f[0])).unwrap(), "hello");
    }

    fn json_of(f: &Frame) -> Value {
        match f {
            Frame::Json(v) => v.clone(),
            Frame::Done => panic!("expected Json"),
        }
    }

    #[test]
    fn recognizes_done_terminator() {
        let mut p = SseParser::new();
        let f = p.feed("data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(f.len(), 2);
        assert_eq!(f[1], Frame::Done);
    }

    #[test]
    fn finish_flushes_frame_without_blank_line() {
        let mut p = SseParser::new();
        assert!(p.feed("data: {\"a\":9}").is_empty());
        let f = p.finish();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0], Frame::Json(json("{\"a\":9}")));
        assert!(p.finish().is_empty(), "finish is idempotent");
    }

    #[test]
    fn non_sse_fallback_parses_bare_json() {
        let mut p = SseParser::new();
        let f = p.feed("{\"choices\":[{\"message\":{\"content\":\"hi\"}}]}\n");
        assert_eq!(f.len(), 1, "whole body emitted without a blank line");
        assert_eq!(delta_content(&json_of(&f[0])).unwrap(), "hi");
    }

    #[test]
    fn bare_json_split_across_reads_waits_for_completeness() {
        let mut p = SseParser::new();
        assert!(p.feed("{\"choices\":[").is_empty());
        assert!(p.feed("{\"message\":{\"content\":\"hi\"}}]\n").len() == 1);
    }

    #[test]
    fn sse_data_line_without_terminator_is_not_mistaken_for_body() {
        let mut p = SseParser::new();
        // A lone `data:` line has a newline but is not valid JSON, so it must
        // be held until the blank line arrives.
        assert!(p.feed("data: {\"a\":1}\n").is_empty());
        assert_eq!(p.feed("\n").len(), 1);
    }

    #[test]
    fn ignores_heartbeat_comments_and_blank_lines() {
        let mut p = SseParser::new();
        let f = p.feed(": ping\n\n\n\ndata: {\"a\":1}\n\n");
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn multi_line_data_is_concatenated() {
        let mut p = SseParser::new();
        let f = p.feed("data: {\"a\":\ndata: 1}\n\n");
        assert_eq!(f, vec![Frame::Json(json("{\"a\":1}"))]);
    }

    #[test]
    fn malformed_json_frame_is_skipped_not_fatal() {
        let mut p = SseParser::new();
        let f = p.feed("data: not-json\n\ndata: {\"a\":1}\n\n");
        assert_eq!(f.len(), 1, "bad frame dropped, good frame survives");
    }

    #[test]
    fn delta_content_prefers_streaming_shape() {
        let v = json("{\"choices\":[{\"delta\":{\"content\":\"x\"}}]}");
        assert_eq!(delta_content(&v), Some("x"));
        let v2 = json("{\"choices\":[{\"message\":{\"content\":\"y\"}}]}");
        assert_eq!(delta_content(&v2), Some("y"));
        let v3 = json("{\"choices\":[{\"text\":\"z\"}]}");
        assert_eq!(delta_content(&v3), Some("z"));
        let v4 = json("{\"choices\":[{}]}");
        assert_eq!(delta_content(&v4), None);
    }

    #[test]
    fn frame_error_reads_message() {
        let v = json("{\"error\":{\"message\":\"rate limited\"}}");
        assert_eq!(frame_error(&v).unwrap(), "rate limited");
        assert!(frame_error(&json("{\"a\":1}")).is_none());
    }
}
