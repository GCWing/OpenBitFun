pub mod glob_search;
pub mod grep_search;
mod workspace_grep_prefilter;
pub(crate) mod workspace_ignore;
pub(crate) mod workspace_walk;

pub use glob_search::{
    build_remote_rg_command, collect_remote_glob_matches, collect_remote_glob_result,
    derive_walk_root, execute_local_glob, extract_glob_base_directory, limit_paths, normalize_path,
    LocalGlobRequest, LocalGlobResult,
};
pub use grep_search::{
    apply_offset_and_limit, content_search_candidate_literal, grep_search, grep_search_workspace,
    relativize_result_text, GrepOptions, OutputMode, ProgressCallback, SearchCancellation,
    WorkspaceGrepLineMatch,
};
