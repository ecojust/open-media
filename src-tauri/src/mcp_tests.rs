use super::*;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

fn fixture() -> (tempfile::TempDir, McpManager) {
    let directory = tempfile::tempdir().unwrap();
    let manager = McpManager::new(directory.path().join("mcp.json")).unwrap();
    (directory, manager)
}
fn catalog() -> Vec<Value> {
    vec![json!({"name":"open_media_echo","description":"检查连接","inputSchema":{"type":"object"}})]
}
fn start(manager: &McpManager, dispatch: Dispatch) -> McpStatus {
    let mut config = manager.config();
    config.port = 0;
    manager.start(config, catalog(), dispatch).unwrap()
}
fn request(status: &McpStatus, token: Option<&str>, body: &str, extra: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", status.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let message = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}", status.port, body.len());
    stream.write_all(message.as_bytes()).unwrap();
    read_response(stream).unwrap()
}

/// These fixed-size responses end at Content-Length, not at a TCP EOF. An early
/// rejection can close a connection with unread request bytes; some systems then
/// reset TCP after delivering the response. Missing body bytes must still fail.
fn read_response(reader: impl Read) -> io::Result<(u16, String)> {
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidData, message);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if !line.ends_with("\r\n") {
        return Err(invalid("incomplete HTTP status line"));
    }
    let mut fields = line.split_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(invalid("invalid HTTP response version"));
    }
    let status = fields
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| (100..=599).contains(value))
        .ok_or_else(|| invalid("invalid HTTP response status"))?;
    let mut length = None;
    let mut header_bytes = line.len();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || !line.ends_with("\r\n") {
            return Err(invalid("incomplete HTTP response headers"));
        }
        header_bytes += line.len();
        if header_bytes > 32 * 1024 {
            return Err(invalid("HTTP response headers exceed the limit"));
        }
        if line == "\r\n" {
            break;
        }
        let (name, value) = line
            .trim_end_matches("\r\n")
            .split_once(':')
            .ok_or_else(|| invalid("invalid HTTP response header"))?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(invalid("expected a fixed-size HTTP response"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(invalid("duplicate Content-Length"));
            }
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid("invalid Content-Length"));
            }
            length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| invalid("invalid Content-Length"))?,
            );
        }
    }
    let length = length.ok_or_else(|| invalid("missing Content-Length"))?;
    if length > MAX_BODY {
        return Err(invalid("HTTP response body exceeds the limit"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok((
        status,
        String::from_utf8(body).map_err(|_| invalid("invalid UTF-8 HTTP response"))?,
    ))
}
fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string()
}

#[test]
fn http_client_accepts_complete_frames_but_rejects_truncated_responses() {
    struct ResetAfterBytes(io::Cursor<Vec<u8>>);
    impl Read for ResetAfterBytes {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.0.position() == self.0.get_ref().len() as u64 {
                return Err(io::ErrorKind::ConnectionReset.into());
            }
            self.0.read(bytes)
        }
    }
    let reply = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}".to_vec();
    assert_eq!(
        read_response(ResetAfterBytes(io::Cursor::new(reply.clone()))).unwrap(),
        (403, "{}".into())
    );
    let truncated = reply[..reply.len() - 1].to_vec();
    assert_eq!(
        read_response(ResetAfterBytes(io::Cursor::new(truncated.clone())))
            .unwrap_err()
            .kind(),
        io::ErrorKind::ConnectionReset
    );
    assert_eq!(
        read_response(io::Cursor::new(truncated))
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    for invalid in [
        "HTTP/1.1 200 OK\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n",
    ] {
        assert!(read_response(io::Cursor::new(invalid)).is_err());
    }
}

