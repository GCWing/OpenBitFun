//! Clipboard File API

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Returns the first path in `paths` that belongs to a registered remote workspace.
async fn first_remote_path<'a>(
    workspace_id: Option<&str>,
    controller_local: bool,
    paths: impl Iterator<Item = &'a str>,
) -> Result<Option<String>, String> {
    for path in paths {
        if openbitfun_core::service::workspace::remote_io_for_legacy_or_id(
            workspace_id,
            controller_local,
            path.trim(),
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Ok(Some(path.to_string()));
        }
    }
    Ok(None)
}

#[derive(Debug, Serialize)]
pub struct ClipboardFilesResponse {
    pub files: Vec<String>,
    pub is_cut: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteFilesRequest {
    #[serde(default)]
    pub controller_local: bool,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub source_paths: Vec<String>,
    pub target_directory: String,
    pub is_cut: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteFilesResponse {
    pub success_count: usize,
    pub failed_files: Vec<FailedFile>,
    pub directory_count: usize,
}

#[derive(Debug, Serialize)]
pub struct FailedFile {
    pub path: String,
    pub error: String,
}

fn normalize_decoded_file_path(mut path: String) -> String {
    path = path.replace('\\', "/");

    while path.starts_with("//") {
        path = path[1..].to_string();
    }

    if let Some(rest) = path.strip_prefix('/') {
        if rest.len() >= 2 {
            let bytes = rest.as_bytes();
            if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                path = rest.to_string();
            }
        }
    }

    if path.len() >= 2 {
        let bytes = path.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            path = format!("{}{}", bytes[0].to_ascii_uppercase() as char, &path[1..]);
        }
    }

    path
}

fn decode_file_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    if !trimmed.starts_with("file://") {
        return None;
    }

    let rest = trimmed.strip_prefix("file://")?;
    let path_part = if rest.starts_with('/') {
        rest.to_string()
    } else if let Some(slash_idx) = rest.find('/') {
        let host = &rest[..slash_idx];
        if host.eq_ignore_ascii_case("localhost") {
            rest[slash_idx..].to_string()
        } else {
            return None;
        }
    } else {
        return None;
    };

    let decoded = urlencoding::decode(&path_part)
        .map(|value| value.into_owned())
        .unwrap_or(path_part);

    Some(normalize_decoded_file_path(decoded))
}

#[allow(dead_code)]
fn parse_uri_list(content: &str) -> Vec<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(decode_file_uri)
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn parse_clipboard_path_segments(content: &str) -> Vec<String> {
    content
        .split(['\n', '\r'])
        .flat_map(|segment| segment.split(','))
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(|segment| decode_file_uri(segment).unwrap_or_else(|| segment.to_string()))
        .collect()
}

#[cfg(target_os = "windows")]
mod windows_clipboard {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const CF_HDROP: u32 = 15;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(
            hdrop: *mut std::ffi::c_void,
            file_index: u32,
            file_name: *mut u16,
            buffer_size: u32,
        ) -> u32;
    }

    pub(super) fn get_clipboard_files() -> Result<Vec<String>, String> {
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP) == 0 {
                return Ok(Vec::new());
            }

            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            struct ClipboardGuard;
            impl Drop for ClipboardGuard {
                fn drop(&mut self) {
                    unsafe {
                        CloseClipboard();
                    }
                }
            }
            let _guard = ClipboardGuard;

            let hdrop = GetClipboardData(CF_HDROP);
            if hdrop.is_null() {
                return Ok(Vec::new());
            }

            let file_count = DragQueryFileW(hdrop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
            if file_count == 0 {
                return Ok(Vec::new());
            }

            let mut files = Vec::with_capacity(file_count as usize);

            for i in 0..file_count {
                let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }

                let mut buffer: Vec<u16> = vec![0; (len + 1) as usize];
                let actual_len = DragQueryFileW(hdrop, i, buffer.as_mut_ptr(), len + 1);

                if actual_len > 0 {
                    let path = OsString::from_wide(&buffer[..actual_len as usize]);
                    files.push(path.to_string_lossy().into_owned());
                }
            }

            Ok(files)
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_clipboard {
    use super::parse_clipboard_path_segments;
    use std::process::Command;

    pub(super) fn get_clipboard_files() -> Result<Vec<String>, String> {
        let output = Command::new("osascript")
            .args([
                "-e",
                r#"
                set theFiles to {}
                set linefeed to ASCII character 10
                set output to ""
                try
                    set theClip to the clipboard as «class furl»
                    set output to (POSIX path of theClip) & linefeed
                on error
                    try
                        set theClip to the clipboard as list
                        repeat with aFile in theClip
                            try
                                set output to output & (POSIX path of (aFile as alias)) & linefeed
                            end try
                        end repeat
                    end try
                end try
                return output
                "#,
            ])
            .output()
            .map_err(|e| format!("Failed to execute osascript: {}", e))?;

        if output.status.success() {
            let paths_str = String::from_utf8_lossy(&output.stdout);
            Ok(parse_clipboard_path_segments(&paths_str))
        } else {
            Ok(Vec::new())
        }
    }
}

