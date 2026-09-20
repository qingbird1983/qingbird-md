//! 载荷组装：done pairs 归并与首个错误挑选、三次渲染产出 html 三件套、
//! 缓存全命中的同步 done 事件与窗口化整篇扫荡。

use std::collections::HashMap;

use crate::markdown;
use crate::translate::cache::Cache;
use crate::translate::engine::TargetLang;

use super::events::TranslationDoneEvt;

pub(crate) fn done_payload_parts(
    indices: &[usize],
    results: &[Result<String, String>],
) -> (bool, Vec<(usize, String)>, Option<String>) {
    let mut pairs = Vec::new();
    let mut err = None;
    for (i, r) in results.iter().enumerate() {
        match r {
            Ok(v) => pairs.push((indices[i], v.clone())),
            Err(e) => {
                if err.is_none() {
                    err = Some(e.clone());
                }
            }
        }
    }
    pairs.sort_by_key(|p| p.0);
    (err.is_none(), pairs, err)
}

pub(crate) fn html_payload_parts(
    content: &str,
    trans: &HashMap<usize, String>,
    bilingual_batch: bool,
    target: TargetLang,
) -> (String, Option<String>, Option<String>, Vec<markdown::html::OutlineItem>) {
    // ⚠️ 三次 render_html 传**同一个** target：orig 里的 data-bi 锚点会被前端
    // 当作 partial 事件的 key，方向与收集侧不一致就会错位。
    let orig = markdown::html::render_html(content, &HashMap::new(), false, target);
    let (html_translation, html_bilingual) = if bilingual_batch {
        (None, Some(markdown::html::render_html(content, trans, true, target).html))
    } else {
        (Some(markdown::html::render_html(content, trans, false, target).html), None)
    };
    (orig.html, html_translation, html_bilingual, orig.outline)
}

/// 窗口化缓存全命中的整篇扫荡：与该 run 模式同一索引空间收集全文可译单元，
/// 逐单元查缓存，命中即带回。窗口化 precheck 只回窗口 pairs 时，文档其余
/// 部分的缓存命中要靠滚动逐窗补齐——第二击翻译（缓存全命中）只换视口那
/// 几行（用户实测 bug）；扫荡对让前端 merge+instant+canonical 重建一次
/// 整屏瞬时替换（验收点 5）。未命中块不带回，维持原文走视口运行补齐。
pub(super) fn sweep_cached_pairs(
    snapshot: &Cache,
    provider: &str,
    variant: &str,
    blocks: &[markdown::model::Block],
    bilingual: bool,
    target: TargetLang,
) -> Vec<(usize, String)> {
    let units = if bilingual {
        markdown::units::collect_translatable(blocks, target)
    } else {
        markdown::units::collect_text_runs(blocks, target)
    };
    units
        .into_iter()
        .filter_map(|(i, t)| {
            snapshot
                .get(&Cache::key(provider, variant, &t))
                .map(|s| (i, s.to_string()))
        })
        .collect()
}

