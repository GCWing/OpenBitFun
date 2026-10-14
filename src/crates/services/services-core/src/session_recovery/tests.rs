use super::*;
use serde_json::json;

pub(super) struct Fixture {
    _temp: tempfile::TempDir,
    pub home: PathBuf,
    pub user: PathBuf,
    pub workspace: PathBuf,
    pub source: PathBuf,
    pub task: PathBuf,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join(".openbitfun");
        let user = temp.path().join("config");
        let workspace = temp.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let source = home.join("projects/legacy-collision/sessions/session-one");
        fs::create_dir_all(&source).unwrap();
        let task = temp.path().join("repair/task");
        let this = Self {
            _temp: temp,
            home,
            user,
            workspace,
            source,
            task,
        };
        this.registry(json!({"id":"w1","rootPath":this.workspace,"workspaceKind":"normal"}));
        let meta = crate::session::SessionMetadata::new(
            "session-one".into(),
            "Example".into(),
            "agent".into(),
            "model".into(),
        );
        let mut meta = serde_json::to_value(meta).unwrap();
        meta["workspaceId"] = json!("w1");
        meta["workspacePath"] = json!(this.workspace);
        this.put(&this.source.join("metadata.json"), meta);
        this.put(&this.source.join("state.json"), json!({"schema_version":2,"config":{"workspace_id":"w1","workspace_path":this.workspace,"permission_mode":"full_access","future_field":{"x":1}},"context":"preserve"}));
        this.put(
            &this.source.parent().unwrap().join("index.json"),
            json!({"old":"index"}),
        );
        fs::write(this.source.join("turn.bin"), [0, 1, 255, 10]).unwrap();
        fs::write(
            this.source
                .parent()
                .unwrap()
                .join("product-search-v1.sqlite"),
            b"rebuildable search cache",
        )
        .unwrap();
        this
    }
    fn put(&self, path: &Path, value: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, encode(&value).unwrap()).unwrap();
    }
    fn registry(&self, record: Value) {
        self.put(&self.user.join("data/workspace_data.json"),json!({"format_version":1,"product_id":"openbitfun","workspaces":{record["id"].as_str().unwrap():record}}));
    }
    fn plan(&self) -> RepairPlan {
        scan(&self.home, &self.user, || false).unwrap()
    }
    pub(super) fn prepare(&self) -> RepairPlan {
        let plan = self.plan();
        save_plan(&self.task, &plan).unwrap();
        plan
    }
}
#[test]
fn misplaced_session_round_trip_keeps_every_byte_and_rebuilds_owner_index() {
    let f = Fixture::new();
    let before = tree_hash(&f.source, &BTreeMap::new()).unwrap();
    let old_index = read(&f.source.parent().unwrap().join("index.json")).unwrap();
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    assert!(f.source.exists());
    assert!(!plan.operations[0].target.exists());
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    assert_eq!(task_phase(&f.task).unwrap(), "completed");
    let target = &plan.operations[0].target;
    assert!(!f
        .source
        .parent()
        .unwrap()
        .join("product-search-v1.sqlite")
        .exists());
    assert_eq!(tree_hash(target, &BTreeMap::new()).unwrap(), before);
    let index: crate::session::StoredSessionIndexFile =
        serde_json::from_slice(&read(&target.parent().unwrap().join("index.json")).unwrap())
            .unwrap();
    assert_eq!(index.metadata_file_count, 1);
    assert_eq!(index.sessions[0].session_id, "session-one");
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    assert_eq!(tree_hash(&f.source, &BTreeMap::new()).unwrap(), before);
    assert!(!target.exists());
    assert_eq!(
        read(&f.source.parent().unwrap().join("index.json")).unwrap(),
        old_index
    );
    assert_eq!(
        read(&f.source.parent().unwrap().join("product-search-v1.sqlite")).unwrap(),
        b"rebuildable search cache"
    );
}
#[test]
fn assistant_alias_repairs_only_existing_fields_and_preserves_permissions() {
    let f = Fixture::new();
    let root = f.home.join("personal_assistant/workspace-named");
    fs::create_dir_all(&root).unwrap();
    let old = f
        .home
        .with_file_name(".bitfun")
        .join("personal_assistant/workspace-named");
    let old_id = crate::workspace_identity::local_workspace_stable_storage_id(
        &old.to_str().unwrap().replace('\\', "/"),
    );
    f.registry(json!({"id":"new-assistant","rootPath":root,"workspaceKind":"assistant"}));
    let mut meta = json(&f.source.join("metadata.json")).unwrap();
    meta.as_object_mut().unwrap().remove("workspaceId");
    meta["workspacePath"] = json!(old);
    f.put(&f.source.join("metadata.json"), meta);
    let state = json!({"config":{"workspace_id":old_id,"workspace_path":old,"permission_mode":"full_access","future":{"a":2}}});
    f.put(&f.source.join("state.json"), state.clone());
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(plan.operations[0].identity_changes.len(), 3);
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    let target = &plan.operations[0].target;
    let repaired = json(&target.join("state.json")).unwrap();
    assert_eq!(repaired["config"]["workspace_id"], "new-assistant");
    assert_eq!(repaired["config"]["permission_mode"], "full_access");
    assert_eq!(repaired["config"]["future"], state["config"]["future"]);
    assert!(json(&target.join("metadata.json"))
        .unwrap()
        .get("workspaceId")
        .is_none());
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    assert_eq!(json(&f.source.join("state.json")).unwrap(), state);
}
#[test]
fn remote_mirror_repairs_offline_without_local_posix_directory() {
    let mut f = Fixture::new();
    let legacy_mirror = f
        .home
        .join("remote_ssh/host.example/home/user/project/sessions/session-one");
    fs::create_dir_all(legacy_mirror.parent().unwrap()).unwrap();
    fs::rename(&f.source, &legacy_mirror).unwrap();
    f.source = legacy_mirror;
    f.registry(json!({"id":"remote_test","rootPath":"/home/user/project","workspaceKind":"remote","metadata":{"sshHost":"host.example","connectionId":"ssh-user@host.example"}}));
    let mut meta = json(&f.source.join("metadata.json")).unwrap();
    meta["workspaceId"] = json!("remote_test");
    meta["workspacePath"] = json!("/home/user/project");
    meta["workspaceHostname"] = json!("host.example");
    f.put(&f.source.join("metadata.json"), meta);
    f.put(&f.source.join("state.json"),json!({"config":{"workspace_id":"remote_test","workspace_path":"/home/user/project","workspace_kind":"remote","remote_ssh_host":"host.example","remote_connection_id":"ssh-user@host.example:22"}}));
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(
        plan.operations[0]
            .target
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap(),
        crate::workspace_identity::remote_workspace_runtime_key(
            "host.example",
            "/home/user/project"
        )
        .as_str()
    );
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
}
#[test]
fn missing_ids_use_unique_path_but_are_never_materialized() {
    let f = Fixture::new();
    for name in ["metadata.json", "state.json"] {
        let mut raw = json(&f.source.join(name)).unwrap();
        if name == "metadata.json" {
            raw.as_object_mut().unwrap().remove("workspaceId");
        } else {
            raw["config"]
                .as_object_mut()
                .unwrap()
                .remove("workspace_id");
        }
        f.put(&f.source.join(name), raw);
    }
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    assert!(plan.operations[0].updates.is_empty());
    apply(&f.task, || false, |_, _, _| {}).unwrap();
}
#[test]
fn stale_session_registry_catalog_and_backup_refuse_mutation() {
    for what in ["session", "registry", "catalog"] {
        let f = Fixture::new();
        let plan = f.prepare();
        match what {
            "session" => fs::write(f.source.join("turn.bin"), "changed").unwrap(),
            "registry" => f.registry(json!({"id":"other","rootPath":f.workspace})),
            _ => {
                let neighbor = f.source.with_file_name("neighbor");
                fs::create_dir_all(&neighbor).unwrap();
                fs::write(neighbor.join("metadata.json"), "{}").unwrap();
            }
        }
        assert!(apply(&f.task, || false, |_, _, _| {}).is_err());
        assert!(f.source.exists());
        assert!(!plan.operations[0].target.exists());
    }
    let f = Fixture::new();
    let plan = f.prepare();
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    fs::write(f.task.join("sessions/0/turn.bin"), "tamper").unwrap();
    assert!(rollback(&f.task, || false, |_, _, _| {}).is_err());
    assert!(plan.operations[0].target.exists());
}
#[test]
fn interrupted_move_resumes_or_rolls_back() {
    for resume in [true, false] {
        let f = Fixture::new();
        let plan = f.prepare();
        // Stop after the whole-session rename but before index publication.
        let cancel = std::cell::Cell::new(false);
        let result = apply(
            &f.task,
            || cancel.get(),
            |_, _, phase| {
                if phase == "repairing_sessions" {
                    cancel.set(true);
                }
            },
        );
        assert!(result.is_err());
        assert!(plan.operations[0].target.exists());
        assert_eq!(task_phase(&f.task).unwrap(), "prepared");
        if resume {
            apply(&f.task, || false, |_, _, _| {}).unwrap();
        }
        rollback(&f.task, || false, |_, _, _| {}).unwrap();
        assert!(f.source.exists());
    }
}
#[test]
fn snapshots_shared_history_revert_blobs_copy_and_rollback_only_created_assets() {
    let f = Fixture::new();
    let snapshots = f
        .source
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("snapshots");
    f.put(
        &snapshots.join("operations/session-one.json"),
        json!({"session_id":"session-one","operations":[{"snapshot_id":"snap-one"}]}),
    );
    f.put(
        &snapshots.join("metadata/snap-one.json"),
        json!({"snapshot_id":"snap-one","content_hash":"0123456789abcdef0123456789abcdef"}),
    );
    fs::create_dir_all(snapshots.join("by_hash")).unwrap();
    fs::write(
        snapshots.join("by_hash/0123456789abcdef0123456789abcdef.snap"),
        "blob",
    )
    .unwrap();
    f.put(
        &f.source.join("session-revert.json"),
        json!({"workspaceCheckpoint":[{"snapshotId":"snap-one"}]}),
    );
    let plan = f.prepare();
    assert_eq!(plan.operations[0].assets.len(), 3);
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    for asset in &plan.operations[0].assets {
        assert!(asset.source.exists() && asset.target.exists());
    }
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    for asset in &plan.operations[0].assets {
        assert!(asset.source.exists() && !asset.target.exists());
    }
}
#[test]
fn ambiguous_unknown_conflicting_and_missing_snapshot_sessions_are_diagnostics() {
    for reason in ["unknown", "conflicting", "snapshot", "neighbor"] {
        let f = Fixture::new();
        match reason {
            "unknown" => {
                let mut value = json(&f.source.join("state.json")).unwrap();
                value["config"]["workspace_id"] = json!("unknown");
                f.put(&f.source.join("state.json"), value);
            }
            "conflicting" => {
                let target = f
                    .home
                    .join("projects")
                    .join(crate::workspace_identity::local_workspace_runtime_key(
                        &crate::workspace_identity::normalize_local_workspace_root_for_stable_id(
                            &f.workspace,
                        )
                        .unwrap(),
                    ))
                    .join("sessions/session-one");
                fs::create_dir_all(target).unwrap();
            }
            "snapshot" => f.put(
                &f.source.join("session-revert.json"),
                json!({"snapshotId":"missing"}),
            ),
            _ => {
                let neighbor = f.source.with_file_name("bad");
                f.put(&neighbor.join("metadata.json"), json!({}));
            }
        }
        let plan = f.plan();
        assert!(plan.operations.is_empty());
        assert!(plan.diagnostics.iter().any(|d| d.status == "skipped"));
    }
}

