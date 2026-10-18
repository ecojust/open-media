use crate::{
    asset_tools::{run_process, TaskControl, MEDIA_FORMATS},
    engine::{self, MediaStore, Result, Runtime},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const LOCK: &str = include_str!("../../scripts/audio-asr-models.lock.json");
const HELPER: &str = if cfg!(windows) {
    "runtime/bin/open-media-asr.exe"
} else {
    "runtime/bin/open-media-asr"
};
const MAX_JOBS: usize = 32;
const MAX_RESULT: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    name: String,
    bytes: u64,
    sha256: String,
    urls: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    schema: u32,
    id: String,
    name: String,
    engine_version: String,
    model_revision: String,
    download_size: u64,
    installed_size: u64,
    hardware: String,
    files: Vec<ModelFile>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrJob {
    pub id: String,
    pub state: String,
    pub progress: f64,
    pub stage: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
struct JobEntry {
    job: AsrJob,
    cancelled: Arc<AtomicBool>,
}
struct ModelState {
    state: String,
    downloaded: u64,
    error: Option<String>,
    job_id: Option<String>,
}
struct Inner {
    root: PathBuf,
    helper: Option<PathBuf>,
    model: Model,
    jobs: Mutex<HashMap<String, JobEntry>>,
    model_state: Mutex<ModelState>,
}
#[derive(Clone)]
pub struct AsrManager(Arc<Inner>);

impl AsrManager {
    pub fn new(app_data: &Path, resource_dir: Option<&Path>) -> Result<Self> {
        let root = app_data.join("recognition-models");
        fs::create_dir_all(&root).map_err(|error| format!("无法创建识别模型目录：{error}"))?;
        if fs::symlink_metadata(&root)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("识别模型目录不能是符号链接。".into());
        }
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let model: Model = serde_json::from_str(LOCK).map_err(|_| "内置识别模型清单无效。")?;
        validate_model(&model)?;
        let manager = Self(Arc::new(Inner {
            root,
            helper: find_helper(resource_dir),
            model,
            jobs: Mutex::new(HashMap::new()),
            model_state: Mutex::new(ModelState {
                state: "not-downloaded".into(),
                downloaded: 0,
                error: None,
                job_id: None,
            }),
        }));
        if manager.model_path().join("ready.json").is_file() {
            manager.set_model_state("verifying", 0, None, None);
            let copy = manager.clone();
            thread::spawn(move || {
                let control = TaskControl::new(Duration::from_secs(300));
                match verify_model(&copy.model_path(), &copy.0.model, &control) {
                    Ok(()) => copy.set_model_state("ready", copy.0.model.download_size, None, None),
                    Err(error) => copy.set_model_state("failed", 0, Some(error), None),
                }
            });
        }
        Ok(manager)
    }

    fn model_path(&self) -> PathBuf {
        self.0.root.join(&self.0.model.id)
    }

    fn set_model_state(
        &self,
        state: &str,
        downloaded: u64,
        error: Option<String>,
        job_id: Option<String>,
    ) {
        if let Ok(mut current) = self.0.model_state.lock() {
            *current = ModelState {
                state: state.into(),
                downloaded,
                error,
                job_id,
            };
        }
    }

    pub fn status(&self) -> Value {
        let model = &self.0.model;
        let state = self.0.model_state.lock().unwrap();
        let runtime_ready = self.0.helper.as_ref().is_some_and(|path| path.is_file());
        json!({
            "ready": runtime_ready && state.state == "ready", "runtimeReady": runtime_ready,
            "error": if runtime_ready { None } else { Some("内置识别组件未安装完整，请使用最新桌面安装包。") },
            "models": [{ "id": model.id, "name": model.name, "status": state.state,
                "downloadSize": model.download_size, "modelSize": model.installed_size,
                "downloadedBytes": state.downloaded, "progress": (state.downloaded as f64 / model.download_size as f64).clamp(0.0, 1.0),
                "hardware": model.hardware, "language": "多语，包含中文和英文", "error": state.error, "jobId": state.job_id }],
        })
    }

    fn check_model_id(&self, id: Option<&str>) -> Result<()> {
        if id.is_some_and(|id| id != self.0.model.id) {
            return Err("不支持该识别模型。".into());
        }
        Ok(())
    }

    fn new_job(&self, stage: &str) -> Result<(AsrJob, Arc<AtomicBool>)> {
        let mut jobs = self.0.jobs.lock().map_err(|_| "识别任务状态不可用。")?;
        if jobs.values().any(|entry| entry.job.state == "running") {
            return Err("已有识别模型任务正在运行，请完成或取消后再试。".into());
        }
        if jobs.len() >= MAX_JOBS {
            jobs.retain(|_, entry| entry.job.state == "running");
        }
        let job = AsrJob {
            id: engine::new_id(),
            state: "running".into(),
            progress: 0.0,
            stage: stage.into(),
            result: None,
            error: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.insert(
            job.id.clone(),
            JobEntry {
                job: job.clone(),
                cancelled: cancelled.clone(),
            },
        );
        Ok((job, cancelled))
    }

    fn progress(&self, id: &str, value: f64, stage: &str) {
        if let Ok(mut jobs) = self.0.jobs.lock() {
            if let Some(entry) = jobs.get_mut(id) {
                entry.job.progress = value.clamp(0.0, 0.99);
                entry.job.stage = stage.into();
            }
        }
    }

    fn finish(&self, id: &str, result: Result<Value>) {
        if let Ok(mut jobs) = self.0.jobs.lock() {
            if let Some(entry) = jobs.get_mut(id) {
                if entry.cancelled.load(Ordering::Acquire) {
                    entry.job.state = "cancelled".into();
                    entry.job.stage = "已取消".into();
                } else {
                    match result {
                        Ok(result) => {
                            entry.job.result = Some(result);
                            entry.job.state = "completed".into();
                            entry.job.stage = "处理完成".into();
                            entry.job.progress = 1.0;
                        }
                        Err(error) => {
                            entry.job.error = Some(error);
                            entry.job.state = "failed".into();
                            entry.job.stage = "处理失败".into();
                        }
                    }
                }
            }
        }
    }

    pub fn get(&self, id: &str) -> Result<AsrJob> {
        self.0
            .jobs
            .lock()
            .map_err(|_| "识别任务状态不可用。")?
            .get(id)
            .map(|entry| entry.job.clone())
            .ok_or_else(|| "识别任务不存在。".into())
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let jobs = self.0.jobs.lock().map_err(|_| "识别任务状态不可用。")?;
        let entry = jobs.get(id).ok_or("识别任务不存在。")?;
        if entry.job.state == "running" {
            entry.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(jobs) = self.0.jobs.lock() {
            for entry in jobs.values() {
                entry.cancelled.store(true, Ordering::Release);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && self
                .0
                .jobs
                .lock()
                .is_ok_and(|jobs| jobs.values().any(|entry| entry.job.state == "running"))
        {
            thread::sleep(Duration::from_millis(30));
        }
    }

    pub fn begin_download(&self, model_id: Option<&str>) -> Result<AsrJob> {
        self.check_model_id(model_id)?;
        if self.0.model_state.lock().unwrap().state == "verifying" {
            return Err("正在校验已下载识别模型，请稍候。".into());
        }
        let was_ready = self.0.model_state.lock().unwrap().state == "ready";
        let (job, cancelled) = self.new_job("正在准备下载识别模型")?;
        self.set_model_state("downloading", 0, None, Some(job.id.clone()));
        let manager = self.clone();
        let id = job.id.clone();
        thread::spawn(move || {
            let mut control = TaskControl::new(Duration::from_secs(2 * 3600));
            control.cancelled = cancelled.clone();
            let result = manager.download(&id, &control);
            match &result {
                Ok(_) => {
                    manager.set_model_state("ready", manager.0.model.download_size, None, None)
                }
                Err(error) => manager.set_model_state(
                    if was_ready {
                        "ready"
                    } else if cancelled.load(Ordering::Acquire) {
                        "not-downloaded"
                    } else {
                        "failed"
                    },
                    if was_ready {
                        manager.0.model.download_size
                    } else {
                        0
                    },
                    if cancelled.load(Ordering::Acquire) {
                        None
                    } else {
                        Some(error.clone())
                    },
                    None,
                ),
            }
            manager.finish(&id, result);
        });
        Ok(job)
    }

    fn download(&self, id: &str, control: &TaskControl) -> Result<Value> {
        checked_directory(&self.0.root)?;
        let temporary = tempfile::Builder::new()
            .prefix("model-download-")
            .tempdir_in(&self.0.root)
            .map_err(|error| error.to_string())?;
        let network = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(8))
            .user_agent("Open-Media-offline-recognition")
            .build()
            .map_err(|error| error.to_string())?;
        let mut completed = 0;
        for file in &self.0.model.files {
            let destination = temporary.path().join(&file.name);
            let mut errors = Vec::new();
            let mut downloaded = false;
            for url in &file.urls {
                control.check()?;
                let result = network.block_on(download_file(
                    &client,
                    url,
                    &destination,
                    file,
                    control,
                    |bytes| {
                        self.progress(
                            id,
                            (completed + bytes) as f64 / self.0.model.download_size as f64 * 0.95,
                            "正在下载识别模型",
                        );
                        self.set_model_state(
                            "downloading",
                            completed + bytes,
                            None,
                            Some(id.to_owned()),
                        );
                    },
                ));
                if result.is_ok() {
                    downloaded = true;
                    break;
                }
                errors.push(result.unwrap_err());
            }
            if !downloaded {
                return Err(format!("识别模型所有下载地址均失败：{}", errors.join("；")));
            }
            completed += file.bytes;
        }
        self.progress(id, 0.96, "正在校验识别模型");
        self.set_model_state("verifying", completed, None, Some(id.to_owned()));
        verify_files(temporary.path(), &self.0.model, control)?;
        fs::write(temporary.path().join("ready.json"), serde_json::to_vec(&json!({"schema":1,"modelId":self.0.model.id,"revision":self.0.model.model_revision})).unwrap()).map_err(|error| error.to_string())?;
        control.check()?;
        let destination = self.model_path();
        let backup = self.0.root.join(format!("replaced-{}", engine::new_id()));
        let had_previous = destination.exists();
        if had_previous {
            checked_directory(&destination)?;
            fs::rename(&destination, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(temporary.path(), &destination) {
            if had_previous {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(format!("无法安装识别模型：{error}"));
        }
        if had_previous {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(json!({"modelId":self.0.model.id,"ready":true,"downloadedBytes":completed}))
    }

    pub fn begin_transcribe(
        &self,
        runtime: &Runtime,
        store: &MediaStore,
        spec: Value,
    ) -> Result<AsrJob> {
        self.check_model_id(spec["modelId"].as_str())?;
        if self.0.helper.is_none() {
            return Err("内置识别组件未安装完整，请使用最新桌面安装包。".into());
        }
        if self.0.model_state.lock().unwrap().state != "ready" {
            return Err("识别模型尚未就绪，请先下载或等待校验完成。".into());
        }
        store.authorized_path(&spec["asset"])?;
        validate_language(spec["language"].as_str().unwrap_or("auto"))?;
        let (job, cancelled) = self.new_job("正在准备识别音频")?;
        let manager = self.clone();
        let id = job.id.clone();
        let runtime = runtime.clone();
        let store = store.clone();
        thread::spawn(move || {
            let mut control = TaskControl::new(Duration::from_secs(4 * 3600));
            control.cancelled = cancelled;
            let result = manager.transcribe(&id, &runtime, &store, &spec, &control);
            manager.finish(&id, result);
        });
        Ok(job)
    }

    fn transcribe(
        &self,
        id: &str,
        runtime: &Runtime,
        store: &MediaStore,
        spec: &Value,
        control: &TaskControl,
    ) -> Result<Value> {
        let path = store.authorized_path(&spec["asset"])?;
        self.progress(id, 0.01, "正在校验识别模型");
        if let Err(error) = verify_model(&self.model_path(), &self.0.model, control) {
            if !control.cancelled.load(Ordering::Acquire) {
                self.set_model_state("failed", 0, Some(error.clone()), None);
            }
            return Err(error);
        }
        let helper = self.0.helper.as_ref().ok_or("识别组件不可用。")?;
        let mut check = helper_command(helper);
        check.arg("--self-test");
        let output = run_process(check, control, 1024 * 1024)?;
        let version: Value =
            serde_json::from_slice(&output.stdout).map_err(|_| "识别组件自检失败。")?;
        if version["engineVersion"] != self.0.model.engine_version {
            return Err("识别组件版本不匹配，请更新应用。".into());
        }
        let metadata =
            crate::asset_tools::analysis::probe(store, runtime, &spec["asset"], control)?;
        if metadata["hasAudio"] != true {
            return Err("该素材不包含可识别的音频。".into());
        }
        let source_duration = metadata["duration"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or("音频时长无效。")?;
        let start = engine::number(spec, "trimIn", 0.0, 0.0, source_duration)?;
        let end = engine::number(spec, "trimOut", source_duration, 0.0, source_duration)?;
        let speed = engine::number(spec, "speed", 1.0, 0.1, 16.0)?;
        let duration = (end - start) / speed;
        if duration <= 0.0 || duration > 4.0 * 3600.0 {
            return Err("识别范围需要大于 0 秒且不超过 4 小时。".into());
        }
        let language = spec["language"].as_str().unwrap_or("auto");
        validate_language(language)?;
        let granularity = spec["granularity"].as_str().unwrap_or("sentence");
        if !["sentence", "word"].contains(&granularity) {
            return Err("不支持该识别时间粒度。".into());
        }
        let workspace = tempfile::tempdir().map_err(|error| error.to_string())?;
        let chunks = chunk_ranges(duration);
        let mut results: Vec<(Vec<Value>, Vec<Value>)> = Vec::new();
        let mut result_bytes = 0_usize;
        let mut backend = String::new();
        let mut fallback = None;
        let mut recognized_language = language.to_owned();
        for (index, (offset, length)) in chunks.iter().copied().enumerate() {
            control.check()?;
            self.progress(
                id,
                0.03 + 0.94 * index as f64 / chunks.len() as f64,
                &format!("正在识别音频 {}/{}", index + 1, chunks.len()),
            );
            let wave = workspace.path().join("chunk.wav");
            let mut decode = engine::process(&runtime.encoder);
            decode
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-y",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    MEDIA_FORMATS,
                    "-ss",
                ])
                .arg(format!("{:.9}", start + offset * speed))
                .arg("-i")
                .arg(&path)
                .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-af"])
                .arg(tempo_filter(speed))
                .arg("-t")
                .arg(format!("{length:.9}"))
                .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
                .arg(&wave);
            run_process(decode, control, 1024 * 1024)?;
            let requested_provider = if cfg!(target_os = "macos") {
                "coreml"
            } else {
                "cpu"
            };
            let build = |provider: &str| {
                let mut command = helper_command(helper);
                command
                    .arg(format!(
                        "--encoder={}",
                        self.model_path().join("small-encoder.int8.onnx").display()
                    ))
                    .arg(format!(
                        "--decoder={}",
                        self.model_path().join("small-decoder.int8.onnx").display()
                    ))
                    .arg(format!(
                        "--tokens={}",
                        self.model_path().join("small-tokens.txt").display()
                    ))
                    .arg(format!("--wave={}", wave.display()))
                    .arg(format!("--language={language}"))
                    .arg(format!("--provider={provider}"));
                command
            };
            let first = run_process(
                build(if fallback.is_some() {
                    "cpu"
                } else {
                    requested_provider
                }),
                control,
                MAX_RESULT,
            );
            let output = match first {
                Ok(output) => output,
                Err(error) if requested_provider != "cpu" && fallback.is_none() => {
                    control.check()?;
                    fallback = Some(requested_provider.to_owned());
                    self.progress(
                        id,
                        0.03 + 0.94 * index as f64 / chunks.len() as f64,
                        "GPU 识别不可用，正在切换 CPU",
                    );
                    run_process(build("cpu"), control, MAX_RESULT)
                        .map_err(|cpu| format!("GPU 识别失败：{error}；CPU 重试失败：{cpu}"))?
                }
                Err(error) => return Err(error),
            };
            let value: Value =
                serde_json::from_slice(&output.stdout).map_err(|_| "识别组件没有返回有效结果。")?;
            backend = value["backend"].as_str().unwrap_or("cpu").into();
            if let Some(value) = value["language"]
                .as_str()
                .filter(|value| !value.is_empty() && *value != "auto")
            {
                recognized_language = value.into();
            }
            let mut normalized = normalize_chunk(
                &value,
                offset,
                length,
                index == 0,
                index + 1 == chunks.len(),
                granularity,
            )?;
            if let Some((_, previous_tokens)) = results.last() {
                remove_duplicate_overlap(previous_tokens, &mut normalized);
            }
            result_bytes += serde_json::to_vec(&normalized)
                .map_err(|error| error.to_string())?
                .len();
            if result_bytes > MAX_RESULT - 4096 {
                return Err("识别结果超过 4 MiB，请缩短音频范围。".into());
            }
            results.push(normalized);
        }
        let mut segments = Vec::new();
        let mut tokens = Vec::new();
        for result in results {
            segments.extend(result.0);
            tokens.extend(result.1);
        }
        let text = segments
            .iter()
            .filter_map(|segment| segment["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let result = json!({ "text": text, "language": recognized_language, "segments": segments, "tokens": tokens,
            "timestampKind":"model", "wordSegmentation":"latin-whitespace-and-cjk-model-tokens", "backend":backend,
            "fallbackFrom":fallback, "duration":duration, "modelId":self.0.model.id });
        if serde_json::to_vec(&result)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_RESULT
        {
            return Err("识别结果超过 4 MiB，请缩短音频范围。".into());
        }
        Ok(result)
    }
}

fn find_helper(resource: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("OPEN_MEDIA_ASR_HELPER") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(resource) = resource {
        if let Some(parent) = resource.parent() {
            candidates.push(parent.join("Helpers/speech").join(HELPER));
        }
        candidates.extend([
            resource.join("speech").join(HELPER),
            resource.join("resources/speech").join(HELPER),
        ]);
    }
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/speech")
            .join(HELPER),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn helper_command(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn validate_model(model: &Model) -> Result<()> {
    if model.schema != 1
        || model.id != "whisper-small-int8-attention-v1"
        || model.files.len() != 3
        || model.files.iter().map(|file| file.bytes).sum::<u64>() != model.download_size
        || model.installed_size != model.download_size
    {
        return Err("识别模型清单不完整。".into());
    }
    for file in &model.files {
        if ![
            "small-encoder.int8.onnx",
            "small-decoder.int8.onnx",
            "small-tokens.txt",
        ]
        .contains(&file.name.as_str())
            || file.bytes == 0
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|value| value.is_ascii_hexdigit())
            || file.urls.is_empty()
            || file
                .urls
                .iter()
                .any(|url| !url.starts_with("https://") || !url.contains(&model.model_revision))
        {
            return Err("识别模型文件清单无效。".into());
        }
    }
    Ok(())
}

fn checked_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "识别模型目录不可用。")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("识别模型目录无效。".into());
    }
    Ok(())
}

fn verify_files(path: &Path, model: &Model, control: &TaskControl) -> Result<()> {
    checked_directory(path)?;
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    for file in &model.files {
        control.check()?;
        let source = path.join(&file.name);
        let metadata =
            fs::symlink_metadata(&source).map_err(|_| "识别模型文件缺失，请重新下载。")?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != file.bytes
            || !source
                .canonicalize()
                .map_err(|error| error.to_string())?
                .starts_with(&canonical)
        {
            return Err("识别模型文件不完整，请重新下载。".into());
        }
        let mut source = File::open(source).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            control.check()?;
            let count = source
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != file.sha256 {
            return Err("识别模型校验失败，请重新下载。".into());
        }
    }
    Ok(())
}

fn verify_model(path: &Path, model: &Model, control: &TaskControl) -> Result<()> {
    let marker_path = path.join("ready.json");
    let metadata = fs::symlink_metadata(&marker_path).map_err(|_| "识别模型未下载完整。")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("识别模型状态无效。".into());
    }
    let marker: Value =
        serde_json::from_slice(&fs::read(marker_path).map_err(|error| error.to_string())?)
            .map_err(|_| "识别模型状态无效。")?;
    if marker["schema"] != 1
        || marker["modelId"] != model.id
        || marker["revision"] != model.model_revision
    {
        return Err("识别模型需要重新下载更新。".into());
    }
    verify_files(path, model, control)
}

async fn download_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    expected: &ModelFile,
    control: &TaskControl,
    progress: impl Fn(u64),
) -> Result<()> {
    let mut request = Box::pin(client.get(url).send());
    let started = Instant::now();
    let response = loop {
        control.check()?;
        match tokio::time::timeout(Duration::from_millis(250), &mut request).await {
            Ok(result) => break result.map_err(|error| format!("下载连接失败：{error}"))?,
            Err(_) if started.elapsed() > Duration::from_secs(30) => {
                return Err("下载连接超时。".into())
            }
            Err(_) => (),
        }
    };
    let mut response = response
        .error_for_status()
        .map_err(|error| format!("下载服务返回错误：{error}"))?;
    if response
        .content_length()
        .is_some_and(|bytes| bytes != expected.bytes)
    {
        return Err("下载文件大小与固定清单不符。".into());
    }
    let mut output = File::create(destination).map_err(|error| error.to_string())?;
    let mut size = 0;
    let mut hash = Sha256::new();
    let mut received = Instant::now();
    loop {
        control.check()?;
        match tokio::time::timeout(Duration::from_millis(250), response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                received = Instant::now();
                size += chunk.len() as u64;
                if size > expected.bytes {
                    return Err("下载内容超过固定文件大小。".into());
                }
                output
                    .write_all(&chunk)
                    .map_err(|error| error.to_string())?;
                hash.update(&chunk);
                progress(size);
            }
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(format!("下载中断：{error}")),
            Err(_) if received.elapsed() > Duration::from_secs(30) => {
                return Err("下载读取超时。".into())
            }
            Err(_) => (),
        }
    }
    if size != expected.bytes || format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err("下载内容未通过大小与 SHA256 校验。".into());
    }
    output.sync_all().map_err(|error| error.to_string())?;
    control.check()
}

fn validate_language(language: &str) -> Result<()> {
    if language.is_empty()
        || language.len() > 20
        || !language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        return Err("识别语言需要使用有效语言代码，例如 zh、en 或 auto。".into());
    }
    Ok(())
}

