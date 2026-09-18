use super::file_lock_manager::FileLockManager;
use super::manager::{
    clear_bound_snapshot_manager_for_test, get_or_create_snapshot_manager_with_workspace,
    open_snapshot_manager_for_workspace_view, wrap_tool_for_snapshot_tracking,
};
use super::service::SnapshotService;
use super::snapshot_core::SnapshotCore;
use super::snapshot_system::FileSnapshotSystem;
use super::types::{FileOperation, OperationType};
use crate::agentic::session::revert::{SessionRevertPhase, SessionRevertState};
use crate::service::workspace_runtime::{WorkspaceRuntimeContext, WorkspaceRuntimeTarget};
use openbitfun_runtime_ports::{
    WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
    WorkspaceMetadata, WorkspacePathKind, WorkspaceShell,
};
use openbitfun_services_core::workspace::LocalWorkspaceFs;
use openbitfun_services_core::workspace_identity::WorkspaceSessionIdentity;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct MemoryFile {
    content: Vec<u8>,
    modified: SystemTime,
    permissions: u32,
}

/// A separate filesystem namespace: using controller IO for any workspace
/// access makes these tests fail, even though metadata and blobs remain local.
struct RemoteMemoryFs {
    root: String,
    files: Mutex<HashMap<String, MemoryFile>>,
    symlinks: Mutex<HashSet<String>>,
    fail_metadata: AtomicBool,
    fail_after_write: AtomicBool,
    fail_remove: AtomicBool,
}

impl RemoteMemoryFs {
    fn new(root: &str) -> Self {
        Self {
            root: root.into(),
            files: Mutex::new(HashMap::new()),
            symlinks: Mutex::new(HashSet::new()),
            fail_metadata: AtomicBool::new(false),
            fail_after_write: AtomicBool::new(false),
            fail_remove: AtomicBool::new(false),
        }
    }
}

#[async_trait::async_trait]
impl WorkspaceFileSystem for RemoteMemoryFs {
    fn join_path(&self, root: &str, components: &[&str]) -> String {
        format!("{}/{}", root.trim_end_matches('/'), components.join("/"))
    }
    async fn metadata(
        &self,
        path: &str,
        _follow_symlinks: bool,
    ) -> anyhow::Result<Option<WorkspaceMetadata>> {
        anyhow::ensure!(
            !self.fail_metadata.load(Ordering::SeqCst),
            "SSH connection is offline"
        );
        if self.symlinks.lock().unwrap().contains(path) {
            return Ok(Some(WorkspaceMetadata {
                kind: WorkspacePathKind::Symlink,
                size: None,
                modified: None,
                permissions: None,
            }));
        }
        let files = self.files.lock().unwrap();
        if let Some(file) = files.get(path) {
            return Ok(Some(WorkspaceMetadata {
                kind: WorkspacePathKind::File,
                size: Some(file.content.len() as u64),
                modified: Some(file.modified),
                permissions: Some(file.permissions),
            }));
        }
        Ok((path == self.root
            || files
                .keys()
                .any(|file| file.starts_with(&format!("{path}/"))))
        .then_some(WorkspaceMetadata {
            kind: WorkspacePathKind::Directory,
            size: None,
            modified: None,
            permissions: None,
        }))
    }
    async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .map(|file| file.content.clone())
            .ok_or_else(|| anyhow::anyhow!("Remote file is missing: {path}"))
    }
    async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
        Ok(String::from_utf8(self.read_file(path).await?)?)
    }
    async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
        anyhow::ensure!(
            path.starts_with(&format!("{}/", self.root)),
            "Controller path leaked into remote filesystem: {path}"
        );
        self.files.lock().unwrap().insert(
            path.into(),
            MemoryFile {
                content: contents.into(),
                modified: UNIX_EPOCH + Duration::from_secs(1_700_000_000),
                permissions: 0o640,
            },
        );
        anyhow::ensure!(
            !self.fail_after_write.swap(false, Ordering::SeqCst),
            "SSH disconnected after write; outcome requires recovery"
        );
        Ok(())
    }
    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.fail_remove.swap(false, Ordering::SeqCst),
            "SSH remove failed"
        );
        anyhow::ensure!(
            self.files.lock().unwrap().remove(path).is_some(),
            "Remote file is missing: {path}"
        );
        Ok(())
    }
    async fn set_permissions(&self, path: &str, permissions: u32) -> anyhow::Result<()> {
        self.files
            .lock()
            .unwrap()
            .get_mut(path)
            .ok_or_else(|| anyhow::anyhow!("Remote file is missing"))?
            .permissions = permissions;
        Ok(())
    }
    async fn set_modified(&self, path: &str, modified: SystemTime) -> anyhow::Result<()> {
        self.files
            .lock()
            .unwrap()
            .get_mut(path)
            .ok_or_else(|| anyhow::anyhow!("Remote file is missing"))?
            .modified = modified;
        Ok(())
    }
    async fn exists(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self.metadata(path, true).await?.is_some())
    }
    async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|entry| entry.kind == WorkspacePathKind::File))
    }
    async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|entry| entry.kind == WorkspacePathKind::Directory))
    }
    async fn path_kind_no_follow(&self, path: &str) -> anyhow::Result<Option<WorkspacePathKind>> {
        Ok(self.metadata(path, false).await?.map(|entry| entry.kind))
    }
    async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        anyhow::bail!("Directory listing is not needed for snapshot IO")
    }
}

