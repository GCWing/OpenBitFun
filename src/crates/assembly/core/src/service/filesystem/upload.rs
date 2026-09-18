//! Product assembly for the runtime-owned workspace upload service.
use openbitfun_services_core::workspace_transfer::{
    TransferScope, UploadStatus, UploadTarget, UploadTransfers, MAX_UPLOAD_CHUNK,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUploadRequest {
    pub action: String,
    pub transfer_id: String,
    pub path: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Owning workspace ID; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Legacy explicit file workspace for pre-ID controllers.
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub expected_hash: Option<String>,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub content_base64: Option<String>,
}
fn transfers() -> &'static UploadTransfers {
    static TRANSFERS: OnceLock<UploadTransfers> = OnceLock::new();
    TRANSFERS.get_or_init(Default::default)
}

pub async fn retire_account_uploads(account_id: &str) -> Result<(), String> {
    transfers()
        .retire_account(account_id)
        .await
        .map_err(|error| error.to_string())
}

pub async fn workspace_file_upload(
    account_id: String,
    request: WorkspaceUploadRequest,
) -> Result<UploadStatus, String> {
    use crate::service_agent_runtime::CoreServiceAgentRuntime;
    use base64::Engine;
    let (target, target_id) = CoreServiceAgentRuntime::scoped_remote_file_target_with_identity(
        &request.path,
        request.session_id.as_deref(),
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let scope = TransferScope {
        account_id,
        target_id,
        workspace_root: target.root,
    };
    let id = request.transfer_id;
    let result = match request.action.as_str() {
        "begin" => {
            transfers()
                .begin(
                    id,
                    scope,
                    UploadTarget {
                        fs: target.fs,
                        path: target.path,
                        remote: target.remote,
                    },
                    request.total_bytes.ok_or("Upload totalBytes is required")?,
                    request.sha256.ok_or("Upload sha256 is required")?,
                    request.expected_hash,
                )
                .await
        }
        "append" => {
            let encoded = request
                .content_base64
                .ok_or("Upload contentBase64 is required")?;
            if encoded.len() > (MAX_UPLOAD_CHUNK + 2) / 3 * 4 {
                return Err("Upload chunk exceeds the bounded transfer size".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid upload base64")?;
            transfers()
                .append(
                    &scope,
                    &id,
                    request.offset.ok_or("Upload offset is required")?,
                    &bytes,
                )
                .await
        }
        "status" => transfers().status(&scope, &id).await,
        "finish" => transfers().finish(&scope, &id).await,
        "cancel" => {
            let status = transfers()
                .status(&scope, &id)
                .await
                .map_err(|error| error.to_string())?;
            transfers()
                .cancel(&scope, &id)
                .await
                .map_err(|error| error.to_string())?;
            Ok(status)
        }
        _ => return Err("Unknown workspace upload action".into()),
    };
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn upload_requires_explicit_workspace_without_session() {
        let request = serde_json::from_value(
            json!({"action":"begin","transferId":"unused","path":"/tmp/file"}),
        )
        .unwrap();
        let error = workspace_file_upload("scope-test".into(), request)
            .await
            .unwrap_err();
        assert!(error.contains("workspace identity is required"), "{error}");
    }

    #[tokio::test]
    async fn upload_stays_bound_to_explicit_local_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        // Explicit upload scopes are registered workspace records; the path
        // is only the IO projection of the record the request names.
        let first_record =
            crate::service::workspace::legacy_compat::register_local_fixture(&first, None).await;
        let second_record =
            crate::service::workspace::legacy_compat::register_local_fixture(&second, None).await;
        let transfer = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let account = format!("scope-{}", uuid::Uuid::new_v4());
        let make = |action: &str, workspace: &crate::service::workspace::WorkspaceInfo| {
            let root = workspace.root_path.as_path();
            json!({
                "action":action,"transferId":transfer,"path":root.join("new.txt"),
                "workspaceId":workspace.id,"workspacePath":root,
                "remoteConnectionId":"","totalBytes":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                "expectedHash":"","offset":0,"contentBase64":"aGVsbG8="
            })
        };
        workspace_file_upload(
            account.clone(),
            serde_json::from_value(make("begin", &second_record)).unwrap(),
        )
        .await
        .unwrap();
        assert!(workspace_file_upload(
            account.clone(),
            serde_json::from_value(make("append", &first_record)).unwrap()
        )
        .await
        .is_err());
        workspace_file_upload(
            account.clone(),
            serde_json::from_value(make("append", &second_record)).unwrap(),
        )
        .await
        .unwrap();
        workspace_file_upload(
            account,
            serde_json::from_value(make("finish", &second_record)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(second_record.root_path.join("new.txt")).unwrap(),
            b"hello"
        );
        assert!(!first_record.root_path.join("new.txt").exists());
    }
}
