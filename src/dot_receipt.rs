//! Content-free, volatile receipt for the native send-only toast.
use std::{fs, io::Write, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path,
    sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{SystemTime, UNIX_EPOCH}};

fn publish_at(directory: &Path, state: &str, epoch_ms: u128) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(directory)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(std::io::Error::other("Unsafe Dot receipt directory"));
    }
    let tmp = directory.join(format!(".send-status-{}", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    let result = (|| {
        write!(file, "{{\"state\":\"{state}\",\"epoch_ms\":{epoch_ms}}}\n")?;
        fs::rename(&tmp, directory.join("send-status.json"))
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}
fn publish(state: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    if publish_at(Path::new("/run/smart-remarkable"), state, now).is_err() {
        log::warn!("Dot receipt unavailable");
    }
}
pub struct Receipt { accepted: Arc<AtomicBool> }
impl Receipt {
    pub fn new() -> Self { publish("capturing"); Self { accepted: Arc::new(AtomicBool::new(false)) } }
    pub fn acknowledgement(&self) -> impl Fn() + Send + 'static {
        let accepted = self.accepted.clone();
        move || { accepted.store(true, Ordering::SeqCst); publish("sent"); }
    }
}
impl Drop for Receipt {
    fn drop(&mut self) { if !self.accepted.load(Ordering::SeqCst) { publish("failed"); } }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn receipt_is_content_free_private_atomic_and_rejects_symlink_directory() {
        let root = std::env::temp_dir().join(format!("dot-receipt-{}", std::process::id()));
        fs::create_dir(&root).unwrap(); fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        publish_at(&root, "sent", 123).unwrap();
        let path = root.join("send-status.json");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"state\":\"sent\",\"epoch_ms\":123}\n");
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
        let link = root.with_extension("link"); symlink(&root, &link).unwrap();
        assert!(publish_at(&link, "sent", 124).is_err());
        fs::remove_file(link).unwrap(); fs::remove_dir_all(root).unwrap();
    }
}
