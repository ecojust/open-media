use super::*;

fn catalog() -> Catalog {
    serde_json::from_str(MODEL_CATALOG).unwrap()
}
fn request() -> VideoGenerationRequest {
    serde_json::from_value(json!({"requestId":"generation-test","modelId":"h3-base-fl2va","mode":"prompt","width":512,"height":512,"steps":20,"seed":1,"lowMemory":true,"joinShots":true,"shots":[{"id":"shot-1","title":"开场","prompt":"云层上方的日出","seconds":2}]})).unwrap()
}

#[test]
fn video_generation_catalog_is_pinned_and_deduplicated() {
    let catalog = catalog();
    validate_catalog(&catalog).unwrap();
    assert_eq!(catalog.models.len(), 2);
    let base = &catalog.models[0];
    let reference = &catalog.models[1];
    let base_files = model_files(&catalog, base).unwrap();
    let all = model_files(&catalog, reference).unwrap();
    assert!(all.len() > base_files.len());
    assert!(all.iter().any(|f| f.path.starts_with("FL2VA/")));
    assert!(all.iter().any(|f| f.path.starts_with("Ref2VA/")));
    assert!(unique_bytes(&all) < all.iter().map(|file| file.size).sum());
    for file in all {
        assert!(file.urls.iter().all(|url| url.contains(&catalog.revision)));
    }
}

#[test]
fn video_generation_request_rejects_unsupported_combinations_and_bounds() {
    let catalog = catalog();
    let valid = request();
    validate_request(&valid, &catalog).unwrap();
    let mut invalid = valid.clone();
    invalid.model_id = "not-existing".into();
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.width = 513;
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.width = 2048;
    invalid.height = 2048;
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.shots[0].prompt.push('\0');
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.request_id = "../../escape".into();
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.shots[0].seconds = f64::NAN;
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.shots[0].title = "长".repeat(201);
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.shots.push(invalid.shots[0].clone());
    assert!(validate_request(&invalid, &catalog).is_err());
    let mut invalid = valid.clone();
    invalid.mode = "image".into();
    assert!(validate_request(&invalid, &catalog).is_err());
    invalid.shots[0].first_frame = Some(json!({"kind":"image"}));
    validate_request(&invalid, &catalog).unwrap();
    invalid.mode = "prompt".into();
    assert!(validate_request(&invalid, &catalog).is_err());
}

#[test]
fn video_generation_reference_duration_uses_embedded_audio_budget() {
    let catalog = catalog();
    let mut request = request();
    request.mode = "reference".into();
    request.model_id = "h3-base-ref2va".into();
    request.shots[0].references = vec![VideoGenerationReference {
        asset: json!({"kind":"video","duration":10}),
        kind: "video".into(),
        include_audio: true,
    }];
    validate_request(&request, &catalog).unwrap();
    request.shots[0].seconds = 1.0;
    assert!(validate_request(&request, &catalog)
        .unwrap_err()
        .contains("2 秒"));
    request.shots[0].seconds = 2.0;
    request.shots[0].references.push(VideoGenerationReference {
        asset: json!({"kind":"audio","duration":6}),
        kind: "audio".into(),
        include_audio: false,
    });
    assert!(validate_request(&request, &catalog).is_err());
}

#[test]
fn video_generation_frame_count_matches_model_temporal_grid() {
    assert_eq!(frames_for_seconds(1.0), 39);
    assert_eq!(frames_for_seconds(2.0), 56);
    for seconds in [1.0, 2.0, 5.0, 7.5, 15.0] {
        let frames = frames_for_seconds(seconds);
        assert_eq!((frames - 5) % 17, 0);
        assert!(frames as f64 / 24.0 >= seconds);
    }
}

#[test]
fn video_generation_unsafe_paths_and_ids_are_rejected() {
    for value in [
        "../outside",
        "/absolute",
        "folder/../../outside",
        "C:\\folder",
        "folder\\file",
        "./dot",
        "folder/./file",
    ] {
        assert!(!safe_relative(value), "{value}");
    }
    assert!(safe_relative("FL2VA/text_encoder/model.safetensors"));
    for id in ["../x", "a b", "a.b", "", "a/b"] {
        assert!(!safe_id(id));
    }
    assert!(safe_id("shot-123_456"));
}

