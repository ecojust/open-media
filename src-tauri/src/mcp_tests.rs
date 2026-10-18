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

fn persistent_client(status: &McpStatus) -> TcpStream {
    let stream = TcpStream::connect(("127.0.0.1", status.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
}

fn send_persistent(
    stream: &mut TcpStream,
    status: &McpStatus,
    token: &str,
    body: &str,
    extra: &str,
) {
    let message = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}", status.port, body.len());
    stream.write_all(message.as_bytes()).unwrap();
}

fn expect_clients(manager: &McpManager, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let status = manager.status();
        if status.connected_clients == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {expected} connected clients, got {}",
            status.connected_clients
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn expect_peer_closed(mut stream: TcpStream) {
    match stream.read(&mut [0_u8; 1]) {
        Ok(0) => (),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ) =>
        {
            ()
        }
        other => panic!("expected a closed idle connection, got {other:?}"),
    }
}

#[test]
fn connected_clients_requires_authenticated_valid_mcp_and_tracks_open_sockets() {
    let (_directory, manager) = fixture();
    assert_eq!(manager.status().connected_clients, 0);
    assert_eq!(
        serde_json::to_value(manager.status()).unwrap()["connectedClients"],
        0
    );
    let status = start(&manager, Arc::new(|_| panic!("unexpected editor dispatch")));
    let token = manager.config().token;
    assert_eq!(status.connected_clients, 0);
    let probe = persistent_client(&status);
    expect_clients(&manager, 0);

    for (supplied, body, extra, code) in [
        ("invalid", rpc(1, "ping", json!({})), "", 401),
        (
            token.as_str(),
            rpc(1, "ping", json!({})),
            "Origin: https://untrusted.example\r\n",
            403,
        ),
        (token.as_str(), "{".into(), "", 400),
        (token.as_str(), "[]".into(), "", 200),
        (token.as_str(), rpc(1, "unknown", json!({})), "", 200),
        (
            token.as_str(),
            rpc(1, "tools/call", json!({"name":"unknown"})),
            "",
            200,
        ),
        (
            token.as_str(),
            rpc(
                1,
                "tools/call",
                json!({"name":"open_media_echo","arguments":[]}),
            ),
            "",
            200,
        ),
        (
            token.as_str(),
            json!({"jsonrpc":"2.0","method":"notifications/unknown"}).to_string(),
            "",
            202,
        ),
    ] {
        let mut rejected = persistent_client(&status);
        send_persistent(&mut rejected, &status, supplied, &body, extra);
        let (http, response) = read_response(&mut rejected).unwrap();
        assert_eq!(http, code);
        if http == 200 {
            assert!(serde_json::from_str::<Value>(&response).unwrap()["error"].is_object());
        }
        assert_eq!(manager.status().connected_clients, 0);
    }

    let mut first = persistent_client(&status);
    let initialize = rpc(
        1,
        "initialize",
        json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1"}}),
    );
    send_persistent(&mut first, &status, &token, &initialize, "");
    assert_eq!(read_response(&mut first).unwrap().0, 200);
    expect_clients(&manager, 1);
    for method in ["ping", "tools/list"] {
        send_persistent(&mut first, &status, &token, &rpc(2, method, json!({})), "");
        assert_eq!(read_response(&mut first).unwrap().0, 200);
        assert_eq!(manager.status().connected_clients, 1);
    }

    let mut second = persistent_client(&status);
    send_persistent(
        &mut second,
        &status,
        &token,
        &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
        "",
    );
    assert_eq!(read_response(&mut second).unwrap().0, 202);
    expect_clients(&manager, 2);
    drop(probe);
    drop(first);
    expect_clients(&manager, 1);

    send_persistent(
        &mut second,
        &status,
        &token,
        &rpc(3, "ping", json!({})),
        "Connection: close\r\n",
    );
    assert_eq!(read_response(&mut second).unwrap().0, 200);
    expect_clients(&manager, 0);
    expect_peer_closed(second);
    manager.stop();
}

#[test]
fn client_count_resets_on_stop_and_old_connections_cannot_affect_restart() {
    let (_directory, manager) = fixture();
    let status = start(&manager, Arc::new(|_| Ok(())));
    let token = manager.config().token;
    let mut old = persistent_client(&status);
    send_persistent(&mut old, &status, &token, &rpc(1, "ping", json!({})), "");
    assert_eq!(read_response(&mut old).unwrap().0, 200);
    expect_clients(&manager, 1);
    let stopped = manager.stop();
    assert!(!stopped.running);
    assert_eq!(stopped.connected_clients, 0);

    let restarted = manager
        .start(manager.config(), catalog(), Arc::new(|_| Ok(())))
        .unwrap();
    assert_eq!(restarted.connected_clients, 0);
    let mut current = persistent_client(&restarted);
    send_persistent(
        &mut current,
        &restarted,
        &token,
        &rpc(1, "ping", json!({})),
        "",
    );
    assert_eq!(read_response(&mut current).unwrap().0, 200);
    expect_clients(&manager, 1);
    expect_peer_closed(old);
    assert_eq!(manager.status().connected_clients, 1);
    drop(current);
    expect_clients(&manager, 0);
    manager.stop();
}

#[test]
fn keepalive_idle_deadline_resets_after_each_completed_request() {
    let (_directory, mut manager) = fixture();
    let idle_timeout = Duration::from_millis(500);
    Arc::get_mut(&mut manager.0)
        .unwrap()
        .connection_idle_timeout = idle_timeout;
    let status = start(&manager, Arc::new(|_| Ok(())));
    let token = manager.config().token;
    let mut client = persistent_client(&status);
    let began = Instant::now();
    let mut id = 0;
    while began.elapsed() < idle_timeout * 3 {
        id += 1;
        send_persistent(
            &mut client,
            &status,
            &token,
            &rpc(id, "ping", json!({})),
            "",
        );
        let (http, body) = read_response(&mut client).unwrap();
        assert_eq!(http, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], id);
        assert_eq!(manager.status().connected_clients, 1);
        thread::sleep(Duration::from_millis(80));
    }
    assert!(id > 1);
    // No more requests: the transport and its connection indicator both expire.
    expect_clients(&manager, 0);
    expect_peer_closed(client);
    manager.stop();
}

