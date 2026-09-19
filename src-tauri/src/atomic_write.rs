//! 原子写：同目录临时文件 + rename 覆盖（REL-3 / P1-6）。
//!
//! `std::fs::write` 内部是 `File::create`（先把目标**截断到 0**）+ `write_all`：
//! 写到一半崩溃/断电，目标路径上留下的是一个被截断/半截的文件——用户的文档、
//! 设置、会话快照就此损坏。本模块把「覆盖用户文件」的窗口收窄为「留下一个
//! `.tmp` 残骸」：临时文件写完、`sync_all` 落盘后才 rename 盖到目标上，崩溃
//! 时目标要么已是完整新内容、要么保持旧内容原封不动。
//!
//! - 临时文件与目标**同目录**：跨卷 rename 会退化为复制+删除，失去原子性。
//! - 临时文件名带 pid + 纳秒戳，崩溃残骸不会与后续写入撞名（残骸体积小、
//!   频率极低，未做启动清扫；需要时可按 `.名称.tmp-<pid>-<nanos>` 前缀清理）。
//! - Windows 语义：`std::fs::rename` 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，
//!   目标已存在时直接覆盖，可依赖。
use std::fs::File;
use std::io::Write;
use std::path::Path;

/// 原子地把 `contents` 写到 `path`（覆盖语义）。任一步失败时删除临时文件并
/// 原样返回错误——目标文件保持旧内容，绝不留半截文件顶替。
///
/// 不负责创建父目录：调用方（storage / hibernate / cache）本就各自
/// `create_dir_all`，此处不重复策略。
pub fn write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "atomic write target has no file name",
        )
    })?;
    // parent 为空（裸文件名，相对 CWD）时 join 结果就是临时名本身，语义不变。
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let res = write_via_temp(&tmp, path, contents);
    if res.is_err() {
        // 失败清理：半截内容只存在于临时文件，绝不让它顶替目标。
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// 单次写入的固定步骤：create_new（不撞已有文件）→ 写全 → 落盘 → rename 覆盖。
fn write_via_temp(tmp: &Path, target: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut f = File::create_new(tmp)?;
    f.write_all(contents)?;
    // 数据先落盘再 rename：断电后 rename 过去的目标要么是完整新内容，要么
    // 根本没 rename（目标保持旧内容）。
    f.sync_all()?;
    drop(f);
    std::fs::rename(tmp, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "qingbird-atomic-write-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tmp_dir("overwrite");
        let target = dir.join("doc.md");
        std::fs::write(&target, b"old").unwrap();
        write(&target, b"new content").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        assert_eq!(entries(&dir), vec!["doc.md"], "无 .tmp 残留");
    }

    #[test]
    fn creates_missing_target_and_no_residue() {
        let dir = tmp_dir("fresh");
        let target = dir.join("s.json");
        write(&target, b"{}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        assert_eq!(entries(&dir), vec!["s.json"], "只应有目标文件本身");
    }

    /// 写失败注入（Windows 专属）：以**不含 FILE_SHARE_DELETE** 的共享模式
    /// 持有目标句柄（std `File::open` 默认三共享位全开，拦不住 rename），
    /// rename 覆盖会因 sharing violation 失败。断言：报错、旧内容原封不动、
    /// 不留半截临时文件。
    #[cfg(windows)]
    #[test]
    fn failed_rename_keeps_old_content_and_cleans_temp() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2; // 刻意不含 FILE_SHARE_DELETE (0x4)
        let dir = tmp_dir("fail");
        let target = dir.join("s.json");
        std::fs::write(&target, b"old-value").unwrap();
        let _guard = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&target)
            .unwrap();
        assert!(write(&target, b"new-value").is_err(), "句柄占用必须导致失败");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"old-value",
            "失败绝不破坏旧内容"
        );
        assert_eq!(entries(&dir), vec!["s.json"], "失败后临时文件必须被清理");
    }
}
