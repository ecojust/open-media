//! Bounded, cancellable media transfer and inspection for local editor requests.
use crate::engine::{self, Asset, MediaStore, Result, Runtime};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "asset_tools_analysis.rs"]
pub mod analysis;
#[path = "asset_tools_export.rs"]
mod export_check;

const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_RESERVED: u64 = 2 * MAX_FILE;
const MAX_UPLOADS: usize = 8;
const MAX_CHUNK: usize = 512 * 1024;
const UPLOAD_TTL: Duration = Duration::from_secs(30 * 60);
const TASK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const MEDIA_FORMATS: &str = "mov,matroska,webm,avi,mpeg,mpegts,mp3,wav,aac,flac,ogg,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,ico";
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg", "mp3", "wav", "aac", "m4a", "flac",
    "ogg", "opus", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif", "heic",
    "ico",
];

pub struct TaskControl {
    pub cancelled: Arc<AtomicBool>,
    deadline: Instant,
}
impl TaskControl {
    pub fn new(timeout: Duration) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + timeout,
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("素材任务已取消。".into());
        }
        if Instant::now() >= self.deadline {
            return Err("素材任务超时。".into());
        }
        Ok(())
    }
}
#[derive(Debug)]
pub struct ProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
}
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spool child pipes to bounded temporary files to avoid pipe deadlocks and
/// retaining unbounded decoder logs. Cancellation kills and reaps the process.
pub fn run_process(
    mut command: Command,
    control: &TaskControl,
    output_limit: usize,
) -> Result<ProcessOutput> {
    control.check()?;
    let mut out = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut err = tempfile::tempfile().map_err(|e| e.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(out.try_clone().map_err(|e| e.to_string())?)
        .stderr(err.try_clone().map_err(|e| e.to_string())?);
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|e| format!("无法开始素材处理：{e}"))?,
    );
    let status = loop {
        control.check()?;
        if out.metadata().map_err(|e| e.to_string())?.len() > output_limit as u64
            || err.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024
        {
            return Err("素材分析结果超过限制，请缩短分析范围或降低图像尺寸。".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        thread::sleep(Duration::from_millis(20));
    };
    out.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    err.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut stdout = Vec::new();
    out.take(output_limit as u64 + 1)
        .read_to_end(&mut stdout)
        .map_err(|e| e.to_string())?;
    let mut stderr = String::new();
    err.take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut stderr)
        .map_err(|e| e.to_string())?;
    if stdout.len() > output_limit || stderr.len() > 8 * 1024 * 1024 {
        return Err("素材分析结果超过限制。".into());
    }
    if !status.success() {
        return Err(format!(
            "素材处理失败：{}",
            stderr
                .chars()
                .rev()
                .take(2500)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
                .trim()
        ));
    }
    control.check()?;
    Ok(ProcessOutput { stdout, stderr })
}
pub fn encode_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn checked_hash(value: &str) -> Result<String> {
    if value.len() != 64 || !value.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err("请提供 64 位十六进制 SHA-256。".into());
    }
    Ok(value.to_ascii_lowercase())
}
fn checked_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 240
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || matches!(name, "." | "..")
    {
        return Err("请提供不含路径的有效媒体文件名。".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !MEDIA_EXTENSIONS.contains(&extension.as_str()) {
        return Err("不支持该媒体文件扩展名。".into());
    }
    Ok(name.into())
}
fn field<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args[name]
        .as_str()
        .ok_or_else(|| format!("缺少参数：{name}"))
}
fn number(args: &Value, name: &str, default: f64) -> Result<f64> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| format!("参数 {name} 必须为有限数字。")),
    }
}
fn integer(args: &Value, name: &str, default: u64) -> Result<u64> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_u64()
            .ok_or_else(|| format!("参数 {name} 必须为非负整数。")),
    }
}

