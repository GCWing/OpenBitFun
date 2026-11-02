//! Bind preview reads to the owning host's persisted workspace and existing filesystem provider.

use openbitfun_product_domains::html_preview::{
    HtmlPreviewError, HtmlPreviewResourceReply, HtmlPreviewResourceRequest,
};
use openbitfun_services_integrations::remote_connect::html_preview::HtmlPreviewSource;

pub async fn resolve_html_preview_source(
    workspace_id: &str,
    file_path: &str,
) -> Result<HtmlPreviewSource, HtmlPreviewError> {
    if workspace_id.trim().is_empty() {
        return Err(HtmlPreviewError::unavailable(
            "HTML preview workspace ID is required",
        ));
    }
    let (target, provider) = crate::service_agent_runtime::CoreServiceAgentRuntime::scoped_remote_file_target_with_identity(
        file_path, None, Some(workspace_id), None, None,
    ).await.map_err(HtmlPreviewError::unavailable)?;
    HtmlPreviewSource::new(target, &format!("{workspace_id}:{provider}")).await
}

pub async fn html_preview_read_resource(
    request: HtmlPreviewResourceRequest,
) -> HtmlPreviewResourceReply {
    let result = async {
        let source = resolve_html_preview_source(&request.workspace_id, &request.file_path).await?;
        source.read(&request).await
    }
    .await;
    result.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use openbitfun_product_domains::html_preview::HtmlPreviewErrorCode;

    #[tokio::test]
    async fn html_preview_uses_registered_workspace_and_shared_local_resource_rules() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("site/dist/assets")).unwrap();
        std::fs::write(root.join("site/dist/index.html"), b"page").unwrap();
        std::fs::write(root.join("site/dist/assets/app.js"), b"site-script").unwrap();
        std::fs::write(root.join("site/shared.css"), b"shared-style").unwrap();
        let record =
            crate::service::workspace::legacy_compat::register_local_fixture(root, None).await;
        let mut request = HtmlPreviewResourceRequest {
            workspace_id: record.id,
            file_path: root
                .join("site/dist/index.html")
                .to_string_lossy()
                .into_owned(),
            resource_path: Some("assets/app.js".into()),
            metadata_only: false,
            offset: 0,
            expected_source: None,
            expected_revision: None,
        };
        let resource = html_preview_read_resource(request.clone())
            .await
            .into_result()
            .unwrap();
        assert_eq!(
            BASE64.decode(resource.content_base64).unwrap(),
            b"site-script"
        );
        assert_eq!(resource.mime_type, "text/javascript; charset=utf-8");
        request.resource_path = Some("site/shared.css".into());
        assert_eq!(
            BASE64
                .decode(
                    html_preview_read_resource(request.clone())
                        .await
                        .into_result()
                        .unwrap()
                        .content_base64
                )
                .unwrap(),
            b"shared-style"
        );
        request.resource_path = Some("../secret".into());
        assert_eq!(
            html_preview_read_resource(request.clone())
                .await
                .into_result()
                .unwrap_err()
                .code,
            HtmlPreviewErrorCode::InvalidPath
        );
        request.workspace_id = "unknown-workspace".into();
        request.resource_path = None;
        assert!(
            html_preview_read_resource(request)
                .await
                .into_result()
                .is_err(),
            "Existing file paths must not bypass workspace identity"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn html_preview_rejects_local_symlinks_outside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("index.html"), b"page").unwrap();
        std::fs::write(external.path().join("secret.js"), b"secret").unwrap();
        std::os::unix::fs::symlink(external.path(), workspace.path().join("assets")).unwrap();
        let record = crate::service::workspace::legacy_compat::register_local_fixture(
            workspace.path(),
            None,
        )
        .await;
        let request = HtmlPreviewResourceRequest {
            workspace_id: record.id,
            file_path: workspace
                .path()
                .join("index.html")
                .to_string_lossy()
                .into_owned(),
            resource_path: Some("assets/secret.js".into()),
            metadata_only: false,
            offset: 0,
            expected_source: None,
            expected_revision: None,
        };
        assert_eq!(
            html_preview_read_resource(request)
                .await
                .into_result()
                .unwrap_err()
                .code,
            HtmlPreviewErrorCode::Forbidden
        );
    }
}
