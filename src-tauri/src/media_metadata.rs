use crate::engine::{Asset, MediaStore, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

const MAX_METADATA_BYTES: u64 = 4096;
const MAX_NAME_BYTES: usize = 1024;

#[derive(Deserialize, Serialize)]
struct Metadata {
    version: u32,
    name: String,
}

/// Keep imported display names separate from project files and physical media names.
pub fn remember_name(store: &MediaStore, asset: &Asset) -> Result<()> {
    if !valid_name(&asset.name) {
        return Err("素材名称无效，无法记录。".into());
    }
    let media = direct_media_path(store, Path::new(&asset.native_path))?;
    let directory = metadata_directory(store, true)?;
    let path = metadata_path(&directory, &media)?;
    check_metadata_file(&path, true)?;
    let bytes = serde_json::to_vec(&Metadata {
        version: 1,
        name: asset.name.clone(),
    })
    .map_err(|error| error.to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|error| format!("无法记录素材名称：{error}"))?;
    staged
        .write_all(&bytes)
        .map_err(|error| format!("无法记录素材名称：{error}"))?;
    // Recheck before replacing; never truncate an existing link or partial record.
    metadata_directory(store, false)?;
    check_metadata_file(&path, true)?;
    staged
        .persist(&path)
        .map_err(|error| format!("无法记录素材名称：{}", error.error))?;
    Ok(())
}

/// Missing or invalid auxiliary records must not hide usable media from the library.
pub fn original_name(store: &MediaStore, path: &Path) -> Option<String> {
    let media = direct_media_path(store, path).ok()?;
    let directory = metadata_directory(store, false).ok()?;
    let path = metadata_path(&directory, &media).ok()?;
    check_metadata_file(&path, false).ok()?;
    let file = File::open(&path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return None;
    }
    let metadata: Metadata = serde_json::from_slice(&bytes).ok()?;
    (metadata.version == 1 && valid_name(&metadata.name)).then_some(metadata.name)
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name != "."
        && name != ".."
        && name.len() <= MAX_NAME_BYTES
        && !name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}

fn direct_media_path(store: &MediaStore, path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("素材名称只能关联素材库中的普通文件。".into());
    }
    let native_path = path.to_str().ok_or("素材文件路径编码无效。")?;
    let authorized = store.authorized_path(&serde_json::json!({ "nativePath": native_path }))?;
    if authorized.parent() != Some(store.root.as_path()) {
        return Err("素材名称只能关联素材库直属文件。".into());
    }
    Ok(authorized)
}

fn metadata_directory(store: &MediaStore, create: bool) -> Result<PathBuf> {
    let path = store.root.join(".metadata");
    if create {
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("无法创建素材名称目录：{error}")),
        }
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || path.canonicalize().map_err(|error| error.to_string())? != path
    {
        return Err("素材名称目录无效。".into());
    }
    Ok(path)
}

fn metadata_path(directory: &Path, media: &Path) -> Result<PathBuf> {
    let mut name = media.file_name().ok_or("素材文件名无效。")?.to_os_string();
    name.push(".json");
    Ok(directory.join(name))
}