struct Upload {
    _quota: QuotaGuard,
    file: tempfile::NamedTempFile,
    name: String,
    size: u64,
    expected: String,
    received: u64,
    digest: Sha256,
    touched: Instant,
}
struct Inner {
    directory: tempfile::TempDir,
    uploads: Mutex<HashMap<String, Upload>>,
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cancelled: Mutex<HashMap<String, Instant>>,
    reserved_bytes: Arc<AtomicU64>,
    stopped: AtomicBool,
}
struct QuotaGuard {
    bytes: u64,
    counter: Arc<AtomicU64>,
}
impl Drop for QuotaGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
#[derive(Clone)]
pub struct AssetTools(Arc<Inner>);
struct TaskGuard {
    inner: Arc<Inner>,
    id: String,
}
impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.inner.tasks.lock().unwrap().remove(&self.id);
    }
}

impl AssetTools {
    pub fn new(app_data: &Path) -> Result<Self> {
        let root = app_data.join("asset-transfers");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&root)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("素材临时目录不能是符号链接。".into());
        }
        // Each application instance owns its directory. Only expired abandoned
        // directories are removed; active transfers have a 30-minute lifetime.
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let old = entry
                .metadata()
                .ok()
                .and_then(|v| v.modified().ok())
                .and_then(|v| v.elapsed().ok())
                .is_some_and(|v| v > Duration::from_secs(24 * 3600));
            if old
                && entry.file_name().to_string_lossy().starts_with("transfer-")
                && entry
                    .file_type()
                    .is_ok_and(|v| v.is_dir() && !v.is_symlink())
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        let directory = tempfile::Builder::new()
            .prefix("transfer-")
            .tempdir_in(root)
            .map_err(|e| e.to_string())?;
        Ok(Self(Arc::new(Inner {
            directory,
            uploads: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            reserved_bytes: Arc::new(AtomicU64::new(0)),
            stopped: AtomicBool::new(false),
        })))
    }
    pub fn cancel(&self, task_id: &str) -> Result<bool> {
        valid_task_id(task_id)?;
        let tasks = self.0.tasks.lock().unwrap();
        if let Some(cancelled) = tasks.get(task_id) {
            cancelled.store(true, Ordering::Release);
            return Ok(true);
        }
        let mut tombstones = self.0.cancelled.lock().unwrap();
        tombstones.retain(|_, created| created.elapsed() < TASK_TIMEOUT);
        if tombstones.len() >= 512 {
            return Err("取消请求过多，请稍后重试。".into());
        }
        tombstones.insert(task_id.into(), Instant::now());
        Ok(false)
    }
    pub fn shutdown(&self) {
        self.0.stopped.store(true, Ordering::Release);
        for cancelled in self.0.tasks.lock().unwrap().values() {
            cancelled.store(true, Ordering::Release);
        }
        self.0.uploads.lock().unwrap().clear();
    }
    fn begin_task(&self, id: &str) -> Result<(TaskControl, TaskGuard)> {
        valid_task_id(id)?;
        let mut tasks = self.0.tasks.lock().unwrap();
        if self.0.stopped.load(Ordering::Acquire) {
            return Err("应用正在关闭，素材任务已停止。".into());
        }
        if tasks.contains_key(id) {
            return Err("素材任务 ID 已在使用。".into());
        }
        if tasks.len() >= 8 {
            return Err("同时运行的素材任务过多。".into());
        }
        let mut cancelled = self.0.cancelled.lock().unwrap();
        cancelled.retain(|_, created| created.elapsed() < TASK_TIMEOUT);
        if cancelled.remove(id).is_some() {
            return Err("素材任务已取消。".into());
        }
        let control = TaskControl::new(TASK_TIMEOUT);
        tasks.insert(id.into(), control.cancelled.clone());
        Ok((
            control,
            TaskGuard {
                inner: self.0.clone(),
                id: id.into(),
            },
        ))
    }
    fn uploads(&self) -> std::sync::MutexGuard<'_, HashMap<String, Upload>> {
        let mut uploads = self.0.uploads.lock().unwrap();
        uploads.retain(|_, upload| upload.touched.elapsed() < UPLOAD_TTL);
        uploads
    }
    fn reserve(&self, bytes: u64) -> Result<QuotaGuard> {
        let mut current = self.0.reserved_bytes.load(Ordering::Acquire);
        loop {
            let next = current
                .checked_add(bytes)
                .filter(|next| *next <= MAX_RESERVED)
                .ok_or("临时素材总配额已满，请完成或取消现有传输。")?;
            match self.0.reserved_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(updated) => current = updated,
            }
        }
        Ok(QuotaGuard {
            bytes,
            counter: self.0.reserved_bytes.clone(),
        })
    }
    pub fn upload_begin(&self, name: &str, size: u64, sha256: &str) -> Result<Value> {
        let name = checked_name(name)?;
        let expected = checked_hash(sha256)?;
        if size == 0 || size > MAX_FILE {
            return Err("上传媒体大小须为 1 字节至 1 GB。".into());
        }
        let mut uploads = self.uploads();
        if uploads.len() >= MAX_UPLOADS
            || uploads.values().map(|u| u.size).sum::<u64>() + size > MAX_RESERVED
        {
            return Err("上传配额已满，请完成或取消现有上传。".into());
        }
        let quota = self.reserve(size)?;
        let id = engine::new_id();
        let file =
            tempfile::NamedTempFile::new_in(self.0.directory.path()).map_err(|e| e.to_string())?;
        uploads.insert(
            id.clone(),
            Upload {
                _quota: quota,
                file,
                name,
                size,
                expected,
                received: 0,
                digest: Sha256::new(),
                touched: Instant::now(),
            },
        );
        Ok(
            json!({"uploadId":id,"receivedBytes":0,"totalBytes":size,"maxChunkBytes":MAX_CHUNK,"expiresInSeconds":UPLOAD_TTL.as_secs()}),
        )
    }
    pub fn upload_status(&self, id: &str) -> Result<Value> {
        let mut uploads = self.uploads();
        let upload = uploads.get_mut(id).ok_or("上传不存在或已经过期。")?;
        upload.touched = Instant::now();
        Ok(
            json!({"uploadId":id,"name":upload.name,"receivedBytes":upload.received,"totalBytes":upload.size,"sha256":upload.expected,"ready":upload.received == upload.size,"maxChunkBytes":MAX_CHUNK,"expiresInSeconds":UPLOAD_TTL.as_secs()}),
        )
    }
    pub fn upload_chunk(
        &self,
        id: &str,
        offset: u64,
        encoded: &str,
        chunk_sha256: &str,
    ) -> Result<Value> {
        if encoded.len() > MAX_CHUNK.div_ceil(3) * 4 {
            return Err("单次上传分块不能超过 512 KB。".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "上传分块不是有效的 Base64。")?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK {
            return Err("上传分块为空或过大。".into());
        }
        if hash(&bytes) != checked_hash(chunk_sha256)? {
            return Err("上传分块 SHA-256 校验失败。".into());
        }
        let mut uploads = self.uploads();
        let upload = uploads.get_mut(id).ok_or("上传不存在或已经过期。")?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or("上传偏移量无效。")?;
        if offset > upload.received || end > upload.size {
            return Err("上传偏移或大小与已接收内容不一致。".into());
        }
        let replay = offset < upload.received;
        if replay {
            if end > upload.received {
                return Err("重复分块不能覆盖未接收的范围。".into());
            }
            upload
                .file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut existing = vec![0; bytes.len()];
            upload
                .file
                .read_exact(&mut existing)
                .map_err(|e| e.to_string())?;
            if existing != bytes {
                return Err("重复上传内容与已接收内容不一致。".into());
            }
        } else {
            upload
                .file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            if let Err(error) = upload.file.write_all(&bytes) {
                let _ = upload.file.as_file().set_len(offset);
                return Err(format!("写入上传分块失败：{error}"));
            }
            upload.digest.update(&bytes);
            upload.received = end;
        }
        upload.touched = Instant::now();
        Ok(
            json!({"uploadId":id,"receivedBytes":upload.received,"totalBytes":upload.size,"ready":upload.received == upload.size,"replayed":replay}),
        )
    }
    pub fn upload_abort(&self, id: &str) -> bool {
        self.uploads().remove(id).is_some()
    }
    fn upload_commit(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        id: &str,
        control: &TaskControl,
    ) -> Result<Value> {
        control.check()?;
        let upload = {
            let mut uploads = self.uploads();
            let upload = uploads.get(id).ok_or("上传不存在或已经过期。")?;
            if upload.received != upload.size {
                return Err("文件尚未上传完整。".into());
            }
            if format!("{:x}", upload.digest.clone().finalize()) != upload.expected {
                uploads.remove(id);
                return Err("完整文件 SHA-256 校验失败，已清理上传。".into());
            }
            uploads.remove(id).unwrap()
        };
        let source = json!({"kind":"upload","name":upload.name,"sha256":upload.expected,"importedAt":now_ms()});
        import_verified(
            store,
            runtime,
            upload.file.path(),
            &upload.name,
            source,
            control,
        )
    }
    /// Call from a blocking worker, never from the window event loop.
    pub fn execute(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        task_id: &str,
        operation: &str,
        args: &Value,
    ) -> Result<Value> {
        let (control, _guard) = self.begin_task(task_id)?;
        control.check()?;
        match operation {
            "validate_export" => export_check::validate_export(
                store,
                runtime,
                &args["asset"],
                number(args, "start", 0.)?,
                args.get("end")
                    .filter(|v| !v.is_null())
                    .map(|_| number(args, "end", 0.))
                    .transpose()?,
                number(args, "blackThreshold", 0.1)?,
                number(args, "blackMinDuration", 0.1)?,
                &control,
            ),
            "asset_upload_begin" => self.upload_begin(
                field(args, "name")?,
                integer(args, "size", 0)?,
                field(args, "sha256")?,
            ),
            "asset_upload_chunk" => self.upload_chunk(
                field(args, "uploadId")?,
                integer(args, "offset", u64::MAX)?,
                field(args, "base64")?,
                field(args, "sha256")?,
            ),
            "asset_upload_status" => self.upload_status(field(args, "uploadId")?),
            "asset_upload_abort" => {
                Ok(json!({"aborted":self.upload_abort(field(args,"uploadId")?)}))
            }
            "asset_upload_commit" => {
                self.upload_commit(store, runtime, field(args, "uploadId")?, &control)
            }
            "asset_import_url" => self.import_url(
                store,
                runtime,
                field(args, "url")?,
                args.get("name").and_then(Value::as_str),
                integer(args, "maxBytes", MAX_FILE)?,
                &control,
            ),
            "asset_probe" => {
                let mut value = analysis::probe(store, runtime, &args["asset"], &control)?;
                if let Some(source) = source_metadata(store, &args["asset"])? {
                    value["source"] = source;
                }
                Ok(value)
            }
            "asset_get_frame" => analysis::frame(
                store,
                runtime,
                &args["asset"],
                number(args, "time", 0.)?,
                bounded_u32(args, "maxWidth", 1280, 1920)?,
                &control,
            ),
            "asset_storyboard" => analysis::storyboard_with_options(
                store,
                runtime,
                &args["asset"],
                number(args, "start", 0.)?,
                args.get("end")
                    .filter(|v| !v.is_null())
                    .map(|_| number(args, "end", 0.))
                    .transpose()?,
                bounded_u32(args, "count", 8, 24)?,
                bounded_u32(args, "maxWidth", 480, 1920)?,
                args.get("mode").map_or(Some("time"), Value::as_str).ok_or("分镜模式无效。")?,
                number(args, "threshold", 0.3)?,
                &control,
            ),
            "asset_detect_scenes" => analysis::detect_scenes(
                store,
                runtime,
                &args["asset"],
                number(args, "threshold", 0.3)?,
                number(args, "minInterval", 0.5)?,
                &control,
            ),
            "asset_detect_idle" => analysis::detect_idle_with_options(
                store,
                runtime,
                &args["asset"],
                analysis::IdleOptions {
                    min_duration: number(args, "minDuration", 2.)?,
                    noise_db: number(args, "noiseDb", -45.)?,
                    freeze_noise_db: number(args, "freezeNoiseDb", -60.)?,
                    freeze_only: args
                        .get("freezeOnly")
                        .map_or(Some(false), Value::as_bool)
                        .ok_or("参数 freezeOnly 必须为布尔值。")?,
                    start: number(args, "start", 0.)?,
                    end: args
                        .get("end")
                        .filter(|v| !v.is_null())
                        .map(|_| number(args, "end", 0.))
                        .transpose()?,
                },
                &control,
            ),
            _ => Err("不支持的素材操作。".into()),
        }
    }
    fn import_url(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        raw: &str,
        name: Option<&str>,
        max_bytes: u64,
        control: &TaskControl,
    ) -> Result<Value> {
        self.import_url_resolved(
            store,
            runtime,
            raw,
            name,
            max_bytes,
            control,
            public_addresses,
        )
    }
    fn import_url_resolved(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        raw: &str,
        name: Option<&str>,
        max_bytes: u64,
        control: &TaskControl,
        resolve: impl Fn(&reqwest::Url, &TaskControl) -> Result<Vec<SocketAddr>>,
    ) -> Result<Value> {
        if max_bytes == 0 || max_bytes > MAX_FILE {
            return Err("下载大小限制须为 1 字节至 1 GB。".into());
        }
        let _quota = self.reserve(max_bytes)?;
        let original = checked_url(raw)?;
        let mut current = original.clone();
        let _ = rustls::crypto::ring::default_provider().install_default();
        for redirects in 0..=5 {
            control.check()?;
            let addresses = resolve(&current, control)?;
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(5))
                .resolve_to_addrs(current.host_str().ok_or("下载主机无效。")?, &addresses)
                .user_agent("Open-Media-Asset-Import")
                .build()
                .map_err(|e| e.without_url().to_string())?;
            let response = client
                .get(current.clone())
                .header("Accept-Encoding", "identity")
                .send()
                .map_err(|e| format!("素材下载失败：{}", e.without_url()))?;
            if response.status().is_redirection() {
                if redirects == 5 {
                    return Err("素材下载跳转次数过多。".into());
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("下载跳转缺少有效地址。")?;
                let next = checked_url(
                    current
                        .join(location)
                        .map_err(|_| "下载跳转地址无效。")?
                        .as_str(),
                )?;
                if current.scheme() == "https" && next.scheme() != "https" {
                    return Err("不允许下载地址降级到非加密连接。".into());
                }
                current = next;
                continue;
            }
            if !response.status().is_success() {
                return Err(format!(
                    "素材下载失败，HTTP {}。",
                    response.status().as_u16()
                ));
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !valid_mime(&mime) {
                return Err("下载结果不是受支持的图片、音频或视频。".into());
            }
            if response
                .content_length()
                .is_some_and(|length| length == 0 || length > max_bytes)
            {
                return Err("下载文件为空或超过大小限制。".into());
            }
            let fallback = url_filename(&current, &mime);
            let name = checked_name(name.unwrap_or(&fallback))?;
            let mut temporary = tempfile::NamedTempFile::new_in(self.0.directory.path())
                .map_err(|e| e.to_string())?;
            let (size, digest) =
                receive_download(response, temporary.as_file_mut(), max_bytes, control)?;
            let source = json!({"kind":"url","url":original.as_str(),"finalUrl":current.as_str(),"mimeType":mime,"sha256":digest,"size":size,"importedAt":now_ms()});
            let imported =
                import_verified(store, runtime, temporary.path(), &name, source, control)?;
            let kind = imported["asset"]["kind"].as_str().unwrap_or("");
            if mime != "application/octet-stream" && !mime.starts_with(&format!("{kind}/")) {
                remove_imported(store, &imported["asset"]);
                return Err("下载文件的媒体类型与服务器声明不一致。".into());
            }
            return Ok(imported);
        }
        Err("素材下载跳转次数过多。".into())
    }
}

fn valid_task_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'_'))
    {
        return Err("素材任务 ID 无效。".into());
    }
    Ok(())
}
fn bounded_u32(args: &Value, key: &str, default: u64, maximum: u64) -> Result<u32> {
    let value = integer(args, key, default)?;
    if value == 0 || value > maximum {
        return Err(format!("参数 {key} 必须为 1 至 {maximum}。"));
    }
    Ok(value as u32)
}
fn valid_mime(mime: &str) -> bool {
    mime == "application/octet-stream"
        || ((mime.starts_with("image/")
            || mime.starts_with("audio/")
            || mime.starts_with("video/"))
            && mime != "image/svg+xml")
}
fn url_filename(url: &reqwest::Url, mime: &str) -> String {
    let candidate = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or("");
    if checked_name(candidate).is_ok() {
        return candidate.into();
    }
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/avif" => "avif",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        "audio/aac" => "aac",
        "audio/mp4" => "m4a",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/mp4" => "mp4",
        _ => "media",
    };
    format!("下载素材.{ext}")
}
fn checked_url(raw: &str) -> Result<reqwest::Url> {
    if raw.len() > 8192 {
        return Err("下载地址过长。".into());
    }
    let mut url = reqwest::Url::parse(raw).map_err(|_| "下载地址无效。")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("请提供不含账号密码的 HTTP 或 HTTPS 素材地址。".into());
    }
    url.set_fragment(None);
    Ok(url)
}
fn is_public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || a == 0
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 198 && matches!(b, 18 | 19)
                || a == 192 && b == 0 && c == 0)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return is_public_address(IpAddr::V4(ip));
            }
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] < 0x200))
                && s[0] != 0x2002
        }
    }
}
fn public_addresses(url: &reqwest::Url, control: &TaskControl) -> Result<Vec<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or("下载主机无效。")?
        .trim_matches(['[', ']'])
        .to_owned();
    let port = url.port_or_known_default().ok_or("下载端口无效。")?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_address(ip) {
            return Err("不能从本机、局域网或保留网络地址导入素材。".into());
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (host.as_str(), port)
            .to_socket_addrs()
            .map(|v| v.collect::<Vec<_>>());
        let _ = sender.send(result);
    });
    let began = Instant::now();
    loop {
        control.check()?;
        if began.elapsed() > Duration::from_secs(5) {
            return Err("解析下载主机超时。".into());
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(addresses)) => {
                if addresses.is_empty()
                    || addresses
                        .iter()
                        .any(|address| !is_public_address(address.ip()))
                {
                    return Err("下载主机解析到了本机、局域网或保留网络地址。".into());
                }
                return Ok(addresses);
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("无法解析素材下载主机。".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
        }
    }
}
fn receive_download(
    mut response: impl Read,
    file: &mut File,
    maximum: u64,
    control: &TaskControl,
) -> Result<(u64, String)> {
    let mut bytes = [0; 64 * 1024];
    let mut received = 0;
    let mut digest = Sha256::new();
    loop {
        control.check()?;
        let count = response
            .read(&mut bytes)
            .map_err(|e| format!("读取下载内容失败：{e}"))?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > maximum {
            return Err("下载内容超过大小限制。".into());
        }
        file.write_all(&bytes[..count]).map_err(|e| e.to_string())?;
        digest.update(&bytes[..count]);
    }
    if received == 0 {
        return Err("下载内容为空。".into());
    }
    control.check()?;
    Ok((received, format!("{:x}", digest.finalize())))
}

