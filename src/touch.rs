use anyhow::Result;
use evdev::EventType as EvdevEventType;
use evdev::{AbsoluteAxisCode, Device, EventStream, InputEvent, KeyCode};
use log::{debug, info, trace};

use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

use crate::cancellation::SmartRemarkableCancellation;
use crate::device::DeviceModel;
use crate::llm_engine::SelectionKind;
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
const RUNTIME_BRIDGE_READY_FILE: &str = "/run/smart-remarkable/bridge-ready";
const SELECTION_PREPARE_ACK_FILE: &str = "/run/smart-remarkable/selection_prepare_ack";
const SELECTION_CLOSE_ACK_FILE: &str = "/run/smart-remarkable/selection_close_ack";
const LLM_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/llm_button_trigger";
const SEND_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/send_button_trigger";

/// Written by the same xovi extension when the sibling "Draw" button (beside the LLM
/// button) is tapped. Selects the Draw prompt (`prompts/draw.json`) instead of the
/// normal answer prompt for that one processing run -- see `TriggerSource`.
const DRAW_BUTTON_TRIGGER_FILE: &str = "/run/smart-remarkable/draw_button_trigger";

const SELECTION_FIXED_POINT_SCALE: u64 = 1_000_000;
const MAX_SELECTION_DESCRIPTOR_BYTES: u64 = 256;
const MAX_SELECTION_DESCRIPTOR_AGE_MS: u64 = 40_000;
const MAX_SELECTION_DESCRIPTOR_FUTURE_SKEW_MS: u64 = 5_000;
const SELECTION_ACK_TIMEOUT: Duration = Duration::from_secs(5);
// Keep one captured selection in memory while the restricted SSH tunnel
// reconnects. This remains shorter than the fresh one-hour transient unit
// granted to every explicit button request, and never persists the crop.
const BRIDGE_READY_TIMEOUT: Duration = Duration::from_secs(900);

/// Stable transform from stock QML's logical selection view to the physical
/// framebuffer. Explicit selection crops never use toolbar/corner heuristics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionOrientation {
    Normal,
    Rotated180,
}

impl SelectionOrientation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Rotated180 => "rot180",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "rot180" => Some(Self::Rotated180),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionAckPhase {
    Prepared,
    Closed,
}

/// Immutable stock-selection metadata supplied by the firmware-pinned QML.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionDescriptor {
    pub nonce: String,
    pub kind: SelectionKind,
    pub orientation: SelectionOrientation,
    pub rect: Rect,
    normalized_bounds: [u64; 4],
    captured_at_ms: u64,
}

impl SelectionDescriptor {
    fn parse_decimal(value: &str, label: &str) -> Result<u64> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) || (value.len() > 1 && value.starts_with('0')) {
            anyhow::bail!("Invalid canonical decimal for {label}");
        }
        Ok(value.parse::<u64>()?)
    }

    fn parse_at(payload: &str, now_ms: u64) -> Result<Self> {
        if payload.len() as u64 > MAX_SELECTION_DESCRIPTOR_BYTES || !payload.is_ascii() || payload.contains('\r') {
            anyhow::bail!("Invalid selection descriptor encoding");
        }
        let payload = payload.strip_suffix('\n').unwrap_or(payload);
        if payload.contains('\n') {
            anyhow::bail!("Selection descriptor must be exactly one line");
        }
        let fields: Vec<&str> = payload.split(',').collect();
        if fields.len() != 9 || fields[0] != "v2" {
            anyhow::bail!("Unsupported selection descriptor");
        }
        let nonce = fields[1];
        if nonce.len() != 64 || !nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            anyhow::bail!("Selection descriptor nonce is not canonical");
        }
        let kind = SelectionKind::parse(fields[2]).ok_or_else(|| anyhow::anyhow!("Unknown selection kind"))?;
        let orientation = SelectionOrientation::parse(fields[3]).ok_or_else(|| anyhow::anyhow!("Unknown selection orientation"))?;
        let x0 = Self::parse_decimal(fields[4], "x0")?;
        let y0 = Self::parse_decimal(fields[5], "y0")?;
        let x1 = Self::parse_decimal(fields[6], "x1")?;
        let y1 = Self::parse_decimal(fields[7], "y1")?;
        let captured_at_ms = Self::parse_decimal(fields[8], "capture timestamp")?;

        if x0 >= x1 || y0 >= y1 || x1 > SELECTION_FIXED_POINT_SCALE || y1 > SELECTION_FIXED_POINT_SCALE {
            anyhow::bail!("Selection descriptor is degenerate or out of bounds");
        }
        if captured_at_ms > now_ms {
            if captured_at_ms - now_ms > MAX_SELECTION_DESCRIPTOR_FUTURE_SKEW_MS {
                anyhow::bail!("Selection descriptor timestamp is in the future");
            }
        } else if now_ms - captured_at_ms > MAX_SELECTION_DESCRIPTOR_AGE_MS {
            anyhow::bail!("Selection descriptor is stale");
        }

        let scale = SELECTION_FIXED_POINT_SCALE;
        let left = (x0 * u64::from(VIRTUAL_WIDTH) / scale) as i32;
        let top = (y0 * u64::from(VIRTUAL_HEIGHT) / scale) as i32;
        let right = ((x1 * u64::from(VIRTUAL_WIDTH) + scale - 1) / scale) as i32;
        let bottom = ((y1 * u64::from(VIRTUAL_HEIGHT) + scale - 1) / scale) as i32;
        let rect = Rect {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
        };
        if rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > i32::from(VIRTUAL_WIDTH) || rect.y + rect.h > i32::from(VIRTUAL_HEIGHT) {
            anyhow::bail!("Selection descriptor does not map to the view");
        }

        Ok(Self {
            nonce: nonce.to_string(),
            kind,
            orientation,
            rect,
            normalized_bounds: [x0, y0, x1, y1],
            captured_at_ms,
        })
    }

    pub fn canonical_payload(&self) -> String {
        format!(
            "v2,{},{},{},{},{},{},{},{}",
            self.nonce,
            self.kind.as_str(),
            self.orientation.as_str(),
            self.normalized_bounds[0],
            self.normalized_bounds[1],
            self.normalized_bounds[2],
            self.normalized_bounds[3],
            self.captured_at_ms
        )
    }

    fn acknowledgement_payload(&self) -> String {
        format!(
            "v2,{},{},{},{},{},{},{}",
            self.nonce,
            self.kind.as_str(),
            self.orientation.as_str(),
            self.normalized_bounds[0],
            self.normalized_bounds[1],
            self.normalized_bounds[2],
            self.normalized_bounds[3]
        )
    }

    fn validate_acknowledgement(&self, payload: &str) -> Result<()> {
        let payload = payload.strip_suffix('\n').unwrap_or(payload);
        if payload.contains('\n') || payload.contains('\r') || payload != self.acknowledgement_payload() {
            anyhow::bail!("Selection acknowledgement does not match the active nonce and snapshot");
        }
        Ok(())
    }
}

/// One launcher-owned selection generation. `V2` is the strict QML geometry
/// protocol. `Legacy` exists only so the currently installed QMD can survive
/// an app-first staged update; it never enters the v2 acknowledgement path.
#[derive(Debug, Clone, PartialEq)]
pub enum SelectionRequest {
    V2(SelectionDescriptor),
    Legacy { nonce: String, captured_at_ms: u64 },
}

