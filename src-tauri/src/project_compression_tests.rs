use super::*;
use serde_json::json;

fn runtime() -> Runtime {
    Runtime::discover(None, None).expect("real media tools available")
}
fn fixture(runtime: &Runtime, path: &Path, args: &[&str]) {
    let out = engine::process(&runtime.encoder)
        .args(["-hide_banner", "-nostdin", "-y", "-v", "error"])
        .args(args)
        .arg(path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn store() -> (tempfile::TempDir, MediaStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = MediaStore {
        root: dir.path().canonicalize().unwrap(),
    };
    (dir, store)
}
fn wait(manager: &CompressionManager, id: &str) -> CompressionJob {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let job = manager.get(id).unwrap();
        if job.state != "running" {
            return job;
        }
        assert!(
            Instant::now() < deadline,
            "timeout: {} {:?}",
            job.stage,
            job.message
        );
        thread::sleep(Duration::from_millis(30));
    }
}
fn decoded(runtime: &Runtime, path: &Path, map: &str) -> Vec<String> {
    let out = engine::process(&runtime.encoder)
        .args(["-v", "error", "-copyts", "-i"])
        .arg(path)
        .args([
            "-map",
            map,
            "-fps_mode",
            "passthrough",
            "-f",
            "framemd5",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
        .map(|line| line.split(',').last().unwrap().trim().to_string())
        .collect()
}
fn frames(runtime: &Runtime, path: &Path) -> Vec<f64> {
    let out = engine::process(&runtime.probe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    value["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|frame| numeric(&frame["best_effort_timestamp_time"]))
        .collect()
}
fn source(runtime: &Runtime, store: &MediaStore, name: &str) -> Value {
    serde_json::to_value(store.probe(runtime, &store.root.join(name), name).unwrap()).unwrap()
}

#[test]
fn lossless_preserves_pixels_two_audio_streams_and_timestamps_with_deduplication() {
    let runtime = runtime();
    let (_dir, store) = store();
    let input = store.root.join("source.mkv");
    fixture(
        &runtime,
        &input,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=25:d=1.2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:duration=1.2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:duration=1.2",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "pcm_s16le",
        ],
    );
    let original = fs::read(&input).unwrap();
    let asset = source(&runtime, &store, "source.mkv");
    let mut second = asset.clone();
    second["id"] = "same-source-other-id".into();
    let manager = CompressionManager::default();
    let start = manager
        .begin(
            &store,
            &runtime,
            vec![asset.clone(), second],
            "lossless".into(),
            "high".into(),
        )
        .unwrap();
    let done = wait(&manager, &start.id);
    assert_eq!(done.state, "completed", "{:?}", done.error);
    assert_eq!(done.total, 1);
    assert_eq!(done.items[0].source_ids.len(), 2);
    assert_eq!(done.items[0].state, "completed");
    let result = done.items[0].asset.as_ref().unwrap();
    let output = Path::new(&result.native_path);
    for map in ["0:v:0", "0:a:0", "0:a:1"] {
        assert_eq!(
            decoded(&runtime, &input, map),
            decoded(&runtime, output, map),
            "{map}"
        );
    }
    let a = frames(&runtime, &input);
    let b = frames(&runtime, output);
    assert_eq!(a.len(), b.len());
    for (a, b) in a.iter().zip(b) {
        assert!((a - b).abs() < 0.0011, "{a} {b}");
    }
    assert!(result.size < done.items[0].source_size);
    assert_eq!(fs::read(&input).unwrap(), original);
    manager.accept(&done.id).unwrap();
    manager.discard(&done.id).unwrap();
    assert!(output.exists());
    manager.shutdown();
    assert!(
        output.exists(),
        "accepted assets survive application shutdown"
    );
}

#[test]
fn quality_output_decodes_preserves_all_frames_and_discard_removes_only_copy() {
    let runtime = runtime();
    let (_dir, store) = store();
    let input = store.root.join("quality.mkv");
    fixture(
        &runtime,
        &input,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=30:d=1.2",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1.2",
            "-c:v",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "pcm_s16le",
        ],
    );
    let manager = CompressionManager::default();
    let start = manager
        .begin(
            &store,
            &runtime,
            vec![source(&runtime, &store, "quality.mkv")],
            "quality".into(),
            "balanced".into(),
        )
        .unwrap();
    let done = wait(&manager, &start.id);
    assert_eq!(done.state, "completed", "{:?}", done.error);
    let result = done.items[0].asset.as_ref().unwrap();
    let output = PathBuf::from(&result.native_path);
    assert_eq!(
        decoded(&runtime, &input, "0:v:0").len(),
        decoded(&runtime, &output, "0:v:0").len()
    );
    assert_eq!(
        decoded(&runtime, &input, "0:a:0"),
        decoded(&runtime, &output, "0:a:0")
    );
    manager.discard(&done.id).unwrap();
    assert!(!output.exists());
    assert!(input.exists());
}

#[test]
fn lossless_larger_result_is_skipped_and_cancel_cleans_temporary_outputs() {
    let runtime = runtime();
    let (_dir, store) = store();
    let input = store.root.join("small.mp4");
    fixture(
        &runtime,
        &input,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=160x90:r=15:d=0.8",
            "-c:v",
            "libx264",
            "-crf",
            "35",
            "-pix_fmt",
            "yuv420p",
        ],
    );
    let manager = CompressionManager::default();
    let start = manager
        .begin(
            &store,
            &runtime,
            vec![source(&runtime, &store, "small.mp4")],
            "lossless".into(),
            "balanced".into(),
        )
        .unwrap();
    let done = wait(&manager, &start.id);
    assert_eq!(done.state, "completed", "{:?}", done.error);
    assert_eq!(done.items[0].state, "skipped");
    assert!(done.items[0].asset.is_none());
    manager.discard(&done.id).unwrap();
    let start = manager
        .begin(
            &store,
            &runtime,
            vec![source(&runtime, &store, "small.mp4")],
            "quality".into(),
            "high".into(),
        )
        .unwrap();
    manager.cancel(&start.id).unwrap();
    let cancelled = wait(&manager, &start.id);
    assert_eq!(cancelled.state, "cancelled");
    manager.discard(&start.id).unwrap();
    assert_eq!(fs::read_dir(&store.root).unwrap().count(), 1);
    assert!(input.exists());
}

#[test]
fn unsupported_hdr_alpha_rotation_and_extra_streams_are_rejected_before_encoding() {
    let base = json!({"streams":[{"codec_type":"video","pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]});
    assert!(validate_source(&base).is_ok());
    for (key, value) in [
        ("pix_fmt", json!("yuva420p")),
        ("pix_fmt", json!("yuv420p10le")),
        ("color_transfer", json!("smpte2084")),
        ("color_primaries", json!("bt2020")),
        (
            "side_data_list",
            json!([{"side_data_type":"Display Matrix","rotation":90}]),
        ),
    ] {
        let mut info = base.clone();
        info["streams"][0][key] = value;
        assert!(validate_source(&info).is_err());
    }
    let mut extra = base.clone();
    extra["streams"]
        .as_array_mut()
        .unwrap()
        .push(json!({"codec_type":"subtitle"}));
    assert!(validate_source(&extra).is_err());
}

#[test]
fn variable_rate_nonzero_timestamps_and_aac_packets_remain_aligned() {
    let runtime = runtime();
    let (_dir, store) = store();
    let input = store.root.join("timed.mp4");
    fixture(
        &runtime,
        &input,
        &[
            "-copyts",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=160x90:r=25:d=1.2",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1.2",
            "-vf",
            r"setpts=PTS+2/TB+if(gte(N\,15)\,0.08/TB\,0)",
            "-af",
            "asetpts=PTS+2/TB",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-avoid_negative_ts",
            "disabled",
        ],
    );
    let asset = source(&runtime, &store, "timed.mp4");
    let flag = Arc::new(AtomicBool::new(false));
    let sources = prepare(&store, &runtime, vec![asset], &control(&flag)).unwrap();
    for mode in ["lossless", "quality"] {
        let jobs = JobManager::default();
        let output = store.root.join(format!("timed-result-{mode}.mp4"));
        let child = jobs
            .begin_with_overwrite(
                &runtime,
                build_plan(&sources[0], mode, "high").unwrap(),
                output.clone(),
                false,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let job = jobs.get(&child.id).unwrap();
            if job.state != "running" {
                assert_eq!(job.state, "completed", "{:?}", job.error);
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        let after = probe(&runtime, &output, &control(&flag)).unwrap();
        validate_output(
            &sources[0],
            &after,
            mode,
            &runtime,
            &output,
            &control(&flag),
        )
        .unwrap();
        let a = frames(&runtime, &input);
        let b = frames(&runtime, &output);
        assert_eq!(a.len(), b.len());
        assert!(a[0] > 1.9);
        for (a, b) in a.iter().zip(b) {
            assert!((a - b).abs() < 0.00001, "{a} {b}");
        }
        if mode == "lossless" {
            assert_eq!(
                decoded(&runtime, &input, "0:v:0"),
                decoded(&runtime, &output, "0:v:0")
            );
        }
        assert_eq!(
            decoded(&runtime, &input, "0:a:0"),
            decoded(&runtime, &output, "0:a:0")
        );
    }
}

#[test]
fn compression_preview_is_owned_cancellable_and_cleaned_with_the_job() {
    let runtime = runtime();
    let (_dir, store) = store();
    let input = store.root.join("preview-source.mp4");
    fixture(
        &runtime,
        &input,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=30:d=8",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ],
    );
    let manager = CompressionManager::default();
    let job = manager
        .begin(
            &store,
            &runtime,
            vec![source(&runtime, &store, "preview-source.mp4")],
            "lossless".into(),
            "high".into(),
        )
        .unwrap();
    let done = wait(&manager, &job.id);
    assert_eq!(done.state, "completed", "{:?}", done.error);
    let asset = done.items[0].asset.as_ref().unwrap();
    let output = PathBuf::from(&asset.native_path);
    assert!(manager
        .prepare_preview(&job.id, "unrelated-asset", Some("mp4"), &store, &runtime)
        .is_err());
    let worker_manager = manager.clone();
    let worker_store = store.clone();
    let worker_runtime = runtime.clone();
    let id = job.id.clone();
    let asset_id = asset.id.clone();
    let worker = thread::spawn(move || {
        worker_manager.prepare_preview(&id, &asset_id, Some("webm"), &worker_store, &worker_runtime)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let started = output
            .parent()
            .unwrap()
            .join("preview")
            .read_dir()
            .is_ok_and(|mut files| files.next().is_some());
        if started {
            break;
        }
        assert!(Instant::now() < deadline, "preview did not start");
        thread::sleep(Duration::from_millis(5));
    }
    let started = Instant::now();
    assert!(
        manager.accept(&job.id).is_err(),
        "active preview cannot be accepted"
    );
    manager.discard(&job.id).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!output.exists());
    assert!(input.exists());
    assert_eq!(fs::read_dir(&store.root).unwrap().count(), 1);
}
