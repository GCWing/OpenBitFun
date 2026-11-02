#[path = "../support/mod.rs"]
mod support;

use std::process::Output;
use support::{
    command_output_with_timeout, CliTestEnvironment, MockOpenAiServer, STREAM_COMPLETED_MARKER,
    STREAM_START_MARKER,
};

fn run_cli(args: &[&str]) -> Output {
    openbitfun_services_core::process_manager::create_command(env!("CARGO_BIN_EXE_openbitfun"))
        .args(args)
        .output()
        .expect("run openbitfun")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn jsonl_events(output: &str) -> Vec<serde_json::Value> {
    output
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|error| panic!("invalid JSONL line {line:?}: {error}"))
        })
        .collect()
}

fn is_terminal_event(value: &serde_json::Value) -> bool {
    matches!(
        value["event"]["type"].as_str(),
        Some("DialogTurnCompleted" | "DialogTurnCancelled" | "DialogTurnFailed" | "SystemError")
    )
}

#[test]
fn command_timeout_helper_returns_within_its_failure_budget() {
    #[cfg(windows)]
    let mut command = {
        let mut command =
            openbitfun_services_core::process_manager::create_command("powershell.exe");
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = openbitfun_services_core::process_manager::create_command("sh");
        command.args(["-c", "exec sleep 30"]);
        command
    };
    let started = std::time::Instant::now();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        command_output_with_timeout(&mut command, std::time::Duration::from_millis(50))
    }));

    let panic = result.expect_err("sleeping process must exceed the deadline");
    let panic_message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or("non-string panic payload");
    assert!(
        panic_message.contains("CLI process exceeded"),
        "unexpected timeout helper panic: {panic_message}"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(8),
        "timeout helper exceeded its bounded cleanup budget: {:?}",
        started.elapsed()
    );
}

#[test]
fn exec_help_uses_competitor_aligned_output_and_approval_flags() {
    let output = run_cli(&["exec", "--help"]);
    let stdout = stdout(&output);

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout.contains("--auto"), "{stdout}");
    assert!(stdout.contains("--output-format"), "{stdout}");
    for format in ["text", "json", "stream-json"] {
        assert!(stdout.contains(format), "missing {format}: {stdout}");
    }
    assert!(!stdout.contains("--output-schema"), "{stdout}");
    assert!(
        !stdout.contains("--confirm"),
        "deprecated compatibility flag must stay out of public help: {stdout}"
    );
}

#[test]
fn exec_accepts_hidden_confirm_compatibility_flag() {
    let output = run_cli(&["exec", "--confirm", "--help"]);

    assert!(output.status.success(), "{}", stderr(&output));
}

#[test]
fn cli_agent_controls_its_own_isolated_config_through_openbitfun_control() {
    let server = MockOpenAiServer::product_control_loop();
    let environment = CliTestEnvironment::new();
    environment.configure_product_control_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "用 OpenBitFunControl 搜索工具调用超时，读取、配置为 74，再回读",
        "--auto",
        "--no-verify-final-changes",
        "--output-format",
        "json",
    ]);

    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(60));
    let stdout = stdout(&output);
    assert!(output.status.success(), "{}\n{stdout}", stderr(&output));
    assert!(stdout.contains("PRODUCT_CONTROL_SELF_TEST_OK"), "{stdout}");
    server.assert_chat_completion_requests(5);

    let requests = server.chat_completion_request_bodies();
    let openbitfun_control = requests[0]["tools"]
        .as_array()
        .expect("model tools")
        .iter()
        .find(|tool| tool["function"]["name"] == "OpenBitFunControl")
        .expect("OpenBitFunControl is loaded for the CLI Agent");
    let description = openbitfun_control["function"]["description"]
        .as_str()
        .expect("OpenBitFunControl description");
    assert!(description.contains("two-step"), "{description}");
    assert!(description.len() < 600, "catalog leaked into tool prompt");

    let config = environment.app_config();
    assert_eq!(config["ai"]["tool_execution_timeout_secs"], 74);
}

