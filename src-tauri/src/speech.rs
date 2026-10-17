use crate::engine::{Asset, MediaStore, Result, Runtime};
use crate::speech_models::SpeechModels;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_TEXT_CHARS: usize = 4_000;
const MAX_JOBS: usize = 2048;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;
const CANCELLED: &str = "语音生成已取消。";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub id: String,
    pub name: String,
    pub language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(skip_serializing)]
    pub(crate) speaker_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub ready: bool,
    pub voices: Vec<SpeechVoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRequest {
    pub request_id: String,
    pub text: String,
    pub voice_id: String,
    pub speed: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJob {
    pub id: String,
    pub state: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<Asset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ModelKind {
    Matcha,
    Kokoro,
    Zipvoice,
    F5,
    Qwen3,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub kind: ModelKind,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub vocoder: String,
    #[serde(default)]
    pub voices: String,
    #[serde(default)]
    pub tokens: String,
    #[serde(default)]
    pub encoder: String,
    #[serde(default)]
    pub decoder: String,
    #[serde(default)]
    pub reference_audio: String,
    #[serde(default)]
    pub reference_text: String,
    #[serde(default)]
    pub config: String,
    #[serde(default)]
    pub data_dir: String,
    #[serde(default)]
    pub lexicons: Vec<String>,
    #[serde(default)]
    pub rule_fsts: Vec<String>,
    pub sample_rate: u32,
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    executable: String,
    model: Model,
    voices: Vec<SpeechVoice>,
}

#[derive(Clone)]
pub(crate) struct SpeechRuntime {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub script: Option<PathBuf>,
    pub model: Model,
    pub voices: Vec<SpeechVoice>,
}

fn relative_path(root: &Path, relative: &str, directory: bool) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains(',')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("内置语音资源清单包含无效路径，请重新安装。".into());
    }
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|_| format!("内置语音资源不完整：{relative}。请重新安装完整安装包。"))?;
    if !resolved.starts_with(root)
        || (directory && !resolved.is_dir())
        || (!directory && !resolved.is_file())
    {
        return Err("内置语音资源路径无效，请重新安装完整安装包。".into());
    }
    if !directory && fs::metadata(&resolved).map_err(|e| e.to_string())?.len() == 0 {
        return Err(format!("内置语音资源为空：{relative}。请重新安装。"));
    }
    Ok(resolved)
}

impl SpeechRuntime {
    fn discover(resource: &Path) -> Result<Self> {
        let mut roots = Vec::new();
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os("OPEN_MEDIA_SPEECH_ROOT") {
            roots.push(PathBuf::from(root));
        }
        roots.extend([resource.join("speech"), resource.join("resources/speech")]);
        #[cfg(debug_assertions)]
        roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/speech"));
        for root in roots {
            if root.join("manifest.json").is_file() {
                return Self::from_root(&root, resource);
            }
        }
        Err("内置语音模型尚未安装完整，请使用包含语音资源的桌面安装包。".into())
    }

    fn from_root(root: &Path, resource: &Path) -> Result<Self> {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let manifest_path = relative_path(&root, "manifest.json", false)?;
        if fs::metadata(&manifest_path)
            .map_err(|e| e.to_string())?
            .len()
            > 1024 * 1024
        {
            return Err("内置语音资源清单过大，请重新安装。".into());
        }
        let manifest: Manifest = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|e| format!("无法读取语音资源清单：{e}"))?,
        )
        .map_err(|_| "内置语音资源清单无效，请重新安装。")?;
        if manifest.schema != 2
            || manifest.model.kind != ModelKind::Matcha
            || manifest.model.sample_rate != 16_000
            || manifest.voices.len() != 1
            || manifest.model.lexicons.is_empty()
            || manifest.model.lexicons.len() > 16
            || manifest.model.rule_fsts.len() > 16
        {
            return Err("内置语音模型配置不受支持，请重新安装。".into());
        }
        let model = manifest.model;
        for file in [&model.file, &model.vocoder, &model.tokens]
            .into_iter()
            .chain(model.lexicons.iter())
            .chain(model.rule_fsts.iter())
        {
            relative_path(&root, file, false)?;
        }
        relative_path(&root, &model.data_dir, true)?;
        let mut ids = HashSet::new();
        for voice in &manifest.voices {
            if voice.id.is_empty()
                || voice.id.len() > 64
                || !voice
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || voice.name.trim().is_empty()
                || voice.name.chars().count() > 80
                || voice.language.is_empty()
                || voice.language.len() > 32
                || voice.speaker_id != 0
                || !ids.insert(&voice.id)
            {
                return Err("内置音色列表无效，请重新安装。".into());
            }
        }
        // Signed desktop bundles may keep executable code beside their resource directory.
        let helper_root = resource.parent().map(|p| p.join("Helpers/speech"));
        let executable =
            if let Some(helpers) = helper_root.filter(|p| p.join(&manifest.executable).is_file()) {
                relative_path(
                    &helpers.canonicalize().map_err(|e| e.to_string())?,
                    &manifest.executable,
                    false,
                )?
            } else {
                relative_path(&root, &manifest.executable, false)?
            };
        Ok(Self {
            root,
            executable,
            script: None,
            model,
            voices: manifest.voices,
        })
    }

    fn command(&self, request: &SpeechRequest, text_file: &Path, output: &Path) -> Result<Command> {
        let voice = self
            .voices
            .iter()
            .find(|voice| voice.id == request.voice_id)
            .ok_or("所选音色不可用，请重新选择。")?;
        let mut command = Command::new(&self.executable);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.current_dir(&self.root);
        if matches!(self.model.kind, ModelKind::F5 | ModelKind::Qwen3) {
            let script = self
                .script
                .as_ref()
                .ok_or("音色运行环境不完整，请重新下载。")?;
            command
                .arg("-I")
                .arg("-B")
                .arg(script)
                .arg("--config")
                .arg(self.root.join(&self.model.config))
                .arg("--text-file")
                .arg(text_file)
                .arg("--output-filename")
                .arg(output)
                .arg("--speed")
                .arg(request.speed.to_string())
                .env("HF_HUB_OFFLINE", "1")
                .env("TRANSFORMERS_OFFLINE", "1")
                .env("PYTHONNOUSERSITE", "1")
                .env("TOKENIZERS_PARALLELISM", "false")
                .stdin(Stdio::null());
            return Ok(command);
        }
        match self.model.kind {
            ModelKind::Matcha => command.args([
                format!("--matcha-acoustic-model={}", self.model.file),
                format!("--matcha-vocoder={}", self.model.vocoder),
                format!("--matcha-tokens={}", self.model.tokens),
                format!("--matcha-data-dir={}", self.model.data_dir),
                format!("--matcha-lexicon={}", self.model.lexicons.join(",")),
            ]),
            ModelKind::Kokoro => command.args([
                format!("--kokoro-model={}", self.model.file),
                format!("--kokoro-voices={}", self.model.voices),
                format!("--kokoro-tokens={}", self.model.tokens),
                format!("--kokoro-data-dir={}", self.model.data_dir),
                format!("--kokoro-lexicon={}", self.model.lexicons.join(",")),
            ]),
            ModelKind::Zipvoice => command.args([
                format!("--zipvoice-encoder={}", self.model.encoder),
                format!("--zipvoice-decoder={}", self.model.decoder),
                format!("--zipvoice-vocoder={}", self.model.vocoder),
                format!("--zipvoice-tokens={}", self.model.tokens),
                format!("--zipvoice-data-dir={}", self.model.data_dir),
                format!("--zipvoice-lexicon={}", self.model.lexicons.join(",")),
                format!("--reference-audio={}", self.model.reference_audio),
                format!("--reference-text-file={}", self.model.reference_text),
                "--num-steps=8".into(),
            ]),
            ModelKind::F5 | ModelKind::Qwen3 => unreachable!(),
        };
        command.args([
            format!("--sample-rate={}", self.model.sample_rate),
            format!("--tts-rule-fsts={}", self.model.rule_fsts.join(",")),
            format!("--sid={}", voice.speaker_id),
            format!("--speed={}", request.speed),
            "--num-threads=2".into(),
            "--debug=false".into(),
        ]);
        let mut output_argument = std::ffi::OsString::from("--output-filename=");
        output_argument.push(output);
        let mut text_argument = std::ffi::OsString::from("--text-file=");
        text_argument.push(text_file);
        command
            .arg(output_argument)
            .arg(text_argument)
            .stdin(Stdio::null());
        Ok(command)
    }
}

