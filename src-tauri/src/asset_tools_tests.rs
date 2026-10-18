use super::*;
use std::net::TcpListener;

fn fixture() -> (tempfile::TempDir, AssetTools, MediaStore, Runtime) {
    let directory = tempfile::tempdir().unwrap();
    let tools = AssetTools::new(directory.path()).unwrap();
    let store = MediaStore::new(directory.path()).unwrap();
    let runtime =
        Runtime::discover(None, None).expect("Media runtime required for integration checks");
    (directory, tools, store, runtime)
}
fn png(runtime: &Runtime) -> Vec<u8> {
    let mut command = engine::process(&runtime.encoder);
    command.args([
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=64x48",
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "pipe:1",
    ]);
    run_process(
        command,
        &TaskControl::new(Duration::from_secs(10)),
        1024 * 1024,
    )
    .unwrap()
    .stdout
}

#[test]
fn upload_chunks_validate_offsets_digests_and_idempotent_retries_before_real_import() {
    let (_directory, tools, store, runtime) = fixture();
    let bytes = png(&runtime);
    let begin = tools
        .upload_begin("蓝色图片.png", bytes.len() as u64, &hash(&bytes))
        .unwrap();
    let id = begin["uploadId"].as_str().unwrap();
    let split = bytes.len() / 2;
    let first = &bytes[..split];
    let second = &bytes[split..];
    assert!(tools
        .upload_chunk(id, 1, &encode_base64(first), &hash(first))
        .is_err());
    assert!(tools
        .upload_chunk(id, 0, &encode_base64(first), &"0".repeat(64))
        .is_err());
    tools
        .upload_chunk(id, 0, &encode_base64(first), &hash(first))
        .unwrap();
    let replay = tools
        .upload_chunk(id, 0, &encode_base64(first), &hash(first))
        .unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["receivedBytes"], split);
    assert!(tools
        .execute(
            &store,
            &runtime,
            "early-commit",
            "asset_upload_commit",
            &json!({"uploadId":id})
        )
        .is_err());
    tools
        .upload_chunk(id, split as u64, &encode_base64(second), &hash(second))
        .unwrap();
    let result = tools
        .execute(
            &store,
            &runtime,
            "commit",
            "asset_upload_commit",
            &json!({"uploadId":id}),
        )
        .unwrap();
    assert_eq!(result["asset"]["kind"], "image");
    assert_eq!(result["asset"]["width"], 64);
    assert_eq!(result["asset"]["height"], 48);
    assert_eq!(
        fs::read(result["asset"]["nativePath"].as_str().unwrap()).unwrap(),
        bytes
    );
    assert_eq!(
        source_metadata(&store, &result["asset"]).unwrap().unwrap()["sha256"],
        hash(&bytes)
    );
    assert!(tools.upload_status(id).is_err());
    assert!(tools.0.uploads.lock().unwrap().is_empty());
}

#[test]
fn whole_file_mismatch_and_invalid_media_never_create_assets() {
    let (_directory, tools, store, runtime) = fixture();
    for (bytes, expected) in [
        (png(&runtime), "0".repeat(64)),
        (b"not media".to_vec(), hash(b"not media")),
    ] {
        let begin = tools
            .upload_begin("file.png", bytes.len() as u64, &expected)
            .unwrap();
        let id = begin["uploadId"].as_str().unwrap();
        tools
            .upload_chunk(id, 0, &encode_base64(&bytes), &hash(&bytes))
            .unwrap();
        assert!(tools
            .execute(
                &store,
                &runtime,
                "invalid",
                "asset_upload_commit",
                &json!({"uploadId":id})
            )
            .is_err());
        assert!(tools.upload_status(id).is_err());
        assert_eq!(fs::read_dir(&store.root).unwrap().count(), 0);
    }
}