pub(super) fn cached_done_evt(
    provider: &str,
    variant: &str,
    snapshot: &Cache,
    indices: &[usize],
    texts: &[String],
    content: &str,
    bilingual_batch: bool,
    windowed: bool,
    target: TargetLang,
) -> Option<TranslationDoneEvt> {
    let results: Vec<Result<String, String>> = texts
        .iter()
        .map(|t| {
            snapshot
                .get(&Cache::key(provider, variant, t))
                .map(|s| s.to_string())
                .ok_or_else(|| "缓存缺失".to_string())
        })
        .collect();
    let (ok, pairs, _) = done_payload_parts(indices, &results);
    if !ok {
        return None;
    }
    let map: HashMap<usize, String> = pairs.iter().cloned().collect();
    let (html_original, html_translation, html_bilingual, outline) = if windowed {
        // 窗口化载荷不携带整树 html：后端只有窗口 pairs，整树渲染会把
        // 窗口外已译块打回原文。显示由前端 patch 承担。
        (None, None, None, None)
    } else {
        let (html_original, html_translation, html_bilingual, outline) =
            html_payload_parts(content, &map, bilingual_batch, target);
        (Some(html_original), html_translation, html_bilingual, Some(outline))
    };
    Some(TranslationDoneEvt {
        r#gen: 0,
        ok: true,
        translations: Some(pairs),
        error: None,
        html_original,
        html_translation,
        html_bilingual,
        outline,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本文件这些用例验证的是缓存命中 / 索引空间 / wire 形状，结论与方向无关，
    /// 一律在 zh 下成立。**方向切换本身由 policy.rs / units.rs / providers.rs
    /// 的专用用例覆盖**（含 bar 那一侧的前端用例）。
    const ZH: TargetLang = TargetLang::Zh;

    // ---- 方向薄包装 ----
    // 本文件这些测试验证的是缓存命中 / 索引空间 / wire 形状，结论与方向无关，
    // 一律在 zh 下成立。用本地遮蔽（本地项优先于 glob import）把方向钉成常量：
    // 省掉十几处字面量，同时让「本文件不覆盖方向切换」在签名上可见——方向本身
    // 由 engine.rs / units.rs 的专用测试覆盖。生产调用点仍必须显式传方向。
    fn html_payload_parts(
        content: &str,
        trans: &HashMap<usize, String>,
        bilingual_batch: bool,
    ) -> (String, Option<String>, Option<String>, Vec<markdown::html::OutlineItem>) {
        super::html_payload_parts(content, trans, bilingual_batch, ZH)
    }

    fn cached_done_evt(
        provider: &str,
        variant: &str,
        snapshot: &Cache,
        indices: &[usize],
        texts: &[String],
        content: &str,
        bilingual_batch: bool,
        windowed: bool,
    ) -> Option<TranslationDoneEvt> {
        super::cached_done_evt(
            provider,
            variant,
            snapshot,
            indices,
            texts,
            content,
            bilingual_batch,
            windowed,
            ZH,
        )
    }

    fn sweep_cached_pairs(
        snapshot: &Cache,
        provider: &str,
        variant: &str,
        blocks: &[markdown::model::Block],
        bilingual: bool,
    ) -> Vec<(usize, String)> {
        super::sweep_cached_pairs(snapshot, provider, variant, blocks, bilingual, ZH)
    }

    #[test]
    fn done_payload_parts_sorts_pairs_and_picks_first_error() {
        let indices = [5usize, 2, 9];
        let results = vec![
            Ok("五".to_string()),
            Err("已取消".to_string()),
            Ok("九".to_string()),
        ];
        let (ok, pairs, err) = done_payload_parts(&indices, &results);
        assert!(!ok);
        assert_eq!(err.as_deref(), Some("已取消"));
        assert_eq!(pairs, vec![(5usize, "五".into()), (9usize, "九".into())]);

        let (_, pairs2, _) =
            done_payload_parts(&[3usize, 1], &[Ok("乙".into()), Ok("甲".into())]);
        assert_eq!(pairs2, vec![(1usize, "甲".into()), (3usize, "乙".into())]);
    }

    #[test]
    fn cached_precheck_returns_payload_only_on_full_hit() {
        let mut c = Cache::new();
        c.set(Cache::key("p", "", "a"), "甲".into());
        c.set(Cache::key("p", "", "b"), "乙".into());
        let evt = cached_done_evt(
            "p",
            "",
            &c,
            &[0, 1],
            &["a".into(), "b".into()],
            "# t\n\na b",
            false,
            false,
        )
        .expect("全命中应返回同步产物");
        assert!(evt.ok);
        assert_eq!(
            evt.translations,
            Some(vec![(0usize, "甲".into()), (1usize, "乙".into())])
        );
        assert!(evt.html_translation.is_some());
        assert!(evt.html_bilingual.is_none());
        assert!(evt.html_original.is_some());
        assert!(evt.outline.is_some());
        let evt2 = cached_done_evt("p", "", &c, &[0], &["a".into()], "a", true, false)
            .expect("全命中");
        assert!(evt2.html_bilingual.is_some() && evt2.html_translation.is_none());
        assert!(
            cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "x".into()], "# t", false, false)
                .is_none()
        );
        assert!(
            cached_done_evt("q", "", &c, &[0], &["a".into()], "# t", false, false).is_none()
        );
        c.set(Cache::key("llm", "old-model@v1", "a"), "旧译文".into());
        assert!(
            cached_done_evt("llm", "old-model@v1", &c, &[0], &["a".into()], "# t", false, false)
                .is_some()
        );
        assert!(
            cached_done_evt("llm", "new-model@v1", &c, &[0], &["a".into()], "# t", false, false)
                .is_none(),
            "换模型必须 miss"
        );
        assert!(cached_done_evt("p", "", &c, &[], &[].to_vec(), "# t", false, false).is_some());
        let evt_w = cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "b".into()], "# t\n\na b", false, true)
            .expect("窗口化全命中");
        assert!(evt_w.html_original.is_none());
        assert!(evt_w.html_translation.is_none());
        assert!(evt_w.html_bilingual.is_none());
        assert!(evt_w.outline.is_none());
        assert_eq!(evt_w.translations, Some(vec![(0usize, "甲".into()), (1usize, "乙".into())]));
    }

    #[test]
    fn sweep_cached_pairs_returns_whole_document_hits() {
        // 窗口化缓存全命中的扫荡：整篇收集（与窗口同一模式索引空间）逐单元查
        // 缓存，命中即带回——第二击翻译时前端凭完整 pairs 整屏瞬时替换
        //（验收点 5），而非只补视口窗口那几行。
        let blocks = markdown::parse_blocks("One\n\nTwo\n\nThree");
        let mut c = Cache::new();
        c.set(Cache::key("p", "", "One"), "甲".into());
        c.set(Cache::key("p", "", "Two"), "乙".into());
        c.set(Cache::key("p", "", "Three"), "丙".into());
        assert_eq!(
            sweep_cached_pairs(&c, "p", "", &blocks, false),
            vec![(0usize, "甲".into()), (1usize, "乙".into()), (2usize, "丙".into())]
        );
        // 部分命中：只带回缓存过的单元，未命中块留给滚动触发的视口运行
        let mut c2 = Cache::new();
        c2.set(Cache::key("p", "", "Two"), "乙".into());
        assert_eq!(sweep_cached_pairs(&c2, "p", "", &blocks, false), vec![(1usize, "乙".into())]);
        // bilingual：块空间（data-bi）索引；跳过区段/纯中文块不出现
        let blocks_b = markdown::parse_blocks("# Eng\n\nAnother one\n\n## References\n\n**X** 2020.");
        let mut c3 = Cache::new();
        c3.set(Cache::key("p", "", "Eng"), "标题".into());
        c3.set(Cache::key("p", "", "Another one"), "另一段".into());
        assert_eq!(
            sweep_cached_pairs(&c3, "p", "", &blocks_b, true),
            vec![(0usize, "标题".into()), (1usize, "另一段".into())]
        );
        // 换模型 variant：缓存键不匹配 → 空
        assert!(sweep_cached_pairs(&c3, "p", "other@v1", &blocks_b, true).is_empty());
    }

    #[test]
    fn html_payload_parts_follow_batch_index_space() {
        let mut m = HashMap::new();
        m.insert(0usize, "标题".into());
        m.insert(1usize, "你好".into());
        m.insert(2usize, "世界".into());
        m.insert(3usize, "更多".into());
        let (html_original, tr, bi, outline) =
            html_payload_parts("# Ti\n\nHello **world** more", &m, false);
        assert!(html_original
            .contains(r#"<h1 id="h-1" data-bi="0"><span data-ri="0">Ti</span></h1>"#));
        assert!(html_original.contains(
            r#"<p data-bi="1"><span data-ri="1">Hello </span><strong><span data-ri="2">world</span></strong><span data-ri="3"> more</span></p>"#
        ));
        let tr = tr.expect("translation batch must carry substituted form");
        assert!(tr.contains(r#"<h1 id="h-1" data-bi="0"><span data-ri="0">标题</span></h1>"#));
        assert!(tr.contains(
            r#"<p data-bi="1"><span data-ri="1">你好</span><strong><span data-ri="2">世界</span></strong><span data-ri="3">更多</span></p>"#
        ));
        assert!(bi.is_none());
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].text, "Ti");
        assert_eq!(outline[0].id, "h-1");

        let mut b = HashMap::new();
        b.insert(0usize, "中文标题".into());
        b.insert(1usize, "中文正文".into());
        let (orig2, tr2, bi2, _) =
            html_payload_parts("# Ti\n\nHello **world** more", &b, true);
        assert!(tr2.is_none());
        let bi2 = bi2.expect("bilingual batch must carry bilingual form");
        assert!(bi2.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(bi2.contains(r#"<div class="tr-box">中文正文</div>"#));
        assert!(orig2.contains(
            r#"<p data-bi="1"><span data-ri="1">Hello </span><strong><span data-ri="2">world</span></strong><span data-ri="3"> more</span></p>"#
        ));
    }
}