#[test]
fn scheduled_jobs_invalid_store_is_preserved_and_does_not_block_cli_turns() {
    use serde_json::json;
    let server = MockOpenAiServer::tool_sequence(vec![
        ("GetToolSpec".into(), json!({"tool_name":"Cron"})),
        (
            "CallDeferredTool".into(),
            json!({"tool_name":"Cron","args":{"action":"list"}}),
        ),
    ]);
    let environment = CliTestEnvironment::new();
    environment.configure_tool_loop_mock_model(server.base_url());
    let path = environment.cron_jobs_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let unsupported_store = r#"{"version":999,"jobs":[{"futureField":"keep-me"}]}"#;
    std::fs::write(&path, unsupported_store).unwrap();
    let mut command = environment.std_command();
    command.args([
        "exec",
        "List scheduled jobs",
        "--auto",
        "--no-verify-final-changes",
        "--output-format",
        "json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(60));
    assert!(
        output.status.success(),
        "{}\n{}",
        stderr(&output),
        stdout(&output)
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), unsupported_store);
    server.assert_chat_completion_requests(3);
    let messages = server.chat_completion_request_bodies()[2]["messages"].to_string();
    assert!(
        messages.contains("Scheduled jobs are unavailable in this execution host"),
        "{messages}"
    );
}

#[test]
fn exec_rejects_auto_with_legacy_confirm() {
    let output = run_cli(&["exec", "task", "--auto", "--confirm"]);
    let stderr = stderr(&output);

    assert!(!output.status.success(), "{}", stdout(&output));
    assert!(stderr.contains("cannot be used with"), "{stderr}");
    assert!(stderr.contains("--auto"), "{stderr}");
    assert!(stderr.contains("--confirm"), "{stderr}");
}

#[test]
fn exec_json_clap_failure_is_one_result_document() {
    let output = run_cli(&[
        "exec",
        "task",
        "--output-format",
        "json",
        "--auto",
        "--confirm",
    ]);
    let stdout = stdout(&output);

    assert!(!output.status.success(), "{stdout}");
    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
    let value: serde_json::Value =
        serde_json::from_str(&stdout).expect("one JSON parser error result");
    assert_eq!(value["type"], "result");
    assert_eq!(value["subtype"], "error");
    assert_eq!(value["is_error"], true);
    assert!(value["result"]
        .as_str()
        .is_some_and(|message| message.contains("--auto") && message.contains("--confirm")));
}

#[test]
fn exec_json_help_preserves_clap_success_semantics() {
    let output = run_cli(&["exec", "--output-format", "json", "--help"]);
    let stdout = stdout(&output);

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout.contains("Usage:"), "{stdout}");
    assert!(stdout.contains("--output-format"), "{stdout}");
    assert!(!stdout.contains("\"subtype\": \"error\""), "{stdout}");
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
}

#[test]
fn exec_json_preflight_failure_is_one_result_document() {
    let output = run_cli(&[
        "exec",
        "task",
        "--output-format",
        "json",
        "--continue",
        "--session-id",
        "fixed-id",
    ]);
    let stdout = stdout(&output);

    assert!(!output.status.success(), "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON result object");
    assert_eq!(value["type"], "result");
    assert_eq!(value["subtype"], "error");
    assert_eq!(value["is_error"], true);
    assert!(value.get("session_id").is_none());
    assert!(value.get("turn_id").is_none());
    assert!(value["result"]
        .as_str()
        .is_some_and(|message| message.contains("--session-id")));
}

#[test]
fn root_shared_flag_keeps_exec_json_error_contract() {
    let output = run_cli(&["--shared", "exec", "task", "--output-format", "json"]);
    let stdout = stdout(&output);

    assert!(!output.status.success(), "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON result object");
    assert_eq!(value["type"], "result");
    assert_eq!(value["subtype"], "error");
    assert!(value["result"]
        .as_str()
        .is_some_and(|message| message.contains("interactive TUI")));
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
}

#[test]
fn exec_json_rejects_continue_with_an_explicit_resume() {
    let output = run_cli(&[
        "exec",
        "task",
        "--output-format",
        "json",
        "--continue",
        "--resume",
        "session-1",
    ]);
    let stdout = stdout(&output);

    assert!(!output.status.success(), "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON error result");
    assert!(value["result"]
        .as_str()
        .is_some_and(|message| message.contains("--continue") && message.contains("--resume")));
}

