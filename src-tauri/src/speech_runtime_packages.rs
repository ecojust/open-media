//! Verified, relocatable inference runtimes shared by downloaded voice models.
use super::*;
use serde::Serialize;
use std::process::{Command, Stdio};

const MANIFEST_LIMIT: u64 = 16 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 100_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeArchive {
    pub url: String,
    #[serde(default)]
    pub mirrors: Vec<String>,
    pub size: u64,
    pub unpacked_size: u64,
    pub sha256: String,
    pub manifest_sha256: String,
    pub executable: String,
    pub script: String,
}

#[derive(Clone, Deserialize)]
pub(super) struct RuntimeDefinition {
    pub id: String,
    pub version: u32,
    pub platforms: HashMap<String, RuntimeArchive>,
}

#[derive(Clone)]
pub(super) struct SelectedRuntime {
    pub id: String,
    pub version: u32,
    pub platform: String,
    pub archive: RuntimeArchive,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFile {
    path: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    executable: bool,
}

#[derive(Deserialize, Serialize)]
struct RuntimeManifest {
    schema: u32,
    files: Vec<RuntimeFile>,
}

pub(super) fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        ("windows", "x86_64") => "windows-x64",
        ("linux", "x86_64") => "linux-x64",
        _ => "unsupported",
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn validate(definitions: &[RuntimeDefinition]) -> Result<()> {
    let mut ids = HashSet::new();
    if definitions.len() > 16 {
        return Err("音色运行环境清单过大。".into());
    }
    for definition in definitions {
        if !valid_id(&definition.id)
            || definition.version == 0
            || !ids.insert(&definition.id)
            || definition.platforms.is_empty()
            || definition.platforms.len() > 8
        {
            return Err("音色运行环境配置无效。".into());
        }
        for (platform, archive) in &definition.platforms {
            let url = reqwest::Url::parse(&archive.url).map_err(|_| "运行环境下载地址无效。")?;
            if !matches!(
                platform.as_str(),
                "macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64"
            ) || !allowed_url(&url)
                || archive.mirrors.len() > 8
                || archive.mirrors.iter().any(|source| {
                    reqwest::Url::parse(source).map_or(true, |url| !allowed_url(&url))
                })
                || archive.size == 0
                || archive.size > 8 * 1024 * 1024 * 1024
                || archive.unpacked_size == 0
                || archive.unpacked_size > 24 * 1024 * 1024 * 1024
                || !valid_hash(&archive.sha256)
                || !valid_hash(&archive.manifest_sha256)
                || !safe_relative(&archive.executable)
                || !safe_relative(&archive.script)
            {
                return Err("音色运行环境文件配置无效。".into());
            }
        }
    }
    Ok(())
}

pub(super) fn select(
    id: &str,
    definitions: &[RuntimeDefinition],
) -> Result<Option<SelectedRuntime>> {
    if id.is_empty() {
        return Ok(None);
    }
    let definition = definitions
        .iter()
        .find(|item| item.id == id)
        .ok_or("音色引用了不存在的运行环境。")?;
    Ok(definition
        .platforms
        .get(platform())
        .map(|archive| SelectedRuntime {
            id: definition.id.clone(),
            version: definition.version,
            platform: platform().into(),
            archive: archive.clone(),
        }))
}

pub(super) fn path(root: &Path, runtime: &SelectedRuntime) -> PathBuf {
    root.join(format!(
        "runtime-{}-v{}-{}",
        runtime.id, runtime.version, runtime.platform
    ))
}

fn manifest(
    root: &Path,
    archive: &RuntimeArchive,
    cancelled: &AtomicBool,
) -> Result<RuntimeManifest> {
    let manifest_path = checked_path(root, "manifest.json", false)?;
    let size = fs::metadata(&manifest_path)
        .map_err(|e| e.to_string())?
        .len();
    if size == 0 || size > MANIFEST_LIMIT {
        return Err("音色运行环境清单大小无效。".into());
    }
    hash_file(
        &manifest_path,
        &ModelFile {
            path: "manifest.json".into(),
            url: String::new(),
            size,
            sha256: archive.manifest_sha256.clone(),
            ..ModelFile::default()
        },
        cancelled,
    )?;
    let manifest: RuntimeManifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|_| "音色运行环境清单无法读取。")?;
    if manifest.schema != 1 || manifest.files.is_empty() || manifest.files.len() > MAX_RUNTIME_FILES
    {
        return Err("音色运行环境清单不受支持。".into());
    }
    let mut paths = HashSet::new();
    let mut total = size;
    for file in &manifest.files {
        if !safe_relative(&file.path)
            || file.path.eq_ignore_ascii_case("manifest.json")
            || !valid_hash(&file.sha256)
            || !paths.insert(file.path.to_lowercase())
        {
            return Err("音色运行环境包含无效文件。".into());
        }
        total = total
            .checked_add(file.size)
            .ok_or("运行环境文件大小溢出。")?;
    }
    if total != archive.unpacked_size
        || !paths.contains(&archive.executable.to_lowercase())
        || !paths.contains(&archive.script.to_lowercase())
    {
        return Err("音色运行环境文件不完整。".into());
    }
    Ok(manifest)
}