struct Entry {
    job: SpeechJob,
    cancelled: Arc<AtomicBool>,
    discard: bool,
    accepted: bool,
    asset_root: PathBuf,
}

#[derive(Default)]
struct Jobs {
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
    early_cancelled: HashSet<String>,
    closing: bool,
}

struct ManagerOwner {
    jobs: Arc<Mutex<Jobs>>,
}

impl Drop for ManagerOwner {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.closing = true;
            for entry in jobs.entries.values() {
                entry.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Clone)]
pub struct SpeechManager {
    runtime: Result<SpeechRuntime>,
    models: Result<SpeechModels>,
    workspace: PathBuf,
    owner: Arc<ManagerOwner>,
}

impl SpeechManager {
    pub fn new(app_data: &Path, resource: &Path) -> Result<Self> {
        let workspace = app_data.join("speech-work");
        fs::create_dir_all(&workspace).map_err(|e| format!("无法创建配音工作目录：{e}"))?;
        let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
        let runtime = SpeechRuntime::discover(resource);
        let models = SpeechModels::new(app_data, runtime.clone());
        Ok(Self {
            runtime,
            models,
            workspace,
            owner: Arc::new(ManagerOwner {
                jobs: Arc::new(Mutex::new(Jobs::default())),
            }),
        })
    }

    pub fn status(&self) -> SpeechStatus {
        let mut voices = self
            .runtime
            .as_ref()
            .map(|runtime| runtime.voices.clone())
            .unwrap_or_default();
        for voice in &mut voices {
            voice.model_id = Some("bundled".into());
            voice.model_size = Some(149_227_292);
            voice.download_size = Some(0);
            voice.downloaded_bytes = Some(0);
            voice.status = Some("bundled".into());
        }
        if let Ok(models) = &self.models {
            voices.extend(models.voices());
        }
        SpeechStatus {
            ready: voices
                .iter()
                .any(|voice| matches!(voice.status.as_deref(), Some("bundled" | "ready"))),
            voices,
            error: self.runtime.as_ref().err().cloned(),
        }
    }

    pub fn begin_model_download(&self, model_id: &str) -> Result<SpeechStatus> {
        self.models
            .as_ref()
            .map_err(Clone::clone)?
            .begin(model_id)?;
        Ok(self.status())
    }

    pub fn cancel_model_download(&self, model_id: &str) -> Result<SpeechStatus> {
        self.models
            .as_ref()
            .map_err(Clone::clone)?
            .cancel(model_id)?;
        Ok(self.status())
    }

    pub fn get(&self, id: &str) -> Result<SpeechJob> {
        self.owner
            .jobs
            .lock()
            .map_err(|_| "语音任务状态不可用。")?
            .entries
            .get(id)
            .map(|entry| entry.job.clone())
            .ok_or_else(|| "语音任务不存在。".into())
    }

    pub fn begin(
        &self,
        runtime: Runtime,
        store: MediaStore,
        mut request: SpeechRequest,
    ) -> Result<SpeechJob> {
        validate_request(&request)?;
        request.text = request.text.trim().to_owned();
        let speech = if let Some(speech) = self.runtime.as_ref().ok().filter(|speech| {
            speech
                .voices
                .iter()
                .any(|voice| voice.id == request.voice_id)
        }) {
            speech.clone()
        } else {
            self.models
                .as_ref()
                .map_err(Clone::clone)?
                .runtime_for_voice(&request.voice_id)?
        };
        let id = request.request_id.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = {
            let mut jobs = self.owner.jobs.lock().map_err(|_| "语音任务状态不可用。")?;
            if jobs.closing {
                return Err("应用正在关闭，无法开始配音。".into());
            }
            if jobs.entries.contains_key(&id) {
                return Err("此语音任务已经提交，请勿重复提交。".into());
            }
            if jobs
                .entries
                .values()
                .any(|entry| entry.job.state == "running")
            {
                return Err("已有语音正在生成，请等待完成或取消后再试。".into());
            }
            prune(&mut jobs);
            if jobs.entries.len() >= MAX_JOBS {
                return Err(
                    "尚有过多未完成保存的配音，请先将当前配音加入项目或取消，再继续生成。".into(),
                );
            }
            let early_cancelled = jobs.early_cancelled.remove(&id);
            let job = SpeechJob {
                id: id.clone(),
                state: if early_cancelled {
                    "cancelled"
                } else {
                    "running"
                }
                .into(),
                stage: if early_cancelled {
                    "已取消"
                } else {
                    "正在加载语音模型"
                }
                .into(),
                progress: None,
                asset: None,
                error: None,
            };
            jobs.order.push_back(id.clone());
            jobs.entries.insert(
                id.clone(),
                Entry {
                    job: job.clone(),
                    cancelled: cancelled.clone(),
                    discard: false,
                    accepted: false,
                    asset_root: store.root.clone(),
                },
            );
            job
        };
        if job.state != "running" {
            return Ok(job);
        }
        let jobs = self.owner.jobs.clone();
        let workspace = self.workspace.clone();
        let spawn_result = thread::Builder::new()
            .name("speech-generation".into())
            .spawn(move || {
                let result = synthesize(
                    &speech, &runtime, &store, &workspace, &request, &cancelled, &jobs,
                );
                if let Ok(mut jobs) = jobs.lock() {
                    if let Some(entry) = jobs.entries.get_mut(&request.request_id) {
                        let must_cancel = entry.discard || cancelled.load(Ordering::SeqCst);
                        match result {
                            Ok(asset) if !must_cancel => {
                                entry.job.state = "completed".into();
                                entry.job.stage = "配音已生成".into();
                                entry.job.progress = Some(1.0);
                                entry.job.asset = Some(asset);
                            }
                            Ok(asset) => {
                                remove_asset(&entry.asset_root, &asset);
                                entry.job.state = "cancelled".into();
                                entry.job.stage = "已取消".into();
                                entry.job.progress = None;
                            }
                            Err(error) => {
                                entry.job.state =
                                    if must_cancel { "cancelled" } else { "failed" }.into();
                                entry.job.stage = if must_cancel {
                                    "已取消"
                                } else {
                                    "生成失败"
                                }
                                .into();
                                entry.job.progress = None;
                                entry.job.error = if must_cancel { None } else { Some(error) };
                            }
                        }
                    }
                }
            });
        if let Err(error) = spawn_result {
            if let Ok(mut jobs) = self.owner.jobs.lock() {
                if let Some(entry) = jobs.entries.get_mut(&id) {
                    entry.job.state = "failed".into();
                    entry.job.stage = "生成失败".into();
                    entry.job.error = Some(format!("无法启动语音任务：{error}"));
                }
            }
            return Err(format!("无法启动语音任务：{error}"));
        }
        Ok(job)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let mut jobs = self.owner.jobs.lock().map_err(|_| "语音任务状态不可用。")?;
        if let Some(entry) = jobs.entries.get(id) {
            if entry.job.state == "running" {
                entry.cancelled.store(true, Ordering::SeqCst);
            }
        } else {
            if jobs.early_cancelled.len() >= MAX_JOBS {
                return Err("待取消任务过多，请等待当前操作结束。".into());
            }
            jobs.early_cancelled.insert(id.into());
        }
        Ok(())
    }