#[test]
fn stream_json_rejects_stdout_patch_before_starting_runtime() {
    let output = run_cli(&[
        "exec",
        "task",
        "--output-format",
        "stream-json",
        "--output-patch",
    ]);

    assert!(!output.status.success(), "{}", stdout(&output));
    assert!(
        stdout(&output).is_empty(),
        "protocol stdout must stay empty"
    );
    assert!(
        stderr(&output).contains("requires an explicit file path"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn stream_json_patch_write_failure_emits_error_without_success_terminal() {
    let server = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let output_target = environment.workspace().to_string_lossy().into_owned();
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise patch settlement",
        "--output-format",
        "stream-json",
        "--output-patch",
        &output_target,
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));

    let stdout = stdout(&output);
    assert!(!output.status.success(), "{stdout}");
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output)
            .lines()
            .any(|line| line.starts_with("OPENBITFUN_EXIT: patch_write_failed:")),
        "missing stable patch failure diagnostic: {}",
        stderr(&output)
    );
    assert!(!stdout.trim().is_empty(), "missing stream-json events");
    let events = jsonl_events(&stdout);
    let completed_marker_index = events
        .iter()
        .position(|value| {
            value["event"]["type"] == "TextChunk"
                && value["event"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(STREAM_COMPLETED_MARKER))
        })
        .unwrap_or_else(|| {
            panic!("model stream did not complete before patch settlement: {stdout}")
        });
    let patch_error_index = events
        .iter()
        .position(|value| {
            value["event"]["type"] == "SystemError"
                && value["event"]["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("Failed to save requested patch"))
        })
        .unwrap_or_else(|| {
            panic!("patch failure did not emit a structured system error: {stdout}")
        });
    assert!(
        completed_marker_index < patch_error_index,
        "patch failure was emitted before model stream completion: {stdout}"
    );
    assert!(
        events
            .iter()
            .all(|value| value["event"]["type"] != "DialogTurnCompleted"),
        "successful terminal event leaked before patch settlement: {stdout}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "patch failure must emit exactly one terminal envelope: {stdout}"
    );
    let terminal_event = events.last().expect("stream-json terminal event");
    assert_eq!(terminal_event["event"]["type"], "SystemError", "{stdout}");
    assert_eq!(terminal_event["event"]["recoverable"], false, "{stdout}");
    assert!(
        terminal_event["event"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("Failed to save requested patch")),
        "unexpected terminal patch failure: {stdout}"
    );
}

#[test]
fn stream_json_patch_success_emits_one_success_terminal() {
    let server = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let output_patch = environment
        .workspace()
        .parent()
        .expect("workspace parent")
        .join("result.patch");
    let output_target = output_patch.to_string_lossy().into_owned();
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise successful patch settlement",
        "--output-format",
        "stream-json",
        "--output-patch",
        &output_target,
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));

    let stdout = stdout(&output);
    assert!(output.status.success(), "{}\n{stdout}", stderr(&output));
    assert_eq!(
        std::fs::read_to_string(&output_patch).expect("read generated patch"),
        "",
        "clean workspace must produce an explicit empty patch"
    );
    let events = jsonl_events(&stdout);
    assert!(
        events.iter().any(|value| {
            value["event"]["type"] == "TextChunk"
                && value["event"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(STREAM_COMPLETED_MARKER))
        }),
        "model stream did not complete: {stdout}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "success must emit exactly one terminal envelope: {stdout}"
    );
    let final_event = events.last().expect("stream-json success terminal event");
    assert_eq!(
        final_event["event"]["type"], "DialogTurnCompleted",
        "success terminal must be the final envelope: {stdout}"
    );
}

#[test]
fn stream_json_malformed_sse_retries_then_completes() {
    let server = MockOpenAiServer::malformed_sse_then_immediate();
    let environment = CliTestEnvironment::new();
    environment.configure_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise malformed provider stream retry",
        "--output-format",
        "stream-json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));
    server.assert_chat_completion_requests(2);

    let stdout = stdout(&output);
    assert!(output.status.success(), "{}\n{stdout}", stderr(&output));
    let events = jsonl_events(&stdout);
    assert!(
        events.iter().any(|value| {
            value["event"]["type"] == "TextChunk"
                && value["event"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(STREAM_COMPLETED_MARKER))
        }),
        "retried model stream did not complete: {stdout}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "retried stream must emit exactly one terminal envelope: {stdout}"
    );
    assert_eq!(
        events.last().expect("retried stream terminal event")["event"]["type"],
        "DialogTurnCompleted",
        "retried stream terminal must be last: {stdout}"
    );
}

