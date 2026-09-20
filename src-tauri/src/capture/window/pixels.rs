//! 每帧像素绘制：主渲染遍历（redraw_session）与像素助手（转换/压暗/搬移/
//! 描边/加载圈）。由根模块的窗口事件在**同一轮**内调用，无独立渲染轮次。

use super::CaptureSession;

// ── Per-frame rendering ───────────────────────────────────────────────────────

pub(super) fn redraw_session(session: &mut CaptureSession) {
    if !session.surface_ready {
        return;
    }

    let mut buffer = match session.surface.buffer_mut() {
        Ok(b) => b,
        Err(_) => return,
    };

    let buf_len = buffer.len();
    let expected = (session.img_w * session.img_h) as usize;

    if buf_len != expected {
        buffer.fill(0);
        let _ = buffer.present();
        return;
    }

    let width = session.img_w;
    let height = session.img_h;

    // Start with darkened screenshot.
    buffer.copy_from_slice(&session.darkened_pixels);

    // If there's a result overlay, paint the translation on top — or, when the
    // user has toggled it off, show the original (un-darkened) screenshot region
    // so they can read the source text. Right-click inside the region flips this.
    // The selection border is drawn in both states so toggling never removes it.
    if let Some(ref res) = session.result {
        if res.visible {
            // res.pixels is a compact res.w×res.h image — stride equals res.w, offset (0,0).
            blit_pixels(
                &mut buffer,
                width,
                &res.pixels,
                res.w,
                0,
                0,
                res.x,
                res.y,
                res.w,
                res.h,
            );
        } else if let Some((sx, sy, sw, sh)) = session.selection {
            // Show the original screenshot for the selected region (bright, not dimmed).
            blit_pixels(
                &mut buffer,
                width,
                &session.original_pixels,
                session.img_w,
                sx,
                sy,
                sx,
                sy,
                sw,
                sh,
            );
        }
        if let Some((sx, sy, sw, sh)) = session.selection {
            draw_border(&mut buffer, width, height, sx, sy, sw, sh, 0x004A9EFF, 2);
        }
        let _ = buffer.present();
        return;
    }

    // Determine current selection rect.
    let sel = if session.is_dragging {
        session
            .drag_start
            .map(|start| super::normalize_rect(start, session.mouse_pos))
    } else {
        session.selection
    };

    if let Some((sx, sy, sw, sh)) = sel {
        if sw > 0 && sh > 0 {
            // original_pixels is the full img_w×img_h screenshot — stride = img_w,
            // source origin = (sx, sy) so we read the correct region.
            blit_pixels(
                &mut buffer,
                width,
                &session.original_pixels,
                session.img_w,
                sx,
                sy,
                sx,
                sy,
                sw,
                sh,
            );
            draw_border(&mut buffer, width, height, sx, sy, sw, sh, 0x004A9EFF, 2);
        }
    }

    // Loading spinner overlay.
    if session.loading {
        if let Some((sx, sy, sw, sh)) = session.selection {
            let elapsed = session
                .loading_start
                .map(|t| t.elapsed().as_secs_f32())
                .unwrap_or(0.0);
            draw_spinner(&mut buffer, width, height, sx, sy, sw, sh, elapsed);
        }
        session.window.request_redraw();
    }

    let _ = buffer.present();

    // Reveal the window only after the first successful paint — prevents the
    // white-flash that occurs when the OS shows the window before pixels are ready.
    if !session.shown {
        session.shown = true;
        session.window.set_visible(true);
    }
}

// ── Pixel helpers ─────────────────────────────────────────────────────────────

/// Convert RGBA bytes (as returned by `screenshots` crate) to softbuffer's 0x00RRGGBB u32s.
pub(super) fn rgba_to_softbuffer(rgba: &[u8]) -> Vec<u32> {
    rgba.chunks_exact(4)
        .map(|px| ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | (px[2] as u32))
        .collect()
}

