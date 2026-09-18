//! Workspace service module
//!
//! Full workspace management system: open, manage, scan, statistics, etc.

#[cfg(feature = "workspace-runtime")]
pub mod factory;
#[cfg(feature = "workspace-watch")]
pub mod identity_watch;
#[cfg(feature = "workspace-runtime")]
pub(crate) mod legacy_compat;
#[cfg(feature = "workspace-runtime")]
pub use legacy_compat::remote_io_for_legacy_or_id;
#[cfg(feature = "workspace-runtime")]
pub mod manager;
pub(crate) mod persistence;
#[cfg(feature = "workspace-runtime")]
pub mod provider;
#[cfg(feature = "workspace-runtime")]
pub mod service;
pub(crate) mod types;
#[cfg(feature = "git")]
pub mod worktree_topology;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(feature = "workspace-runtime")]
pub enum WorktreeTopologyFreshness {
    Cached,
    ForceRefresh,
}

// Re-export main components
#[cfg(feature = "workspace-runtime")]
pub use factory::WorkspaceFactory;
#[cfg(feature = "workspace-watch")]
pub use identity_watch::WorkspaceIdentityWatchService;
#[cfg(feature = "workspace-runtime")]
pub use manager::{
    GitInfo, PrimaryAssistantKey, RelatedPath, ScanOptions, WorkspaceIdentity, WorkspaceInfo,
    WorkspaceInfoRuntimeExt, WorkspaceKind, WorkspaceManager, WorkspaceManagerConfig,
    WorkspaceManagerStatistics, WorkspaceOpenOptions, WorkspaceStatistics, WorkspaceStatus,
    WorkspaceSummary, WorkspaceType, WorkspaceWorktreeInfo,
};
#[cfg(feature = "workspace-runtime")]
pub use provider::{WorkspaceCleanupResult, WorkspaceProvider, WorkspaceSystemSummary};
#[cfg(feature = "workspace-runtime")]
pub use service::{
    get_global_workspace_service, set_global_workspace_service, BatchImportResult,
    BatchRemoveResult, WorkspaceActivityMode, WorkspaceCreateOptions, WorkspaceExport,
    WorkspaceHealthStatus, WorkspaceIdentityChangedEvent, WorkspaceImportResult,
    WorkspaceInfoUpdates, WorkspaceQuickSummary, WorkspaceService,
};
#[cfg(feature = "git")]
pub use worktree_topology::{global_worktree_topology_service, WorktreeTopologyService};