#[test]
fn stream_json_context_overflow_compresses_before_reissuing_the_model_request() {
    let server = MockOpenAiServer::context_overflow_then_immediate();
    let environment = CliTestEnvironment::new();
    environment.configure_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "Remember this request and continue after context recovery",
        "--output-format",
        "stream-json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));
    let stdout = stdout(&output);
    assert!(output.status.success(), "{}\n{stdout}", stderr(&output));
    // One rejected request, one summary request, then the recovered model round.
    server.assert_chat_completion_requests(3);
    let requests = server.chat_completion_request_bodies();
    assert_ne!(
        requests[0]["messages"], requests[1]["messages"],
        "overflow must enter compression instead of replaying the original request"
    );
    assert_ne!(
        requests[0]["messages"], requests[2]["messages"],
        "recovery must send the compressed context"
    );
    let events = jsonl_events(&stdout);
    let compression_started = events
        .iter()
        .position(|value| {
            value["event"]["type"] == "ContextCompressionStarted"
                && value["event"]["trigger"] == "context_overflow_recovery"
        })
        .expect("overflow should start recovery compression");
    let compression_completed = events
        .iter()
        .position(|value| value["event"]["type"] == "ContextCompressionCompleted")
        .expect("recovery compression should complete");
    assert!(compression_started < compression_completed);
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1
    );
    assert_eq!(
        events.last().unwrap()["event"]["type"],
        "DialogTurnCompleted"
    );
}

#[test]
fn stream_json_provider_http_403_emits_one_error_terminal() {
    let server = MockOpenAiServer::http_403("provider authorization denied");
    let environment = CliTestEnvironment::new();
    environment.configure_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise provider failure contract",
        "--output-format",
        "stream-json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));
    server.assert_chat_completion_requests(1);

    let stdout = stdout(&output);
    assert!(!output.status.success(), "{stdout}");
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output)
            .lines()
            .any(|line| line.starts_with("OPENBITFUN_EXIT: dialog_turn_failed:")),
        "missing stable provider failure diagnostic: {}",
        stderr(&output)
    );
    let events = jsonl_events(&stdout);
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "provider failure must emit exactly one terminal envelope: {stdout}"
    );
    assert_eq!(
        events.last().expect("provider failure terminal event")["event"]["type"],
        "DialogTurnFailed",
        "provider failure terminal must be last: {stdout}"
    );
    let terminal_error = events.last().expect("provider failure terminal event")["event"]["error"]
        .as_str()
        .expect("provider failure error text");
    assert!(
        terminal_error.contains("provider authorization denied"),
        "provider failure reason was lost: {stdout}"
    );
    assert!(
        stderr(&output).contains("provider authorization denied"),
        "provider failure diagnostic lost its reason: {}",
        stderr(&output)
    );
    assert!(
        events.iter().all(|value| {
            !(value["event"]["type"] == "DialogTurnCompleted" && value["event"]["success"] == true)
        }),
        "provider failure emitted a successful completion: {stdout}"
    );
}

#[test]
fn stream_json_provider_and_patch_failures_publish_one_final_classification() {
    let server = MockOpenAiServer::http_403("provider authorization denied");
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let output_target = environment.workspace().to_string_lossy().into_owned();
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise combined provider and patch failure",
        "--output-format",
        "stream-json",
        "--output-patch",
        &output_target,
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));
    server.assert_chat_completion_requests(1);

    let stdout = stdout(&output);
    let stderr = stderr(&output);
    assert_eq!(output.status.code(), Some(1), "{stderr}\n{stdout}");
    let exit_diagnostics = stderr
        .lines()
        .filter(|line| line.starts_with("OPENBITFUN_EXIT:"))
        .collect::<Vec<_>>();
    assert_eq!(
        exit_diagnostics.len(),
        1,
        "combined failure must have one stable classifier: {stderr}"
    );
    assert!(
        exit_diagnostics[0].starts_with("OPENBITFUN_EXIT: patch_write_failed:"),
        "patch delivery failure must be the final classifier: {stderr}"
    );

    let events = jsonl_events(&stdout);
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "combined failure must publish exactly one terminal: {stdout}"
    );
    let terminal = events.last().expect("combined failure terminal");
    assert_eq!(terminal["event"]["type"], "SystemError", "{stdout}");
    let error = terminal["event"]["error"]
        .as_str()
        .expect("combined failure error text");
    assert!(error.contains("provider authorization denied"), "{stdout}");
    assert!(error.contains("Failed to save requested patch"), "{stdout}");
}

