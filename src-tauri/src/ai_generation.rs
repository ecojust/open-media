//! Shared image and music jobs. No model code or user Python is executed.
use crate::{
    ai_execution::AiExecutionGate,
    ai_models::{self as models, Model},
    ai_types::{AiGenerationRequest, AiJob, AiModel, AiRuntimeStatus},
    engine::{self, Asset, MediaStore, Result, Runtime},
    speech_models::runtime_packages,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_HISTORY: usize = 100;
const MAX_QUEUED: usize = 8;
struct Download {
    id: String,
    cancelled: Arc<AtomicBool>,
}
struct Task {
    cancelled: Arc<AtomicBool>,
    process: Option<Arc<Mutex<Child>>>,
}
struct State {
    models: Vec<AiModel>,
    jobs: Vec<AiJob>,
    tasks: HashMap<String, Task>,
    download: Option<Download>,
    closing: bool,
    verified_runtimes: HashMap<PathBuf, Vec<crate::speech_models::FileStamp>>,
}
struct Owner {
    shared: Arc<Mutex<State>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        shutdown_shared(&self.shared);
    }
}
#[derive(Clone)]
struct Worker {
    root: PathBuf,
    catalog: Arc<Vec<Model>>,
    runtimes: Arc<Vec<runtime_packages::RuntimeDefinition>>,
    shared: Arc<Mutex<State>>,
    gate: AiExecutionGate,
}
#[derive(Clone)]
pub struct AiGenerationManager {
    worker: Worker,
    owner: Arc<Owner>,
}

