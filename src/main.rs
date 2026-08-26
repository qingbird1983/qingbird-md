#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod editor;
mod fileopen;
mod markdown;
mod single_instance;
mod state;
mod storage;
mod translate;
mod workspace;

use std::sync::atomic::Ordering;

use eframe::egui;
use markdown::render::RenderEnv;
use state::{AppState, Mode, Theme, View};
use translate::http::UreqClient;
use translate::providers::{self, Creds};
use translate::providers_meta;

fn main() -> eframe::Result {
    // Single instance: if another instance already runs, hand off the file
    // argument and exit without opening a second window.
    let lock = single_instance::acquire_lock();
    if lock.is_none() {
        if let Some(p) = fileopen::file_arg_from_args(std::env::args().skip(1)) {
            single_instance::write_pending(&p);
        }
        return Ok(());
    }
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 860.0])
            .with_min_inner_size([800.0, 600.0])
            .with_title("青鸟 Markdown 阅读器"),
        ..Default::default()
    };
    eframe::run_native("qingbird-md", opts, Box::new(move |cc| {
        Ok(Box::new(MyApp::new(cc, lock)))
    }))
}

fn initial_theme(ctx: &egui::Context) -> Theme {
    match ctx.system_theme() {
        Some(egui::Theme::Dark) => Theme::Dark,
        _ => Theme::Light,
    }
}

fn apply_theme(ctx: &egui::Context, theme: Theme) {
    match theme {
        Theme::Light => ctx.set_visuals(egui::Visuals::light()),
        Theme::Dark => ctx.set_visuals(egui::Visuals::dark()),
    }
}

/// Set the editor's cursor to a byte position (used after a toolbar op).
fn set_editor_cursor(ctx: &egui::Context, byte: usize) {
    use egui::text::{CCursor, CCursorRange};
    let id = egui::Id::new("md_editor");
    if let Some(mut st) = egui::text_edit::TextEditState::load(ctx, id) {
        st.cursor.set_char_range(Some(CCursorRange::one(CCursor::new(byte))));
        st.store(ctx, id);
    }
}

fn edit_button(app: &mut MyApp, ctx: &egui::Context, ui: &mut egui::Ui, name: &str, label: &str) {
    if ui.button(label).clicked() {
        app.apply_editor_op(ctx, name);
    }
}

/// Collect `(level, text)` for h1–h3 headings, in document order (recursing
/// into quotes/lists), for the outline panel.
fn outline_items(blocks: &[markdown::Block]) -> Vec<(u8, String)> {
    let mut out = Vec::new();
    walk_heading(blocks, &mut out);
    out
}

fn walk_heading(blocks: &[markdown::Block], out: &mut Vec<(u8, String)>) {
    for b in blocks {
        match b {
            markdown::Block::Heading { level, text } => {
                out.push((*level, markdown::render::inline_plain_text(text)));
            }
            markdown::Block::Quote { blocks } => walk_heading(blocks, out),
            markdown::Block::List { items, .. } => {
                for it in items {
                    walk_heading(&it.blocks, out);
                }
            }
            _ => {}
        }
    }
}

/// Printable name for a key (used in hotkey strings like "Alt+1").
fn key_name(key: egui::Key) -> Option<String> {
    use egui::Key::*;
    let s = match key {
        A => "A", B => "B", C => "C", D => "D", E => "E", F => "F", G => "G", H => "H", I => "I",
        J => "J", K => "K", L => "L", M => "M", N => "N", O => "O", P => "P", Q => "Q", R => "R",
        S => "S", T => "T", U => "U", V => "V", W => "W", X => "X", Y => "Y", Z => "Z",
        Num0 => "0", Num1 => "1", Num2 => "2", Num3 => "3", Num4 => "4", Num5 => "5", Num6 => "6",
        Num7 => "7", Num8 => "8", Num9 => "9",
        Space => "Space",
        _ => return None,
    };
    Some(s.to_string())
}