fn runtime_context(root: &str, runtime_root: &Path, remote: bool) -> WorkspaceRuntimeContext {
    let target = if remote {
        WorkspaceRuntimeTarget::RemoteWorkspaceMirror {
            ssh_host: "shared-server".into(),
            remote_root: root.into(),
        }
    } else {
        WorkspaceRuntimeTarget::LocalWorkspace {
            workspace_root: root.into(),
        }
    };
    let context = WorkspaceRuntimeContext::new(target, runtime_root.into());
    for dir in context.required_directories() {
        std::fs::create_dir_all(dir).unwrap();
    }
    context
}

async fn open_core(
    context: &WorkspaceRuntimeContext,
    fs: Arc<dyn WorkspaceFileSystem>,
) -> SnapshotCore {
    let system = FileSnapshotSystem::with_workspace_fs(context.clone(), fs);
    let mut core = SnapshotCore::new(context.clone(), system);
    core.initialize().await.unwrap();
    core
}

async fn record_change(
    core: &mut SnapshotCore,
    fs: &dyn WorkspaceFileSystem,
    path: &str,
    kind: OperationType,
    after: Option<&[u8]>,
) {
    let operation = core
        .start_file_operation(
            "session",
            0,
            path.into(),
            kind,
            "fixture".into(),
            serde_json::json!({}),
            None,
        )
        .await
        .unwrap();
    if let Some(content) = after {
        fs.write_file(path, content).await.unwrap();
    } else {
        fs.remove_file(path).await.unwrap();
    }
    core.complete_file_operation("session", &operation, 1)
        .await
        .unwrap();
}

fn revert_state() -> SessionRevertState {
    SessionRevertState {
        schema_version: 1,
        boundary_turn: 0,
        original_turn_end: 1,
        phase: SessionRevertPhase::Applying,
        workspace_checkpoint: Vec::new(),
    }
}