#[test]
fn uploads_have_count_byte_time_and_path_limits_and_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let tools = AssetTools::new(directory.path()).unwrap();
    for name in [
        "../sample.png",
        "/sample.png",
        "a\\b.png",
        "a\n.png",
        "script.js",
    ] {
        assert!(tools.upload_begin(name, 1, &"a".repeat(64)).is_err());
    }
    assert!(tools
        .upload_begin("sample.png", 0, &"a".repeat(64))
        .is_err());
    let first = tools
        .upload_begin("sample.png", MAX_FILE, &"a".repeat(64))
        .unwrap();
    let second = tools
        .upload_begin("sample.png", MAX_FILE, &"a".repeat(64))
        .unwrap();
    assert!(tools
        .upload_begin("sample.png", 1, &"a".repeat(64))
        .is_err());
    assert!(tools.upload_abort(first["uploadId"].as_str().unwrap()));
    assert!(tools.upload_abort(second["uploadId"].as_str().unwrap()));
    for _ in 0..MAX_UPLOADS {
        tools.upload_begin("a.png", 1, &"a".repeat(64)).unwrap();
    }
    assert!(tools.upload_begin("a.png", 1, &"a".repeat(64)).is_err());
    tools
        .0
        .uploads
        .lock()
        .unwrap()
        .values_mut()
        .for_each(|upload| upload.touched = Instant::now() - UPLOAD_TTL - Duration::from_secs(1));
    tools.upload_begin("a.png", 1, &"a".repeat(64)).unwrap();
    assert_eq!(tools.0.uploads.lock().unwrap().len(), 1);
    let path = tools.0.directory.path().to_owned();
    tools.shutdown();
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    drop(tools);
    assert!(!path.exists());
}

#[test]
fn private_redirect_targets_and_ambiguous_urls_are_rejected() {
    let control = TaskControl::new(Duration::from_secs(5));
    for address in [
        "127.0.0.1",
        "10.2.3.4",
        "172.16.5.6",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",
        "198.18.0.1",
        "192.0.2.2",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::ffff:127.0.0.1",
        "fd00::1",
        "fe80::1",
        "2001:db8::1",
        "2002:7f00:1::",
    ] {
        assert!(!is_public_address(address.parse().unwrap()), "{address}");
    }
    for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
        assert!(is_public_address(address.parse().unwrap()));
    }
    for raw in [
        "file:///etc/passwd",
        "ftp://example.org/x",
        "https://user:pass@example.org/x",
    ] {
        assert!(checked_url(raw).is_err());
    }
    for raw in [
        "http://127.1/x.png",
        "http://2130706433/x.png",
        "http://[::ffff:127.0.0.1]/x.png",
    ] {
        assert!(public_addresses(&checked_url(raw).unwrap(), &control).is_err());
    }
    assert!(!valid_mime("text/html"));
    assert!(!valid_mime("image/svg+xml"));
}

fn serve(replies: Vec<(u16, String, Vec<u8>)>) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        for (code, headers, body) in replies {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
                assert!(head.len() < 8192);
            }
            let header = format!(
                "HTTP/1.1 {code} Test\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    (address, handle)
}

#[test]
fn real_http_download_follows_verified_redirect_and_retains_source_and_hash() {
    let (_directory, tools, store, runtime) = fixture();
    let bytes = png(&runtime);
    let (address, server) = serve(vec![
        (302, "Location: /final.png\r\n".into(), vec![]),
        (200, "Content-Type: image/png\r\n".into(), bytes.clone()),
    ]);
    let url = format!("http://media.example:{}/start.png", address.port());
    // Only the test injects its local endpoint; production always resolves and
    // pins exclusively public addresses for every redirect destination.
    let result = tools
        .import_url_resolved(
            &store,
            &runtime,
            &url,
            None,
            1024 * 1024,
            &TaskControl::new(Duration::from_secs(10)),
            |url, _| {
                assert_eq!(url.host_str(), Some("media.example"));
                Ok(vec![address])
            },
        )
        .unwrap();
    server.join().unwrap();
    assert_eq!(result["source"]["url"], url);
    assert_eq!(result["source"]["sha256"], hash(&bytes));
    assert!(result["source"]["finalUrl"]
        .as_str()
        .unwrap()
        .ends_with("/final.png"));
    assert_eq!(result["asset"]["width"], 64);
    assert_eq!(
        source_metadata(&store, &result["asset"]).unwrap(),
        Some(result["source"].clone())
    );
}

