use crate::{
    engine::{build_plan, process, JobManager, MediaStore, Runtime},
    media_metadata,
    preview::create_preview,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn asset_path(path: &Path) -> Value {
    json!({ "nativePath": path.to_str().unwrap() })
}

#[test]
fn recording_directory_is_a_fixed_sibling_of_the_regular_media_store() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    assert_eq!(
        store.root,
        app_data.path().join("media").canonicalize().unwrap()
    );
    assert_eq!(
        recordings.root,
        app_data.path().join("recording").canonicalize().unwrap()
    );
    assert_eq!(store.recording_root().unwrap(), recordings.root);
    assert_ne!(store.root, recordings.root);
    assert!(!recordings.root.starts_with(&store.root));
    assert_eq!(store.recording_store().unwrap().root, recordings.root);
    assert_eq!(MediaStore::new(app_data.path()).unwrap().root, store.root);
}

#[test]
fn main_store_accepts_all_fixed_media_roots_but_not_unrelated_siblings() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    let imported = store.import_video_store().unwrap();
    for directory in [&store.root, &recordings.root, &imported.root] {
        let path = directory.join("video.mp4");
        fs::write(&path, b"media fixture").unwrap();
        assert_eq!(store.authorized_path(&asset_path(&path)).unwrap(), path);
        assert!(store.is_internal_path(&path));
    }
    for name in [
        "other",
        "media-other",
        "recordings-other",
        "import video-other",
    ] {
        let directory = app_data.path().join(name);
        fs::create_dir(&directory).unwrap();
        let path = directory.join("video.mp4");
        fs::write(&path, b"media fixture").unwrap();
        assert!(store.authorized_path(&asset_path(&path)).is_err());
        assert!(!store.is_internal_path(&path));
    }
    let outside = app_data.path().join("video.mp4");
    fs::write(&outside, b"media fixture").unwrap();
    assert!(store.authorized_path(&asset_path(&outside)).is_err());
}

#[test]
fn imported_video_directory_is_a_fixed_sibling_and_preserves_existing_media() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let old_file = store.root.join("previously-imported.mp4");
    fs::write(&old_file, b"existing media").unwrap();
    let imported = store.import_video_store().unwrap();
    let recordings = store.recording_store().unwrap();
    assert_eq!(
        imported.root,
        app_data.path().join("import video").canonicalize().unwrap()
    );
    assert_eq!(store.import_video_root().unwrap(), imported.root);
    assert_eq!(recordings.import_video_root().unwrap(), imported.root);
    assert_eq!(imported.recording_root().unwrap(), recordings.root);
    assert!(!imported.root.starts_with(&store.root));
    assert!(!imported.root.starts_with(&recordings.root));
    assert_eq!(store.import_video_store().unwrap().root, imported.root);
    assert_eq!(fs::read(old_file).unwrap(), b"existing media");
    assert_eq!(fs::read_dir(&imported.root).unwrap().count(), 0);
}

#[test]
fn workspace_and_project_paths_are_authorized_and_internal_roots_cannot_be_overwritten() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    for category in [
        "recording",
        "screenshot",
        "videogen",
        "imagegen",
        "musicgen",
    ] {
        let workspace = store.workspace_store(category).unwrap();
        assert_eq!(
            workspace.root,
            app_data.path().join(category).canonicalize().unwrap()
        );
        let path = workspace.root.join("asset.dat");
        fs::write(&path, b"retained asset").unwrap();
        assert_eq!(store.authorized_path(&asset_path(&path)).unwrap(), path);
        assert!(store.is_internal_path(&workspace.root));
    }
    for invalid in ["", "../outside", "projects", "imaggen", "media"] {
        assert!(store.workspace_store(invalid).is_err());
    }
    for name in ["recordings", "projects/project-a/assets"] {
        let root = app_data.path().join(name);
        fs::create_dir_all(&root).unwrap();
        let old = root.join("old.mp4");
        fs::write(&old, b"existing project reference").unwrap();
        let canonical = old.canonicalize().unwrap();
        assert_eq!(store.authorized_path(&asset_path(&old)).unwrap(), canonical);
        assert!(store.is_internal_path(&canonical));
        assert_eq!(fs::read(&old).unwrap(), b"existing project reference");
    }
}