async fn assert_roundtrip(
    fs: Arc<dyn WorkspaceFileSystem>,
    context: WorkspaceRuntimeContext,
    root: &str,
) {
    let modified = fs.join_path(root, &["nested", "modified.txt"]);
    let deleted = fs.join_path(root, &["deleted.txt"]);
    let created = fs.join_path(root, &["created.txt"]);
    fs.write_file(&modified, b"original\n").await.unwrap();
    fs.write_file(&deleted, b"restore deletion\n")
        .await
        .unwrap();
    let before_metadata = fs.metadata(&modified, true).await.unwrap().unwrap();
    let mut core = open_core(&context, fs.clone()).await;
    record_change(
        &mut core,
        fs.as_ref(),
        &modified,
        OperationType::Modify,
        Some(b"changed\n"),
    )
    .await;
    record_change(
        &mut core,
        fs.as_ref(),
        &deleted,
        OperationType::Delete,
        None,
    )
    .await;
    record_change(
        &mut core,
        fs.as_ref(),
        &created,
        OperationType::Create,
        Some(b"new\n"),
    )
    .await;
    assert_eq!(
        core.get_file_diff(Path::new(&modified), "session")
            .await
            .unwrap(),
        ("original\n".into(), "changed\n".into())
    );
    assert_eq!(
        core.get_file_diff(Path::new(&deleted), "session")
            .await
            .unwrap(),
        ("restore deletion\n".into(), String::new())
    );
    assert!(context
        .snapshot_operations_dir
        .join("session.json")
        .is_file());

    // Cold restore reads controller metadata, then uses the same provider for
    // checkpoint/rollback/redo; it must not open remote logical paths locally.
    drop(core);
    let mut core = open_core(&context, fs.clone()).await;
    let mut state = revert_state();
    core.prepare_workspace_revert("session", &mut state)
        .await
        .unwrap();
    assert_eq!(state.workspace_checkpoint.len(), 3);
    for _ in 0..2 {
        core.apply_workspace_revert("session", &state)
            .await
            .unwrap();
        assert_eq!(fs.read_file(&modified).await.unwrap(), b"original\n");
        assert_eq!(fs.read_file(&deleted).await.unwrap(), b"restore deletion\n");
        assert!(!fs.exists(&created).await.unwrap());
    }
    let restored = fs.metadata(&modified, true).await.unwrap().unwrap();
    assert_eq!(restored.permissions, before_metadata.permissions);
    assert_eq!(restored.modified, before_metadata.modified);
    core.restore_workspace_revert(&state).await.unwrap();
    assert_eq!(fs.read_file(&modified).await.unwrap(), b"changed\n");
    assert!(!fs.exists(&deleted).await.unwrap());
    assert_eq!(fs.read_file(&created).await.unwrap(), b"new\n");
}

#[tokio::test]
async fn one_snapshot_algorithm_roundtrips_real_local_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let root = workspace.to_string_lossy();
    assert_roundtrip(
        Arc::new(LocalWorkspaceFs),
        runtime_context(&root, &temp.path().join("runtime"), false),
        &root,
    )
    .await;
}

#[tokio::test]
async fn one_snapshot_algorithm_roundtrips_separate_remote_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/snapshot-workspace";
    assert_roundtrip(
        Arc::new(RemoteMemoryFs::new(root)),
        runtime_context(root, temp.path(), true),
        root,
    )
    .await;
}

#[tokio::test]
async fn remote_transport_errors_are_not_missing_files_or_successful_rollback() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/recovery";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let context = runtime_context(root, temp.path(), true);
    let mut core = open_core(&context, fs.clone()).await;
    let path = "/remote/recovery/new.txt";
    record_change(
        &mut core,
        fs.as_ref(),
        path,
        OperationType::Create,
        Some(b"new"),
    )
    .await;
    let mut state = revert_state();
    fs.fail_metadata.store(true, Ordering::SeqCst);
    assert!(core
        .prepare_workspace_revert("session", &mut state)
        .await
        .unwrap_err()
        .to_string()
        .contains("offline"));
    assert!(state.workspace_checkpoint.is_empty());
    fs.fail_metadata.store(false, Ordering::SeqCst);
    core.prepare_workspace_revert("session", &mut state)
        .await
        .unwrap();
    fs.fail_after_write.store(true, Ordering::SeqCst);
    assert!(core
        .apply_workspace_revert("session", &state)
        .await
        .unwrap_err()
        .to_string()
        .contains("disconnected"));
    fs.fail_remove.store(true, Ordering::SeqCst);
    assert!(core
        .apply_workspace_revert("session", &state)
        .await
        .unwrap_err()
        .to_string()
        .contains("remove failed"));
    assert!(fs.exists(path).await.unwrap());
    core.apply_workspace_revert("session", &state)
        .await
        .unwrap();
    assert!(!fs.exists(path).await.unwrap());
    core.restore_workspace_revert(&state).await.unwrap();
    assert_eq!(fs.read_file(path).await.unwrap(), b"new");
}

