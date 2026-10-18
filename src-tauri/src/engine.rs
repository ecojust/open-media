use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[path = "export_acceleration.rs"]
mod export_acceleration;

#[path = "transitions.rs"]
mod transitions;

pub type Result<T> = std::result::Result<T, String>;

pub fn new_id() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("系统随机数不可用");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn process(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(path);
    // Exclude the legacy chroma conversion path; newer vector instructions remain enabled.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    command.args(["-cpuflags", "-mmxext"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
#[derive(Clone)]
pub struct Runtime {
    pub encoder: PathBuf,
    pub probe: PathBuf,
    pub source: String,
    pub version: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    pub version: Option<String>,
    pub source: Option<String>,
    pub error: Option<String>,
}
impl Runtime {
    pub fn discover(resource: Option<&Path>, selected: Option<&Path>) -> Result<Self> {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        let mut candidates = Vec::new();
        if let Some(path) = selected {
            candidates.push((
                path.to_path_buf(),
                path.with_file_name(format!("ffprobe{exe}")),
                "用户选择",
            ));
        }
        if let Ok(path) = std::env::var("OPEN_MEDIA_FFMPEG") {
            let path = PathBuf::from(path);
            let probe = std::env::var("OPEN_MEDIA_FFPROBE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| path.with_file_name(format!("ffprobe{exe}")));
            candidates.push((path, probe, "开发环境"));
        }
        if let Some(root) = resource {
            for dir in [root.join("media"), root.join("resources/media")] {
                candidates.push((
                    dir.join(format!("ffmpeg{exe}")),
                    dir.join(format!("ffprobe{exe}")),
                    "内置引擎",
                ));
            }
        }
        candidates.push((
            PathBuf::from(format!("ffmpeg{exe}")),
            PathBuf::from(format!("ffprobe{exe}")),
            "系统引擎",
        ));
        for (encoder, probe, source) in candidates {
            if let (Ok(a), Ok(b)) = (
                process(&encoder).arg("-version").output(),
                process(&probe).arg("-version").output(),
            ) {
                if a.status.success() && b.status.success() {
                    let line = String::from_utf8_lossy(&a.stdout)
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_owned();
                    return Ok(Self {
                        encoder,
                        probe,
                        source: source.into(),
                        version: line.split_whitespace().nth(2).unwrap_or("未知").into(),
                    });
                }
            }
        }
        Err("媒体引擎不可用。请重新安装完整安装包，或在当前功能的「媒体处理检查」中选择本机编码工具。".into())
    }
    pub fn status(result: &Result<Self>) -> RuntimeStatus {
        match result {
            Ok(r) => RuntimeStatus {
                ready: true,
                version: Some(r.version.clone()),
                source: Some(r.source.clone()),
                error: None,
            },
            Err(e) => RuntimeStatus {
                ready: false,
                version: None,
                source: None,
                error: Some(e.clone()),
            },
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    pub mime: String,
    pub native_path: String,
}
#[derive(Clone)]
pub struct MediaStore {
    pub root: PathBuf,
}
impl MediaStore {
    pub fn new(app_data: &Path) -> Result<Self> {
        let root = app_data.join("media");
        fs::create_dir_all(&root).map_err(|e| format!("无法创建素材库：{e}"))?;
        Ok(Self {
            root: root.canonicalize().map_err(|e| e.to_string())?,
        })
    }
    pub fn import(&self, runtime: &Runtime, input: &Path, name: Option<&str>) -> Result<Asset> {
        let meta = fs::metadata(input).map_err(|e| format!("无法读取素材：{e}"))?;
        if !meta.is_file() || meta.len() == 0 {
            return Err("请选择非空媒体文件。".into());
        }
        let original = name.map(str::to_owned).unwrap_or_else(|| {
            input
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
        let ext = Path::new(&original)
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| s.len() <= 12 && s.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or("media");
        let destination = self.root.join(format!("{}.{}", new_id(), ext));
        fs::copy(input, &destination).map_err(|e| format!("无法保存素材：{e}"))?;
        match self.probe(runtime, &destination, &original) {
            Ok(asset) => Ok(asset),
            Err(e) => {
                let _ = fs::remove_file(destination);
                Err(e)
            }
        }
    }
    pub fn import_bytes(&self, runtime: &Runtime, bytes: &[u8], name: &str) -> Result<Asset> {
        if bytes.is_empty() || bytes.len() > 1024 * 1024 * 1024 {
            return Err("素材为空或超过 1 GB 导入上限。".into());
        }
        let temp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        fs::write(temp.path(), bytes).map_err(|e| e.to_string())?;
        self.import(runtime, temp.path(), Some(name))
    }
    pub fn authorized_path(&self, asset: &Value) -> Result<PathBuf> {
        let path = asset
            .get("nativePath")
            .and_then(Value::as_str)
            .ok_or("素材尚未导入本地媒体库，请重新导入。")?;
        let path = Path::new(path)
            .canonicalize()
            .map_err(|_| "素材文件已丢失，请重新导入。")?;
        if !path.starts_with(&self.root) || !path.is_file() {
            return Err("只能处理已经导入素材库的文件。".into());
        }
        Ok(path)
    }
    pub fn probe(&self, runtime: &Runtime, path: &Path, name: &str) -> Result<Asset> {
        let output = process(&runtime.probe)
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .map_err(|e| format!("读取媒体信息失败：{e}"))?;
        if !output.status.success() {
            return Err("文件不是可读取的图片、视频或音频。".into());
        }
        let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "媒体信息无效。")?;
        let streams = value["streams"].as_array().ok_or("文件没有媒体流。")?;
        let video = streams
            .iter()
            .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
        let audio = streams.iter().any(|s| s["codec_type"] == "audio");
        let ext = Path::new(name)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let is_image = [
            "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "heic", "gif",
        ]
        .contains(&ext.as_str());
        let kind = if is_image && video.is_some() {
            "image"
        } else if video.is_some() {
            "video"
        } else if audio {
            "audio"
        } else {
            return Err("文件不包含支持的媒体内容。".into());
        };
        let metadata_duration = seconds(&value["format"]["duration"]).or_else(|| {
            streams
                .iter()
                .filter_map(|stream| {
                    seconds(&stream["duration"]).or_else(|| seconds(&stream["tags"]["DURATION"]))
                })
                .reduce(f64::max)
        });
        let duration = if let Some(duration) = metadata_duration {
            duration
        } else if kind == "image" {
            5.0
        } else {
            packet_duration(runtime, path)?
        };
        let mut width = video.and_then(|s| s["width"].as_u64()).unwrap_or(0) as u32;
        let mut height = video.and_then(|s| s["height"].as_u64()).unwrap_or(0) as u32;
        if let Some(video) = video {
            let rotation = video["side_data_list"]
                .as_array()
                .and_then(|items| items.iter().find_map(|item| numeric(&item["rotation"])))
                .or_else(|| numeric(&video["tags"]["rotate"]))
                .unwrap_or(0.0)
                .rem_euclid(360.0);
            if (rotation - 90.0).abs() < 0.01 || (rotation - 270.0).abs() < 0.01 {
                std::mem::swap(&mut width, &mut height);
            }
        }
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            "tif" | "tiff" => "image/tiff",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mkv" => "video/x-matroska",
            _ => {
                if kind == "video" {
                    "video/mp4"
                } else {
                    "application/octet-stream"
                }
            }
        };
        Ok(Asset {
            id: new_id(),
            name: name.into(),
            kind: kind.into(),
            url: String::new(),
            duration,
            width,
            height,
            size: fs::metadata(path).map_err(|e| e.to_string())?.len(),
            mime: mime.into(),
            native_path: path.to_string_lossy().into(),
        })
    }
    pub fn has_audio(&self, runtime: &Runtime, path: &Path) -> bool {
        process(&runtime.probe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    }
}
fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
        .filter(|n| n.is_finite())
}
fn seconds(value: &Value) -> Option<f64> {
    numeric(value)
        .or_else(|| {
            let parts = value
                .as_str()?
                .split(':')
                .map(str::parse::<f64>)
                .collect::<std::result::Result<Vec<_>, _>>()
                .ok()?;
            (parts.len() == 3).then(|| parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
        })
        .filter(|n| n.is_finite() && *n > 0.0)
}
fn packet_duration(runtime: &Runtime, path: &Path) -> Result<f64> {
    let mut child = process(&runtime.probe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "packet=pts_time,dts_time,duration_time",
            "-of",
            "compact=p=0:nk=0",
        ])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("读取媒体时长失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取媒体时间戳。")?;
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("读取媒体时间戳失败：{error}"));
            }
        };
        let mut pts = None;
        let mut dts = None;
        let mut duration = 0.0;
        for field in line.split('|') {
            let Some((key, raw)) = field.split_once('=') else {
                continue;
            };
            let Some(value) = raw.parse::<f64>().ok().filter(|v| v.is_finite()) else {
                continue;
            };
            match key {
                "pts_time" => pts = Some(value),
                "dts_time" => dts = Some(value),
                "duration_time" => duration = value.max(0.0),
                _ => {}
            }
        }
        if let Some(timestamp) = pts.or(dts) {
            first = first.min(timestamp);
            last = last.max(timestamp + duration);
        }
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err("无法完整读取媒体时间戳，请检查文件是否损坏。".into());
    }
    let duration = last - first;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("无法确定媒体时长，请检查文件是否包含完整录制内容。".into());
    }
    Ok(duration)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJob {
    pub id: String,
    pub state: String,
    pub progress: f64,
    pub name: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub elapsed_seconds: f64,
    pub backend: Option<String>,
    pub stage: String,
    pub fallback_reason: Option<String>,
}
struct JobEntry {
    job: MediaJob,
    cancelled: Arc<AtomicBool>,
    started: std::time::Instant,
}
#[derive(Clone, Default)]
pub struct JobManager {
    jobs: Arc<Mutex<HashMap<String, JobEntry>>>,
}
#[derive(Clone, Debug)]
pub struct VideoTarget {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: String,
}
pub struct RenderPlan {
    pub args: Vec<String>,
    pub duration: f64,
    pub format: String,
    pub workspace: tempfile::TempDir,
    pub video: Option<VideoTarget>,
}
impl JobManager {
    pub fn list(&self) -> Vec<MediaJob> {
        let mut jobs = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .map(|entry| {
                let mut job = entry.job.clone();
                if job.state == "running" {
                    job.elapsed_seconds = entry.started.elapsed().as_secs_f64();
                }
                job
            })
            .collect::<Vec<_>>();
        jobs.sort_by(|a, b| a.id.cmp(&b.id));
        jobs
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let jobs = self.jobs.lock().unwrap();
        let item = jobs.get(id).ok_or("任务不存在。")?;
        item.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn cancel_all(&self) {
        for entry in self.jobs.lock().unwrap().values() {
            entry.cancelled.store(true, Ordering::SeqCst);
        }
    }
    pub fn shutdown(&self) {
        self.cancel_all();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while self.list().iter().any(|job| job.state == "running")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(30));
        }
    }
    pub fn begin(&self, runtime: &Runtime, plan: RenderPlan, output: PathBuf) -> Result<MediaJob> {
        self.begin_with_overwrite(runtime, plan, output, true)
    }
    pub fn begin_with_overwrite(
        &self,
        runtime: &Runtime,
        plan: RenderPlan,
        output: PathBuf,
        overwrite: bool,
    ) -> Result<MediaJob> {
        if !overwrite && output.try_exists().map_err(|e| e.to_string())? {
            return Err("输出文件已存在，请指定新路径或明确允许覆盖。".into());
        }
        let parent = output.parent().ok_or("请选择有效的保存目录。")?;
        let staging = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| format!("无法创建输出文件：{e}"))?;
        let started = std::time::Instant::now();
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let id = format!("{started_at}-{}", new_id());
        let job = MediaJob {
            id: id.clone(),
            state: "running".into(),
            progress: 0.0,
            name: output
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            output_path: None,
            error: None,
            started_at,
            elapsed_seconds: 0.0,
            backend: None,
            stage: "正在准备导出".into(),
            fallback_reason: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().unwrap();
            if jobs
                .values()
                .filter(|entry| entry.job.state == "running")
                .count()
                >= 4
            {
                return Err("已有 4 个导出任务，请等待完成后再试。".into());
            }
            jobs.insert(
                id.clone(),
                JobEntry {
                    job: job.clone(),
                    cancelled: cancelled.clone(),
                    started,
                },
            );
        }
        let jobs = self.jobs.clone();
        let runtime = runtime.clone();
        let worker_id = id.clone();
        let spawned = thread::Builder::new()
            .name("media-export".into())
            .spawn(move || {
                let id = worker_id;
                let mut detail = String::new();
                let result = (|| -> Result<()> {
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("cancelled".into());
                    }
                    let mut encoder = export_acceleration::Encoder::Cpu;
                    if let Some(target) = plan.video.as_ref().filter(|_| {
                        !export_acceleration::candidates(&plan.args, std::env::consts::OS)
                            .is_empty()
                    }) {
                        update_export_job(&jobs, &id, |job| job.stage = "正在检查硬件编码".into());
                        encoder = export_acceleration::select(
                            &runtime,
                            &plan.args,
                            target,
                            plan.workspace.path(),
                            &cancelled,
                        )?;
                    }
                    update_export_job(&jobs, &id, |job| {
                        job.backend = Some(encoder.label().into());
                        job.stage = "正在导出".into();
                    });
                    loop {
                        if cancelled.load(Ordering::SeqCst) {
                            return Err("cancelled".into());
                        }
                        let args = plan.video.as_ref().map_or_else(
                            || plan.args.clone(),
                            |target| export_acceleration::arguments(&plan.args, target, encoder),
                        );
                        let attempt = run_export_attempt(
                            &runtime,
                            &args,
                            &plan.format,
                            plan.duration,
                            staging.path(),
                            &jobs,
                            &id,
                            &cancelled,
                        )?;
                        detail = attempt.detail;
                        if attempt.success {
                            detail.clear();
                            break;
                        }
                        if cancelled.load(Ordering::SeqCst) {
                            return Err("cancelled".into());
                        }
                        if export_acceleration::retryable_failure(
                            encoder,
                            &detail,
                            attempt.abnormal_exit,
                        ) {
                            let reason = format!("{} 编码失败，已改用 CPU", encoder.label());
                            staging
                                .as_file()
                                .set_len(0)
                                .map_err(|e| format!("无法清理未完成的导出：{e}"))?;
                            encoder = export_acceleration::Encoder::Cpu;
                            update_export_job(&jobs, &id, |job| {
                                job.progress = 0.0;
                                job.backend = Some("CPU".into());
                                job.stage = "硬件编码不可用，正在使用 CPU 导出".into();
                                job.fallback_reason = Some(reason);
                            });
                            continue;
                        }
                        return Err("编码进程未成功完成。".into());
                    }
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("cancelled".into());
                    }
                    staging
                        .as_file()
                        .sync_all()
                        .map_err(|e| format!("无法写入导出文件：{e}"))?;
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("cancelled".into());
                    }
                    // A file may have appeared while encoding; the default MCP export must
                    // still preserve it instead of relying on the initial existence check.
                    let saved = if overwrite {
                        staging.persist(&output)
                    } else {
                        staging.persist_noclobber(&output)
                    };
                    saved
                        .map(|_| ())
                        .map_err(|e| format!("无法保存导出文件：{}", e.error))
                })();
                if let Some(entry) = jobs.lock().unwrap().get_mut(&id) {
                    entry.job.elapsed_seconds = entry.started.elapsed().as_secs_f64();
                    match result {
                        Ok(()) => {
                            entry.job.state = "completed".into();
                            entry.job.stage = "导出完成".into();
                            entry.job.progress = 1.0;
                            entry.job.output_path = Some(output.to_string_lossy().into());
                        }
                        Err(error) if error == "cancelled" => {
                            entry.job.state = "cancelled".into();
                            entry.job.stage = "已取消".into();
                        }
                        Err(error) => {
                            entry.job.state = "failed".into();
                            entry.job.stage = "导出失败".into();
                            entry.job.error = Some(if detail.is_empty() {
                                format!("导出失败：{error}")
                            } else {
                                format!(
                                    "导出失败：{}",
                                    detail.chars().take(1800).collect::<String>()
                                )
                            });
                        }
                    }
                }
            });
        if let Err(error) = spawned {
            self.jobs.lock().unwrap().remove(&id);
            return Err(format!("无法启动导出任务：{error}"));
        }
        Ok(job)
    }
}