#[cfg(unix)]
#[test]
fn workspace_and_project_root_links_cannot_authorize_external_files() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let file = outside.path().join("asset.mp4");
    fs::write(&file, b"external asset").unwrap();
    for name in [
        "recording",
        "recordings",
        "screenshot",
        "videogen",
        "imagegen",
        "musicgen",
        "projects",
    ] {
        symlink(outside.path(), app_data.path().join(name)).unwrap();
        assert!(store
            .authorized_path(&asset_path(&app_data.path().join(name).join("asset.mp4")))
            .is_err());
        assert!(!store.is_internal_path(&file));
        assert!(store.workspace_store(name).is_err());
    }
}

#[test]
fn a_regular_file_cannot_be_used_as_the_imported_video_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let path = app_data.path().join("import video");
    fs::write(&path, b"keep this file").unwrap();
    assert!(store.import_video_root().is_err());
    assert!(store.import_video_store().is_err());
    assert!(store.authorized_path(&asset_path(&path)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"keep this file");
}

#[cfg(unix)]
#[test]
fn imported_video_directory_cannot_be_redirected_outside_the_application_store() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let file = outside.path().join("video.mp4");
    fs::write(&file, b"outside fixture").unwrap();
    symlink(outside.path(), app_data.path().join("import video")).unwrap();
    assert!(store.import_video_root().is_err());
    assert!(store.import_video_store().is_err());
    assert!(store
        .authorized_path(&asset_path(&app_data.path().join("import video/video.mp4")))
        .is_err());
    assert!(store.authorized_path(&asset_path(&file)).is_err());
    assert!(!store.is_internal_path(&file));
    let regular_media = store.root.join("ordinary.mp4");
    fs::write(&regular_media, b"ordinary fixture").unwrap();
    assert_eq!(
        store.authorized_path(&asset_path(&regular_media)).unwrap(),
        regular_media
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn replacing_an_existing_imported_video_directory_does_not_authorize_its_link_target() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let imported = store.import_video_store().unwrap();
    fs::write(outside.path().join("video.mp4"), b"outside fixture").unwrap();
    fs::remove_dir(&imported.root).unwrap();
    symlink(outside.path(), &imported.root).unwrap();
    let linked_file = imported.root.join("video.mp4");
    assert!(store.authorized_path(&asset_path(&linked_file)).is_err());
    assert!(imported.authorized_path(&asset_path(&linked_file)).is_err());
    assert!(!store.is_internal_path(&linked_file.canonicalize().unwrap()));
    assert!(store.import_video_store().is_err());
}

#[cfg(unix)]
#[test]
fn a_link_inside_imported_videos_does_not_authorize_an_external_media_file() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let imported = store.import_video_store().unwrap();
    let file = outside.path().join("video.mp4");
    fs::write(&file, b"outside fixture").unwrap();
    let linked = imported.root.join("linked.mp4");
    symlink(&file, &linked).unwrap();
    assert!(store.authorized_path(&asset_path(&linked)).is_err());
    assert!(imported.authorized_path(&asset_path(&linked)).is_err());
    assert!(!store.is_internal_path(&linked.canonicalize().unwrap()));
}

#[test]
fn a_regular_file_cannot_be_used_as_the_recordings_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let path = app_data.path().join("recording");
    fs::write(&path, b"keep this file").unwrap();
    assert!(store.recording_root().is_err());
    assert!(store.recording_store().is_err());
    assert!(store.authorized_path(&asset_path(&path)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"keep this file");
}

