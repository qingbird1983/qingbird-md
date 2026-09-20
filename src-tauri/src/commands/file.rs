//! 文档 IO 与编辑/预览外壳：打开（含编码兜底 + 首渲）、保存、mtime 基线、
//! 编辑器 op 映射、markdown 重解析、预览图片路径解析（SEC-2 根校验）。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::{atomic_write, dto, editor, markdown, translate, workspace};

// ---- 文件 ----

/// 解码文件字节：严格 UTF-8 优先，失败回退 GB18030（GBK 超集，中文场景兜底）。
/// 返回 (内容, 编码标注)。非中文二进制误判会得到 U+FFFD 替换字符，可接受。
pub fn decode_bytes(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), "UTF-8"),
        Err(_) => {
            let (text, _, _) = encoding_rs::GB18030.decode(bytes);
            (text.into_owned(), "GB18030")
        }
    }
}

/// 打开文档：读取 + doc_dto 内完成首次 markdown 渲染（parse 随文档一趟下发）。
/// async 命令：render_html 是 CPU 密集操作（大文档 release 下可达百 ms 级），
/// 必须离开主线程，否则解析期间整个窗口冻结（同 T9 pick_* 先例）。
///
/// `target_lang` 是当前翻译方向（`"zh"` / `"en"`，未知值回落 zh）：首渲的
/// `data-bi` 占号由它决定，必须与随后 `translate_document` 的入参一致。
#[tauri::command]
pub async fn open_file(path: String, target_lang: String) -> Result<dto::DocDTO, String> {
    let p = std::path::PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_bytes(&bytes);
    let target = translate::engine::TargetLang::from_tag(&target_lang);
    Ok(dto::doc_dto(&p, content, encoding, target))
}

/// 保存文档；返回写盘后的 mtime（毫秒），前端记为新的外部修改检测基线。
/// 原子写（REL-3）：崩溃/断电不会留下截断的文档。
#[tauri::command]
pub fn save_file(path: String, content: String) -> Result<Option<i64>, String> {
    atomic_write::write(std::path::Path::new(&path), content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(dto::file_mtime_millis(std::path::Path::new(&path)))
}

/// 查询当前磁盘 mtime（毫秒）：窗口聚焦时的外部修改检测、保存前的冲突检测。
/// 文件不存在/不可访问返回 None。
#[tauri::command]
pub fn file_mtime(path: String) -> Option<i64> {
    dto::file_mtime_millis(std::path::Path::new(&path))
}

// ---- 预览（Task 7）----

/// Resolve a markdown image `src` to a local absolute path
/// （逻辑 = 旧 render.rs::resolve_src 平移）：
/// - http(s)/data: -> `None`（远程图交给前端按 alt 兜底）
/// - file:// -> 剥前缀使用
/// - 相对路径 -> 与文档目录（base_dir）拼接
///
/// P1-2(SEC-2)：解析结果经 `.`/`..` 词法归一（`..` 逃出根整体返回 None），
/// 与文档目录之外工作区根之内的合法 `../` 引用由此可判定；逃逸的最终拒绝
/// 在 [`resolve_within`] 的根校验。
fn resolve(src: &str, base_dir: Option<&str>) -> Option<PathBuf> {
    let s = src.trim();
    if s.is_empty() {
        return None;
    }
    let raw = if let Some(p) = s.strip_prefix("file://") {
        // 三斜杠 file:///C:/x.png 剥 `file://` 后余 `/C:/x.png`，前导斜杠在
        // Windows 上不是有效本地路径——剥净；双斜杠 file://C:/x.png 原样无影响
        // （旧 Electron 平移行为保持）。
        PathBuf::from(p.trim_start_matches('/'))
    } else {
        if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") {
            return None;
        }
        PathBuf::from(base_dir?).join(s)
    };
    // join 在 Windows 上插入反斜杠；统一为 '/' 保持路径字符串可预测
    // （前端展示、测试断言一致）。Win32 API 两种分隔符均接受。
    workspace::normalize_lexical(&raw)
        .map(|n| PathBuf::from(n.to_string_lossy().replace('\\', "/")))
}

