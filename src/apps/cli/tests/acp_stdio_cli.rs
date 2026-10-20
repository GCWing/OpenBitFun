mod support;

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use support::{CliTestEnvironment, MockOpenAiServer};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct AcpProcess {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<BufReader<tokio::process::ChildStdout>>,
    stderr_reader: tokio::task::JoinHandle<String>,
}

impl AcpProcess {
    async fn spawn(environment: &CliTestEnvironment) -> Self {
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(env!(
            "CARGO_BIN_EXE_openbitfun"
        ));
        command
            .arg("acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        environment.apply_tokio_environment(&mut command);

        let mut child = command.spawn().expect("start production ACP server");
        let stdin = child.stdin.take().expect("ACP stdin");
        let stdout = BufReader::new(child.stdout.take().expect("ACP stdout"));
        let mut stderr = child.stderr.take().expect("ACP stderr");
        let stderr_reader = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .read_to_end(&mut bytes)
                .await
                .expect("read ACP stderr");
            String::from_utf8_lossy(&bytes).into_owned()
        });

        Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr_reader,
        }
    }

    async fn request(&mut self, id: i64, method: &str, params: Value) -> (Value, Vec<Value>) {
        self.send_request(id, method, params).await;
        let (mut responses, notifications) = self.read_responses(&[id], method).await;
        (responses.remove(0), notifications)
    }

    async fn send_request(&mut self, id: i64, method: &str, params: Value) {
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut request = serde_json::to_vec(&request).expect("serialize ACP request");
        request.push(b'\n');
        let stdin = self.stdin.as_mut().expect("ACP stdin remains available");
        stdin.write_all(&request).await.expect("write ACP request");
        stdin.flush().await.expect("flush ACP request");
    }

    async fn read_responses(
        &mut self,
        expected_ids: &[i64],
        operation: &str,
    ) -> (Vec<Value>, Vec<Value>) {
        let mut responses = Vec::with_capacity(expected_ids.len());
        let mut notifications = Vec::new();
        while responses.len() < expected_ids.len() {
            let mut line = String::new();
            let bytes_read = tokio::time::timeout(
                Duration::from_secs(60),
                self.stdout
                    .as_mut()
                    .expect("ACP stdout remains available")
                    .read_line(&mut line),
            )
            .await
            .unwrap_or_else(|_| panic!("ACP {operation} request timed out"))
            .expect("read ACP stdout");
            assert_ne!(
                bytes_read, 0,
                "ACP stdout closed while waiting for {operation}"
            );

            let message: Value = serde_json::from_str(&line).unwrap_or_else(|error| {
                panic!("ACP stdout contained non-JSON data: {error}: {line}")
            });
            if let Some(id) = message.get("id").and_then(Value::as_i64) {
                assert!(
                    expected_ids.contains(&id),
                    "unexpected ACP response while waiting for {operation}: {message}"
                );
                assert!(
                    !responses.iter().any(|response: &Value| {
                        response.get("id").and_then(Value::as_i64) == Some(id)
                    }),
                    "duplicate ACP response id while waiting for {operation}: {message}"
                );
                responses.push(message);
                continue;
            }

            assert_eq!(
                message.get("method"),
                Some(&json!("session/update")),
                "unexpected ACP message while waiting for {operation}: {message}"
            );
            notifications.push(message);
        }
        (responses, notifications)
    }

    async fn shutdown(mut self) -> String {
        drop(self.stdin.take());
        drop(self.stdout.take());
        match tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await {
            Ok(Ok(status)) => assert!(status.success(), "ACP server exited with {status}"),
            Ok(Err(error)) => panic!("wait for ACP server: {error}"),
            Err(_) => {
                self.child.kill().await.expect("stop ACP server");
                let _ = self.child.wait().await.expect("reap ACP server");
            }
        }
        self.stderr_reader.await.expect("join ACP stderr reader")
    }
}

fn current_config_value<'a>(response: &'a Value, config_id: &str) -> Option<&'a Value> {
    response
        .pointer("/result/configOptions")?
        .as_array()?
        .iter()
        .find(|option| option.get("id") == Some(&json!(config_id)))?
        .get("currentValue")
}