#[tokio::test]
async fn remote_paths_preserve_posix_case_and_literal_backslash_on_every_controller() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/CaseSensitive";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let context = runtime_context(root, temp.path(), true);
    let mut core = open_core(&context, fs.clone()).await;
    let paths = [
        r"/remote/CaseSensitive/a\b.txt",
        "/remote/CaseSensitive/a/b.txt",
        "/remote/CaseSensitive/A/b.txt",
    ];
    for (i, path) in paths.iter().enumerate() {
        let before = format!("before-{i}");
        fs.write_file(path, before.as_bytes()).await.unwrap();
        record_change(
            &mut core,
            fs.as_ref(),
            path,
            OperationType::Modify,
            Some(b"after"),
        )
        .await;
    }
    assert_eq!(core.get_session_files("session").len(), 3);
    let first_operation = core.get_session_operations_before("session", None)[0]
        .operation_id
        .clone();
    assert!(core
        .get_operation_diff_before(Path::new(paths[1]), "session", &first_operation, None)
        .await
        .is_err());
    let (_, _, anchor) = core
        .get_file_diff_with_anchor_before(
            Path::new(paths[1]),
            "session",
            Some(&first_operation),
            None,
        )
        .await
        .unwrap();
    assert!(
        anchor.is_none(),
        "POSIX backslash and separator paths must not share an operation anchor"
    );
    let locks = FileLockManager::new(context);
    for (i, path) in paths.iter().enumerate() {
        let lock = tokio::time::timeout(
            Duration::from_secs(2),
            locks.try_acquire_lock(&PathBuf::from(path), &format!("s{i}"), "Edit"),
        )
        .await
        .expect("lock persistence must not deadlock");
        assert!(lock.unwrap());
    }
    drop(core);
    let context = runtime_context(root, temp.path(), true);
    let mut core = open_core(&context, fs.clone()).await;
    for (i, path) in paths.iter().enumerate() {
        let baseline = core
            .get_baseline_snapshot_diff(Path::new(path))
            .await
            .unwrap();
        assert_eq!(baseline, (format!("before-{i}"), "after".into()));
    }
    core.rollback_session("session").await.unwrap();
    for (i, path) in paths.iter().enumerate() {
        assert_eq!(
            fs.read_file_text(path).await.unwrap(),
            format!("before-{i}")
        );
    }
}

#[tokio::test]
async fn connection_scoped_managers_do_not_read_legacy_or_other_profile_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/shared";
    let context = runtime_context(root, temp.path(), true);
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let path = "/remote/shared/file.txt";
    fs.write_file(path, b"first-user").await.unwrap();
    let alice = crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
        root,
        "alice",
        "shared-server",
        Some(&uuid::Uuid::new_v4().to_string()),
    )
    .await;
    let bob = crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
        root,
        "bob",
        "shared-server",
        Some(&uuid::Uuid::new_v4().to_string()),
    )
    .await;
    // Legacy data has no connection owner. Its presence must not make a fresh
    // profile inherit a previous profile's baseline or operations.
    let mut legacy = open_core(&context, fs.clone()).await;
    record_change(
        &mut legacy,
        fs.as_ref(),
        path,
        OperationType::Modify,
        Some(b"legacy"),
    )
    .await;
    let first =
        get_or_create_snapshot_manager_with_workspace(&alice.id, fs.clone(), context.clone(), None)
            .await
            .unwrap();
    assert!(first.get_session_files("session").await.unwrap().is_empty());
    let operation = first
        .record_file_change(
            "session",
            0,
            path.into(),
            OperationType::Modify,
            "Edit".into(),
        )
        .await
        .unwrap();
    fs.write_file(path, b"alice-only").await.unwrap();
    first
        .get_snapshot_service()
        .read()
        .await
        .complete_file_modification("session", &operation, 1)
        .await
        .unwrap();
    let second = open_snapshot_manager_for_workspace_view(&bob.id, None, context.clone())
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
    assert!(second
        .get_session_files("session")
        .await
        .unwrap()
        .is_empty());
    let same = open_snapshot_manager_for_workspace_view(&alice.id, None, context.clone())
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    clear_bound_snapshot_manager_for_test(&alice.id).await;
    let offline = open_snapshot_manager_for_workspace_view(&alice.id, None, context.clone())
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &offline));
    assert_eq!(
        offline
            .get_snapshot_service()
            .read()
            .await
            .get_file_diff("session", Path::new(path))
            .await
            .unwrap(),
        ("legacy".into(), "alice-only".into())
    );
    assert!(offline
        .get_snapshot_service()
        .read()
        .await
        .get_baseline_snapshot_diff(Path::new(path))
        .await
        .unwrap_err()
        .to_string()
        .contains("not explicitly bound"));
    let mismatch = crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
        root,
        "alice",
        "different-server",
        Some(&uuid::Uuid::new_v4().to_string()),
    )
    .await;
    assert!(
        get_or_create_snapshot_manager_with_workspace(&mismatch.id, fs, context.clone(), None)
            .await
            .is_err()
    );
    assert!(
        context
            .snapshot_operations_dir
            .join("session.json")
            .is_file(),
        "legacy metadata is preserved"
    );
}