/// Build a hotkey string like "Alt+1" / "Ctrl+Shift+T" from modifiers+key.
fn hotkey_combo(mods: egui::Modifiers, key: egui::Key) -> Option<String> {
    let name = key_name(key)?;
    let mut parts: Vec<&str> = Vec::new();
    if mods.ctrl {
        parts.push("Ctrl");
    }
    if mods.alt {
        parts.push("Alt");
    }
    if mods.shift {
        parts.push("Shift");
    }
    if !mods.ctrl && mods.command {
        parts.push("Meta");
    }
    if parts.is_empty() {
        return None;
    }
    parts.push(&name);
    Some(parts.join("+"))
}

/// The hotkey combo pressed this frame, if a fresh non-repeat key-down.
fn hotkey_from_input(ctx: &egui::Context) -> Option<String> {
    ctx.input(|i| {
        i.events.iter().find_map(|e| match e {
            egui::Event::Key { key, pressed: true, modifiers, repeat: false, .. } => {
                hotkey_combo(*modifiers, *key)
            }
            _ => None,
        })
    })
}

/// egui's bundled fonts carry no CJK glyphs, so Chinese renders as tofu. Load a
/// system CJK font (Windows: YaHei / SimHei / DengXian / SimSun) and add it as
/// the fallback for both families.
fn add_cjk_font(ctx: &egui::Context) {
    let candidates = [
        "C:/Windows/Fonts/Deng.ttf",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/MSYH.TTC",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyh.ttf",
        "C:/Windows/Fonts/simsun.ttc",
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            let mut fonts = egui::FontDefinitions::default();
            let mut data = egui::FontData::from_owned(bytes);
            data.index = 0;
            fonts.font_data.insert("cjk".to_owned(), data);
            if let Some(fam) = fonts.families.get_mut(&egui::FontFamily::Proportional) {
                fam.push("cjk".to_string());
            }
            if let Some(fam) = fonts.families.get_mut(&egui::FontFamily::Monospace) {
                fam.push("cjk".to_string());
            }
            ctx.set_fonts(fonts);
            return;
        }
    }
}

struct MyApp {
    state: AppState,
    settings_open: bool,
    form_provider: String,
    form_creds: std::collections::HashMap<String, String>,
    test_result: String,
    last_mode: Mode,
    sel: (usize, usize),
    recording_hotkey: Option<String>,
    // Selection translation (划词): selected text, result, and an in-flight task.
    sel_text: String,
    sel_result: String,
    sel_loading: bool,
    sel_task: Option<std::sync::Arc<std::sync::Mutex<Option<String>>>>,
}

impl MyApp {
    fn new(cc: &eframe::CreationContext, lock: Option<std::fs::File>) -> Self {
        add_cjk_font(&cc.egui_ctx);
        let mut state = AppState::new();
        state._lock = lock;
        let theme = match state.settings.theme.as_str() {
            "dark" => Theme::Dark,
            "light" => Theme::Light,
            _ => initial_theme(&cc.egui_ctx),
        };
        apply_theme(&cc.egui_ctx, theme);
        state.theme = theme;
        // Open a file passed via file association (e.g. double-click a .md).
        if let Some(p) = fileopen::file_arg_from_args(std::env::args().skip(1)) {
            let _ = state.open(&p);
        }
        let form_provider = state.settings.provider.clone();
        let form_creds = state
            .settings
            .providers
            .get(&form_provider)
            .cloned()
            .unwrap_or_default();
        let last_mode = state.mode;
        MyApp {
            state,
            settings_open: false,
            form_provider,
            form_creds,
            test_result: String::new(),
            last_mode,
            sel: (0, 0),
            recording_hotkey: None,
            sel_text: String::new(),
            sel_result: String::new(),
            sel_loading: false,
            sel_task: None,
        }
    }