#[test]
fn downloads_reject_oversize_mime_spoofs_and_redirects_to_private_targets() {
    let (_directory, tools, store, runtime) = fixture();
    let bytes = png(&runtime);
    for (headers, limit) in [
        ("Content-Type: text/html\r\n", 1024 * 1024),
        ("Content-Type: image/png\r\n", 1),
    ] {
        let (address, server) = serve(vec![(200, headers.into(), bytes.clone())]);
        assert!(tools
            .import_url_resolved(
                &store,
                &runtime,
                &format!("http://media.example:{}/sample.png", address.port()),
                None,
                limit,
                &TaskControl::new(Duration::from_secs(10)),
                |_, _| Ok(vec![address])
            )
            .is_err());
        server.join().unwrap();
    }
    let (address, server) = serve(vec![(
        302,
        "Location: http://127.0.0.1/private.png\r\n".into(),
        vec![],
    )]);
    let error = tools
        .import_url_resolved(
            &store,
            &runtime,
            &format!("http://media.example:{}/sample.png", address.port()),
            None,
            1024 * 1024,
            &TaskControl::new(Duration::from_secs(10)),
            |url, control| {
                if url.host_str() == Some("media.example") {
                    Ok(vec![address])
                } else {
                    public_addresses(url, control)
                }
            },
        )
        .unwrap_err();
    assert!(error.contains("本机"));
    server.join().unwrap();
    assert_eq!(fs::read_dir(&store.root).unwrap().count(), 0);
}

#[test]
fn cancellation_races_and_real_media_process_timeout_are_bounded() {
    let (_directory, tools, store, runtime) = fixture();
    tools.cancel("already-cancelled").unwrap();
    assert!(tools
        .execute(
            &store,
            &runtime,
            "already-cancelled",
            "asset_upload_begin",
            &json!({"name":"a.png","size":1,"sha256":"a".repeat(64)})
        )
        .unwrap_err()
        .contains("取消"));
    let control = TaskControl::new(Duration::from_secs(10));
    let flag = control.cancelled.clone();
    let signal = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        flag.store(true, Ordering::Release);
    });
    let mut command = engine::process(&runtime.encoder);
    command.args([
        "-hide_banner",
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=64x48:d=60",
        "-f",
        "null",
        "-",
    ]);
    let began = Instant::now();
    assert!(run_process(command, &control, 1024)
        .unwrap_err()
        .contains("取消"));
    assert!(began.elapsed() < Duration::from_secs(3));
    signal.join().unwrap();
    let mut command = engine::process(&runtime.encoder);
    command.args([
        "-hide_banner",
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=64x48:d=60",
        "-f",
        "null",
        "-",
    ]);
    assert!(
        run_process(command, &TaskControl::new(Duration::from_millis(100)), 1024)
            .unwrap_err()
            .contains("超时")
    );
}

#[test]
fn decoder_whitelist_rejects_uploaded_playlist_content() {
    let (_directory, tools, store, runtime) = fixture();
    let bytes = b"ffconcat version 1.0\nfile '/etc/passwd'\n";
    let begin = tools
        .upload_begin("malicious.mp4", bytes.len() as u64, &hash(bytes))
        .unwrap();
    let id = begin["uploadId"].as_str().unwrap();
    tools
        .upload_chunk(id, 0, &encode_base64(bytes), &hash(bytes))
        .unwrap();
    assert!(tools
        .execute(
            &store,
            &runtime,
            "playlist",
            "asset_upload_commit",
            &json!({"uploadId":id})
        )
        .is_err());
    assert_eq!(fs::read_dir(store.root).unwrap().count(), 0);
}
