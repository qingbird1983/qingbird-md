//! 翻译 wire 事件类型：translation-partial / translation-progress /
//! translation-done 的载荷、查词增量与翻译起跑信封（serde 线上形状由本文件
//! 测试钉住）。

use crate::markdown;

#[derive(Clone, serde::Serialize)]
pub struct TranslationProgressEvt {
    pub r#gen: u64,
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, serde::Serialize)]
pub struct TranslationDoneEvt {
    pub r#gen: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translations: Option<Vec<(usize, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_bilingual: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<Vec<markdown::html::OutlineItem>>,
}

#[derive(Clone, serde::Serialize)]
pub struct TranslationPartialEvt {
    pub r#gen: u64,
    pub index: usize,
    pub text: String,
    pub from_cache: bool,
    /// 单单元裸发路径的实时增量（累积文本）：true = 前端直写灰字省略号、
    /// 不经过打字机队列；false = 完整单元（走打字动画）。from_cache 仅对
    /// 完整单元有意义，流式增量恒 false。
    pub streaming: bool,
    /// 单元翻译失败：text = 原文（前端回退显示原文并跳过打字，但照常推进
    /// 打字机放行——否则该 run 的缺失会让其后所有块永久等位，出现
    /// "前几行打字 → 停住 → done 一次性回填"）。
    pub failed: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct LookupDeltaEvt {
    pub text: String,
    pub content: String,
}

/// S5：语义核查分批进度（done/total 是**批**数——一批 ≈ max_len 字符的
/// 原文+译文，不是单元数）。前端时间线的 semantic 步骤据此显 running。
#[derive(Clone, serde::Serialize)]
pub struct ReviewProgressEvt {
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranslateStart {
    Started {
        r#gen: u64,
        /// 窗口化 run 的最小全局索引（全文=收集器首索引；空收集=0）。
        /// 兼容保留：前端打字机已改按下方 indices 序列放行（终审 C1）。
        first_index: usize,
        /// 本轮收集索引的完整文档序序列（= spawn_translation 收到的那份）。
        /// 窗口化按需/文献区段跳过使收集索引带缺口（如 [1,3,5]），打字机
        /// 按此序列放行，缺口不再被误判为"等连续前缀"而永久停摆（终审 C1）。
        indices: Vec<usize>,
        /// 与 indices 等长、一一对应：每个收集单元所属的块索引（data-bi 空间）。
        /// translation 模式 = run 所属块；bilingual 模式 = 块自身（=indices）。
        /// 前端据此把同一块的 run 组装成"整段"打字单元（对齐 qingniao 节奏）。
        indices_blocks: Vec<usize>,
    },
    Cached {
        done: TranslationDoneEvt,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_partial_evt_wire_shape() {
        let e = TranslationPartialEvt {
            r#gen: 4,
            index: 12,
            text: "译文".into(),
            from_cache: true,
            streaming: false,
            failed: false,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 4);
        assert_eq!(v["index"], 12);
        assert_eq!(v["text"], "译文");
        assert_eq!(v["from_cache"], true);
        assert_eq!(v["streaming"], false);
        assert_eq!(v["failed"], false);
    }

    #[test]
    fn translate_start_started_carries_indices() {
        // 终审 C1 回归锚点：Started 必须携带本轮收集索引序列（文档序，可带
        // 缺口）——前端打字机按此序列放行，而非"连续 +1"游标；first_index
        // 为兼容保留（= 序列首元素；空收集为 0）。
        let e = TranslateStart::Started {
            r#gen: 6,
            first_index: 1,
            indices: vec![1, 3, 5],
            indices_blocks: vec![0, 2, 2],
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "started");
        assert_eq!(v["gen"], 6);
        assert_eq!(v["first_index"], 1);
        assert_eq!(v["indices"], serde_json::json!([1, 3, 5]));
        assert_eq!(v["indices_blocks"], serde_json::json!([0, 2, 2]));
        // 全文 run：索引连续且从收集器首索引起（此处 0 起）
        let full = TranslateStart::Started {
            r#gen: 7,
            first_index: 0,
            indices: vec![0, 1, 2],
            indices_blocks: vec![0, 0, 1],
        };
        let v2 = serde_json::to_value(&full).unwrap();
        assert_eq!(v2["indices"], serde_json::json!([0, 1, 2]));
        assert_eq!(v2["indices_blocks"], serde_json::json!([0, 0, 1]));
    }

    #[test]
    fn translation_done_evt_wire_shape() {
        let e = TranslationDoneEvt {
            r#gen: 7,
            ok: true,
            translations: Some(vec![(0, "甲".into()), (1, "乙".into())]),
            error: None,
            html_original: Some(r#"<h1 id="h-1">T</h1>"#.into()),
            html_translation: Some("<p>译</p>".into()),
            html_bilingual: None,
            outline: Some(vec![markdown::html::OutlineItem {
                level: 1,
                text: "T".into(),
                id: "h-1".into(),
            }]),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 7);
        assert_eq!(v["ok"], true);
        assert_eq!(v["translations"], serde_json::json!([[0, "甲"], [1, "乙"]]));
        assert!(v.get("error").is_none());
        assert_eq!(v["html_original"], r#"<h1 id="h-1">T</h1>"#);
        assert_eq!(v["html_translation"], "<p>译</p>");
        assert!(v.get("html_bilingual").is_none());
        assert_eq!(
            v["outline"],
            serde_json::json!([{ "level": 1, "text": "T", "id": "h-1" }])
        );

        let e2 = TranslationDoneEvt {
            r#gen: 7,
            ok: false,
            translations: None,
            error: Some("已取消".into()),
            html_original: None,
            html_translation: None,
            html_bilingual: None,
            outline: None,
        };
        let v2 = serde_json::to_value(&e2).unwrap();
        assert_eq!(v2["error"], "已取消");
        assert!(v2.get("translations").is_none());
        assert!(v2.get("html_original").is_none());
        assert!(v2.get("html_bilingual").is_none());
        assert!(v2.get("outline").is_none());
    }

    #[test]
    fn windowed_done_evt_omits_html_fields() {
        let e = TranslationDoneEvt {
            r#gen: 9,
            ok: true,
            translations: Some(vec![(3, "窗".into())]),
            error: None,
            html_original: None,
            html_translation: None,
            html_bilingual: None,
            outline: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("html_original").is_none());
        assert!(v.get("html_translation").is_none());
        assert!(v.get("html_bilingual").is_none());
        assert!(v.get("outline").is_none());
        assert_eq!(v["translations"], serde_json::json!([[3, "窗"]]));
    }

    #[test]
    fn translation_progress_evt_wire_shape() {
        let e = TranslationProgressEvt {
            r#gen: 3,
            done: 2,
            total: 5,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 3);
        assert_eq!(v["done"], 2);
        assert_eq!(v["total"], 5);
    }
}