pub(super) fn darken_pixels(pixels: &[u32], factor: f32) -> Vec<u32> {
    pixels
        .iter()
        .map(|&p| {
            let r = (((p >> 16) & 0xFF) as f32 * factor) as u32;
            let g = (((p >> 8) & 0xFF) as f32 * factor) as u32;
            let b = ((p & 0xFF) as f32 * factor) as u32;
            (r << 16) | (g << 8) | b
        })
        .collect()
}

/// Blit a rectangular region from `src` into `dst`.
///
/// - `src_stride`: row stride of `src` in pixels (may differ from `w` when `src` is a
///   sub-region of a larger image, e.g. the full-resolution screenshot).
/// - `src_ox`, `src_oy`: pixel offset within `src` where reading starts.
fn blit_pixels(
    dst: &mut [u32],
    dst_w: u32,
    src: &[u32],
    src_stride: u32,
    src_ox: u32,
    src_oy: u32,
    dx: u32,
    dy: u32,
    w: u32,
    h: u32,
) {
    let dst_w = dst_w as usize;
    let src_stride = src_stride as usize;
    let len = w as usize;
    for row in 0..(h as usize) {
        let dst_start = (dy as usize + row) * dst_w + dx as usize;
        let src_start = (src_oy as usize + row) * src_stride + src_ox as usize;
        if dst_start + len <= dst.len() && src_start + len <= src.len() {
            dst[dst_start..dst_start + len].copy_from_slice(&src[src_start..src_start + len]);
        }
    }
}

