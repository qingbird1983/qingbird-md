//! lib.rs 命令族拆分（P2-7d）：file = 文档 IO / 编辑器外壳 / 预览解析；
//! workspace_ops = 工作区右键一族；dialogs = 对话框 + 外链白名单（同族：
//! 都是「前端请求系统侧动作」的薄壳）；settings = 设置 / 缓存 / 会话转发布。
//! 各模块命令以 `commands::X::name` 全路径注册进 generate_handler!（wire 名
//! 逐字不变）。
pub(crate) mod dialogs;
pub(crate) mod file;
pub(crate) mod settings;
pub(crate) mod workspace_ops;
