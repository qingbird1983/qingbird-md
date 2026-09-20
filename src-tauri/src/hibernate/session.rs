//! 会话快照（仅休眠时落草稿，恢复成功后即删）：类型、版本化落盘与清理。
//! 原子写（P1-6/REL-3）调用点原样保持。

use serde::{Deserialize, Serialize};

// ---- session 快照（仅休眠时落草稿，恢复成功后即删）----

/// 快照格式版本。结构变更**且不可向后兼容**时递增，旧文件直接丢弃走冷启动路径。
/// 新增 `#[serde(default)]` 字段属于向后兼容变更（旧快照缺失字段时取默认值），
/// 不必 bump——bump 的后果是用户那一次未保存的草稿被丢弃。
/// 历史：v1 含 show_nav / show_outline / sidebar_width / outline_width / split_ratio；
/// v1 后续补 show_review / review_width（AI 核查面板，2026-09-19）仍为 v1——
/// 每字段都带 `#[serde(default)]`，旧文件能正常反序列化。
pub const SESSION_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionTab {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: String,
    /// `Some` = 未保存内容（草稿）；`None` = 干净，重建时从 path 重读。
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub mtime: Option<i64>,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub view: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub cursor_sel: [u32; 2],
    #[serde(default)]
    pub scroll_top: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionUi {
    #[serde(default)]
    pub show_nav: bool,
    #[serde(default)]
    pub show_outline: bool,
    #[serde(default)]
    pub sidebar_width: f64,
    #[serde(default)]
    pub outline_width: f64,
    #[serde(default)]
    pub split_ratio: f64,
    // AI 核查面板（§八）：与大纲栏共用两个侧栏槽，各自独立 show/width。
    // side 走前端 localStorage（不进快照，同 outlineSide 先例）。
    #[serde(default)]
    pub show_review: bool,
    #[serde(default)]
    pub review_width: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionSnapshot {
    /// 恒为 [`SESSION_VERSION`]；不符即丢弃（不阻塞启动）。
    pub version: u32,
    #[serde(default)]
    pub saved_at: i64,
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub ui: Option<SessionUi>,
}

/// 草稿 tab 数；>0 表示恢复后要提示「已恢复上次未保存的内容」。
///
/// 预留：前端在 JS 侧自行统计（快照已在内存，无需再走 IPC），此处保留为
/// 「脏 tab == content.is_some()」这一契约的 Rust 侧定义与回归断言。
#[allow(dead_code)]
pub fn snapshot_dirty_count(snap: &SessionSnapshot) -> usize {
    snap.tabs.iter().filter(|t| t.content.is_some()).count()
}

pub fn session_path() -> std::path::PathBuf {
    crate::storage::user_data_dir().join("qingbird-session.json")
}

pub fn save_snapshot_to(
    path: &std::path::Path,
    snap: &SessionSnapshot,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(snap).map_err(|e| e.to_string())?;
    // 原子写（REL-3）：快照装着未保存的草稿，崩溃/断电绝不留半截文件。
    crate::atomic_write::write(path, json.as_bytes()).map_err(|e| e.to_string())
}

pub fn save_snapshot(snap: &SessionSnapshot) -> Result<(), String> {
    save_snapshot_to(&session_path(), snap)
}

/// 读快照：文件不存在 → `Ok(None)`；版本不符 → `Ok(None)`（旧文件作废，不阻塞启动）。
pub fn load_snapshot_from(
    path: &std::path::Path,
) -> Result<Option<SessionSnapshot>, String> {
    let s = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let snap: SessionSnapshot = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if snap.version != SESSION_VERSION {
        eprintln!(
            "[hibernate] 快照版本 {} != {SESSION_VERSION}，丢弃",
            snap.version
        );
        return Ok(None);
    }
    Ok(Some(snap))
}

pub fn load_snapshot() -> Result<Option<SessionSnapshot>, String> {
    load_snapshot_from(&session_path())
}

/// 恢复成功后删除（一次性快照：不在下次冷启动冒出旧内容）。
pub fn clear_snapshot_from(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn clear_snapshot() -> Result<(), String> {
    clear_snapshot_from(&session_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap_with(dirty: bool) -> SessionSnapshot {
        SessionSnapshot {
            version: SESSION_VERSION,
            saved_at: 1,
            tabs: vec![
                SessionTab {
                    id: "a".into(),
                    path: Some("C:/x/a.md".into()),
                    name: "a.md".into(),
                    content: if dirty { Some("# draft".into()) } else { None },
                    mtime: Some(123),
                    encoding: Some("UTF-8".into()),
                    view: "source".into(),
                    mode: "original".into(),
                    cursor_sel: [1, 2],
                    scroll_top: 12.5,
                },
                SessionTab {
                    id: "b".into(),
                    path: None,
                    name: "未命名".into(),
                    content: None,
                    mtime: None,
                    encoding: None,
                    view: "preview".into(),
                    mode: "original".into(),
                    cursor_sel: [0, 0],
                    scroll_top: 0.0,
                },
            ],
            active_id: Some("a".into()),
            workspace_root: None,
            ui: Some(SessionUi {
                show_nav: true,
                show_outline: false,
                sidebar_width: 240.0,
                outline_width: 200.0,
                split_ratio: 0.5,
                show_review: false,
                review_width: 320.0,
            }),
        }
    }

    // ---- 快照 serde 往返 ----

    #[test]
    fn snapshot_roundtrips_with_dirty_and_clean_tabs() {
        let snap = snap_with(true);
        let json = serde_json::to_string(&snap).unwrap();
        let back: SessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, snap);
        assert_eq!(back.tabs[0].content.as_deref(), Some("# draft"));
        assert!(back.tabs[1].content.is_none());
    }

    #[test]
    fn dirty_count_counts_only_draft_tabs() {
        assert_eq!(snapshot_dirty_count(&snap_with(false)), 0);
        assert_eq!(snapshot_dirty_count(&snap_with(true)), 1);
    }

    #[test]
    fn snapshot_json_uses_snake_case_wire_names() {
        // 前端 collectSnapshot 产出同名键；字段名一旦改名，这里先炸
        let v: serde_json::Value = serde_json::to_value(snap_with(true)).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v["tabs"][0].get("cursor_sel").is_some());
        assert!(v["tabs"][0].get("scroll_top").is_some());
        assert!(v["ui"].get("sidebar_width").is_some());
        assert!(v["ui"].get("show_review").is_some());
        assert!(v["ui"].get("review_width").is_some());
        assert!(v.get("workspace_root").is_some());
    }

    #[test]
    fn old_snapshot_without_review_fields_still_deserializes() {
        // v1 旧快照的 ui 缺 show_review / review_width——
        // 不 bump SESSION_VERSION 的前提是 serde(default) 兜住兼容性。
        let v: SessionSnapshot = serde_json::from_str(
            r#"{"version":1,"ui":{"show_nav":true,"show_outline":false,"sidebar_width":240.0,"outline_width":200.0,"split_ratio":0.5}}"#,
        )
        .unwrap();
        assert!(v.ui.is_some());
        let ui = v.ui.unwrap();
        assert!(ui.show_review == false); // default: false
        assert_eq!(ui.review_width, 0.0); // default: 0.0
    }

    #[test]
    fn snapshot_tolerates_missing_optional_fields() {
        // 老/残缺快照：缺字段走 default，不得整体解析失败
        let v: SessionSnapshot =
            serde_json::from_str(r#"{"version":1,"tabs":[{"id":"a"}]}"#).unwrap();
        assert_eq!(v.tabs.len(), 1);
        assert!(v.tabs[0].path.is_none());
        assert!(v.tabs[0].content.is_none());
        assert_eq!(v.tabs[0].cursor_sel, [0, 0]);
        assert!(v.ui.is_none());
    }

    // ---- 草稿文件 IO ----

    #[test]
    fn save_and_load_roundtrip_via_disk() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let p = std::env::temp_dir()
            .join(format!("qingbird-session-{unique}"))
            .join("qingbird-session.json");
        save_snapshot_to(&p, &snap_with(true)).unwrap();
        let got = load_snapshot_from(&p).unwrap().expect("应能读回快照");
        assert_eq!(got, snap_with(true));
        clear_snapshot_from(&p).unwrap();
        assert!(!p.exists());
        // 删除后再读：文件不存在 = 没有快照，不是错误
        assert!(load_snapshot_from(&p).unwrap().is_none());
    }

    #[test]
    fn stale_version_snapshot_is_discarded() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let p = std::env::temp_dir().join(format!("qingbird-session-old-{unique}.json"));
        let mut snap = snap_with(true);
        snap.version = 99;
        save_snapshot_to(&p, &snap).unwrap();
        assert!(
            load_snapshot_from(&p).unwrap().is_none(),
            "版本不符必须丢弃，绝不阻塞启动"
        );
    }

    #[test]
    fn missing_file_is_none_not_error() {
        let p = std::env::temp_dir().join(format!(
            "qingbird-session-absent-{}.json",
            std::process::id()
        ));
        assert!(!p.exists());
        assert!(load_snapshot_from(&p).unwrap().is_none());
    }

    #[test]
    fn session_path_sits_next_to_settings() {
        // 与 settings/cache 同目录，路径构造口径必须一致（user_data_dir）
        let s = session_path();
        assert_eq!(s.file_name().unwrap(), "qingbird-session.json");
        assert_eq!(s.parent(), crate::storage::settings_path().parent());
    }
}
