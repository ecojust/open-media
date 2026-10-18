use crate::{
    engine::Result,
    speech::{Model, ModelKind, PythonCpuFallback, SpeechRuntime, SpeechVoice},
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

#[path = "speech_native_acceleration.rs"]
mod native_acceleration;
#[path = "speech_runtime_packages.rs"]
pub(crate) mod runtime_packages;

const CANCELLED: &str = "音色下载已取消。";
const BUFFER_BYTES: usize = 128 * 1024;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelFile {
    pub(crate) path: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) mirrors: Vec<String>,
    #[serde(default)]
    pub(crate) embedded: Option<String>,
    pub(crate) size: u64,
    pub(crate) sha256: String,
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
    #[serde(default)]
    runtime_id: String,
    #[serde(default)]
    accelerated_runtime_id: String,
    #[serde(skip)]
    fallback_runtime: Option<runtime_packages::SelectedRuntime>,
    #[serde(skip)]
    runtime_only: bool,
    #[serde(default)]
    license: String,
    #[serde(default)]
    usage_note: String,
    #[serde(skip)]
    runtime: Option<runtime_packages::SelectedRuntime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema: u32,
    #[serde(default)]
    native_acceleration_runtime_id: String,
    models: Vec<Package>,
    #[serde(default)]
    runtimes: Vec<runtime_packages::RuntimeDefinition>,
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
pub(crate) struct FileStamp {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    // Full runtime trees are checked at startup and before synthesis, not on every UI poll.
    defer_display_check: bool,
}

struct Entry {
    state: State,
    downloaded: u64,
    error: Option<String>,
    download_source: Option<String>,
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
            download_source: None,
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
    runtime_stamps: HashMap<String, Vec<FileStamp>>,
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
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && safe_relative(value)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains([',', '\\', ':', '<', '>', '"', '|', '?', '*'])
        && !value.chars().any(char::is_control)
        && value.split('/').all(|part| {
            if part.is_empty() || matches!(part, "." | "..") || part.ends_with(['.', ' ']) {
                return false;
            }
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !matches!(
                stem.as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
        })
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
            | "modelscope.cn"
            | "hf-mirror.com"
            | "ghfast.top"
            | "ghproxy.net"
            | "gh-proxy.com"
    ) || host.ends_with(".huggingface.co")
        || host.ends_with(".hf.co")
        || host.ends_with(".xethub.hf.co")
}

fn load_catalog(text: &str) -> Result<Vec<Package>> {
    load_catalog_with_acceleration(text, runtime_packages::cuda_available())
}

fn load_catalog_with_acceleration(text: &str, cuda: bool) -> Result<Vec<Package>> {
    let mut catalog: Catalog = serde_json::from_str(text).map_err(|_| "可下载音色清单无效。")?;
    if !matches!(catalog.schema, 1 | 2) || catalog.models.len() > 16 {
        return Err("可下载音色清单版本不受支持。".into());
    }
    runtime_packages::validate(&catalog.runtimes)?;
    native_acceleration::append_package(&mut catalog)?;
    let mut ids = HashSet::new();
    let mut voice_ids = HashSet::new();
    for package in &mut catalog.models {
        if !valid_id(&package.id)
            || !ids.insert(&package.id)
            || package.version == 0
            || (!package.runtime_only && package.files.is_empty())
            || package.files.len() > 64
            || (!package.runtime_only && package.voices.is_empty())
            || package.voices.len() > 128
        {
            return Err("可下载音色配置无效。".into());
        }
        package.runtime = runtime_packages::select(&package.runtime_id, &catalog.runtimes)?;
        if !package.accelerated_runtime_id.is_empty() {
            let accelerated =
                runtime_packages::select(&package.accelerated_runtime_id, &catalog.runtimes)?;
            if let Some(accelerated) = accelerated {
                if accelerated.archive.kind != runtime_packages::RuntimeKind::Python
                    || !matches!(package.model.kind, ModelKind::F5 | ModelKind::Qwen3)
                {
                    return Err("加速运行环境与模型类型不一致。".into());
                }
                if cuda {
                    package.fallback_runtime = package.runtime.take();
                    package.runtime_id = accelerated.id.clone();
                    package.runtime = Some(accelerated);
                }
            }
        }
        if !package.runtime_only
            && matches!(package.model.kind, ModelKind::F5 | ModelKind::Qwen3)
                != !package.runtime_id.is_empty()
        {
            return Err("音色运行环境与模型类型不一致。".into());
        }
        if package.runtime.as_ref().is_some_and(|runtime| {
            (runtime.archive.kind == runtime_packages::RuntimeKind::Native) != package.runtime_only
        }) {
            return Err("音色运行环境类型无效。".into());
        }
        let mut paths = HashSet::new();
        let mut total = 0_u64;
        let mut download_total = 0_u64;
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
            if file.mirrors.len() > 8
                || file.mirrors.iter().any(|source| {
                    reqwest::Url::parse(source).map_or(true, |url| !allowed_url(&url))
                })
            {
                return Err("音色备用下载地址无效。".into());
            }
            if let Some(name) = &file.embedded {
                let bytes = embedded_file(name).ok_or("音色内置配置不存在。")?;
                if bytes.len() as u64 != file.size
                    || format!("{:x}", Sha256::digest(bytes)) != file.sha256.to_lowercase()
                {
                    return Err("音色内置配置与校验清单不一致。".into());
                }
            } else {
                download_total = download_total
                    .checked_add(file.size)
                    .ok_or("音色下载大小无效。")?;
            }
            total = total.checked_add(file.size).ok_or("音色资源大小无效。")?;
        }
        if total != package.model_size || download_total != package.download_size {
            return Err("音色资源大小与清单不一致。".into());
        }
        total
            .checked_add(
                package
                    .runtime
                    .as_ref()
                    .map_or(0, |runtime| runtime.archive.size),
            )
            .ok_or("音色资源与运行环境的总大小无效。")?;
        for voice in &package.voices {
            if !valid_id(&voice.id)
                || !voice_ids.insert(&voice.id)
                || voice.name.trim().is_empty()
                || voice.name.chars().count() > 80
                || voice.language.is_empty()
                || voice.language.len() > 32
                || voice.speaker_id > 1024
                || (package.model.kind == ModelKind::Matcha && voice.speaker_id != 0)
                || crate::speech::additional_voice_kind(&voice.id)
                    .is_some_and(|kind| kind != package.model.kind)
            {
                return Err("可下载音色列表无效。".into());
            }
        }
        if package.runtime_only {
            continue;
        }
        let model = &package.model;
        if !matches!(model.sample_rate, 16000 | 22050 | 24000 | 44100 | 48000)
            || model.lexicons.len() > 16
            || model.rule_fsts.len() > 16
        {
            return Err("可下载音色模型配置无效。".into());
        }
        let mut required: Vec<&str> = match model.kind {
            ModelKind::Matcha => vec![&model.file, &model.tokens, &model.vocoder],
            ModelKind::Kokoro => vec![&model.file, &model.tokens, &model.voices],
            ModelKind::Zipvoice => vec![
                &model.encoder,
                &model.decoder,
                &model.tokens,
                &model.vocoder,
                &model.reference_audio,
                &model.reference_text,
            ],
            ModelKind::F5 | ModelKind::Qwen3 => vec![&model.config],
        };
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
        defer_display_check: false,
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
    bundled: Option<&SpeechRuntime>,
) -> Result<SpeechRuntime> {
    if let Some(native) = native_acceleration::resolve(package, root, bundled) {
        return native;
    }

    let mut model = package.model.clone();
    let resolve = |value: &str, directory: bool| -> Result<String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        if let Some(shared) = value.strip_prefix("@bundled/") {
            let bundled = bundled.ok_or("此音色需要内置语音资源，请重新安装完整安装包。")?;
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
    model.encoder = resolve(&model.encoder, false)?;
    model.decoder = resolve(&model.decoder, false)?;
    model.reference_audio = resolve(&model.reference_audio, false)?;
    model.reference_text = resolve(&model.reference_text, false)?;
    model.config = resolve(&model.config, false)?;
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
    let (executable, script) = if let Some(runtime) = &package.runtime {
        let store = root.parent().ok_or("音色模型目录无效。")?;
        let runtime_root = runtime_packages::path(store, runtime);
        (
            checked_path(&runtime_root, &runtime.archive.executable, false)?,
            Some(checked_path(&runtime_root, &runtime.archive.script, false)?),
        )
    } else if package.runtime_id.is_empty() {
        (
            bundled
                .ok_or("内置语音引擎不可用，请重新安装完整安装包。")?
                .executable
                .clone(),
            None,
        )
    } else {
        return Err("当前系统暂不支持此音色的运行环境。".into());
    };
    Ok(SpeechRuntime {
        native_cpu_fallback: None,
        python_cpu_fallback: None,
        root: root.canonicalize().map_err(|e| e.to_string())?,
        executable,
        script,
        model,
        voices: package.voices.clone(),
    })
}

fn verify_package(
    package: &Package,
    root: &Path,
    bundled: Option<&SpeechRuntime>,
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
    let mut selected = package.clone();
    if let Some(runtime) = &package.runtime {
        let store = root.parent().ok_or("音色模型目录无效。")?;
        match runtime_packages::verify(&runtime_packages::path(store, runtime), runtime, cancelled)
        {
            Ok(verified) => stamps.extend(verified),
            Err(error) => {
                check_cancelled(cancelled)?;
                let Some(fallback) = &package.fallback_runtime else {
                    return Err(error);
                };
                stamps.extend(runtime_packages::verify(
                    &runtime_packages::path(store, fallback),
                    fallback,
                    cancelled,
                )?);
                selected.runtime = Some(fallback.clone());
                selected.runtime_id = fallback.id.clone();
            }
        }
    }
    check_cancelled(cancelled)?;
    let mut resolved = resolve_runtime(&selected, root, bundled)?;
    if let Some(fallback) = package.fallback_runtime.as_ref().filter(|fallback| {
        matches!(package.model.kind, ModelKind::F5 | ModelKind::Qwen3)
            && selected.runtime_id != fallback.id
    }) {
        let store = root.parent().ok_or("音色模型目录无效。")?;
        let fallback_root = runtime_packages::path(store, fallback);
        if let Ok(mut verified) = runtime_packages::verify(&fallback_root, fallback, cancelled) {
            resolved.python_cpu_fallback = Some(PythonCpuFallback {
                executable: checked_path(&fallback_root, &fallback.archive.executable, false)?,
                script: checked_path(&fallback_root, &fallback.archive.script, false)?,
            });
            // A damaged optional fallback does not make the primary GPU runtime
            // unavailable. Before synthesis, a changed stamp triggers full revalidation.
            for stamp in &mut verified {
                stamp.defer_display_check = true;
            }
            stamps.extend(verified);
        }
        check_cancelled(cancelled)?;
    }
    Ok((resolved, stamps))
}

fn preferred_runtime_active(
    package: &Package,
    runtime: Option<&SpeechRuntime>,
    store: &Path,
) -> bool {
    package.runtime.as_ref().is_none_or(|preferred| {
        runtime.is_some_and(|runtime| {
            runtime
                .executable
                .starts_with(runtime_packages::path(store, preferred))
        })
    })
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

fn display_stamps_unchanged(stamps: &[FileStamp]) -> bool {
    !stamps.is_empty()
        && stamps
            .iter()
            .filter(|stamp| !stamp.defer_display_check)
            .all(|stamp| {
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
                if state != State::Downloading {
                    entry.download_source = None;
                }
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
            entry.download_source = None;
            if entry.cancelled.load(Ordering::SeqCst)
                && entry.runtime.is_some()
                && stamps_unchanged(&entry.stamps)
            {
                entry.state = State::Ready;
                entry.error = None;
            } else if entry.cancelled.load(Ordering::SeqCst) {
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
                        entry.error = Some(error);
                        if entry.runtime.is_some() && stamps_unchanged(&entry.stamps) {
                            entry.state = State::Ready;
                        } else {
                            entry.state = State::Failed;
                            entry.runtime = None;
                            entry.stamps.clear();
                        }
                    }
                }
            }
        }
    }
}

impl SpeechModels {
    pub fn new(app_data: &Path, bundled: Result<SpeechRuntime>) -> Result<Self> {
        let catalog = load_catalog(include_str!("../resources/speech-models.json"))?;
        Self::with_catalog(app_data, bundled, catalog)
    }

    fn with_catalog(
        app_data: &Path,
        bundled: Result<SpeechRuntime>,
        catalog: Vec<Package>,
    ) -> Result<Self> {
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
            entry.download_source = None;
            entry.downloaded = package.download_size
                + package
                    .runtime
                    .as_ref()
                    .map_or(0, |runtime| runtime.archive.size);
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
        let total = package.download_size
            + package
                .runtime
                .as_ref()
                .map_or(0, |runtime| runtime.archive.size);
        let spawned = thread::Builder::new()
            .name("voice-model-verify".into())
            .spawn(move || {
                let result = verify_package(&package, &root, bundled.as_ref().ok(), &cancelled);
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
        let ready_runtimes: HashSet<_> = downloads
            .runtime_stamps
            .iter()
            .filter_map(|(id, stamps)| display_stamps_unchanged(stamps).then_some(id.clone()))
            .chain(self.catalog.iter().filter_map(|package| {
                let entry = downloads.entries.get(&package.id)?;
                (entry.state == State::Ready
                    && !package.runtime_id.is_empty()
                    && preferred_runtime_active(package, entry.runtime.as_ref(), &self.root)
                    && display_stamps_unchanged(&entry.stamps))
                .then_some(package.runtime_id.clone())
            }))
            .collect();
        let mut voices = Vec::new();
        for package in self.catalog.iter() {
            let Some(entry) = downloads.entries.get_mut(&package.id) else {
                continue;
            };
            if entry.state == State::Ready && !display_stamps_unchanged(&entry.stamps) {
                entry.state = State::Failed;
                entry.error = Some("已下载的音色文件缺失或已更改，请重新下载。".into());
                entry.runtime = None;
            }
            for voice in &package.voices {
                let mut voice = voice.clone();
                voice.model_id = Some(package.id.clone());
                voice.model_size = Some(package.model_size);
                let runtime_size = package
                    .runtime
                    .as_ref()
                    .map_or(0, |runtime| runtime.archive.size);
                voice.download_size = Some(package.download_size + runtime_size);
                voice.runtime_size = Some(runtime_size);
                voice.runtime_download_id = package.runtime.as_ref().map(|_| package.id.clone());
                voice.runtime_status = if package.runtime_id.is_empty() {
                    None
                } else if ready_runtimes.contains(&package.runtime_id) {
                    Some("ready".into())
                } else if entry.runtime.is_some()
                    && !preferred_runtime_active(package, entry.runtime.as_ref(), &self.root)
                {
                    Some(
                        match entry.state {
                            State::Downloading => "upgrade-downloading",
                            State::Verifying => "upgrade-verifying",
                            _ if entry.error.is_some() => "upgrade-failed",
                            _ => "upgrade-available",
                        }
                        .into(),
                    )
                } else {
                    Some(entry.state.name().into())
                };
                voice.runtime_error = if package.runtime_id.is_empty()
                    || ready_runtimes.contains(&package.runtime_id)
                {
                    None
                } else {
                    entry.error.clone()
                };
                voice.license = (!package.license.is_empty()).then(|| package.license.clone());
                voice.usage_note =
                    (!package.usage_note.is_empty()).then(|| package.usage_note.clone());
                voice.status = Some(
                    if entry.runtime.is_some() && display_stamps_unchanged(&entry.stamps) {
                        "ready".into()
                    } else {
                        entry.state.name().into()
                    },
                );
                voice.downloaded_bytes = Some(entry.downloaded);
                voice.error = entry.error.clone();
                voice.download_sources = Some(download_sources(package));
                voice.download_source = entry.download_source.clone();
                if !package.runtime_id.is_empty() && package.runtime.is_none() {
                    voice.status = Some("unsupported".into());
                    voice.runtime_status = Some("unsupported".into());
                    voice.error = Some("此音色尚无适合当前系统的运行环境。".into());
                }
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
        if entry.state != State::Ready && entry.runtime.is_none() {
            return Err("请先下载所选音色，等待校验完成后再生成配音。".into());
        }
        if !preferred_runtime_active(package, entry.runtime.as_ref(), &self.root)
            && package
                .runtime
                .as_ref()
                .is_some_and(|runtime| runtime_packages::path(&self.root, runtime).is_dir())
        {
            let (runtime, stamps) = verify_package(
                package,
                &package_path(&self.root, package),
                self.bundled.as_ref().ok(),
                &AtomicBool::new(false),
            )?;
            entry.runtime = Some(runtime);
            entry.stamps = stamps;
        }
        if !stamps_unchanged(&entry.stamps) && package.fallback_runtime.is_some() {
            if let Ok((runtime, stamps)) = verify_package(
                package,
                &package_path(&self.root, package),
                self.bundled.as_ref().ok(),
                &AtomicBool::new(false),
            ) {
                entry.runtime = Some(runtime);
                entry.stamps = stamps;
            }
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
        self.begin_with_repair(id, false)
    }

    pub fn repair(&self, id: &str) -> Result<()> {
        self.begin_with_repair(id, true)
    }

    fn begin_with_repair(&self, id: &str, repair: bool) -> Result<()> {
        let package = self.package(id)?;
        if !package.runtime_id.is_empty() && package.runtime.is_none() {
            return Err("此音色尚无适合当前系统的运行环境。".into());
        }
        if package.runtime_id.is_empty() {
            self.bundled.as_ref().map_err(Clone::clone)?;
        }
        let bundled = self.bundled.clone();
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
            if !repair
                && entry.state == State::Ready
                && stamps_unchanged(&entry.stamps)
                && preferred_runtime_active(&package, entry.runtime.as_ref(), &self.root)
            {
                return Ok(());
            }
            entry.generation += 1;
            entry.state = State::Downloading;
            entry.downloaded = 0;
            entry.error = None;
            entry.download_source = None;
            if !stamps_unchanged(&entry.stamps) {
                entry.runtime = None;
                entry.stamps.clear();
            }
            entry.cancelled = cancelled.clone();
            let generation = entry.generation;
            downloads.workers += 1;
            generation
        };
        let root = self.root.clone();
        let downloads = self.owner.downloads.clone();
        let id = package.id.clone();
        let total = package.download_size
            + package
                .runtime
                .as_ref()
                .map_or(0, |runtime| runtime.archive.size);
        let spawned = thread::Builder::new()
            .name("voice-model-download".into())
            .spawn(move || {
                let result = download_package(
                    &package,
                    &root,
                    bundled.as_ref().ok(),
                    &cancelled,
                    &downloads,
                    generation,
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
            entry.state = if entry.runtime.is_some() && stamps_unchanged(&entry.stamps) {
                State::Ready
            } else {
                State::NotDownloaded
            };
            entry.downloaded = 0;
            entry.error = None;
            entry.download_source = None;
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

fn embedded_file(name: &str) -> Option<&'static [u8]> {
    match name {
        "zipvoice-reference.wav" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/zipvoice-reference.wav"
        )),
        "zipvoice-reference.txt" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/zipvoice-reference.txt"
        )),
        "zipvoice-lexicon.txt" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/zipvoice-lexicon.txt"
        )),
        "f5-reference.wav" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/f5-reference.wav"
        )),
        "f5-reference.txt" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/f5-reference.txt"
        )),
        "f5-runner-config.json" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/f5-runner-config.json"
        )),
        "qwen3-runner-config.json" => Some(include_bytes!(
            "../../scripts/optional-speech-assets/qwen3-runner-config.json"
        )),
        _ => None,
    }
}

