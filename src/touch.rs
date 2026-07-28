use anyhow::Result;
use evdev::EventType as EvdevEventType;
use evdev::{Device, EventStream, InputEvent};
use log::{debug, info, trace};

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};
use tokio::time::sleep;

use crate::cancellation::SmartRemarkableCancellation;
use crate::device::DeviceModel;
use crate::screenshot::Screenshot;
use crate::simulation::{SimulationConfig, TouchSimulator};

/// The active pen tool slot in the RMPP xochitl palette.
/// These correspond to the first two slots in the pen type grid.
/// Verified palette slot coordinates: Ballpoint=(96,119), Fineliner=(150,119).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PenTool {
    Ballpoint,
    Fineliner,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TriggerCorner {
    UpperRight,
    UpperLeft,
    LowerRight,
    LowerLeft,
    /// Trigger on a simultaneous four-finger tap anywhere on the screen
    FourFinger,
    /// Trigger when the pen is lifted after the armed stock lasso gesture.
    PenRelease,
    /// Trigger only when a completed lasso ends with a stationary dwell
    /// before pen-up.
    PenHold,
}

impl TriggerCorner {
    pub fn from_string(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "ur" | "upper-right" => Ok(TriggerCorner::UpperRight),
            "ul" | "upper-left" => Ok(TriggerCorner::UpperLeft),
            "lr" | "lower-right" => Ok(TriggerCorner::LowerRight),
            "ll" | "lower-left" => Ok(TriggerCorner::LowerLeft),
            "4f" | "four-finger" | "fourfinger" => Ok(TriggerCorner::FourFinger),
            "pen-release" | "penrelease" | "lasso" => Ok(TriggerCorner::PenRelease),
            "pen-hold" | "penhold" | "hold" => Ok(TriggerCorner::PenHold),
            _ => Err(anyhow::anyhow!(
                "Invalid trigger corner: {}. Use UR, UL, LR, LL, upper-right, upper-left, lower-right, lower-left, four-finger, pen-release, or pen-hold",
                s
            )),
        }
    }
}

// Output dimensions remain the same for both devices
const VIRTUAL_WIDTH: u16 = 768;
const VIRTUAL_HEIGHT: u16 = 1024;

/// Written by the xovi `llmbutton` extension (xovi-ext/llmbutton/main.c) when the
/// injected "LLM" button beside xochitl's selection menu is tapped. Deleted here once
/// consumed, matching the extension's own file-trigger-is-an-ack convention. This is an
/// additional trigger source alongside the four-finger gesture, not a replacement for
/// it -- see SELECT_MODE.md.
const RUNTIME_STATE_DIR: &str = "/run/smart-remarkable";
const RUNTIME_READY_FILE: &str = "/run/smart-remarkable/ready";
const RUNTIME_BUSY_FILE: &str = "/run/smart-remarkable/busy";
const LLM_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/llm_button_trigger";
const SEND_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/send_button_trigger";

/// Written by the same xovi extension when the sibling "Draw" button (beside the LLM
/// button) is tapped. Selects the Draw prompt (`prompts/draw.json`) instead of the
/// normal answer prompt for that one processing run -- see `TriggerSource`.
const DRAW_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/draw_button_trigger";

/// Consume all button markers as one admission decision. If concurrent
/// launchers somehow create more than one marker, deterministic priority plus
/// draining prevents a second request from being queued behind the first.
fn take_button_trigger(
    llm_trigger_file: &str,
    send_trigger_file: &str,
    draw_trigger_file: &str,
) -> Option<TriggerSource> {
    let llm = std::fs::remove_file(llm_trigger_file).is_ok();
    let send = std::fs::remove_file(send_trigger_file).is_ok();
    let draw = std::fs::remove_file(draw_trigger_file).is_ok();
    if llm {
        Some(TriggerSource::LlmButton)
    } else if send {
        Some(TriggerSource::SendButton)
    } else if draw {
        Some(TriggerSource::DrawButton)
    } else {
        None
    }
}

