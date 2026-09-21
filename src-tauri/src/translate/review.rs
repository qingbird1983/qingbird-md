//! AI 语义核查（S5 / correctness 第 4 步 17–21）。
//!
//! 确定性检查（`check.rs`）管「结构坏没坏」；本模块管「译得对不对」——
//! 术语一致、指代、语域、数字专名、句法崩坏。让 AI **只出问题清单**，
//! 不重写译文：重写破坏术语一致性、不可审计、引入新错（correctness §L2），
//! 用户逐条接受/拒绝，每条可追溯。
//!
//! 红线：
//! * 结果**不进 Cache**——核查是「当前文档 × 当前译文表 × 当前 prompt」的
//!   一次性判定，入缓存只会把调参归因搅浑（correctness 红线 7）。
//! * **锁定 `llm`**：凭据固定取 `providers["llm"]` 那份（前端 llmReady 门 +
//!   本模块双重校验），命令层连 provider 入参都不设——不给他源留口子
//!   （correctness §七.1 R2：绝不静默降级）。
//! * prompt 带版本指纹（[`PROMPT_FINGERPRINT`]），随结果返回——将来调参可归因。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{Value, json};

use super::engine::TargetLang;
use super::http::HttpClient;
use super::openai::{ChatRequest, chat_stream, strip_fence};
use super::providers::Creds;
use super::providers_meta;

use crate::markdown::model::parse_blocks;
use crate::markdown::units::{collect_text_runs, collect_translatable};

/// prompt 指纹：改 prompt 或解析规则时 +1，随 [`ReviewOutcome`] 返回前端
/// （展示在时间线 detail，调参前后的问题数变化才有归因依据）。
pub const PROMPT_FINGERPRINT: &str = "review-v1";

/// 单批 90s：一批最多 max_len(3000) 字符的原文+译文，清单式输出不短；
/// 比划词宽一个量级，但仍受 ChatRequest 超时兜底。
const TIMEOUT_MS: u64 = 90_000;
/// 单批响应 token 上限：被截断的 JSON 会让整批白跑，宁可给宽。
const MAX_TOKENS: u32 = 3000;

/// 语义问题类型白名单：decode 强校验，模型漂移出新值只丢该条不连坐。
const KINDS: &[&str] = &[
    "term_inconsistency",
    "pronoun_reference",
    "register",
    "number_propernoun",
    "syntax_breakdown",
];
const SEVERITIES: &[&str] = &["high", "medium", "low"];
/// 单条问题**恰好**六个键：多键少键都丢（借鉴 assertAllowedKeys 的严格口径）。
const ISSUE_KEYS: &[&str] = &["run", "kind", "severity", "current", "suggested", "reason"];

const SYSTEM: &str = r#"你是译文的语义核查员。输入 JSON 含 dir（翻译方向）与 units（已翻译单元：id/src/dst）。只找语义层问题：术语一致、指代、语域、数字与专名、句法通顺。Markdown 标记与结构由确定性检查负责，不要报告。
只输出一个 JSON 对象，不要代码块、不要解释文字：
{"issues":[{"run":单元id,"kind":"枚举","severity":"high|medium|low","current":"译文现状摘句","suggested":"建议改法","reason":"一句话理由"}]}
规则：
1. run 原样使用输入单元的 id，禁止编造。
2. kind 只能取：term_inconsistency（同一概念前后译法不一）/ pronoun_reference（指代不清或有误）/ register（语域语气与文档不符）/ number_propernoun（数字、专名、单位译错）/ syntax_breakdown（译文句法崩坏读不通）。
3. severity：high=错误必须改；medium=明显瑕疵；low=可改进。
4. current 摘自 dst 原文（≤60 字）；suggested 给最小修改，不要重写整句（≤120 字）；reason 用一句中文（≤60 字）。
5. 只报有把握的问题；没有问题输出 {"issues":[]}。
6. 若输入含 followup（用户追问），围绕追问重点复查相关单元，但只报符合上述规则的问题。"#;

