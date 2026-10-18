use crate::engine::{Asset, MediaJob, MediaStore, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn completed_output(state: &str, output: Option<&str>) -> Result<PathBuf> {
    if state != "completed" {
        return Err("导出成功后才能打开文件夹。".into());
    }
    let path = PathBuf::from(output.ok_or("此导出任务没有输出文件。")?);
    if !path.is_absolute() || !path.is_file() {
        return Err("导出文件已移动或删除，无法在文件夹中显示。".into());
    }
    Ok(path)
}

pub fn reveal_job_output(jobs: &[MediaJob], id: &str) -> Result<()> {
    let job = jobs
        .iter()
        .find(|job| job.id == id)
        .ok_or("导出任务不存在。")?;
    let output = completed_output(&job.state, job.output_path.as_deref())?;
    reveal(&output)
}

#[derive(Serialize, Deserialize)]
struct AssetOrigin {
    source: PathBuf,
}

fn origin_record(store: &MediaStore, imported: &Path) -> Result<PathBuf> {
    let name = imported.file_name().ok_or("素材文件名无效。")?;
    let mut record = name.to_os_string();
    record.push(".json");
    Ok(store.root.join(".origins").join(record))
}

/// Origins come from explicitly selected local paths; portable projects cannot supply them.
pub fn remember_asset_source(store: &MediaStore, asset: &Asset, source: &Path) -> Result<()> {
    let imported =
        store.authorized_path(&serde_json::json!({ "nativePath": asset.native_path }))?;
    let source = source
        .canonicalize()
        .map_err(|error| format!("无法读取素材原位置：{error}"))?;
    if !source.is_file() || source.starts_with(&store.root) {
        return Ok(());
    }
    let record = origin_record(store, &imported)?;
    let folder = record.parent().ok_or("素材位置目录无效。")?;
    fs::create_dir_all(folder).map_err(|error| format!("无法保存素材位置：{error}"))?;
    let temporary = tempfile::NamedTempFile::new_in(folder).map_err(|error| error.to_string())?;
    fs::write(
        temporary.path(),
        serde_json::to_vec(&AssetOrigin { source }).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("无法保存素材位置：{error}"))?;
    temporary
        .persist(record)
        .map_err(|error| format!("无法保存素材位置：{error}"))?;
    Ok(())
}

fn asset_location(store: &MediaStore, asset: &Value) -> Result<PathBuf> {
    let imported = store.authorized_path(asset)?;
    let record = origin_record(store, &imported)?;
    if let Ok(bytes) = fs::read(record) {
        if let Ok(origin) = serde_json::from_slice::<AssetOrigin>(&bytes) {
            if origin.source.is_absolute() && origin.source.is_file() {
                return Ok(origin.source);
            }
        }
    }
    Ok(imported)
}

pub fn reveal_media_asset(store: &MediaStore, asset: &Value) -> Result<()> {
    reveal(&asset_location(store, asset)?)
}

fn reveal(path: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        // The file manager can outlive this request; do not wait for its window to close.
        let mut child = std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|error| format!("无法打开导出文件夹：{error}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .status();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let result = std::process::Command::new("xdg-open")
            .arg(path.parent().ok_or("导出目录无效。")?)
            .status();
        let status = result.map_err(|error| format!("无法打开导出文件夹：{error}"))?;
        if !status.success() {
            return Err("无法打开导出文件夹，请从保存位置打开。".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_completed_existing_outputs_can_be_revealed() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("导出文件 空格.mp4");
        std::fs::write(&path, b"exported result").unwrap();
        for state in ["running", "failed", "cancelled"] {
            assert!(completed_output(state, path.to_str()).is_err());
        }
        assert_eq!(completed_output("completed", path.to_str()).unwrap(), path);
        assert!(completed_output("completed", None).is_err());
        assert!(completed_output("completed", folder.path().to_str()).is_err());
        assert!(completed_output("completed", Some("relative.mp4")).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(completed_output("completed", path.to_str()).is_err());
    }

    #[test]
    fn unknown_job_cannot_choose_a_file_path() {
        assert!(reveal_job_output(&[], "/tmp/not-a-job").is_err());
    }

    #[test]
    fn asset_folder_uses_persisted_picker_origin_and_falls_back_to_imported_copy() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = directory.path().join("原始 视频.mp4");
        let imported = store.root.join("cached-video.mp4");
        fs::write(&source, b"video").unwrap();
        fs::copy(&source, &imported).unwrap();
        let asset = Asset {
            id: "asset".into(),
            name: "原始 视频.mp4".into(),
            kind: "video".into(),
            url: String::new(),
            duration: 1.0,
            width: 160,
            height: 90,
            size: 5,
            mime: "video/mp4".into(),
            native_path: imported.to_string_lossy().into(),
        };
        remember_asset_source(&store, &asset, &source).unwrap();
        let reopened = MediaStore::new(directory.path()).unwrap();
        let value = serde_json::to_value(&asset).unwrap();
        assert_eq!(
            asset_location(&reopened, &value).unwrap(),
            source.canonicalize().unwrap()
        );
        fs::remove_file(source).unwrap();
        assert_eq!(
            asset_location(&reopened, &value).unwrap(),
            imported.canonicalize().unwrap()
        );
        fs::remove_file(imported).unwrap();
        assert!(asset_location(&reopened, &value).is_err());
    }

    #[test]
    fn imported_assets_cannot_supply_their_own_source_location() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let external = directory.path().join("external.mp4");
        fs::write(&external, b"video").unwrap();
        assert!(asset_location(&store, &serde_json::json!({"nativePath": external})).is_err());
        let imported = store.root.join("old-project.mp4");
        fs::write(&imported, b"video").unwrap();
        let value = serde_json::json!({"nativePath": imported, "sourcePath": external});
        assert_eq!(
            asset_location(&store, &value).unwrap(),
            imported.canonicalize().unwrap()
        );
    }
}