#[cfg(unix)]
#[test]
fn recordings_directory_cannot_be_redirected_outside_the_application_store() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let file = outside.path().join("video.mp4");
    fs::write(&file, b"outside fixture").unwrap();
    symlink(outside.path(), app_data.path().join("recording")).unwrap();
    assert!(store.recording_root().is_err());
    assert!(store.recording_store().is_err());
    assert!(store
        .authorized_path(&asset_path(&app_data.path().join("recording/video.mp4")))
        .is_err());
    assert!(store.authorized_path(&asset_path(&file)).is_err());
    let regular_media = store.root.join("ordinary.mp4");
    fs::write(&regular_media, b"ordinary fixture").unwrap();
    assert_eq!(
        store.authorized_path(&asset_path(&regular_media)).unwrap(),
        regular_media
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn replacing_an_existing_recordings_directory_does_not_authorize_its_link_target() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    fs::write(outside.path().join("video.mp4"), b"outside fixture").unwrap();
    fs::remove_dir(&recordings.root).unwrap();
    symlink(outside.path(), &recordings.root).unwrap();
    let linked_file = recordings.root.join("video.mp4");
    assert!(store.authorized_path(&asset_path(&linked_file)).is_err());
    assert!(recordings
        .authorized_path(&asset_path(&linked_file))
        .is_err());
    assert!(store.recording_store().is_err());
}

#[cfg(unix)]
#[test]
fn a_link_inside_recordings_does_not_authorize_an_external_media_file() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    let file = outside.path().join("video.mp4");
    fs::write(&file, b"outside fixture").unwrap();
    let linked = recordings.root.join("linked.mp4");
    symlink(&file, &linked).unwrap();
    assert!(store.authorized_path(&asset_path(&linked)).is_err());
    assert!(recordings.authorized_path(&asset_path(&linked)).is_err());
}

fn make_video(runtime: &Runtime, path: &Path) {
    let output = process(&runtime.encoder)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x48:r=10:d=0.6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.6",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "0.6",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_red_video(runtime: &Runtime, path: &Path) {
    let decoded = process(&runtime.encoder)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-vf",
            "scale=1:1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    assert_eq!(decoded.stdout.len(), 3);
    assert!(
        decoded.stdout[0] > 180 && decoded.stdout[1] < 50 && decoded.stdout[2] < 50,
        "decoded recording must retain the red source frame: {:?}",
        decoded.stdout
    );
}

