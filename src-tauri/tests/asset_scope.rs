//! P1-1(SEC-1) 回归：asset scope 收窄（conf `scope: []`）后，`resolve_image`
//! 必须把解析出的每个图片路径逐个放进 asset 协议 scope，否则既有功能
//! （文档在任意盘符目录，预览照常出图）回退。
//!
//! 为什么放集成测试而非 lib 单测：要用真实 Wry 运行时 `Builder::build`
//! （generate_context! 以真实 tauri.conf.json 为种子），测试 exe 因此链入
//! comctl32——没有 Common-Controls v6 manifest 时进程起步即 0xc0000139
//! （STATUS_ENTRYPOINT_NOT_FOUND，tauri 上游 #13419/#13954 同因），由
//! build.rs 的 `rustc-link-arg-tests` 嵌 `windows-test-manifest.xml` 解决；
//! tauri 2.11.5 自带的 mock runtime（feature "test"）在本机报同样的错，弃用。

use qingbird_md_lib::resolve_image_for_test as resolve_image;
use tauri::Manager;

#[test]
fn resolve_image_grants_asset_scope_for_resolved_paths() {
    let app = tauri::Builder::default()
        .any_thread() // 测试跑在 harness 的 worker 线程，允许在该线程建事件循环
        .build(tauri::generate_context!())
        .expect("test app build");
    let root = std::env::temp_dir().join(format!("qingbird-p11-{}", std::process::id()));
    let docs = root.join("docs");
    std::fs::remove_dir_all(&root).ok(); // 上次失败残留
    std::fs::create_dir_all(&docs).unwrap();
    let in_doc = docs.join("pic.png");
    std::fs::write(&in_doc, b"png").unwrap();
    let img = root.join("assets").join("pic.png");
    std::fs::create_dir_all(img.parent().unwrap()).unwrap();
    std::fs::write(&img, b"png").unwrap();

    let root_s = root.to_string_lossy().replace('\\', "/");
    let base = format!("{root_s}/docs");
    let expect = format!("{root_s}/docs/pic.png");
    let scope = app.handle().asset_protocol_scope();

    // conf 起步 scope 为空：命令放行前，文档目录内文件也不可读
    assert!(!scope.is_allowed(&expect), "asset scope 起步即放行，说明 scope 未收窄");

    // 相对路径图片：命令把解析出的绝对路径即时放进 scope
    assert_eq!(
        resolve_image(app.handle().clone(), "pic.png".into(), Some(base.clone())).as_deref(),
        Some(expect.as_str())
    );
    assert!(scope.is_allowed(&expect), "resolve_image 未放行解析出的相对路径图片");

    // file:// 绝对路径（文档在任意盘符目录的既有形态）：同样即时放行
    let outside = format!("{root_s}/assets/pic.png");
    assert_eq!(
        resolve_image(app.handle().clone(), format!("file://{outside}"), None).as_deref(),
        Some(outside.as_str())
    );
    assert!(scope.is_allowed(&outside), "resolve_image 未放行解析出的 file:// 图片");

    std::fs::remove_dir_all(&root).ok();
}
