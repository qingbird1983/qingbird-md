//! Settings + paths in the platform user-data dir (like the Electron app's
//! `qingbird-settings.json`).
//!
//! ⚠️ 凭据现状（SEC-3，如实陈述，勿再美化）：api_key 等凭据以**明文 JSON**
//! 落盘在用户数据目录（[`settings_path`]），文件权限与普通文件相同——同
//! 账户下运行的任何进程都可读，本进程**不做任何加密**（Windows DPAPI /
//! 系统凭据管理器属产品决策，见审计计划 §六，截至本注释未实施）。
//! 旧注释「Credentials never leave this process」与此矛盾，已更正。
//! 当前进程内维持的边界只有两条：凭据仅发往用户显式配置的 base_url；
//! 进程对外的主动广播（`settings-updated`，见 [`settings_broadcast_payload`]）
//! 不得携带凭据。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    String::new()
}

/// 一套已保存的 OpenAI 兼容大模型配置（「翻译与模型」页里的配置档案）。
///
/// 为什么要落盘：翻译链路只认 `providers["llm"]` 这一份凭据（bridge.rs 的
/// translate_text / translate_document 都由前端显式传 creds），所以多套配置
/// 的增删改与流水线天然解耦——档案库纯粹是「用户攒下来的几套凭据」，
/// 选中哪套就把它镜像进 `providers["llm"]`。Rust 侧不需要认识「档案」概念，
/// 但仍必须认识这个字段：`save_settings` 走 serde 反序列化，不认识的字段
/// 会被静默丢弃，前端攒的档案下次启动就没了。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct LlmProfile {
    /// 前端生成的不透明 id（稳定标识，改名不改 id）
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub lookup_model: String,
    /// 语义核查模型（S5）：留空回落 `model`。核查要质量不敏感于延迟，
    /// 与划词的 `lookup_model` 取舍相反——可选字段，不催配置。
    #[serde(default)]
    pub review_model: String,
    /// 上次从 `/models` 拉到的模型清单：持久化后重启仍可下拉选用，
    /// 不必每次打开设置都重新拉一遍。
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub providers: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub last_file: Option<String>,
    #[serde(default)]
    pub hotkeys: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub selection_translate: bool,
    #[serde(default = "default_on")]
    pub outline: String,
    #[serde(default = "default_on")]
    pub nav: String,
    /// "" = follow system on first run; otherwise "light"/"dark".
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 主题配色 id（xuan/su/qing/tan/ci/ye），与 theme（明暗）正交。
    /// `#[serde(default)]` = 空串，前端 normalizePalette 回落到 xuan——
    /// 老配置文件读出来就是默认配色，升级零感知。
    /// 合法值清单的真源在前端 src/lib/paletteSeeds.ts；Rust 侧不做校验，
    /// 因为未知值在前端本来就归一化，多一处白名单只会多一处漂移。
    #[serde(default)]
    pub palette: String,
    /// 开机自启（托盘菜单开关；持久化权威，启动时 apply 到 autostart 插件）。
    #[serde(default)]
    pub autostart: bool,
    /// 大模型配置档案库（可多套并存）。`#[serde(default)]` = 空数组，
    /// 老配置文件读出来就是「还没攒过档案」，升级零感知。
    #[serde(default)]
    pub llm_profiles: Vec<LlmProfile>,
    /// 当前生效档案的 id（空串 = 没有选中任何档案，用 `providers["llm"]` 原值）
    #[serde(default)]
    pub llm_active: String,
    /// 翻译方向（目标语言短标签 `"zh"` / `"en"`）。`#[serde(default)]` = 空串，
    /// 前端 `normalizeTarget` 与 Rust `TargetLang::from_tag` 都回落 `zh`——
    /// 老配置文件读出来就是改动前行为，升级零感知。
    ///
    /// 合法值清单的真源在 `src-tauri/src/translate/policy.rs`；这里不设白名单，
    /// 未知值在两处解析口都被收成 zh，多一处白名单只会多一处漂移。
    #[serde(default)]
    pub translate_target: String,
    /// 导出时重排版（S6 / A 计划第 5 步 22）。`#[serde(default = "default_true")]`
    /// = 老配置文件读出来即「开」，与中英间距/标点体例作为交付可读性默认收益一致；
    /// 关掉即回到改动前的逐字导出。仅在「另存为」导出时对译文 value 施加，
    /// **不改实时预览、不改译文表、不进 Cache**。
    #[serde(default = "default_true")]
    pub relayout_on_export: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "auto".to_string(),
            providers: HashMap::new(),
            workspace: None,
            last_file: None,
            hotkeys: DEFAULT_HOTKEYS
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            selection_translate: true,
            outline: "on".to_string(),
            nav: "on".to_string(),
            theme: String::new(),
            palette: String::new(),
            autostart: false,
            llm_profiles: Vec::new(),
            llm_active: String::new(),
            translate_target: String::new(),
            relayout_on_export: true,
        }
    }
}

