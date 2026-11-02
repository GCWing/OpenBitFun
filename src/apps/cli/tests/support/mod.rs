#![allow(dead_code)]

use portable_pty::CommandBuilder;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) const STREAM_START_MARKER: &str = "ACTIVE_TURN_STREAM_MARKER";
pub(crate) const STREAM_RESIZED_MARKER: &str = "RESIZED_OK";
pub(crate) const STREAM_COMPLETED_MARKER: &str = "ACTIVE_TURN_STREAM_COMPLETED";

pub(crate) fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Output {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn CLI process");
    let mut child_stdout = child.stdout.take().expect("capture CLI stdout");
    let mut child_stderr = child.stderr.take().expect("capture CLI stderr");
    let (stdout_tx, stdout_rx) = mpsc::sync_channel(1);
    let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = child_stdout.read_to_end(&mut output).map(|_| output);
        let _ = stdout_tx.send(result);
    });
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = child_stderr.read_to_end(&mut output).map(|_| output);
        let _ = stderr_tx.send(result);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll CLI process") {
            break status;
        }
        if Instant::now() >= deadline {
            let kill_error = child.kill().err();
            let termination_result = if kill_error.is_none() {
                wait_for_child_exit(&mut child, Instant::now() + Duration::from_secs(2))
            } else {
                None
            };
            let output_deadline = Instant::now() + Duration::from_secs(2);
            let stdout = recv_pipe_output(&stdout_rx, output_deadline, "stdout");
            let stderr = recv_pipe_output(&stderr_rx, output_deadline, "stderr");
            panic!(
                "CLI process exceeded {timeout:?}; kill_error={kill_error:?}; termination_result={termination_result:?}\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    let output_deadline = Instant::now() + Duration::from_secs(2);

    Output {
        status,
        stdout: recv_pipe_output(&stdout_rx, output_deadline, "stdout"),
        stderr: recv_pipe_output(&stderr_rx, output_deadline, "stderr"),
    }
}

fn wait_for_child_exit(
    child: &mut std::process::Child,
    deadline: Instant,
) -> Option<std::io::Result<std::process::ExitStatus>> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(Ok(status)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => return None,
            Err(error) => return Some(Err(error)),
        }
    }
}

fn recv_pipe_output(
    receiver: &mpsc::Receiver<std::io::Result<Vec<u8>>>,
    deadline: Instant,
    stream: &str,
) -> Vec<u8> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    receiver
        .recv_timeout(remaining)
        .unwrap_or_else(|error| panic!("timed out collecting CLI {stream}: {error}"))
        .unwrap_or_else(|error| panic!("failed to read CLI {stream}: {error}"))
}

pub(crate) struct CliTestEnvironment {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    user_root: PathBuf,
    home_root: PathBuf,
    config_root: PathBuf,
}

impl CliTestEnvironment {
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().expect("create isolated CLI environment");
        let workspace = temp.path().join("workspace");
        let user_root = temp.path().join("user-root");
        let home_root = temp.path().join("home");
        let config_root = temp.path().join("config-root");
        for path in [&workspace, &user_root, &home_root, &config_root] {
            std::fs::create_dir_all(path).expect("create isolated CLI directory");
        }

        Self {
            _temp: temp,
            workspace,
            user_root,
            home_root,
            config_root,
        }
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn session_metadata_path(&self, session_id: &str) -> PathBuf {
        fn find(dir: &Path, session_id: &str) -> Option<PathBuf> {
            for entry in std::fs::read_dir(dir).ok()? {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().and_then(|name| name.to_str()) == Some(session_id) {
                        let metadata = path.join("metadata.json");
                        if metadata.is_file() {
                            return Some(metadata);
                        }
                    }
                    if let Some(found) = find(&path, session_id) {
                        return Some(found);
                    }
                }
            }
            None
        }

