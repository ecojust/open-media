use crate::{
    engine::Result,
    speech::{Model, ModelKind, SpeechRuntime, SpeechVoice},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const CANCELLED: &str = "音色下载已取消。";
const BUFFER_BYTES: usize = 128 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    path: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    id: String,
    version: u32,
    model_size: u64,
    download_size: u64,
    files: Vec<ModelFile>,
    voices: Vec<SpeechVoice>,
    model: Model,
}

#[derive(Deserialize)]
struct Catalog {
    schema: u32,
    models: Vec<Package>,
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    NotDownloaded,
    Downloading,
    Verifying,
    Ready,
    Failed,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::NotDownloaded => "not-downloaded",
            Self::Downloading => "downloading",
            Self::Verifying => "verifying",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn working(self) -> bool {
        matches!(self, Self::Downloading | Self::Verifying)
    }
}

#[derive(Clone)]
struct FileStamp {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

struct Entry {
    state: State,
    downloaded: u64,
    error: Option<String>,
    cancelled: Arc<AtomicBool>,
    runtime: Option<SpeechRuntime>,
    stamps: Vec<FileStamp>,
    // A cancelled request may finish after a user has already retried.
    generation: u64,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            state: State::NotDownloaded,
            downloaded: 0,
            error: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            runtime: None,
            stamps: Vec::new(),
            generation: 0,
        }
    }
}

#[derive(Default)]
struct Downloads {
    entries: HashMap<String, Entry>,
    closing: bool,
    workers: usize,
}

struct Owner {
    downloads: Arc<Mutex<Downloads>>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        stop(&self.downloads);
    }
}

#[derive(Clone)]
pub(crate) struct SpeechModels {
    catalog: Arc<Vec<Package>>,
    root: PathBuf,
    bundled: Result<SpeechRuntime>,
    owner: Arc<Owner>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains([',', '\\', ':'])
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn allowed_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port().is_some_and(|port| port != 443) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(
        host,
        "huggingface.co"
            | "github.com"
            | "raw.githubusercontent.com"
            | "release-assets.githubusercontent.com"
    ) || host.ends_with(".huggingface.co")
        || host.ends_with(".hf.co")
        || host.ends_with(".xethub.hf.co")
}

fn load_catalog(text: &str) -> Result<Vec<Package>> {
    let catalog: Catalog = serde_json::from_str(text).map_err(|_| "可下载音色清单无效。")?;
    if catalog.schema != 1 || catalog.models.len() > 16 {
        return Err("可下载音色清单版本不受支持。".into());
    }
    let mut ids = HashSet::new();
    let mut voice_ids = HashSet::new();
    for package in &catalog.models {
        if !valid_id(&package.id)
            || !ids.insert(&package.id)
            || package.version == 0
            || package.files.is_empty()
            || package.files.len() > 64
            || package.voices.is_empty()
            || package.voices.len() > 128
        {
            return Err("可下载音色配置无效。".into());
        }
        let mut paths = HashSet::new();
        let mut total = 0_u64;
        for file in &package.files {
            let url = reqwest::Url::parse(&file.url).map_err(|_| "音色下载地址无效。")?;
            if !allowed_url(&url)
                || !safe_relative(&file.path)
                || !paths.insert(file.path.as_str())
                || file.size == 0
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("音色文件校验配置无效。".into());
            }
            total = total.checked_add(file.size).ok_or("音色资源大小无效。")?;
        }
        if total != package.model_size || total != package.download_size {
            return Err("音色资源大小与清单不一致。".into());
        }
        for voice in &package.voices {
            if !valid_id(&voice.id)
                || !voice_ids.insert(&voice.id)
                || voice.name.trim().is_empty()
                || voice.name.chars().count() > 80
                || voice.language.is_empty()
                || voice.language.len() > 32
                || voice.speaker_id > 1024
                || (package.model.kind == ModelKind::Matcha && voice.speaker_id != 0)
            {
                return Err("可下载音色列表无效。".into());
            }
        }
        let model = &package.model;
        if !matches!(model.sample_rate, 16000 | 22050 | 24000 | 44100 | 48000)
            || model.lexicons.len() > 16
            || model.rule_fsts.len() > 16
        {
            return Err("可下载音色模型配置无效。".into());
        }
        let mut required = vec![model.file.as_str(), model.tokens.as_str()];
        required.push(match model.kind {
            ModelKind::Matcha => &model.vocoder,
            ModelKind::Kokoro => &model.voices,
        });
        required.extend(model.lexicons.iter().map(String::as_str));
        required.extend(model.rule_fsts.iter().map(String::as_str));
        for path in required {
            if let Some(shared) = path.strip_prefix("@bundled/") {
                if !safe_relative(shared) {
                    return Err("共享音色资源路径无效。".into());
                }
            } else if !safe_relative(path) || !paths.contains(path) {
                return Err("音色模型缺少已校验的资源。".into());
            }
        }
        if !model.data_dir.is_empty() {
            if let Some(shared) = model.data_dir.strip_prefix("@bundled/") {
                if !safe_relative(shared) {
                    return Err("共享语音数据目录无效。".into());
                }
            } else if !safe_relative(&model.data_dir)
                || !paths
                    .iter()
                    .any(|path| path.starts_with(&format!("{}/", model.data_dir)))
            {
                return Err("语音数据目录缺少已校验的资源。".into());
            }
        }
    }
    Ok(catalog.models)
}