impl SelectionRequest {
    fn nonce_is_canonical(nonce: &str) -> bool {
        nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn timestamp_is_fresh(captured_at_ms: u64, now_ms: u64) -> bool {
        if captured_at_ms > now_ms {
            captured_at_ms - now_ms <= MAX_SELECTION_DESCRIPTOR_FUTURE_SKEW_MS
        } else {
            now_ms - captured_at_ms <= MAX_SELECTION_DESCRIPTOR_AGE_MS
        }
    }

    fn parse_at(payload: &str, now_ms: u64) -> Result<Self> {
        if payload.starts_with("v2,") {
            return Ok(Self::V2(SelectionDescriptor::parse_at(payload, now_ms)?));
        }
        if payload.len() as u64 > MAX_SELECTION_DESCRIPTOR_BYTES || !payload.is_ascii() || payload.contains('\r') {
            anyhow::bail!("Invalid legacy selection generation encoding");
        }
        let payload = payload.strip_suffix('\n').unwrap_or(payload);
        if payload.contains('\n') {
            anyhow::bail!("Legacy selection generation must be exactly one line");
        }
        let fields: Vec<&str> = payload.split(',').collect();
        if fields.len() != 3 || fields[0] != "legacy-v1" {
            anyhow::bail!("Unsupported selection generation");
        }
        let nonce = fields[1];
        if !Self::nonce_is_canonical(nonce) {
            anyhow::bail!("Legacy selection nonce is not canonical");
        }
        let captured_at_ms = SelectionDescriptor::parse_decimal(fields[2], "capture timestamp")?;
        if !Self::timestamp_is_fresh(captured_at_ms, now_ms) {
            anyhow::bail!("Legacy selection generation is stale or from the future");
        }
        Ok(Self::Legacy {
            nonce: nonce.to_string(),
            captured_at_ms,
        })
    }

    pub fn descriptor(&self) -> Option<&SelectionDescriptor> {
        match self {
            Self::V2(descriptor) => Some(descriptor),
            Self::Legacy { .. } => None,
        }
    }

    pub fn is_legacy(&self) -> bool {
        matches!(self, Self::Legacy { .. })
    }

    pub fn canonical_payload(&self) -> String {
        match self {
            Self::V2(descriptor) => descriptor.canonical_payload(),
            Self::Legacy { nonce, captured_at_ms } => format!("legacy-v1,{nonce},{captured_at_ms}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ButtonTrigger {
    source: TriggerSource,
    selection_request: Option<SelectionRequest>,
}

#[derive(Debug, Clone, PartialEq)]
struct TriggerActivation {
    source: TriggerSource,
    selection_request: Option<SelectionRequest>,
}

impl TriggerActivation {
    const fn without_descriptor(source: TriggerSource) -> Self {
        Self {
            source,
            selection_request: None,
        }
    }
}

fn current_time_ms() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?)
}

#[derive(Debug)]
struct SecureMarkerSnapshot {
    payload: String,
    dev: u64,
    ino: u64,
}

#[derive(Debug)]
struct InvalidButtonGeneration {
    reason: String,
    matching_busy_released: bool,
}

impl std::fmt::Display for InvalidButtonGeneration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} (matching busy generation released: {})",
            self.reason, self.matching_busy_released
        )
    }
}

impl std::error::Error for InvalidButtonGeneration {}

/// Read and unlink one complete root-only volatile marker. The directory and
/// file identities are rechecked around the open so symlinks or path swaps
/// cannot turn the trigger channel into an arbitrary-file reader.
fn read_secure_marker_file(path: &str, expected_uid: u32) -> Result<Option<SecureMarkerSnapshot>> {
    let path = Path::new(path);
    let path_metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("Trigger marker has no parent"))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir()
        || parent_metadata.file_type().is_symlink()
        || parent_metadata.uid() != expected_uid
        || parent_metadata.permissions().mode() & 0o777 != 0o700
    {
        anyhow::bail!("Trigger runtime directory is not owner-only");
    }
    if !path_metadata.file_type().is_file()
        || path_metadata.file_type().is_symlink()
        || path_metadata.uid() != expected_uid
        || path_metadata.permissions().mode() & 0o777 != 0o600
        || path_metadata.len() > MAX_SELECTION_DESCRIPTOR_BYTES
        || !(1..=2).contains(&path_metadata.nlink())
    {
        anyhow::bail!("Trigger marker is not a bounded owner-only regular file");
    }

    let file = std::fs::File::open(path)?;
    let opened_metadata = file.metadata()?;
    if opened_metadata.dev() != path_metadata.dev() || opened_metadata.ino() != path_metadata.ino() {
        anyhow::bail!("Trigger marker changed while opening");
    }
    let mut payload = String::new();
    file.take(MAX_SELECTION_DESCRIPTOR_BYTES + 1).read_to_string(&mut payload)?;
    if payload.len() as u64 > MAX_SELECTION_DESCRIPTOR_BYTES {
        anyhow::bail!("Trigger marker exceeds its size limit");
    }

    let final_metadata = std::fs::symlink_metadata(path)?;
    if final_metadata.dev() != path_metadata.dev() || final_metadata.ino() != path_metadata.ino() {
        anyhow::bail!("Trigger marker changed while reading");
    }
    Ok(Some(SecureMarkerSnapshot {
        payload,
        dev: path_metadata.dev(),
        ino: path_metadata.ino(),
    }))
}

fn unlink_secure_marker_snapshot(path: &str, snapshot: &SecureMarkerSnapshot) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.dev() != snapshot.dev || metadata.ino() != snapshot.ino {
        anyhow::bail!("Trigger marker changed before unlink");
    }
    std::fs::remove_file(path)?;
    Ok(())
}

fn consume_marker_file(path: &str, expected_uid: u32) -> Result<Option<String>> {
    let Some(snapshot) = read_secure_marker_file(path, expected_uid)? else {
        return Ok(None);
    };
    unlink_secure_marker_snapshot(path, &snapshot)?;
    Ok(Some(snapshot.payload))
}

fn consume_marker_if_exact(path: &str, expected_uid: u32, expected_payload: &str) -> Result<bool> {
    let Some(snapshot) = read_secure_marker_file(path, expected_uid)? else {
        return Ok(false);
    };
    if snapshot.payload != expected_payload {
        return Ok(false);
    }
    unlink_secure_marker_snapshot(path, &snapshot)?;
    Ok(true)
}

fn secure_runtime_marker_exists(path: &str, expected_uid: u32) -> Result<bool> {
    let path = Path::new(path);
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("Runtime marker has no parent"))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir()
        || parent_metadata.file_type().is_symlink()
        || parent_metadata.uid() != expected_uid
        || parent_metadata.permissions().mode() & 0o777 != 0o700
        || !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != expected_uid
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.len() != 0
        || metadata.nlink() != 1
    {
        anyhow::bail!("Runtime readiness marker is not an empty owner-only regular file");
    }
    Ok(true)
}

