// 会话快照版本号单点定义（P2-3/CQ-6 去重）：此前 lib/session.ts 与
// stores/useDocStore.ts 各持一份同值常量。不能收进 session.ts——那模块读
// store（useDocStore 等），store 反向 import 会成环（见 session.ts 头注释
// 「store 不读本模块」）；故下沉为无依赖小模块，两侧各自 import。
//
// 三方同值契约：与 Rust 侧 hibernate.rs 的 SESSION_VERSION 一致，改动须同步。
export const SESSION_VERSION = 1;
