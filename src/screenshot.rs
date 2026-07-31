use anyhow::Result;
use image::GrayImage;
use log::{debug, info};
use std::fs::File;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
use std::process;

use base64::{engine::general_purpose, Engine as _};
use image::{GenericImageView, ImageEncoder};

use crate::device::DeviceModel;
use crate::simulation::{ScreenshotSimulator, SimulationConfig};

const VIRTUAL_WIDTH: u32 = 768;
const VIRTUAL_HEIGHT: u32 = 1024;
const RM2_LANDSCAPE_WIDTH: u32 = 1872;
const RM2_LANDSCAPE_HEIGHT: u32 = 1404;
const RM2_PORTRAIT_WIDTH: u32 = 1404;
const RM2_PORTRAIT_HEIGHT: u32 = 1872;
const RMPP_WIDTH: u32 = 1632;
const RMPP_HEIGHT: u32 = 2154;
const RMPP_FRAME_CHAIN_MAX_HOPS: usize = 64;
const RMPP_PAGE_BYTES: u64 = 4096;
const RMPP_TERMINAL_ADVANCE_BYTES: u64 = 0x00d73000;
const RMPP_TERMINAL_HEADER_LENGTH: u64 = RMPP_TERMINAL_ADVANCE_BYTES + 2;
const FRAMEBUFFER_PROBE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RawFramebufferFormat {
    Rm2Rgb565,
    Rm2Bgra32,
    RmppRgba8,
}

#[derive(Clone, Copy, Debug)]
struct ProcMapEntry {
    start: u64,
    end: u64,
    readable: bool,
    is_card0: bool,
    is_anonymous: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RmppFramebufferCandidate {
    base: u64,
    readable_end: u64,
}

pub enum ScreenshotMode {
    Real { data: Vec<u8>, device_model: DeviceModel },
    Simulated { simulator: ScreenshotSimulator },
}

pub struct Screenshot {
    mode: ScreenshotMode,
}

/// Decoded, orientation-normalized framebuffer bytes retained only in memory.
/// Delayed write-back uses this instead of a page identifier because stock
/// xochitl does not expose a stable document/page identity to this process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedView {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl NormalizedView {
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn fingerprint(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.width.hash(&mut hasher);
        self.height.hash(&mut hasher);
        self.rgba.hash(&mut hasher);
        hasher.finish()
    }

    #[cfg(test)]
    pub(crate) fn from_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Self {
        Self {
            width,
            height,
            rgba,
        }
    }

    /// Compare two normalized views while allowing only firmware-pinned UI
    /// chrome and the small text-cursor target to change. At least
    /// `minimum_required_changes` pixels must change inside `required`.
    pub fn changed_pixels_are_confined(
        &self,
        current: &Self,
        allowed: &[crate::touch::Rect],
        required: crate::touch::Rect,
        minimum_required_changes: usize,
    ) -> bool {
        self.compare_changed_pixels(current, allowed, Some((required, minimum_required_changes)))
    }

    pub fn changed_pixels_are_within(&self, current: &Self, allowed: &[crate::touch::Rect]) -> bool {
        self.compare_changed_pixels(current, allowed, None)
    }

    fn compare_changed_pixels(
        &self,
        current: &Self,
        allowed: &[crate::touch::Rect],
        required: Option<(crate::touch::Rect, usize)>,
    ) -> bool {
        if self.width != current.width
            || self.height != current.height
            || self.rgba.len() != current.rgba.len()
            || self.rgba.len() != self.width as usize * self.height as usize * 4
        {
            return false;
        }

        let valid_rect = |rect: crate::touch::Rect| {
            rect.x >= 0
                && rect.y >= 0
                && rect.w > 0
                && rect.h > 0
                && rect.x.checked_add(rect.w).is_some_and(|right| right <= self.width as i32)
                && rect.y.checked_add(rect.h).is_some_and(|bottom| bottom <= self.height as i32)
        };
        if allowed.is_empty()
            || allowed.iter().copied().any(|rect| !valid_rect(rect))
            || required.is_some_and(|(rect, minimum)| minimum == 0 || !valid_rect(rect))
        {
            return false;
        }

        let contains = |rect: crate::touch::Rect, x: i32, y: i32| {
            x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
        };
        if let Some((required_rect, _)) = required {
            let overlaps = |left: crate::touch::Rect, right: crate::touch::Rect| {
                left.x < right.x + right.w
                    && left.x + left.w > right.x
                    && left.y < right.y + right.h
                    && left.y + left.h > right.y
            };
            if allowed
                .iter()
                .copied()
                .filter(|rect| *rect != required_rect)
                .any(|rect| overlaps(rect, required_rect))
            {
                return false;
            }
        }
        let mut required_changes = 0usize;
        for (pixel_index, (before, after)) in self.rgba.chunks_exact(4).zip(current.rgba.chunks_exact(4)).enumerate() {
            if before == after {
                continue;
            }
            let x = (pixel_index as u32 % self.width) as i32;
            let y = (pixel_index as u32 / self.width) as i32;
            if !allowed.iter().copied().any(|rect| contains(rect, x, y)) {
                return false;
            }
            if required.is_some_and(|(rect, _)| contains(rect, x, y)) {
                required_changes = required_changes.saturating_add(1);
            }
        }
        required.map(|(_, minimum)| required_changes >= minimum).unwrap_or(true)
    }

    pub fn has_vertical_change_run(&self, current: &Self, region: crate::touch::Rect, minimum_run: usize) -> bool {
        let Some(region_right) = region.x.checked_add(region.w) else {
            return false;
        };
        let Some(region_bottom) = region.y.checked_add(region.h) else {
            return false;
        };
        if self.width != current.width
            || self.height != current.height
            || self.rgba.len() != current.rgba.len()
            || minimum_run == 0
            || region.x < 0
            || region.y < 0
            || region.w <= 0
            || region.h <= 0
            || region_right > self.width as i32
            || region_bottom > self.height as i32
        {
            return false;
        }
        for x in region.x..region_right {
            let mut run = 0usize;
            for y in region.y..region_bottom {
                let index = ((y as u32 * self.width + x as u32) * 4) as usize;
                if self.rgba[index..index + 4] != current.rgba[index..index + 4] {
                    run += 1;
                    if run >= minimum_run {
                        return true;
                    }
                } else {
                    run = 0;
                }
            }
        }
        false
    }
}

impl Screenshot {
    pub fn new() -> Result<Screenshot> {
        let device_model = DeviceModel::detect();
        info!("Screen detected device: {}", device_model.name());
        Ok(Screenshot {
            mode: ScreenshotMode::Real { data: vec![], device_model },
        })
    }

    pub fn new_simulated(simulation_config: SimulationConfig) -> Result<Screenshot> {
        let simulator = ScreenshotSimulator::new(simulation_config)?;
        info!("Screen using simulation mode");
        Ok(Screenshot {
            mode: ScreenshotMode::Simulated { simulator },
        })
    }

    fn screen_width(&self) -> u32 {
        let device_model = match &self.mode {
            ScreenshotMode::Real { device_model, .. } => device_model,
            ScreenshotMode::Simulated { .. } => &DeviceModel::Unknown, // Default for simulation
        };
        match device_model {
            DeviceModel::Remarkable2 => RM2_LANDSCAPE_WIDTH,
            DeviceModel::RemarkablePaperPro => RMPP_WIDTH,
            DeviceModel::Unknown => RM2_LANDSCAPE_WIDTH, // Default to RM2
        }
    }