fn remove_imported(store: &MediaStore, asset: &Value) {
    if let Ok(path) = store.authorized_path(asset) {
        let _ = fs::remove_file(&path);
        if let Some(name) = path.file_name() {
            let _ = fs::remove_file(
                store
                    .root
                    .join(".asset-origins")
                    .join(name)
                    .with_extension("json"),
            );
        }
    }
}
fn import_verified(
    store: &MediaStore,
    runtime: &Runtime,
    input: &Path,
    name: &str,
    source: Value,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let name = checked_name(name)?;
    // Restrict external uploads to self-contained media demuxers; playlists
    // must not turn decoding into arbitrary local-file or network reads.
    let metadata = analysis::probe_file(runtime, input, &name, control)?;
    let extension = Path::new(&name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = metadata["kind"].as_str().ok_or("媒体类型无效。")?;
    let duration = metadata["duration"]
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(0.);
    if kind != "image" && duration <= 0. {
        return Err("无法确认上传媒体时长，请先转换为完整媒体文件。".into());
    }
    validate_container(&extension, &metadata)?;
    let width = metadata["width"]
        .as_u64()
        .filter(|v| *v <= u32::MAX as u64)
        .ok_or("媒体宽度无效。")? as u32;
    let height = metadata["height"]
        .as_u64()
        .filter(|v| *v <= u32::MAX as u64)
        .ok_or("媒体高度无效。")? as u32;
    if width > 32768 || height > 32768 || u64::from(width) * u64::from(height) > 128 * 1024 * 1024 {
        return Err("媒体画面尺寸超过处理上限。".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&store.root).map_err(|e| e.to_string())?;
    // Verify the store using an existing candidate before writing destination data.
    store.authorized_path(&json!({"nativePath":temporary.path()}))?;
    let mut source_file = File::open(input).map_err(|e| e.to_string())?;
    let (size, _) = receive_download(&mut source_file, temporary.as_file_mut(), MAX_FILE, control)?;
    let destination = store
        .root
        .join(format!("{}.{}", engine::new_id(), extension));
    temporary
        .persist_noclobber(&destination)
        .map_err(|e| e.error.to_string())?;
    let mime = metadata["mime"]
        .as_str()
        .unwrap_or("application/octet-stream");
    let asset = Asset {
        id: engine::new_id(),
        name,
        kind: kind.into(),
        url: String::new(),
        duration,
        width,
        height,
        size,
        mime: mime.into(),
        native_path: destination.to_string_lossy().into(),
    };
    let asset_value = serde_json::to_value(&asset).map_err(|e| e.to_string())?;
    let result = (|| -> Result<Value> {
        control.check()?;
        let folder = store.root.join(".asset-origins");
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&folder)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("素材来源目录不能是符号链接。".into());
        }
        let mut record = tempfile::NamedTempFile::new_in(&folder).map_err(|e| e.to_string())?;
        serde_json::to_writer(record.as_file_mut(), &source).map_err(|e| e.to_string())?;
        record
            .persist(
                folder
                    .join(destination.file_name().unwrap())
                    .with_extension("json"),
            )
            .map_err(|e| e.error.to_string())?;
        crate::media_metadata::remember_name(store, &asset)?;
        Ok(json!({"asset":asset_value,"source":source}))
    })();
    if result.is_err() {
        remove_imported(store, &asset_value);
    }
    result
}