fn default_provider() -> String {
    "auto".to_string()
}
fn default_on() -> String {
    "on".to_string()
}

/// 出厂快捷键。与前端 `src/lib/hotkeyRegistry.ts` 的 HOTKEYS 表逐条对应，
/// 由 src/lib/hotkeyRegistry.test.ts 读本文件比对钉住（改一处漏另一处会红）。
///
/// 为什么 Rust 也得有一份：这四个是**系统级**注册（hotkeys.rs，程序未聚焦也生效），
/// 前端光有默认值只能让应用内匹配生效，切出去按键就没反应了——注册层必须看得到。
/// 其余应用内快捷键只在 App.tsx 匹配，不在这里登记，Rust 也就不需要认识它们。
pub const DEFAULT_HOTKEYS: &[(&str, &str)] = &[
    ("original", "Ctrl+Alt+1"),
    ("translation", "Ctrl+Alt+2"),
    ("bilingual", "Ctrl+Alt+3"),
    ("capture", "Ctrl+Shift+X"),
];

pub fn user_data_dir() -> PathBuf {
    if let Some(d) = dirs::data_dir() {
        d.join("qingbird-md")
    } else {
        std::env::temp_dir()
    }
}

/// `full` 是否以 `base` 开头、且后面紧跟一个路径分隔符。
///
/// 用 `strip_prefix` 做前缀替换时必须卡这一刀：否则 `C:\Users\ab` 会匹配上
/// `C:\Users\abcdef\...`，把别人的目录误认成家目录。
fn strip_dir_prefix<'a>(full: &'a str, base: &str) -> Option<&'a str> {
    if base.is_empty() {
        return None;
    }
    let rest = full.strip_prefix(base)?;
    if rest.starts_with(['\\', '/']) {
        Some(rest)
    } else {
        None
    }
}

/// 数据目录的**界面显示形态**：把用户数据根折成环境变量写法（`%APPDATA%\qingbird-md`）。
///
/// 为什么不显示绝对路径：绝对路径里带着**当前这台机器**的用户名
/// （`C:\Users\某某\AppData\Roaming\...`），用户看到会以为路径被写死在配置里、
/// 换台电脑就不对了。实际上 [`user_data_dir`] 是每次启动现算的，换机器自然指向
/// 新位置——根因是**显示**招来的误会，那就改显示：环境变量写法更短、跨机器成立，
/// 也是 Windows 上的通行表示法。
///
/// **只可供显示使用**：真要打开这个目录仍必须用 [`user_data_dir`] 的绝对路径，
/// 把 `%APPDATA%` 原样交给 explorer 是解析不出来的。
pub fn user_data_dir_label() -> String {
    let full = user_data_dir().to_string_lossy().into_owned();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        if let Some(rest) = strip_dir_prefix(&full, &appdata.to_string_lossy()) {
            return format!("%APPDATA%{rest}");
        }
    }
    // 非 Windows（或 APPDATA 被清掉）时的兜底：用家目录缩写。
    if let Some(home) = dirs::home_dir() {
        if let Some(rest) = strip_dir_prefix(&full, &home.to_string_lossy()) {
            return format!("~{rest}");
        }
    }
    full
}

pub fn settings_path() -> PathBuf {
    user_data_dir().join("qingbird-settings.json")
}