pub async fn wait_for_selection_acknowledgement(
    descriptor: &SelectionDescriptor,
    phase: SelectionAckPhase,
    cancellation: &SmartRemarkableCancellation,
) -> Result<()> {
    let path = match phase {
        SelectionAckPhase::Prepared => SELECTION_PREPARE_ACK_FILE,
        SelectionAckPhase::Closed => SELECTION_CLOSE_ACK_FILE,
    };
    let deadline = tokio::time::Instant::now() + SELECTION_ACK_TIMEOUT;
    loop {
        if let Some(payload) = consume_marker_file(path, 0)? {
            descriptor.validate_acknowledgement(&payload)?;
            return Ok(());
        }
        if cancellation.should_cancel() {
            anyhow::bail!("Selection acknowledgement wait cancelled");
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("Timed out waiting for the nonce-bound selection acknowledgement");
        }
        sleep(Duration::from_millis(25)).await;
    }
}

/// Remote readiness is deliberately separate from local capture readiness.
/// The stock selection may be validated, captured, and closed before this
/// marker exists; only the network submission waits for it.
pub async fn wait_for_bridge_ready(cancellation: &SmartRemarkableCancellation) -> Result<()> {
    let deadline = tokio::time::Instant::now() + BRIDGE_READY_TIMEOUT;
    loop {
        if secure_runtime_marker_exists(RUNTIME_BRIDGE_READY_FILE, 0)? {
            return Ok(());
        }
        if cancellation.should_cancel() {
            anyhow::bail!("Bridge readiness wait cancelled");
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("Private OpenClaw tunnel was not remotely ready after local capture");
        }
        sleep(Duration::from_millis(50)).await;
    }
}

/// Release the external one-flight gate for this exact nonce. Callers must
/// first reopen their in-process admission flag; the busy file is removed last
/// so a tap can never queue in the transition between busy and idle.
pub fn finish_selection_handshake(request: &SelectionRequest) -> Result<()> {
    finish_selection_handshake_at(
        request,
        RUNTIME_BUSY_FILE,
        SELECTION_PREPARE_ACK_FILE,
        SELECTION_CLOSE_ACK_FILE,
        0,
    )
}

fn finish_selection_handshake_at(
    request: &SelectionRequest,
    busy_file: &str,
    prepare_ack_file: &str,
    close_ack_file: &str,
    expected_uid: u32,
) -> Result<()> {
    let _ = std::fs::remove_file(prepare_ack_file);
    let _ = std::fs::remove_file(close_ack_file);
    let expected_payload = format!("{}\n", request.canonical_payload());
    if !consume_marker_if_exact(busy_file, expected_uid, &expected_payload)? {
        anyhow::bail!("Active selection busy marker is missing or does not match the completed nonce");
    }
    Ok(())
}

/// Consume all button markers as one admission decision. If concurrent
/// launchers somehow create more than one marker, deterministic priority plus
/// draining prevents a second request from being queued behind the first.
fn take_button_trigger(llm_trigger_file: &str, send_trigger_file: &str, draw_trigger_file: &str) -> Result<Option<ButtonTrigger>> {
    take_button_trigger_at_with_busy(
        llm_trigger_file,
        send_trigger_file,
        draw_trigger_file,
        RUNTIME_BUSY_FILE,
        0,
        current_time_ms()?,
    )
}

fn take_button_trigger_at(
    llm_trigger_file: &str,
    send_trigger_file: &str,
    draw_trigger_file: &str,
    expected_uid: u32,
    now_ms: u64,
) -> Result<Option<ButtonTrigger>> {
    take_button_trigger_at_with_busy(
        llm_trigger_file,
        send_trigger_file,
        draw_trigger_file,
        RUNTIME_BUSY_FILE,
        expected_uid,
        now_ms,
    )
}

fn take_button_trigger_at_with_busy(
    llm_trigger_file: &str,
    send_trigger_file: &str,
    draw_trigger_file: &str,
    busy_file: &str,
    expected_uid: u32,
    now_ms: u64,
) -> Result<Option<ButtonTrigger>> {
    // Evaluate all three before propagating an error so a malformed marker
    // cannot leave a lower-priority valid request queued for later.
    let llm = consume_marker_file(llm_trigger_file, expected_uid);
    let send = consume_marker_file(send_trigger_file, expected_uid);
    let draw = consume_marker_file(draw_trigger_file, expected_uid);
    let llm = llm?;
    let send = send?;
    let draw = draw?;

    if let Some(payload) = llm {
        parse_button_generation(TriggerSource::LlmButton, payload, busy_file, expected_uid, now_ms).map(Some)
    } else if let Some(payload) = send {
        parse_button_generation(TriggerSource::SendButton, payload, busy_file, expected_uid, now_ms).map(Some)
    } else if let Some(payload) = draw {
        if !payload.trim().is_empty() {
            anyhow::bail!("Legacy Draw trigger must be empty");
        }
        Ok(Some(ButtonTrigger {
            source: TriggerSource::DrawButton,
            selection_request: None,
        }))
    } else {
        Ok(None)
    }
}

