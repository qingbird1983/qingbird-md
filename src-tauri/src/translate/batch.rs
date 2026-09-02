//! Batch protocol: pack several text units into one request and recover them
//! from a *streaming* response.
//!
//! The previous implementation joined units with `\n` and required the reply's
//! line count to match exactly — any extra blank line, list marker or merged
//! paragraph discarded the whole batch and fell back to N *serial* requests.
//! Since LLMs add that decoration almost every time, the slow path was the
//! normal path.
//!
//! This module replaces it with explicit delimiters, mirroring the block-batch
//! protocol from the core design doc:
//!
//! ```text
//! <<<B0>>>first unit<<<END>>>
//! <<<B1>>>second unit<<<END>>>
//! ```
//!
//! The decoder is incremental: it consumes stream deltas and emits a unit as
//! soon as its closing marker arrives, so the UI can render unit 0 while the
//! model is still generating unit 7.

const OPEN_PREFIX: &str = "<<<B";
const OPEN_SUFFIX: &str = ">>>";
const CLOSE: &str = "<<<END>>>";

/// Instruction appended to the system prompt when a batch carries more than
/// one unit. Kept here so the protocol text and the parser cannot drift apart.
pub const INSTRUCTION: &str = "输入由若干文本块组成，每块形如 <<<B序号>>>原文<<<END>>>。\
对每一块，原样输出 <<<B序号>>> 后跟该块的译文，以 <<<END>>> 结束。\
不要改动序号，不要合并或拆分块，不要输出标记以外的任何文字。";

/// Pack units into a single request payload.
///
/// A single unit is sent bare — no markers, no protocol overhead, and the
/// caller can use the raw reply verbatim.
pub fn encode(units: &[(usize, String)]) -> String {
    if units.len() == 1 {
        return units[0].1.clone();
    }
    let mut out = String::new();
    for (slot, (_, text)) in units.iter().enumerate() {
        out.push_str(OPEN_PREFIX);
        out.push_str(&slot.to_string());
        out.push_str(OPEN_SUFFIX);
        out.push_str(text);
        out.push_str(CLOSE);
        out.push('\n');
    }
    out
}

/// Strip decoration models like to wrap block content in (`**`, backticks).
fn clean_unit(s: &str) -> String {
    s.trim()
        .trim_matches(|c: char| matches!(c, '*' | '`' | '#' | '~'))
        .trim()
        .to_string()
}

/// Map recovered `(slot, text)` pairs back onto the batch's unit order.
///
/// A returned `None` means that unit must be re-requested. Models are not
/// reliable at counting: they may emit 1-based indices, repeat one, or drop
/// one. This resolves the common cases (exact 0-based, exact 1-based) and
/// otherwise trusts arrival order, but never invents content — unmatched slots
/// stay `None` so the caller can retry them.
pub fn map_slots(recovered: &[(usize, String)], expected: usize) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; expected];
    if expected == 0 || recovered.is_empty() {
        return out;
    }

    // True if every recovered slot lands in `shift..shift+expected` exactly once.
    let is_permutation = |shift: usize| -> bool {
        let mut seen = vec![false; expected];
        for (slot, _) in recovered {
            if *slot < shift || *slot - shift >= expected {
                return false;
            }
            let i = slot - shift;
            if seen[i] {
                return false;
            }
            seen[i] = true;
        }
        true
    };

    let shift = if is_permutation(0) {
        Some(0)
    } else if is_permutation(1) {
        Some(1) // models frequently count from 1
    } else {
        None
    };

    match shift {
        Some(s) => {
            for (slot, text) in recovered {
                out[slot - s] = Some(text.clone());
            }
        }
        None => {
            for (i, (_, text)) in recovered.iter().enumerate().take(expected) {
                out[i] = Some(text.clone());
            }
        }
    }
    out
}

/// Incremental decoder for the [`INSTRUCTION`] protocol.
pub struct BatchDecoder {
    buf: String,
    fed_len: usize,
    recovered: usize,
}

impl BatchDecoder {
    pub fn new() -> Self {
        BatchDecoder { buf: String::new(), fed_len: 0, recovered: 0 }
    }

    /// Feed a stream delta; returns every unit that just became complete.
    pub fn push(&mut self, delta: &str) -> Vec<(usize, String)> {
        self.fed_len += delta.len();
        self.buf.push_str(delta);
        self.drain(false)
    }

    /// Flush trailing content once the stream ends: an unterminated final unit
    /// is recovered best-effort rather than thrown away.
    pub fn finish(&mut self) -> Vec<(usize, String)> {
        self.drain(true)
    }

