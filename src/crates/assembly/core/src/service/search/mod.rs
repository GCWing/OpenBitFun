#[cfg(feature = "ssh-remote")]
mod remote;
#[cfg(not(feature = "ssh-remote"))]
mod remote_disabled;
pub mod service;

pub use openbitfun_services_integrations::workspace_search::{
    ContentSearchOutputMode, ContentSearchRequest, ContentSearchResult, GlobSearchRequest,
    GlobSearchResult, IndexTaskHandle, WorkspaceIndexStatus, WorkspaceSearchAutoIndexDecision,
    WorkspaceSearchAutoIndexPriority, WorkspaceSearchAutoIndexStatus, WorkspaceSearchBackend,
    WorkspaceSearchContextLine, WorkspaceSearchDirtyFiles, WorkspaceSearchFileCount,
    WorkspaceSearchHit, WorkspaceSearchLine, WorkspaceSearchMatch, WorkspaceSearchMatchLocation,
    WorkspaceSearchOverlayStatus, WorkspaceSearchRepoPhase, WorkspaceSearchRepoStatus,
    WorkspaceSearchTaskKind, WorkspaceSearchTaskPhase, WorkspaceSearchTaskState,
    WorkspaceSearchTaskStatus,
};
#[cfg(feature = "ssh-remote")]
pub use remote::{remote_workspace_search_service_for_workspace, RemoteWorkspaceSearchService};
#[cfg(not(feature = "ssh-remote"))]
pub use remote_disabled::{
    remote_workspace_search_service_for_workspace, RemoteWorkspaceSearchService,
};
pub use service::{
    get_global_workspace_search_service, resolve_workspace_search_daemon_program_path,
    set_global_workspace_search_service, workspace_search_daemon_available,
    workspace_search_daemon_binary_name, workspace_search_daemon_binary_names,
    workspace_search_daemon_missing_hint, workspace_search_feature_enabled,
    workspace_search_runtime_available, WorkspaceSearchService,
};
