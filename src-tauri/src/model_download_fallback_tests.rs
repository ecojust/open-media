mod mirror_fallback_tests {
    use super::*;
    use std::net::TcpListener;

    fn serve(
        body: Vec<u8>,
        declared_size: usize,
        status: &str,
        range: Option<String>,
        stall: Duration,
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
            while stream.read(&mut byte).unwrap() != 0 {
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {declared_size}\r\nConnection: close\r\n{}\r\n", range.map(|range| format!("Content-Range: {range}\r\n")).unwrap_or_default()).unwrap();
            stream.write_all(&body).unwrap();
            if !stall.is_zero() {
                thread::sleep(stall);
            }
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/pinned-weights"), task)
    }

    fn fixture(data: &[u8]) -> (tempfile::TempDir, PathBuf, ModelFile) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        safe_directory(&root, "parts").unwrap();
        safe_directory(&root, "blobs").unwrap();
        let file = ModelFile {
            path: "model/weights.safetensors".into(),
            size: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
            urls: vec![],
        };
        (directory, root, file)
    }

    #[test]
    fn http_rate_limit_and_invalid_hash_switch_to_the_next_source() {
        let data = b"authenticated model weights";
        for invalid_hash in [false, true] {
            let (_directory, root, mut file) = fixture(data);
            let bad = if invalid_hash {
                vec![b'x'; data.len()]
            } else {
                vec![]
            };
            let (primary, first) = serve(
                bad.clone(),
                bad.len(),
                if invalid_hash {
                    "200 OK"
                } else {
                    "429 Too Many Requests"
                },
                None,
                Duration::ZERO,
            );
            let (backup, second) = serve(data.to_vec(), data.len(), "200 OK", None, Duration::ZERO);
            file.urls = vec![primary.clone(), backup.clone()];
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .build()
                .unwrap();
            let mut sources = vec![];
            ensure_blob_with_source(
                &root,
                &client,
                &file,
                &AtomicBool::new(false),
                |_, _| {},
                |url| sources.push(url.to_owned()),
            )
            .unwrap();
            assert_eq!(sources, vec![primary, backup]);
            assert_eq!(fs::read(blob(&root, &file)).unwrap(), data);
            assert!(cached(&root, &file));
            first.join().unwrap();
            assert!(!second
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("range:"));
        }
    }

    #[test]
    fn disconnect_and_read_timeout_resume_the_verified_range_on_the_next_source() {
        let data = b"authenticated model weights";
        for stall in [Duration::ZERO, Duration::from_millis(600)] {
            let (_directory, root, mut file) = fixture(data);
            let (primary, first) = serve(data[..5].to_vec(), data.len(), "200 OK", None, stall);
            let (backup, second) = serve(
                data[5..].to_vec(),
                data.len() - 5,
                "206 Partial Content",
                Some(format!("bytes 5-{}/{}", data.len() - 1, data.len())),
                Duration::ZERO,
            );
            file.urls = vec![primary.clone(), backup.clone()];
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(150))
                .build()
                .unwrap();
            let mut sources = vec![];
            ensure_blob_with_source(
                &root,
                &client,
                &file,
                &AtomicBool::new(false),
                |_, _| {},
                |url| sources.push(url.to_owned()),
            )
            .unwrap();
            assert_eq!(sources, vec![primary, backup]);
            assert_eq!(fs::read(blob(&root, &file)).unwrap(), data);
            first.join().unwrap();
            assert!(second
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("range: bytes=5-"));
        }
    }

    #[test]
    fn invalid_resume_header_keeps_the_existing_partial_for_the_next_source() {
        let data = b"authenticated model weights";
        let (_directory, root, mut file) = fixture(data);
        fs::write(partial(&root, &file), &data[..5]).unwrap();
        let (primary, first) = serve(
            data[5..].to_vec(),
            data.len() - 5,
            "206 Partial Content",
            Some(format!("bytes 4-{}/{}", data.len() - 1, data.len())),
            Duration::ZERO,
        );
        let (backup, second) = serve(
            data[5..].to_vec(),
            data.len() - 5,
            "206 Partial Content",
            Some(format!("bytes 5-{}/{}", data.len() - 1, data.len())),
            Duration::ZERO,
        );
        file.urls = vec![primary, backup];
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        ensure_blob_with_source(
            &root,
            &client,
            &file,
            &AtomicBool::new(false),
            |_, _| {},
            |_| {},
        )
        .unwrap();
        assert_eq!(fs::read(blob(&root, &file)).unwrap(), data);
        assert!(first
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=5-"));
        assert!(second
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=5-"));
    }
}
