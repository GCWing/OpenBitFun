mod support;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use support::{
    CliTestEnvironment, MockOpenAiServer, STREAM_COMPLETED_MARKER, STREAM_RESIZED_MARKER,
    STREAM_START_MARKER,
};

const INITIAL_SIZE: PtySize = PtySize {
    rows: 30,
    cols: 100,
    pixel_width: 0,
    pixel_height: 0,
};
const RESIZED_SIZE: PtySize = PtySize {
    rows: 40,
    cols: 120,
    pixel_width: 0,
    pixel_height: 0,
};
const EXEC_STREAM_SIZE: PtySize = PtySize {
    rows: 30,
    cols: 4096,
    pixel_width: 0,
    pixel_height: 0,
};
const STARTUP_INPUT: &[u8] = b"exercise active turn resize Q7Z9";
const STARTUP_INPUT_SENTINEL: &str = "Q7Z9";
const MULTILINE_INPUT_SENTINEL: &str = "M7Q4";
// Must not match the product version in the startup header (for example beta).
const MULTILINE_TAIL_SENTINEL: &str = "Z9R2";
const RECOVERY_INPUT: &[u8] = b"READY_AFTER_CANCEL K4W8";
const RECOVERY_INPUT_SENTINEL: &str = "K4W8";

#[test]
fn scheduled_jobs_survive_cli_restart_and_run_without_a_controller_turn() {
    use serde_json::json;
    let environment = CliTestEnvironment::new();
    let cron_spec = || ("GetToolSpec".to_string(), json!({"tool_name":"Cron"}));
    let cron_call = |args| {
        (
            "CallDeferredTool".to_string(),
            json!({"tool_name":"Cron", "args":args}),
        )
    };
    let payload = "CLI_SCHEDULED_WAKEUP_7Q9";
    let creator = MockOpenAiServer::tool_sequence(vec![
        cron_spec(),
        cron_call(json!({"action":"add", "job":{
            "name":"CLI scheduled restart check", "schedule":{"kind":"at","at":"2099-01-01T00:00:00Z"},
            "payload":payload, "enabled":true
        }})),
        cron_call(json!({"action":"list"})),
    ]);
    environment.configure_tool_loop_mock_model(creator.base_url());
    let run_exec = || {
        let mut command = environment.std_command();
        command.args([
            "exec",
            "Manage the scheduled restart check",
            "--auto",
            "--no-verify-final-changes",
            "--output-format",
            "json",
        ]);
        let output = support::command_output_with_timeout(&mut command, Duration::from_secs(60));
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    };
    run_exec();
    creator.assert_chat_completion_requests(4);
    let mut jobs = environment.cron_jobs();
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(jobs["jobs"][0]["payload"]["text"], payload);
    let job_id = jobs["jobs"][0]["id"].as_str().unwrap().to_string();
    assert!(creator.chat_completion_request_bodies()[3]["messages"]
        .to_string()
        .contains(&job_id));

    let reader =
        MockOpenAiServer::tool_sequence(vec![cron_spec(), cron_call(json!({"action":"list"}))]);
    environment.configure_tool_loop_mock_model(reader.base_url());
    run_exec();
    reader.assert_chat_completion_requests(3);
    assert!(reader.chat_completion_request_bodies()[2]["messages"]
        .to_string()
        .contains(&job_id));

    // Advance the persisted deadline while no host is running. The restarted
    // interactive host must restore the session and execute without UI input.
    let due = chrono::Utc::now() - chrono::Duration::seconds(1);
    jobs["jobs"][0]["schedule"]["at"] = json!(due.to_rfc3339());
    jobs["jobs"][0]["state"]["nextRunAtMs"] = json!(due.timestamp_millis());
    std::fs::write(
        environment.cron_jobs_path(),
        serde_json::to_vec_pretty(&jobs).unwrap(),
    )
    .unwrap();
    let runner = MockOpenAiServer::immediate();
    environment.configure_mock_model(runner.base_url());
    let mut process = PtyProcess::spawn(environment.pty_command(), INITIAL_SIZE);
    process.expect_output(
        "\x1b[?2004h",
        Duration::from_secs(60),
        "scheduled host did not start",
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let persisted = environment.cron_jobs();
        let job = &persisted["jobs"][0];
        if job["state"]["lastRunStatus"] == "ok" {
            assert_eq!(job["enabled"], false, "one-shot job must finish once");
            assert!(job["state"]["activeTurnId"].is_null());
            assert!(job["state"]["lastRunStartedAtMs"].is_number());
            assert!(job["state"]["lastRunFinishedAtMs"].is_number());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "scheduled job did not settle: {persisted}; terminal: {}",
            process.output()
        );
        thread::sleep(Duration::from_millis(25));
    }
    runner.assert_chat_completion_requests(1);
    assert!(runner.chat_completion_request_bodies()[0]["messages"]
        .to_string()
        .contains(payload));
    process.write(&[0x03]);
    let (status, output) = process.finish(Duration::from_secs(15));
    assert!(status.success(), "{output}");
}