#[tokio::test]
async fn acp_stdio_preserves_mode_and_history_across_restart_then_closes_active_session() {
    let model = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(model.base_url());
    let cwd = environment.workspace().to_string_lossy().to_string();

    let mut first = AcpProcess::spawn(&environment).await;
    let (initialize, _) = first
        .request(
            1,
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await;
    assert_eq!(
        initialize.pointer("/result/protocolVersion"),
        Some(&json!(1))
    );
    assert_eq!(
        initialize.pointer("/result/agentInfo/name"),
        Some(&json!("openbitfun-acp"))
    );
    assert_eq!(
        initialize.pointer("/result/agentCapabilities/sessionCapabilities/close"),
        Some(&json!({})),
        "ACP must advertise session/close before clients can call it"
    );

    let (invalid_new, _) = first
        .request(
            2,
            "session/new",
            json!({
                "cwd": cwd,
                "mcpServers": [{
                    "name": " ",
                    "command": "unused",
                    "args": [],
                    "env": []
                }]
            }),
        )
        .await;
    assert_eq!(invalid_new.pointer("/error/code"), Some(&json!(-32602)));
    let (after_failed_new, _) = first
        .request(3, "session/list", json!({ "cwd": cwd }))
        .await;
    assert_eq!(
        after_failed_new.pointer("/result/sessions"),
        Some(&json!([])),
        "failed session/new must not leave an undisclosed Core session"
    );

    let (created, _) = first
        .request(4, "session/new", json!({ "cwd": cwd, "mcpServers": [] }))
        .await;
    let session_id = created
        .pointer("/result/sessionId")
        .and_then(Value::as_str)
        .expect("new session id")
        .to_string();

    let (configured, mode_updates) = first
        .request(
            5,
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": "mode",
                "value": " Cowork "
            }),
        )
        .await;
    assert!(configured.get("error").is_none(), "{configured}");
    assert_eq!(
        current_config_value(&configured, "mode"),
        Some(&json!("Cowork"))
    );
    assert!(
        mode_updates.iter().all(|message| {
            message.pointer("/params/update/sessionUpdate") != Some(&json!("current_mode_update"))
        }),
        "a client-initiated mode change must not be echoed as an autonomous mode update"
    );

    let (prompted, prompt_updates) = first
        .request(
            6,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "remember this turn" }]
            }),
        )
        .await;
    assert!(prompted.get("error").is_none(), "{prompted}");
    assert!(
        !prompt_updates.is_empty(),
        "prompt must stream at least one session/update before its response"
    );
    let first_stderr = first.shutdown().await;
    model.assert_chat_completion_requests(1);

    let restored_model = MockOpenAiServer::immediate();
    environment.configure_mock_model(restored_model.base_url());
    let mut second = AcpProcess::spawn(&environment).await;
    let _ = second
        .request(
            10,
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await;
    let (missing_load, _) = second
        .request(
            11,
            "session/load",
            json!({
                "sessionId": "missing-session",
                "cwd": environment.workspace().to_string_lossy(),
                "mcpServers": []
            }),
        )
        .await;
    assert_eq!(missing_load.pointer("/error/code"), Some(&json!(-32002)));
    assert_eq!(
        missing_load.pointer("/error/data/uri"),
        Some(&json!("missing-session"))
    );
    let (invalid_session_id, _) = second
        .request(
            12,
            "session/load",
            json!({
                "sessionId": "../outside",
                "cwd": environment.workspace().to_string_lossy(),
                "mcpServers": [{
                    "name": "must-not-start",
                    "command": "openbitfun-command-that-must-not-run",
                    "args": [],
                    "env": []
                }]
            }),
        )
        .await;
    assert_eq!(
        invalid_session_id.pointer("/error/code"),
        Some(&json!(-32602)),
        "invalid session identity must be rejected before MCP provisioning: {invalid_session_id}"
    );
    let (invalid_load, _) = second
        .request(
            13,
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": environment.workspace().to_string_lossy(),
                "mcpServers": [{
                    "name": " ",
                    "command": "unused",
                    "args": [],
                    "env": []
                }]
            }),
        )
        .await;
    assert_eq!(invalid_load.pointer("/error/code"), Some(&json!(-32602)));

    let load_params = json!({
        "sessionId": session_id,
        "cwd": environment.workspace().to_string_lossy(),
        "mcpServers": []
    });
    second
        .send_request(14, "session/load", load_params.clone())
        .await;
    second.send_request(15, "session/load", load_params).await;
    let (load_responses, replay_updates) = second
        .read_responses(&[14, 15], "concurrent session/load")
        .await;
    let loaded = load_responses
        .iter()
        .find(|response| response.get("error").is_none())
        .expect("one concurrent session/load must succeed");
    let duplicate_load = load_responses
        .iter()
        .find(|response| response.get("error").is_some())
        .expect("one concurrent session/load must be rejected");
    assert!(loaded.get("error").is_none(), "{loaded}");
    assert_eq!(current_config_value(loaded, "mode"), Some(&json!("Cowork")));
    assert!(
        !replay_updates.is_empty(),
        "session/load must replay persisted history before its success response"
    );
    // Back-to-back stdio writes need not overlap inside the server: the first
    // restore may publish before the second request claims its transition.
    // Both schedules must reject the duplicate without replaying history twice.
    // The ACP runtime's transition-claim test separately holds an active claim
    // to deterministically require the retryable in-progress error.
    match duplicate_load
        .pointer("/error/code")
        .and_then(Value::as_i64)
    {
        Some(-32603) => {
            assert_eq!(
                duplicate_load.pointer("/error/data/state"),
                Some(&json!("session_transition_in_progress")),
                "{duplicate_load}"
            );
            assert_eq!(
                duplicate_load.pointer("/error/data/retryable"),
                Some(&json!(true)),
                "{duplicate_load}"
            );
        }
        Some(-32602) => assert_eq!(
            duplicate_load.pointer("/error/data"),
            Some(&json!("session is already active")),
            "{duplicate_load}"
        ),
        _ => panic!("unexpected duplicate session/load rejection: {duplicate_load}"),
    }
    assert_eq!(
        replay_updates
            .iter()
            .filter(|message| {
                message.pointer("/params/update/sessionUpdate")
                    == Some(&json!("user_message_chunk"))
            })
            .count(),
        1,
        "overlapping session/load must not replay the persisted user turn twice"
    );

    let (closed, _) = second
        .request(16, "session/close", json!({ "sessionId": session_id }))
        .await;
    assert!(closed.get("error").is_none(), "{closed}");

    let (reloaded_after_close, replay_after_close) = second
        .request(
            17,
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": environment.workspace().to_string_lossy(),
                "mcpServers": []
            }),
        )
        .await;
    assert!(
        reloaded_after_close.get("error").is_none(),
        "closing an ACP session must release runtime resources without deleting its history: {reloaded_after_close}"
    );
    assert_eq!(
        current_config_value(&reloaded_after_close, "mode"),
        Some(&json!("Cowork"))
    );
    assert_eq!(
        replay_after_close
            .iter()
            .filter(|message| {
                message.pointer("/params/update/sessionUpdate")
                    == Some(&json!("user_message_chunk"))
            })
            .count(),
        1,
        "reloading after close must replay the persisted turn exactly once"
    );
    let (closed_after_reload, _) = second
        .request(18, "session/close", json!({ "sessionId": session_id }))
        .await;
    assert!(
        closed_after_reload.get("error").is_none(),
        "{closed_after_reload}"
    );

    let metadata_path = environment.session_metadata_path(&session_id);
    let mut metadata: Value = serde_json::from_slice(
        &std::fs::read(&metadata_path).expect("read persisted session metadata"),
    )
    .expect("parse persisted session metadata");
    metadata["agentType"] = json!("RemovedCustomMode");
    std::fs::write(
        &metadata_path,
        serde_json::to_vec_pretty(&metadata).expect("serialize persisted session metadata"),
    )
    .expect("replace persisted session mode");

    let (loaded_with_fallback, _) = second
        .request(
            19,
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": environment.workspace().to_string_lossy(),
                "mcpServers": []
            }),
        )
        .await;
    assert!(
        loaded_with_fallback.get("error").is_none(),
        "{loaded_with_fallback}"
    );
    assert_eq!(
        current_config_value(&loaded_with_fallback, "mode"),
        Some(&json!("Standard")),
        "an unavailable persisted mode must be migrated to an executable fallback"
    );
    let (fallback_prompt, _) = second
        .request(
            20,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "continue after mode fallback" }]
            }),
        )
        .await;
    assert!(
        fallback_prompt.get("error").is_none(),
        "the restored fallback mode must be executable: {fallback_prompt}"
    );
    restored_model.assert_chat_completion_requests(1);
    let (closed_after_fallback, _) = second
        .request(21, "session/close", json!({ "sessionId": session_id }))
        .await;
    assert!(
        closed_after_fallback.get("error").is_none(),
        "{closed_after_fallback}"
    );

    let (post_close_prompt, _) = second
        .request(
            22,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "must be rejected" }]
            }),
        )
        .await;
    assert_eq!(
        post_close_prompt.pointer("/error/code"),
        Some(&json!(-32002)),
        "closed ACP session must no longer accept prompts"
    );
    let (post_close_model, _) = second
        .request(
            23,
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": "primary" }),
        )
        .await;
    assert_eq!(
        post_close_model.pointer("/error/code"),
        Some(&json!(-32002))
    );

    let second_stderr = second.shutdown().await;
    assert!(
        !first_stderr.contains("panicked") && !second_stderr.contains("panicked"),
        "ACP process panicked:\nfirst:\n{first_stderr}\nsecond:\n{second_stderr}"
    );
}