/// SEC-2 根校验后的解析：结果必须落在允许根——文档目录（base_dir）或任一
/// 已登记工作区根（[`workspace::register_root`]）——之内，否则 `None`。
///
/// resolve_image 是唯一被**文档内容**直接驱动的路径入口（恶意 .md 的
/// `<img src>`），`..` 逃逸在此被拦下，P1-1 的运行时逐文件 asset 放行因此
/// 只发生在根内路径上。
fn resolve_within(src: &str, base_dir: Option<&str>, roots: &[PathBuf]) -> Option<PathBuf> {
    let p = resolve(src, base_dir)?;
    let in_base = base_dir
        .filter(|b| !b.is_empty())
        .is_some_and(|b| workspace::path_within(&p, std::path::Path::new(b)));
    if in_base || roots.iter().any(|r| workspace::path_within(&p, r)) {
        Some(p)
    } else {
        None
    }
}

#[tauri::command]
pub fn resolve_image(app: AppHandle, src: String, base_dir: Option<String>) -> Option<String> {
    let roots = workspace::allowed_roots();
    resolve_within(&src, base_dir.as_deref(), &roots)
        .inspect(|p| {
            // P1-1(SEC-1)：解析结果即时放进 asset scope（见 resolve 上的注释）。
            // 放行失败（如路径不存在）静默忽略——本就加载不出图，不值得挡命令。
            let _ = app.asset_protocol_scope().allow_file(p);
        })
        .map(|p| p.to_string_lossy().into_owned())
}

/// tests/asset_scope.rs 的直调入口（tauri 命令宏把原 fn 保留为普通可调用，
/// 但 `pub` 会与其生成的隐藏项冲突 E0255，故经此薄壳转发，跑的是同一函数体）。
#[doc(hidden)]
pub fn resolve_image_for_test(
    app: AppHandle,
    src: String,
    base_dir: Option<String>,
) -> Option<String> {
    resolve_image(app, src, base_dir)
}

/// tests/asset_scope.rs 的根登记入口（open_workspace 命令为私有 fn，同上理由
/// 经薄壳转发；集成测试进程与 lib 单测进程隔离，静态根表互不可见）。
#[doc(hidden)]
pub fn register_workspace_root_for_test(path: &str) {
    workspace::register_root(std::path::Path::new(path));
}

/// 编辑期重新渲染（open_file 已随文档首渲，此处只服务内容变化后的重解析）。
/// async：同 open_file，解析离开主线程。
///
/// `target_lang` 同 `open_file`：`data-bi` 占号随方向变，前端切方向后必须
/// 用新方向重解析，否则预览 DOM 的块编号与本轮翻译的索引空间对不上。
#[tauri::command]
pub async fn parse_markdown(content: String, target_lang: String) -> markdown::html::ParseResult {
    markdown::html::render_html(
        &content,
        &std::collections::HashMap::new(),
        false,
        translate::engine::TargetLang::from_tag(&target_lang),
    )
}

// ---- 编辑器纯逻辑外壳 ----

#[tauri::command]
pub fn apply_op(op: dto::EditOp) -> dto::EditResult {
    apply_op_map(op)
}

/// Type-mapping shell around [`editor::apply_op`] ([usize;2] ↔ byte pair).
/// Snaps the selection onto UTF-8 char boundaries first so malformed IPC
/// payloads cannot panic mid-character — the frontend normally converts
/// CodeMirror code-point offsets to byte offsets before calling (plan Task 14).
pub(crate) fn apply_op_map(op: dto::EditOp) -> dto::EditResult {
    let c = &op.content;
    let s = snap_down(c, op.sel[0]);
    let e = snap_down(c, op.sel[1]).max(s);
    let (content, sel) = editor::apply_op(c, (s, e), &op.op);
    dto::EditResult { content, sel: [sel.0, sel.1] }
}

