//! Authenticated local editing transport. Project state remains in the editor.
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Bytes, Incoming},
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs,
    io::Write,
    net::{IpAddr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, Semaphore};

const MAX_BODY: usize = 1_048_576;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_IDLE_TIMEOUT: Duration = Duration::from_secs(40);
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
pub type Dispatch = Arc<dyn Fn(McpRequest) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub url: Option<String>,
    pub pending_requests: usize,
    /// Authenticated open HTTP transports, not unique agents or recent requests.
    pub connected_clients: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRequest {
    pub id: String,
    pub tool: String,
    pub arguments: Value,
    pub created_at: u64,
    pub deadline_at: u64,
}

struct Pending {
    request: McpRequest,
    deadline: Instant,
    claimed: bool,
    reply: oneshot::Sender<(Value, bool)>,
}
struct Running {
    address: SocketAddr,
    stopped: Arc<AtomicBool>,
    connected_clients: Arc<AtomicUsize>,
    thread: thread::JoinHandle<()>,
}
struct Inner {
    path: PathBuf,
    config: Mutex<McpConfig>,
    running: Mutex<Option<Running>>,
    pending: Mutex<HashMap<String, Pending>>,
    sequence: AtomicU64,
    request_timeout: Duration,
    connection_idle_timeout: Duration,
}
#[derive(Clone)]
pub struct McpManager(Arc<Inner>);