    fn open_settings(&mut self) {
        self.form_provider = self.state.settings.provider.clone();
        self.form_creds = self
            .state
            .settings
            .providers
            .get(&self.form_provider)
            .cloned()
            .unwrap_or_default();
        self.test_result.clear();
        self.settings_open = true;
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        if !self.settings_open {
            return;
        }
        let mut open = self.settings_open;
        egui::Window::new("翻译设置")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .show(ctx, |ui| {
                if let Some(mode) = self.recording_hotkey.clone() {
                    if let Some(combo) = hotkey_from_input(ctx) {
                        self.state.settings.hotkeys.insert(mode.clone(), combo.clone());
                        self.recording_hotkey = None;
                        self.test_result = format!("已保存快捷键（{mode}）：{combo}");
                    } else if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                        self.recording_hotkey = None;
                        self.test_result = "已取消录制".to_string();
                    }
                    ctx.request_repaint();
                }
                // Provider selection.
                let mut provider = self.form_provider.clone();
                egui::ComboBox::from_label("翻译源")
                    .selected_text(providers_meta::get(&provider).map(|m| m.label).unwrap_or(&provider))
                    .show_ui(ui, |ui| {
                        for (key, meta) in providers_meta::REGISTRY {
                            ui.selectable_value(&mut provider, key.to_string(), meta.label);
                        }
                    });
                if provider != self.form_provider {
                    self.form_provider = provider;
                    self.form_creds = self
                        .state
                        .settings
                        .providers
                        .get(&self.form_provider)
                        .cloned()
                        .unwrap_or_default();
                    self.test_result.clear();
                }
                if let Some(meta) = providers_meta::get(&self.form_provider) {
                    ui.label(meta.note);
                    if meta.fields.is_empty() {
                        ui.label("该翻译源无需密钥，可直接使用。");
                    } else {
                        for f in meta.fields {
                            ui.horizontal(|ui| {
                                ui.label(f.label);
                                let key = f.key.to_string();
                                let mut val = self.form_creds.entry(key.clone()).or_default().clone();
                                let resp = if f.secret {
                                    ui.add(egui::TextEdit::singleline(&mut val).password(true))
                                } else {
                                    ui.text_edit_singleline(&mut val).on_hover_text(f.placeholder)
                                };
                                let _ = resp;
                                self.form_creds.insert(key, val);
                            });
                        }
                    }

                    ui.separator();
                    ui.horizontal(|ui| {
                        if ui.button("测试连接").clicked() {
                            self.test_translate(ui);
                        }
                        if ui.button("清除翻译缓存").clicked() {
                            self.state.cache.clear();
                            let _ = self.state.cache.save(&storage::cache_path());
                            self.test_result = "翻译缓存已清除。".to_string();
                        }
                    });
                    if !self.test_result.is_empty() {
                        ui.label(&self.test_result);
                    }

                    ui.separator();
                    ui.label("阅读模式快捷键（点击后按下组合键，须含 Ctrl/Alt/Shift）");
                    for (mode, label) in [("original", "原文"), ("translation", "译文"), ("bilingual", "中英对照")] {
                        let current = self.state.settings.hotkeys.get(mode).cloned().unwrap_or_else(|| "未设置".to_string());
                        let text = if self.recording_hotkey.as_deref() == Some(mode) {
                            "按下快捷键…".to_string()
                        } else {
                            current.clone()
                        };
                        ui.horizontal(|ui| {
                            ui.label(label);
                            if ui.button(text).clicked() {
                                self.recording_hotkey = Some(mode.to_string());
                            }
                        });
                    }

                    ui.separator();
                    ui.horizontal(|ui| {
                        let mut enabled = self.state.settings.selection_translate;
                        if ui.checkbox(&mut enabled, "启用划词翻译（选中文字即弹出译文）").changed() {
                            self.state.settings.selection_translate = enabled;
                        }
                    });
                    ui.separator();
                    ui.horizontal(|ui| {
                        if ui.button("取消").clicked() {
                            self.settings_open = false;
                        }
                        if ui.button("保存").clicked() {
                            self.state.settings.provider = self.form_provider.clone();
                            self.state.settings.providers.insert(
                                self.form_provider.clone(),
                                self.form_creds.clone(),
                            );
                            storage::save_settings(&self.state.settings);
                            self.settings_open = false;
                        }
                    });
                }
            });
        self.settings_open = open;
    }

    fn test_translate(&mut self, _ui: &mut egui::Ui) {
        let provider = self.form_provider.clone();
        let creds = Creds(self.form_creds.clone());
        let test_text = "Hello, this is a translation test.";
        let http = UreqClient;
        match providers::provider(&provider, test_text, &creds, &http) {
            Ok(out) => self.test_result = format!("成功：{out}"),
            Err(e) => self.test_result = format!("失败：{e}"),
        }
    }

    fn reparse(&mut self) {
        self.state.doc.blocks = markdown::parse_blocks(&self.state.doc.content);
    }

    fn apply_editor_op(&mut self, ctx: &egui::Context, op: &str) {
        let (new, sel) = editor::apply_op(&self.state.doc.content, self.sel, op);
        self.state.doc.content = new;
        self.sel = sel;
        self.reparse();
        set_editor_cursor(ctx, sel.1);
    }

    fn save_doc(&mut self) {
        if let Some(path) = self.state.doc.path.clone() {
            match std::fs::write(&path, &self.state.doc.content) {
                Ok(_) => {
                    self.state.saved_content = self.state.doc.content.clone();
                    self.state.status = format!("已保存：{}", path.display());
                }
                Err(e) => self.state.status = format!("保存失败：{e}"),
            }
        } else if let Some(p) = fileopen::pick_save_path(&self.state.doc.name) {
            if std::fs::write(&p, &self.state.doc.content).is_ok() {
                self.state.doc.path = Some(p.clone());
                self.state.doc.name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "untitled.md".to_string());
                self.state.doc.base_dir = p.parent().map(|d| d.to_path_buf());
                self.state.saved_content = self.state.doc.content.clone();
                self.state.status = format!("已保存：{}", p.display());
            }
        }
    }

    fn editor_ui(&mut self, ctx: &egui::Context, ui: &mut egui::Ui) {
        let id = egui::Id::new("md_editor");
        let resp = ui.add_sized(
            [ui.available_width(), ui.available_height()],
            egui::TextEdit::multiline(&mut self.state.doc.content)
                .id(id)
                .code_editor()
                .desired_rows(30),
        );
        if resp.changed() {
            self.reparse();
        }
        if resp.has_focus() {
            if let Some(st) = egui::text_edit::TextEditState::load(ctx, id) {
                if let Some(range) = st.cursor.char_range() {
                    self.sel = (range.primary.index, range.secondary.index);
                }
            }
            if self.state.settings.selection_translate {
                let (s, e) = (self.sel.0.min(self.sel.1), self.sel.0.max(self.sel.1));
                let selected = self.state.doc.content.get(s..e).unwrap_or("").to_string();
                self.trigger_sel_translate(ctx, &selected);
            } else {
                self.sel_text.clear();
                self.sel_task = None;
                self.sel_loading = false;
            }
        }
    }

    fn editor_toolbar(&mut self, ctx: &egui::Context, ui: &mut egui::Ui) {
        edit_button(self, ctx, ui, "bold", "粗体");
        edit_button(self, ctx, ui, "italic", "斜体");
        edit_button(self, ctx, ui, "strike", "删除线");
        ui.separator();
        edit_button(self, ctx, ui, "h1", "H1");
        edit_button(self, ctx, ui, "h2", "H2");
        edit_button(self, ctx, ui, "h3", "H3");
        ui.separator();
        edit_button(self, ctx, ui, "ul", "无序");
        edit_button(self, ctx, ui, "ol", "有序");
        edit_button(self, ctx, ui, "task", "任务");
        edit_button(self, ctx, ui, "quote", "引用");
        ui.separator();
        edit_button(self, ctx, ui, "code", "行内代码");
        edit_button(self, ctx, ui, "codeblock", "代码块");
        ui.separator();
        edit_button(self, ctx, ui, "link", "链接");
        edit_button(self, ctx, ui, "image", "图片");
        edit_button(self, ctx, ui, "table", "表格");
        edit_button(self, ctx, ui, "hr", "分割线");
    }

    fn preview_ui(&mut self, ctx: &egui::Context, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.with_layout(egui::Layout::top_down(egui::Align::Center), |ui| {
                ui.set_width(820.0_f32.min(ui.available_width()));
                let blocks = self.state.doc.blocks.clone();
                let base_dir = self.state.doc.base_dir.clone();
                let mode = self.state.mode;
                let mut env = RenderEnv {
                    ctx,
                    base_dir,
                    textures: std::mem::take(&mut self.state.textures),
                };
                match mode {
                    Mode::Original => {
                        markdown::render::render_blocks(ui, &blocks, &mut env);
                    }
                    Mode::Translation => {
                        let mut counter = 0usize;
                        markdown::render::render_substituted(
                            ui,
                            &blocks,
                            &mut env,
                            &self.state.translation,
                            &mut counter,
                        );
                    }
                    Mode::Bilingual => {
                        let mut counter = 0usize;
                        markdown::render::render_translated(
                            ui,
                            &blocks,
                            &mut env,
                            &self.state.translation,
                            true,
                            &mut counter,
                        );
                    }
                }
                self.state.textures = env.textures;
            });
        });
    }

    fn open_dialog(&mut self) {
        if let Some(p) = fileopen::pick_markdown_file() {
            let _ = self.state.open(&p);
        }
    }

    fn open_workspace(&mut self) {
        if let Some(root) = fileopen::pick_folder() {
            let tree = workspace::walk(&root);
            self.state.ws_root = Some(root.clone());
            self.state.ws_tree = tree;
            self.state.nav_search.clear();
            self.state.status = format!("工作区：{}", root.display());
        }
    }

    fn open_tree_file(&mut self, path: &std::path::Path) {
        let _ = self.state.open(path);
    }

    fn nav_contents(&mut self, _ctx: &egui::Context, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.text_edit_singleline(&mut self.state.nav_search);
            if ui.button("打开工作区").clicked() {
                self.open_workspace();
            }
        });
        ui.separator();
        let q = self.state.nav_search.clone();
        let nodes = if q.trim().is_empty() {
            self.state.ws_tree.clone()
        } else {
            workspace::filter(&self.state.ws_tree, &q)
        };
        if nodes.is_empty() {
            ui.label("未打开工作区");
            return;
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            self.tree_ui(ui, &nodes);
        });
    }

    fn tree_ui(&mut self, ui: &mut egui::Ui, nodes: &[workspace::TreeNode]) {
        for node in nodes {
            if node.is_dir {
                let salt = node.path.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| node.name.clone());
                egui::CollapsingHeader::new(&node.name)
                    .id_salt(salt)
                    .show(ui, |ui| {
                        self.tree_ui(ui, &node.children);
                    });
            } else {
                let selected = self.state.doc.path.as_deref() == node.path.as_deref();
                let name = node.name.clone();
                if ui.selectable_label(selected, &name).clicked() {
                    if let Some(p) = &node.path {
                        let p = p.clone();
                        self.open_tree_file(&p);
                    }
                }
            }
        }
    }

    fn outline_contents(&mut self, ui: &mut egui::Ui) {
        let items = outline_items(&self.state.doc.blocks);
        if items.is_empty() {
            ui.label("（本文无标题）");
            return;
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            for (level, text) in items {
                let indent = (level as f32 - 1.0) * 12.0;
                ui.horizontal(|ui| {
                    ui.add_space(indent);
                    ui.label(text);
                });
            }
        });
    }

    fn handle_dropped_files(&mut self, ctx: &egui::Context) {
        let dropped = ctx.input(|i| i.raw.dropped_files.clone());
        if let Some(file) = dropped.first() {
            if let Some(path) = &file.path {
                if let Some(ext) = path.extension() {
                    let ext = ext.to_string_lossy().to_lowercase();
                    if ext == "md" || ext == "markdown" || ext == "txt" {
                        let _ = self.state.open(path);
                    }
                }
            }
        }
    }

    fn start_translate(&mut self, ctx: &egui::Context) {
        if self.state.txn_running.load(Ordering::SeqCst) {
            return;
        }
        if self.state.doc.blocks.is_empty() {
            self.state.status = "没有可翻译的内容".to_string();
            return;
        }
        let provider = self.state.settings.provider.clone();
        let creds = providers::Creds(
            self.state.settings.providers.get(&provider).cloned().unwrap_or_default(),
        );
        let Some(meta) = providers_meta::get(&provider) else {
            self.state.status = format!("未知翻译源：{provider}");
            return;
        };
        if meta.needs_key {
            let missing = meta.fields.iter().find(|f| creds.get(f.key).map(|v| v.is_empty()).unwrap_or(true));
            if let Some(f) = missing {
                self.state.status = format!("请先在「设置」中填写「{}」的{}", meta.label, f.label);
                return;
            }
        }

        let units = match self.state.mode {
            Mode::Translation => markdown::render::collect_text_runs(&self.state.doc.blocks),
            Mode::Bilingual => markdown::render::collect_translatable(&self.state.doc.blocks),
            Mode::Original => Vec::new(),
        };
        let texts: Vec<String> = units.iter().map(|(_, t)| t.clone()).collect();
        let indices: Vec<usize> = units.iter().map(|(i, _)| *i).collect();
        let max_len = meta.max_len;
        let max_conc = meta.max_concurrency;

        // Transfer into the background thread.
        let txn_running = self.state.txn_running.clone();
        let txn_result = self.state.txn_result.clone();
        let mut local_cache = self.state.cache.clone();
        txn_running.store(true, Ordering::SeqCst);
        self.state.translating = true;
        self.state.translation.clear();
        self.state.status = "翻译中…".to_string();
        let ctx = ctx.clone();

        let h = std::thread::spawn(move || {
            let http = UreqClient;
            let results = translate::pipeline::translate_units(
                &texts,
                &provider,
                &creds,
                max_len,
                max_conc,
                &mut local_cache,
                &http,
                &|_done, _total| {
                    ctx.request_repaint();
                },
            );
            let mut translation: std::collections::HashMap<usize, String> = Default::default();
            for (k, r) in indices.into_iter().zip(results.into_iter()) {
                if let Ok(v) = r {
                    translation.insert(k, v);
                }
            }
            *txn_result.lock().unwrap() = Some((translation, local_cache));
            txn_running.store(false, Ordering::SeqCst);
            ctx.request_repaint();
        });
        let _ = h;
    }

    fn poll_pending(&mut self) {
        if let Some(path) = single_instance::take_pending() {
            let _ = self.state.open(&path);
        }
    }

    fn poll_sel_translate(&mut self) {
        if let Some(task) = &self.sel_task {
            let done = task.lock().unwrap().take();
            if let Some(r) = done {
                self.sel_result = r;
                self.sel_loading = false;
                self.sel_task = None;
            }
        }
    }

    fn trigger_sel_translate(&mut self, ctx: &egui::Context, text: &str) {
        if text.is_empty() {
            self.sel_text.clear();
            self.sel_loading = false;
            self.sel_task = None;
            return;
        }
        if text == self.sel_text {
            return;
        }
        self.sel_text = text.to_string();
        self.sel_loading = true;
        let provider = self.state.settings.provider.clone();
        let creds = providers::Creds(self.state.settings.providers.get(&provider).cloned().unwrap_or_default());
        let http = UreqClient;
        let task = std::sync::Arc::new(std::sync::Mutex::new(None));
        self.sel_task = Some(task.clone());
        let ctx2 = ctx.clone();
        let txt = text.to_string();
        std::thread::spawn(move || {
            let r = providers::provider(&provider, &txt, &creds, &http);
            *task.lock().unwrap() = Some(match r {
                Ok(t) => t,
                Err(e) => format!("翻译失败：{e}"),
            });
            ctx2.request_repaint();
        });
    }

    fn render_sel_popup(&mut self, ctx: &egui::Context) {
        if self.sel_text.is_empty() {
            return;
        }
        let mut open = true;
        egui::Window::new("划词翻译")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_TOP, [0.0, 44.0])
            .show(ctx, |ui| {
                ui.label(&self.sel_text);
                ui.separator();
                if self.sel_loading || self.sel_task.is_some() {
                    ui.spinner();
                } else {
                    ui.label(&self.sel_result);
                }
            });
        if !open {
            self.sel_text.clear();
        }
    }

    fn poll_translate(&mut self, ctx: &egui::Context) {
        if self.state.txn_running.load(Ordering::SeqCst) {
            self.state.translating = true;
            self.state.status = "翻译中…".to_string();
            ctx.request_repaint();
            return;
        }
        if let Some((map, new_cache)) = self.state.txn_result.lock().unwrap().take() {
            self.state.translation = map;
            self.state.cache = new_cache;
            self.state.translating = false;
            let p = storage::cache_path();
            let _ = self.state.cache.save(&p);
            let provider = self.state.settings.provider.clone();
            let label = providers_meta::get(&provider).map(|m| m.label).unwrap_or("");
            self.state.status = format!("翻译完成（{label}）");
        }
    }
}