fn parse_button_generation(
    source: TriggerSource,
    payload: String,
    busy_file: &str,
    expected_uid: u32,
    now_ms: u64,
) -> Result<ButtonTrigger> {
    match SelectionRequest::parse_at(&payload, now_ms) {
        Ok(selection_request) => Ok(ButtonTrigger {
            source,
            selection_request: Some(selection_request),
        }),
        Err(error) => {
            let matching_busy_released = consume_marker_if_exact(busy_file, expected_uid, &payload)?;
            Err(anyhow::Error::new(InvalidButtonGeneration {
                reason: error.to_string(),
                matching_busy_released,
            }))
        }
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
        if event_type == EvdevEventType::ABSOLUTE && (code == Self::ABS_X || code == Self::ABS_Y) {
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
        let held = !self.timestamp_regressed && event_time_ms.saturating_sub(self.stationary_since_ms) >= hold_ms;
        let outcome = PenGestureOutcome {
            release: if held { PenReleaseKind::Held } else { PenReleaseKind::Quick },
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
        if dx.saturating_mul(dx) + dy.saturating_mul(dy) > hold_radius_px.saturating_mul(hold_radius_px) {
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
        input_device: Option<Device>,          // For sending touch events
        event_stream: Option<EventStream>,     // For reading touch events
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
    last_selection_request: Option<SelectionRequest>,
    pen_hold_ms: u64,
    pen_hold_radius_px: i32,
    pen_min_extent_px: i32,
}

/// Owns the local admission marker for exactly as long as the trigger listener
/// future is alive. Tokio task completion, error, panic unwind, or abort drops
/// this guard before main can reopen admission.
pub struct TriggerReadinessGuard {
    path: std::path::PathBuf,
}

impl Drop for TriggerReadinessGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Non-exclusive observer for physical touch and pen activity during a short
/// stock-text insertion. It never uses EVIOCGRAB, so xochitl continues to
/// receive complete contacts. The keyboard checks it before every emitted
/// character and aborts the remaining response on the first physical event.
pub struct WriteBackInputMonitor {
    devices: Vec<(Device, bool)>,
}

impl WriteBackInputMonitor {
    const MAX_TOUCH_SLOTS: usize = 32;

    pub fn start() -> Result<Self> {
        if DeviceModel::detect() != DeviceModel::RemarkablePaperPro {
            anyhow::bail!("Guarded physical-input monitoring is pinned to reMarkable Paper Pro");
        }

        let mut monitor = Self { devices: Vec::new() };
        for (path, is_pen) in [("/dev/input/event3", false), ("/dev/input/event2", true)] {
            let device = Device::open(path)?;
            device.set_nonblocking(true)?;
            if Self::current_contact_active(&device, is_pen)? {
                anyhow::bail!("Physical input was already active before guarded typing");
            }
            monitor.devices.push((device, is_pen));
        }
        if monitor.interaction_detected()? {
            anyhow::bail!("Physical input was already active before guarded typing");
        }
        Ok(monitor)
    }

    pub fn interaction_detected(&mut self) -> Result<bool> {
        for (device, is_pen) in &mut self.devices {
            match device.fetch_events() {
                Ok(mut events) => {
                    if events.any(|event| Self::event_is_interaction(*is_pen, &event)) {
                        return Ok(true);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(false)
    }

    fn current_contact_active(device: &Device, is_pen: bool) -> Result<bool> {
        if is_pen {
            let keys = device.get_key_state()?;
            return Ok(
                keys.contains(KeyCode::BTN_TOUCH)
                    || keys.contains(KeyCode::BTN_STYLUS)
                    || keys.contains(KeyCode::BTN_STYLUS2),
            );
        }

        let slot_maximum = device
            .get_absinfo()?
            .find_map(|(axis, info)| (axis == AbsoluteAxisCode::ABS_MT_SLOT).then_some(info.maximum()))
            .ok_or_else(|| anyhow::anyhow!("Paper Pro touch device has no multitouch slot state"))?;
        let slot_count = usize::try_from(slot_maximum)
            .ok()
            .and_then(|maximum| maximum.checked_add(1))
            .filter(|count| (1..=Self::MAX_TOUCH_SLOTS).contains(count))
            .ok_or_else(|| anyhow::anyhow!("Paper Pro touch device reported an unsafe multitouch slot count"))?;
        let tracking_ids = Self::read_multitouch_tracking_ids(device, slot_count)?;
        Ok(Self::tracking_ids_contain_contact(&tracking_ids))
    }

    fn read_multitouch_tracking_ids(device: &Device, slot_count: usize) -> Result<Vec<i32>> {
        let byte_len = (slot_count + 1)
            .checked_mul(std::mem::size_of::<i32>())
            .ok_or_else(|| anyhow::anyhow!("Multitouch state query size overflowed"))?;
        let request = Self::linux_eviocgmtslots_request(byte_len)?;
        let mut query = vec![-1i32; slot_count + 1];
        query[0] = i32::from(AbsoluteAxisCode::ABS_MT_TRACKING_ID.0);
        // SAFETY: EVIOCGMTSLOTS reads exactly `byte_len` bytes into the
        // contiguous i32 buffer. The request encodes that same checked length,
        // and the evdev descriptor remains borrowed for the duration.
        let result = unsafe { libc::ioctl(device.as_raw_fd(), request, query.as_mut_ptr()) };
        if result < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(query.split_off(1))
    }

    fn linux_eviocgmtslots_request(byte_len: usize) -> Result<libc::c_ulong> {
        // Linux asm-generic _IOC(_IOC_READ, 'E', 0x0a, len). Paper Pro is
        // aarch64 and uses these bit positions. Reject lengths that do not fit
        // the kernel's 14-bit ioctl size field.
        const IOC_READ: libc::c_ulong = 2;
        const IOC_TYPE_SHIFT: u32 = 8;
        const IOC_SIZE_SHIFT: u32 = 16;
        const IOC_DIR_SHIFT: u32 = 30;
        const IOC_SIZE_MASK: usize = (1 << 14) - 1;
        if byte_len == 0 || byte_len > IOC_SIZE_MASK {
            anyhow::bail!("Multitouch state query length is outside the Linux ioctl bound");
        }
        Ok((IOC_READ << IOC_DIR_SHIFT)
            | (libc::c_ulong::from(b'E') << IOC_TYPE_SHIFT)
            | libc::c_ulong::from(0x0au8)
            | ((byte_len as libc::c_ulong) << IOC_SIZE_SHIFT))
    }

    fn tracking_ids_contain_contact(tracking_ids: &[i32]) -> bool {
        tracking_ids.iter().any(|tracking_id| *tracking_id >= 0)
    }

    fn event_is_interaction(is_pen: bool, event: &InputEvent) -> bool {
        if !is_pen {
            return event.event_type() != EvdevEventType::SYNCHRONIZATION;
        }
        event.event_type() == EvdevEventType::KEY && matches!(event.code(), 330..=332)
    }
}

impl Touch {
    pub fn new(no_touch: bool, trigger_corner: TriggerCorner) -> Self {
        Self::new_with_pen_hold(no_touch, trigger_corner, 800, 12, 24)
    }

    pub fn new_with_pen_hold(no_touch: bool, trigger_corner: TriggerCorner, pen_hold_ms: u64, pen_hold_radius_px: i32, pen_min_extent_px: i32) -> Self {
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
            let pen_stream = if device_model == DeviceModel::RemarkablePaperPro && matches!(trigger_corner, TriggerCorner::PenRelease | TriggerCorner::PenHold)
            {
                Some(Device::open("/dev/input/event2").unwrap().into_event_stream().unwrap())
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
            last_selection_request: None,
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
            last_selection_request: None,
            pen_hold_ms: 800,
            pen_hold_radius_px: 12,
            pen_min_extent_px: 24,
        })
    }

    /// Initialize the one long-lived trigger listener. This deliberately does
    /// not happen in `Touch::new`, because drawing callbacks construct helper
    /// Touch instances and must not erase a button press.
    pub fn clear_stale_trigger_state(&mut self) {
        let _ = std::fs::remove_file(LLM_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(SEND_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(DRAW_BUTTON_TRIGGER_FILE);
        let _ = std::fs::remove_file(SELECTION_PREPARE_ACK_FILE);
        let _ = std::fs::remove_file(SELECTION_CLOSE_ACK_FILE);
        let _ = std::fs::remove_file(RUNTIME_BUSY_FILE);
        let _ = std::fs::remove_file(RUNTIME_READY_FILE);
    }

    pub fn publish_trigger_readiness(&mut self) -> Result<TriggerReadinessGuard> {
        let runtime_dir = std::path::Path::new(RUNTIME_STATE_DIR);
        if !runtime_dir.is_dir() {
            return Ok(TriggerReadinessGuard {
                path: RUNTIME_READY_FILE.into(),
            });
        }
        if std::fs::symlink_metadata(RUNTIME_READY_FILE)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(anyhow::anyhow!("Refusing symlink runtime marker {}", RUNTIME_READY_FILE));
        }
        std::fs::write(RUNTIME_READY_FILE, [])?;
        Ok(TriggerReadinessGuard {
            path: RUNTIME_READY_FILE.into(),
        })
    }

    /// Which physical trigger caused the most recent `wait_for_trigger` to return `Ok`.
    /// Reset to `TriggerSource::Touch` at the start of every `wait_for_trigger` call.
    pub fn last_trigger_source(&self) -> TriggerSource {
        self.last_trigger_source
    }

    /// Stock selection geometry and content classification supplied by the
    /// most recent explicit selection-menu button.
    pub fn last_selection_request(&self) -> Option<SelectionRequest> {
        self.last_selection_request.clone()
    }

    pub async fn wait_for_trigger(&mut self, cancellation: &SmartRemarkableCancellation) -> Result<()> {
        let admission = AtomicBool::new(true);
        self.wait_for_trigger_admitted(cancellation, &admission).await
    }

    pub async fn wait_for_trigger_admitted(&mut self, cancellation: &SmartRemarkableCancellation, admission: &AtomicBool) -> Result<()> {
        debug!("wait_for_trigger: entered, checking mode");
        self.last_trigger_source = TriggerSource::default();
        self.last_selection_request = None;
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
                let activation = if matches!(trigger_corner, TriggerCorner::PenRelease | TriggerCorner::PenHold) {
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
                    Self::wait_for_real_trigger(event_stream, device_model, trigger_corner, cancellation, admission).await?
                };
                self.last_trigger_source = activation.source;
                self.last_selection_request = activation.selection_request;
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
    ) -> Result<TriggerActivation> {
        let events = pen_event_stream.as_mut().ok_or_else(|| anyhow::anyhow!("Pen event stream unavailable"))?;
        let mut tracker = PenGestureTracker::default();
        let mut raw_x: Option<i32> = None;
        let mut raw_y: Option<i32> = None;
        info!(
            "Waiting for {:?} native-lasso trigger (hold={}ms, radius={}px)",
            trigger_corner, pen_hold_ms, pen_hold_radius_px
        );

        loop {
            match take_button_trigger(LLM_BUTTON_TRIGGER_FILE, SEND_BUTTON_TRIGGER_FILE, DRAW_BUTTON_TRIGGER_FILE) {
                Ok(Some(trigger)) => {
                    if admission.load(Ordering::Acquire) {
                        return Ok(TriggerActivation {
                            source: trigger.source,
                            selection_request: trigger.selection_request,
                        });
                    }
                    info!("Ignoring button trigger while another request is active");
                }
                Ok(None) => {}
                Err(error)
                    if error
                        .downcast_ref::<InvalidButtonGeneration>()
                        .is_some_and(|generation| generation.matching_busy_released) =>
                {
                    info!("Rejected stale/invalid button generation and released its exact busy marker: {}", error);
                }
                Err(error) => return Err(error),
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
                        return Ok(TriggerActivation::without_descriptor(TriggerSource::PenLasso));
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
    ) -> Result<TriggerActivation> {
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

                match take_button_trigger(LLM_BUTTON_TRIGGER_FILE, SEND_BUTTON_TRIGGER_FILE, DRAW_BUTTON_TRIGGER_FILE) {
                    Ok(Some(trigger)) => {
                        if admission.load(Ordering::Acquire) {
                            debug!("Button trigger file detected: {:?}", trigger.source);
                            return Ok(TriggerActivation {
                                source: trigger.source,
                                selection_request: trigger.selection_request,
                            });
                        }
                        info!("Ignoring button trigger while another request is active");
                    }
                    Ok(None) => {}
                    Err(error)
                        if error
                            .downcast_ref::<InvalidButtonGeneration>()
                            .is_some_and(|generation| generation.matching_busy_released) =>
                    {
                        info!("Rejected stale/invalid button generation and released its exact busy marker: {}", error);
                    }
                    Err(error) => return Err(error),
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
                                                return Ok(TriggerActivation::without_descriptor(TriggerSource::Touch));
                                            }
                                            max_concurrent = 0;
                                        }
                                    } else if event.value() == -1 {
                                        let (x, y) = Self::input_to_virtual((position_x, position_y), device_model);
                                        debug!("Touch release detected at ({}, {}) normalized ({}, {})", position_x, position_y, x, y);
                                        if Self::is_in_trigger_zone(x, y, trigger_corner) {
                                            debug!("Touch release in target zone!");
                                            debug!("wait_for_real_trigger: returning Ok()");
                                            return Ok(TriggerActivation::without_descriptor(TriggerSource::Touch));
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

                let events = event_stream.as_mut().ok_or_else(|| anyhow::anyhow!("No touch event stream available"))?;

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
    const SIDEBAR_Y_PEN1: i32 = 80; // Mechanical pencil (pen slot 1)
    const SIDEBAR_Y_PEN2: i32 = 130; // Fineliner (pen slot 2) — used by smart_remarkable
    const SIDEBAR_Y_TEXT: i32 = 187; // Text tool
    const SIDEBAR_Y_ERASER: i32 = 240;
    const SIDEBAR_X: i32 = 28;

    /// Known sidebar tool y-centers for dynamic scanning.
    const SIDEBAR_TOOL_YS: &'static [i32] = &[Self::SIDEBAR_Y_PEN1, Self::SIDEBAR_Y_PEN2, Self::SIDEBAR_Y_TEXT, Self::SIDEBAR_Y_ERASER];

    /// Settings panel coordinates for the Fineliner pen (slot 2, y≈130).
    /// NOTE: Tapping a pen-type icon closes the settings panel — skip that tap.
    /// Only configure size and color; these taps keep the settings panel open.
    const SETTINGS_SIZE_THIN: (i32, i32) = (96, 385); // Thin stroke thickness
    const SETTINGS_SIZE_MEDIUM: (i32, i32) = (150, 385); // Medium stroke thickness
    const SETTINGS_COLOR_BLACK: (i32, i32) = (96, 468); // Black color (row 1, col 1)

    /// Detect whether the palette is currently open by scanning the screenshot.
    ///
    /// When the palette is OPEN, the left ~55px wide strip shows tool icons.
    /// We check whether there's substantial dark content in the sidebar region
    /// (pixel at x=28, y=80 is dark = pen1 icon or selected-background visible).
    /// When palette is CLOSED, only the toggle circle is visible; y=80 is white canvas.
    fn screenshot_palette_state(ss: &Screenshot) -> (bool, Option<i32>) {
        let Ok(image) = ss.grayscale_image() else {
            return (false, None);
        };
        let selected_y = Self::selected_tool_y_in(&image);
        // Require a repeated stock-tool signature, not one dark canvas pixel:
        // at least three known icon rows plus the selected-tool side band.
        let icon_rows = Self::SIDEBAR_TOOL_YS
            .iter()
            .filter(|&&center_y| {
                ((center_y - 12).max(0) as u32..=(center_y + 12) as u32).any(|y| {
                    (16u32..=42).any(|x| image.get_pixel(x, y).0[0] < 180)
                })
            })
            .count();
        (icon_rows >= 3 && selected_y.is_some(), selected_y)
    }

    fn screenshot_palette_open(ss: &Screenshot) -> bool {
        Self::screenshot_palette_state(ss).0
    }

    /// Scan the open palette sidebar and return the y-center of the currently selected tool.
    ///
    /// When the palette is open, the selected tool has a dark (inverted) background
    /// spanning its full ~45px tall icon area. We scan x=5 (just inside the sidebar)
    /// to find the largest contiguous dark band.
    fn screenshot_selected_tool_y(ss: &Screenshot) -> Option<i32> {
        let image = ss.grayscale_image().ok()?;
        Self::selected_tool_y_in(&image)
    }

    fn selected_tool_y_in(image: &image::GrayImage) -> Option<i32> {
        // Scan x=5, y=50..500 for dark pixels; find the longest contiguous run.
        let scan_x = 5u32;
        let mut best_run_start = 0i32;
        let mut best_run_len = 0usize;
        let mut cur_run_start = 0i32;
        let mut cur_run_len = 0usize;

        for y in 50u32..500 {
            let dark = image.get_pixel(scan_x, y).0[0] < 100;
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
        self.read_tool_state_with_orientation(None).await
    }

    fn take_tool_screenshot(orientation: Option<SelectionOrientation>) -> Result<Screenshot> {
        let mut screenshot = Screenshot::new()?;
        if let Some(orientation) = orientation {
            screenshot.take_screenshot_with_orientation(orientation)?;
        } else {
            screenshot.take_screenshot()?;
        }
        Ok(screenshot)
    }

    async fn read_tool_state_with_orientation(&self, orientation: Option<SelectionOrientation>) -> (bool, PenTool) {
        let ss = match Self::take_tool_screenshot(orientation) {
            Ok(screenshot) => screenshot,
            Err(_) => return (false, PenTool::Unknown),
        };
        let (palette_open, selected_y) = Self::screenshot_palette_state(&ss);
        let tool = if palette_open {
            selected_y.map(Self::y_to_pen_tool).unwrap_or(PenTool::Unknown)
        } else {
            PenTool::Unknown
        };
        info!("read_tool_state: palette_open={} → {:?}", palette_open, tool);
        (palette_open, tool)
    }

    /// Select and visually verify the text tool, then close and verify the
    /// palette before any page-placement tap. Ordinary ink cannot count as
    /// success because the screenshot must contain the repeated stock palette
    /// signature and selected band centered on the firmware-pinned Text row.
    pub async fn select_text_tool(&mut self) -> Result<()> {
        self.select_text_tool_with_orientation(None).await
    }

    async fn ensure_palette_closed_with_orientation(
        &mut self,
        orientation: Option<SelectionOrientation>,
    ) -> Result<()> {
        let before = Self::take_tool_screenshot(orientation)?;
        if !Self::screenshot_palette_open(&before) {
            return Ok(());
        }

        // Inspect before mutating: never blindly toggle when the attempted
        // open may itself have failed. Whatever the tap reports, trust only a
        // fresh verified closed screenshot as successful restoration.
        let tap_result = self.tap(Self::PALETTE_BUTTON).await;
        let after = Self::take_tool_screenshot(orientation)?;
        if Self::screenshot_palette_open(&after) {
            if let Err(error) = tap_result {
                return Err(error);
            }
            anyhow::bail!("Text-tool palette remained open after cleanup");
        }
        Ok(())
    }

    async fn text_tool_failure_after_cleanup(
        &mut self,
        orientation: Option<SelectionOrientation>,
        error: anyhow::Error,
    ) -> anyhow::Error {
        match self.ensure_palette_closed_with_orientation(orientation).await {
            Ok(()) => error,
            Err(cleanup_error) => anyhow::anyhow!(
                "{}; palette cleanup could not be verified: {}",
                error,
                cleanup_error
            ),
        }
    }

    pub async fn select_text_tool_with_orientation(&mut self, orientation: Option<SelectionOrientation>) -> Result<()> {
        let initial = Self::take_tool_screenshot(orientation)?;
        let (palette_open, _) = Self::screenshot_palette_state(&initial);
        if !palette_open {
            if let Err(error) = self.tap(Self::PALETTE_BUTTON).await {
                return Err(self.text_tool_failure_after_cleanup(orientation, error).await);
            }
            sleep(Duration::from_millis(100)).await;
            let opened = match Self::take_tool_screenshot(orientation) {
                Ok(screenshot) => screenshot,
                Err(error) => {
                    return Err(self.text_tool_failure_after_cleanup(orientation, error).await);
                }
            };
            if !Self::screenshot_palette_open(&opened) {
                let error = anyhow::anyhow!("Text-tool palette did not open with the expected stock signature");
                return Err(self.text_tool_failure_after_cleanup(orientation, error).await);
            }
        }

        let selected = match self.tap((Self::SIDEBAR_X, Self::SIDEBAR_Y_TEXT)).await {
            Ok(()) => Self::take_tool_screenshot(orientation),
            Err(error) => Err(error),
        };
        let selected = match selected {
            Ok(screenshot) => screenshot,
            Err(error) => {
                return Err(self.text_tool_failure_after_cleanup(orientation, error).await);
            }
        };
        self.ensure_palette_closed_with_orientation(orientation).await?;
        let (palette_open, selected_y) = Self::screenshot_palette_state(&selected);
        if !palette_open || !selected_y.is_some_and(|y| (y - Self::SIDEBAR_Y_TEXT).abs() < 25)
        {
            anyhow::bail!("Text tool was not visibly selected");
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
            TriggerCorner::FourFinger => false,                          // handled by slot counting, not position
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
        finish_selection_handshake_at, take_button_trigger_at, take_button_trigger_at_with_busy, InvalidButtonGeneration, PenGestureOutcome,
        PenGestureTracker, PenReleaseKind, SelectionDescriptor, SelectionOrientation, SelectionRequest, Touch, TriggerCorner, TriggerSource,
        TriggerReadinessGuard, WriteBackInputMonitor,
    };
    use crate::llm_engine::SelectionKind;
    use crate::screenshot::Screenshot;
    use evdev::{EventType, InputEvent};
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    const NOW_MS: u64 = 1_800_000_000_000;
    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn trigger_paths(name: &str) -> (PathBuf, PathBuf, PathBuf, u32) {
        let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("smart-remarkable-{name}-{}-{counter}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let uid = std::fs::metadata(&dir).unwrap().uid();
        (dir.join("llm"), dir.join("send"), dir.join("draw"), uid)
    }

    fn write_marker(path: &Path, payload: &str) {
        std::fs::write(path, payload).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn palette_screenshot(selected_y: Option<i32>, extra_ink: bool) -> Screenshot {
        let mut image = RgbaImage::from_pixel(768, 1024, Rgba([255, 255, 255, 255]));
        for center_y in [Touch::SIDEBAR_Y_PEN1, Touch::SIDEBAR_Y_PEN2, Touch::SIDEBAR_Y_TEXT, Touch::SIDEBAR_Y_ERASER] {
            for y in center_y - 3..=center_y + 3 {
                for x in 20..=34 {
                    image.put_pixel(x, y as u32, Rgba([0, 0, 0, 255]));
                }
            }
        }
        if let Some(center_y) = selected_y {
            for y in center_y - 18..=center_y + 18 {
                image.put_pixel(5, y as u32, Rgba([0, 0, 0, 255]));
            }
        }
        if extra_ink {
            for y in 60..=110 {
                image.put_pixel(28, y, Rgba([0, 0, 0, 255]));
            }
        }
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        Screenshot::from_png_data(encoded.into_inner())
    }

    fn valid_descriptor(kind: &str) -> String {
        format!("v2,{},{},normal,100000,200000,500000,600000,{}\n", "a".repeat(64), kind, NOW_MS - 10)
    }

    fn cleanup_trigger_dir(path: &Path) {
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn pen_lasso(hold_for_ms: u64, admission_ready: bool, last_move: (i32, i32)) -> PenGestureOutcome {
        let mut tracker = PenGestureTracker::default();
        tracker.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        tracker.observe(EventType::KEY, 330, 1, 10, admission_ready, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 0, 220, 100, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, 220, 100, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 0, last_move.0, 200, true, 800, 12);
        tracker.observe(EventType::ABSOLUTE, 1, last_move.1, 200, true, 800, 12);
        tracker.observe(EventType::KEY, 330, 0, 200 + hold_for_ms, true, 800, 12).unwrap()
    }

    #[test]
    fn button_trigger_is_consumed_without_waiting_for_touch_idle() {
        let (llm, send, draw, uid) = trigger_paths("trigger");
        write_marker(&llm, &valid_descriptor("ink"));

        let trigger = take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS)
            .unwrap()
            .unwrap();
        assert_eq!(trigger.source, TriggerSource::LlmButton);
        let request = trigger.selection_request.unwrap();
        let descriptor = request.descriptor().unwrap();
        assert_eq!(descriptor.kind, SelectionKind::Ink);
        assert_eq!(descriptor.orientation, SelectionOrientation::Normal);
        assert_eq!(descriptor.nonce, "a".repeat(64));
        assert_eq!(descriptor.rect, super::Rect { x: 76, y: 204, w: 308, h: 411 });
        assert!(!llm.exists());
        assert!(
            take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS,)
                .unwrap()
                .is_none()
        );
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn palette_detection_requires_repeated_stock_signature_not_ordinary_ink() {
        let false_open = palette_screenshot(None, true);
        assert!(!Touch::screenshot_palette_open(&false_open));

        let text_selected = palette_screenshot(Some(Touch::SIDEBAR_Y_TEXT), false);
        assert!(Touch::screenshot_palette_open(&text_selected));
        assert!(
            Touch::screenshot_selected_tool_y(&text_selected)
                .is_some_and(|y| (y - Touch::SIDEBAR_Y_TEXT).abs() < 25)
        );

        let pen_selected = palette_screenshot(Some(Touch::SIDEBAR_Y_PEN2), false);
        assert!(Touch::screenshot_palette_open(&pen_selected));
        assert!(
            !Touch::screenshot_selected_tool_y(&pen_selected)
                .is_some_and(|y| (y - Touch::SIDEBAR_Y_TEXT).abs() < 25)
        );
    }

    #[test]
    fn write_back_monitor_ignores_pen_hover_but_detects_contacts() {
        assert!(!WriteBackInputMonitor::event_is_interaction(
            true,
            &InputEvent::new(EventType::ABSOLUTE.0, 0, 123),
        ));
        assert!(!WriteBackInputMonitor::event_is_interaction(
            true,
            &InputEvent::new(EventType::SYNCHRONIZATION.0, 0, 0),
        ));
        assert!(WriteBackInputMonitor::event_is_interaction(
            true,
            &InputEvent::new(EventType::KEY.0, 330, 1),
        ));
        assert!(WriteBackInputMonitor::event_is_interaction(
            false,
            &InputEvent::new(EventType::ABSOLUTE.0, 47, 1),
        ));
        assert!(!WriteBackInputMonitor::tracking_ids_contain_contact(&[-1, -1]));
        assert!(WriteBackInputMonitor::tracking_ids_contain_contact(&[-1, 7]));
        assert_eq!(
            WriteBackInputMonitor::linux_eviocgmtslots_request(12).unwrap(),
            0x800c_450a
        );
    }

    #[test]
    fn trigger_readiness_is_removed_when_listener_owner_drops() {
        let (ready, _, _, _) = trigger_paths("ready-guard");
        write_marker(&ready, "");
        {
            let _guard = TriggerReadinessGuard {
                path: ready.clone(),
            };
            assert!(ready.exists());
        }
        assert!(!ready.exists());
        cleanup_trigger_dir(&ready);
    }

    #[test]
    fn simultaneous_button_markers_are_drained_as_one_request() {
        let (llm, send, draw, uid) = trigger_paths("multi-trigger");
        write_marker(&llm, &valid_descriptor("mixed"));
        write_marker(&send, &valid_descriptor("image"));
        write_marker(&draw, "");

        let trigger = take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS)
            .unwrap()
            .unwrap();
        assert_eq!(trigger.source, TriggerSource::LlmButton);
        assert_eq!(trigger.selection_request.unwrap().descriptor().unwrap().kind, SelectionKind::Mixed);
        assert!(!llm.exists());
        assert!(!send.exists());
        assert!(!draw.exists());
        assert!(
            take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS,)
                .unwrap()
                .is_none()
        );
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn send_button_marker_selects_whatsapp_only_source() {
        let (llm, send, draw, uid) = trigger_paths("send-trigger");
        write_marker(&send, &valid_descriptor("image"));

        let trigger = take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS)
            .unwrap()
            .unwrap();
        assert_eq!(trigger.source, TriggerSource::SendButton);
        assert_eq!(trigger.selection_request.unwrap().descriptor().unwrap().kind, SelectionKind::Image);
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn installed_qmd_legacy_generation_remains_distinct_from_v2() {
        let (llm, send, draw, uid) = trigger_paths("legacy-trigger");
        let payload = format!("legacy-v1,{},{}\n", "c".repeat(64), NOW_MS - 10);
        write_marker(&llm, &payload);

        let trigger = take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS)
            .unwrap()
            .unwrap();
        let request = trigger.selection_request.unwrap();
        assert_eq!(trigger.source, TriggerSource::LlmButton);
        assert!(matches!(request, SelectionRequest::Legacy { .. }));
        assert!(request.descriptor().is_none());
        assert_eq!(request.canonical_payload(), payload.trim_end());
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn malformed_explicit_descriptor_is_consumed_without_fallback() {
        let (llm, send, draw, uid) = trigger_paths("malformed");
        write_marker(
            &llm,
            &format!("v2,{},unknown,normal,100000,200000,500000,600000,1799999999990\n", "a".repeat(64)),
        );

        assert!(take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS,).is_err());
        assert!(!llm.exists());
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn stale_trigger_releases_only_its_matching_busy_generation_and_next_tap_is_admitted() {
        let (llm, send, draw, uid) = trigger_paths("stale-busy");
        let busy = llm.parent().unwrap().join("busy");
        let stale = format!("v2,{},ink,normal,100000,200000,500000,600000,{}\n", "a".repeat(64), NOW_MS - 40_001);
        write_marker(&llm, &stale);
        write_marker(&busy, &stale);

        let error = take_button_trigger_at_with_busy(
            llm.to_str().unwrap(),
            send.to_str().unwrap(),
            draw.to_str().unwrap(),
            busy.to_str().unwrap(),
            uid,
            NOW_MS,
        )
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<InvalidButtonGeneration>()
                .is_some_and(|generation| generation.matching_busy_released)
        );
        assert!(!busy.exists());

        let valid = valid_descriptor("ink");
        write_marker(&llm, &valid);
        write_marker(&busy, &valid);
        let trigger = take_button_trigger_at_with_busy(
            llm.to_str().unwrap(),
            send.to_str().unwrap(),
            draw.to_str().unwrap(),
            busy.to_str().unwrap(),
            uid,
            NOW_MS,
        )
        .unwrap()
        .unwrap();
        assert_eq!(trigger.source, TriggerSource::LlmButton);
        assert!(busy.exists(), "valid generation remains busy until processing finishes");
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn invalid_trigger_preserves_a_mismatched_busy_generation_and_fails_closed() {
        let (llm, send, draw, uid) = trigger_paths("mismatched-busy");
        let busy = llm.parent().unwrap().join("busy");
        let stale = format!("v2,{},ink,normal,100000,200000,500000,600000,{}\n", "a".repeat(64), NOW_MS - 40_001);
        let other = valid_descriptor("mixed");
        write_marker(&llm, &stale);
        write_marker(&busy, &other);

        let error = take_button_trigger_at_with_busy(
            llm.to_str().unwrap(),
            send.to_str().unwrap(),
            draw.to_str().unwrap(),
            busy.to_str().unwrap(),
            uid,
            NOW_MS,
        )
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<InvalidButtonGeneration>()
                .is_some_and(|generation| !generation.matching_busy_released)
        );
        assert_eq!(std::fs::read_to_string(&busy).unwrap(), other);
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn completion_unlinks_only_the_exact_busy_generation() {
        let (llm, _send, _draw, uid) = trigger_paths("finish-busy");
        let busy = llm.parent().unwrap().join("busy");
        let prepare = llm.parent().unwrap().join("prepare");
        let close = llm.parent().unwrap().join("close");
        let request = SelectionRequest::parse_at(&valid_descriptor("ink"), NOW_MS).unwrap();
        let different = valid_descriptor("mixed");
        write_marker(&busy, &different);
        write_marker(&prepare, "ack");
        write_marker(&close, "ack");

        assert!(finish_selection_handshake_at(
            &request,
            busy.to_str().unwrap(),
            prepare.to_str().unwrap(),
            close.to_str().unwrap(),
            uid,
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&busy).unwrap(), different);
        assert!(!prepare.exists());
        assert!(!close.exists());

        write_marker(&llm, &request.canonical_payload());
        let exact = format!("{}\n", request.canonical_payload());
        std::fs::remove_file(&busy).unwrap();
        write_marker(&busy, &exact);
        assert!(finish_selection_handshake_at(
            &request,
            busy.to_str().unwrap(),
            prepare.to_str().unwrap(),
            close.to_str().unwrap(),
            uid,
        )
        .is_ok());
        assert!(!busy.exists());
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn stale_and_out_of_bounds_descriptors_fail_closed() {
        assert!(SelectionDescriptor::parse_at(&format!("v2,{},ink,normal,100000,200000,500000,600000,1799999959999\n", "a".repeat(64)), NOW_MS,).is_err());
        assert!(SelectionDescriptor::parse_at(
            &format!("v2,{},image,normal,100000,200000,1000001,600000,1799999999990\n", "a".repeat(64)),
            NOW_MS,
        )
        .is_err());
        assert!(SelectionDescriptor::parse_at(
            &format!("v2,{},mixed,normal,100000,200000,100000,600000,1799999999990\n", "a".repeat(64)),
            NOW_MS,
        )
        .is_err());
    }

    #[test]
    fn nonce_orientation_freshness_and_ack_are_bound_together() {
        let descriptor = SelectionDescriptor::parse_at(
            &format!("v2,{},mixed,rot180,100000,200000,500000,600000,{}\n", "b".repeat(64), NOW_MS - 40_000),
            NOW_MS,
        )
        .unwrap();
        assert_eq!(descriptor.orientation, SelectionOrientation::Rotated180);
        assert!(descriptor
            .validate_acknowledgement(&format!("v2,{},mixed,rot180,100000,200000,500000,600000\n", "b".repeat(64)))
            .is_ok());
        assert!(descriptor
            .validate_acknowledgement(&format!("v2,{},mixed,normal,100000,200000,500000,600000\n", "b".repeat(64)))
            .is_err());
        assert!(SelectionDescriptor::parse_at(
            &format!("v2,{},mixed,rot180,100000,200000,500000,600000,{}\n", "b".repeat(64), NOW_MS - 40_001),
            NOW_MS,
        )
        .is_err());
        assert!(SelectionDescriptor::parse_at(
            &format!("v2,{},mixed,rot180,100000,200000,500000,600000,{}\n", "B".repeat(64), NOW_MS - 1),
            NOW_MS,
        )
        .is_err());
    }

    #[test]
    fn marker_permissions_are_owner_only() {
        let (llm, send, draw, uid) = trigger_paths("permissions");
        write_marker(&llm, &valid_descriptor("ink"));
        std::fs::set_permissions(&llm, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(take_button_trigger_at(llm.to_str().unwrap(), send.to_str().unwrap(), draw.to_str().unwrap(), uid, NOW_MS,).is_err());
        assert!(llm.exists());
        std::fs::remove_file(&llm).unwrap();
        cleanup_trigger_dir(&llm);
    }

    #[test]
    fn pen_release_requires_a_real_contact_first() {
        let mut tracker = PenGestureTracker::default();
        assert_eq!(tracker.observe(EventType::KEY, 330, 0, 0, true, 800, 12), None);
        assert_eq!(tracker.observe(EventType::ABSOLUTE, 0, 10, 1, true, 800, 12), None);
    }

    #[test]
    fn hold_requires_the_full_dwell_and_preserves_admission_at_down() {
        assert_eq!(pen_lasso(799, true, (100, 100)).release, PenReleaseKind::Quick);
        assert_eq!(pen_lasso(800, true, (100, 100)).release, PenReleaseKind::Held);
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
        let held = tracker.observe(EventType::KEY, 330, 0, 900, true, 800, 12).unwrap();
        assert_eq!(held.release, PenReleaseKind::Held);

        let mut moved = PenGestureTracker::default();
        moved.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        moved.observe(EventType::KEY, 330, 1, 10, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 0, 200, 100, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 1, 200, 100, true, 800, 12);
        moved.observe(EventType::ABSOLUTE, 0, 225, 500, true, 800, 12);
        let quick = moved.observe(EventType::KEY, 330, 0, 900, true, 800, 12).unwrap();
        assert_eq!(quick.release, PenReleaseKind::Quick);
    }

    #[test]
    fn tiny_contact_and_timestamp_regression_fail_closed() {
        let mut tiny = PenGestureTracker::default();
        tiny.observe(EventType::ABSOLUTE, 0, 100, 0, true, 800, 12);
        tiny.observe(EventType::ABSOLUTE, 1, 100, 0, true, 800, 12);
        tiny.observe(EventType::KEY, 330, 1, 10, true, 800, 12);
        tiny.observe(EventType::ABSOLUTE, 0, 105, 20, true, 800, 12);
        let tiny_outcome = tiny.observe(EventType::KEY, 330, 0, 1000, true, 800, 12).unwrap();
        assert!(tiny_outcome.extent_px < 24);

        let mut regressed = PenGestureTracker::default();
        regressed.observe(EventType::ABSOLUTE, 0, 100, 100, true, 800, 12);
        regressed.observe(EventType::ABSOLUTE, 1, 100, 100, true, 800, 12);
        regressed.observe(EventType::KEY, 330, 1, 100, true, 800, 12);
        regressed.observe(EventType::ABSOLUTE, 0, 200, 50, true, 800, 12);
        let outcome = regressed.observe(EventType::KEY, 330, 0, 1000, true, 800, 12).unwrap();
        assert_eq!(outcome.release, PenReleaseKind::Quick);
    }

    #[test]
    fn pen_release_trigger_aliases_parse() {
        assert_eq!(TriggerCorner::from_string("pen-release").unwrap(), TriggerCorner::PenRelease);
        assert_eq!(TriggerCorner::from_string("lasso").unwrap(), TriggerCorner::PenRelease);
        assert_eq!(TriggerCorner::from_string("pen-hold").unwrap(), TriggerCorner::PenHold);
    }
}
