fn main() {
    // icon.ico 变更必须触发构建脚本重跑，否则 exe 资源里嵌的仍是旧图标
    //（tauri-build 自身的 rerun-if-changed 不含图标文件，cargo 会缓存构建脚本输出，
    //  表现为：改了图标、重新构建安装，桌面快捷方式/任务栏仍显示旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
