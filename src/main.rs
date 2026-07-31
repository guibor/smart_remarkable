use anyhow::Result;
use clap::Parser;
use dotenv::dotenv;
use log::info;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{Mutex as TokioMutex, RwLock as TokioRwLock};

use std::time::Duration;
use tokio::time::sleep;

use smart_remarkable::{
    cancellation::SmartRemarkableCancellation,
    config::Config,
    coordinator::{self, CoordinatorChannels, ProgressState, WriteBackGuardState},
    device::DeviceModel,
    embedded_assets::load_config,
    image_gen::ImageGen,
    keyboard::Keyboard,
    llm_engine::{anthropic::Anthropic, google::Google, openai::OpenAI, LLMEngine},
    pen::Pen,
    screenshot::{NormalizedView, Screenshot},
    simulation::SimulationConfig,
    status::SmartRemarkableStatus,
    touch::{finish_selection_handshake, PenTool, Rect, Touch, TriggerCorner, TriggerSource, WriteBackInputMonitor},
    util::{build_svg_from_lines, fit_lines_to_rect, fit_svg_to_rect, image_to_ink_bitmap, setup_uinput, svg_to_bitmap, write_bitmap_to_file, OptionMap},
    web_server::start_web_server,
};

// Output dimensions remain the same for both devices
const VIRTUAL_WIDTH: u32 = 768;
const VIRTUAL_HEIGHT: u32 = 1024;
const SUPERVISED_PROCESSING_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Parser, Serialize)]
#[command(author, version)]
#[command(about = "Vision-LLM Agent for the reMarkable2")]
#[command(
    long_about = "This tool is an exploration of how to interact with vision-LLM through the handwritten medium of the reMarkable2. It is a pluggable system; you can provide a custom prompt and custom 'tools' that the agent can use."
)]
#[command(after_help = "See https://github.com/yangg1224/smart_remarkable for updates!")]
pub struct Args {
    /// Sets the engine to use (openai, openclaw, anthropic, google);
    /// Sometimes we can guess the engine from the model name
    #[arg(long)]
    engine: Option<String>,

    /// Sets the base URL for the engine API;
    /// Or use the engine-specific base URL environment variable
    #[arg(long)]
    engine_base_url: Option<String>,

    /// Sets the provider API key or narrow OpenClaw bridge token for the engine
    #[arg(long)]
    engine_api_key: Option<String>,

    /// Sets the model to use
    #[arg(long, short, default_value = "claude-sonnet-4-6")]
    model: String,

    /// Sets the prompt to use
    #[arg(long, default_value = "general.json")]
    prompt: String,

    /// Do not actually submit to the model, for testing
    #[arg(short, long)]
    no_submit: bool,

    /// Skip running draw_text or draw_svg, for testing
    #[arg(long)]
    no_draw: bool,

    /// Disable SVG drawing tool
    #[arg(long)]
    no_svg: bool,

    /// Disable keyboard
    #[arg(long)]
    no_keyboard: bool,

    /// Disable keyboard progress
    #[arg(long)]
    no_draw_progress: bool,

    /// Input PNG file for testing
    #[arg(long)]
    input_png: Option<String>,

    /// Output file for testing
    #[arg(long)]
    output_file: Option<String>,

    /// Output file for model parameters
    #[arg(long)]
    model_output_file: Option<String>,

    /// Save screenshot filename
    #[arg(long)]
    save_screenshot: Option<String>,

    /// Save bitmap filename
    #[arg(long)]
    save_bitmap: Option<String>,

    /// Disable looping
    #[arg(long)]
    no_loop: bool,

    /// Disable waiting for trigger
    #[arg(long)]
    no_trigger: bool,

    /// Apply segmentation
    #[arg(long)]
    apply_segmentation: bool,

    /// Select mode: after the corner trigger, tap two corners to select a
    /// region of handwriting, then tap two corners for where the answer
    /// should be drawn. The answer is scaled into that box as pen strokes,
    /// so it can afterwards be moved/resized with the native selection tool.
    #[arg(long)]
    select_mode: bool,

    /// Generate Draw-button sketches with an image-generation model instead
    /// of LLM-authored SVG. Pass a model name, or no value for the default
    /// (gemini-2.5-flash-image, "nano banana"). Needs GEMINI_API_KEY or
    /// GOOGLE_API_KEY (or --image-api-key).
    #[arg(long, num_args = 0..=1, default_missing_value = "gemini-2.5-flash-image")]
    image_model: Option<String>,

    /// API key for the image-generation model;
    /// or use environment variable GEMINI_API_KEY / GOOGLE_API_KEY
    #[arg(long)]
    image_api_key: Option<String>,

    /// Enable web search (for Anthropic models)
    #[arg(long)]
    web_search: bool,

    /// Enable model thinking (for Anthropic models)
    #[arg(long)]
    thinking: bool,

    /// Set the thinking token budget (for Anthropic models)
    #[arg(long, default_value = "5000")]
    thinking_tokens: u32,

    /// Set the log level. Try 'debug' or 'trace'
    #[arg(long, default_value = "info")]
    log_level: String,

    /// Sets the touch trigger (UR, UL, LR, LL, four-finger, pen-release, or pen-hold)
    #[arg(long, default_value = "UR")]
    trigger_corner: String,

    /// Milliseconds the lasso endpoint must remain still before pen-up in pen-hold mode
    #[arg(long, default_value_t = 800)]
    pen_hold_ms: u64,

    /// Allowed endpoint jitter in normalized 768x1024 pixels during a hold
    #[arg(long, default_value_t = 12)]
    pen_hold_radius_px: i32,

    /// Minimum normalized path extent accepted as a lasso rather than a tap
    #[arg(long, default_value_t = 24)]
    pen_min_extent_px: i32,

    /// Save current configuration to ~/.smart_remarkable.toml and exit
    #[arg(long)]
    save_config: bool,

    /// Start web server for configuration UI
    #[arg(long)]
    web_server: bool,

    /// Port for web server (default: 8080)
    #[arg(long, default_value = "8080")]
    web_port: u16,

    /// Enable test/simulation mode for specific device (rm2, rmpp)
    #[arg(long)]
    test_mode: Option<String>,

    /// File containing scripted touch events for simulation (JSON format)
    #[arg(long)]
    test_touch_events_file: Option<String>,

    /// Directory containing test screenshots to cycle through
    #[arg(long)]
    test_screenshot_dir: Option<String>,

    /// Auto-trigger delay in seconds for automated testing
    #[arg(long)]
    test_auto_trigger_delay: Option<u32>,

    /// File to log simulated interactions to
    #[arg(long)]
    test_interaction_log: Option<String>,

    /// Debug: select text tool, tap at "x,y", type the given text, exit.
    /// Format: "x,y,text to type"
    #[arg(long)]
    debug_type: Option<String>,

    /// Debug: send a single tap at "x,y" (virtual 768x1024 coords), exit.
    #[arg(long)]
    debug_tap: Option<String>,

    /// Debug: touch-drag from "x1,y1" to "x2,y2" (virtual coords), exit.
    /// With the selection tool active this creates a lasso selection.
    #[arg(long)]
    debug_drag: Option<String>,

    /// Debug: trace a closed rectangle "x1,y1,x2,y2" with the touch (lasso).
    #[arg(long)]
    debug_lasso: Option<String>,

    /// Debug: draw the SVG in the given file with the centerline renderer.
    #[arg(long)]
    debug_svg: Option<String>,

    /// Debug: erase the rect "x1,y1,x2,y2" (virtual coords) with the rubber.
    #[arg(long)]
    debug_erase: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();