pub fn cache_path() -> PathBuf {
    user_data_dir().join("qingbird-cache.json")
}

/// S9：SQLite 缓存库主路径，与 [`cache_path`]（JSON，现为迁移来源）并列（不新建子目录，见 C 计划 §九）。
pub fn cache_db_path() -> PathBuf {
    user_data_dir().join("qingbird-cache.db")
}

pub fn load_settings() -> Settings {
    load_settings_from(&settings_path())
}

/// [`load_settings`] 的可注入路径版本（测试与复用入口；对应 save_settings_to）。
pub fn load_settings_from(path: &std::path::Path) -> Settings {
    if let Ok(s) = std::fs::read_to_string(path) {
        match serde_json::from_str::<Settings>(&s) {
            Ok(mut v) => {
                // 出厂热键补缺：老设置文件升级后开箱即用；显式空串=禁用不补。
                // 「空串不补」是刻意的——用户把某项删干净表示不要这个键，
                // 补回去等于每次启动都跟他对着干。
                for (k, d) in DEFAULT_HOTKEYS {
                    v.hotkeys
                        .entry(k.to_string())
                        .or_insert_with(|| d.to_string());
                }
                return v;
            }
            Err(_) => {
                // 加固（审查遗留）：解析失败的坏文件重命名为 <name>.bak-<timestamp>
                // 再回退默认值——坏内容仍在磁盘上，绝不静默丢弃用户数据。
                // rename 失败（权限/占用）不阻塞默认值回退。
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                if let Some(name) = path.file_name() {
                    let bak = path.with_file_name(format!("{}.bak-{ts}", name.to_string_lossy()));
                    let _ = std::fs::rename(path, bak);
                }
            }
        }
    }
    Settings::default()
}

/// Persist `s` to `path`, creating parent dirs as needed; error string on any
/// failure（成功与否可判定，是命令层“先落盘、后广播”的前提）。
/// 原子写（REL-3）：崩溃/断电不会留下截断的设置文件（坏文件只会整体丢失或
/// 保持旧内容，[`load_settings`] 的 .bak 兜底仍是最后防线）。
pub fn save_settings_to(path: &std::path::Path, s: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    crate::atomic_write::write(path, json.as_bytes()).map_err(|e| e.to_string())
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    save_settings_to(&settings_path(), s)
}