fn source_origin(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}

fn download_sources(package: &Package) -> Vec<String> {
    let mut sources = Vec::new();
    for file in package.files.iter().filter(|file| file.embedded.is_none()) {
        for url in std::iter::once(&file.url).chain(&file.mirrors) {
            let source = source_origin(url);
            if !source.is_empty() && !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    if let Some(runtime) = &package.runtime {
        for url in std::iter::once(&runtime.archive.url)
            .chain(&runtime.archive.mirrors)
            .chain(
                runtime
                    .archive
                    .parts
                    .iter()
                    .flat_map(|part| std::iter::once(&part.url).chain(&part.mirrors)),
            )
        {
            let source = source_origin(url);
            if !source.is_empty() && !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    sources
}

fn download_file(
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    destination: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, &str),
) -> Result<()> {
    check_cancelled(cancelled)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建音色文件目录：{e}"))?;
    }
    if let Some(name) = &file.embedded {
        let data = embedded_file(name).ok_or("音色内置配置不存在。")?;
        if data.len() as u64 != file.size
            || format!("{:x}", Sha256::digest(data)) != file.sha256.to_lowercase()
        {
            return Err("音色内置配置校验失败。".into());
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| format!("无法写入音色配置：{e}"))?;
        output
            .write_all(data)
            .and_then(|_| output.sync_all())
            .map_err(|e| format!("无法写入音色配置：{e}"))?;
        check_cancelled(cancelled)?;
        return Ok(());
    }
    let mut failures = Vec::new();
    for url in std::iter::once(&file.url).chain(&file.mirrors) {
        check_cancelled(cancelled)?;
        let origin = source_origin(url);
        progress(0, &origin);
        let mut created = false;
        let attempt = (|| {
            let mut response = client
                .get(url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .map_err(|error| {
                    if error.is_timeout() {
                        "连接超时".to_owned()
                    } else {
                        "连接失败".to_owned()
                    }
                })?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|size| size != file.size)
            {
                return Err("文件大小不符".into());
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|e| format!("本地文件写入失败：{e}"))?;
            created = true;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0_u8; BUFFER_BYTES];
            let mut received = 0_u64;
            loop {
                check_cancelled(cancelled)?;
                let count = response
                    .read(&mut buffer)
                    .map_err(|_| "读取中断或超时".to_owned())?;
                if count == 0 {
                    break;
                }
                received = received
                    .checked_add(count as u64)
                    .ok_or("文件超出声明大小")?;
                if received > file.size {
                    return Err("文件超出声明大小".into());
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| format!("本地文件写入失败：{e}"))?;
                hasher.update(&buffer[..count]);
                progress(received, &origin);
            }
            if received != file.size
                || format!("{:x}", hasher.finalize()) != file.sha256.to_lowercase()
            {
                return Err("文件完整性校验失败".into());
            }
            output
                .sync_all()
                .map_err(|e| format!("本地文件写入失败：{e}"))?;
            Ok(())
        })();
        match attempt {
            Ok(()) => return Ok(()),
            Err(error) => {
                // Never retain an unverified partial file when changing download source.
                if created && destination.exists() {
                    fs::remove_file(destination)
                        .map_err(|e| format!("无法清理音色下载临时文件：{e}"))?;
                }
                check_cancelled(cancelled)?;
                if error.starts_with("本地文件写入失败") {
                    return Err(error);
                }
                failures.push(format!("{origin}：{error}"));
            }
        }
    }
    Err(format!(
        "音色文件 {} 的下载来源均未成功，请稍后重试。\n{}",
        file.path,
        failures.join("\n")
    ))
}

fn download_cached_file(
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    destination: &Path,
    root: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, &str),
) -> Result<()> {
    if file.embedded.is_some() {
        return download_file(client, file, destination, cancelled, progress);
    }
    check_cancelled(cancelled)?;
    let cache_root = root.join(".verified-files");
    if let Ok(metadata) = fs::symlink_metadata(&cache_root) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("音色缓存目录无效。".into());
        }
    } else {
        fs::create_dir(&cache_root).map_err(|e| format!("无法创建已验证音色缓存：{e}"))?;
    }
    let cache = cache_root.join(file.sha256.to_lowercase());
    if let Ok(metadata) = fs::symlink_metadata(&cache) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("音色缓存文件类型无效。".into());
        }
        if hash_file(&cache, file, cancelled).is_ok() {
            check_cancelled(cancelled)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if fs::hard_link(&cache, destination).is_err() {
                let mut input = File::open(&cache).map_err(|e| e.to_string())?;
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(destination)
                    .map_err(|e| e.to_string())?;
                let mut buffer = vec![0_u8; BUFFER_BYTES];
                loop {
                    check_cancelled(cancelled)?;
                    let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    output
                        .write_all(&buffer[..count])
                        .map_err(|e| e.to_string())?;
                }
                output.sync_all().map_err(|e| e.to_string())?;
                hash_file(destination, file, cancelled)?;
            }
            progress(file.size, "");
            return Ok(());
        }
        check_cancelled(cancelled)?;
        fs::remove_file(&cache).map_err(|e| format!("无法清理已损坏的音色缓存：{e}"))?;
    }
    download_file(client, file, destination, cancelled, &mut progress)?;
    check_cancelled(cancelled)?;
    // The cache points only to a complete, hash-verified file. Hard links keep a
    // successfully installed model and its retry cache from occupying two copies.
    // If this filesystem lacks hard links, generation still works without caching.
    let _ = fs::hard_link(destination, &cache);
    Ok(())
}

