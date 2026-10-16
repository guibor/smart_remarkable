//! Locally generated, bounded print-style answers. Remote Markdown is data;
//! it cannot specify SVG, coordinates, external resources or input commands.
use crate::{touch::Rect, util};
use anyhow::{ensure, Result};
use resvg::usvg::{Options, Tree};
use std::sync::Arc;

pub struct AnswerPlan {
    pub svg: String,
    pub rect: Rect,
    pub truncated: bool,
}

/// A tightly cropped image, ready for the native scene-image insertion path.
/// Pixel dimensions are explicit: they are NOT yet qualified scene dimensions.
/// No file path, SVG, URL, or placement command is accepted from Dot.
pub struct AnswerImage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Render at a caller-selected, bounded density. Only our local layout may
/// supply SVG. Preserve antialiasing and transparency instead of tracing glyphs
/// into thousands of pen strokes. This function performs no device/file I/O.
pub fn image(plan: &AnswerPlan, pixels_per_unit: f32) -> Result<AnswerImage> {
    ensure!(
        pixels_per_unit.is_finite() && (1.0..=3.0).contains(&pixels_per_unit),
        "Invalid answer image density"
    );
    let r = plan.rect;
    ensure!(
        r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x.checked_add(r.w).is_some_and(|v| v <= 768) && r.y.checked_add(r.h).is_some_and(|v| v <= 1024),
        "Invalid answer image bounds"
    );
    let width = (r.w as f32 * pixels_per_unit).ceil() as u32;
    let height = (r.h as f32 * pixels_per_unit).ceil() as u32;
    ensure!(u64::from(width) * u64::from(height) <= 4_000_000, "Answer image exceeds pixel budget");
    let mut options = Options::default();
    options.fontdb = Arc::new(util::build_fontdb());
    // No network or local file resolver: generated SVG contains only text.
    options.image_href_resolver = resvg::usvg::ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|_, _| None),
    };
    let tree = Tree::from_str(&plan.svg, &options)?;
    let bounds = tree.root().abs_bounding_box();
    ensure!(
        bounds.width() > 0.0
            && bounds.height() > 0.0
            && bounds.left() >= r.x as f32
            && bounds.top() >= r.y as f32
            && bounds.right() <= (r.x + r.w) as f32
            && bounds.bottom() <= (r.y + r.h) as f32,
        "Answer content extends outside image bounds"
    );
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or_else(|| anyhow::anyhow!("Cannot allocate bounded answer image"))?;
    let transform = resvg::tiny_skia::Transform::from_row(
        pixels_per_unit,
        0.0,
        0.0,
        pixels_per_unit,
        -(r.x as f32) * pixels_per_unit,
        -(r.y as f32) * pixels_per_unit,
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    ensure!(pixmap.pixels().iter().any(|p| p.alpha() > 0), "Empty rendered answer");
    let png = pixmap.encode_png()?;
    ensure!(png.len() <= 2_000_000, "Answer image exceeds encoded budget");
    Ok(AnswerImage { png, width, height })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn line_svg(text: &str, x: i32, y: i32, heading: bool) -> String {
    let rtl = text.chars().find(|c| c.is_alphabetic()).is_some_and(|c| ('\u{590}'..='\u{8ff}').contains(&c));
    let font = if rtl { "Noto Sans Hebrew" } else { "Noto Sans SC" };
    let size = if heading { 26 } else { 22 };
    let direction = if rtl { "rtl" } else { "ltr" };
    let anchor = if rtl { "end" } else { "start" };
    // usvg 0.47 shapes with an LTR paragraph base regardless of SVG direction.
    // An explicit Unicode RTL embedding keeps punctuation in the right run.
    let shaped = if rtl { format!("\u{202b}{text}\u{202c}") } else { text.to_string() };
    format!(
        r#"<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{font}" font-size="{size}" direction="{direction}" unicode-bidi="embed" fill="black">{}</text>"#,
        escape(&shaped)
    )
}

fn svg(body: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024">{body}</svg>"#)
}

/// Fixed readable font size, word wrapping, below-selection placement only.
/// Oversized answers get an explicit continuation label, never tiny scaling.
pub fn layout(markdown: &str, selection: Rect) -> Result<AnswerPlan> {
    ensure!(!markdown.trim().is_empty() && markdown.len() <= 120_000, "Invalid Dot answer length");
    ensure!(
        selection.x >= 0
            && selection.y >= 0
            && selection.w > 0
            && selection.h > 0
            && selection.x.checked_add(selection.w).is_some_and(|v| v <= 768)
            && selection.y.checked_add(selection.h).is_some_and(|v| v <= 1024),
        "Invalid selected region"
    );
    let top = (selection.y + selection.h + 20).max(120);
    let left = selection.x.clamp(104, 368);
    let rect = Rect {
        x: left,
        y: top,
        w: 744 - left,
        h: 994 - top,
    };
    ensure!(rect.h >= 100, "No readable answer area below this selection; use Dot/PDF");
    // The bundled CJK font has a taller ascent than typical Latin fonts.
    // Keep the first heading baseline inside the box, including its ascent.
    let max_lines = ((rect.h - 16) / 36).min(16) as usize;
    let mut options = Options::default();
    options.fontdb = Arc::new(util::build_fontdb());
    let width = |line: &str, heading: bool| -> Result<f32> {
        let tree = Tree::from_str(&svg(&line_svg(line, 0, 40, heading)), &options)?;
        Ok(tree.root().abs_bounding_box().width())
    };
    let mut lines: Vec<(String, bool)> = Vec::new();
    let mut truncated = false;
    'paragraphs: for raw in markdown.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        // Complex tables/code/math remain in the fully typeset Dot PDF. Do
        // not present misleading raw TeX or pretend to draw a requested plot.
        if raw.starts_with("```") || raw.starts_with('|') || raw.contains("$$") {
            truncated = true;
            break;
        }
        let heading = raw.starts_with('#');
        let text = raw.trim_start_matches('#').trim().replace("**", "").replace('`', "");
        let mut line = String::new();
        for word in text.split_whitespace() {
            ensure!(word.chars().count() <= 100, "Unbreakable answer token; use Dot/PDF");
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if width(&candidate, heading)? > (rect.w - 16) as f32 {
                ensure!(!line.is_empty(), "Answer word exceeds readable width; use Dot/PDF");
                lines.push((std::mem::take(&mut line), heading));
            }
            if lines.len() >= max_lines {
                truncated = true;
                break 'paragraphs;
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
        if !line.is_empty() {
            lines.push((line, heading));
        }
        if lines.len() >= max_lines {
            truncated = true;
            break;
        }
    }
    if truncated {
        lines.truncate(max_lines.saturating_sub(1));
        lines.push(("Full answer in Dot / PDF".into(), false));
    }
    ensure!(!lines.is_empty(), "No renderable answer content");
    let body: String = lines
        .iter()
        .enumerate()
        .map(|(i, (text, heading))| {
            // usvg resolves bidi shaping inside each line; RTL's x anchor is its
            // right edge, LTR's is its left edge. Check final bounds below.
            let rtl = text.chars().find(|c| c.is_alphabetic()).is_some_and(|c| ('\u{590}'..='\u{8ff}').contains(&c));
            line_svg(text, if rtl { rect.x + rect.w - 8 } else { rect.x + 8 }, rect.y + 36 + i as i32 * 36, *heading)
        })
        .collect();
    let result = svg(&body);
    let tree = Tree::from_str(&result, &options)?;
    let bounds = tree.root().abs_bounding_box();
    ensure!(
        bounds.width() > 0.0
            && bounds.height() > 0.0
            && bounds.left() >= rect.x as f32
            && bounds.top() >= rect.y as f32
            && bounds.right() <= (rect.x + rect.w) as f32
            && bounds.bottom() <= (rect.y + rect.h) as f32,
        "Rendered answer exceeds its safe area ({bounds:?} vs {rect:?}); use Dot/PDF"
    );
    let rect = Rect {
        h: lines.len() as i32 * 36 + 12,
        ..rect
    };
    Ok(AnswerPlan { svg: result, rect, truncated })
}

/// Rasterize text at 2x, then trace centerlines instead of drawing double
/// glyph outlines. Every emitted point is independently bounded before I/O.
pub fn strokes(plan: &AnswerPlan) -> Result<Vec<Vec<(f32, f32)>>> {
    let mut bitmap = util::svg_to_bitmap(&plan.svg, 1536, 2048)?;
    crate::skeleton::thin_zhang_suen(&mut bitmap);
    let paths: Vec<_> = crate::skeleton::trace_skeleton(&bitmap)
        .into_iter()
        .map(|p| p.into_iter().map(|(x, y)| (x * 0.5, y * 0.5)).collect::<Vec<_>>())
        .filter(|p| !p.is_empty())
        .collect();
    ensure!(
        !paths.is_empty() && paths.len() <= 3000 && paths.iter().map(Vec::len).sum::<usize>() <= 60_000,
        "Answer exceeds bounded drawing budget"
    );
    ensure!(
        paths.iter().flatten().all(|(x, y)| x.is_finite()
            && y.is_finite()
            && *x >= (plan.rect.x + 2) as f32
            && *x < (plan.rect.x + plan.rect.w - 2) as f32
            && *y >= (plan.rect.y + 2) as f32
            && *y < (plan.rect.y + plan.rect.h - 2) as f32),
        "Unsafe answer stroke"
    );
    Ok(paths)
}

/// A separate uinput pen lets the physical-input observer distinguish the
/// user's pen from generated strokes. Never inject into the physical device
/// and then ignore its contact events. Dropping this device releases it.
pub struct AnswerPen {
    device: evdev::uinput::VirtualDevice,
}

impl AnswerPen {
    pub fn new() -> Result<Self> {
        use evdev::{AbsoluteAxisCode, AttributeSet, KeyCode, UinputAbsSetup};
        ensure!(
            crate::device::DeviceModel::detect() == crate::device::DeviceModel::RemarkablePaperPro,
            "Dot pen is qualified only for Paper Pro, never Move"
        );
        let physical = evdev::Device::open("/dev/input/event2")?;
        ensure!(physical.name() == Some("Elan marker input"), "Unexpected Paper Pro pen device");
        let axes: Vec<_> = physical.get_absinfo()?.collect();
        for (axis, expected) in [(AbsoluteAxisCode::ABS_X, 11180), (AbsoluteAxisCode::ABS_Y, 15340)] {
            ensure!(
                axes.iter()
                    .any(|(code, info)| *code == axis && info.minimum() == 0 && info.maximum() == expected),
                "Unexpected Paper Pro pen range"
            );
        }
        let mut keys = AttributeSet::new();
        keys.insert(KeyCode::BTN_TOOL_PEN);
        keys.insert(KeyCode::BTN_TOUCH);
        let mut builder = evdev::uinput::VirtualDevice::builder()?
            .name("Smart Dot answer pen")
            .with_keys(&keys)?
            .with_properties(physical.properties())?;
        for (axis, info) in axes {
            builder = builder.with_absolute_axis(&UinputAbsSetup::new(axis, info))?;
        }
        Ok(Self { device: builder.build()? })
    }

    fn emit(&mut self, point: Option<(f32, f32)>, down: bool) -> Result<()> {
        use evdev::{EventType as E, InputEvent as I};
        let mut events = Vec::new();
        if let Some((x, y)) = point {
            let (x, y) = util::maybe_rot180_virtual((x.round() as i32, y.round() as i32));
            events.push(I::new(E::ABSOLUTE.0, 0, (x as f32 * 11180.0 / 768.0).round() as i32));
            events.push(I::new(E::ABSOLUTE.0, 1, (y as f32 * 15340.0 / 1024.0).round() as i32));
        }
        events.extend([
            I::new(E::KEY.0, 320, i32::from(down)),
            I::new(E::KEY.0, 330, i32::from(down)),
            I::new(E::ABSOLUTE.0, 24, if down { 800 } else { 0 }),
            I::new(E::ABSOLUTE.0, 25, if down { 0 } else { 100 }),
        ]);
        self.device.emit(&events)?;
        Ok(())
    }

    /// All paths have been bounded before device creation. Guard before every
    /// point and each pen-down, limit the whole batch, always release on error.
    pub fn draw(&mut self, paths: &[Vec<(f32, f32)>], mut interrupted: impl FnMut() -> Result<bool>) -> Result<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        let result = (|| {
            for path in paths {
                for (i, point) in path.iter().enumerate() {
                    ensure!(
                        std::time::Instant::now() < deadline && !interrupted()?,
                        "Dot insertion interrupted; remaining answer is in Dot/PDF"
                    );
                    self.emit(Some(*point), true)?;
                    if i % 64 == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
                self.emit(None, false)?;
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Ok(())
        })();
        let released = self.emit(None, false);
        result.and(released)
    }
}

impl Drop for AnswerPen {
    fn drop(&mut self) {
        let _ = self.emit(None, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_falls_back_above_selection() {
        assert!(layout("Answer", Rect { x: 100, y: 900, w: 300, h: 80 }).is_err());
        assert!(layout(
            "Answer",
            Rect {
                x: 100,
                y: 0,
                w: 300,
                h: i32::MAX
            }
        )
        .is_err());
    }
    #[test]
    fn xml_is_only_text() {
        assert_eq!(escape("<script>&\""), "&lt;script&gt;&amp;&quot;");
    }

    #[test]
    fn native_image_is_cropped_transparent_and_antialiased() {
        let plan = layout(
            "# A clear answer\nTen is the sum of seven and three.",
            Rect {
                x: 160,
                y: 100,
                w: 400,
                h: 200,
            },
        )
        .unwrap();
        let output = image(&plan, 2.0).unwrap();
        let decoded = ::image::load_from_memory(&output.png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (output.width, output.height));
        assert_eq!(output.width, plan.rect.w as u32 * 2);
        assert_eq!(output.height, plan.rect.h as u32 * 2);
        assert!(decoded.pixels().any(|p| p.0[3] == 0));
        assert!(decoded.pixels().any(|p| p.0[3] > 0 && p.0[3] < 255));
        assert!(decoded.pixels().any(|p| p.0 == [0, 0, 0, 255]));
    }

    #[test]
    fn native_image_rejects_unbounded_density_and_forged_rect() {
        let mut plan = layout(
            "A short answer",
            Rect {
                x: 160,
                y: 100,
                w: 400,
                h: 200,
            },
        )
        .unwrap();
        for density in [f32::NAN, f32::INFINITY, -1.0, 0.5, 3.1] {
            assert!(image(&plan, density).is_err());
        }
        plan.rect.w = i32::MAX;
        assert!(image(&plan, 2.0).is_err());
        plan.rect.w = 10;
        assert!(image(&plan, 2.0).is_err());
    }

    #[test]
    fn native_image_handles_hebrew_headings() {
        let plan = layout(
            "# תשובה קצרה\nשבע ועוד שלוש הם עשר.",
            Rect {
                x: 160,
                y: 100,
                w: 400,
                h: 200,
            },
        )
        .unwrap();
        let output = image(&plan, 2.0).unwrap();
        assert!(output.width > 0 && output.height > 0 && output.png.len() > 100);
    }
}
