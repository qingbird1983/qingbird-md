//! Render the pure document model (`Block`/`Inline`) into egui widgets.
//! This is the thin egui layer on top of the testable `model` module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use eframe::egui;
use egui::text::LayoutJob;
use egui::{Color32, FontId, RichText, Stroke, TextFormat, Ui};

use super::model::{Block, Inline, ListItem};
use super::syntax::highlight_spans;

/// Rendering environment: egui context, the base dir of the current `.md`
/// (for relative image paths), and a cache of decoded image textures.
pub struct RenderEnv<'a> {
    pub ctx: &'a egui::Context,
    pub base_dir: Option<PathBuf>,
    pub textures: HashMap<String, egui::TextureHandle>,
}

/// Render a list of top-level blocks into the given `ui`.
pub fn render_blocks(ui: &mut Ui, blocks: &[Block], env: &mut RenderEnv) {
    for b in blocks {
        render_block(ui, b, env);
    }
}

fn render_block(ui: &mut Ui, block: &Block, env: &mut RenderEnv) {
    match block {
        Block::Heading { level, text } => {
            let size = match level {
                1 => 26.0,
                2 => 22.0,
                3 => 19.0,
                4 => 17.0,
                5 => 16.0,
                _ => 15.0,
            };
            ui.add_space(4.0);
            ui.label(inline_job(ui, text, size, true));
        }
        Block::Paragraph { text } => {
            ui.add_space(4.0);
            ui.label(inline_job(ui, text, 15.0, false));
        }
        Block::Code { lang, code } => {
            ui.add_space(6.0);
            render_code(ui, lang.as_deref(), code);
        }
        Block::Quote { blocks } => render_quote(ui, blocks, env),
        Block::List { ordered, start, items } => render_list(ui, *ordered, *start, items, env),
        Block::Rule => {
            ui.add_space(6.0);
            ui.separator();
            ui.add_space(6.0);
        }
        Block::Image { alt, src } => render_image(ui, alt, src, env),
        Block::Table { headers, rows } => render_table(ui, headers, rows),
    }
}

/// Build a single wrapping `LayoutJob` for a run of inlines, applying
/// strong/italic/code/link styling.
fn inline_job(ui: &Ui, text: &[Inline], size: f32, is_heading: bool) -> LayoutJob {
    let visuals = ui.visuals();
    let base = TextFormat {
        font_id: FontId::proportional(size),
        color: if is_heading {
            visuals.strong_text_color()
        } else {
            visuals.text_color()
        },
        ..Default::default()
    };
    let strong = TextFormat {
        color: visuals.strong_text_color(),
        ..base.clone()
    };
    let code = TextFormat {
        font_id: FontId::monospace(size - 1.0),
        background: visuals.extreme_bg_color,
        ..base.clone()
    };
    let link = TextFormat {
        color: visuals.hyperlink_color,
        underline: Stroke::new(1.0_f32, visuals.hyperlink_color),
        ..base.clone()
    };
    let mut job = LayoutJob::default();
    push_inline(&mut job, text, &base, &strong, &code, &link);
    job
}

fn push_inline(
    job: &mut LayoutJob,
    inlines: &[Inline],
    base: &TextFormat,
    strong: &TextFormat,
    code: &TextFormat,
    link: &TextFormat,
) {
    for il in inlines {
        match il {
            Inline::Text(t) => job.append(t, 0.0, base.clone()),
            Inline::Strong(inner) => push_inline(job, inner, strong, strong, code, link),
            Inline::Emph(inner) => {
                let mut f = base.clone();
                f.italics = true;
                push_inline(job, inner, &f, strong, code, link);
            }
            Inline::Del(inner) => {
                let mut f = base.clone();
                f.strikethrough = Stroke::new(1.0_f32, f.color);
                push_inline(job, inner, &f, strong, code, link);
            }
            Inline::Code(c) => job.append(c, 0.0, code.clone()),
            Inline::Link { text, href: _ } => push_inline(job, text, link, strong, code, link),
            Inline::Image { alt, .. } => {
                let mut f = code.clone();
                f.italics = true;
                job.append(&format!("[{alt}]"), 0.0, f);
            }
            Inline::LineBreak => job.append("\n", 0.0, base.clone()),
        }
    }
}

