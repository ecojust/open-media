use super::*;
use serde_json::json;

fn request(id: &str) -> AiGenerationRequest {
    serde_json::from_value(
        json!({"requestId":"test-request", "modelId":id, "prompt":"清晨薄雾中的森林"}),
    )
    .unwrap()
}
fn catalog_model(id: &str) -> Model {
    models::catalogs()
        .unwrap()
        .into_iter()
        .find(|m| m.id == id)
        .unwrap()
}

#[test]
fn requests_enforce_model_specific_bounds_and_input_modes() {
    let qwen = catalog_model("qwen-image");
    let mut req = request(&qwen.id);
    assert!(validate_request(&qwen, &req).is_ok());
    req.width = Some(1023);
    assert!(validate_request(&qwen, &req).is_err());
    req.width = Some(1024);
    req.guidance = Some(f64::NAN);
    assert!(validate_request(&qwen, &req).is_err());
    req.guidance = None;
    req.request_id = "../../escape".into();
    assert!(validate_request(&qwen, &req).is_err());
    let turbo = catalog_model("z-image-turbo");
    let mut req = request(&turbo.id);
    req.negative_prompt = Some("blur".into());
    assert!(validate_request(&turbo, &req).is_err());
    req.negative_prompt = None;
    req.guidance = Some(2.0);
    assert!(validate_request(&turbo, &req).is_err());
    req.guidance = Some(0.0);
    assert!(validate_request(&turbo, &req).is_ok());
    let music = catalog_model("ace-step-1.5-turbo");
    let mut req = request(&music.id);
    req.seconds = Some(600.0);
    assert!(validate_request(&music, &req).is_ok());
    req.seconds = Some(601.0);
    assert!(validate_request(&music, &req).is_err());
    req.seconds = Some(30.0);
    req.instrumental = Some(false);
    assert!(validate_request(&music, &req).is_err());
    req.lyrics = Some("清晨的风，带来新的篇章".into());
    assert!(validate_request(&music, &req).is_ok());
    req.input_asset = Some(Asset {
        id: "external".into(),
        name: "x.png".into(),
        kind: "image".into(),
        url: String::new(),
        duration: 1.0,
        width: 16,
        height: 16,
        size: 1,
        mime: "image/png".into(),
        native_path: "/tmp/x.png".into(),
    });
    assert!(validate_request(&music, &req).is_err());
}

#[test]
fn adapter_parameters_are_data_only_and_lyrics_select_song_mode() {
    let model = catalog_model("ace-step-1.5-sft");
    let mut req = request(&model.id);
    req.lyrics = Some("我的歌词".into());
    let payload = adapter_request(
        &model,
        &req,
        Path::new("/models/locked"),
        Path::new("/jobs/one/result.wav"),
        None,
    );
    assert_eq!(payload["mode"], "song");
    assert_eq!(payload["instrumental"], false);
    assert_eq!(payload["device"], "auto");
    assert_eq!(payload["memoryMode"], "low");
    assert!(payload.get("engine").is_none());
    assert!(payload.get("script").is_none());
    let unknown = json!({"requestId":"test", "modelId":"qwen-image", "prompt":"hello", "script":"/tmp/inject.py"});
    assert!(serde_json::from_value::<AiGenerationRequest>(unknown).is_err());
}

#[test]
fn model_status_does_not_probe_or_install_an_unavailable_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for directory in ["models", "blobs", "parts", "runtime"] {
        models::safe_directory(&root, directory).unwrap();
    }
    let model = catalog_model("qwen-image");
    let state = model_state(&root, &model, &[]);
    assert_eq!(state.state, "unsupported");
    assert_eq!(state.runtime.state, "unsupported");
    assert!(state.runtime.reason.unwrap().contains("运行环境"));
    assert!(!root.join("runtime").read_dir().unwrap().any(|_| true));
}

#[test]
fn cancelled_queued_jobs_never_start_a_child() {
    let shared = Mutex::new(State {
        models: vec![],
        model_revision: 0,
        jobs: vec![],
        tasks: HashMap::new(),
        download: None,
        closing: false,
        verified_runtimes: HashMap::new(),
    });
    let flag = Arc::new(AtomicBool::new(false));
    shared.lock().unwrap().tasks.insert(
        "image:test".into(),
        Task {
            cancelled: flag.clone(),
            process: None,
        },
    );
    shutdown_shared(&shared);
    assert!(flag.load(Ordering::SeqCst));
    assert!(shared.lock().unwrap().closing);
}

