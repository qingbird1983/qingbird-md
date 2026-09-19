fn main() {
    // icon.ico 变更必须触发构建脚本重跑，否则 exe 资源里嵌的仍是旧图标
    //（tauri-build 自身的 rerun-if-changed 不含图标文件，cargo 会缓存构建脚本输出，
    //  表现为：改了图标、重新构建安装，桌面快捷方式/任务栏仍显示旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build();

    // P1-1 回归需要测试 exe 链入 tauri 的 app 构建对象（Builder::build +
    // generate_context!），这会拉进 comctl32 导入；测试二进制没有嵌
    // Common-Controls v6 manifest 时加载器绑到 WinSxS 的 comctl32 v5，
    // 进程起步即 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND）。与 tauri 官方
    // 仓库 embed_manifest_for_tests 同解（其 .cargo/config.toml 注释）；
    // rustc-link-arg-tests 只作用于测试二进制，主程序 manifest 不受影响。
    #[cfg(target_os = "windows")]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
