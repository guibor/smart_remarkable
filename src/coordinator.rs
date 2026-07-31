use anyhow::Result;
use base64::prelude::*;
use log::{debug, info};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, watch, Mutex as TokioMutex};
use tokio::time::{sleep, Duration};

use crate::cancellation::SmartRemarkableCancellation;
use crate::config::Config;
use crate::embedded_assets::load_config;
use crate::keyboard::Keyboard;
use crate::llm_engine::{LLMEngine, ModelExecutionStatus, ResponseMode, SelectionKind};
use crate::screenshot::{NormalizedView, Screenshot};
use crate::segmenter::ImageAnalyzer;
use crate::simulation::SimulationConfig;
use crate::touch::{
    wait_for_bridge_ready, wait_for_selection_acknowledgement, Rect, SelectionAckPhase, SelectionRequest, Touch,
    TriggerReadinessGuard, TriggerSource,
};
use crate::util::prepare_selection_png_b64_for_kind;

const SELECTION_VISION_MIN_LONG_EDGE: u32 = 768;
const POST_CLOSE_VIEW_BIND_TIMEOUT: Duration = Duration::from_millis(500);

/// Events that can trigger AI processing
#[derive(Debug, Clone)]
pub enum TriggerEvent {
    /// User touched the trigger corner
    UserTouch { source: TriggerSource },
    /// User touched the trigger corner, then tapped the corners of a
    /// selection box and an answer-placement box (select mode)
    UserSelection {
        selection: Rect,
        placement: Rect,
        source: TriggerSource,
        selection_kind: SelectionKind,
        selection_request: Option<SelectionRequest>,
    },
    /// Compatibility path for the currently installed QMD during an app-first
    /// staged update. It has a random launcher generation but no QML geometry.
    UserLegacySelection {
        source: TriggerSource,
        selection_request: SelectionRequest,
    },
    /// Trigger via web API (for testing/simulation)
    WebTrigger,
}

/// Progress states during AI processing
/// Uses ModelExecutionStatus for LLM operations, plus additional states for the full workflow
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressState {
    /// No processing happening
    Idle,
    /// Waiting for user trigger
    WaitingForTrigger,
    /// Taking screenshot
    TakingScreenshot,
    /// LLM execution state
    LlmState(ModelExecutionStatus),
    /// Processing completed successfully
    Done,
}

/// Message from coordinator to processing task
#[derive(Debug)]
pub struct ProcessingRequest {
    /// The trigger event that started this
    pub trigger: TriggerEvent,
}

/// Whether a trigger reached a real processing attempt. An armed pen tap can
/// arrive before the user completes a native lasso; that is not a completed
/// one-shot request and the worker must remain armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingOutcome {
    Completed,
    NoSelection,
    DuplicateSelection,
}

/// In-memory authorization for a delayed write-back. The full normalized
/// post-close framebuffer is retained so activation can allow only known
/// toolbar/cursor deltas while rejecting every page-content change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBackViewGuard {
    pub orientation: Option<crate::touch::SelectionOrientation>,
    pub baseline: crate::screenshot::NormalizedView,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WriteBackGuardState {
    #[default]
    Unrestricted,
    Required,
    Exact(WriteBackViewGuard),
}

pub fn write_back_view_matches(expected: &crate::screenshot::NormalizedView, current: &crate::screenshot::NormalizedView) -> bool {
    expected == current
}

fn verified_post_close_guard(
    baseline: &NormalizedView,
    current: &NormalizedView,
    orientation: crate::touch::SelectionOrientation,
) -> Option<WriteBackViewGuard> {
    write_back_view_matches(baseline, current).then(|| WriteBackViewGuard {
        orientation: Some(orientation),
        baseline: baseline.clone(),
    })
}

async fn bind_verified_post_close_view(
    baseline: NormalizedView,
    orientation: crate::touch::SelectionOrientation,
    cancellation: &SmartRemarkableCancellation,
) -> Result<WriteBackViewGuard> {
    let deadline = tokio::time::Instant::now() + POST_CLOSE_VIEW_BIND_TIMEOUT;
    loop {
        let mut screenshot = Screenshot::new()?;
        screenshot.take_screenshot_with_orientation(orientation)?;
        let current = screenshot.normalized_view()?;
        if let Some(guard) = verified_post_close_guard(&baseline, &current, orientation) {
            return Ok(guard);
        }
        if cancellation.should_cancel() {
            anyhow::bail!("Post-close view binding was cancelled");
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("Post-close view did not match the prepared original page");
        }
        sleep(Duration::from_millis(25)).await;
    }
}

fn restore_prepared_selection(keyboard: &Arc<Mutex<Keyboard>>) {
    match keyboard.lock() {
        Ok(mut keyboard) => {
            if let Err(error) = keyboard.restore_prepared_selection() {
                info!("Unable to restore prepared selection chrome: {}", error);
            }
        }
        Err(_) => info!("Unable to restore prepared selection: keyboard lock poisoned"),
    }
}

/// Communication channels for the coordinator
pub struct CoordinatorChannels {
    /// Send trigger events to coordinator
    pub trigger_tx: mpsc::Sender<TriggerEvent>,
    /// Receive trigger events in coordinator
    pub trigger_rx: mpsc::Receiver<TriggerEvent>,