#[test]
fn runtime_download_progress_does_not_change_model_weight_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let definition = catalog_model("qwen-image");
    let mut model = model_state(temp.path(), &definition, &[]);
    model.state = "downloading".into();
    model.downloaded_bytes = 12345;
    let cancelled = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(State {
        models: vec![model],
        model_revision: 0,
        jobs: vec![],
        tasks: HashMap::new(),
        download: Some(Download {
            id: definition.id.clone(),
            cancelled: cancelled.clone(),
        }),
        closing: false,
        verified_runtimes: HashMap::new(),
    }));
    let worker = Worker {
        root: temp.path().to_owned(),
        catalog: Arc::new(vec![definition.clone()]),
        runtimes: Arc::new(vec![]),
        shared: shared.clone(),
        gate: AiExecutionGate::default(),
    };
    worker.runtime_progress(
        &definition.id,
        "downloading",
        Some(runtime_file_progress(
            "runtime.part-01",
            1_200_000_000,
            1_800_000_000,
            false,
        )),
    );
    {
        let state = shared.lock().unwrap();
        let model = &state.models[0];
        assert_eq!(model.downloaded_bytes, 12345);
        assert_eq!(model.runtime.state, "downloading");
        assert!(model
            .runtime
            .reason
            .as_ref()
            .unwrap()
            .contains("1.20 GB / 1.80 GB"));
        assert!(model.runtime.reason.as_ref().unwrap().contains("当前文件"));
    }
    worker.runtime_progress(
        &definition.id,
        "verifying",
        Some(runtime_file_progress(
            "runtime.part-01",
            1_800_000_000,
            1_800_000_000,
            true,
        )),
    );
    assert_eq!(shared.lock().unwrap().models[0].state, "verifying");
    worker.runtime_progress(&definition.id, "ready", None);
    worker.transfer_progress(&definition.id, 1_800_012_345, 2_000_000_000);
    worker.download_source(&definition.id, "https://example.test/model?token=private");
    let first_session = shared.lock().unwrap().models[0].download_session.unwrap();
    worker.download_source(&definition.id, "https://backup.test/model");
    {
        let state = shared.lock().unwrap();
        assert_eq!(state.models[0].runtime.state, "ready");
        assert!(state.models[0].runtime.reason.is_none());
        assert_eq!(state.models[0].downloaded_bytes, 12345);
        assert_eq!(
            state.models[0].download_transferred_bytes,
            Some(1_800_012_345)
        );
        assert_eq!(state.models[0].download_total_bytes, Some(2_000_000_000));
        assert_eq!(
            state.models[0].active_source.as_deref(),
            Some("https://backup.test")
        );
        assert!(state.models[0].download_session.unwrap() > first_session);
    }
    cancelled.store(true, Ordering::SeqCst);
    worker.runtime_progress(&definition.id, "downloading", Some("late event".into()));
    worker.transfer_progress(&definition.id, 0, 1);
    worker.download_source(&definition.id, "https://late.test/model");
    assert_eq!(shared.lock().unwrap().models[0].runtime.state, "ready");
    assert_eq!(
        shared.lock().unwrap().models[0].active_source.as_deref(),
        Some("https://backup.test")
    );
    assert_eq!(
        shared.lock().unwrap().models[0].download_total_bytes,
        Some(2_000_000_000)
    );
}