#[tokio::test]
async fn remote_scope_rejects_parent_escape_and_unbound_local_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/scope";
    let context = runtime_context(root, temp.path(), true);
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let mut system = FileSnapshotSystem::with_workspace_fs(context.clone(), fs.clone());
    for path in [
        "/remote/scope/../secret",
        "/remote/scope-extra/file",
        "/remote/scope/.git/config",
        "/remote/scope//file",
    ] {
        assert!(
            system.create_snapshot(Path::new(path)).await.is_err(),
            "{path}"
        );
    }
    fs.symlinks
        .lock()
        .unwrap()
        .insert("/remote/scope/escape".into());
    assert!(system
        .create_snapshot(Path::new("/remote/scope/escape/private.txt"))
        .await
        .unwrap_err()
        .to_string()
        .contains("symbolic links"));
    let mut unbound = FileSnapshotSystem::new(context);
    assert!(unbound
        .create_snapshot(Path::new("/remote/scope/file"))
        .await
        .unwrap_err()
        .to_string()
        .contains("not explicitly bound"));
}

struct NoShell;

#[async_trait::async_trait]
impl WorkspaceShell for NoShell {
    async fn exec_with_options(
        &self,
        _command: &str,
        _options: WorkspaceCommandOptions,
    ) -> anyhow::Result<WorkspaceCommandResult> {
        anyhow::bail!("Snapshot file operations must not fall back to a shell")
    }
}

