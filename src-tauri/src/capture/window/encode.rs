//! 裁剪与 PNG 编码（commands.rs 消费）+ 选区矩形归一化（窗口与绘制两侧共用）。

use winit::dpi::PhysicalPosition;

/// 归一化拖拽矩形：任意起终点 → (x, y, w, h)，负坐标钳到 0。
pub(super) fn normalize_rect(a: PhysicalPosition<f64>, b: PhysicalPosition<f64>) -> (u32, u32, u32, u32) {
    let x1 = a.x.min(b.x).max(0.0) as u32;
    let y1 = a.y.min(b.y).max(0.0) as u32;
    let x2 = a.x.max(b.x).max(0.0) as u32;
    let y2 = a.y.max(b.y).max(0.0) as u32;
    (x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
}

// ── Crop / encode helpers (used by commands.rs) ───────────────────────────────

pub fn crop_rgba(rgba: &[u8], img_w: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in y..(y + h) {
        let start = ((row * img_w + x) * 4) as usize;
        let end = start + (w * 4) as usize;
        if end <= rgba.len() {
            out.extend_from_slice(&rgba[start..end]);
        }
    }
    out
}

pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    use image::{ImageBuffer, RgbaImage};
    let img: RgbaImage = ImageBuffer::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| "invalid RGBA dimensions for PNG".to_string())?;
    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("PNG encode error: {e}"))?;
    Ok(png_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rect_orders_and_clamps() {
        use winit::dpi::PhysicalPosition;
        let a = PhysicalPosition::new(30.0, 10.0);
        let b = PhysicalPosition::new(10.0, 40.0);
        assert_eq!(normalize_rect(a, b), (10, 10, 20, 30));
        // 负坐标钳到 0
        let n = PhysicalPosition::new(-5.0, -1.0);
        assert_eq!(normalize_rect(n, a), (0, 0, 30, 10));
    }

    #[test]
    fn crop_rgba_extracts_rows() {
        // 4x2 图，每像素 4 字节：取第二行前两个像素
        let img: Vec<u8> = (0..8u8).flat_map(|i| [i, 0, 0, 255]).collect();
        let crop = crop_rgba(&img, 4, 0, 1, 2, 1);
        assert_eq!(crop, vec![4u8, 0, 0, 255, 5, 0, 0, 255]);
        // 越界行安全跳过（不 panic）：y=1,h=2 的第二行整行越界
        assert_eq!(crop_rgba(&img, 4, 3, 1, 5, 2).len(), 0);
    }
}