// This file remains in place across launches; removing it could create two lock inodes.
struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn try_store_lock(root: &Path) -> Result<Option<StoreLock>> {
    let path = root.join(".store.lock");
    if fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("音色下载锁文件无效，请检查应用数据目录。".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| format!("无法锁定音色下载目录：{error}"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(StoreLock(file))),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(format!("无法锁定音色下载目录：{error}")),
    }
}

fn wait_store_lock(root: &Path, cancelled: &AtomicBool) -> Result<StoreLock> {
    loop {
        check_cancelled(cancelled)?;
        if let Some(lock) = try_store_lock(root)? {
            check_cancelled(cancelled)?;
            return Ok(lock);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

fn package_path(root: &Path, package: &Package) -> PathBuf {
    root.join(format!("{}-v{}", package.id, package.version))
}

fn checked_path(root: &Path, relative: &str, directory: bool) -> Result<PathBuf> {
    if !safe_relative(relative) {
        return Err("音色资源路径无效。".into());
    }
    // Reject links instead of accepting a link that happens to resolve inside the package.
    let mut cursor = root.to_path_buf();
    for part in Path::new(relative).components() {
        cursor.push(part);
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|_| format!("音色资源缺失：{relative}。请重新下载。"))?;
        if metadata.file_type().is_symlink() {
            return Err("音色资源路径异常，请重新下载。".into());
        }
    }
    let path = cursor.canonicalize().map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || (directory && !path.is_dir()) || (!directory && !path.is_file()) {
        return Err("音色资源类型无效，请重新下载。".into());
    }
    Ok(path)
}

fn hash_file(path: &Path, file: &ModelFile, cancelled: &AtomicBool) -> Result<FileStamp> {
    check_cancelled(cancelled)?;
    let mut input = File::open(path).map_err(|e| format!("无法校验音色文件：{e}"))?;
    let before = input.metadata().map_err(|e| e.to_string())?;
    if before.len() != file.size {
        return Err(format!("音色文件大小不符：{}。请重新下载。", file.path));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        check_cancelled(cancelled)?;
        let count = input
            .read(&mut buffer)
            .map_err(|e| format!("无法读取音色文件：{e}"))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or("音色文件大小在校验期间发生变化。")?;
        if total > file.size {
            return Err("音色文件大小在校验期间发生变化。".into());
        }
        hasher.update(&buffer[..count]);
    }
    if total != file.size || format!("{:x}", hasher.finalize()) != file.sha256.to_lowercase() {
        return Err(format!("音色文件校验失败：{}。请重新下载。", file.path));
    }
    let after = input.metadata().map_err(|e| e.to_string())?;
    if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err("音色文件在校验期间发生变化，请重新下载。".into());
    }
    Ok(FileStamp {
        path: path.into(),
        size: after.len(),
        modified: after.modified().ok(),
    })
}

#[cfg(any(windows, test))]
fn windows_engine_path(value: &str) -> Result<String> {
    // The speech engine appends forward slashes to resource directories. Windows
    // extended paths do not accept that separator, while ordinary paths do.
    let value = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!("//{unc}")
    } else if let Some(drive) = value.strip_prefix(r"\\?\") {
        let bytes = drive.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
        {
            return Err("语音资源所在的 Windows 路径类型不受支持。".into());
        }
        drive.to_owned()
    } else {
        value.to_owned()
    };
    Ok(value.replace('\\', "/"))
}

fn engine_resource_path(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("语音资源路径无法转换为有效文本。")?;
    #[cfg(windows)]
    {
        let value = windows_engine_path(value)?;
        // Normalize only the external argument after boundary/link checks, and
        // confirm the engine will still open the exact resource we validated.
        let resolved = Path::new(&value)
            .canonicalize()
            .map_err(|_| "语音资源路径无法交给本地语音引擎，请检查应用安装路径。")?;
        if resolved != path {
            return Err("语音资源路径转换后不一致，已停止加载。".into());
        }
        Ok(value)
    }
    #[cfg(not(windows))]
    {
        Ok(value.to_owned())
    }
}