fn check_metadata_file(path: &Path, allow_missing: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => Ok(()),
        Err(error) if allow_missing && error.kind() == ErrorKind::NotFound => Ok(()),
        _ => Err("素材名称记录无效。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, MediaStore, Asset) {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let path = store.root.join("imported-video.mp4");
        fs::write(&path, b"media fixture").unwrap();
        let asset = Asset {
            id: "fixture".into(),
            name: "我的旅行片段 01.mp4".into(),
            kind: "video".into(),
            url: String::new(),
            duration: 3.0,
            width: 1920,
            height: 1080,
            size: 13,
            mime: "video/mp4".into(),
            native_path: path.to_string_lossy().into_owned(),
        };
        (directory, store, asset)
    }

    fn record_path(store: &MediaStore) -> PathBuf {
        store.root.join(".metadata/imported-video.mp4.json")
    }

    #[test]
    fn original_display_name_survives_reopening_and_can_be_replaced() {
        let (directory, store, mut asset) = fixture();
        remember_name(&store, &asset).unwrap();
        let reopened = MediaStore::new(directory.path()).unwrap();
        assert_eq!(
            original_name(&reopened, Path::new(&asset.native_path)),
            Some(asset.name.clone())
        );
        asset.name = "重新命名.mp4".into();
        remember_name(&reopened, &asset).unwrap();
        assert_eq!(
            original_name(&store, Path::new(&asset.native_path)),
            Some(asset.name)
        );
    }

    #[test]
    fn missing_records_are_optional_and_reads_do_not_create_directories() {
        let (_directory, store, asset) = fixture();
        assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
        assert!(!store.root.join(".metadata").exists());
    }

    #[test]
    fn missing_external_and_nested_media_cannot_have_records() {
        let (directory, store, mut asset) = fixture();
        for path in [
            directory.path().join("outside.mp4"),
            store.root.join("nested/video.mp4"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"media fixture").unwrap();
            asset.native_path = path.to_string_lossy().into_owned();
            assert!(remember_name(&store, &asset).is_err());
            assert_eq!(original_name(&store, &path), None);
        }
        asset.native_path = store
            .root
            .join("missing.mp4")
            .to_string_lossy()
            .into_owned();
        assert!(remember_name(&store, &asset).is_err());
        assert!(!store.root.join(".metadata").exists());
    }

    #[test]
    fn malformed_unknown_version_and_oversized_records_are_ignored() {
        let (_directory, store, asset) = fixture();
        remember_name(&store, &asset).unwrap();
        for bytes in [
            b"not json".to_vec(),
            br#"{"version":2,"name":"video.mp4"}"#.to_vec(),
            br#"{"version":1,"name":"../video.mp4"}"#.to_vec(),
            br#"{"version":1,"name":""}"#.to_vec(),
            vec![b' '; MAX_METADATA_BYTES as usize + 1],
        ] {
            fs::write(record_path(&store), bytes).unwrap();
            assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
        }
    }

    #[test]
    fn invalid_names_do_not_replace_valid_records() {
        let (_directory, store, mut asset) = fixture();
        remember_name(&store, &asset).unwrap();
        let original = asset.name.clone();
        for name in [
            "".into(),
            "  ".into(),
            "..".into(),
            "path/video.mp4".into(),
            "path\\video.mp4".into(),
            "video\n.mp4".into(),
            "x".repeat(MAX_NAME_BYTES + 1),
        ] {
            asset.name = name;
            assert!(remember_name(&store, &asset).is_err());
            assert_eq!(
                original_name(&store, Path::new(&asset.native_path)),
                Some(original.clone())
            );
        }
    }

    #[test]
    fn directory_and_record_must_have_expected_file_types() {
        let (_directory, store, asset) = fixture();
        let metadata_directory = store.root.join(".metadata");
        fs::write(&metadata_directory, b"not a directory").unwrap();
        assert!(remember_name(&store, &asset).is_err());
        assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
        fs::remove_file(&metadata_directory).unwrap();
        fs::create_dir(&metadata_directory).unwrap();
        fs::create_dir(record_path(&store)).unwrap();
        assert!(remember_name(&store, &asset).is_err());
        assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
    }

    #[cfg(unix)]
    #[test]
    fn linked_metadata_directory_is_never_read_or_written() {
        use std::os::unix::fs::symlink;
        let (_directory, store, asset) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let outside_record = outside.path().join("imported-video.mp4.json");
        fs::write(&outside_record, br#"{"version":1,"name":"external.mp4"}"#).unwrap();
        symlink(outside.path(), store.root.join(".metadata")).unwrap();
        assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
        assert!(remember_name(&store, &asset).is_err());
        assert_eq!(
            fs::read(&outside_record).unwrap(),
            br#"{"version":1,"name":"external.mp4"}"#
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn linked_metadata_files_and_media_are_rejected() {
        use std::os::unix::fs::symlink;
        let (directory, store, mut asset) = fixture();
        fs::create_dir(store.root.join(".metadata")).unwrap();
        let outside_record = directory.path().join("outside.json");
        fs::write(&outside_record, br#"{"version":1,"name":"external.mp4"}"#).unwrap();
        symlink(&outside_record, record_path(&store)).unwrap();
        assert_eq!(original_name(&store, Path::new(&asset.native_path)), None);
        assert!(remember_name(&store, &asset).is_err());
        assert_eq!(
            fs::read(&outside_record).unwrap(),
            br#"{"version":1,"name":"external.mp4"}"#
        );
        let linked_media = store.root.join("linked.mp4");
        symlink(&asset.native_path, &linked_media).unwrap();
        asset.native_path = linked_media.to_string_lossy().into_owned();
        assert!(remember_name(&store, &asset).is_err());
        assert_eq!(original_name(&store, &linked_media), None);
    }
}
