#![cfg(all(
    feature = "workspace-search",
    feature = "remote-ssh",
    not(feature = "remote-ssh-concrete")
))]

use openbitfun_services_integrations::remote_ssh::workspace_search::disabled::RemoteWorkspaceSearchService;

fn assert_disabled_error(error: String) {
    assert!(
        error.contains("Remote SSH search is disabled"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn disabled_remote_workspace_search_returns_explicit_unsupported_errors() {
    let service = RemoteWorkspaceSearchService;

    let status_error = service.get_index_status("/remote/repo").await.unwrap_err();
    assert_disabled_error(status_error);

    let resolve_error = service
        .resolve_remote_workspace_entry("/remote/repo")
        .await
        .unwrap_err();
    assert_disabled_error(resolve_error);

    assert_disabled_error(service.build_index("/remote/repo").await.unwrap_err());
    assert_disabled_error(service.rebuild_index("/remote/repo").await.unwrap_err());
}