#[tokio::test]
async fn wrapped_remote_write_and_delete_produce_recorded_history_without_a_remote_runtime() {
    use crate::agentic::tools::framework::ToolUseContext;
    use crate::agentic::tools::implementations::delete_file_tool::DeleteFileTool;
    use crate::agentic::tools::implementations::file_write_tool::FileWriteTool;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use crate::infrastructure::PathManager;
    use crate::service::workspace_runtime::{
        set_workspace_runtime_service_for_current_test, WorkspaceRuntimeService,
    };
    use openbitfun_runtime_ports::{ToolRuntimeHandles, WorkspaceServices};

    let temp = tempfile::tempdir().unwrap();
    let runtime = Arc::new(WorkspaceRuntimeService::new(Arc::new(
        PathManager::with_user_root_for_tests(temp.path().join("user-root")),
    )));
    let _runtime_guard = set_workspace_runtime_service_for_current_test(runtime.clone());
    let root = "/remote/real-tool";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let identity = WorkspaceSessionIdentity {
        workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
        hostname: "shared-server".into(),
        logical_workspace_path: root.into(),
        remote_connection_id: Some("real-tool-connection".into()),
    };
    let workspace = crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
        root,
        "real-tool-connection",
        "shared-server",
        Some(&uuid::Uuid::new_v4().to_string()),
    )
    .await;
    let mut context = ToolUseContext {
        tool_call_id: Some("remote-write".into()),
        agent_type: None,
        session_id: Some("session".into()),
        dialog_turn_id: None,
        workspace: Some(WorkspaceBinding::new_remote(
            Some(workspace.id.clone()),
            PathBuf::from(root),
            "real-tool-connection".into(),
            "Shared server".into(),
            identity.clone(),
        )),
        loaded_deferred_tool_specs: Vec::new(),
        primary_model_facts: Default::default(),
        custom_data: HashMap::new(),
        computer_use_host: None,
        runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
        runtime_handles: ToolRuntimeHandles::new(
            Some(WorkspaceServices {
                fs: fs.clone(),
                shell: Arc::new(NoShell),
            }),
            None,
        ),
    };
    let write = wrap_tool_for_snapshot_tracking(Arc::new(FileWriteTool::new()));
    let results = write
        .call(
            &serde_json::json!({"payload": "+++ nested/file.txt\ncreated remotely"}),
            &context,
        )
        .await
        .unwrap();
    assert_eq!(
        results.last().unwrap().content().get("snapshot_recorded"),
        Some(&serde_json::Value::Bool(true))
    );
    assert_eq!(
        fs.read_file_text("/remote/real-tool/nested/file.txt")
            .await
            .unwrap(),
        "created remotely"
    );

    context.tool_call_id = Some("remote-delete".into());
    let delete = wrap_tool_for_snapshot_tracking(Arc::new(DeleteFileTool::new()));
    let results = delete
        .call(&serde_json::json!({"path": "nested/file.txt"}), &context)
        .await
        .unwrap();
    assert_eq!(
        results.last().unwrap().content().get("snapshot_recorded"),
        Some(&serde_json::Value::Bool(true))
    );
    assert!(!fs
        .exists("/remote/real-tool/nested/file.txt")
        .await
        .unwrap());

    clear_bound_snapshot_manager_for_test(&workspace.id).await;
    fs.fail_metadata.store(true, Ordering::SeqCst);
    let history = super::manager::open_snapshot_history_for_workspace(&workspace.id)
        .await
        .unwrap();
    let write_operation = history
        .get_snapshot_service()
        .read()
        .await
        .get_operation_summary("session", "remote-write")
        .await
        .unwrap();
    assert!(write_operation.before_snapshot_id.is_none());
    assert!(write_operation.after_snapshot_id.is_some());
    let delete_operation = history
        .get_snapshot_service()
        .read()
        .await
        .get_operation_summary("session", "remote-delete")
        .await
        .unwrap();
    assert!(delete_operation.before_snapshot_id.is_some());
    assert!(delete_operation.after_snapshot_id.is_none());
    let created = history
        .get_operation_diff_before(
            "session",
            "/remote/real-tool/nested/file.txt",
            "remote-write",
            None,
        )
        .await
        .unwrap();
    assert_eq!(created["original_content"], "");
    assert_eq!(created["modified_content"], "created remotely");
    let deleted = history
        .get_operation_diff_before(
            "session",
            "/remote/real-tool/nested/file.txt",
            "remote-delete",
            None,
        )
        .await
        .unwrap();
    assert_eq!(deleted["original_content"], "created remotely");
    assert_eq!(deleted["modified_content"], "");
}