fn chunk_ranges(duration: f64) -> Vec<(f64, f64)> {
    let mut ranges = Vec::new();
    let mut offset: f64 = 0.0;
    while offset < duration {
        let length = (duration - offset).min(30.0);
        ranges.push((offset, length));
        if offset + length >= duration {
            break;
        }
        offset += 29.0;
    }
    ranges
}

fn tempo_filter(mut speed: f64) -> String {
    let mut parts = Vec::new();
    while speed > 2.0 {
        parts.push("atempo=2".into());
        speed /= 2.0;
    }
    while speed < 0.5 {
        parts.push("atempo=0.5".into());
        speed /= 0.5;
    }
    parts.push(format!("atempo={speed}"));
    parts.join(",")
}

fn timed(value: &Value, offset: f64, length: f64) -> Result<Value> {
    let text = value["text"].as_str().ok_or("识别时间戳缺少文本。")?;
    let start = value["start"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("识别开始时间无效。")?;
    let end = value["end"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= start)
        .ok_or("识别结束时间无效。")?;
    Ok(json!({"text":text,"start":offset+start.min(length),"end":offset+end.min(length)}))
}

fn word_groups(tokens: &[Value]) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    let mut pending = None;
    for token in tokens {
        let raw = token["text"].as_str().unwrap_or("");
        let text = raw.trim();
        if text.is_empty() {
            pending.get_or_insert(token["start"].as_f64().unwrap_or(0.0));
            continue;
        }
        let punctuation = text
            .chars()
            .all(|c| c.is_ascii_punctuation() || "，。！？；：、…—（）《》“”‘’".contains(c));
        let latin_fragment = !raw.starts_with(char::is_whitespace)
            && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '\'');
        let previous_latin = result
            .last()
            .and_then(|word| word["text"].as_str())
            .is_some_and(|text| text.chars().all(|c| c.is_ascii_alphanumeric() || c == '\''));
        if let Some(previous) = result
            .last_mut()
            .filter(|_| punctuation || (latin_fragment && previous_latin))
        {
            previous["text"] = json!(format!(
                "{}{}",
                previous["text"].as_str().unwrap_or(""),
                text
            ));
            previous["end"] = token["end"].clone();
        } else {
            result.push(json!({"text":text,"start":pending.take().unwrap_or(token["start"].as_f64().unwrap_or(0.0)),"end":token["end"]}));
        }
        pending = None;
    }
    result
}