#[cfg(unix)]
#[test]
fn startup_bracketed_paste_attaches_an_image_path_without_rendering_the_path() {
    let server = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_image_model(server.base_url());
    let image_path = environment.workspace().join("startup attachment.png");
    image::DynamicImage::new_rgba8(2, 1)
        .save_with_format(&image_path, image::ImageFormat::Png)
        .expect("write startup image fixture");
    let mut process = PtyProcess::spawn(environment.pty_command(), INITIAL_SIZE);

    process.expect_output(
        "\x1b[?2004h",
        Duration::from_secs(30),
        "interactive startup did not enable bracketed paste",
    );
    process.write(format!("\x1b[200~{}\x1b[201~", image_path.display()).as_bytes());
    process.expect_output(
        "[Image 1]",
        Duration::from_secs(15),
        "startup did not render the OpenCode-compatible image placeholder",
    );
    assert!(
        !process
            .output()
            .contains(image_path.to_string_lossy().as_ref()),
        "the local image path leaked into the rendered prompt"
    );

    process.write(b"\r");
    process.expect_output(
        STREAM_COMPLETED_MARKER,
        Duration::from_secs(30),
        "the image draft did not reach the model request",
    );
    process.expect_idle_after_turn(1, Duration::from_secs(30));
    process.write(&[0x03]);
    let (status, output) = process.finish(Duration::from_secs(15));
    assert!(
        status.success(),
        "unexpected process status {status}:\n{output}"
    );
    assert!(output.contains("[Image 1]"), "{output}");
    assert!(output.contains("Goodbye!"), "{output}");

    let requests = server.chat_completion_request_bodies();
    assert_eq!(
        requests.len(),
        1,
        "unexpected model requests: {requests:#?}"
    );
    let request = requests[0].to_string();
    assert!(request.contains("\"type\":\"image_url\""), "{request}");
    assert!(request.contains("data:image/"), "{request}");
    assert!(
        !request.contains(image_path.to_string_lossy().as_ref()),
        "the local image path leaked into the model request: {request}"
    );
}

#[test]
fn interactive_startup_survives_resize_multiline_input_and_emits_cleanup() {
    let environment = CliTestEnvironment::new();
    let mut process = PtyProcess::spawn(environment.pty_command(), INITIAL_SIZE);

    process.expect_output(
        "\x1b[?2004h",
        Duration::from_secs(30),
        "interactive startup did not enable bracketed paste",
    );
    #[cfg(unix)]
    assert!(
        process.output().contains("\x1b[?1049h"),
        "interactive TUI must enter the alternate screen"
    );

    process.resize(RESIZED_SIZE);

    // Ratatui emits only changed cells, so the sentinel must not share characters
    // with the startup placeholder at the same screen positions.
    #[cfg(unix)]
    process.write(
        format!("\x1b[200~{MULTILINE_INPUT_SENTINEL}\r\n{MULTILINE_TAIL_SENTINEL}\x1b[201~")
            .as_bytes(),
    );
    #[cfg(windows)]
    {
        let mut rapid_input = MULTILINE_INPUT_SENTINEL.as_bytes().to_vec();
        rapid_input.extend(std::iter::repeat_n(b'a', 251));
        rapid_input.push(b'\r');
        rapid_input.extend_from_slice(MULTILINE_TAIL_SENTINEL.as_bytes());
        process.write(&rapid_input);
    }

    process.expect_output(
        MULTILINE_INPUT_SENTINEL,
        Duration::from_secs(15),
        "interactive startup did not render multiline input",
    );
    process.expect_output(
        MULTILINE_TAIL_SENTINEL,
        Duration::from_secs(15),
        "interactive startup did not render the multiline input tail",
    );
    assert!(
        !process.output().contains("Welcome to OpenBitFun CLI!"),
        "multiline input was submitted instead of remaining in the startup editor"
    );

    process.write(&[0x03]);
    let (status, output) = process.finish(Duration::from_secs(15));
    assert!(
        status.success(),
        "unexpected process status {status}:\n{output}"
    );
    assert!(
        output.contains(MULTILINE_INPUT_SENTINEL),
        "paste text was not rendered:\n{output}"
    );
    assert!(
        output.contains(MULTILINE_TAIL_SENTINEL),
        "paste tail was not rendered:\n{output}"
    );
    assert!(
        !output.contains("[200~") && !output.contains("[201~"),
        "bracketed-paste markers leaked into input:\n{output}"
    );
    assert!(
        output.contains("\x1b[?2004l"),
        "bracketed paste was not disabled:\n{output}"
    );
    #[cfg(unix)]
    assert!(
        output.contains("\x1b[?1049l"),
        "alternate screen was not left:\n{output}"
    );
    assert!(
        output.contains("\x1b[?25h"),
        "cursor was not restored:\n{output}"
    );
    assert!(
        output.contains("Goodbye!"),
        "clean exit was not reported:\n{output}"
    );
}