fn token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成 MCP 访问令牌。".to_string())?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
fn validate_config(mut config: McpConfig, allow_zero_port: bool) -> Result<McpConfig, String> {
    config.host = config.host.trim().to_owned();
    if config.host == "localhost" {
        config.host = "127.0.0.1".into();
    }
    config
        .host
        .parse::<IpAddr>()
        .map_err(|_| "监听地址必须是有效的 IP 地址。".to_string())?;
    if config.port == 0 && !allow_zero_port {
        return Err("监听端口须为 1 至 65535。".into());
    }
    if config.token.is_empty() {
        config.token = token()?;
    }
    if !(32..=256).contains(&config.token.len())
        || !config.token.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err("访问令牌须包含 32 至 256 个不含空格的 ASCII 字符。".into());
    }
    Ok(config)
}
fn save_config(path: &PathBuf, config: &McpConfig) -> Result<(), String> {
    let parent = path.parent().ok_or("MCP 配置目录无效。")?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建 MCP 配置目录：{e}"))?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法保存 MCP 配置：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    serde_json::to_writer(file.as_file_mut(), config).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path)
        .map_err(|e| format!("无法保存 MCP 配置：{}", e.error))?;
    Ok(())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn can_choose_another_port(error: &std::io::Error, requested_port: u16) -> bool {
    requested_port != 0
        && (error.kind() == std::io::ErrorKind::AddrInUse
            // A reserved or exclusively owned Windows port can report WSAEACCES.
            // Retry only this port-specific case on the same listening address.
            || cfg!(windows) && error.raw_os_error() == Some(10013))
}

impl McpManager {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let config = if path.exists() {
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.len() > 4096 {
                return Err("MCP 配置文件无效。".into());
            }
            let bytes = fs::read(&path).map_err(|e| format!("无法读取 MCP 配置：{e}"))?;
            validate_config(
                serde_json::from_slice(&bytes).map_err(|_| "MCP 配置文件无效。")?,
                false,
            )?
        } else {
            McpConfig {
                host: "127.0.0.1".into(),
                port: 39861,
                token: token()?,
            }
        };
        save_config(&path, &config)?;
        Ok(Self(Arc::new(Inner {
            path,
            config: Mutex::new(config),
            running: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            request_timeout: REQUEST_TIMEOUT,
            connection_idle_timeout: CONNECTION_IDLE_TIMEOUT,
        })))
    }
    pub fn config(&self) -> McpConfig {
        self.0.config.lock().unwrap().clone()
    }
    pub fn save_config(&self, config: McpConfig) -> Result<McpConfig, String> {
        let mut running = self.0.running.lock().unwrap();
        reap_stopped(&mut running);
        if running.is_some() {
            return Err("请先停止 MCP 服务，再修改连接配置。".into());
        }
        let config = validate_config(config, false)?;
        save_config(&self.0.path, &config)?;
        *self.0.config.lock().unwrap() = config.clone();
        Ok(config)
    }
    pub fn status(&self) -> McpStatus {
        let running = self.0.running.lock().unwrap();
        let config = self.0.config.lock().unwrap();
        McpStatus {
            running: running
                .as_ref()
                .is_some_and(|r| !r.stopped.load(Ordering::Acquire)),
            host: config.host.clone(),
            port: running.as_ref().map_or(config.port, |r| r.address.port()),
            url: running
                .as_ref()
                .filter(|r| !r.stopped.load(Ordering::Acquire))
                .map(|r| {
                    let mut address = r.address;
                    if address.ip().is_unspecified() {
                        address.set_ip(if address.is_ipv4() {
                            IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                        } else {
                            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
                        });
                    }
                    format!("http://{address}/mcp")
                }),
            pending_requests: self.0.pending.lock().unwrap().len(),
            connected_clients: running
                .as_ref()
                .filter(|r| !r.stopped.load(Ordering::Acquire))
                .map_or(0, |r| r.connected_clients.load(Ordering::Acquire)),
        }
    }
    pub fn start(
        &self,
        config: McpConfig,
        tools: Vec<Value>,
        dispatch: Dispatch,
    ) -> Result<McpStatus, String> {
        let mut running = self.0.running.lock().unwrap();
        reap_stopped(&mut running);
        if running.is_some() {
            return Err("MCP 服务已经启动。".into());
        }
        let mut config = validate_config(config, cfg!(test))?;
        if tools.is_empty()
            || tools.len() > 200
            || serde_json::to_vec(&tools).map_err(|e| e.to_string())?.len() > MAX_BODY
        {
            return Err("MCP 工具清单无效。".into());
        }
        let mut names = std::collections::HashSet::new();
        for tool in &tools {
            let name = tool["name"].as_str().ok_or("MCP 工具缺少名称。")?;
            if name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                || !names.insert(name.to_owned())
                || tool["inputSchema"]["type"] != "object"
            {
                return Err("MCP 工具清单无效。".into());
            }
        }
        let address = SocketAddr::new(config.host.parse().unwrap(), config.port);
        // Keep the actual listener bound throughout startup. Probing and closing
        // a free port first would let another process claim it before we start.
        let listener = match TcpListener::bind(address) {
            Ok(listener) => listener,
            Err(error) if can_choose_another_port(&error, address.port()) => {
                TcpListener::bind(SocketAddr::new(address.ip(), 0))
                    .map_err(|e| format!("无法选择可用的 MCP 端口：{e}"))?
            }
            Err(error) => return Err(format!("无法启动 MCP 服务：{error}")),
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        config.port = address.port();
        // Build the runtime before reporting success, so setup failures are visible to the caller.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let listener = {
            let _context = runtime.enter();
            tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?
        };
        let startup = Arc::new((Mutex::new(None::<bool>), Condvar::new()));
        let wait_for_startup = startup.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let connected_clients = Arc::new(AtomicUsize::new(0));
        let clients = connected_clients.clone();
        let idle_timeout = self.0.connection_idle_timeout;
        let server = Server {
            manager: self.clone(),
            config: config.clone(),
            tools: Arc::new(tools),
            dispatch,
            stopped: stop.clone(),
        };
        let thread = thread::Builder::new()
            .name("media-mcp".into())
            .spawn(move || {
                // No requests are accepted until both the worker and the atomic
                // configuration write succeed. Failed writes release the socket.
                let (lock, ready) = &*wait_for_startup;
                let mut start = lock.lock().unwrap();
                while start.is_none() {
                    start = ready.wait(start).unwrap();
                }
                let allowed = *start == Some(true);
                drop(start);
                if !allowed {
                    return;
                }
                runtime.block_on(async move {
                    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
                    while !stop.load(Ordering::Acquire) {
                        match tokio::time::timeout(Duration::from_millis(100), listener.accept())
                            .await
                        {
                            Ok(Ok((stream, _))) => {
                                let Ok(permit) = slots.clone().try_acquire_owned() else {
                                    drop(stream);
                                    continue;
                                };
                                let Ok(local) = stream.local_addr() else {
                                    continue;
                                };
                                let server = server.clone();
                                let connection = Arc::new(ClientConnection {
                                    authenticated: AtomicBool::new(false),
                                    clients: clients.clone(),
                                });
                                tokio::spawn(async move {
                                    let _permit = permit;
                                    let service = service_fn(move |request| {
                                        handle(request, server.clone(), local, connection.clone())
                                    });
                                    // Reset the idle/header timeout for each request; an
                                    // active request must not inherit a connection deadline.
                                    let _ = hyper::server::conn::http1::Builder::new()
                                        .keep_alive(true)
                                        .timer(TokioTimer::new())
                                        .header_read_timeout(idle_timeout)
                                        .max_buf_size(32 * 1024)
                                        .serve_connection(TokioIo::new(stream), service)
                                        .await;
                                });
                            }
                            Ok(Err(_)) => break,
                            Err(_) => {}
                        }
                    }
                    stop.store(true, Ordering::Release);
                });
            })
            .map_err(|e| format!("无法启动 MCP 服务：{e}"))?;
        if let Err(error) = save_config(&self.0.path, &config) {
            *startup.0.lock().unwrap() = Some(false);
            startup.1.notify_one();
            let _ = thread.join();
            return Err(error);
        }
        *self.0.config.lock().unwrap() = config;
        *running = Some(Running {
            address,
            stopped,
            connected_clients,
            thread,
        });
        *startup.0.lock().unwrap() = Some(true);
        startup.1.notify_one();
        drop(running);
        Ok(self.status())
    }
    pub fn stop(&self) -> McpStatus {
        let mut guard = self.0.running.lock().unwrap();
        if let Some(running) = guard.take() {
            running.stopped.store(true, Ordering::Release);
            self.0.pending.lock().unwrap().clear();
            let _ = running.thread.join();
        }
        drop(guard);
        self.status()
    }
    pub fn pending(&self) -> Vec<McpRequest> {
        self.0
            .pending
            .lock()
            .unwrap()
            .values()
            .filter(|p| !p.claimed && p.deadline > Instant::now())
            .map(|p| p.request.clone())
            .collect()
    }
    /// Claim immediately before synchronous edits. Long work must return a job id promptly.
    pub fn claim(&self, id: &str) -> bool {
        let mut pending = self.0.pending.lock().unwrap();
        let Some(item) = pending.get_mut(id) else {
            return false;
        };
        if item.claimed || item.deadline <= Instant::now() {
            return false;
        }
        item.claimed = true;
        true
    }
    pub fn complete(&self, id: &str, result: Value, is_error: bool) -> bool {
        let mut pending = self.0.pending.lock().unwrap();
        if !pending
            .get(id)
            .is_some_and(|p| p.claimed && p.deadline > Instant::now())
        {
            return false;
        }
        let item = pending.remove(id).unwrap();
        item.reply.send((result, is_error)).is_ok()
    }
}

