use super::{read_pipe_output, OutputCursor, OutputState};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::time::Instant;

fn initial_cursor() -> OutputCursor {
    OutputCursor {
        next_seq: 0,
        observed_output_chars: 0,
    }
}

#[tokio::test]
async fn pipe_read_boundary_preserves_results_progress_capture_and_counts() {
    // The comma's EF BC | 8C bytes straddle the real 8192-byte read buffer.
    let expected = format!("{}，后😀\n", "中".repeat(2730));
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
    let output = Arc::new(OutputState::new(Some(capture_tx)));
    read_pipe_output(expected.as_bytes(), Arc::clone(&output)).await;
    output.close(Some(0)).await;

    let (progress_tx, mut progress_rx) = mpsc::channel(16);
    let collected = output
        .collect_until(initial_cursor(), Instant::now(), 10_000, Some(&progress_tx))
        .await;
    assert_eq!(collected.output, expected);
    assert_eq!(collected.original_output_chars, expected.chars().count());
    let mut progress = String::new();
    while let Ok(text) = progress_rx.try_recv() {
        progress.push_str(&text);
    }
    let mut captured = String::new();
    while let Ok(text) = capture_rx.try_recv() {
        captured.push_str(&text);
    }
    assert_eq!(progress, expected);
    assert_eq!(captured, expected);

    let truncated = output
        .collect_until(initial_cursor(), Instant::now(), 8, None)
        .await;
    assert_eq!(truncated.original_output_chars, expected.chars().count());
    assert_eq!(
        truncated.output,
        "中中中中\n... [truncated, middle omitted] ...\n，后😀\n"
    );
}

#[tokio::test]
async fn pipe_streams_keep_independent_partial_characters_across_polls() {
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
    let output = Arc::new(OutputState::new(Some(capture_tx)));
    let (mut stdout_writer, stdout) = tokio::io::duplex(64);
    let (mut stderr_writer, stderr) = tokio::io::duplex(64);
    let stdout_task = tokio::spawn(read_pipe_output(stdout, Arc::clone(&output)));
    let stderr_task = tokio::spawn(read_pipe_output(stderr, Arc::clone(&output)));

    stdout_writer.write_all(b"out:\xe4\xb8").await.unwrap();
    assert_eq!(capture_rx.recv().await.unwrap(), "out:");
    stderr_writer.write_all(b"err:\xe6\x96").await.unwrap();
    assert_eq!(capture_rx.recv().await.unwrap(), "err:");
    let first = output
        .collect_until(initial_cursor(), Instant::now(), 100, None)
        .await;
    assert_eq!(first.output, "out:err:");
    assert_eq!(first.original_output_chars, 8);

    stdout_writer.write_all(b"\xad").await.unwrap();
    assert_eq!(capture_rx.recv().await.unwrap(), "中");
    stderr_writer.write_all(b"\x87").await.unwrap();
    assert_eq!(capture_rx.recv().await.unwrap(), "文");
    let second = output
        .collect_until(first.cursor, Instant::now(), 100, None)
        .await;
    assert_eq!(second.output, "中文");
    assert_eq!(second.original_output_chars, 2);

    stdout_writer.write_all(b"\xf0\x9f").await.unwrap();
    drop(stdout_writer);
    drop(stderr_writer);
    stdout_task.await.unwrap();
    stderr_task.await.unwrap();
    output.close(Some(0)).await;
    assert_eq!(capture_rx.recv().await.unwrap(), "\u{fffd}");
    let last = output
        .collect_until(second.cursor, Instant::now(), 100, None)
        .await;
    assert_eq!(last.output, "\u{fffd}");
    assert_eq!(last.original_output_chars, 1);
}

#[cfg(windows)]
#[tokio::test]
async fn git_bash_cat_preserves_utf8_fixture_through_exec_command() {
    use super::{ExecCommandRequest, ExecProcessManager};
    use crate::shell::ShellDetector;
    use std::collections::HashMap;

    let Some(shell) = ShellDetector::detect_git_bash() else {
        eprintln!("Skipping Git Bash encoding regression: Git Bash is not installed");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf8-boundary.txt");
    let expected = format!("{}，后😀\n", "中".repeat(2730));
    std::fs::write(&path, expected.as_bytes()).unwrap();
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
    let (progress_tx, mut progress_rx) = mpsc::channel(32);
    let manager = ExecProcessManager::default();
    let result = manager
        .exec_command_streaming(
            ExecCommandRequest {
                argv: vec![
                    shell.path.to_string_lossy().into_owned(),
                    "-lc".into(),
                    "cat -- \"$OPENBITFUN_ENCODING_FIXTURE\"".into(),
                ],
                cwd: dir.path().to_path_buf(),
                env: HashMap::from([(
                    "OPENBITFUN_ENCODING_FIXTURE".into(),
                    path.to_string_lossy().replace('\\', "/"),
                )]),
                tty: false,
                yield_time_ms: Some(10_000),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: Some(capture_tx),
            },
            progress_tx,
        )
        .await
        .unwrap();
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.output, expected);
    assert_eq!(result.original_output_chars, expected.chars().count());
    let mut progress = String::new();
    while let Ok(text) = progress_rx.try_recv() {
        progress.push_str(&text);
    }
    let mut capture = String::new();
    while let Ok(text) = capture_rx.try_recv() {
        capture.push_str(&text);
    }
    assert_eq!(progress, expected);
    assert_eq!(capture, expected);
}
