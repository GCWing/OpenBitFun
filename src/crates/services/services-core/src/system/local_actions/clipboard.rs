//! Text clipboard IO on the runtime host. Payloads travel through stdin/stdout,
//! never command arguments or shell interpolation.

use super::{LocalSystemActionError, LocalSystemActionErrorKind};
use crate::process_manager;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELPER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

struct Helper {
    program: String,
    args: Vec<String>,
}

impl Helper {
    fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.into(),
            args: args.iter().map(|arg| (*arg).into()).collect(),
        }
    }
}

#[derive(Debug)]
enum HelperError {
    Missing(String),
    Failed(LocalSystemActionError),
}

fn failure(kind: LocalSystemActionErrorKind, message: impl Into<String>) -> HelperError {
    HelperError::Failed(LocalSystemActionError::new(kind, message))
}

async fn run_helper(
    helper: &Helper,
    input: Option<&str>,
    timeout: Duration,
) -> Result<String, HelperError> {
    let writing = input.is_some();
    let mut child = process_manager::create_tokio_command(&helper.program)
        .args(&helper.args)
        .stdin(if writing {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if writing {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        // X11/Wayland owners may fork and keep stderr open to serve future
        // pastes. Waiting for EOF on an inherited pipe would hang a successful
        // copy. Clipboard contents and helper diagnostics are never logged.
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                HelperError::Missing(helper.program.clone())
            } else {
                failure(
                    LocalSystemActionErrorKind::NotAvailable,
                    format!(
                        "Clipboard helper {} could not start: {error}",
                        helper.program
                    ),
                )
            }
        })?;
    let operation = async {
        let mut bytes = Vec::new();
        if let Some(text) = input {
            let mut stdin = child.stdin.take().expect("piped clipboard stdin");
            stdin.write_all(text.as_bytes()).await.map_err(|error| {
                failure(
                    LocalSystemActionErrorKind::Internal,
                    format!("Clipboard input failed: {error}"),
                )
            })?;
            stdin.shutdown().await.map_err(|error| {
                failure(
                    LocalSystemActionErrorKind::Internal,
                    format!("Clipboard input could not close: {error}"),
                )
            })?;
            drop(stdin);
        } else {
            child
                .stdout
                .take()
                .expect("piped clipboard stdout")
                .take((MAX_TEXT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| {
                    failure(
                        LocalSystemActionErrorKind::Internal,
                        format!("Clipboard output failed: {error}"),
                    )
                })?;
            if bytes.len() > MAX_TEXT_BYTES {
                return Err(failure(
                    LocalSystemActionErrorKind::NotAvailable,
                    "Clipboard text exceeds the 16 MiB transport limit",
                ));
            }
        }
        let status = child.wait().await.map_err(|error| {
            failure(
                LocalSystemActionErrorKind::Internal,
                format!("Clipboard helper wait failed: {error}"),
            )
        })?;
        if !status.success() {
            return Err(failure(LocalSystemActionErrorKind::NotAvailable,
                format!("Clipboard helper {} exited with {:?}; the desktop clipboard may be unavailable or in use", helper.program, status.code())));
        }
        String::from_utf8(bytes).map_err(|_| {
            failure(
                LocalSystemActionErrorKind::NotAvailable,
                "Clipboard helper returned non-UTF-8 text",
            )
        })
    };
    let result = match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result,
        Err(_) => Err(failure(
            LocalSystemActionErrorKind::Timeout,
            "Clipboard helper timed out",
        )),
    };
    if result.is_err() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
    }
    result.map_err(|error| match error {
        HelperError::Failed(error) if writing => failure(error.kind(), format!(
            "[CLIPBOARD_WRITE_OUTCOME_UNKNOWN] {error}. The clipboard may have changed; no alternate helper or retry was used"
        )),
        other => other,
    })
}

