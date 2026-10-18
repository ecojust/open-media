use super::*;
use std::io::{Read, Write};
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
    write!(stream, "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}", status.port, body.len()).unwrap();
    let mut output = String::new();
    stream.read_to_string(&mut output).unwrap();
    let (headers, body) = output.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, body.to_owned())
}
fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string()
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
        write!(stream, "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", status.port, body.len()).unwrap();
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
    write!(stream, "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", status.port, MAX_BODY + 1).unwrap();
    let mut rejected = String::new();
    stream.read_to_string(&mut rejected).unwrap();
    assert!(rejected.starts_with("HTTP/1.1 413"));
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