#[test]
fn stream_json_disconnect_then_authorization_failure_emits_one_error_terminal() {
    let server = MockOpenAiServer::disconnect_then_http_403();
    let environment = CliTestEnvironment::new();
    environment.configure_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "exercise interrupted provider stream",
        "--output-format",
        "stream-json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(30));
    server.assert_chat_completion_requests(2);

    let stdout = stdout(&output);
    assert!(!output.status.success(), "{stdout}");
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    let events = jsonl_events(&stdout);
    let stream_marker_index = events
        .iter()
        .position(|value| {
            value["event"]["type"] == "TextChunk"
                && value["event"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(STREAM_START_MARKER))
        })
        .expect("interrupted provider stream marker");
    assert_eq!(
        events
            .iter()
            .filter(|value| is_terminal_event(value))
            .count(),
        1,
        "provider disconnect must emit exactly one terminal envelope: {stdout}"
    );
    assert_eq!(
        events.last().expect("provider disconnect terminal event")["event"]["type"],
        "DialogTurnFailed",
        "provider disconnect terminal must be last: {stdout}"
    );
    assert!(
        stream_marker_index < events.len() - 1,
        "provider stream must start before its retry failure: {stdout}"
    );
    let terminal_error = events.last().expect("provider disconnect terminal event")["event"]
        ["error"]
        .as_str()
        .expect("provider disconnect error text");
    assert!(
        terminal_error.contains("provider stream remained unavailable"),
        "provider retry failure reason was lost: {stdout}"
    );
    assert!(
        stderr(&output).contains("provider stream remained unavailable"),
        "provider retry diagnostic lost its reason: {}",
        stderr(&output)
    );
    assert!(
        events.iter().all(|value| {
            !(value["event"]["type"] == "DialogTurnCompleted" && value["event"]["success"] == true)
        }),
        "provider disconnect emitted a successful completion: {stdout}"
    );
}

#[test]
fn computer_use_default_is_enabled_without_requesting_graphical_access() {
    let environment = CliTestEnvironment::new();
    let mut command = environment.std_command();
    command
        .env("SSH_CONNECTION", "fixture")
        .args(["computer-use", "status"]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(15));
    assert!(output.status.success(), "{}", stderr(&output));
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["computer_use_enabled"], true);
    assert_eq!(status["provider_available"], false);
    assert!(status["permissions"].is_null());
}

#[test]
fn computer_use_setting_survives_restart_without_a_graphical_session() {
    let environment = CliTestEnvironment::new();
    for (action, enabled) in [("enable", true), ("disable", false)] {
        let mut command = environment.std_command();
        command
            .env("SSH_CONNECTION", "fixture")
            .args(["computer-use", action]);
        let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(15));
        assert!(output.status.success(), "{}", stderr(&output));
        assert_eq!(
            environment.app_config()["ai"]["computer_use_enabled"],
            enabled
        );

        let mut status = environment.std_command();
        status
            .env("SSH_CONNECTION", "fixture")
            .args(["computer-use", "status"]);
        let output = command_output_with_timeout(&mut status, std::time::Duration::from_secs(15));
        assert!(output.status.success(), "{}", stderr(&output));
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status["computer_use_enabled"], enabled);
        assert_eq!(status["provider_available"], false);
        assert!(status["unavailable_reason"]
            .as_str()
            .unwrap()
            .contains("GUI_SESSION_UNAVAILABLE"));
        assert!(status["permissions"].is_null());
    }
}