fn resolve_runtime(
    package: &Package,
    root: &Path,
    bundled: &SpeechRuntime,
) -> Result<SpeechRuntime> {
    let mut model = package.model.clone();
    let resolve = |value: &str, directory: bool| -> Result<String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        if let Some(shared) = value.strip_prefix("@bundled/") {
            let path = checked_path(&bundled.root, shared, directory)?;
            // Lists of lexicons and rules use commas as separators in the native engine.
            engine_resource_path(&path)
        } else {
            checked_path(root, value, directory)?;
            // Relative paths also work when the user's data directory contains commas.
            Ok(value.into())
        }
    };
    model.file = resolve(&model.file, false)?;
    model.vocoder = resolve(&model.vocoder, false)?;
    model.voices = resolve(&model.voices, false)?;
    model.tokens = resolve(&model.tokens, false)?;
    model.data_dir = resolve(&model.data_dir, true)?;
    model.lexicons = model
        .lexicons
        .iter()
        .map(|path| resolve(path, false))
        .collect::<Result<_>>()?;
    model.rule_fsts = model
        .rule_fsts
        .iter()
        .map(|path| resolve(path, false))
        .collect::<Result<_>>()?;
    if model
        .lexicons
        .iter()
        .chain(&model.rule_fsts)
        .any(|path| path.contains(','))
    {
        return Err("应用安装路径含有逗号，无法读取共享语音规则，请移至不含逗号的目录。".into());
    }
    Ok(SpeechRuntime {
        root: root.canonicalize().map_err(|e| e.to_string())?,
        executable: bundled.executable.clone(),
        model,
        voices: package.voices.clone(),
    })
}

fn verify_package(
    package: &Package,
    root: &Path,
    bundled: &SpeechRuntime,
    cancelled: &AtomicBool,
) -> Result<(SpeechRuntime, Vec<FileStamp>)> {
    let metadata = fs::symlink_metadata(root).map_err(|_| "音色模型不存在，请先下载。")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("音色模型目录无效，请重新下载。".into());
    }
    let mut stamps = Vec::with_capacity(package.files.len());
    for file in &package.files {
        let path = checked_path(root, &file.path, false)?;
        stamps.push(hash_file(&path, file, cancelled)?);
    }
    check_cancelled(cancelled)?;
    Ok((resolve_runtime(package, root, bundled)?, stamps))
}

fn stamps_unchanged(stamps: &[FileStamp]) -> bool {
    !stamps.is_empty()
        && stamps.iter().all(|stamp| {
            fs::symlink_metadata(&stamp.path).is_ok_and(|metadata| {
                metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() == stamp.size
                    && metadata.modified().ok() == stamp.modified
            })
        })
}