#[test]
fn idle_deadline_does_not_interrupt_an_active_tool_request() {
    let (_directory, mut manager) = fixture();
    let idle_timeout = Duration::from_millis(300);
    Arc::get_mut(&mut manager.0)
        .unwrap()
        .connection_idle_timeout = idle_timeout;
    let (send, receive) = std::sync::mpsc::channel();
    let status = start(
        &manager,
        Arc::new(move |request| {
            send.send(request.id).unwrap();
            Ok(())
        }),
    );
    let token = manager.config().token;
    let mut client = persistent_client(&status);
    send_persistent(
        &mut client,
        &status,
        &token,
        &rpc(1, "tools/call", json!({"name":"open_media_echo"})),
        "",
    );
    let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    expect_clients(&manager, 1);
    thread::sleep(idle_timeout * 2);
    assert_eq!(manager.status().connected_clients, 1);
    assert!(manager.claim(&id));
    assert!(manager.complete(&id, json!({"finished":true}), false));
    let (http, body) = read_response(&mut client).unwrap();
    assert_eq!(http, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["result"]["structuredContent"]["finished"],
        true
    );
    assert_eq!(manager.status().connected_clients, 1);
    // Disconnecting while a later tool waits for the editor must also release
    // the transport count and cancel that request, without waiting 30 seconds.
    send_persistent(
        &mut client,
        &status,
        &token,
        &rpc(2, "tools/call", json!({"name":"open_media_echo"})),
        "",
    );
    let abandoned = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    expect_clients(&manager, 0);
    assert!(!manager.claim(&abandoned));
    assert!(manager.pending().is_empty());
    manager.stop();
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
fn occupied_default_port_falls_back_and_persists_the_reusable_listener() {
    let (directory, manager) = fixture();
    let initial = manager.config();
    assert_eq!(initial.port, 39861);
    let default_owner = match TcpListener::bind(("127.0.0.1", initial.port)) {
        Ok(listener) => Some(listener),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => None,
        Err(error) => panic!("cannot establish the occupied default-port precondition: {error}"),
    };
    let first = manager
        .start(initial.clone(), catalog(), Arc::new(|_| Ok(())))
        .unwrap();
    assert!(first.running);
    assert_ne!(first.port, 0);
    // An unrelated owner may release its port before start; only our own held
    // socket guarantees it remains occupied for the entire assertion window.
    if default_owner.is_some() {
        assert_ne!(first.port, initial.port);
    }
    assert_eq!(
        first.url,
        Some(format!("http://127.0.0.1:{}/mcp", first.port))
    );
    assert_eq!(manager.config().port, first.port);
    assert_eq!(manager.config().token, initial.token);
    assert!(
        TcpListener::bind(("127.0.0.1", first.port)).is_err(),
        "the chosen socket must remain reserved"
    );
    let saved = fs::read(directory.path().join("mcp.json")).unwrap();
    let persisted: McpConfig = serde_json::from_slice(&saved).unwrap();
    assert_eq!(persisted.port, first.port);
    assert_eq!(persisted.token, initial.token);
    assert!(manager
        .start(manager.config(), catalog(), Arc::new(|_| Ok(())))
        .is_err());
    assert_eq!(manager.status().port, first.port);
    assert_eq!(fs::read(directory.path().join("mcp.json")).unwrap(), saved);
    manager.stop();
    drop(manager);

    let restored = McpManager::new(directory.path().join("mcp.json")).unwrap();
    assert_eq!(restored.config().port, first.port);
    let reused = restored
        .start(restored.config(), catalog(), Arc::new(|_| Ok(())))
        .unwrap();
    assert_eq!(
        reused.port, first.port,
        "an available saved port should be reused after restarting the app"
    );
    restored.stop();

    let selected_owner = TcpListener::bind(("127.0.0.1", reused.port)).unwrap();
    let second = restored
        .start(restored.config(), catalog(), Arc::new(|_| Ok(())))
        .unwrap();
    assert_ne!(second.port, first.port);
    if default_owner.is_some() {
        assert_ne!(second.port, initial.port);
    }
    assert_eq!(restored.config().port, second.port);
    assert_eq!(restored.config().token, initial.token);
    restored.stop();
    drop(restored);
    drop(selected_owner);
    drop(default_owner);

    let final_manager = McpManager::new(directory.path().join("mcp.json")).unwrap();
    let final_status = final_manager
        .start(final_manager.config(), catalog(), Arc::new(|_| Ok(())))
        .unwrap();
    assert_eq!(
        final_status.port, second.port,
        "freeing the default port must not reset the saved choice"
    );
    assert_eq!(
        final_status.url,
        Some(format!("http://127.0.0.1:{}/mcp", second.port))
    );
    let (status, reply) = request(
        &final_status,
        Some(&initial.token),
        &rpc(1, "ping", json!({})),
        "",
    );
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&reply).unwrap()["result"],
        json!({})
    );
    final_manager.stop();
}

