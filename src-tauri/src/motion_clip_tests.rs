use super::*;

fn runtime() -> Runtime {
    Runtime::discover(None, None).expect("real media tools are required")
}

fn png() -> Vec<u8> {
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, 32, 32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut pixels = vec![0; 32 * 32 * 4];
        for y in 4..28 {
            for x in 4..28 {
                let i = (y * 32 + x) * 4;
                pixels[i..i + 4].copy_from_slice(&[0, 255, 20, 255]);
            }
        }
        writer.write_image_data(&pixels).unwrap();
    }
    bytes
}

fn fixture(store: &MediaStore, runtime: &Runtime) -> Asset {
    let source = store.root.join("source.mp4");
    let output = engine::process(&runtime.encoder)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=160x90:r=24:d=0.8",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.8:sample_rate=48000",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "1",
            "-c:a",
            "aac",
            "-shortest",
            "-y",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    store.probe(runtime, &source, "source.mp4").unwrap()
}

fn spec(source: &Asset, overlay: &Asset, scope: &str, duration: f64) -> Value {
    json!({"scopeId":scope,"project":{"width":1440,"height":810,"fps":48,"background":"#101018",
        "assets":[source,overlay],"tracks":[
            {"kind":"text","clips":[{"id":"title","start":0,"trimIn":0,"trimOut":duration,"speed":1,
                "width":320,"height":180,"x":500,"y":300,"opacity":1,"volume":0,"fadeIn":0.1,"fadeOut":0.1}]},
            {"kind":"video","clips":[{"id":"video","assetId":source.id,"start":0,"trimIn":0,"trimOut":duration,
                "speed":1,"width":1440,"height":810,"x":0,"y":0,"opacity":1,"volume":0.4}]}]},
        "textAssets":{"title":overlay},"config":{"format":"mp4","width":1440,"height":810,"fps":48,"quality":"high"}})
}

