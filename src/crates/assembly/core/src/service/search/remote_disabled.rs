//! Disabled remote-search facade for builds without concrete SSH support.

use openbitfun_services_integrations::workspace_search::{
    ContentSearchRequest, ContentSearchResult, GlobSearchRequest, GlobSearchResult,
};

fn unsupported() -> String {
    "Remote SSH search is disabled; enable the `ssh-remote` feature".to_string()
}

#[derive(Clone)]
pub struct RemoteWorkspaceSearchService;

impl RemoteWorkspaceSearchService {
    pub async fn search_content(
        &self,
        _request: ContentSearchRequest,
    ) -> Result<ContentSearchResult, String> {
        Err(unsupported())
    }

    pub async fn glob(&self, _request: GlobSearchRequest) -> Result<GlobSearchResult, String> {
        Err(unsupported())
    }
}

pub async fn remote_workspace_search_service_for_workspace(
    _workspace_id: &str,
) -> Result<RemoteWorkspaceSearchService, String> {
    Err(unsupported())
}
