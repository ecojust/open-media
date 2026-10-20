use crate::{
    engine::{self, Asset, JobManager, MediaJob, MediaStore, Result, Runtime},
    project_files::{ProjectFile, ProjectFiles, ProjectTarget},
};
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg", "mp3", "wav", "aac", "m4a", "flac",
    "ogg", "opus", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif", "heic",
    "ico",
];

pub fn require_editor_origin(
    label: &str,
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    development: bool,
) -> Result<()> {
    if label != "main" {
        return Err("只有主窗口可以管理 MCP 服务和执行编辑请求。".into());
    }
    let local = (scheme == "tauri" && host == Some("localhost") && port.is_none())
        || (matches!(scheme, "http" | "https")
            && host == Some("tauri.localhost")
            && port.is_none())
        || (development && scheme == "http" && host == Some("127.0.0.1") && port == Some(5200));
    if !local {
        return Err("MCP 请求必须来自本机应用界面。".into());
    }
    Ok(())
}

fn checked_path(raw: &str, extensions: &[&str]) -> Result<PathBuf> {
    let path = Path::new(raw);
    if raw.is_empty()
        || raw.len() > 32768
        || raw.contains('\0')
        || !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("请提供不含相对目录的本机绝对文件路径。".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !extensions.contains(&extension.as_str()) {
        return Err(format!("不支持此文件扩展名：{extension}"));
    }
    Ok(path.to_path_buf())
}

fn input_path(raw: &str, extensions: &[&str]) -> Result<PathBuf> {
    let path = checked_path(raw, extensions)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法读取指定文件：{error}"))?;
    if !canonical.is_file() {
        return Err("指定路径必须是现有的本机文件。".into());
    }
    Ok(canonical)
}

fn output_path(
    raw: &str,
    extensions: &[&str],
    store: &MediaStore,
    overwrite: bool,
) -> Result<PathBuf> {
    let path = checked_path(raw, extensions)?;
    let parent = path
        .parent()
        .ok_or("保存目录无效。")?
        .canonicalize()
        .map_err(|error| format!("保存目录不存在或不可访问：{error}"))?;
    if !parent.is_dir() || store.is_internal_path(&parent) {
        return Err("请选择媒体素材库以外的现有保存目录。".into());
    }
    let path = parent.join(path.file_name().ok_or("保存文件名无效。")?);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("不能覆盖目录或符号链接，请指定普通文件位置。".into());
        }
        Ok(_) if !overwrite => return Err("文件已存在，请指定新路径或明确允许覆盖。".into()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    Ok(path)
}

pub fn import_media_paths(
    store: &MediaStore,
    runtime: &Runtime,
    paths: &[String],
) -> Result<Vec<Asset>> {
    if paths.is_empty() || paths.len() > 32 {
        return Err("每次请指定 1 至 32 个媒体文件。".into());
    }
    // Validate the complete request before importing its first file.
    let selected = paths
        .iter()
        .map(|raw| input_path(raw, MEDIA_EXTENSIONS))
        .collect::<Result<Vec<_>>>()?;
    selected
        .into_iter()
        .map(|path| {
            let asset = store.import(runtime, &path, None)?;
            crate::export_files::remember_asset_source(store, &asset, &path)?;
            Ok(asset)
        })
        .collect()
}

pub fn save_project(
    files: &ProjectFiles,
    store: &MediaStore,
    bytes: &[u8],
    token: Option<&str>,
    path: Option<&str>,
    overwrite: bool,
) -> Result<ProjectTarget> {
    if token.is_some() && path.is_some() {
        return Err("项目保存凭据和新的保存路径不能同时指定。".into());
    }
    if let Some(token) = token {
        return files.save_registered(token, bytes);
    }
    let path = path.ok_or("项目尚未选择保存位置，请明确提供 .omedia 文件的绝对路径。")?;
    let path = output_path(path, &["omedia"], store, overwrite)?;
    files.save_selected_with_overwrite(path, bytes, overwrite)
}

pub fn open_project(files: &ProjectFiles, path: &str) -> Result<ProjectFile> {
    files.open_selected(input_path(path, &["omedia", "zip"])?)
}

pub fn save_project_archive(
    files: &ProjectFiles,
    store: &MediaStore,
    project: &Value,
    token: Option<&str>,
    path: Option<&str>,
    overwrite: bool,
) -> Result<ProjectTarget> {
    if token.is_some() && path.is_some() {
        return Err("项目保存凭据和新的保存路径不能同时指定。".into());
    }
    let write = |file: &mut fs::File| crate::project_archive::write_archive(file, store, project);
    if let Some(token) = token { return files.save_registered_with_writer(token, write); }
    let path = path.ok_or("项目尚未选择保存位置，请明确提供 .omedia 文件的绝对路径。")?;
    let path = output_path(path, &["omedia"], store, overwrite)?;
    files.save_selected_with_writer(path, overwrite, write)
}

pub fn open_project_archive(files: &ProjectFiles, store: &MediaStore, path: &str) -> Result<Value> {
    let path = input_path(path, &["omedia", "zip"])?;
    let project = crate::project_archive::read_archive(store, &path)?;
    let target = match files.register_opened(path) {
        Ok(target) => target,
        Err(error) => {
            let _ = crate::project_archive::discard_imported(store, &project);
            return Err(error);
        }
    };
    Ok(serde_json::json!({ "name": target.name, "path": target.path, "token": target.token, "project": project }))
}

pub fn begin_export(
    store: &MediaStore,
    runtime: &Runtime,
    jobs: &JobManager,
    spec: &Value,
    output: &str,
    overwrite: bool,
) -> Result<MediaJob> {
    if spec["kind"] != "timeline" {
        return Err("此接口用于导出当前视频项目。".into());
    }
    let name = engine::suggested_output(spec)?;
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("导出格式无效。")?;
    let output = output_path(output, &[extension], store, overwrite)?;
    let plan = engine::build_plan(store, runtime, spec)?;
    jobs.begin_with_overwrite(runtime, plan, output, overwrite)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_application_document_can_manage_mcp() {
        assert!(require_editor_origin("main", "tauri", Some("localhost"), None, false).is_ok());
        assert!(
            require_editor_origin("main", "http", Some("tauri.localhost"), None, false).is_ok()
        );
        assert!(
            require_editor_origin("capture-picker", "tauri", Some("localhost"), None, false)
                .is_err()
        );
        assert!(require_editor_origin(
            "recording-controls",
            "http",
            Some("tauri.localhost"),
            None,
            false
        )
        .is_err());
        assert!(require_editor_origin("main", "https", Some("example.org"), None, false).is_err());
        assert!(
            require_editor_origin("main", "http", Some("tauri.localhost"), Some(8123), false)
                .is_err()
        );
        assert!(
            require_editor_origin("main", "http", Some("127.0.0.1"), Some(5200), false).is_err()
        );
        assert!(require_editor_origin("main", "http", Some("127.0.0.1"), Some(5200), true).is_ok());
    }

    #[test]
    fn paths_require_explicit_absolute_typed_files() {
        for path in [
            "relative.mp4",
            "https://example.org/a.mp4",
            "/tmp/../a.mp4",
            "/tmp/a.sh",
            "/tmp/a.mp4\0",
        ] {
            assert!(checked_path(path, MEDIA_EXTENSIONS).is_err(), "{path}");
        }
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("video.MP4");
        assert!(checked_path(path.to_str().unwrap(), MEDIA_EXTENSIONS).is_ok());
        assert!(input_path(path.to_str().unwrap(), MEDIA_EXTENSIONS).is_err());
        fs::create_dir(&path).unwrap();
        assert!(input_path(path.to_str().unwrap(), MEDIA_EXTENSIONS).is_err());
    }

    #[test]
    fn project_save_is_explicit_and_does_not_clobber_by_default() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let files = ProjectFiles::default();
        assert!(save_project(&files, &store, b"one", None, None, false).is_err());
        let path = folder.path().join("project.omedia");
        let target = save_project(&files, &store, b"one", None, path.to_str(), false).unwrap();
        assert!(save_project(&files, &store, b"two", None, path.to_str(), false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"one");
        save_project(&files, &store, b"two", Some(&target.token), None, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(save_project(
            &files,
            &store,
            b"three",
            Some(&target.token),
            path.to_str(),
            false
        )
        .is_err());
        let restored = open_project(&files, path.to_str().unwrap()).unwrap();
        assert_eq!(restored.bytes, b"two");
        assert_eq!(restored.token, target.token);
        let unsafe_path = store.root.join("project.omedia");
        assert!(save_project(&files, &store, b"three", None, unsafe_path.to_str(), true).is_err());
    }

    #[test]
    fn no_clobber_is_enforced_at_the_atomic_write_not_only_validation() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("project.omedia");
        fs::write(&path, b"preserve").unwrap();
        let files = ProjectFiles::default();
        assert!(files
            .save_selected_with_overwrite(path.clone(), b"replace", false)
            .is_err());
        assert_eq!(fs::read(path).unwrap(), b"preserve");
    }

    #[test]
    fn project_archive_bridge_preserves_media_targets_and_failed_overwrites() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let files = ProjectFiles::default();
        let source = store.root.join("original.wav");
        fs::write(&source, b"original audio contents").unwrap();
        let mut project = serde_json::json!({
            "version": 1, "id": "project", "title": "Original", "width": 1920,
            "height": 1080, "fps": 30, "background": "#000000", "tracks": [],
            "assets": [{"id": "audio", "name": "original.wav", "kind": "audio",
                "duration": 1, "width": 0, "height": 0, "size": 23,
                "mime": "audio/wav", "url": "", "nativePath": source}],
        });
        let path = folder.path().join("project.omedia");
        let target = save_project_archive(&files, &store, &project, None, path.to_str(), false).unwrap();
        let original = fs::read(&path).unwrap();
        assert!(save_project_archive(&files, &store, &project, None, path.to_str(), false).is_err());
        assert!(save_project_archive(&files, &store, &project, Some(&target.token), path.to_str(), true).is_err());
        project["title"] = "Updated".into();
        save_project_archive(&files, &store, &project, Some(&target.token), None, false).unwrap();
        assert_ne!(fs::read(&path).unwrap(), original);
        fs::remove_file(&source).unwrap();
        let updated = fs::read(&path).unwrap();
        assert!(save_project_archive(&files, &store, &project, Some(&target.token), None, false).is_err());
        assert_eq!(fs::read(&path).unwrap(), updated);
        let opened = open_project_archive(&files, &store, path.to_str().unwrap()).unwrap();
        assert!(opened.get("bytes").is_none());
        assert_eq!(opened["token"], target.token);
        assert_eq!(opened["project"]["title"], "Updated");
        let restored = &opened["project"];
        let media = store.authorized_path(&restored["assets"][0]).unwrap();
        assert_eq!(fs::read(&media).unwrap(), b"original audio contents");
        let forbidden = store.root.join("project.omedia");
        assert!(save_project_archive(&files, &store, restored, None, forbidden.to_str(), true).is_err());
        save_project_archive(&files, &store, restored, Some(&target.token), None, false).unwrap();
        crate::project_archive::discard_imported(&store, restored).unwrap();
        assert!(!media.exists());
    }

    #[test]
    fn export_targets_preserve_existing_files_and_protect_library() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let path = folder.path().join("output.mp4");
        fs::write(&path, b"preserve").unwrap();
        assert!(output_path(path.to_str().unwrap(), &["mp4"], &store, false).is_err());
        assert!(output_path(path.to_str().unwrap(), &["mp4"], &store, true).is_ok());
        let inside = store.root.join("source.mp4");
        assert!(output_path(inside.to_str().unwrap(), &["mp4"], &store, true).is_err());
        let recorded = store.recording_store().unwrap().root.join("recorded.mp4");
        fs::write(&recorded, b"preserve recording").unwrap();
        assert!(output_path(recorded.to_str().unwrap(), &["mp4"], &store, true).is_err());
        assert_eq!(fs::read(recorded).unwrap(), b"preserve recording");
        assert!(output_path(path.to_str().unwrap(), &["webm"], &store, true).is_err());
    }

    #[test]
    fn authenticated_file_workflow_imports_and_exports_real_video_without_clobbering() {
        use std::time::{Duration, Instant};
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let runtime =
            Runtime::discover(None, None).expect("Media runtime required for integration checks");
        let source = folder.path().join("source.mp4");
        let generated = engine::process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x180:r=20:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let assets =
            import_media_paths(&store, &runtime, &[source.to_string_lossy().into()]).unwrap();
        let asset = &assets[0];
        assert_eq!(asset.kind, "video");
        assert_eq!(asset.width, 320);
        let spec = serde_json::json!({
            "kind": "timeline",
            "project": {"width": 320, "height": 180, "background": "#000000", "assets": assets,
                "tracks": [{"id": "track", "kind": "video", "muted": false, "clips": [{
                    "id": "clip", "assetId": asset.id, "start": 0, "trimIn": 0, "trimOut": 1,
                    "speed": 1, "opacity": 1, "volume": 1, "width": 320, "height": 180,
                }]}]},
            "config": {"width": 320, "height": 180, "fps": 20, "format": "mp4", "quality": "draft"},
        });
        let jobs = JobManager::default();
        let wait = |id: &str| {
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                let job = jobs.list().into_iter().find(|job| job.id == id).unwrap();
                if job.state != "running" {
                    return job;
                }
                assert!(Instant::now() < deadline, "export timeout");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let output = folder.path().join("export.mp4");
        let started = begin_export(
            &store,
            &runtime,
            &jobs,
            &spec,
            output.to_str().unwrap(),
            false,
        )
        .unwrap();
        let completed = wait(&started.id);
        assert_eq!(completed.state, "completed", "{:?}", completed.error);
        let probe = engine::process(&runtime.probe)
            .args(["-v", "error", "-show_streams", "-of", "json"])
            .arg(&output)
            .output()
            .unwrap();
        assert!(probe.status.success());
        let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
        assert_eq!(probe["streams"][0]["width"], 320);
        assert_eq!(probe["streams"][0]["height"], 180);
        assert!(begin_export(
            &store,
            &runtime,
            &jobs,
            &spec,
            output.to_str().unwrap(),
            false
        )
        .is_err());
        let race = folder.path().join("race.mp4");
        let started = begin_export(
            &store,
            &runtime,
            &jobs,
            &spec,
            race.to_str().unwrap(),
            false,
        )
        .unwrap();
        fs::write(&race, b"created by another writer during encoding").unwrap();
        let completed = wait(&started.id);
        assert_eq!(completed.state, "failed");
        assert_eq!(
            fs::read(race).unwrap(),
            b"created by another writer during encoding"
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_does_not_follow_file_or_library_symlinks() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let original = folder.path().join("original.mp4");
        fs::write(&original, b"preserve").unwrap();
        let alias = folder.path().join("alias.mp4");
        std::os::unix::fs::symlink(&original, &alias).unwrap();
        assert!(output_path(alias.to_str().unwrap(), &["mp4"], &store, true).is_err());
        let alias_dir = folder.path().join("library");
        std::os::unix::fs::symlink(&store.root, &alias_dir).unwrap();
        assert!(output_path(
            alias_dir.join("source.mp4").to_str().unwrap(),
            &["mp4"],
            &store,
            true
        )
        .is_err());
    }
}
