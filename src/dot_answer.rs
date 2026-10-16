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
    let max_lines = ((rect.h - 16) / 32).min(16) as usize;
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
            line_svg(text, if rtl { rect.x + rect.w - 8 } else { rect.x + 8 }, rect.y + 28 + i as i32 * 32, *heading)
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
        "Rendered answer exceeds its safe area; use Dot/PDF"
    );
    let rect = Rect {
        h: lines.len() as i32 * 32 + 12,
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
}
