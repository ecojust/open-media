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