/// Which physical trigger woke up `wait_for_trigger`. Threaded through so select-mode
/// can pick a different prompt/behavior for the Draw button without changing the
/// public `wait_for_trigger` signature (see `Touch::last_trigger_source`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum TriggerSource {
    /// Corner tap, four-finger gesture, or simulated trigger.
    #[default]
    Touch,
    /// The injected "LLM" button beside xochitl's selection menu.
    LlmButton,
    /// The injected "Send" button: deliver through OpenClaw/WhatsApp without
    /// writing the returned answer into the notebook.
    SendButton,
    /// The injected "Draw" button beside xochitl's selection menu.
    DrawButton,
    /// The pen was lifted after the AppLoad-armed native lasso gesture.
    PenLasso,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PenReleaseKind {
    Quick,
    Held,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PenGestureOutcome {
    release: PenReleaseKind,
    admitted_at_down: bool,
    extent_px: i32,
}

/// Pure state reducer for the Paper Pro pen stream. xochitl remains the
/// authority on whether the path actually produced a native marquee; this
/// reducer only rejects taps, detects the optional endpoint dwell, and
/// remembers whether the contact began while another request was busy.
#[derive(Debug, Default)]
struct PenGestureTracker {
    touching: bool,
    admitted_at_down: bool,
    current_x: Option<i32>,
    current_y: Option<i32>,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
    have_bounds: bool,
    anchor_x: i32,
    anchor_y: i32,
    stationary_since_ms: u64,
    last_event_ms: u64,
    timestamp_regressed: bool,
}

impl PenGestureTracker {
    const BTN_TOUCH: u16 = 330;
    const ABS_X: u16 = 0;
    const ABS_Y: u16 = 1;

    fn observe(
        &mut self,
        event_type: EvdevEventType,
        code: u16,
        value: i32,
        event_time_ms: u64,
        admission_ready: bool,
        hold_ms: u64,
        hold_radius_px: i32,
    ) -> Option<PenGestureOutcome> {
        if event_type == EvdevEventType::ABSOLUTE
            && (code == Self::ABS_X || code == Self::ABS_Y)
        {
            if code == Self::ABS_X {
                self.current_x = Some(value);
            } else {
                self.current_y = Some(value);
            }
            if self.touching {
                self.observe_position(event_time_ms, hold_radius_px);
            }
            return None;
        }

        if event_type != EvdevEventType::KEY || code != Self::BTN_TOUCH {
            return None;
        }

        if value > 0 {
            if !self.touching {
                self.touching = true;
                self.admitted_at_down = admission_ready;
                self.have_bounds = false;
                self.stationary_since_ms = event_time_ms;
                self.last_event_ms = event_time_ms;
                self.timestamp_regressed = false;
                self.initialize_position(event_time_ms);
            }
            return None;
        }

        if value != 0 || !self.touching {
            return None;
        }

        if event_time_ms < self.last_event_ms {
            self.timestamp_regressed = true;
        }
        let extent_px = if self.have_bounds {
            (self.max_x - self.min_x).max(self.max_y - self.min_y)
        } else {
            0
        };
        let held = !self.timestamp_regressed
            && event_time_ms.saturating_sub(self.stationary_since_ms) >= hold_ms;
        let outcome = PenGestureOutcome {
            release: if held {
                PenReleaseKind::Held
            } else {
                PenReleaseKind::Quick
            },
            admitted_at_down: self.admitted_at_down,
            extent_px,
        };
        self.touching = false;
        self.have_bounds = false;
        self.admitted_at_down = false;
        Some(outcome)
    }

    fn initialize_position(&mut self, event_time_ms: u64) {
        if let (Some(x), Some(y)) = (self.current_x, self.current_y) {
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
            self.anchor_x = x;
            self.anchor_y = y;
            self.have_bounds = true;
            self.stationary_since_ms = event_time_ms;
        }
    }

    fn observe_position(&mut self, event_time_ms: u64, hold_radius_px: i32) {
        let (Some(x), Some(y)) = (self.current_x, self.current_y) else {
            return;
        };
        if event_time_ms < self.last_event_ms {
            self.timestamp_regressed = true;
            self.stationary_since_ms = event_time_ms;
            self.anchor_x = x;
            self.anchor_y = y;
        }
        self.last_event_ms = event_time_ms;

        if !self.have_bounds {
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
            self.anchor_x = x;
            self.anchor_y = y;
            self.have_bounds = true;
            self.stationary_since_ms = event_time_ms;
            return;
        }

        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);

        let dx = x - self.anchor_x;
        let dy = y - self.anchor_y;
        if dx.saturating_mul(dx) + dy.saturating_mul(dy)
            > hold_radius_px.saturating_mul(hold_radius_px)
        {
            self.anchor_x = x;
            self.anchor_y = y;
            self.stationary_since_ms = event_time_ms;
        }
    }
}

// Event codes
const ABS_MT_SLOT: u16 = 47;
const ABS_MT_TOUCH_MAJOR: u16 = 48;
const ABS_MT_TOUCH_MINOR: u16 = 49;
const ABS_MT_ORIENTATION: u16 = 52;
const ABS_MT_POSITION_X: u16 = 53;
const ABS_MT_POSITION_Y: u16 = 54;
// const ABS_MT_TOOL_TYPE: u16 = 55;
const ABS_MT_TRACKING_ID: u16 = 57;
const ABS_MT_PRESSURE: u16 = 58;

/// Axis-aligned rectangle in virtual 768x1024 screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    /// Build a normalized rect from two corner taps, enforcing a minimum size
    /// so an accidental double-tap still yields a usable box.
    pub fn from_corners((x1, y1): (i32, i32), (x2, y2): (i32, i32)) -> Self {
        const MIN_SIZE: i32 = 40;
        let x = x1.min(x2);
        let y = y1.min(y2);
        let w = (x1 - x2).abs().max(MIN_SIZE);
        let h = (y1 - y2).abs().max(MIN_SIZE);
        Rect { x, y, w, h }
    }
}

pub enum TouchMode {
    Real {
        input_device: Option<Device>,      // For sending touch events
        event_stream: Option<EventStream>, // For reading touch events
        pen_event_stream: Option<EventStream>, // For the arm-then-lasso trigger
        device_model: DeviceModel,
    },
    Simulated {
        simulator: TouchSimulator,
    },
}

pub struct Touch {
    mode: TouchMode,
    trigger_corner: TriggerCorner,
    last_trigger_source: TriggerSource,
    pen_hold_ms: u64,
    pen_hold_radius_px: i32,
    pen_min_extent_px: i32,
}

impl Touch {
    pub fn new(no_touch: bool, trigger_corner: TriggerCorner) -> Self {
        Self::new_with_pen_hold(no_touch, trigger_corner, 800, 12, 24)
    }

    pub fn new_with_pen_hold(
        no_touch: bool,
        trigger_corner: TriggerCorner,
        pen_hold_ms: u64,
        pen_hold_radius_px: i32,
        pen_min_extent_px: i32,
    ) -> Self {
        let device_model = DeviceModel::detect();
        info!("Touch using device model: {}", device_model.name());

        let device_path = match device_model {
            DeviceModel::Remarkable2 => "/dev/input/event2",
            DeviceModel::RemarkablePaperPro => "/dev/input/event3",
            DeviceModel::Unknown => "/dev/input/event2", // Default to RM2
        };

        let (input_device, event_stream, pen_event_stream) = if no_touch {
            (None, None, None)
        } else {
            let input_dev = Device::open(device_path).unwrap();
            let read_dev = Device::open(device_path).unwrap();
            let stream = read_dev.into_event_stream().unwrap();
            let pen_stream = if device_model == DeviceModel::RemarkablePaperPro
                && matches!(
                    trigger_corner,
                    TriggerCorner::PenRelease | TriggerCorner::PenHold
                )
            {
                Some(
                    Device::open("/dev/input/event2")
                        .unwrap()
                        .into_event_stream()
                        .unwrap(),
                )
            } else {
                None
            };
            (Some(input_dev), Some(stream), pen_stream)
        };

        Self {
            mode: TouchMode::Real {
                input_device,
                event_stream,
                pen_event_stream,
                device_model,
            },
            trigger_corner,
            last_trigger_source: TriggerSource::default(),
            pen_hold_ms,
            pen_hold_radius_px,
            pen_min_extent_px,
        }
    }