    pub fn discard(&self, id: &str) -> Result<()> {
        self.cancel(id)?;
        {
            let mut jobs = self.owner.jobs.lock().map_err(|_| "语音任务状态不可用。")?;
            if let Some(entry) = jobs.entries.get_mut(id) {
                if entry.accepted {
                    return Err("配音已经加入项目，不能作为临时音频删除。".into());
                }
                entry.discard = true;
                if let Some(asset) = entry.job.asset.take() {
                    remove_asset(&entry.asset_root, &asset);
                }
                if entry.job.state == "completed" {
                    entry.job.state = "cancelled".into();
                    entry.job.stage = "已丢弃".into();
                    entry.job.progress = None;
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.get(id).is_ok_and(|job| job.state == "running") {
            if Instant::now() >= deadline {
                return Err("语音任务正在停止，临时音频将在停止后自动清理。".into());
            }
            thread::sleep(Duration::from_millis(30));
        }
        Ok(())
    }

    pub fn accept(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() || ids.len() > 1000 {
            return Err("待保存的配音数量超出项目素材上限。".into());
        }
        let mut jobs = self.owner.jobs.lock().map_err(|_| "语音任务状态不可用。")?;
        for id in ids {
            let entry = jobs.entries.get(id).ok_or("待保存的语音任务不存在。")?;
            if entry.job.state != "completed" || entry.job.asset.is_none() || entry.discard {
                return Err("配音尚未生成完成，不能加入项目。".into());
            }
        }
        for id in ids {
            if let Some(entry) = jobs.entries.get_mut(id) {
                entry.accepted = true;
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(models) = &self.models {
            models.shutdown();
        }
        if let Ok(mut jobs) = self.owner.jobs.lock() {
            jobs.closing = true;
            for entry in jobs.entries.values() {
                entry.cancelled.store(true, Ordering::SeqCst);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let running = self
                .owner
                .jobs
                .lock()
                .map(|jobs| {
                    jobs.entries
                        .values()
                        .any(|entry| entry.job.state == "running")
                })
                .unwrap_or(false);
            if !running {
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
    }
}

fn prune(jobs: &mut Jobs) {
    let existing = jobs.order.len();
    for _ in 0..existing {
        if jobs.entries.len() < MAX_JOBS {
            break;
        }
        let Some(id) = jobs.order.pop_front() else {
            break;
        };
        if jobs.entries.get(&id).is_some_and(|entry| {
            entry.job.state == "running" || (entry.job.state == "completed" && !entry.accepted)
        }) {
            jobs.order.push_back(id);
            continue;
        }
        jobs.entries.remove(&id);
    }
}

fn validate_id(id: &str) -> Result<()> {
    if !(16..=80).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("语音任务编号无效。".into());
    }
    Ok(())
}

fn validate_request(request: &SpeechRequest) -> Result<()> {
    validate_id(&request.request_id)?;
    if request.text.trim().is_empty() {
        return Err("请先输入需要朗读的文字。".into());
    }
    if request.text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!(
            "单段文字最多支持 {MAX_TEXT_CHARS} 个字符，请拆分后生成。"
        ));
    }
    if request
        .text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("文字包含不支持的控制字符，请删除后重试。".into());
    }
    if !request.speed.is_finite() || !(0.5..=2.0).contains(&request.speed) {
        return Err("朗读速度必须在 0.5 到 2 倍之间。".into());
    }
    Ok(())
}

struct RunningChild(Child);
impl Drop for RunningChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

fn update_job(jobs: &Mutex<Jobs>, id: &str, stage: &str, progress: Option<f64>) {
    if let Ok(mut jobs) = jobs.lock() {
        if let Some(entry) = jobs.entries.get_mut(id) {
            entry.job.stage = stage.into();
            entry.job.progress = progress;
        }
    }
}

fn synthesize(
    speech: &SpeechRuntime,
    runtime: &Runtime,
    store: &MediaStore,
    workspace: &Path,
    request: &SpeechRequest,
    cancelled: &AtomicBool,
    jobs: &Mutex<Jobs>,
) -> Result<Asset> {
    check_cancelled(cancelled)?;
    let workspace = tempfile::Builder::new()
        .prefix("voice-")
        .tempdir_in(workspace)
        .map_err(|e| format!("无法创建配音临时目录：{e}"))?;
    let output = workspace.path().join("speech.wav");
    let text_file = workspace.path().join("text.txt");
    let text = if speech.model.kind == ModelKind::Zipvoice {
        crate::speech_chinese::normalize_chinese(&request.text)
    } else {
        request.text.clone()
    };
    fs::write(&text_file, text.as_bytes()).map_err(|e| format!("无法保存待朗读文字：{e}"))?;
    let log_path = workspace.path().join("generation.log");
    let log = OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法创建语音任务日志：{e}"))?;
    let stdout = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = speech.command(request, &text_file, &output)?;
    command.stdout(stdout).stderr(log);
    check_cancelled(cancelled)?;
    let mut child = RunningChild(
        command
            .spawn()
            .map_err(|e| format!("无法启动内置语音引擎：{e}。请确认安装包完整。"))?,
    );
    let mut log_reader = File::open(&log_path).map_err(|e| e.to_string())?;
    let mut log_text = String::new();
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    loop {
        check_cancelled(cancelled)?;
        if Instant::now() >= deadline {
            return Err("语音生成超过 30 分钟，请缩短文字或降低同时运行的任务数量。".into());
        }
        if log_reader.metadata().map_err(|e| e.to_string())?.len() > MAX_LOG_BYTES {
            return Err("语音引擎输出异常，已停止本次生成。".into());
        }
        let mut bytes = Vec::new();
        log_reader
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if !bytes.is_empty() {
            log_text.push_str(&String::from_utf8_lossy(&bytes));
            if let Some(progress) = parse_progress(&log_text) {
                update_job(
                    jobs,
                    &request.request_id,
                    "正在合成语音",
                    Some(progress.min(0.99)),
                );
            } else if log_text
                .lines()
                .any(|line| line.starts_with("stage=generating,"))
            {
                update_job(jobs, &request.request_id, "正在合成语音", None);
            }
        }
        if fs::metadata(&output).is_ok_and(|metadata| metadata.len() > MAX_AUDIO_BYTES) {
            return Err("生成音频超出大小限制，已停止本次生成。".into());
        }
        match child
            .0
            .try_wait()
            .map_err(|e| format!("读取语音任务状态失败：{e}"))?
        {
            Some(status) => {
                if !status.success() {
                    let mut remaining = Vec::new();
                    let _ = log_reader.take(4096).read_to_end(&mut remaining);
                    log_text.push_str(&String::from_utf8_lossy(&remaining));
                    let detail: String = log_text
                        .chars()
                        .rev()
                        .take(1600)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                    let message = if log_text.contains("Write '") && log_text.contains("failed") {
                        "语音已生成，但无法保存。请检查磁盘剩余空间和应用数据目录权限。".into()
                    } else if log_text.contains("Cannot load bundled speech model") {
                        "无法加载内置语音模型，请重新安装完整安装包。".into()
                    } else {
                        format!("语音生成失败（{status}）。")
                    };
                    return Err(format!("{message}\n{}", detail.trim()));
                }
                break;
            }
            None => thread::sleep(Duration::from_millis(70)),
        }
    }
    check_cancelled(cancelled)?;
    update_job(jobs, &request.request_id, "正在检查音频", None);
    validate_wave(&output, speech.model.sample_rate)?;
    check_cancelled(cancelled)?;
    let title = request
        .text
        .chars()
        .take(24)
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let mut staged = tempfile::NamedTempFile::new_in(&store.root)
        .map_err(|e| format!("无法保存配音素材：{e}"))?;
    std::io::copy(
        &mut File::open(&output).map_err(|e| e.to_string())?,
        staged.as_file_mut(),
    )
    .map_err(|e| format!("无法保存配音素材：{e}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|e| format!("无法写入配音素材：{e}"))?;
    check_cancelled(cancelled)?;
    let mut asset = store.probe(
        runtime,
        staged.path(),
        &format!("配音-{}.wav", title.trim()),
    )?;
    if cancelled.load(Ordering::SeqCst)
        || asset.kind != "audio"
        || !asset.duration.is_finite()
        || asset.duration <= 0.0
        || asset.duration > 1800.0
    {
        check_cancelled(cancelled)?;
        return Err("生成音频的媒体信息无效，请调整文字后重试。".into());
    }
    let destination = store.root.join(format!("{}.wav", crate::engine::new_id()));
    staged
        .persist_noclobber(&destination)
        .map_err(|e| format!("无法保存配音素材：{}", e.error))?;
    asset.native_path = destination.to_string_lossy().into();
    Ok(asset)
}

fn parse_progress(log: &str) -> Option<f64> {
    log.lines().rev().find_map(|line| {
        let line = line.strip_prefix("sample=")?;
        let (samples, progress) = line.split_once(", progress=")?;
        samples.parse::<u64>().ok()?;
        let value = progress.trim().parse::<f64>().ok()?;
        (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
    })
}

fn remove_asset(root: &Path, asset: &Asset) {
    let path = Path::new(&asset.native_path);
    if path.parent() == Some(root) {
        let _ = fs::remove_file(path);
    }
}

fn validate_wave(path: &Path, expected_rate: u32) -> Result<()> {
    let invalid = || "语音引擎未生成完整的可播放音频，请调整文字后重试。".to_string();
    let mut file = File::open(path).map_err(|_| invalid())?;
    let file_size = file.metadata().map_err(|_| invalid())?.len();
    if !(44..=MAX_AUDIO_BYTES).contains(&file_size) {
        return Err(invalid());
    }
    let mut header = [0_u8; 12];
    file.read_exact(&mut header).map_err(|_| invalid())?;
    let declared_size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" || declared_size != file_size {
        return Err(invalid());
    }
    let mut format_seen = false;
    let mut float_samples = false;
    let mut sample_bytes = 2_u64;
    let mut audio_seen = false;
    let mut cursor = 12_u64;
    while cursor + 8 <= file_size {
        let mut chunk = [0_u8; 8];
        file.read_exact(&mut chunk).map_err(|_| invalid())?;
        let length = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        cursor += 8;
        if cursor + length > file_size {
            return Err(invalid());
        }
        match &chunk[..4] {
            b"fmt " => {
                if length < 16 || format_seen {
                    return Err(invalid());
                }
                let mut format = [0_u8; 16];
                file.read_exact(&mut format).map_err(|_| invalid())?;
                let rate = u32::from_le_bytes(format[4..8].try_into().unwrap());
                let encoding = u16::from_le_bytes(format[..2].try_into().unwrap());
                let bits = u16::from_le_bytes(format[14..16].try_into().unwrap());
                float_samples = encoding == 3 && bits == 32;
                sample_bytes = if float_samples { 4 } else { 2 };
                if !(float_samples || encoding == 1 && bits == 16)
                    || u16::from_le_bytes(format[2..4].try_into().unwrap()) != 1
                    || rate != expected_rate
                    || u32::from_le_bytes(format[8..12].try_into().unwrap())
                        != rate * sample_bytes as u32
                    || u16::from_le_bytes(format[12..14].try_into().unwrap()) != sample_bytes as u16
                {
                    return Err(invalid());
                }
                format_seen = true;
            }
            b"data" => {
                if !format_seen || audio_seen || length < sample_bytes || length % sample_bytes != 0
                {
                    return Err(invalid());
                }
                let mut remaining = length;
                let mut buffer = [0_u8; 8192];
                let mut audible = false;
                while remaining > 0 {
                    let size = remaining.min(buffer.len() as u64) as usize;
                    file.read_exact(&mut buffer[..size])
                        .map_err(|_| invalid())?;
                    if float_samples {
                        for bytes in buffer[..size].chunks_exact(4) {
                            let sample = f32::from_le_bytes(bytes.try_into().unwrap());
                            if !sample.is_finite() {
                                return Err(invalid());
                            }
                            audible |= sample.abs() > 8.0 / 32768.0;
                        }
                    } else {
                        audible |= buffer[..size]
                            .chunks_exact(2)
                            .any(|pair| i16::from_le_bytes([pair[0], pair[1]]).unsigned_abs() > 8);
                    }
                    remaining -= size as u64;
                }
                if !audible {
                    return Err("生成的语音没有可听内容，请使用可朗读的文字。".into());
                }
                audio_seen = true;
            }
            _ => {}
        }
        cursor += length + length % 2;
        if cursor > file_size {
            return Err(invalid());
        }
        file.seek(SeekFrom::Start(cursor)).map_err(|_| invalid())?;
    }
    if !format_seen || !audio_seen || cursor != file_size {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(text: &str) -> SpeechRequest {
        SpeechRequest {
            request_id: crate::engine::new_id(),
            text: text.into(),
            voice_id: "matcha_zh_en_female".into(),
            speed: 1.0,
        }
    }

    #[test]
    fn validates_unicode_length_controls_and_speed() {
        assert!(validate_request(&request(&"你".repeat(4000))).is_ok());
        assert!(validate_request(&request(&"你".repeat(4001))).is_err());
        assert!(validate_request(&request(" \n\t ")).is_err());
        assert!(validate_request(&request("你好\0世界")).is_err());
        assert!(validate_request(&request("第一句。\n第二句。\t结尾。 ")).is_ok());
        let mut item = request("Hello");
        item.speed = f64::NAN;
        assert!(validate_request(&item).is_err());
        item.speed = 2.01;
        assert!(validate_request(&item).is_err());
        item.speed = 0.5;
        assert!(validate_request(&item).is_ok());
        item.request_id = "../../outside".into();
        assert!(validate_request(&item).is_err());
    }

    #[test]
    fn parses_only_real_finite_callback_progress() {
        assert_eq!(
            parse_progress("loading\nsample=1234, progress=0.333333\n"),
            Some(0.333333)
        );
        assert_eq!(
            parse_progress("sample=12, progress=0.5\nsample=12, progress=1.000000\n"),
            Some(1.0)
        );
        for text in [
            "progress=0.5",
            "sample=x, progress=0.5",
            "sample=1, progress=NaN",
            "sample=2, progress=3",
            "sample=1, progress=-1",
        ] {
            assert_eq!(parse_progress(text), None, "{text}");
        }
    }

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("model/data")).unwrap();
        fs::create_dir_all(root.path().join("runtime/bin")).unwrap();
        for name in [
            "model/model.onnx",
            "model/vocoder.onnx",
            "model/tokens.txt",
            "model/lexicon.txt",
            "model/rule.fst",
            "runtime/bin/engine",
        ] {
            fs::write(root.path().join(name), b"test configuration only").unwrap();
        }
        let manifest = json!({
            "schema": 2,
            "executable": "runtime/bin/engine",
            "model": {"kind": "matcha", "file": "model/model.onnx", "vocoder": "model/vocoder.onnx", "tokens": "model/tokens.txt", "dataDir": "model/data", "lexicons": ["model/lexicon.txt"], "ruleFsts": ["model/rule.fst"], "sampleRate": 16000},
            "voices": [{"id": "matcha_zh_en_female", "name": "温柔女声（中英）", "language": "zh-CN", "gender": "female", "speakerId": 0}]
        });
        fs::write(
            root.path().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        root
    }

    #[test]
    fn manifest_requires_complete_confined_resources() {
        let root = fixture();
        let canonical = root.path().canonicalize().unwrap();
        assert!(SpeechRuntime::from_root(root.path(), root.path()).is_ok());
        for path in [
            "../outside",
            "/tmp/outside",
            "model/../model/model.onnx",
            "",
            "model/a,b",
        ] {
            assert!(relative_path(&canonical, path, false).is_err(), "{path}");
        }
        fs::remove_file(root.path().join("model/tokens.txt")).unwrap();
        assert!(SpeechRuntime::from_root(root.path(), root.path()).is_err());
    }

    #[test]
    fn manifest_requires_supported_schema_model_and_single_speaker() {
        let root = fixture();
        let path = root.path().join("manifest.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut invalid_manifests = Vec::new();
        let mut old_schema = original.clone();
        old_schema["schema"] = json!(1);
        invalid_manifests.push(old_schema);
        let mut missing_kind = original.clone();
        missing_kind["model"]
            .as_object_mut()
            .unwrap()
            .remove("kind");
        invalid_manifests.push(missing_kind);
        let mut unknown_kind = original.clone();
        unknown_kind["model"]["kind"] = json!("unsupported");
        invalid_manifests.push(unknown_kind);
        let mut wrong_rate = original.clone();
        wrong_rate["model"]["sampleRate"] = json!(24000);
        invalid_manifests.push(wrong_rate);
        let mut wrong_speaker = original.clone();
        wrong_speaker["voices"][0]["speakerId"] = json!(1);
        invalid_manifests.push(wrong_speaker);
        let mut extra_voice = original.clone();
        let mut second_voice = original["voices"][0].clone();
        second_voice["id"] = json!("another_voice");
        extra_voice["voices"]
            .as_array_mut()
            .unwrap()
            .push(second_voice);
        invalid_manifests.push(extra_voice);
        for manifest in invalid_manifests {
            fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            assert!(SpeechRuntime::from_root(root.path(), root.path()).is_err());
        }
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        fs::remove_file(root.path().join("model/vocoder.onnx")).unwrap();
        assert!(SpeechRuntime::from_root(root.path(), root.path()).is_err());
    }

    #[test]
    fn command_uses_acoustic_model_vocoder_and_valid_voice() {
        let root = fixture();
        let runtime = SpeechRuntime::from_root(root.path(), root.path()).unwrap();
        let mut input = request("你好，欢迎使用本地配音。");
        input.speed = 1.25;
        let command = runtime
            .command(
                &input,
                Path::new("文字 file.txt"),
                Path::new("配音 file.wav"),
            )
            .unwrap();
        let arguments: Vec<_> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "--matcha-acoustic-model=model/model.onnx",
            "--matcha-vocoder=model/vocoder.onnx",
            "--matcha-tokens=model/tokens.txt",
            "--matcha-data-dir=model/data",
            "--matcha-lexicon=model/lexicon.txt",
            "--sid=0",
            "--speed=1.25",
            "--text-file=文字 file.txt",
            "--output-filename=配音 file.wav",
        ] {
            assert!(
                arguments.iter().any(|argument| argument == expected),
                "{expected}"
            );
        }
        input.voice_id = "unavailable_voice".into();
        assert!(runtime
            .command(&input, Path::new("text.txt"), Path::new("speech.wav"))
            .is_err());
    }

    #[test]
    fn downloaded_multi_voice_command_selects_model_speaker_and_sample_rate() {
        let root = fixture();
        let mut runtime = SpeechRuntime::from_root(root.path(), root.path()).unwrap();
        runtime.model.kind = ModelKind::Kokoro;
        runtime.model.file = "model.int8.onnx".into();
        runtime.model.voices = "voices.bin".into();
        runtime.model.sample_rate = 24000;
        runtime.voices[0].id = "downloaded_voice".into();
        runtime.voices[0].speaker_id = 62;
        let mut input = request("测试声音");
        input.voice_id = "downloaded_voice".into();
        let command = runtime
            .command(&input, Path::new("text.txt"), Path::new("speech.wav"))
            .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "--kokoro-model=model.int8.onnx",
            "--kokoro-voices=voices.bin",
            "--sample-rate=24000",
            "--sid=62",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{expected}");
        }
        assert!(!args.iter().any(|arg| arg.starts_with("--matcha-")));
    }

    #[test]
    fn downloaded_python_command_uses_isolated_offline_runner_and_unicode_paths() {
        let root = fixture();
        let mut runtime = SpeechRuntime::from_root(root.path(), root.path()).unwrap();
        runtime.model.kind = ModelKind::Qwen3;
        runtime.model.config = "runner-config.json".into();
        runtime.script = Some(root.path().join("运行 环境/runner/tts.py"));
        let input = request("需要保留原始文字。");
        let command = runtime
            .command(
                &input,
                Path::new("字幕 文本.txt"),
                Path::new("配音 音频.wav"),
            )
            .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..2], &["-I", "-B"]);
        assert_eq!(args[2], runtime.script.as_ref().unwrap().to_string_lossy());
        assert_eq!(args[3], "--config");
        assert_eq!(
            args[4],
            root.path().join("runner-config.json").to_string_lossy()
        );
        assert_eq!(
            &args[5..],
            &[
                "--text-file",
                "字幕 文本.txt",
                "--output-filename",
                "配音 音频.wav",
                "--speed",
                "1"
            ]
        );
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "HF_HUB_OFFLINE"
                && value == Some(std::ffi::OsStr::new("1"))));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("--kokoro") || arg.contains("--matcha")));
        runtime.script = None;
        assert!(runtime
            .command(&input, Path::new("text.txt"), Path::new("speech.wav"))
            .is_err());
    }

    #[test]
    fn downloaded_reference_voice_uses_native_fixed_steps_and_reference_paths() {
        let root = fixture();
        let mut runtime = SpeechRuntime::from_root(root.path(), root.path()).unwrap();
        runtime.model.kind = ModelKind::Zipvoice;
        runtime.model.encoder = "encoder.onnx".into();
        runtime.model.decoder = "decoder.onnx".into();
        runtime.model.reference_audio = "reference.wav".into();
        runtime.model.reference_text = "reference.txt".into();
        let command = runtime
            .command(
                &request("你好。"),
                Path::new("text.txt"),
                Path::new("speech.wav"),
            )
            .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "--zipvoice-encoder=encoder.onnx",
            "--zipvoice-decoder=decoder.onnx",
            "--reference-audio=reference.wav",
            "--reference-text-file=reference.txt",
            "--num-steps=8",
        ] {
            assert!(args.iter().any(|arg| arg == expected));
        }
    }

    #[cfg(unix)]
    #[test]
    fn manifest_rejects_symbolic_link_outside_bundle() {
        let root = fixture();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(root.path().join("model/model.onnx")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("model/model.onnx")).unwrap();
        assert!(SpeechRuntime::from_root(root.path(), root.path()).is_err());
    }

    fn manager(root: &Path, runtime: Result<SpeechRuntime>) -> SpeechManager {
        SpeechManager {
            runtime,
            models: Err("测试不启用可选音色。".into()),
            workspace: root.into(),
            owner: Arc::new(ManagerOwner {
                jobs: Arc::new(Mutex::new(Jobs::default())),
            }),
        }
    }

    fn stub_runtime() -> Runtime {
        Runtime {
            encoder: "unused".into(),
            probe: "unused".into(),
            source: "测试配置".into(),
            version: "0".into(),
        }
    }

    #[test]
    fn missing_model_is_status_error_and_pre_cancel_never_starts_process() {
        let root = fixture();
        let absent = manager(root.path(), Err("模型缺失".into()));
        assert!(!absent.status().ready);
        assert_eq!(absent.status().error.as_deref(), Some("模型缺失"));
        let ready = manager(
            root.path(),
            SpeechRuntime::from_root(root.path(), root.path()),
        );
        let input = request("你好");
        ready.cancel(&input.request_id).unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let job = ready.begin(stub_runtime(), store, input).unwrap();
        assert_eq!(job.state, "cancelled");
        assert!(job.asset.is_none());
        ready.discard(&job.id).unwrap();
        assert!(ready.accept(&[job.id]).is_err());
        ready.shutdown();
        assert!(ready
            .begin(
                stub_runtime(),
                MediaStore::new(root.path()).unwrap(),
                request("你好")
            )
            .is_err());
    }

    fn test_asset(path: &Path) -> Asset {
        Asset {
            id: "generated".into(),
            name: "配音.wav".into(),
            kind: "audio".into(),
            url: String::new(),
            duration: 1.0,
            width: 0,
            height: 0,
            size: 3,
            mime: "audio/wav".into(),
            native_path: path.to_string_lossy().into(),
        }
    }

    fn completed_entry(id: &str, root: &Path, asset: Asset) -> Entry {
        Entry {
            job: SpeechJob {
                id: id.into(),
                state: "completed".into(),
                stage: "配音已生成".into(),
                progress: Some(1.0),
                asset: Some(asset),
                error: None,
            },
            cancelled: Arc::new(AtomicBool::new(false)),
            discard: false,
            accepted: false,
            asset_root: root.into(),
        }
    }

    #[test]
    fn accepted_audio_is_never_discarded_and_accept_is_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let audio = root.join("generated.wav");
        fs::write(&audio, b"test asset ownership").unwrap();
        let id = crate::engine::new_id();
        let manager = manager(&root, Err("unused".into()));
        manager
            .owner
            .jobs
            .lock()
            .unwrap()
            .entries
            .insert(id.clone(), completed_entry(&id, &root, test_asset(&audio)));
        assert!(manager
            .accept(&[id.clone(), crate::engine::new_id()])
            .is_err());
        assert!(!manager.owner.jobs.lock().unwrap().entries[&id].accepted);
        manager.accept(&[id.clone()]).unwrap();
        assert!(manager.discard(&id).is_err());
        assert!(audio.exists());
        let second_id = crate::engine::new_id();
        let second_audio = root.join("preview.wav");
        fs::write(&second_audio, b"test preview ownership").unwrap();
        manager.owner.jobs.lock().unwrap().entries.insert(
            second_id.clone(),
            completed_entry(&second_id, &root, test_asset(&second_audio)),
        );
        manager.discard(&second_id).unwrap();
        assert!(!second_audio.exists());
        assert!(audio.exists());
    }

    #[test]
    fn history_pruning_preserves_unaccepted_batch_audio() {
        let mut jobs = Jobs::default();
        let root = Path::new("/unused");
        for index in 0..MAX_JOBS {
            let id = format!("request-{index:016}");
            jobs.order.push_back(id.clone());
            jobs.entries
                .insert(id.clone(), completed_entry(&id, root, test_asset(root)));
        }
        prune(&mut jobs);
        assert_eq!(jobs.entries.len(), MAX_JOBS);
        let accepted = format!("request-{:016}", MAX_JOBS - 1);
        jobs.entries.get_mut(&accepted).unwrap().accepted = true;
        prune(&mut jobs);
        assert_eq!(jobs.entries.len(), MAX_JOBS - 1);
        assert!(!jobs.entries.contains_key(&accepted));
        assert!(jobs.entries.contains_key("request-0000000000000000"));
    }

    fn wave(samples: &[i16]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&16000_u32.to_le_bytes());
        bytes.extend_from_slice(&32000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn wave_validation_rejects_empty_truncated_silent_or_wrong_format() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let valid = wave(&[0, 500, -500, 0]);
        fs::write(file.path(), &valid).unwrap();
        validate_wave(file.path(), 16000).unwrap();
        assert!(validate_wave(file.path(), 24000).is_err());
        fs::write(file.path(), &valid[..valid.len() - 1]).unwrap();
        assert!(validate_wave(file.path(), 16000).is_err());
        fs::write(file.path(), wave(&[0; 20])).unwrap();
        assert!(validate_wave(file.path(), 16000).is_err());
        fs::write(file.path(), wave(&[])).unwrap();
        assert!(validate_wave(file.path(), 16000).is_err());
        let mut extra = valid.clone();
        extra.push(0);
        fs::write(file.path(), extra).unwrap();
        assert!(validate_wave(file.path(), 16000).is_err());
    }

    #[test]
    fn floating_point_speech_is_preserved_and_non_finite_samples_rejected() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let float_wave = |samples: &[f32]| {
            let mut bytes = wave(&[]);
            bytes[4..8].copy_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
            bytes[20..22].copy_from_slice(&3_u16.to_le_bytes());
            bytes[28..32].copy_from_slice(&64000_u32.to_le_bytes());
            bytes[32..34].copy_from_slice(&4_u16.to_le_bytes());
            bytes[34..36].copy_from_slice(&32_u16.to_le_bytes());
            bytes[40..44].copy_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
            for sample in samples {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            bytes
        };
        let original = float_wave(&[0.0, 1.009, -0.5, 0.0]);
        fs::write(file.path(), &original).unwrap();
        validate_wave(file.path(), 16000).unwrap();
        assert_eq!(fs::read(file.path()).unwrap(), original);
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            fs::write(file.path(), float_wave(&[0.5, invalid])).unwrap();
            assert!(validate_wave(file.path(), 16000).is_err());
        }
        fs::write(file.path(), float_wave(&[0.0; 4])).unwrap();
        assert!(validate_wave(file.path(), 16000).is_err());
    }

    fn await_job(manager: &SpeechManager, id: &str) -> SpeechJob {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let job = manager.get(id).unwrap();
            if job.state != "running" {
                return job;
            }
            assert!(Instant::now() < deadline, "speech test timed out: {job:?}");
            thread::sleep(Duration::from_millis(60));
        }
    }

    #[test]
    #[ignore = "requires the prepared offline voice bundle and media runtime"]
    fn real_offline_speech_round_trip() {
        let root = PathBuf::from(
            std::env::var_os("OPEN_MEDIA_SPEECH_ROOT")
                .expect("OPEN_MEDIA_SPEECH_ROOT must point to the prepared bundle"),
        );
        let data = tempfile::Builder::new()
            .prefix("配音, test-")
            .tempdir()
            .unwrap();
        let runtime = Runtime::discover(None, None).expect("real media runtime is required");
        let store = MediaStore::new(data.path()).unwrap();
        let speech = manager(
            data.path(),
            SpeechRuntime::from_root(&root, root.parent().unwrap()),
        );
        let status = speech.status();
        assert!(status.ready, "{:?}", status.error);
        assert_eq!(
            status
                .voices
                .iter()
                .filter(|voice| voice.status.as_deref() == Some("bundled"))
                .count(),
            1
        );
        let female = status
            .voices
            .iter()
            .find(|voice| voice.language == "zh-CN" && voice.gender.as_deref() == Some("female"))
            .expect("Chinese female voice");
        let mut results = Vec::new();
        for speed in [1.0, 1.5] {
            let mut input = request("你好，欢迎使用本地配音。今天是十月十六日。");
            input.voice_id.clone_from(&female.id);
            input.speed = speed;
            let started = speech.begin(runtime.clone(), store.clone(), input).unwrap();
            let job = await_job(&speech, &started.id);
            assert_eq!(job.state, "completed", "{:?}", job.error);
            let asset = job.asset.clone().unwrap();
            assert_eq!(asset.kind, "audio");
            assert!(asset.duration > 1.0 && asset.duration < 30.0);
            validate_wave(Path::new(&asset.native_path), 16000).unwrap();
            results.push((job, fs::read(&asset.native_path).unwrap()));
        }
        assert_ne!(
            results[0].1, results[1].1,
            "changing the speed must synthesize distinct audio"
        );
        assert!(
            results[1].0.asset.as_ref().unwrap().duration
                < results[0].0.asset.as_ref().unwrap().duration,
            "a faster rate must produce a shorter spoken clip"
        );
        speech.accept(&[results[0].0.id.clone()]).unwrap();
        assert!(speech.discard(&results[0].0.id).is_err());
        assert!(Path::new(&results[0].0.asset.as_ref().unwrap().native_path).exists());
        speech.discard(&results[1].0.id).unwrap();
        assert!(!Path::new(&results[1].0.asset.as_ref().unwrap().native_path).exists());
        let mut input = request(&"这一段用于验证生成中的取消与临时文件清理。".repeat(100));
        input.voice_id.clone_from(&female.id);
        let started = speech.begin(runtime, store.clone(), input).unwrap();
        thread::sleep(Duration::from_millis(250));
        speech.discard(&started.id).unwrap();
        assert_eq!(speech.get(&started.id).unwrap().state, "cancelled");
        assert_eq!(
            fs::read_dir(&store.root).unwrap().count(),
            1,
            "only the accepted audio may remain"
        );
        assert!(
            !fs::read_dir(data.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("voice-")),
            "temporary workspaces must be removed"
        );
        speech.shutdown();
    }

    #[test]
    #[ignore = "requires a real downloaded portable runtime and model; no desktop bundle needed"]
    fn real_portable_runtime_command_and_audio_round_trip() {
        let runtime_root = PathBuf::from(
            std::env::var_os("OPEN_MEDIA_TEST_RUNTIME_ROOT").expect("portable runtime root"),
        );
        let model_root = PathBuf::from(
            std::env::var_os("OPEN_MEDIA_TEST_MODEL_ROOT").expect("downloaded model root"),
        )
        .canonicalize()
        .unwrap();
        let engine = std::env::var("OPEN_MEDIA_TEST_ENGINE").expect("f5 or qwen3");
        assert!(matches!(engine.as_str(), "f5" | "qwen3"));
        let metadata_path =
            PathBuf::from(std::env::var_os("OPEN_MEDIA_TEST_RUNTIME_METADATA").expect(
                "OPEN_MEDIA_TEST_RUNTIME_METADATA must name the real builder artifact metadata",
            ));
        let model_id = if engine == "f5" {
            "f5-v1-base-fp32"
        } else {
            "qwen3-tts-1.7b-serena"
        };
        let (executable, script) = crate::speech_models::verify_portable_runtime_for_integration(
            &runtime_root,
            &metadata_path,
            model_id,
        )
        .expect(
            "real portable runtime must pass the application's complete integrity and path checks",
        );
        let model: Model = serde_json::from_value(
            json!({"kind":engine,"config":"runner-config.json","sampleRate":24000}),
        )
        .unwrap();
        let voice: SpeechVoice = serde_json::from_value(
            json!({"id":"integration_voice","name":"集成验证","language":"zh-CN","speakerId":0}),
        )
        .unwrap();
        let speech = SpeechRuntime {
            root: model_root,
            executable,
            script: Some(script),
            model,
            voices: vec![voice],
        };
        let work = tempfile::Builder::new()
            .prefix("配音 路径, 兼容-")
            .tempdir()
            .unwrap();
        let text = work.path().join("字幕 文本.txt");
        let output = work.path().join("生成 音频.wav");
        let log_path = work.path().join("generation.log");
        let mut input = request("这是一款全程由AI接管并生成的软件。");
        input.voice_id = "integration_voice".into();
        fs::write(&text, &input.text).unwrap();
        let log = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&log_path)
            .unwrap();
        let mut command = speech.command(&input, &text, &output).unwrap();
        command.stdout(log.try_clone().unwrap()).stderr(log);
        let started = Instant::now();
        let mut child = RunningChild(command.spawn().expect("portable runner must launch"));
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(1800),
                "portable synthesis exceeded 30 minutes"
            );
            thread::sleep(Duration::from_millis(100));
        };
        let details = fs::read_to_string(&log_path).unwrap_or_default();
        assert!(status.success(), "portable runtime failed: {details}");
        validate_wave(&output, 24000).expect("real portable output must be finite audible WAV");
        let bytes = fs::read(&output).unwrap();
        assert!(
            bytes.len() > 24000,
            "spoken sentence must contain substantial audio"
        );
        eprintln!(
            "portable {engine}: {} real WAV bytes in {:.2}s; {}",
            bytes.len(),
            started.elapsed().as_secs_f64(),
            details
        );
    }

    #[test]
    #[ignore = "requires network access and the prepared offline voice and media runtimes"]
    fn real_optional_voice_download_and_speech_round_trip() {
        let root = PathBuf::from(
            std::env::var_os("OPEN_MEDIA_SPEECH_ROOT")
                .expect("OPEN_MEDIA_SPEECH_ROOT must point to the prepared bundle"),
        );
        let data = tempfile::Builder::new()
            .prefix("下载音色, test-")
            .tempdir()
            .unwrap();
        let runtime = Runtime::discover(None, None).expect("real media runtime is required");
        let store = MediaStore::new(data.path()).unwrap();
        let resource = root.parent().unwrap();
        let speech = SpeechManager::new(data.path(), resource).unwrap();
        assert!(speech.status().ready, "{:?}", speech.status().error);
        let selected_model = std::env::var("OPEN_MEDIA_TEST_VOICE_MODEL")
            .unwrap_or_else(|_| "zipvoice-distill-fp32".into());
        let optional = speech
            .status()
            .voices
            .into_iter()
            .filter(|voice| {
                voice.status.as_deref() == Some("not-downloaded")
                    && voice.model_id.as_deref() == Some(selected_model.as_str())
            })
            .collect::<Vec<_>>();
        assert!(!optional.is_empty());
        let model_id = optional[0].model_id.clone().unwrap();
        assert!(optional
            .iter()
            .all(|voice| voice.model_id.as_ref() == Some(&model_id)));
        let mut input = request("下载前不可生成此声音。");
        input.voice_id.clone_from(&optional[0].id);
        assert!(speech.begin(runtime.clone(), store.clone(), input).is_err());

        speech.begin_model_download(&model_id).unwrap();
        speech.cancel_model_download(&model_id).unwrap();
        assert!(speech
            .status()
            .voices
            .iter()
            .filter(|voice| voice.model_id.as_ref() == Some(&model_id))
            .all(|voice| voice.status.as_deref() == Some("not-downloaded")));
        speech.begin_model_download(&model_id).unwrap();
        let await_ready = |speech: &SpeechManager| {
            let deadline = Instant::now() + Duration::from_secs(1200);
            let mut report = Instant::now();
            loop {
                let status = speech.status();
                let voices = status
                    .voices
                    .iter()
                    .filter(|voice| voice.model_id.as_ref() == Some(&model_id))
                    .collect::<Vec<_>>();
                assert_eq!(voices.len(), optional.len());
                assert!(
                    voices
                        .iter()
                        .all(|voice| voice.status.as_deref() != Some("failed")),
                    "{voices:?}"
                );
                if voices
                    .iter()
                    .all(|voice| voice.status.as_deref() == Some("ready"))
                {
                    assert!(voices
                        .iter()
                        .all(|voice| voice.downloaded_bytes == voice.download_size));
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "voice download test timed out: {voices:?}"
                );
                if report.elapsed() >= Duration::from_secs(10) {
                    eprintln!(
                        "voice download: {} / {} bytes ({})",
                        voices[0].downloaded_bytes.unwrap_or(0),
                        voices[0].download_size.unwrap_or(0),
                        voices[0].status.as_deref().unwrap_or("unknown")
                    );
                    report = Instant::now();
                }
                thread::sleep(Duration::from_millis(100));
            }
        };
        await_ready(&speech);
        // Already installed resources must remain usable after an application restart.
        speech.shutdown();
        drop(speech);
        let speech = SpeechManager::new(data.path(), resource).unwrap();
        await_ready(&speech);
        speech.begin_model_download(&model_id).unwrap();
        let mut generated = Vec::new();
        for voice in &optional {
            let text = if voice.language.starts_with("zh") {
                "这是一款全程由人工智能接管并生成的软件。欢迎使用本地配音。"
            } else {
                "This application was created with artificial intelligence. Welcome to local voice narration."
            };
            let mut input = request(text);
            input.voice_id.clone_from(&voice.id);
            let job = speech.begin(runtime.clone(), store.clone(), input).unwrap();
            let job = await_job(&speech, &job.id);
            assert_eq!(job.state, "completed", "{}: {:?}", voice.id, job.error);
            let asset = job.asset.as_ref().unwrap();
            assert!(asset.duration > 1.0 && asset.duration < 60.0);
            validate_wave(Path::new(&asset.native_path), 24000).unwrap();
            let audio = fs::read(&asset.native_path).unwrap();
            assert!(
                generated.iter().all(|previous| previous != &audio),
                "different voices must synthesize distinct audio"
            );
            generated.push(audio);
            eprintln!(
                "optional voice {}: {:.2}s real audio",
                voice.id, asset.duration
            );
            speech.discard(&job.id).unwrap();
        }
        assert_eq!(fs::read_dir(&store.root).unwrap().count(), 0);
        speech.shutdown();
    }
}