/// Reads the controller clipboard through GTK.
///
/// The Desktop host is a GTK application on Linux, so `gtk::Clipboard` is the
/// clipboard connection the session already grants the focused window. Reading
/// it here removes the old hard dependency on `wl-clipboard` / `xclip`, which
/// stock Ubuntu GNOME does not install and which therefore made pasted files
/// and images fail out of the box. Both helpers must run on the GTK main
/// thread; `wait_for_*` pumps a nested main loop and returns empty when the
/// clipboard owner offers no such payload.
#[cfg(target_os = "linux")]
mod gtk_clipboard {
    use super::decode_file_uri;
    use std::time::Duration;

    /// GTK clipboard reads answer through the session clipboard owner. A host
    /// that never answers must not stall the paste path indefinitely.
    const READ_TIMEOUT: Duration = Duration::from_secs(5);

    fn on_main_thread<T, F>(app: &tauri::AppHandle, read: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(read());
        })
        .map_err(|error| format!("clipboard_main_thread_dispatch_failed: {error}"))?;
        receiver
            .recv_timeout(READ_TIMEOUT)
            .map_err(|error| format!("clipboard_read_timeout: {error}"))
    }

    pub(super) fn read_files(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
        on_main_thread(app, || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            clipboard
                .wait_for_uris()
                .iter()
                .filter_map(|uri| decode_file_uri(uri.as_str()))
                .collect()
        })
    }

    pub(super) fn read_image_png(app: &tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
        on_main_thread(app, || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            clipboard
                .wait_for_image()
                // Re-encoding through GTK keeps one payload format for the
                // webview regardless of the copied source format.
                .and_then(|pixbuf| pixbuf.save_to_bufferv("png", &[]).ok())
        })
    }
}

/// Fallback for hosts where the GTK read cannot run. Kept for X11 sessions and
/// for diagnosing a broken clipboard bridge, and reported as unavailable
/// instead of "clipboard is empty" when no reader tool exists.
#[cfg(target_os = "linux")]
mod linux_clipboard {
    use super::parse_uri_list;

    fn read_tool_output(program: &str, args: &[&str]) -> Result<Option<String>, String> {
        let output = openbitfun_core::util::process_manager::create_command(program)
            .args(args)
            .output()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("{program} is not installed")
                } else {
                    format!("failed to spawn {program}: {error}")
                }
            })?;

        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
            .filter(|content| !content.is_empty()))
    }

    pub(super) fn get_clipboard_files() -> Result<Vec<String>, String> {
        let mut tool_ran = false;
        let mut last_error = String::new();
        let probes: [(&str, &[&str]); 2] = [
            (
                "xclip",
                &["-selection", "clipboard", "-t", "text/uri-list", "-o"],
            ),
            ("wl-paste", &["-t", "text/uri-list"]),
        ];

        for (program, args) in probes {
            match read_tool_output(program, args) {
                Ok(Some(content)) => {
                    tool_ran = true;
                    let files = parse_uri_list(&content);
                    if !files.is_empty() {
                        return Ok(files);
                    }
                }
                Ok(None) => tool_ran = true,
                Err(error) => last_error = error,
            }
        }

        if tool_ran {
            return Ok(Vec::new());
        }
        Err(format!(
            "clipboard_files_unsupported: reading clipboard files needs wl-paste (Wayland) or \
             xclip (X11), but neither is available ({last_error}); install wl-clipboard or \
             xclip and retry"
        ))
    }
}

fn get_clipboard_files_internal(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows_clipboard::get_clipboard_files()
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos_clipboard::get_clipboard_files()
    }

    #[cfg(target_os = "linux")]
    {
        match gtk_clipboard::read_files(app) {
            Ok(files) => Ok(files),
            Err(error) => {
                log::warn!(
                    "GTK clipboard file read failed, falling back to clipboard tools: {}",
                    error
                );
                linux_clipboard::get_clipboard_files()
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("Reading clipboard files is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn get_clipboard_files(app: tauri::AppHandle) -> Result<ClipboardFilesResponse, String> {
    match get_clipboard_files_internal(&app) {
        Ok(files) => Ok(ClipboardFilesResponse {
            files,
            is_cut: false,
        }),
        Err(e) => {
            log::error!("Failed to read clipboard files: {}", e);
            Err(e)
        }
    }
}

/// Image bytes read from the system clipboard, base64-encoded for the webview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageResponse {
    pub base64: Option<String>,
    pub mime_type: Option<String>,
}

impl Default for ClipboardImageResponse {
    fn default() -> Self {
        Self {
            base64: None,
            mime_type: None,
        }
    }
}

/// Sniffs the image format from magic bytes so a tool that misreports success
/// cannot inject arbitrary text as an attachment payload.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        Some("image/jpeg")
    } else {
        None
    }
}

