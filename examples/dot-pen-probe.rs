//! Qualification only: create a virtual pen with NO pen-down/position events.
//! It disappears after ten seconds; no notebook or stock service is modified.
fn main() -> anyhow::Result<()> {
    let _pen = smart_remarkable::dot_answer::AnswerPen::new()?;
    println!("Virtual answer pen created; no strokes will be emitted");
    std::thread::sleep(std::time::Duration::from_secs(10));
    Ok(())
}
