//! IPC bridge for translation: wire event types, cache-hit fast path, and the
//! background worker that turns a worker thread into the three translate
//! events the frontend subscribes to.
//!
//! Translation commands live here too: they're a single coherent surface
//! around the same `translate::engine` + cache pair.
//!
//! 拆自 lib.rs：god-file 阶段保留 lib.rs 给 AppTxn / run() / 通用浅壳命令。
//!
//! P2-7a 拆分布局：events = wire 事件类型；payload = 载荷组装；worker =
//! 后台翻译线程与活动戳/running 守卫；commands = 9 个 IPC 命令外壳。

mod commands;
mod events;
mod payload;
mod worker;

// lib.rs 以 `bridge::X` 注册 9 个命令（全仓 use 零改动约束）——经此处再导出
// 保住旧路径。
pub use commands::{
    check_translation, export_translation, get_providers, llm_list_models, lookup_word,
    render_translated, stop_translation, translate_document, translate_text,
};

// `#[tauri::command]` 会为每个 pub 命令在定义模块内生成隐藏伴随宏（`__cmd__X`
// 包装 + `__tauri_command_name_X` 命令名，其自带的那行 `pub use` 停在 commands
// 层），generate_handler 展开后按 `bridge::__cmd__X!` 路径解析——须同样再导出，
// lib.rs 的注册路径才能原样工作。
#[doc(hidden)]
pub use commands::{
    __cmd__check_translation, __cmd__export_translation, __cmd__get_providers,
    __cmd__llm_list_models, __cmd__lookup_word, __cmd__render_translated,
    __cmd__stop_translation, __cmd__translate_document, __cmd__translate_text,
    __tauri_command_name_check_translation, __tauri_command_name_export_translation,
    __tauri_command_name_get_providers, __tauri_command_name_llm_list_models,
    __tauri_command_name_lookup_word, __tauri_command_name_render_translated,
    __tauri_command_name_stop_translation, __tauri_command_name_translate_document,
    __tauri_command_name_translate_text,
};