#[test]
fn restoring_shared_runtime_updates_all_intact_models_without_redownloading() {
    use sha2::{Digest, Sha256};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for directory in ["blobs", "parts", "models", "runtime"] {
        models::safe_directory(&root, directory).unwrap();
    }
    let bytes = b"locked test weights";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let file = models::ModelFile {
        path: "weights.safetensors".into(),
        size: bytes.len() as u64,
        sha256: sha.clone(),
        urls: vec!["https://example.invalid/weights".into()],
    };
    fs::write(root.join("parts").join(format!("{sha}.part")), bytes).unwrap();
    let client = models::http_client().unwrap();
    models::ensure_blob(&root, &client, &file, &AtomicBool::new(false), |_, _| {}).unwrap();
    let mut installed = catalog_model("qwen-image");
    installed.files = vec![file.clone()];
    models::install_model(&root, &installed, &AtomicBool::new(false), |_, _| {}).unwrap();
    let mut missing = installed.clone();
    missing.id = "missing-model".into();
    let mut finished = installed.clone();
    finished.id = "finished-model".into();
    let (definitions, selected) = runtime_fixture(&root, &installed.runtime_id);
    let directory = runtime_packages::path(&root.join("runtime"), &selected);
    fs::remove_file(directory.join("check.py")).unwrap();
    let mut entries: Vec<_> = [&installed, &missing, &finished]
        .into_iter()
        .map(|model| model_state(&root, model, &definitions))
        .collect();
    assert_eq!(entries[0].state, "update-available");
    entries[0].error = Some("旧运行环境需要更新".into());
    entries[2].state = "failed".into();
    entries[2].error = Some("下载已失败".into());
    fs::write(directory.join("check.py"), b"check fixture").unwrap();
    let catalog = vec![installed.clone(), missing, finished.clone()];
    refresh_shared_runtime_models(&root, &catalog, &definitions, &mut entries, &finished.id);
    assert_eq!(entries[0].state, "ready");
    assert_eq!(entries[0].runtime.state, "ready");
    assert!(entries[0].error.is_none());
    assert_eq!(entries[0].downloaded_bytes, entries[0].size);
    assert_eq!(entries[1].state, "not-downloaded");
    assert_eq!(entries[1].runtime.state, "ready");
    assert_eq!(entries[2].state, "failed");
    assert_eq!(entries[2].error.as_deref(), Some("下载已失败"));
    fs::write(
        models::model_root(&root, &installed).join(&file.path),
        b"damaged",
    )
    .unwrap();
    refresh_shared_runtime_models(&root, &catalog, &definitions, &mut entries, &finished.id);
    assert_eq!(entries[0].state, "update-available");
}

#[test]
fn accelerator_failure_is_distinct_from_invalid_input() {
    assert!(accelerator_failure(
        "生成进程退出 signal: 6 device=mps invalid shape"
    ));
    assert!(accelerator_failure("device=cuda CUDA out of memory"));
    assert!(!accelerator_failure("device=cpu out of memory"));
    assert!(!accelerator_failure("device= invalid request"));
    assert!(!accelerator_failure("device=mps model config is missing"));
    assert!(!accelerator_failure("device=cuda unsupported input"));
}

#[cfg(unix)]
#[test]
fn shutdown_kills_and_reaps_generation_process() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "sleep 60"]);
    isolate(&mut command);
    let child = Arc::new(Mutex::new(command.spawn().unwrap()));
    let mut tasks = HashMap::new();
    tasks.insert(
        "image:test".into(),
        Task {
            cancelled: Arc::new(AtomicBool::new(false)),
            process: Some(child.clone()),
        },
    );
    let shared = Mutex::new(State {
        models: vec![],
        model_revision: 0,
        jobs: vec![],
        tasks,
        download: None,
        closing: false,
        verified_runtimes: HashMap::new(),
    });
    let started = Instant::now();
    shutdown_shared(&shared);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(child.lock().unwrap().try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn generation_protocol_retains_stdout_errors_without_cpu_retry_for_invalid_models() {
    let temp = tempfile::tempdir().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let id = "image:protocol";
    let mut tasks = HashMap::new();
    tasks.insert(
        id.into(),
        Task {
            cancelled: cancelled.clone(),
            process: None,
        },
    );
    let shared = Arc::new(Mutex::new(State {
        models: vec![],
        model_revision: 0,
        jobs: vec![],
        tasks,
        download: None,
        closing: false,
        verified_runtimes: HashMap::new(),
    }));
    let worker = Worker {
        root: temp.path().to_owned(),
        catalog: Arc::new(vec![]),
        runtimes: Arc::new(vec![]),
        shared: shared.clone(),
        gate: AiExecutionGate::default(),
    };
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf '%s\\n' '{\"stage\":\"loading\",\"device\":\"mps\"}' '{\"stage\":\"failed\",\"error\":\"模型配置文件缺失\"}'; exit 1"]);
    let error = worker
        .run_command(id, command, &cancelled, Some(Duration::from_secs(3)))
        .unwrap_err();
    assert!(error.contains("模型配置文件缺失"));
    assert!(error.contains("device=mps"));
    assert!(!accelerator_failure(&error));
    assert!(shared
        .lock()
        .unwrap()
        .tasks
        .get(id)
        .unwrap()
        .process
        .is_none());
}

fn runtime_fixture(
    root: &Path,
    runtime_id: &str,
) -> (
    Vec<runtime_packages::RuntimeDefinition>,
    runtime_packages::SelectedRuntime,
) {
    use sha2::{Digest, Sha256};
    let files = [
        ("python", b"python fixture".as_slice()),
        ("check.py", b"check fixture".as_slice()),
        ("library.py", b"library fixture".as_slice()),
    ];
    let manifest = serde_json::to_vec(&json!({"schema":1,"files":files.iter().map(|(path, data)| json!({"path":path,"size":data.len(),"sha256":format!("{:x}",Sha256::digest(data))})).collect::<Vec<_>>()})).unwrap();
    let archive: runtime_packages::RuntimeArchive = serde_json::from_value(json!({"url":"https://github.com/ecojust/open-media/releases/download/test/runtime.zip","size":10,"unpackedSize":manifest.len()+files.iter().map(|(_,data)|data.len()).sum::<usize>(),"sha256":"a".repeat(64),"manifestSha256":format!("{:x}",Sha256::digest(&manifest)),"executable":"python","script":"check.py"})).unwrap();
    let definitions = vec![runtime_packages::RuntimeDefinition {
        id: runtime_id.into(),
        version: 1,
        platforms: HashMap::from([(runtime_packages::platform().into(), archive)]),
    }];
    let selected = runtime_packages::select(runtime_id, &definitions)
        .unwrap()
        .unwrap();
    let directory = runtime_packages::path(&root.join("runtime"), &selected);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("manifest.json"), manifest).unwrap();
    for (name, data) in files {
        fs::write(directory.join(name), data).unwrap();
    }
    (definitions, selected)
}