fn validate_container(extension: &str, metadata: &Value) -> Result<()> {
    let format = metadata["format"].as_str().unwrap_or("");
    let stream = metadata["streams"].as_array().and_then(|streams| {
        streams
            .iter()
            .find(|stream| stream["type"] == "video" && stream["attachedPicture"] != true)
    });
    let codec = stream.and_then(|s| s["codec"].as_str()).unwrap_or("");
    let image_codec = match extension {
        "png" => Some(&["png"][..]),
        "jpg" | "jpeg" => Some(&["mjpeg"][..]),
        "webp" => Some(&["webp"][..]),
        "bmp" => Some(&["bmp"][..]),
        "tif" | "tiff" => Some(&["tiff"][..]),
        "gif" => Some(&["gif"][..]),
        "ico" => Some(&["bmp", "png"][..]),
        "avif" => Some(&["av1"][..]),
        "heic" => Some(&["hevc"][..]),
        _ => None,
    };
    if image_codec.is_some_and(|allowed| !allowed.contains(&codec)) {
        return Err("图片编码与文件扩展名不一致。".into());
    }
    if image_codec.is_none()
        && (format.ends_with("_pipe") || matches!(format, "image2" | "gif" | "ico"))
    {
        return Err("图片内容与所给音视频文件名不一致。".into());
    }
    let audio_extension = ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"].contains(&extension);
    if audio_extension && metadata["hasVideo"] == true {
        return Err("视频内容与所给音频文件名不一致。".into());
    }
    Ok(())
}

pub fn source_metadata(store: &MediaStore, asset: &Value) -> Result<Option<Value>> {
    let path = store.authorized_path(asset)?;
    let folder = store.root.join(".asset-origins");
    if !folder.exists() {
        return Ok(None);
    }
    if fs::symlink_metadata(&folder)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("素材来源目录无效。".into());
    }
    let record = folder
        .join(path.file_name().ok_or("素材名称无效。")?)
        .with_extension("json");
    match fs::symlink_metadata(&record) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 65536 => {
            Err("素材来源记录无效。".into())
        }
        Ok(_) => serde_json::from_slice(&fs::read(record).map_err(|e| e.to_string())?)
            .map(Some)
            .map_err(|_| "素材来源记录无效。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
#[path = "asset_tools_tests.rs"]
mod tests;