fn run_export(store: &MediaStore, runtime: &Runtime, spec: &Value, output: &Path) {
    let plan = build_plan(store, runtime, spec).unwrap();
    let jobs = JobManager::default();
    let job = jobs.begin(runtime, plan, output.to_path_buf()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let current = jobs
            .list()
            .into_iter()
            .find(|item| item.id == job.id)
            .unwrap();
        if current.state != "running" {
            assert_eq!(current.state, "completed", "{:?}", current.error);
            break;
        }
        if Instant::now() >= deadline {
            jobs.cancel_all();
            panic!("recording export timed out: {}", output.display());
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_red_video(runtime, output);
}

#[test]
fn library_video_imports_and_blobs_keep_sources_and_work_in_conversion_and_gif_export() {
    let app_data = tempfile::tempdir().unwrap();
    let runtime =
        Runtime::discover(None, None).expect("Media runtime required for library import checks");
    let store = MediaStore::new(app_data.path()).unwrap();
    let source = app_data.path().join("source.mp4");
    make_video(&runtime, &source);
    let bytes = fs::read(&source).unwrap();
    let ordinary = store
        .import(&runtime, &source, Some("普通素材.mp4"))
        .unwrap();
    let imported = store
        .import_for_library(&runtime, &source, Some("手动导入视频.mp4"))
        .unwrap();
    let blob = store
        .import_bytes_for_library(&runtime, &bytes, "拖入视频.mp4")
        .unwrap();
    let imported_store = store.import_video_store().unwrap();
    assert_eq!(
        Path::new(&ordinary.native_path).parent(),
        Some(store.root.as_path())
    );
    for asset in [&imported, &blob] {
        assert_eq!(asset.kind, "video");
        assert_eq!(
            Path::new(&asset.native_path).parent(),
            Some(imported_store.root.as_path())
        );
        assert_eq!(fs::read(&asset.native_path).unwrap(), bytes);
        assert_eq!(
            store
                .authorized_path(&serde_json::to_value(asset).unwrap())
                .unwrap(),
            Path::new(&asset.native_path)
        );
        assert_eq!(
            media_metadata::original_name(&imported_store, Path::new(&asset.native_path)),
            Some(asset.name.clone())
        );
        assert_eq!(
            media_metadata::original_name(&store, Path::new(&asset.native_path)),
            None
        );
    }
    assert_ne!(imported.native_path, blob.native_path);
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(fs::read(&ordinary.native_path).unwrap(), bytes);

    let reopened = MediaStore::new(app_data.path()).unwrap();
    let asset = serde_json::to_value(&imported).unwrap();
    let preview = create_preview(&reopened, &runtime, &asset, None).unwrap();
    assert_red_video(&runtime, Path::new(&preview.path));
    for (name, spec, has_audio) in [
        (
            "imported-segment.gif",
            json!({
                "kind": "gif", "asset": asset,
                "segments": [{ "start": 0, "end": 0.5 }],
                "width": 64, "fps": 10, "loop": false
            }),
            false,
        ),
        (
            "converted-import.mp4",
            json!({
                "kind": "convert", "asset": asset, "format": "mp4",
                "width": 64, "height": 48, "fps": 10,
                "trimStart": 0, "trimEnd": 0.5
            }),
            true,
        ),
    ] {
        let output = app_data.path().join(name);
        run_export(&reopened, &runtime, &spec, &output);
        let converted = reopened.probe(&runtime, &output, name).unwrap();
        assert_eq!((converted.width, converted.height), (64, 48), "{name}");
        assert!((converted.duration - 0.5).abs() < 0.15, "{name}");
        assert_eq!(reopened.has_audio(&runtime, &output), has_audio, "{name}");
    }
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn library_imports_keep_audio_and_images_in_media_even_with_video_extensions() {
    let app_data = tempfile::tempdir().unwrap();
    let runtime =
        Runtime::discover(None, None).expect("Media runtime required for import isolation checks");
    let store = MediaStore::new(app_data.path()).unwrap();
    let imported_store = store.import_video_store().unwrap();
    let audio_path = app_data.path().join("audio.mp4");
    let output = process(&runtime.encoder)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.2",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
        ])
        .arg(&audio_path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let image_path = app_data.path().join("image.mp4");
    {
        let output = fs::File::create(&image_path).unwrap();
        let mut encoder = png::Encoder::new(output, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[255, 0, 0]).unwrap();
        writer.finish().unwrap();
    }
    for (path, kind) in [(&audio_path, "audio"), (&image_path, "image")] {
        let original_bytes = fs::read(path).unwrap();
        let asset = store
            .import_for_library(&runtime, path, Some("误用视频扩展名.mp4"))
            .unwrap();
        let blob = store
            .import_bytes_for_library(&runtime, &original_bytes, "拖入误用扩展名.mp4")
            .unwrap();
        for imported in [&asset, &blob] {
            assert_eq!(imported.kind, kind);
            assert_eq!(
                Path::new(&imported.native_path).parent(),
                Some(store.root.as_path())
            );
            assert_eq!(fs::read(&imported.native_path).unwrap(), original_bytes);
        }
        assert_eq!(fs::read(path).unwrap(), original_bytes);
    }
    assert_eq!(fs::read_dir(&imported_store.root).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn library_import_probes_each_file_once() {
    use std::os::unix::fs::PermissionsExt;
    let app_data = tempfile::tempdir().unwrap();
    let runtime =
        Runtime::discover(None, None).expect("Media runtime required for import probe checks");
    let store = MediaStore::new(app_data.path()).unwrap();
    let source = app_data.path().join("source.mp4");
    make_video(&runtime, &source);
    let count_path = app_data.path().join("probe-count");
    let wrapper_path = app_data.path().join("count-probe.sh");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    fs::write(
        &wrapper_path,
        format!(
            "#!/bin/sh\nprintf x >> {}\nexec {} \"$@\"\n",
            quote(&count_path),
            quote(&runtime.probe)
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o700)).unwrap();
    let counted_runtime = Runtime {
        probe: wrapper_path,
        ..runtime
    };
    let imported = store
        .import_for_library(&counted_runtime, &source, Some("单次读取.mp4"))
        .unwrap();
    assert_eq!(imported.kind, "video");
    assert_eq!(fs::read(&count_path).unwrap(), b"x");
    let blob = store
        .import_bytes_for_library(
            &counted_runtime,
            &fs::read(&source).unwrap(),
            "单次读取拖入.mp4",
        )
        .unwrap();
    assert_eq!(blob.kind, "video");
    assert_eq!(fs::read(count_path).unwrap(), b"xx");
    assert!(source.is_file());
}

#[test]
fn recording_import_preserves_its_name_and_remains_usable_in_preview_and_export() {
    let app_data = tempfile::tempdir().unwrap();
    let runtime =
        Runtime::discover(None, None).expect("Media runtime required for recording checks");
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    let source = app_data.path().join("source.mp4");
    make_video(&runtime, &source);
    let imported = store
        .import(&runtime, &source, Some("普通导入.mp4"))
        .unwrap();
    let recorded = recordings
        .import(&runtime, &source, Some("屏幕录制 2026-10-18.mp4"))
        .unwrap();
    assert_eq!(
        Path::new(&imported.native_path).parent(),
        Some(store.root.as_path())
    );
    assert_eq!(
        Path::new(&recorded.native_path).parent(),
        Some(recordings.root.as_path())
    );
    assert_eq!(
        fs::read(&recorded.native_path).unwrap(),
        fs::read(&source).unwrap()
    );
    fs::remove_file(&source).unwrap();

    let reopened = MediaStore::new(app_data.path()).unwrap();
    let reopened_recordings = reopened.recording_store().unwrap();
    assert_eq!(
        media_metadata::original_name(&reopened_recordings, Path::new(&recorded.native_path)),
        Some(recorded.name.clone())
    );
    assert_eq!(
        media_metadata::original_name(&reopened, Path::new(&imported.native_path)),
        Some(imported.name.clone())
    );
    assert_eq!(
        media_metadata::original_name(&reopened, Path::new(&recorded.native_path)),
        None,
        "display-name records belong to their own store"
    );

    let asset = serde_json::to_value(&recorded).unwrap();
    let preview = create_preview(&reopened, &runtime, &asset, None).unwrap();
    assert!(Path::new(&preview.path).starts_with(reopened.root.join("preview")));
    assert_red_video(&runtime, Path::new(&preview.path));

    let output = app_data.path().join("exported-recording.mp4");
    run_export(
        &reopened,
        &runtime,
        &json!({
            "kind": "timeline",
            "project": {
                "title": "录屏素材导出检查", "width": 64, "height": 48, "background": "#000000",
                "assets": [asset],
                "tracks": [{ "kind": "video", "muted": false, "clips": [{
                    "id": "recorded-clip", "assetId": recorded.id, "start": 0,
                    "trimIn": 0, "trimOut": 0.6, "speed": 1, "volume": 1,
                    "opacity": 1, "x": 0, "y": 0, "width": 64, "height": 48,
                    "rotation": 0, "fit": "contain", "fadeIn": 0, "fadeOut": 0
                }] }]
            },
            "config": { "format": "mp4", "width": 64, "height": 48, "fps": 10, "quality": "balanced" }
        }),
        &output,
    );
    let output_asset = reopened
        .probe(&runtime, &output, "exported-recording.mp4")
        .unwrap();
    assert_eq!((output_asset.width, output_asset.height), (64, 48));
    assert!((output_asset.duration - 0.6).abs() < 0.2);
    assert!(reopened.has_audio(&runtime, &output));

    for (name, spec, has_audio) in [
        (
            "recording-segment.gif",
            json!({
                "kind": "gif", "asset": asset,
                "segments": [{ "start": 0, "end": 0.5 }],
                "width": 64, "fps": 10, "loop": false
            }),
            false,
        ),
        (
            "converted-recording.mp4",
            json!({
                "kind": "convert", "asset": asset, "format": "mp4",
                "width": 64, "height": 48, "fps": 10,
                "trimStart": 0, "trimEnd": 0.5
            }),
            true,
        ),
    ] {
        let output = app_data.path().join(name);
        run_export(&reopened, &runtime, &spec, &output);
        let converted = reopened.probe(&runtime, &output, name).unwrap();
        assert_eq!((converted.width, converted.height), (64, 48), "{name}");
        assert!(
            (converted.duration - 0.5).abs() < 0.15,
            "{name}: unexpected segment duration {}",
            converted.duration
        );
        assert_eq!(reopened.has_audio(&runtime, &output), has_audio, "{name}");
    }
}
