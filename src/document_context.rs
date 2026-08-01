use anyhow::{Context, Result};
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

const XOCHITL_DOCUMENT_ROOT: &str = "/home/root/.local/share/remarkable/xochitl";
const MAX_METADATA_BYTES: u64 = 128 * 1024;
const MAX_VISIBLE_NAME_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            size: metadata.len(),
            mtime: metadata.mtime(),
            mtime_nsec: metadata.mtime_nsec(),
            ctime: metadata.ctime(),
            ctime_nsec: metadata.ctime_nsec(),
        }
    }
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn validate_metadata_file(metadata: &Metadata, expected_uid: u32) -> Result<()> {
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != expected_uid
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o022 != 0
        || metadata.len() == 0
        || metadata.len() > MAX_METADATA_BYTES
    {
        anyhow::bail!("Document metadata file failed its type, owner, mode, link, or size check");
    }
    Ok(())
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn open_metadata_nofollow(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    Ok(options.open(path)?)
}

fn load_visible_name_from_root(root: &Path, document_id: &str, expected_uid: u32) -> Result<String> {
    if !canonical_uuid(document_id) {
        anyhow::bail!("Document id is not a canonical lowercase UUID");
    }
    let root_metadata = std::fs::symlink_metadata(root).with_context(|| "Unable to inspect the fixed xochitl metadata directory")?;
    if !root_metadata.file_type().is_dir()
        || root_metadata.file_type().is_symlink()
        || root_metadata.uid() != expected_uid
        || root_metadata.permissions().mode() & 0o022 != 0
    {
        anyhow::bail!("Xochitl metadata root failed its directory, owner, or mode check");
    }

    let path: PathBuf = root.join(format!("{document_id}.metadata"));
    let path_before = std::fs::symlink_metadata(&path).with_context(|| "Unable to inspect the exact document metadata file")?;
    validate_metadata_file(&path_before, expected_uid)?;

    let mut file = open_metadata_nofollow(&path).with_context(|| "Unable to open the exact document metadata file")?;
    let descriptor_before = file.metadata()?;
    validate_metadata_file(&descriptor_before, expected_uid)?;
    if !same_file(&path_before, &descriptor_before) {
        anyhow::bail!("Document metadata path changed before it was opened");
    }

    let mut bytes = Vec::with_capacity(descriptor_before.len() as usize);
    file.by_ref().take(MAX_METADATA_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != descriptor_before.len() || bytes.len() as u64 > MAX_METADATA_BYTES {
        anyhow::bail!("Document metadata changed size while it was read");
    }

    let descriptor_after = file.metadata()?;
    let path_after = std::fs::symlink_metadata(&path)?;
    validate_metadata_file(&descriptor_after, expected_uid)?;
    validate_metadata_file(&path_after, expected_uid)?;
    if FileIdentity::from_metadata(&descriptor_before) != FileIdentity::from_metadata(&descriptor_after)
        || !same_file(&descriptor_after, &path_after)
        || FileIdentity::from_metadata(&path_before) != FileIdentity::from_metadata(&path_after)
    {
        anyhow::bail!("Document metadata was not stable for the complete read");
    }

    let document: serde_json::Value = serde_json::from_slice(&bytes).with_context(|| "Document metadata is not valid JSON")?;
    let visible_name = document
        .as_object()
        .and_then(|object| object.get("visibleName"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Document metadata has no string visibleName"))?;
    if visible_name
        .chars()
        .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
        anyhow::bail!("Document visibleName contains controls");
    }
    let visible_name: String = visible_name.nfc().collect();
    if visible_name.trim().is_empty()
        || visible_name.len() > MAX_VISIBLE_NAME_BYTES
        || visible_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
        anyhow::bail!("Document visibleName is empty, oversized, or contains controls");
    }
    Ok(visible_name)
}

/// Resolve the display name for the nonce-bound document. This reads exactly
/// one root-owned xochitl metadata file and returns only its bounded
/// `visibleName`; the UUID and title are never logged here.
pub fn load_document_display_name(document_id: &str) -> Result<String> {
    load_visible_name_from_root(Path::new(XOCHITL_DOCUMENT_ROOT), document_id, 0)
}

#[cfg(test)]
mod tests {
    use super::{MAX_METADATA_BYTES, load_visible_name_from_root};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    fn fixture_root(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "smart-remarkable-document-context-{}-{}-{label}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir(&path).unwrap();
        path
    }

    fn write_metadata(root: &Path, id: &str, content: &[u8]) -> PathBuf {
        let path = root.join(format!("{id}.metadata"));
        std::fs::write(&path, content).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    fn local_uid(root: &Path) -> u32 {
        std::fs::metadata(root).unwrap().uid()
    }

    const ID: &str = "12345678-1234-4abc-8def-1234567890ab";

    #[test]
    fn reads_only_a_stable_bounded_control_clean_visible_name() {
        let root = fixture_root("valid");
        write_metadata(&root, ID, br#"{"visibleName":"Project notes","other":"ignored"}"#);
        assert_eq!(load_visible_name_from_root(&root, ID, local_uid(&root)).unwrap(), "Project notes");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalizes_a_safe_decomposed_visible_name_to_nfc() {
        let root = fixture_root("nfc");
        write_metadata(&root, ID, "{\"visibleName\":\"Cafe\u{301}\"}".as_bytes());
        assert_eq!(load_visible_name_from_root(&root, ID, local_uid(&root)).unwrap(), "Café");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_noncanonical_uuid_and_symlink_metadata() {
        let root = fixture_root("identity");
        let target = write_metadata(&root, ID, br#"{"visibleName":"Safe"}"#);
        assert!(load_visible_name_from_root(&root, "../escape", local_uid(&root)).is_err());
        std::fs::remove_file(&target).unwrap();
        let real = root.join("real.metadata");
        std::fs::write(&real, br#"{"visibleName":"Unsafe link"}"#).unwrap();
        std::os::unix::fs::symlink(&real, &target).unwrap();
        assert!(load_visible_name_from_root(&root, ID, local_uid(&root)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_symlinked_metadata_root() {
        let target = fixture_root("root-target");
        write_metadata(&target, ID, br#"{"visibleName":"Safe"}"#);
        let link = target.with_extension("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(load_visible_name_from_root(&link, ID, local_uid(&target)).is_err());
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn rejects_wrong_owner_or_mode_and_oversized_files() {
        let root = fixture_root("attributes");
        let path = write_metadata(&root, ID, br#"{"visibleName":"Safe"}"#);
        let uid = local_uid(&root);
        assert!(load_visible_name_from_root(&root, ID, uid.saturating_add(1)).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o622)).unwrap();
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, vec![b'x'; (MAX_METADATA_BYTES + 1) as usize]).unwrap();
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_malformed_missing_and_control_bearing_names() {
        let root = fixture_root("json");
        let uid = local_uid(&root);
        let path = write_metadata(&root, ID, b"not-json");
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::write(&path, br#"{"other":true}"#).unwrap();
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::write(&path, br#"{"visibleName":"line\nbreak"}"#).unwrap();
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::write(&path, br#"{"visibleName":"   "}"#).unwrap();
        assert!(load_visible_name_from_root(&root, ID, uid).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
