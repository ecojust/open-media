//! Content-addressed, opt-in model installation, independent of editor projects.
use crate::{engine::Result, speech_models::runtime_packages};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const CANCELLED: &str = "AI 操作已取消。";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub engine: String,
    pub version: String,
    pub runtime_id: String,
    pub modes: Vec<String>,
    pub license: License,
    pub hardware: String,
    pub files: Vec<ModelFile>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct License {
    pub name: String,
    pub url: String,
    pub notice: String,
}
#[derive(Clone, Deserialize)]
pub(crate) struct ModelFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub urls: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    models: Vec<Model>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runtimes {
    schema_version: u32,
    runtimes: Vec<runtime_packages::RuntimeDefinition>,
}

pub(crate) fn catalogs() -> Result<Vec<Model>> {
    let mut models = Vec::new();
    for text in [
        include_str!("../resources/ai-image-models.json"),
        include_str!("../resources/ai-music-models.json"),
    ] {
        let catalog: Catalog =
            serde_json::from_str(text).map_err(|e| format!("AI 模型清单无效：{e}"))?;
        if catalog.schema_version != 1 {
            return Err("AI 模型清单版本不受支持。".into());
        }
        models.extend(catalog.models);
    }
    validate_models(&models)?;
    Ok(models)
}
pub(crate) fn runtimes() -> Result<Vec<runtime_packages::RuntimeDefinition>> {
    let catalog: Runtimes =
        serde_json::from_str(include_str!("../resources/ai-runtime-models.json"))
            .map_err(|e| format!("AI 运行环境清单无效：{e}"))?;
    if catalog.schema_version != 1 {
        return Err("AI 运行环境清单版本不受支持。".into());
    }
    runtime_packages::validate(&catalog.runtimes)?;
    Ok(catalog.runtimes)
}
fn validate_models(models: &[Model]) -> Result<()> {
    let mut ids = HashSet::new();
    for model in models {
        if !safe_id(&model.id)
            || !safe_id(&model.version)
            || !safe_id(&model.runtime_id)
            || !ids.insert(&model.id)
            || !matches!(
                (model.kind.as_str(), model.engine.as_str()),
                ("image", "diffusers") | ("music", "ace-step")
            )
            || model.modes.is_empty()
            || model.files.is_empty()
            || model.files.len() > 2000
            || model.name.trim().is_empty()
            || model.license.name.trim().is_empty()
            || !https_url(&model.license.url)
        {
            return Err("AI 模型定义无效。".into());
        }
        let mut paths = HashSet::new();
        for file in &model.files {
            if !safe_relative(&file.path)
                || !paths.insert(file.path.to_lowercase())
                || file.size == 0
                || file.size > 200_000_000_000
                || !valid_hash(&file.sha256)
                || file.urls.is_empty()
                || file.urls.len() > 8
                || file.urls.iter().any(|url| !https_url(url))
            {
                return Err(format!("AI 模型 {} 文件清单无效。", model.id));
            }
            if matches!(
                Path::new(&file.path).extension().and_then(|s| s.to_str()),
                Some("py" | "pyc" | "pyd" | "dll" | "dylib" | "so" | "exe")
            ) {
                return Err("模型文件不能包含可执行推理代码。".into());
            }
        }
    }
    Ok(())
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn https_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

#[derive(Clone, Serialize, Deserialize)]
struct Stamp {
    size: u64,
    modified: u128,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    sha256: String,
    stamp: Stamp,
}
#[derive(Serialize, Deserialize)]
struct Installed {
    schema: u32,
    fingerprint: String,
    files: HashMap<String, Stamp>,
    accepted_license_at: u64,
}
fn stamp(path: &Path) -> Result<Stamp> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("模型文件必须是普通文件。".into());
    }
    Ok(Stamp {
        size: meta.len(),
        modified: meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
    })
}
fn matches_stamp(a: &Stamp, b: &Stamp) -> bool {
    a.size == b.size && a.modified == b.modified
}
fn fingerprint(model: &Model) -> String {
    let mut hash = Sha256::new();
    hash.update(model.id.as_bytes());
    hash.update(model.version.as_bytes());
    hash.update(model.runtime_id.as_bytes());
    for file in &model.files {
        hash.update(file.path.as_bytes());
        hash.update(file.sha256.as_bytes());
        hash.update(file.size.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub(crate) fn model_root(root: &Path, model: &Model) -> PathBuf {
    root.join("models").join(&model.id).join(&model.version)
}
pub(crate) fn installed_ready(root: &Path, model: &Model) -> bool {
    let root = model_root(root, model);
    let Ok(installed) = read_json::<Installed>(&root.join("installed.json")) else {
        return false;
    };
    installed.schema == 1
        && installed.accepted_license_at > 0
        && installed.fingerprint == fingerprint(model)
        && installed.files.len() == model.files.len()
        && model.files.iter().all(|file| {
            let path = root.join(&file.path);
            checked_file(&root, &path).is_ok()
                && installed.files.get(&file.path).is_some_and(|expected| {
                    expected.size == file.size
                        && stamp(&path).is_ok_and(|actual| matches_stamp(&actual, expected))
                })
        })
}
fn blob(root: &Path, file: &ModelFile) -> PathBuf {
    root.join("blobs").join(&file.sha256)
}
fn partial(root: &Path, file: &ModelFile) -> PathBuf {
    root.join("parts").join(format!("{}.part", file.sha256))
}
fn receipt(root: &Path, file: &ModelFile) -> PathBuf {
    root.join("blobs")
        .join(format!("{}.verified.json", file.sha256))
}
fn cached(root: &Path, file: &ModelFile) -> bool {
    let path = blob(root, file);
    if checked_file(&root.join("blobs"), &path).is_err() {
        return false;
    }
    let Ok(receipt) = read_json::<Receipt>(&receipt(root, file)) else {
        return false;
    };
    receipt.sha256 == file.sha256
        && receipt.stamp.size == file.size
        && stamp(&path).is_ok_and(|actual| matches_stamp(&actual, &receipt.stamp))
}
pub(crate) fn cached_bytes(root: &Path, model: &Model) -> u64 {
    let mut seen = HashSet::new();
    model
        .files
        .iter()
        .filter(|f| seen.insert(&f.sha256))
        .map(|file| {
            if cached(root, file) {
                file.size
            } else {
                stamp(&partial(root, file)).map_or(0, |s| s.size.min(file.size))
            }
        })
        .sum()
}
pub(crate) fn model_size(model: &Model) -> u64 {
    let mut seen = HashSet::new();
    model
        .files
        .iter()
        .filter(|f| seen.insert(&f.sha256))
        .map(|f| f.size)
        .sum()
}
pub(crate) fn http_client() -> Result<reqwest::blocking::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 10 || a.url().scheme() != "https" {
                a.error("下载跳转不受支持")
            } else {
                a.follow()
            }
        }))
        .user_agent("Open-Media-AI-Models")
        .build()
        .map_err(|e| e.to_string())
}
#[cfg(test)]
pub(crate) fn install_model(
    root: &Path,
    model: &Model,
    cancelled: &AtomicBool,
    progress: impl FnMut(&str, u64),
) -> Result<()> {
    install_model_with_source(root, model, cancelled, progress, |_| {})
}

