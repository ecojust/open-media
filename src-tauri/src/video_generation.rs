//! Optional local video generation. Model bytes are installed separately from the app.
use crate::engine::{self, Asset, MediaStore, Result, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "video_generation_download.rs"]
mod download;

const CANCELLED: &str = "视频生成操作已取消。";
const MAX_HISTORY: usize = 100;
const MODEL_CATALOG: &str = include_str!("../resources/video-generation-models.json");

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    engine: Engine,
    revision: String,
    license: License,
    models: Vec<Model>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Engine {
    version: String,
    executable: String,
    shader: String,
}
#[derive(Clone, Deserialize)]
struct License {
    url: String,
    text: String,
    notice: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    name: String,
    modes: Vec<String>,
    #[serde(default)]
    requires: Vec<String>,
    files: Vec<ModelFile>,
}
#[derive(Clone, Deserialize)]
struct ModelFile {
    path: String,
    size: u64,
    sha256: String,
    urls: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationModel {
    id: String,
    name: String,
    version: String,
    modes: Vec<String>,
    size: u64,
    downloaded_bytes: u64,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    license_url: String,
    hardware: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationStatus {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    runtime_ready: bool,
    runtime_version: String,
    device: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_bytes: Option<u64>,
    models: Vec<VideoGenerationModel>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationReference {
    asset: Value,
    kind: String,
    #[serde(default)]
    include_audio: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationShot {
    id: String,
    title: String,
    prompt: String,
    seconds: f64,
    #[serde(default)]
    first_frame: Option<Value>,
    #[serde(default)]
    last_frame: Option<Value>,
    #[serde(default)]
    references: Vec<VideoGenerationReference>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationRequest {
    request_id: String,
    model_id: String,
    mode: String,
    width: u32,
    height: u32,
    steps: u32,
    seed: u32,
    #[serde(default)]
    low_memory: bool,
    #[serde(default)]
    join_shots: bool,
    shots: Vec<VideoGenerationShot>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationJob {
    id: String,
    state: String,
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    shot_index: usize,
    shot_count: usize,
    started_at: u64,
    elapsed_seconds: f64,
    assets: Vec<Asset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    combined_asset: Option<Asset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

struct Active {
    id: String,
    download: bool,
    cancelled: Arc<AtomicBool>,
}
struct State {
    models: Vec<VideoGenerationModel>,
    jobs: Vec<VideoGenerationJob>,
    active: Option<Active>,
    early_cancelled: HashSet<String>,
}
struct Owner {
    shared: Arc<Mutex<State>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        if let Ok(state) = self.shared.lock() {
            if let Some(active) = &state.active {
                active.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }
}
#[derive(Clone)]
struct Worker {
    root: PathBuf,
    catalog: Arc<Catalog>,
    shared: Arc<Mutex<State>>,
    runner: Arc<OnceLock<Result<PathBuf>>>,
}
#[derive(Clone)]
pub struct VideoGenerationManager {
    worker: Worker,
    owner: Arc<Owner>,
    unsupported: Option<String>,
    memory_bytes: Option<u64>,
}

impl VideoGenerationManager {
    pub fn new(app_data: &Path) -> Result<Self> {
        let catalog: Catalog = serde_json::from_str(MODEL_CATALOG)
            .map_err(|error| format!("视频生成模型清单无效：{error}"))?;
        validate_catalog(&catalog)?;
        let root = app_data.join("video-generation");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        checked_directory(&root)?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for name in ["blobs", "parts", "models", "jobs", "runtime"] {
            safe_directory(&root, name)?;
        }
        let unsupported = unsupported_reason();
        // The first status/begin command initializes this on its blocking worker,
        // never during application setup on the window thread.
        let runner = Arc::new(OnceLock::new());
        let mut jobs: Vec<VideoGenerationJob> =
            read_json(&root.join("jobs.json")).unwrap_or_default();
        jobs.truncate(MAX_HISTORY);
        for job in &mut jobs {
            if job.state == "running" {
                job.state = "failed".into();
                job.stage = "生成已中断".into();
                job.error = Some(
                    "应用在上次生成期间退出；已完成的分镜仍可使用，请重新提交未完成的分镜。".into(),
                );
            }
        }
        let models = catalog.models.iter().map(|model| {
            let files = model_files(&catalog, model).expect("validated dependency graph");
            let size = unique_bytes(&files);
            let installed = model_root(&root, &catalog, model);
            let ready = download::installed_ready(&installed, &catalog, model, &files);
            VideoGenerationModel {
                id: model.id.clone(), name: model.name.clone(), version: catalog.revision.clone(), modes: model.modes.clone(), size,
                downloaded_bytes: if ready { size } else { download::cached_bytes(&root, &files) },
                state: if unsupported.is_some() { "unsupported" } else if ready { "ready" } else if installed.exists() || root.join("models").join(&model.id).exists() { "update-available" } else { "not-downloaded" }.into(),
                error: None, license_url: catalog.license.url.clone(),
                hardware: "Apple 芯片 Mac · macOS 15 或更新版本；建议 64 GB 以上统一内存。低内存模式使用 SSD，生成较慢，需预留模型与输出空间。".into(),
            }
        }).collect();
        let shared = Arc::new(Mutex::new(State {
            models,
            jobs,
            active: None,
            early_cancelled: HashSet::new(),
        }));
        let manager = Self {
            worker: Worker {
                root,
                catalog: Arc::new(catalog),
                shared: shared.clone(),
                runner,
            },
            owner: Arc::new(Owner { shared }),
            unsupported,
            memory_bytes: physical_memory(),
        };
        manager.worker.persist_jobs();
        Ok(manager)
    }

    pub fn status(&self) -> VideoGenerationStatus {
        let mut models = self
            .owner
            .shared
            .lock()
            .map(|state| state.models.clone())
            .unwrap_or_default();
        let runtime = self.runtime();
        if self.unsupported.is_none() {
            if let Err(error) = runtime {
                for model in &mut models {
                    model.state = "failed".into();
                    model.error = Some(error.clone());
                }
            }
        }
        VideoGenerationStatus {
            supported: self.unsupported.is_none(),
            reason: self
                .unsupported
                .clone()
                .or_else(|| runtime.as_ref().err().cloned()),
            runtime_ready: runtime.is_ok(),
            runtime_version: self.worker.catalog.engine.version.clone(),
            device: if self.unsupported.is_none() && runtime.is_ok() {
                "Apple GPU · Metal"
            } else {
                ""
            }
            .into(),
            memory_bytes: self.memory_bytes,
            models,
        }
    }
    fn runtime(&self) -> &Result<PathBuf> {
        self.worker.runner.get_or_init(|| {
            if let Some(reason) = &self.unsupported {
                Err(reason.clone())
            } else {
                install_runtime(&self.worker.root, &self.worker.catalog)
            }
        })
    }
    fn require_supported(&self) -> Result<()> {
        if let Some(reason) = &self.unsupported {
            return Err(reason.clone());
        }
        self.runtime().as_ref().map(|_| ()).map_err(Clone::clone)
    }
    pub fn begin_download(
        &self,
        model_id: &str,
        accepted_license: bool,
    ) -> Result<VideoGenerationStatus> {
        self.require_supported()?;
        if !accepted_license {
            return Err("请先阅读模型许可并确认适用地区与使用资格；接受后才会下载。".into());
        }
        let model = self
            .worker
            .catalog
            .models
            .iter()
            .find(|m| m.id == model_id)
            .ok_or("视频模型不存在。")?
            .clone();
        let files = model_files(&self.worker.catalog, &model)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self
                .owner
                .shared
                .lock()
                .map_err(|_| "视频任务状态不可用。")?;
            require_idle(&state)?;
            state.active = Some(Active {
                id: model.id.clone(),
                download: true,
                cancelled: cancelled.clone(),
            });
            let status = state.models.iter_mut().find(|m| m.id == model.id).unwrap();
            status.state = "downloading".into();
            status.error = None;
        }
        let worker = self.worker.clone();
        let id = model.id.clone();
        if let Err(error) = thread::Builder::new()
            .name("video-model-download".into())
            .spawn(move || {
                let result = download::install_model(&worker, &model, &files, &cancelled);
                worker.refresh_installed();
                if let Ok(mut state) = worker.shared.lock() {
                    if let Some(status) = state.models.iter_mut().find(|m| m.id == model.id) {
                        match result {
                            Ok(()) => {
                                status.state = "ready".into();
                                status.downloaded_bytes = status.size;
                                status.error = None;
                            }
                            Err(error) => {
                                status.state = if cancelled.load(Ordering::SeqCst) {
                                    "not-downloaded"
                                } else {
                                    "failed"
                                }
                                .into();
                                status.error = if cancelled.load(Ordering::SeqCst) {
                                    None
                                } else {
                                    Some(error)
                                };
                            }
                        }
                    }
                    state.active = None;
                }
            })
        {
            self.worker.clear_active(&id);
            return Err(format!("无法启动下载：{error}"));
        }
        Ok(self.status())
    }
    pub fn cancel_download(&self, model_id: &str) -> Result<VideoGenerationStatus> {
        if !self.worker.catalog.models.iter().any(|m| m.id == model_id) {
            return Err("视频模型不存在。".into());
        }
        let state = self
            .owner
            .shared
            .lock()
            .map_err(|_| "视频任务状态不可用。")?;
        if let Some(active) = &state.active {
            if active.download && active.id == model_id {
                active.cancelled.store(true, Ordering::SeqCst);
            }
        }
        drop(state);
        Ok(self.status())
    }
    pub fn begin(
        &self,
        runtime: Runtime,
        store: MediaStore,
        request: VideoGenerationRequest,
    ) -> Result<VideoGenerationJob> {
        self.require_supported()?;
        validate_request(&request, &self.worker.catalog)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = {
            let mut state = self
                .owner
                .shared
                .lock()
                .map_err(|_| "视频任务状态不可用。")?;
            if let Some(job) = state.jobs.iter().find(|j| j.id == request.request_id) {
                return Ok(job.clone());
            }
            require_idle(&state)?;
            if !state
                .models
                .iter()
                .any(|m| m.id == request.model_id && m.state == "ready")
            {
                return Err("模型尚未就绪，请先下载或更新并等待校验完成。".into());
            }
            let early_cancelled = state.early_cancelled.remove(&request.request_id);
            let job = VideoGenerationJob {
                id: request.request_id.clone(),
                state: if early_cancelled {
                    "cancelled"
                } else {
                    "running"
                }
                .into(),
                stage: if early_cancelled {
                    "已取消"
                } else {
                    "正在检查模型与参考素材"
                }
                .into(),
                progress: None,
                shot_index: 0,
                shot_count: request.shots.len(),
                started_at: now_ms(),
                elapsed_seconds: 0.0,
                assets: vec![],
                combined_asset: None,
                error: None,
                warning: if !request.low_memory
                    && self
                        .memory_bytes
                        .is_some_and(|bytes| bytes < 64 * 1024 * 1024 * 1024)
                {
                    Some(
                        "统一内存不足 64 GB，建议开启低内存模式；生成速度取决于内存、SSD 与画幅。"
                            .into(),
                    )
                } else {
                    None
                },
            };
            state.jobs.insert(0, job.clone());
            state.jobs.truncate(MAX_HISTORY);
            if !early_cancelled {
                state.active = Some(Active {
                    id: job.id.clone(),
                    download: false,
                    cancelled: cancelled.clone(),
                });
            }
            job
        };
        self.worker.persist_jobs();
        if job.state == "cancelled" {
            return Ok(job);
        }
        let worker = self.worker.clone();
        let id = job.id.clone();
        if let Err(error) = thread::Builder::new()
            .name("video-generation".into())
            .spawn(move || {
                let result = worker.generate(&runtime, &store, &request, &cancelled);
                worker.update_job(&request.request_id, |job| {
                    if cancelled.load(Ordering::SeqCst) {
                        job.state = "cancelled".into();
                        job.stage = "已取消，已完成的分镜已保留".into();
                        job.progress = None;
                    } else {
                        match result {
                            Ok(()) => {
                                job.state = "completed".into();
                                job.stage = "视频已生成".into();
                                job.progress = Some(1.0);
                            }
                            Err(error) => {
                                job.state = "failed".into();
                                job.stage = "生成失败，已完成的分镜已保留".into();
                                job.error = Some(error);
                            }
                        }
                    }
                });
                worker.clear_active(&request.request_id);
                worker.persist_jobs();
            })
        {
            self.worker.clear_active(&id);
            self.worker.update_job(&id, |job| {
                job.state = "failed".into();
                job.error = Some(error.to_string());
            });
            self.worker.persist_jobs();
            return Err(format!("无法启动生成：{error}"));
        }
        Ok(job)
    }
    pub fn get(&self, id: &str) -> Result<VideoGenerationJob> {
        self.list()?
            .into_iter()
            .find(|job| job.id == id)
            .ok_or_else(|| "视频生成任务不存在。".into())
    }
    pub fn list(&self) -> Result<Vec<VideoGenerationJob>> {
        let mut jobs = self
            .owner
            .shared
            .lock()
            .map_err(|_| "视频任务状态不可用。")?
            .jobs
            .clone();
        for job in &mut jobs {
            if job.state == "running" {
                job.elapsed_seconds = now_ms().saturating_sub(job.started_at) as f64 / 1000.0;
            }
        }
        Ok(jobs)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let mut state = self
            .owner
            .shared
            .lock()
            .map_err(|_| "视频任务状态不可用。")?;
        if !state.jobs.iter().any(|job| job.id == id) {
            if !safe_id(id) {
                return Err("生成请求标识无效。".into());
            }
            if state.early_cancelled.len() >= MAX_HISTORY {
                state.early_cancelled.clear();
            }
            state.early_cancelled.insert(id.to_owned());
            return Ok(());
        }
        if let Some(active) = &state.active {
            if !active.download && active.id == id {
                active.cancelled.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
}

impl Worker {
    fn update_job(&self, id: &str, update: impl FnOnce(&mut VideoGenerationJob)) {
        if let Ok(mut state) = self.shared.lock() {
            if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
                update(job);
                job.elapsed_seconds = now_ms().saturating_sub(job.started_at) as f64 / 1000.0;
            }
        }
    }
    fn persist_jobs(&self) {
        // Serialize under the same lock to prevent an older checkpoint replacing a newer one.
        if let Ok(state) = self.shared.lock() {
            let _ = write_json(&self.root.join("jobs.json"), &state.jobs);
        }
    }
    fn clear_active(&self, id: &str) {
        if let Ok(mut state) = self.shared.lock() {
            if state.active.as_ref().is_some_and(|a| a.id == id) {
                state.active = None;
            }
        }
    }
    fn refresh_installed(&self) {
        for model in &self.catalog.models {
            let Ok(files) = model_files(&self.catalog, model) else {
                continue;
            };
            if download::installed_ready(
                &model_root(&self.root, &self.catalog, model),
                &self.catalog,
                model,
                &files,
            ) {
                if let Ok(mut state) = self.shared.lock() {
                    if let Some(status) = state.models.iter_mut().find(|m| m.id == model.id) {
                        status.state = "ready".into();
                        status.downloaded_bytes = status.size;
                        status.error = None;
                    }
                }
            }
        }
    }
    fn generate(
        &self,
        runtime: &Runtime,
        store: &MediaStore,
        request: &VideoGenerationRequest,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        checked_directory(&self.root)?;
        check_cancelled(cancelled)?;
        let _operation_lock = operation_lock(&self.root)?;
        let model = self
            .catalog
            .models
            .iter()
            .find(|m| m.id == request.model_id)
            .ok_or("视频模型不存在。")?;
        let model_dir = model_root(&self.root, &self.catalog, model);
        let files = model_files(&self.catalog, model)?;
        if !download::installed_ready(&model_dir, &self.catalog, model, &files) {
            if let Ok(mut state) = self.shared.lock() {
                if let Some(status) = state.models.iter_mut().find(|m| m.id == model.id) {
                    status.state = "update-available".into();
                    status.error = Some("模型文件已改变，请点击更新以重新校验并修复。".into());
                }
            }
            return Err("模型文件已改变，请更新模型后再生成。".into());
        }
        download::require_space(&self.root, 2 * 1024 * 1024 * 1024)?;
        let work_root = safe_directory(&self.root, "jobs")?;
        let temporary = tempfile::Builder::new()
            .prefix("generate-")
            .tempdir_in(&work_root)
            .map_err(|e| e.to_string())?;
        let working = temporary.path();
        write_json(
            &working.join("source.json"),
            &json!({"schema":1,"createdAt":now_ms(),"modelVersion":self.catalog.revision,"engineVersion":self.catalog.engine.version,"request":request}),
        )?;
        let mut outputs = Vec::new();
        for (index, shot) in request.shots.iter().enumerate() {
            check_cancelled(cancelled)?;
            self.update_job(&request.request_id, |job| {
                job.shot_index = index;
                job.stage = format!("分镜 {}/{}：检查参考素材", index + 1, request.shots.len());
                job.progress = Some(index as f64 / request.shots.len() as f64);
            });
            let output = working.join(format!("shot-{index:03}.mp4"));
            let native =
                build_runner_request(&model_dir, &output, runtime, store, request, shot, index)?;
            let input = working.join(format!("shot-{index:03}.json"));
            write_json(&input, &native)?;
            let runner = self
                .runner
                .get()
                .ok_or("生成引擎尚未初始化。")?
                .as_ref()
                .map_err(Clone::clone)?;
            let mut command = Command::new(runner);
            command
                .args(["--request"])
                .arg(&input)
                .current_dir(runner.parent().ok_or("生成引擎目录无效。")?)
                .env("H3_FFMPEG", &runtime.encoder)
                .env("H3_FFPROBE", &runtime.probe)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            isolate_process(&mut command);
            self.run_child(
                command,
                &request.request_id,
                index,
                request.shots.len(),
                cancelled,
            )?;
            check_cancelled(cancelled)?;
            checked_file(&working, &output)?;
            let name = format!("{}-{}.mp4", safe_title(&shot.title), index + 1);
            let asset = store.import(runtime, &output, Some(&name))?;
            if asset.kind != "video"
                || asset.width != request.width
                || asset.height != request.height
                || (asset.duration - frames_for_seconds(shot.seconds) as f64 / 24.0).abs() > 0.5
            {
                let _ = fs::remove_file(&asset.native_path);
                return Err("生成引擎输出的格式、尺寸或时长无效。".into());
            }
            self.update_job(&request.request_id, |job| job.assets.push(asset.clone()));
            self.persist_jobs();
            write_json(
                &Path::new(&asset.native_path).with_extension("generation.json"),
                &json!({"schema":1,"generatedAt":now_ms(),"modelId":request.model_id,"modelVersion":self.catalog.revision,"engineVersion":self.catalog.engine.version,"seed":request.seed.wrapping_add(index as u32),"shot":shot,"requestId":request.request_id}),
            )?;
            outputs.push(asset);
            let _ = fs::remove_file(output);
        }
        if request.join_shots && outputs.len() > 1 {
            self.update_job(&request.request_id, |job| {
                job.stage = "正在按实际分镜时长合并视频".into();
                job.progress = None;
            });
            let joined = working.join("combined.mp4");
            let concat = working.join("concat.txt");
            // Internal filenames have no user-supplied shell or concat syntax.
            let mut lines = String::new();
            for asset in &outputs {
                let path = store
                    .authorized_path(&serde_json::to_value(asset).map_err(|e| e.to_string())?)?;
                lines.push_str(&format!(
                    "file '{}'\n",
                    path.to_string_lossy()
                        .replace('\\', "\\\\")
                        .replace('\'', "'\\''")
                ));
            }
            fs::write(&concat, lines).map_err(|e| e.to_string())?;
            let mut command = engine::process(&runtime.encoder);
            command
                .args([
                    "-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i",
                ])
                .arg(&concat)
                .args([
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a?",
                    "-c",
                    "copy",
                    "-movflags",
                    "+faststart",
                ])
                .arg(&joined)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            isolate_process(&mut command);
            self.run_child(
                command,
                &request.request_id,
                request.shots.len() - 1,
                request.shots.len(),
                cancelled,
            )?;
            check_cancelled(cancelled)?;
            checked_file(&working, &joined)?;
            let asset = store.import(runtime, &joined, Some("生成分镜合辑.mp4"))?;
            let expected: f64 = outputs.iter().map(|a| a.duration).sum();
            if asset.kind != "video" || (asset.duration - expected).abs() > 1.0 {
                let _ = fs::remove_file(&asset.native_path);
                return Err("分镜合并后的时长不正确，单个分镜仍已保留。".into());
            }
            write_json(
                &Path::new(&asset.native_path).with_extension("generation.json"),
                &json!({"schema":1,"generatedAt":now_ms(),"modelId":request.model_id,"modelVersion":self.catalog.revision,"request":request,"sourceAssets":outputs}),
            )?;
            self.update_job(&request.request_id, |job| job.combined_asset = Some(asset));
            self.persist_jobs();
            let _ = fs::remove_file(joined);
        }
        Ok(())
    }

    fn run_child(
        &self,
        mut command: Command,
        id: &str,
        index: usize,
        count: usize,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动视频生成引擎：{e}"))?;
        let stdout = child.stdout.take().ok_or("生成引擎没有输出流。")?;
        let stderr = child.stderr.take().ok_or("生成引擎没有错误流。")?;
        let (sender, receiver) = std::sync::mpsc::sync_channel::<String>(128);
        let output_thread = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() <= 64 * 1024 {
                    let _ = sender.try_send(line);
                }
            }
        });
        let error_thread = thread::spawn(move || {
            let mut tail = String::new();
            for line in BufReader::new(stderr).lines() {
                if let Ok(line) = line {
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > 16000 {
                        let start = tail
                            .char_indices()
                            .find(|(i, _)| *i >= tail.len() - 12000)
                            .map_or(0, |(i, _)| i);
                        tail.drain(..start);
                    }
                } else {
                    break;
                }
            }
            tail
        });
        let mut reported_error = None;
        let exit = loop {
            for line in receiver.try_iter() {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value["type"] == "error" {
                        reported_error = value["message"].as_str().map(str::to_owned);
                    }
                    if value["type"] == "progress" {
                        let stage = stage_label(value["stage"].as_str().unwrap_or("generating"));
                        let fraction = value["completed"]
                            .as_u64()
                            .zip(value["total"].as_u64())
                            .filter(|(_, total)| *total > 0)
                            .map_or(String::new(), |(done, total)| {
                                format!("（{}/{total}）", done.min(total))
                            });
                        // Every engine phase has an independent counter. Do not
                        // present a phase reaching 100% as whole-job completion.
                        self.update_job(id, |job| {
                            job.stage = format!("分镜 {}/{}：{stage}{fraction}", index + 1, count);
                            job.progress = None;
                        });
                    }
                }
            }
            if cancelled.load(Ordering::SeqCst) {
                terminate(&mut child);
                break Err(CANCELLED.into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(())
                    } else {
                        Err(format!("生成进程退出（{status}）。"))
                    }
                }
                Ok(None) => thread::sleep(Duration::from_millis(80)),
                Err(error) => {
                    terminate(&mut child);
                    break Err(format!("无法读取生成进程：{error}"));
                }
            }
        };
        let _ = output_thread.join();
        let errors = error_thread.join().unwrap_or_default();
        if cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        if let Some(error) = reported_error {
            return Err(error);
        }
        exit.map_err(|error| format!("{error} {}", errors.chars().take(3000).collect::<String>()))
    }
}

fn stage_label(stage: &str) -> &'static str {
    match stage {
        "loading" | "model" | "load transformer core" => "加载模型",
        "text encoder" | "tokenizer" | "conditioning" | "encoding" | "text" => "编码提示词",
        "Qwen vision" | "video VAE encoder" => "编码参考画面",
        "denoise" | "denoise enqueue" | "denoising" | "generating" | "sampling" => "生成画面",
        "video VAE load" | "preview VAE load" => "加载画面解码器",
        "decoding" => "解码画面",
        "audio VAE encoder" => "编码参考声音",
        "audio VAE" | "audio" => "生成声音",
        "FFmpeg" | "muxing" | "encoding-video" | "saving" => "编码视频",
        _ => "处理视频",
    }
}
fn require_idle(state: &State) -> Result<()> {
    if let Some(active) = &state.active {
        Err(format!(
            "正在{}（{}），请等待完成或取消后再试。",
            if active.download {
                "下载模型"
            } else {
                "生成视频"
            },
            active.id
        ))
    } else {
        Ok(())
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
fn safe_title(title: &str) -> String {
    let title: String = title
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(80)
        .collect();
    if title.trim().is_empty() {
        "生成分镜".into()
    } else {
        title
    }
}
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 500
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && !path.chars().any(char::is_control)
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn checked_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("工作目录不可用：{e}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("工作目录不能是链接或普通文件。".into());
    }
    Ok(())
}
fn operation_lock(root: &Path) -> Result<fs::File> {
    checked_directory(root)?;
    let path = root.join("operation.lock");
    if path.exists() {
        checked_file(root, &path)?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("无法锁定视频生成工作目录：{e}"))?;
    file.try_lock()
        .map_err(|_| "另一个应用窗口正在下载模型或生成视频，请等待该任务结束。")?;
    Ok(file)
}
fn safe_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    if !safe_relative(relative) {
        return Err("工作目录路径无效。".into());
    }
    checked_directory(root)?;
    let mut current = root.to_owned();
    for part in Path::new(relative).components() {
        current.push(part);
        if !current.exists() {
            match fs::create_dir(&current) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        checked_directory(&current)?;
    }
    Ok(current)
}
fn checked_file(root: &Path, path: &Path) -> Result<()> {
    if !path.starts_with(root) {
        return Err("文件不在视频生成工作目录中。".into());
    }
    if root.is_absolute() && root.canonicalize().map_err(|e| e.to_string())? != root {
        return Err("文件目录已改变，不能通过链接访问模型或输出。".into());
    }
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    let mut current = root.to_owned();
    checked_directory(root)?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err("文件路径无效。".into());
        }
        current.push(part);
        let meta = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("模型或输出文件不能是符号链接。".into());
        }
    }
    if !path.is_file() {
        return Err("生成文件不存在。".into());
    }
    Ok(())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("保存路径无效。")?;
    checked_directory(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(temp.as_file_mut(), value).map_err(|e| e.to_string())?;
    temp.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
        return Err("本地生成状态文件无效。".into());
    }
    serde_json::from_reader(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn unique_bytes(files: &[ModelFile]) -> u64 {
    let mut hashes = HashSet::new();
    files
        .iter()
        .filter(|f| hashes.insert(&f.sha256))
        .map(|f| f.size)
        .sum()
}
fn model_root(root: &Path, catalog: &Catalog, model: &Model) -> PathBuf {
    root.join("models").join(&model.id).join(&catalog.revision)
}
fn model_files(catalog: &Catalog, model: &Model) -> Result<Vec<ModelFile>> {
    fn add(
        catalog: &Catalog,
        model: &Model,
        visiting: &mut HashSet<String>,
        result: &mut HashMap<String, ModelFile>,
    ) -> Result<()> {
        if !visiting.insert(model.id.clone()) {
            return Err("模型依赖存在循环。".into());
        }
        for id in &model.requires {
            add(
                catalog,
                catalog
                    .models
                    .iter()
                    .find(|m| &m.id == id)
                    .ok_or("模型依赖缺失。")?,
                visiting,
                result,
            )?;
        }
        for file in &model.files {
            if let Some(previous) = result.insert(file.path.clone(), file.clone()) {
                if previous.sha256 != file.sha256 || previous.size != file.size {
                    return Err("模型文件路径发生冲突。".into());
                }
            }
        }
        visiting.remove(&model.id);
        Ok(())
    }
    let mut files = HashMap::new();
    add(catalog, model, &mut HashSet::new(), &mut files)?;
    let mut files: Vec<_> = files.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
fn validate_catalog(catalog: &Catalog) -> Result<()> {
    if catalog.schema_version != 1
        || !safe_id(&catalog.revision)
        || !safe_id(&catalog.engine.version)
        || !safe_id(&catalog.engine.executable)
        || !safe_relative(&catalog.engine.shader)
        || catalog.models.is_empty()
    {
        return Err("视频模型清单版本无效。".into());
    }
    let mut ids = HashSet::new();
    for model in &catalog.models {
        if !safe_id(&model.id) || !ids.insert(&model.id) || model.files.is_empty() {
            return Err("视频模型标识无效。".into());
        }
        for file in model_files(catalog, model)? {
            if !safe_relative(&file.path)
                || file.size == 0
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                || file.urls.is_empty()
                || !file.urls.iter().all(|u| u.starts_with("https://"))
            {
                return Err("视频模型文件清单不安全或不完整。".into());
            }
        }
    }
    Ok(())
}

fn validate_request(request: &VideoGenerationRequest, catalog: &Catalog) -> Result<()> {
    let model = catalog
        .models
        .iter()
        .find(|m| m.id == request.model_id)
        .ok_or("视频模型不存在。")?;
    if !safe_id(&request.request_id)
        || !model.modes.contains(&request.mode)
        || !["prompt", "image", "reference", "storyboard"].contains(&request.mode.as_str())
    {
        return Err("生成请求标识、模型或生成方式无效。".into());
    }
    if request.width < 256
        || request.height < 256
        || request.width % 32 != 0
        || request.height % 32 != 0
        || u64::from(request.width) * u64::from(request.height) > 768 * 1344
    {
        return Err("生成画幅宽高需为至少 256 的 32 倍数，总像素不超过 1344 × 768。".into());
    }
    if !(4..=50).contains(&request.steps)
        || request.shots.is_empty()
        || request.shots.len() > 20
        || (request.mode != "storyboard" && request.shots.len() != 1)
    {
        return Err("生成步数或分镜数量无效。".into());
    }
    let mut ids = HashSet::new();
    for shot in &request.shots {
        if !safe_id(&shot.id)
            || !ids.insert(&shot.id)
            || shot.title.encode_utf16().count() > 200
            || shot.prompt.trim().is_empty()
            || shot.prompt.contains('\0')
            || shot.prompt.encode_utf16().count() > 8000
            || !shot.seconds.is_finite()
            || !(1.0..=15.0).contains(&shot.seconds)
        {
            return Err("分镜标识、提示词或时长无效。".into());
        }
        if shot
            .first_frame
            .iter()
            .chain(shot.last_frame.iter())
            .any(|a| a["kind"] != "image")
        {
            return Err("首尾帧必须是图片。".into());
        }
        if request.mode == "image" && shot.first_frame.is_none() && shot.last_frame.is_none() {
            return Err("图片生成需要首帧或尾帧。".into());
        }
        if request.mode == "prompt"
            && (shot.first_frame.is_some()
                || shot.last_frame.is_some()
                || !shot.references.is_empty())
        {
            return Err("提示词生成不能附带图片或参考素材，请选择对应生成方式。".into());
        }
        if !shot.references.is_empty() && (shot.first_frame.is_some() || shot.last_frame.is_some())
        {
            return Err("参考素材不能与首尾帧同时使用。".into());
        }
        if !shot.references.is_empty() && !model.modes.iter().any(|mode| mode == "reference") {
            return Err("当前模型不支持参考素材生成。".into());
        }
        if (shot.first_frame.is_some() || shot.last_frame.is_some())
            && !model.modes.iter().any(|mode| mode == "image")
        {
            return Err("当前模型不支持首尾帧生成。".into());
        }
        validate_references(&shot.references)?;
        if shot
            .references
            .iter()
            .any(|reference| reference.kind == "video" && reference.include_audio)
            && frames_for_seconds(shot.seconds) < 56
        {
            return Err("包含声音的参考视频需要至少 2 秒输出时长。".into());
        }
        if request.mode == "reference" && !shot.references.iter().any(|r| r.kind != "audio") {
            return Err("参考生成至少需要一张图片或一段视频。".into());
        }
    }
    Ok(())
}
fn validate_references(references: &[VideoGenerationReference]) -> Result<()> {
    if references.len() > 12
        || references.iter().filter(|r| r.kind == "image").count() > 9
        || references.iter().filter(|r| r.kind == "video").count() > 3
    {
        return Err("参考素材最多 12 个，图片最多 9 张、视频最多 3 段。".into());
    }
    let mut video_seconds = 0.0;
    let mut audio_seconds = 0.0;
    let mut audio_count = 0;
    for reference in references {
        if !["image", "video", "audio"].contains(&reference.kind.as_str())
            || reference.asset["kind"] != reference.kind
        {
            return Err("参考素材类型无效。".into());
        }
        if reference.kind != "image" {
            let seconds = reference.asset["duration"]
                .as_f64()
                .filter(|v| v.is_finite() && (2.0..=15.0).contains(v))
                .ok_or("参考音视频每段时长需为 2–15 秒。")?;
            if reference.kind == "video" {
                video_seconds += seconds;
            }
            if reference.kind == "audio" || reference.include_audio {
                audio_count += 1;
                audio_seconds += seconds;
            }
        }
    }
    if video_seconds > 15.0 || audio_seconds > 15.0 || audio_count > 3 {
        return Err("参考视频与音频各自总长不能超过 15 秒，音频最多 3 段。".into());
    }
    Ok(())
}
fn frames_for_seconds(seconds: f64) -> u32 {
    5 + 17 * (((seconds * 24.0).ceil() - 5.0).max(0.0) / 17.0).ceil() as u32
}
fn build_runner_request(
    model_dir: &Path,
    output: &Path,
    runtime: &Runtime,
    store: &MediaStore,
    request: &VideoGenerationRequest,
    shot: &VideoGenerationShot,
    index: usize,
) -> Result<Value> {
    let mut value = json!({"modelDir":model_dir,"outputPath":output,"prompt":shot.prompt.trim(),"width":request.width,"height":request.height,"frames":frames_for_seconds(shot.seconds),"steps":request.steps,"seed":request.seed.wrapping_add(index as u32),"ssdStreaming":request.low_memory});
    for (name, asset) in [
        ("firstFrame", &shot.first_frame),
        ("lastFrame", &shot.last_frame),
    ] {
        if let Some(asset) = asset {
            let path = store.authorized_path(asset)?;
            let actual = store.probe(
                runtime,
                &path,
                &path.file_name().unwrap_or_default().to_string_lossy(),
            )?;
            if actual.kind != "image" {
                return Err("首尾帧源文件不是图片。".into());
            }
            value[name] = json!(path);
        }
    }
    let mut refs = Vec::new();
    let mut actual_refs = Vec::new();
    for reference in &shot.references {
        let path = store.authorized_path(&reference.asset)?;
        let actual = store.probe(
            runtime,
            &path,
            &path.file_name().unwrap_or_default().to_string_lossy(),
        )?;
        if actual.kind != reference.kind {
            return Err("参考素材声明类型与源文件不一致。".into());
        }
        if reference.include_audio && reference.kind == "video" && !store.has_audio(runtime, &path)
        {
            return Err("所选参考视频没有音轨，请关闭包含声音。".into());
        }
        actual_refs.push(VideoGenerationReference {
            asset: serde_json::to_value(actual).map_err(|e| e.to_string())?,
            kind: reference.kind.clone(),
            include_audio: reference.include_audio,
        });
        refs.push(json!({"kind":reference.kind,"path":path,"includeEmbeddedAudio":reference.include_audio}));
    }
    validate_references(&actual_refs)?;
    value["references"] = json!(refs);
    Ok(value)
}

fn unsupported_reason() -> Option<String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Some("本地视频生成当前仅支持 Apple 芯片 Mac（macOS 15 或更新版本）；此平台不会下载无法运行的模型。".into());
    }
    let version = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    if version
        .split('.')
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
        < 15
    {
        Some("本地视频生成需要 macOS 15 或更新版本。".into())
    } else {
        None
    }
}
fn physical_memory() -> Option<u64> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}
fn install_runtime(root: &Path, catalog: &Catalog) -> Result<PathBuf> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let folder = safe_directory(root, &format!("runtime/{}", catalog.engine.version))?;
        for (name, bytes, executable) in [
            (
                catalog.engine.executable.as_str(),
                include_bytes!(concat!(env!("OUT_DIR"), "/open-media-video-generation")).as_slice(),
                true,
            ),
            (
                catalog.engine.shader.as_str(),
                include_bytes!(concat!(env!("OUT_DIR"), "/h3_shaders.metal")).as_slice(),
                false,
            ),
        ] {
            let path = folder.join(name);
            let mut file = tempfile::NamedTempFile::new_in(&folder).map_err(|e| e.to_string())?;
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(if executable {
                    0o755
                } else {
                    0o644
                }))
                .map_err(|e| e.to_string())?;
            file.as_file().sync_all().map_err(|e| e.to_string())?;
            file.persist(&path).map_err(|e| e.to_string())?;
        }
        let runner = folder.join(&catalog.engine.executable);
        let mut child = Command::new(&runner)
            .arg("--probe")
            .current_dir(&folder)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("无法检查本地视频生成引擎：{e}"))?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(
                            "视频生成引擎无法访问可用的图形设备，请确认系统版本及完整安装包。"
                                .into(),
                        );
                    }
                    break;
                }
                Ok(None) if start.elapsed() < Duration::from_secs(8) => {
                    thread::sleep(Duration::from_millis(40))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("视频生成引擎设备检查超时或失败。".into());
                }
            }
        }
        Ok(runner)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (root, catalog);
        Err("当前平台尚无可用的视频生成引擎。".into())
    }
}
fn isolate_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
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
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
#[path = "video_generation_tests.rs"]
mod tests;
