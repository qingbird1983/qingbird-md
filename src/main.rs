#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fileopen;
mod markdown;
mod state;
mod translate;

use eframe::egui;
use state::{AppState, Theme};

fn main() -> eframe::Result {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 860.0])
            .with_min_inner_size([800.0, 600.0])
            .with_title("青鸟 Markdown 阅读器"),
        ..Default::default()
    };
    eframe::run_native("qingbird-md", opts, Box::new(|cc| {
        Ok(Box::new(MyApp::new(cc)))
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

struct MyApp {
    state: AppState,
}

impl MyApp {
    fn new(cc: &eframe::CreationContext) -> Self {
        let theme = initial_theme(&cc.egui_ctx);
        apply_theme(&cc.egui_ctx, theme);
        let mut state = AppState::new();
        state.theme = theme;
        MyApp { state }
    }

    fn open_dialog(&mut self) {
        if let Some(p) = fileopen::pick_markdown_file() {
            let _ = self.state.open(&p);
        }
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
}

impl eframe::App for MyApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        apply_theme(ctx, self.state.theme);

        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::O)) {
            self.open_dialog();
        }
        self.handle_dropped_files(ctx);

        egui::TopBottomPanel::top("topbar").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui.button("📂 打开").clicked() {
                    self.open_dialog();
                }
                if ui
                    .button(if self.state.theme == Theme::Dark { "☀ 亮色" } else { "🌙 暗色" })
                    .clicked()
                {
                    self.state.theme = if self.state.theme == Theme::Dark {
                        Theme::Light
                    } else {
                        Theme::Dark
                    };
                }
                ui.separator();
                ui.label(egui::RichText::new(&self.state.doc.name).strong());
            });
            ui.add_space(4.0);
        });

        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(&self.state.status);
                ui.separator();
                let c = self.state.doc.char_count();
                let l = self.state.doc.line_count();
                ui.label(format!("字符 {c} · 行 {l}"));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.with_layout(egui::Layout::top_down(egui::Align::Center), |ui| {
                    ui.set_width(820.0_f32.min(ui.available_width()));
                    let mut env = markdown::render::RenderEnv {
                        ctx,
                        base_dir: self.state.doc.base_dir.clone(),
                        textures: std::mem::take(&mut self.state.textures),
                    };
                    markdown::render::render_blocks(ui, &self.state.doc.blocks, &mut env);
                    self.state.textures = env.textures;
                });
            });
        });
    }
}