#[tokio::test]
async fn operation_diff_is_exact_visible_and_available_after_cold_reload_for_either_backend() {
    for remote in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = if remote {
            "/remote/operation-diff".to_string()
        } else {
            temp.path().join("workspace").to_string_lossy().into_owned()
        };
        let fs: Arc<dyn WorkspaceFileSystem> = if remote {
            Arc::new(RemoteMemoryFs::new(&root))
        } else {
            Arc::new(LocalWorkspaceFs)
        };
        let context = runtime_context(&root, &temp.path().join("runtime"), remote);
        let path = fs.join_path(&root, &["file.txt"]);
        let other = fs.join_path(&root, &["other.txt"]);
        fs.write_file(&path, b"original\n").await.unwrap();
        let mut core = open_core(&context, fs.clone()).await;
        record_change(
            &mut core,
            fs.as_ref(),
            &path,
            OperationType::Modify,
            Some(b"first\n"),
        )
        .await;
        let first_operation = core.get_session_operations_before("session", None)[0]
            .operation_id
            .clone();
        let second_operation = core
            .start_file_operation(
                "session",
                1,
                PathBuf::from(&path),
                OperationType::Modify,
                "Edit".into(),
                serde_json::json!({}),
                None,
            )
            .await
            .unwrap();
        fs.write_file(&path, b"second\n").await.unwrap();
        core.complete_file_operation("session", &second_operation, 1)
            .await
            .unwrap();
        record_change(
            &mut core,
            fs.as_ref(),
            &other,
            OperationType::Create,
            Some(b"other file"),
        )
        .await;
        fs.write_file(&path, b"external change after the operation")
            .await
            .unwrap();

        // The remote cold reader intentionally has no filesystem provider.
        // These APIs must read only recorded controller-side blobs.
        drop(core);
        let system = FileSnapshotSystem::new(context.clone());
        let mut core = SnapshotCore::new(context.clone(), system);
        core.initialize().await.unwrap();
        let (before, after, anchor) = core
            .get_operation_diff_before(Path::new(&path), "session", &first_operation, Some(1))
            .await
            .unwrap();
        assert_eq!(
            (before.as_str(), after.as_str(), anchor),
            ("original\n", "first\n", Some(1))
        );
        let (before, after, _) = core
            .get_operation_diff_before(Path::new(&path), "session", &second_operation, None)
            .await
            .unwrap();
        assert_eq!((before.as_str(), after.as_str()), ("first\n", "second\n"));
        assert_eq!(
            core.get_file_diff_before(Path::new(&path), "session", None)
                .await
                .unwrap(),
            ("original\n".into(), "second\n".into())
        );
        assert!(core
            .get_operation_diff_before(Path::new(&other), "session", &first_operation, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("requested file"));
        assert!(core
            .get_operation_diff_before(Path::new(&path), "session", &second_operation, Some(1))
            .await
            .is_err());
        assert!(core
            .get_operation_diff_before(Path::new(&path), "other-session", &first_operation, None)
            .await
            .is_err());

        let first = core
            .get_operation_before("session", &first_operation, None)
            .unwrap();
        std::fs::remove_file(
            context
                .snapshot_metadata_dir
                .join(format!("{}.json", first.after_snapshot_id.unwrap())),
        )
        .unwrap();
        assert!(
            core.get_operation_diff_before(Path::new(&path), "session", &first_operation, None)
                .await
                .is_err(),
            "missing recorded content must not become an empty diff"
        );
    }
}

