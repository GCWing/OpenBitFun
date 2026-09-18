//! Temporary upgrade adapter for pre-ID workspace references (including 1.0.0).
//!
//! Paths are NOT workspace keys. Only legacy persisted data and old protocol
//! ingress may call this adapter. Normal runtime code must use `require_workspace`.
//! Successful conversion must retain the record ID; never store the input path
//! as its identity. Ambiguous and missing references must not select another
//! workspace, create a local fallback, or delete user data.
//!
//! Sunset: remove after supported persisted data has migrated and all supported
//! peers negotiate ID-based workspace references. Do not add new path callers.
use super::{WorkspaceInfo, WorkspaceKind, WorkspaceService};
use crate::{OpenBitFunError, OpenBitFunResult};

pub(crate) fn resolve_legacy_workspace_reference(
    records: &[WorkspaceInfo],
    workspace_id: Option<&str>,
    path: &str,
    connection_id: Option<&str>,
    ssh_host: Option<&str>,
) -> OpenBitFunResult<Option<WorkspaceInfo>> {
    let text = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let connection_id = text(connection_id);
    let ssh_host = text(ssh_host);
    let path_matches = |workspace: &&WorkspaceInfo| {
        if workspace.workspace_kind == WorkspaceKind::Remote {
            openbitfun_services_core::workspace_identity::normalize_remote_workspace_path(
                &workspace.root_path.to_string_lossy(),
            ) == openbitfun_services_core::workspace_identity::normalize_remote_workspace_path(path)
        } else {
            let local = std::path::Path::new(path);
            workspace.root_path == local
                || dunce::canonicalize(local).is_ok_and(|root| root == workspace.root_path)
        }
    };
    if let Some(id) = workspace_id {
        // An explicit ID is authoritative. A stale or unknown ID must never
        // fall through to a similarly named folder on this or another host.
        return records
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .map(Some)
            .ok_or_else(|| {
                OpenBitFunError::service(format!("Workspace ID is unavailable on this host: {id}"))
            });
    }
    let mut candidates: Vec<_> = records.iter().filter(path_matches).collect();
    if let Some(id) = connection_id.as_deref() {
        candidates.retain(|workspace| {
            workspace.workspace_kind == WorkspaceKind::Remote
                && workspace.remote_ssh_connection_id() == Some(id)
        });
    }
    if let Some(host) = ssh_host
        .as_deref()
        .filter(|host| *host != "localhost" || connection_id.is_some())
    {
        candidates.retain(|workspace| {
            workspace.workspace_kind == WorkspaceKind::Remote
                && workspace.metadata.get("sshHost").and_then(|v| v.as_str()) == Some(host)
        });
    }
    match candidates.as_slice() {
        [] => Ok(None),
        [record] => Ok(Some((*record).clone())),
        _ => Err(OpenBitFunError::service(
            "Workspace path is ambiguous; select a workspace by its ID or saved SSH connection",
        )),
    }
}

impl WorkspaceService {
    pub async fn resolve_legacy_workspace_reference(
        &self,
        workspace_id: Option<&str>,
        path: &str,
        connection_id: Option<&str>,
        ssh_host: Option<&str>,
    ) -> OpenBitFunResult<Option<WorkspaceInfo>> {
        resolve_legacy_workspace_reference(
            &self.list_workspace_infos().await,
            workspace_id,
            path,
            connection_id,
            ssh_host,
        )
    }
}

// The following adapter is exclusively for old path-only open requests. It is
// part of the same sunset boundary as resolve_legacy_workspace_reference.
use std::path::PathBuf;

impl WorkspaceService {
    /// Upgrade-only open adapter for pre-ID requests, including 1.0.0.
    /// New callers must select by ID or explicitly create a local/remote workspace.
    pub async fn upgrade_legacy_workspace_open(
        &self,
        path: PathBuf,
        preferred_connection_id: Option<&str>,
        preferred_ssh_host: Option<&str>,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let path_str = path.to_string_lossy().to_string();
        let known = self
            .resolve_legacy_workspace_open(&path_str, preferred_connection_id, preferred_ssh_host)
            .await?;
        self.finish_legacy_workspace_open(path, known).await
    }