#[test]
fn remote_scoped_snapshots_use_canonical_connection_and_leave_legacy_scope_untouched() {
    let f = Fixture::new();
    f.registry(json!({"id":"remote_test","rootPath":"/home/user/project","workspaceKind":"remote","metadata":{"sshHost":"host.example","connectionId":"ssh-user@host.example"}}));
    let mut meta = json(&f.source.join("metadata.json")).unwrap();
    meta["workspaceId"] = json!("remote_test");
    meta["workspacePath"] = json!("/home/user/project");
    meta["workspaceHostname"] = json!("host.example");
    f.put(&f.source.join("metadata.json"), meta);
    f.put(&f.source.join("state.json"),json!({"config":{"workspace_id":"remote_test","workspace_path":"/home/user/project","workspace_kind":"remote","remote_ssh_host":"host.example","remote_connection_id":"ssh-user@host.example:22"}}));
    let runtime = f.source.parent().unwrap().parent().unwrap();
    let scope = hash(
        &serde_json::to_vec(&(
            "host.example",
            "/home/user/project",
            Some("ssh-user@host.example"),
        ))
        .unwrap(),
    );
    let snapshots = runtime.join("snapshots/workspace-identities").join(&scope);
    f.put(
        &snapshots.join("operations/session-one.json"),
        json!({"session_id":"session-one","snapshot_id":"snap-one"}),
    );
    f.put(&snapshots.join("metadata/snap-one.json"),json!({"snapshot_id":"snap-one","content_hash":"0123456789abcdef0123456789abcdef","compressed_content":[1,2,3]}));
    f.put(
        &runtime.join("snapshots/operations/session-one.json"),
        json!({"legacy":"do not copy"}),
    );
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(plan.operations[0].assets.len(), 2);
    assert!(plan.operations[0]
        .assets
        .iter()
        .all(|a| a.source.to_string_lossy().contains(&scope)));
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    assert_eq!(
        json(&runtime.join("snapshots/operations/session-one.json")).unwrap(),
        json!({"legacy":"do not copy"})
    );
}