impl AiGenerationManager {
    pub fn new(app_data: &Path, _resource: &Path, gate: AiExecutionGate) -> Result<Self> {
        let catalog = models::catalogs()?;
        let runtimes = models::runtimes()?;
        let root = app_data.join("ai-generation");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        models::checked_directory(&root)?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for path in ["blobs", "parts", "models", "jobs", "runtime"] {
            models::safe_directory(&root, path)?;
        }
        let model_states = catalog
            .iter()
            .map(|m| model_state(&root, m, &runtimes))
            .collect();
        let mut jobs: Vec<AiJob> = models::read_json(&root.join("jobs.json")).unwrap_or_default();
        jobs.truncate(MAX_HISTORY);
        for job in &mut jobs {
            if matches!(job.state.as_str(), "running" | "queued" | "cancelling") {
                job.state = "failed".into();
                job.stage = "上次生成已中断".into();
                job.cancelable = false;
                job.error = Some("应用在生成期间退出，请重新提交任务。".into());
            }
        }
        let shared = Arc::new(Mutex::new(State {
            models: model_states,
            jobs,
            tasks: HashMap::new(),
            download: None,
            closing: false,
            verified_runtimes: HashMap::new(),
        }));
        Ok(Self {
            worker: Worker {
                root,
                catalog: Arc::new(catalog),
                runtimes: Arc::new(runtimes),
                shared: shared.clone(),
                gate,
            },
            owner: Arc::new(Owner { shared }),
        })
    }
    pub fn models(&self, probe_runtime: bool) -> Result<Vec<AiModel>> {
        // Status polling never initializes a GPU or re-hashes multi-gigabyte weights.
        let _ = probe_runtime;
        let state = self
            .worker
            .shared
            .lock()
            .map_err(|_| "AI 模型状态不可用。")?;
        Ok(state.models.clone())
    }
    pub fn download(&self, id: &str, accepted_license: bool) -> Result<()> {
        if !accepted_license {
            return Err("下载前请确认该模型的许可条款。".into());
        }
        let model = self.worker.model(id)?.clone();
        let runtime = select_runtime(&model, &self.worker.runtimes)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self
                .worker
                .shared
                .lock()
                .map_err(|_| "AI 模型状态不可用。")?;
            if state.closing {
                return Err("应用正在关闭。".into());
            }
            if state.download.is_some() {
                return Err("已有 AI 模型正在下载，请等待或取消后重试。".into());
            }
            if !state.tasks.is_empty() {
                return Err("AI 图像或歌曲生成尚未结束，请完成后更新模型。".into());
            }
            state.download = Some(Download {
                id: id.into(),
                cancelled: cancelled.clone(),
            });
            if let Some(entry) = state.models.iter_mut().find(|m| m.id == id) {
                entry.state = "downloading".into();
                entry.error = None;
            }
        }
        let worker = self.worker.clone();
        thread::spawn(move || {
            let result = worker.download(&model, &runtime, &cancelled);
            if let Ok(mut state) = worker.shared.lock() {
                let mut next = model_state(&worker.root, &model, &worker.runtimes);
                if let Err(error) = result {
                    next.state = if cancelled.load(Ordering::SeqCst) {
                        "not-downloaded"
                    } else {
                        "failed"
                    }
                    .into();
                    next.error = Some(error);
                }
                if let Some(entry) = state.models.iter_mut().find(|m| m.id == model.id) {
                    *entry = next;
                }
                state.download = None;
                refresh_shared_runtime_models(
                    &worker.root,
                    &worker.catalog,
                    &worker.runtimes,
                    &mut state.models,
                    &model.id,
                );
            }
        });
        Ok(())
    }
    pub fn cancel_download(&self, id: &str) -> Result<()> {
        let mut state = self
            .worker
            .shared
            .lock()
            .map_err(|_| "AI 下载状态不可用。")?;
        let download = state
            .download
            .as_ref()
            .filter(|d| d.id == id)
            .ok_or("该模型没有正在进行的下载。")?;
        download.cancelled.store(true, Ordering::SeqCst);
        if let Some(model) = state.models.iter_mut().find(|m| m.id == id) {
            model.error = Some("正在取消下载；已下载的数据将保留。".into());
        }
        Ok(())
    }
    pub fn repair(&self, id: &str, accepted_license: bool) -> Result<()> {
        self.download(id, accepted_license)
    }
    pub fn begin(
        &self,
        runtime: Runtime,
        store: MediaStore,
        request: AiGenerationRequest,
    ) -> Result<AiJob> {
        let model = self.worker.model(&request.model_id)?.clone();
        validate_request(&model, &request)?;
        select_runtime(&model, &self.worker.runtimes)?;
        if !models::installed_ready(&self.worker.root, &model) {
            return Err("模型尚未安装或文件已改变，请在 AI 模型中下载或修复。".into());
        }
        // Resolve library membership before queueing; the worker rechecks before opening.
        if let Some(asset) = &request.input_asset {
            validated_image(&store, &runtime, asset)?;
        }
        let id = format!("{}:{}", model.kind, request.request_id);
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = AiJob {
            id: id.clone(),
            provider: model.kind.clone(),
            model_id: Some(model.id.clone()),
            kind: "generation".into(),
            state: "running".into(),
            stage: "等待生成".into(),
            progress: None,
            started_at: models::now_ms(),
            elapsed_seconds: 0.0,
            assets: Vec::new(),
            cancelable: true,
            error: None,
            warning: None,
        };
        {
            let mut state = self
                .worker
                .shared
                .lock()
                .map_err(|_| "AI 任务状态不可用。")?;
            if state.closing {
                return Err("应用正在关闭。".into());
            }
            if state.download.is_some() {
                return Err("正在安装 AI 模型，请等待下载完成。".into());
            }
            if state.tasks.len() >= MAX_QUEUED {
                return Err("等待中的 AI 任务过多，请先完成或取消现有任务。".into());
            }
            if state.jobs.iter().any(|j| j.id == id) {
                return Err("生成请求编号已存在，请使用新的 requestId。".into());
            }
            state.tasks.insert(
                id.clone(),
                Task {
                    cancelled: cancelled.clone(),
                    process: None,
                },
            );
            state.jobs.insert(0, job.clone());
            state.jobs.truncate(MAX_HISTORY);
            persist(&self.worker.root, &state.jobs);
        }
        let worker = self.worker.clone();
        thread::spawn(move || {
            let began = Instant::now();
            let result = worker.generate(&runtime, &store, &model, &request, &id, &cancelled);
            if let Ok(mut state) = worker.shared.lock() {
                if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
                    job.elapsed_seconds = began.elapsed().as_secs_f64();
                    job.cancelable = false;
                    match result {
                        Ok(asset) => {
                            job.state = "completed".into();
                            job.stage = "生成完成".into();
                            job.progress = Some(1.0);
                            job.assets = vec![asset];
                        }
                        Err(error) => {
                            job.state = if cancelled.load(Ordering::SeqCst) {
                                "cancelled"
                            } else {
                                "failed"
                            }
                            .into();
                            job.stage = if job.state == "cancelled" {
                                "已取消"
                            } else {
                                "生成失败"
                            }
                            .into();
                            job.error = Some(error);
                            job.progress = None;
                        }
                    }
                }
                state.tasks.remove(&id);
                persist(&worker.root, &state.jobs);
            }
        });
        Ok(job)
    }
    pub fn list(&self) -> Result<Vec<AiJob>> {
        let state = self
            .worker
            .shared
            .lock()
            .map_err(|_| "AI 任务状态不可用。")?;
        Ok(state
            .jobs
            .iter()
            .cloned()
            .map(|mut job| {
                if job.cancelable {
                    job.elapsed_seconds =
                        models::now_ms().saturating_sub(job.started_at) as f64 / 1000.0;
                }
                job
            })
            .collect())
    }
    pub fn get(&self, id: &str) -> Result<AiJob> {
        self.list()?
            .into_iter()
            .find(|j| j.id == id)
            .ok_or_else(|| "AI 生成任务不存在。".into())
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let process = {
            let mut state = self
                .worker
                .shared
                .lock()
                .map_err(|_| "AI 任务状态不可用。")?;
            let Some(task) = state.tasks.get(id) else {
                return if state.jobs.iter().any(|job| job.id == id) {
                    Ok(())
                } else {
                    Err("AI 任务不存在。".into())
                };
            };
            task.cancelled.store(true, Ordering::SeqCst);
            let process = task.process.clone();
            if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
                job.stage = "正在取消".into();
            }
            process
        };
        if let Some(child) = process {
            terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        let _ = &self.owner;
        shutdown_shared(&self.worker.shared);
    }
}