#[test]
fn active_turn_resize_can_be_cancelled_and_returns_to_editable_input() {
    let server = MockOpenAiServer::gated();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let mut process = PtyProcess::spawn(environment.pty_command(), INITIAL_SIZE);

    process.expect_output(
        "\x1b[?2004h",
        Duration::from_secs(30),
        "interactive startup did not enable bracketed paste",
    );
    process.write(STARTUP_INPUT);
    process.expect_output(
        STARTUP_INPUT_SENTINEL,
        Duration::from_secs(15),
        "startup prompt sentinel was not rendered before submission",
    );
    process.write(b"\r");
    process.expect_output(
        STREAM_START_MARKER,
        Duration::from_secs(30),
        "active model stream was not rendered",
    );

    let active_turn_size = PtySize {
        rows: 24,
        cols: 52,
        pixel_width: 0,
        pixel_height: 0,
    };
    process.resize(active_turn_size);
    server.release();
    process.expect_output(
        STREAM_RESIZED_MARKER,
        Duration::from_secs(15),
        "active model stream did not remain renderable after resize",
    );
    process.write(&[0x03]);
    process.expect_output(
        "Cancelled",
        Duration::from_secs(15),
        "active turn did not reach the cancelled state after resize",
    );
    server.expect_stream_disconnect(Duration::from_secs(5));

    process.write(RECOVERY_INPUT);
    process.expect_output(
        RECOVERY_INPUT_SENTINEL,
        Duration::from_secs(15),
        "recovery input sentinel was not rendered after cancellation",
    );
    process.write(&[0x03]);

    let (status, output) = process.finish(Duration::from_secs(15));
    assert!(
        status.success(),
        "unexpected process status {status}:\n{output}"
    );
    assert!(output.contains(STREAM_START_MARKER), "{output}");
    assert!(output.contains(STREAM_RESIZED_MARKER), "{output}");
    assert!(output.contains("Cancelled"), "{output}");
    assert!(output.contains(RECOVERY_INPUT_SENTINEL), "{output}");
    assert!(output.contains("\x1b[?2004l"), "{output}");
    assert!(output.contains("\x1b[?25h"), "{output}");
    assert!(output.contains("Goodbye!"), "{output}");
}