impl eframe::App for MyApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        apply_theme(ctx, self.state.theme);
        self.poll_translate(ctx);
        self.poll_pending();
        self.poll_sel_translate();

        // Honor user-recorded reading-mode hotkeys (e.g. Alt+1).
        if let Some(combo) = hotkey_from_input(ctx) {
            let hk = &self.state.settings.hotkeys;
            let m = if hk.get("original").map(|s| s == &combo).unwrap_or(false) {
                Some(Mode::Original)
            } else if hk.get("translation").map(|s| s == &combo).unwrap_or(false) {
                Some(Mode::Translation)
            } else if hk.get("bilingual").map(|s| s == &combo).unwrap_or(false) {
                Some(Mode::Bilingual)
            } else {
                None
            };
            if let Some(m) = m {
                if self.state.mode != m {
                    self.state.mode = m;
                    self.state.translation.clear();
                    if m != Mode::Original && !self.state.doc.blocks.is_empty() {
                        self.start_translate(ctx);
                    }
                }
            }
        }

        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::O)) {
            self.open_dialog();
        }
        if ctx.input(|i| i.modifiers.command) {
            if ctx.input(|i| i.key_pressed(egui::Key::E)) {
                self.state.view = if self.state.view == View::Source { View::Preview } else { View::Source };
            }
            if ctx.input(|i| i.key_pressed(egui::Key::S)) {
                self.save_doc();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::Backslash)) {
                self.state.view = View::Split;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::B)) && self.state.view != View::Preview {
                self.apply_editor_op(ctx, "bold");
            }
            if ctx.input(|i| i.key_pressed(egui::Key::I)) && self.state.view != View::Preview {
                self.apply_editor_op(ctx, "italic");
            }
        }
        self.handle_dropped_files(ctx);

        // ---- top bar ----
        egui::TopBottomPanel::top("topbar").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui.button("打开").clicked() {
                    self.open_dialog();
                }
                if ui.button("设置").clicked() {
                    self.open_settings();
                }
                if ui.button(if self.state.theme == Theme::Dark { "亮色" } else { "暗色" }).clicked() {
                    self.state.theme = if self.state.theme == Theme::Dark { Theme::Light } else { Theme::Dark };
                    self.state.settings.theme = if self.state.theme == Theme::Dark { "dark".into() } else { "light".into() };
                    storage::save_settings(&self.state.settings);
                }
                ui.separator();
                egui::ComboBox::from_label("模式")
                    .selected_text(self.state.mode.label())
                    .show_ui(ui, |ui| {
                        for m in [Mode::Original, Mode::Translation, Mode::Bilingual] {
                            ui.selectable_value(&mut self.state.mode, m, m.label());
                        }
                    });
                if self.state.mode != self.last_mode {
                    self.last_mode = self.state.mode;
                    self.state.translation.clear();
                    if self.state.mode != Mode::Original && !self.state.doc.blocks.is_empty() {
                        self.start_translate(ctx);
                    }
                }
                if ui.button("翻译").clicked() {
                    if self.state.mode == Mode::Original {
                        self.state.mode = Mode::Translation;
                    }
                    self.start_translate(ctx);
                }
                ui.separator();
                egui::ComboBox::from_label("视图")
                    .selected_text(match self.state.view {
                        View::Preview => "预览",
                        View::Source => "源码",
                        View::Split => "分栏",
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.state.view, View::Preview, "预览");
                        ui.selectable_value(&mut self.state.view, View::Source, "源码");
                        ui.selectable_value(&mut self.state.view, View::Split, "分栏");
                    });
                ui.separator();
                if ui.button(if self.state.show_nav { "隐藏文档栏" } else { "文档栏" }).clicked() {
                    self.state.show_nav = !self.state.show_nav;
                }
                if ui.button(if self.state.show_outline { "隐藏大纲" } else { "大纲" }).clicked() {
                    self.state.show_outline = !self.state.show_outline;
                }
                ui.separator();
                ui.label(egui::RichText::new(&self.state.doc.name).strong());
                if self.state.is_dirty() {
                    ui.label(egui::RichText::new("●").color(egui::Color32::from_rgb(60, 120, 230)));
                }
            });
            ui.add_space(4.0);
        });

        if self.state.view != View::Preview {
            egui::TopBottomPanel::top("editbar").show(ctx, |ui| {
                ui.horizontal(|ui| {
                    self.editor_toolbar(ctx, ui);
                });
            });
        }

        self.settings_window(ctx);
        self.render_sel_popup(ctx);

        // ---- bottom bar ----
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(&self.state.status);
                if self.state.translating {
                    ui.spinner();
                }
                ui.separator();
                let c = self.state.doc.char_count();
                let l = self.state.doc.line_count();
                ui.label(format!("字符 {c} · 行 {l}"));
            });
        });

        // ---- side panels: workspace tree (left) + outline (right) ----
        if self.state.show_nav {
            egui::SidePanel::left("nav").resizable(true).default_width(240.0).show(ctx, |ui| {
                self.nav_contents(ctx, ui);
            });
        }
        if self.state.show_outline {
            egui::SidePanel::right("outline").resizable(true).default_width(200.0).show(ctx, |ui| {
                self.outline_contents(ui);
            });
        }

        // ---- central area (view = preview | source | split) ----
        egui::CentralPanel::default().show(ctx, |ui| {
            match self.state.view {
                View::Preview => self.preview_ui(ctx, ui),
                View::Source => self.editor_ui(ctx, ui),
                View::Split => {
                    ui.columns(2, |cols| {
                        self.editor_ui(ctx, &mut cols[0]);
                        self.preview_ui(ctx, &mut cols[1]);
                    });
                }
            }
        });
    }
}
