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
    fn checked_root(&self) -> Result<&Path> {
        let metadata = fs::symlink_metadata(&self.root)
            .map_err(|error| format!("媒体保存目录不可用：{error}"))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || self
                .root
                .canonicalize()
                .map_err(|error| error.to_string())?
                != self.root
        {
            return Err("媒体保存目录已改变，请重新打开应用。".into());
        }
        Ok(&self.root)
    }
    /// Recording storage is a fixed sibling of the application's media directory.
    pub fn recording_root(&self) -> Result<PathBuf> {
        let root = self.checked_root()?;
        if !matches!(
            root.file_name().and_then(|value| value.to_str()),
            Some("media" | "recordings")
        ) {
            return Err("录屏保存目录无效。".into());
        }
        let recordings = root
            .parent()
            .ok_or("录屏保存目录无效。")?
            .join("recordings");
        match fs::symlink_metadata(&recordings) {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || recordings
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        != recordings
                {
                    return Err("录屏保存目录已改变，请重新打开应用。".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("录屏保存目录不可用：{error}")),
        }
        Ok(recordings)
    }
    pub fn recording_store(&self) -> Result<Self> {
        let root = self.recording_root()?;
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("无法创建录屏保存目录：{error}")),
        }
        let store = Self { root };
        store.checked_root()?;
        Ok(store)
    }
    /// Callers pass a canonical existing file or directory.
    pub fn is_internal_path(&self, path: &Path) -> bool {
        path.starts_with(&self.root)
            || self
                .recording_root()
                .is_ok_and(|root| path.starts_with(root))
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
            Ok(asset) => {
                let _ = crate::media_metadata::remember_name(self, &asset);
                Ok(asset)
            }
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
    /// Capture output is already a PNG. Read its dimensions locally instead of
    /// starting a media-probing process for this known still-image format.
    pub fn import_png(&self, input: &Path, name: &str) -> Result<Asset> {
        self.checked_root()?;
        let file = fs::File::open(input).map_err(|error| format!("无法读取截屏：{error}"))?;
        let mut decoder = png::Decoder::new(BufReader::new(file));
        decoder.set_limits(png::Limits { bytes: 400_000_000 });
        let mut reader = decoder.read_info().map_err(|error| format!("截屏图片无效：{error}"))?;
        let (width, height) = (reader.info().width, reader.info().height);
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 100_000_000 {
            return Err("截屏尺寸无效或范围过大。".into());
        }
        // Decode one row at a time to validate actual image data without keeping
        // another full desktop-sized bitmap in memory.
        while reader.next_row().map_err(|error| format!("截屏图片损坏：{error}"))?.is_some() {}
        reader.finish().map_err(|error| format!("截屏图片不完整：{error}"))?;
        let destination = self.root.join(format!("{}.png", new_id()));
        let size = match fs::copy(input, &destination) {
            Ok(size) => size,
            Err(error) => {
                let _ = fs::remove_file(&destination);
                return Err(format!("无法保存截屏：{error}"));
            }
        };
        let asset = Asset {
            id: new_id(), name: name.into(), kind: "image".into(), url: String::new(),
            duration: 5.0, width, height, size, mime: "image/png".into(),
            native_path: destination.to_string_lossy().into(),
        };
        let _ = crate::media_metadata::remember_name(self, &asset);
        Ok(asset)
    }
    pub fn authorized_path(&self, asset: &Value) -> Result<PathBuf> {
        self.checked_root()?;
        let path = asset
            .get("nativePath")
            .and_then(Value::as_str)
            .ok_or("素材尚未导入本地媒体库，请重新导入。")?;
        let path = Path::new(path)
            .canonicalize()
            .map_err(|_| "素材文件已丢失，请重新导入。")?;
        if !self.is_internal_path(&path) || !path.is_file() {
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
    pub encoded_frames: u64,
    pub output_time: f64,
    pub output_idle_seconds: Option<f64>,
}
struct JobEntry {
    job: MediaJob,
    cancelled: Arc<AtomicBool>,
    started: std::time::Instant,
    output_progress_at: Option<std::time::Instant>,
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
                    job.output_idle_seconds = entry
                        .output_progress_at
                        .map(|updated| updated.elapsed().as_secs_f64());
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
            encoded_frames: 0,
            output_time: 0.0,
            output_idle_seconds: None,
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
                    output_progress_at: None,
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
                        job.stage = "正在等待首帧输出".into();
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
                            plan.video.as_ref().map(|target|target.fps),
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
                                job.encoded_frames = 0;
                                job.output_time = 0.0;
                                job.backend = Some("CPU".into());
                                job.stage = "正在等待首帧输出".into();
                                job.fallback_reason = Some(reason);
                            });
                            continue;
                        }
                        return Err("编码进程未成功完成。".into());
                    }
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("cancelled".into());
                    }
                    update_export_job(&jobs,&id,|job|job.stage="正在写入输出文件".into());
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
                                    export_log_tail(&detail, 1800)
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