fn update_export_job(
    jobs: &Mutex<HashMap<String, JobEntry>>,
    id: &str,
    update: impl FnOnce(&mut MediaJob),
) {
    if let Some(entry) = jobs.lock().unwrap().get_mut(id) {
        update(&mut entry.job);
    }
}

struct ExportAttempt {
    success: bool,
    abnormal_exit: bool,
    detail: String,
}
struct ExportChild(std::process::Child);
impl Drop for ExportChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn run_export_attempt(
    runtime: &Runtime,
    args: &[String],
    format: &str,
    duration: f64,
    output: &Path,
    jobs: &Arc<Mutex<HashMap<String, JobEntry>>>,
    id: &str,
    cancelled: &AtomicBool,
) -> Result<ExportAttempt> {
    let mut command = process(&runtime.encoder);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-threads",
            "2",
            "-filter_complex_threads",
            "1",
        ])
        .args(args)
        .args(["-progress", "pipe:1", "-nostats", "-f", format])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ExportChild(
        command
            .spawn()
            .map_err(|error| format!("无法启动导出：{error}"))?,
    );
    let stderr = child.0.stderr.take().ok_or("无法读取导出日志。")?;
    let errors = thread::spawn(move || {
        let mut tail = std::collections::VecDeque::new();
        for line in BufReader::new(stderr)
            .lines()
            .map_while(std::result::Result::ok)
        {
            tail.push_back(line.chars().take(1600).collect::<String>());
            if tail.len() > 30 {
                tail.pop_front();
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });
    let stdout = child.0.stdout.take().ok_or("无法读取导出进度。")?;
    let progress_jobs = jobs.clone();
    let progress_id = id.to_owned();
    let progress_thread = thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if let Some(time) = line
                .strip_prefix("out_time_us=")
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
            {
                if duration > 0.0 {
                    update_export_job(&progress_jobs, &progress_id, |job| {
                        job.progress = (time / 1_000_000.0 / duration).clamp(0.0, 0.99)
                    });
                }
            }
        }
    });
    let outcome = loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.0.kill();
            let _ = child.0.wait();
            break Err("cancelled".to_owned());
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => {
                let _ = child.0.kill();
                let _ = child.0.wait();
                break Err(error.to_string());
            }
            _ => thread::sleep(Duration::from_millis(50)),
        }
    };
    let _ = progress_thread.join();
    let detail = errors.join().unwrap_or_default();
    let status = outcome?;
    Ok(ExportAttempt {
        success: status.success(),
        abnormal_exit: status.code().is_none_or(|code| (code as u32) >= 0xc0000000),
        detail,
    })
}

