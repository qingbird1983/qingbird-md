//! Application state for the running egui app. Thin over the markdown model.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::markdown::{self, Block};

/// The currently open document.
pub struct Doc {
    pub name: String,
    pub path: Option<PathBuf>,
    pub content: String,
    /// Directory of the markdown file, used to resolve relative image paths.
    pub base_dir: Option<PathBuf>,
    /// Cached parse of `content` (parsed once per file load).
    pub blocks: Vec<Block>,
}

impl Doc {
    pub fn empty() -> Self {
        Doc {
            name: "未打开文档".to_string(),
            path: None,
            content: String::new(),
            base_dir: None,
            blocks: Vec::new(),
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let content = std::fs::read_to_string(path).ok()?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".to_string());
        let base_dir = path.parent().map(|p| p.to_path_buf());
        let blocks = markdown::parse_blocks(&content);
        Some(Doc {
            name,
            path: Some(path.to_path_buf()),
            content,
            base_dir,
            blocks,
        })
    }

    /// Load content (e.g. from a drag-and-drop) with an explicit name/base dir.
    pub fn from_content(name: String, content: String, base_dir: Option<PathBuf>) -> Self {
        let blocks = markdown::parse_blocks(&content);
        Doc {
            name,
            path: None,
            content,
            base_dir,
            blocks,
        }
    }

    pub fn load(&mut self, path: &Path) {
        if let Some(d) = Doc::from_path(path) {
            *self = d;
        }
    }

    pub fn char_count(&self) -> usize {
        self.content.chars().count()
    }

    pub fn line_count(&self) -> usize {
        let c = self.content.lines().count();
        if c == 0 && self.content.is_empty() {
            0
        } else {
            c
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Theme {
    Light,
    Dark,
}

pub struct AppState {
    pub doc: Doc,
    pub theme: Theme,
    pub status: String,
    /// Cache of decoded image textures keyed by path (persists across frames).
    pub textures: HashMap<String, eframe::egui::TextureHandle>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            doc: Doc::empty(),
            theme: Theme::Light,
            status: "就绪 · Ctrl+O 打开 · 拖入 .md 打开".to_string(),
            textures: HashMap::new(),
        }
    }

    pub fn open(&mut self, path: &Path) -> std::io::Result<()> {
        match Doc::from_path(path) {
            Some(d) => {
                self.doc = d;
                self.status = format!("已打开：{}", path.display());
                Ok(())
            }
            None => {
                self.status = format!("读取失败：{}", path.display());
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "unable to read file",
                ))
            }
        }
    }
}
