//! Service facade and core-owned product service assembly.
//!
//! Owner-crate implementations are re-exported here when they are safely
//! isolated. High-coupling runtime services stay here until their port
//! contracts and equivalence tests are explicit.

#[cfg(feature = "workspace-runtime")]
pub(crate) mod bootstrap; // Workspace persona bootstrap helpers
#[cfg(feature = "canvas-runtime")]
pub mod canvas; // Canvas service compatibility facade
pub mod config; // Config management
#[cfg(feature = "agent-runtime")]
pub(crate) mod coordination_persistence;
#[cfg(all(feature = "agent-runtime", feature = "scheduled-jobs"))]
pub mod cron; // Scheduled jobs
#[cfg(feature = "dispatch-store")]
pub mod dispatch; // Outbound dispatch observer index and target contracts
#[cfg(feature = "filesystem")]
pub mod filesystem; // FileSystem management
#[cfg(feature = "git")]
pub mod git; // Git service
pub mod i18n; // I18n service
#[cfg(feature = "agent-runtime")]
pub(crate) mod instruction_context; // Workspace instruction file prompt helpers
#[cfg(feature = "mcp-runtime")]
pub mod mcp; // MCP (Model Context Protocol) system
#[cfg(feature = "remote-connect")]
pub mod remote_connect; // Remote Connect (phone → desktop)
#[cfg(feature = "remote-workspace")]
pub mod remote_ssh; // Remote SSH (desktop → server)
#[cfg(all(not(feature = "remote-workspace"), feature = "agent-runtime"))]
#[path = "remote_ssh_compat.rs"]
pub mod remote_ssh;
#[cfg(feature = "review-platform")]
pub mod review_platform; // Pull request review platform adapters
#[cfg(feature = "process-runtime")]
pub mod runtime; // Managed runtime and capability management
#[cfg(feature = "workspace-search")]
pub mod search; // Workspace search via managed flashgrep daemon
#[cfg(feature = "local-storage")]
pub mod session; // Session persistence
#[cfg(feature = "agent-runtime")]
pub(crate) mod session_projection_format;
#[cfg(feature = "agent-runtime")]
pub mod session_projection_store; // Durable append-only log of the executing Turn
#[cfg(feature = "agent-runtime")]
pub mod session_usage; // Session runtime usage reports
#[cfg(feature = "agent-runtime")]
pub mod snapshot; // Snapshot-based change tracking
#[cfg(feature = "agent-runtime")]
pub mod token_usage; // Token usage tracking
#[cfg(feature = "web-tools")]
pub mod web_search; // Provider-neutral WebSearch runtime and local credentials
#[cfg(feature = "workspace-runtime")]
pub mod workspace; // Workspace management // Diff calculation and merge service
#[cfg(feature = "workspace-runtime")]
pub mod workspace_runtime; // Workspace runtime layout / migration / initialization
#[cfg(all(feature = "agent-runtime", feature = "git"))]
pub mod worktree; // Managed Git worktree lifecycle and session bindings

// Terminal is implemented in the workspace-level `terminal-core` crate.
// This re-export preserves the legacy `openbitfun_core::service::terminal` path.
#[cfg(feature = "terminal")]
pub use terminal_core as terminal;