/// `settings-updated` 的广播 payload（SEC-3 脱敏）：只含跨窗口需要收敛的
/// 非敏感字段 theme / palette。
///
/// 为什么不广播整份 [`Settings`]：里面带着明文凭据（`providers` 与
/// `llm_profiles` 的 `api_key`），改个主题也会把它推给全部窗口。前端唯一
/// 消费方 `useSettingsStore.applyRemote` 本来就只读这两项（已逐一核对）；
/// 需要全量设置由前端走 `load_settings` IPC 按需拉取。
/// **扩字段必须刻意为之且永不放凭据**——`tests::broadcast_payload_excludes_credentials`
/// 钉住这一点。
pub fn settings_broadcast_payload(s: &Settings) -> serde_json::Value {
    serde_json::json!({ "theme": s.theme, "palette": s.palette })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_settings_file_is_backed_up_and_defaults_loaded() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(format!("qingbird-corrupt-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("qingbird-settings.json");
        std::fs::write(&p, "{corrupt json").unwrap();

        // 加固契约：解析失败 → 坏文件保留为 <name>.bak-<timestamp>，load 返回默认值，
        // 绝不静默丢弃用户数据。
        let s = load_settings_from(&p);
        assert_eq!(s.provider, "auto");
        assert!(s.workspace.is_none());

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), 1, "exactly one file should remain, got {names:?}");
        assert!(
            names[0].starts_with("qingbird-settings.json.bak-"),
            "backup must be <name>.bak-<timestamp>, got {names:?}"
        );
    }

    #[test]
    fn settings_defaults() {
        let s = Settings::default();
        assert_eq!(s.provider, "auto");
        assert!(s.selection_translate);
        assert_eq!(s.outline, "on");
    }

    /// 前缀替换必须卡住分隔符边界，否则 `C:\Users\ab` 会误匹配 `C:\Users\abcdef\...`。
    #[test]
    fn strip_dir_prefix_requires_separator_boundary() {
        assert_eq!(strip_dir_prefix(r"C:\Users\ab\AppData", r"C:\Users\ab"), Some(r"\AppData"));
        assert_eq!(strip_dir_prefix(r"C:\Users\abc\AppData", r"C:\Users\ab"), None);
        assert_eq!(strip_dir_prefix("/home/u/x", "/home/u"), Some("/x"));
        assert_eq!(strip_dir_prefix("/home/other", "/home/u"), None);
        assert_eq!(strip_dir_prefix("anything", ""), None);
    }

    /// 用户明确要求：「显示数据目录不能带上本机绝对路径，换电脑就看着不对」。
    /// 只要系统给了 APPDATA（Windows）或家目录，就**必须**折成 `%VAR%` / `~` 形态。
    #[test]
    fn data_dir_label_is_machine_independent() {
        let label = user_data_dir_label();
        assert!(label.ends_with("qingbird-md"), "label = {label}");
        if std::env::var_os("APPDATA").is_some() || dirs::home_dir().is_some() {
            assert!(
                label.starts_with('%') || label.starts_with('~'),
                "应折成环境变量/家目录形态，实得：{label}"
            );
        }
    }

    #[test]
    fn save_writes_reloadable_json_and_creates_parents() {
        // Wire contract（Task 14 → SEC-3 收窄）：settings-updated 的广播 payload
        // 不再是整份落盘 JSON，改由 settings_broadcast_payload 只发
        // theme/palette；本测试钉的是**落盘**文件的 JSON 形状。
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let target = std::env::temp_dir()
            .join(format!("qingbird-save-{unique}"))
            .join("deep")
            .join("qingbird-settings.json");
        let mut s = Settings::default();
        s.provider = "youdao".into();
        s.theme = "dark".into();
        save_settings_to(&target, &s).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["provider"], "youdao");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn save_reports_write_failure_as_err() {
        // 目标即已存在的目录：fs::write 必败 → Err。
        // Err 上抛是“先持久化、后广播”前提——失败路径绝不 emit。
        let dir = std::env::temp_dir().join(format!("qingbird-save-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(save_settings_to(&dir, &Settings::default()).is_err());
    }

    #[test]
    fn settings_json_roundtrip() {
        let mut s = Settings::default();
        s.provider = "youdao".into();
        s.hotkeys.insert("original".into(), "Alt+1".into());
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.provider, "youdao");
        assert_eq!(s2.hotkeys.get("original").map(|x| x.as_str()), Some("Alt+1"));
    }

    #[test]
    fn capture_hotkey_defaults_added_when_missing() {
        // 老用户设置文件无 capture 键 → 加载后补默认值（spec §8）
        let dir = std::env::temp_dir().join(format!("qingbird-hk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("qingbird-settings.json");
        std::fs::write(&p, r#"{"provider":"auto"}"#).unwrap();
        let s = load_settings_from(&p);
        assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
        // 显式空串 = 用户禁用，不得覆盖
        std::fs::write(&p, r#"{"hotkeys":{"capture":""}}"#).unwrap();
        let s2 = load_settings_from(&p);
        assert_eq!(s2.hotkeys.get("capture").map(String::as_str), Some(""));
        // autostart 缺字段 → false
        assert!(!s2.autostart);
    }

    #[test]
    fn default_settings_carry_capture_hotkey() {
        let s = Settings::default();
        assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
        assert!(!s.autostart);
        // 三个模式热键同样有出厂默认（前端 hotkeyRegistry 的镜像，见 DEFAULT_HOTKEYS 注释）
        assert_eq!(s.hotkeys.get("original").map(String::as_str), Some("Ctrl+Alt+1"));
        assert_eq!(s.hotkeys.get("translation").map(String::as_str), Some("Ctrl+Alt+2"));
        assert_eq!(s.hotkeys.get("bilingual").map(String::as_str), Some("Ctrl+Alt+3"));
        // 系统级注册只看这四个；应用内快捷键不在 Rust 侧登记
        assert_eq!(s.hotkeys.len(), 4);
    }

    /// 配置档案必须能原样落盘再读回——`save_settings` 走 serde 反序列化，
    /// 字段名漏登记就会被静默丢弃（前端攒的档案下次启动消失）。
    #[test]
    fn llm_profiles_roundtrip() {
        let mut s = Settings::default();
        s.llm_active = "p-2".into();
        s.llm_profiles = vec![
            LlmProfile {
                id: "p-1".into(),
                name: "DeepSeek 官方".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key: "sk-a".into(),
                model: "deepseek-v4-flash".into(),
                lookup_model: String::new(),
                review_model: String::new(),
                models: vec!["deepseek-v4-flash".into(), "deepseek-v4-pro".into()],
            },
            LlmProfile {
                id: "p-2".into(),
                name: "本地 Ollama".into(),
                base_url: "http://127.0.0.1:11434/v1".into(),
                ..Default::default()
            },
        ];
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.llm_active, "p-2");
        assert_eq!(s2.llm_profiles.len(), 2);
        assert_eq!(s2.llm_profiles[0].models.len(), 2);
        // 缺省字段（struct update 没给的）回落成空串，不 panic
        assert_eq!(s2.llm_profiles[1].model, "");
        assert!(s2.llm_profiles[1].models.is_empty());
        // 序列化字段名同时钉住 wire 契约（TS 侧 llm_profiles / base_url 同名）
        assert!(json.contains("\"llm_profiles\""));
        assert!(json.contains("\"base_url\""));
        assert!(json.contains("\"lookup_model\""));
        assert!(json.contains("\"review_model\""));
    }

    /// SEC-3 回归钉：`settings-updated` 的广播 payload 不得携带任何凭据，
    /// 且必须保留前端消费方要读的 theme/palette。
    /// 修复前 save_settings 广播整份 Settings（lib.rs
    /// `app.emit("settings-updated", &settings)`），当时以
    /// `serde_json::to_value(&s)` 取 payload 实跑本断言必红——失败输出把
    /// providers 与 llm_profiles 两处 api_key 字段的探针值原样回显了出来。
    /// 修复后 payload 由 [`settings_broadcast_payload`] 生成，本测试转绿。
    /// （探针值是自造的非凭据形标记串，只为断言泄漏，并非任何可用密钥。）
    #[test]
    fn broadcast_payload_excludes_credentials() {
        let mut s = Settings::default();
        s.theme = "dark".into();
        s.palette = "ye".into();
        // 探针值故意不用密钥形字面量（安全扫描不区分真假）：仅证明
        // api_key 字段的**值**会/不会进广播，形状无关紧要。
        let probe = "LEAK-PROBE-CANARY-1";
        let profile_probe = "LEAK-PROBE-CANARY-2";
        s.providers
            .insert("llm".into(), HashMap::from([("api_key".into(), probe.into())]));
        s.llm_profiles.push(LlmProfile {
            api_key: profile_probe.into(),
            ..Default::default()
        });
        let payload = settings_broadcast_payload(&s);
        let text = payload.to_string();
        assert!(
            !text.contains(probe),
            "settings-updated 泄漏 providers api_key: {text}"
        );
        assert!(
            !text.contains(profile_probe),
            "settings-updated 泄漏 llm_profiles api_key: {text}"
        );
        // 前端 applyRemote 只收敛这两项：payload 里必须真的有。
        assert_eq!(payload["theme"], "dark");
        assert_eq!(payload["palette"], "ye");
    }

    /// 老设置文件没有这两个字段：加载后必须是「空档案库」而不是解析失败
    /// （解析失败会被当作坏文件备份掉，等于把用户配置清空）。
    #[test]
    fn old_config_without_llm_profiles_loads_clean() {
        let dir = std::env::temp_dir().join(format!("qingbird-llm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("qingbird-settings.json");
        std::fs::write(&p, r#"{"provider":"llm","theme":"dark"}"#).unwrap();
        let s = load_settings_from(&p);
        assert!(s.llm_profiles.is_empty());
        assert_eq!(s.llm_active, "");
        assert_eq!(s.provider, "llm"); // 其余字段照常读回
        // 也没有被当成坏文件改名（目录里仍只有这一个文件）
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }
}