fn stop(downloads: &Mutex<Downloads>) {
    if let Ok(mut state) = downloads.lock() {
        state.closing = true;
        for entry in state.entries.values() {
            entry.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

fn update(downloads: &Mutex<Downloads>, id: &str, generation: u64, state: State, downloaded: u64) {
    if let Ok(mut downloads) = downloads.lock() {
        if let Some(entry) = downloads
            .entries
            .get_mut(id)
            .filter(|entry| entry.generation == generation)
        {
            if !entry.cancelled.load(Ordering::SeqCst) {
                entry.state = state;
                entry.downloaded = downloaded;
            }
        }
    }
}

fn finished(
    downloads: &Mutex<Downloads>,
    id: &str,
    generation: u64,
    result: Result<(SpeechRuntime, Vec<FileStamp>)>,
    total: u64,
) {
    if let Ok(mut downloads) = downloads.lock() {
        downloads.workers = downloads.workers.saturating_sub(1);
        if let Some(entry) = downloads
            .entries
            .get_mut(id)
            .filter(|entry| entry.generation == generation)
        {
            if entry.cancelled.load(Ordering::SeqCst) {
                entry.state = State::NotDownloaded;
                entry.downloaded = 0;
                entry.error = None;
                entry.runtime = None;
                entry.stamps.clear();
            } else {
                match result {
                    Ok((runtime, stamps)) => {
                        entry.state = State::Ready;
                        entry.downloaded = total;
                        entry.error = None;
                        entry.runtime = Some(runtime);
                        entry.stamps = stamps;
                    }
                    Err(error) => {
                        entry.state = State::Failed;
                        entry.error = Some(error);
                        entry.runtime = None;
                        entry.stamps.clear();
                    }
                }
            }
        }
    }
}

impl SpeechModels {
    pub fn new(app_data: &Path, bundled: Result<SpeechRuntime>) -> Result<Self> {
        let catalog = load_catalog(include_str!("../resources/speech-models.json"))?;
        let root = app_data.join("speech-models");
        fs::create_dir_all(&root).map_err(|e| format!("无法创建音色目录：{e}"))?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        // Only clean abandoned staging directories while no application instance is downloading.
        if let Some(_store_lock) = try_store_lock(&root)? {
            for item in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
                if item.file_name().to_string_lossy().starts_with(".download-") {
                    let _ = remove_package(&item.path());
                }
            }
        }
        let mut entries = HashMap::new();
        for package in &catalog {
            entries.insert(package.id.clone(), Entry::default());
        }
        let manager = Self {
            catalog: Arc::new(catalog),
            root,
            bundled,
            owner: Arc::new(Owner {
                downloads: Arc::new(Mutex::new(Downloads {
                    entries,
                    ..Downloads::default()
                })),
            }),
        };
        for package in manager.catalog.iter() {
            if package_path(&manager.root, package)
                .symlink_metadata()
                .is_ok()
            {
                manager.start_verification(package)?;
            }
        }
        Ok(manager)
    }

    fn package(&self, id: &str) -> Result<Package> {
        self.catalog
            .iter()
            .find(|package| package.id == id)
            .cloned()
            .ok_or_else(|| "此音色不在可下载列表中。".into())
    }

    fn start_verification(&self, package: &Package) -> Result<()> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let generation = {
            let mut downloads = self
                .owner
                .downloads
                .lock()
                .map_err(|_| "音色状态不可用。")?;
            let entry = downloads
                .entries
                .get_mut(&package.id)
                .ok_or("音色配置不存在。")?;
            entry.state = State::Verifying;
            entry.downloaded = package.download_size;
            entry.cancelled = cancelled.clone();
            entry.generation += 1;
            let generation = entry.generation;
            downloads.workers += 1;
            generation
        };
        let package = package.clone();
        let root = package_path(&self.root, &package);
        let bundled = self.bundled.clone();
        let downloads = self.owner.downloads.clone();
        let id = package.id.clone();
        let total = package.download_size;
        let spawned = thread::Builder::new()
            .name("voice-model-verify".into())
            .spawn(move || {
                let result = bundled
                    .and_then(|bundled| verify_package(&package, &root, &bundled, &cancelled));
                finished(&downloads, &package.id, generation, result, total);
            });
        if let Err(error) = spawned {
            finished(
                &self.owner.downloads,
                &id,
                generation,
                Err(format!("无法校验已下载音色：{error}")),
                total,
            );
        }
        Ok(())
    }

    pub fn voices(&self) -> Vec<SpeechVoice> {
        let Ok(mut downloads) = self.owner.downloads.lock() else {
            return Vec::new();
        };
        let mut voices = Vec::new();
        for package in self.catalog.iter() {
            let Some(entry) = downloads.entries.get_mut(&package.id) else {
                continue;
            };
            if entry.state == State::Ready && !stamps_unchanged(&entry.stamps) {
                entry.state = State::Failed;
                entry.error = Some("已下载的音色文件缺失或已更改，请重新下载。".into());
                entry.runtime = None;
            }
            for voice in &package.voices {
                let mut voice = voice.clone();
                voice.model_id = Some(package.id.clone());
                voice.model_size = Some(package.model_size);
                voice.download_size = Some(package.download_size);
                voice.status = Some(entry.state.name().into());
                voice.downloaded_bytes = Some(entry.downloaded);
                voice.error = entry.error.clone();
                voices.push(voice);
            }
        }
        voices
    }

    pub fn runtime_for_voice(&self, id: &str) -> Result<SpeechRuntime> {
        let package = self
            .catalog
            .iter()
            .find(|package| package.voices.iter().any(|voice| voice.id == id))
            .ok_or("所选音色不可用，请重新选择。")?;
        let mut downloads = self
            .owner
            .downloads
            .lock()
            .map_err(|_| "音色状态不可用。")?;
        let entry = downloads
            .entries
            .get_mut(&package.id)
            .ok_or("音色模型不存在。")?;
        if entry.state != State::Ready {
            return Err("请先下载所选音色，等待校验完成后再生成配音。".into());
        }
        if !stamps_unchanged(&entry.stamps) {
            entry.state = State::Failed;
            entry.runtime = None;
            entry.error = Some("已下载的音色文件缺失或已更改，请重新下载。".into());
            return Err(entry.error.clone().unwrap());
        }
        entry
            .runtime
            .clone()
            .ok_or_else(|| "音色模型未就绪，请重新下载。".into())
    }

    pub fn begin(&self, id: &str) -> Result<()> {
        let package = self.package(id)?;
        let bundled = self.bundled.clone()?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let generation = {
            let mut downloads = self
                .owner
                .downloads
                .lock()
                .map_err(|_| "音色状态不可用。")?;
            if downloads.closing {
                return Err("应用正在关闭，无法下载音色。".into());
            }
            if downloads.workers >= 4 {
                return Err("音色任务正在结束，请稍候再试。".into());
            }
            let entry = downloads.entries.get_mut(id).ok_or("音色模型不存在。")?;
            if entry.state.working() && !entry.cancelled.load(Ordering::SeqCst) {
                return Ok(());
            }
            if entry.state == State::Ready && stamps_unchanged(&entry.stamps) {
                return Ok(());
            }
            entry.generation += 1;
            entry.state = State::Downloading;
            entry.downloaded = 0;
            entry.error = None;
            entry.runtime = None;
            entry.stamps.clear();
            entry.cancelled = cancelled.clone();
            let generation = entry.generation;
            downloads.workers += 1;
            generation
        };
        let root = self.root.clone();
        let downloads = self.owner.downloads.clone();
        let id = package.id.clone();
        let total = package.download_size;
        let spawned = thread::Builder::new()
            .name("voice-model-download".into())
            .spawn(move || {
                let result = download_package(
                    &package, &root, &bundled, &cancelled, &downloads, generation,
                );
                finished(&downloads, &package.id, generation, result, total);
            });
        if let Err(error) = spawned {
            let message = format!("无法启动音色下载：{error}");
            finished(
                &self.owner.downloads,
                &id,
                generation,
                Err(message.clone()),
                total,
            );
            return Err(message);
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        self.package(id)?;
        let mut downloads = self
            .owner
            .downloads
            .lock()
            .map_err(|_| "音色状态不可用。")?;
        let entry = downloads.entries.get_mut(id).ok_or("音色模型不存在。")?;
        if entry.state.working() {
            entry.cancelled.store(true, Ordering::SeqCst);
            entry.state = State::NotDownloaded;
            entry.downloaded = 0;
            entry.error = None;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        stop(&self.owner.downloads);
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            let running = self
                .owner
                .downloads
                .lock()
                .map(|downloads| downloads.workers > 0)
                .unwrap_or(false);
            if !running {
                break;
            }
            thread::sleep(Duration::from_millis(40));
        }
    }
}

fn remove_package(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    .map_err(|error| format!("无法清理音色临时文件：{error}"))
}

fn download_package(
    package: &Package,
    root: &Path,
    bundled: &SpeechRuntime,
    cancelled: &AtomicBool,
    downloads: &Mutex<Downloads>,
    generation: u64,
) -> Result<(SpeechRuntime, Vec<FileStamp>)> {
    check_cancelled(cancelled)?;
    // Serialize cleanup and installation across processes, including a cancelled worker
    // still waiting for its current network read to finish.
    let _store_lock = wait_store_lock(root, cancelled)?;
    let installed = package_path(root, package);
    if installed.symlink_metadata().is_ok() {
        update(
            downloads,
            &package.id,
            generation,
            State::Verifying,
            package.download_size,
        );
        if let Ok(verified) = verify_package(package, &installed, bundled, cancelled) {
            check_cancelled(cancelled)?;
            return Ok(verified);
        }
        check_cancelled(cancelled)?;
        update(downloads, &package.id, generation, State::Downloading, 0);
    }
    let staging = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(root)
        .map_err(|e| format!("无法创建音色下载目录：{e}"))?;
    // Use a portable TLS provider without an additional native build toolchain.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        // The blocking client applies this separately to connection/response reads,
        // not to the complete large download. A stalled read also bounds cancellation.
        .timeout(Duration::from_secs(15))
        .user_agent("Open-Media-Voice-Download")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 || !allowed_url(attempt.url()) {
                attempt.error("音色下载跳转地址不受支持")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("无法建立音色下载连接：{e}"))?;
    let mut completed = 0_u64;
    for file in &package.files {
        check_cancelled(cancelled)?;
        let mut response = client
            .get(&file.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| format!("下载音色失败，请检查网络后重试：{e}"))?;
        if response
            .content_length()
            .is_some_and(|size| size != file.size)
        {
            return Err(format!("音色下载文件大小不符：{}。", file.path));
        }
        let destination = staging.path().join(&file.path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建音色文件目录：{e}"))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| format!("无法保存音色文件，请检查可用磁盘空间：{e}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; BUFFER_BYTES];
        let mut received = 0_u64;
        loop {
            check_cancelled(cancelled)?;
            let count = response
                .read(&mut buffer)
                .map_err(|e| format!("音色下载中断，请重试：{e}"))?;
            if count == 0 {
                break;
            }
            received = received
                .checked_add(count as u64)
                .ok_or("音色文件超出声明大小，已停止下载。")?;
            if received > file.size {
                return Err("音色文件超出声明大小，已停止下载。".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| format!("无法保存音色文件，请检查可用磁盘空间：{e}"))?;
            hasher.update(&buffer[..count]);
            update(
                downloads,
                &package.id,
                generation,
                State::Downloading,
                completed + received,
            );
        }
        if received != file.size || format!("{:x}", hasher.finalize()) != file.sha256.to_lowercase()
        {
            return Err(format!("音色文件校验失败：{}。请重新下载。", file.path));
        }
        output
            .sync_all()
            .map_err(|e| format!("无法完成音色文件写入：{e}"))?;
        completed += received;
    }
    update(
        downloads,
        &package.id,
        generation,
        State::Verifying,
        completed,
    );
    verify_package(package, staging.path(), bundled, cancelled)?;
    check_cancelled(cancelled)?;
    // Hold the state lock around the commit so cancellation cannot race the final rename.
    let mut downloads = downloads.lock().map_err(|_| "音色状态不可用。")?;
    let entry = downloads
        .entries
        .get(&package.id)
        .ok_or("音色模型不存在。")?;
    if downloads.closing || entry.generation != generation || entry.cancelled.load(Ordering::SeqCst)
    {
        return Err(CANCELLED.into());
    }
    let installed = package_path(root, package);
    remove_package(&installed)?;
    fs::rename(staging.path(), &installed).map_err(|e| format!("无法安装已下载音色：{e}"))?;
    // The verified file content is unchanged after the atomic rename.
    let runtime = resolve_runtime(package, &installed, bundled)?;
    let stamps = package
        .files
        .iter()
        .map(|file| {
            let path = checked_path(&installed, &file.path, false)?;
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
            Ok(FileStamp {
                path,
                size: metadata.len(),
                modified: metadata.modified().ok(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if let Some(entry) = downloads.entries.get_mut(&package.id) {
        entry.state = State::Ready;
        entry.downloaded = package.download_size;
        entry.error = None;
        entry.runtime = Some(runtime.clone());
        entry.stamps = stamps.clone();
    }
    drop(downloads);
    Ok((runtime, stamps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> serde_json::Value {
        json!({"schema": 1, "models": [{
            "id":"extra-voice", "version":1, "modelSize":12, "downloadSize":12,
            "files":[
                {"path":"model.onnx", "url":"https://huggingface.co/a/b/resolve/commit/model.onnx", "size":4, "sha256":"a".repeat(64)},
                {"path":"vocoder.onnx", "url":"https://huggingface.co/a/b/resolve/commit/vocoder.onnx", "size":4, "sha256":"b".repeat(64)},
                {"path":"tokens.txt", "url":"https://huggingface.co/a/b/resolve/commit/tokens.txt", "size":4, "sha256":"c".repeat(64)}
            ],
            "voices":[{"id":"extra_voice", "name":"测试声音", "language":"en-US", "speakerId":0}],
            "model":{"kind":"matcha", "file":"model.onnx", "vocoder":"vocoder.onnx", "tokens":"tokens.txt", "dataDir":"@bundled/model/espeak-ng-data", "sampleRate":22050}
        }]})
    }

    #[test]
    fn catalog_rejects_untrusted_urls_paths_sizes_and_missing_dependencies() {
        let original = catalog();
        assert!(load_catalog(&original.to_string()).is_ok());
        for path in [
            "../model.onnx",
            "/model.onnx",
            "a\\model.onnx",
            "C:model.onnx",
            "a,b.onnx",
        ] {
            let mut changed = original.clone();
            changed["models"][0]["files"][0]["path"] = json!(path);
            assert!(load_catalog(&changed.to_string()).is_err());
        }
        for url in [
            "http://huggingface.co/file",
            "https://example.com/file",
            "https://huggingface.co.evil.test/file",
            "https://user@huggingface.co/file",
        ] {
            let mut changed = original.clone();
            changed["models"][0]["files"][0]["url"] = json!(url);
            assert!(load_catalog(&changed.to_string()).is_err());
        }
        let mut changed = original.clone();
        changed["models"][0]["downloadSize"] = json!(11);
        assert!(load_catalog(&changed.to_string()).is_err());
        let mut changed = original.clone();
        changed["models"][0]["model"]["tokens"] = json!("unverified.txt");
        assert!(load_catalog(&changed.to_string()).is_err());
        let mut changed = original;
        changed["models"][0]["files"][0]["sha256"] = json!("g".repeat(64));
        assert!(load_catalog(&changed.to_string()).is_err());
    }

    #[test]
    fn catalog_accepts_large_files_and_packages_with_exact_declared_sizes() {
        let mut value = catalog();
        let large_file = 9_u64 * 1024 * 1024 * 1024;
        value["models"][0]["files"][0]["size"] = json!(large_file);
        value["models"][0]["modelSize"] = json!(large_file + 8);
        value["models"][0]["downloadSize"] = json!(large_file + 8);
        let packages = load_catalog(&value.to_string()).unwrap();
        assert_eq!(packages[0].files[0].size, large_file);
        assert_eq!(packages[0].download_size, large_file + 8);

        value["models"][0]["downloadSize"] = json!(large_file + 7);
        assert!(load_catalog(&value.to_string()).is_err());
    }

    #[test]
    fn catalog_rejects_total_size_overflow() {
        let mut value = catalog();
        value["models"][0]["files"][0]["size"] = json!(u64::MAX);
        value["models"][0]["modelSize"] = json!(u64::MAX);
        value["models"][0]["downloadSize"] = json!(u64::MAX);
        assert_eq!(
            load_catalog(&value.to_string()).err().unwrap(),
            "音色资源大小无效。"
        );
    }

    #[test]
    fn integrity_checks_detect_corruption_truncation_and_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.onnx");
        let data = b"test-model-content";
        fs::write(&path, data).unwrap();
        let file = ModelFile {
            path: "model.onnx".into(),
            url: String::new(),
            size: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
        };
        let cancelled = AtomicBool::new(false);
        let stamp = hash_file(&path, &file, &cancelled).unwrap();
        assert!(stamps_unchanged(&[stamp]));
        fs::write(&path, b"test-model-corrupt").unwrap();
        assert!(hash_file(&path, &file, &cancelled).is_err());
        fs::write(&path, b"test").unwrap();
        assert!(hash_file(&path, &file, &cancelled).is_err());
        fs::write(&path, data).unwrap();
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(
            hash_file(&path, &file, &cancelled).err().unwrap(),
            CANCELLED
        );
    }

    #[test]
    fn cancelled_worker_cannot_overwrite_retry_progress() {
        let mut state = Downloads::default();
        state.entries.insert(
            "model".into(),
            Entry {
                state: State::Downloading,
                generation: 2,
                downloaded: 25,
                ..Entry::default()
            },
        );
        state.workers = 2;
        let state = Mutex::new(state);
        update(&state, "model", 1, State::Verifying, 100);
        finished(&state, "model", 1, Err("old worker".into()), 100);
        let state = state.lock().unwrap();
        assert_eq!(state.entries["model"].state.name(), "downloading");
        assert_eq!(state.entries["model"].downloaded, 25);
        assert_eq!(state.workers, 1);
        assert!(state.entries["model"].error.is_none());
    }

    #[test]
    fn real_catalog_is_consistent_and_shares_models_between_voices() {
        let catalog = load_catalog(include_str!("../resources/speech-models.json")).unwrap();
        assert!(catalog.iter().any(|package| package.voices.len() > 1));
        assert!(catalog
            .iter()
            .any(|package| package.model.kind == ModelKind::Kokoro));
    }

    #[test]
    fn windows_engine_paths_preserve_drive_unc_unicode_and_spaces() {
        for (input, expected) in [
            (
                r"\\?\D:\应用 资源\speech\model\espeak-ng-data",
                "D:/应用 资源/speech/model/espeak-ng-data",
            ),
            (
                r"\\?\UNC\server\共享 资源\speech\model\number-zh.fst",
                "//server/共享 资源/speech/model/number-zh.fst",
            ),
            (
                r"C:\应用 资源\speech\model\date-zh.fst",
                "C:/应用 资源/speech/model/date-zh.fst",
            ),
            (r"\\server\共享 资源\tokens.txt", "//server/共享 资源/tokens.txt"),
        ] {
            assert_eq!(windows_engine_path(input).unwrap(), expected);
        }
        assert!(windows_engine_path(r"\\?\Volume{unknown}\speech").is_err());
        assert!(windows_engine_path(r"\\?\relative\speech").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn shared_windows_resources_remain_readable_after_engine_path_conversion() {
        let root = tempfile::Builder::new()
            .prefix("共享语音 资源-")
            .tempdir()
            .unwrap();
        fs::create_dir_all(root.path().join("model/espeak-ng-data")).unwrap();
        fs::write(root.path().join("model/espeak-ng-data/phontab"), b"phonemes").unwrap();
        fs::write(root.path().join("model/number-zh.fst"), b"rules").unwrap();
        for (relative, directory) in [("model/espeak-ng-data", true), ("model/number-zh.fst", false)] {
            let validated = checked_path(root.path(), relative, directory).unwrap();
            let argument = engine_resource_path(&validated).unwrap();
            assert!(!argument.starts_with(r"\\?\"));
            assert_eq!(Path::new(&argument).canonicalize().unwrap(), validated);
            if directory {
                assert_eq!(fs::read(format!("{argument}/phontab")).unwrap(), b"phonemes");
            } else {
                assert_eq!(fs::read(argument).unwrap(), b"rules");
            }
        }
    }

    fn fixture_package(root: &Path) -> (Package, SpeechRuntime) {
        let mut value = catalog();
        value["models"][0]["model"]["kind"] = json!("kokoro");
        value["models"][0]["model"]["voices"] = json!("vocoder.onnx");
        value["models"][0]["model"]["sampleRate"] = json!(24000);
        value["models"][0]["voices"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id":"second_voice", "name":"第二声音", "language":"zh-CN", "speakerId":23
            }));
        let mut package = load_catalog(&value.to_string()).unwrap().remove(0);
        let installed = package_path(root, &package);
        fs::create_dir_all(&installed).unwrap();
        for file in &mut package.files {
            fs::write(installed.join(&file.path), b"test").unwrap();
            file.sha256 = format!("{:x}", Sha256::digest(b"test"));
        }
        let bundled_root = root.join("bundled");
        fs::create_dir_all(bundled_root.join("model/espeak-ng-data")).unwrap();
        let bundled = SpeechRuntime {
            root: bundled_root,
            executable: root.join("not-executed"),
            model: package.model.clone(),
            voices: Vec::new(),
        };
        (package, bundled)
    }

    #[test]
    fn installed_voice_requires_verification_and_all_shared_voices_reflect_corruption() {
        let root = tempfile::tempdir().unwrap();
        let (package, bundled) = fixture_package(root.path());
        let id = package.id.clone();
        let state = Downloads {
            entries: HashMap::from([(id.clone(), Entry::default())]),
            ..Downloads::default()
        };
        let manager = SpeechModels {
            catalog: Arc::new(vec![package.clone()]),
            root: root.path().into(),
            bundled: Ok(bundled.clone()),
            owner: Arc::new(Owner {
                downloads: Arc::new(Mutex::new(state)),
            }),
        };
        assert!(manager.runtime_for_voice("extra_voice").is_err());
        assert!(manager.begin("unknown-package").is_err());
        assert_eq!(
            manager.voices()[0].status.as_deref(),
            Some("not-downloaded")
        );
        let cancelled = AtomicBool::new(false);
        let (runtime, stamps) = verify_package(
            &package,
            &package_path(root.path(), &package),
            &bundled,
            &cancelled,
        )
        .unwrap();
        assert!(Path::new(&runtime.model.data_dir)
            .ends_with(Path::new("model").join("espeak-ng-data")));
        assert_eq!(runtime.model.file, "model.onnx");
        assert_eq!(runtime.model.sample_rate, 24000);
        finished(
            &manager.owner.downloads,
            &id,
            0,
            Ok((runtime, stamps)),
            package.download_size,
        );
        for voice in manager.voices() {
            assert_eq!(voice.status.as_deref(), Some("ready"));
            assert_eq!(voice.model_id.as_deref(), Some(id.as_str()));
            assert_eq!(voice.downloaded_bytes, Some(12));
            assert!(manager.runtime_for_voice(&voice.id).is_ok());
        }
        fs::remove_file(package_path(root.path(), &package).join("tokens.txt")).unwrap();
        assert!(manager.runtime_for_voice("extra_voice").is_err());
        for voice in manager.voices() {
            assert_eq!(voice.status.as_deref(), Some("failed"));
            assert!(voice.error.is_some());
        }
    }

    #[test]
    fn cancelled_or_shutdown_download_cannot_mark_voice_ready() {
        let root = tempfile::tempdir().unwrap();
        let (package, bundled) = fixture_package(root.path());
        let cancelled = Arc::new(AtomicBool::new(false));
        let state = Downloads {
            entries: HashMap::from([(
                package.id.clone(),
                Entry {
                    state: State::Downloading,
                    cancelled: cancelled.clone(),
                    ..Entry::default()
                },
            )]),
            workers: 1,
            closing: false,
        };
        let state = Mutex::new(state);
        let verified = verify_package(
            &package,
            &package_path(root.path(), &package),
            &bundled,
            &cancelled,
        )
        .unwrap();
        stop(&state);
        assert!(cancelled.load(Ordering::SeqCst));
        finished(&state, &package.id, 0, Ok(verified), package.download_size);
        let state = state.lock().unwrap();
        assert_eq!(state.entries[&package.id].state.name(), "not-downloaded");
        assert_eq!(state.workers, 0);
    }

    #[test]
    fn store_lock_serializes_handles_and_cancelled_wait_does_not_acquire() {
        let root = tempfile::tempdir().unwrap();
        let held = try_store_lock(root.path()).unwrap().unwrap();
        assert!(try_store_lock(root.path()).unwrap().is_none());
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_worker = cancelled.clone();
        let waiting_root = root.path().to_path_buf();
        let worker = thread::spawn(move || {
            wait_store_lock(&waiting_root, &cancel_worker)
                .err()
                .unwrap()
        });
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap(), CANCELLED);
        assert!(try_store_lock(root.path()).unwrap().is_none());
        drop(held);
        assert!(try_store_lock(root.path()).unwrap().is_some());
        assert!(root.path().join(".store.lock").is_file());
    }

    #[test]
    fn second_instance_does_not_remove_active_staging_directory() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("speech-models");
        fs::create_dir_all(&root).unwrap();
        let held = try_store_lock(&root).unwrap().unwrap();
        let staging = root.join(".download-active");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial-model.onnx"), b"still downloading").unwrap();
        let manager =
            SpeechModels::new(data.path(), Err("test bundle unavailable".into())).unwrap();
        assert!(staging.join("partial-model.onnx").is_file());
        drop(manager);
        drop(held);
        let _manager =
            SpeechModels::new(data.path(), Err("test bundle unavailable".into())).unwrap();
        assert!(!staging.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_model_files_are_not_accepted() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("model.onnx")).unwrap();
        assert!(checked_path(root.path(), "model.onnx", false).is_err());
    }
}