    /// Broadcast progress state updates
    pub progress_tx: watch::Sender<ProgressState>,
    /// Receive progress state updates
    pub progress_rx: watch::Receiver<ProgressState>,
}

/// Manual touch triggers need four follow-up taps to define the selection
/// and placement rectangles. Button-file triggers already refer to xochitl's
/// active native selection, so processing must detect that marquee instead of
/// consuming unrelated touch events as rectangle corners.
fn should_collect_selection_taps(collect_taps: bool, is_real: bool, source: TriggerSource) -> bool {
    collect_taps && is_real && source == TriggerSource::Touch
}

fn try_admit(admission: &AtomicBool) -> bool {
    admission.compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

fn selection_fingerprint(base64_image: &str, selection: Rect, selection_kind: SelectionKind) -> u64 {
    let mut hasher = DefaultHasher::new();
    selection.x.hash(&mut hasher);
    selection.y.hash(&mut hasher);
    selection.w.hash(&mut hasher);
    selection.h.hash(&mut hasher);
    selection_kind.hash(&mut hasher);
    base64_image.hash(&mut hasher);
    hasher.finish()
}

fn should_suppress_duplicate(source: TriggerSource, current: Option<u64>, last_completed: Option<u64>) -> bool {
    source == TriggerSource::PenLasso && current.is_some() && current == last_completed
}

/// Map a physical trigger onto the response destination used by this request.
/// Existing gesture and Draw behavior remains write-back; only the explicit
/// Send button suppresses notebook output.
fn response_mode_for_trigger(source: TriggerSource) -> ResponseMode {
    match source {
        TriggerSource::SendButton => ResponseMode::WhatsappOnly,
        _ => ResponseMode::WriteBack,
    }
}

/// Explicit menu buttons hand the stock selection off as soon as its supplied
/// descriptor has produced a validated immutable in-memory crop. Remote work
/// begins only after the stock close chord succeeds.
fn should_dismiss_captured_selection(source: TriggerSource, has_selection: bool, selection_kind: Option<SelectionKind>) -> bool {
    matches!(source, TriggerSource::LlmButton | TriggerSource::SendButton) && has_selection && selection_kind.is_some()
}

fn should_dismiss_legacy_accepted_selection(legacy: bool, source: TriggerSource, has_selection: bool, status: &ModelExecutionStatus) -> bool {
    legacy && matches!(source, TriggerSource::LlmButton | TriggerSource::SendButton) && has_selection && matches!(status, ModelExecutionStatus::RemoteAccepted)
}

impl CoordinatorChannels {
    pub fn new() -> Self {
        // A trigger is never a backlog: one request may be admitted and any
        // gesture/button press while it is active is discarded.
        let (trigger_tx, trigger_rx) = mpsc::channel(1);
        let (progress_tx, progress_rx) = watch::channel(ProgressState::Idle);

        Self {
            trigger_tx,
            trigger_rx,
            progress_tx,
            progress_rx,
        }
    }
}

impl Default for CoordinatorChannels {
    fn default() -> Self {
        Self::new()
    }
}

/// Task that waits for triggers and notifies the coordinator
pub async fn trigger_task(
    touch: Arc<tokio::sync::RwLock<Touch>>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
    cancellation: Arc<SmartRemarkableCancellation>,
    no_trigger: bool,
    collect_taps: bool,
    admission: Arc<AtomicBool>,
    _readiness_guard: TriggerReadinessGuard,
) -> Result<()> {
    info!("Trigger task starting");

    loop {
        debug!("Trigger loop looping");

        if no_trigger {
            debug!("No-trigger mode: auto-triggering");
            if !try_admit(&admission) {
                sleep(Duration::from_millis(25)).await;
                continue;
            }
            if trigger_tx.send(TriggerEvent::UserTouch { source: TriggerSource::Touch }).await.is_err() {
                admission.store(true, Ordering::Release);
                info!("Trigger receiver dropped, exiting trigger task");
                break;
            }
            // In no-trigger mode, wait a bit before next auto-trigger or check for cancellation
            tokio::select! {
                _ = sleep(Duration::from_millis(100)) => {
                    if cancellation.should_cancel_main() {
                        info!("Trigger task: cancelled in no-trigger mode");
                        break;
                    }
                }
                _ = async {
                    while !cancellation.should_cancel_main() {
                        sleep(Duration::from_millis(10)).await;
                    }
                } => {
                    info!("Trigger task: cancelled in no-trigger mode");
                    break;
                }
            }
            continue;
        }

        info!("Trigger task: waiting for touch trigger...");

        debug!("Trigger task: about to acquire touch write lock");
        let mut touch_guard = touch.write().await;
        debug!("Trigger task: acquired touch write lock, calling wait_for_trigger");

        match touch_guard.wait_for_trigger_admitted(&cancellation, &admission).await {
            Ok(()) => {
                debug!("Trigger task: wait_for_trigger returned Ok, touch detected");
                info!("Trigger task: touch detected");

                let source = touch_guard.last_trigger_source();
                let selection_request = touch_guard.last_selection_request();

                if !try_admit(&admission) {
                    info!("Ignoring trigger while another request is active");
                    continue;
                }

                // In select mode, collect the selection and placement box corners
                // while we still hold the touch event stream
                let event = if should_collect_selection_taps(collect_taps, touch_guard.is_real(), source) {
                    match collect_selection(&mut touch_guard, &cancellation, source).await {
                        Ok(event) => event,
                        Err(e) => {
                            admission.store(true, Ordering::Release);
                            if e.to_string().contains("cancelled") {
                                info!("Trigger task: cancelled during selection");
                                return Ok(());
                            }
                            info!("Trigger task: selection failed ({}), ignoring trigger", e);
                            continue;
                        }
                    }
                } else if matches!(source, TriggerSource::LlmButton | TriggerSource::SendButton) {
                    match selection_request {
                        Some(SelectionRequest::V2(descriptor)) => TriggerEvent::UserSelection {
                            selection: descriptor.rect,
                            placement: auto_placement(descriptor.rect),
                            source,
                            selection_kind: descriptor.kind,
                            selection_request: Some(SelectionRequest::V2(descriptor)),
                        },
                        Some(request @ SelectionRequest::Legacy { .. }) => TriggerEvent::UserLegacySelection {
                            source,
                            selection_request: request,
                        },
                        None => {
                            admission.store(true, Ordering::Release);
                            info!("Ignoring explicit selection button without a validated generation");
                            continue;
                        }
                    }
                } else {
                    TriggerEvent::UserTouch { source }
                };

                // Drop the lock before sending the event so processing_task can acquire it
                drop(touch_guard);
                debug!("Trigger task: dropped touch write lock");

                if trigger_tx.send(event).await.is_err() {
                    admission.store(true, Ordering::Release);
                    info!("Trigger receiver dropped, exiting trigger task");
                    break;
                }
                debug!("Trigger task: sent trigger event, continuing loop");

                // Give processing_task a moment to acquire the lock before we loop back
                sleep(Duration::from_millis(50)).await;
            }
            Err(e) => {
                debug!("Trigger task: wait_for_trigger returned Err: {}", e);
                if e.to_string().contains("cancelled") {
                    info!("Trigger task: cancelled (likely config change)");
                    return Ok(()); // Clean exit for restart
                } else {
                    info!("Trigger task: error waiting for trigger: {}", e);
                    return Err(e);
                }
            }
        }
    }

    debug!("Escaped from trigger task loop");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        response_mode_for_trigger, selection_fingerprint, should_collect_selection_taps, should_dismiss_captured_selection,
        should_dismiss_legacy_accepted_selection, should_suppress_duplicate, try_admit, verified_post_close_guard,
    };
    use crate::llm_engine::{ModelExecutionStatus, ResponseMode, SelectionKind};
    use crate::screenshot::NormalizedView;
    use crate::touch::{Rect, SelectionOrientation, TriggerSource};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn physical_touch_collects_select_mode_rectangles() {
        assert!(should_collect_selection_taps(true, true, TriggerSource::Touch));
    }

    #[test]
    fn native_button_triggers_use_the_active_marquee() {
        assert!(!should_collect_selection_taps(true, true, TriggerSource::LlmButton));
        assert!(!should_collect_selection_taps(true, true, TriggerSource::SendButton));
        assert!(!should_collect_selection_taps(true, true, TriggerSource::DrawButton));
        assert!(!should_collect_selection_taps(true, true, TriggerSource::PenLasso));
    }

    #[test]
    fn simulation_and_non_select_modes_skip_manual_rectangles() {
        assert!(!should_collect_selection_taps(true, false, TriggerSource::Touch));
        assert!(!should_collect_selection_taps(false, true, TriggerSource::Touch));
    }

    #[test]
    fn admission_is_single_owner_until_released() {
        let admission = AtomicBool::new(true);
        assert!(try_admit(&admission));
        assert!(!try_admit(&admission));
        admission.store(true, Ordering::Release);
        assert!(try_admit(&admission));
    }

    #[test]
    fn post_close_binding_never_replaces_the_prepared_original_with_a_new_page() {
        let original = NormalizedView::from_rgba(1, 1, vec![255, 255, 255, 255]);
        let navigated = NormalizedView::from_rgba(1, 1, vec![0, 0, 0, 255]);
        assert!(verified_post_close_guard(&original, &navigated, SelectionOrientation::Normal).is_none());
        let guard = verified_post_close_guard(&original, &original, SelectionOrientation::Normal).unwrap();
        assert_eq!(guard.baseline, original);
    }

    #[test]
    fn pen_duplicate_is_suppressed_but_explicit_button_is_not() {
        let rect = Rect { x: 10, y: 20, w: 100, h: 50 };
        let first = selection_fingerprint("image-a", rect, SelectionKind::Ink);
        let changed = selection_fingerprint("image-b", rect, SelectionKind::Ink);
        assert!(should_suppress_duplicate(TriggerSource::PenLasso, Some(first), Some(first)));
        assert!(!should_suppress_duplicate(TriggerSource::LlmButton, Some(first), Some(first)));
        assert!(!should_suppress_duplicate(TriggerSource::PenLasso, Some(changed), Some(first)));
    }

    #[test]
    fn explicit_button_selection_is_dismissed_after_local_capture() {
        assert!(should_dismiss_captured_selection(TriggerSource::LlmButton, true, Some(SelectionKind::Ink),));
        assert!(should_dismiss_captured_selection(TriggerSource::SendButton, true, Some(SelectionKind::Image),));
        assert!(!should_dismiss_captured_selection(TriggerSource::LlmButton, true, None,));
        assert!(!should_dismiss_captured_selection(TriggerSource::LlmButton, false, Some(SelectionKind::Ink),));
        assert!(!should_dismiss_captured_selection(TriggerSource::DrawButton, true, Some(SelectionKind::Mixed),));
        assert!(!should_dismiss_captured_selection(TriggerSource::PenLasso, true, Some(SelectionKind::Ink),));
    }

    #[test]
    fn legacy_qmd_closes_only_at_remote_acceptance() {
        assert!(should_dismiss_legacy_accepted_selection(
            true,
            TriggerSource::LlmButton,
            true,
            &ModelExecutionStatus::RemoteAccepted,
        ));
        assert!(!should_dismiss_legacy_accepted_selection(
            false,
            TriggerSource::LlmButton,
            true,
            &ModelExecutionStatus::RemoteAccepted,
        ));
        assert!(!should_dismiss_legacy_accepted_selection(
            true,
            TriggerSource::LlmButton,
            true,
            &ModelExecutionStatus::LlmProcessing,
        ));
    }

    #[test]
    fn selection_fingerprint_binds_stock_selection_kind() {
        let rect = Rect { x: 10, y: 20, w: 100, h: 50 };
        assert_ne!(
            selection_fingerprint("same-image", rect, SelectionKind::Ink),
            selection_fingerprint("same-image", rect, SelectionKind::Image),
        );
    }

    #[test]
    fn button_sources_map_to_explicit_response_destinations() {
        assert_eq!(response_mode_for_trigger(TriggerSource::LlmButton), ResponseMode::WriteBack);
        assert_eq!(response_mode_for_trigger(TriggerSource::SendButton), ResponseMode::WhatsappOnly);
        assert_eq!(response_mode_for_trigger(TriggerSource::PenLasso), ResponseMode::WriteBack);
    }
}

