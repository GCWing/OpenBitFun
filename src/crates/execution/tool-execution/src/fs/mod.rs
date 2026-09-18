pub mod backend;
pub mod delete_path;
pub mod document;
pub mod edit_file;
pub mod listing;
pub mod read_file;
pub mod write_file;

pub use backend::{FileSystem, LocalFileSystem};
pub use delete_path::{
    build_remote_delete_command, delete_local_path, delete_path_success_message,
    inspect_local_delete_target, DeleteLocalPathOutcome, DeleteLocalPathRequest, LocalDeleteTarget,
};
pub use edit_file::{
    edit_local_file, edit_local_file_with_content, edit_success_message, EditLocalFileOutcome,
    EditLocalFileRequest, EditLocalFileWithContentRequest,
};
pub use write_file::{
    write_file_success_outcome, write_local_file, write_same_content_outcome,
    WriteLocalFileOutcome, WriteLocalFileRequest, WriteLocalFileStatus,
};

/// Returns whether a regular filesystem entry has more than one hard link.
/// Callers that use paths as a security boundary can reject such aliases.
pub fn path_has_multiple_hard_links(path: &std::path::Path) -> std::io::Result<bool> {
    let metadata = std::fs::metadata(path)?;
    if metadata.is_dir() {
        return Ok(false);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(metadata.nlink() > 1)
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        let file = std::fs::File::open(path)?;
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
        }
        return Ok(information.nNumberOfLinks > 1);
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "hard-link identity checks are unavailable on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn document_path_recognition_is_available_without_conversion_support() {
        assert!(super::document::is_supported_document_path("report.DOCX"));
        assert!(super::document::is_supported_document_path("paper.pdf"));
        assert!(!super::document::is_supported_document_path("src/lib.rs"));
    }
}