#[test]
fn video_generation_history_recovers_interrupted_jobs_without_claiming_success() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("video-generation");
    fs::create_dir_all(&root).unwrap();
    let old = VideoGenerationJob {
        id: "interrupted".into(),
        state: "running".into(),
        stage: "生成画面".into(),
        progress: None,
        shot_index: 0,
        shot_count: 1,
        started_at: now_ms(),
        elapsed_seconds: 1.0,
        assets: vec![],
        combined_asset: None,
        error: None,
        warning: None,
    };
    write_json(&root.join("jobs.json"), &vec![old]).unwrap();
    let manager = VideoGenerationManager::new(temp.path()).unwrap();
    let job = manager.get("interrupted").unwrap();
    assert_eq!(job.state, "failed");
    assert!(job.error.unwrap().contains("退出"));
    assert!(
        manager.worker.runner.get().is_none(),
        "runtime initialization must be lazy"
    );
    manager.cancel("pending-request").unwrap();
    assert!(manager
        .owner
        .shared
        .lock()
        .unwrap()
        .early_cancelled
        .contains("pending-request"));
}

#[test]
fn video_generation_platform_status_never_claims_support_elsewhere() {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let manager = VideoGenerationManager::new(temp.path()).unwrap();
    let status = manager.status();
    assert!(!status.supported);
    assert!(!status.runtime_ready);
    assert!(status.models.iter().all(|m| m.state == "unsupported"));
    assert!(manager.begin_download("h3-base-fl2va", true).is_err());
}

#[cfg(unix)]
#[test]
fn video_generation_symlinks_cannot_escape_cache() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("model.bin"), b"data").unwrap();
    symlink(external.path(), root.join("linked")).unwrap();
    assert!(safe_directory(&root, "linked/child").is_err());
    assert!(checked_file(&root, &root.join("linked/model.bin")).is_err());
}

#[test]
fn video_generation_real_engine_phase_names_are_descriptive() {
    for name in [
        "text encoder",
        "video VAE load",
        "audio VAE",
        "denoise",
        "FFmpeg",
        "load transformer core",
    ] {
        assert_ne!(stage_label(name), "处理视频");
    }
}

#[test]
fn video_generation_operation_lock_prevents_multiple_app_writers() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let first = operation_lock(&root).unwrap();
    assert!(operation_lock(&root).is_err());
    drop(first);
    assert!(operation_lock(&root).is_ok());
}

#[cfg(unix)]
#[test]
fn video_generation_cancellation_terminates_process_group() {
    let temp = tempfile::tempdir().unwrap();
    let manager = VideoGenerationManager::new(temp.path()).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    let cancel_thread = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        signal.store(true, Ordering::SeqCst);
    });
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "sleep 20 & wait"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_process(&mut command);
    let start = Instant::now();
    let result = manager
        .worker
        .run_child(command, "cancel-check", 0, 1, &cancelled);
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert!(start.elapsed() < Duration::from_secs(3));
    cancel_thread.join().unwrap();
}

#[cfg(unix)]
#[test]
fn video_generation_shutdown_synchronously_terminates_and_reaps_helper() {
    let temp = tempfile::tempdir().unwrap();
    let manager = VideoGenerationManager::new(temp.path()).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    manager.owner.shared.lock().unwrap().active = Some(Active {
        id: "exit-check".into(),
        download: false,
        cancelled: cancelled.clone(),
    });
    let worker = manager.worker.clone();
    let signal = cancelled.clone();
    let running = thread::spawn(move || {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 20 & wait"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        isolate_process(&mut command);
        worker.run_child(command, "exit-check", 0, 1, &signal)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let handle = loop {
        if let Some(handle) = manager.owner.shared.lock().unwrap().process.clone() {
            break handle;
        }
        assert!(Instant::now() < deadline, "helper was not registered");
        thread::sleep(Duration::from_millis(10));
    };
    let pid = handle.lock().unwrap().id();
    manager.shutdown();
    assert!(cancelled.load(Ordering::SeqCst));
    assert!(
        handle.lock().unwrap().try_wait().unwrap().is_some(),
        "shutdown returned while helper was alive"
    );
    unsafe extern "C" {
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }
    let mut status = 0;
    assert_eq!(
        unsafe { waitpid(pid as i32, &mut status, 1) },
        -1,
        "shutdown must reap the helper, not leave a zombie"
    );
    assert_eq!(running.join().unwrap().unwrap_err(), CANCELLED);
    let state = manager.owner.shared.lock().unwrap();
    assert!(state.closing);
    assert!(state.process.is_none());
    assert!(require_idle(&state).is_err());
    drop(state);
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "exit 0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    assert_eq!(
        manager
            .worker
            .run_child(command, "after-exit", 0, 1, &AtomicBool::new(false))
            .unwrap_err(),
        CANCELLED
    );
    manager.shutdown();
}
