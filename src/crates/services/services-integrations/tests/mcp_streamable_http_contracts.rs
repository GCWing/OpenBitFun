use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openbitfun_services_integrations::mcp::adapter::render_mcp_tool_result_for_assistant;
use openbitfun_services_integrations::mcp::config::ConfigLocation;
use openbitfun_services_integrations::mcp::protocol::MCPToolResultContent;
use openbitfun_services_integrations::mcp::server::{
    MCPConnection, MCPProcessStartContext, MCPRuntimeErrorKind, MCPServerConfig,
    MCPServerRuntimeState, MCPServerStatus, MCPServerTimeouts, MCPServerTransport, MCPServerType,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::task::JoinSet;

const TOOL_ERROR_DETAIL: &str = "Invalid date: expected YYYY-MM-DD";

#[derive(Clone, Default)]
struct TestState {
    sse_clients_by_session: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
    sse_connected: Arc<AtomicBool>,
    sse_connected_notify: Arc<Notify>,
    saw_session_header: Arc<AtomicBool>,
    saw_roots_capability: Arc<AtomicBool>,
    saw_sampling_capability: Arc<AtomicBool>,
    saw_elicitation_capability: Arc<AtomicBool>,
    initialize_delay_ms: Arc<AtomicU64>,
    ping_error: Arc<AtomicI32>,
    tools_error: Arc<AtomicBool>,
    tools_requests: Arc<AtomicU64>,
    tool_call_sse: Arc<AtomicBool>,
}

struct TestRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<TestRequest>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_offset = loop {
        if let Some(offset) = header_end(&buffer) {
            break offset;
        }

        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 1024 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "test request headers exceeded one MiB",
            ));
        }
    };

    let headers_text = String::from_utf8_lossy(&buffer[..header_offset]);
    let mut lines = headers_text.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let target = request_line.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_offset = header_offset + 4;
    while buffer.len() < body_offset + content_length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "test request body ended early",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = buffer[body_offset..body_offset + content_length].to_vec();

    Ok(Some(TestRequest {
        method,
        target,
        headers,
        body,
    }))
}

async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    response.push_str(body);
    stream.write_all(response.as_bytes()).await
}

async fn serve_sse(
    mut stream: TcpStream,
    state: TestState,
    session_id: String,
) -> std::io::Result<()> {
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        )
        .await?;

    let (tx, rx) = mpsc::unbounded_channel::<String>();
    {
        let mut guard = state.sse_clients_by_session.lock().await;
        guard.entry(session_id).or_default().push(tx);
    }

    if !state.sse_connected.swap(true, Ordering::SeqCst) {
        state.sse_connected_notify.notify_waiters();
    }

    let mut rx = rx;
    while let Some(payload) = rx.recv().await {
        let event = format!("data: {payload}\n\n");
        stream
            .write_all(format!("{:X}\r\n", event.len()).as_bytes())
            .await?;
        stream.write_all(event.as_bytes()).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
    }
    stream.write_all(b"0\r\n\r\n").await?;
    Ok(())
}