fn reap_stopped(running: &mut Option<Running>) {
    if running
        .as_ref()
        .is_some_and(|r| r.stopped.load(Ordering::Acquire) || r.thread.is_finished())
    {
        if let Some(stopped) = running.take() {
            let _ = stopped.thread.join();
        }
    }
}

#[derive(Clone)]
struct Server {
    manager: McpManager,
    config: McpConfig,
    tools: Arc<Vec<Value>>,
    dispatch: Dispatch,
    stopped: Arc<AtomicBool>,
}

struct ClientConnection {
    authenticated: AtomicBool,
    // This counter belongs to one service generation. Old sockets cannot
    // decrement a newly started service's count.
    clients: Arc<AtomicUsize>,
}
impl ClientConnection {
    fn authenticate(&self) {
        if !self.authenticated.swap(true, Ordering::AcqRel) {
            self.clients.fetch_add(1, Ordering::AcqRel);
        }
    }
}
impl Drop for ClientConnection {
    fn drop(&mut self) {
        if self.authenticated.load(Ordering::Acquire) {
            self.clients.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

type HttpResponse = Response<Full<Bytes>>;
fn response(status: StatusCode, value: Value) -> HttpResponse {
    let mut result = Response::new(Full::new(Bytes::from(value.to_string())));
    *result.status_mut() = status;
    result
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    result
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    result
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    result
}
fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn success(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn empty(status: StatusCode) -> HttpResponse {
    let mut result = Response::new(Full::new(Bytes::new()));
    *result.status_mut() = status;
    result
}
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |diff, (a, b)| diff | (a ^ b)) == 0
}
fn valid_host(request: &Request<Incoming>, local: SocketAddr) -> bool {
    if request.headers().get_all("host").iter().count() != 1 {
        return false;
    }
    let Some(authority) = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<hyper::http::uri::Authority>().ok())
    else {
        return false;
    };
    if authority.port_u16().unwrap_or(80) != local.port() {
        return false;
    }
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']');
    host.parse::<IpAddr>().is_ok_and(|ip| ip == local.ip())
        || (host == "localhost" && local.ip().is_loopback())
}
async fn handle(
    request: Request<Incoming>,
    server: Server,
    local: SocketAddr,
    connection: Arc<ClientConnection>,
) -> Result<HttpResponse, Infallible> {
    if !valid_host(&request, local) || request.headers().contains_key("origin") {
        return Ok(response(
            StatusCode::FORBIDDEN,
            json!({"error":"请求来源不被允许。"}),
        ));
    }
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (scheme, supplied_token) = authorization.split_once(' ').unwrap_or(("", ""));
    if request.headers().get_all("authorization").iter().count() != 1
        || !scheme.eq_ignore_ascii_case("Bearer")
        || !constant_time_eq(supplied_token.as_bytes(), server.config.token.as_bytes())
    {
        let mut result = response(
            StatusCode::UNAUTHORIZED,
            json!({"error":"MCP 访问令牌无效。"}),
        );
        result
            .headers_mut()
            .insert("www-authenticate", "Bearer".parse().unwrap());
        return Ok(result);
    }
    if request.uri().path() != "/mcp" || request.uri().query().is_some() {
        return Ok(response(
            StatusCode::NOT_FOUND,
            json!({"error":"接口不存在。"}),
        ));
    }
    if request.method() != Method::POST {
        let mut result = response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"该服务使用 POST JSON 请求；不提供独立事件流。"}),
        );
        result
            .headers_mut()
            .insert("allow", "POST".parse().unwrap());
        return Ok(result);
    }
    if request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| {
            !v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        return Ok(response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"error":"请求须使用 application/json。"}),
        ));
    }
    if request
        .headers()
        .get("mcp-protocol-version")
        .is_some_and(|v| v.to_str().ok().is_none_or(|s| !PROTOCOLS.contains(&s)))
    {
        return Ok(response(
            StatusCode::BAD_REQUEST,
            json!({"error":"MCP 协议版本不受支持。"}),
        ));
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .is_some_and(|size| size > MAX_BODY)
    {
        return Ok(response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error":"请求内容超过限制。"}),
        ));
    }
    let collected = tokio::time::timeout(
        Duration::from_secs(5),
        http_body_util::Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await;
    let body = match collected {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => {
            return Ok(response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"请求内容无效或超过限制。"}),
            ))
        }
        Err(_) => {
            return Ok(response(
                StatusCode::REQUEST_TIMEOUT,
                json!({"error":"请求内容读取超时。"}),
            ))
        }
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                error(Value::Null, -32700, "JSON 解析失败。"),
            ))
        }
    };
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if !message.is_object()
        || message["jsonrpc"] != "2.0"
        || !message["method"].is_string()
        || !(id.is_null() || id.is_string() || id.is_number())
        || message.get("params").is_some_and(|v| !v.is_object())
    {
        return Ok(response(
            StatusCode::OK,
            error(Value::Null, -32600, "JSON-RPC 请求无效。"),
        ));
    }
    if server.stopped.load(Ordering::Acquire) {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            error(id, -32000, "MCP 服务已停止。"),
        ));
    }
    if !message.as_object().unwrap().contains_key("id") {
        if message["method"] == "notifications/initialized" {
            connection.authenticate();
        }
        return Ok(empty(StatusCode::ACCEPTED));
    }
    let result = match message["method"].as_str().unwrap() {
        "initialize" => {
            connection.authenticate();
            let requested = message["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOLS.contains(&requested) {
                requested
            } else {
                PROTOCOLS[0]
            };
            success(
                id,
                json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"Open Media","version":env!("CARGO_PKG_VERSION")},"instructions":"通过工具编辑当前桌面工程。长任务返回 jobId，请使用任务查询工具读取进度；修改会同步到桌面，保存需调用保存工具。"}),
            )
        }
        "ping" => {
            connection.authenticate();
            success(id, json!({}))
        }
        "tools/list" => {
            connection.authenticate();
            success(id, json!({"tools":server.tools.as_ref()}))
        }
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            let arguments = message["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({}));
            if !server.tools.iter().any(|t| t["name"] == name) || !arguments.is_object() {
                error(id, -32602, "工具名称或参数无效。")
            } else {
                connection.authenticate();
                dispatch_tool(&server, id, name.to_owned(), arguments).await
            }
        }
        _ => error(id, -32601, "MCP 方法不存在。"),
    };
    Ok(response(StatusCode::OK, result))
}