impl Worker {
    fn model(&self, id: &str) -> Result<&Model> {
        self.catalog
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| "未知 AI 模型。".into())
    }
    fn update(&self, id: &str, stage: &str, progress: Option<f64>, warning: Option<&str>) {
        if let Ok(mut state) = self.shared.lock() {
            let cancelling = state
                .tasks
                .get(id)
                .is_some_and(|task| task.cancelled.load(Ordering::SeqCst));
            if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
                if !cancelling {
                    job.state = "running".into();
                    job.stage = stage.into();
                    job.progress = progress
                        .filter(|p| p.is_finite())
                        .map(|p| p.clamp(0.0, 1.0));
                }
                if let Some(warning) = warning {
                    job.warning = Some(warning.chars().take(2000).collect());
                }
            }
        }
    }
    fn model_progress(&self, id: &str, phase: &str, bytes: u64) {
        if let Ok(mut state) = self.shared.lock() {
            let cancelling = state
                .download
                .as_ref()
                .is_some_and(|d| d.cancelled.load(Ordering::SeqCst));
            if let Some(model) = state.models.iter_mut().find(|m| m.id == id) {
                if !cancelling {
                    model.state = phase.into();
                    model.downloaded_bytes = bytes.min(model.size);
                    model.download_phase = Some(if phase == "verifying" { "verifying" } else { "model" }.into());
                    let total = model.download_total_bytes.unwrap_or(model.size);
                    model.download_transferred_bytes = Some(total.saturating_sub(model.size).saturating_add(bytes.min(model.size)).min(total));
                }
            }
        }
    }
    fn runtime_progress(&self, id: &str, phase: &str, reason: Option<String>) {
        if let Ok(mut state) = self.shared.lock() {
            if state
                .download
                .as_ref()
                .is_some_and(|download| download.cancelled.load(Ordering::SeqCst))
            {
                return;
            }
            if let Some(model) = state.models.iter_mut().find(|model| model.id == id) {
                model.runtime.state = phase.into();
                model.runtime.reason = reason;
                if matches!(phase, "downloading" | "verifying") {
                    model.state = phase.into();
                    model.download_phase = Some(if phase == "verifying" { "verifying" } else { "runtime" }.into());
                }
            }
        }
    }
    fn transfer_progress(&self, id: &str, bytes: u64, total: u64) {
        if let Ok(mut state) = self.shared.lock() {
            if let Some(model) = state.models.iter_mut().find(|model| model.id == id) {
                model.download_total_bytes = Some(total);
                model.download_transferred_bytes = Some(bytes.min(total));
            }
        }
    }
    fn download(
        &self,
        model: &Model,
        runtime: &runtime_packages::SelectedRuntime,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let _lock = models::operation_lock(&self.root)?;
        models::check_cancelled(cancelled)?;
        self.runtime_progress(
            &model.id,
            "verifying",
            Some("正在检查已安装的推理环境。".into()),
        );
        let runtime_ready = self.verify_runtime(runtime, cancelled).is_ok();
        models::check_cancelled(cancelled)?;
        let cached_weights = models::cached_bytes(&self.root, model);
        let transfer_total = models::model_size(model).saturating_add(runtime.archive.size);
        self.transfer_progress(&model.id, cached_weights.saturating_add(if runtime_ready { runtime.archive.size } else { 0 }), transfer_total);
        self.runtime_progress(
            &model.id,
            if runtime_ready {
                "ready"
            } else {
                "downloading"
            },
            if runtime_ready {
                None
            } else {
                Some("正在准备下载推理环境；模型权重会在环境就绪后下载。".into())
            },
        );
        let runtime_space = if runtime_ready {
            0
        } else {
            runtime
                .archive
                .size
                .saturating_mul(2)
                .saturating_add(runtime.archive.unpacked_size)
        };
        let needed = models::model_size(model)
            .saturating_sub(models::cached_bytes(&self.root, model))
            .saturating_add(runtime_space)
            .saturating_add(512 * 1024 * 1024);
        models::require_space(&self.root, needed)?;
        let client = models::http_client()?;
        let runtime_root = self.root.join("runtime");
        if !runtime_ready {
            let stamps = runtime_packages::install_with_download_and_probe(
                &runtime_root,
                runtime,
                cancelled,
                |name, urls, size, sha256, destination, offset| {
                    let file = models::ModelFile {
                        path: name.into(),
                        urls: urls.to_vec(),
                        size,
                        sha256: sha256.into(),
                    };
                    models::ensure_blob(
                        &self.root,
                        &client,
                        &file,
                        cancelled,
                        |bytes, verifying| {
                            self.transfer_progress(&model.id, cached_weights.saturating_add(offset).saturating_add(bytes), transfer_total);
                            self.runtime_progress(
                                &model.id,
                                if verifying {
                                    "verifying"
                                } else {
                                    "downloading"
                                },
                                Some(runtime_file_progress(name, bytes, size, verifying)),
                            )
                        },
                    )?;
                    fs::hard_link(self.root.join("blobs").join(sha256), destination)
                        .map_err(|e| format!("无法共享 AI 运行环境下载文件：{e}"))?;
                    self.runtime_progress(
                        &model.id,
                        "verifying",
                        Some("当前运行环境文件已下载，正在校验和安装。".into()),
                    );
                    Ok(())
                },
                |directory, selected, flag| {
                    self.probe_runtime(&model.id, directory, selected, flag)
                },
            )?;
            if let Ok(mut state) = self.shared.lock() {
                state
                    .verified_runtimes
                    .insert(runtime_packages::path(&runtime_root, runtime), stamps);
            }
        }
        self.runtime_progress(&model.id, "ready", None);
        self.transfer_progress(&model.id, cached_weights.saturating_add(runtime.archive.size), transfer_total);
        models::install_model(&self.root, model, cancelled, |phase, bytes| {
            self.model_progress(&model.id, phase, bytes)
        })
    }
    fn probe_runtime(
        &self,
        model_id: &str,
        directory: &Path,
        runtime: &runtime_packages::SelectedRuntime,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let id = format!("runtime-check:{model_id}");
        let _permit = self.gate.acquire(&id, cancelled, |_| {
            self.runtime_progress(
                model_id,
                "verifying",
                Some("正在等待其他 AI 任务释放设备，以检查推理环境。".into()),
            )
        })?;
        models::check_cancelled(cancelled)?;
        self.runtime_progress(
            model_id,
            "verifying",
            Some("正在检查推理环境及可用计算设备。".into()),
        );
        {
            let mut state = self.shared.lock().map_err(|_| "AI 下载状态不可用。")?;
            if state.closing {
                return Err(models::CANCELLED.into());
            }
            let flag = state
                .download
                .as_ref()
                .filter(|d| d.id == model_id)
                .ok_or("AI 下载已取消。")?
                .cancelled
                .clone();
            state.tasks.insert(
                id.clone(),
                Task {
                    cancelled: flag,
                    process: None,
                },
            );
        }
        let mut command = Command::new(directory.join(&runtime.archive.executable));
        command
            .args(["-I", "-B", "-u"])
            .arg(directory.join(&runtime.archive.script))
            .arg("--self-test")
            .current_dir(directory)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("PYTHONNOUSERSITE", "1");
        let result = self.run_command(&id, command, cancelled, Some(Duration::from_secs(180)));
        if let Ok(mut state) = self.shared.lock() {
            state.tasks.remove(&id);
        }
        result.map_err(|error| format!("AI 运行环境未通过本机检查：{error}"))
    }
    fn verify_runtime(
        &self,
        runtime: &runtime_packages::SelectedRuntime,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let directory = runtime_packages::path(&self.root.join("runtime"), runtime);
        models::checked_file(&directory, &directory.join(&runtime.archive.executable))?;
        let verified = self
            .shared
            .lock()
            .map_err(|_| "AI 运行环境状态不可用。")?
            .verified_runtimes
            .get(&directory)
            .cloned();
        if verified.is_some_and(|stamps| runtime_packages::verified_files_unchanged(&stamps)) {
            return models::check_cancelled(cancelled);
        }
        let stamps = runtime_packages::verify(&directory, runtime, cancelled)?;
        self.shared
            .lock()
            .map_err(|_| "AI 运行环境状态不可用。")?
            .verified_runtimes
            .insert(directory, stamps);
        Ok(())
    }
    fn generate(
        &self,
        runtime: &Runtime,
        store: &MediaStore,
        model: &Model,
        request: &AiGenerationRequest,
        id: &str,
        cancelled: &AtomicBool,
    ) -> Result<Asset> {
        let _permit = self.gate.acquire(id, cancelled, |blocker| {
            self.update(
                id,
                &format!("正在等待其他 AI 任务释放设备（{blocker}）"),
                None,
                None,
            )
        })?;
        models::check_cancelled(cancelled)?;
        let _lock = models::operation_lock(&self.root)?;
        if !models::installed_ready(&self.root, model) {
            return Err("模型文件在等待期间发生变化，请修复后重试。".into());
        }
        self.update(id, "校验运行环境", None, None);
        let selected = select_runtime(model, &self.runtimes)?;
        let runtime_root = runtime_packages::path(&self.root.join("runtime"), &selected);
        self.verify_runtime(&selected, cancelled)
            .map_err(|e| format!("AI 运行环境不可用，请下载或修复模型：{e}"))?;
        let python = runtime_root.join(&selected.archive.executable);
        models::require_space(&self.root, 512 * 1024 * 1024)?;
        let job_dir = models::safe_directory(&self.root, &format!("jobs/{}", engine::new_id()))?;
        let output = job_dir.join(if model.kind == "image" {
            "result.png"
        } else {
            "result.wav"
        });
        let input = request
            .input_asset
            .as_ref()
            .map(|asset| validated_image(store, runtime, asset))
            .transpose()?;
        let mut payload = adapter_request(
            model,
            request,
            &models::model_root(&self.root, model),
            &output,
            input.as_deref(),
        );
        let adapter = job_dir.join("runner.py");
        let source = if model.kind == "image" {
            include_str!("../../scripts/ai-image-runner.py")
        } else {
            include_str!("../../scripts/ai-music-runner.py")
        };
        fs::write(&adapter, source).map_err(|e| e.to_string())?;
        let request_path = job_dir.join("request.json");
        models::write_json(&request_path, &payload)?;
        self.update(id, "启动生成引擎", None, None);
        let run = self.run_process(id, &python, &adapter, &request_path, &job_dir, cancelled);
        if let Err(error) = run {
            if !cancelled.load(Ordering::SeqCst) && accelerator_failure(&error) {
                self.update(
                    id,
                    "GPU 不可用，正在回退 CPU",
                    None,
                    Some("GPU 运行失败，已回退 CPU；大模型在 CPU 上可能需要较多内存和时间。"),
                );
                let _ = fs::remove_file(&output);
                payload["device"] = json!("cpu");
                models::write_json(&request_path, &payload)?;
                self.run_process(id, &python, &adapter, &request_path, &job_dir, cancelled)?;
            } else {
                return Err(error);
            }
        }
        models::check_cancelled(cancelled)?;
        self.update(id, "检查生成文件", Some(0.99), None);
        models::checked_file(&job_dir, &output)?;
        let asset = if model.kind == "image" {
            store.import_png(&output, &format!("生成图片-{}.png", models::now_ms()))?
        } else {
            let probed = store.probe(runtime, &output, "result.wav")?;
            if probed.kind != "audio"
                || !probed.duration.is_finite()
                || probed.duration <= 0.05
                || probed.duration > 660.0
            {
                return Err("生成结果不是有效的音频文件。".into());
            }
            store.import(
                runtime,
                &output,
                Some(&format!("生成音乐-{}.wav", models::now_ms())),
            )?
        };
        if let Err(error) = models::check_cancelled(cancelled) {
            let _ = fs::remove_file(&asset.native_path);
            return Err(error);
        }
        models::write_json(
            &job_dir.join("result.json"),
            &json!({"modelId": model.id, "modelVersion": model.version, "createdAt": models::now_ms(), "asset": asset}),
        )?;
        // The library owns the completed media. Keep only small provenance records.
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(adapter);
        Ok(asset)
    }
    fn run_process(
        &self,
        id: &str,
        python: &Path,
        adapter: &Path,
        request: &Path,
        directory: &Path,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        models::check_cancelled(cancelled)?;
        let mut command = Command::new(python);
        command
            .args(["-I", "-B", "-u"])
            .arg(adapter)
            .arg("--request")
            .arg(request)
            .current_dir(directory)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_DATASETS_OFFLINE", "1")
            .env("HF_HOME", directory.join("offline-cache"))
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.run_command(id, command, cancelled, None)
    }
    fn run_command(
        &self,
        id: &str,
        mut command: Command,
        cancelled: &AtomicBool,
        timeout: Option<Duration>,
    ) -> Result<()> {
        models::check_cancelled(cancelled)?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        isolate(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动已安装的 AI 运行环境：{e}"))?;
        let stdout = child.stdout.take().ok_or("无法读取生成进度。")?;
        let stderr = child.stderr.take().ok_or("无法读取生成错误。")?;
        let child = Arc::new(Mutex::new(child));
        {
            let mut state = self.shared.lock().map_err(|_| "AI 任务状态不可用。")?;
            if state.closing || cancelled.load(Ordering::SeqCst) {
                terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                return Err(models::CANCELLED.into());
            }
            let Some(task) = state.tasks.get_mut(id) else {
                terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                return Err(models::CANCELLED.into());
            };
            task.process = Some(child.clone());
        }
        let observed_device = Arc::new(Mutex::new(String::new()));
        let reported_error = Arc::new(Mutex::new(None::<String>));
        let reader_error = reported_error.clone();
        let reader_device = observed_device.clone();
        let worker = self.clone();
        let job_id = id.to_owned();
        let out_thread = thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if line.len() > 65536 {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(device) = event["device"].as_str() {
                    *reader_device.lock().unwrap_or_else(|e| e.into_inner()) =
                        device.chars().take(30).collect();
                }
                if let Some(error) = event["error"].as_str() {
                    *reader_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!(
                        "{} {} {}",
                        event["errorType"].as_str().unwrap_or(""),
                        event["code"].as_str().unwrap_or(""),
                        error.chars().take(5000).collect::<String>()
                    ));
                }
                let stage = stage_label(event["stage"].as_str().unwrap_or("generating"));
                worker.update(
                    &job_id,
                    stage,
                    event["progress"].as_f64().map(|p| p.min(0.98)),
                    event["warning"].as_str(),
                );
            }
        });
        let err_thread = thread::spawn(move || {
            let mut tail = Vec::new();
            let mut reader = stderr;
            let mut buffer = [0_u8; 4096];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..size]);
                if tail.len() > 32768 {
                    tail.drain(..tail.len() - 32768);
                }
            }
            String::from_utf8_lossy(&tail).into_owned()
        });
        let started = Instant::now();
        let result = loop {
            if cancelled.load(Ordering::SeqCst) {
                terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                break Err(models::CANCELLED.into());
            }
            if timeout.is_some_and(|limit| started.elapsed() >= limit) {
                terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                break Err("AI 运行环境检查超时。".into());
            }
            let status = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
            match status {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(())
                    } else {
                        Err(format!("生成进程退出（{status}）。"))
                    }
                }
                Ok(None) => thread::sleep(Duration::from_millis(80)),
                Err(error) => {
                    terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
                    break Err(format!("无法读取生成进程：{error}"));
                }
            }
        };
        if let Ok(mut state) = self.shared.lock() {
            if let Some(task) = state.tasks.get_mut(id) {
                task.process = None;
            }
        }
        let _ = out_thread.join();
        let errors = err_thread.join().unwrap_or_default();
        models::check_cancelled(cancelled)?;
        let device = observed_device
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let reported = reported_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(error) = reported {
            return Err(format!("生成失败。device={device} {error} {errors}"));
        }
        result.map_err(|e| {
            format!(
                "{e} device={device} {}",
                errors
                    .chars()
                    .rev()
                    .take(5000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            )
        })
    }
}