fn draw_border(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    color: u32,
    thickness: u32,
) {
    let bw = buf_w as usize;
    let x2 = (x + w).min(buf_w);
    let y2 = (y + h).min(buf_h);
    for t in 0..thickness {
        let top = (y + t) as usize;
        let bot = y2.saturating_sub(1).saturating_sub(t) as usize;
        for col in x..x2 {
            let c = col as usize;
            if top < buf_h as usize {
                let i = top * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
            if bot != top && bot < buf_h as usize {
                let i = bot * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
        }
        let left = (x + t) as usize;
        let right = x2.saturating_sub(1).saturating_sub(t) as usize;
        for row in y..y2 {
            let r = row as usize;
            if r < buf_h as usize {
                let li = r * bw + left;
                if li < buf.len() {
                    buf[li] = color;
                }
                if right != left {
                    let ri = r * bw + right;
                    if ri < buf.len() {
                        buf[ri] = color;
                    }
                }
            }
        }
    }
}

/// Draw a spinning arc loader centered on the selection rect.
fn draw_spinner(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    sx: u32,
    sy: u32,
    sw: u32,
    sh: u32,
    elapsed: f32,
) {
    let cx = sx as f32 + sw as f32 / 2.0;
    let cy = sy as f32 + sh as f32 / 2.0;
    let r = (sw.min(sh) as f32 * 0.15).clamp(12.0, 28.0);
    let line_w = 3u32;
    let arc_span = std::f32::consts::PI * 1.5; // 270°
    let angle_start = elapsed * std::f32::consts::TAU; // 1 rotation/sec

    let steps = ((r + line_w as f32) * std::f32::consts::TAU * 2.0) as usize + 8;
    for i in 0..steps {
        let a = angle_start + (i as f32 / steps as f32) * arc_span;
        for w in 0..line_w {
            let rr = r - line_w as f32 / 2.0 + w as f32;
            let px = (cx + rr * a.cos()).round() as i32;
            let py = (cy + rr * a.sin()).round() as i32;
            if px >= 0 && py >= 0 && px < buf_w as i32 && py < buf_h as i32 {
                let idx = py as usize * buf_w as usize + px as usize;
                if idx < buf.len() {
                    buf[idx] = 0x004A9EFF;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_to_softbuffer_packs_rgb_and_drops_alpha() {
        assert_eq!(rgba_to_softbuffer(&[0x12, 0x34, 0x56, 0xAA]), vec![0x123456]);
    }

    // ---- P2-7k: blit_pixels / draw_border 边界守卫（纯函数离线可测）----

    #[test]
    fn blit_pixels_honors_stride_and_source_offset() {
        // src 4x2（stride=4），取 (1,0) 起的 2x2 贴到 dst 2x3 的 (0,1)：
        // 行 0 不动；行 1 = src 行 0 偏移 1 起 [2,3]；行 2 = src 行 1 偏移 1 起 [6,7]
        let src = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let mut dst = vec![0u32; 6];
        blit_pixels(&mut dst, 2, &src, 4, 1, 0, 0, 1, 2, 2);
        assert_eq!(dst, vec![0, 0, 2, 3, 6, 7]);
    }

    #[test]
    fn blit_pixels_clips_rows_crossing_the_bottom_edge() {
        // dst 2x2、dy=1 起贴 2x2：第一行落在 dst 第 2 行（界内），第二行
        // 越过底边被行级护栏整行跳过——内容不回卷、不 panic
        let src = vec![1, 2, 3, 4];
        let mut dst = vec![0u32; 4];
        blit_pixels(&mut dst, 2, &src, 2, 0, 0, 0, 1, 2, 2);
        assert_eq!(dst, vec![0, 0, 1, 2]);
    }

    #[test]
    fn blit_pixels_tolerates_empty_buffers_and_zero_size() {
        // 全零尺寸：循环体不执行，空缓冲不 panic
        let mut dst: Vec<u32> = vec![];
        blit_pixels(&mut dst, 0, &[], 0, 0, 0, 0, 0, 0, 0);
        assert!(dst.is_empty());
        // 非零尺寸但 src 为空：行级护栏整段跳过，dst 原样
        let mut dst2 = vec![7u32; 4];
        blit_pixels(&mut dst2, 2, &[], 2, 0, 0, 0, 0, 2, 2);
        assert_eq!(dst2, vec![7, 7, 7, 7]);
    }

    #[test]
    fn draw_border_outlines_rect_and_interior_stays_clean() {
        let mut buf = vec![0u32; 25]; // 5x5
        draw_border(&mut buf, 5, 5, 1, 1, 3, 3, 0xFF, 1);
        assert_eq!(buf[2 * 5 + 2], 0, "3x3 描边厚度 1：中心不得着色");
        for (x, y) in [(1, 1), (2, 1), (3, 1), (1, 2), (3, 2), (1, 3), (2, 3), (3, 3)] {
            assert_eq!(buf[y * 5 + x], 0xFF, "({x},{y}) 应着色");
        }
    }

    #[test]
    fn draw_border_thickness_beyond_rect_fills_without_panic() {
        // 厚度 10 大于 3x3 矩形：bot==top / right==left 的互斥守卫防重复写，
        // 整幅应被同一颜色填满且不 panic
        let mut buf = vec![0u32; 9];
        draw_border(&mut buf, 3, 3, 0, 0, 3, 3, 0xAB, 10);
        assert!(buf.iter().all(|&p| p == 0xAB));
    }

    #[test]
    fn draw_border_clips_to_buffer_and_skips_fully_outside() {
        let mut buf = vec![0u32; 16]; // 4x4
        // 右下越界的部分裁剪：只有落在缓冲内的 2x2 角着色
        draw_border(&mut buf, 4, 4, 2, 2, 5, 5, 0xFF, 1);
        assert_eq!(buf[2 * 4 + 2], 0xFF);
        assert_eq!(buf[3 * 4 + 3], 0xFF);
        assert_eq!(buf[0], 0);
        assert_eq!(buf[4 + 1], 0);
        // 完全在缓冲外（x 已超宽 → 列区间为空）：整体 no-op
        draw_border(&mut buf, 4, 4, 10, 10, 3, 3, 0xFF00, 2);
        assert!(buf.iter().all(|&p| p != 0xFF00));
    }
}
