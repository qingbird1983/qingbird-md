//! 引擎 wire 事件类型（经 engine.rs 再导出，前端 wire 不变）。

/// Events emitted while a run is in flight. Every variant is cheap and
/// idempotent for the UI: `Unit` may arrive in any order.
pub enum EngineEvent {
    /// One unit's translation is ready. `from_cache` = 缓存命中（前端据此
    /// 跳过打字动画直接上屏，qingniao round2 #5 语义）。
    Unit { index: usize, text: String, from_cache: bool },
    /// 单单元裸发路径的实时增量（累积文本，随 SSE delta 增长）。前端据此
    /// 直写 DOM（灰字+省略号，qingniao `TranslationState::Streaming` 语义），
    /// 找回"逐字吐出"；同一 index 的 `Unit` 到达后再定格。
    Streaming { index: usize, text: String },
    /// Progress across all units of the run.
    Progress { done: usize, total: usize },
    /// One unit failed; the rest of the run continues. 事件层刻意不消费
    /// 这两个字段（lib.rs 把单段失败当"结果缺席"处理，done 事件统一带
    /// 首个错误）——字段留给未来前端单段标红的扩展，先挂 allow 免噪音。
    #[allow(dead_code)]
    Failed { index: usize, error: String },
}