    /// True when the model produced output that never resolved into a unit —
    /// the signal that it ignored the protocol entirely.
    pub fn ignored_protocol(&self) -> bool {
        self.fed_len > 0 && self.recovered == 0
    }

    /// True when unconsumed text remains in the buffer (a partial unit, or
    /// preamble the model emitted ahead of the markers).
    pub fn has_leftover(&self) -> bool {
        !self.buf.trim().is_empty()
    }

    /// How much raw text has been fed in, for diagnostics.
    pub fn fed_len(&self) -> usize {
        self.fed_len
    }

    fn drain(&mut self, flush: bool) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        while let Some(u) = self.next_unit(flush) {
            out.push(u);
        }
        self.recovered += out.len();
        out
    }

    /// Take one unit off the front of the buffer, or `None` when more data is
    /// needed (or the buffer is exhausted, when flushing). Invalid markers are
    /// consumed and skipped internally, so this never spins.
    fn next_unit(&mut self, flush: bool) -> Option<(usize, String)> {
        loop {
            let open = match self.buf.find(OPEN_PREFIX) {
                Some(p) => p,
                None => {
                    if flush {
                        self.buf.clear();
                    } else {
                        self.buf = retain_partial_tail(&self.buf, OPEN_PREFIX);
                    }
                    return None;
                }
            };
            if open > 0 {
                self.buf.drain(..open); // discard preamble before the marker
            }

            let after_prefix = OPEN_PREFIX.len();
            let close_open = match self.buf[after_prefix..].find(OPEN_SUFFIX) {
                Some(p) => after_prefix + p,
                None => {
                    if flush {
                        self.buf.clear();
                    }
                    return None; // marker split across deltas
                }
            };

            let digits = self.buf[after_prefix..close_open]
                .trim_matches(|c: char| !c.is_ascii_digit());
            let slot: usize = match digits.parse() {
                Ok(n) => n,
                Err(_) => {
                    // Complete but invalid marker (e.g. `<<<BLOCK>>>`): drop
                    // it and keep scanning for a real one.
                    self.buf.drain(..close_open + OPEN_SUFFIX.len());
                    continue;
                }
            };

            let content_start = close_open + OPEN_SUFFIX.len();
            match self.buf[content_start..].find(CLOSE) {
                Some(rel) => {
                    let end = content_start + rel;
                    let text = clean_unit(&self.buf[content_start..end]);
                    self.buf.drain(..end + CLOSE.len());
                    return Some((slot, text));
                }
                None => {
                    if flush {
                        let text = clean_unit(&self.buf[content_start..]);
                        self.buf.clear();
                        return if text.is_empty() { None } else { Some((slot, text)) };
                    }
                    return None; // closing marker hasn't arrived yet
                }
            }
        }
    }
}