#[test]
fn zero_port_start_persists_the_assigned_port_and_keeps_the_token() {
    let (directory, manager) = fixture();
    let token = manager.config().token;
    let status = start(&manager, Arc::new(|_| Ok(())));
    assert_ne!(status.port, 0);
    assert_eq!(manager.config().port, status.port);
    assert_eq!(manager.config().token, token);
    let saved: McpConfig =
        serde_json::from_slice(&fs::read(directory.path().join("mcp.json")).unwrap()).unwrap();
    assert_eq!(saved.port, status.port);
    manager.stop();
}

#[test]
fn unrelated_bind_failure_does_not_change_saved_config_or_start_service() {
    let (directory, manager) = fixture();
    let before = fs::read(directory.path().join("mcp.json")).unwrap();
    let initial = manager.config();
    let mut invalid = initial.clone();
    invalid.host = "192.0.2.123".into();
    invalid.token = "b".repeat(64);
    assert!(manager
        .start(invalid, catalog(), Arc::new(|_| Ok(())))
        .is_err());
    assert!(!manager.status().running);
    assert!(manager.status().url.is_none());
    assert_eq!(manager.config().host, initial.host);
    assert_eq!(manager.config().port, initial.port);
    assert_eq!(manager.config().token, initial.token);
    assert_eq!(fs::read(directory.path().join("mcp.json")).unwrap(), before);
}

#[test]
fn persistence_failure_closes_bound_socket_without_half_starting() {
    let (directory, manager) = fixture();
    let initial = manager.config();
    let port_owner = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = port_owner.local_addr().unwrap().port();
    drop(port_owner);
    let path = directory.path().join("mcp.json");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let mut requested = initial.clone();
    requested.port = port;
    requested.token = "b".repeat(64);
    let failure = manager
        .start(requested, catalog(), Arc::new(|_| Ok(())))
        .unwrap_err();
    assert!(failure.contains("保存 MCP 配置"));
    assert!(!manager.status().running);
    assert!(manager.status().url.is_none());
    assert!(manager.pending().is_empty());
    assert_eq!(manager.config().port, initial.port);
    assert_eq!(manager.config().token, initial.token);
    assert!(path.is_dir());
    let released =
        TcpListener::bind(("127.0.0.1", port)).expect("failed startup must release its listener");
    drop(released);
    assert_eq!(
        Arc::strong_count(&manager.0),
        1,
        "failed startup must join the unused worker"
    );
}

#[test]
fn another_port_is_only_selected_for_port_specific_bind_errors() {
    assert!(can_choose_another_port(
        &io::ErrorKind::AddrInUse.into(),
        39861
    ));
    assert!(!can_choose_another_port(
        &io::ErrorKind::AddrInUse.into(),
        0
    ));
    assert!(!can_choose_another_port(
        &io::ErrorKind::AddrNotAvailable.into(),
        39861
    ));
    assert!(!can_choose_another_port(
        &io::ErrorKind::PermissionDenied.into(),
        39861
    ));
    assert!(!can_choose_another_port(
        &io::ErrorKind::InvalidInput.into(),
        39861
    ));
    assert_eq!(
        can_choose_another_port(&io::Error::from_raw_os_error(10013), 39861),
        cfg!(windows)
    );
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

#[test]
fn media_result_exposes_pixels_as_image_content_without_repeating_base64_in_text() {
    let frame = json!({"state":"completed","result":{"mimeType":"image/png","base64":"aGVsbG8=","artifactId":"preview-one","width":16,"height":16}});
    let content = tool_content(&frame, false);
    assert_eq!(content.len(), 2);
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["data"], "aGVsbG8=");
    assert!(!content[0]["text"].as_str().unwrap().contains("aGVsbG8="));
    assert!(content[0]["text"].as_str().unwrap().contains("preview-one"));
    let chunk = json!({"mimeType":"image/png","encoding":"base64","data":"aGVsbG8=","offset":0});
    assert!(tool_content(&chunk, false)[0]["text"].as_str().unwrap().contains("aGVsbG8="));
    assert_eq!(tool_content(&frame, true).len(), 1);
}
