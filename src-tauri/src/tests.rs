use crate::{capture::parse_devices, engine::*};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};
fn runtime() -> Runtime {
    Runtime::discover(None, None).expect("Media runtime required for integration checks")
}
fn sample(root: &Path, runtime: &Runtime) -> Asset {
    let source = root.join("source.mp4");
    let out = process(&runtime.encoder)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x120:r=20:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x120:r=20:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=2",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "2",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    MediaStore::new(root)
        .unwrap()
        .import(runtime, &source, None)
        .unwrap()
}
fn wait(jobs: &JobManager, id: &str) -> MediaJob {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let item = jobs.list().into_iter().find(|j| j.id == id).unwrap();
        if item.state != "running" {
            return item;
        }
        assert!(Instant::now() < deadline, "job timeout");
        thread::sleep(Duration::from_millis(30));
    }
}
fn run(root: &Path, runtime: &Runtime, spec: Value, name: &str) -> (MediaJob, Value) {
    let store = MediaStore::new(root).unwrap();
    let jobs = JobManager::default();
    let target = root.join(name);
    let job = jobs
        .begin(
            runtime,
            build_plan(&store, runtime, &spec).unwrap(),
            target.clone(),
        )
        .unwrap();
    let job = wait(&jobs, &job.id);
    assert_eq!(job.state, "completed", "{:?}", job.error);
    let out = process(&runtime.probe)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(target)
        .output()
        .unwrap();
    assert!(out.status.success());
    (job, serde_json::from_slice(&out.stdout).unwrap())
}
#[test]
fn imported_asset_is_persistent_and_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    fs::remove_file(temp.path().join("source.mp4")).unwrap();
    assert_eq!(asset.kind, "video");
    assert_eq!(asset.width, 160);
    let restored = MediaStore::new(temp.path()).unwrap();
    assert!(restored
        .authorized_path(&serde_json::to_value(asset).unwrap())
        .is_ok());
    assert!(restored
        .authorized_path(&json!({"nativePath":"/etc/passwd"}))
        .is_err());
}
#[test]
fn convert_trim_has_expected_duration_and_audio() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (job, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"mp4","width":80,"height":60,"fps":10,"trimStart":0.25,"trimEnd":1.25}),
        "trim.mp4",
    );
    assert_eq!(job.progress, 1.0);
    assert_eq!(probe["streams"][0]["width"], 80);
    assert_eq!(probe["streams"][0]["height"], 60);
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.0).abs() < 0.15);
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
}
#[test]
fn gif_segments_preserve_requested_order() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"gif","asset":asset,"segments":[{"start":1.1,"end":1.7},{"start":0.1,"end":0.7}],"width":80,"fps":10,"loop":false}),
        "joined.gif",
    );
    assert_eq!(probe["streams"][0]["codec_name"], "gif");
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(temp.path().join("joined.gif"))
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
    assert!(pixels.status.success());
    assert!(
        pixels.stdout[2] > 200 && pixels.stdout[0] < 50,
        "first segment must be blue"
    );
}
#[test]
fn audio_extraction_and_image_conversion() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"wav","sampleRate":16000}),
        "sound.wav",
    );
    assert_eq!(probe["streams"][0]["codec_type"], "audio");
    assert_eq!(probe["streams"][0]["sample_rate"], "16000");
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"webp","width":64}),
        "image.webp",
    );
    assert_eq!(probe["streams"][0]["width"], 64);
}
fn clip(asset: &Asset) -> Value {
    json!({"id":"clip","assetId":asset.id,"name":"sample","start":0.2,"trimIn":0.0,"trimOut":2.0,"speed":2.0,"volume":0.8,"opacity":0.8,"x":20.0,"y":10.0,"width":100.0,"height":80.0,"rotation":15.0,"fit":"contain","fadeIn":0.1,"fadeOut":0.1})
}
#[test]
fn timeline_composites_audio_transform_and_text_image() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let png = temp.path().join("caption.png");
    let result = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=yellow:s=60x20",
            "-frames:v",
            "1",
            "-threads",
            "1",
        ])
        .arg(&png)
        .output()
        .unwrap();
    assert!(result.status.success());
    let store = MediaStore::new(temp.path()).unwrap();
    let caption = store.import(&rt, &png, None).unwrap();
    let mut text = clip(&caption);
    text["id"] = json!("title");
    text["start"] = json!(0);
    text["trimOut"] = json!(1.2);
    text["speed"] = json!(1);
    text["rotation"] = json!(0);
    text["width"] = json!(60);
    text["height"] = json!(20);
    text["x"] = json!(30);
    text["y"] = json!(30);
    text["opacity"] = json!(1);
    text["fadeIn"] = json!(0);
    text["fadeOut"] = json!(0);
    let spec = json!({"kind":"timeline","project":{"title":"project","width":160,"height":120,"background":"#003300","assets":[asset.clone()],"tracks":[{"kind":"text","muted":false,"clips":[text]},{"kind":"video","muted":false,"clips":[clip(&asset)]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"balanced"},"textAssets":{"title":caption}});
    let (_, probe) = run(temp.path(), &rt, spec, "timeline.mp4");
    assert_eq!(probe["streams"][0]["width"], 160);
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.2).abs() < 0.15);
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-ss", "0.6", "-i"])
        .arg(temp.path().join("timeline.mp4"))
        .args([
            "-vf",
            "crop=2:2:40:40,scale=1:1",
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
    assert!(pixels.status.success());
    assert!(
        pixels.stdout[0] > 180 && pixels.stdout[1] > 180 && pixels.stdout[2] < 70,
        "foreground caption expected yellow, got {:?}",
        pixels.stdout
    );
}
#[test]
fn cancelling_output_preserves_existing_file() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let jobs = JobManager::default();
    let target = temp.path().join("existing.mp4");
    fs::write(&target, b"original-file").unwrap();
    let plan = RenderPlan {
        args: vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=s=1920x1080:r=30:d=300".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "slow".into(),
        ],
        duration: 300.0,
        format: "mp4".into(),
        workspace: tempfile::tempdir().unwrap(),
    };
    let job = jobs.begin(&rt, plan, target.clone()).unwrap();
    jobs.cancel(&job.id).unwrap();
    assert_eq!(wait(&jobs, &job.id).state, "cancelled");
    assert_eq!(fs::read(target).unwrap(), b"original-file");
}
#[test]
fn validates_ranges_and_malformed_jobs() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let rt = runtime();
    assert!(build_plan(&store, &rt, &json!({"kind":"shell","command":"bad"})).is_err());
    assert!(number(&json!({"fps":500}), "fps", 30.0, 1.0, 120.0).is_err());
    assert!(
        suggested_output(&json!({"kind":"convert","asset":{"name":"x"},"format":"exe"})).is_err()
    );
}
#[test]
fn capture_device_parsing_distinguishes_screen_and_microphone() {
    let mac="[AVFoundation indev @ 0] AVFoundation video devices:\n[AVFoundation indev @ 0] [0] Camera\n[AVFoundation indev @ 0] [1] Capture screen 0\n[AVFoundation indev @ 0] AVFoundation audio devices:\n[AVFoundation indev @ 0] [0] Built-in Microphone";
    let devices = parse_devices(mac, true);
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].id, "1");
    assert_eq!(devices[0].kind, "screen");
    assert_eq!(devices[1].kind, "audio");
    let devices = parse_devices(
        "[dshow @ 0] \"Mic\" (audio)\n[dshow @ 0] Alternative name \"@device\"",
        false,
    );
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "Mic");
}