fn normalize_chunk(
    value: &Value,
    offset: f64,
    length: f64,
    first: bool,
    last: bool,
    granularity: &str,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let text = value["text"].as_str().ok_or("识别结果缺少文本。")?;
    let raw_tokens = value["tokens"]
        .as_array()
        .ok_or("识别结果缺少 token 数组。")?;
    let raw_segments = value["segments"]
        .as_array()
        .ok_or("识别结果缺少句时间戳。")?;
    if !text.trim().is_empty()
        && (raw_segments.is_empty() || granularity == "word" && raw_tokens.is_empty())
    {
        return Err("模型未返回所需的真实时间戳。".into());
    }
    let low = offset + if first { 0.0 } else { 0.5 };
    let high = offset + length - if last { 0.0 } else { 0.5 };
    let tokens = raw_tokens
        .iter()
        .map(|value| timed(value, offset, length))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|value| {
            let midpoint =
                (value["start"].as_f64().unwrap() + value["end"].as_f64().unwrap()) / 2.0;
            midpoint >= low && (midpoint < high || last && midpoint <= high)
        })
        .collect::<Vec<_>>();
    let mut segments = Vec::new();
    for (index, raw) in raw_segments.iter().enumerate() {
        let mut segment = timed(raw, offset, length)?;
        let start = segment["start"].as_f64().unwrap();
        let end = segment["end"].as_f64().unwrap();
        let partial = start < low || end > high;
        let next_start = raw_segments
            .get(index + 1)
            .and_then(|next| next["start"].as_f64())
            .map(|start| offset + start)
            .unwrap_or(offset + length + 0.001);
        let owned = tokens
            .iter()
            .filter(|token| {
                let midpoint =
                    (token["start"].as_f64().unwrap() + token["end"].as_f64().unwrap()) / 2.0;
                midpoint >= start && midpoint < next_start
            })
            .cloned()
            .collect::<Vec<_>>();
        if partial && owned.is_empty() {
            continue;
        }
        if !partial && end <= low || start >= high {
            continue;
        }
        if partial {
            segment["text"] = json!(owned
                .iter()
                .filter_map(|token| token["text"].as_str())
                .collect::<String>()
                .trim());
            segment["start"] = owned.first().unwrap()["start"].clone();
            segment["end"] = owned.last().unwrap()["end"].clone();
            segment["boundaryAdjustedForChunk"] = json!(true);
        } else if let Some(last) = owned.last() {
            segment["end"] = json!(end.max(last["end"].as_f64().unwrap()).min(offset + length));
        }
        if segment["text"].as_str().unwrap_or("").trim().is_empty() {
            continue;
        }
        segment["words"] = json!(word_groups(&owned));
        segment["tokens"] = json!(owned);
        segments.push(segment);
    }
    Ok((segments, tokens))
}