        find(self._temp.path(), session_id).unwrap_or_else(|| {
            panic!(
                "persisted metadata for session {session_id} was not found under {}",
                self._temp.path().display()
            )
        })
    }

    pub(crate) fn configure_mock_model(&self, server_base_url: &str) {
        self.configure_mock_model_with_capabilities(
            server_base_url,
            &["text_chat", "function_calling"],
        );
    }

    pub(crate) fn configure_product_control_mock_model(&self, server_base_url: &str) {
        self.configure_tool_loop_mock_model(server_base_url);
    }

    pub(crate) fn configure_tool_loop_mock_model(&self, server_base_url: &str) {
        self.configure_mock_model(server_base_url);
        self.allow_tool_loop_rounds();
    }

    pub(crate) fn configure_tool_loop_image_model(&self, server_base_url: &str) {
        self.configure_mock_image_model(server_base_url);
        self.allow_tool_loop_rounds();
    }

    fn allow_tool_loop_rounds(&self) {
        let config_path = self.user_root.join("config/app.json");
        let mut config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&config_path).expect("read tool-loop model config"),
        )
        .expect("parse tool-loop model config");
        config["ai"]["max_rounds"] = json!(8);
        std::fs::write(
            config_path,
            serde_json::to_vec_pretty(&config).expect("serialize tool-loop model config"),
        )
        .expect("write tool-loop model config");
    }

    pub(crate) fn app_config(&self) -> serde_json::Value {
        serde_json::from_slice(
            &std::fs::read(self.user_root.join("config/app.json")).expect("read CLI app config"),
        )
        .expect("parse CLI app config")
    }

    pub(crate) fn cron_jobs_path(&self) -> PathBuf {
        self.user_root.join("data/cron/jobs.json")
    }

    pub(crate) fn cron_jobs(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.cron_jobs_path()).expect("read scheduled jobs"))
            .expect("parse scheduled jobs")
    }

    pub(crate) fn configure_mock_image_model(&self, server_base_url: &str) {
        self.configure_mock_model_with_capabilities(
            server_base_url,
            &["text_chat", "function_calling", "image_understanding"],
        );
    }

    fn configure_mock_model_with_capabilities(&self, server_base_url: &str, capabilities: &[&str]) {
        let config_dir = self.user_root.join("config");
        std::fs::create_dir_all(&config_dir).expect("create model config directory");
        let base_url = format!("{}/v1", server_base_url.trim_end_matches('/'));
        let request_url = format!("{base_url}/chat/completions");
        let mut config =
            serde_json::to_value(openbitfun_core::service::config::GlobalConfig::default())
                .expect("serialize default CLI config");
        config["app"]["ai_experience"]["enable_session_title_generation"] = json!(false);
        config["ai"]["models"] = json!([{
            "id": "cli-e2e-model",
            "name": "CLI E2E Model",
            "provider": "openai",
            "model_name": "cli-e2e-model",
            "base_url": base_url,
            "request_url": request_url,
            "api_key": "cli-e2e-key",
            "enabled": true,
            "category": "general_chat",
            "capabilities": capabilities
        }]);
        config["ai"]["default_models"] = json!({
            "primary": "cli-e2e-model"
        });
        config["ai"]["agent_model_defaults"] = json!({
            "mode": "cli-e2e-model"
        });
        config["ai"]["max_rounds"] = json!(1);
        config["ai"]["stream_idle_timeout_secs"] = json!(10);
        config["ai"]["stream_ttft_timeout_secs"] = json!(10);
        std::fs::write(
            config_dir.join("app.json"),
            serde_json::to_vec_pretty(&config).expect("serialize model config"),
        )
        .expect("write model config");
    }

    pub(crate) fn initialize_git_repository(&self) {
        self.run_git(&["init", "--quiet"]);
        self.run_git(&["config", "user.email", "cli-tests@example.invalid"]);
        self.run_git(&["config", "user.name", "CLI Tests"]);
        std::fs::write(self.workspace.join("seed.txt"), "seed\n").expect("write git seed");
        self.run_git(&["add", "seed.txt"]);
        self.run_git(&["commit", "--quiet", "-m", "seed"]);
    }

    pub(crate) fn std_command(&self) -> Command {
        let mut command = openbitfun_services_core::process_manager::create_command(env!(
            "CARGO_BIN_EXE_openbitfun"
        ));
        command.current_dir(&self.workspace);
        self.apply_std_environment(&mut command);
        command
    }

    pub(crate) fn apply_tokio_environment(&self, command: &mut tokio::process::Command) {
        command
            .current_dir(&self.workspace)
            .env_remove("OPENBITFUN_USER_ROOT")
            .env_remove("OPENBITFUN_HOME")
            .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
            .env("OPENBITFUN_E2E_USER_ROOT", &self.user_root)
            .env("OPENBITFUN_E2E_HOME", &self.home_root)
            .env("APPDATA", &self.config_root)
            .env("XDG_CONFIG_HOME", &self.config_root)
            .env("HOME", &self.home_root)
            .env("USERPROFILE", &self.home_root)
            .env("TERM", "xterm-256color");
    }

    pub(crate) fn pty_command(&self) -> CommandBuilder {
        self.pty_command_for(env!("CARGO_BIN_EXE_openbitfun"))
    }

    fn pty_command_for(&self, binary: &str) -> CommandBuilder {
        let mut command = CommandBuilder::new(binary);
        command.cwd(&self.workspace);
        command.env_remove("OPENBITFUN_USER_ROOT");
        command.env_remove("OPENBITFUN_HOME");
        command.env("OPENBITFUN_E2E_STORAGE_GUARD", "1");
        command.env("OPENBITFUN_E2E_USER_ROOT", &self.user_root);
        command.env("OPENBITFUN_E2E_HOME", &self.home_root);
        command.env("APPDATA", &self.config_root);
        command.env("XDG_CONFIG_HOME", &self.config_root);
        command.env("HOME", &self.home_root);
        command.env("USERPROFILE", &self.home_root);
        command.env("TERM", "xterm-256color");
        command
    }

    fn apply_std_environment(&self, command: &mut Command) {
        command
            .env_remove("OPENBITFUN_USER_ROOT")
            .env_remove("OPENBITFUN_HOME")
            .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
            .env("OPENBITFUN_E2E_USER_ROOT", &self.user_root)
            .env("OPENBITFUN_E2E_HOME", &self.home_root)
            .env("APPDATA", &self.config_root)
            .env("XDG_CONFIG_HOME", &self.config_root)
            .env("HOME", &self.home_root)
            .env("USERPROFILE", &self.home_root)
            .env("TERM", "xterm-256color");
    }

    fn run_git(&self, args: &[&str]) {
        let output = openbitfun_services_core::process_manager::create_command("git")
            .args(args)
            .current_dir(&self.workspace)
            .output()
            .expect("run git for CLI test");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

pub(crate) struct MockOpenAiServer {
    base_url: String,
    release_stream: mpsc::Sender<()>,
    stream_disconnected: mpsc::Receiver<()>,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

enum MockModelResponse {
    Immediate,
    Gated,
    ProductControlLoop,
    ToolSequence(Vec<(String, serde_json::Value)>),
    Http403 { reason: String },
    DisconnectThenHttp403,
    MalformedSseThenImmediate,
    ContextOverflowThenImmediate,
}

impl MockOpenAiServer {
    pub(crate) fn gated() -> Self {
        Self::spawn(MockModelResponse::Gated)
    }

    pub(crate) fn immediate() -> Self {
        Self::spawn(MockModelResponse::Immediate)
    }

    pub(crate) fn product_control_loop() -> Self {
        Self::spawn(MockModelResponse::ProductControlLoop)
    }

    pub(crate) fn tool_sequence(calls: Vec<(String, serde_json::Value)>) -> Self {
        Self::spawn(MockModelResponse::ToolSequence(calls))
    }

    pub(crate) fn http_403(reason: impl Into<String>) -> Self {
        Self::spawn(MockModelResponse::Http403 {
            reason: reason.into(),
        })
    }

    pub(crate) fn disconnect_then_http_403() -> Self {
        Self::spawn(MockModelResponse::DisconnectThenHttp403)
    }

    pub(crate) fn malformed_sse_then_immediate() -> Self {
        Self::spawn(MockModelResponse::MalformedSseThenImmediate)
    }

    pub(crate) fn context_overflow_then_immediate() -> Self {
        Self::spawn(MockModelResponse::ContextOverflowThenImmediate)
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn release(&self) {
        let _ = self.release_stream.send(());
    }

    pub(crate) fn expect_stream_disconnect(&self, timeout: Duration) {
        self.stream_disconnected
            .recv_timeout(timeout)
            .expect("model stream remained connected after cancellation");
    }

    pub(crate) fn assert_chat_completion_requests(&self, expected_count: usize) {
        let requests = self.chat_completion_request_bodies();
        assert_eq!(
            requests.len(),
            expected_count,
            "unexpected mock model request count"
        );
    }

    pub(crate) fn chat_completion_request_bodies(&self) -> Vec<serde_json::Value> {
        let requests = self.requests.lock().expect("lock mock model requests");
        requests
            .iter()
            .map(|request| {
                let header_end = find_header_end(request).expect("mock request header terminator");
                let headers = String::from_utf8_lossy(&request[..header_end]);
                assert_eq!(
                    headers.lines().next(),
                    Some("POST /v1/chat/completions HTTP/1.1"),
                    "unexpected mock model request target"
                );
                let body: serde_json::Value = serde_json::from_slice(&request[header_end + 4..])
                    .expect("parse mock model request body");
                assert_eq!(body["model"], "cli-e2e-model", "unexpected mock model id");
                body
            })
            .collect()
    }

    fn spawn(response: MockModelResponse) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock model server");
        listener
            .set_nonblocking(true)
            .expect("configure mock model listener");
        let address = listener.local_addr().expect("mock model address");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let (release_tx, release_rx) = mpsc::channel();
        let (disconnect_tx, disconnect_rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            // The owning test bounds startup and turn waits. Keep the listener alive
            // until Drop: a cold CLI startup can consume the old 30-second lifetime
            // before its first model request, especially on Windows CI.
            let mut attempt = 0;
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_nonblocking(false)
                            .expect("configure accepted mock model connection");
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .expect("configure mock request timeout");
                        let request =
                            read_http_request(&mut stream).expect("read mock model request");
                        requests_for_thread
                            .lock()
                            .expect("lock mock model requests")
                            .push(request);
                        serve_model_response(
                            &mut stream,
                            &response,
                            attempt,
                            &release_rx,
                            &disconnect_tx,
                        );
                        attempt += 1;
                        let accepts_more_requests = matches!(
                            response,
                            MockModelResponse::Http403 { .. }
                                | MockModelResponse::DisconnectThenHttp403
                        ) || (matches!(
                            response,
                            MockModelResponse::MalformedSseThenImmediate
                        ) && attempt < 2)
                            || (matches!(
                                response,
                                MockModelResponse::ContextOverflowThenImmediate
                            ) && attempt < 3)
                            || (matches!(response, MockModelResponse::ProductControlLoop)
                                && attempt < 5)
                            || matches!(&response, MockModelResponse::ToolSequence(calls) if attempt <= calls.len());
                        if accepts_more_requests {
                            continue;
                        }
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop_for_thread.load(Ordering::Relaxed) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept mock model request: {error}"),
                }
            }
        });

        Self {
            base_url: format!("http://{address}"),
            release_stream: release_tx,
            stream_disconnected: disconnect_rx,
            requests,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for MockOpenAiServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.release();
        self.release();
        if let Some(thread) = self.thread.take() {
            if let Err(panic) = thread.join() {
                if !std::thread::panicking() {
                    std::panic::resume_unwind(panic);
                }
            }
        }
    }
}