    fn screen_height(&self) -> u32 {
        let device_model = match &self.mode {
            ScreenshotMode::Real { device_model, .. } => device_model,
            ScreenshotMode::Simulated { .. } => &DeviceModel::Unknown, // Default for simulation
        };
        match device_model {
            DeviceModel::Remarkable2 => RM2_LANDSCAPE_HEIGHT,
            DeviceModel::RemarkablePaperPro => RMPP_HEIGHT,
            DeviceModel::Unknown => RM2_LANDSCAPE_HEIGHT, // Default to RM2
        }
    }

    pub fn bytes_per_pixel(&self) -> usize {
        let device_model = match &self.mode {
            ScreenshotMode::Real { device_model, .. } => device_model,
            ScreenshotMode::Simulated { .. } => &DeviceModel::Unknown, // Default for simulation
        };
        match device_model {
            DeviceModel::Remarkable2 => Self::detect_rm2_bytes_per_pixel(),
            DeviceModel::RemarkablePaperPro => 4,
            DeviceModel::Unknown => 2, // Default to RM2
        }
    }

    // Returns (major, minor) firmware version from /etc/os-release IMG_VERSION field.
    fn detect_rm2_firmware_version() -> (u32, u32) {
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if line.starts_with("IMG_VERSION=") {
                    let value = line.trim_start_matches("IMG_VERSION=").trim_matches('"');
                    let parts: Vec<&str> = value.split('.').collect();
                    if parts.len() >= 2 {
                        let major = parts[0].parse::<u32>().unwrap_or(0);
                        let minor = parts[1].parse::<u32>().unwrap_or(0);
                        debug!("RM2 firmware version: {}.{}", major, minor);
                        return (major, minor);
                    }
                }
            }
        }
        (0, 0)
    }

    // Firmware 3.24+ changed RM2 framebuffer from 16-bit (2 bpp) to 32-bit BGRA (4 bpp).
    fn detect_rm2_bytes_per_pixel() -> usize {
        let (major, minor) = Self::detect_rm2_firmware_version();
        if major > 3 || (major == 3 && minor >= 24) {
            4
        } else {
            2
        }
    }

    // Memory offset within the post-fb0 mapping where the current framebuffer data starts.
    // Reference: goMarkableStream internal/remarkable/detect.go
    fn detect_rm2_pointer_offset() -> u64 {
        let (major, minor) = Self::detect_rm2_firmware_version();
        if major > 3 || (major == 3 && minor >= 24) {
            2629632
        } else {
            0
        }
    }

    pub fn take_screenshot(&mut self) -> Result<()> {
        self.take_screenshot_oriented(None)
    }

    /// Capture in the stable logical orientation declared by stock QML. This
    /// is used only for explicit native selections; legacy/full-screen paths
    /// retain the toolbar heuristic through `take_screenshot`.
    pub fn take_screenshot_with_orientation(&mut self, orientation: crate::touch::SelectionOrientation) -> Result<()> {
        self.take_screenshot_oriented(Some(orientation))
    }

    fn take_screenshot_oriented(&mut self, orientation: Option<crate::touch::SelectionOrientation>) -> Result<()> {
        if let ScreenshotMode::Simulated { simulator } = &mut self.mode {
            // In simulation mode, just advance to next image
            simulator.advance_to_next_image();
            debug!("Simulated screenshot taken (advanced to next test image)");
            return Ok(());
        }

        // For real mode, handle separately to avoid borrowing issues
        // Find xochitl's process
        debug!("screenshot: finding pid");
        let pid = Self::find_xochitl_pid()?;

        // Find framebuffer location in memory
        debug!("screenshot: finding address");
        let skip_bytes = self.find_framebuffer_address(&pid)?;

        // Read the framebuffer data
        debug!("screenshot: reading data");
        let screenshot_data = self.read_framebuffer(&pid, skip_bytes)?;

        // Process the image data (transpose, color correction, etc.)
        debug!("screenshot: processing image");
        let processed_data = self.process_image(screenshot_data, orientation)?;

        // Update the data
        if let ScreenshotMode::Real { data, .. } = &mut self.mode {
            *data = processed_data;
        }

        Ok(())
    }

    fn find_xochitl_pid() -> Result<String> {
        let output = process::Command::new("pidof").arg("xochitl").output()?;
        let pids = String::from_utf8(output.stdout)?;
        if let Some(pid) = pids.split_whitespace().next() {
            return Ok(pid.to_string());
            // let has_fb = process::Command::new("grep")
            //     .args(&["-C1", "/dev/fb0", &format!("/proc/{}/maps", pid)])
            //     .output()?;
            // if !has_fb.stdout.is_empty() {
            //     return Ok(pid.to_string());
            // }
        }
        anyhow::bail!("No xochitl process found")
    }

    fn find_framebuffer_address(&self, pid: &str) -> Result<u64> {
        let device_model = match &self.mode {
            ScreenshotMode::Real { device_model, .. } => device_model,
            ScreenshotMode::Simulated { .. } => &DeviceModel::Unknown, // Default for simulation
        };
        match device_model {
            DeviceModel::RemarkablePaperPro => {
                // xochitl can have several separate card0 allocation groups.
                // Their order changes across restarts, so probe every group
                // instead of assuming the final mapping is the framebuffer.
                let screen_size_bytes = (self.screen_width() as u64)
                    .checked_mul(self.screen_height() as u64)
                    .and_then(|pixels| pixels.checked_mul(self.bytes_per_pixel() as u64))
                    .ok_or_else(|| anyhow::anyhow!("Framebuffer size overflow"))?;
                let candidates = self.get_framebuffer_candidates(pid)?;
                let mem_file_path = format!("/proc/{}/mem", pid);
                let mut file = File::open(&mem_file_path)?;

                for candidate in candidates.iter().rev() {
                    let readable_bytes = candidate.readable_end.checked_sub(candidate.base).unwrap_or(0);
                    if readable_bytes < screen_size_bytes {
                        debug!("RMPP framebuffer candidate {:#x} rejected: readable span is too small", candidate.base);
                        continue;
                    }

                    let frame_pointer = match Self::calculate_frame_pointer_from(&mut file, candidate.base, candidate.readable_end, screen_size_bytes) {
                        Ok(pointer) => pointer,
                        Err(error) => {
                            debug!("RMPP framebuffer candidate {:#x} rejected: {}", candidate.base, error);
                            continue;
                        }
                    };

                    if let Err(error) = Self::probe_framebuffer_range(&mut file, frame_pointer, screen_size_bytes) {
                        debug!("RMPP framebuffer candidate {:#x} has an unreadable frame: {}", candidate.base, error);
                        continue;
                    }

                    debug!("RMPP framebuffer candidate {:#x} resolved to {:#x}", candidate.base, frame_pointer);
                    return Ok(frame_pointer);
                }

                anyhow::bail!("No usable Paper Pro framebuffer found across {} allocation candidate(s)", candidates.len())
            }
            _ => {
                // RM2: find the mapping after /dev/fb0 in /proc/pid/maps, then apply firmware offset.
                // Reference: goMarkableStream internal/remarkable/pointer.go
                let output = process::Command::new("sh")
                    .arg("-c")
                    .arg(format!("grep -A1 '/dev/fb0' /proc/{}/maps | tail -n1 | sed 's/-.*$//'", pid))
                    .output()?;
                let address_hex = String::from_utf8(output.stdout)?.trim().to_string();
                let address = u64::from_str_radix(&address_hex, 16)?;
                let pointer_offset = Self::detect_rm2_pointer_offset();
                debug!(
                    "RM2 framebuffer: base={:#x}, pointer_offset={}, total={:#x}",
                    address,
                    pointer_offset,
                    address + pointer_offset + 8
                );
                Ok(address + pointer_offset + 8)
            }
        }
    }

    // Get every contiguous card0 mapping group's end address plus large,
    // anonymous allocations that may hold a detached terminal framebuffer.
    // Qt's allocator can either keep the final frame contiguous with the
    // card0-linked chain or place it in a standalone anonymous mapping.
    fn get_framebuffer_candidates(&self, pid: &str) -> Result<Vec<RmppFramebufferCandidate>> {
        let maps_file_path = format!("/proc/{}/maps", pid);
        debug!("screenshot: reading memory ranges from {}", maps_file_path);
        let maps_content = std::fs::read_to_string(&maps_file_path)?;
        Self::parse_framebuffer_candidates(&maps_content)
    }

    fn parse_framebuffer_candidates(maps_content: &str) -> Result<Vec<RmppFramebufferCandidate>> {
        let mut entries = Vec::new();
        for line in maps_content.lines() {
            let mut fields = line.split_whitespace();
            let range_field = fields.next().ok_or_else(|| anyhow::anyhow!("Missing card0 memory range"))?;
            let permissions = fields.next().ok_or_else(|| anyhow::anyhow!("Missing memory permissions"))?;
            let (start_hex, end_hex) = range_field.split_once('-').ok_or_else(|| anyhow::anyhow!("Invalid memory range format"))?;
            let start = u64::from_str_radix(start_hex, 16)?;
            let end = u64::from_str_radix(end_hex, 16)?;

            if start >= end {
                anyhow::bail!("Invalid memory range");
            }

            // Skip offset, device, and inode. The path is optional.
            let path = fields.nth(3);
            entries.push(ProcMapEntry {
                start,
                end,
                readable: permissions.starts_with('r'),
                is_card0: path == Some("/dev/dri/card0"),
                is_anonymous: path.is_none(),
            });
        }

        let mut candidates = Vec::new();
        let mut index = 0;
        while index < entries.len() {
            if !entries[index].is_card0 {
                index += 1;
                continue;
            }

            let mut group_end = entries[index].end;
            index += 1;
            while index < entries.len() && entries[index].is_card0 && entries[index].start == group_end {
                group_end = entries[index].end;
                index += 1;
            }

            let mut readable_end = group_end;
            let mut successor = index;
            while successor < entries.len() && !entries[successor].is_card0 && entries[successor].readable && entries[successor].start == readable_end {
                readable_end = entries[successor].end;
                successor += 1;
            }

            candidates.push(RmppFramebufferCandidate { base: group_end, readable_end });
        }

        // On some xochitl allocation layouts, the card0-linked chain ends in
        // an empty slot and its terminal frame is a separate anonymous
        // allocation. Such a mapping begins with the same terminal length
        // header at +8, so it can use the normal checked chain validator.
        for entry in &entries {
            if entry.is_anonymous && entry.readable && entry.end.saturating_sub(entry.start) == RMPP_TERMINAL_ADVANCE_BYTES {
                candidates.push(RmppFramebufferCandidate {
                    base: entry.start,
                    readable_end: entry.end,
                });
            }
        }

        if candidates.is_empty() {
            anyhow::bail!("No Paper Pro framebuffer allocation candidates found");
        }

        candidates.sort_unstable_by_key(|candidate| (candidate.base, candidate.readable_end));
        candidates.dedup();
        debug!("Found {} Paper Pro framebuffer candidate(s)", candidates.len());
        Ok(candidates)
    }

    // Calculate frame pointer for RMPP based on goMarkableStream/pointer_arm64.go
    fn calculate_frame_pointer_from<R: Read + Seek>(reader: &mut R, start_address: u64, readable_end: u64, screen_size_bytes: u64) -> Result<u64> {
        let mut offset: u64 = 0;
        let mut length: u64 = 2;

        for _ in 0..RMPP_FRAME_CHAIN_MAX_HOPS {
            let advance = length.checked_sub(2).ok_or_else(|| anyhow::anyhow!("Invalid header length"))?;
            offset = offset
                .checked_add(advance)
                .ok_or_else(|| anyhow::anyhow!("Framebuffer chain offset overflow"))?;
            let header_address = start_address
                .checked_add(offset)
                .and_then(|address| address.checked_add(8))
                .ok_or_else(|| anyhow::anyhow!("Framebuffer header address overflow"))?;
            let header_end = header_address
                .checked_add(4)
                .ok_or_else(|| anyhow::anyhow!("Framebuffer header range overflow"))?;
            if header_end > readable_end {
                anyhow::bail!("Framebuffer header exceeds readable mapping");
            }

            reader.seek(SeekFrom::Start(header_address))?;
            let mut header = [0u8; 4];
            reader.read_exact(&mut header)?;
            length = u32::from_le_bytes(header) as u64;

            if length < 2 {
                anyhow::bail!("Invalid header length");
            }
            if length >= screen_size_bytes {
                if length != RMPP_TERMINAL_HEADER_LENGTH {
                    anyhow::bail!("Unexpected terminal framebuffer header");
                }
                let frame_pointer = start_address
                    .checked_add(offset)
                    .ok_or_else(|| anyhow::anyhow!("Framebuffer address overflow"))?;
                let frame_end = frame_pointer
                    .checked_add(screen_size_bytes)
                    .ok_or_else(|| anyhow::anyhow!("Framebuffer range overflow"))?;
                if frame_end > readable_end {
                    anyhow::bail!("Framebuffer exceeds readable mapping");
                }
                return Ok(frame_pointer);
            }
            if length == 2 {
                anyhow::bail!("Framebuffer chain made no progress");
            }
            let next_advance = length - 2;
            if next_advance % RMPP_PAGE_BYTES != 0 || next_advance >= RMPP_TERMINAL_ADVANCE_BYTES {
                anyhow::bail!("Invalid intermediate framebuffer header");
            }
        }

        anyhow::bail!("Framebuffer chain exceeded {} hops", RMPP_FRAME_CHAIN_MAX_HOPS)
    }

    // Read the complete candidate range before accepting it. /proc/<pid>/mem
    // permits seeking to an address that is not fully backed; a complete
    // bounded read prevents selecting a chain that ends in a partial mapping.
    fn probe_framebuffer_range<R: Read + Seek>(reader: &mut R, frame_pointer: u64, screen_size_bytes: u64) -> Result<()> {
        frame_pointer
            .checked_add(screen_size_bytes)
            .ok_or_else(|| anyhow::anyhow!("Framebuffer range overflow"))?;
        reader.seek(SeekFrom::Start(frame_pointer))?;

        let mut remaining = screen_size_bytes;
        let mut buffer = [0u8; FRAMEBUFFER_PROBE_CHUNK_BYTES];
        while remaining > 0 {
            let chunk_size = remaining.min(buffer.len() as u64) as usize;
            reader.read_exact(&mut buffer[..chunk_size])?;
            remaining -= chunk_size as u64;
        }
        Ok(())
    }

    fn read_framebuffer(&self, pid: &str, skip_bytes: u64) -> Result<Vec<u8>> {
        // println!("taking screenshot \n assumed dimensions {} w x {} h", self.screen_width(), self.screen_height());
        let window_bytes = self.screen_width() as usize * self.screen_height() as usize * self.bytes_per_pixel();
        let mut buffer = vec![0u8; window_bytes];
        let mut file = std::fs::File::open(format!("/proc/{}/mem", pid))?;
        file.seek(std::io::SeekFrom::Start(skip_bytes))?;
        file.read_exact(&mut buffer)?;
        Ok(buffer)
    }

    fn process_image(&self, data: Vec<u8>, orientation: Option<crate::touch::SelectionOrientation>) -> Result<Vec<u8>> {
        let format = self.raw_framebuffer_format();
        let img = Self::image_from_raw_framebuffer(data, format)?;

        debug!("Resizing image to {}x{}", VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
        let resized_img = img.resize_exact(VIRTUAL_WIDTH, VIRTUAL_HEIGHT, image::imageops::FilterType::Nearest);

        // Normalize to user space: if the UI is rendered 180°-rotated (user
        // holding the device flipped), rotate the screenshot so everything
        // downstream — marquee detection, LLM crops, toolbar pixel checks,
        // placement planning — works in the orientation the user sees.
        // Pen/touch injection mirrors coordinates back (util::maybe_rot180_virtual).
        let rotated = Self::resolve_ui_rotation(&resized_img, orientation);
        crate::util::set_ui_rotated_180(rotated);
        let resized_img = if rotated { resized_img.rotate180() } else { resized_img };

        // Encode the resized image back to PNG
        debug!("Re-encoding resized image");
        let mut resized_png_data = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut resized_png_data);

        match format {
            RawFramebufferFormat::RmppRgba8 => {
                encoder.write_image(
                    resized_img.as_rgba8().unwrap().as_raw(),
                    VIRTUAL_WIDTH,
                    VIRTUAL_HEIGHT,
                    image::ExtendedColorType::Rgba8,
                )?;
            }
            _ => {
                encoder.write_image(
                    resized_img.as_luma8().unwrap().as_raw(),
                    VIRTUAL_WIDTH,
                    VIRTUAL_HEIGHT,
                    image::ExtendedColorType::L8,
                )?;
            }
        }

        Ok(resized_png_data)
    }

    fn resolve_ui_rotation(image: &image::DynamicImage, orientation: Option<crate::touch::SelectionOrientation>) -> bool {
        match orientation {
            Some(crate::touch::SelectionOrientation::Normal) => false,
            Some(crate::touch::SelectionOrientation::Rotated180) => true,
            None => Self::detect_ui_rotated(image),
        }
    }

    fn raw_framebuffer_format(&self) -> RawFramebufferFormat {
        let device_model = match &self.mode {
            ScreenshotMode::Real { device_model, .. } => device_model,
            ScreenshotMode::Simulated { .. } => &DeviceModel::Unknown,
        };
        match device_model {
            DeviceModel::RemarkablePaperPro => RawFramebufferFormat::RmppRgba8,
            _ if self.bytes_per_pixel() == 4 => RawFramebufferFormat::Rm2Bgra32,
            _ => RawFramebufferFormat::Rm2Rgb565,
        }
    }

    /// Convert the framebuffer bytes directly into the same image layout that
    /// the previous raw-PNG encode/decode path produced.
    fn image_from_raw_framebuffer(raw_data: Vec<u8>, format: RawFramebufferFormat) -> Result<image::DynamicImage> {
        match format {
            RawFramebufferFormat::RmppRgba8 => {
                let image = image::RgbaImage::from_raw(RMPP_WIDTH, RMPP_HEIGHT, raw_data)
                    .ok_or_else(|| anyhow::anyhow!("Failed to create RMPP image from raw data"))?;
                Ok(image::DynamicImage::ImageRgba8(image))
            }
            RawFramebufferFormat::Rm2Bgra32 => {
                // Firmware 3.24+: data is stored portrait (1404×1872), 32-bit
                // BGRA. The blue byte is the grayscale value used historically.
                let processed: Vec<u8> = raw_data.chunks_exact(4).map(|pixel| pixel[0]).collect();
                let image = GrayImage::from_raw(RM2_PORTRAIT_WIDTH, RM2_PORTRAIT_HEIGHT, processed)
                    .ok_or_else(|| anyhow::anyhow!("Failed to create RM2 image from raw data"))?;
                Ok(image::DynamicImage::ImageLuma8(image))
            }
            RawFramebufferFormat::Rm2Rgb565 => {
                // Pre-3.24: data is stored landscape (1872×1404), 16-bit
                // RGB565. Preserve the historical high-byte curve and
                // orientation normalization.
                let processed: Vec<u8> = raw_data.chunks_exact(2).map(|pixel| Self::apply_curves(pixel[1])).collect();
                let image = GrayImage::from_raw(RM2_LANDSCAPE_WIDTH, RM2_LANDSCAPE_HEIGHT, processed)
                    .ok_or_else(|| anyhow::anyhow!("Failed to create RM2 image from raw data"))?;
                let rotated = image::imageops::rotate270(&image);
                let oriented = image::imageops::flip_horizontal(&rotated);
                Ok(image::DynamicImage::ImageLuma8(oriented))
            }
        }
    }

    /// Detect whether xochitl's UI is rendered 180°-rotated in the
    /// framebuffer (user holding the device upside down). The toolbar /
    /// palette-toggle strip lives along the left-top edge normally, and in
    /// the mirrored right-bottom strip when rotated — compare dark-pixel
    /// counts between the two. With no clear toolbar signal on either side
    /// (e.g. fullscreen page), keep the last known state.
    fn detect_ui_rotated(img: &image::DynamicImage) -> bool {
        let gray = img.to_luma8();
        let dark_count = |x0: u32, y0: u32, x1: u32, y1: u32| -> u32 {
            let mut n = 0u32;
            for y in y0..y1 {
                for x in x0..x1 {
                    if gray.get_pixel(x, y).0[0] < 100 {
                        n += 1;
                    }
                }
            }
            n
        };
        let normal = dark_count(8, 8, 64, 300);
        let rotated = dark_count(VIRTUAL_WIDTH - 64, VIRTUAL_HEIGHT - 300, VIRTUAL_WIDTH - 8, VIRTUAL_HEIGHT - 8);
        if normal.max(rotated) < 20 {
            return crate::util::ui_rotated_180();
        }
        rotated > normal
    }

    fn apply_curves(value: u8) -> u8 {
        let normalized = value as f32 / 255.0;
        let adjusted = if normalized < 0.045 {
            0.0
        } else if normalized < 0.06 {
            (normalized - 0.045) / (0.06 - 0.045)
        } else {
            1.0
        };
        (adjusted * 255.0) as u8
    }

    pub fn save_image(&self, filename: &str) -> Result<()> {
        match &self.mode {
            ScreenshotMode::Simulated { simulator } => {
                simulator.save_image(filename)?;
                debug!("Simulated PNG image saved to {}", filename);
                Ok(())
            }
            ScreenshotMode::Real { data, .. } => {
                let mut png_file = File::create(filename)?;
                png_file.write_all(data)?;
                debug!("PNG image saved to {}", filename);
                Ok(())
            }
        }
    }

    /// Find the native selection-tool marquee in the screenshot. When strokes
    /// are selected, xochitl fills their bounding box with a uniform gray
    /// (exactly rgb(194,194,194) on the Paper Pro). Returns the bounding box
    /// of that gray region in virtual 768x1024 coordinates, or None if there
    /// is no active selection.
    pub fn detect_selection_rect(&self) -> Option<crate::touch::Rect> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data,
            _ => return None,
        };
        let img = image::load_from_memory(data).ok()?.to_rgb8();
        let (width, height) = (img.width() as usize, img.height() as usize);

        // Mask of selection-gray pixels. UI icons contain scattered gray
        // anti-aliasing pixels, so we take the largest CONNECTED component.
        let mask: Vec<bool> = img
            .pixels()
            .map(|p| {
                let [r, g, b] = p.0;
                r == g && g == b && (190..=198).contains(&r)
            })
            .collect();

        let mut visited = vec![false; width * height];
        let mut best: Option<(u32, u32, u32, u32, u32)> = None; // (count, min_x, min_y, max_x, max_y)
        let mut stack = Vec::new();

        for start in 0..mask.len() {
            if !mask[start] || visited[start] {
                continue;
            }
            let mut count = 0u32;
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
            visited[start] = true;
            stack.push(start);
            while let Some(idx) = stack.pop() {
                count += 1;
                let x = (idx % width) as u32;
                let y = (idx / width) as u32;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                let mut push = |n: usize| {
                    if mask[n] && !visited[n] {
                        visited[n] = true;
                        stack.push(n);
                    }
                };
                if x > 0 {
                    push(idx - 1);
                }
                if (x as usize) < width - 1 {
                    push(idx + 1);
                }
                if y > 0 {
                    push(idx - width);
                }
                if (y as usize) < height - 1 {
                    push(idx + width);
                }
            }
            if best.map(|(c, ..)| count > c).unwrap_or(true) {
                best = Some((count, min_x, min_y, max_x, max_y));
            }
        }

        let (count, min_x, min_y, max_x, max_y) = best?;
        // Require a substantial, mostly-solid region: the marquee is a filled
        // rectangle (minus the ink drawn on top of it)
        if count < 1000 {
            debug!("detect_selection_rect: largest gray region too small ({} px)", count);
            return None;
        }
        let w = (max_x - min_x + 1) as i32;
        let h = (max_y - min_y + 1) as i32;
        let density = count as f32 / (w * h) as f32;
        if density < 0.4 {
            debug!("detect_selection_rect: gray region too sparse (density {:.2})", density);
            return None;
        }

        Some(crate::touch::Rect {
            x: min_x as i32,
            y: min_y as i32,
            w,
            h,
        })
    }

    /// Find the floating menu xochitl shows next to an active lasso
    /// selection (cut / copy / style / delete) and return the tap point of
    /// its rightmost icon — the trash/delete button. Scans a band below,
    /// then above, the selection rect for a horizontal row of small dark
    /// icon glyphs. Returns None if no such menu is visible.
    pub fn detect_selection_menu_delete(&self, sel: crate::touch::Rect) -> Option<(i32, i32)> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data,
            _ => return None,
        };
        let img = image::load_from_memory(data).ok()?.to_luma8();
        Self::detect_selection_menu_delete_in(&img, sel)
    }

    /// Detection core of detect_selection_menu_delete, on a decoded
    /// grayscale screenshot (separated for offline testing).
    ///
    /// The native menu renders as a wide rounded-rect border (~150x40, only
    /// a few % of its area dark) with the four icon glyphs inside; the xovi
    /// LLM/Draw buttons render as separate NARROW boxes next to it, so
    /// requiring a wide hollow box excludes them, and the rightmost glyph
    /// inside the wide box is always the trash icon (measured on-device).
    pub fn detect_selection_menu_delete_in(img: &image::GrayImage, sel: crate::touch::Rect) -> Option<(i32, i32)> {
        let (width, height) = (img.width() as i32, img.height() as i32);

        let cx = sel.x + sel.w / 2;
        let x0 = (cx - 220).max(0);
        let x1 = (cx + 220).min(width - 1);

        // The menu sits ~15-60px from the selection edge; check below first
        // (xochitl's preference), then above.
        let bands = [(sel.y + sel.h + 2, (sel.y + sel.h + 110).min(height - 1)), ((sel.y - 110).max(0), sel.y - 2)];

        for (y0, y1) in bands {
            if y1 <= y0 {
                continue;
            }
            // Connected dark components inside the band window:
            // (min_x, min_y, max_x, max_y, pixel_count) in screen coords
            let win_w = (x1 - x0 + 1) as usize;
            let win_h = (y1 - y0 + 1) as usize;
            let dark: Vec<bool> = (0..win_h)
                .flat_map(|wy| (0..win_w).map(move |wx| (wx, wy)))
                .map(|(wx, wy)| img.get_pixel((x0 + wx as i32) as u32, (y0 + wy as i32) as u32).0[0] < 100)
                .collect();
            let mut visited = vec![false; dark.len()];
            let mut comps: Vec<(i32, i32, i32, i32, u32)> = Vec::new();
            for start in 0..dark.len() {
                if !dark[start] || visited[start] {
                    continue;
                }
                let (mut min_x, mut min_y, mut max_x, mut max_y) = (usize::MAX, usize::MAX, 0usize, 0usize);
                let mut count = 0u32;
                let mut stack = vec![start];
                visited[start] = true;
                while let Some(idx) = stack.pop() {
                    count += 1;
                    let (px, py) = (idx % win_w, idx / win_w);
                    min_x = min_x.min(px);
                    min_y = min_y.min(py);
                    max_x = max_x.max(px);
                    max_y = max_y.max(py);
                    let mut try_push = |n: usize| {
                        if dark[n] && !visited[n] {
                            visited[n] = true;
                            stack.push(n);
                        }
                    };
                    if px > 0 {
                        try_push(idx - 1);
                    }
                    if px < win_w - 1 {
                        try_push(idx + 1);
                    }
                    if py > 0 {
                        try_push(idx - win_w);
                    }
                    if py < win_h - 1 {
                        try_push(idx + win_w);
                    }
                }
                comps.push((x0 + min_x as i32, y0 + min_y as i32, x0 + max_x as i32, y0 + max_y as i32, count));
            }

            // The menu border: wide, ~40 tall, hollow (border pixels only)
            let boxes: Vec<_> = comps
                .iter()
                .filter(|&&(bx0, by0, bx1, by1, n)| {
                    let (w, h) = (bx1 - bx0 + 1, by1 - by0 + 1);
                    (100..=340).contains(&w) && (25..=70).contains(&h) && (n as f32) < (w * h) as f32 * 0.25
                })
                .collect();

            for &&(bx0, by0, bx1, by1, _) in &boxes {
                // Glyph fragments strictly inside the box interior
                let icons: Vec<_> = comps
                    .iter()
                    .filter(|&&(ix0, iy0, ix1, iy1, n)| {
                        n >= 4 && ix0 > bx0 + 2 && ix1 < bx1 - 2 && iy0 > by0 + 2 && iy1 < by1 - 2 && (ix1 - ix0) <= 40 && (iy1 - iy0) <= 40
                    })
                    .collect();
                if icons.len() < 3 {
                    continue;
                }
                // Rightmost glyph in the native menu = trash/delete
                let &&(ix0, iy0, ix1, iy1, _) = icons.iter().max_by_key(|&&&(_, _, ix1, _, _)| ix1)?;
                let (tx, ty) = ((ix0 + ix1) / 2, (iy0 + iy1) / 2);
                debug!(
                    "detect_selection_menu_delete: menu box ({},{})-({},{}), {} glyphs, delete at ({}, {})",
                    bx0,
                    by0,
                    bx1,
                    by1,
                    icons.len(),
                    tx,
                    ty
                );
                return Some((tx, ty));
            }
        }
        None
    }

    /// Return the screenshot cropped to `rect` (virtual 768x1024 coordinates)
    /// as a base64-encoded PNG. The rect is clamped to the screen bounds.
    pub fn base64_cropped(&self, rect: crate::touch::Rect) -> Result<String> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data.clone(),
            ScreenshotMode::Simulated { simulator } => {
                let b64 = simulator.get_base64_image()?;
                general_purpose::STANDARD.decode(b64)?
            }
            _ => anyhow::bail!("No screenshot data available to crop"),
        };

        let img = image::load_from_memory(&data)?;
        let x = rect.x.clamp(0, VIRTUAL_WIDTH as i32 - 1) as u32;
        let y = rect.y.clamp(0, VIRTUAL_HEIGHT as i32 - 1) as u32;
        let w = (rect.w as u32).min(VIRTUAL_WIDTH - x).max(1);
        let h = (rect.h as u32).min(VIRTUAL_HEIGHT - y).max(1);
        info!("Cropping screenshot to x={} y={} w={} h={}", x, y, w, h);
        let cropped = img.crop_imm(x, y, w, h);

        let mut png_data = Vec::new();
        cropped.write_to(&mut std::io::Cursor::new(&mut png_data), image::ImageFormat::Png)?;
        Ok(general_purpose::STANDARD.encode(png_data))
    }

    pub fn base64(&self) -> Result<String> {
        match &self.mode {
            ScreenshotMode::Simulated { simulator } => simulator.get_base64_image(),
            ScreenshotMode::Real { data, .. } => {
                let base64_image = general_purpose::STANDARD.encode(data);
                Ok(base64_image)
            }
        }
    }

    /// Exact in-memory fingerprint of the normalized current view. It is
    /// intentionally conservative: any changed pixel suppresses a delayed
    /// write-back rather than inserting into a possibly different page.
    pub fn view_fingerprint(&self) -> Result<u64> {
        Ok(self.normalized_view()?.fingerprint())
    }

    pub fn normalized_view(&self) -> Result<NormalizedView> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data.clone(),
            ScreenshotMode::Simulated { simulator } => {
                let b64 = simulator.get_base64_image()?;
                general_purpose::STANDARD.decode(b64)?
            }
            _ => anyhow::bail!("No screenshot data available"),
        };
        let image = image::load_from_memory(&data)?.to_rgba8();
        Ok(NormalizedView {
            width: image.width(),
            height: image.height(),
            rgba: image.into_raw(),
        })
    }

    pub fn grayscale_image(&self) -> Result<GrayImage> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data.clone(),
            ScreenshotMode::Simulated { simulator } => {
                let b64 = simulator.get_base64_image()?;
                general_purpose::STANDARD.decode(b64)?
            }
            _ => anyhow::bail!("No screenshot data available"),
        };
        Ok(image::load_from_memory(&data)?.to_luma8())
    }

    #[cfg(test)]
    pub(crate) fn from_png_data(data: Vec<u8>) -> Self {
        Screenshot {
            mode: ScreenshotMode::Real {
                data,
                device_model: DeviceModel::RemarkablePaperPro,
            },
        }
    }

    /// Return the (r, g, b) pixel value at virtual coordinate (vx, vy) in the 768×1024 space.
    /// Decodes the stored PNG on each call. Returns None if no screenshot data available.
    pub fn get_pixel(&self, vx: u32, vy: u32) -> Option<(u8, u8, u8)> {
        let data = match &self.mode {
            ScreenshotMode::Real { data, .. } if !data.is_empty() => data,
            ScreenshotMode::Simulated { simulator } => {
                return simulator.get_pixel(vx, vy);
            }
            _ => return None,
        };
        let img = image::load_from_memory(data).ok()?;
        let pixel = img.get_pixel(vx, vy);
        Some((pixel[0], pixel[1], pixel[2]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn legacy_png_roundtrip(raw_data: &[u8], format: RawFramebufferFormat) -> image::DynamicImage {
        let mut png_data = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        match format {
            RawFramebufferFormat::RmppRgba8 => {
                encoder.write_image(raw_data, RMPP_WIDTH, RMPP_HEIGHT, image::ExtendedColorType::Rgba8).unwrap();
            }
            RawFramebufferFormat::Rm2Bgra32 => {
                let processed: Vec<u8> = raw_data.chunks_exact(4).map(|pixel| pixel[0]).collect();
                let image = GrayImage::from_raw(RM2_PORTRAIT_WIDTH, RM2_PORTRAIT_HEIGHT, processed).unwrap();
                encoder
                    .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::L8)
                    .unwrap();
            }
            RawFramebufferFormat::Rm2Rgb565 => {
                let processed: Vec<u8> = raw_data.chunks_exact(2).map(|pixel| Screenshot::apply_curves(pixel[1])).collect();
                let image = GrayImage::from_raw(RM2_LANDSCAPE_WIDTH, RM2_LANDSCAPE_HEIGHT, processed).unwrap();
                let rotated = image::imageops::rotate270(&image);
                let oriented = image::imageops::flip_horizontal(&rotated);
                encoder
                    .write_image(oriented.as_raw(), oriented.width(), oriented.height(), image::ExtendedColorType::L8)
                    .unwrap();
            }
        }
        image::load_from_memory(&png_data).unwrap()
    }

    fn assert_matches_legacy_roundtrip(raw_data: Vec<u8>, format: RawFramebufferFormat) {
        let legacy = legacy_png_roundtrip(&raw_data, format);
        let direct = Screenshot::image_from_raw_framebuffer(raw_data, format).unwrap();

        assert_eq!(direct.dimensions(), legacy.dimensions());
        assert_eq!(direct.color(), legacy.color());
        match format {
            RawFramebufferFormat::RmppRgba8 => {
                assert_eq!(direct.to_rgba8().into_raw(), legacy.to_rgba8().into_raw());
            }
            _ => {
                assert_eq!(direct.to_luma8().into_raw(), legacy.to_luma8().into_raw());
            }
        }
    }

    #[test]
    fn rmpp_direct_frame_conversion_matches_legacy_png_roundtrip() {
        let mut raw = vec![0u8; (RMPP_WIDTH * RMPP_HEIGHT * 4) as usize];
        for (x, y, rgba) in [
            (0, 0, [1, 2, 3, 4]),
            (RMPP_WIDTH / 2, RMPP_HEIGHT / 2, [17, 89, 201, 255]),
            (RMPP_WIDTH - 1, RMPP_HEIGHT - 1, [255, 128, 64, 32]),
        ] {
            let offset = ((y * RMPP_WIDTH + x) * 4) as usize;
            raw[offset..offset + 4].copy_from_slice(&rgba);
        }
        assert_matches_legacy_roundtrip(raw, RawFramebufferFormat::RmppRgba8);
    }

    #[test]
    fn rm2_bgra32_direct_frame_conversion_matches_legacy_png_roundtrip() {
        let mut raw = vec![0u8; (RM2_PORTRAIT_WIDTH * RM2_PORTRAIT_HEIGHT * 4) as usize];
        for (x, y, bgra) in [
            (0, 0, [1, 2, 3, 4]),
            (RM2_PORTRAIT_WIDTH / 2, RM2_PORTRAIT_HEIGHT / 2, [127, 89, 201, 255]),
            (RM2_PORTRAIT_WIDTH - 1, RM2_PORTRAIT_HEIGHT - 1, [255, 128, 64, 32]),
        ] {
            let offset = ((y * RM2_PORTRAIT_WIDTH + x) * 4) as usize;
            raw[offset..offset + 4].copy_from_slice(&bgra);
        }
        assert_matches_legacy_roundtrip(raw, RawFramebufferFormat::Rm2Bgra32);
    }

    #[test]
    fn rm2_rgb565_direct_frame_conversion_matches_legacy_png_roundtrip() {
        let mut raw = vec![0u8; (RM2_LANDSCAPE_WIDTH * RM2_LANDSCAPE_HEIGHT * 2) as usize];
        for (x, y, bytes) in [
            (0, 0, [255, 11]),
            (RM2_LANDSCAPE_WIDTH / 2, RM2_LANDSCAPE_HEIGHT / 2, [128, 13]),
            (RM2_LANDSCAPE_WIDTH - 1, RM2_LANDSCAPE_HEIGHT - 1, [64, 255]),
        ] {
            let offset = ((y * RM2_LANDSCAPE_WIDTH + x) * 2) as usize;
            raw[offset..offset + 2].copy_from_slice(&bytes);
        }
        assert_matches_legacy_roundtrip(raw, RawFramebufferFormat::Rm2Rgb565);
    }

    #[test]
    fn groups_contiguous_card0_mappings_and_preserves_separate_candidates() {
        let maps = "\
ffff8e88a000-ffff8ea37000 rw-s 00000000 00:06 273 /dev/dri/card0
ffff8ea37000-ffff8ebe4000 rw-s 00000000 00:06 273 /dev/dri/card0
ffff8ebe4000-ffff90000000 rw-s 00000000 00:06 273 /dev/dri/card0
ffff90000000-ffff90d16000 rw-p 00000000 00:00 0
ffff94006000-ffff941b3000 rw-s 00000000 00:06 273 /dev/dri/card0
ffff941b3000-ffff955e0000 rw-p 00000000 00:00 0
ffffa0180000-ffffa032d000 rw-s 00000000 00:06 273 /dev/dri/card0
";

        assert_eq!(
            Screenshot::parse_framebuffer_candidates(maps).unwrap(),
            vec![
                RmppFramebufferCandidate {
                    base: 0xffff90000000,
                    readable_end: 0xffff90d16000,
                },
                RmppFramebufferCandidate {
                    base: 0xffff941b3000,
                    readable_end: 0xffff955e0000,
                },
                RmppFramebufferCandidate {
                    base: 0xffffa032d000,
                    readable_end: 0xffffa032d000,
                },
            ]
        );
    }

    #[test]
    fn requires_an_exact_card0_path_and_a_contiguous_readable_successor() {
        let maps = "\
1000-2000 rw-s 00000000 00:06 273 /dev/dri/card00
2000-3000 rw-p 00000000 00:00 0
4000-5000 rw-s 00000000 00:06 273 /dev/dri/card0
5000-6000 ---p 00000000 00:00 0
6000-7000 rw-p 00000000 00:00 0
";

        assert_eq!(
            Screenshot::parse_framebuffer_candidates(maps).unwrap(),
            vec![RmppFramebufferCandidate {
                base: 0x5000,
                readable_end: 0x5000,
            }]
        );
    }

    #[test]
    fn includes_a_detached_terminal_frame_allocation() {
        let maps = "\
1000-2000 rw-s 00000000 00:06 273 /dev/dri/card0
2000-3000 ---p 00000000 00:00 0
4000-d77000 rw-p 00000000 00:00 0
";

        assert_eq!(
            Screenshot::parse_framebuffer_candidates(maps).unwrap(),
            vec![
                RmppFramebufferCandidate {
                    base: 0x2000,
                    readable_end: 0x2000,
                },
                RmppFramebufferCandidate {
                    base: 0x4000,
                    readable_end: 0xd77000,
                },
            ]
        );
    }

    #[test]
    fn follows_a_valid_rmpp_framebuffer_header_chain() {
        let start = 16u64;
        let intermediate_advance = 0x35d000u64;
        let pointer = start + 2 * intermediate_advance;
        let readable_end = pointer + RMPP_TERMINAL_ADVANCE_BYTES;
        let mut memory = vec![0u8; (pointer + 12) as usize];
        memory[(start + 8) as usize..(start + 12) as usize].copy_from_slice(&((intermediate_advance + 2) as u32).to_le_bytes());
        let second_header = start + intermediate_advance + 8;
        memory[second_header as usize..(second_header + 4) as usize].copy_from_slice(&((intermediate_advance + 2) as u32).to_le_bytes());
        let terminal_header = pointer + 8;
        memory[terminal_header as usize..(terminal_header + 4) as usize].copy_from_slice(&(RMPP_TERMINAL_HEADER_LENGTH as u32).to_le_bytes());
        let mut reader = Cursor::new(memory);

        assert_eq!(
            Screenshot::calculate_frame_pointer_from(&mut reader, start, readable_end, 14_061_312,).unwrap(),
            pointer
        );
    }

    #[test]
    fn rejects_invalid_and_nonadvancing_rmpp_header_chains() {
        let start = 16u64;

        let mut invalid = Cursor::new(vec![0u8; 64]);
        let error = Screenshot::calculate_frame_pointer_from(&mut invalid, start, 64, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("Invalid header length"));

        let mut memory = vec![0u8; 64];
        memory[(start + 8) as usize..(start + 12) as usize].copy_from_slice(&2u32.to_le_bytes());
        let mut nonadvancing = Cursor::new(memory);
        let error = Screenshot::calculate_frame_pointer_from(&mut nonadvancing, start, 64, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("made no progress"));
    }

    #[test]
    fn rejects_false_terminal_and_unaligned_intermediate_headers() {
        let start = 16u64;

        let mut false_terminal_memory = vec![0u8; 64];
        false_terminal_memory[(start + 8) as usize..(start + 12) as usize].copy_from_slice(&((RMPP_TERMINAL_HEADER_LENGTH + 1) as u32).to_le_bytes());
        let mut false_terminal = Cursor::new(false_terminal_memory);
        let error = Screenshot::calculate_frame_pointer_from(&mut false_terminal, start, start + RMPP_TERMINAL_ADVANCE_BYTES + 1, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("Unexpected terminal"));

        let mut unaligned_memory = vec![0u8; 64];
        unaligned_memory[(start + 8) as usize..(start + 12) as usize].copy_from_slice(&0x1003u32.to_le_bytes());
        let mut unaligned = Cursor::new(unaligned_memory);
        let error = Screenshot::calculate_frame_pointer_from(&mut unaligned, start, start + RMPP_TERMINAL_ADVANCE_BYTES, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("Invalid intermediate"));
    }

    #[test]
    fn rejects_a_frame_that_would_cross_the_readable_mapping() {
        let start = 16u64;
        let mut memory = vec![0u8; 64];
        memory[(start + 8) as usize..(start + 12) as usize].copy_from_slice(&(RMPP_TERMINAL_HEADER_LENGTH as u32).to_le_bytes());
        let mut reader = Cursor::new(memory);

        let error = Screenshot::calculate_frame_pointer_from(&mut reader, start, start + 14_061_311, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("exceeds readable mapping"));
    }

    #[test]
    fn bounds_rmpp_header_hops_and_address_arithmetic() {
        let start = 16u64;
        let intermediate_advance = RMPP_PAGE_BYTES;
        let mut memory = vec![0u8; (start + 8 + (RMPP_FRAME_CHAIN_MAX_HOPS as u64 + 1) * intermediate_advance) as usize];
        for hop in 0..RMPP_FRAME_CHAIN_MAX_HOPS {
            let header = (start + 8 + hop as u64 * intermediate_advance) as usize;
            memory[header..header + 4].copy_from_slice(&((intermediate_advance + 2) as u32).to_le_bytes());
        }
        let readable_end = memory.len() as u64;
        let mut reader = Cursor::new(memory);
        let error = Screenshot::calculate_frame_pointer_from(&mut reader, start, readable_end, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("exceeded 64 hops"));

        let mut empty = Cursor::new(Vec::<u8>::new());
        let error = Screenshot::calculate_frame_pointer_from(&mut empty, u64::MAX - 4, u64::MAX, 14_061_312).unwrap_err();
        assert!(error.to_string().contains("address overflow"));
    }

    #[test]
    fn probes_the_complete_framebuffer_range() {
        let mut reader = Cursor::new(vec![0x7f; FRAMEBUFFER_PROBE_CHUNK_BYTES + 7]);
        Screenshot::probe_framebuffer_range(&mut reader, 0, (FRAMEBUFFER_PROBE_CHUNK_BYTES + 7) as u64).unwrap();

        let mut short_reader = Cursor::new(vec![0x7f; 7]);
        assert!(Screenshot::probe_framebuffer_range(&mut short_reader, 0, 8).is_err());
    }

    #[test]
    fn detects_selection_marquee_in_real_capture() {
        let data = std::fs::read("tests/fixtures/rmpp_selection.png").unwrap();
        let ss = Screenshot::from_png_data(data);
        let rect = ss.detect_selection_rect().expect("marquee should be detected");
        // The capture has the selection around "Hi, How are You?" near (145,222)-(447,275)
        assert!((rect.x - 145).abs() < 15, "x = {}", rect.x);
        assert!((rect.y - 222).abs() < 15, "y = {}", rect.y);
        assert!((rect.w - 300).abs() < 30, "w = {}", rect.w);
        assert!((rect.h - 52).abs() < 20, "h = {}", rect.h);
    }

    #[test]
    fn real_marquee_crop_prepares_for_vision_without_persistence() {
        let data = std::fs::read("tests/fixtures/rmpp_selection.png").unwrap();
        let ss = Screenshot::from_png_data(data);
        let rect = ss.detect_selection_rect().expect("marquee should be detected");
        let crop = ss.base64_cropped(rect).unwrap();
        let prepared = crate::util::prepare_selection_png_b64(&crop, 768).unwrap();

        let bytes = general_purpose::STANDARD.decode(prepared).unwrap();
        assert!(bytes.len() < 6 * 1024 * 1024);
        let image = image::load_from_memory(&bytes).unwrap().to_luma8();
        assert_eq!(image.width().max(image.height()), 768);
        assert!(image.pixels().any(|pixel| pixel.0[0] < 64), "handwriting must remain visible");
        assert!(image.pixels().any(|pixel| pixel.0[0] == 255), "selection-gray background must become white");
    }

    #[test]
    fn no_marquee_in_capture_without_selection() {
        let data = std::fs::read("tests/fixtures/rmpp_no_selection.png").unwrap();
        let ss = Screenshot::from_png_data(data);
        assert!(ss.detect_selection_rect().is_none());
    }

    #[test]
    fn explicit_orientation_overrides_ambiguous_corner_heuristics() {
        let image = image::DynamicImage::ImageLuma8(GrayImage::from_pixel(VIRTUAL_WIDTH, VIRTUAL_HEIGHT, image::Luma([255])));
        assert!(Screenshot::resolve_ui_rotation(&image, Some(crate::touch::SelectionOrientation::Rotated180)));
        assert!(!Screenshot::resolve_ui_rotation(&image, Some(crate::touch::SelectionOrientation::Normal)));
    }

    #[test]
    fn view_fingerprint_changes_with_any_normalized_pixel() {
        let first = image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 255, 255, 255]));
        let mut changed = first.clone();
        changed.put_pixel(3, 4, image::Rgba([254, 255, 255, 255]));

        let encode = |image: image::RgbaImage| {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            bytes.into_inner()
        };
        let first_fingerprint = Screenshot::from_png_data(encode(first)).view_fingerprint().unwrap();
        let repeated_fingerprint = Screenshot::from_png_data(encode(image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 255, 255, 255]))))
            .view_fingerprint()
            .unwrap();
        let changed_fingerprint = Screenshot::from_png_data(encode(changed)).view_fingerprint().unwrap();

        assert_eq!(first_fingerprint, repeated_fingerprint);
        assert_ne!(first_fingerprint, changed_fingerprint);
    }

    #[test]
    fn guarded_write_back_accepts_only_chrome_and_cursor_deltas() {
        let baseline = image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 255, 255, 255]));
        let encode = |image: image::RgbaImage| {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            Screenshot::from_png_data(bytes.into_inner()).normalized_view().unwrap()
        };
        let baseline = encode(baseline);
        let chrome = crate::touch::Rect { x: 0, y: 0, w: 3, h: 3 };
        let cursor = crate::touch::Rect { x: 8, y: 8, w: 4, h: 4 };

        let mut allowed = image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 255, 255, 255]));
        allowed.put_pixel(1, 1, image::Rgba([0, 0, 0, 255]));
        for (x, y) in [(8, 8), (9, 8), (8, 9), (9, 9)] {
            allowed.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
        assert!(baseline.changed_pixels_are_confined(&encode(allowed), &[chrome, cursor], cursor, 4));

        let mut outside = image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 255, 255, 255]));
        for (x, y) in [(8, 8), (9, 8), (8, 9), (9, 9)] {
            outside.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
        outside.put_pixel(15, 15, image::Rgba([0, 0, 0, 255]));
        assert!(!baseline.changed_pixels_are_confined(&encode(outside), &[chrome, cursor], cursor, 4));
    }

    #[test]
    fn guarded_write_back_rejects_missing_cursor_delta_and_invalid_masks() {
        let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 255, 255, 255]));
        let encode = |image: image::RgbaImage| {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            Screenshot::from_png_data(bytes.into_inner()).normalized_view().unwrap()
        };
        let baseline = encode(image.clone());
        let current = encode(image);
        let chrome = crate::touch::Rect { x: 0, y: 0, w: 3, h: 3 };
        let cursor = crate::touch::Rect { x: 8, y: 8, w: 4, h: 4 };
        assert!(!baseline.changed_pixels_are_confined(&current, &[chrome, cursor], cursor, 1));
        assert!(!baseline.changed_pixels_are_confined(
            &current,
            &[crate::touch::Rect { x: -1, y: 0, w: 3, h: 3 }, cursor],
            cursor,
            1,
        ));
        assert!(!baseline.changed_pixels_are_confined(
            &current,
            &[crate::touch::Rect { x: 7, y: 7, w: 3, h: 3 }, cursor],
            cursor,
            1,
        ));
        assert!(!baseline.changed_pixels_are_within(&current, &[]));
    }

    #[test]
    fn guarded_write_back_requires_a_caret_like_vertical_delta() {
        let baseline_image = image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 255, 255, 255]));
        let encode = |image: image::RgbaImage| {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            Screenshot::from_png_data(bytes.into_inner()).normalized_view().unwrap()
        };
        let baseline = encode(baseline_image.clone());
        let region = crate::touch::Rect { x: 8, y: 4, w: 4, h: 8 };

        let mut vertical = baseline_image.clone();
        for y in 5..=10 {
            vertical.put_pixel(9, y, image::Rgba([0, 0, 0, 255]));
        }
        assert!(baseline.has_vertical_change_run(&encode(vertical), region, 6));

        let mut scattered = baseline_image;
        for (x, y) in [(8, 4), (9, 5), (10, 6), (11, 7), (8, 8), (9, 9), (10, 10), (11, 11)] {
            scattered.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
        assert!(!baseline.has_vertical_change_run(&encode(scattered), region, 6));
    }
}