// Use AppKit's string type explicitly: pbcopy can interpret text beginning with
// an RTF/PostScript header as a different clipboard format. A named pasteboard
// lets native tests exercise this same path without touching the user's board.
#[cfg(target_os = "macos")]
fn macos_helper(writing: bool, board_name: Option<&str>) -> Helper {
    let board = match board_name {
        Some(name) => format!(
            "$.NSPasteboard.pasteboardWithName({})",
            serde_json::to_string(name).unwrap()
        ),
        None => "$.NSPasteboard.generalPasteboard".into(),
    };
    let operation = if writing {
        "var d=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile; var t=$.NSString.alloc.initWithDataEncoding(d,$.NSUTF8StringEncoding); if(t.isNil()) throw Error('Invalid UTF-8 clipboard input'); p.clearContents; if(!p.setStringForType(t,$.NSPasteboardTypeString)) throw Error('Clipboard write failed');"
    } else {
        "var t=p.stringForType($.NSPasteboardTypeString); if(!t.isNil()) $.NSFileHandle.fileHandleWithStandardOutput.writeData(t.dataUsingEncoding($.NSUTF8StringEncoding));"
    };
    Helper::new(
        "/usr/bin/osascript",
        &[
            "-l",
            "JavaScript",
            "-e",
            &format!(
        "ObjC.import('AppKit'); ObjC.import('Foundation'); var p={board}; {operation} void 0;"
    ),
        ],
    )
}

#[cfg(target_os = "windows")]
fn windows_helper(writing: bool) -> Helper {
    let operation = if writing {
        // ReadToEnd preserves empty strings, CRLF/LF, trailing newlines and
        // non-ASCII text. $input is a line-oriented PowerShell pipeline.
        "$reader=[System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false,$true), $false); $text=$reader.ReadToEnd(); if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text,[System.Windows.Forms.TextDataFormat]::UnicodeText) }"
    } else {
        "$text=[System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText); $bytes=([System.Text.UTF8Encoding]::new($false,$true)).GetBytes($text); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)"
    };
    Helper::new(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            &format!(
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; {operation}"
    ),
        ],
    )
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxBackend {
    Wayland,
    X11,
}