fn render_code(ui: &mut Ui, lang: Option<&str>, code: &str) {
    let visuals = ui.visuals();
    let font = FontId::monospace(13.0);
    let mut job = LayoutJob::default();
    match highlight_spans(code, lang) {
        Some(spans) => {
            for (color, text) in spans {
                let f = TextFormat {
                    font_id: font.clone(),
                    color: Color32::from_rgb(color.r, color.g, color.b),
                    ..Default::default()
                };
                job.append(&text, 0.0, f);
            }
        }
        None => {
            let f = TextFormat {
                font_id: font,
                color: visuals.text_color(),
                ..Default::default()
            };
            job.append(code, 0.0, f);
        }
    }
    egui::Frame::group(ui.style())
        .fill(visuals.extreme_bg_color)
        .show(ui, |ui| {
            ui.add(egui::Label::new(job));
        });
}

fn render_quote(ui: &mut Ui, blocks: &[Block], env: &mut RenderEnv) {
    ui.add_space(6.0);
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.set_width(ui.available_width() - 8.0);
        let rect = ui.max_rect();
        ui.painter().rect_filled(
            egui::Rect::from_min_max(rect.min, egui::pos2(rect.min.x + 3.0, rect.max.y)),
            0.0,
            ui.visuals().weak_text_color(),
        );
        render_blocks(ui, blocks, env);
    });
    ui.add_space(6.0);
}

fn render_list(ui: &mut Ui, ordered: bool, start: u32, items: &[ListItem], env: &mut RenderEnv) {
    ui.add_space(4.0);
    let mut idx = start;
    for item in items {
        ui.horizontal(|ui| {
            if ordered {
                ui.label(RichText::new(format!("{idx}.")).strong());
                idx += 1;
            } else {
                let text = match item.task {
                    Some(true) => "☑",
                    Some(false) => "☐",
                    None => "•",
                };
                ui.label(RichText::new(text).strong());
            }
            ui.add_space(6.0);
            for b in &item.blocks {
                render_block(ui, b, env);
            }
        });
    }
    ui.add_space(4.0);
}

fn render_image(ui: &mut Ui, alt: &str, src: &str, env: &mut RenderEnv) {
    ui.add_space(6.0);
    let Some(path) = resolve_src(src, env.base_dir.as_deref()) else {
        ui.label(RichText::new(format!("[{alt}]")).italics());
        ui.add_space(6.0);
        return;
    };
    let key = path.display().to_string();
    if let Some(tex) = env.textures.get(&key) {
        show_image(ui, tex, alt);
        ui.add_space(6.0);
        return;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        ui.label(RichText::new(format!("[{alt}]")).italics());
        ui.add_space(6.0);
        return;
    };
    let Ok(img) = image::load_from_memory(&bytes) else {
        ui.label(RichText::new(format!("[{alt}]")).italics());
        ui.add_space(6.0);
        return;
    };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let color_img =
        egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], rgba.as_raw());
    let tex = env
        .ctx
        .load_texture(key.clone(), color_img, egui::TextureOptions::LINEAR);
    env.textures.insert(key, tex.clone());
    show_image(ui, &tex, alt);
    ui.add_space(6.0);
}

fn show_image(ui: &mut Ui, tex: &egui::TextureHandle, alt: &str) {
    let size = egui::Vec2::new(tex.size()[0] as f32, tex.size()[1] as f32);
    if size.x <= 0.0 || size.y <= 0.0 {
        ui.label(RichText::new(format!("[{alt}]")).italics());
        return;
    }
    let max_w = ui.available_width().min(820.0);
    let scale = if size.x > max_w { max_w / size.x } else { 1.0 };
    let shown = size * scale;
    ui.add(egui::Image::new((tex.id(), shown)));
}

fn render_table(ui: &mut Ui, headers: &[Vec<Inline>], rows: &[Vec<Vec<Inline>>]) {
    ui.add_space(6.0);
    egui::Grid::new("md_table")
        .striped(true)
        .spacing([12.0, 5.0])
        .show(ui, |ui| {
            for header in headers {
                ui.label(inline_job(ui, header, 14.0, true));
            }
            ui.end_row();
            for row in rows {
                for cell in row {
                    ui.label(inline_job(ui, cell, 14.0, false));
                }
                ui.end_row();
            }
        });
    ui.add_space(6.0);
}

/// Resolve a markdown image `src` to a local path:
/// - http(s) / data: -> `None` (rendered as alt text in Phase 1).
/// - file: -> strip the prefix and use as-is.
/// - relative -> join against the markdown file's base dir.
fn resolve_src(src: &str, base_dir: Option<&Path>) -> Option<PathBuf> {
    let s = src.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(p) = s.strip_prefix("file://") {
        return Some(PathBuf::from(p));
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") {
        return None;
    }
    let base = base_dir?;
    Some(base.join(s))
}