fn serve_model_response(
    stream: &mut TcpStream,
    response: &MockModelResponse,
    attempt: usize,
    release_stream: &mpsc::Receiver<()>,
    stream_disconnected: &mpsc::Sender<()>,
) {
    if matches!(response, MockModelResponse::ContextOverflowThenImmediate) && attempt == 0 {
        let body = json!({
            "error": {"code": "context_length_exceeded", "message": "Maximum context length exceeded"}
        }).to_string();
        write!(stream, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            .expect("write context overflow response");
        stream.flush().expect("flush context overflow response");
        return;
    }
    if matches!(response, MockModelResponse::DisconnectThenHttp403) && attempt > 0 {
        write_http_403(stream, "provider stream remained unavailable")
            .expect("write post-disconnect HTTP error");
        return;
    }
    if let MockModelResponse::Http403 { reason } = response {
        write_http_403(stream, reason).expect("write mock HTTP error");
        return;
    }
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        )
        .expect("write mock response headers");

    if matches!(response, MockModelResponse::ProductControlLoop) {
        serve_product_control_response(stream, attempt);
        return;
    }

    if let MockModelResponse::ToolSequence(calls) = response {
        let (delta, finish_reason) = match calls.get(attempt) {
            Some((name, arguments)) => (
                json!({"role":"assistant", "tool_calls":[{
                    "index":0, "id":format!("call_sequence_{attempt}"), "type":"function",
                    "function":{"name":name,"arguments":arguments.to_string()}
                }]}),
                "tool_calls",
            ),
            None => (
                json!({"role":"assistant", "content":STREAM_COMPLETED_MARKER}),
                "stop",
            ),
        };
        write_sse_chunk(
            stream,
            &json!({
                "id":format!("chatcmpl_sequence_{attempt}"), "object":"chat.completion.chunk",
                "created":attempt, "model":"cli-e2e-model",
                "choices":[{"index":0,"delta":delta,"finish_reason":finish_reason}]
            })
            .to_string(),
        )
        .expect("write scripted tool response");
        // The client may close as soon as it consumes the finish reason. A Windows
        // ConnectionAborted here must not kill the server for the next tool
        // response; all required SSE data was already written successfully.
        if write_chunk(stream, b"data: [DONE]\n\n").is_err() {
            return;
        }
        let _ = stream.write_all(b"0\r\n\r\n");
        let _ = stream.flush();
        return;
    }

    if matches!(response, MockModelResponse::MalformedSseThenImmediate) && attempt == 0 {
        write_chunk(stream, b"data: not-json\n\n").expect("write malformed SSE frame");
        let _ = stream.write_all(b"0\r\n\r\n");
        let _ = stream.flush();
        return;
    }

    write_sse_chunk(
        stream,
        &json!({
            "id": "chatcmpl_cli_e2e",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "cli-e2e-model",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": ""},
                "finish_reason": null
            }]
        })
        .to_string(),
    )
    .expect("write mock role chunk");
    write_sse_chunk(
        stream,
        &json!({
            "id": "chatcmpl_cli_e2e",
            "object": "chat.completion.chunk",
            "created": 2,
            "model": "cli-e2e-model",
            "choices": [{
                "index": 0,
                "delta": {"content": STREAM_START_MARKER},
                "finish_reason": null
            }]
        })
        .to_string(),
    )
    .expect("write mock streaming marker");

    if matches!(response, MockModelResponse::DisconnectThenHttp403) {
        return;
    }

    let gated = matches!(response, MockModelResponse::Gated);
    if gated && !wait_for_release_or_disconnect(stream, release_stream, stream_disconnected) {
        return;
    }

    if gated {
        if write_sse_chunk(
            stream,
            &json!({
                "id": "chatcmpl_cli_e2e",
                "object": "chat.completion.chunk",
                "created": 3,
                "model": "cli-e2e-model",
                "choices": [{
                    "index": 0,
                    "delta": {"content": STREAM_RESIZED_MARKER},
                    "finish_reason": null
                }]
            })
            .to_string(),
        )
        .is_err()
        {
            return;
        }
        if !wait_for_release_or_disconnect(stream, release_stream, stream_disconnected) {
            return;
        }
    }

    if write_sse_chunk(
        stream,
        &json!({
            "id": "chatcmpl_cli_e2e",
            "object": "chat.completion.chunk",
            "created": 4,
            "model": "cli-e2e-model",
            "choices": [{
                "index": 0,
                "delta": {"content": STREAM_COMPLETED_MARKER},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
        })
        .to_string(),
    )
    .is_err()
    {
        return;
    }
    if write_chunk(stream, b"data: [DONE]\n\n").is_err() {
        return;
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = stream.flush();
}

fn serve_product_control_response(stream: &mut TcpStream, attempt: usize) {
    write_sse_chunk(
        stream,
        &json!({
            "id": format!("chatcmpl_product_control_{attempt}"),
            "object": "chat.completion.chunk",
            "created": attempt,
            "model": "cli-e2e-model",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": null},
                "finish_reason": null
            }]
        })
        .to_string(),
    )
    .expect("write product-control role chunk");

    if attempt < 4 {
        let (call_id, arguments) = match attempt {
            0 => (
                "call_product_control_search",
                json!({"action": "search", "query": "工具调用超时"}),
            ),
            1 => (
                "call_product_control_get_before",
                json!({"action": "get", "capability_id": "setting.tools.execution"}),
            ),
            2 => (
                "call_product_control_configure",
                json!({
                    "action": "configure",
                    "capability_id": "setting.tools.execution",
                    "option_id": "tool-timeout-seconds",
                    "value_integer": 74
                }),
            ),
            3 => (
                "call_product_control_get_after",
                json!({"action": "get", "capability_id": "setting.tools.execution"}),
            ),
            _ => unreachable!(),
        };
        write_sse_chunk(
            stream,
            &json!({
                "id": format!("chatcmpl_product_control_{attempt}"),
                "object": "chat.completion.chunk",
                "created": attempt,
                "model": "cli-e2e-model",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "OpenBitFunControl",
                                "arguments": arguments.to_string()
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            })
            .to_string(),
        )
        .expect("write product-control tool-call chunk");
    } else {
        write_sse_chunk(
            stream,
            &json!({
                "id": "chatcmpl_product_control_complete",
                "object": "chat.completion.chunk",
                "created": attempt,
                "model": "cli-e2e-model",
                "choices": [{
                    "index": 0,
                    "delta": {"content": "PRODUCT_CONTROL_SELF_TEST_OK"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
            })
            .to_string(),
        )
        .expect("write product-control completion chunk");
    }

    // Match the ordinary streaming response: EOF after completion is normal.
    if write_chunk(stream, b"data: [DONE]\n\n").is_err() {
        return;
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = stream.flush();
}

fn write_http_403(stream: &mut TcpStream, reason: &str) -> std::io::Result<()> {
    let body = json!({
        "error": {
            "message": reason,
            "type": "permission_error",
            "param": null,
            "code": "permission_denied"
        }
    })
    .to_string();
    write!(
        stream,
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 1\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

fn wait_for_release_or_disconnect(
    stream: &TcpStream,
    release_stream: &mpsc::Receiver<()>,
    stream_disconnected: &mpsc::Sender<()>,
) -> bool {
    stream
        .set_read_timeout(Some(Duration::from_millis(25)))
        .expect("configure mock disconnect observation");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut probe = [0_u8; 1];
    while Instant::now() < deadline {
        if release_stream.try_recv().is_ok() {
            return true;
        }
        match stream.peek(&mut probe) {
            Ok(0) => {
                let _ = stream_disconnected.send(());
                return false;
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => {
                let _ = stream_disconnected.send(());
                return false;
            }
        }
    }
    false
}

fn write_sse_chunk(stream: &mut TcpStream, data: &str) -> std::io::Result<()> {
    write_chunk(stream, format!("data: {data}\n\n").as_bytes())
}

fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    write!(stream, "{:X}\r\n", bytes.len())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn read_http_request(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut expected_len = None;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if expected_len.is_none() {
            if let Some(header_end) = find_header_end(&request) {
                let content_length = parse_content_length(&request[..header_end]);
                expected_len = Some(header_end + 4 + content_length);
            }
        }
        if expected_len.is_some_and(|expected| request.len() >= expected) {
            break;
        }
    }
    Ok(request)
}

fn find_header_end(request: &[u8]) -> Option<usize> {
    request.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &[u8]) -> usize {
    String::from_utf8_lossy(headers)
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or_default()
}