pub(crate) fn install_model_with_source(
    root: &Path,
    model: &Model,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
    mut source: impl FnMut(&str),
) -> Result<()> {
    let client = http_client()?;
    let size = model_size(model);
    require_space(
        root,
        size.saturating_sub(cached_bytes(root, model))
            .saturating_add(512 * 1024 * 1024),
    )?;
    let mut seen = HashSet::new();
    let mut completed = 0;
    for file in model.files.iter().filter(|f| seen.insert(&f.sha256)) {
        check_cancelled(cancelled)?;
        ensure_blob_with_source(
            root,
            &client,
            file,
            cancelled,
            |bytes, verifying| {
                progress(
                    if verifying {
                        "verifying"
                    } else {
                        "downloading"
                    },
                    completed + bytes,
                )
            },
            &mut source,
        )?;
        completed += file.size;
    }
    let parent = safe_directory(root, &format!("models/{}", model.id))?;
    let staging = tempfile::Builder::new()
        .prefix("install-")
        .tempdir_in(&parent)
        .map_err(|e| e.to_string())?;
    let mut stamps = HashMap::new();
    for file in &model.files {
        check_cancelled(cancelled)?;
        if !cached(root, file) {
            return Err("模型缓存已改变，请重新下载以校验修复。".into());
        }
        if let Some(parent) = Path::new(&file.path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            safe_directory(staging.path(), &parent.to_string_lossy())?;
        }
        let destination = staging.path().join(&file.path);
        fs::hard_link(blob(root, file), &destination)
            .map_err(|e| format!("模型保存目录需要支持硬链接以共享权重：{e}"))?;
        stamps.insert(file.path.clone(), stamp(&destination)?);
    }
    fs::write(
        staging.path().join("MODEL-NOTICE.txt"),
        format!(
            "{}\n{}\n{}",
            model.license.name, model.license.url, model.license.notice
        ),
    )
    .map_err(|e| e.to_string())?;
    write_json(
        &staging.path().join("installed.json"),
        &Installed {
            schema: 1,
            fingerprint: fingerprint(model),
            files: stamps,
            accepted_license_at: now_ms(),
        },
    )?;
    check_cancelled(cancelled)?;
    let destination = model_root(root, model);
    let backup = parent.join(format!("replaced-{}", crate::engine::new_id()));
    let replacing = destination.exists();
    if replacing {
        checked_directory(&destination)?;
        fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(staging.path(), &destination) {
        if replacing {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(format!("无法完成模型安装：{error}"));
    }
    if replacing {
        let _ = fs::remove_dir_all(backup);
    }
    progress("ready", size);
    Ok(())
}

pub(crate) fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 500
        && !path.contains(['\\', ':', '\0'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}
pub(crate) fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && !id.starts_with('.')
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
pub(crate) fn checked_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("AI 工作目录必须是普通目录。".into());
    }
    Ok(())
}
pub(crate) fn safe_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    if !safe_relative(relative) {
        return Err("AI 工作目录路径无效。".into());
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
pub(crate) fn checked_file(root: &Path, path: &Path) -> Result<()> {
    if !path.starts_with(root) || root.canonicalize().map_err(|e| e.to_string())? != root {
        return Err("AI 文件目录已改变。".into());
    }
    checked_directory(root)?;
    let mut current = root.to_owned();
    for part in path
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
    {
        if !matches!(part, Component::Normal(_)) {
            return Err("AI 文件路径无效。".into());
        }
        current.push(part);
        if fs::symlink_metadata(&current)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("AI 模型及输出文件不能是符号链接。".into());
        }
    }
    if !path.is_file() {
        return Err("AI 文件不存在。".into());
    }
    Ok(())
}
pub(crate) fn operation_lock(root: &Path) -> Result<File> {
    checked_directory(root)?;
    let path = root.join("installation.lock");
    if path.exists() {
        checked_file(root, &path)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "另一个应用窗口正在安装 AI 模型，请稍后重试。")?;
    Ok(file)
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("保存路径无效。")?;
    checked_directory(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(temp.as_file_mut(), value).map_err(|e| e.to_string())?;
    temp.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16 * 1024 * 1024 {
        return Err("AI 状态文件无效。".into());
    }
    serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub(crate) fn check_cancelled(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn require_space(root: &Path, needed: u64) -> Result<()> {
    #[cfg(windows)]
    let available = {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDiskFreeSpaceExW(
                path: *const u16,
                free: *mut u64,
                total: *mut u64,
                all_free: *mut u64,
            ) -> i32;
        }
        let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("无法检查模型目录的可用空间。".into());
        }
        free
    };
    #[cfg(not(windows))]
    let available = {
        let output = Command::new("/bin/df")
            .arg("-Pk")
            .arg(root)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("无法检查模型目录的可用空间。".into());
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .skip(1)
            .last()
            .and_then(|line| line.split_whitespace().nth(3))
            .and_then(|v| v.parse::<u64>().ok())
            .and_then(|v| v.checked_mul(1024))
            .ok_or("无法读取磁盘剩余空间。")?
    };
    if available < needed {
        return Err(format!(
            "磁盘空间不足，还需要 {:.1} GB，可用 {:.1} GB。",
            needed as f64 / 1e9,
            available as f64 / 1e9
        ));
    }
    Ok(())
}
fn hash_file(path: &Path, cancelled: &AtomicBool) -> Result<Sha256> {
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash)
}
fn remember_blob(root: &Path, file: &ModelFile) -> Result<()> {
    write_json(
        &receipt(root, file),
        &Receipt {
            sha256: file.sha256.clone(),
            stamp: stamp(&blob(root, file))?,
        },
    )
}

#[cfg(test)]
pub(crate) fn ensure_blob(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    cancelled: &AtomicBool,
    progress: impl FnMut(u64, bool),
) -> Result<()> {
    ensure_blob_with_source(root, client, file, cancelled, progress, |_| {})
}

pub(crate) fn ensure_blob_with_source(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, bool),
    mut source: impl FnMut(&str),
) -> Result<()> {
    safe_directory(root, "blobs")?;
    safe_directory(root, "parts")?;
    if cached(root, file) {
        progress(file.size, false);
        return Ok(());
    }
    let final_path = blob(root, file);
    let part = partial(root, file);
    if final_path.exists() {
        checked_file(&root.join("blobs"), &final_path)?;
        progress(file.size, true);
        if stamp(&final_path)?.size == file.size
            && format!("{:x}", hash_file(&final_path, cancelled)?.finalize()) == file.sha256
        {
            remember_blob(root, file)?;
            return Ok(());
        }
        fs::remove_file(&final_path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(receipt(root, file));
    }
    let mut failures = Vec::new();
    // Retry each pinned source, retaining only size-bounded partial files. A full
    // SHA-256 verification is mandatory before any partial becomes executable data.
    for attempt in 0..3 {
        for url in &file.urls {
            check_cancelled(cancelled)?;
            let result = download_attempt_with_source(
                root,
                client,
                file,
                url,
                cancelled,
                &mut progress,
                &mut source,
            );
            match result {
                Ok(()) => {
                    check_cancelled(cancelled)?;
                    fs::rename(&part, &final_path)
                        .map_err(|e| format!("无法保存已验证模型文件：{e}"))?;
                    remember_blob(root, file)?;
                    return Ok(());
                }
                Err(error) => {
                    if cancelled.load(Ordering::SeqCst) {
                        return Err(CANCELLED.into());
                    }
                    failures.push(error);
                }
            }
        }
        if attempt < 2 {
            for _ in 0..(10 * (attempt + 1)) {
                check_cancelled(cancelled)?;
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "模型文件 {} 下载失败，已保留可续传数据：{}",
        file.path,
        failures.last().map(String::as_str).unwrap_or("网络不可用")
    ))
}

#[cfg(test)]
fn download_attempt(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    url: &str,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(u64, bool),
) -> Result<()> {
    download_attempt_with_source(root, client, file, url, cancelled, progress, &mut |_| {})
}

fn download_attempt_with_source(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    url: &str,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(u64, bool),
    source: &mut impl FnMut(&str),
) -> Result<()> {
    let part = partial(root, file);
    let mut offset = if part.exists() {
        checked_file(&root.join("parts"), &part)?;
        stamp(&part)?.size
    } else {
        0
    };
    if offset > file.size {
        fs::remove_file(&part).map_err(|e| e.to_string())?;
        offset = 0;
    }
    let mut hash = if offset > 0 {
        progress(offset, true);
        hash_file(&part, cancelled)?
    } else {
        Sha256::new()
    };
    if offset == file.size {
        if format!("{:x}", hash.finalize()) == file.sha256 {
            progress(offset, true);
            return Ok(());
        }
        fs::remove_file(&part).map_err(|e| e.to_string())?;
        return Err("断点文件完整性校验失败，将重新下载。".into());
    }
    check_cancelled(cancelled)?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    source(url);
    let mut response = request.send().map_err(|e| {
        if e.is_timeout() {
            "模型下载连接超时。".to_owned()
        } else {
            "模型下载连接失败。".to_owned()
        }
    })?;
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let header = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .ok_or("续传响应缺少范围信息。")?;
        validate_content_range(header, offset, file.size)?;
    } else if response.status() == reqwest::StatusCode::OK {
        // Some CDNs ignore Range; restart safely instead of appending two files.
        offset = 0;
        hash = Sha256::new();
    } else {
        return Err(format!(
            "模型下载返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != file.size - offset)
    {
        return Err("下载响应大小与锁定的模型大小不符。".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(&part)
        .map_err(|e| format!("无法保存模型断点：{e}"))?;
    let mut total = offset;
    let mut last = Instant::now();
    let mut buffer = vec![0; 1024 * 1024];
    progress(total, false);
    loop {
        check_cancelled(cancelled)?;
        let size = response
            .read(&mut buffer)
            .map_err(|_| "模型下载中断或超时，将尝试续传。")?;
        if size == 0 {
            break;
        }
        total = total
            .checked_add(size as u64)
            .ok_or("下载文件超出大小上限。")?;
        if total > file.size {
            return Err("下载文件超出清单中的大小上限。".into());
        }
        output
            .write_all(&buffer[..size])
            .map_err(|e| format!("模型写入失败：{e}"))?;
        hash.update(&buffer[..size]);
        if last.elapsed() >= Duration::from_millis(200) {
            progress(total, false);
            last = Instant::now();
        }
    }
    output.sync_all().map_err(|e| e.to_string())?;
    check_cancelled(cancelled)?;
    progress(total, true);
    if total != file.size {
        return Err("下载文件尚未完整，将继续续传。".into());
    }
    if format!("{:x}", hash.finalize()) != file.sha256 {
        drop(output);
        fs::remove_file(&part).map_err(|e| e.to_string())?;
        return Err("模型 SHA-256 校验失败，已清理损坏文件。".into());
    }
    Ok(())
}
fn validate_content_range(header: &str, offset: u64, size: u64) -> Result<()> {
    let (range, total) = header
        .strip_prefix("bytes ")
        .and_then(|s| s.split_once('/'))
        .ok_or("模型续传范围格式无效。")?;
    let (start, end) = range.split_once('-').ok_or("模型续传范围格式无效。")?;
    if start.parse::<u64>().ok() != Some(offset)
        || end.parse::<u64>().ok() != Some(size - 1)
        || total.parse::<u64>().ok() != Some(size)
    {
        return Err("模型续传范围与已保存断点不一致。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn directories() -> (tempfile::TempDir, PathBuf) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for name in ["blobs", "parts", "models"] {
            safe_directory(&root, name).unwrap();
        }
        (temp, root)
    }
    fn tiny_file(data: &[u8]) -> ModelFile {
        ModelFile {
            path: "model/data.safetensors".into(),
            size: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
            urls: vec!["https://example.invalid/locked".into()],
        }
    }
    fn response(
        body: Vec<u8>,
        status: &str,
        range: Option<String>,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let task = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while stream.read(&mut byte).unwrap() > 0 {
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
                status,
                body.len(),
                range
                    .map(|v| format!("Content-Range: {v}\r\n"))
                    .unwrap_or_default()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/file"), task)
    }
    #[test]
    fn catalog_files_are_locked_and_shared_weights_have_identical_hashes() {
        let catalog = catalogs().unwrap();
        assert!(catalog.len() >= 4);
        let music: Vec<_> = catalog.iter().filter(|m| m.kind == "music").collect();
        let mut hashes: HashMap<&str, (&str, u64)> = HashMap::new();
        for model in music {
            for file in &model.files {
                if file.path.starts_with("vae/") || file.path.starts_with("Qwen3-Embedding") {
                    if let Some((sha, size)) = hashes.insert(&file.path, (&file.sha256, file.size))
                    {
                        assert_eq!(sha, file.sha256);
                        assert_eq!(size, file.size);
                    }
                }
            }
        }
    }
    #[test]
    fn resume_validates_ranges_and_keeps_exact_file_bytes() {
        let (_temp, root) = directories();
        let data = b"verified-model-data";
        let file = tiny_file(data);
        fs::write(partial(&root, &file), &data[..5]).unwrap();
        let (url, server) = response(
            data[5..].to_vec(),
            "206 Partial Content",
            Some(format!("bytes 5-{}/{}", data.len() - 1, data.len())),
        );
        let client = reqwest::blocking::Client::builder().build().unwrap();
        download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), data);
        assert!(server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=5-"));
        assert!(validate_content_range("bytes 4-18/19", 5, 19).is_err());
    }
    #[test]
    fn streaming_download_can_outlast_the_per_read_timeout() {
        let (_temp, root) = directories();
        let data = b"verified-model-data";
        let file = tiny_file(data);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nodelay(true).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while stream.read(&mut byte).unwrap() > 0 {
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len()
            )
            .unwrap();
            for byte in data {
                stream.write_all(&[*byte]).unwrap();
                thread::sleep(Duration::from_millis(80));
            }
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
            .unwrap();
        let started = Instant::now();
        download_attempt(
            &root,
            &client,
            &file,
            &format!("http://{address}/model"),
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert!(started.elapsed() > Duration::from_secs(1));
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), data);
        server.join().unwrap();
    }
    #[test]
    fn ignored_range_restarts_instead_of_appending_and_wrong_hash_is_removed() {
        let (_temp, root) = directories();
        let data = b"verified-model-data";
        let file = tiny_file(data);
        fs::write(partial(&root, &file), &data[..5]).unwrap();
        let (url, server) = response(data.to_vec(), "200 OK", None);
        let client = reqwest::blocking::Client::builder().build().unwrap();
        download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), data);
        fs::remove_file(partial(&root, &file)).unwrap();
        let (url, server) = response(vec![b'x'; data.len()], "200 OK", None);
        assert!(download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {}
        )
        .is_err());
        server.join().unwrap();
        assert!(!partial(&root, &file).exists());
        assert!(!cached(&root, &file));
    }
    #[test]
    fn model_install_is_atomic_and_changed_files_require_repair() {
        let (_temp, root) = directories();
        let data = b"verified-model-data";
        let file = tiny_file(data);
        fs::write(partial(&root, &file), data).unwrap();
        ensure_blob(
            &root,
            &reqwest::blocking::Client::new(),
            &file,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        let mut model = catalogs().unwrap().remove(0);
        model.files = vec![file.clone()];
        install_model(&root, &model, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(installed_ready(&root, &model));
        fs::write(model_root(&root, &model).join(&file.path), b"changed").unwrap();
        assert!(!installed_ready(&root, &model));
        assert!(!cached(&root, &file));
        assert!(install_model(&root, &model, &AtomicBool::new(true), |_, _| {}).is_err());
    }
    #[test]
    fn unsafe_paths_and_executable_model_files_are_rejected() {
        for path in [
            "../escape",
            "/root/model",
            "a/../../b",
            "C:/model",
            "a\\b",
            "a//b",
        ] {
            assert!(!safe_relative(path));
        }
        let mut models = catalogs().unwrap();
        models[0].files[0].path = "runner.py".into();
        assert!(validate_models(&models).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symbolic_link_cache_or_model_paths_are_rejected() {
        use std::os::unix::fs::symlink;
        let (_temp, root) = directories();
        let other = tempfile::tempdir().unwrap();
        symlink(other.path(), root.join("models/link")).unwrap();
        assert!(safe_directory(&root, "models/link/child").is_err());
        fs::write(other.path().join("data"), b"test").unwrap();
        symlink(other.path().join("data"), root.join("blobs/link")).unwrap();
        assert!(checked_file(&root, &root.join("blobs/link")).is_err());
    }
}

#[cfg(test)]
include!("model_download_fallback_tests.rs");