pub fn number(v: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let x = v.get(key).and_then(Value::as_f64).unwrap_or(default);
    if !x.is_finite() || x < min || x > max {
        return Err(format!("参数 {key} 超出支持范围。"));
    }
    Ok(x)
}
fn arg(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|v| v.to_string()));
}
fn video_codec(args: &mut Vec<String>, format: &str, quality: &str, fps: f64) {
    if format == "gif" {
        return;
    }
    let crf = match quality {
        "draft" => "30",
        "high" => "18",
        _ => "23",
    };
    if format == "webm" {
        arg(
            args,
            &[
                "-c:v",
                "libvpx-vp9",
                "-crf",
                crf,
                "-b:v",
                "0",
                "-deadline",
                "good",
                "-cpu-used",
                "3",
                "-c:a",
                "libopus",
            ],
        );
    } else {
        arg(
            args,
            &[
                "-c:v", "libx264", "-crf", crf, "-preset", "medium", "-c:a", "aac",
            ],
        );
        if ["mp4", "mov"].contains(&format) {
            arg(args, &["-movflags", "+faststart"]);
        }
    }
    arg(args, &["-pix_fmt", "yuv420p", "-r", &fps.to_string()]);
}
fn container(format: &str) -> Result<&str> {
    match format {
        "mp4" => Ok("mp4"),
        "mov" => Ok("mov"),
        "webm" => Ok("webm"),
        "mkv" => Ok("matroska"),
        "mp3" => Ok("mp3"),
        "wav" => Ok("wav"),
        "aac" => Ok("adts"),
        "flac" => Ok("flac"),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tiff" => Ok("image2"),
        "gif" => Ok("gif"),
        _ => Err("不支持该输出格式。".into()),
    }
}
pub fn suggested_output(spec: &Value) -> Result<String> {
    let format = if spec["kind"] == "timeline" {
        spec["config"]["format"].as_str()
    } else if spec["kind"] == "gif" {
        Some("gif")
    } else {
        spec["format"].as_str()
    }
    .ok_or("请选择输出格式。")?;
    container(format)?;
    let name = if spec["kind"] == "timeline" {
        spec["project"]["title"].as_str()
    } else {
        spec["asset"]["name"].as_str()
    }
    .unwrap_or("媒体");
    let stem = Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    Ok(format!(
        "{}-导出.{format}",
        stem.chars()
            .map(
                |c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                    '_'
                } else {
                    c
                }
            )
            .collect::<String>()
    ))
}
pub fn build_plan(store: &MediaStore, runtime: &Runtime, spec: &Value) -> Result<RenderPlan> {
    let workspace = tempfile::tempdir().map_err(|e| e.to_string())?;
    match spec["kind"].as_str() {
        Some("convert") => convert_plan(store, spec, workspace),
        Some("gif") => gif_plan(store, spec, workspace),
        Some("timeline") => timeline_plan(store, runtime, spec, workspace),
        _ => Err("未知媒体任务。".into()),
    }
}
fn convert_plan(
    store: &MediaStore,
    spec: &Value,
    workspace: tempfile::TempDir,
) -> Result<RenderPlan> {
    let input = store.authorized_path(&spec["asset"])?;
    let format = spec["format"].as_str().ok_or("请选择格式。")?;
    let container = container(format)?.to_owned();
    let duration = number(&spec["asset"], "duration", 0.0, 0.0, 86400.0)?;
    let start = number(spec, "trimStart", 0.0, 0.0, duration.max(1.0))?;
    let end = number(spec, "trimEnd", duration, 0.0, duration.max(1.0))?;
    if end < start || (end == start && spec["asset"]["kind"] != "image") {
        return Err("结束时间必须晚于开始时间。".into());
    }
    let mut args = Vec::new();
    arg(&mut args, &["-i", &input.to_string_lossy()]);
    if start > 0.0 {
        arg(&mut args, &["-ss", &start.to_string()]);
    }
    if end > start {
        arg(&mut args, &["-t", &(end - start).to_string()]);
    }
    let fps = number(spec, "fps", 30.0, 1.0, 120.0)?;
    let width = number(spec, "width", 0.0, 0.0, 7680.0)? as u32;
    let height = number(spec, "height", 0.0, 0.0, 4320.0)? as u32;
    let image = ["png", "jpg", "jpeg", "webp", "bmp", "tiff"].contains(&format);
    let audio = ["mp3", "wav", "aac", "flac"].contains(&format);
    if audio {
        arg(
            &mut args,
            &[
                "-vn",
                "-c:a",
                match format {
                    "mp3" => "libmp3lame",
                    "wav" => "pcm_s16le",
                    "flac" => "flac",
                    _ => "aac",
                },
            ],
        );
    } else {
        let filter = if width > 0 && height > 0 {
            format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2")
        } else if width > 0 {
            format!("scale={width}:-2")
        } else if height > 0 {
            format!("scale=-2:{height}")
        } else if image {
            "null".into()
        } else {
            "scale=trunc(iw/2)*2:trunc(ih/2)*2".into()
        };
        if format == "gif" {
            arg(&mut args,&["-filter_complex",&format!("[0:v]{filter},fps={fps},split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=sierra2_4a"),"-an","-loop","0"]);
        } else {
            arg(&mut args, &["-vf", &filter]);
        }
        if image {
            arg(
                &mut args,
                &[
                    "-frames:v",
                    "1",
                    "-update",
                    "1",
                    "-an",
                    "-c:v",
                    match format {
                        "png" => "png",
                        "jpg" | "jpeg" => "mjpeg",
                        "webp" => "libwebp",
                        "bmp" => "bmp",
                        _ => "tiff",
                    },
                ],
            );
            if format == "jpg" || format == "jpeg" {
                arg(&mut args, &["-q:v", "2"]);
            }
        } else if format != "gif" {
            video_codec(
                &mut args,
                format,
                spec["quality"].as_str().unwrap_or("balanced"),
                fps,
            );
        }
    }
    if let Some(bitrate) = spec["videoBitrate"].as_f64() {
        if !(100.0..=200_000.0).contains(&bitrate) {
            return Err("视频码率超出范围。".into());
        }
        arg(&mut args, &["-b:v", &format!("{bitrate}k")]);
    }
    if let Some(bitrate) = spec["audioBitrate"].as_f64() {
        if !(16.0..=1024.0).contains(&bitrate) {
            return Err("音频码率超出范围。".into());
        }
        arg(&mut args, &["-b:a", &format!("{bitrate}k")]);
    }
    if let Some(rate) = spec["sampleRate"].as_u64() {
        if ![8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000].contains(&rate) {
            return Err("不支持该采样率。".into());
        }
        arg(&mut args, &["-ar", &rate.to_string()]);
    }
    let video = if !image && !audio && format != "gif" {
        let source_width = number(&spec["asset"], "width", 1920.0, 1.0, 32768.0)? as u32;
        let source_height = number(&spec["asset"], "height", 1080.0, 1.0, 32768.0)? as u32;
        let (output_width, output_height) = match (width, height) {
            (0, 0) => (source_width / 2 * 2, source_height / 2 * 2),
            (w, 0) => (
                w,
                ((source_height as f64 * w as f64 / source_width as f64 / 2.0).round() as u32) * 2,
            ),
            (0, h) => (
                ((source_width as f64 * h as f64 / source_height as f64 / 2.0).round() as u32) * 2,
                h,
            ),
            (w, h) => (w, h),
        };
        Some(VideoTarget {
            width: output_width.max(2),
            height: output_height.max(2),
            fps,
            quality: spec["quality"].as_str().unwrap_or("balanced").into(),
        })
    } else {
        None
    };
    Ok(RenderPlan {
        video,
        args,
        duration: (end - start).max(0.1),
        format: container,
        workspace,
    })
}
fn gif_plan(store: &MediaStore, spec: &Value, workspace: tempfile::TempDir) -> Result<RenderPlan> {
    let path = store.authorized_path(&spec["asset"])?;
    let segments = spec["segments"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or("请选择 1 至 100 个片段。")?;
    let width = number(spec, "width", 640.0, 16.0, 1920.0)? as u32;
    let fps = number(spec, "fps", 12.0, 1.0, 60.0)?;
    let source_duration = number(&spec["asset"], "duration", 0.0, 0.0, 86400.0)?;
    let mut filters = Vec::new();
    let mut duration = 0.0;
    for (i, segment) in segments.iter().enumerate() {
        let start = number(segment, "start", 0.0, 0.0, source_duration)?;
        let end = number(segment, "end", source_duration, 0.0, source_duration)?;
        if end <= start {
            return Err("片段结束必须晚于开始。".into());
        }
        duration += end - start;
        filters.push(format!("[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,scale={width}:-2,fps={fps}[s{i}]"));
    }
    if duration > 600.0 {
        return Err("动图片段总长请控制在 10 分钟以内。".into());
    }
    let labels = (0..segments.len())
        .map(|i| format!("[s{i}]"))
        .collect::<String>();
    filters.push(format!("{labels}concat=n={}:v=1:a=0,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[out]",segments.len()));
    let mut args = Vec::new();
    arg(
        &mut args,
        &[
            "-i",
            &path.to_string_lossy(),
            "-filter_complex",
            &filters.join(";"),
            "-map",
            "[out]",
            "-an",
            "-loop",
            if spec["loop"].as_bool().unwrap_or(true) {
                "0"
            } else {
                "-1"
            },
        ],
    );
    Ok(RenderPlan {
        args,
        duration,
        format: "gif".into(),
        workspace,
        video: None,
    })
}
fn safe_color(value: &str) -> String {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        value.into()
    } else {
        "#000000".into()
    }
}
fn tempo(speed: f64) -> String {
    let mut speed = speed;
    let mut result = Vec::new();
    while speed > 2.0 {
        result.push("atempo=2".to_string());
        speed /= 2.0;
    }
    while speed < 0.5 {
        result.push("atempo=0.5".to_string());
        speed /= 0.5;
    }
    result.push(format!("atempo={speed}"));
    result.join(",")
}
fn fade_parameters(clip: &Value, duration: f64) -> Result<(f64, f64, f64)> {
    let fade_in = number(clip, "fadeIn", 0.0, 0.0, duration)?;
    let fade_out = number(clip, "fadeOut", 0.0, 0.0, duration)?;
    let peak = if fade_in + fade_out > duration {
        duration / (fade_in + fade_out)
    } else {
        1.0
    };
    Ok((fade_in * peak, fade_out * peak, peak))
}
fn timeline_plan(
    store: &MediaStore,
    runtime: &Runtime,
    spec: &Value,
    workspace: tempfile::TempDir,
) -> Result<RenderPlan> {
    let project = &spec["project"];
    let config = &spec["config"];
    let width = number(config, "width", 1920.0, 16.0, 7680.0)? as u32;
    let height = number(config, "height", 1080.0, 16.0, 7680.0)? as u32;
    if width % 2 != 0 || height % 2 != 0 {
        return Err("输出宽高必须为偶数。".into());
    }
    let fps = number(config, "fps", 30.0, 1.0, 120.0)?;
    let project_w = number(project, "width", 1920.0, 1.0, 16384.0)?;
    let project_h = number(project, "height", 1080.0, 1.0, 16384.0)?;
    let format = config["format"].as_str().unwrap_or("mp4");
    if !["mp4", "webm", "mov", "gif"].contains(&format) {
        return Err("不支持该项目导出格式。".into());
    }
    let tracks = project["tracks"]
        .as_array()
        .filter(|t| t.len() <= 100)
        .ok_or("时间线轨道无效。")?;
    let assets = project["assets"].as_array().ok_or("素材列表无效。")?;
    let transitions = transitions::Transitions::from_project(project)?;
    let mut clips = Vec::new();
    let mut total = 0.0_f64;
    for track in tracks.iter().rev() {
        if track["kind"] == "transition" {
            continue;
        }
        let items = track["clips"].as_array().ok_or("轨道片段无效。")?;
        for clip in items {
            let speed = number(clip, "speed", 1.0, 0.1, 16.0)?;
            let input = number(clip, "trimIn", 0.0, 0.0, 86400.0)?;
            let output = number(clip, "trimOut", 1.0, input, 86400.0)?;
            let duration = (output - input) / speed;
            if duration <= 0.0 {
                continue;
            }
            let start = number(clip, "start", 0.0, 0.0, 86400.0)?;
            total = total.max(start + duration);
            clips.push((track, clip, start, input, output, speed, duration));
        }
    }
    if clips.is_empty() || clips.len() > 500 || total > 86400.0 {
        return Err("项目需要包含 1 至 500 个有效片段，时长不超过 24 小时。".into());
    }
    let background = safe_color(project["background"].as_str().unwrap_or("#101114"));
    let mut args = Vec::new();
    arg(
        &mut args,
        &[
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={background}:s={width}x{height}:r={fps}:d={total}"),
        ],
    );
    let mut filters = vec!["[0:v]format=rgba[base0]".to_string()];
    let mut visuals = 0;
    let mut audio_labels = Vec::new();
    for (i, (track, clip, start, trim_in, trim_out, speed, duration)) in clips.iter().enumerate() {
        let text = track["kind"] == "text";
        let asset = if text {
            spec["textAssets"]
                .get(clip["id"].as_str().unwrap_or_default())
                .ok_or("字幕预览尚未准备完成，请重新导出。")?
        } else {
            let id = clip["assetId"].as_str().ok_or("片段缺少素材。")?;
            assets
                .iter()
                .find(|a| a["id"] == id)
                .ok_or("片段素材已丢失。")?
        };
        let path = store.authorized_path(asset)?;
        let image = text || asset["kind"] == "image";
        let loop_audio = if image {
            false
        } else {
            let source_duration = number(asset, "duration", 0.0, 0.0, 86400.0)?;
            if source_duration <= 0.0 {
                return Err("素材时长无效，请重新导入后导出。".into());
            }
            if track["kind"] == "audio" {
                *trim_out > source_duration
            } else {
                if *trim_out > source_duration + 0.001 {
                    return Err("视频片段超出素材原始时长，请缩短片段后导出。".into());
                }
                false
            }
        };
        let color_filter = crate::clip_filters::filter_chain(
            clip,
            track["kind"] == "video" && (asset["kind"] == "video" || asset["kind"] == "image"),
        )?;
        let chroma_key = crate::chroma_key::filter_chain(
            clip,
            track["kind"] == "video" && (asset["kind"] == "video" || asset["kind"] == "image"),
        )?;
        if loop_audio || (image && asset["mime"] == "image/gif") {
            arg(
                &mut args,
                &["-stream_loop", "-1", "-t", &trim_out.to_string()],
            );
        } else if image {
            arg(
                &mut args,
                &[
                    "-loop",
                    "1",
                    "-framerate",
                    &fps.to_string(),
                    "-t",
                    &trim_out.to_string(),
                ],
            );
        }
        arg(&mut args, &["-i", &path.to_string_lossy()]);
        let index = i + 1;
        if track["kind"] != "audio" && asset["kind"] != "audio" {
            let cw = (number(clip, "width", project_w, 1.0, 30000.0)? / project_w * width as f64)
                .round()
                .max(2.0) as u32;
            let ch = (number(clip, "height", project_h, 1.0, 30000.0)? / project_h * height as f64)
                .round()
                .max(2.0) as u32;
            let x = number(clip, "x", 0.0, -30000.0, 30000.0)? / project_w * width as f64;
            let y = number(clip, "y", 0.0, -30000.0, 30000.0)? / project_h * height as f64;
            let rotation =
                number(clip, "rotation", 0.0, -3600.0, 3600.0)? * std::f64::consts::PI / 180.0;
            let (fade_in, fade_out, fade_peak) = fade_parameters(clip, *duration)?;
            let opacity = number(clip, "opacity", 1.0, 0.0, 1.0)? * fade_peak;
            let fit = clip["fit"].as_str().unwrap_or("contain");
            let scale=match fit{"cover"=>format!("scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch}"),"fill"=>format!("scale={cw}:{ch}"),_=>format!("scale={cw}:{ch}:force_original_aspect_ratio=decrease,pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color=0x00000000")};
            let mut chain=format!("[{index}:v]trim=start={trim_in}:end={trim_out},setpts=(PTS-STARTPTS)/{speed},format=rgba");
            if let Some(filter) = &chroma_key {
                chain = crate::chroma_key::append_graph(chain, &mut filters, index, filter);
            }
            chain += &format!(",{scale},setsar=1");
            if let Some(filter) = &color_filter {
                chain += &format!(",format=rgba,split[filter_input{index}][filter_alpha{index}]");
                filters.push(chain);
                filters.push(format!(
                    "[filter_alpha{index}]alphaextract[filter_mask{index}]"
                ));
                filters.push(format!(
                    "[filter_input{index}]{filter}[filter_color{index}]"
                ));
                chain = format!("[filter_color{index}][filter_mask{index}]alphamerge");
            }
            chain += &format!(",colorchannelmixer=aa={opacity}");
            if fade_in > 0.0 {
                chain += &format!(",fade=t=in:st=0:d={fade_in}:alpha=1");
            }
            if fade_out > 0.0 {
                chain += &format!(
                    ",fade=t=out:st={}:d={fade_out}:alpha=1",
                    duration - fade_out
                );
            }
            chain += &transitions.filter_chain(clip, fps);
            if rotation != 0.0 {
                chain +=
                    &format!(",rotate={rotation}:ow=rotw({rotation}):oh=roth({rotation}):c=none");
            }
            chain += &format!(",setpts=PTS+{start}/TB[v{index}]");
            filters.push(chain);
            // A trimmed stream can reach EOF between output frame timestamps.
            // Its final decoded frame remains valid until the clip's exclusive
            // endpoint; passing the background here would insert a black frame.
            filters.push(format!("[base{visuals}][v{index}]overlay=x='{x}+({cw}-overlay_w)/2':y='{y}+({ch}-overlay_h)/2':enable='gte(t,{start})*lt(t,{})':eof_action=repeat:repeatlast=1:format=auto[base{}]",start+duration,visuals+1));
            visuals += 1;
        }
        let volume = number(clip, "volume", 1.0, 0.0, 4.0)?;
        if !image && volume > 0.0 && track["muted"] != true && store.has_audio(runtime, &path) {
            let (fade_in, fade_out, fade_peak) = fade_parameters(clip, *duration)?;
            let volume = volume * fade_peak;
            let mut chain=format!("[{index}:a]atrim=start={trim_in}:end={trim_out},asetpts=PTS-STARTPTS,{},apad=whole_dur={duration},atrim=duration={duration},volume={volume}",tempo(*speed));
            if fade_in > 0.0 {
                chain += &format!(",afade=t=in:st=0:d={fade_in}");
            }
            if fade_out > 0.0 {
                chain += &format!(",afade=t=out:st={}:d={fade_out}", duration - fade_out);
            }
            chain += &format!(
                ",adelay={}|{}[a{index}]",
                (start * 1000.0).round(),
                (start * 1000.0).round()
            );
            filters.push(chain);
            audio_labels.push(format!("[a{index}]"));
        }
    }
    if format == "gif" {
        filters.push(format!("[base{visuals}]fps={fps},split[pa][pb];[pa]palettegen[p];[pb][p]paletteuse=dither=sierra2_4a[video]"));
    } else {
        filters.push(format!("[base{visuals}]format=yuv420p[video]"));
    }
    if !audio_labels.is_empty() && format != "gif" {
        filters.push(format!("{}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[audio]",audio_labels.join(""),audio_labels.len()));
    }
    let script = workspace.path().join("filters.txt");
    fs::write(&script, filters.join(";\n")).map_err(|e| e.to_string())?;
    arg(
        &mut args,
        &[
            "-filter_complex_script",
            &script.to_string_lossy(),
            "-map",
            "[video]",
        ],
    );
    if !audio_labels.is_empty() && format != "gif" {
        arg(&mut args, &["-map", "[audio]"]);
    } else {
        arg(&mut args, &["-an"]);
    }
    video_codec(
        &mut args,
        format,
        config["quality"].as_str().unwrap_or("balanced"),
        fps,
    );
    if format == "gif" {
        arg(&mut args, &["-loop", "0"]);
    }
    arg(&mut args, &["-t", &total.to_string()]);
    Ok(RenderPlan {
        args,
        duration: total,
        format: format.into(),
        video: Some(VideoTarget {
            width,
            height,
            fps,
            quality: config["quality"].as_str().unwrap_or("balanced").into(),
        }),
        workspace,
    })
}