/// Clamp to string length and floor to the nearest preceding char boundary.
/// `is_char_boundary(0)` is always true, so this terminates.
fn snap_down(c: &str, mut i: usize) -> usize {
    i = i.min(c.len());
    while !c.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_skips_remote_and_resolves_relative() {
        assert_eq!(resolve("https://a/b.png", Some("D:/w")), None);
        assert_eq!(resolve("data:image/png;base64,x", None), None);
        assert_eq!(
            resolve("img/logo.png", Some("D:/w")).unwrap().to_string_lossy(),
            "D:/w/img/logo.png"
        );
        assert_eq!(resolve("file://C:/x.png", None).unwrap().to_string_lossy(), "C:/x.png");
        // 平移自旧逻辑的边界：空 src 与纯空白拒绝
        assert_eq!(resolve("", Some("D:/w")), None);
        assert_eq!(resolve("   ", Some("D:/w")), None);
    }

    #[test]
    fn resolve_triple_slash_file_url_is_normalized_to_drive_path() {
        // file:///C:/x.png 三斜杠形式：剥净前导斜杠（否则 /C:/x.png 不是有效本地路径）
        assert_eq!(
            resolve("file:///C:/x.png", None).unwrap().to_string_lossy(),
            "C:/x.png"
        );
        // 四斜杠同样剥净到净路径
        assert_eq!(
            resolve("file:////C:/x.png", None).unwrap().to_string_lossy(),
            "C:/x.png"
        );
    }

    #[test]
    fn apply_op_maps_types() {
        let op = dto::EditOp { content: "hi".into(), sel: [0, 2], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**hi**");
        // 内核契约（editor::wrap）：包裹后选区落在标记内的原文字上
        assert_eq!(r.sel, [2, 4]);
    }

    #[test]
    fn apply_op_cjk_selection_is_snapped_to_char_boundaries() {
        // 每个汉字 3 字节：1/7/99 都不在字符边界上，必须收敛而非 panic
        let op = dto::EditOp { content: "你好".into(), sel: [1, 4], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**你**好");
        assert_eq!(r.sel, [2, 5]);

        // 越界选择 → 钳到末尾空选区，插入占位符并选中它
        let beyond = dto::EditOp { content: "你好".into(), sel: [7, 99], op: "italic".into() };
        let r2 = apply_op_map(beyond);
        assert_eq!(r2.content, "你好*斜体*");
        assert_eq!(r2.sel, [7, 13]);
    }

    #[test]
    fn resolve_within_enforces_doc_dir_and_workspace_roots() {
        let root = std::env::temp_dir().join(format!("qingbird-p12-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let base = root.join("docs").to_string_lossy().replace('\\', "/");
        let root_s = root.to_string_lossy().replace('\\', "/");
        let roots = vec![root.clone()];

        // 文档目录内相对图片：放行
        assert!(resolve_within("pic.png", Some(&base), &roots).is_some());
        // `..` 进入工作区（文档目录之外、根之内）：放行——根校验要保住的合法形态
        assert!(resolve_within("../assets/pic.png", Some(&base), &roots).is_some());
        // 未登记任何根时同样的 `..`：逃出文档目录，拒绝
        assert_eq!(resolve_within("../assets/pic.png", Some(&base), &[]), None);
        // 越过工作区根：拒绝
        assert_eq!(resolve_within("../../escape.png", Some(&base), &roots), None);
        // file:// 根内绝对路径：放行；根外：拒绝
        assert!(resolve_within(&format!("file://{root_s}/docs/pic.png"), None, &roots).is_some());
        let other =
            std::env::temp_dir().join(format!("qingbird-p12-res-out-{}", std::process::id()));
        std::fs::create_dir_all(&other).unwrap();
        let other_s = other.to_string_lossy().replace('\\', "/");
        assert_eq!(resolve_within(&format!("file://{other_s}/x.png"), None, &roots), None);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    // ---- T7: 编码兜底 / T6+T8: mtime 基线 ----

    #[test]
    fn decode_utf8_is_passthrough() {
        let (text, enc) = decode_bytes("中文\n# ok".as_bytes());
        assert_eq!(text, "中文\n# ok");
        assert_eq!(enc, "UTF-8");
    }

    #[test]
    fn decode_gbk_falls_back_to_gb18030() {
        // "中文ab" 的 GBK 编码字节（D6 D0 CE C4 61 62）不是合法 UTF-8
        let bytes: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4, b'a', b'b'];
        let (text, enc) = decode_bytes(bytes);
        assert_eq!(text, "中文ab");
        assert_eq!(enc, "GB18030");
    }

    #[test]
    fn decode_garbage_still_labels_gb18030_with_replacement() {
        let (text, enc) = decode_bytes(&[0xFF, 0xFE, 0x61]);
        assert_eq!(enc, "GB18030");
        assert!(text.contains('\u{FFFD}')); // 替换字符而非 panic/丢内容
    }

    #[test]
    fn file_mtime_millis_tracks_write() {
        let dir = std::env::temp_dir().join(format!("qingbird-mtime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.md");
        assert_eq!(dto::file_mtime_millis(&p), None); // 不存在 → None
        std::fs::write(&p, "x").unwrap();
        let m = dto::file_mtime_millis(&p).unwrap();
        assert!(m > 0);
        std::fs::remove_file(&p).ok();
    }
}
