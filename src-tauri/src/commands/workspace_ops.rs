//! 工作区右键一族：树构建/过滤 + 树右键写命令（创建/重命名/删除到回收站/
//! 定位/终端/移动/模板新建）。写命令统一 SEC-2 根校验（fail closed）。

use crate::{dto, workspace};

/// Walk a workspace folder into the frontend file tree (`.md`/`.markdown`
/// `.txt` only; dotfiles and vendored/build dirs skipped by `workspace::walk`).
///
/// P1-2(SEC-2)：每次打开同时把该目录登记进本会话的允许根——树右键一族写
/// 命令与 `resolve_image` 的根校验都以它为边界。前端传来的树路径全部来自
/// 本命令的 walk 结果，故登记天然覆盖所有既有流程。
#[tauri::command]
pub fn open_workspace(path: String) -> Vec<dto::TreeNodeDTO> {
    workspace::register_root(std::path::Path::new(&path));
    workspace::walk(std::path::Path::new(&path))
}

/// Filter a client-held tree by filename query.
#[tauri::command]
pub fn filter_workspace(tree: Vec<dto::TreeNodeDTO>, query: String) -> Vec<dto::TreeNodeDTO> {
    workspace::filter(&tree, &query)
}

/// Create an empty file; refuses to overwrite (`create_new`).
///
/// P1-2(SEC-2)：树右键一族命令统一根校验（见 [`workspace::ensure_within_roots`]）；
/// 调用方路径全部来自 open_workspace 的树，校验不破坏既有流程。
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    workspace::ensure_within_roots(std::path::Path::new(&path))?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(()),
        Err(e) => Err(create_err("创建文件失败", &path, e)),
    }
}

/// Create a single directory (no parents implied).
#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    workspace::ensure_within_roots(std::path::Path::new(&path))?;
    std::fs::create_dir(&path).map_err(|e| create_err("创建文件夹失败", &path, e))
}

/// 同目录重命名，返回新的完整路径（前端据此更新标签/树）。
#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    // 目标 = 同父目录拼接（validate_name 禁分隔符/`..`），源在根内则目标同在
    workspace::ensure_within_roots(std::path::Path::new(&path))?;
    let target = workspace::renamed_path(&path, &new_name)?;
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("原路径不存在".into());
    }
    if target != path && std::path::Path::new(&target).exists() {
        return Err("已存在同名文件或文件夹".into());
    }
    std::fs::rename(&path, &target).map_err(|e| format!("重命名失败 {path}: {e}"))?;
    Ok(target)
}

/// 删除文件/文件夹（Windows 走回收站，可撤销）。
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    workspace::ensure_within_roots(std::path::Path::new(&path))?;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(windows)]
    {
        delete_to_trash(&path)
    }
    #[cfg(not(windows))]
    {
        Err("当前平台不支持删除到回收站".into())
    }
}

/// Windows：SHFileOperationW + FOF_ALLOWUNDO = 删除到回收站（无二次确认弹窗）。
#[cfg(windows)]
fn delete_to_trash(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        SHFileOperationW, SHFILEOPSTRUCTW,
    };

    // pFrom 是需要双 NUL 结尾的宽字符列表（支持一次多项）。
    let mut from: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().collect();
    from.push(0);
    from.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE as u32,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("删除失败（系统错误 {rc}）"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("删除已取消".into());
    }
    Ok(())
}

/// 给 explorer 的「选中文件」原始参数：`/select,"<完整路径>"`。
/// 必须经 `CommandExt::raw_arg` 原样写进命令行——std 默认转义会给这枚
/// 含空格+引号的参数再包一层壳，explorer 就解析不出目标了。
pub(crate) fn reveal_select_arg(path: &str) -> String {
    format!("/select,\"{path}\"")
}

/// 在资源管理器中定位：文件选中该文件，目录直接打开。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    let mut cmd = std::process::Command::new("explorer.exe");
    if p.is_dir() {
        cmd.arg(&path);
    } else {
        // /select,"路径" 必须整枚原样直达 explorer（见 reveal_select_arg）
        cmd.raw_arg(reveal_select_arg(&path));
    }
    cmd.spawn().map_err(|e| format!("打开资源管理器失败：{e}"))?;
    Ok(())
}

/// 在该路径所在目录打开系统终端（cmd，新窗口继承该工作目录）。
#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().map(|d| d.to_path_buf()).ok_or_else(|| "无法定位目录".to_string())? };
    if !dir.exists() {
        return Err("目录不存在".into());
    }
    std::process::Command::new("cmd")
        .current_dir(&dir)
        .args(["/c", "start", "", "cmd"])
        .spawn()
        .map_err(|e| format!("打开终端失败：{e}"))?;
    Ok(())
}

