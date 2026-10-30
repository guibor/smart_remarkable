//! Qualification only: read the already-loaded Pro framebuffer, no input/network.
fn main() -> anyhow::Result<()> {
    let target = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("Output path or --verify-only required"))?;
    let image = smart_remarkable::dot_framebuffer::capture()?;
    if target != "--verify-only" {
        image.save(target)?;
    }
    println!("Read-only Pro capture: {}x{}", image.width(), image.height());
    Ok(())
}