/// Outcome of a Linux clipboard-image probe.
enum ClipboardImageRead {
    /// An image payload, base64-encoded with its sniffed MIME type.
    #[cfg(target_os = "linux")]
    Image(String, String),
    /// A reader answered; the clipboard simply holds no image payload.
    Empty,
    /// The GTK bridge failed and neither `wl-paste` nor `xclip` could be
    /// spawned. Surfaced to the user instead of silently reporting "no image":
    /// a plain-text clipboard and a machine with no clipboard backend must stay
    /// distinguishable.
    #[cfg(target_os = "linux")]
    ToolsUnavailable(String),
}

/// Reads a clipboard image through the external clipboard tools.
///
/// Only used when the GTK clipboard bridge is unavailable; both reader tools
/// are optional packages that a stock desktop does not necessarily ship.
#[cfg(target_os = "linux")]
fn read_clipboard_image_with_tools() -> ClipboardImageRead {
    use base64::Engine as _;

    // `Ok(None)` = the tool ran and reported no such payload;
    // `Err` = the tool could not be run at all.
    let read_target = |program: &str, args: &[&str]| -> Result<Option<Vec<u8>>, String> {
        let output = openbitfun_core::util::process_manager::create_command(program)
            .args(args)
            .output()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("{program} is not installed")
                } else {
                    format!("failed to spawn {program}: {error}")
                }
            })?;
        Ok(output
            .status
            .success()
            .then_some(output.stdout)
            .filter(|stdout| !stdout.is_empty()))
    };

    let mut runnable_tools = 0usize;
    let mut last_tool_error = String::new();
    for mime in ["image/png", "image/jpeg"] {
        for (program, args) in [
            ("wl-paste", vec!["-t", mime]),
            ("xclip", vec!["-selection", "clipboard", "-t", mime, "-o"]),
        ] {
            match read_target(program, &args) {
                Ok(Some(bytes)) => {
                    if let Some(sniffed) = sniff_image_mime(&bytes) {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        return ClipboardImageRead::Image(encoded, sniffed.to_string());
                    }
                    runnable_tools += 1;
                }
                Ok(None) => runnable_tools += 1,
                Err(error) => last_tool_error = error,
            }
        }
    }

    if runnable_tools > 0 {
        return ClipboardImageRead::Empty;
    }
    ClipboardImageRead::ToolsUnavailable(format!(
        "clipboard_image_unsupported: reading a clipboard image needs wl-paste (Wayland) or \
         xclip (X11), but neither is available ({last_tool_error}); install wl-clipboard or \
         xclip and retry"
    ))
}

/// Reads a clipboard image on Linux.
///
/// WebKitGTK delivers paste events with empty `DataTransfer` items, so the
/// webview itself can never see a pasted image; the host owns the read. GTK is
/// the primary bridge because the Desktop host already runs a GTK main loop;
/// the external tools stay as a fallback for a broken GTK clipboard bridge.
#[cfg(target_os = "linux")]
fn get_clipboard_image_internal(app: &tauri::AppHandle) -> ClipboardImageRead {
    use base64::Engine as _;

    match gtk_clipboard::read_image_png(app) {
        Ok(Some(bytes)) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return ClipboardImageRead::Image(encoded, "image/png".to_string());
        }
        Ok(None) => return ClipboardImageRead::Empty,
        Err(error) => log::warn!(
            "GTK clipboard image read failed, falling back to clipboard tools: {}",
            error
        ),
    }

    read_clipboard_image_with_tools()
}

#[cfg(not(target_os = "linux"))]
fn get_clipboard_image_internal(_app: &tauri::AppHandle) -> ClipboardImageRead {
    // Other platforms deliver clipboard images to the page directly and never
    // need the host fallback.
    ClipboardImageRead::Empty
}