struct PendingGuard {
    manager: McpManager,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.manager.0.pending.lock().unwrap().remove(&self.id);
    }
}
async fn dispatch_tool(server: &Server, rpc_id: Value, tool: String, arguments: Value) -> Value {
    let id = format!(
        "mcp-{}-{}",
        now_ms(),
        server.manager.0.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let created_at = now_ms();
    let timeout = server.manager.0.request_timeout;
    let request = McpRequest {
        id: id.clone(),
        tool,
        arguments,
        created_at,
        deadline_at: created_at + timeout.as_millis() as u64,
    };
    let (reply, received) = oneshot::channel();
    {
        let mut pending = server.manager.0.pending.lock().unwrap();
        if server.stopped.load(Ordering::Acquire) {
            return error(rpc_id, -32000, "MCP 服务已停止。");
        }
        if pending.len() >= MAX_CONNECTIONS {
            return error(rpc_id, -32000, "编辑器请求过多，请稍后重试。");
        }
        pending.insert(
            id.clone(),
            Pending {
                request: request.clone(),
                deadline: Instant::now() + timeout,
                claimed: false,
                reply,
            },
        );
    }
    let _guard = PendingGuard {
        manager: server.manager.clone(),
        id,
    };
    if (server.dispatch)(request).is_err() {
        return error(rpc_id, -32000, "无法连接编辑器，请打开视频剪辑界面。");
    }
    match tokio::time::timeout(timeout, received).await {
        Ok(Ok((result, is_error))) => {
            let content = tool_content(&result, is_error);
            let structured = if result.is_object() { result } else { json!({"result":result}) };
            success(rpc_id, json!({"content":content,"structuredContent":structured,"isError":is_error}))
        }
        Ok(Err(_)) => error(rpc_id, -32000, "MCP 请求已取消。"),
        Err(_) => error(rpc_id, -32000, "编辑器响应超时，请确认视频剪辑界面已打开。"),
    }
}

/// Image results are native MCP image content so agents can inspect composed pixels.
/// Keep binary download chunks unchanged; only remove duplicated image bytes from text.
fn tool_content(result: &Value, is_error: bool) -> Vec<Value> {
    let payload = result.get("result").filter(|value| value.is_object()).unwrap_or(result);
    let frame = payload.get("sheet").filter(|value| value.is_object()).unwrap_or(payload);
    let image = if !is_error && frame.get("mimeType").and_then(Value::as_str) == Some("image/png") {
        frame.get("base64").and_then(Value::as_str).filter(|data| !data.is_empty() && data.len() <= 12 * 1024 * 1024)
    } else { None };
    let text_value = if image.is_some() {
        fn strip(value: &Value) -> Value {
            match value {
                Value::Object(fields) => Value::Object(fields.iter().filter(|(key, _)| key.as_str() != "base64").map(|(key, value)| (key.clone(), strip(value))).collect()),
                Value::Array(values) => Value::Array(values.iter().map(strip).collect()),
                _ => value.clone(),
            }
        }
        strip(result)
    } else { result.clone() };
    let text = text_value.as_str().map(str::to_owned).unwrap_or_else(|| text_value.to_string());
    let mut content = vec![json!({"type":"text","text":text})];
    if let Some(data) = image { content.push(json!({"type":"image","mimeType":"image/png","data":data})); }
    content
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