/// Collect the four taps that define the selection box (what to answer)
/// and the placement box (where to draw the answer): two opposite corners each.
async fn collect_selection(touch: &mut Touch, cancellation: &SmartRemarkableCancellation, source: TriggerSource) -> Result<TriggerEvent> {
    info!("Select mode: tap two corners of the handwriting to select");
    let sel_a = touch.wait_for_tap(cancellation).await?;
    let sel_b = touch.wait_for_tap(cancellation).await?;
    let selection = Rect::from_corners(sel_a, sel_b);
    info!("Select mode: selection box {:?}; now tap two corners for the answer box", selection);

    let place_a = touch.wait_for_tap(cancellation).await?;
    let place_b = touch.wait_for_tap(cancellation).await?;
    let placement = Rect::from_corners(place_a, place_b);
    info!("Select mode: placement box {:?}", placement);

    Ok(TriggerEvent::UserSelection {
        selection,
        placement,
        source,
        selection_kind: SelectionKind::Ink,
        selection_request: None,
    })
}

/// Task that monitors for cancel touch during processing
pub async fn cancel_monitor_task(touch: Arc<tokio::sync::RwLock<Touch>>, cancellation: Arc<SmartRemarkableCancellation>) -> Result<()> {
    info!("Cancel monitor task: starting");

    // Wait for any touch to cancel
    match touch.write().await.wait_for_trigger(&cancellation).await {
        Ok(()) => {
            info!("Cancel monitor task: touch detected, cancelling processing");
            cancellation.cancel_execution();
            Ok(())
        }
        Err(e) => {
            if e.to_string().contains("cancelled") {
                info!("Cancel monitor task: processing completed before touch");
                Ok(())
            } else {
                info!("Cancel monitor task: error: {}", e);
                Err(e)
            }
        }
    }
}

