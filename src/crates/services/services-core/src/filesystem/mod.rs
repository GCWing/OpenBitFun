//! Platform-neutral filesystem owner.
//!
//! This module owns local file operations, directory listings, file-tree
//! construction, and search primitives. Product/runtime adapters in
//! `openbitfun-core` may still layer remote-workspace routing or legacy error
//! mapping on top of these primitives.

mod content_preview;
mod error;
mod factory;
mod listing;
mod operations;
mod service;
mod sorting;
mod tree;
mod types;

pub use content_preview::{
    build_content_match_preview, compile_content_search_regex, ContentMatchPreviewBuilder,
};
pub use error::{FileSystemError, FileSystemResult};
pub use factory::FileSystemServiceFactory;
pub use listing::{
    format_directory_listing, get_formatted_directory_listing, list_directory_entries,
    DirectoryListingEntry, FormattedDirectoryListing,
};
pub use operations::{
    normalize_text_for_editor_disk_sync, FileInfo, FileOperationOptions, FileOperationService,
    FileReadResult, FileWriteResult,
};
pub use service::FileSystemService;
pub use sorting::sort_directory_nodes;
pub use tree::{
    BatchedFileSearchProgressSink, FileContentSearchOptions, FileNameSearchOptions,
    FileSearchOutcome, FileSearchProgressSink, FileSearchResult, FileSearchResultGroup,
    FileTreeNode, FileTreeOptions, FileTreeService, FileTreeStatistics, SearchMatchType,
    CONTENT_SEARCH_BINARY_SUFFIXES, CONTENT_SEARCH_MAX_FILE_BYTES,
    CONTENT_SEARCH_SKIPPED_DIRECTORIES, CONTENT_SEARCH_SKIPPED_FILE_NAMES,
};
pub use types::{DirectoryScanResult, DirectoryStats, FileSearchOptions, FileSystemConfig};