fn computer_use_agent_status(ssh: bool) -> Vec<serde_json::Value> {
    let server = MockOpenAiServer::tool_sequence(vec![(
        "ComputerUse".into(),
        serde_json::json!({"action":"control_status"}),
    )]);
    let environment = CliTestEnvironment::new();
    environment.configure_tool_loop_mock_model(server.base_url());
    let mut command = environment.std_command();
    if ssh {
        command.env("SSH_CONNECTION", "fixture");
    }
    command.args([
        "exec",
        "Read native control status only; do not capture or operate an application",
        "--auto",
        "--no-verify-final-changes",
        "--output-format",
        "json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(60));
    assert!(
        output.status.success(),
        "{}\n{}",
        stderr(&output),
        stdout(&output)
    );
    server.assert_chat_completion_requests(2);
    server.chat_completion_request_bodies()
}

#[test]
fn computer_use_provider_does_not_determine_cli_terminal_availability() {
    let server = MockOpenAiServer::tool_sequence(vec![(
        "ControlHub".into(),
        serde_json::json!({"domain":"meta","action":"capabilities"}),
    )]);
    let environment = CliTestEnvironment::new();
    environment.configure_tool_loop_mock_model(server.base_url());
    let mut command = environment.std_command();
    command.env("SSH_CONNECTION", "fixture").args([
        "exec",
        "Report registered capabilities without starting a terminal or capturing a screen",
        "--auto",
        "--no-verify-final-changes",
        "--output-format",
        "json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(60));
    assert!(output.status.success(), "{}", stderr(&output));
    server.assert_chat_completion_requests(2);
    let requests = server.chat_completion_request_bodies();
    let message = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("capability tool result");
    let payload: serde_json::Value = serde_json::from_str(message["content"].as_str().unwrap())
        .unwrap_or_else(|error| panic!("invalid capability payload: {error}: {message}"));
    assert_eq!(payload["domains"]["terminal"]["available"], true);
    assert_eq!(payload["computer_use"]["available"], false);
}

#[test]
fn computer_use_is_not_exposed_by_an_ssh_execution_host() {
    let requests = computer_use_agent_status(true);
    assert!(requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["function"]["name"] != "ComputerUse"));
    assert!(!requests[1]["messages"]
        .to_string()
        .contains("agent-directed-control-v1"));
}

#[test]
#[ignore = "requires a local graphical login session; reads status only and requests no OS consent"]
fn computer_use_graphical_cli_routes_the_real_tool_to_the_native_provider() {
    let requests = computer_use_agent_status(false);
    assert!(requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "ComputerUse"));
    let reply = requests[1]["messages"].to_string();
    assert!(
        reply.contains("agent-directed-control-v1"),
        "native provider was not called: {reply}"
    );
    assert!(reply.contains("stop-control"), "{reply}");
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the disposable AX fixture plus Accessibility and Screen Recording; run test-native-ax-context.mjs --cli"]
fn computer_use_native_cli_observes_and_stops_fixture() {
    use serde_json::json;
    let pid: i32 = std::env::var("OPENBITFUN_AX_FIXTURE_PID")
        .expect("disposable fixture PID")
        .parse()
        .unwrap();
    let server = MockOpenAiServer::tool_sequence(vec![
        (
            "ComputerUse".into(),
            json!({"action":"get_app_state","app":{"pid":pid}}),
        ),
        ("ComputerUse".into(), json!({"action":"stop_control"})),
        ("ComputerUse".into(), json!({"action":"control_status"})),
    ]);
    let environment = CliTestEnvironment::new();
    environment.configure_tool_loop_image_model(server.base_url());
    let mut command = environment.std_command();
    command.args([
        "exec",
        "Observe the disposable OpenBitFun AX context fixture, then stop control",
        "--auto",
        "--no-verify-final-changes",
        "--output-format",
        "json",
    ]);
    let output = command_output_with_timeout(&mut command, std::time::Duration::from_secs(60));
    assert!(output.status.success(), "{}", stderr(&output));
    server.assert_chat_completion_requests(4);
    let requests = server.chat_completion_request_bodies();
    let observation = requests[1]["messages"].to_string();
    assert!(
        observation.contains("context-value"),
        "fixture AX text was not observed"
    );
    assert!(
        observation.contains("Save report"),
        "fixture button was not observed"
    );
    assert!(
        observation.contains("screenshot_id"),
        "capture was not bound to an observation"
    );
    assert!(
        observation.contains("data:image/"),
        "native window capture did not reach the model"
    );
    let stopped =
        requests[3]["messages"].as_array().unwrap().last().unwrap()["content"].to_string();
    assert!(
        stopped.contains("stopped"),
        "native control was not stopped: {stopped}"
    );
}