/// Task that displays progress updates on the keyboard
pub async fn progress_task(
    keyboard: Arc<Mutex<Keyboard>>,
    mut progress_rx: watch::Receiver<ProgressState>,
    cancellation: Arc<SmartRemarkableCancellation>,
) -> Result<()> {
    info!("Progress task starting");

    let mut current_state = ProgressState::Idle;
    let cancel_token = cancellation.execution_token();

    loop {
        tokio::select! {
            // Check for cancellation
            _ = cancel_token.cancelled() => {
                info!("Progress task cancelled");
                // Clear any progress display
                if let Ok(mut kb) = keyboard.lock() {
                    let _ = kb.progress_end();
                }
                return Ok(());
            }

            // Watch for progress updates
            result = progress_rx.changed() => {
                if result.is_err() {
                    info!("Progress sender dropped, exiting progress task");
                    break;
                }

                let new_state = progress_rx.borrow().clone();
                if new_state != current_state {
                    current_state = new_state.clone();

                    match &current_state {
                        ProgressState::Idle => {
                            info!("Progress: Idle");
                            if let Ok(mut kb) = keyboard.lock() {
                                let _ = kb.progress_end();
                            }
                        }
                        ProgressState::WaitingForTrigger => {
                            info!("Progress: Waiting for trigger");
                        }
                        ProgressState::TakingScreenshot => {
                            info!("Progress: Taking screenshot...");
                        }
                        ProgressState::LlmState(ModelExecutionStatus::BuildingContext) => {
                            info!("Progress: Building context...");
                            if let Ok(mut kb) = keyboard.lock() {
                                let _ = kb.progress("Thinking");
                            }
                        }
                        ProgressState::LlmState(ModelExecutionStatus::LlmProcessing) => {
                            info!("Progress: Thinking...");
                        }
                        ProgressState::LlmState(ModelExecutionStatus::RemoteAccepted) => {
                            info!("Progress: OpenClaw accepted request");
                        }
                        ProgressState::LlmState(ModelExecutionStatus::ProcessingResponse) => {
                            info!("Progress: Processing response...");
                        }
                        ProgressState::LlmState(ModelExecutionStatus::CallingTools) => {
                            info!("Progress: Executing tools...");
                            if let Ok(mut kb) = keyboard.lock() {
                                let _ = kb.progress_end();
                            }
                        }
                        ProgressState::LlmState(ModelExecutionStatus::Done) => {
                            debug!("Progress: LLM Done");
                        }
                        ProgressState::LlmState(ModelExecutionStatus::Error(msg)) => {
                            debug!("Progress: Error - {}", msg);
                        }
                        ProgressState::Done => {
                            debug!("Progress: Done");
                        }
                    }
                }
            }

            // Add dots for thinking state
            _ = sleep(Duration::from_millis(500)) => {
                if matches!(current_state, ProgressState::LlmState(ModelExecutionStatus::LlmProcessing)) {
                    if let Ok(mut kb) = keyboard.lock() {
                        let _ = kb.progress(".");
                    }
                }
            }
        }
    }

    Ok(())
}