fn remove_duplicate_overlap(previous: &[Value], current: &mut (Vec<Value>, Vec<Value>)) {
    let duplicates = current
        .1
        .iter()
        .take(16)
        .filter(|token| {
            let text = token["text"].as_str().unwrap_or("").trim().to_lowercase();
            if text.is_empty() {
                return false;
            }
            previous.iter().rev().take(16).any(|before| {
                let intersection = before["end"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .min(token["end"].as_f64().unwrap_or(0.0))
                    - before["start"]
                        .as_f64()
                        .unwrap_or(0.0)
                        .max(token["start"].as_f64().unwrap_or(0.0));
                intersection > 0.02
                    && before["text"].as_str().unwrap_or("").trim().to_lowercase() == text
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    if duplicates.is_empty() {
        return;
    }
    current.1.retain(|token| !duplicates.contains(token));
    for segment in &mut current.0 {
        let tokens = segment["tokens"].as_array().cloned().unwrap_or_default();
        let kept = tokens
            .iter()
            .filter(|token| !duplicates.contains(token))
            .cloned()
            .collect::<Vec<_>>();
        if kept.len() == tokens.len() {
            continue;
        }
        segment["text"] = json!(kept
            .iter()
            .filter_map(|token| token["text"].as_str())
            .collect::<String>()
            .trim());
        if let (Some(first), Some(last)) = (kept.first(), kept.last()) {
            segment["start"] = first["start"].clone();
            segment["end"] = last["end"].clone();
        }
        segment["words"] = json!(word_groups(&kept));
        segment["tokens"] = json!(kept);
        segment["boundaryAdjustedForChunk"] = json!(true);
    }
    current
        .0
        .retain(|segment| !segment["text"].as_str().unwrap_or("").trim().is_empty());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_model_and_chunk_boundaries_are_consistent() {
        let model: Model = serde_json::from_str(LOCK).unwrap();
        validate_model(&model).unwrap();
        assert_eq!(model.download_size, 375_744_699);
        assert_eq!(
            chunk_ranges(60.0),
            vec![(0.0, 30.0), (29.0, 30.0), (58.0, 2.0)]
        );
        assert_eq!(chunk_ranges(30.0), vec![(0.0, 30.0)]);
        assert_eq!(tempo_filter(4.0), "atempo=2,atempo=2");
        assert!(validate_language("zh;command").is_err());
    }

    #[test]
    fn word_groups_preserve_real_token_spans_and_chinese_units() {
        let words = word_groups(&[
            json!({"text":" night","start":0.1,"end":0.3}),
            json!({"text":"fall","start":0.3,"end":0.6}),
            json!({"text":".","start":0.6,"end":0.7}),
            json!({"text":"你","start":0.8,"end":1.0}),
            json!({"text":"好","start":1.0,"end":1.2}),
        ]);
        assert_eq!(words[0], json!({"text":"nightfall.","start":0.1,"end":0.7}));
        assert_eq!(words.len(), 3);
        assert_eq!(words[1]["text"], "你");
    }

    #[test]
    fn overlap_ownership_removes_duplicate_tokens_without_inventing_times() {
        let value = json!({"text":" one two", "tokens":[{"text":" one","start":0.0,"end":0.4},{"text":" two","start":0.5,"end":1.0}], "segments":[{"text":" one two","start":0.0,"end":1.0}]});
        let (segments, tokens) = normalize_chunk(&value, 29.0, 2.0, false, true, "word").unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0]["start"], 29.5);
        assert_eq!(segments[0]["text"], "two");
        assert_eq!(segments[0]["boundaryAdjustedForChunk"], true);
        assert!(normalize_chunk(
            &json!({"text":"missing","tokens":[],"segments":[]}),
            0.0,
            2.0,
            true,
            true,
            "sentence"
        )
        .is_err());
        let previous = vec![json!({"text":" one","start":29.0,"end":29.7})];
        let mut current = normalize_chunk(&json!({"text":" one two","tokens":[{"text":" one","start":0.3,"end":0.8},{"text":" two","start":1.0,"end":1.8}],"segments":[{"text":" one two","start":0.0,"end":1.8}]}),29.0,2.0,false,true,"word").unwrap();
        remove_duplicate_overlap(&previous, &mut current);
        assert_eq!(current.1.len(), 1);
        assert_eq!(current.0[0]["text"], "two");
        assert_eq!(current.0[0]["start"], 30.0);
    }

    #[test]
    fn missing_or_tampered_models_never_report_ready() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AsrManager::new(directory.path(), None).unwrap();
        assert_eq!(manager.status()["models"][0]["status"], "not-downloaded");
        assert!(manager.begin_download(Some("unknown")).is_err());
        fs::create_dir(manager.model_path()).unwrap();
        fs::write(manager.model_path().join("ready.json"), b"{}").unwrap();
        assert!(verify_model(
            &manager.model_path(),
            &manager.0.model,
            &TaskControl::new(Duration::from_secs(10))
        )
        .is_err());
    }

    fn serve_body(bytes: Vec<u8>) -> (String, thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut header = [0_u8; 4096];
            let _ = connection.read(&mut header);
            write!(
                connection,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            connection.write_all(&bytes).unwrap();
        });
        (url, server)
    }

    #[test]
    fn real_http_transfer_enforces_hash_and_cancels_stalled_body() {
        use std::net::TcpListener;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder().build().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"offline-recognition-fixture".to_vec();
        let mut file = ModelFile {
            name: "fixture".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            urls: Vec::new(),
        };
        let (url, server) = serve_body(bytes.clone());
        runtime
            .block_on(download_file(
                &client,
                &url,
                &directory.path().join("model"),
                &file,
                &TaskControl::new(Duration::from_secs(10)),
                |_| {},
            ))
            .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(directory.path().join("model")).unwrap(), bytes);
        file.sha256 = "0".repeat(64);
        let (url, server) = serve_body(bytes);
        assert!(runtime
            .block_on(download_file(
                &client,
                &url,
                &directory.path().join("corrupt"),
                &file,
                &TaskControl::new(Duration::from_secs(10)),
                |_| {}
            ))
            .unwrap_err()
            .contains("SHA256"));
        server.join().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stalled", listener.local_addr().unwrap());
        let done = Arc::new(AtomicBool::new(false));
        let server_done = done.clone();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let mut header = [0_u8; 4096];
            let _ = connection.read(&mut header);
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n")
                .unwrap();
            while !server_done.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(10));
            }
        });
        file.bytes = 999;
        let control = TaskControl::new(Duration::from_secs(10));
        let cancelled = control.cancelled.clone();
        let cancel = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancelled.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let result = runtime.block_on(download_file(
            &client,
            &url,
            &directory.path().join("cancelled"),
            &file,
            &control,
            |_| {},
        ));
        done.store(true, Ordering::Release);
        cancel.join().unwrap();
        server.join().unwrap();
        assert!(result.unwrap_err().contains("取消"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    #[ignore = "requires the pinned downloaded model, packaged helper, and real speech fixtures"]
    fn native_recognition_produces_real_chinese_and_english_timestamps() {
        let model_root = PathBuf::from(std::env::var("OPEN_MEDIA_ASR_TEST_MODEL_DIR").unwrap());
        let helper = PathBuf::from(std::env::var("OPEN_MEDIA_ASR_TEST_HELPER").unwrap());
        let english = PathBuf::from(std::env::var("OPEN_MEDIA_ASR_TEST_ENGLISH").unwrap());
        let directory = tempfile::tempdir().unwrap();
        let mut manager = AsrManager::new(directory.path(), None).unwrap();
        Arc::get_mut(&mut manager.0).unwrap().helper = Some(helper);
        fs::create_dir(manager.model_path()).unwrap();
        for file in &manager.0.model.files {
            fs::hard_link(
                model_root.join(&file.name),
                manager.model_path().join(&file.name),
            )
            .or_else(|_| {
                fs::copy(
                    model_root.join(&file.name),
                    manager.model_path().join(&file.name),
                )
                .map(|_| ())
            })
            .unwrap();
        }
        fs::write(manager.model_path().join("ready.json"),serde_json::to_vec(&json!({"schema":1,"modelId":manager.0.model.id,"revision":manager.0.model.model_revision})).unwrap()).unwrap();
        manager.set_model_state("ready", manager.0.model.download_size, None, None);
        let runtime = Runtime::discover(None, None).unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        for (language, path, expected) in [
            (
                "zh",
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/optional-speech-assets/zipvoice-reference.wav"),
                "你好",
            ),
            ("en", english, "yellow lamps"),
        ] {
            let asset = store.import(&runtime, &path, None).unwrap();
            let job = manager
                .begin_transcribe(
                    &runtime,
                    &store,
                    json!({"asset":asset,"language":language,"granularity":"word"}),
                )
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(180);
            let completed = loop {
                let current = manager.get(&job.id).unwrap();
                if current.state != "running" {
                    break current;
                }
                assert!(Instant::now() < deadline, "recognition did not finish");
                thread::sleep(Duration::from_millis(50));
            };
            assert_eq!(completed.state, "completed", "{:?}", completed.error);
            let value = completed.result.unwrap();
            assert!(
                value["text"].as_str().unwrap().contains(expected),
                "{value}"
            );
            assert_eq!(value["timestampKind"], "model");
            assert!(value["tokens"].as_array().unwrap().len() > 8);
            assert!(value["segments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|segment| !segment["words"].as_array().unwrap().is_empty()));
            for token in value["tokens"].as_array().unwrap() {
                assert!(token["start"].as_f64().unwrap() >= 0.0);
                assert!(token["end"].as_f64().unwrap() >= token["start"].as_f64().unwrap());
                assert!(token["end"].as_f64().unwrap() <= asset.duration + 0.001);
            }
            println!(
                "{} recognition: {}; {} measured tokens",
                language,
                value["text"],
                value["tokens"].as_array().unwrap().len()
            );
        }
    }

    #[test]
    #[ignore = "downloads the actual pinned 375 MB optional model"]
    fn native_download_installs_only_verified_model_files() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AsrManager::new(directory.path(), None).unwrap();
        let started = Instant::now();
        let job = manager.begin_download(None).unwrap();
        let completed = loop {
            let current = manager.get(&job.id).unwrap();
            if current.state != "running" {
                break current;
            }
            if started.elapsed() > Duration::from_secs(600) {
                manager.cancel(&job.id).unwrap();
                manager.shutdown();
                panic!("download did not finish within 10 minutes");
            }
            thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(completed.state, "completed", "{:?}", completed.error);
        assert_eq!(manager.status()["models"][0]["status"], "ready");
        verify_model(
            &manager.model_path(),
            &manager.0.model,
            &TaskControl::new(Duration::from_secs(60)),
        )
        .unwrap();
        assert_eq!(fs::read_dir(&manager.0.root).unwrap().count(), 1);
        println!(
            "Verified native model download: {} bytes in {:.2} seconds",
            manager.0.model.download_size,
            started.elapsed().as_secs_f64()
        );
    }
}
