//! File system service module
//!
//! Integrates file operations, file tree building, search, and related functionality.

pub mod factory;
#[cfg(feature = "remote-connect")]
pub mod html_preview;
pub mod listing;
#[cfg(feature = "ssh-remote")]
pub mod path_operations;
pub mod service;
pub mod types;
#[cfg(feature = "remote-connect")]
pub mod upload;

pub use factory::FileSystemServiceFactory;
pub use listing::{
    format_directory_listing, get_formatted_directory_listing, list_directory_entries,
    DirectoryListingEntry, FormattedDirectoryListing,
};
pub use service::FileSystemService;
pub use types::{DirectoryScanResult, DirectoryStats, FileSearchOptions, FileSystemConfig};

pub use openbitfun_services_core::filesystem::sort_directory_nodes;