/// Pick a box for the answer near a detected selection: directly below it,
/// or above if there is no room. The user can move/resize it afterwards with
/// the native selection tool.
fn auto_placement(sel: Rect) -> Rect {
    const SCREEN_W: i32 = 768;
    const SCREEN_H: i32 = 1024;
    const GAP: i32 = 16;
    const MARGIN: i32 = 10;

    // Give the answer all the space from below the selection to the bottom
    // of the page; fit_svg_to_rect anchors at the top and only uses what the
    // answer needs, so long answers keep a legible size instead of being
    // squeezed into a fixed-height box.
    let w = (sel.w * 3 / 2).clamp(300, SCREEN_W - 2 * MARGIN);
    let x = sel.x.clamp(MARGIN, SCREEN_W - MARGIN - w);
    let below_y = sel.y + sel.h + GAP;
    let space_below = SCREEN_H - MARGIN - below_y;
    let (y, h) = if space_below >= 160 {
        (below_y, space_below)
    } else {
        // No room below: use the space above the selection instead
        (MARGIN, (sel.y - GAP - MARGIN).max(160))
    };
    Rect { x, y, w, h }
}

/// Task that processes a trigger: screenshot → LLM → tool execution
pub async fn processing_task(
    config: Config,
    engine: Arc<TokioMutex<Box<dyn LLMEngine>>>,
    progress_tx: watch::Sender<ProgressState>,
    cancellation: Arc<SmartRemarkableCancellation>,
    keyboard: Arc<Mutex<Keyboard>>,
    touch: Arc<tokio::sync::RwLock<Touch>>,
    selection: Option<(Rect, Rect)>,
    placement_slot: Arc<Mutex<Option<Rect>>>,
    selection_slot: Arc<Mutex<Option<Rect>>>,
    input_image_slot: Arc<Mutex<Option<String>>>,
    write_back_view_guard: Arc<Mutex<WriteBackGuardState>>,
    trigger_source: TriggerSource,
    selection_kind: Option<SelectionKind>,
    selection_request: Option<SelectionRequest>,
    last_selection_fingerprint: Arc<Mutex<Option<u64>>>,
) -> Result<ProcessingOutcome> {
    info!("Processing task: starting");
    if let Ok(mut guard) = write_back_view_guard.lock() {
        *guard = WriteBackGuardState::Unrestricted;
    }

    let selection_descriptor = selection_request.as_ref().and_then(SelectionRequest::descriptor);
    let legacy_selection = selection_request.as_ref().map(SelectionRequest::is_legacy).unwrap_or(false);
    if matches!(trigger_source, TriggerSource::LlmButton | TriggerSource::SendButton) && selection_request.is_none() {
        info!("Explicit selection request lacked a validated generation; ignoring");
        let _ = progress_tx.send(ProgressState::Done);
        return Ok(ProcessingOutcome::NoSelection);
    }
    if let Some(descriptor) = selection_descriptor {
        if selection.map(|(rect, _)| rect) != Some(descriptor.rect) || selection_kind != Some(descriptor.kind) {
            info!("Explicit selection event does not match its nonce-bound descriptor");
            let _ = progress_tx.send(ProgressState::Done);
            return Ok(ProcessingOutcome::NoSelection);
        }
    }
    let response_mode = response_mode_for_trigger(trigger_source);

    // The pen-up event reaches evdev just before xochitl finishes painting
    // the gray native-selection marquee. Give the stock UI a short head
    // start; unlike a follow-up finger gesture, this does not dismiss it.
    if trigger_source == TriggerSource::PenLasso {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    // Update progress: taking screenshot
    info!("Setting ProgressState::TakingScreenshot");
    let _ = progress_tx.send(ProgressState::TakingScreenshot);
    tokio::time::sleep(Duration::from_millis(10)).await; // Give progress_task time

    // The explicit button path is a two-phase local transaction. QML rechecks
    // the still-live stock selection before it hides tint/controls; AppLoad
    // binds that acknowledgement to the launcher's active random nonce.
    let mut selection_prepared = false;
    if let Some(descriptor) = selection_descriptor {
        if !config.is_test_mode() {
            {
                let mut keyboard = keyboard
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Unable to prepare selection: keyboard lock poisoned"))?;
                keyboard.prepare_captured_selection()?;
            }
            if let Err(error) = wait_for_selection_acknowledgement(descriptor, SelectionAckPhase::Prepared, &cancellation).await {
                restore_prepared_selection(&keyboard);
                return Err(error);
            }
            selection_prepared = true;
        }
    }

    // Take screenshot
    let screenshot_path = config.save_screenshot.clone();
    let mut selection = selection;
    let mut selection_kind = selection_kind;
    let mut prepared_write_back_baseline = None;
    let captured_image = if let Some(input_png) = &config.input_png {
        match std::fs::read(input_png) {
            Ok(bytes) => BASE64_STANDARD.encode(bytes),
            Err(error) => {
                // A configured fixture can fail after a real v2 prepare even
                // though production launchers never supply --input-png.
                if selection_prepared {
                    restore_prepared_selection(&keyboard);
                }
                return Err(error.into());
            }
        }
    } else {
        let mut screenshot = if config.is_test_mode() {
            let simulation_config = SimulationConfig::from_config(&config);
            Screenshot::new_simulated(simulation_config)?
        } else {
            Screenshot::new()?
        };
        let screenshot_result = if let Some(descriptor) = selection_descriptor {
            screenshot.take_screenshot_with_orientation(descriptor.orientation)
        } else {
            screenshot.take_screenshot()
        };
        if let Err(error) = screenshot_result {
            if selection_prepared {
                restore_prepared_selection(&keyboard);
            }
            return Err(error);
        }
        if let Some(save_screenshot) = &config.save_screenshot {
            info!("Saving screenshot to {}", save_screenshot);
            if let Err(error) = screenshot.save_image(save_screenshot) {
                if selection_prepared {
                    restore_prepared_selection(&keyboard);
                }
                return Err(error);
            }
        }
        if selection_descriptor.is_some() && response_mode.writes_to_tablet() && selection_prepared {
            prepared_write_back_baseline = match screenshot.normalized_view() {
                Ok(view) => Some(view),
                Err(error) => {
                    restore_prepared_selection(&keyboard);
                    return Err(error);
                }
            };
        }

        // Select mode without tapped boxes: look for the native selection-tool
        // marquee in the screenshot and answer below it. Pen-up can precede
        // the final xochitl repaint, so retry a few read-only captures before
        // treating this candidate as an unrelated pen tap.
        if selection.is_none() && config.select_mode {
            let mut marquee = screenshot.detect_selection_rect();
            if trigger_source == TriggerSource::PenLasso {
                for _ in 0..4 {
                    if marquee.is_some() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    screenshot.take_screenshot()?;
                    marquee = screenshot.detect_selection_rect();
                }
            }
            match marquee {
                Some(marquee) => {
                    let placement = auto_placement(marquee);
                    info!("Detected selection marquee {:?}, answering into {:?}", marquee, placement);
                    selection = Some((marquee, placement));
                    selection_kind = Some(SelectionKind::Ink);
                }
                None => {
                    info!("No selection marquee found; ignoring trigger (select something first)");
                    if let Ok(mut fingerprint) = last_selection_fingerprint.lock() {
                        fingerprint.take();
                    }
                    let _ = progress_tx.send(ProgressState::Done);
                    return Ok(ProcessingOutcome::NoSelection);
                }
            }
        }

        let image_result = if let Some((selection_rect, _)) = &selection {
            screenshot.base64_cropped(*selection_rect)
        } else {
            screenshot.base64()
        };
        match image_result {
            Ok(image) => image,
            Err(error) => {
                if selection_prepared {
                    restore_prepared_selection(&keyboard);
                }
                return Err(error);
            }
        }
    };
    let effective_selection_kind = if selection.is_some() {
        Some(selection_kind.unwrap_or(SelectionKind::Ink))
    } else {
        None
    };
    let prepared_image_result = if let Some(kind) = effective_selection_kind {
        prepare_selection_png_b64_for_kind(&captured_image, SELECTION_VISION_MIN_LONG_EDGE, kind)
    } else {
        Ok(captured_image)
    };
    let base64_image = match prepared_image_result {
        Ok(image) => image,
        Err(error) => {
            if selection_prepared {
                restore_prepared_selection(&keyboard);
            }
            return Err(error);
        }
    };

    // Once the crop is immutable in memory, close the exact stock selection
    // before any remote work. Rust accepts the close only when AppLoad returns
    // the same nonce, kind, orientation, and geometry that were prepared.
    let mut pending_write_back_guard = None;
    if should_dismiss_captured_selection(trigger_source, selection.is_some(), effective_selection_kind)
        && selection_descriptor.is_some()
        && !config.is_test_mode()
    {
        let descriptor = selection_descriptor.ok_or_else(|| anyhow::anyhow!("Explicit selection close lacked its active descriptor"))?;
        let close_result = keyboard
            .lock()
            .map_err(|_| anyhow::anyhow!("Unable to dismiss captured selection: keyboard lock poisoned"))?
            .dismiss_captured_selection();
        if let Err(error) = close_result {
            if selection_prepared {
                restore_prepared_selection(&keyboard);
            }
            return Err(error);
        }
        if let Err(error) = wait_for_selection_acknowledgement(descriptor, SelectionAckPhase::Closed, &cancellation).await {
            if selection_prepared {
                restore_prepared_selection(&keyboard);
            }
            return Err(error);
        }
        // Bind the closed view back to the exact full framebuffer captured
        // while this original selection was prepared. A navigation between
        // close and this read can never become the new blessed baseline.
        if response_mode.writes_to_tablet() {
            let baseline = prepared_write_back_baseline
                .take()
                .ok_or_else(|| anyhow::anyhow!("Prepared original-page framebuffer was unavailable for write-back binding"))?;
            pending_write_back_guard = match bind_verified_post_close_view(
                baseline,
                descriptor.orientation,
                &cancellation,
            )
            .await
            {
                Ok(guard) => Some(guard),
                Err(error) if cancellation.should_cancel() => return Err(error),
                Err(error) => {
                    info!(
                        "Original page could not be rebound after local close ({}); \
                         continuing canonical OpenClaw/WhatsApp delivery with tablet insertion suppressed",
                        error
                    );
                    None
                }
            };
        }
    }

    let request_fingerprint =
        selection.map(|(selection_rect, _)| selection_fingerprint(&base64_image, selection_rect, effective_selection_kind.unwrap_or(SelectionKind::Ink)));
    let last_completed = last_selection_fingerprint.lock().ok().and_then(|last| *last);
    if should_suppress_duplicate(trigger_source, request_fingerprint, last_completed) {
        info!("Ignoring duplicate pen trigger for the still-active selection");
        let _ = progress_tx.send(ProgressState::Done);
        return Ok(ProcessingOutcome::DuplicateSelection);
    }

    if config.no_submit {
        info!("Skipping LLM submission (no_submit mode)");
        if let Some(fingerprint) = request_fingerprint {
            if let Ok(mut last) = last_selection_fingerprint.lock() {
                *last = Some(fingerprint);
            }
        }
        let _ = progress_tx.send(ProgressState::Done);
        return Ok(ProcessingOutcome::Completed);
    }

    if config.engine.as_deref() == Some("openclaw") && !config.is_test_mode() {
        wait_for_bridge_ready(&cancellation).await?;
    }

    // Tap middle bottom to position cursor for text input (before showing
    // "Thinking"). Skipped in select mode: the tap dismisses the active
    // marquee and its floating menu, which the in-place redraw needs (the
    // draw tool deletes the lassoed strokes via that menu's trash button).
    if !config.select_mode {
        if let Err(e) = touch.write().await.tap_middle_bottom().await {
            info!("Failed to tap middle bottom: {}", e);
        }
    }

    // Update progress: building context
    let _ = progress_tx.send(ProgressState::LlmState(ModelExecutionStatus::BuildingContext));
    tokio::time::sleep(Duration::from_millis(10)).await; // Give progress_task time

    // Apply segmentation if requested
    let segmentation_description = if config.apply_segmentation {
        let image_path = config
            .input_png
            .as_ref()
            .or(screenshot_path.as_ref())
            .ok_or_else(|| anyhow::anyhow!("Segmentation requires either input_png or save_screenshot"))?;

        info!("Applying segmentation to {}", image_path);
        let analyzer = ImageAnalyzer::new(0.001, 10); // min_region_size=0.1%, max_regions=10
        match analyzer.analyze_image(image_path) {
            Ok(result) => {
                let description = analyzer.generate_description(&result);
                info!("Segmentation found {} regions", result.regions.len());
                Some(description)
            }
            Err(e) => {
                info!("Segmentation failed: {}, continuing without it", e);
                None
            }
        }
    } else {
        None
    };

    // Load prompt. The Draw button overrides the normal select-mode prompt
    // with prompts/draw.json regardless of --prompt/config.prompt, since it's
    // a distinct action (sketch/refine) from the LLM button's Q&A behavior.
    let prompt_name = if config.select_mode && trigger_source == TriggerSource::DrawButton {
        // With an image-generation model configured, the LLM plans the
        // drawing (prompt-writing) instead of authoring SVG itself
        if config.image_model.is_some() {
            "draw_image.json".to_string()
        } else {
            "draw.json".to_string()
        }
    } else if config.select_mode && response_mode == ResponseMode::WhatsappOnly {
        "selection_openclaw_whatsapp.json".to_string()
    } else {
        config.prompt.clone()
    };
    let prompt_general_raw = load_config(&prompt_name);
    let prompt_general_json = serde_json::from_str::<serde_json::Value>(prompt_general_raw.as_str())?;
    let mut prompt = prompt_general_json["prompt"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Prompt file '{}' missing required 'prompt' field", prompt_name))?
        .to_string();

    // Add segmentation to prompt if available
    if let Some(seg_desc) = segmentation_description {
        prompt.push_str("\n\nImage Analysis:\n");
        prompt.push_str(&seg_desc);
    }

    // Arm request-scoped tool slots only after every fallible preprocessing
    // step and immediately before model execution. This prevents no-submit
    // and prompt/configuration errors from retaining a cropped page image.
    if response_mode.writes_to_tablet() {
        if let Some((selection_rect, placement_rect)) = &selection {
            if let Ok(mut slot) = placement_slot.lock() {
                *slot = Some(*placement_rect);
            }
            if let Ok(mut slot) = selection_slot.lock() {
                *slot = Some(*selection_rect);
            }
        }
        if selection_request.is_some() {
            if let Ok(mut guard) = write_back_view_guard.lock() {
                *guard = match pending_write_back_guard {
                    Some(view_guard) => WriteBackGuardState::Exact(view_guard),
                    None => WriteBackGuardState::Required,
                };
            }
        }
    }
    if trigger_source == TriggerSource::DrawButton {
        if let Ok(mut slot) = input_image_slot.lock() {
            *slot = Some(base64_image.clone());
        }
    }

    // Prepare engine
    let mut engine_guard = engine.lock().await;
    engine_guard.set_response_mode(response_mode);
    engine_guard.set_selection_kind(effective_selection_kind);
    engine_guard.clear_content();
    engine_guard.add_image_content(&base64_image);
    engine_guard.add_text_content(&prompt);

    // Create status callback that wraps model execution status in LlmState
    let progress_tx_clone = progress_tx.clone();
    let keyboard_for_legacy = Arc::clone(&keyboard);
    let write_back_guard_for_legacy = Arc::clone(&write_back_view_guard);
    let has_selection = selection.is_some();
    let is_test_mode = config.is_test_mode();
    let mut legacy_selection_dismissed = false;
    let status_callback = Some(Box::new(move |status: ModelExecutionStatus| {
        if !is_test_mode && !legacy_selection_dismissed && should_dismiss_legacy_accepted_selection(legacy_selection, trigger_source, has_selection, &status) {
            match keyboard_for_legacy.lock() {
                Ok(mut keyboard) => match keyboard.dismiss_captured_selection() {
                    Ok(()) => {
                        legacy_selection_dismissed = true;
                        if response_mode.writes_to_tablet() {
                            // The installed legacy QMD cannot bind its
                            // post-close frame to the prepared original page.
                            // Keep Required so migration-stage write-back is
                            // suppressed rather than blessing a page reached
                            // during its unacknowledged close.
                            if let Ok(mut guard) = write_back_guard_for_legacy.lock() {
                                *guard = WriteBackGuardState::Required;
                            }
                            info!(
                                "Legacy selection closed without v2 original-page binding; \
                                 WhatsApp remains canonical and tablet insertion is suppressed"
                            );
                        }
                    }
                    Err(error) => info!("Unable to close remotely accepted legacy selection: {}", error),
                },
                Err(_) => info!("Unable to close remotely accepted legacy selection: keyboard lock poisoned"),
            }
        }
        let _ = progress_tx_clone.send(ProgressState::LlmState(status));
    }) as Box<dyn FnMut(ModelExecutionStatus) + Send>);

    // Execute LLM with proper error handling
    info!("Processing task: calling LLM");
    let execution_result = engine_guard.execute(&cancellation, status_callback).await;
    // Model content includes the selected image; release it immediately after
    // every execution instead of retaining it until the next request.
    engine_guard.clear_content();
    drop(engine_guard);

    // Write model output if configured
    if let Some(model_output_file) = &config.model_output_file {
        info!("Would write model output to {}", model_output_file);
        // Note: The actual model output would need to be captured from the engine
        // This is a placeholder - the LLMEngine trait would need to expose the raw response
    }

    // Disarm both slots so later non-select runs draw normally
    if let Ok(mut slot) = placement_slot.lock() {
        slot.take();
    }
    if let Ok(mut slot) = selection_slot.lock() {
        slot.take();
    }
    if let Ok(mut slot) = input_image_slot.lock() {
        slot.take();
    }
    if let Ok(mut guard) = write_back_view_guard.lock() {
        *guard = WriteBackGuardState::Unrestricted;
    }

    // Handle execution result
    match execution_result {
        Ok(_) => {
            if let Some(fingerprint) = request_fingerprint {
                if let Ok(mut last) = last_selection_fingerprint.lock() {
                    *last = Some(fingerprint);
                }
            }
            let _ = progress_tx.send(ProgressState::Done);
            info!("Processing task: completed successfully");
            Ok(ProcessingOutcome::Completed)
        }
        Err(e) => {
            let error_msg = e.to_string();
            info!("Processing task: LLM error: {}", error_msg);

            // Only send error state if not already cancelled
            if !error_msg.contains("cancelled") && !error_msg.contains("canceled") {
                let _ = progress_tx.send(ProgressState::LlmState(ModelExecutionStatus::Error(error_msg.clone())));
                // Keep error visible for a moment
                sleep(Duration::from_secs(2)).await;
            }

            // Return to idle state
            let _ = progress_tx.send(ProgressState::Idle);
            Err(e)
        }
    }
}