/// 一条语义问题。线上形状由前端 `src/types/ipc.ts` 的 `ReviewIssue` 镜像，
/// 两侧同形（与 `check::Issue` 同规矩）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiIssue {
    /// 与 `translations` 同键空间的单元索引（采集器与 check 同一条 walk）。
    pub run: usize,
    pub kind: String,
    pub severity: String,
    /// 译文现状摘句（模型引用，仅展示）。
    pub current: String,
    /// 建议改法（用户「接受」时写回翻译表的内容）。
    pub suggested: String,
    pub reason: String,
}

/// 一次语义核查的完整产出。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewOutcome {
    pub issues: Vec<AiIssue>,
    pub fingerprint: String,
    pub batch_total: usize,
    /// 解析失败/请求失败的批数——部分失败时前端在时间线明示「N 批失败」。
    pub batch_failed: usize,
    /// 实际使用的模型（`review_model` 优先，留空回落主模型）。
    pub model: String,
}

/// 语义核查主入口。
///
/// `on_progress(done, total)` 以**批**为单位回调（一批 ≈ max_len 字符），
/// 起跑即回调 `(0, total)`，此后每轮并发跑完推一次。`cancel` 与翻译/查词
/// 共享同一旗标（REL-7 同规矩）：置位后不再发新批，在途批由
/// `CancelableClient` 在流式行边界掐断。
pub fn review_semantic(
    content: &str,
    translations: &HashMap<usize, String>,
    mode: &str,
    target_lang: &str,
    instruction: Option<&str>,
    creds: &Creds,
    http: &(dyn HttpClient + Sync),
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
) -> Result<ReviewOutcome, String> {
    let base = creds
        .get("baseUrl")
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_default();
    if base.is_empty() {
        return Err("请先在「设置」中填写自定义大模型的 API 地址".to_string());
    }
    let model = resolve_model(creds);
    if model.is_empty() {
        return Err("请先在「设置」中填写模型名".to_string());
    }
    let api_key = creds.get("apiKey").unwrap_or_default().to_string();

    let items = reviewable_items(content, translations, mode, target_lang);
    let meta = providers_meta::get("llm");
    let max_len = meta.map(|m| m.max_len).unwrap_or(3000);
    let conc = meta.map(|m| m.max_concurrency).unwrap_or(6).max(1);

    let batches = pack_items(items, max_len);
    let total = batches.len();
    if total > 0 {
        on_progress(0, total);
    }
    let mut issues: Vec<AiIssue> = Vec::new();
    let mut batch_failed = 0usize;
    let mut first_err: Option<String> = None;
    let mut done = 0usize;
    for round in batches.chunks(conc) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let base_ref = &base;
        let key_ref = &api_key;
        let model_ref = &model;
        let results: Vec<Result<Vec<AiIssue>, String>> = std::thread::scope(|s| {
            let handles: Vec<_> = round
                .iter()
                .map(|b| {
                    let ids: HashSet<usize> = b.iter().map(|(i, _, _)| *i).collect();
                    let payload = build_payload(b, target_lang, instruction);
                    s.spawn(move || {
                        run_batch(base_ref, key_ref, model_ref, &payload, &ids, http, cancel)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().map_err(|_| "核查线程崩溃".to_string()).and_then(|r| r))
                .collect()
        });
        for r in results {
            match r {
                Ok(mut v) => issues.append(&mut v),
                Err(e) => {
                    batch_failed += 1;
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
        }
        done += round.len();
        on_progress(done, total);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("核查已取消".to_string());
    }
    if total > 0 && batch_failed == total {
        return Err(first_err.unwrap_or_else(|| "核查请求全部失败".to_string()));
    }
    Ok(ReviewOutcome {
        issues,
        fingerprint: PROMPT_FINGERPRINT.to_string(),
        batch_total: total,
        batch_failed,
        model,
    })
}

/// 模型选择：`review_model` 优先，留空回落主模型。与划词相反的取舍：
/// 核查要质量、不敏感于延迟，回落主模型就是合理默认——所以字段是可选项，
/// 不催用户单独配置。
fn resolve_model(creds: &Creds) -> String {
    let m = creds.get("review_model").map(|s| s.trim()).unwrap_or_default();
    if !m.is_empty() {
        return m.to_string();
    }
    creds.get("model").map(|s| s.trim()).unwrap_or_default().to_string()
}

/// 采集可核查单元：与 `check.rs` 同一条 walk、同一键空间（P0-2 口径）。
/// 只带**有译文且不是原文回显**的单元——漏译/回显是确定性检查的领地，
/// 语义核查不重复报告、也不为它们花 token。
fn reviewable_items(
    content: &str,
    translations: &HashMap<usize, String>,
    mode: &str,
    target_lang: &str,
) -> Vec<(usize, String, String)> {
    let blocks = parse_blocks(content);
    let target = TargetLang::from_tag(target_lang);
    let units: Vec<(usize, String)> = match mode {
        "bilingual" => collect_translatable(&blocks, target),
        _ => collect_text_runs(&blocks, target),
    };
    units
        .into_iter()
        .filter_map(|(idx, src)| {
            let dst = translations.get(&idx)?;
            (dst != &src).then(|| (idx, src, dst.clone()))
        })
        .collect()
}

/// 按 max_len 字符预算贪心装批（src+dst 的字符数计入预算，CJK 按字数算
/// 而非字节数，预算偏保守）。单条超预算的单元独占一批——宁可一批大一点，
/// 也不把单元劈开（劈开会让 id 对不上原文）。
fn pack_items(
    items: Vec<(usize, String, String)>,
    max_len: usize,
) -> Vec<Vec<(usize, String, String)>> {
    let mut batches: Vec<Vec<(usize, String, String)>> = Vec::new();
    let mut cur: Vec<(usize, String, String)> = Vec::new();
    let mut cur_len = 0usize;
    for it in items {
        let w = it.1.chars().count() + it.2.chars().count();
        if !cur.is_empty() && cur_len + w > max_len {
            batches.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur_len += w;
        cur.push(it);
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// 一批的请求体：方向 + （可选的用户追问）+ 单元表。JSON 由 serde 组装，
/// 转义不手写；followup 只在有追问时出现（缺键 ≠ 空串，模型不至于把
/// 「没有追问」误解成「追问为空」）。
fn build_payload(
    batch: &[(usize, String, String)],
    target_lang: &str,
    instruction: Option<&str>,
) -> String {
    let dir = match TargetLang::from_tag(target_lang) {
        TargetLang::Zh => "英译中",
        TargetLang::En => "中译英",
    };
    let units: Vec<Value> = batch
        .iter()
        .map(|(id, src, dst)| json!({"id": id, "src": src, "dst": dst}))
        .collect();
    let mut root = json!({"dir": dir, "units": units});
    if let Some(q) = instruction {
        let q = q.trim();
        if !q.is_empty() {
            root["followup"] = Value::String(q.to_string());
        }
    }
    root.to_string()
}

/// 跑一批：请求 → 严格解码。批内 id 集合是解码的「合法 run」边界——
/// 模型编造的 id 在这里被丢弃。
fn run_batch(
    base: &str,
    api_key: &str,
    model: &str,
    payload: &str,
    allowed: &HashSet<usize>,
    http: &(dyn HttpClient + Sync),
    cancel: &AtomicBool,
) -> Result<Vec<AiIssue>, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    let req = ChatRequest {
        base_url: base,
        api_key,
        model,
        system: SYSTEM,
        user: payload,
        temperature: 0.1,
        max_tokens: Some(MAX_TOKENS),
        json_mode: true,
        thinking_off: true,
        timeout_ms: TIMEOUT_MS,
    };
    let raw = chat_stream(&req, http, &mut |_| {})?;
    parse_issues(&raw, allowed)
}

/// 严格解码一批回复（工单 18：借鉴 assertAllowedKeys / 长度上限）：
/// * 整体必须是 `{"issues":[…]}` 且**只含 issues 键**——顶层混入未知键说明
///   prompt 契约已滑，整批按失败计；
/// * 单条键必须恰为六个、run 必须在批内、kind/severity 必须在白名单、
///   建议不可为空——违反**只丢该条**不连坐；
/// * 字符串超长截断（防长输出把前端卡片撑爆）。
fn parse_issues(raw: &str, allowed: &HashSet<usize>) -> Result<Vec<AiIssue>, String> {
    let v = parse_json_object(raw).ok_or_else(|| "回复不是合法 JSON".to_string())?;
    let obj = v.as_object().ok_or_else(|| "回复不是 JSON 对象".to_string())?;
    if obj.keys().any(|k| k != "issues") {
        return Err("回复含未知顶层字段".to_string());
    }
    let arr = obj
        .get("issues")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "缺少 issues 数组".to_string())?;
    let mut out = Vec::new();
    for it in arr {
        if let Some(issue) = parse_issue(it, allowed) {
            out.push(issue);
        }
    }
    Ok(out)
}

fn parse_issue(v: &Value, allowed: &HashSet<usize>) -> Option<AiIssue> {
    let obj = v.as_object()?;
    if obj.len() != ISSUE_KEYS.len() || obj.keys().any(|k| !ISSUE_KEYS.contains(&k.as_str())) {
        return None;
    }
    let run = obj.get("run")?.as_u64()?;
    if !allowed.contains(&(run as usize)) {
        return None;
    }
    let kind = text(obj, "kind")?;
    if !KINDS.contains(&kind.as_str()) {
        return None;
    }
    let severity = text(obj, "severity")?;
    if !SEVERITIES.contains(&severity.as_str()) {
        return None;
    }
    let current = clamp_chars(text(obj, "current")?, 200);
    let suggested = clamp_chars(text(obj, "suggested")?, 300);
    let reason = clamp_chars(text(obj, "reason")?, 200);
    Some(AiIssue {
        run: run as usize,
        kind,
        severity,
        current,
        suggested,
        reason,
    })
}

/// 取 trim 后非空的字符串字段。
fn text(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    let s = obj.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn clamp_chars(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    s.chars().take(max).collect()
}

/// 容错取 JSON 对象：先按裸 JSON 解，败了再扫第一个 `{` 到最后一个 `}`
/// （模型偶尔在前后垫话）。与 lookup.rs 的同名私有函数同思路，各持一份
/// 小实现，避免为三行代码跨模块导出。
fn parse_json_object(raw: &str) -> Option<Value> {
    let t = strip_fence(raw);
    if let Ok(v) = serde_json::from_str::<Value>(&t) {
        return Some(v);
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str::<Value>(&t[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(fields: &[(&str, &str)]) -> Creds {
        Creds(fields.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn review_model_takes_priority_and_falls_back() {
        assert_eq!(resolve_model(&creds(&[("model", "main"), ("review_model", "strong")])), "strong");
        assert_eq!(resolve_model(&creds(&[("model", "main"), ("review_model", "  ")])), "main");
        assert_eq!(resolve_model(&creds(&[("model", "main")])), "main");
    }

    #[test]
    fn pack_items_respects_char_budget_and_solo_oversize() {
        let mk = |n: usize| "x".repeat(n);
        let items = vec![
            (0usize, mk(450), mk(450)),
            (1, mk(450), mk(450)),
            (2, mk(450), mk(450)),
            (3, mk(450), mk(450)),
            (4, mk(450), mk(450)),
            (5, mk(6000), mk(10)),
        ];
        let batches = pack_items(items, 2000);
        // 900 字/条：两条 1800 ≤2000 一批；第 5 条 (6000+10) 超预算独占一批
        assert_eq!(batches.iter().map(|b| b.len()).collect::<Vec<_>>(), vec![2, 2, 1, 1]);
        assert_eq!(batches[3][0].0, 5);
        assert!(pack_items(vec![], 1000).is_empty());
    }

    #[test]
    fn reviewable_items_skips_missing_and_echo() {
        let content = "# T\n\nHello world\n\nSecond para";
        // 收集器取标题**纯文本**："# T" 的 run 0 是 "T"。dst 回显原文 =
        // EchoOfSource 领地；run 2 无译文 = 漏译领地——都不进核查。
        let map: HashMap<usize, String> = [(0usize, "T".to_string()), (1, "你好世界".to_string())]
            .into_iter()
            .collect();
        let items = reviewable_items(content, &map, "translation", "zh");
        assert_eq!(items, vec![(1usize, "Hello world".to_string(), "你好世界".to_string())]);
    }

    fn allow(ids: &[usize]) -> HashSet<usize> {
        ids.iter().copied().collect()
    }

    #[test]
    fn parse_issues_accepts_valid_and_tolerates_chatter() {
        let raw = r#"好的，核查结果如下：{"issues":[{"run":1,"kind":"register","severity":"high","current":"这么搞就完了","suggested":"这样做就完成了","reason":"口语化过重"},{"run":2,"kind":"term_inconsistency","severity":"low","current":"仪表盘","suggested":"控制台","reason":"与第 3 段术语统一"}]}"#;
        let out = parse_issues(raw, &allow(&[1, 2])).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].run, 1);
        assert_eq!(out[1].kind, "term_inconsistency");
    }

    #[test]
    fn parse_issues_drops_bad_entries_without_poisoning_the_batch() {
        let base = |run: &str, kind: &str| {
            format!(
                r#"{{"run":{run},"kind":"{kind}","severity":"high","current":"a","suggested":"b","reason":"c"}}"#
            )
        };
        let raw = format!(
            "[{},{},{},{{\"run\":9,\"kind\":\"register\",\"severity\":\"high\",\"current\":\"a\",\"suggested\":\"b\",\"reason\":\"c\"}}]",
            base("1", "register"),
            base("2", "unknown_kind"),
            r#"{"run":3,"severity":"high","current":"a","suggested":"b","reason":"c"}"#,
        );
        let v: Value = serde_json::from_str(&raw).unwrap();
        let issues: Vec<AiIssue> = v
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| parse_issue(i, &allow(&[1, 2, 3])))
            .collect();
        // 编造 run / 漂移 kind / 缺键各丢一条，合法的 run=1 保留
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].run, 1);
    }

    #[test]
    fn parse_issues_rejects_contract_slip_and_garbage() {
        assert!(parse_issues("not json at all", &allow(&[1])).is_err());
        assert!(parse_issues(r#"{"issues":[],"extra":1}"#, &allow(&[1])).is_err());
        assert!(parse_issues(r#"{"problems":[]}"#, &allow(&[1])).is_err());
        assert!(parse_issues(r#"{"issues":"none"}"#, &allow(&[1])).is_err());
        // 空清单是合法结果
        assert_eq!(parse_issues(r#"{"issues":[]}"#, &allow(&[1])).unwrap(), vec![]);
    }

    #[test]
    fn parse_issue_clamps_oversize_strings() {
        let long = "译".repeat(500);
        let raw = format!(
            r#"{{"run":1,"kind":"register","severity":"low","current":"{long}","suggested":"{long}","reason":"{long}"}}"#
        );
        let v: Value = serde_json::from_str(&raw).unwrap();
        let issue = parse_issue(&v, &allow(&[1])).unwrap();
        assert_eq!(issue.current.chars().count(), 200);
        assert_eq!(issue.suggested.chars().count(), 300);
        assert_eq!(issue.reason.chars().count(), 200);
    }

    #[test]
    fn build_payload_carries_direction_and_units() {
        let payload = build_payload(&[(3, "Hi".into(), "你好".into())], "zh", None);
        assert!(payload.contains(r#""dir":"英译中""#));
        assert!(payload.contains(r#""id":3"#) && payload.contains(r#""src":"Hi""#));
        assert!(build_payload(&[(0, "Hola".into(), "你好".into())], "en", None).contains("中译英"));
    }

    #[test]
    fn build_payload_carries_followup_only_when_present() {
        let with = build_payload(&[(1, "a".into(), "b".into())], "zh", Some(" 语气再正式一点 "));
        assert!(with.contains(r#""followup":"语气再正式一点""#));
        // 空白追问 = 没有追问：缺键，而不是空串
        let blank = build_payload(&[(1, "a".into(), "b".into())], "zh", Some("   "));
        assert!(!blank.contains("followup"));
        assert!(!build_payload(&[(1, "a".into(), "b".into())], "zh", None).contains("followup"));
    }
}