#[test]
fn settings_persist_private_token_without_auto_start() {
    let (directory, manager) = fixture();
    let initial = manager.config();
    assert_eq!(initial.token.len(), 64);
    assert_eq!(initial.host, "127.0.0.1");
    let restored = McpManager::new(directory.path().join("mcp.json")).unwrap();
    assert_eq!(restored.config().token, initial.token);
    assert!(!restored.status().running);
    let mut config = initial.clone();
    config.token.clear();
    let rotated = manager.save_config(config).unwrap();
    assert_ne!(rotated.token, initial.token);
    assert!(!serde_json::to_string(&manager.status())
        .unwrap()
        .contains(&rotated.token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(directory.path().join("mcp.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn real_http_negotiation_auth_and_origin_guards() {
    let (_directory, manager) = fixture();
    let status = start(&manager, Arc::new(|_| Ok(())));
    let token = manager.config().token;
    let body = rpc(
        1,
        "initialize",
        json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1"}}),
    );
    assert_eq!(request(&status, None, &body, "").0, 401);
    assert_eq!(request(&status, Some("incorrect"), &body, "").0, 401);
    assert_eq!(
        request(
            &status,
            Some(&token),
            &body,
            "Origin: https://untrusted.example\r\n"
        )
        .0,
        403
    );
    assert_eq!(
        request(&status, Some(&token), &body, "Host: attacker.example\r\n").0,
        403
    );
    assert_eq!(
        request(
            &status,
            Some(&token),
            &body,
            "MCP-Protocol-Version: unsupported\r\n"
        )
        .0,
        400
    );
    let (http, body) = request(&status, Some(&token), &body, "");
    assert_eq!(http, 200);
    let value: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(value["result"]["protocolVersion"], "2025-06-18");
    let (_, body) = request(&status, Some(&token), &rpc(2, "tools/list", json!({})), "");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["result"]["tools"][0]["name"],
        "open_media_echo"
    );
    assert_eq!(
        request(
            &status,
            Some(&token),
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
            ""
        )
        .0,
        202
    );
    assert!(manager.save_config(manager.config()).is_err());
    manager.stop();
    assert!(TcpStream::connect(("127.0.0.1", status.port)).is_err());
}

#[test]
fn real_http_tool_dispatch_requires_claim_and_is_single_use() {
    let (_directory, manager) = fixture();
    let receiver = manager.clone();
    let status = start(
        &manager,
        Arc::new(move |request| {
            assert!(!receiver.complete(&request.id, json!({}), false));
            assert_eq!(receiver.pending().len(), 1);
            assert!(receiver.claim(&request.id));
            assert!(!receiver.claim(&request.id));
            assert!(receiver.pending().is_empty());
            assert!(receiver.complete(&request.id, json!({"echo":request.arguments}), false));
            assert!(!receiver.complete(&request.id, json!({}), false));
            Ok(())
        }),
    );
    let token = manager.config().token;
    let (_, body) = request(
        &status,
        Some(&token),
        &rpc(
            3,
            "tools/call",
            json!({"name":"open_media_echo","arguments":{"value":42}}),
        ),
        "",
    );
    let result: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(result["result"]["structuredContent"]["echo"]["value"], 42);
    assert_eq!(result["result"]["isError"], false);
    let (_, body) = request(
        &status,
        Some(&token),
        &rpc(4, "tools/call", json!({"name":"unknown"})),
        "",
    );
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32602
    );
    manager.stop();
}

#[test]
fn expired_requests_cannot_be_claimed_or_completed_later() {
    let (_directory, mut manager) = fixture();
    Arc::get_mut(&mut manager.0).unwrap().request_timeout = Duration::from_millis(60);
    let queued = Arc::new(Mutex::new(None));
    let target = queued.clone();
    let status = start(
        &manager,
        Arc::new(move |request| {
            *target.lock().unwrap() = Some(request.id);
            Ok(())
        }),
    );
    let (_, body) = request(
        &status,
        Some(&manager.config().token),
        &rpc(1, "tools/call", json!({"name":"open_media_echo"})),
        "",
    );
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32000
    );
    let id = queued.lock().unwrap().clone().unwrap();
    assert!(!manager.claim(&id));
    assert!(!manager.complete(&id, json!({}), false));
    assert!(manager.pending().is_empty());
    manager.stop();
}

#[test]
fn stop_cancels_queued_requests_and_service_can_restart() {
    let (_directory, manager) = fixture();
    let (send, receive) = std::sync::mpsc::channel();
    let status = start(
        &manager,
        Arc::new(move |request| {
            send.send(request.id).unwrap();
            Ok(())
        }),
    );
    let token = manager.config().token;
    let client = thread::spawn(move || {
        let body = rpc(1, "tools/call", json!({"name":"open_media_echo"}));
        let mut stream = TcpStream::connect(("127.0.0.1", status.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let message = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", status.port, body.len());
        stream.write_all(message.as_bytes()).unwrap();
        let mut response = Vec::new();
        if let Err(error) = stream.read_to_end(&mut response) {
            // Shutdown can close an in-flight response instead of delivering an RPC error.
            assert!(matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ));
        }
    });
    let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(manager.pending().len(), 1);
    manager.stop();
    assert!(!manager.claim(&id));
    assert!(!manager.complete(&id, json!({}), false));
    assert!(manager.pending().is_empty());
    let _ = client.join().unwrap();
    assert!(start(&manager, Arc::new(|_| Ok(()))).running);
    manager.stop();
}

#[test]
fn malformed_batched_and_oversize_requests_never_reach_editor() {
    let (_directory, manager) = fixture();
    let status = start(
        &manager,
        Arc::new(|_| panic!("invalid request reached editor")),
    );
    let token = manager.config().token;
    assert_eq!(request(&status, Some(&token), "{", "").0, 400);
    let (_, body) = request(&status, Some(&token), "[]", "");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32600
    );
    // The server rejects the announced length before accepting a large upload.
    let mut stream = TcpStream::connect(("127.0.0.1", status.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let message = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", status.port, MAX_BODY + 1);
    stream.write_all(message.as_bytes()).unwrap();
    let (rejected, body) = read_response(stream).unwrap();
    assert_eq!(rejected, 413);
    assert!(serde_json::from_str::<Value>(&body).unwrap()["error"].is_string());
    let (_, body) = request(
        &status,
        Some(&token),
        &rpc(
            2,
            "tools/call",
            json!({"name":"open_media_echo","arguments":[]}),
        ),
        "",
    );
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32602
    );
    manager.stop();
}

#[test]
fn rejects_invalid_bind_addresses_tokens_and_catalogs() {
    let (_directory, manager) = fixture();
    let mut config = manager.config();
    config.host = "untrusted.example".into();
    assert!(manager.save_config(config).is_err());
    let mut config = manager.config();
    config.token = "x".repeat(32) + "\r\n";
    assert!(manager.save_config(config).is_err());
    let mut config = manager.config();
    config.port = 0;
    assert!(manager.save_config(config.clone()).is_err());
    assert!(manager
        .start(
            config.clone(),
            vec![json!({"name":"bad tool","inputSchema":{"type":"object"}})],
            Arc::new(|_| Ok(()))
        )
        .is_err());
    let mut tools = catalog();
    tools.push(tools[0].clone());
    assert!(manager.start(config, tools, Arc::new(|_| Ok(()))).is_err());
}

#[test]
#[ignore = "external protocol client fixture"]
fn external_protocol_fixture() {
    let ready =
        PathBuf::from(std::env::var("OPEN_MEDIA_MCP_HANDSHAKE").expect("handshake file path"));
    let stop = PathBuf::from(std::env::var("OPEN_MEDIA_MCP_STOP").expect("stop file path"));
    let (_directory, manager) = fixture();
    let executor = manager.clone();
    let status = start(
        &manager,
        Arc::new(move |request| {
            if !executor.claim(&request.id) {
                return Err("expired".into());
            }
            executor.complete(&request.id, json!({"echo":request.arguments}), false);
            Ok(())
        }),
    );
    fs::write(
        ready,
        json!({"url":status.url,"token":manager.config().token}).to_string(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    while !stop.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    manager.stop();
}
