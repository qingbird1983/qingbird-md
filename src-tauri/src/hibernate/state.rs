//! 休眠状态机：计时线程、与前端握手落草稿、销毁收口（含 P1-11 TOCTOU
//! 复检与 abandon_cancelled_hibernate 统一收尾——逻辑原样）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use super::session::clear_snapshot;
use super::window::{HANDSHAKE_TIMEOUT, MAIN_LABEL};

/// 关窗后到真正销毁的空闲时长。体感不可接受时单点调大（15–30 分钟）。
pub const HIBERNATE_DELAY: Duration = Duration::from_secs(5 * 60);

/// 实测用的延迟覆盖键：设 `QINGBIRD_HIBERNATE_DELAY_SECS=20` 就能在 20 秒内
/// 走完一遍休眠→唤醒，不必干等 5 分钟。不设或解析失败即回默认。
const DELAY_OVERRIDE_ENV: &str = "QINGBIRD_HIBERNATE_DELAY_SECS";

fn hibernate_delay() -> Duration {
    std::env::var(DELAY_OVERRIDE_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(HIBERNATE_DELAY)
}

/// 计时线程轮询间隔。用轮询而非 `sleep(5min)`：唤醒时必须能立刻取消。
const TICK: Duration = Duration::from_secs(1);

/// 计划休眠时刻；`None` = 无计划。
static HIBERNATE_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// 计时线程存活标记（进程级单例，防重复 spawn）。
static WATCHING: AtomicBool = AtomicBool::new(false);
/// 休眠握手信道：`send(())` == 前端已落完草稿，可以销毁。
static READY_TX: Mutex<Option<Sender<()>>> = Mutex::new(None);
/// 握手窗口内被 [`cancel`] 叫停（用户抢在销毁前唤醒了窗口）。
static CANCELLED: AtomicBool = AtomicBool::new(false);

// ---- 休眠状态机 ----

/// 关窗时调用：从现在起 [`HIBERNATE_DELAY`] 后销毁主窗口。
pub fn schedule(app: &tauri::AppHandle) {
    eprintln!(
        "[hibernate] 关窗：排定 {:.0}s 后销毁 WebView",
        hibernate_delay().as_secs_f64()
    );
    *HIBERNATE_AT.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Instant::now() + hibernate_delay());
    CANCELLED.store(false, Ordering::SeqCst);
    start_watcher(app.clone());
}

/// 任一唤醒路径（托盘 / 热键 / 单实例 handoff）调用：取消待卸载计时。
pub fn cancel() {
    let had_pending = HIBERNATE_AT.lock().unwrap_or_else(|e| e.into_inner()).take().is_some();
    if had_pending {
        eprintln!("[hibernate] 唤醒：取消待卸载计时");
    }
    // 销毁倒计时已启动、前端正在落草稿时用户抢先唤醒 → 让 do_hibernate 放弃销毁。
    CANCELLED.store(true, Ordering::SeqCst);
}

/// 纯函数：给定当前时刻与计划时刻，判断是否到点。
/// 抽成纯函数以便离线断言（`Instant` 本身无法在单测里构造出可比对的未来值）。
pub fn should_hibernate(now: Instant, scheduled_at: Option<Instant>) -> bool {
    matches!(scheduled_at, Some(at) if now >= at)
}

fn start_watcher(app: tauri::AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return; // 已在跑：它每秒重查 HIBERNATE_AT，无需第二个线程
    }
    let spawned = std::thread::Builder::new()
        .name("hibernate-watch".into())
        .spawn(move || loop {
            let due = {
                let at = HIBERNATE_AT.lock().unwrap_or_else(|e| e.into_inner());
                should_hibernate(Instant::now(), *at)
            };
            if due {
                *HIBERNATE_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
                do_hibernate(&app);
            }
            std::thread::sleep(TICK);
        });
    if let Err(e) = spawned {
        // spawn 失败必须复位标记，否则后续 schedule 再也不会重试
        WATCHING.store(false, Ordering::SeqCst);
        eprintln!("[hibernate] watcher spawn failed: {e}");
    }
}