#[tokio::test]
async fn pending_delete_and_failed_completion_stay_unavailable_but_zero_ms_empty_delete_completes()
{
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/pending-delete";
    let path = "/remote/pending-delete/empty.txt";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let context = runtime_context(root, &temp.path().join("runtime"), true);
    fs.write_file(path, b"").await.unwrap();
    let mut core = open_core(&context, fs.clone()).await;
    let operation = core
        .start_file_operation(
            "session",
            0,
            path.into(),
            OperationType::Delete,
            "Delete".into(),
            serde_json::json!({}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        core.get_operation("session", &operation).unwrap().completed,
        Some(false)
    );
    assert!(core
        .get_operation_diff_before(Path::new(path), "session", &operation, None)
        .await
        .is_err());

    // Completion used to set execution_time_ms before this fallible workspace
    // read, which made a failed Delete look completed to history readers.
    fs.fail_metadata.store(true, Ordering::SeqCst);
    assert!(core
        .complete_file_operation("session", &operation, 123)
        .await
        .is_err());
    let pending = core.get_operation("session", &operation).unwrap();
    assert_eq!(pending.completed, Some(false));
    assert_eq!(pending.tool_context.execution_time_ms, 123);
    assert!(core.get_session_files("session").is_empty());
    assert!(core
        .get_operation_diff_before(Path::new(path), "session", &operation, None)
        .await
        .is_err());
    let mut cold = SnapshotService::new(root.into(), context.clone(), None);
    cold.initialize_for_view().await.unwrap();
    assert!(cold
        .get_operation_summary("session", &operation)
        .await
        .is_err());

    fs.fail_metadata.store(false, Ordering::SeqCst);
    fs.remove_file(path).await.unwrap();
    let completed = core
        .complete_file_operation("session", &operation, 0)
        .await
        .unwrap();
    assert_eq!(completed.completed, Some(true));
    assert_eq!(completed.diff_summary.lines_removed, 0);
    assert_eq!(core.get_session_files("session"), vec![PathBuf::from(path)]);
    drop(core);
    let mut cold = SnapshotService::new(root.into(), context, None);
    cold.initialize_for_view().await.unwrap();
    assert_eq!(
        cold.get_operation_summary("session", &operation)
            .await
            .unwrap()
            .completed,
        Some(true)
    );
    assert_eq!(
        cold.get_operation_diff_before("session", Path::new(path), &operation, None)
            .await
            .unwrap(),
        (String::new(), String::new(), Some(1))
    );
}

#[tokio::test]
async fn failed_completion_persistence_does_not_expose_after_snapshot_as_completed() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/failed-completion-persist";
    let path = "/remote/failed-completion-persist/file.txt";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let context = runtime_context(root, &temp.path().join("runtime"), true);
    fs.write_file(path, b"before\n").await.unwrap();
    let mut core = open_core(&context, fs.clone()).await;
    let operation = core
        .start_file_operation(
            "session",
            0,
            path.into(),
            OperationType::Modify,
            "Edit".into(),
            serde_json::json!({}),
            None,
        )
        .await
        .unwrap();
    fs.write_file(path, b"after\n").await.unwrap();

    let history = context.snapshot_operations_dir.join("session.json");
    let backup = temp.path().join("pending-session.json");
    std::fs::rename(&history, &backup).unwrap();
    std::fs::create_dir(&history).unwrap();
    assert!(core
        .complete_file_operation("session", &operation, 1)
        .await
        .is_err());
    let pending = core.get_operation("session", &operation).unwrap();
    assert!(pending.after_snapshot_id.is_some());
    assert_eq!(pending.completed, Some(false));
    assert!(core
        .get_operation_diff_before(Path::new(path), "session", &operation, None)
        .await
        .is_err());
    assert!(core.get_session_files("session").is_empty());

    // Restore only the test's temporary obstruction. The durable pre-operation
    // record must still reject completion after a cold load without SSH.
    std::fs::remove_dir(&history).unwrap();
    std::fs::rename(backup, history).unwrap();
    drop(core);
    let mut cold = SnapshotService::new(root.into(), context, None);
    cold.initialize_for_view().await.unwrap();
    assert!(cold
        .get_operation_summary("session", &operation)
        .await
        .is_err());
    assert!(cold
        .get_operation_diff_before("session", Path::new(path), &operation, None)
        .await
        .is_err());
}

#[tokio::test]
async fn legacy_operation_completion_round_trip_preserves_omission_and_recorded_diff() {
    let temp = tempfile::tempdir().unwrap();
    let root = "/remote/legacy-completion";
    let path = "/remote/legacy-completion/file.txt";
    let fs = Arc::new(RemoteMemoryFs::new(root));
    let context = runtime_context(root, &temp.path().join("runtime"), true);
    fs.write_file(path, b"before\n").await.unwrap();
    let mut core = open_core(&context, fs.clone()).await;
    record_change(
        &mut core,
        fs.as_ref(),
        path,
        OperationType::Modify,
        Some(b"after\n"),
    )
    .await;
    drop(core);

    let history = context.snapshot_operations_dir.join("session.json");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&history).unwrap()).unwrap();
    let operation_json = &mut legacy["turns"]["0"]["operations"][0];
    assert_eq!(
        operation_json.as_object_mut().unwrap().remove("completed"),
        Some(serde_json::json!(true))
    );
    let operation: FileOperation = serde_json::from_value(operation_json.clone()).unwrap();
    assert_eq!(operation.completed, None);
    assert_eq!(serde_json::to_value(&operation).unwrap(), *operation_json);
    std::fs::write(&history, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let mut cold = SnapshotService::new(root.into(), context, None);
    cold.initialize_for_view().await.unwrap();
    assert_eq!(
        cold.get_operation_summary("session", &operation.operation_id)
            .await
            .unwrap()
            .completed,
        None
    );
    assert_eq!(
        cold.get_operation_diff_before("session", Path::new(path), &operation.operation_id, None)
            .await
            .unwrap(),
        ("before\n".into(), "after\n".into(), Some(1))
    );
}
