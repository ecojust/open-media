use super::*;
use std::path::PathBuf;

fn fixture(seconds: &str) -> (tempfile::TempDir, AssetTools, MediaStore, Runtime, Value) {
    let directory = tempfile::tempdir().unwrap();
    let tools = AssetTools::new(directory.path()).unwrap();
    let store = MediaStore::new(directory.path()).unwrap();
    let runtime = Runtime::discover(None, None).expect("Preview checks require the media runtime");
    let input = store.root.join("original.avi");
    let output = engine::process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            seconds,
            "-c:v",
            "mpeg4",
            "-q:v",
            "2",
            "-c:a",
            "pcm_s16le",
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
    let asset =
        serde_json::to_value(store.probe(&runtime, &input, "original.avi").unwrap()).unwrap();
    (directory, tools, store, runtime, asset)
}

#[test]
fn restored_asset_preview_is_decodable_cached_and_preserves_source() {
    let (_directory, tools, store, runtime, asset) = fixture("0.6");
    let original = PathBuf::from(asset["nativePath"].as_str().unwrap());
    let before = fs::read(&original).unwrap();
    let args = json!({ "asset": asset, "format": "mp4" });
    let result = tools
        .execute(
            &store,
            &runtime,
            "preview-first",
            "asset_prepare_preview",
            &args,
        )
        .unwrap();
    let output = PathBuf::from(result["path"].as_str().unwrap());
    assert!(output.starts_with(store.root.join("preview")));
    let content = fs::read(&output).unwrap();
    assert!(!content.is_empty());
    let decoded = engine::process(&runtime.encoder)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(&output)
        .args(["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    let mut cache_runtime = runtime.clone();
    cache_runtime.encoder = PathBuf::from("/missing/encoder");
    let cached = tools
        .execute(
            &store,
            &cache_runtime,
            "preview-cached",
            "asset_prepare_preview",
            &args,
        )
        .unwrap();
    assert_eq!(result, cached);
    assert_eq!(fs::read(&original).unwrap(), before);
    assert_eq!(fs::read(&output).unwrap(), content);
    assert!(tools
        .execute(
            &store,
            &runtime,
            "preview-invalid-format",
            "asset_prepare_preview",
            &json!({"asset":asset,"format":5})
        )
        .is_err());
}

#[test]
fn restored_asset_preview_cancel_cleans_partial_and_retains_completed_cache() {
    let (_directory, tools, store, runtime, asset) = fixture("8");
    let original = PathBuf::from(asset["nativePath"].as_str().unwrap());
    let before = fs::read(&original).unwrap();
    let ready = tools
        .execute(
            &store,
            &runtime,
            "preview-retained",
            "asset_prepare_preview",
            &json!({"asset":asset,"format":"mp4"}),
        )
        .unwrap();
    let cached = PathBuf::from(ready["path"].as_str().unwrap());
    let cached_bytes = fs::read(&cached).unwrap();
    let worker_tools = tools.clone();
    let worker_store = store.clone();
    let mut worker_runtime = runtime.clone();
    #[cfg(unix)]
    let encoder_pid = {
        use std::os::unix::fs::PermissionsExt;
        let pid_path = store.root.join("preview-encoder.pid");
        let wrapper = store.root.join("preview-encoder.sh");
        let quote = |value: &Path| format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"));
        fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nprintf '%s' \"$$\" > {}\nexec {} \"$@\"\n",
                quote(&pid_path),
                quote(&runtime.encoder)
            ),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        worker_runtime.encoder = wrapper;
        pid_path
    };
    let worker_asset = asset.clone();
    let worker = thread::spawn(move || {
        worker_tools.execute(
            &worker_store,
            &worker_runtime,
            "preview-cancel-live",
            "asset_prepare_preview",
            &json!({"asset":worker_asset,"format":"webm"}),
        )
    });
    let preview = store.root.join("preview");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let partial_exists = fs::read_dir(&preview)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.path() != cached);
        #[cfg(unix)]
        let encoder_started = fs::read_to_string(&encoder_pid).is_ok_and(|value| !value.is_empty());
        #[cfg(not(unix))]
        let encoder_started = true;
        if partial_exists && encoder_started {
            break;
        }
        assert!(
            !worker.is_finished(),
            "Preview finished before cancellation could be exercised"
        );
        assert!(Instant::now() < deadline, "Preview did not start");
        thread::sleep(Duration::from_millis(5));
    }
    let started = Instant::now();
    assert!(tools.cancel("preview-cancel-live").unwrap());
    assert!(worker.join().unwrap().unwrap_err().contains("取消"));
    assert!(started.elapsed() < Duration::from_secs(3));
    #[cfg(unix)]
    assert!(
        !Command::new("kill")
            .args(["-0", fs::read_to_string(&encoder_pid).unwrap().trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success(),
        "Cancelled preview encoder must be reaped"
    );
    assert_eq!(fs::read_dir(&preview).unwrap().count(), 1);
    assert_eq!(fs::read(&cached).unwrap(), cached_bytes);
    assert_eq!(fs::read(&original).unwrap(), before);
    assert!(tools.0.tasks.lock().unwrap().is_empty());
    tools.cancel("preview-cancel-before").unwrap();
    assert!(tools
        .execute(
            &store,
            &runtime,
            "preview-cancel-before",
            "asset_prepare_preview",
            &json!({"asset":asset,"format":"webm"})
        )
        .unwrap_err()
        .contains("取消"));
}
