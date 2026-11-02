//! Native Computer Use services for Windows, macOS and Linux.
//! Product hosts own runtime/configuration wiring; this crate owns OS resources.
mod computer_use;
pub use computer_use::{
    control_session, grants, permissions, share_grants, share_targets, shared_preview,
    NativeComputerUseHost,
};
static OCR_DEBUG_DIRECTORY: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Set the host-owned diagnostic destination before starting native work.
pub fn set_ocr_debug_directory(path: std::path::PathBuf) {
    let _ = OCR_DEBUG_DIRECTORY.set(path);
}

#[cfg(all(feature = "test-support", target_os = "macos"))]
pub use computer_use::test_support;
pub mod host_runtime;