fn runtime_file_progress(name: &str, bytes: u64, size: u64, verifying: bool) -> String {
    let (scale, unit) = if size >= 1_000_000_000 {
        (1_000_000_000.0, "GB")
    } else {
        (1_000_000.0, "MB")
    };
    format!(
        "{}运行环境文件 {name}：{:.2} {unit} / {:.2} {unit}（当前文件）",
        if verifying {
            "正在校验"
        } else {
            "正在下载"
        },
        bytes.min(size) as f64 / scale,
        size as f64 / scale
    )
}

fn refresh_shared_runtime_models(
    root: &Path,
    catalog: &[Model],
    runtimes: &[runtime_packages::RuntimeDefinition],
    entries: &mut [AiModel],
    finished_id: &str,
) {
    for entry in entries {
        let Some(definition) = catalog.iter().find(|model| model.id == entry.id) else {
            continue;
        };
        entry.runtime = runtime_status(root, definition, runtimes);
        // The finished download keeps its own error/cancellation result. Other
        // installed models become usable as soon as their shared runtime returns.
        if entry.id == finished_id || matches!(entry.state.as_str(), "downloading" | "verifying") {
            continue;
        }
        if entry.runtime.state == "ready" && models::installed_ready(root, definition) {
            entry.state = "ready".into();
            entry.downloaded_bytes = entry.size;
            entry.error = None;
        } else if entry.state == "ready" {
            entry.state = "update-available".into();
        }
    }
}