#[test]
fn external_editor_restores_the_tui_and_applies_the_edited_draft() {
    let server = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let editor = create_editor_helper(environment.workspace());
    let mut command = environment.pty_command();
    command.env("EDITOR", editor.as_os_str());
    command.env_remove("VISUAL");
    let mut process = PtyProcess::spawn(command, INITIAL_SIZE);

    process.expect_output(
        "\x1b[?2004h",
        Duration::from_secs(30),
        "interactive startup did not enable bracketed paste",
    );
    process.write(b"enter chat for editor test");
    process.expect_output(
        "editor test",
        Duration::from_secs(15),
        "startup prompt was not rendered before submission",
    );
    process.write(b"\r");
    process.expect_output(
        STREAM_COMPLETED_MARKER,
        Duration::from_secs(30),
        "initial turn did not finish before /editor",
    );
    process.expect_idle_after_turn(1, Duration::from_secs(30));

    process.write(b"/editor");
    process.expect_output(
        "/editor",
        Duration::from_secs(15),
        "editor command was not rendered before submission",
    );
    process.write(b"\r");
    process.expect_output(
        "EDITOR_UPDATED_DRAFT",
        Duration::from_secs(30),
        "edited draft was not rendered after the editor closed",
    );
    // Ratatui can emit each unchanged-separated word at a different cursor position.
    process.expect_output(
        "updated",
        Duration::from_secs(15),
        "editor completion status was not rendered",
    );

    let output = process.output();
    assert!(
        output.matches("\x1b[?2004h").count() >= 2,
        "TUI did not re-enable bracketed paste after editor: {output}"
    );
    assert!(
        output.contains("\x1b[?2004l"),
        "TUI did not disable bracketed paste before editor: {output}"
    );

    process.write(&[0x15]);
    process.write(b"/exit\r");
    let (status, output) = process.finish(Duration::from_secs(20));
    assert!(
        status.success(),
        "unexpected process status {status}:\n{output}"
    );
    assert!(output.contains("EDITOR_UPDATED_DRAFT"), "{output}");
    assert!(output.contains("Goodbye!"), "{output}");
}

#[test]
fn export_dialog_writes_markdown_under_the_local_cli_directory() {
    let server = MockOpenAiServer::immediate();
    let environment = CliTestEnvironment::new();
    environment.initialize_git_repository();
    environment.configure_mock_model(server.base_url());
    let mut process = PtyProcess::spawn(environment.pty_command(), INITIAL_SIZE);

    process.expect_output("\x1b[?2004h", Duration::from_secs(30), "TUI did not start");
    process.write(b"export transcript contract");
    process.expect_output(
        "script contract",
        Duration::from_secs(15),
        "startup prompt was not rendered",
    );
    process.write(b"\r");
    process.expect_output(
        STREAM_COMPLETED_MARKER,
        Duration::from_secs(30),
        "initial turn did not finish before /export",
    );
    process.expect_idle_after_turn(1, Duration::from_secs(30));

    process.write(b"/export");
    process.expect_output(
        "/export",
        Duration::from_secs(15),
        "export command was not rendered",
    );
    process.write(b"\r");
    // The title can be split by Ratatui's cursor movement; the file row is contiguous.
    process.expect_output(
        "File: session-",
        Duration::from_secs(15),
        "export dialog did not open",
    );
    process.write(b"\r");
    let export_deadline = Instant::now() + Duration::from_secs(20);
    while session_markdown_exports(environment.workspace()).is_empty()
        && Instant::now() < export_deadline
    {
        if let Some(status) = process
            .child
            .as_mut()
            .expect("PTY process child")
            .try_wait()
            .expect("poll OpenBitFun CLI process")
        {
            panic!(
                "export process exited with {status}; output:\n{}",
                process.output()
            );
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !session_markdown_exports(environment.workspace()).is_empty(),
        "export did not create a Markdown file; output:\n{}",
        process.output()
    );

    process.write(b"/exit");
    process.expect_output(
        "/exit",
        Duration::from_secs(10),
        "exit command was not rendered",
    );
    process.write(b"\r");
    let (status, output) = process.finish(Duration::from_secs(20));
    assert!(
        status.success(),
        "unexpected process status {status}:\n{output}"
    );

    let exports = session_markdown_exports(environment.workspace());
    assert_eq!(exports.len(), 1, "unexpected exports: {exports:?}");
    let markdown = std::fs::read_to_string(&exports[0]).expect("read Markdown export");
    assert!(
        markdown.contains("## User\n\nexport transcript contract"),
        "{markdown}"
    );
    assert!(markdown.contains("## Assistant"), "{markdown}");
    assert!(
        !markdown.contains("Welcome to OpenBitFun CLI!"),
        "{markdown}"
    );
}

fn session_markdown_exports(workspace: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(workspace)
        .expect("read workspace exports")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("session-") && name.ends_with(".md"))
        })
        .collect()
}