    pub fn new_simulated(simulation_config: SimulationConfig, trigger_corner: TriggerCorner) -> Result<Self> {
        let simulator = TouchSimulator::new(simulation_config, trigger_corner)?;
        info!("Touch using simulation mode");

        Ok(Self {
            mode: TouchMode::Simulated { simulator },
            trigger_corner,
            last_trigger_source: TriggerSource::default(),
            pen_hold_ms: 800,
            pen_hold_radius_px: 12,
            pen_min_extent_px: 24,
        })
    }

    /// Initialize the one long-lived trigger listener. This deliberately does
    /// not happen in `Touch::new`, because drawing callbacks construct helper
    /// Touch instances and must not erase a button press.
    pub fn prepare_trigger_listener(&mut self) -> Result<()> {
        let _ = std::fs::remove_file(LLM_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(SEND_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(DRAW_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(RUNTIME_BUSY_FILE);
        let _ = std::fs::remove_file(RUNTIME_READY_FILE);

        let runtime_dir = std::path::Path::new(RUNTIME_STATE_DIR);
        if !runtime_dir.is_dir() {
            return Ok(());
        }
        if std::fs::symlink_metadata(RUNTIME_READY_FILE)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(anyhow::anyhow!(
                "Refusing symlink runtime marker {}",
                RUNTIME_READY_FILE
            ));
        }
        std::fs::write(RUNTIME_READY_FILE, [])?;
        Ok(())
    }

    /// Which physical trigger caused the most recent `wait_for_trigger` to return `Ok`.
    /// Reset to `TriggerSource::Touch` at the start of every `wait_for_trigger` call.
    pub fn last_trigger_source(&self) -> TriggerSource {
        self.last_trigger_source
    }

    pub async fn wait_for_trigger(&mut self, cancellation: &SmartRemarkableCancellation) -> Result<()> {
        let admission = AtomicBool::new(true);
        self.wait_for_trigger_admitted(cancellation, &admission).await
    }

    pub async fn wait_for_trigger_admitted(
        &mut self,
        cancellation: &SmartRemarkableCancellation,
        admission: &AtomicBool,
    ) -> Result<()> {
        debug!("wait_for_trigger: entered, checking mode");
        self.last_trigger_source = TriggerSource::default();
        match &mut self.mode {
            TouchMode::Simulated { simulator } => {
                debug!("wait_for_trigger: using Simulated mode");
                simulator.wait_for_trigger(cancellation).await
            }
            TouchMode::Real {
                event_stream,
                pen_event_stream,
                device_model,
                ..
            } => {
                debug!("wait_for_trigger: using Real device mode");
                let trigger_corner = self.trigger_corner;
                let source = if matches!(
                    trigger_corner,
                    TriggerCorner::PenRelease | TriggerCorner::PenHold
                ) {
                    Self::wait_for_pen_lasso_trigger(
                        pen_event_stream,
                        device_model,
                        trigger_corner,
                        self.pen_hold_ms,
                        self.pen_hold_radius_px,
                        self.pen_min_extent_px,
                        cancellation,
                        admission,
                    )
                    .await?
                } else {
                    Self::wait_for_real_trigger(
                        event_stream,
                        device_model,
                        trigger_corner,
                        cancellation,
                        admission,
                    )
                    .await?
                };
                self.last_trigger_source = source;
                Ok(())
            }
        }
    }

    async fn wait_for_pen_lasso_trigger(
        pen_event_stream: &mut Option<EventStream>,
        device_model: &DeviceModel,
        trigger_corner: TriggerCorner,
        pen_hold_ms: u64,
        pen_hold_radius_px: i32,
        pen_min_extent_px: i32,
        cancellation: &SmartRemarkableCancellation,
        admission: &AtomicBool,
    ) -> Result<TriggerSource> {
        let events = pen_event_stream
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Pen event stream unavailable"))?;
        let mut tracker = PenGestureTracker::default();
        let mut raw_x: Option<i32> = None;
        let mut raw_y: Option<i32> = None;
        info!(
            "Waiting for {:?} native-lasso trigger (hold={}ms, radius={}px)",
            trigger_corner, pen_hold_ms, pen_hold_radius_px
        );

        loop {
            if let Some(source) =
                take_button_trigger(
                    LLM_BUTTON_TRIGGER_FILE,
                    SEND_BUTTON_TRIGGER_FILE,
                    DRAW_BUTTON_TRIGGER_FILE,
                )
            {
                if admission.load(Ordering::Acquire) {
                    return Ok(source);
                }
                info!("Ignoring button trigger while another request is active");
            }

            tokio::select! {
                _ = async {
                    while !cancellation.should_cancel_main() {
                        sleep(Duration::from_millis(50)).await;
                    }
                } => {
                    return Err(anyhow::anyhow!("Pen waiting cancelled"));
                }

                _ = sleep(Duration::from_millis(150)) => {}

                event_result = events.next_event() => {
                    let event = event_result?;
                    let value = if event.event_type() == EvdevEventType::ABSOLUTE
                        && (event.code() == PenGestureTracker::ABS_X
                            || event.code() == PenGestureTracker::ABS_Y)
                    {
                        if event.code() == PenGestureTracker::ABS_X {
                            raw_x = Some(event.value());
                        } else {
                            raw_y = Some(event.value());
                        }
                        if let (Some(x), Some(y)) = (raw_x, raw_y) {
                            let (virtual_x, virtual_y) =
                                Self::input_to_virtual((x, y), device_model);
                            if event.code() == PenGestureTracker::ABS_X {
                                virtual_x
                            } else {
                                virtual_y
                            }
                        } else {
                            // Bounds require both axes. The next axis update
                            // will provide a complete normalized point.
                            continue;
                        }
                    } else {
                        event.value()
                    };
                    let event_time_ms = event
                        .timestamp()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .map(|duration| {
                            duration.as_millis().min(u64::MAX as u128) as u64
                        })
                        .unwrap_or_default();
                    if let Some(outcome) = tracker.observe(
                        event.event_type(),
                        event.code(),
                        value,
                        event_time_ms,
                        admission.load(Ordering::Acquire),
                        pen_hold_ms,
                        pen_hold_radius_px,
                    ) {
                        if !outcome.admitted_at_down {
                            info!("Ignoring pen gesture that began while another request was active");
                            continue;
                        }
                        if outcome.extent_px < pen_min_extent_px {
                            debug!(
                                "Ignoring pen contact with {}px extent (< {}px)",
                                outcome.extent_px, pen_min_extent_px
                            );
                            continue;
                        }
                        if trigger_corner == TriggerCorner::PenHold
                            && outcome.release != PenReleaseKind::Held
                        {
                            debug!("Quick lasso left as an ordinary stock selection");
                            continue;
                        }
                        debug!("Accepted {:?} lasso release", outcome.release);
                        return Ok(TriggerSource::PenLasso);
                    }
                }
            }
        }
    }

    async fn wait_for_real_trigger(
        event_stream: &mut Option<EventStream>,
        device_model: &DeviceModel,
        trigger_corner: TriggerCorner,
        cancellation: &SmartRemarkableCancellation,
        admission: &AtomicBool,
    ) -> Result<TriggerSource> {
        debug!("wait_for_real_trigger: entered");
        let mut position_x = 0;
        let mut position_y = 0;

        // Multitouch slot tracking for the four-finger trigger
        let mut current_slot: usize = 0;
        let mut active_slots = [false; 32];
        let mut max_concurrent: usize = 0;

        if let Some(events) = event_stream {
            debug!("wait_for_real_trigger: event stream available, entering wait loop");

            loop {
                debug!("wait_for_real_trigger: loop iteration starting");

                if let Some(source) = take_button_trigger(
                    LLM_BUTTON_TRIGGER_FILE,
                    SEND_BUTTON_TRIGGER_FILE,
                    DRAW_BUTTON_TRIGGER_FILE,
                ) {
                    if admission.load(Ordering::Acquire) {
                        debug!("Button trigger file detected: {:?}", source);
                        return Ok(source);
                    }
                    info!("Ignoring button trigger while another request is active");
                }

                tokio::select! {
                    // Check for cancellation (only main token, not execution cycles)
                    _ = async {
                        while !cancellation.should_cancel_main() {
                            sleep(Duration::from_millis(50)).await;
                        }
                    } => {
                        debug!("wait_for_real_trigger: cancellation detected");
                        debug!("Touch waiting cancelled due to shutdown");
                        return Err(anyhow::anyhow!("Touch waiting cancelled"));
                    }

                    // Poll for the LLM/Draw buttons' trigger files (independent of trigger_corner)
                    _ = sleep(Duration::from_millis(150)) => {}

                    // Wait for next event
                    event_result = events.next_event() => {
                        debug!("wait_for_real_trigger: received event");
                        match event_result {
                            Ok(event) => {
                                if event.code() == ABS_MT_POSITION_X {
                                    position_x = event.value();
                                }
                                if event.code() == ABS_MT_POSITION_Y {
                                    position_y = event.value();
                                }
                                if event.code() == ABS_MT_SLOT {
                                    current_slot = (event.value().max(0) as usize).min(active_slots.len() - 1);
                                }
                                if event.code() == ABS_MT_TRACKING_ID {
                                    if trigger_corner == TriggerCorner::FourFinger {
                                        active_slots[current_slot] = event.value() != -1;
                                        let count = active_slots.iter().filter(|&&a| a).count();
                                        max_concurrent = max_concurrent.max(count);
                                        if count == 0 {
                                            if max_concurrent >= 4 {
                                                debug!("Four-finger tap detected ({} concurrent contacts)", max_concurrent);
                                                return Ok(TriggerSource::Touch);
                                            }
                                            max_concurrent = 0;
                                        }
                                    } else if event.value() == -1 {
                                        let (x, y) = Self::input_to_virtual((position_x, position_y), device_model);
                                        debug!("Touch release detected at ({}, {}) normalized ({}, {})", position_x, position_y, x, y);
                                        if Self::is_in_trigger_zone(x, y, trigger_corner) {
                                            debug!("Touch release in target zone!");
                                            debug!("wait_for_real_trigger: returning Ok()");
                                            return Ok(TriggerSource::Touch);
                                        } else {
                                            debug!("Touch release NOT in trigger zone, continuing");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                debug!("Error reading touch events: {}", e);
                                return Err(e.into());
                            }
                        }
                    }
                }
            }
        } else {
            debug!("wait_for_real_trigger: no event stream available, entering cancellation wait loop");
            // No event stream available, just wait for cancellation
            loop {
                if cancellation.should_cancel_main() {
                    debug!("wait_for_real_trigger: cancellation detected in no-stream path");
                    debug!("Touch waiting cancelled due to shutdown");
                    return Err(anyhow::anyhow!("Touch waiting cancelled"));
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    }

    /// Whether this Touch reads from a real input device (vs simulation).
    pub fn is_real(&self) -> bool {
        matches!(self.mode, TouchMode::Real { .. })
    }

    /// Wait for the next finger tap and return its release position in
    /// virtual 768x1024 coordinates. Used by select mode to collect the
    /// corners of the selection and answer-placement boxes.
    pub async fn wait_for_tap(&mut self, cancellation: &SmartRemarkableCancellation) -> Result<(i32, i32)> {
        match &mut self.mode {
            TouchMode::Simulated { .. } => Err(anyhow::anyhow!("wait_for_tap is not supported in simulation mode")),
            TouchMode::Real {
                event_stream, device_model, ..
            } => {
                let mut position_x = 0;
                let mut position_y = 0;

                let events = event_stream
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("No touch event stream available"))?;

                loop {
                    tokio::select! {
                        _ = async {
                            while !cancellation.should_cancel_main() {
                                sleep(Duration::from_millis(50)).await;
                            }
                        } => {
                            return Err(anyhow::anyhow!("Touch waiting cancelled"));
                        }

                        event_result = events.next_event() => {
                            match event_result {
                                Ok(event) => {
                                    if event.code() == ABS_MT_POSITION_X {
                                        position_x = event.value();
                                    }
                                    if event.code() == ABS_MT_POSITION_Y {
                                        position_y = event.value();
                                    }
                                    if event.code() == ABS_MT_TRACKING_ID && event.value() == -1 {
                                        let (x, y) = Self::input_to_virtual((position_x, position_y), device_model);
                                        debug!("wait_for_tap: release at virtual ({}, {})", x, y);
                                        return Ok((x, y));
                                    }
                                }
                                Err(e) => {
                                    debug!("Error reading touch events: {}", e);
                                    return Err(e.into());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub async fn touch_start(&mut self, xy: (i32, i32)) -> Result<()> {
        match &mut self.mode {
            TouchMode::Simulated { .. } => {
                debug!("Simulated touch_start at ({}, {})", xy.0, xy.1);
                Ok(())
            }
            TouchMode::Real {
                input_device, device_model, ..
            } => {
                let (x, y) = Self::virtual_to_input(xy, device_model);
                if let Some(device) = input_device {
                    trace!("touch_start at ({}, {})", x, y);
                    device.send_events(&[
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_SLOT, 0),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_TRACKING_ID, 1),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_POSITION_X, x),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_POSITION_Y, y),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_PRESSURE, 100),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_TOUCH_MAJOR, 17),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_TOUCH_MINOR, 17),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_ORIENTATION, 4),
                        InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0), // SYN_REPORT
                    ])?;
                    sleep(Duration::from_millis(1)).await;
                }
                Ok(())
            }
        }
    }

    pub async fn touch_stop(&mut self) -> Result<()> {
        match &mut self.mode {
            TouchMode::Simulated { .. } => {
                debug!("Simulated touch_stop");
                Ok(())
            }
            TouchMode::Real { input_device, .. } => {
                if let Some(device) = input_device {
                    trace!("touch_stop");
                    device.send_events(&[
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_SLOT, 0),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_TRACKING_ID, -1),
                        InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0), // SYN_REPORT
                    ])?;
                    sleep(Duration::from_millis(1)).await;
                }
                Ok(())
            }
        }
    }

    pub async fn goto_xy(&mut self, xy: (i32, i32)) -> Result<()> {
        match &mut self.mode {
            TouchMode::Simulated { .. } => {
                debug!("Simulated goto_xy at ({}, {})", xy.0, xy.1);
                Ok(())
            }
            TouchMode::Real {
                input_device, device_model, ..
            } => {
                let (x, y) = Self::virtual_to_input(xy, device_model);
                if let Some(device) = input_device {
                    device.send_events(&[
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_SLOT, 0),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_TRACKING_ID, 1),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_POSITION_X, x),
                        InputEvent::new(EvdevEventType::ABSOLUTE.0, ABS_MT_POSITION_Y, y),
                        InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0), // SYN_REPORT
                    ])?;
                }
                Ok(())
            }
        }
    }

    pub async fn tap_middle_bottom(&mut self) -> Result<()> {
        self.touch_start((384, 1023)).await?; // middle bottom
        sleep(Duration::from_millis(100)).await;
        self.touch_stop().await?;
        // sleep(Duration::from_millis(10));
        // sleep(Duration::from_millis(100));
        Ok(())
    }

    // ── Tool palette helpers ────────────────────────────────────────────────

    /// Palette toggle button (upper-left circle). Tapping toggles the palette open/closed.
    const PALETTE_BUTTON: (i32, i32) = (35, 35);

    /// Sidebar tool icon y-centers (virtual 768×1024 coords, x≈28).
    /// Verified by screenshot analysis. All icons are at x≈28 when palette is open.
    const SIDEBAR_Y_PEN1: i32 = 80;   // Mechanical pencil (pen slot 1)
    const SIDEBAR_Y_PEN2: i32 = 130;  // Fineliner (pen slot 2) — used by smart_remarkable
    const SIDEBAR_Y_TEXT: i32 = 187;  // Text tool
    const SIDEBAR_Y_ERASER: i32 = 240;
    const SIDEBAR_X: i32 = 28;

    /// Known sidebar tool y-centers for dynamic scanning.
    const SIDEBAR_TOOL_YS: &'static [i32] = &[
        Self::SIDEBAR_Y_PEN1,
        Self::SIDEBAR_Y_PEN2,
        Self::SIDEBAR_Y_TEXT,
        Self::SIDEBAR_Y_ERASER,
    ];

    /// Settings panel coordinates for the Fineliner pen (slot 2, y≈130).
    /// NOTE: Tapping a pen-type icon closes the settings panel — skip that tap.
    /// Only configure size and color; these taps keep the settings panel open.
    const SETTINGS_SIZE_THIN: (i32, i32) = (96, 385);      // Thin stroke thickness
    const SETTINGS_SIZE_MEDIUM: (i32, i32) = (150, 385);   // Medium stroke thickness
    const SETTINGS_COLOR_BLACK: (i32, i32) = (96, 468);    // Black color (row 1, col 1)

    /// Detect whether the palette is currently open by scanning the screenshot.
    ///
    /// When the palette is OPEN, the left ~55px wide strip shows tool icons.
    /// We check whether there's substantial dark content in the sidebar region
    /// (pixel at x=28, y=80 is dark = pen1 icon or selected-background visible).
    /// When palette is CLOSED, only the toggle circle is visible; y=80 is white canvas.
    fn screenshot_palette_open(ss: &Screenshot) -> bool {
        // Check a pixel inside the expected sidebar tool area.
        // Any dark content at this position = palette is open.
        let is_open = (60u32..110).any(|y| {
            ss.get_pixel(28, y).map(|(r, _, _)| r < 180).unwrap_or(false)
        });
        is_open
    }

    /// Scan the open palette sidebar and return the y-center of the currently selected tool.
    ///
    /// When the palette is open, the selected tool has a dark (inverted) background
    /// spanning its full ~45px tall icon area. We scan x=5 (just inside the sidebar)
    /// to find the largest contiguous dark band.
    fn screenshot_selected_tool_y(ss: &Screenshot) -> Option<i32> {
        // Scan x=5, y=50..500 for dark pixels; find the longest contiguous run.
        let scan_x = 5u32;
        let mut best_run_start = 0i32;
        let mut best_run_len = 0usize;
        let mut cur_run_start = 0i32;
        let mut cur_run_len = 0usize;

        for y in 50u32..500 {
            let dark = ss.get_pixel(scan_x, y).map(|(r, _, _)| r < 100).unwrap_or(false);
            if dark {
                if cur_run_len == 0 {
                    cur_run_start = y as i32;
                }
                cur_run_len += 1;
            } else {
                if cur_run_len > best_run_len {
                    best_run_len = cur_run_len;
                    best_run_start = cur_run_start;
                }
                cur_run_len = 0;
            }
        }
        if cur_run_len > best_run_len {
            best_run_len = cur_run_len;
            best_run_start = cur_run_start;
        }

        if best_run_len >= 15 {
            Some(best_run_start + best_run_len as i32 / 2)
        } else {
            None
        }
    }

    /// Map a detected sidebar y-center to a PenTool (for the two pen slots we care about).
    fn y_to_pen_tool(y: i32) -> PenTool {
        if (y - Self::SIDEBAR_Y_PEN1).abs() < 25 {
            PenTool::Ballpoint
        } else if (y - Self::SIDEBAR_Y_PEN2).abs() < 25 {
            PenTool::Fineliner
        } else {
            PenTool::Unknown
        }
    }

    /// Take a fresh screenshot and detect palette state + active tool.
    /// Returns (palette_open, tool).
    async fn read_tool_state(&self) -> (bool, PenTool) {
        let mut ss = match Screenshot::new() {
            Ok(s) => s,
            Err(_) => return (false, PenTool::Unknown),
        };
        if ss.take_screenshot().is_err() {
            return (false, PenTool::Unknown);
        }
        let palette_open = Self::screenshot_palette_open(&ss);
        let tool = if palette_open {
            Self::screenshot_selected_tool_y(&ss)
                .map(Self::y_to_pen_tool)
                .unwrap_or(PenTool::Unknown)
        } else {
            PenTool::Unknown
        };
        info!("read_tool_state: palette_open={} → {:?}", palette_open, tool);
        (palette_open, tool)
    }

    /// Select the text tool in the sidebar so keyboard input is accepted,
    /// leaving the palette in the state we found it (it may be pinned).
    pub async fn select_text_tool(&mut self) -> Result<()> {
        let (palette_open, _) = self.read_tool_state().await;
        if !palette_open {
            self.tap(Self::PALETTE_BUTTON).await?;
            sleep(Duration::from_millis(100)).await;
        }
        self.tap((Self::SIDEBAR_X, Self::SIDEBAR_Y_TEXT)).await?;
        if !palette_open {
            self.tap(Self::PALETTE_BUTTON).await?;
        }
        Ok(())
    }

    /// Tap a point (touch_start + brief hold + touch_stop).
    pub async fn tap(&mut self, xy: (i32, i32)) -> Result<()> {
        self.touch_start(xy).await?;
        sleep(Duration::from_millis(100)).await;
        self.touch_stop().await?;
        sleep(Duration::from_millis(300)).await;
        Ok(())
    }

    /// Select fineliner pen with correct tip type, medium size, and black color.
    ///
    /// Robust algorithm that does not rely on knowing the current state:
    /// 1. Open palette (toggle if closed)
    /// 2. Tap ballpoint sidebar icon → guarantees ballpoint is now active
    /// 3. Tap fineliner sidebar icon → selects it (since ballpoint was active, this just selects)
    /// 4. Tap fineliner sidebar icon again → opens its settings (it's now active)
    /// 5. Configure: fineliner tip, medium size, black color
    /// 6. Close palette
    pub async fn select_fineliner(&mut self) -> Result<PenTool> {
        // Read current state so we can return the previous tool
        let (palette_open, previous) = self.read_tool_state().await;

        // Step 1: Open palette if not already open
        if !palette_open {
            self.tap(Self::PALETTE_BUTTON).await?;
            sleep(Duration::from_millis(100)).await; // Extra delay after toggle
        }

        let pen1 = (Self::SIDEBAR_X, Self::SIDEBAR_Y_PEN1);
        let pen2 = (Self::SIDEBAR_X, Self::SIDEBAR_Y_PEN2);

        // Step 2: Tap pen1 — guarantees pen1 is now the active tool
        self.tap(pen1).await?;

        // Step 3: Tap pen2 — selects it (pen1 was active, so this just switches)
        self.tap(pen2).await?;

        // Step 4: Tap pen2 again — opens its settings (pen2 is now active)
        self.tap(pen2).await?;
        sleep(Duration::from_millis(100)).await; // Extra delay for settings panel animation

        // Step 5: Configure thin size (skip tip type — tapping it closes the settings panel)
        self.tap(Self::SETTINGS_SIZE_THIN).await?;

        // Step 6: Configure black color
        self.tap(Self::SETTINGS_COLOR_BLACK).await?;

        // Step 8: Close palette
        self.tap(Self::PALETTE_BUTTON).await?;

        info!("select_fineliner: done, previous={:?}", previous);
        Ok(previous)
    }

    /// Switch to the given pen tool. Returns the previously active tool so caller can restore.
    /// Uses sidebar icons for reliable tool selection.
    pub async fn switch_to_tool(&mut self, target: PenTool) -> Result<PenTool> {
        let (palette_open, current_tool) = self.read_tool_state().await;
        let previous = if palette_open { PenTool::Unknown } else { current_tool };

        match target {
            PenTool::Fineliner => {
                return self.select_fineliner().await;
            }
            PenTool::Ballpoint => {
                // Open palette if needed, tap pen1 sidebar icon, and only
                // close the palette again if we opened it (it may be pinned)
                if !palette_open {
                    self.tap(Self::PALETTE_BUTTON).await?;
                    sleep(Duration::from_millis(100)).await;
                }
                self.tap((Self::SIDEBAR_X, Self::SIDEBAR_Y_PEN1)).await?;
                if !palette_open {
                    self.tap(Self::PALETTE_BUTTON).await?;
                }
            }
            PenTool::Unknown => {}
        }

        info!("switch_to_tool: {:?} → {:?}", previous, target);
        Ok(previous)
    }

    /// Restore a previously saved tool (e.g. after drawing is done).
    pub async fn restore_tool(&mut self, previous: PenTool) -> Result<()> {
        if previous == PenTool::Unknown || previous == PenTool::Fineliner {
            return Ok(()); // Nothing to restore or already on fineliner
        }
        self.switch_to_tool(previous).await?;
        Ok(())
    }

    /// Select the eraser sidebar tool. Unlike `switch_to_tool`, `read_tool_state`
    /// can't recognize an active eraser (`y_to_pen_tool` only maps the two pen
    /// slots), so this always opens the palette, taps the eraser icon, and
    /// closes the palette again -- the caller doesn't get a "previous tool" back
    /// since whatever draws next (e.g. `draw_svg_centerline`'s render pipeline)
    /// already re-selects its own pen tool before drawing.
    pub async fn select_eraser(&mut self) -> Result<()> {
        let (palette_open, _) = self.read_tool_state().await;
        if !palette_open {
            self.tap(Self::PALETTE_BUTTON).await?;
            sleep(Duration::from_millis(100)).await;
        }
        self.tap((Self::SIDEBAR_X, Self::SIDEBAR_Y_ERASER)).await?;
        if !palette_open {
            self.tap(Self::PALETTE_BUTTON).await?;
        }
        Ok(())
    }


    fn is_in_trigger_zone(x: i32, y: i32, trigger_corner: TriggerCorner) -> bool {
        const CORNER_SIZE: i32 = 68; // Size of the trigger zone (68x68 pixels)

        match trigger_corner {
            TriggerCorner::UpperRight => x > VIRTUAL_WIDTH as i32 - CORNER_SIZE && y < CORNER_SIZE,
            TriggerCorner::UpperLeft => x < CORNER_SIZE && y < CORNER_SIZE,
            TriggerCorner::LowerRight => x > VIRTUAL_WIDTH as i32 - CORNER_SIZE && y > VIRTUAL_HEIGHT as i32 - CORNER_SIZE,
            TriggerCorner::LowerLeft => x < CORNER_SIZE && y > VIRTUAL_HEIGHT as i32 - CORNER_SIZE,
            TriggerCorner::FourFinger => false, // handled by slot counting, not position
            TriggerCorner::PenRelease | TriggerCorner::PenHold => false, // pen stream
        }
    }

    fn virtual_to_input((x, y): (i32, i32), device_model: &DeviceModel) -> (i32, i32) {
        // Synthetic taps are planned in user space (UI-element constants,
        // rects from normalized screenshots); mirror to panel space when the
        // UI is rotated 180°
        let (x, y) = crate::util::maybe_rot180_virtual((x, y));
        // Swap and normalize the coordinates
        let x_normalized = x as f32 / VIRTUAL_WIDTH as f32;
        let y_normalized = y as f32 / VIRTUAL_HEIGHT as f32;
        let (screen_width, screen_height) = Self::screen_dimensions(device_model);

        match device_model {
            DeviceModel::RemarkablePaperPro => {
                let x_input = (x_normalized * screen_width as f32) as i32;
                let y_input = (y_normalized * screen_height as f32) as i32;
                (x_input, y_input)
            }
            _ => {
                // RM2 coordinate transformation
                let x_input = (x_normalized * screen_width as f32) as i32;
                let y_input = ((1.0 - y_normalized) * screen_height as f32) as i32;
                (x_input, y_input)
            }
        }
    }

    fn input_to_virtual((x, y): (i32, i32), device_model: &DeviceModel) -> (i32, i32) {
        // Swap and normalize the coordinates
        let (screen_width, screen_height) = Self::screen_dimensions(device_model);
        let x_normalized = x as f32 / screen_width as f32;
        let y_normalized = y as f32 / screen_height as f32;

        let virt = match device_model {
            DeviceModel::RemarkablePaperPro => {
                let x_input = (x_normalized * VIRTUAL_WIDTH as f32) as i32;
                let y_input = (y_normalized * VIRTUAL_HEIGHT as f32) as i32;
                (x_input, y_input)
            }
            _ => {
                // RM2 coordinate transformation
                let x_input = (x_normalized * VIRTUAL_WIDTH as f32) as i32;
                let y_input = ((1.0 - y_normalized) * VIRTUAL_HEIGHT as f32) as i32;
                (x_input, y_input)
            }
        };
        // Physical touches arrive in panel space; report them in user space
        // so select-mode corner taps line up with the normalized screenshots
        crate::util::maybe_rot180_virtual(virt)
    }

    fn screen_dimensions(device_model: &DeviceModel) -> (u32, u32) {
        match device_model {
            DeviceModel::Remarkable2 => (1404, 1872),
            DeviceModel::RemarkablePaperPro => (2065, 2833),
            DeviceModel::Unknown => (1404, 1872), // Default to RM2
        }
    }

    /// Update the trigger corner (called when config changes)
    pub fn set_trigger_corner(&mut self, new_corner: TriggerCorner) {
        self.trigger_corner = new_corner;
        if let TouchMode::Simulated { simulator } = &mut self.mode {
            simulator.set_trigger_corner(new_corner);
        }
    }

    /// Get handle for manual triggering (for web API in simulation mode)
    pub fn get_manual_trigger_handle(&self) -> Option<std::sync::Arc<std::sync::Mutex<Vec<TriggerCorner>>>> {
        match &self.mode {
            TouchMode::Simulated { simulator } => Some(simulator.get_manual_trigger_handle()),
            TouchMode::Real { .. } => None,
        }
    }

    /// Add a manual trigger (for web API in simulation mode)
    pub fn add_manual_trigger(&self, corner: TriggerCorner) {
        if let TouchMode::Simulated { simulator } = &self.mode {
            simulator.add_manual_trigger(corner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        take_button_trigger, PenGestureOutcome, PenGestureTracker,
        PenReleaseKind, TriggerCorner, TriggerSource,
    };
    use evdev::EventType;

    fn pen_lasso(
        hold_for_ms: u64,
        admission_ready: bool,
        last_move: (i32, i32),
    ) -> PenGestureOutcome {
        let mut tracker = PenGestureTracker::default();
        tracker.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        tracker.observe(
            EventType::KEY,
            330,
            1,
            10,
            admission_ready,
            800,
            12,
        );
        tracker.observe(EventType::ABSOLUTE, 0, 220, 100, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 220, 100, true, 800, 12);
        tracker.observe(
            EventType::ABSOLUTE,
            0,
            last_move.0,
            200,
            true,
            800,
            12,
        );
        tracker.observe(
            EventType::ABSOLUTE,
            1,
            last_move.1,
            200,
            true,
            800,
            12,
        );
        tracker
            .observe(
                EventType::KEY,
                330,
                0,
                200 + hold_for_ms,
                true,
                800,
                12,
            )
            .unwrap()
    }

    #[test]
    fn button_trigger_is_consumed_without_waiting_for_touch_idle() {
        let base = std::env::temp_dir().join(format!("smart-remarkable-trigger-{}", std::process::id()));
        let llm = base.with_extension("llm");
        let send = base.with_extension("send");
        let draw = base.with_extension("draw");

        let _ = std::fs::remove_file(&llm);
        let _ = std::fs::remove_file(&send);
        let _ = std::fs::remove_file(&draw);
        std::fs::write(&llm, []).unwrap();

        assert_eq!(
            take_button_trigger(
                llm.to_str().unwrap(),
                send.to_str().unwrap(),
                draw.to_str().unwrap(),
            ),
            Some(TriggerSource::LlmButton)
        );
        assert!(!llm.exists());
        assert_eq!(
            take_button_trigger(
                llm.to_str().unwrap(),
                send.to_str().unwrap(),
                draw.to_str().unwrap(),
            ),
            None
        );
    }

    #[test]
    fn simultaneous_button_markers_are_drained_as_one_request() {
        let base = std::env::temp_dir().join(format!(
            "smart-remarkable-multi-trigger-{}",
            std::process::id()
        ));
        let llm = base.with_extension("llm");
        let send = base.with_extension("send");
        let draw = base.with_extension("draw");
        for path in [&llm, &send, &draw] {
            let _ = std::fs::remove_file(path);
            std::fs::write(path, []).unwrap();
        }

        assert_eq!(
            take_button_trigger(
                llm.to_str().unwrap(),
                send.to_str().unwrap(),
                draw.to_str().unwrap(),
            ),
            Some(TriggerSource::LlmButton)
        );
        assert!(!llm.exists());
        assert!(!send.exists());
        assert!(!draw.exists());
        assert_eq!(
            take_button_trigger(
                llm.to_str().unwrap(),
                send.to_str().unwrap(),
                draw.to_str().unwrap(),
            ),
            None
        );
    }

    #[test]
    fn send_button_marker_selects_whatsapp_only_source() {
        let base = std::env::temp_dir().join(format!(
            "smart-remarkable-send-trigger-{}",
            std::process::id()
        ));
        let llm = base.with_extension("llm");
        let send = base.with_extension("send");
        let draw = base.with_extension("draw");
        for path in [&llm, &send, &draw] {
            let _ = std::fs::remove_file(path);
        }
        std::fs::write(&send, []).unwrap();

        assert_eq!(
            take_button_trigger(
                llm.to_str().unwrap(),
                send.to_str().unwrap(),
                draw.to_str().unwrap(),
            ),
            Some(TriggerSource::SendButton)
        );
    }

    #[test]
    fn pen_release_requires_a_real_contact_first() {
        let mut tracker = PenGestureTracker::default();
        assert_eq!(
            tracker.observe(EventType::KEY, 330, 0, 0, true, 800, 12),
            None
        );
        assert_eq!(
            tracker.observe(EventType::ABSOLUTE, 0, 10, 1, true, 800, 12),
            None
        );
    }

    #[test]
    fn hold_requires_the_full_dwell_and_preserves_admission_at_down() {
        assert_eq!(
            pen_lasso(799, true, (100, 100)).release,
            PenReleaseKind::Quick
        );
        assert_eq!(
            pen_lasso(800, true, (100, 100)).release,
            PenReleaseKind::Held
        );
        assert!(!pen_lasso(800, false, (100, 100)).admitted_at_down);
    }

    #[test]
    fn small_jitter_does_not_restart_hold_but_large_movement_does() {
        let mut tracker = PenGestureTracker::default();
        tracker.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        tracker.observe(EventType::KEY, 330, 1, 10, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 0, 200, 100, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 200, 100, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 0, 207, 500, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 205, 500, true, 800, 12);
        let held = tracker
            .observe(EventType::KEY, 330, 0, 900, true, 800, 12)
            .unwrap();
        assert_eq!(held.release, PenReleaseKind::Held);

        let mut moved = PenGestureTracker::default();
        moved.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        moved.observe(EventType::KEY, 330, 1, 10, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 0, 200, 100, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 1, 200, 100, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 0, 225, 500, true, 800, 12);
        let quick = moved
            .observe(EventType::KEY, 330, 0, 900, true, 800, 12)
            .unwrap();
        assert_eq!(quick.release, PenReleaseKind::Quick);
    }

    #[test]
    fn tiny_contact_and_timestamp_regression_fail_closed() {
        let mut tiny = PenGestureTracker::default();
        tiny.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        tiny.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        tiny.observe(EventType::KEY, 330, 1, 10, true, 800, 12);
        tiny.observe(EventType::ABSOLUTE, 0, 105, 20, true, 800, 12);
        let tiny_outcome = tiny
            .observe(EventType::KEY, 330, 0, 1000, true, 800, 12)
            .unwrap();
        assert!(tiny_outcome.extent_px < 24);

        let mut regressed = PenGestureTracker::default();
        regressed.observe(EventType::ABSOLUTE, 0, 100, 100, true, 800, 12);
        regressed.observe(EventType::ABSOLUTE, 1, 100, 100, true, 800, 12);
        regressed.observe(EventType::KEY, 330, 1, 100, true, 800, 12);
        regressed.observe(EventType::ABSOLUTE, 0, 200, 50, true, 800, 12);
        let outcome = regressed
            .observe(EventType::KEY, 330, 0, 1000, true, 800, 12)
            .unwrap();
        assert_eq!(outcome.release, PenReleaseKind::Quick);
    }

    #[test]
    fn pen_release_trigger_aliases_parse() {
        assert_eq!(
            TriggerCorner::from_string("pen-release").unwrap(),
            TriggerCorner::PenRelease
        );
        assert_eq!(
            TriggerCorner::from_string("lasso").unwrap(),
            TriggerCorner::PenRelease
        );
        assert_eq!(
            TriggerCorner::from_string("pen-hold").unwrap(),
            TriggerCorner::PenHold
        );
    }
}