fn reset_export_output(jobs: &Mutex<HashMap<String, JobEntry>>, id: &str) {
    if let Some(entry) = jobs.lock().unwrap().get_mut(id) {
        entry.job.progress = 0.0;
        entry.job.encoded_frames = 0;
        entry.job.output_time = 0.0;
        entry.job.output_idle_seconds = Some(0.0);
        entry.job.stage = "正在等待首帧输出".into();
        entry.output_progress_at = Some(std::time::Instant::now());
    }
}

// Only advancing media counters count as activity; repeated zero reports do not.
fn apply_export_progress(
    job: &mut MediaJob,
    line: &str,
    duration: f64,
    frame_rate: Option<f64>,
) -> bool {
    let mut advanced = false;
    if let Some(frames) = line
        .strip_prefix("frame=")
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        advanced = frames > job.encoded_frames;
        job.encoded_frames = job.encoded_frames.max(frames);
        if let Some(rate) = frame_rate.filter(|rate| rate.is_finite() && *rate > 0.0) {
            job.progress = job.progress.max(
                (job.encoded_frames as f64 / (duration * rate).max(1.0)).clamp(0.0, 0.99),
            );
        }
    }
    if let Some(time) = line
        .strip_prefix("out_time_us=")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
    {
        let seconds = (time / 1_000_000.0).max(0.0);
        advanced = seconds > job.output_time;
        job.output_time = job.output_time.max(seconds);
        if duration > 0.0 {
            job.progress = job.progress.max((job.output_time / duration).clamp(0.0, 0.99));
        }
    }
    if advanced {
        job.stage = "正在编码输出".into();
    }
    advanced
}

fn record_export_progress(
    jobs: &Mutex<HashMap<String, JobEntry>>,
    id: &str,
    line: &str,
    duration: f64,
    frame_rate: Option<f64>,
) {
    if let Some(entry) = jobs.lock().unwrap().get_mut(id) {
        if apply_export_progress(&mut entry.job, line, duration, frame_rate) {
            entry.output_progress_at = Some(std::time::Instant::now());
            entry.job.output_idle_seconds = Some(0.0);
        }
    }
}

fn export_log_tail(text: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    let start = text.char_indices().rev().nth(limit - 1).map_or(0, |(index, _)| index);
    text[start..].to_owned()
}

fn read_export_log(reader: impl BufRead) -> String {
    let mut tail = std::collections::VecDeque::new();
    for line in reader.split(b'\n') {
        let line = match line {
            Ok(bytes) => export_log_tail(&String::from_utf8_lossy(&bytes), 1600),
            Err(error) => {
                tail.push_back(format!("读取导出日志失败：{error}"));
                break;
            }
        };
        tail.push_back(line);
        if tail.len() > 30 {
            tail.pop_front();
        }
    }
    tail.into_iter().collect::<Vec<_>>().join("\n")
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
    frame_rate: Option<f64>,
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
        .args(["-progress", "pipe:1", "-stats_period", "0.25", "-nostats", "-f", format])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ExportChild(
        command
            .spawn()
            .map_err(|error| format!("无法启动导出：{error}"))?,
    );
    reset_export_output(jobs, id);
    let stderr = child.0.stderr.take().ok_or("无法读取导出日志。")?;
    let errors = thread::spawn(move || read_export_log(BufReader::new(stderr)));
    let stdout = child.0.stdout.take().ok_or("无法读取导出进度。")?;
    let progress_jobs = jobs.clone();
    let progress_id = id.to_owned();
    let progress_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n') {
            let bytes = line.map_err(|error| format!("读取导出进度失败：{error}"))?;
            record_export_progress(
                &progress_jobs, &progress_id, &String::from_utf8_lossy(&bytes), duration, frame_rate,
            );
        }
        Ok::<(), String>(())
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
    let progress_result = progress_thread
        .join()
        .unwrap_or_else(|_| Err("导出进度读取线程意外退出。".into()));
    let mut detail = errors.join().unwrap_or_else(|_| "导出日志读取线程意外退出。".into());
    if let Err(error) = progress_result {
        detail.push_str(&format!("\n{error}"));
    }
    if let Some(entry) = jobs.lock().unwrap().get_mut(id) {
        entry.job.output_idle_seconds = None;
        entry.output_progress_at = None;
    }
    let status = outcome?;
    Ok(ExportAttempt {
        success: status.success(),
        abnormal_exit: status.code().is_none_or(|code| (code as u32) >= 0xc0000000),
        detail,
    })
}

