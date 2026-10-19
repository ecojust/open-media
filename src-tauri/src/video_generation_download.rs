use super::*;
use std::fs::{File, OpenOptions};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stamp {
    size: u64,
    modified: u128,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    sha256: String,
    stamp: Stamp,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    let modified = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(Stamp {
        size: meta.len(),
        modified,
    })
}
fn matches_stamp(actual: &Stamp, expected: &Stamp) -> bool {
    actual.size == expected.size && actual.modified == expected.modified
}
fn fingerprint(catalog: &Catalog, model: &Model, files: &[ModelFile]) -> String {
    let mut hash = Sha256::new();
    hash.update(catalog.revision.as_bytes());
    hash.update(catalog.engine.version.as_bytes());
    hash.update(model.id.as_bytes());
    for file in files {
        hash.update(file.path.as_bytes());
        hash.update(file.sha256.as_bytes());
        hash.update(file.size.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub(super) fn installed_ready(
    root: &Path,
    catalog: &Catalog,
    model: &Model,
    files: &[ModelFile],
) -> bool {
    let Ok(installed) = read_json::<Installed>(&root.join("installed.json")) else {
        return false;
    };
    installed.schema == 1
        && installed.accepted_license_at > 0
        && installed.fingerprint == fingerprint(catalog, model, files)
        && installed.files.len() == files.len()
        && files.iter().all(|file| {
            let path = root.join(&file.path);
            checked_file(root, &path).is_ok()
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
pub(super) fn cached_bytes(root: &Path, files: &[ModelFile]) -> u64 {
    let mut seen = HashSet::new();
    files
        .iter()
        .filter(|f| seen.insert(&f.sha256))
        .map(|file| {
            if cached(root, file) {
                file.size
            } else {
                stamp(&partial(root, file)).map_or(0, |stamp| stamp.size.min(file.size))
            }
        })
        .sum()
}
pub(super) fn require_space(root: &Path, needed: u64) -> Result<()> {
    // Download is offered only on the native supported platform. The OS utility
    // reports available bytes on the exact volume containing the model cache.
    let output = Command::new("/bin/df")
        .args(["-Pk"])
        .arg(root)
        .output()
        .map_err(|e| format!("无法检查模型目录可用空间：{e}"))?;
    if !output.status.success() {
        return Err("无法检查可用磁盘空间，请确认模型保存目录可访问。".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let available = text
        .lines()
        .skip(1)
        .last()
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|v| v.parse::<u64>().ok())
        .and_then(|blocks| blocks.checked_mul(1024))
        .ok_or("无法读取磁盘剩余空间。")?;
    if available < needed {
        return Err(format!(
            "磁盘空间不足，还需要至少 {:.1} GB，可用 {:.1} GB。已下载的部分会保留。",
            needed as f64 / 1e9,
            available as f64 / 1e9
        ));
    }
    Ok(())
}

pub(super) fn install_model(
    worker: &Worker,
    model: &Model,
    files: &[ModelFile],
    cancelled: &AtomicBool,
) -> Result<()> {
    checked_directory(&worker.root)?;
    let _operation_lock = operation_lock(&worker.root)?;
    let mut hashes = HashSet::new();
    let unique: Vec<_> = files
        .iter()
        .filter(|file| hashes.insert(&file.sha256))
        .collect();
    let needed: u64 = unique
        .iter()
        .map(|file| {
            if cached(&worker.root, file) {
                0
            } else {
                file.size.saturating_sub(
                    stamp(&partial(&worker.root, file)).map_or(0, |s| s.size.min(file.size)),
                )
            }
        })
        .sum();
    require_space(&worker.root, needed.saturating_add(2 * 1024 * 1024 * 1024))?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 || attempt.url().scheme() != "https" {
                attempt.error("模型下载跳转不受支持")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Open-Media-Video-Models")
        .build()
        .map_err(|e| format!("无法连接模型下载服务：{e}"))?;
    let mut completed = 0;
    for file in &unique {
        check_cancelled(cancelled)?;
        ensure_blob(
            &worker.root,
            &client,
            file,
            cancelled,
            |bytes, verifying| {
                update_model(
                    worker,
                    &model.id,
                    if verifying {
                        "verifying"
                    } else {
                        "downloading"
                    },
                    completed + bytes,
                )
            },
        )?;
        completed += file.size;
        update_model(worker, &model.id, "downloading", completed);
    }
    check_cancelled(cancelled)?;
    update_model(worker, &model.id, "verifying", completed);
    install_dependencies(worker, model, cancelled, &mut HashSet::new())?;
    Ok(())
}
fn update_model(worker: &Worker, id: &str, stage: &str, bytes: u64) {
    if let Ok(mut state) = worker.shared.lock() {
        if let Some(model) = state.models.iter_mut().find(|m| m.id == id) {
            model.state = stage.into();
            model.downloaded_bytes = bytes.min(model.size);
        }
    }
}
fn install_dependencies(
    worker: &Worker,
    model: &Model,
    cancelled: &AtomicBool,
    installed: &mut HashSet<String>,
) -> Result<()> {
    if installed.contains(&model.id) {
        return Ok(());
    }
    for id in &model.requires {
        install_dependencies(
            worker,
            worker
                .catalog
                .models
                .iter()
                .find(|m| &m.id == id)
                .ok_or("视频模型依赖缺失。")?,
            cancelled,
            installed,
        )?;
    }
    check_cancelled(cancelled)?;
    let files = model_files(&worker.catalog, model)?;
    let parent = safe_directory(&worker.root, &format!("models/{}", model.id))?;
    let staging = tempfile::Builder::new()
        .prefix("install-")
        .tempdir_in(&parent)
        .map_err(|e| e.to_string())?;
    let mut stamps = HashMap::new();
    for file in &files {
        check_cancelled(cancelled)?;
        if !cached(&worker.root, file) {
            return Err("模型缓存已改变，请重新下载以校验修复。".into());
        }
        let destination = staging.path().join(&file.path);
        if let Some(dir) = Path::new(&file.path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            safe_directory(staging.path(), &dir.to_string_lossy())?;
        }
        // A shared content-addressed file is hard-linked into each model view.
        // Copying huge weights would silently double disk usage.
        fs::hard_link(blob(&worker.root, file), &destination)
            .map_err(|e| format!("无法共享已下载的模型文件：{e}；模型目录需要支持硬链接。"))?;
        stamps.insert(file.path.clone(), stamp(&destination)?);
    }
    fs::write(staging.path().join("LICENSE"), &worker.catalog.license.text)
        .map_err(|e| e.to_string())?;
    fs::write(
        staging.path().join("NOTICE"),
        &worker.catalog.license.notice,
    )
    .map_err(|e| e.to_string())?;
    write_json(
        &staging.path().join("installed.json"),
        &Installed {
            schema: 1,
            fingerprint: fingerprint(&worker.catalog, model, &files),
            files: stamps,
            accepted_license_at: now_ms(),
        },
    )?;
    check_cancelled(cancelled)?;
    let destination = model_root(&worker.root, &worker.catalog, model);
    let backup = parent.join(format!("replaced-{}", engine::new_id()));
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
    installed.insert(model.id.clone());
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

fn ensure_blob(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, bool),
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
            let result = download_attempt(root, client, file, url, cancelled, &mut progress);
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

fn download_attempt(
    root: &Path,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    url: &str,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(u64, bool),
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

    fn local_response(
        body: Vec<u8>,
        range: Option<String>,
        delay_ms: u64,
    ) -> (String, thread::JoinHandle<String>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let join = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = String::new();
            {
                let mut reader = BufReader::new(&stream);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
            }
            let status = if range.is_some() {
                "206 Partial Content"
            } else {
                "200 OK"
            };
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                body.len(),
                range.map_or(String::new(), |value| format!("Content-Range: {value}\r\n"))
            );
            stream.write_all(header.as_bytes()).unwrap();
            for chunk in body.chunks(2) {
                if stream.write_all(chunk).is_err() {
                    break;
                }
                if delay_ms > 0 {
                    thread::sleep(Duration::from_millis(delay_ms));
                }
            }
            request
        });
        (format!("http://{address}/weights"), join)
    }
    fn small_file(bytes: &[u8]) -> ModelFile {
        ModelFile {
            path: "FL2VA/model.bin".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            urls: vec![],
        }
    }

    #[test]
    fn healthy_slow_download_outlives_per_read_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let bytes = b"abcdefghijkl";
        let file = small_file(bytes);
        let (url, server) = local_response(bytes.to_vec(), None, 60);
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(150))
            .build()
            .unwrap();
        let start = Instant::now();
        download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert!(start.elapsed() > Duration::from_millis(250));
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), bytes);
        server.join().unwrap();
    }
    #[test]
    fn partial_download_resumes_at_exact_offset_and_validates_full_hash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let bytes = b"abcdefghijkl";
        let file = small_file(bytes);
        fs::write(partial(&root, &file), &bytes[..4]).unwrap();
        let (url, server) = local_response(bytes[4..].to_vec(), Some("bytes 4-11/12".into()), 0);
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert!(server
            .join()
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=4-"));
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), bytes);
    }
    #[test]
    fn server_ignoring_range_restarts_instead_of_appending() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let bytes = b"abcdefghijkl";
        let file = small_file(bytes);
        fs::write(partial(&root, &file), b"abcd").unwrap();
        let (url, server) = local_response(bytes.to_vec(), None, 0);
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(fs::read(partial(&root, &file)).unwrap(), bytes);
        server.join().unwrap();
    }
    #[test]
    fn checksum_failure_discards_corrupt_partial() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let file = small_file(b"abcdefghijkl");
        let (url, server) = local_response(b"XXXXXXXXXXXX".to_vec(), None, 0);
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        assert!(download_attempt(
            &root,
            &client,
            &file,
            &url,
            &AtomicBool::new(false),
            &mut |_, _| {}
        )
        .unwrap_err()
        .contains("SHA-256"));
        assert!(!partial(&root, &file).exists());
        server.join().unwrap();
    }
    #[test]
    fn cancellation_keeps_resumable_partial() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let file = small_file(b"abcdefghijklmnopqrstuvwx");
        let (url, server) = local_response(b"abcdefghijklmnopqrstuvwx".to_vec(), None, 60);
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let cancelled = AtomicBool::new(false);
        assert!(
            download_attempt(&root, &client, &file, &url, &cancelled, &mut |bytes, _| {
                if bytes >= 6 {
                    cancelled.store(true, Ordering::SeqCst);
                }
            })
            .is_err()
        );
        let bytes = fs::metadata(partial(&root, &file)).unwrap().len();
        assert!(bytes >= 6 && bytes < file.size);
        server.join().unwrap();
    }
    #[test]
    fn range_rejects_wrong_offset_and_unknown_size() {
        assert!(validate_content_range("bytes 10-99/100", 10, 100).is_ok());
        for header in [
            "bytes 0-99/100",
            "bytes 10-99/*",
            "bytes 10-100/101",
            "bytes */100",
        ] {
            assert!(validate_content_range(header, 10, 100).is_err());
        }
    }
    #[test]
    fn receipts_reject_replaced_files_without_reading_model_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "blobs").unwrap();
        let file = ModelFile {
            path: "FL2VA/model.bin".into(),
            size: 4,
            sha256: format!("{:x}", Sha256::digest(b"test")),
            urls: vec!["https://example.org/model".into()],
        };
        fs::write(blob(&root, &file), b"test").unwrap();
        remember_blob(&root, &file).unwrap();
        assert!(cached(&root, &file));
        fs::write(blob(&root, &file), b"changed").unwrap();
        assert!(!cached(&root, &file));
    }
    #[test]
    fn partial_bytes_are_bounded_and_shared_hashes_count_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        let file = ModelFile {
            path: "FL2VA/a".into(),
            size: 10,
            sha256: "a".repeat(64),
            urls: vec![],
        };
        fs::write(partial(&root, &file), b"12345").unwrap();
        assert_eq!(cached_bytes(&root, &[file.clone(), file]), 5);
    }
    #[test]
    fn installation_is_atomic_shared_and_version_checked() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        safe_directory(&root, "blobs").unwrap();
        safe_directory(&root, "models").unwrap();
        let mut catalog: Catalog = serde_json::from_str(MODEL_CATALOG).unwrap();
        catalog.models.truncate(1);
        let mut file = small_file(b"weights");
        file.path = "FL2VA/model.safetensors".into();
        let mut shared = file.clone();
        shared.path = "FL2VA/other.safetensors".into();
        catalog.models[0].files = vec![file.clone(), shared];
        fs::write(blob(&root, &file), b"weights").unwrap();
        remember_blob(&root, &file).unwrap();
        let worker = Worker {
            root: root.clone(),
            catalog: Arc::new(catalog),
            shared: Arc::new(Mutex::new(State {
                models: vec![],
                jobs: vec![],
                active: None,
                early_cancelled: HashSet::new(),
                closing: false,
                process: None,
            })),
            runner: Arc::new(OnceLock::new()),
        };
        let model = &worker.catalog.models[0];
        let files = model_files(&worker.catalog, model).unwrap();
        install_dependencies(&worker, model, &AtomicBool::new(false), &mut HashSet::new()).unwrap();
        let installed = model_root(&root, &worker.catalog, model);
        assert!(installed_ready(&installed, &worker.catalog, model, &files));
        assert_eq!(unique_bytes(&files), 7);
        assert!(installed.join("LICENSE").is_file());
        assert!(installed.join("NOTICE").is_file());
        // Reinstallation replaces only the view; verified weight bytes remain shared.
        install_dependencies(&worker, model, &AtomicBool::new(false), &mut HashSet::new()).unwrap();
        assert!(installed_ready(&installed, &worker.catalog, model, &files));
        let mut changed = (*worker.catalog).clone();
        changed.engine.version = "updated-engine".into();
        assert!(!installed_ready(&installed, &changed, model, &files));
        fs::write(installed.join(&file.path), b"changed-weights").unwrap();
        assert!(!installed_ready(&installed, &worker.catalog, model, &files));
        assert!(!cached(&root, &file));
    }
}