#[test]
fn muted_video_keeps_picture_and_excludes_sound() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"timeline","project":{"width":160,"height":120,"background":"#000000","assets":[asset.clone()],"tracks":[{"kind":"video","muted":true,"clips":[clip(&asset)]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"draft"}}),
        "muted.mp4",
    );
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "video"));
    assert!(!probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-ss", "0.4", "-i"])
        .arg(temp.path().join("muted.mp4"))
        .args([
            "-vf",
            "crop=2:2:70:50,scale=1:1",
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
        pixels.stdout[0] > 120,
        "muting must retain red video picture"
    );
}

#[test]
fn container_encoders_and_odd_image_dimensions() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    for format in ["webm", "mov", "mkv", "mp3", "aac", "flac"] {
        let (_, probe) = run(
            temp.path(),
            &rt,
            json!({"kind":"convert","asset":asset,"format":format,"trimStart":0,"trimEnd":0.4,"width":80,"fps":10}),
            &format!("codec.{format}"),
        );
        assert!(!probe["streams"].as_array().unwrap().is_empty());
    }
    let input = temp.path().join("odd.png");
    let output = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=17x19",
            "-frames:v",
            "1",
            "-threads",
            "1",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let image = MediaStore::new(temp.path())
        .unwrap()
        .import(&rt, &input, None)
        .unwrap();
    for format in ["png", "jpg", "webp", "bmp", "tiff"] {
        let (_, probe) = run(
            temp.path(),
            &rt,
            json!({"kind":"convert","asset":image,"format":format}),
            &format!("odd-output.{format}"),
        );
        assert_eq!(probe["streams"][0]["width"], 17);
        assert_eq!(probe["streams"][0]["height"], 19);
    }
}