#[tauri::command]
pub async fn get_clipboard_image(app: tauri::AppHandle) -> Result<ClipboardImageResponse, String> {
    match get_clipboard_image_internal(&app) {
        #[cfg(target_os = "linux")]
        ClipboardImageRead::Image(base64, mime_type) => Ok(ClipboardImageResponse {
            base64: Some(base64),
            mime_type: Some(mime_type),
        }),
        ClipboardImageRead::Empty => Ok(ClipboardImageResponse::default()),
        #[cfg(target_os = "linux")]
        ClipboardImageRead::ToolsUnavailable(error) => {
            log::warn!("Clipboard image read unsupported: {}", error);
            Err(error)
        }
    }
}

/// Pastes clipboard files between controller-local paths.
///
/// The remote file provider exposes no copy primitive, so a remote workspace path is refused here
/// instead of being served by a controller-side copy that would silently target the wrong machine.
#[tauri::command]
pub async fn paste_files(request: PasteFilesRequest) -> Result<PasteFilesResponse, String> {
    if let Some(remote_path) = first_remote_path(
        request.workspace_id.as_deref(),
        request.controller_local,
        std::iter::once(request.target_directory.as_str())
            .chain(request.source_paths.iter().map(String::as_str)),
    )
    .await?
    {
        return Err(format!(
            "paste_files cannot copy remote workspace path '{}': the remote file provider has no copy primitive; local filesystem fallback was not attempted",
            remote_path
        ));
    }

    let target_dir = Path::new(&request.target_directory);

    if !target_dir.exists() {
        return Err(format!(
            "Target directory does not exist: {}",
            request.target_directory
        ));
    }

    if !target_dir.is_dir() {
        return Err(format!(
            "Target path is not a directory: {}",
            request.target_directory
        ));
    }

    let mut success_count = 0;
    let mut directory_count = 0;
    let mut failed_files = Vec::new();

    for source_path in &request.source_paths {
        let source = Path::new(source_path);

        if !source.exists() {
            failed_files.push(FailedFile {
                path: source_path.clone(),
                error: "Source file does not exist".to_string(),
            });
            continue;
        }

        let file_name = match source.file_name() {
            Some(name) => name,
            None => {
                failed_files.push(FailedFile {
                    path: source_path.clone(),
                    error: "Failed to get file name".to_string(),
                });
                continue;
            }
        };

        let target_path = target_dir.join(file_name);

        let final_target = if target_path.exists() {
            generate_unique_path(&target_path)
        } else {
            target_path
        };

        let is_dir = source.is_dir();
        let result = if is_dir {
            copy_directory_recursive(source, &final_target)
        } else {
            std::fs::copy(source, &final_target)
                .map(|_| ())
                .map_err(|e| e.to_string())
        };

        match result {
            Ok(_) => {
                success_count += 1;
                if is_dir {
                    directory_count += 1;
                }

                if request.is_cut {
                    if is_dir {
                        if let Err(e) = std::fs::remove_dir_all(source) {
                            log::warn!("Failed to remove source directory after cut: {}", e);
                        }
                    } else if let Err(e) = std::fs::remove_file(source) {
                        log::warn!("Failed to remove source file after cut: {}", e);
                    }
                }
            }
            Err(e) => {
                failed_files.push(FailedFile {
                    path: source_path.clone(),
                    error: e,
                });
            }
        }
    }

    Ok(PasteFilesResponse {
        success_count,
        failed_files,
        directory_count,
    })
}

fn generate_unique_path(path: &Path) -> std::path::PathBuf {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let extension = path.extension().and_then(|s| s.to_str());

    let mut counter = 1;
    loop {
        let new_name = if let Some(ext) = extension {
            format!("{} ({}).{}", stem, counter, ext)
        } else {
            format!("{} ({})", stem, counter)
        };

        let new_path = parent.join(&new_name);
        if !new_path.exists() {
            return new_path;
        }
        counter += 1;
    }
}

