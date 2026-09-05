//! Windows 工作集主动 trim：把 Rust 进程「已分配但不一定需要」的工作集页还给 OS。
//!
//! ## 为什么需要
//!
//! Rust 默认用 Windows HeapAlloc：free 后块留在堆的空闲链表里，**不会 decommit
//! 回 OS**。截图流程的 ~25MB 临时缓冲（RGBA + PNG + 译文图）、翻译过程中的
//! 各种中间 `String`/`Vec<u8>`，drop 后内存还在堆里。任务管理器看到的"专用
//! 工作集"因此**只涨不跌**——即使后续代码逻辑上不再持有。
//!
//! ## 解法
//!
//! `SetProcessWorkingSetSize(hProcess, -1, -1)`（SIZE_T 的 -1 是特殊语义）
//! 会让 OS 立即把进程工作集里所有页 trim 出去；下次访问时硬缺页再装回来。
//! **休眠/冷重建路径里调最合适**：唤醒反正要硬缺页重建，零代价。
//!
//! 非 Windows 平台编译为 no-op（项目当前仅 Windows 发布，但单测在 macOS
//! 开发机也要跑得通）。

#[cfg(windows)]
pub fn trim_working_set() {
    use windows_sys::Win32::System::Threading::{SetProcessWorkingSetSize, GetCurrentProcess};
    // SAFETY：仅调一次 OS API，参数都是合法值。
    unsafe {
        // SIZE_T 的 -1（即 usize::MAX）让 API 把当前工作集 trim 到 0；
        // 最小/最大值都用 usize::MAX 等同于 EmptyWorkingSet 的语义。
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

#[cfg(not(windows))]
pub fn trim_working_set() {
    // 非 Windows 平台无操作；编译期即可消除（#[cfg(not(windows))]）。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_working_set_is_callable_and_idempotent() {
        // 调一次不应 panic；连续多次调也安全（API 幂等）。
        trim_working_set();
        trim_working_set();
    }
}