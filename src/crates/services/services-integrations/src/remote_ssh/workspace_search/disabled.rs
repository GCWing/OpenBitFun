//! Disabled remote workspace-search surface for lightweight feature builds.

use crate::remote_ssh::RemoteWorkspaceEntry;
use crate::workspace_search::{
    ContentSearchRequest, ContentSearchResult, GlobSearchRequest, GlobSearchResult,
    IndexTaskHandle, WorkspaceIndexStatus,
};

fn unsupported() -> String {
    "Remote SSH search is disabled; enable the `ssh-remote` feature".to_string()
}

#[derive(Clone)]
pub struct RemoteWorkspaceSearchService;

impl RemoteWorkspaceSearchService {
    pub async fn get_index_status(&self, _root_path: &str) -> Result<WorkspaceIndexStatus, String> {
        Err(unsupported())
    }

    pub async fn build_index(&self, _root_path: &str) -> Result<IndexTaskHandle, String> {
        Err(unsupported())
    }

    pub async fn rebuild_index(&self, _root_path: &str) -> Result<IndexTaskHandle, String> {
        Err(unsupported())
    }

    pub async fn search_content(
        &self,
        _request: ContentSearchRequest,
    ) -> Result<ContentSearchResult, String> {
        Err(unsupported())
    }

    pub async fn glob(&self, _request: GlobSearchRequest) -> Result<GlobSearchResult, String> {
        Err(unsupported())
    }

    pub async fn resolve_remote_workspace_entry(
        &self,
        _repo_root: &str,
    ) -> Result<RemoteWorkspaceEntry, String> {
        Err(unsupported())
    }
}
