//! Explicit synthetic live transport test. Sends ONE labelled request to the
//! configured Dot inbox; never captures a screen or opens an input/notebook.
//! The private tablet key is read from stdin, not a command-line argument.
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use smart_remarkable::{
    cancellation::SmartRemarkableCancellation,
    llm_engine::{dot::Dot, LLMEngine, ResponseMode, SelectionKind, SelectionPageContext},
    touch::PageImageCompleteness,
    util,
};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--send-synthetic-test"),
        "This sends a real Dot inbox request. Supply --send-synthetic-test explicitly."
    );
    let base = std::env::var("DOT_BASE_URL")?;
    let mut key = String::new();
    std::io::stdin().take(512).read_to_string(&mut key)?;
    let key = key.trim().to_string();
    ensure!(
        (32..=256).contains(&key.len()) && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "Invalid key input"
    );
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="768" height="360">
      <text x="30" y="55" font-family="Noto Sans SC" font-size="28">SYNTHETIC INTEGRATION TEST</text>
      <text x="30" y="110" font-family="Noto Sans SC" font-size="23">No real notebook or private content.</text>
      <text x="30" y="165" font-family="Noto Sans SC" font-size="23">Please reply briefly: DOT LASSO OK.</text>
      <text x="30" y="220" font-family="Noto Sans SC" font-size="23">Identify the originating app and requested mode.</text>
      <text x="30" y="275" font-family="Noto Sans SC" font-size="23">Do not claim this was inserted into a notebook.</text>
    </svg>"#;
    let bitmap = util::svg_to_bitmap(svg, 768, 360)?;
    let pixels = image::GrayImage::from_fn(768, 360, |x, y| image::Luma([if bitmap[y as usize][x as usize] { 0 } else { 255 }]));
    let mut png = Cursor::new(Vec::new());
    pixels.write_to(&mut png, image::ImageFormat::Png)?;
    let image = STANDARD.encode(png.into_inner());
    let mut dot = Dot::new(&HashMap::from([("base_url".into(), base), ("api_key".into(), key)]));
    dot.set_response_mode(ResponseMode::WriteBack);
    dot.set_selection_kind(Some(SelectionKind::Image));
    dot.set_selection_page_context(Some(SelectionPageContext {
        selection_image_base64: image.clone(),
        current_page_image_base64: image,
        document_display_name: "Synthetic integration test - not a notebook".into(),
        page_id: "synthetic-dot-test".into(),
        page_index: 0,
        page_image_completeness: PageImageCompleteness::ViewportOnly,
    }));
    let received = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&received);
    dot.register_tool(
        "dot_answer",
        serde_json::json!({}),
        Box::new(move |answer| {
            seen.store(true, Ordering::SeqCst);
            println!("Verified Dot response (no notebook insertion): {}", answer["markdown"]);
        }),
    );
    dot.execute(&SmartRemarkableCancellation::new(), Some(Box::new(|state| println!("Transport: {state:?}"))))
        .await?;
    ensure!(
        received.load(Ordering::SeqCst),
        "Queue accepted, but no verified Dot reply within the bounded wait; local insertion was never attempted"
    );
    Ok(())
}