    pub(crate) async fn finish_legacy_workspace_open(
        &self,
        path: PathBuf,
        known_remote: Option<WorkspaceInfo>,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let path_str = path.to_string_lossy().to_string();
        if let Some(known) = known_remote {
            return if known.workspace_kind == WorkspaceKind::Remote {
                self.open_known_remote_workspace(&known).await
            } else {
                self.open_workspace_by_id(&known.id).await
            };
        }
        match self.open_workspace(path).await {
            Ok(info) => Ok(info),
            Err(error) => {
                let message = error.to_string();
                if message.contains("Workspace path does not exist") {
                    Err(OpenBitFunError::service(format!(
                        "Workspace path does not exist locally and is not a known remote SSH \
                         workspace: {path_str}. Open it once from the desktop SSH remote UI so \
                         OpenBitFun can remember the connection, then try again."
                    )))
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Resolve persisted identity or verify a new path against an existing SSH
    /// connection. Caller input alone never authorizes a remote runtime scope.
    pub(crate) async fn resolve_legacy_workspace_open(
        &self,
        path: &str,
        connection_id: Option<&str>,
        ssh_host: Option<&str>,
    ) -> OpenBitFunResult<Option<WorkspaceInfo>> {
        let known = self
            .resolve_legacy_workspace_reference(None, path, connection_id, ssh_host)
            .await?;
        if let Some(record) = known.as_ref() {
            return if record.workspace_kind == WorkspaceKind::Remote {
                if record.remote_ssh_connection_id().is_none() {
                    Err(OpenBitFunError::service(
                        "Remote workspace record is missing its saved SSH connection ID",
                    ))
                } else {
                    Ok(known)
                }
            } else {
                Ok(known)
            };
        }
        let connection_id = connection_id.map(str::trim).filter(|id| !id.is_empty());
        let ssh_host = ssh_host.map(str::trim).filter(|id| !id.is_empty());
        if connection_id.is_none() && ssh_host.is_none() {
            return Ok(known);
        }
        let connection_id = connection_id.ok_or_else(|| {
            OpenBitFunError::service(
                "Opening a remote workspace requires its saved SSH connection ID",
            )
        })?;
        self.prepare_remote_workspace(path, connection_id, ssh_host)
            .await
            .map(Some)
    }
}

#[cfg(feature = "agent-runtime")]
impl crate::agentic::coordination::ConversationCoordinator {
    /// Gates workspace attachment before opening it, then prepares local
    /// Snapshot ownership without treating remote workspaces as local paths.
    pub async fn upgrade_legacy_workspace_with_runtime_ownership(
        &self,
        workspace_service: &WorkspaceService,
        path: PathBuf,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
        snapshot_log_context: &str,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let known_remote = workspace_service
            .resolve_legacy_workspace_open(
                &path.to_string_lossy(),
                remote_connection_id,
                remote_ssh_host,
            )
            .await?;
        if known_remote.is_none() && !path.exists() {
            return Err(OpenBitFunError::service(format!(
                "Workspace path does not exist locally and is not a known remote SSH workspace: {}. Open it once from the desktop SSH remote UI so OpenBitFun can remember the connection, then try again.",
                path.display()
            )));
        }
        // Caller-provided remote facts only select a known workspace. They are
        // not authority to bypass the local Runtime ownership lease.
        let resolved_connection_id = known_remote
            .as_ref()
            .filter(|workspace| workspace.workspace_kind == WorkspaceKind::Remote)
            .and_then(WorkspaceInfo::remote_ssh_connection_id)
            .map(ToOwned::to_owned);
        let resolved_ssh_host = known_remote
            .as_ref()
            .filter(|workspace| workspace.workspace_kind == WorkspaceKind::Remote)
            .and_then(|workspace| {
                workspace
                    .metadata
                    .get("sshHost")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned)
            });
        if let Some(connection_id) = resolved_connection_id.as_deref() {
            self.ensure_verified_remote_workspace_runtime_ownership(
                &path,
                connection_id,
                resolved_ssh_host.as_deref(),
            )?;
        } else {
            self.ensure_runtime_ownership(&path, None, None)?;
        }
        let info = workspace_service
            .finish_legacy_workspace_open(path, known_remote)
            .await?;
        if info.workspace_kind != WorkspaceKind::Remote {
            if let Err(error) =
                crate::service::snapshot::initialize_snapshot_manager_for_workspace(&info.id, None)
                    .await
            {
                log::error!(
                    "Failed to initialize snapshot after {}: {}",
                    snapshot_log_context,
                    error
                );
            }
        }
        Ok(info)
    }
}

#[cfg(test)]
async fn fixture_workspace_service() -> std::sync::Arc<WorkspaceService> {
    use std::sync::Arc;
    static SERVICE: tokio::sync::OnceCell<(tempfile::TempDir, Arc<WorkspaceService>)> =
        tokio::sync::OnceCell::const_new();
    let (_, service) = SERVICE
        .get_or_init(|| async {
            let root = tempfile::tempdir().unwrap();
            let paths = Arc::new(
                crate::infrastructure::PathManager::with_user_root_for_tests(
                    root.path().join("user"),
                ),
            );
            let service = Arc::new(WorkspaceService::new_for_test_path_manager(paths).await);
            super::set_global_workspace_service(service.clone());
            (root, service)
        })
        .await;
    service.clone()
}

#[cfg(test)]
pub(crate) async fn register_local_fixture(
    path: &std::path::Path,
    project: Option<&std::path::Path>,
) -> WorkspaceInfo {
    use super::{
        WorkspaceExport, WorkspaceInfoRuntimeExt, WorkspaceOpenOptions, WorkspaceWorktreeInfo,
    };
    let service = fixture_workspace_service().await;
    let mut record =
        WorkspaceInfo::new_without_worktree(path.to_path_buf(), WorkspaceOpenOptions::default())
            .await
            .unwrap();
    if let Some(project) = project {
        record.worktree = Some(WorkspaceWorktreeInfo {
            main_workspace_id: None,
            path: path.to_string_lossy().into_owned(),
            main_repo_path: project.to_string_lossy().into_owned(),
            branch: None,
            is_main: false,
        });
    }
    let mut records = vec![record.clone()];
    if let Some(project) = project.filter(|project| *project != path) {
        records.push(
            WorkspaceInfo::new_without_worktree(
                project.to_path_buf(),
                WorkspaceOpenOptions::default(),
            )
            .await
            .unwrap(),
        );
    }
    service
        .import_workspaces(
            WorkspaceExport {
                workspaces: records,
                current_workspace_id: None,
                primary_assistant_key: None,
                recent_workspaces: vec![],
                recent_assistant_workspaces: vec![],
                export_timestamp: "test".into(),
                version: "1".into(),
            },
            true,
        )
        .await
        .unwrap();
    service.require_workspace(&record.id).await.unwrap()
}

/// Synchronous form of [`register_local_fixture`] for test helpers that build
/// their workspace directory outside an async context (for example a
/// `TestWorkspace::new()` constructor). Production hosts register a directory
/// before creating sessions in it; a fixture directory used as a session
/// workspace must do the same, otherwise path-only session configs are
/// (correctly) rejected as unavailable legacy references.
///
/// The registration runs on its own thread with a private current-thread
/// runtime so it can be called from inside or outside another Tokio runtime.
#[cfg(test)]
pub(crate) fn register_local_fixture_blocking(path: &std::path::Path) -> WorkspaceInfo {
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name("workspace-fixture-registration".into())
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("fixture registration runtime")
                .block_on(register_local_fixture(&path, None))
        })
        .expect("spawn fixture registration thread")
        .join()
        .expect("fixture registration thread")
}

/// Test fixtures register real persisted workspace records before exercising
/// session routing; transport metadata alone is deliberately insufficient.
#[cfg(test)]
pub(crate) async fn register_remote_fixture(
    path: &str,
    connection: &str,
    host: &str,
) -> WorkspaceInfo {
    register_remote_fixture_with_id(path, connection, host, None).await
}

#[cfg(test)]
pub(crate) async fn register_remote_fixture_with_id(
    path: &str,
    connection: &str,
    host: &str,
    id: Option<&str>,
) -> WorkspaceInfo {
    use super::{WorkspaceExport, WorkspaceInfoRuntimeExt, WorkspaceOpenOptions};
    let service = fixture_workspace_service().await;
    let mut record = WorkspaceInfo::new_without_worktree(
        std::path::PathBuf::from(path),
        WorkspaceOpenOptions {
            workspace_kind: WorkspaceKind::Remote,
            remote_connection_id: Some(connection.to_owned()),
            remote_ssh_host: Some(host.to_owned()),
            stable_workspace_id: Some(
                openbitfun_services_core::workspace_identity::remote_workspace_stable_id(
                    host, path,
                ),
            ),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    if let Some(id) = id {
        record.id = id.to_owned();
    }
    let result = service
        .import_workspaces(
            WorkspaceExport {
                workspaces: vec![record.clone()],
                current_workspace_id: None,
                primary_assistant_key: None,
                recent_workspaces: vec![],
                recent_assistant_workspaces: vec![],
                export_timestamp: "test".into(),
                version: "1".into(),
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(result.imported_workspaces, 1);
    record
}

#[cfg(all(test, feature = "agent-runtime"))]
mod tests {
    use super::*;
    use crate::agentic::core::SessionConfig;
    use crate::agentic::workspace::{apply_workspace_record, reject_session_storage_root};
    use std::sync::Arc;

    #[cfg(feature = "scheduled-jobs")]
    #[tokio::test]
    async fn cron_100_target_upgrades_once_and_round_trips_without_losing_io() {
        use crate::service::cron::CronJobTarget;
        let root = tempfile::tempdir().unwrap();
        let local = register_local_fixture(root.path(), None).await;
        let remote = register_remote_fixture(
            &local.root_path.to_string_lossy(),
            "cron-upgrade-ssh",
            "cron.example",
        )
        .await;
        let payload = serde_json::json!({
            "kind": "workspace", "workspace": {
                "workspacePath": remote.root_path, "remoteConnectionId": "cron-upgrade-ssh",
                "remoteSshHost": "cron.example"
            }, "launch": { "agentType": "Standard" }
        });
        let legacy: CronJobTarget = serde_json::from_value(payload.clone()).unwrap();
        let upgraded = upgrade_legacy_cron_target(legacy).await.unwrap();
        assert_eq!(
            upgraded.workspace().workspace_id.as_deref(),
            Some(remote.id.as_str())
        );
        let round_trip: CronJobTarget =
            serde_json::from_value(serde_json::to_value(&upgraded).unwrap()).unwrap();
        assert_eq!(round_trip, upgraded);
        assert_eq!(
            round_trip.workspace().workspace_path,
            payload["workspace"]["workspacePath"].as_str().unwrap()
        );
        let mut ambiguous = payload.clone();
        ambiguous["workspace"]
            .as_object_mut()
            .unwrap()
            .remove("remoteConnectionId");
        ambiguous["workspace"]
            .as_object_mut()
            .unwrap()
            .remove("remoteSshHost");
        assert!(
            upgrade_legacy_cron_target(serde_json::from_value(ambiguous).unwrap())
                .await
                .is_err()
        );
        let id_only: CronJobTarget = serde_json::from_value(serde_json::json!({
            "kind": "workspace", "workspace": { "workspaceId": local.id },
            "launch": { "agentType": "Standard" }
        }))
        .unwrap();
        assert_eq!(
            upgrade_legacy_cron_target(id_only.clone()).await.unwrap(),
            id_only
        );
    }

    #[tokio::test]
    async fn current_local_io_scope_uses_ids_or_an_explicit_controller_target() {
        let root = tempfile::tempdir().unwrap();
        let local = register_local_fixture(root.path(), None).await;
        let remote = register_remote_fixture(
            &local.root_path.to_string_lossy(),
            "io-scope-ssh",
            "io.example",
        )
        .await;
        let path = local.root_path.to_string_lossy();
        assert!(!remote_io_for_legacy_or_id(Some(&local.id), false, &path)
            .await
            .unwrap());
        assert!(remote_io_for_legacy_or_id(Some(&remote.id), false, &path)
            .await
            .unwrap());
        assert!(remote_io_for_legacy_or_id(Some(&remote.id), true, &path)
            .await
            .unwrap());
        assert!(!remote_io_for_legacy_or_id(None, true, &path).await.unwrap());
        assert!(
            remote_io_for_legacy_or_id(Some("missing-io-id"), true, &path)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn old_worktree_owner_is_migrated_once_and_never_reselected_by_path() {
        use super::super::{WorkspaceInfoRuntimeExt, WorkspaceOpenOptions, WorkspaceWorktreeInfo};
        let root = tempfile::tempdir().unwrap();
        let parent = WorkspaceInfo::new_without_worktree(
            root.path().to_path_buf(),
            WorkspaceOpenOptions::default(),
        )
        .await
        .unwrap();
        let mut execution = parent.clone();
        execution.id = "execution-id".into();
        execution.root_path = root.path().join("worktree");
        execution.worktree = Some(
            serde_json::from_value::<WorkspaceWorktreeInfo>(serde_json::json!({
                "path": execution.root_path, "mainRepoPath": parent.root_path, "isMain": false
            }))
            .unwrap(),
        );
        assert!(execution.project_workspace_id().is_err());
        let mut remote = parent.clone();
        remote.id = "same-path-remote".into();
        remote.workspace_kind = WorkspaceKind::Remote;
        let mut records = std::collections::HashMap::from([
            (parent.id.clone(), parent.clone()),
            (execution.id.clone(), execution.clone()),
            (remote.id.clone(), remote),
        ]);
        upgrade_legacy_worktree_references(
            &mut records,
            &crate::infrastructure::get_path_manager_arc(),
        )
        .await;
        assert_eq!(
            records[&execution.id].project_workspace_id().unwrap(),
            parent.id
        );
        let serialized = serde_json::to_value(&records[&execution.id]).unwrap();
        assert_eq!(serialized["worktree"]["mainWorkspaceId"], parent.id);
        records
            .get_mut(&execution.id)
            .unwrap()
            .worktree
            .as_mut()
            .unwrap()
            .main_repo_path = "/stale/projection".into();
        upgrade_legacy_worktree_references(
            &mut records,
            &crate::infrastructure::get_path_manager_arc(),
        )
        .await;
        assert_eq!(
            records[&execution.id].project_workspace_id().unwrap(),
            parent.id
        );
        let mut collision = parent.clone();
        collision.id = "another-local-parent".into();
        records.insert(collision.id.clone(), collision);
        records.insert(execution.id.clone(), execution.clone());
        upgrade_legacy_worktree_references(
            &mut records,
            &crate::infrastructure::get_path_manager_arc(),
        )
        .await;
        assert!(records[&execution.id].project_workspace_id().is_err());
        assert_eq!(records.len(), 4);
    }

    #[tokio::test]
    async fn legacy_worktree_registers_missing_parent_once_and_preserves_unavailable_records() {
        use super::super::{WorkspaceInfoRuntimeExt, WorkspaceOpenOptions, WorkspaceWorktreeInfo};
        let root = tempfile::tempdir().unwrap();
        let paths =
            crate::infrastructure::PathManager::with_user_root_for_tests(root.path().join("user"));
        let execution_root = root.path().join("tree");
        let project_root = root.path().join("project");
        std::fs::create_dir_all(&execution_root).unwrap();
        std::fs::create_dir_all(&project_root).unwrap();
        let mut execution = WorkspaceInfo::new_without_worktree(
            execution_root.clone(),
            WorkspaceOpenOptions::default(),
        )
        .await
        .unwrap();
        execution.worktree = Some(WorkspaceWorktreeInfo {
            path: execution_root.to_string_lossy().into_owned(),
            main_repo_path: project_root.to_string_lossy().into_owned(),
            main_workspace_id: None,
            branch: None,
            is_main: false,
        });
        let mut records =
            std::collections::HashMap::from([(execution.id.clone(), execution.clone())]);
        upgrade_legacy_worktree_references(&mut records, &paths).await;
        let owner_id = records[&execution.id]
            .project_workspace_id()
            .unwrap()
            .to_owned();
        assert_eq!(
            records[&owner_id].root_path,
            dunce::canonicalize(&project_root).unwrap()
        );
        assert_eq!(records.len(), 2);
        upgrade_legacy_worktree_references(&mut records, &paths).await;
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[&execution.id].project_workspace_id().unwrap(),
            owner_id
        );

        for unavailable in [
            root.path().join("missing"),
            paths.projects_root().join("hidden"),
        ] {
            if unavailable.starts_with(paths.projects_root()) {
                std::fs::create_dir_all(&unavailable).unwrap();
            }
            execution.worktree.as_mut().unwrap().main_repo_path =
                unavailable.to_string_lossy().into_owned();
            let mut legacy =
                std::collections::HashMap::from([(execution.id.clone(), execution.clone())]);
            upgrade_legacy_worktree_references(&mut legacy, &paths).await;
            assert_eq!(legacy.len(), 1);
            assert!(legacy[&execution.id].project_workspace_id().is_err());
            assert_eq!(legacy[&execution.id].worktree, execution.worktree);
        }
    }

    #[tokio::test]
    async fn legacy_worktree_migration_resolves_execution_and_project_separately() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let execution = root.path().join("worktree");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&execution).unwrap();
        let record = register_local_fixture(&execution, Some(&project)).await;
        let mut config = SessionConfig {
            workspace_path: Some(execution.to_string_lossy().into_owned()),
            project_workspace_path: Some(project.to_string_lossy().into_owned()),
            ..Default::default()
        };
        crate::agentic::workspace::normalize_session_workspace(&mut config)
            .await
            .unwrap();
        assert_eq!(config.workspace_id.as_deref(), Some(record.id.as_str()));
        assert_ne!(config.project_workspace_id, config.workspace_id);
        assert_eq!(config.workspace_path.as_deref(), record.root_path.to_str());
        assert_eq!(
            config.project_workspace_path.as_deref(),
            dunce::canonicalize(&project).unwrap().to_str()
        );
        // Rehydration uses IDs even when stale projections look like another workspace.
        config.workspace_path = Some(project.to_string_lossy().into_owned());
        config.remote_connection_id = Some("stale-ssh-id".into());
        crate::agentic::workspace::normalize_session_workspace(&mut config)
            .await
            .unwrap();
        assert_eq!(config.workspace_path.as_deref(), record.root_path.to_str());
        assert_eq!(config.workspace_kind, Some(WorkspaceKind::Normal));
        assert_eq!(config.remote_connection_id, None);
    }

    #[tokio::test]
    async fn unknown_legacy_local_folder_cannot_become_an_unregistered_workspace() {
        let root = tempfile::tempdir().unwrap();
        let _ = fixture_workspace_service().await;
        let mut config = SessionConfig {
            workspace_path: Some(root.path().to_string_lossy().into_owned()),
            ..Default::default()
        };
        let original = config.workspace_path.clone();
        assert!(
            crate::agentic::workspace::normalize_session_workspace(&mut config)
                .await
                .is_err()
        );
        assert_eq!(config.workspace_id, None);
        assert_eq!(config.workspace_kind, None);
        assert_eq!(config.workspace_path, original);
        assert!(root.path().exists());
    }

    #[tokio::test]
    async fn id_only_restore_uses_record_type_and_separates_execution_from_storage() {
        use crate::agentic::session::CoreSessionStorePort;
        use openbitfun_runtime_ports::{SessionStorageKind, SessionStorePort};
        let logical_root = format!("/srv/id-only-{}", uuid::Uuid::new_v4());
        let record = register_remote_fixture(&logical_root, "ssh-localhost", "localhost").await;
        let mut config = SessionConfig {
            workspace_id: Some(record.id.clone()),
            remote_connection_id: Some("untrusted-request".into()),
            ..Default::default()
        };
        crate::agentic::workspace::normalize_session_workspace(&mut config)
            .await
            .unwrap();
        assert_eq!(
            config.workspace_path.as_deref(),
            Some(logical_root.as_str())
        );
        assert_eq!(
            config.remote_connection_id.as_deref(),
            Some("ssh-localhost")
        );
        assert!(config.is_remote_workspace());
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(temp.path().join("user")),
        );
        let resolution = CoreSessionStorePort::with_path_manager_for_tests(paths.clone())
            .resolve_workspace_storage(&record.id)
            .await
            .unwrap();
        assert_eq!(resolution.storage_kind, SessionStorageKind::Remote);
        assert_eq!(resolution.requested_workspace_path, record.root_path);
        assert!(resolution
            .effective_storage_path
            .starts_with(paths.remote_ssh_mirror_root_dir()));
        assert_ne!(resolution.effective_storage_path, record.root_path);
        assert!(CoreSessionStorePort::with_path_manager_for_tests(paths)
            .resolve_workspace_storage(&logical_root)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn workspace_kind_controls_legacy_identity_and_path_resolution() {
        let root = tempfile::tempdir().unwrap();
        let paths = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(root.path().join("data")),
        );
        let service = WorkspaceService::new_for_test_path_manager(paths.clone()).await;
        let project = root.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let local = service.open_workspace(project.clone()).await.unwrap();
        let path = local.root_path.to_string_lossy().to_string();
        // Exact 1.0.0 shape: no workspace_kind in session config and a local host marker.
        let mut json = serde_json::to_value(SessionConfig::default()).unwrap();
        json["workspace_path"] = serde_json::json!(path);
        json["remote_ssh_host"] = serde_json::json!("localhost");
        json.as_object_mut().unwrap().remove("workspace_kind");
        let mut legacy: SessionConfig = serde_json::from_value(json).unwrap();
        let resolved = resolve_legacy_workspace_reference(
            &[local.clone()],
            None,
            &path,
            None,
            Some("localhost"),
        )
        .unwrap()
        .unwrap();
        apply_workspace_record(&mut legacy, &resolved).unwrap();
        assert_eq!(legacy.workspace_kind, Some(WorkspaceKind::Normal));
        assert!(legacy.remote_ssh_host.is_none());
        assert!(legacy.remote_connection_id.is_none());
        assert!(!legacy.is_remote_workspace());
        let round_trip: SessionConfig =
            serde_json::from_value(serde_json::to_value(&legacy).unwrap()).unwrap();
        assert_eq!(round_trip.workspace_kind, legacy.workspace_kind);
        let reopened = service
            .resolve_legacy_workspace_open(&path, None, Some("localhost"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reopened.id, local.id);
        assert_eq!(reopened.workspace_kind, WorkspaceKind::Normal);

        let mut remote = local.clone();
        remote.id = "ssh-workspace".into();
        remote.workspace_kind = WorkspaceKind::Remote;
        remote
            .metadata
            .insert("connectionId".into(), serde_json::json!("saved-ssh"));
        // localhost can also be a real SSH host. Type decides, never host spelling.
        let records = [local.clone(), remote.clone()];
        assert!(resolve_legacy_workspace_reference(&records, None, &path, None, None).is_err());
        let resolved =
            resolve_legacy_workspace_reference(&records, Some(&remote.id), &path, None, None)
                .unwrap()
                .unwrap();
        apply_workspace_record(&mut legacy, &resolved).unwrap();
        assert!(legacy.is_remote_workspace());
        assert_eq!(legacy.remote_connection_id.as_deref(), Some("saved-ssh"));
        assert_eq!(legacy.remote_ssh_host.as_deref(), Some("localhost"));
        let resolved = resolve_legacy_workspace_reference(
            &records,
            Some(&local.id),
            &path,
            Some("wrong-id"),
            Some("wrong-host"),
        )
        .unwrap()
        .unwrap();
        apply_workspace_record(&mut legacy, &resolved).unwrap();
        assert!(!legacy.is_remote_workspace());
        assert!(legacy.remote_connection_id.is_none());
        remote.metadata.remove("connectionId");
        assert!(apply_workspace_record(&mut legacy, &remote).is_err());

        let storage = paths
            .remote_ssh_mirror_root_dir()
            .join("localhost/project/sessions");
        std::fs::create_dir_all(&storage).unwrap();
        assert!(reject_session_storage_root(
            &storage,
            &paths.projects_root(),
            &paths.remote_ssh_mirror_root_dir()
        )
        .is_err());
        assert!(reject_session_storage_root(
            &project,
            &paths.projects_root(),
            &paths.remote_ssh_mirror_root_dir()
        )
        .is_ok());
        let resolved = resolve_legacy_workspace_reference(
            &records,
            Some(&remote.id),
            &storage.to_string_lossy(),
            None,
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(resolved.root_path, remote.root_path);
        assert!(resolve_legacy_workspace_reference(
            &records,
            Some("deleted-workspace"),
            &path,
            None,
            None
        )
        .is_err());
    }
}

/// Temporary pre-ID wire adapter. Paths may only be resolved here, never used
/// as runtime workspace keys. A missing or ambiguous reference fails closed.
pub(crate) async fn upgrade_optional_workspace_reference(
    workspace_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<Option<super::WorkspaceInfo>, String> {
    if workspace_id.is_none() && legacy_path.is_none() {
        return Ok(None);
    }
    let service = super::get_global_workspace_service()
        .ok_or_else(|| "Workspace service is unavailable".to_string())?;
    if let Some(id) = workspace_id {
        return service
            .require_workspace(id)
            .await
            .map(Some)
            .map_err(|error| error.to_string());
    }
    service
        .resolve_legacy_workspace_reference(None, legacy_path.unwrap_or_default(), None, None)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Legacy workspace reference cannot be resolved".to_string())
        .map(Some)
}

#[cfg(feature = "external-sources")]
pub(crate) fn upgrade_external_policy_key<T: Clone>(
    overrides: &mut std::collections::BTreeMap<String, T>,
    records: &[WorkspaceInfo],
    workspace_id: &str,
    new_key: &str,
) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let record = records
        .iter()
        .find(|record| record.id == workspace_id)
        .ok_or_else(|| "Unknown workspace ID during policy migration".to_string())?;
    if overrides.contains_key(new_key) {
        return Ok(false);
    }
    // Reproduce only the retired on-disk key algorithm. Runtime routes never
    // use this value. Preserve old entries for rollback and old readers.
    let legacy_key = |record: &WorkspaceInfo| {
        let root =
            dunce::canonicalize(&record.root_path).unwrap_or_else(|_| record.root_path.clone());
        let normalized = root.to_string_lossy().replace('\\', "/");
        #[cfg(windows)]
        let normalized = normalized.to_ascii_lowercase();
        let digest = Sha256::digest(normalized.as_bytes());
        format!("workspace:{}", hex::encode(&digest[..16]))
    };
    let old_key = legacy_key(record);
    let Some(value) = overrides.get(&old_key).cloned() else {
        return Ok(false);
    };
    if records
        .iter()
        .filter(|other| legacy_key(other) == old_key)
        .count()
        != 1
    {
        return Err("Legacy external integration policy belongs to an ambiguous workspace; original settings were preserved".into());
    }
    overrides.insert(new_key.to_owned(), value);
    Ok(true)
}

#[cfg(all(test, feature = "external-sources"))]
mod external_policy_upgrade_tests {
    use super::super::{WorkspaceInfoRuntimeExt, WorkspaceOpenOptions};
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    #[tokio::test]
    async fn copies_legacy_policy_once_without_overwriting_id_settings_or_old_data() {
        let root = tempfile::tempdir().unwrap();
        let record = WorkspaceInfo::new_without_worktree(
            root.path().to_owned(),
            WorkspaceOpenOptions::default(),
        )
        .await
        .unwrap();
        let path = dunce::canonicalize(root.path())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        #[cfg(windows)]
        let path = path.to_ascii_lowercase();
        let legacy_key = format!(
            "workspace:{}",
            hex::encode(&Sha256::digest(path.as_bytes())[..16])
        );
        let mut settings = BTreeMap::from([(legacy_key.clone(), false)]);
        let records = vec![record.clone()];
        assert!(
            upgrade_external_policy_key(&mut settings, &records, &record.id, "new-id-key").unwrap()
        );
        assert_eq!(settings.get("new-id-key"), Some(&false));
        assert_eq!(settings.get(&legacy_key), Some(&false));
        settings.insert("new-id-key".into(), true);
        assert!(
            !upgrade_external_policy_key(&mut settings, &records, &record.id, "new-id-key")
                .unwrap()
        );
        assert_eq!(settings.get("new-id-key"), Some(&true));
        settings.remove("new-id-key");
        let mut remote = record.clone();
        remote.id = "another-workspace".into();
        remote.workspace_kind = WorkspaceKind::Remote;
        let before = settings.clone();
        assert!(upgrade_external_policy_key(
            &mut settings,
            &[record.clone(), remote],
            &record.id,
            "new-id-key"
        )
        .is_err());
        assert_eq!(settings, before);
    }

    #[test]
    fn route_keys_preserve_id_case_and_never_canonicalize_as_paths() {
        use crate::agentic::workspace::workspace_route_key;
        assert_eq!(workspace_route_key(Some("Alpha")), "workspace:Alpha");
        assert_ne!(
            workspace_route_key(Some("Alpha")),
            workspace_route_key(Some("alpha"))
        );
        assert_ne!(
            workspace_route_key(Some("Alpha")),
            workspace_route_key(None)
        );
    }
}

/// Upgrade-only hydration for persisted 1.0.0 session references. Execution and
/// storage roots have different roles: resolve the execution object first, then
/// migrate the owning project relationship. Unknown or ambiguous data is retained
/// by the persistence owner and reported as unavailable, never made local.
#[cfg(feature = "agent-runtime")]
pub(crate) async fn upgrade_session_workspace_reference(
    config: &mut crate::agentic::core::SessionConfig,
    service: &WorkspaceService,
) -> OpenBitFunResult<()> {
    if config.workspace_id.is_none() {
        let path = config
            .workspace_path
            .as_deref()
            .or(config.project_workspace_path.as_deref())
            .ok_or_else(|| OpenBitFunError::service("Session has no workspace reference"))?;
        let record = service
            .resolve_legacy_workspace_reference(
                None,
                path,
                config.remote_connection_id.as_deref(),
                config.remote_ssh_host.as_deref(),
            )
            .await?
            .ok_or_else(|| {
                OpenBitFunError::service(
                    "Legacy session workspace is unavailable; restore its workspace record",
                )
            })?;
        config.workspace_id = Some(record.id);
    }
    if config.project_workspace_id.is_none() {
        let record = service
            .require_workspace(config.workspace_id.as_deref().expect("workspace resolved"))
            .await?;
        config.project_workspace_id = Some(
            record
                .project_workspace_id()
                .map_err(OpenBitFunError::service)?
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(feature = "agent-runtime")]
impl WorkspaceService {
    /// Upgrade-only conversion of an old Runtime binding projection. New producers
    /// send IDs and kind; this adapter never infers kind from SSH metadata.
    pub async fn upgrade_legacy_session_binding(
        &self,
        binding: openbitfun_runtime_ports::AgentSessionWorkspaceBinding,
    ) -> OpenBitFunResult<openbitfun_runtime_ports::AgentSessionWorkspaceBinding> {
        let mut config = crate::agentic::core::SessionConfig {
            workspace_id: binding.workspace_id,
            project_workspace_id: binding.project_workspace_id,
            workspace_kind: binding.workspace_kind,
            workspace_path: Some(binding.workspace_path),
            project_workspace_path: binding.project_workspace_path,
            execution_target: binding.execution_target,
            remote_connection_id: binding.remote_connection_id,
            remote_ssh_host: binding.remote_ssh_host,
            ..Default::default()
        };
        upgrade_session_workspace_reference(&mut config, self).await?;
        let record = self
            .require_workspace(config.workspace_id.as_deref().expect("resolved workspace"))
            .await?;
        let project = self
            .require_workspace(
                config
                    .project_workspace_id
                    .as_deref()
                    .expect("resolved project"),
            )
            .await?;
        if (record.workspace_kind == WorkspaceKind::Remote
            || project.workspace_kind == WorkspaceKind::Remote)
            && record.id != project.id
        {
            return Err(OpenBitFunError::service(
                "Remote workspace cannot use another project workspace",
            ));
        }
        crate::agentic::workspace::apply_workspace_record(&mut config, &record)?;
        Ok(openbitfun_runtime_ports::AgentSessionWorkspaceBinding {
            workspace_kind: config.workspace_kind,
            workspace_id: config.workspace_id,
            project_workspace_id: config.project_workspace_id,
            workspace_path: record.root_path.to_string_lossy().into_owned(),
            project_workspace_path: Some(project.root_path.to_string_lossy().into_owned()),
            execution_target: config.execution_target,
            remote_connection_id: config.remote_connection_id,
            remote_ssh_host: config.remote_ssh_host,
        })
    }
}

#[cfg(feature = "remote-workspace")]
impl WorkspaceService {
    /// Upgrade-only ingress for pre-ID filesystem requests. Never call this from
    /// current workspace operations: resolve their ID and use the record's kind.
    /// Device directory browsers carry an explicit connection (empty means local).
    pub async fn upgrade_legacy_file_connection(
        &self,
        path: &str,
        legacy_workspace_path: Option<&str>,
        connection_id: Option<&str>,
    ) -> OpenBitFunResult<Option<String>> {
        if let Some(root) = legacy_workspace_path.filter(|value| !value.is_empty()) {
            let record = self
                .resolve_legacy_workspace_reference(
                    None,
                    root,
                    connection_id.filter(|id| !id.is_empty()),
                    None,
                )
                .await?
                .ok_or_else(|| {
                    OpenBitFunError::service(
                        "Legacy filesystem workspace cannot be resolved; select its ID",
                    )
                })?;
            return record
                .filesystem_connection_id()
                .map(|id| id.map(str::to_owned))
                .map_err(OpenBitFunError::service);
        }
        if let Some(id) = connection_id {
            return Ok((!id.is_empty()).then(|| id.to_owned()));
        }
        // Old file browsers omitted the target. Compare only registered IO
        // projections inside this upgrade boundary. An active connection is
        // never authority, and colliding local/remote providers are ambiguous.
        let mut providers = std::collections::BTreeSet::new();
        let local_path =
            dunce::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
        let remote_path =
            openbitfun_services_core::workspace_identity::normalize_remote_workspace_path(path);
        for record in self.list_workspace_infos().await {
            let contains = if record.workspace_kind == WorkspaceKind::Remote {
                let root =
                    openbitfun_services_core::workspace_identity::normalize_remote_workspace_path(
                        &record.root_path.to_string_lossy(),
                    );
                remote_path == root
                    || remote_path.starts_with(&format!("{}/", root.trim_end_matches('/')))
            } else {
                local_path.starts_with(&record.root_path)
            };
            if contains {
                providers.insert(
                    record
                        .filesystem_connection_id()
                        .map_err(OpenBitFunError::service)?
                        .map(str::to_owned),
                );
            }
        }
        if providers.len() > 1 {
            return Err(OpenBitFunError::service("Legacy filesystem path matches multiple workspace providers; select the workspace ID"));
        }
        Ok(providers.into_iter().next().flatten())
    }
}

/// Upgrade-only persisted worktree relationship migration. All normal navigation,
/// session storage and execution binding follow `main_workspace_id` afterwards.
/// Unknown/ambiguous parents stay intact and unavailable, never become local roots.
pub(crate) async fn upgrade_legacy_worktree_references(
    records: &mut std::collections::HashMap<String, WorkspaceInfo>,
    path_manager: &crate::infrastructure::PathManager,
) {
    use super::{WorkspaceInfoRuntimeExt, WorkspaceOpenOptions};
    let old_records: Vec<_> = records.values().cloned().collect();
    for record in old_records {
        if record.workspace_kind == WorkspaceKind::Remote {
            continue;
        }
        let Some(tree) = record.worktree.as_ref() else {
            continue;
        };
        if tree.main_workspace_id.is_some() {
            continue;
        }
        let parent_id = if tree.is_main {
            Some(record.id.clone())
        } else {
            let snapshot: Vec<_> = records
                .values()
                .filter(|record| record.workspace_kind != WorkspaceKind::Remote)
                .cloned()
                .collect();
            match resolve_legacy_workspace_reference(
                &snapshot,
                None,
                &tree.main_repo_path,
                None,
                None,
            ) {
                Ok(Some(parent)) => Some(parent.id),
                Ok(None) => {
                    // 1.0.0 could persist a linked worktree before its main folder
                    // was opened. Register that existing local folder once; never
                    // use a hidden session directory as the parent.
                    let root = match dunce::canonicalize(&tree.main_repo_path) {
                        Ok(root) => root,
                        Err(error) => {
                            log::warn!("Legacy project folder is unavailable; preserving workspace: workspace_id={}, error={}", record.id, error);
                            continue;
                        }
                    };
                    let valid = [
                        path_manager.projects_root(),
                        path_manager.remote_ssh_mirror_root_dir(),
                    ]
                    .into_iter()
                    .all(|storage| {
                        let storage = dunce::canonicalize(&storage).unwrap_or(storage);
                        !root.starts_with(storage)
                    });
                    if !valid {
                        None
                    } else {
                        match WorkspaceInfo::new_without_worktree(
                            root,
                            WorkspaceOpenOptions {
                                auto_set_current: false,
                                add_to_recent: false,
                                ..Default::default()
                            },
                        )
                        .await
                        {
                            Ok(parent) => {
                                let id = parent.id.clone();
                                records.entry(id.clone()).or_insert(parent);
                                Some(id)
                            }
                            Err(error) => {
                                log::warn!("Legacy project registration failed; preserving workspace: workspace_id={}, error={}", record.id, error);
                                None
                            }
                        }
                    }
                }
                Err(error) => {
                    log::warn!("Legacy worktree project is ambiguous; preserving workspace: workspace_id={}, error={}", record.id, error);
                    None
                }
            }
        };
        if let Some(tree) = records
            .get_mut(&record.id)
            .and_then(|record| record.worktree.as_mut())
        {
            tree.main_workspace_id = parent_id;
        }
    }
}

/// Temporary local-IO wire compatibility boundary. Current workspace operations
/// supply an ID and the record kind is authoritative. Only a pre-ID payload may
/// consult the retired remote path registry; remove that branch at protocol sunset.
pub async fn remote_io_for_legacy_or_id(
    workspace_id: Option<&str>,
    controller_local: bool,
    legacy_path: &str,
) -> OpenBitFunResult<bool> {
    if let Some(id) = workspace_id {
        let service = super::get_global_workspace_service()
            .ok_or_else(|| OpenBitFunError::service("Workspace service is unavailable"))?;
        return Ok(service.require_workspace(id).await?.workspace_kind == WorkspaceKind::Remote);
    }
    if controller_local {
        return Ok(false);
    }
    #[cfg(any(feature = "remote-workspace", feature = "agent-runtime"))]
    {
        Ok(crate::service::remote_ssh::workspace_state::is_remote_path(legacy_path).await)
    }
    #[cfg(not(any(feature = "remote-workspace", feature = "agent-runtime")))]
    {
        let _ = legacy_path;
        Ok(false)
    }
}

/// Temporary 1.0.0 persisted/wire Cron adapter. New producers must supply an ID.
/// Preserve the IO projection for old readers; the runtime refreshes it by ID.
#[cfg(all(feature = "agent-runtime", feature = "scheduled-jobs"))]
pub(crate) async fn upgrade_legacy_cron_target(
    mut target: crate::service::cron::CronJobTarget,
) -> OpenBitFunResult<crate::service::cron::CronJobTarget> {
    use crate::service::cron::CronJobTarget;
    let workspace = match &mut target {
        CronJobTarget::Session { workspace, .. } | CronJobTarget::Workspace { workspace, .. } => {
            workspace
        }
    };
    if workspace.workspace_id.is_none() {
        let service = super::get_global_workspace_service()
            .ok_or_else(|| OpenBitFunError::service("Workspace service is unavailable"))?;
        let record = service
            .resolve_legacy_workspace_reference(
                None,
                &workspace.workspace_path,
                workspace.remote_connection_id.as_deref(),
                workspace.remote_ssh_host.as_deref(),
            )
            .await?
            .ok_or_else(|| {
                OpenBitFunError::service(
                    "Scheduled job workspace is unavailable; select its workspace by ID",
                )
            })?;
        workspace.workspace_id = Some(record.id);
    }
    Ok(target)
}

/// Temporary 1.0.0 fork ingress. Some old SDK/plugin clients sent a resolved
/// Session store rather than a project directory. Resolve the source through
/// its registered ID and compare the IO projection only inside this adapter.
/// New callers must never send a path; remove with the pre-ID protocol sunset.
#[cfg(feature = "agent-runtime")]
impl WorkspaceService {
    pub(crate) async fn resolve_legacy_fork_workspace_reference(
        &self,
        sessions: &crate::agentic::session::SessionManager,
        path: &str,
        connection: Option<&str>,
        host: Option<&str>,
        source_session_id: &str,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        if let Some(record) = self
            .resolve_legacy_workspace_reference(None, path, connection, host)
            .await?
        {
            return Ok(record);
        }
        if connection.is_none() && host.is_none() {
            if let Some(binding) = sessions
                .resolve_session_workspace_binding(source_session_id)
                .await
            {
                if let Some(id) = binding.workspace_id.as_deref() {
                    use openbitfun_runtime_ports::SessionStorePort;
                    let storage = crate::agentic::session::CoreSessionStorePort::with_path_manager(
                        sessions.persistence_manager().path_manager().clone(),
                    )
                    .resolve_workspace_storage(id)
                    .await
                    .map_err(|e| OpenBitFunError::service(e.to_string()))?;
                    let input = std::path::Path::new(path);
                    if input == storage.effective_storage_path
                        || dunce::canonicalize(input)
                            .is_ok_and(|canonical| canonical == storage.effective_storage_path)
                    {
                        return self.require_workspace(id).await;
                    }
                }
            }
        }
        Err(OpenBitFunError::service(
            "Legacy fork workspace reference is unavailable; select its workspace ID",
        ))
    }
}

#[cfg(all(test, feature = "agent-runtime", feature = "remote-workspace"))]
mod legacy_file_scope_tests {
    #[tokio::test]
    async fn legacy_file_collision_requires_id_or_explicit_device_scope() {
        let folder = tempfile::tempdir().unwrap();
        let local = super::register_local_fixture(folder.path(), None).await;
        let path = local
            .root_path
            .join("file.txt")
            .to_string_lossy()
            .into_owned();
        let service = super::fixture_workspace_service().await;
        assert_eq!(
            service
                .upgrade_legacy_file_connection(&path, None, None)
                .await
                .unwrap(),
            None
        );
        let remote = super::register_remote_fixture(
            &local.root_path.to_string_lossy(),
            "legacy-file-ssh",
            "legacy-file-host",
        )
        .await;
        assert!(service
            .upgrade_legacy_file_connection(&path, None, None)
            .await
            .is_err());
        assert_eq!(
            service
                .upgrade_legacy_file_connection(&path, None, Some(""))
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            service
                .require_workspace(&local.id)
                .await
                .unwrap()
                .filesystem_connection_id()
                .unwrap(),
            None
        );
        assert_eq!(
            service
                .require_workspace(&remote.id)
                .await
                .unwrap()
                .filesystem_connection_id()
                .unwrap(),
            Some("legacy-file-ssh")
        );
        assert_eq!(
            service
                .upgrade_legacy_file_connection(&path, None, Some("legacy-file-ssh"))
                .await
                .unwrap()
                .as_deref(),
            Some("legacy-file-ssh")
        );
    }
}