async fn handle_post(
    stream: &mut TcpStream,
    state: &TestState,
    headers: &HashMap<String, String>,
    body: &Value,
) -> std::io::Result<()> {
    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let delay_ms = state.initialize_delay_ms.load(Ordering::SeqCst);
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let capabilities = body
                .get("params")
                .and_then(|params| params.get("capabilities"))
                .cloned()
                .unwrap_or(Value::Null);
            if capabilities.get("roots").is_some() {
                state.saw_roots_capability.store(true, Ordering::SeqCst);
            }
            if capabilities.get("sampling").is_some() {
                state.saw_sampling_capability.store(true, Ordering::SeqCst);
            }
            if capabilities.get("elicitation").is_some() {
                state
                    .saw_elicitation_capability
                    .store(true, Ordering::SeqCst);
            }

            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {
                        "tools": { "listChanged": false }
                    },
                    "serverInfo": { "name": "test-mcp", "version": "1.0.0" }
                }
            });

            write_response(
                stream,
                "200 OK",
                &[
                    ("Content-Type", "application/json"),
                    ("Mcp-Session-Id", "test-session"),
                ],
                &response.to_string(),
            )
            .await
        }
        // BigModel-style quirk: return 200 with an empty body (and no Content-Type),
        // which should be treated as Accepted by the client.
        "notifications/initialized" => write_response(stream, "200 OK", &[], "").await,
        "tools/list" => {
            state.tools_requests.fetch_add(1, Ordering::SeqCst);
            if state.tools_error.load(Ordering::SeqCst) {
                return write_response(stream, "500 Internal Server Error", &[], "unavailable")
                    .await;
            }
            let sid = headers
                .get("mcp-session-id")
                .map(String::as_str)
                .unwrap_or_default();
            if sid == "test-session" {
                state.saw_session_header.store(true, Ordering::SeqCst);
            }

            let payload = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "hello",
                            "title": "Hello Tool",
                            "description": "test tool",
                            "inputSchema": { "type": "object", "properties": {} },
                            "outputSchema": { "type": "object", "properties": { "message": { "type": "string" } } },
                            "annotations": {
                                "title": "Hello",
                                "readOnlyHint": true,
                                "destructiveHint": false,
                                "openWorldHint": true
                            },
                            "icons": [
                                {
                                    "src": "https://example.com/tool.png",
                                    "mimeType": "image/png",
                                    "sizes": ["32x32"]
                                }
                            ],
                            "_meta": {
                                "ui": {
                                    "resourceUri": "ui://hello/widget"
                                }
                            }
                        }
                    ],
                    "nextCursor": null
                }
            })
            .to_string();

            write_response(stream, "202 Accepted", &[], "").await?;
            let mut guard = state.sse_clients_by_session.lock().await;
            if let Some(list) = guard.get_mut("test-session") {
                list.retain(|tx| tx.send(payload.clone()).is_ok());
            }
            Ok(())
        }
        "tools/call" => {
            let response =
                if body.pointer("/params/name").and_then(Value::as_str) == Some("missing_tool") {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32602,
                            "message": "Unknown tool: missing_tool",
                            "data": { "tool": "missing_tool", "reason": "tool_not_registered" }
                        }
                    })
                } else {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": TOOL_ERROR_DETAIL }],
                            "isError": true
                        }
                    })
                };
            let (content_type, payload) = if state.tool_call_sse.load(Ordering::SeqCst) {
                (
                    "text/event-stream",
                    format!("event: message\ndata: {response}\n\n"),
                )
            } else {
                ("application/json", response.to_string())
            };
            write_response(
                stream,
                "200 OK",
                &[("Content-Type", content_type)],
                &payload,
            )
            .await
        }
        "ping" if state.ping_error.load(Ordering::SeqCst) != 0 => {
            let response = json!({"jsonrpc": "2.0", "id": id,
                "error": {"code": state.ping_error.load(Ordering::SeqCst), "message": "fixture ping error"}});
            write_response(
                stream,
                "200 OK",
                &[("Content-Type", "application/json")],
                &response.to_string(),
            )
            .await
        }
        _ => {
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {}
            });
            write_response(
                stream,
                "200 OK",
                &[("Content-Type", "application/json")],
                &response.to_string(),
            )
            .await
        }
    }
}

async fn handle_connection(mut stream: TcpStream, state: TestState) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return Ok(());
    };

    if request.target != "/mcp" {
        return write_response(&mut stream, "404 Not Found", &[], "").await;
    }

    match request.method.as_str() {
        "GET" => {
            let session_id = request
                .headers
                .get("mcp-session-id")
                .cloned()
                .unwrap_or_default();
            serve_sse(stream, state, session_id).await
        }
        "POST" => {
            let is_json = request
                .headers
                .get("content-type")
                .and_then(|value| value.split(';').next())
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
            if !is_json {
                return write_response(&mut stream, "415 Unsupported Media Type", &[], "").await;
            }
            let body = serde_json::from_slice(&request.body)?;
            handle_post(&mut stream, &state, &request.headers, &body).await
        }
        _ => write_response(&mut stream, "405 Method Not Allowed", &[], "").await,
    }
}

async fn raw_status_line(addr: std::net::SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr)
        .await
        .expect("test fixture should accept a raw request");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("raw request should be written");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("test fixture should close its rejection response");
    String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string()
}