#[cfg(test)]
mod export_progress_tests {
    use super::*;
    use std::time::Instant;

    fn manager() -> JobManager {
        let jobs = JobManager::default();
        jobs.jobs.lock().unwrap().insert("export".into(), JobEntry {
            job: MediaJob {
                id: "export".into(), state: "running".into(), progress: 0.0,
                name: "video.mp4".into(), output_path: None, error: None, started_at: 0,
                elapsed_seconds: 0.0, backend: Some("CPU".into()),
                stage: "正在等待首帧输出".into(), fallback_reason: None,
                encoded_frames: 0, output_time: 0.0, output_idle_seconds: None,
            },
            cancelled: Arc::new(AtomicBool::new(false)),
            started: Instant::now(), output_progress_at: None,
        });
        jobs
    }

    fn mark_idle(jobs: &JobManager) -> Instant {
        let updated = Instant::now() - Duration::from_secs(125);
        jobs.jobs.lock().unwrap().get_mut("export").unwrap().output_progress_at = Some(updated);
        updated
    }

    #[test]
    fn repeated_zero_or_unchanged_reports_do_not_hide_output_stalls() {
        let jobs = manager();
        assert_eq!(jobs.list()[0].output_idle_seconds, None);
        reset_export_output(&jobs.jobs, "export");
        let original = mark_idle(&jobs);
        for line in ["frame=0", "out_time_us=0", "out_time_us=N/A", "out_time_us=NaN", "progress=continue"] {
            record_export_progress(&jobs.jobs, "export", line, 600.0, Some(25.0));
        }
        assert_eq!(jobs.jobs.lock().unwrap()["export"].output_progress_at, Some(original));
        let waiting = &jobs.list()[0];
        assert_eq!(waiting.progress, 0.0);
        assert!(waiting.output_idle_seconds.unwrap() >= 125.0);
        assert_eq!(waiting.stage, "正在等待首帧输出");

        record_export_progress(&jobs.jobs, "export", "frame=25\r", 600.0, Some(25.0));
        assert_eq!(jobs.list()[0].encoded_frames, 25);
        assert_eq!(jobs.list()[0].stage, "正在编码输出");
        assert!(jobs.jobs.lock().unwrap()["export"].output_progress_at.unwrap() > original);
        let unchanged = mark_idle(&jobs);
        for line in ["frame=25", "frame=24", "out_time_us=-1"] {
            record_export_progress(&jobs.jobs, "export", line, 600.0, Some(25.0));
        }
        assert_eq!(jobs.jobs.lock().unwrap()["export"].output_progress_at, Some(unchanged));
        record_export_progress(&jobs.jobs, "export", "out_time_us=1000000\r", 600.0, Some(25.0));
        assert!(jobs.jobs.lock().unwrap()["export"].output_progress_at.unwrap() > unchanged);
        let unchanged_time = mark_idle(&jobs);
        for line in ["out_time_us=1000000", "out_time_us=500000"] {
            record_export_progress(&jobs.jobs, "export", line, 600.0, Some(25.0));
        }
        assert_eq!(jobs.jobs.lock().unwrap()["export"].output_progress_at, Some(unchanged_time));
        let progressing = &jobs.list()[0];
        assert_eq!(progressing.encoded_frames, 25);
        assert_eq!(progressing.output_time, 1.0);
        assert_eq!(progressing.progress, 1.0 / 600.0);
    }

