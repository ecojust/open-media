use super::*;
use std::fs::OpenOptions;

#[cfg(test)]
pub(super) async fn download_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    expected: &ModelFile,
    control: &TaskControl,
    progress: impl Fn(u64),
) -> Result<()> {
    download_attempt(
        client,
        url,
        destination,
        expected,
        control,
        &progress,
        &|_, _| {},
    )
    .await
}

pub(super) async fn download_file_from_mirrors(
    client: &reqwest::Client,
    destination: &Path,
    expected: &ModelFile,
    control: &TaskControl,
    progress: impl Fn(u64),
    source: impl Fn(&str, u64),
) -> Result<()> {
    let mut last_error = "没有可用下载地址。".to_owned();
    for url in &expected.urls {
        control.check()?;
        match download_attempt(
            client,
            url,
            destination,
            expected,
            control,
            &progress,
            &source,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                control.check()?;
                last_error = error;
            }
        }
    }
    Err(format!(
        "识别模型所有下载地址均失败，已保留续传数据：{last_error}"
    ))
}

async fn download_attempt(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    expected: &ModelFile,
    control: &TaskControl,
    progress: &impl Fn(u64),
    source: &impl Fn(&str, u64),
) -> Result<()> {
    let mut size = 0;
    let mut hash = Sha256::new();
    if let Ok(metadata) = fs::symlink_metadata(destination) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("识别模型断点必须是普通文件。".into());
        }
        if metadata.len() > expected.bytes {
            fs::remove_file(destination).map_err(|error| error.to_string())?;
        } else {
            let mut previous = File::open(destination).map_err(|error| error.to_string())?;
            let mut buffer = [0_u8; 256 * 1024];
            loop {
                control.check()?;
                let count = previous
                    .read(&mut buffer)
                    .map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                hash.update(&buffer[..count]);
            }
            if size == expected.bytes {
                if format!("{:x}", hash.clone().finalize()) == expected.sha256 {
                    progress(size);
                    return Ok(());
                }
                drop(previous);
                fs::remove_file(destination).map_err(|error| error.to_string())?;
                size = 0;
                hash = Sha256::new();
            }
        }
    }
    control.check()?;
    let mut builder = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if size > 0 {
        builder = builder.header(reqwest::header::RANGE, format!("bytes={size}-"));
    }
    source(url, size);
    let mut request = Box::pin(builder.send());
    let started = Instant::now();
    let response = loop {
        control.check()?;
        match tokio::time::timeout(Duration::from_millis(250), &mut request).await {
            Ok(result) => break result.map_err(|error| format!("下载连接失败：{error}"))?,
            Err(_) if started.elapsed() > Duration::from_secs(30) => {
                return Err("下载连接超时。".into())
            }
            Err(_) => (),
        }
    };
    let mut response = response
        .error_for_status()
        .map_err(|error| format!("下载服务返回错误：{error}"))?;
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let expected_range = format!("bytes {size}-{}/{}", expected.bytes - 1, expected.bytes);
        if response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            != Some(expected_range.as_str())
        {
            return Err("识别模型续传范围与已保存断点不一致。".into());
        }
    } else if response.status() == reqwest::StatusCode::OK {
        size = 0;
        hash = Sha256::new();
    } else {
        return Err("识别模型下载响应无效。".into());
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes != expected.bytes - size)
    {
        return Err("下载文件大小与固定清单不符。".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(size == 0)
        .append(size > 0)
        .open(destination)
        .map_err(|error| error.to_string())?;
    progress(size);
    let mut received = Instant::now();
    loop {
        control.check()?;
        match tokio::time::timeout(Duration::from_millis(250), response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                received = Instant::now();
                size = size
                    .checked_add(chunk.len() as u64)
                    .ok_or("下载内容超过大小上限。")?;
                if size > expected.bytes {
                    return Err("下载内容超过固定文件大小。".into());
                }
                output
                    .write_all(&chunk)
                    .map_err(|error| error.to_string())?;
                hash.update(&chunk);
                progress(size);
            }
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(format!("下载中断：{error}")),
            Err(_) if received.elapsed() > Duration::from_secs(30) => {
                return Err("下载读取超时。".into())
            }
            Err(_) => (),
        }
    }
    output.sync_all().map_err(|error| error.to_string())?;
    control.check()?;
    if size != expected.bytes {
        return Err("下载尚未完整，已保留续传数据。".into());
    }
    if format!("{:x}", hash.finalize()) != expected.sha256 {
        drop(output);
        fs::remove_file(destination).map_err(|error| error.to_string())?;
        return Err("下载内容未通过 SHA256 校验，已清理损坏断点。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn server(
        body: Vec<u8>,
        declared: usize,
        status: &str,
        range: Option<String>,
        stall: Duration,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
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
                "HTTP/1.1 {status}\r\nContent-Length: {declared}\r\nConnection: close\r\n{}\r\n",
                range
                    .map(|range| format!("Content-Range: {range}\r\n"))
                    .unwrap_or_default()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            if !stall.is_zero() {
                thread::sleep(stall);
            }
            String::from_utf8(request).unwrap()
        });
        (url, task)
    }

    fn fixture(bytes: &[u8]) -> (tokio::runtime::Runtime, reqwest::Client, ModelFile) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let file = ModelFile {
            name: "weights.onnx".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            urls: vec![],
        };
        (runtime, client, file)
    }

    #[test]
    fn rate_limit_and_hash_failure_automatically_use_the_backup() {
        let bytes = b"recognition mirror fixture";
        for corrupt in [false, true] {
            let (runtime, client, mut file) = fixture(bytes);
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("partial");
            let body = if corrupt {
                vec![b'x'; bytes.len()]
            } else {
                vec![]
            };
            let (primary, first) = server(
                body.clone(),
                body.len(),
                if corrupt {
                    "200 OK"
                } else {
                    "429 Too Many Requests"
                },
                None,
                Duration::ZERO,
            );
            let (backup, second) =
                server(bytes.to_vec(), bytes.len(), "200 OK", None, Duration::ZERO);
            file.urls = vec![primary.clone(), backup.clone()];
            let sources = Mutex::new(vec![]);
            runtime
                .block_on(download_file_from_mirrors(
                    &client,
                    &destination,
                    &file,
                    &TaskControl::new(Duration::from_secs(5)),
                    |_| {},
                    |url, offset| sources.lock().unwrap().push((url.to_owned(), offset)),
                ))
                .unwrap();
            assert_eq!(*sources.lock().unwrap(), vec![(primary, 0), (backup, 0)]);
            assert_eq!(fs::read(destination).unwrap(), bytes);
            first.join().unwrap();
            assert!(!second
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("range:"));
        }
    }

    #[test]
    fn disconnected_or_timed_out_source_resumes_on_the_backup() {
        let bytes = b"recognition mirror fixture";
        for stall in [Duration::ZERO, Duration::from_millis(600)] {
            let (runtime, client, mut file) = fixture(bytes);
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("partial");
            let (primary, first) = server(bytes[..4].to_vec(), bytes.len(), "200 OK", None, stall);
            let (backup, second) = server(
                bytes[4..].to_vec(),
                bytes.len() - 4,
                "206 Partial Content",
                Some(format!("bytes 4-{}/{}", bytes.len() - 1, bytes.len())),
                Duration::ZERO,
            );
            file.urls = vec![primary.clone(), backup.clone()];
            let sources = Mutex::new(vec![]);
            runtime
                .block_on(download_file_from_mirrors(
                    &client,
                    &destination,
                    &file,
                    &TaskControl::new(Duration::from_secs(5)),
                    |_| {},
                    |url, offset| sources.lock().unwrap().push((url.to_owned(), offset)),
                ))
                .unwrap();
            assert_eq!(*sources.lock().unwrap(), vec![(primary, 0), (backup, 4)]);
            assert_eq!(fs::read(destination).unwrap(), bytes);
            first.join().unwrap();
            assert!(second
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("range: bytes=4-"));
        }
    }

    #[test]
    fn invalid_range_keeps_partial_and_non_range_backup_safely_restarts() {
        let bytes = b"recognition mirror fixture";
        let (runtime, client, mut file) = fixture(bytes);
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("partial");
        fs::write(&destination, &bytes[..4]).unwrap();
        let (primary, first) = server(
            bytes[4..].to_vec(),
            bytes.len() - 4,
            "206 Partial Content",
            Some(format!("bytes 3-{}/{}", bytes.len() - 1, bytes.len())),
            Duration::ZERO,
        );
        let (backup, second) = server(bytes.to_vec(), bytes.len(), "200 OK", None, Duration::ZERO);
        file.urls = vec![primary, backup];
        runtime
            .block_on(download_file_from_mirrors(
                &client,
                &destination,
                &file,
                &TaskControl::new(Duration::from_secs(5)),
                |_| {},
                |_, _| {},
            ))
            .unwrap();
        assert_eq!(fs::read(destination).unwrap(), bytes);
        assert!(first
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=4-"));
        assert!(second
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=4-"));
    }
}