fn select_runtime(
    model: &Model,
    definitions: &[runtime_packages::RuntimeDefinition],
) -> Result<runtime_packages::SelectedRuntime> {
    if !definitions.iter().any(|r| r.id == model.runtime_id) {
        return Err("当前版本尚未提供此平台的 AI 运行环境，请更新应用后再下载模型。".into());
    }
    let selected = runtime_packages::select(&model.runtime_id, definitions)?
        .ok_or_else(|| "当前平台暂不支持该模型的本地推理。".to_owned())?;
    platform_requirements()?;
    Ok(selected)
}
fn platform_requirements() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        static VERSION: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
        let major = VERSION.get_or_init(|| {
            Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|s| s.trim().split('.').next()?.parse::<u32>().ok())
        });
        if major.is_none_or(|v| v < 14) {
            return Err("图像和歌曲的本地生成需要 macOS 14 或更新版本。".into());
        }
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        unsafe extern "C" {
            fn gnu_get_libc_version() -> *const std::ffi::c_char;
        }
        let version = unsafe { std::ffi::CStr::from_ptr(gnu_get_libc_version()) }.to_string_lossy();
        let mut parts = version.split('.').filter_map(|v| v.parse::<u32>().ok());
        let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        if (major, minor) < (2, 28) {
            return Err("此 AI 运行环境需要 glibc 2.28 或更新版本。".into());
        }
    }
    #[cfg(all(target_os = "linux", not(target_env = "gnu")))]
    {
        return Err("此 AI 运行环境暂不支持当前 Linux C 库。".into());
    }
    #[allow(unreachable_code)]
    Ok(())
}
fn runtime_status(
    root: &Path,
    model: &Model,
    definitions: &[runtime_packages::RuntimeDefinition],
) -> AiRuntimeStatus {
    match select_runtime(model, definitions) {
        Err(error) => AiRuntimeStatus {
            state: "unsupported".into(),
            device: None,
            reason: Some(error),
        },
        Ok(runtime) => {
            let directory = runtime_packages::path(&root.join("runtime"), &runtime);
            let ready = models::checked_file(&directory, &directory.join("manifest.json")).is_ok()
                && models::checked_file(&directory, &directory.join(&runtime.archive.executable))
                    .is_ok();
            AiRuntimeStatus {
                state: if ready { "ready" } else { "not-downloaded" }.into(),
                device: Some("auto".into()),
                reason: if ready {
                    None
                } else {
                    Some("下载模型时一并安装隔离的推理环境。".into())
                },
            }
        }
    }
}
fn model_state(
    root: &Path,
    model: &Model,
    runtimes: &[runtime_packages::RuntimeDefinition],
) -> AiModel {
    let runtime = runtime_status(root, model, runtimes);
    let ready = models::installed_ready(root, model);
    let size = models::model_size(model);
    AiModel {
        id: model.id.clone(),
        name: model.name.clone(),
        provider: model.kind.clone(),
        capabilities: model
            .modes
            .iter()
            .map(|mode| {
                if mode == "song" {
                    "lyrics-to-song".to_owned()
                } else {
                    mode.clone()
                }
            })
            .collect(),
        version: model.version.clone(),
        size,
        downloaded_bytes: if ready {
            size
        } else {
            models::cached_bytes(root, model)
        },
        download_total_bytes: None,
        download_transferred_bytes: None,
        download_phase: None,
        active_source: None,
        download_session: None,
        download_speed_bytes_per_second: None,
        remaining_seconds: None,
        state: if runtime.state == "unsupported" {
            "unsupported"
        } else if ready && runtime.state == "ready" {
            "ready"
        } else if root.join("models").join(&model.id).exists() {
            "update-available"
        } else {
            "not-downloaded"
        }
        .into(),
        hardware: model.hardware.clone(),
        runtime,
        bundled: false,
        requires_license_acceptance: true,
        license: Some(model.license.name.clone()),
        license_url: Some(model.license.url.clone()),
        error: None,
        voices: Vec::new(),
    }
}
fn persist(root: &Path, jobs: &[AiJob]) {
    let _ = models::write_json(&root.join("jobs.json"), &jobs);
}
fn stage_label(stage: &str) -> &'static str {
    match stage {
        "loading" | "model" => "加载模型",
        "preflight" => "检查内存需求",
        "encoding" | "text" => "编码提示词",
        "device" => "选择计算设备",
        "decoding" => "解码生成结果",
        "saving" | "complete" => "保存生成结果",
        "fallback" => "切换计算设备",
        _ => "正在生成",
    }
}
fn accelerator_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower.contains("memorypreflighterror")
        || lower.contains("insufficient_physical_memory")
        || lower.contains("weightinspectionerror")
        || lower.contains("invalid_weight_header")
    {
        return false;
    }
    let detail = lower.replace("device=mps", "").replace("device=cuda", "");
    (lower.contains("device=cuda") || lower.contains("device=mps"))
        && [
            "out of memory",
            "mps",
            "cuda",
            "signal",
            "abort",
            "device-side",
            "kernel",
        ]
        .iter()
        .any(|s| detail.contains(s))
}
fn validated_image(store: &MediaStore, runtime: &Runtime, asset: &Asset) -> Result<PathBuf> {
    let path = store.authorized_path(&serde_json::to_value(asset).map_err(|e| e.to_string())?)?;
    let actual = store.probe(runtime, &path, &asset.name)?;
    if actual.kind != "image"
        || actual.width == 0
        || actual.height == 0
        || u64::from(actual.width) * u64::from(actual.height) > 40_000_000
    {
        return Err("参考素材必须是已导入的有效图片，且不超过 4000 万像素。".into());
    }
    Ok(path)
}
fn validate_request(model: &Model, request: &AiGenerationRequest) -> Result<()> {
    if !models::safe_id(&request.request_id)
        || request.prompt.trim().is_empty()
        || request.prompt.chars().count() > 6000
        || request.prompt.contains('\0')
    {
        return Err("请输入有效的提示词与请求编号（提示词不超过 6000 字）。".into());
    }
    if request.seed.is_some_and(|s| s > u32::MAX as u64)
        || request.steps.is_some_and(|n| n == 0 || n > 100)
        || request
            .guidance
            .is_some_and(|n| !n.is_finite() || !(0.0..=30.0).contains(&n))
    {
        return Err("种子、步数或引导强度超出有效范围。".into());
    }
    if request
        .negative_prompt
        .as_ref()
        .is_some_and(|s| s.chars().count() > 6000 || s.contains('\0'))
    {
        return Err("负面提示词无效或过长。".into());
    }
    if model.kind == "image" {
        if request
            .guidance
            .is_some_and(|n| n > 20.0 || (model.id == "z-image-turbo" && n != 0.0))
        {
            return Err("图像模型提示词强度无效；快速模型需使用 0。".into());
        }
        for size in [
            request.width.unwrap_or(1024),
            request.height.unwrap_or(1024),
        ] {
            if !(256..=2048).contains(&size) || size % 16 != 0 {
                return Err("图片宽高应为 256–2048 范围内的 16 的倍数。".into());
            }
        }
        let strength = request.strength.unwrap_or(0.75);
        if !strength.is_finite() || strength <= 0.0 || strength > 1.0 {
            return Err("参考图强度应大于 0 且不超过 1。".into());
        }
        if model.id == "z-image-turbo"
            && request
                .negative_prompt
                .as_ref()
                .is_some_and(|p| !p.trim().is_empty())
        {
            return Err("当前快速图像模型不支持负面提示词，请清空后重试。".into());
        }
        let steps = request
            .steps
            .unwrap_or(if model.id == "z-image-turbo" { 9 } else { 50 });
        if request.input_asset.is_some() && (steps as f64 * strength).floor() < 1.0 {
            return Err("参考图强度与步数过低，至少需要一个有效生成步。".into());
        }
        if request.lyrics.is_some() || request.seconds.is_some() {
            return Err("图像模型不接受歌曲参数。".into());
        }
    } else {
        if request.prompt.chars().count() > 4096
            || request
                .negative_prompt
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty())
        {
            return Err("音乐提示词不能超过 4096 字，且当前模型不接受负面提示词。".into());
        }
        if request
            .language
            .as_ref()
            .is_some_and(|s| s.len() > 20 || s.contains('\0'))
            || request
                .key_scale
                .as_ref()
                .is_some_and(|s| s.len() > 64 || s.contains('\0'))
        {
            return Err("音乐语言或调式参数无效。".into());
        }
        if request.input_asset.is_some() || request.width.is_some() || request.height.is_some() {
            return Err("歌曲模型不接受图像参数。".into());
        }
        let seconds = request.seconds.unwrap_or(30.0);
        if !seconds.is_finite() || !(10.0..=600.0).contains(&seconds) {
            return Err("音乐时长应为 10–600 秒。".into());
        }
        if request
            .lyrics
            .as_ref()
            .is_some_and(|s| s.chars().count() > 6000 || s.contains('\0'))
        {
            return Err("歌词无效或超过 6000 字。".into());
        }
        if is_instrumental(request)
            && request
                .lyrics
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty() && s.trim() != "[Instrumental]")
        {
            return Err("纯音乐模式不使用歌词，请清空歌词或切换为歌曲。".into());
        }
        if model.id == "ace-step-1.5-turbo" && request.guidance.is_some_and(|n| n != 1.0) {
            return Err("快速音乐模型的提示词强度固定为 1。".into());
        }
        if !is_instrumental(request) && request.lyrics.as_ref().is_none_or(|s| s.trim().is_empty())
        {
            return Err("歌曲生成需要填写歌词；纯音乐请开启纯音乐选项。".into());
        }
        if request.bpm.is_some_and(|n| !(30..=300).contains(&n)) {
            return Err("节奏速度应在 30–300 BPM 之间。".into());
        }
    }
    Ok(())
}
fn is_instrumental(request: &AiGenerationRequest) -> bool {
    request
        .instrumental
        .unwrap_or_else(|| request.lyrics.as_ref().is_none_or(|s| s.trim().is_empty()))
}
fn adapter_request(
    model: &Model,
    request: &AiGenerationRequest,
    model_root: &Path,
    output: &Path,
    image: Option<&Path>,
) -> Value {
    let mut value = json!({"modelId": model.id, "modelRoot": model_root, "outputPath": output, "prompt": request.prompt,
        "device": "auto", "memoryMode": if request.low_memory.unwrap_or(true) { "low" } else { "balanced" }});
    let map = value.as_object_mut().unwrap();
    macro_rules! field {
        ($key:literal, $value:expr) => {
            if let Some(value) = $value {
                map.insert($key.into(), json!(value));
            }
        };
    }
    field!("negativePrompt", &request.negative_prompt);
    field!("steps", request.steps);
    field!("guidance", request.guidance);
    field!("seed", request.seed);
    if model.kind == "image" {
        map.insert(
            "mode".into(),
            json!(if image.is_some() {
                "image-to-image"
            } else {
                "text-to-image"
            }),
        );
        map.insert("width".into(), json!(request.width.unwrap_or(1024)));
        map.insert("height".into(), json!(request.height.unwrap_or(1024)));
        field!("inputImagePath", image);
        field!("strength", request.strength);
    } else {
        map.insert(
            "mode".into(),
            json!(if is_instrumental(request) {
                "text-to-music"
            } else {
                "song"
            }),
        );
        map.insert("seconds".into(), json!(request.seconds.unwrap_or(30.0)));
        map.insert("instrumental".into(), json!(is_instrumental(request)));
        field!("lyrics", &request.lyrics);
        field!("bpm", request.bpm);
        field!("language", &request.language);
        field!("keyScale", &request.key_scale);
    }
    value
}
fn shutdown_shared(shared: &Mutex<State>) {
    let processes = {
        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
        state.closing = true;
        if let Some(download) = &state.download {
            download.cancelled.store(true, Ordering::SeqCst);
        }
        state
            .tasks
            .values_mut()
            .filter_map(|task| {
                task.cancelled.store(true, Ordering::SeqCst);
                task.process.take()
            })
            .collect::<Vec<_>>()
    };
    for child in processes {
        terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
    }
}
fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000200);
    }
}
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        unsafe {
            kill(-(child.id() as i32), 9);
        }
    }
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        isolate(&mut kill);
        let _ = kill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
#[path = "ai_generation_tests.rs"]
mod tests;