pub(super) fn verify(
    root: &Path,
    runtime: &SelectedRuntime,
    cancelled: &AtomicBool,
) -> Result<Vec<FileStamp>> {
    let metadata = fs::symlink_metadata(root).map_err(|_| "音色运行环境未安装，请重新下载。")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("音色运行环境目录无效。".into());
    }
    let manifest = manifest(root, &runtime.archive, cancelled)?;
    let mut stamps = Vec::with_capacity(manifest.files.len() + 1);
    let manifest_path = checked_path(root, "manifest.json", false)?;
    let metadata = fs::metadata(&manifest_path).map_err(|e| e.to_string())?;
    stamps.push(FileStamp {
        path: manifest_path,
        size: metadata.len(),
        modified: metadata.modified().ok(),
        defer_display_check: false,
    });
    for file in manifest.files {
        let path = checked_path(root, &file.path, false)?;
        let mut stamp = hash_file(
            &path,
            &ModelFile {
                path: file.path.clone(),
                url: String::new(),
                size: file.size,
                sha256: file.sha256,
                ..ModelFile::default()
            },
            cancelled,
        )?;
        stamp.defer_display_check =
            file.path != runtime.archive.executable && file.path != runtime.archive.script;
        stamps.push(stamp);
        #[cfg(unix)]
        if file.executable {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&path)
                .map_err(|e| e.to_string())?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err("音色运行环境缺少执行权限，请重新下载。".into());
            }
        }
    }
    Ok(stamps)
}

fn extract(
    archive_path: &Path,
    destination: &Path,
    runtime: &SelectedRuntime,
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive_path).map_err(|e| e.to_string())?)
        .map_err(|_| "音色运行环境压缩包无法读取。")?;
    if zip.len() > MAX_RUNTIME_FILES + 10000 {
        return Err("运行环境压缩包条目过多。".into());
    }
    let mut total = 0_u64;
    let mut paths = HashSet::new();
    for index in 0..zip.len() {
        check_cancelled(cancelled)?;
        let mut entry = zip
            .by_index(index)
            .map_err(|_| "运行环境压缩包条目无效。")?;
        let name = entry.name().trim_end_matches('/').to_owned();
        if !safe_relative(&name) || !paths.insert(name.to_lowercase()) {
            return Err("运行环境压缩包包含不安全或重复路径。".into());
        }
        let file_type = entry.unix_mode().unwrap_or(0) & 0o170000;
        if (entry.is_dir() && !matches!(file_type, 0 | 0o040000))
            || (!entry.is_dir() && !matches!(file_type, 0 | 0o100000))
        {
            return Err("运行环境压缩包包含链接或特殊文件。".into());
        }
        let target = destination.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .ok_or("运行环境解压大小溢出。")?;
        if total > runtime.archive.unpacked_size {
            return Err("运行环境解压大小超出清单。".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| format!("无法安装音色运行环境：{e}"))?;
        let mut remaining = entry.size();
        let mut buffer = vec![0_u8; BUFFER_BYTES];
        loop {
            check_cancelled(cancelled)?;
            let count = entry
                .read(&mut buffer)
                .map_err(|_| "运行环境压缩包内容损坏。")?;
            if count == 0 {
                break;
            }
            remaining = remaining
                .checked_sub(count as u64)
                .ok_or("运行环境文件解压大小超限。")?;
            output
                .write_all(&buffer[..count])
                .map_err(|e| format!("无法写入音色运行环境，请检查磁盘空间：{e}"))?;
        }
        if remaining != 0 {
            return Err("运行环境文件解压不完整。".into());
        }
    }
    if total != runtime.archive.unpacked_size {
        return Err("运行环境解压大小与清单不符。".into());
    }
    let manifest = manifest(destination, &runtime.archive, cancelled)?;
    // No unlisted executable or importable module may remain in the environment.
    let listed: HashSet<_> = manifest
        .files
        .iter()
        .map(|file| file.path.to_lowercase())
        .chain(std::iter::once("manifest.json".into()))
        .collect();
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|_| "运行环境压缩包条目无效。")?;
        if !entry.is_dir() && !listed.contains(&entry.name().to_lowercase()) {
            return Err("运行环境包含未校验文件。".into());
        }
    }
    #[cfg(unix)]
    for file in &manifest.files {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            destination.join(&file.path),
            fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
        )
        .map_err(|e| format!("无法设置语音运行环境权限：{e}"))?;
    }
    Ok(())
}