async fn assert_streamable_http_tool_errors_reach_assistant(use_post_sse: bool) {
    let state = TestState::default();
    state.tool_call_sse.store(use_post_sse, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        while let Ok((stream, _)) = listener.accept().await {
            let state = state.clone();
            connections.spawn(async move {
                let _ = handle_connection(stream, state).await;
            });
        }
    });

    let responses = tokio::time::timeout(Duration::from_secs(5), async {
        let connection = MCPConnection::new_remote(
            "tool-errors-test",
            format!("http://{addr}/mcp"),
            Default::default(),
            false,
        )
        .await
        .expect("remote connection should be created");
        connection
            .initialize("OpenBitFunTest", "1.0.0")
            .await
            .expect("initialize should succeed");
        let execution_result = connection
            .call_tool("hello", Some(json!({ "date": "invalid" })))
            .await;
        let protocol_result = connection.call_tool("missing_tool", None).await;
        drop(connection);
        (execution_result, protocol_result)
    })
    .await;
    // Aborting the listener drops its JoinSet and cancels the persistent GET SSE handlers.
    server.abort();
    let _ = server.await;

    let (execution_result, protocol_result) =
        responses.expect("Streamable HTTP tool calls should complete promptly");
    let execution_result =
        execution_result.expect("a tool execution error should remain a valid MCP result");
    assert!(execution_result.is_error);
    assert!(matches!(
        execution_result.content.as_deref(),
        Some([MCPToolResultContent::Text { text }]) if text == TOOL_ERROR_DETAIL
    ));
    let assistant_text =
        render_mcp_tool_result_for_assistant("hello", &execution_result, usize::MAX);
    assert!(
        assistant_text.contains(TOOL_ERROR_DETAIL),
        "the assistant must receive the server's actionable error detail: {assistant_text}"
    );

    let protocol_error = protocol_result
        .expect_err("a JSON-RPC error should fail the tool call")
        .to_string();
    for detail in [
        "-32602",
        "Unknown tool: missing_tool",
        "tool_not_registered",
    ] {
        assert!(
            protocol_error.contains(detail),
            "the protocol error must preserve code, message and data: {protocol_error}"
        );
    }
}

#[tokio::test]
async fn remote_mcp_tool_errors_reach_assistant_via_json() {
    assert_streamable_http_tool_errors_reach_assistant(false).await;
}

#[tokio::test]
async fn remote_mcp_tool_errors_reach_assistant_via_post_sse() {
    assert_streamable_http_tool_errors_reach_assistant(true).await;
}

#[tokio::test]
async fn remote_startup_timeout_preserves_timeout_kind_and_cleans_connection() {
    let state = TestState::default();
    state.initialize_delay_ms.store(100, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let connection_state = server_state.clone();
            tokio::spawn(async move {
                handle_connection(stream, connection_state)
                    .await
                    .expect("test MCP connection should complete");
            });
        }
    });

    let runtime = MCPServerRuntimeState::new();
    let config = MCPServerConfig {
        id: "startup-timeout".to_string(),
        name: "Startup timeout".to_string(),
        server_type: MCPServerType::Remote,
        transport: Some(MCPServerTransport::StreamableHttp),
        command: None,
        args: Vec::new(),
        env: Default::default(),
        working_directory: None,
        inherit_parent_environment: None,
        headers: Default::default(),
        url: Some(format!("http://{addr}/mcp")),
        auto_start: true,
        enabled: true,
        location: ConfigLocation::BuiltIn,
        capabilities: Vec::new(),
        settings: Default::default(),
        oauth: None,
        oauth_enabled: Some(false),
        xaa: None,
        timeouts: MCPServerTimeouts {
            startup_ms: Some(20),
            ..Default::default()
        },
    };
    let data_dir = tempfile::tempdir().unwrap();

    let error = runtime
        .start_process(
            &config,
            MCPProcessStartContext::Remote {
                data_dir: data_dir.path().to_path_buf(),
            },
        )
        .await
        .expect_err("remote startup should time out");

    assert_eq!(error.kind(), MCPRuntimeErrorKind::Timeout);
    assert_eq!(
        runtime.process_status(&config.id).await.unwrap(),
        MCPServerStatus::Failed
    );
    assert!(runtime.process_connection(&config.id).await.is_none());
}