/// 休眠在销毁前被唤醒（[`CANCELLED`] 置位）的统一收尾。
///
/// 前端已经落了草稿，但这次休眠作废了：必须删掉它。否则文件会一直
/// 躺在磁盘上，等下次真正的冷启动时冒出用户早就不用的旧内容。
fn abandon_cancelled_hibernate() {
    eprintln!("[hibernate] 销毁前检测到唤醒，放弃本次休眠");
    if let Err(e) = clear_snapshot() {
        eprintln!("[hibernate] 清理已取消的草稿失败: {e}");
    }
}

/// 到点：与前端握手落草稿 → 销毁。
fn do_hibernate(app: &tauri::AppHandle) {
    eprintln!("[hibernate] 到点：发起休眠握手（等前端落草稿 {HANDSHAKE_TIMEOUT:?}）");
    let (tx, rx) = mpsc::channel();
    *READY_TX.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);

    // 前端收此事件 → save_session → hibernate_ready（src/lib/session.ts）
    if let Err(e) = app.emit("session-hibernate", ()) {
        eprintln!("[hibernate] emit session-hibernate 失败: {e}");
    }
    match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(()) => {}
        Err(_) => eprintln!("[hibernate] 前端握手超时，强制销毁（草稿可能不完整）"),
    }
    *READY_TX.lock().unwrap_or_else(|e| e.into_inner()) = None;

    if CANCELLED.load(Ordering::SeqCst) {
        abandon_cancelled_hibernate();
        return;
    }
    match app.get_webview_window(MAIN_LABEL) {
        Some(w) => {
            // TOCTOU 收口（审查 REL-5）：上面那次检查与 destroy 之间还隔着窗口
            // 查找，用户可恰在此间隙唤醒（cancel() 置位 + ensure_main_window 把
            // 窗口 show 回来）——直接 destroy 会把刚弹回的窗口打掉（闪现又消失）。
            // 销毁前复检一次：剩余竞态窗口收窄到复检与 destroy 之间的几条指令。
            if CANCELLED.load(Ordering::SeqCst) {
                eprintln!("[hibernate] destroy 前复检到唤醒，放弃本次休眠");
                abandon_cancelled_hibernate();
                return;
            }
            if let Err(e) = w.destroy() {
                eprintln!("[hibernate] destroy 失败: {e}");
            } else {
                eprintln!("[hibernate] 主窗口已销毁（WebView 内存归还）");
            }
        }
        None => eprintln!("[hibernate] 主窗口已不存在，跳过销毁"),
    }
}

/// 前端落完草稿后调用（唤醒 [`do_hibernate`] 的等待）。
pub fn mark_ready() -> Result<(), String> {
    match READY_TX
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        Some(tx) => tx.send(()).map_err(|e| format!("休眠握手信道已关闭: {e}")),
        None => Err("当前没有待处理的休眠握手".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- should_hibernate（纯逻辑，Instant 由调用方给出）----

    #[test]
    fn no_schedule_means_never_hibernate() {
        assert!(!should_hibernate(Instant::now(), None));
    }

    #[test]
    fn past_schedule_hibernates() {
        let at = Instant::now() - Duration::from_secs(1);
        assert!(should_hibernate(Instant::now(), Some(at)));
    }

    #[test]
    fn future_schedule_waits() {
        let at = Instant::now() + Duration::from_secs(3600);
        assert!(!should_hibernate(Instant::now(), Some(at)));
    }

    #[test]
    fn exactly_due_is_due() {
        // 到点即触发（>=）：轮询精度 1s，边界取闭区间避免多等一轮
        let now = Instant::now();
        assert!(should_hibernate(now, Some(now)));
    }
}