fn reuse_installed_file(
    installed: &Path,
    file: &ModelFile,
    destination: &Path,
    cancelled: &AtomicBool,
) -> Result<bool> {
    check_cancelled(cancelled)?;
    if !fs::symlink_metadata(installed)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
    {
        return Ok(false);
    }
    let Ok(source) = checked_path(installed, &file.path, false) else {
        return Ok(false);
    };
    if hash_file(&source, file, cancelled).is_err() {
        check_cancelled(cancelled)?;
        return Ok(false);
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::hard_link(&source, destination).is_err() {
        let mut input = File::open(&source).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| e.to_string())?;
        let mut buffer = vec![0_u8; BUFFER_BYTES];
        loop {
            check_cancelled(cancelled)?;
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        output.sync_all().map_err(|e| e.to_string())?;
        hash_file(destination, file, cancelled)?;
    }
    check_cancelled(cancelled)?;
    Ok(true)
}

fn update_source(downloads: &Mutex<Downloads>, id: &str, generation: u64, source: &str) {
    if let Ok(mut state) = downloads.lock() {
        if let Some(entry) = state.entries.get_mut(id).filter(|entry| {
            entry.generation == generation && !entry.cancelled.load(Ordering::SeqCst)
        }) {
            entry.download_source = (!source.is_empty()).then(|| source.to_owned());
        }
    }
}

fn download_package(
    package: &Package,
    root: &Path,
    bundled: Option<&SpeechRuntime>,
    cancelled: &AtomicBool,
    downloads: &Mutex<Downloads>,
    generation: u64,
) -> Result<(SpeechRuntime, Vec<FileStamp>)> {
    check_cancelled(cancelled)?;
    // Serialize cleanup and installation across processes, including a cancelled worker
    // still waiting for its current network read to finish.
    let _store_lock = wait_store_lock(root, cancelled)?;
    let installed = package_path(root, package);
    let mut existing_models_valid = false;
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
            if preferred_runtime_active(package, Some(&verified.0), root) {
                return Ok(verified);
            }
            existing_models_valid = true;
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
    if let Some(runtime) = &package.runtime {
        let runtime_stamps =
            runtime_packages::install(root, runtime, cancelled, |file, destination, offset| {
                download_cached_file(
                    &client,
                    file,
                    destination,
                    root,
                    cancelled,
                    |received, source| {
                        update_source(downloads, &package.id, generation, source);
                        update(
                            downloads,
                            &package.id,
                            generation,
                            State::Downloading,
                            if existing_models_valid {
                                package.download_size
                            } else {
                                0
                            } + offset
                                + received,
                        );
                    },
                )
            })?;
        if let Ok(mut state) = downloads.lock() {
            state
                .runtime_stamps
                .insert(package.runtime_id.clone(), runtime_stamps);
        }
        completed = runtime.archive.size;
        let hashes: Vec<_> = if runtime.archive.parts.is_empty() {
            vec![&runtime.archive.sha256]
        } else {
            runtime
                .archive
                .parts
                .iter()
                .map(|part| &part.sha256)
                .collect()
        };
        for hash in hashes {
            let _ = fs::remove_file(root.join(".verified-files").join(hash.to_lowercase()));
        }
    }
    if existing_models_valid {
        // An acceleration upgrade changes only the runtime. Keep the verified
        // model directory in place, including files currently mapped by a CPU job.
        check_cancelled(cancelled)?;
        return verify_package(package, &installed, bundled, cancelled);
    }
    for file in &package.files {
        update_source(downloads, &package.id, generation, "");
        let destination = staging.path().join(&file.path);
        if file.embedded.is_none()
            && reuse_installed_file(&installed, file, &destination, cancelled)?
        {
            completed += file.size;
            update(
                downloads,
                &package.id,
                generation,
                State::Downloading,
                completed,
            );
            continue;
        }
        download_cached_file(
            &client,
            file,
            &destination,
            root,
            cancelled,
            |received, source| {
                update_source(downloads, &package.id, generation, source);
                update(
                    downloads,
                    &package.id,
                    generation,
                    State::Downloading,
                    completed + received,
                );
            },
        )?;
        if file.embedded.is_none() {
            completed += file.size;
        }
    }
    update(
        downloads,
        &package.id,
        generation,
        State::Verifying,
        completed,
    );
    let (verified_runtime, mut stamps) =
        verify_package(package, staging.path(), bundled, cancelled)?;
    let staging_root = staging.path().canonicalize().map_err(|e| e.to_string())?;
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
    let mut runtime = resolve_runtime(package, &installed, bundled)?;
    runtime.python_cpu_fallback = verified_runtime.python_cpu_fallback;
    let installed_root = installed.canonicalize().map_err(|e| e.to_string())?;
    for stamp in &mut stamps {
        if let Ok(relative) = stamp.path.strip_prefix(&staging_root) {
            stamp.path = installed_root.join(relative);
        }
    }
    if let Some(entry) = downloads.entries.get_mut(&package.id) {
        entry.state = State::Ready;
        entry.downloaded = package.download_size
            + package
                .runtime
                .as_ref()
                .map_or(0, |runtime| runtime.archive.size);
        entry.error = None;
        entry.runtime = Some(runtime.clone());
        entry.stamps = stamps.clone();
    }
    drop(downloads);
    // Completed installations own the file links; remove retry links so removing
    // a model later cannot leave gigabytes hidden in the completed-file cache.
    for file in package.files.iter().filter(|file| file.embedded.is_none()) {
        let _ = fs::remove_file(
            root.join(".verified-files")
                .join(file.sha256.to_lowercase()),
        );
    }
    Ok((runtime, stamps))
}

/// Verify an actual installed model and its shared runtime using the application catalog.
#[cfg(test)]
pub(crate) fn verify_installed_voice_for_integration(
    model_root: &Path,
    voice_id: &str,
    bundled: &SpeechRuntime,
) -> Result<SpeechRuntime> {
    let catalog = load_catalog(include_str!("../resources/speech-models.json"))?;
    let package = catalog
        .iter()
        .find(|package| package.voices.iter().any(|voice| voice.id == voice_id))
        .ok_or("集成验证音色不在应用清单内。")?;
    let cancelled = AtomicBool::new(false);
    let (runtime, stamps) = verify_package(package, model_root, Some(bundled), &cancelled)?;
    if !stamps_unchanged(&stamps) {
        return Err("已安装模型或运行包在校验期间发生变化。".into());
    }
    eprintln!(
        "application installed voice verification: {} files verified for {}",
        stamps.len(),
        voice_id
    );
    Ok(runtime)
}

#[cfg(test)]
/// Exercise the application's strict runtime validator against real CI artifacts.
/// The expected checksums come from the builder's artifact metadata, never from
/// a newly computed hash of the tree being tested.
pub(crate) fn verify_portable_runtime_for_integration(
    runtime_root: &Path,
    metadata_path: &Path,
    model_id: &str,
) -> Result<(PathBuf, PathBuf)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata {
        id: String,
        version: u32,
        platform: String,
        filename: String,
        validated: bool,
        validated_models: Vec<String>,
        #[serde(flatten)]
        archive: runtime_packages::RuntimeArchive,
    }
    let bytes = fs::read(metadata_path).map_err(|e| format!("无法读取真实运行包元数据：{e}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("运行包测试元数据过大。".into());
    }
    let metadata: Metadata =
        serde_json::from_slice(&bytes).map_err(|e| format!("真实运行包元数据无效：{e}"))?;
    if metadata.platform != runtime_packages::platform()
        || !metadata.validated
        || !metadata
            .validated_models
            .iter()
            .any(|value| value == model_id)
        || !safe_relative(&metadata.filename)
    {
        return Err("运行包元数据未验证当前平台和所选模型。".into());
    }
    let definition = runtime_packages::RuntimeDefinition {
        id: metadata.id.clone(),
        version: metadata.version,
        platforms: HashMap::from([(metadata.platform.clone(), metadata.archive.clone())]),
    };
    runtime_packages::validate(std::slice::from_ref(&definition))?;
    let selected =
        runtime_packages::select(&metadata.id, &[definition])?.ok_or("运行包没有当前平台配置。")?;
    let cancelled = AtomicBool::new(false);
    let archive_root = metadata_path.parent().ok_or("运行包元数据目录无效。")?;
    let archive = checked_path(archive_root, &metadata.filename, false)?;
    hash_file(
        &archive,
        &ModelFile {
            path: metadata.filename,
            size: metadata.archive.size,
            sha256: metadata.archive.sha256,
            ..ModelFile::default()
        },
        &cancelled,
    )?;
    let stamps = runtime_packages::verify(runtime_root, &selected, &cancelled)?;
    if !stamps_unchanged(&stamps) {
        return Err("运行包在校验期间发生变化。".into());
    }
    eprintln!("application runtime verification: {} files verified against actual artifact metadata on {}", stamps.len(), metadata.platform);
    Ok((
        checked_path(runtime_root, &selected.archive.executable, false)?,
        checked_path(runtime_root, &selected.archive.script, false)?,
    ))
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
        for id in [
            ".",
            "..",
            ".voice",
            "voice.",
            "voice..model",
            "../voice",
            "a/voice",
            "a\\voice",
            "C:voice",
            "CON.foo",
            "NUL.1",
            "COM1.x",
            "LPT9.model",
        ] {
            let mut changed = original.clone();
            changed["models"][0]["id"] = json!(id);
            assert!(
                load_catalog(&changed.to_string()).is_err(),
                "Accepted unsafe model ID: {id}"
            );
        }
        let mut versioned = original.clone();
        versioned["models"][0]["id"] = json!("qwen3-tts-1.7b-serena");
        assert_eq!(
            load_catalog(&versioned.to_string()).unwrap()[0].id,
            "qwen3-tts-1.7b-serena"
        );
        for path in [
            "../model.onnx",
            "/model.onnx",
            "a\\model.onnx",
            "C:model.onnx",
            "a,b.onnx",
            "a/./model.onnx",
            "a//model.onnx",
            "a/model.onnx.",
            "CON.onnx",
            "model\n.onnx",
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
    fn portable_models_require_valid_platform_runtime_metadata() {
        let mut value = catalog();
        value["schema"] = json!(2);
        value["models"][0]["runtimeId"] = json!("python-cpu-v1");
        value["models"][0]["model"] = json!({"kind":"f5","config":"model.onnx","sampleRate":24000});
        assert!(load_catalog(&value.to_string()).is_err());
        value["runtimes"] = json!([{"id":"python-cpu-v1","version":1,"platforms": {
            "macos-arm64": {"url":"https://github.com/ecojust/open-media/releases/download/runtime/runtime.zip","size":100,"unpackedSize":200,"sha256":"a".repeat(64),"manifestSha256":"b".repeat(64),"executable":"python/bin/python3","script":"runner/tts.py"}
        }}]);
        let packages = load_catalog(&value.to_string()).unwrap();
        assert_eq!(
            packages[0].runtime.is_some(),
            runtime_packages::platform() == "macos-arm64"
        );
        value["runtimes"][0]["platforms"]["macos-arm64"]["mirrors"] =
            json!(["http://ghfast.top/unsafe"]);
        assert!(load_catalog(&value.to_string()).is_err());
        value["runtimes"][0]["platforms"]["macos-arm64"]["mirrors"] =
            json!(["https://ghfast.top/https://github.com/ecojust/open-media/runtime.zip"]);
        assert!(load_catalog(&value.to_string()).is_ok());
    }

    #[test]
    fn accelerated_python_runtime_selection_preserves_cpu_package_and_weights() {
        let mut value = catalog();
        value["schema"] = json!(2);
        value["models"][0]["runtimeId"] = json!("python-cpu-v1");
        value["models"][0]["acceleratedRuntimeId"] = json!("python-cuda-v1");
        value["models"][0]["model"] = json!({"kind":"f5","config":"model.onnx","sampleRate":24000});
        let archive = json!({"url":"https://github.com/ecojust/open-media/releases/download/test/runtime.zip",
            "size":100,"unpackedSize":200,"sha256":"a".repeat(64),"manifestSha256":"b".repeat(64),
            "executable":"python/python.exe","script":"runner/tts.py"});
        value["runtimes"] = json!([
            {"id":"python-cpu-v1","version":1,"platforms":{runtime_packages::platform():archive.clone()}},
            {"id":"python-cuda-v1","version":1,"platforms":{runtime_packages::platform():archive.clone()}}
        ]);
        let cpu = load_catalog_with_acceleration(&value.to_string(), false)
            .unwrap()
            .remove(0);
        assert_eq!(cpu.runtime_id, "python-cpu-v1");
        assert!(cpu.fallback_runtime.is_none());
        let gpu = load_catalog_with_acceleration(&value.to_string(), true)
            .unwrap()
            .remove(0);
        assert_eq!(gpu.runtime_id, "python-cuda-v1");
        assert_eq!(gpu.fallback_runtime.as_ref().unwrap().id, "python-cpu-v1");
        assert_eq!(cpu.id, gpu.id);
        assert_eq!(cpu.version, gpu.version);
        assert_eq!(cpu.model_size, gpu.model_size);
        assert_eq!(
            cpu.files
                .iter()
                .map(|file| (&file.path, &file.sha256))
                .collect::<Vec<_>>(),
            gpu.files
                .iter()
                .map(|file| (&file.path, &file.sha256))
                .collect::<Vec<_>>()
        );
        value["runtimes"][1]["platforms"] = json!({"unsupported":archive});
        assert!(load_catalog_with_acceleration(&value.to_string(), true).is_err());
    }

    #[test]
    fn catalog_rejects_total_size_overflow() {
        let mut value = catalog();
        value["models"][0]["files"][0]["size"] = json!(u64::MAX);
        value["models"][0]["modelSize"] = json!(u64::MAX);
        value["models"][0]["downloadSize"] = json!(u64::MAX);
        assert!(load_catalog(&value.to_string()).is_err());
    }

    fn test_client() -> reqwest::blocking::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    fn http_sources(bodies: Vec<Vec<u8>>) -> (Vec<String>, thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let urls = (0..bodies.len())
            .map(|index| format!("http://{address}/{index}"))
            .collect();
        let worker = thread::spawn(move || {
            for body in bodies {
                let (mut connection, _) = server.accept().unwrap();
                let mut request = [0_u8; 4096];
                connection.read(&mut request).unwrap();
                write!(
                    connection,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                connection.write_all(&body).unwrap();
            }
        });
        (urls, worker)
    }

    #[test]
    fn mirror_fallback_discards_bad_bytes_and_only_retries_current_file() {
        let (urls, worker) = http_sources(vec![b"wrong".to_vec(), b"valid".to_vec()]);
        let directory = tempfile::tempdir().unwrap();
        let previous = directory.path().join("previous.onnx");
        fs::write(&previous, b"already verified").unwrap();
        let output = directory.path().join("model.onnx");
        let file = ModelFile {
            path: "model.onnx".into(),
            url: urls[0].clone(),
            mirrors: vec![urls[1].clone()],
            size: 5,
            sha256: format!("{:x}", Sha256::digest(b"valid")),
            ..ModelFile::default()
        };
        let mut restarts = 0;
        download_file(
            &test_client(),
            &file,
            &output,
            &AtomicBool::new(false),
            |bytes, _| {
                if bytes == 0 {
                    restarts += 1;
                }
            },
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(restarts, 2);
        assert_eq!(fs::read(output).unwrap(), b"valid");
        assert_eq!(fs::read(previous).unwrap(), b"already verified");
    }

    #[test]
    fn completed_file_cache_survives_failed_package_attempt_without_network_retry() {
        let (urls, worker) = http_sources(vec![b"verified weights".to_vec()]);
        let root = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir_in(root.path()).unwrap();
        let file = ModelFile {
            path: "model.onnx".into(),
            url: urls[0].clone(),
            size: 16,
            sha256: format!("{:x}", Sha256::digest(b"verified weights")),
            ..ModelFile::default()
        };
        let client = test_client();
        download_cached_file(
            &client,
            &file,
            &first.path().join("model.onnx"),
            root.path(),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        worker.join().unwrap();
        drop(first);
        let second = tempfile::tempdir_in(root.path()).unwrap();
        let output = second.path().join("model.onnx");
        let mut bytes = 0;
        download_cached_file(
            &client,
            &file,
            &output,
            root.path(),
            &AtomicBool::new(false),
            |count, origin| {
                bytes = count;
                assert!(origin.is_empty());
            },
        )
        .unwrap();
        assert_eq!(bytes, 16);
        assert_eq!(fs::read(output).unwrap(), b"verified weights");
    }

    #[test]
    fn stalled_source_falls_back_without_whole_download_deadline() {
        use std::net::TcpListener;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut first, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            first.read(&mut request).unwrap();
            first
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\na")
                .unwrap();
            let (mut second, _) = server.accept().unwrap();
            second.read(&mut request).unwrap();
            second
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvalid",
                )
                .unwrap();
        });
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let file = ModelFile {
            path: "model.onnx".into(),
            url: format!("http://{address}/stall"),
            mirrors: vec![format!("http://{address}/fallback")],
            size: 5,
            sha256: format!("{:x}", Sha256::digest(b"valid")),
            ..ModelFile::default()
        };
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("model.onnx");
        download_file(&client, &file, &output, &AtomicBool::new(false), |_, _| {}).unwrap();
        worker.join().unwrap();
        assert_eq!(fs::read(output).unwrap(), b"valid");
    }

    #[test]
    fn repairing_runtime_reuses_valid_installed_weights_but_rejects_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join("installed");
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("model.onnx"), b"verified weights").unwrap();
        let file = ModelFile {
            path: "model.onnx".into(),
            size: 16,
            sha256: format!("{:x}", Sha256::digest(b"verified weights")),
            ..ModelFile::default()
        };
        let first = directory.path().join("staging/model.onnx");
        assert!(reuse_installed_file(&installed, &file, &first, &AtomicBool::new(false)).unwrap());
        assert_eq!(fs::read(&first).unwrap(), b"verified weights");
        assert_eq!(
            fs::read(installed.join("model.onnx")).unwrap(),
            b"verified weights"
        );
        fs::write(installed.join("model.onnx"), b"corrupt").unwrap();
        let second = directory.path().join("new-staging/model.onnx");
        assert!(
            !reuse_installed_file(&installed, &file, &second, &AtomicBool::new(false)).unwrap()
        );
        assert!(!second.exists());
        assert_eq!(
            reuse_installed_file(&installed, &file, &second, &AtomicBool::new(true)).unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn cancellation_does_not_try_next_mirror_or_leave_partial_download() {
        let (urls, worker) = http_sources(vec![b"valid".to_vec()]);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("model.onnx");
        let file = ModelFile {
            path: "model.onnx".into(),
            url: urls[0].clone(),
            mirrors: vec!["http://127.0.0.1:1/never-requested".into()],
            size: 5,
            sha256: format!("{:x}", Sha256::digest(b"valid")),
            ..ModelFile::default()
        };
        let cancelled = AtomicBool::new(false);
        let mut sources = 0;
        let result = download_file(&test_client(), &file, &output, &cancelled, |bytes, _| {
            if bytes == 0 {
                sources += 1;
            } else {
                cancelled.store(true, Ordering::SeqCst);
            }
        });
        worker.join().unwrap();
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(sources, 1);
        assert!(!output.exists());
    }

    #[test]
    fn embedded_resources_are_hashed_and_excluded_from_download_total_and_sources() {
        let name = "f5-reference.txt";
        let data = embedded_file(name).unwrap();
        let file = ModelFile {
            path: "reference.txt".into(),
            url: "https://github.com/local-configuration".into(),
            size: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
            embedded: Some(name.into()),
            ..ModelFile::default()
        };
        let mut value = catalog();
        value["models"][0]["files"].as_array_mut().unwrap().push(json!({"path":file.path,"url":file.url,"size":file.size,"sha256":file.sha256,"embedded":name}));
        value["models"][0]["modelSize"] = json!(12 + file.size);
        let package = load_catalog(&value.to_string()).unwrap().remove(0);
        assert_eq!(package.download_size, 12);
        assert_eq!(download_sources(&package), ["https://huggingface.co"]);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("reference.txt");
        download_file(
            &test_client(),
            &file,
            &output,
            &AtomicBool::new(false),
            |_, _| panic!("embedded resources must never report network bytes"),
        )
        .unwrap();
        assert_eq!(fs::read(output).unwrap(), data);
        value["models"][0]["files"][3]["sha256"] = json!("0".repeat(64));
        assert!(load_catalog(&value.to_string()).is_err());
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
            ..ModelFile::default()
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
    fn download_source_tracks_only_the_current_network_operation() {
        let downloads = Mutex::new(Downloads {
            entries: HashMap::from([(
                "model".into(),
                Entry {
                    state: State::Downloading,
                    generation: 2,
                    ..Entry::default()
                },
            )]),
            ..Downloads::default()
        });
        let source = || {
            downloads.lock().unwrap().entries["model"]
                .download_source
                .clone()
        };
        update_source(&downloads, "model", 2, "https://modelscope.cn");
        update_source(&downloads, "model", 1, "https://huggingface.co");
        assert_eq!(source().as_deref(), Some("https://modelscope.cn"));

        // Local cache and installed-file reuse must not claim a network source.
        update_source(&downloads, "model", 2, "");
        assert!(source().is_none());
        update_source(&downloads, "model", 2, "https://hf-mirror.com");
        update(&downloads, "model", 2, State::Verifying, 100);
        assert!(source().is_none());

        update(&downloads, "model", 2, State::Downloading, 0);
        update_source(&downloads, "model", 2, "https://modelscope.cn");
        finished(
            &downloads,
            "model",
            2,
            Err("network unavailable".into()),
            100,
        );
        assert!(source().is_none());

        let cancelled = downloads.lock().unwrap().entries["model"].cancelled.clone();
        cancelled.store(true, Ordering::SeqCst);
        update_source(&downloads, "model", 2, "https://huggingface.co");
        assert!(source().is_none());
    }

    #[test]
    fn real_catalog_shares_three_models_between_male_and_female_voices() {
        let catalog =
            load_catalog_with_acceleration(include_str!("../resources/speech-models.json"), false)
                .unwrap();
        assert!(catalog
            .iter()
            .filter(|package| package.runtime_only)
            .all(|package| package.voices.is_empty()));
        let voice_packages: Vec<_> = catalog
            .iter()
            .filter(|package| !package.runtime_only)
            .collect();
        assert_eq!(voice_packages.len(), 3);
        assert!(voice_packages.iter().all(|package| package.voices.len() == 2));
        for package in &voice_packages {
            assert_eq!(package.voices[0].gender.as_deref(), Some("female"));
            assert_eq!(package.voices[1].gender.as_deref(), Some("male"));
            assert!(crate::speech::additional_voice_kind(&package.voices[1].id)
                .is_some_and(|kind| kind == package.model.kind));
        }
        for kind in [ModelKind::Zipvoice, ModelKind::F5, ModelKind::Qwen3] {
            assert_eq!(
                voice_packages
                    .iter()
                    .filter(|package| package.model.kind == kind)
                    .count(),
                1
            );
        }
        for package in voice_packages
            .iter()
            .filter(|package| package.model.kind != ModelKind::Zipvoice)
        {
            assert_eq!(package.runtime_id, "python-cpu-v1");
            assert!(package.fallback_runtime.is_none());
        }
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
            (
                r"\\server\共享 资源\tokens.txt",
                "//server/共享 资源/tokens.txt",
            ),
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
        fs::write(
            root.path().join("model/espeak-ng-data/phontab"),
            b"phonemes",
        )
        .unwrap();
        fs::write(root.path().join("model/number-zh.fst"), b"rules").unwrap();
        for (relative, directory) in [
            ("model/espeak-ng-data", true),
            ("model/number-zh.fst", false),
        ] {
            let validated = checked_path(root.path(), relative, directory).unwrap();
            let argument = engine_resource_path(&validated).unwrap();
            assert!(!argument.starts_with(r"\\?\"));
            assert_eq!(Path::new(&argument).canonicalize().unwrap(), validated);
            if directory {
                assert_eq!(
                    fs::read(format!("{argument}/phontab")).unwrap(),
                    b"phonemes"
                );
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
            native_cpu_fallback: None,
            python_cpu_fallback: None,
            root: bundled_root,
            executable: root.join("not-executed"),
            script: None,
            model: package.model.clone(),
            voices: Vec::new(),
        };
        (package, bundled)
    }

    fn installed_test_runtime(
        root: &Path,
        id: &str,
        install: bool,
    ) -> runtime_packages::SelectedRuntime {
        let files = [
            ("python/python.exe", b"interpreter".as_slice()),
            ("runner/tts.py", b"runner".as_slice()),
        ];
        let manifest = serde_json::to_vec(&json!({"schema":1,"files":files.iter().map(|(path, bytes)| json!({
            "path":path,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"executable":false
        })).collect::<Vec<_>>()})).unwrap();
        let archive: runtime_packages::RuntimeArchive = serde_json::from_value(json!({
            "url":"https://github.com/ecojust/open-media/releases/download/test/runtime.zip",
            "size":100,"unpackedSize":manifest.len()+files.iter().map(|(_,b)|b.len()).sum::<usize>(),
            "sha256":"a".repeat(64),"manifestSha256":format!("{:x}",Sha256::digest(&manifest)),
            "executable":"python/python.exe","script":"runner/tts.py"
        })).unwrap();
        let runtime = runtime_packages::SelectedRuntime {
            id: id.into(),
            version: 1,
            platform: runtime_packages::platform().into(),
            archive,
        };
        if install {
            let directory = runtime_packages::path(root, &runtime);
            for (path, bytes) in files {
                let file = directory.join(path);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, bytes).unwrap();
            }
            fs::write(directory.join("manifest.json"), manifest).unwrap();
        }
        runtime
    }

    #[test]
    fn gpu_upgrade_preserves_verified_cpu_voice_on_failure_cancel_and_switches_when_ready() {
        let parent = tempfile::tempdir().unwrap();
        let store = parent.path().join("store");
        fs::create_dir(&store).unwrap();
        // Exercise alias ancestors on Unix, including macOS /var -> /private/var.
        #[cfg(unix)]
        let store = {
            let alias = parent.path().join("store-alias");
            std::os::unix::fs::symlink(&store, &alias).unwrap();
            alias
        };
        let root = tempfile::tempdir_in(store).unwrap();
        let (mut package, bundled) = fixture_package(root.path());
        package.model.kind = ModelKind::F5;
        package.model.config = "model.onnx".into();
        package.runtime_id = "python-cuda-v1".into();
        package.runtime = Some(installed_test_runtime(root.path(), "python-cuda-v1", false));
        package.fallback_runtime = Some(installed_test_runtime(root.path(), "python-cpu-v1", true));
        let id = package.id.clone();
        let (cpu, stamps) = verify_package(
            &package,
            &package_path(root.path(), &package),
            Some(&bundled),
            &AtomicBool::new(false),
        )
        .unwrap();
        let cpu_directory = runtime_packages::path(
            root.path(),
            package.fallback_runtime.as_ref().unwrap(),
        )
        .canonicalize()
        .unwrap();
        assert!(cpu.executable.starts_with(&cpu_directory));
        let mut entry = Entry::default();
        entry.state = State::Ready;
        entry.runtime = Some(cpu.clone());
        entry.stamps = stamps;
        let manager = SpeechModels {
            catalog: Arc::new(vec![package.clone()]),
            // Match the production with_catalog constructor's normalized store.
            root: root.path().canonicalize().unwrap(),
            bundled: Ok(bundled),
            owner: Arc::new(Owner {
                downloads: Arc::new(Mutex::new(Downloads {
                    entries: HashMap::from([(id.clone(), entry)]),
                    ..Downloads::default()
                })),
            }),
        };
        assert_eq!(
            manager.voices()[0].runtime_status.as_deref(),
            Some("upgrade-available")
        );
        assert_eq!(manager.voices()[0].status.as_deref(), Some("ready"));
        update(&manager.owner.downloads, &id, 0, State::Downloading, 10);
        assert_eq!(
            manager.voices()[0].runtime_status.as_deref(),
            Some("upgrade-downloading")
        );
        assert_eq!(
            manager.runtime_for_voice("extra_voice").unwrap().executable,
            cpu.executable
        );
        update(&manager.owner.downloads, &id, 0, State::Verifying, 10);
        assert_eq!(
            manager.voices()[0].runtime_status.as_deref(),
            Some("upgrade-verifying")
        );
        finished(
            &manager.owner.downloads,
            &id,
            0,
            Err("组件下载失败".into()),
            100,
        );
        assert_eq!(
            manager.voices()[0].runtime_status.as_deref(),
            Some("upgrade-failed")
        );
        assert_eq!(
            manager.runtime_for_voice("extra_voice").unwrap().executable,
            cpu.executable
        );
        update(&manager.owner.downloads, &id, 0, State::Downloading, 10);
        manager.cancel(&id).unwrap();
        finished(&manager.owner.downloads, &id, 0, Err(CANCELLED.into()), 100);
        assert_eq!(
            manager.voices()[0].runtime_status.as_deref(),
            Some("upgrade-available")
        );
        assert_eq!(
            manager.runtime_for_voice("extra_voice").unwrap().executable,
            cpu.executable
        );
        installed_test_runtime(root.path(), "python-cuda-v1", true);
        let gpu = manager.runtime_for_voice("extra_voice").unwrap();
        let gpu_directory = runtime_packages::path(root.path(), package.runtime.as_ref().unwrap())
            .canonicalize()
            .unwrap();
        assert!(gpu.executable.starts_with(&gpu_directory));
        assert!(!gpu.executable.starts_with(&cpu_directory));
        assert!(!cpu.executable.starts_with(&gpu_directory));
        assert_eq!(manager.voices()[0].runtime_status.as_deref(), Some("ready"));
        let fallback = gpu
            .python_cpu_fallback
            .as_ref()
            .expect("verified CPU runtime is available for loader failures");
        assert_eq!(fallback.executable, cpu.executable);
        assert_eq!(fallback.script, cpu.script.clone().unwrap());
        fs::write(&fallback.executable, b"corrupt fallback executable").unwrap();
        assert_eq!(manager.voices()[0].status.as_deref(), Some("ready"));
        let still_gpu = manager.runtime_for_voice("extra_voice").unwrap();
        assert_eq!(still_gpu.executable, gpu.executable);
        assert!(still_gpu.python_cpu_fallback.is_none());
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
            Some(&bundled),
            &cancelled,
        )
        .unwrap();
        assert!(
            Path::new(&runtime.model.data_dir).ends_with(Path::new("model").join("espeak-ng-data"))
        );
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
    fn explicit_repair_rechecks_ready_resources_and_reuses_local_files() {
        let root = tempfile::tempdir().unwrap();
        let (mut package, bundled) = fixture_package(root.path());
        let bytes = embedded_file("f5-reference.txt").unwrap();
        let installed = package_path(root.path(), &package);
        for file in &mut package.files {
            file.embedded = Some("f5-reference.txt".into());
            file.size = bytes.len() as u64;
            file.sha256 = format!("{:x}", Sha256::digest(bytes));
            fs::write(installed.join(&file.path), bytes).unwrap();
        }
        package.model_size = bytes.len() as u64 * package.files.len() as u64;
        package.download_size = 0;
        let (runtime, stamps) = verify_package(
            &package,
            &installed,
            Some(&bundled),
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut entry = Entry::default();
        entry.state = State::Ready;
        entry.runtime = Some(runtime);
        entry.stamps = stamps;
        let id = package.id.clone();
        let manager = SpeechModels {
            catalog: Arc::new(vec![package]),
            root: root.path().into(),
            bundled: Ok(bundled),
            owner: Arc::new(Owner {
                downloads: Arc::new(Mutex::new(Downloads {
                    entries: HashMap::from([(id.clone(), entry)]),
                    ..Downloads::default()
                })),
            }),
        };
        let changed = installed.join("model.onnx");
        let modified = fs::metadata(&changed).unwrap().modified().unwrap();
        fs::write(&changed, vec![b'x'; bytes.len()]).unwrap();
        // Windows requires a write-capable handle to restore file timestamps.
        OpenOptions::new()
            .write(true)
            .open(&changed)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert!(stamps_unchanged(
            &manager.owner.downloads.lock().unwrap().entries[&id].stamps
        ));
        manager.begin(&id).unwrap();
        assert_eq!(
            manager.owner.downloads.lock().unwrap().entries[&id].generation,
            0
        );
        manager.repair(&id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.owner.downloads.lock().unwrap().workers > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let state = manager.owner.downloads.lock().unwrap();
        let entry = &state.entries[&id];
        assert_eq!(entry.generation, 1);
        assert_eq!(entry.state.name(), "ready", "{:?}", entry.error);
        assert_eq!(state.workers, 0);
        assert_eq!(fs::read(changed).unwrap(), bytes);
    }

    #[test]
    fn successful_install_relocates_verified_paths_without_stale_staging_entries() {
        let root = tempfile::tempdir().unwrap();
        let (mut package, bundled) = fixture_package(root.path());
        remove_package(&package_path(root.path(), &package)).unwrap();
        let bytes = embedded_file("f5-reference.txt").unwrap();
        for file in &mut package.files {
            file.embedded = Some("f5-reference.txt".into());
            file.size = bytes.len() as u64;
            file.sha256 = format!("{:x}", Sha256::digest(bytes));
        }
        package.model_size = bytes.len() as u64 * package.files.len() as u64;
        package.download_size = 0;
        let cancelled = Arc::new(AtomicBool::new(false));
        let downloads = Mutex::new(Downloads {
            entries: HashMap::from([(
                package.id.clone(),
                Entry {
                    state: State::Downloading,
                    cancelled: cancelled.clone(),
                    ..Entry::default()
                },
            )]),
            ..Downloads::default()
        });
        let (runtime, stamps) = download_package(
            &package,
            root.path(),
            Some(&bundled),
            &cancelled,
            &downloads,
            0,
        )
        .unwrap();
        assert_eq!(
            runtime.root,
            package_path(root.path(), &package).canonicalize().unwrap()
        );
        assert!(stamps_unchanged(&stamps));
        assert!(stamps
            .iter()
            .all(|stamp| stamp.path.starts_with(&runtime.root)));
        assert_eq!(
            downloads.lock().unwrap().entries[&package.id].state.name(),
            "ready"
        );
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".download-")));
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
            runtime_stamps: HashMap::new(),
        };
        let state = Mutex::new(state);
        let verified = verify_package(
            &package,
            &package_path(root.path(), &package),
            Some(&bundled),
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
        let manager = SpeechModels::with_catalog(
            data.path(),
            Err("test bundle unavailable".into()),
            load_catalog(&catalog().to_string()).unwrap(),
        )
        .unwrap();
        assert!(staging.join("partial-model.onnx").is_file());
        drop(manager);
        drop(held);
        let _manager = SpeechModels::with_catalog(
            data.path(),
            Err("test bundle unavailable".into()),
            load_catalog(&catalog().to_string()).unwrap(),
        )
        .unwrap();
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