fn create_editor_helper(workspace: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let path = workspace.join("openbitfun-test-editor.cmd");
        std::fs::write(&path, "@echo off\r\n>\"%~1\" echo EDITOR_UPDATED_DRAFT\r\n")
            .expect("write Windows editor helper");
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let path = workspace.join("openbitfun-test-editor.sh");
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf '%s\\n' EDITOR_UPDATED_DRAFT > \"$1\"\n",
        )
        .expect("write Unix editor helper");
        let mut permissions = std::fs::metadata(&path)
            .expect("editor helper metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make editor helper executable");
        path
    }
}

#[test]
fn exec_stream_json_ctrl_c_emits_one_cancelled_terminal_and_disconnects() {
    assert_exec_stream_json_ctrl_c_contract();
}

fn assert_exec_stream_json_ctrl_c_contract() {
    let server = MockOpenAiServer::gated();
    let environment = CliTestEnvironment::new();
    environment.configure_mock_model(server.base_url());
    let mut command = environment.pty_command();
    command.args([
        "exec",
        "exercise interrupt contract",
        "--output-format",
        "stream-json",
    ]);
    let mut process = PtyProcess::spawn(command, EXEC_STREAM_SIZE);

    process.expect_output(
        STREAM_START_MARKER,
        Duration::from_secs(30),
        "exec model stream did not start",
    );
    process.write(&[0x03]);
    server.expect_stream_disconnect(Duration::from_secs(5));

    let (status, output) = process.finish(Duration::from_secs(15));
    assert_eq!(
        status.exit_code(),
        1,
        "interrupt exit code changed:\n{output}"
    );
    assert!(
        output.contains("OPENBITFUN_EXIT: cancelled:"),
        "missing stable cancellation diagnostic:\n{output}"
    );
    let events = strict_stream_json_events(&output);
    let terminal_events = events
        .iter()
        .filter(|value| {
            matches!(
                value["event"]["type"].as_str(),
                Some(
                    "DialogTurnCompleted"
                        | "DialogTurnCancelled"
                        | "DialogTurnFailed"
                        | "SystemError"
                )
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        terminal_events.len(),
        1,
        "interrupt must emit exactly one terminal envelope:\n{output}"
    );
    let raw_terminal_count = [
        "DialogTurnCompleted",
        "DialogTurnCancelled",
        "DialogTurnFailed",
        "SystemError",
    ]
    .iter()
    .map(|event_type| {
        output
            .matches(&format!("\"type\":\"{event_type}\""))
            .count()
    })
    .sum::<usize>();
    assert_eq!(
        raw_terminal_count, 1,
        "raw PTY output contains a hidden or duplicate terminal envelope:\n{output}"
    );
    assert_eq!(
        terminal_events[0]["event"]["type"], "DialogTurnCancelled",
        "interrupt must settle as cancelled:\n{output}"
    );
    assert_eq!(
        events.last().expect("stream-json cancellation event")["event"]["type"],
        "DialogTurnCancelled",
        "cancellation must be the final protocol envelope:\n{output}"
    );
}

fn strict_stream_json_events(output: &str) -> Vec<serde_json::Value> {
    output
        .lines()
        .filter_map(|raw_line| {
            let line = strip_terminal_sequences(raw_line);
            let line = line.strip_prefix("^C").unwrap_or(&line);
            let is_protocol_candidate = line.contains('{')
                || line.contains("\"event\"")
                || [
                    "DialogTurnCompleted",
                    "DialogTurnCancelled",
                    "DialogTurnFailed",
                    "SystemError",
                ]
                .iter()
                .any(|event_type| line.contains(event_type));
            if !is_protocol_candidate {
                return None;
            }
            let value = serde_json::from_str::<serde_json::Value>(line).unwrap_or_else(|error| {
                panic!("invalid stream-json PTY line {line:?}: {error}\nfull output:\n{output}")
            });
            assert!(
                value.get("event").is_some(),
                "stream-json PTY record is not an Agentic envelope: {line:?}"
            );
            Some(value)
        })
        .collect()
}

#[test]
fn stream_json_parser_accepts_the_echoed_ctrl_c_prefix_before_an_envelope() {
    let events = strict_stream_json_events(
        "^C{\"id\":\"event-1\",\"event\":{\"type\":\"SessionStateChanged\"}}\n",
    );

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"]["type"], "SessionStateChanged");
}

fn strip_terminal_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\x1b' {
            if character != '\r' {
                output.push(character);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if next.is_ascii() && (0x40..=0x7e).contains(&(next as u8)) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) | None => {}
        }
    }
    output
}

