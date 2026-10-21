//! Opt-in validation of actual browser-composed projects through the native encoder.
use super::*;

#[test]
#[ignore = "requires a browser-generated project and its real media files"]
fn browser_composed_motion_style_exports_real_frames_and_audio() {
    let fixture = std::env::var_os("OPEN_MEDIA_MOTION_FIXTURE")
        .expect("set OPEN_MEDIA_MOTION_FIXTURE to a prepared project JSON file");
    let fixture = Path::new(&fixture);
    let folder = fixture.parent().unwrap();
    let mut prepared: Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let store = MediaStore::new(temp.path()).unwrap();
    let mut copied = std::collections::HashMap::<String, String>::new();
    let mut import = |asset: &mut Value| {
        let source = asset["nativePath"]
            .as_str()
            .expect("fixture media path")
            .to_owned();
        let path = copied.entry(source.clone()).or_insert_with(|| {
            let name = asset["name"].as_str().unwrap_or("fixture.png");
            store
                .import(&rt, Path::new(&source), Some(name))
                .unwrap()
                .native_path
        });
        asset["nativePath"] = json!(path);
    };
    for asset in prepared["project"]["assets"].as_array_mut().unwrap() {
        import(asset);
    }
    for asset in prepared["textAssets"].as_object_mut().unwrap().values_mut() {
        import(asset);
    }
    let project = &prepared["project"];
    let width = project["width"].as_u64().unwrap();
    let height = project["height"].as_u64().unwrap();
    let fps = project["fps"].as_f64().unwrap();
    let clips: Vec<&Value> = project["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|track| track["clips"].as_array().unwrap())
        .collect();
    assert!(
        clips.iter().any(|clip| clip["keyframes"].is_object()),
        "fixture must exercise motion"
    );
    assert!(
        !prepared["textAssets"].as_object().unwrap().is_empty(),
        "fixture must exercise text rasterization"
    );
    assert!(project["assets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|asset| asset["kind"] == "video"));
    assert!(project["assets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|asset| asset["kind"] == "audio"));
    let spec = json!({
        "kind":"timeline", "project":project, "textAssets":prepared["textAssets"],
        "config":{"format":"mp4","width":width,"height":height,"fps":fps,"quality":"high"}
    });
    let plan = build_plan(&store, &rt, &spec).unwrap();
    let expected_duration = plan.duration;
    fs::copy(
        plan.workspace.path().join("filters.txt"),
        folder.join("native-export.ffgraph"),
    )
    .unwrap();
    let output = folder.join("native-export.mp4");
    let jobs = JobManager::default();
    let started = Instant::now();
    // Exercise the same owned render path used by generated editor video clips.
    let manager = crate::motion_clip::MotionClipManager::default();
    let mut render_request = spec.clone();
    render_request.as_object_mut().unwrap().remove("kind");
    let pending = manager.begin(&store, &rt, &jobs, &render_request).unwrap();
    let completed = wait(&jobs, &pending.id);
    assert_eq!(completed.state, "completed", "{:?}", completed.error);
    assert!(completed.encoded_frames > 0);
    let generated = manager.result(&store, &rt, &jobs, &pending.id).unwrap();
    manager.accept(&store, &jobs, &pending.id).unwrap();
    fs::copy(&generated.native_path, &output).unwrap();
    let probe = process(&rt.probe)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(&output)
        .output()
        .unwrap();
    assert!(probe.status.success());
    let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
    let streams = probe["streams"].as_array().unwrap();
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .unwrap();
    assert_eq!(video["width"], width);
    assert_eq!(video["height"], height);
    assert!(streams.iter().any(|stream| stream["codec_type"] == "audio"));
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - expected_duration).abs() < 0.15);
    // Decode every output frame at thumbnail resolution to catch corrupt media,
    // an empty composition, or a frozen output without allocating full frames.
    let frames = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(&output)
        .args([
            "-an",
            "-vf",
            "scale=64:36",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        frames.status.success(),
        "{}",
        String::from_utf8_lossy(&frames.stderr)
    );
    let frame_bytes = 64 * 36 * 3;
    let count = frames.stdout.len() / frame_bytes;
    assert!((count as f64 - expected_duration * fps).abs() < 2.0);
    let thumbnails: Vec<_> = frames.stdout.chunks_exact(frame_bytes).collect();
    let varied = thumbnails
        .windows(2)
        .filter(|pair| {
            pair[0]
                .iter()
                .zip(pair[1])
                .map(|(left, right)| left.abs_diff(*right) as u64)
                .sum::<u64>()
                > 100
        })
        .count();
    assert!(
        varied > count / 5,
        "composition is unexpectedly static: {varied}/{count} changing frames"
    );
    assert!(thumbnails
        .iter()
        .any(|frame| frame.iter().filter(|pixel| **pixel > 32).count() > frame_bytes / 4));
    let report = json!({"fixture":fixture,"output":output,"runtime":rt.version,"elapsedSeconds":started.elapsed().as_secs_f64(),"duration":duration,"decodedFrames":count,"changingFrames":varied,"job":completed,"probe":probe});
    fs::write(
        folder.join("native-export-report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "MOTION_NATIVE_EXPORT {}",
        serde_json::to_string(&report).unwrap()
    );
}
