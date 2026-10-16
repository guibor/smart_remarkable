//! Pure rendering probe: never opens an input device, network or notebook.
use smart_remarkable::{dot_answer, touch::Rect};
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
    let rendered = dot_answer::image(&plan, 2.0)?;
    std::fs::write(&args[1], &rendered.png)?;
    println!(
        "rect={:?} image={}x{} continuation={}",
        plan.rect, rendered.width, rendered.height, plan.truncated
    );
    Ok(())
}
