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

/// P1-2(SEC-2) 回归：resolve_image 是唯一被**文档内容**直接驱动的路径入口
/// （恶意 .md 的 `<img src>`），解析结果逃出允许根（文档目录 / 已登记工作区
/// 根）时必须返回 None 且不放进 asset scope——否则 P1-1 的运行时逐文件放行
/// 会把逃逸路径重新变成可读。
#[test]
fn resolve_image_rejects_escape_outside_allowed_roots() {
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::generate_context!())
        .expect("test app build");
    let root = std::env::temp_dir().join(format!("qingbird-p12-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    // 逃逸目标真实存在：否则 allow_file 因不存在而失败，is_allowed 断言失去区分度
    std::fs::write(root.join("outside.png"), b"png").unwrap();

    let root_s = root.to_string_lossy().replace('\\', "/");
    let base = format!("{root_s}/docs");
    let scope = app.handle().asset_protocol_scope();

    // 恶意文档的 `..` 逃逸：未登记工作区根时必须拒绝（今天会放行）
    assert_eq!(
        resolve_image(app.handle().clone(), "../outside.png".into(), Some(base.clone())),
        None,
        "`..` 逃出文档目录未被拒绝"
    );
    assert!(!scope.is_allowed(&format!("{root_s}/outside.png")), "逃逸路径被放进了 asset scope");

    // file:// 绝对路径指向允许根之外 → 同样拒绝
    assert_eq!(
        resolve_image(app.handle().clone(), format!("file://{root_s}/outside.png"), None),
        None,
        "file:// 绝对路径逃逸未被拒绝"
    );
    assert!(!scope.is_allowed(&format!("{root_s}/outside.png")));

    // 登记工作区根后：`..` 进入根内（文档目录之外）恢复放行——这正是根校验
    // 要保住的合法形态（工作区子目录文档引用工作区级 assets）。
    qingbird_md_lib::register_workspace_root_for_test(&root.to_string_lossy());
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("assets").join("shared.png"), b"png").unwrap();
    let in_ws = format!("{root_s}/assets/shared.png");
    assert_eq!(
        resolve_image(app.handle().clone(), "../assets/shared.png".into(), Some(base.clone()))
            .as_deref(),
        Some(in_ws.as_str()),
        "登记根后的工作区级 `../` 引用被误拒"
    );
    assert!(scope.is_allowed(&in_ws), "登记根内的解析路径未放进 asset scope");

    // 越过工作区根的 `..`：仍拒绝
    assert_eq!(
        resolve_image(app.handle().clone(), "../../escape.png".into(), Some(base)),
        None,
        "越过登记根的 `..` 逃逸未被拒绝"
    );

    std::fs::remove_dir_all(&root).ok();
}

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

    // file:// 绝对路径（文档在任意盘符目录的既有形态）：同样即时放行。
    // P1-2(SEC-2) 起，「逃出文档目录且无已登记工作区根」的绝对路径会被根
    // 校验拒绝（见下方 escape 测试）——此处改用文档目录内的绝对路径验证
    // 「file:// + 逐文件放行」契约本身。
    let in_doc_abs = format!("{root_s}/docs/pic.png");
    assert_eq!(
        resolve_image(app.handle().clone(), format!("file://{in_doc_abs}"), Some(base.clone()))
            .as_deref(),
        Some(in_doc_abs.as_str())
    );
    assert!(scope.is_allowed(&in_doc_abs), "resolve_image 未放行解析出的 file:// 图片");

    std::fs::remove_dir_all(&root).ok();
}