    let args = Args::parse();

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(args.log_level.as_str()))
        .format_timestamp_millis()
        .init();

    setup_uinput()?;

    // Debug commands inject input directly; detect UI rotation first so
    // their coordinates land where the user sees them (best effort — only
    // possible on a real device with xochitl running)
    let debug_mode = args.debug_type.is_some()
        || args.debug_tap.is_some()
        || args.debug_drag.is_some()
        || args.debug_lasso.is_some()
        || args.debug_svg.is_some()
        || args.debug_erase.is_some();
    if debug_mode {
        if let Ok(mut ss) = smart_remarkable::screenshot::Screenshot::new() {
            let _ = ss.take_screenshot();
        }
    }

    if let Some(spec) = &args.debug_type {
        return debug_type(spec).await;
    }

    if let Some(spec) = &args.debug_drag {
        let coords: Vec<i32> = spec.split(',').map(|s| s.trim().parse().unwrap()).collect();
        let mut touch = Touch::new(false, TriggerCorner::UpperRight);
        info!("debug_drag: ({}, {}) -> ({}, {})", coords[0], coords[1], coords[2], coords[3]);
        touch.touch_start((coords[0], coords[1])).await?;
        let steps = 30;
        for i in 1..=steps {
            let x = coords[0] + (coords[2] - coords[0]) * i / steps;
            let y = coords[1] + (coords[3] - coords[1]) * i / steps;
            touch.goto_xy((x, y)).await?;
            sleep(Duration::from_millis(10)).await;
        }
        sleep(Duration::from_millis(100)).await;
        touch.touch_stop().await?;
        sleep(Duration::from_millis(500)).await;
        return Ok(());
    }

    // Trace a closed rectangle with the PEN (the lasso is a pen gesture;
    // finger drags are navigation), so the selection tool lassos everything
    // inside the rect "x1,y1,x2,y2"
    if let Some(spec) = &args.debug_lasso {
        let c: Vec<i32> = spec.split(',').map(|s| s.trim().parse().unwrap()).collect();
        let corners = [(c[0], c[1]), (c[2], c[1]), (c[2], c[3]), (c[0], c[3]), (c[0], c[1])];
        let mut pen = Pen::new(false);
        info!("debug_lasso: rect ({}, {}) - ({}, {})", c[0], c[1], c[2], c[3]);
        pen.pen_down_at(pen.virtual_to_input_pub(corners[0]))?;
        std::thread::sleep(Duration::from_millis(50));
        for w in corners.windows(2) {
            let (x1, y1) = w[0];
            let (x2, y2) = w[1];
            let steps = 40;
            for i in 1..=steps {
                pen.goto_xy_virtual((x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps))?;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        std::thread::sleep(Duration::from_millis(50));
        pen.pen_up()?;
        sleep(Duration::from_millis(500)).await;
        return Ok(());
    }

    if let Some(path) = &args.debug_svg {
        let svg_data = std::fs::read_to_string(path)?;
        let mut pen = Pen::new(false);
        info!("debug_svg: drawing {} with centerline renderer", path);
        pen.draw_svg_centerline(&svg_data)?;
        return Ok(());
    }

    if let Some(spec) = &args.debug_erase {
        let c: Vec<i32> = spec.split(',').map(|s| s.trim().parse().unwrap()).collect();
        let rect = Rect::from_corners((c[0], c[1]), (c[2], c[3]));
        let mut pen = Pen::new(false);
        info!("debug_erase: erasing {:?}", rect);
        pen.erase_rect(rect)?;
        sleep(Duration::from_millis(500)).await;
        return Ok(());
    }

    if let Some(spec) = &args.debug_tap {
        let parts: Vec<&str> = spec.splitn(2, ',').collect();
        let x: i32 = parts[0].trim().parse()?;
        let y: i32 = parts[1].trim().parse()?;
        let mut touch = Touch::new(false, TriggerCorner::UpperRight);
        info!("debug_tap: tapping at ({}, {})", x, y);
        touch.tap((x, y)).await?;
        sleep(Duration::from_millis(500)).await;
        return Ok(());
    }

    smart_remarkable(&args).await
}

/// Debug helper: exercise the text-tool + virtual-keyboard output path in
/// isolation so it can be tested over SSH without a full LLM round trip.
async fn debug_type(spec: &str) -> Result<()> {
    let parts: Vec<&str> = spec.splitn(3, ',').collect();
    if parts.len() != 3 {
        return Err(anyhow::anyhow!("debug_type format: x,y,text"));
    }
    let x: i32 = parts[0].trim().parse()?;
    let y: i32 = parts[1].trim().parse()?;
    let text = parts[2];

    let mut keyboard = Keyboard::new(false, true);
    sleep(Duration::from_millis(1000)).await; // let xochitl register the device

    let mut touch = Touch::new(false, TriggerCorner::UpperRight);
    info!("debug_type: selecting text tool");
    touch.select_text_tool().await?;
    info!("debug_type: tapping at ({}, {})", x, y);
    touch.tap((x, y)).await?;
    sleep(Duration::from_millis(800)).await;
    info!("debug_type: typing {:?}", text);
    keyboard.string_to_keypresses(text)?;
    sleep(Duration::from_millis(500)).await;
    Ok(())
}

async fn await_processing_while_listener_alive(
    processing_handle: &mut tokio::task::JoinHandle<Result<coordinator::ProcessingOutcome>>,
    trigger_handle: &mut tokio::task::JoinHandle<Result<()>>,
) -> Result<std::result::Result<Result<coordinator::ProcessingOutcome>, tokio::task::JoinError>> {
    tokio::select! {
        // A listener that is already dead must win even when request processing
        // completed on the same scheduler turn. Otherwise main could briefly
        // reopen admission and remove busy while /ready still exists.
        biased;
        trigger_result = trigger_handle => {
            let error = match trigger_result {
                Ok(Ok(())) => anyhow::anyhow!("Trigger listener exited during request processing"),
                Ok(Err(error)) => error,
                Err(error) => anyhow::anyhow!(
                    "Trigger listener task failed during request processing: {}",
                    error
                ),
            };
            Err(error)
        }
        result = processing_handle => Ok(result),
    }
}

async fn settle_processing_after_listener_failure<F>(
    processing_handle: &mut tokio::task::JoinHandle<Result<coordinator::ProcessingOutcome>>,
    cancellation: &SmartRemarkableCancellation,
    cleanup_timeout: Duration,
    restore_prepared_selection: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    cancellation.cancel_all();
    if tokio::time::timeout(cleanup_timeout, &mut *processing_handle)
        .await
        .is_err()
    {
        // Stop the worker before restoring selection chrome. Otherwise a
        // synchronous capture step could resume after restoration and close
        // the selection that we just returned to the user.
        processing_handle.abort();
        let _ = processing_handle.await;
    }

    // The QML restore chord is deliberately idempotent: it restores a live
    // Prepared transaction and is a no-op once Closed. Issuing it after the
    // processing task has settled covers both cooperative and forced cleanup.
    restore_prepared_selection()
}

#[cfg(test)]
mod write_back_safety_tests {
    use std::cell::Cell;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    use super::{
        after_successful_activation, await_processing_while_listener_alive,
        guarded_text_target, settle_processing_after_listener_failure,
    };
    use smart_remarkable::cancellation::SmartRemarkableCancellation;
    use smart_remarkable::coordinator::ProcessingOutcome;
    use smart_remarkable::touch::Rect;

    #[test]
    fn text_activation_failure_suppresses_keyboard_output() {
        let wrote = Cell::new(false);
        let result = after_successful_activation(Err(anyhow::anyhow!("text tool unavailable")), || {
            wrote.set(true);
            Ok(())
        });
        assert!(result.is_err());
        assert!(!wrote.get());

        let result = after_successful_activation(Ok(()), || {
            wrote.set(true);
            Ok(())
        });
        assert!(result.is_ok());
        assert!(wrote.get());
    }

    #[test]
    fn left_edge_placement_moves_the_cursor_target_clear_of_stock_chrome() {
        let ((tap_x, tap_y), cursor) = guarded_text_target(Rect {
            x: 10,
            y: 10,
            w: 400,
            h: 300,
        })
        .unwrap();
        assert!(tap_x >= 104);
        assert!(tap_y >= 120);
        assert!(cursor.x >= 10);
        assert!(cursor.y >= 10);
        assert!(cursor.x + cursor.w <= 410);
        assert!(cursor.y + cursor.h <= 310);
        assert!(
            cursor.x >= super::WRITE_BACK_TOOL_CHROME.x + super::WRITE_BACK_TOOL_CHROME.w
                || cursor.y >= super::WRITE_BACK_TOOL_CHROME.y + super::WRITE_BACK_TOOL_CHROME.h
        );
    }

    #[test]
    fn placement_too_small_to_clear_stock_chrome_is_rejected() {
        assert!(guarded_text_target(Rect {
            x: 0,
            y: 0,
            w: 80,
            h: 80,
        })
        .is_none());
    }

    #[tokio::test]
    async fn dead_listener_wins_when_processing_and_listener_are_both_ready() {
        let mut processing = tokio::spawn(async {
            Ok::<ProcessingOutcome, anyhow::Error>(ProcessingOutcome::Completed)
        });
        let mut trigger = tokio::spawn(async { Ok::<(), anyhow::Error>(()) });
        while !processing.is_finished() || !trigger.is_finished() {
            tokio::task::yield_now().await;
        }

        let error = await_processing_while_listener_alive(&mut processing, &mut trigger)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Trigger listener exited during request processing"));
    }

    #[tokio::test]
    async fn listener_failure_settles_and_restores_a_live_prepared_transaction() {
        let cancellation = SmartRemarkableCancellation::new();
        let main_token = cancellation.main_token();
        let task_cleaned_up = Arc::new(AtomicBool::new(false));
        let prepared = Arc::new(AtomicBool::new(true));
        let task_cleaned_up_for_worker = Arc::clone(&task_cleaned_up);

        let mut processing = tokio::spawn(async move {
            main_token.cancelled().await;
            task_cleaned_up_for_worker.store(true, Ordering::Release);
            Ok::<ProcessingOutcome, anyhow::Error>(ProcessingOutcome::Completed)
        });
        let mut trigger = tokio::spawn(async {
            Err::<(), anyhow::Error>(anyhow::anyhow!("listener failed while selection was prepared"))
        });

        let listener_error = await_processing_while_listener_alive(
            &mut processing,
            &mut trigger,
        )
        .await
        .unwrap_err();
        assert!(listener_error.to_string().contains("listener failed"));

        let prepared_for_restore = Arc::clone(&prepared);
        settle_processing_after_listener_failure(
            &mut processing,
            &cancellation,
            Duration::from_secs(1),
            || {
                assert!(
                    task_cleaned_up.load(Ordering::Acquire),
                    "processing must stop before selection chrome is restored"
                );
                prepared_for_restore.store(false, Ordering::Release);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(cancellation.should_cancel_main());
        assert!(!prepared.load(Ordering::Acquire));
    }
}

macro_rules! shared {
    ($x:expr) => {
        Arc::new(Mutex::new($x))
    };
}

macro_rules! lock {
    ($x:expr) => {
        $x.lock().unwrap()
    };
}

fn draw_text(text: &str, keyboard: &mut Keyboard) -> Result<()> {
    info!("Drawing text to the screen.");
    keyboard.progress_end()?;
    keyboard.key_cmd_body()?;
    keyboard.string_to_keypresses(text)?;
    Ok(())
}

fn draw_text_guarded(text: &str, keyboard: &mut Keyboard, input_monitor: &mut WriteBackInputMonitor) -> Result<()> {
    info!("Drawing guarded text to the screen.");
    keyboard.progress_end()?;
    keyboard.key_cmd_body_guarded(|| input_monitor.interaction_detected())?;
    if input_monitor.interaction_detected()? {
        anyhow::bail!("Physical input changed before response typing");
    }
    keyboard.string_to_keypresses_guarded(text, || input_monitor.interaction_detected())?;
    Ok(())
}

#[cfg(test)]
fn after_successful_activation<T>(activation: Result<()>, write: impl FnOnce() -> Result<T>) -> Result<T> {
    activation?;
    write()
}

const WRITE_BACK_TOOL_CHROME: Rect = Rect { x: 0, y: 0, w: 80, h: 80 };
const WRITE_BACK_CURSOR_MIN_CHANGED_PIXELS: usize = 8;
const WRITE_BACK_CURSOR_MIN_VERTICAL_RUN: usize = 6;

fn guarded_text_target(placement: Rect) -> Option<((i32, i32), Rect)> {
    let right = placement.x.checked_add(placement.w)?.min(VIRTUAL_WIDTH as i32);
    let bottom = placement.y.checked_add(placement.h)?.min(VIRTUAL_HEIGHT as i32);
    let left = placement.x.max(0);
    let top = placement.y.max(0);
    if right <= left || bottom <= top {
        return None;
    }

    // Keep the synthetic placement away from the upper-left palette toggle
    // and closed-sidebar strip, even when auto-placement begins at x=10.
    let tap_x = (left + 16).max(104);
    let tap_y = (top + 16).max(120);
    if tap_x >= right - 8 || tap_y >= bottom - 8 {
        return None;
    }

    // Before typing, only the cursor/text-target UI may differ in this small
    // region. It is deliberately narrower than the answer-placement box so a
    // changed page cannot hide behind a broad permitted rectangle.
    let cursor_left = (tap_x - 4).max(left);
    let cursor_top = (tap_y - 24).max(top);
    let cursor_right = (tap_x + 12).min(right);
    let cursor_bottom = (tap_y + 40).min(bottom);
    let cursor = Rect {
        x: cursor_left,
        y: cursor_top,
        w: cursor_right - cursor_left,
        h: cursor_bottom - cursor_top,
    };
    (cursor.w > 0 && cursor.h > 0).then_some(((tap_x, tap_y), cursor))
}

fn take_write_back_view(orientation: Option<smart_remarkable::touch::SelectionOrientation>) -> Result<NormalizedView> {
    let mut screenshot = Screenshot::new()?;
    if let Some(orientation) = orientation {
        screenshot.take_screenshot_with_orientation(orientation)?;
    } else {
        screenshot.take_screenshot()?;
    }
    let view = screenshot.normalized_view()?;
    if view.dimensions() != (VIRTUAL_WIDTH, VIRTUAL_HEIGHT) {
        anyhow::bail!("Write-back screenshot was not normalized to the expected viewport");
    }
    Ok(view)
}

fn write_back_cursor_is_verified(baseline: &NormalizedView, current: &NormalizedView, cursor: Rect) -> bool {
    baseline.changed_pixels_are_confined(
        current,
        &[WRITE_BACK_TOOL_CHROME, cursor],
        cursor,
        WRITE_BACK_CURSOR_MIN_CHANGED_PIXELS,
    ) && baseline.has_vertical_change_run(current, cursor, WRITE_BACK_CURSOR_MIN_VERTICAL_RUN)
}

fn draw_svg(svg_data: &str, keyboard: &mut Keyboard, pen: &mut Pen, save_bitmap: Option<&String>, no_draw: bool) -> Result<()> {
    info!("Drawing SVG to the screen.");
    keyboard.progress_end()?;
    let scale = 2u32;
    if let Some(save_bitmap) = save_bitmap {
        let bitmap = svg_to_bitmap(svg_data, VIRTUAL_WIDTH * scale, VIRTUAL_HEIGHT * scale)?;
        write_bitmap_to_file(&bitmap, save_bitmap)?;
    }
    if !no_draw {
        // Draw continuous single-stroke centerlines: raster row-scans render
        // text as rows of tiny dashes ("dots"), while skeleton tracing draws
        // each letter as connected pen strokes like real handwriting
        pen.draw_svg_centerline(svg_data)?;
    }
    Ok(())
}

/// Delete the currently-lassoed strokes via xochitl's own selection menu
/// (tap its trash icon): exact — removes only the selected ink, no residue —
/// unlike sweeping the bounding box with the rubber. Verifies the marquee is
/// gone afterwards. Returns false if the menu wasn't found or the selection
/// survived, so the caller can fall back to the rubber erase.
fn native_delete_selection(sel: Rect) -> bool {
    use smart_remarkable::screenshot::Screenshot;

    let take = || -> Option<Screenshot> {
        let mut ss = Screenshot::new().ok()?;
        ss.take_screenshot().ok()?;
        Some(ss)
    };

    let Some(tap_point) = take().and_then(|ss| ss.detect_selection_menu_delete(sel)) else {
        log::warn!("native_delete_selection: selection menu not found near {:?}", sel);
        return false;
    };
    log::info!("native_delete_selection: tapping delete at {:?}", tap_point);
    let tapped =
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(async { Touch::new(false, TriggerCorner::UpperRight).tap(tap_point).await }));
    if tapped.is_err() {
        return false;
    }
    std::thread::sleep(Duration::from_millis(600));

    // Verify: the marquee (and thus the selected ink) should be gone
    match take().map(|ss| ss.detect_selection_rect()) {
        Some(None) => true,
        _ => {
            log::warn!("native_delete_selection: marquee still present after delete tap");
            false
        }
    }
}

fn determine_engine_name(engine_arg: &Option<String>, model: &str) -> Result<String> {
    if let Some(engine) = engine_arg {
        return Ok(engine.clone());
    }

    if model.starts_with("gpt") {
        Ok("openai".to_string())
    } else if model.starts_with("claude") {
        Ok("anthropic".to_string())
    } else if model.starts_with("gemini") {
        Ok("google".to_string())
    } else {
        Err(anyhow::anyhow!(
            "Unable to guess engine from model name '{}'. Please specify --engine (openai, anthropic, or google)",
            model
        ))
    }
}

fn create_engine(engine_name: &str, engine_options: &OptionMap) -> Result<Box<dyn LLMEngine>> {
    match engine_name {
        "openai" => Ok(Box::new(OpenAI::new(engine_options))),
        "openclaw" => Ok(Box::new(OpenAI::new_openclaw(engine_options))),
        "anthropic" => Ok(Box::new(Anthropic::new(engine_options))),
        "google" => Ok(Box::new(Google::new(engine_options))),
        _ => Err(anyhow::anyhow!(
            "Unknown engine '{}'. Supported engines: openai, openclaw, anthropic, google",
            engine_name
        )),
    }
}

async fn smart_remarkable(args: &Args) -> Result<()> {
    let mut config = Config::load(args)?;

    // Parse test_mode device model if provided
    if let Some(device_str) = &config.test_mode {
        let device_model = DeviceModel::from_string(device_str)?;
        config.test_device_model = Some(device_model);
        info!("Test mode enabled for device: {}", device_model.name());
    }

    // Select mode answers a cropped selection, which needs its own prompt
    if config.select_mode && config.prompt == "general.json" {
        config.prompt = "selection.json".to_string();
        info!("Select mode enabled, using selection.json prompt");
    }

    // Handle --save-config option
    if args.save_config {
        config.save()?;
        println!("Configuration saved to {:?}", Config::config_path()?);
        return Ok(());
    }

    // Create shared state for live config updates
    let shared_config = Arc::new(TokioRwLock::new(config.clone()));
    let shared_status = Arc::new(TokioRwLock::new(SmartRemarkableStatus::default()));

    // Create Touch component for web API and main loop
    let trigger_corner = TriggerCorner::from_string(&config.trigger_corner)?;
    let shared_touch = if args.web_server || config.is_test_mode() {
        let touch = if config.is_test_mode() {
            let simulation_config = SimulationConfig::from_config(&config);
            Touch::new_simulated(simulation_config, trigger_corner)?
        } else {
            Touch::new_with_pen_hold(
                config.no_draw,
                trigger_corner,
                config.pen_hold_ms,
                config.pen_hold_radius_px,
                config.pen_min_extent_px,
            )
        };
        Some(Arc::new(TokioRwLock::new(touch)))
    } else {
        None
    };

    // Create cancellation holder to be updated on each restart
    // We use Arc<TokioRwLock> so web server can read current cancellation
    let shared_cancellation = Arc::new(TokioRwLock::new(SmartRemarkableCancellation::new()));

    // Create config watch channel for communication between web server and main loop
    let (config_watch_tx, config_watch_rx) = tokio::sync::watch::channel(config.clone());
    let shared_config_watch_tx = Arc::new(config_watch_tx);

    // Spawn web server in same tokio runtime if requested
    let web_handle = if args.web_server {
        let config_clone = Arc::clone(&shared_config);
        let status_clone = Arc::clone(&shared_status);
        let touch_clone = shared_touch.as_ref().map(Arc::clone);
        let cancellation_clone = Arc::clone(&shared_cancellation);
        let config_watch_tx_clone = Arc::clone(&shared_config_watch_tx);
        let port = args.web_port;

        Some(tokio::spawn(async move {
            start_web_server(
                port,
                config_clone,
                status_clone,
                touch_clone,
                Some(cancellation_clone),
                Some(config_watch_tx_clone),
            )
            .await
        }))
    } else {
        None
    };

    // Run main smart_remarkable logic, restarting on config changes
    // Keep a single receiver across iterations to avoid spurious change notifications
    let mut persistent_config_watch_rx = config_watch_rx.clone();
    let result = loop {
        // Create fresh cancellation for each iteration
        let cancellation = Arc::new(SmartRemarkableCancellation::new());

        // Update shared cancellation for web server
        if args.web_server {
            let mut shared_cancel = shared_cancellation.write().await;
            *shared_cancel = (*cancellation).clone();
        }

        match run_smart_remarkable_loop(
            Arc::clone(&shared_config),
            Arc::clone(&shared_status),
            shared_touch.as_ref().map(Arc::clone),
            cancellation,
            &mut persistent_config_watch_rx,
        )
        .await
        {
            Ok(()) => {
                if shared_config.read().await.no_loop {
                    info!("One-shot Smart Remarkable loop exited cleanly");
                    break Ok(());
                }
                info!("Smart Remarkable loop exited normally, restarting to pick up config changes...");
                continue; // Restart the loop
            }
            Err(e) => {
                break Err(e); // Exit on actual errors
            }
        }
    };

    // Wait for web server task if it exists
    if let Some(handle) = web_handle {
        let _ = handle.await;
    }

    result
}

async fn run_smart_remarkable_loop(
    shared_config: Arc<TokioRwLock<Config>>,
    _shared_status: Arc<TokioRwLock<SmartRemarkableStatus>>,
    shared_touch: Option<Arc<TokioRwLock<Touch>>>,
    cancellation: Arc<SmartRemarkableCancellation>,
    config_watch_rx: &mut tokio::sync::watch::Receiver<Config>,
) -> Result<()> {
    info!("Starting smart_remarkable with new coordinator architecture");

    // Get initial config
    let config = shared_config.read().await.clone();

    // Create coordinator channels
    let channels = CoordinatorChannels::new();

    // Initialize devices
    let trigger_corner = TriggerCorner::from_string(&config.trigger_corner)?;
    let keyboard = shared!(Keyboard::new(
        config.is_test_mode() || config.no_draw || config.no_keyboard,
        config.no_draw_progress,
    ));

    let pen = shared!(Pen::new(config.is_test_mode() || config.no_draw));

    let touch = if let Some(shared_touch) = shared_touch {
        shared_touch
    } else {
        Arc::new(TokioRwLock::new(Touch::new_with_pen_hold(
            config.no_draw,
            trigger_corner,
            config.pen_hold_ms,
            config.pen_hold_radius_px,
            config.pen_min_extent_px,
        )))
    };

    // Only the long-lived listener owns trigger cleanup/readiness. Helper
    // Touch instances used by drawing tools must never delete a real button
    // press that arrived during processing.
    touch.write().await.clear_stale_trigger_state();

    // Give keyboard time to initialize
    // sleep(Duration::from_millis(1000)).await;
    if !config.select_mode {
        // Position the text cursor for progress typing. Skipped in select
        // mode: this tap dismisses an active selection marquee.
        touch.write().await.tap_middle_bottom().await?;
        lock!(keyboard).progress("Smart Remarkable starting...")?;
        sleep(Duration::from_millis(1000)).await;
        lock!(keyboard).progress_end()?;
    }

    // Initialize engine
    let mut engine_options = OptionMap::new();
    engine_options.insert("model".to_string(), config.model.clone());

    let engine_name = determine_engine_name(&config.engine, &config.model)?;
    if let Some(base_url) = &config.engine_base_url {
        engine_options.insert("base_url".to_string(), base_url.clone());
    }
    if let Some(api_key) = &config.engine_api_key {
        engine_options.insert("api_key".to_string(), api_key.clone());
    }
    if config.web_search {
        engine_options.insert("web_search".to_string(), "true".to_string());
    }
    if config.thinking {
        engine_options.insert("thinking".to_string(), "true".to_string());
        engine_options.insert("thinking_tokens".to_string(), config.thinking_tokens.to_string());
    }

    let mut engine = create_engine(&engine_name, &engine_options)?;

    // Slot holding the answer-placement box for the current select-mode run;
    // armed by processing_task, consumed by the draw_svg tool callback
    let placement_slot: Arc<Mutex<Option<Rect>>> = Arc::new(Mutex::new(None));
    // Slot holding the original lassoed selection box, so the Draw button's
    // draw_sketch tool can redraw into it (erasing the old ink first)
    // instead of the answer-placement box below it
    let selection_slot: Arc<Mutex<Option<Rect>>> = Arc::new(Mutex::new(None));
    // Slot holding the base64 PNG of the current input (cropped selection),
    // so the image-generation draw tool can attach it to its request when
    // refining an existing sketch
    let input_image_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    // Explicit async write-back is authorized only while the normalized page
    // still equals the in-memory post-close view captured for this request.
    let write_back_view_guard: Arc<Mutex<WriteBackGuardState>> = Arc::new(Mutex::new(WriteBackGuardState::Unrestricted));
    // One admitted request at a time. The trigger listener also snapshots
    // this value at pen-down, so a contact begun while busy cannot become a
    // delayed request after the current response finishes.
    let trigger_admission = Arc::new(AtomicBool::new(true));
    // Last successfully processed native selection, used to reject an
    // accidental repeat of a still-active marquee.
    let last_selection_fingerprint: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));

    // Register tools
    register_tools(
        &mut engine,
        Arc::clone(&keyboard),
        Arc::clone(&pen),
        Arc::clone(&touch),
        Arc::clone(&placement_slot),
        Arc::clone(&selection_slot),
        Arc::clone(&input_image_slot),
        Arc::clone(&write_back_view_guard),
        &config,
    )?;

    let engine = Arc::new(TokioMutex::new(engine));

    // Spawn long-lived tasks
    // Publish local admission only after every fallible engine/tool setup step
    // has succeeded, immediately before the listener future takes ownership.
    let trigger_readiness_guard = touch.write().await.publish_trigger_readiness()?;
    let mut trigger_handle = {
        let touch = Arc::clone(&touch);
        let trigger_tx = channels.trigger_tx.clone();
        let cancellation = Arc::clone(&cancellation);
        let no_trigger = config.no_trigger;
        let admission = Arc::clone(&trigger_admission);
        // Native-selection triggers use the stock marquee detected in the
        // screenshot, not four follow-up corner taps.
        let collect_taps = config.select_mode && !matches!(trigger_corner, TriggerCorner::FourFinger | TriggerCorner::PenRelease | TriggerCorner::PenHold);
        tokio::spawn(async move {
            coordinator::trigger_task(
                touch,
                trigger_tx,
                cancellation,
                no_trigger,
                collect_taps,
                admission,
                trigger_readiness_guard,
            )
            .await
        })
    };

    let progress_handle = {
        let keyboard = Arc::clone(&keyboard);
        let progress_rx = channels.progress_rx.clone();
        let cancellation = Arc::clone(&cancellation);
        tokio::spawn(async move { coordinator::progress_task(keyboard, progress_rx, cancellation).await })
    };

    // Main loop
    let mut trigger_rx = channels.trigger_rx;
    let progress_tx = channels.progress_tx.clone();

    info!("Main: entering main loop");

    loop {
        // Update progress to waiting for trigger
        let _ = progress_tx.send(ProgressState::WaitingForTrigger);
        info!("Main: waiting for next trigger...");

        tokio::select! {
            // Listener death must win over a simultaneously queued trigger.
            biased;
            trigger_result = &mut trigger_handle => {
                cancellation.cancel_all();
                return match trigger_result {
                    Ok(Ok(())) => Err(anyhow::anyhow!("Trigger listener exited unexpectedly")),
                    Ok(Err(error)) => Err(error),
                    Err(error) => Err(anyhow::anyhow!("Trigger listener task failed: {}", error)),
                };
            }

            Some(trigger_event) = trigger_rx.recv() => {
                info!("Main: trigger received, starting processing");

                let selection = match &trigger_event {
                    coordinator::TriggerEvent::UserSelection { selection, placement, .. } => Some((*selection, *placement)),
                    _ => None,
                };
                let selection_kind = match &trigger_event {
                    coordinator::TriggerEvent::UserSelection { selection_kind, .. } => Some(*selection_kind),
                    _ => None,
                };
                let selection_request = match &trigger_event {
                    coordinator::TriggerEvent::UserSelection {
                        selection_request,
                        ..
                    } => selection_request.clone(),
                    coordinator::TriggerEvent::UserLegacySelection {
                        selection_request,
                        ..
                    } => Some(selection_request.clone()),
                    _ => None,
                };
                let selection_request_for_cleanup = selection_request.clone();
                let trigger_source = match &trigger_event {
                    coordinator::TriggerEvent::UserSelection { source, .. } => *source,
                    coordinator::TriggerEvent::UserLegacySelection { source, .. } => *source,
                    coordinator::TriggerEvent::UserTouch { source } => *source,
                    coordinator::TriggerEvent::WebTrigger => TriggerSource::Touch,
                };

                // Update progress to indicate we're processing (not waiting for triggers)
                // let _ = progress_tx.send(ProgressState::TakingScreenshot);

                // Create a new execution cycle for this processing run
                cancellation.new_execution_cycle();

                // Spawn cancel monitor to allow user to interrupt
                // let cancel_handle = {
                //     let touch_clone = Arc::clone(&touch);
                //     let cancellation_clone = Arc::clone(&cancellation);
                //     tokio::spawn(async move {
                //         coordinator::cancel_monitor_task(touch_clone, cancellation_clone).await
                //     })
                // };

                // Spawn processing task
                let mut processing_handle = {
                    let config_clone = config.clone();
                    let engine_clone = Arc::clone(&engine);
                    let progress_tx_clone = progress_tx.clone();
                    let cancellation_clone = Arc::clone(&cancellation);
                    let keyboard_clone = Arc::clone(&keyboard);
                    let touch_clone = Arc::clone(&touch);
                    let placement_slot_clone = Arc::clone(&placement_slot);
                    let selection_slot_clone = Arc::clone(&selection_slot);
                    let input_image_slot_clone = Arc::clone(&input_image_slot);
                    let write_back_view_guard_clone =
                        Arc::clone(&write_back_view_guard);
                    let last_selection_fingerprint_clone =
                        Arc::clone(&last_selection_fingerprint);
                    tokio::spawn(async move {
                        coordinator::processing_task(
                            config_clone,
                            engine_clone,
                            progress_tx_clone,
                            cancellation_clone,
                            keyboard_clone,
                            touch_clone,
                            selection,
                            placement_slot_clone,
                            selection_slot_clone,
                            input_image_slot_clone,
                            write_back_view_guard_clone,
                            trigger_source,
                            selection_kind,
                            selection_request,
                            last_selection_fingerprint_clone,
                        ).await
                    })
                };

                // Wait for either processing to complete or user to cancel
                // The cancel_monitor will trigger cancellation which processing_task respects
                let processing_result = match await_processing_while_listener_alive(
                    &mut processing_handle,
                    &mut trigger_handle,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        let keyboard_for_restore = Arc::clone(&keyboard);
                        if let Err(cleanup_error) = settle_processing_after_listener_failure(
                            &mut processing_handle,
                            &cancellation,
                            SUPERVISED_PROCESSING_CLEANUP_TIMEOUT,
                            move || {
                                let mut keyboard = keyboard_for_restore.lock().map_err(|_| {
                                    anyhow::anyhow!(
                                        "Unable to restore prepared selection after listener failure: keyboard lock poisoned"
                                    )
                                })?;
                                keyboard.restore_prepared_selection()
                            },
                        )
                        .await
                        {
                            return Err(anyhow::anyhow!(
                                "{}; supervised selection cleanup also failed: {}",
                                error,
                                cleanup_error
                            ));
                        }
                        return Err(error);
                    }
                };

                // Cancel the cancel monitor (it may still be waiting)
                cancellation.cancel_execution();
                // let _ = tokio::time::timeout(
                //     Duration::from_millis(100),
                //     cancel_handle
                // ).await;

                let finish_one_shot = match processing_result {
                    Ok(Ok(coordinator::ProcessingOutcome::Completed)) => {
                        info!("Processing completed successfully, ready for next trigger");
                        true
                    }
                    Ok(Ok(coordinator::ProcessingOutcome::NoSelection)) => {
                        info!("No native selection yet; keeping the worker armed");
                        false
                    }
                    Ok(Ok(coordinator::ProcessingOutcome::DuplicateSelection)) => {
                        info!("Still-active selection already processed; keeping the worker armed");
                        false
                    }
                    Ok(Err(e)) => {
                        info!("Processing error: {}, ready for next trigger", e);
                        true
                    }
                    Err(e) => {
                        info!("Processing task join error: {}, ready for next trigger", e);
                        true
                    }
                };

                // A stray pen tap or repeated marquee is not the one-shot
                // request. Stay armed until a new native selection was
                // accepted. Real processing errors retain prior behavior.
                // Drain any triggers that arrived during processing
                while trigger_rx.try_recv().is_ok() {
                    info!("Ignoring trigger received during processing");
                }
                // Reopen in-process admission first. The nonce-bearing busy
                // file remains present during this transition, so AppLoad
                // cannot publish a tap that survives into the next idle cycle.
                trigger_admission.store(true, Ordering::Release);
                if let Some(request) = &selection_request_for_cleanup {
                    if let Err(error) = finish_selection_handshake(request) {
                        cancellation.cancel_all();
                        return Err(anyhow::anyhow!(
                            "Unable to release the exact selection handshake; terminating for runner cleanup: {}",
                            error
                        ));
                    }
                }

                if config.no_loop && finish_one_shot {
                    info!("No-loop mode, cleaning up and exiting");
                    cancellation.cancel_all();
                    break;
                }
            }

            // Wait for config changes via watch channel (priority 2)
            _ = config_watch_rx.changed() => {
                info!("Config changed via watch channel, restarting loop");
                cancellation.cancel_all(); // Cancel all tokens to ensure clean shutdown
                break; // Exit loop to clean up and restart
            }
        }
    }

    // Clean shutdown - wait for tasks to complete
    info!("Main: shutting down tasks");

    // Cancel any ongoing execution and tasks
    cancellation.cancel_execution();

    // Give tasks a moment to notice cancellation
    sleep(Duration::from_millis(100)).await;

    // Wait for tasks with timeout to prevent hanging
    let shutdown_timeout = Duration::from_secs(2);

    match tokio::time::timeout(shutdown_timeout, trigger_handle).await {
        Ok(Ok(Ok(_))) => info!("Trigger task completed successfully"),
        Ok(Ok(Err(e))) => info!("Trigger task error: {}", e),
        Ok(Err(e)) => info!("Trigger task join error: {}", e),
        Err(_) => {
            info!("Trigger task shutdown timed out - this is expected in no-trigger mode");
        }
    }

    match tokio::time::timeout(shutdown_timeout, progress_handle).await {
        Ok(Ok(Ok(_))) => info!("Progress task completed successfully"),
        Ok(Ok(Err(e))) => info!("Progress task error: {}", e),
        Ok(Err(e)) => info!("Progress task join error: {}", e),
        Err(_) => info!("Progress task shutdown timed out"),
    }

    info!("Main: clean shutdown complete");
    Ok(())
}