/// 移动文件/目录到目标目录（同名冲突拒绝覆盖），返回新路径。
#[tauri::command]
pub fn move_path(path: String, dest_dir: String) -> Result<String, String> {
    // 源与目标目录各自校验：跨已登记根移动合法（两棵树都在侧栏里可见）
    workspace::ensure_within_roots(std::path::Path::new(&path))?;
    workspace::ensure_within_roots(std::path::Path::new(&dest_dir))?;
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("原路径不存在".into());
    }
    let dest = std::path::Path::new(&dest_dir);
    if !dest.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let target = workspace::moved_path(&path, &dest_dir)?;
    if std::path::Path::new(&target).exists() {
        return Err("目标目录已存在同名项".into());
    }
    match std::fs::rename(&path, &target) {
        Ok(()) => Ok(target),
        Err(e) => {
            // 跨卷 rename 失败：文件退化为复制 + 删除源
            if src.is_file() {
                std::fs::copy(src, &target).map_err(|e2| format!("移动失败：{e2}"))?;
                std::fs::remove_file(src).map_err(|e2| format!("移动失败：{e2}"))?;
                Ok(target)
            } else {
                Err(format!("移动失败：{e}"))
            }
        }
    }
}

/// 从模板新建文档（模板正文见 workspace::template_body），返回新文件路径。
#[tauri::command]
pub fn create_from_template(dir: String, name: String, kind: String) -> Result<String, String> {
    workspace::ensure_within_roots(std::path::Path::new(&dir))?;
    let clean = name.trim();
    workspace::validate_name(clean)?;
    let file_name = if clean.to_lowercase().ends_with(".md") { clean.to_string() } else { format!("{clean}.md") };
    let target = std::path::Path::new(&dir).join(&file_name);
    let body = workspace::template_body(&kind);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(body.as_bytes()).map_err(|e| format!("写入模板失败：{e}"))?;
            Ok(target.to_string_lossy().into_owned())
        }
        Err(e) => Err(create_err("新建文件失败", &target.to_string_lossy(), e)),
    }
}

/// Wire-contract error text: "已存在" when the target exists (the frontend
/// may match on it), contextual message for any other IO failure.
fn create_err(what: &str, path: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        "已存在".into()
    } else {
        format!("{what} {path}: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_workspace_dto_command_matches_and_keeps_ancestors() {
        let mk_file = |n: &str| dto::TreeNodeDTO {
            name: n.into(),
            path: Some(format!("docs/{n}")),
            is_dir: false,
            children: vec![],
        };
        let tree = vec![dto::TreeNodeDTO {
            name: "docs".into(),
            path: Some("docs".into()),
            is_dir: true,
            children: vec![mk_file("readme.md"), mk_file("api.md")],
        }];

        let hit = filter_workspace(tree.clone(), "api".into());
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].children.len(), 1);
        assert_eq!(hit[0].children[0].name, "api.md");

        let miss = filter_workspace(tree.clone(), "zzz".into());
        assert!(miss.is_empty());

        let all = filter_workspace(tree.clone(), "   ".into()); // 空查询原样返回
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].children.len(), 2);
    }

    // ---- P1-2(SEC-2): 工作区写命令根校验 ----

    #[test]
    fn workspace_write_commands_fail_closed_without_registered_root() {
        // 未登记任何工作区根时写命令必须 fail closed：前端所有树右键操作
        // 的路径都来自 open_workspace 的 walk 结果（必在某个已登记根内），
        // 拒绝不破坏任何既有流程；被污染的前端任意路径写入在此被拦下。
        let dir = std::env::temp_dir().join(format!("qingbird-p12-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir_s = dir.to_string_lossy().into_owned();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();

        assert!(create_file(p("x.md")).is_err());
        assert!(create_folder(p("sub")).is_err());
        assert!(create_from_template(dir_s.clone(), "tpl.md".into(), "blank".into()).is_err());

        // rename / move：素材用 fs 直接准备（不依赖写命令本身），今天这两个
        // 命令会对根外路径成功执行——修复后必须在任何 IO 之前拒绝。
        std::fs::write(dir.join("a.md"), "x").unwrap();
        assert!(rename_path(p("a.md"), "b.md".to_string()).is_err());
        std::fs::create_dir(dir.join("dest")).unwrap();
        assert!(move_path(p("a.md"), p("dest")).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_write_commands_allow_registered_root_lifecycle() {
        // 登记根后：create → rename → move → delete 根内全生命周期放行；
        // 根外（另一未登记目录）仍拒绝。
        let dir = std::env::temp_dir().join(format!("qingbird-p12-round-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dest")).unwrap();
        workspace::register_root(&dir);
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();

        let f = dir.join("a.md");
        create_file(s(&f)).unwrap();
        let renamed = rename_path(s(&f), "b.md".to_string()).unwrap();
        let moved = move_path(renamed, s(&dir.join("dest"))).unwrap();
        assert_eq!(std::path::Path::new(&moved).file_name().unwrap(), "b.md");
        delete_path(moved).unwrap();

        let out =
            std::env::temp_dir().join(format!("qingbird-p12-round-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        assert!(create_file(s(&out.join("x.md"))).is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn select_arg_keeps_verbatim_quoting_for_explorer() {
        use super::reveal_select_arg;
        // explorer 自己解析原始命令行：必须是 /select,"<path>" 这个裸形态。
        // 旧实现交给 std 的 MSVCRT 转义（含空格参数被整枚再包一层引号、内引号变 \"），
        // explorer 解析失败 → 打开默认位置而不是文件所在目录（2026-09-24 用户报障）。
        assert_eq!(
            reveal_select_arg(r#"C:\我的 文档\a.md"#),
            r#"/select,"C:\我的 文档\a.md""#
        );
        assert_eq!(reveal_select_arg(r"C:\d\b.md"), r#"/select,"C:\d\b.md""#);
    }
}