#[test]
fn legacy_metadata_aliases_hide_subagents_and_reject_unknown_schema_versions() {
    let f = Fixture::new();
    let mut meta = json(&f.source.join("metadata.json")).unwrap();
    for (camel, snake) in [
        ("sessionId", "session_id"),
        ("sessionName", "session_name"),
        ("workspacePath", "workspace_path"),
        ("workspaceId", "workspace_id"),
    ] {
        let value = meta.as_object_mut().unwrap().remove(camel).unwrap();
        meta[snake] = value;
    }
    meta["sessionKind"] = json!("subagent");
    f.put(&f.source.join("metadata.json"), meta);
    let plan = f.prepare();
    assert_eq!(plan.operations.len(), 1);
    apply(&f.task, || false, |_, _, _| {}).unwrap();
    let target = &plan.operations[0].target;
    let index = json(&target.parent().unwrap().join("index.json")).unwrap();
    assert_eq!(index["metadata_file_count"], 1);
    assert_eq!(index["sessions"], json!([]));
    rollback(&f.task, || false, |_, _, _| {}).unwrap();
    let mut state = json(&f.source.join("state.json")).unwrap();
    state["schema_version"] = json!("unknown");
    f.put(&f.source.join("state.json"), state);
    let plan = f.plan();
    assert!(plan.operations.is_empty());
    assert!(plan
        .diagnostics
        .iter()
        .any(|d| d.reason.as_deref() == Some("Unsupported session state")));
}