fn captured_output(captured: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&captured.lock().expect("lock captured PTY output")).into_owned()
}

struct PtyProcess {
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    captured: Arc<Mutex<Vec<u8>>>,
    reader_thread: Option<thread::JoinHandle<()>>,
}

impl PtyProcess {
    fn spawn(command: CommandBuilder, size: PtySize) -> Self {
        let pair = native_pty_system().openpty(size).expect("open native PTY");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn OpenBitFun CLI in native PTY");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone PTY reader");
        let writer = pair.master.take_writer().expect("take PTY writer");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let reader_capture = Arc::clone(&captured);
        let reader_thread = thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            while let Ok(read) = reader.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                reader_capture
                    .lock()
                    .expect("lock captured PTY output")
                    .extend_from_slice(&chunk[..read]);
            }
        });

        // Detect an immediate startup failure before handing the process to the test.
        if let Some(status) = child.try_wait().expect("poll initial CLI process") {
            panic!("OpenBitFun CLI exited during PTY startup: {status}");
        }

        Self {
            master: Some(pair.master),
            writer: Some(writer),
            child: Some(child),
            captured,
            reader_thread: Some(reader_thread),
        }
    }

    fn output(&self) -> String {
        captured_output(&self.captured)
    }

    fn expect_output(&mut self, expected: &str, timeout: Duration, context: &str) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.output().contains(expected) {
                return;
            }
            if let Some(status) = self
                .child
                .as_mut()
                .expect("PTY process child")
                .try_wait()
                .expect("poll OpenBitFun CLI process")
            {
                let output = self.output();
                self.close_io();
                panic!("{context}; process exited with {status}; output:\n{output}");
            }
            thread::sleep(Duration::from_millis(25));
        }
        let output = self.output();
        self.terminate();
        panic!("{context}; output:\n{output}");
    }

    /// Waits for the status bar to fall back to its idle summary.
    ///
    /// `STREAM_COMPLETED_MARKER` is assistant text, so it lands in the transcript while
    /// `is_processing` is still set. Commands declared `ActionAvailability::Idle` — `/export`
    /// and `/editor` among them — are refused with a status message rather than opened during
    /// that window, so gating on the marker alone races the end of the turn. The status bar
    /// paints the "Thinking..." spinner for as long as `is_processing` holds and only renders
    /// `Messages: … | Tool calls: …` once it clears, which makes that summary the first point
    /// where those commands are actually accepted. Match only the idle-only prefix because
    /// Ratatui can insert cursor movement between unchanged spans later in the status line.
    fn expect_idle_after_turn(&mut self, messages: usize, timeout: Duration) {
        self.expect_output(
            &format!("Messages: {messages}"),
            timeout,
            "turn did not return to idle",
        );
    }

    fn resize(&self, size: PtySize) {
        let master = self.master.as_ref().expect("PTY master");
        master.resize(size).expect("resize native PTY");
        assert_eq!(
            master.get_size().expect("read resized PTY dimensions"),
            size
        );
    }

    fn write(&mut self, bytes: &[u8]) {
        let writer = self.writer.as_mut().expect("PTY writer");
        writer.write_all(bytes).expect("write terminal input");
        writer.flush().expect("flush terminal input");
    }

    fn finish(mut self, timeout: Duration) -> (portable_pty::ExitStatus, String) {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self
                .child
                .as_mut()
                .expect("PTY process child")
                .try_wait()
                .expect("poll OpenBitFun CLI process")
            {
                break status;
            }
            if Instant::now() >= deadline {
                let output = self.output();
                self.terminate();
                panic!("interactive process did not exit; output:\n{output}");
            }
            thread::sleep(Duration::from_millis(25));
        };
        self.child.take();
        self.close_io();
        (status, self.output())
    }

    fn close_io(&mut self) {
        self.writer.take();
        self.master.take();
        if let Some(reader_thread) = self.reader_thread.take() {
            reader_thread.join().expect("join PTY reader");
        }
    }

    fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.close_io();
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}
