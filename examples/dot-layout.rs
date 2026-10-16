//! Pure rendering probe: never opens an input device, network or notebook.
use smart_remarkable::{dot_answer, touch::Rect, util};
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "Usage: dot-layout OUTPUT.png TEXT");
    let plan = dot_answer::layout(
        &args[2],
        Rect {
            x: 160,
            y: 100,
            w: 400,
            h: 200,
        },
    )?;
    let bitmap = util::svg_to_bitmap(&plan.svg, 768, 1024)?;
    util::write_bitmap_to_file(&bitmap, &args[1])?;
    let paths = dot_answer::strokes(&plan)?;
    println!(
        "rect={:?} strokes={} points={} continuation={}",
        plan.rect,
        paths.len(),
        paths.iter().map(Vec::len).sum::<usize>(),
        plan.truncated
    );
    Ok(())
}
