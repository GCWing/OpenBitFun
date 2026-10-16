pub mod layout;
mod lineage;
#[cfg(feature = "session-git")]
mod memory_workspace;
mod metadata;
mod metadata_store;
pub mod naming;
mod offline_import;
mod ordinal;
pub mod page;
pub mod types;
mod write_lock;

pub use layout::SessionStorageLayout;
pub use lineage::{
    apply_session_lineage, build_branched_session_metadata, build_session_lineage_snapshot,
    collect_hidden_subagent_cascade, format_branch_session_name, resolve_branch_session_lineage,
    BranchSessionLineage, BranchSessionMetadataFacts, SessionBranchBoundary, SessionBranchRequest,
    SessionBranchResult, SessionLineageSnapshot,
};
#[cfg(feature = "session-git")]
pub use memory_workspace::{
    ensure_memory_workspace_git_baseline, memory_workspace_diff, render_memory_workspace_diff_file,
    reset_memory_workspace_git_baseline, MemoryWorkspaceChange, MemoryWorkspaceChangeStatus,
    MemoryWorkspaceDiff, MemoryWorkspaceGitError,
};
pub use metadata::{
    apply_session_title_metadata, apply_session_unread_completion, build_session_index_snapshot,
    build_session_metadata, estimate_turn_message_count, merge_session_custom_metadata,
    normalized_session_relationship, refresh_session_metadata_from_turns,
    remove_session_index_entry, set_deep_review_cache, set_deep_review_run_manifest,
    set_review_target_evidence, set_session_relationship,
    try_refresh_session_metadata_for_saved_turn, unread_completion_target,
    upsert_session_index_entry, SessionMetadataBuildFacts,
};
pub use metadata_store::{SessionMetadataStore, SessionMetadataStoreError};
pub use offline_import::{
    OfflineSessionBundle, OfflineSessionImportError, OfflineSessionImportStore,
};
pub use openbitfun_core_types::{SessionKind, SESSION_PROVIDER_ACP, SESSION_PROVIDER_METADATA_KEY};
pub use page::{build_session_metadata_page, empty_session_metadata_page, SessionMetadataPage};
pub use types::*;
pub use write_lock::{SessionWriteLock, SessionWriteLockError};