fn finish(jobs: &JobManager, id: &str) -> MediaJob {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let job = jobs.get(id).unwrap();
        if job.state != "running" {
            return job;
        }
        assert!(
            Instant::now() < deadline,
            "motion clip render timeout: {}",
            job.stage
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn full_resolution_render_has_audio_and_accept_keeps_only_the_video() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let manager = MotionClipManager::default();
    let jobs = JobManager::default();
    let source = fixture(&store, &runtime);
    let scope = manager.create_scope(&store).unwrap();
    let overlay = manager
        .import_asset(&store, &runtime, &scope, &png(), "title.png")
        .unwrap();
    let imported = PathBuf::from(&overlay.native_path);
    let job = manager
        .begin(
            &store,
            &runtime,
            &jobs,
            &spec(&source, &overlay, &scope, 0.75),
        )
        .unwrap();
    assert!(
        manager.accept(&store, &jobs, &job.id).is_err(),
        "unverified output cannot be accepted"
    );
    assert!(manager
        .import_asset(&store, &runtime, &scope, &png(), "late.png")
        .is_err());
    let completed = finish(&jobs, &job.id);
    assert_eq!(completed.state, "completed", "{:?}", completed.error);
    let asset = manager.result(&store, &runtime, &jobs, &job.id).unwrap();
    assert_eq!((asset.width, asset.height), (1440, 810));
    assert!((asset.duration - 0.75).abs() < 0.12);
    assert!(
        !imported.exists(),
        "temporary raster layers are disposed after encoding"
    );
    assert!(
        Path::new(&source.native_path).exists(),
        "source media is retained"
    );
    let output = engine::process(&runtime.probe)
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(&asset.native_path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let probe: Value = serde_json::from_slice(&output.stdout).unwrap();
    let streams = probe["streams"].as_array().unwrap();
    assert!(streams.iter().any(|s| s["codec_type"] == "audio"));
    assert!(streams
        .iter()
        .any(|s| s["codec_type"] == "video" && s["avg_frame_rate"] == "48/1"));
    let decoded = engine::process(&runtime.encoder)
        .args(["-v", "error", "-i"])
        .arg(&asset.native_path)
        .args([
            "-vf",
            "scale=48:27",
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
    assert_eq!(decoded.stdout.len(), 48 * 27 * 3);
    assert!(
        decoded.stdout.iter().copied().max().unwrap()
            - decoded.stdout.iter().copied().min().unwrap()
            > 100
    );
    manager.accept(&store, &jobs, &job.id).unwrap();
    manager.accept(&store, &jobs, &job.id).unwrap();
    manager.discard(&store, &jobs, &job.id).unwrap();
    manager.discard(&store, &jobs, &scope).unwrap();
    assert!(
        Path::new(&asset.native_path).exists(),
        "accepted assets survive later discard and undo"
    );
}

#[test]
fn cancellation_cleans_long_render_and_never_touches_source_media() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let manager = MotionClipManager::default();
    let jobs = JobManager::default();
    let scope = manager.create_scope(&store).unwrap();
    let source = fixture(&store, &runtime);
    let overlay = manager
        .import_asset(&store, &runtime, &scope, &png(), "title.png")
        .unwrap();
    let mut input = spec(&source, &overlay, &scope, 65.0);
    // Use a still layer to exercise a duration beyond the temporary preview limit.
    input["project"]["tracks"][1]["clips"][0]["assetId"] = json!(overlay.id);
    let job = manager.begin(&store, &runtime, &jobs, &input).unwrap();
    jobs.cancel(&job.id).unwrap();
    manager.discard(&store, &jobs, &job.id).unwrap();
    manager.discard(&store, &jobs, &scope).unwrap();
    assert!(!store.root.join(format!("motion-clip-{scope}")).exists());
    assert!(Path::new(&source.native_path).exists());
    assert!(manager.result(&store, &runtime, &jobs, &job.id).is_err());
    assert!(manager.accept(&store, &jobs, &job.id).is_err());
}

#[test]
fn invalid_request_and_foreign_job_cannot_claim_or_delete_files() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let manager = MotionClipManager::default();
    let jobs = JobManager::default();
    let scope = manager.create_scope(&store).unwrap();
    let source = fixture(&store, &runtime);
    let overlay = manager
        .import_asset(&store, &runtime, &scope, &png(), "title.png")
        .unwrap();
    let mut input = spec(&source, &overlay, &scope, 0.5);
    input["outputPath"] = json!(source.native_path);
    assert!(manager.begin(&store, &runtime, &jobs, &input).is_err());
    input.as_object_mut().unwrap().remove("outputPath");
    input["config"]["width"] = json!(640);
    assert!(manager.begin(&store, &runtime, &jobs, &input).is_err());
    assert!(manager.discard(&store, &jobs, &source.native_path).is_err());
    assert!(manager
        .result(&store, &runtime, &jobs, "unrelated-job")
        .is_err());
    assert!(manager.accept(&store, &jobs, &scope).is_err());
    manager.discard(&store, &jobs, &scope).unwrap();
    manager.discard(&store, &jobs, &scope).unwrap();
    assert!(Path::new(&source.native_path).exists());
}

#[cfg(unix)]
#[test]
fn symlinked_input_directory_cannot_write_or_delete_external_files() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let manager = MotionClipManager::default();
    let jobs = JobManager::default();
    let scope = manager.create_scope(&store).unwrap();
    let inputs = store.root.join(format!("motion-clip-{scope}/inputs"));
    fs::remove_dir(&inputs).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let kept = outside.join("keep.txt");
    fs::write(&kept, b"untouched").unwrap();
    std::os::unix::fs::symlink(&outside, &inputs).unwrap();
    assert!(manager
        .import_asset(&store, &runtime, &scope, &png(), "title.png")
        .is_err());
    manager.discard(&store, &jobs, &scope).unwrap();
    assert_eq!(fs::read(kept).unwrap(), b"untouched");
}