#[cfg(any(target_os = "linux", test))]
fn linux_backend(
    wayland: Option<&str>,
    display: Option<&str>,
    session: Option<&str>,
) -> Option<LinuxBackend> {
    if wayland.is_some_and(|value| !value.is_empty()) || session == Some("wayland") {
        Some(LinuxBackend::Wayland)
    } else if display.is_some_and(|value| !value.is_empty()) || session == Some("x11") {
        Some(LinuxBackend::X11)
    } else {
        None
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_helpers(backend: LinuxBackend, writing: bool) -> Vec<Helper> {
    match (backend, writing) {
        (LinuxBackend::Wayland, true) => vec![Helper::new(
            "wl-copy",
            &["--type", "text/plain;charset=utf-8"],
        )],
        (LinuxBackend::Wayland, false) => {
            vec![Helper::new("wl-paste", &["--no-newline", "--type", "text"])]
        }
        (LinuxBackend::X11, true) => vec![
            Helper::new(
                "xclip",
                &["-selection", "clipboard", "-in", "-target", "UTF8_STRING"],
            ),
            Helper::new("xsel", &["--clipboard", "--input"]),
        ],
        (LinuxBackend::X11, false) => vec![
            Helper::new(
                "xclip",
                &["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
            ),
            Helper::new("xsel", &["--clipboard", "--output"]),
        ],
    }
}

fn helpers(writing: bool) -> Result<Vec<Helper>, LocalSystemActionError> {
    #[cfg(target_os = "macos")]
    {
        Ok(vec![macos_helper(writing, None)])
    }
    #[cfg(target_os = "windows")]
    {
        Ok(vec![windows_helper(writing)])
    }
    #[cfg(target_os = "linux")]
    {
        let backend = linux_backend(
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
            std::env::var("DISPLAY").ok().as_deref(),
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        )
        .ok_or_else(|| {
            LocalSystemActionError::new(
                LocalSystemActionErrorKind::NotAvailable,
                "No X11 or Wayland desktop session is available on the runtime host",
            )
        })?;
        Ok(linux_helpers(backend, writing))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = writing;
        Err(LocalSystemActionError::new(
            LocalSystemActionErrorKind::NotAvailable,
            "Clipboard text is unsupported on this OS",
        ))
    }
}

async fn run_candidates(
    helpers: &[Helper],
    input: Option<&str>,
    timeout: Duration,
) -> Result<String, LocalSystemActionError> {
    let mut missing = Vec::new();
    for helper in helpers {
        match run_helper(helper, input, timeout).await {
            Ok(text) => return Ok(text),
            // Only an executable that never started permits a write fallback.
            // Never replay input after a timeout, exit error or broken pipe.
            Err(HelperError::Missing(program)) => missing.push(program),
            Err(HelperError::Failed(error)) => return Err(error),
        }
    }
    Err(LocalSystemActionError::new(
        LocalSystemActionErrorKind::NotAvailable,
        format!(
            "Clipboard helper unavailable on this host: {}",
            missing.join(", ")
        ),
    ))
}

pub(super) async fn read_text() -> Result<String, LocalSystemActionError> {
    run_candidates(&helpers(false)?, None, HELPER_TIMEOUT).await
}

pub(super) async fn write_text(text: &str) -> Result<(), LocalSystemActionError> {
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        return Err(LocalSystemActionError::new(
            LocalSystemActionErrorKind::InvalidParams,
            "Clipboard text must be at most 16 MiB and contain no NUL characters",
        ));
    }
    run_candidates(&helpers(true)?, Some(text), HELPER_TIMEOUT)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT_CASES: &[&str] = &[
        "plain text",
        "中文 café 🦀",
        " first\n\nlast\n",
        "first\r\nsecond\r\n",
        "'\" $() `echo no` ; <tag> & |",
        "{\\rtf1\\ansi this must stay literal text}",
        "",
    ];

    struct Fixture {
        dir: tempfile::TempDir,
        helper: Helper,
    }

    impl Fixture {
        fn new(unix: &str, windows: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let value = dir.path().join("value");
            #[cfg(unix)]
            let helper = {
                let _ = windows;
                let script = dir.path().join("fixture.sh");
                std::fs::write(&script, unix).unwrap();
                Helper::new("sh", &[script.to_str().unwrap(), value.to_str().unwrap()])
            };
            #[cfg(windows)]
            let helper = {
                let _ = unix;
                let script = dir.path().join("fixture.ps1");
                std::fs::write(
                    &script,
                    format!("param([string]$Path)\n$ErrorActionPreference='Stop'\n{windows}"),
                )
                .unwrap();
                Helper::new(
                    "powershell.exe",
                    &[
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        script.to_str().unwrap(),
                        value.to_str().unwrap(),
                    ],
                )
            };
            Self { dir, helper }
        }

        fn writer() -> Self {
            Self::new("cat > \"$1\"", "$file=[IO.File]::Create($Path); [Console]::OpenStandardInput().CopyTo($file); $file.Dispose()")
        }

        fn reader() -> Self {
            Self::new("cat \"$1\"", "$bytes=[IO.File]::ReadAllBytes($Path); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)")
        }
    }

    #[tokio::test]
    async fn helper_transport_preserves_literal_utf8_and_line_endings() {
        let writer = Fixture::writer();
        let reader = Fixture::reader();
        for text in TEXT_CASES {
            run_helper(&writer.helper, Some(text), HELPER_TIMEOUT)
                .await
                .unwrap();
            assert_eq!(
                std::fs::read(writer.dir.path().join("value")).unwrap(),
                text.as_bytes()
            );
            std::fs::write(reader.dir.path().join("value"), text).unwrap();
            assert_eq!(
                run_helper(&reader.helper, None, HELPER_TIMEOUT)
                    .await
                    .unwrap(),
                *text
            );
        }
    }

    #[tokio::test]
    async fn missing_executable_can_fall_back_before_any_input() {
        let fixture = Fixture::writer();
        let value = fixture.dir.path().join("value");
        run_candidates(
            &[
                Helper::new("openbitfun-clipboard-missing-fixture", &[]),
                fixture.helper,
            ],
            Some("fallback"),
            HELPER_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(value).unwrap(), "fallback");
    }

    #[tokio::test]
    async fn failed_write_is_not_replayed_even_after_accepting_text() {
        let first = Fixture::new("cat > \"$1\"; exit 7", "$file=[IO.File]::Create($Path); [Console]::OpenStandardInput().CopyTo($file); $file.Dispose(); exit 7");
        let second = Fixture::writer();
        let second_value = second.dir.path().join("value");
        let result = run_candidates(
            &[first.helper, second.helper],
            Some("submitted"),
            HELPER_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(result.message().contains("CLIPBOARD_WRITE_OUTCOME_UNKNOWN"));
        assert_eq!(
            std::fs::read_to_string(first.dir.path().join("value")).unwrap(),
            "submitted"
        );
        assert!(!second_value.exists());
    }

    #[tokio::test]
    async fn timeout_bounds_blocked_stdin_and_never_runs_an_alternate_writer() {
        let blocked = Fixture::new(
            "while :; do :; done",
            "while ($true) { Start-Sleep -Milliseconds 50 }",
        );
        let second = Fixture::writer();
        let second_value = second.dir.path().join("value");
        let started = std::time::Instant::now();
        let result = run_candidates(
            &[blocked.helper, second.helper],
            Some(&"x".repeat(1024 * 1024)),
            Duration::from_millis(150),
        )
        .await
        .unwrap_err();
        assert_eq!(result.kind(), LocalSystemActionErrorKind::Timeout);
        assert!(result.message().contains("CLIPBOARD_WRITE_OUTCOME_UNKNOWN"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!second_value.exists());
    }

    #[tokio::test]
    async fn read_rejects_invalid_utf8_instead_of_corrupting_text() {
        let fixture = Fixture::reader();
        std::fs::write(fixture.dir.path().join("value"), [0xff, 0xfe]).unwrap();
        let error = run_helper(&fixture.helper, None, HELPER_TIMEOUT)
            .await
            .unwrap_err();
        assert!(
            matches!(error, HelperError::Failed(error) if error.message().contains("non-UTF-8"))
        );
    }

    #[tokio::test]
    async fn read_timeout_is_bounded_without_claiming_a_write() {
        let fixture = Fixture::new(
            "while :; do :; done",
            "while ($true) { Start-Sleep -Milliseconds 50 }",
        );
        let started = std::time::Instant::now();
        let error = run_helper(&fixture.helper, None, Duration::from_millis(150))
            .await
            .unwrap_err();
        assert!(
            matches!(error, HelperError::Failed(error) if error.kind() == LocalSystemActionErrorKind::Timeout && !error.message().contains("WRITE_OUTCOME_UNKNOWN"))
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn oversized_read_is_bounded() {
        let fixture = Fixture::reader();
        std::fs::write(
            fixture.dir.path().join("value"),
            vec![b'x'; MAX_TEXT_BYTES + 1],
        )
        .unwrap();
        let error = run_helper(&fixture.helper, None, HELPER_TIMEOUT)
            .await
            .unwrap_err();
        assert!(
            matches!(error, HelperError::Failed(error) if error.message().contains("transport limit"))
        );
    }

    #[tokio::test]
    async fn invalid_write_is_rejected_before_a_desktop_is_needed() {
        assert_eq!(
            write_text("a\0b").await.unwrap_err().kind(),
            LocalSystemActionErrorKind::InvalidParams
        );
        assert_eq!(
            write_text(&"x".repeat(MAX_TEXT_BYTES + 1))
                .await
                .unwrap_err()
                .kind(),
            LocalSystemActionErrorKind::InvalidParams
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detached_clipboard_owner_does_not_hold_the_write_reply_open() {
        let fixture = Fixture::new("cat > \"$1\"; (sleep 2) >&2 &", "");
        let started = std::time::Instant::now();
        run_helper(&fixture.helper, Some("owned"), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join("value")).unwrap(),
            "owned"
        );
    }

    #[test]
    fn linux_uses_the_selected_desktop_clipboard_and_explicit_text_formats() {
        assert_eq!(
            linux_backend(Some("wayland-1"), Some(":1"), None),
            Some(LinuxBackend::Wayland)
        );
        assert_eq!(
            linux_backend(Some(""), Some(":1"), None),
            Some(LinuxBackend::X11)
        );
        assert_eq!(
            linux_backend(None, None, Some("wayland")),
            Some(LinuxBackend::Wayland)
        );
        assert_eq!(linux_backend(None, None, Some("tty")), None);
        assert_eq!(linux_backend(None, None, None), None);
        for writing in [false, true] {
            let wayland = linux_helpers(LinuxBackend::Wayland, writing);
            assert_eq!(
                wayland.len(),
                1,
                "A Wayland clipboard must not fall back to XWayland"
            );
            assert!(wayland[0].program.starts_with("wl-"));
            let x11 = linux_helpers(LinuxBackend::X11, writing);
            assert_eq!(x11[0].program, "xclip");
            assert!(x11[0].args.iter().any(|arg| arg == "UTF8_STRING"));
            assert_eq!(x11[1].program, "xsel");
        }
    }

    // A real desktop clipboard is slower than a fixture script: the Windows
    // helper starts PowerShell and loads WinForms on every call, and another
    // process can hold the clipboard for the duration of a copy. Product writes
    // never retry, but this environment-bound test retries a whole pass so a
    // transiently locked clipboard on a CI runner cannot fail the build.
    const NATIVE_ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(30);
    const NATIVE_ROUNDTRIP_PASSES: usize = 3;
    const NATIVE_ROUNDTRIP_BACKOFF: Duration = Duration::from_secs(2);

    enum RoundTripFailure {
        /// The desktop clipboard was busy or the helper never answered in time.
        Transient(String),
        /// The helper answered, and the answer contradicts the clipboard contract.
        Definite(String),
    }

    async fn run_native_roundtrip(pairs: &[(Helper, Helper)]) -> Result<(), RoundTripFailure> {
        for (writer, reader) in pairs {
            for text in TEXT_CASES {
                run_helper(writer, Some(text), NATIVE_ROUNDTRIP_TIMEOUT)
                    .await
                    .map_err(|error| classify_roundtrip_failure(writer, "write", error))?;
                let read = run_helper(reader, None, NATIVE_ROUNDTRIP_TIMEOUT)
                    .await
                    .map_err(|error| classify_roundtrip_failure(reader, "read", error))?;
                if read != *text {
                    return Err(RoundTripFailure::Definite(format!(
                        "{} read back text that differs from what {} wrote",
                        reader.program, writer.program
                    )));
                }
            }
        }
        Ok(())
    }

    fn classify_roundtrip_failure(
        helper: &Helper,
        direction: &str,
        error: HelperError,
    ) -> RoundTripFailure {
        match error {
            HelperError::Failed(error)
                if matches!(
                    error.kind(),
                    LocalSystemActionErrorKind::Timeout | LocalSystemActionErrorKind::NotAvailable
                ) =>
            {
                RoundTripFailure::Transient(format!(
                    "{direction} through {}: {}",
                    helper.program,
                    error.message()
                ))
            }
            other => RoundTripFailure::Definite(format!(
                "{direction} through {}: {other:?}",
                helper.program
            )),
        }
    }

    #[tokio::test]
    #[cfg_attr(
        not(target_os = "macos"),
        ignore = "Requires a disposable desktop clipboard; use the documented isolated native fixture"
    )]
    async fn native_clipboard_roundtrip() {
        #[cfg(target_os = "macos")]
        let pairs = {
            let board = format!(
                "org.openbitfun.clipboard-test.{}.{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            vec![(
                macos_helper(true, Some(&board)),
                macos_helper(false, Some(&board)),
            )]
        };
        #[cfg(target_os = "windows")]
        let pairs = vec![(windows_helper(true), windows_helper(false))];
        #[cfg(target_os = "linux")]
        let pairs = helpers(true)
            .unwrap()
            .into_iter()
            .zip(helpers(false).unwrap())
            .collect::<Vec<_>>();
        let mut last_failure = String::new();
        for attempt in 1..=NATIVE_ROUNDTRIP_PASSES {
            match run_native_roundtrip(&pairs).await {
                Ok(()) => return,
                Err(RoundTripFailure::Definite(reason)) => {
                    panic!("native clipboard round trip broke the clipboard contract: {reason}")
                }
                Err(RoundTripFailure::Transient(reason)) => {
                    last_failure = reason;
                    if attempt < NATIVE_ROUNDTRIP_PASSES {
                        tokio::time::sleep(NATIVE_ROUNDTRIP_BACKOFF).await;
                    }
                }
            }
        }
        panic!(
            "native clipboard round trip could not use the desktop clipboard in {NATIVE_ROUNDTRIP_PASSES} attempts: {last_failure}"
        );
    }
}