#[test]
fn runtime_layout_rejects_missing_runner_or_library_and_updates_all_sharing_models() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let model = catalog_model("qwen-image");
    let (definitions, selected) = runtime_fixture(&root, &model.runtime_id);
    let directory = runtime_packages::path(&root.join("runtime"), &selected);
    assert_eq!(runtime_status(&root, &model, &definitions).state, "ready");
    for (name, content) in [
        ("check.py", b"check fixture".as_slice()),
        ("library.py", b"library fixture".as_slice()),
    ] {
        fs::remove_file(directory.join(name)).unwrap();
        let status = runtime_status(&root, &model, &definitions);
        assert_eq!(status.state, "update-available");
        assert!(status.reason.unwrap().contains("修复"));
        fs::write(directory.join(name), content).unwrap();
    }
    let mut second = model.clone();
    second.id = "another-model".into();
    let shared = Arc::new(Mutex::new(State {
        models: vec![
            model_state(&root, &model, &definitions),
            model_state(&root, &second, &definitions),
        ],
        model_revision: 0,
        jobs: vec![],
        tasks: HashMap::new(),
        download: None,
        closing: false,
        verified_runtimes: HashMap::new(),
    }));
    let worker = Worker {
        root: root.clone(),
        catalog: Arc::new(vec![model, second]),
        runtimes: Arc::new(definitions),
        shared: shared.clone(),
        gate: AiExecutionGate::default(),
    };
    worker
        .verify_runtime(&selected, &AtomicBool::new(false))
        .unwrap();
    fs::remove_file(directory.join("library.py")).unwrap();
    let error = worker
        .verify_runtime(&selected, &AtomicBool::new(false))
        .unwrap_err();
    worker.runtime_needs_repair(&selected, &error);
    let state = shared.lock().unwrap();
    assert!(state
        .models
        .iter()
        .all(|model| model.state == "update-available"
            && model.runtime.state == "update-available"
            && model.error.is_some()));
    assert!(state.verified_runtimes.is_empty());
}

fn probe_manager(root: &Path, catalog: Vec<Model>, runtimes: Vec<runtime_packages::RuntimeDefinition>) -> AiGenerationManager {
    let entries = catalog.iter().map(|model| model_state(root, model, &runtimes)).collect();
    let shared = Arc::new(Mutex::new(State {
        models: entries, model_revision: 0, jobs: vec![], tasks: HashMap::new(), download: None,
        closing: false, verified_runtimes: HashMap::new(),
    }));
    AiGenerationManager {
        worker: Worker { root: root.to_owned(), catalog: Arc::new(catalog), runtimes: Arc::new(runtimes),
            shared: shared.clone(), gate: AiExecutionGate::default() },
        owner: Arc::new(Owner { shared }),
    }
}