impl Default for BatchDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Keep only the longest trailing slice of `buf` that could still grow into
/// `marker`, so a marker split across two deltas survives.
fn retain_partial_tail(buf: &str, marker: &str) -> String {
    for k in (1..marker.len()).rev() {
        if buf.ends_with(&marker[..k]) {
            return buf[buf.len() - k..].to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(n: usize) -> Vec<(usize, String)> {
        (0..n).map(|i| (i * 10, format!("unit{i}"))).collect()
    }

    #[test]
    fn single_unit_is_sent_bare() {
        assert_eq!(encode(&[(3, "hello".into())]), "hello");
    }

    #[test]
    fn multi_unit_uses_numbered_slots() {
        assert_eq!(
            encode(&units(2)),
            "<<<B0>>>unit0<<<END>>>\n<<<B1>>>unit1<<<END>>>\n"
        );
    }

    #[test]
    fn decodes_when_every_delta_is_one_char() {
        let payload = "<<<B0>>>AAA<<<END>>>\n<<<B1>>>BBB<<<END>>>\n";
        let mut d = BatchDecoder::new();
        let mut got = Vec::new();
        for c in payload.chars() {
            got.extend(d.push(&c.to_string()));
        }
        got.extend(d.finish());
        assert_eq!(got, vec![(0usize, "AAA".into()), (1usize, "BBB".into())]);
    }

    #[test]
    fn emits_each_unit_as_soon_as_it_closes() {
        let mut d = BatchDecoder::new();
        assert_eq!(d.push("<<<B0>>>AAA<<<END>>>").len(), 1, "unit 0 out immediately");
        assert!(d.push("\n<<<B1>>>B").is_empty(), "unit 1 still open");
        let rest = d.push("BB<<<END>>>\n");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].1, "BBB");
        assert!(d.finish().is_empty());
    }

    #[test]
    fn tolerates_preamble_blank_lines_and_list_markers() {
        let mut d = BatchDecoder::new();
        let out = d.push("好的，翻译如下：\n\n1. <<<B0>>>AAA<<<END>>>\n2. <<<B1>>>BBB<<<END>>>\n");
        assert_eq!(out.len(), 2, "decoration before markers is discarded");
        assert_eq!(out[0].1, "AAA");
        assert_eq!(out[1].1, "BBB");
    }

    #[test]
    fn tolerates_bold_wrapped_markers_and_blank_lines_between_units() {
        let mut d = BatchDecoder::new();
        let out = d.push("**<<<B0>>>**AAA<<<END>>>\n\n**<<<B1>>>**BBB<<<END>>>\n");
        assert_eq!(out, vec![(0usize, "AAA".into()), (1usize, "BBB".into())]);
    }

    #[test]
    fn multi_line_unit_content_is_preserved() {
        let mut d = BatchDecoder::new();
        let out = d.push("<<<B0>>>line one\nline two<<<END>>>\n<<<B1>>>B<<<END>>>\n");
        assert_eq!(out[0].1, "line one\nline two");
        assert_eq!(out[1].1, "B");
    }

    #[test]
    fn flush_recovers_truncated_final_unit() {
        let mut d = BatchDecoder::new();
        let out = d.push("<<<B0>>>AAA<<<END>>>\n<<<B1>>>part");
        assert_eq!(out, vec![(0usize, "AAA".into())], "closed unit arrives now");
        assert_eq!(d.finish(), vec![(1usize, "part".into())], "open unit flushed");
    }

    #[test]
    fn garbage_marker_without_digits_is_skipped() {
        let mut d = BatchDecoder::new();
        let out = d.push("<<<BLOCK>>>ignored<<<END>>>\n<<<B0>>>AAA<<<END>>>\n");
        assert_eq!(out, vec![(0usize, "AAA".into())]);
    }

    #[test]
    fn marker_split_across_deltas_survives() {
        let mut d = BatchDecoder::new();
        assert!(d.push("noise <<<").is_empty());
        assert_eq!(d.push("B0>>>AAA<<<END>>>").len(), 1);
    }

    #[test]
    fn ignored_protocol_is_detected_from_output_with_no_units() {
        let mut d = BatchDecoder::new();
        assert!(d.push("Sure! Here is the translation.").is_empty());
        assert!(d.ignored_protocol(), "prose with no markers = protocol ignored");
        let mut ok = BatchDecoder::new();
        ok.push("<<<B0>>>A<<<END>>>");
        assert!(!ok.ignored_protocol(), "a recovered unit means it worked");
    }

    #[test]
    fn preamble_is_discarded_not_reported_as_content() {
        let mut d = BatchDecoder::new();
        let out = d.push("以下是译文：\n<<<B0>>>AAA<<<END>>>\n");
        assert_eq!(out, vec![(0usize, "AAA".into())]);
        assert!(!d.has_leftover(), "preamble cleared, buffer clean");
    }

    // ---- slot mapping ----

    #[test]
    fn map_slots_handles_zero_based_exact() {
        let got = vec![(1usize, "B".into()), (0usize, "A".into())];
        assert_eq!(map_slots(&got, 2), vec![Some("A".into()), Some("B".into())]);
    }

    #[test]
    fn map_slots_handles_one_based_output() {
        let got = vec![(1usize, "A".into()), (2usize, "B".into())];
        assert_eq!(
            map_slots(&got, 2),
            vec![Some("A".into()), Some("B".into())],
            "1-based indices are shifted down"
        );
    }

    #[test]
    fn map_slots_falls_back_to_arrival_order() {
        let got = vec![(7usize, "A".into()), (9usize, "B".into())];
        assert_eq!(map_slots(&got, 2), vec![Some("A".into()), Some("B".into())]);
    }

    #[test]
    fn map_slots_leaves_missing_units_as_none() {
        let got = vec![(0usize, "A".into())];
        assert_eq!(map_slots(&got, 3), vec![Some("A".into()), None, None]);
    }

    #[test]
    fn map_slots_handles_empty_and_zero() {
        assert_eq!(map_slots(&[], 2), vec![None, None]);
        assert!(map_slots(&[(0, "A".into())], 0).is_empty());
    }
}
