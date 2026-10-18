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
        app_data.path().join("recordings").canonicalize().unwrap()
    );
    assert_eq!(store.recording_root().unwrap(), recordings.root);
    assert_ne!(store.root, recordings.root);
    assert!(!recordings.root.starts_with(&store.root));
    assert_eq!(store.recording_store().unwrap().root, recordings.root);
    assert_eq!(MediaStore::new(app_data.path()).unwrap().root, store.root);
}

#[test]
fn main_store_accepts_both_media_roots_but_not_unrelated_siblings() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let recordings = store.recording_store().unwrap();
    for directory in [&store.root, &recordings.root] {
        let path = directory.join("video.mp4");
        fs::write(&path, b"media fixture").unwrap();
        assert_eq!(store.authorized_path(&asset_path(&path)).unwrap(), path);
    }
    for name in ["other", "media-other", "recordings-other"] {
        let directory = app_data.path().join(name);
        fs::create_dir(&directory).unwrap();
        let path = directory.join("video.mp4");
        fs::write(&path, b"media fixture").unwrap();
        assert!(store.authorized_path(&asset_path(&path)).is_err());
    }
    let outside = app_data.path().join("video.mp4");
    fs::write(&outside, b"media fixture").unwrap();
    assert!(store.authorized_path(&asset_path(&outside)).is_err());
}

#[test]
fn a_regular_file_cannot_be_used_as_the_recordings_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let store = MediaStore::new(app_data.path()).unwrap();
    let path = app_data.path().join("recordings");
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
    symlink(outside.path(), app_data.path().join("recordings")).unwrap();
    assert!(store.recording_root().is_err());
    assert!(store.recording_store().is_err());
    assert!(store
        .authorized_path(&asset_path(&app_data.path().join("recordings/video.mp4")))
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