fn install_probe_weights(root: &Path) -> Model {
    use sha2::{Digest, Sha256};
    for directory in ["blobs", "parts", "models", "runtime"] { models::safe_directory(root, directory).unwrap(); }
    let bytes = b"local status probe weights";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let mut model = catalog_model("qwen-image");
    let file = models::ModelFile { path: "weights.safetensors".into(), size: bytes.len() as u64,
        sha256: sha.clone(), urls: vec!["https://example.invalid/never-requested".into()] };
    fs::write(root.join("parts").join(format!("{sha}.part")), bytes).unwrap();
    models::ensure_blob(root, &models::http_client().unwrap(), &file, &AtomicBool::new(false), |_, _| {}).unwrap();
    model.files = vec![file];
    models::install_model(root, &model, &AtomicBool::new(false), |_, _| {}).unwrap();
    model
}

#[test]
fn explicit_model_probe_refreshes_removed_weights_and_runtime_without_running_or_downloading() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let model = install_probe_weights(&root);
    let (runtimes, selected) = runtime_fixture(&root, &model.runtime_id);
    let manager = probe_manager(&root, vec![model.clone()], runtimes);
    assert_eq!(manager.models(true).unwrap()[0].state, "ready");
    let weights = models::model_root(&root, &model).join(&model.files[0].path);
    fs::remove_file(&weights).unwrap();
    assert_eq!(manager.models(false).unwrap()[0].state, "ready", "ordinary polling remains cached");
    assert_eq!(manager.models(true).unwrap()[0].state, "update-available");
    assert!(!weights.exists(), "probing must not reinstall missing files");
    models::install_model(&root, &model, &AtomicBool::new(false), |_, _| {}).unwrap();
    assert_eq!(manager.models(true).unwrap()[0].state, "ready");
    let script = runtime_packages::path(&root.join("runtime"), &selected).join("check.py");
    fs::remove_file(&script).unwrap();
    let unavailable = manager.models(true).unwrap();
    assert_eq!(unavailable[0].state, "update-available");
    assert_eq!(unavailable[0].runtime.state, "update-available");
    assert!(!script.exists());
    fs::write(&script, b"check fixture").unwrap();
    assert_eq!(manager.models(true).unwrap()[0].state, "ready");
    let state = manager.worker.shared.lock().unwrap();
    assert!(state.tasks.is_empty()); assert!(state.jobs.is_empty()); assert!(state.download.is_none());
    assert!(state.verified_runtimes.is_empty(), "layout checks never execute or hash the runtime");
}

#[test]
fn explicit_model_probe_preserves_download_progress_and_rejects_older_results() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let definition = catalog_model("qwen-image");
    let manager = probe_manager(&root, vec![definition], vec![]);
    let old_revision = manager.worker.shared.lock().unwrap().model_revision;
    let old_result = manager.models(false).unwrap();
    {
        let mut state = manager.worker.shared.lock().unwrap();
        state.model_revision += 1;
        state.models[0].state = "verifying".into();
        state.models[0].downloaded_bytes = 123;
        state.models[0].runtime.state = "downloading".into();
        state.download = Some(Download { id: state.models[0].id.clone(), cancelled: Arc::new(AtomicBool::new(false)) });
    }
    let active = manager.models(true).unwrap();
    assert_eq!(active[0].state, "verifying");
    assert_eq!(active[0].downloaded_bytes, 123);
    assert_eq!(active[0].runtime.state, "downloading");
    let mut state = manager.worker.shared.lock().unwrap();
    apply_model_probe(&mut state, old_revision, old_result.clone());
    assert_eq!(state.models[0].state, "verifying");
    state.download = None;
    state.model_revision += 1;
    state.models[0].state = "ready".into();
    apply_model_probe(&mut state, old_revision, old_result);
    assert_eq!(state.models[0].state, "ready", "old probe cannot overwrite a finished installation");
}

#[test]
fn lightweight_model_probe_does_not_clear_a_stronger_runtime_checksum_failure() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let model = install_probe_weights(&root);
    let (runtimes, selected) = runtime_fixture(&root, &model.runtime_id);
    let manager = probe_manager(&root, vec![model], runtimes);
    manager.worker.runtime_needs_repair(&selected, "运行环境文件校验失败");
    let state = manager.models(true).unwrap();
    assert_eq!(state[0].state, "update-available");
    assert_eq!(state[0].runtime.state, "update-available");
    assert!(state[0].error.as_ref().unwrap().contains("校验失败"));
}