pub(crate) fn copy_directory_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in
        std::fs::read_dir(source).map_err(|e| format!("Failed to read directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            std::fs::copy(&source_path, &target_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        copy_directory_recursive, decode_file_uri, generate_unique_path,
        parse_clipboard_path_segments, parse_uri_list, sniff_image_mime,
    };
    use std::path::Path;

    #[test]
    fn sniff_image_mime_detects_png_header() {
        assert_eq!(
            sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
            Some("image/png")
        );
    }

    #[test]
    fn sniff_image_mime_detects_jpeg_header() {
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]),
            Some("image/jpeg")
        );
    }

    #[test]
    fn sniff_image_mime_rejects_non_image_payloads() {
        assert_eq!(sniff_image_mime(b"image/png but not really"), None);
        assert_eq!(sniff_image_mime(&[]), None);
    }

    #[test]
    fn decode_unix_file_uri() {
        assert_eq!(
            decode_file_uri("file:///tmp/example.txt").as_deref(),
            Some("/tmp/example.txt")
        );
    }

    #[test]
    fn decode_localhost_file_uri() {
        assert_eq!(
            decode_file_uri("file://localhost/home/user/example.txt").as_deref(),
            Some("/home/user/example.txt")
        );
    }

    #[test]
    fn decode_windows_file_uri() {
        assert_eq!(
            decode_file_uri("file:///C:/Users/dev/example.txt").as_deref(),
            Some("C:/Users/dev/example.txt")
        );
    }

    #[test]
    fn decode_windows_file_uri_lowercases_drive_letter() {
        assert_eq!(
            decode_file_uri("file:///c:/Users/dev/example.txt").as_deref(),
            Some("C:/Users/dev/example.txt")
        );
    }

    #[test]
    fn parse_clipboard_path_segments_handles_posix_paths() {
        assert_eq!(
            parse_clipboard_path_segments("/tmp/a.txt\n/tmp/b.txt"),
            vec!["/tmp/a.txt".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn parse_clipboard_path_segments_handles_comma_separated_paths() {
        assert_eq!(
            parse_clipboard_path_segments("/tmp/a.txt,/tmp/b.txt"),
            vec!["/tmp/a.txt".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn parse_clipboard_path_segments_decodes_file_uris() {
        assert_eq!(
            parse_clipboard_path_segments("file:///tmp/a.txt\r\nfile:///tmp/b.txt"),
            vec!["/tmp/a.txt".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn generate_unique_path_uses_current_dir_when_parent_missing() {
        let unique = generate_unique_path(Path::new("example.txt"));
        assert_eq!(
            unique.file_name(),
            Some(std::ffi::OsStr::new("example (1).txt"))
        );
    }

    #[test]
    fn parse_uri_list_ignores_comments_and_blank_lines() {
        let files =
            parse_uri_list("# comment\n\nfile:///tmp/a.txt\r\nfile://localhost/tmp/b.txt\n");
        assert_eq!(
            files,
            vec!["/tmp/a.txt".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn copy_directory_recursive_copies_nested_binary_files() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-directory-copy-test-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(source.join("nested")).expect("create source directory");
        std::fs::write(source.join("root.bin"), [0_u8, 255, 128]).expect("write root file");
        std::fs::write(source.join("nested").join("child.txt"), b"child")
            .expect("write nested file");

        copy_directory_recursive(&source, &target).expect("copy directory recursively");

        assert_eq!(
            std::fs::read(target.join("root.bin")).expect("read copied root file"),
            [0_u8, 255, 128]
        );
        assert_eq!(
            std::fs::read(target.join("nested").join("child.txt"))
                .expect("read copied nested file"),
            b"child"
        );

        std::fs::remove_dir_all(root).expect("remove test directory");
    }
}

#[cfg(test)]
mod remote_guard_tests {
    use super::{paste_files, PasteFilesRequest};
    use openbitfun_core::service::remote_ssh::workspace_state::init_remote_workspace_manager;

    const REMOTE_ROOT: &str = "/remote-audit-paste";
    const CONNECTION_ID: &str = "remote-audit-paste-connection";

    #[tokio::test]
    async fn paste_files_refuses_remote_target_and_leaves_controller_untouched() {
        init_remote_workspace_manager()
            .register_remote_workspace(
                REMOTE_ROOT.to_string(),
                CONNECTION_ID.to_string(),
                "remote-audit-paste".to_string(),
                "remote-audit-paste.invalid".to_string(),
            )
            .await;

        let source = std::env::temp_dir().join("openbitfun-remote-audit-paste-source.txt");
        std::fs::write(&source, b"local bytes").expect("write controller source");
        let sentinel = std::env::temp_dir().join("openbitfun-remote-audit-paste-source.txt.copy");
        let _ = std::fs::remove_file(&sentinel);

        let error = paste_files(PasteFilesRequest {
            controller_local: false,
            workspace_id: None,
            source_paths: vec![source.to_string_lossy().to_string()],
            target_directory: format!("{REMOTE_ROOT}/src"),
            is_cut: true,
        })
        .await
        .expect_err("remote paste target must be refused");

        assert!(error.starts_with("paste_files cannot copy remote workspace path"));
        assert!(error.contains("local filesystem fallback was not attempted"));
        assert!(
            source.exists(),
            "a refused cut must not delete the controller source"
        );
        assert!(!sentinel.exists());

        let _ = std::fs::remove_file(&source);
        init_remote_workspace_manager()
            .unregister_remote_workspace(CONNECTION_ID, REMOTE_ROOT)
            .await;
    }
}
