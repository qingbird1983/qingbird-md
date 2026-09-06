//! 翻译跳过规则：参考文献区段自动跳过（qingniao 同款规则）。
//!
//! 入口标题整串命中（英文不区分大小写）→ 区段内所有块不参与翻译，
//! 直到 `级别 ≤ 入口级别` 的标题复位。判定必须与占号（html.rs bi_advance）
//! 和收集（units.rs 的 walker）共用同一状态机，三处索引空间才逐位一致。

/// 入口标题触发词（trim 后整串精确匹配；英文不区分大小写）。
const REFERENCE_TITLES: [&str; 8] = [
    "references",
    "bibliography",
    "works cited",
    "literature cited",
    "参考文献",
    "参考资料",
    "参考书目",
    "引用文献",
];

/// 每次文档遍历持有一份；沿文档序逐块 feed。
#[derive(Debug, Default, Clone)]
pub struct RefSkipState {
    in_section: bool,
    entry_level: u8,
}

impl RefSkipState {
    /// 逐块喂入：标题块传 `Some((level, 纯文本))`，其余块传 `None`。
    /// 返回 true = 本块处于参考文献区段内，不参与翻译。
    pub fn feed(&mut self, heading: Option<(u8, &str)>) -> bool {
        match heading {
            Some((level, text)) => {
                if is_reference_title(text) {
                    self.in_section = true;
                    self.entry_level = level;
                    return true; // 入口标题本身也不译
                }
                if self.in_section && level <= self.entry_level {
                    // 同级或更高级标题复位；复位标题自身重新判定（可能是新入口）
                    self.in_section = false;
                    return self.feed(Some((level, text)));
                }
                self.in_section
            }
            None => self.in_section,
        }
    }
}

fn is_reference_title(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && REFERENCE_TITLES.iter().any(|k| t.eq_ignore_ascii_case(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked_seq(items: &[(Option<u8>, &str)]) -> Vec<bool> {
        let mut st = RefSkipState::default();
        items
            .iter()
            .map(|&(lvl, txt)| st.feed(lvl.map(|l| (l, txt))))
            .collect()
    }

    #[test]
    fn h2_entry_and_same_level_reset() {
        let r = blocked_seq(&[
            (None, "Intro body"),
            (Some(2), "References"),
            (None, "Smith 2020"),
            (None, "Another entry"),
            (Some(2), "Acknowledgements"),
            (None, "Thanks body"),
        ]);
        assert_eq!(r, [false, true, true, true, false, false]);
    }

    #[test]
    fn sub_heading_inside_section_does_not_reset() {
        let r = blocked_seq(&[
            (Some(2), "References"),
            (Some(3), "Primary sources"),
            (None, "entry"),
            (Some(1), "Bibliography"), // H1 ≤ H2 复位，但自身又是入口 → true
            (None, "entry2"),
            (Some(1), "Conclusion"),
            (None, "body"),
        ]);
        assert_eq!(r, [true, true, true, true, true, false, false]);
    }

    #[test]
    fn english_case_insensitive_and_trim() {
        let r = blocked_seq(&[(Some(2), "  REFERENCES  "), (None, "x")]);
        assert_eq!(r, [true, true]);
    }

    #[test]
    fn partial_match_does_not_trigger() {
        let r = blocked_seq(&[
            (Some(2), "6.4 参考实现"),
            (None, "body"),
            (Some(2), "References and Further Reading"),
            (None, "body2"),
        ]);
        assert_eq!(r, [false, false, false, false]);
    }

    #[test]
    fn all_chinese_titles_trigger() {
        for t in ["参考文献", "参考资料", "参考书目", "引用文献"] {
            let mut st = RefSkipState::default();
            assert!(st.feed(Some((2, t))));
            assert!(st.feed(None));
        }
    }
}