// Re-export main components.
#[cfg(feature = "workspace-runtime")]
pub use bootstrap::reset_workspace_persona_files_to_default;
#[cfg(feature = "canvas-runtime")]
pub use canvas::{CanvasMemoryStore, CanvasService};
pub use config::{ConfigManager, ConfigProvider, ConfigService};
#[cfg(all(feature = "agent-runtime", feature = "scheduled-jobs"))]
pub use cron::{
    get_global_cron_service, set_global_cron_service, CronEventSubscriber, CronJobsChangedEvent,
    CronJobsChangedReason, CronService, CRON_JOBS_CHANGED_EVENT,
};
#[cfg(feature = "diff")]
pub use diff::{
    DiffConfig, DiffHunk, DiffLine, DiffLineType, DiffOptions, DiffResult, DiffService,
};
#[cfg(feature = "file-watch")]
pub use file_watch::{
    get_file_watch_status, get_global_file_watch_service, get_watched_paths,
    initialize_file_watch_service, retry_file_watch, start_file_watch, stop_file_watch,
    FileWatchEvent, FileWatchEventKind, FileWatchFailure, FileWatchFailureCode, FileWatchService,
    FileWatchStatus, FileWatcherConfig, FILE_WATCH_STATUS_CHANGED_EVENT,
};
#[cfg(feature = "filesystem")]
pub use filesystem::{DirectoryStats, FileSystemService, FileSystemServiceFactory};
#[cfg(feature = "git")]
pub use git::GitService;
#[cfg(feature = "i18n-runtime")]
pub use i18n::{get_global_i18n_service, I18nService};
pub use i18n::{I18nConfig, LocaleId, LocaleMetadata};
#[cfg(feature = "mcp-runtime")]
pub use mcp::MCPService;
#[cfg(feature = "diagnostics")]
pub use openbitfun_services_core::diagnostics;
#[cfg(feature = "diff")]
pub use openbitfun_services_core::diff;
#[cfg(feature = "process-runtime")]
pub use openbitfun_services_core::system;
#[cfg(feature = "file-watch")]
pub use openbitfun_services_integrations::file_watch;
#[cfg(feature = "review-platform")]
pub use review_platform::{
    ReviewAuthSource, ReviewAuthState, ReviewChecks, ReviewDecision, ReviewEvidenceCompleteness,
    ReviewFileStatus, ReviewItemState, ReviewPlatformAccount, ReviewPlatformAuthChallenge,
    ReviewPlatformAuthChallengeState, ReviewPlatformCapabilities, ReviewPlatformCiLog,
    ReviewPlatformCommit, ReviewPlatformError, ReviewPlatformFile, ReviewPlatformIssueComment,
    ReviewPlatformIssueEvidence, ReviewPlatformKind, ReviewPlatformPullRequest,
    ReviewPlatformPullRequestDetail, ReviewPlatformPullRequestFileDiff,
    ReviewPlatformPullRequestReviewTarget, ReviewPlatformRemote, ReviewPlatformRepositoryRef,
    ReviewPlatformService, ReviewPlatformThread, ReviewPlatformWorkspaceSnapshot,
};
#[cfg(feature = "process-runtime")]
pub use runtime::{ResolvedCommand, RuntimeCommandCapability, RuntimeManager, RuntimeSource};
#[cfg(feature = "workspace-search")]
pub use search::{
    get_global_workspace_search_service, set_global_workspace_search_service, ContentSearchRequest,
    ContentSearchResult, GlobSearchRequest, GlobSearchResult, IndexTaskHandle,
    WorkspaceIndexStatus, WorkspaceSearchAutoIndexDecision, WorkspaceSearchAutoIndexPriority,
    WorkspaceSearchAutoIndexStatus, WorkspaceSearchBackend, WorkspaceSearchContextLine,
    WorkspaceSearchDirtyFiles, WorkspaceSearchFileCount, WorkspaceSearchHit, WorkspaceSearchLine,
    WorkspaceSearchMatch, WorkspaceSearchMatchLocation, WorkspaceSearchOverlayStatus,
    WorkspaceSearchRepoPhase, WorkspaceSearchRepoStatus, WorkspaceSearchService,
    WorkspaceSearchTaskKind, WorkspaceSearchTaskPhase, WorkspaceSearchTaskState,
    WorkspaceSearchTaskStatus,
};
#[cfg(feature = "agent-runtime")]
pub use snapshot::SnapshotService;
#[cfg(feature = "process-runtime")]
pub use system::{
    check_command, check_commands, run_command, run_command_simple, CheckCommandResult,
    CommandOutput, SystemError,
};
#[cfg(feature = "agent-runtime")]
pub use token_usage::{
    ModelTokenStats, SessionTokenStats, TimeRange, TokenUsageQuery, TokenUsageRecord,
    TokenUsageService, TokenUsageSummary,
};
#[cfg(feature = "workspace-runtime")]
pub use workspace::{WorkspaceManager, WorkspaceProvider, WorkspaceService};
#[cfg(feature = "workspace-runtime")]
pub use workspace_runtime::{
    get_workspace_runtime_service_arc, try_get_workspace_runtime_service_arc,
    WorkspaceRuntimeContext, WorkspaceRuntimeEnsureResult, WorkspaceRuntimeService,
    WorkspaceRuntimeTarget,
};
#[cfg(all(feature = "agent-runtime", feature = "git"))]
pub use worktree::WorktreeService;

/// Session-scoped output projection shared by remote delivery surfaces.
#[cfg(feature = "remote-connect")]
pub mod output_files;