#[tokio::test]
async fn remote_mcp_streamable_http_accepts_202_and_delivers_response_via_sse() {
    let state = TestState::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let connection_state = server_state.clone();
            tokio::spawn(async move {
                handle_connection(stream, connection_state)
                    .await
                    .expect("test MCP connection should complete");
            });
        }
    });

    assert_eq!(
        raw_status_line(
            addr,
            "POST /wrong HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        )
        .await,
        "HTTP/1.1 404 Not Found",
    );
    assert_eq!(
        raw_status_line(
            addr,
            "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}",
        )
        .await,
        "HTTP/1.1 415 Unsupported Media Type",
    );
    assert_eq!(
        raw_status_line(addr, "PUT /mcp HTTP/1.1\r\nHost: localhost\r\n\r\n").await,
        "HTTP/1.1 405 Method Not Allowed",
    );

    let url = format!("http://{addr}/mcp");
    let connection = MCPConnection::new_remote("test-server", url, Default::default(), false)
        .await
        .expect("remote connection should be created");

    connection
        .initialize("OpenBitFunTest", "0.0.0")
        .await
        .expect("initialize should succeed");

    // `Notify::notify_waiters` only wakes tasks already waiting. The rmcp client may open the
    // SSE GET during `initialize` and fire notify before we await `notified()`, which would
    // drop the wakeup and time out. The atomic records that the handler ran at least once.
    if !state.sse_connected.load(Ordering::SeqCst) {
        tokio::time::timeout(
            Duration::from_secs(2),
            state.sse_connected_notify.notified(),
        )
        .await
        .expect("SSE stream should connect");
    }

    let tools = connection
        .list_tools(None)
        .await
        .expect("tools/list should resolve via SSE");
    assert_eq!(tools.tools.len(), 1);
    assert_eq!(tools.tools[0].name, "hello");
    assert_eq!(tools.tools[0].title.as_deref(), Some("Hello Tool"));
    assert_eq!(
        tools.tools[0]
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.read_only_hint),
        Some(true)
    );
    assert_eq!(
        tools.tools[0]
            .meta
            .as_ref()
            .and_then(|meta| meta.ui.as_ref())
            .and_then(|ui| ui.resource_uri.as_deref()),
        Some("ui://hello/widget")
    );

    assert!(
        state.saw_session_header.load(Ordering::SeqCst),
        "client should forward session id header on subsequent requests"
    );
    assert!(
        state.saw_roots_capability.load(Ordering::SeqCst),
        "client should advertise roots capability"
    );
    assert!(
        state.saw_sampling_capability.load(Ordering::SeqCst),
        "client should advertise sampling capability"
    );
    assert!(
        state.saw_elicitation_capability.load(Ordering::SeqCst),
        "client should advertise elicitation capability"
    );
}

#[tokio::test]
async fn remote_mcp_health_falls_back_only_for_unsupported_ping() {
    let state = TestState::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let state = server_state.clone();
            tokio::spawn(async move {
                let _ = handle_connection(stream, state).await;
            });
        }
    });
    let connection = MCPConnection::new_remote(
        "health-test",
        format!("http://{addr}/mcp"),
        Default::default(),
        false,
    )
    .await
    .unwrap();
    connection
        .initialize("OpenBitFunTest", "1.0.0")
        .await
        .unwrap();
    if !state.sse_connected.load(Ordering::SeqCst) {
        tokio::time::timeout(
            Duration::from_secs(2),
            state.sse_connected_notify.notified(),
        )
        .await
        .unwrap();
    }
    connection.ping().await.unwrap();
    assert_eq!(state.tools_requests.load(Ordering::SeqCst), 0);
    state.ping_error.store(-32601, Ordering::SeqCst);
    connection
        .ping()
        .await
        .expect("unsupported ping should use tools/list");
    assert_eq!(state.tools_requests.load(Ordering::SeqCst), 1);
    state.ping_error.store(-32603, Ordering::SeqCst);
    assert!(connection.ping().await.is_err());
    assert_eq!(state.tools_requests.load(Ordering::SeqCst), 1);
    state.ping_error.store(-32601, Ordering::SeqCst);
    state.tools_error.store(true, Ordering::SeqCst);
    assert!(
        connection.ping().await.is_err(),
        "failed fallback must not report healthy"
    );
    server.abort();
}
