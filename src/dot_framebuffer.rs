//! Read-only capture from the already-loaded, firmware-qualified framebuffer spy.
use anyhow::{ensure, Context, Result};
use std::{fs::{self, File}, io::{Read, Seek, SeekFrom}, os::unix::fs::MetadataExt, path::Path};
const WIDTH: u32 = 1620;
const HEIGHT: u32 = 2160;
const STRIDE: u64 = 6528;

fn address(config: &str) -> Result<u64> {
    let fields: Vec<_> = config.split(',').collect();
    ensure!(fields.len() == 6 && fields[1..] == ["1620", "2160", "2", "6528", "0"], "Unexpected Pro framebuffer layout");
    let hex = fields[0].strip_prefix("0x").context("Invalid framebuffer address")?;
    ensure!(!hex.is_empty() && hex.len() <= 12 && hex.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid framebuffer address");
    let value = u64::from_str_radix(hex, 16)?;
    ensure!((65536..0x1000000000000 - STRIDE * HEIGHT as u64).contains(&value), "Invalid framebuffer range");
    Ok(value)
}
fn rows(reader: &mut (impl Read + Seek), start: u64) -> Result<Vec<u8>> {
    let mut rgba = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
    for (y, row) in rgba.chunks_exact_mut(WIDTH as usize * 4).enumerate() {
        reader.seek(SeekFrom::Start(start + y as u64 * STRIDE))?;
        reader.read_exact(row)?;
        for pixel in row.chunks_exact_mut(4) { pixel.swap(0, 2); pixel[3] = 255; }
    }
    Ok(rgba)
}
fn incarnation(pid: &str) -> Result<String> {
    ensure!(fs::read_link(format!("/proc/{pid}/exe"))? == Path::new("/usr/bin/xochitl"), "Unexpected UI process");
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    Ok(stat.rsplit_once(") ").context("Invalid process stat")?.1.split_whitespace().nth(19).context("Missing process start")?.into())
}
pub fn capture() -> Result<image::DynamicImage> {
    ensure!(fs::read_to_string("/sys/devices/soc0/machine")?.trim() == "reMarkable Ferrari", "Pro capture only");
    ensure!(fs::read_to_string("/etc/os-release")?.lines().any(|l| l == "IMG_VERSION=\"3.29.0.153\""), "Unqualified capture firmware");
    let output = std::process::Command::new("pidof").arg("xochitl").output()?;
    let pid = std::str::from_utf8(&output.stdout)?.trim();
    ensure!(!pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()), "Ambiguous UI process");
    let before = incarnation(pid)?;
    let log = fs::read_link(format!("/proc/{pid}/fd/2"))?;
    let name = log.to_str().context("Invalid log path")?;
    ensure!(name.starts_with("/home/root/.codex-backups/companion-") && name.ends_with("/probe.log") && !name.contains(".."), "Capture requires qualified native owner");
    let meta = fs::symlink_metadata(&log)?;
    ensure!(meta.is_file() && meta.uid() == 0 && meta.mode() & 0o022 == 0, "Unsafe framebuffer log");
    // The spy announces at startup. Do not reread an ever-growing UI log.
    let mut text = String::new();
    File::open(log)?.take(256*1024).read_to_string(&mut text)?;
    let configs: Vec<_> = text.lines().filter_map(|l| l.strip_prefix("Found framebuffer! Config string is ")).collect();
    ensure!(configs.len() == 1, "Framebuffer identity ambiguous");
    let start = address(configs[0])?;
    let mut memory = File::open(format!("/proc/{pid}/mem"))?; // O_RDONLY only
    let data = rows(&mut memory, start)?;
    ensure!(incarnation(pid)? == before, "UI restarted during capture");
    let image = image::RgbaImage::from_raw(WIDTH, HEIGHT, data).context("Invalid capture dimensions")?;
    Ok(image::DynamicImage::ImageRgba8(image))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_layout_and_address() {
        assert_eq!(address("0x10000,1620,2160,2,6528,0").unwrap(), 65536);
        for bad in ["0x0,1620,2160,2,6528,0", "0x10000,1632,2154,2,6528,0", "0x10000,960,1696,2,3840,0", "0x10000,1620,2160,2,6480,0"] { assert!(address(bad).is_err()); }
    }
    #[test]
    fn rows_skip_padding_and_convert_rgb32() {
        let mut data = vec![77u8; (STRIDE * HEIGHT as u64) as usize];
        for y in 0..HEIGHT as usize { for x in 0..WIDTH as usize {
            let i = y * STRIDE as usize + x*4; data[i..i+4].copy_from_slice(&[3, 2, 1, 0]);
        }}
        let rgba = rows(&mut std::io::Cursor::new(data), 0).unwrap();
        assert_eq!(rgba.len(), WIDTH as usize*HEIGHT as usize*4);
        assert!(rgba.chunks_exact(4).all(|p| p == [1,2,3,255]));
    }
}