    #[test]
    fn retry_starts_new_output_counters_and_waiting_clock() {
        let jobs = manager();
        record_export_progress(&jobs.jobs, "export", "frame=250", 600.0, Some(25.0));
        record_export_progress(&jobs.jobs, "export", "out_time_us=10000000", 600.0, Some(25.0));
        let previous = mark_idle(&jobs);
        reset_export_output(&jobs.jobs, "export");
        let retry = &jobs.list()[0];
        assert_eq!(retry.encoded_frames, 0);
        assert_eq!(retry.output_time, 0.0);
        assert_eq!(retry.progress, 0.0);
        assert_eq!(retry.stage, "正在等待首帧输出");
        assert!(retry.output_idle_seconds.unwrap() < 1.0);
        assert!(jobs.jobs.lock().unwrap()["export"].output_progress_at.unwrap() > previous);
    }

    #[test]
    fn error_tail_preserves_last_failure_after_invalid_utf8() {
        let mut log = (0..35).map(|index| format!("message {index}\n")).collect::<String>().into_bytes();
        log.extend_from_slice(b"invalid path: \xff\n");
        log.extend_from_slice("最终错误：输出文件写入失败".as_bytes());
        let detail = read_export_log(std::io::Cursor::new(log));
        assert!(!detail.contains("message 0\n"));
        assert!(detail.contains("invalid path: \u{fffd}"));
        assert!(detail.ends_with("最终错误：输出文件写入失败"));
        assert_eq!(export_log_tail(&detail, 8), "输出文件写入失败");
        assert_eq!(export_log_tail("短日志", 1800), "短日志");
    }