// Helper function to register tools with the engine
fn register_tools(
    engine: &mut Box<dyn LLMEngine>,
    keyboard: Arc<Mutex<Keyboard>>,
    pen: Arc<Mutex<Pen>>,
    _touch: Arc<TokioRwLock<Touch>>,
    placement_slot: Arc<Mutex<Option<Rect>>>,
    selection_slot: Arc<Mutex<Option<Rect>>>,
    input_image_slot: Arc<Mutex<Option<String>>>,
    write_back_view_guard: Arc<Mutex<WriteBackGuardState>>,
    config: &Config,
) -> Result<()> {
    use serde_json::Value as json;

    // Register draw_text tool
    let output_file = config.output_file.clone();
    let no_draw = config.no_draw;
    let test_mode = config.is_test_mode();
    let keyboard_clone = Arc::clone(&keyboard);
    let placement_slot_text = Arc::clone(&placement_slot);
    let write_back_view_guard_text = Arc::clone(&write_back_view_guard);

    let tool_config_draw_text = load_config("tool_draw_text.json");
    engine.register_tool(
        "draw_text",
        serde_json::from_str::<serde_json::Value>(tool_config_draw_text.as_str())?,
        Box::new(move |arguments: json| {
            let text = match arguments["text"].as_str() {
                Some(t) => t,
                None => {
                    log::error!("draw_text tool called without valid 'text' argument");
                    return;
                }
            };
            if let Some(output_file) = &output_file {
                if let Err(e) = std::fs::write(output_file, text) {
                    log::error!("Failed to write output file: {}", e);
                }
            }
            if !no_draw {
                let bounded_for_tablet = match keyboard_clone.lock() {
                    Ok(keyboard) => keyboard.tablet_write_back_is_bounded(text),
                    Err(_) => {
                        log::error!("Keyboard lock is poisoned; skipping tablet insertion");
                        return;
                    }
                };
                if !bounded_for_tablet {
                    log::info!(
                        "OpenClaw response exceeds the bounded tablet typing interval or has no supported keys; \
                         WhatsApp remains canonical and tablet insertion was skipped"
                    );
                    return;
                }

                if test_mode {
                    if let Err(error) = draw_text(text, &mut lock!(keyboard_clone)) {
                        log::error!("Failed to type test-mode text: {}", error);
                    }
                    return;
                }

                let guard_state = match write_back_view_guard_text.lock() {
                    Ok(guard) => guard.clone(),
                    Err(_) => {
                        log::error!("Write-back view guard lock is poisoned; skipping tablet insertion");
                        return;
                    }
                };
                let view_guard = match guard_state {
                    WriteBackGuardState::Exact(view_guard) => view_guard,
                    WriteBackGuardState::Unrestricted | WriteBackGuardState::Required => {
                        log::info!("Write-back requires a verified post-close view; WhatsApp remains canonical and tablet insertion was skipped");
                        return;
                    }
                };
                let placement = placement_slot_text.lock().ok().and_then(|mut slot| slot.take());
                let Some(placement) = placement else {
                    log::error!("Guarded write-back placement is unavailable; skipping tablet insertion");
                    return;
                };

                let write_result = {
                    let current = take_write_back_view(view_guard.orientation);
                    if !matches!(
                        current.as_ref(),
                        Ok(current) if coordinator::write_back_view_matches(&view_guard.baseline, current)
                    ) {
                        log::info!(
                            "Notebook view changed while OpenClaw was working; \
                             WhatsApp remains canonical and tablet insertion was skipped"
                        );
                        return;
                    }
                    let Some((tap_point, cursor_region)) = guarded_text_target(placement) else {
                        log::error!("No toolbar-safe text target fits inside the answer placement; skipping tablet insertion");
                        return;
                    };

                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async {
                            let mut touch = Touch::new(false, TriggerCorner::UpperRight);
                            touch.select_text_tool_with_orientation(view_guard.orientation).await?;

                            // Selecting Text is allowed to change only the
                            // closed palette toggle. Recheck before placing a
                            // cursor so a navigation during activation fails.
                            let after_tool = take_write_back_view(view_guard.orientation)?;
                            if !view_guard
                                .baseline
                                .changed_pixels_are_within(&after_tool, &[WRITE_BACK_TOOL_CHROME])
                            {
                                anyhow::bail!("Notebook view changed during text-tool activation");
                            }

                            touch.tap(tap_point).await?;
                            drop(touch);

                            // Open only after Smart's physical-evdev injection
                            // completes, then query all current kernel contact
                            // state before relying on future events. The narrow
                            // caret proof below rejects a completed physical
                            // gesture that moved the target during placement.
                            let mut input_monitor = WriteBackInputMonitor::start()?;
                            let target_view = take_write_back_view(view_guard.orientation)?;
                            if !write_back_cursor_is_verified(&view_guard.baseline, &target_view, cursor_region) {
                                anyhow::bail!("Text cursor was not verified on the unchanged notebook view");
                            }
                            draw_text_guarded(text, &mut lock!(keyboard_clone), &mut input_monitor)
                        })
                    })
                };

                if let Err(error) = write_result {
                    log::error!("Failed to activate text tool or type guarded text; skipping tablet insertion: {}", error);
                }
            }
        }),
    );

    // Register draw_svg and draw_answer tools, which share the same
    // render pipeline: fit into the select-mode placement box (if any),
    // switch to the user's pen, draw, then restore the previous tool.
    if !config.no_svg {
        let output_file = config.output_file.clone();
        let save_bitmap = config.save_bitmap.clone();
        let no_draw = config.no_draw;
        let test_mode = config.is_test_mode();

        fn make_render_svg_answer(
            output_file: Option<String>,
            save_bitmap: Option<String>,
            no_draw: bool,
            test_mode: bool,
            keyboard: Arc<Mutex<Keyboard>>,
            pen: Arc<Mutex<Pen>>,
            placement_slot: Arc<Mutex<Option<Rect>>>,
        ) -> impl Fn(&str) + Send + Sync + 'static {
            move |svg_data: &str| {
                // In select mode, scale the answer into the box the user chose
                let placement = placement_slot.lock().ok().and_then(|mut slot| slot.take());
                let svg_data = if let Some(rect) = placement {
                    match fit_svg_to_rect(svg_data, rect) {
                        Ok(fitted) => fitted,
                        Err(e) => {
                            log::error!("Failed to fit SVG to placement box: {}, drawing as-is", e);
                            svg_data.to_string()
                        }
                    }
                } else {
                    svg_data.to_string()
                };
                let svg_data = svg_data.as_str();

                if let Some(output_file) = &output_file {
                    if let Err(e) = std::fs::write(output_file, svg_data) {
                        log::error!("Failed to write output file: {}", e);
                    }
                }

                // Switch to the user's pen before drawing, remember original tool
                // for restore. Use a fresh Touch instance to avoid deadlock with
                // trigger_task which holds the shared touch RwLock indefinitely
                // while waiting for user trigger.
                let previous_tool = if !no_draw && !test_mode {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async {
                            // Use pen slot 1 (the user's own pen, typically black)
                            // rather than slot 2, which may be a highlighter
                            Touch::new(false, TriggerCorner::UpperRight).switch_to_tool(PenTool::Ballpoint).await
                        })
                    })
                    .unwrap_or(PenTool::Unknown)
                } else {
                    PenTool::Unknown
                };

                let mut keyboard = lock!(keyboard);
                let mut pen = lock!(pen);
                if let Err(e) = draw_svg(svg_data, &mut keyboard, &mut pen, save_bitmap.as_ref(), no_draw) {
                    log::error!("Failed to draw SVG: {}", e);
                }
                drop(keyboard);
                drop(pen);

                // Restore the original tool after drawing
                if !no_draw && !test_mode && previous_tool != PenTool::Unknown {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async { Touch::new(false, TriggerCorner::UpperRight).restore_tool(previous_tool).await })
                    })
                    .ok();
                }
            }
        }

        let tool_config_draw_svg = load_config("tool_draw_svg.json");
        let render = make_render_svg_answer(
            output_file.clone(),
            save_bitmap.clone(),
            no_draw,
            test_mode,
            Arc::clone(&keyboard),
            Arc::clone(&pen),
            Arc::clone(&placement_slot),
        );
        engine.register_tool(
            "draw_svg",
            serde_json::from_str::<serde_json::Value>(tool_config_draw_svg.as_str())?,
            Box::new(move |arguments: json| {
                let svg_data = match arguments["svg"].as_str() {
                    Some(svg) => svg,
                    None => {
                        log::error!("draw_svg tool called without valid 'svg' argument");
                        return;
                    }
                };
                render(svg_data);
            }),
        );

        // draw_sketch (Draw button only): like draw_svg, but the model also
        // reports whether the lassoed selection was already a drawing. If
        // so, erase the original ink and redraw into that SAME box instead
        // of the answer-placement box below it -- an in-place "refine",
        // rather than adding a new sketch elsewhere on the page.
        #[allow(clippy::too_many_arguments)]
        fn make_render_sketch(
            output_file: Option<String>,
            save_bitmap: Option<String>,
            no_draw: bool,
            test_mode: bool,
            keyboard: Arc<Mutex<Keyboard>>,
            pen: Arc<Mutex<Pen>>,
            placement_slot: Arc<Mutex<Option<Rect>>>,
            selection_slot: Arc<Mutex<Option<Rect>>>,
        ) -> impl Fn(&str, bool) + Send + Sync + 'static {
            move |svg_data: &str, redraw_in_place: bool| {
                let selection_rect = selection_slot.lock().ok().and_then(|mut slot| slot.take());
                let placement_rect = placement_slot.lock().ok().and_then(|mut slot| slot.take());
                let target_rect = if redraw_in_place {
                    selection_rect.or(placement_rect)
                } else {
                    placement_rect.or(selection_rect)
                };

                if redraw_in_place {
                    if let Some(rect) = target_rect {
                        if !no_draw && !test_mode {
                            // No toolbar tool switch needed: xochitl only erases in
                            // response to the pen's actual eraser-tip hardware signal
                            // (BTN_TOOL_RUBBER), independent of which on-screen tool is
                            // selected -- see Pen::erase_rect.
                            let mut pen = lock!(pen);
                            if let Err(e) = pen.erase_rect(rect) {
                                log::error!("Failed to erase original drawing before redraw: {}", e);
                            }
                            drop(pen);
                            std::thread::sleep(Duration::from_millis(300));
                        }
                    }
                }

                let svg_data = if let Some(rect) = target_rect {
                    match fit_svg_to_rect(svg_data, rect) {
                        Ok(fitted) => fitted,
                        Err(e) => {
                            log::error!("Failed to fit sketch to box: {}, drawing as-is", e);
                            svg_data.to_string()
                        }
                    }
                } else {
                    svg_data.to_string()
                };
                let svg_data = svg_data.as_str();

                if let Some(output_file) = &output_file {
                    if let Err(e) = std::fs::write(output_file, svg_data) {
                        log::error!("Failed to write output file: {}", e);
                    }
                }

                let previous_tool = if !no_draw && !test_mode {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current()
                            .block_on(async { Touch::new(false, TriggerCorner::UpperRight).switch_to_tool(PenTool::Ballpoint).await })
                    })
                    .unwrap_or(PenTool::Unknown)
                } else {
                    PenTool::Unknown
                };

                let mut keyboard = lock!(keyboard);
                let mut pen = lock!(pen);
                if let Err(e) = draw_svg(svg_data, &mut keyboard, &mut pen, save_bitmap.as_ref(), no_draw) {
                    log::error!("Failed to draw sketch: {}", e);
                }
                drop(keyboard);
                drop(pen);

                if !no_draw && !test_mode && previous_tool != PenTool::Unknown {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async { Touch::new(false, TriggerCorner::UpperRight).restore_tool(previous_tool).await })
                    })
                    .ok();
                }
            }
        }

        if let Some(image_model) = &config.image_model {
            // Image-generation mode: the LLM plans the sketch (writes an
            // image prompt), nano banana renders it, and the resulting
            // line art is skeleton-traced into pen strokes. Much higher
            // drawing quality than LLM-authored SVG.
            let image_gen = Arc::new(ImageGen::new(image_model, config.image_api_key.as_deref(), None)?);
            let output_file = output_file.clone();
            let save_bitmap = save_bitmap.clone();
            let keyboard = Arc::clone(&keyboard);
            let pen = Arc::clone(&pen);
            let placement_slot = Arc::clone(&placement_slot);
            let selection_slot = Arc::clone(&selection_slot);
            let input_image_slot = Arc::clone(&input_image_slot);

            let tool_config = load_config("tool_draw_sketch_image.json");
            engine.register_tool(
                "draw_sketch",
                serde_json::from_str::<serde_json::Value>(tool_config.as_str())?,
                Box::new(move |arguments: json| {
                    let image_prompt = match arguments["image_prompt"].as_str() {
                        Some(p) => p,
                        None => {
                            log::error!("draw_sketch tool called without valid 'image_prompt' argument");
                            return;
                        }
                    };
                    let redraw_in_place = arguments["selection_is_drawing"].as_bool().unwrap_or(false);

                    let selection_rect = selection_slot.lock().ok().and_then(|mut slot| slot.take());
                    let placement_rect = placement_slot.lock().ok().and_then(|mut slot| slot.take());
                    let input_image = input_image_slot.lock().ok().and_then(|mut slot| slot.take());
                    let target_rect = if redraw_in_place {
                        selection_rect.or(placement_rect)
                    } else {
                        placement_rect.or(selection_rect)
                    };

                    if let Some(output_file) = &output_file {
                        if let Err(e) = std::fs::write(output_file, image_prompt) {
                            log::error!("Failed to write output file: {}", e);
                        }
                    }

                    // Only attach the user's sketch when refining a drawing.
                    // Selection preprocessing already normalized and enlarged
                    // this request-scoped in-memory PNG before it reached the
                    // slot, so do not resample it a second time.
                    let image_input = if redraw_in_place { input_image } else { None };
                    let image_bytes =
                        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(image_gen.generate(image_prompt, image_input.as_deref())));
                    let image_bytes = match image_bytes {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            log::error!("Image generation failed: {}", e);
                            return;
                        }
                    };

                    if let Some(save_bitmap) = &save_bitmap {
                        if let Err(e) = std::fs::write(save_bitmap, &image_bytes) {
                            log::error!("Failed to save generated image: {}", e);
                        }
                    }

                    let mut bitmap = match image_to_ink_bitmap(&image_bytes, 1024) {
                        Ok(b) => b,
                        Err(e) => {
                            log::error!("Failed to decode generated image: {}", e);
                            return;
                        }
                    };

                    if no_draw {
                        return;
                    }

                    // Erase the original ink only now, after generation
                    // succeeded, so an API failure doesn't destroy the
                    // user's sketch. Prefer xochitl's own selection delete
                    // (exact, no residue); fall back to rubber sweeps if the
                    // selection menu can't be found.
                    if redraw_in_place && !test_mode {
                        if let Some(rect) = target_rect {
                            if !native_delete_selection(rect) {
                                log::info!("Falling back to rubber erase of {:?}", rect);
                                let mut pen = lock!(pen);
                                if let Err(e) = pen.erase_rect(rect) {
                                    log::error!("Failed to erase original drawing before redraw: {}", e);
                                }
                                drop(pen);
                            }
                            std::thread::sleep(Duration::from_millis(300));
                        }
                    }

                    let previous_tool = if !test_mode {
                        tokio::task::block_in_place(|| {
                            tokio::runtime::Handle::current()
                                .block_on(async { Touch::new(false, TriggerCorner::UpperRight).switch_to_tool(PenTool::Ballpoint).await })
                        })
                        .unwrap_or(PenTool::Unknown)
                    } else {
                        PenTool::Unknown
                    };

                    let mut keyboard = lock!(keyboard);
                    if let Err(e) = keyboard.progress_end() {
                        log::error!("Failed to end progress: {}", e);
                    }
                    drop(keyboard);
                    let mut pen = lock!(pen);
                    if let Err(e) = pen.draw_bitmap_centerline(&mut bitmap, target_rect) {
                        log::error!("Failed to draw generated sketch: {}", e);
                    }
                    drop(pen);

                    if !test_mode && previous_tool != PenTool::Unknown {
                        tokio::task::block_in_place(|| {
                            tokio::runtime::Handle::current().block_on(async { Touch::new(false, TriggerCorner::UpperRight).restore_tool(previous_tool).await })
                        })
                        .ok();
                    }
                }),
            );
        } else {
            let tool_config_draw_sketch = load_config("tool_draw_sketch.json");
            let render_sketch = make_render_sketch(
                output_file.clone(),
                save_bitmap.clone(),
                no_draw,
                test_mode,
                Arc::clone(&keyboard),
                Arc::clone(&pen),
                Arc::clone(&placement_slot),
                Arc::clone(&selection_slot),
            );
            engine.register_tool(
                "draw_sketch",
                serde_json::from_str::<serde_json::Value>(tool_config_draw_sketch.as_str())?,
                Box::new(move |arguments: json| {
                    let svg_data = match arguments["svg"].as_str() {
                        Some(svg) => svg,
                        None => {
                            log::error!("draw_sketch tool called without valid 'svg' argument");
                            return;
                        }
                    };
                    let redraw_in_place = arguments["selection_is_drawing"].as_bool().unwrap_or(false);
                    render_sketch(svg_data, redraw_in_place);
                }),
            );
        }

        // draw_answer: structured content, no LLM-computed coordinates. Fixes
        // the garbled/overlapping-text bug caused by relying on the model to
        // do its own line-spacing arithmetic (see prompts/selection.json).
        // Lines are drawn one at a time with a pause in between, so the
        // answer appears progressively rather than all at once — both a
        // nicer effect and visible proof it's still working.
        const LINE_PAUSE: Duration = Duration::from_millis(450);

        let tool_config_draw_answer = load_config("tool_draw_answer.json");
        engine.register_tool(
            "draw_answer",
            serde_json::from_str::<serde_json::Value>(tool_config_draw_answer.as_str())?,
            Box::new(move |arguments: json| {
                let lines: Vec<String> = match arguments["lines"].as_array() {
                    Some(arr) => arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
                    None => {
                        log::error!("draw_answer tool called without valid 'lines' argument");
                        return;
                    }
                };

                if let Some(output_file) = &output_file {
                    if let Err(e) = std::fs::write(output_file, lines.join("\n")) {
                        log::error!("Failed to write output file: {}", e);
                    }
                }

                let placement = placement_slot.lock().ok().and_then(|mut slot| slot.take());
                let line_svgs = match &placement {
                    Some(rect) => fit_lines_to_rect(&lines, *rect).unwrap_or_else(|e| {
                        log::error!("Failed to fit lines to placement box: {}, drawing combined", e);
                        vec![build_svg_from_lines(&lines)]
                    }),
                    None => vec![build_svg_from_lines(&lines)],
                };

                let previous_tool = if !no_draw && !test_mode {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async {
                            // Use pen slot 1 (the user's own pen, typically black)
                            // rather than slot 2, which may be a highlighter
                            Touch::new(false, TriggerCorner::UpperRight).switch_to_tool(PenTool::Ballpoint).await
                        })
                    })
                    .unwrap_or(PenTool::Unknown)
                } else {
                    PenTool::Unknown
                };

                for (i, svg_data) in line_svgs.iter().enumerate() {
                    if i > 0 {
                        std::thread::sleep(LINE_PAUSE);
                    }
                    let mut keyboard = lock!(keyboard);
                    let mut pen = lock!(pen);
                    if let Err(e) = draw_svg(svg_data, &mut keyboard, &mut pen, save_bitmap.as_ref(), no_draw) {
                        log::error!("Failed to draw answer line {}: {}", i, e);
                    }
                }

                if !no_draw && !test_mode && previous_tool != PenTool::Unknown {
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async { Touch::new(false, TriggerCorner::UpperRight).restore_tool(previous_tool).await })
                    })
                    .ok();
                }
            }),
        );
    }

    Ok(())
}
