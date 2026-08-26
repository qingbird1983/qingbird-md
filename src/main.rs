#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod markdown;

use eframe::egui;

fn main() -> eframe::Result {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 860.0])
            .with_min_inner_size([800.0, 600.0])
            .with_title("青鸟 Markdown 阅读器"),
        ..Default::default()
    };
    eframe::run_native(
        "qingbird-md",
        opts,
        Box::new(|_cc| Ok(Box::new(EmptyApp::default()))),
    )
}

#[derive(Default)]
struct EmptyApp;

impl eframe::App for EmptyApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("qingbird-md — Phase 1 skeleton");
        });
    }
}