struct CheckChild(std::process::Child);
impl Drop for CheckChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn self_test(root: &Path, runtime: &SelectedRuntime, cancelled: &AtomicBool) -> Result<()> {
    let log = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let log_writer = OpenOptions::new()
        .append(true)
        .open(log.path())
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(checked_path(root, &runtime.archive.executable, false)?);
    command
        .arg("-I")
        .arg("-B")
        .arg(checked_path(root, &runtime.archive.script, false)?)
        .arg("--self-test")
        .current_dir(root)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .stdin(Stdio::null())
        .stdout(log_writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(log_writer);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = CheckChild(
        command
            .spawn()
            .map_err(|e| format!("无法启动已下载的语音运行环境：{e}"))?,
    );
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(180) {
            check_cancelled(cancelled)?;
            return Err("语音运行环境检查超时，请重试。".into());
        }
        if log.as_file().metadata().map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
            return Err("语音运行环境检查日志异常，已停止。".into());
        }
        match child.0.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => {
                let mut detail = String::new();
                let _ = log
                    .reopen()
                    .and_then(|file| file.take(4096).read_to_string(&mut detail));
                return Err(format!(
                    "下载的语音运行环境未通过本机检查，请重新下载。\n{}",
                    detail.trim()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

pub(super) fn install(
    root: &Path,
    runtime: &SelectedRuntime,
    cancelled: &AtomicBool,
    mut download: impl FnMut(&ModelFile, &Path) -> Result<()>,
) -> Result<Vec<FileStamp>> {
    let installed = path(root, runtime);
    if let Ok(stamps) = verify(&installed, runtime, cancelled) {
        return Ok(stamps);
    }
    check_cancelled(cancelled)?;
    let staging = tempfile::Builder::new()
        .prefix(".download-runtime-")
        .tempdir_in(root)
        .map_err(|e| e.to_string())?;
    let archive = tempfile::Builder::new()
        .prefix(".download-runtime-archive-")
        .tempfile_in(root)
        .map_err(|e| e.to_string())?;
    let archive_path = archive.path().to_owned();
    // The downloader creates its destination exclusively.
    archive.close().map_err(|e| e.to_string())?;
    let result = (|| {
        download(
            &ModelFile {
                path: "runtime.zip".into(),
                url: runtime.archive.url.clone(),
                size: runtime.archive.size,
                sha256: runtime.archive.sha256.clone(),
                mirrors: runtime.archive.mirrors.clone(),
                embedded: None,
            },
            &archive_path,
        )?;
        extract(&archive_path, staging.path(), runtime, cancelled)?;
        verify(staging.path(), runtime, cancelled)?;
        self_test(staging.path(), runtime, cancelled)?;
        check_cancelled(cancelled)?;
        remove_package(&installed)?;
        fs::rename(staging.path(), &installed).map_err(|e| format!("无法安装语音运行环境：{e}"))?;
        verify(&installed, runtime, cancelled)
    })();
    let _ = fs::remove_file(archive_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn archive(directory: &Path, extra: Option<(&str, &[u8])>) -> (PathBuf, SelectedRuntime) {
        let data = [
            ("python/bin/python3", b"runtime".as_slice(), true),
            ("runner/tts.py", b"runner".as_slice(), false),
        ];
        let manifest = RuntimeManifest {
            schema: 1,
            files: data
                .iter()
                .map(|(path, content, executable)| RuntimeFile {
                    path: (*path).into(),
                    size: content.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(content)),
                    executable: *executable,
                })
                .collect(),
        };
        let manifest = serde_json::to_vec(&manifest).unwrap();
        let path = directory.join("runtime.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&manifest).unwrap();
        for (path, content, _) in data {
            writer
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        if let Some((name, content)) = extra {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
        let contents = fs::read(&path).unwrap();
        let runtime = SelectedRuntime {
            id: "python-cpu-v1".into(),
            version: 1,
            platform: "linux-x64".into(),
            archive: RuntimeArchive {
                url: "https://github.com/ecojust/open-media/releases/download/test/runtime.zip"
                    .into(),
                mirrors: Vec::new(),
                size: contents.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&contents)),
                manifest_sha256: format!("{:x}", Sha256::digest(&manifest)),
                unpacked_size: manifest.len() as u64
                    + 13
                    + extra.map_or(0, |(_, bytes)| bytes.len() as u64),
                executable: "python/bin/python3".into(),
                script: "runner/tts.py".into(),
            },
        };
        (path, runtime)
    }

    #[test]
    fn extracted_runtime_preserves_checksums_and_executable_permissions() {
        let temporary = tempfile::tempdir().unwrap();
        let (archive, runtime) = archive(temporary.path(), None);
        let destination = temporary.path().join("installed");
        fs::create_dir(&destination).unwrap();
        let cancelled = AtomicBool::new(false);
        extract(&archive, &destination, &runtime, &cancelled).unwrap();
        let stamps = verify(&destination, &runtime, &cancelled).unwrap();
        assert_eq!(stamps.len(), 3);
        assert!(stamps_unchanged(&stamps));
        fs::write(destination.join("runner/tts.py"), b"tamper").unwrap();
        assert!(verify(&destination, &runtime, &cancelled).is_err());
    }

    #[test]
    fn extraction_rejects_traversal_unlisted_files_and_wrong_manifest_digest() {
        for extra in [
            ("../escape.py", b"bad".as_slice()),
            ("unlisted.py", b"bad".as_slice()),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let (archive, runtime) = archive(temporary.path(), Some(extra));
            let destination = temporary.path().join("installed");
            fs::create_dir(&destination).unwrap();
            assert!(extract(&archive, &destination, &runtime, &AtomicBool::new(false)).is_err());
            assert!(!temporary.path().join("escape.py").exists());
        }
        let temporary = tempfile::tempdir().unwrap();
        let (archive, mut runtime) = archive(temporary.path(), None);
        runtime.archive.manifest_sha256 = "0".repeat(64);
        let destination = temporary.path().join("installed");
        fs::create_dir(&destination).unwrap();
        assert!(extract(&archive, &destination, &runtime, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn extraction_stops_on_cancellation_and_declared_size_mismatch() {
        let temporary = tempfile::tempdir().unwrap();
        let (archive, mut runtime) = archive(temporary.path(), None);
        let destination = temporary.path().join("installed");
        fs::create_dir(&destination).unwrap();
        assert_eq!(
            extract(&archive, &destination, &runtime, &AtomicBool::new(true)).unwrap_err(),
            CANCELLED
        );
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        runtime.archive.unpacked_size -= 1;
        assert!(extract(&archive, &destination, &runtime, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn unsupported_platform_never_selects_another_architecture() {
        let temporary = tempfile::tempdir().unwrap();
        let (_, runtime) = archive(temporary.path(), None);
        let other = if platform() == "windows-x64" {
            "macos-arm64"
        } else {
            "windows-x64"
        };
        let definitions = vec![RuntimeDefinition {
            id: "runtime".into(),
            version: 1,
            platforms: HashMap::from([(other.into(), runtime.archive)]),
        }];
        validate(&definitions).unwrap();
        assert!(select("runtime", &definitions).unwrap().is_none());
        assert!(select("unknown", &definitions).is_err());
    }
}