    #[test]
    fn log_read_errors_are_retained() {
        struct BrokenReader;
        impl std::io::Read for BrokenReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("closed stream"))
            }
        }
        assert!(read_export_log(BufReader::new(BrokenReader)).contains("读取导出日志失败：closed stream"));
    }
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
    if start > 0.0 {
        arg(&mut args, &["-ss", &start.to_string()]);
    }
    arg(&mut args, &["-i", &input.to_string_lossy()]);
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
    let mut ranges = Vec::with_capacity(segments.len());
    let mut duration = 0.0;
    let mut source_start = source_duration;
    let mut source_end = 0.0_f64;
    for segment in segments {
        let start = number(segment, "start", 0.0, 0.0, source_duration)?;
        let end = number(segment, "end", source_duration, 0.0, source_duration)?;
        if end <= start {
            return Err("片段结束必须晚于开始。".into());
        }
        duration += end - start;
        source_start = source_start.min(start);
        source_end = source_end.max(end);
        ranges.push((start, end));
    }
    if duration > 600.0 {
        return Err("动图片段总长请控制在 10 分钟以内。".into());
    }
    // Keep one decoder even with many selected segments, but skip the unused
    // prefix and tail. Segment timestamps remain relative to the source seek.
    let mut filters: Vec<_> = ranges.iter().enumerate().map(|(i, (start, end))| {
        format!("[0:v]trim=start={}:end={},setpts=PTS-STARTPTS,fps={fps},scale={width}:-2[s{i}]", start-source_start, end-source_start)
    }).collect();
    let labels = (0..segments.len())
        .map(|i| format!("[s{i}]"))
        .collect::<String>();
    filters.push(format!("{labels}concat=n={}:v=1:a=0,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[out]",segments.len()));
    let mut args = Vec::new();
    if source_start > 0.0 {
        arg(&mut args, &["-ss", &source_start.to_string()]);
    }
    arg(&mut args, &["-t", &(source_end-source_start).to_string()]);
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
    let audio_only = spec["audioOnly"] == true;
    let frame_time = if spec["frameOnly"] == true { Some(number(spec, "frameTime", 0.0, 0.0, 86400.0)?) } else { None };
    let render_start = if frame_time.is_some() { frame_time.unwrap() } else { number(spec, "renderStart", 0.0, 0.0, 86400.0)? };
    let requested_end = spec.get("renderEnd").and_then(Value::as_f64);
    let windowed = frame_time.is_some() || requested_end.is_some();
    let config = &spec["config"];
    let min_dimension = if frame_time.is_some() { 1.0 } else { 16.0 };
    let max_dimension = if frame_time.is_some() { 1920.0 } else { 7680.0 };
    let width = number(config, "width", 1920.0, min_dimension, max_dimension)? as u32;
    let height = number(config, "height", 1080.0, min_dimension, max_dimension)? as u32;
    if frame_time.is_none() && (width % 2 != 0 || height % 2 != 0) {
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
            let duration = crate::clip_animation::duration(clip)?;
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
    let render_end = if frame_time.is_some() { (render_start + 1.0/fps).min(total) } else { requested_end.unwrap_or(total) };
    if !render_end.is_finite() || render_start >= total || render_end > total + 0.000001 || render_end <= render_start { return Err("预览区间超出工程时长。".into()); }
    let render_duration = render_end - render_start;
    let background = safe_color(project["background"].as_str().unwrap_or("#101114"));
    let mut args = Vec::new();
    arg(
        &mut args,
        &[
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={background}:s={width}x{height}:r={fps}:d={render_duration}{}", if frame_time.is_some() { ",format=rgba" } else { "" }),
        ],
    );
    // A still starts at the exact requested timestamp, not the nearest output frame.
    let mut filters = vec![if windowed { format!("[0:v]format=rgba,settb=AVTB,setpts=PTS+{render_start}/TB[base0]") } else { "[0:v]format=rgba[base0]".to_string() }];
    let mut visuals = 0;
    let mut input_count = 0;
    let mut audio_labels = Vec::new();
    // Probe once per source within this plan. New jobs inspect the files again,
    // without retaining stale stream metadata when a file changes.
    let mut audio_streams = HashMap::<PathBuf, bool>::new();
    for (track, clip, start, _trim_in, trim_out, _speed, duration) in &clips {
        let text = track["kind"] == "text";
        if let Some(time) = frame_time {
            if track["kind"] == "audio" || time < *start || time >= start+duration { continue; }
        } else if windowed && (*start >= render_end || start+duration <= render_start) { continue; }
        let active_from = (render_start-start).max(0.0);
        let active_to = (render_end-start).min(*duration);
        let local_from = if windowed { (active_from-0.25).max(0.0) } else { 0.0 };
        let local_to = if windowed { (active_to+0.25).min(*duration) } else { *duration };
        if audio_only && text { continue; }
        if text && clip["overlay"]["kind"] == "blur" {
            crate::clip_animation::append_blur_overlay(clip, &mut filters, visuals, width, height, project_w, project_h, *duration)?;
            visuals += 1;
            continue;
        }
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
        if audio_only && asset["kind"] == "image" { continue; }
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
                if let Some(freeze) = clip.get("freezeFrame") {
                    let time = number(freeze, "sourceTime", 0.0, 0.0, source_duration)?;
                    if time >= source_duration { return Err("定格位置必须位于素材时长内。".into()); }
                } else if *trim_out > source_duration + 0.001 {
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
        // Static text is already rasterized. Decode its PNG once and let the
        // compositor retain that frame; looping every subtitle creates many
        // concurrent decoders and repeats identical scaling work.
        let single_frame_text = text
            && number(clip, "fadeIn", 0.0, 0.0, *duration)? == 0.0
            && number(clip, "fadeOut", 0.0, 0.0, *duration)? == 0.0
            && !crate::clip_animation::transformed(clip)
            && !crate::clip_animation::has_keyframe(clip, "opacity");
        if loop_audio || (image && asset["mime"] == "image/gif") {
            arg(
                &mut args,
                &["-stream_loop", "-1", "-t", &trim_out.to_string()],
            );
        } else if image && !single_frame_text {
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
        // Full exports need the same source seeking as range previews. Each
        // late timeline slice otherwise decodes the entire preceding source
        // before framesync can produce even the first composition frame.
        // Pitch-preserving speed ramps need surrounding audio samples for
        // their tempo windows and crossfades, including at high source speeds.
        let source_padding = if !image && !loop_audio && clip.get("speedRamp").is_some()
            && clip["speedRamp"]["preservePitch"] != false {
            crate::clip_animation::speed_segments(clip)?.iter()
                .map(|segment| segment.speed * 0.3).fold(0.25_f64, f64::max)
        } else { 0.25 };
        let input_seek = if !image && !loop_audio {
            // Whole-second seeking avoids different rounding of fractional
            // timestamps in demuxer and filter time bases. Exact trimming is
            // still done below, so no boundary frame or audio sample is lost.
            (crate::clip_animation::source_time(clip,local_from)? - source_padding).max(0.0).floor()
        } else { 0.0 };
        if input_seek > 0.0 { arg(&mut args, &["-ss",&input_seek.to_string()]); }
        if !image && !loop_audio && clip.get("freezeFrame").is_none() {
            let source_to = crate::clip_animation::source_time(clip,local_to)?;
            arg(&mut args, &["-t", &(source_to-input_seek+source_padding+0.5).max(0.5).to_string()]);
        }
        // Codec options apply to the next input, not every input in the job.
        // Bound each decoder instead of spawning a CPU-sized pool per clip.
        arg(&mut args, &["-threads", if image { "1" } else { "2" }]);
        arg(&mut args, &["-i", &path.to_string_lossy()]);
        input_count += 1;
        let index = input_count;
        if !audio_only && track["kind"] != "audio" && asset["kind"] != "audio" {
            let cw = (number(clip, "width", project_w, 1.0, 30000.0)? / project_w * width as f64)
                .round()
                .max(if frame_time.is_some() { 1.0 } else { 2.0 }) as u32;
            let ch = (number(clip, "height", project_h, 1.0, 30000.0)? / project_h * height as f64)
                .round()
                .max(if frame_time.is_some() { 1.0 } else { 2.0 }) as u32;
            let local_clock = frame_time.map_or_else(|| format!("t-{start}"), |time| (time-start).to_string());
            let x = crate::clip_animation::expression(clip,"x",number(clip, "x", 0.0, -30000.0, 30000.0)?,&local_clock)?;
            let y = crate::clip_animation::expression(clip,"y",number(clip, "y", 0.0, -30000.0, 30000.0)?,&local_clock)?;
            let x = format!("({x})/{project_w}*{width}");
            let y = format!("({y})/{project_h}*{height}");
            let rotation =
                number(clip, "rotation", 0.0, -3600.0, 3600.0)? * std::f64::consts::PI / 180.0;
            let (fade_in, fade_out, fade_peak) = fade_parameters(clip, *duration)?;
            let animation = crate::clip_animation::visual_filter_at(clip,cw,ch,fps,frame_time)?;
            let mut opacity = if animation.is_empty() { number(clip, "opacity", 1.0, 0.0, 1.0)? * fade_peak } else { fade_peak };
            if let Some(time) = frame_time {
                if fade_in > 0.0 { opacity *= ((time-start)/fade_in).clamp(0.0,1.0); }
                if fade_out > 0.0 { opacity *= ((start+duration-time)/fade_out).clamp(0.0,1.0); }
            }
            let fit = clip["fit"].as_str().unwrap_or("contain");
            let scale=match fit{"cover"=>format!("scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch}:exact=1,format=rgba"),"fill"=>format!("scale={cw}:{ch},format=rgba"),_=>format!("scale={cw}:{ch}:force_original_aspect_ratio=decrease,format=rgba,pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color=0x00000000")};
            let timing=if single_frame_text {
                // A trimmed text clip still displays the same raster. Its
                // single source frame must not be discarded by trimIn.
                "settb=AVTB,setpts=PTS-STARTPTS".to_string()
            } else if windowed && image && asset["mime"] != "image/gif" {
                format!("trim=duration={},settb=AVTB,setpts=PTS-STARTPTS+{local_from}/TB",local_to-local_from)
            } else if windowed { crate::clip_animation::video_timing_window(clip,local_from,local_to,input_seek)? } else {
                let timing = crate::clip_animation::video_timing(clip)?;
                // Restore the source clock before applying the existing trim
                // and speed mapping, preserving fractional split boundaries.
                // Input seeking rounds to source ticks, including AVI clocks
                // such as 1001/30000 where one second is not an integral tick.
                if input_seek > 0.0 { format!("setpts=PTS+round({input_seek}/TB),{timing}") } else { timing }
            };
            let mut chain=format!("[{index}:v]{timing}");
            chain += &crate::clip_animation::crop_filter(clip)?;
            if let Some(filter) = &chroma_key {
                chain += ",format=rgba";
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
            chain = transitions.append_graph(clip,fps,chain,&mut filters,index,frame_time,width as f64/project_w,cw,ch);
            chain += &format!(",colorchannelmixer=aa={opacity}");
            if fade_in > 0.0 && frame_time.is_none() {
                chain += &format!(",fade=t=in:st=0:d={fade_in}:alpha=1");
            }
            if fade_out > 0.0 && frame_time.is_none() {
                chain += &format!(
                    ",fade=t=out:st={}:d={fade_out}:alpha=1",
                    duration - fade_out
                );
            }
            chain += &animation;
            if rotation != 0.0 && !crate::clip_animation::transformed(clip) {
                chain +=
                    &format!(",rotate={rotation}:ow=rotw({rotation}):oh=roth({rotation}):c=none");
            }
            chain += &format!(",setpts=PTS+{start}/TB[v{index}]");
            filters.push(chain);
            // A trimmed stream can reach EOF between output frame timestamps.
            // Its final decoded frame remains valid until the clip's exclusive
            // endpoint; passing the background here would insert a black frame.
            // Evaluate visibility on the composition clock. Generic enable can
            // be reevaluated on a secondary frame and leak it past a cut.
            // An offscreen coordinate skips blending outside the clip interval.
            filters.push(format!("[base{visuals}][v{index}]overlay=x='if(gte(t,{start})*lt(t,{}),{x}+({cw}-overlay_w)/2,NAN)':y='{y}+({ch}-overlay_h)/2':eof_action=repeat:repeatlast=1:format=auto[base{}]",start+duration,visuals+1));
            visuals += 1;
        }
        let volume = number(clip, "volume", 1.0, 0.0, 4.0)?;
        if frame_time.is_none() && !image && clip.get("freezeFrame").is_none() && (volume > 0.0 || crate::clip_animation::has_keyframe(clip,"volume")) && track["muted"] != true && *audio_streams.entry(path.clone()).or_insert_with(|| store.has_audio(runtime, &path)) {
            let (fade_in, fade_out, fade_peak) = fade_parameters(clip, *duration)?;
            let clock = if windowed { format!("t+{local_from}") } else { "t".to_string() };
            let volume = crate::clip_animation::expression(clip,"volume",volume,&clock)?;
            let timing=if windowed {
                let trimmed=crate::clip_animation::window_clip(clip,local_from,local_to)?;
                crate::clip_animation::audio_timing_seek(&trimmed,index,&mut filters,input_seek)?
            } else { crate::clip_animation::audio_timing_seek(clip,index,&mut filters,input_seek)? };
            let audio_duration=if windowed { local_to-local_from } else { *duration };
            let mut gain=format!("({volume})*{fade_peak}");
            if windowed {
                if fade_in>0.0 { gain += &format!("*clip(({clock})/{fade_in},0,1)"); }
                if fade_out>0.0 { gain += &format!("*clip(({duration}-({clock}))/{fade_out},0,1)"); }
            }
            let mut chain=format!("{timing},apad=whole_dur={audio_duration},atrim=duration={audio_duration},volume='{gain}':eval=frame");
            if !windowed && fade_in > 0.0 { chain += &format!(",afade=t=in:st=0:d={fade_in}"); }
            if !windowed && fade_out > 0.0 { chain += &format!(",afade=t=out:st={}:d={fade_out}", duration-fade_out); }
            let delay=if windowed {
                chain += &format!(",atrim=start={}:duration={},asetpts=PTS-STARTPTS",active_from-local_from,active_to-active_from);
                (start+active_from-render_start).max(0.0)
            } else { *start };
            chain += &format!(",adelay={}|{}[a{index}]",(delay*1000.0).round(),(delay*1000.0).round());
            filters.push(chain);
            audio_labels.push(format!("[a{index}]"));
        }
    }
    if audio_only && audio_labels.is_empty() {
        filters.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={render_duration}[audio_silence]"));
        audio_labels.push("[audio_silence]".to_string());
    }
    if frame_time.is_some() {
        filters.push(format!("[base{visuals}]setpts=PTS-STARTPTS,format=rgba[video]"));
    } else if format == "gif" {
        filters.push(format!("[base{visuals}]setpts=PTS-{render_start}/TB,fps={fps},split[pa][pb];[pa]palettegen[p];[pb][p]paletteuse=dither=sierra2_4a[video]"));
    } else {
        filters.push(format!("[base{visuals}]setpts=PTS-{render_start}/TB,format=yuv420p[video]"));
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
    arg(&mut args, &["-t", &render_duration.to_string()]);
    Ok(RenderPlan {
        args,
        duration: render_duration,
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
