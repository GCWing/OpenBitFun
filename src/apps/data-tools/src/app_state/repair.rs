use super::*;
use openbitfun_services_core::session_recovery as recovery;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairLocations {
    pub home: PathBuf,
    pub user_root: PathBuf,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairTask {
    pub run_id: String,
    pub phase: String,
    pub readable: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairAction {
    pub session_name: String,
    pub session_id: String,
    pub source: PathBuf,
    pub target: PathBuf,
    pub identity_changes: Vec<recovery::IdentityChange>,
    pub snapshot_files: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairView {
    pub locations: RepairLocations,
    pub saved_tasks: Vec<RepairTask>,
    pub run_id: Option<String>,
    pub backup_path: Option<PathBuf>,
    pub phase: String,
    pub actions: Vec<RepairAction>,
    pub diagnostics: Vec<recovery::RepairDiagnostic>,
    pub processed: usize,
    pub total: usize,
    pub active: bool,
    pub current_path: Option<PathBuf>,
}
fn tasks_root(settings: &Path) -> PathBuf {
    settings.parent().unwrap().join("session-repairs")
}
fn task_path(settings: &Path, run_id: &str) -> Result<PathBuf, CommandError> {
    let id = uuid::Uuid::parse_str(run_id)
        .map_err(|_| CommandError::new("invalid_repair_task", "Invalid repair task ID.", false))?;
    if id.to_string() != run_id {
        return Err(CommandError::new(
            "invalid_repair_task",
            "Invalid repair task ID.",
            false,
        ));
    }
    Ok(tasks_root(settings).join(run_id))
}
fn tasks(settings: &Path) -> Vec<RepairTask> {
    let mut result = vec![];
    if let Ok(entries) = std::fs::read_dir(tasks_root(settings)) {
        for entry in entries.flatten() {
            let run_id = entry.file_name().to_string_lossy().to_string();
            if task_path(settings, &run_id).is_err() {
                continue;
            }
            let phase = recovery::read_plan(&entry.path())
                .and_then(|_| recovery::task_phase(&entry.path()));
            result.push(RepairTask {
                run_id,
                readable: phase.is_ok(),
                phase: phase.unwrap_or_else(|_| "unreadable".into()),
            });
        }
    }
    result.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    result
}
pub(super) fn bootstrap(roots: &MigrationRoots, settings: &Path) -> RepairView {
    let defaults = RepairLocations {
        home: roots.target_home_root.clone(),
        user_root: roots.target_user_root.clone(),
    };
    let locations = std::fs::read(settings.parent().unwrap().join("repair-locations.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or(defaults);
    RepairView {
        locations,
        saved_tasks: tasks(settings),
        run_id: None,
        backup_path: None,
        phase: "idle".into(),
        actions: vec![],
        diagnostics: vec![],
        processed: 0,
        total: 0,
        active: false,
        current_path: None,
    }
}
fn update_view(
    view: &mut RepairView,
    plan: &recovery::RepairPlan,
    run_id: String,
    path: PathBuf,
    phase: String,
) {
    view.locations = RepairLocations {
        home: plan.home.clone(),
        user_root: plan.user_root.clone(),
    };
    view.run_id = Some(run_id);
    view.backup_path = Some(path);
    view.phase = phase;
    view.actions = plan
        .operations
        .iter()
        .map(|o| RepairAction {
            session_name: o.session_name.clone(),
            session_id: o.session_id.clone(),
            source: o.source.clone(),
            target: o.target.clone(),
            identity_changes: o.identity_changes.clone(),
            snapshot_files: o.assets.len(),
        })
        .collect();
    view.diagnostics = plan.diagnostics.clone();
    view.total = view.actions.len();
    view.processed = 0;
    view.current_path = None;
}
fn failure(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("session_repair_failed", &error.to_string(), true)
}

impl DataToolsCoordinator {
    pub(crate) fn scan_repair(
        &self,
        home: PathBuf,
        user_root: PathBuf,
    ) -> Result<DataToolsView, CommandError> {
        let (task, run_id, cancel) = {
            let mut session = self.lock();
            if session.running {
                return Err(CommandError::operation_in_progress());
            }
            if !home.is_absolute() || !user_root.is_absolute() {
                return Err(failure("Repair locations must be absolute paths."));
            }
            let locations = RepairLocations {
                home: home.clone(),
                user_root: user_root.clone(),
            };
            atomic_write_json(
                &session
                    .settings_path
                    .parent()
                    .unwrap()
                    .join("repair-locations.json"),
                &locations,
            )
            .map_err(|e| failure(e))?;
            let run_id = uuid::Uuid::new_v4().to_string();
            let task = task_path(&session.settings_path, &run_id)?;
            session.cancellation = CancellationToken::default();
            session.running = true;
            session.error = None;
            session.blockers.clear();
            session.progress = None;
            session.repair.locations = locations;
            session.repair.active = true;
            session.repair.phase = "scanning".into();
            session.repair.run_id = None;
            session.repair.actions.clear();
            session.repair.diagnostics.clear();
            session.repair.backup_path = None;
            (task, run_id, session.cancellation.clone())
        };
        let coordinator = self.clone();
        self.spawn_worker("session-repair-scan", move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let progress = |processed, total, phase: &str, path: &Path| {
                    let mut session = coordinator.lock();
                    session.repair.processed = processed;
                    session.repair.total = total;
                    session.repair.phase = phase.into();
                    session.repair.current_path = Some(path.into());
                };
                let plan = recovery::scan_with_progress(
                    &home,
                    &user_root,
                    || cancel.is_cancelled(),
                    progress,
                )
                .map_err(failure)?;
                recovery::save_plan(&task, &plan).map_err(failure)?;
                Ok::<_, CommandError>(plan)
            }))
            .unwrap_or_else(|_| Err(CommandError::worker_failed()));
            let mut session = coordinator.lock();
            if let Ok(plan) = result.as_ref() {
                update_view(&mut session.repair, plan, run_id, task, "planned".into());
            } else {
                session.repair.phase = if cancel.is_cancelled() {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
            }
            session.error = result.err();
            session.running = false;
            session.repair.active = false;
            session.repair.saved_tasks = tasks(&session.settings_path);
        })
    }
    pub(crate) fn load_repair(&self, run_id: &str) -> Result<DataToolsView, CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        let task = task_path(&session.settings_path, run_id)?;
        let plan = recovery::read_plan(&task).map_err(failure)?;
        let phase = recovery::task_phase(&task).map_err(failure)?;
        update_view(&mut session.repair, &plan, run_id.into(), task, phase);
        session.error = None;
        session.repair.active = false;
        Ok(snapshot(&session))
    }
    pub(crate) fn execute_repair(
        &self,
        run_id: &str,
        rollback: bool,
    ) -> Result<DataToolsView, CommandError> {
        let (task, cancel) = {
            let mut session = self.lock();
            if session.running {
                return Err(CommandError::operation_in_progress());
            }
            if session.repair.run_id.as_deref() != Some(run_id) {
                return Err(failure(
                    "Review the selected repair task before continuing.",
                ));
            }
            let task = task_path(&session.settings_path, run_id)?;
            let phase = recovery::task_phase(&task).map_err(failure)?;
            if rollback && phase == "planned"
                || !rollback
                    && ["rolling_back", "rolled_back", "completed"].contains(&phase.as_str())
            {
                return Err(failure(
                    "This repair task cannot perform the selected action.",
                ));
            }
            if !rollback && session.repair.actions.is_empty() {
                return Err(failure("This scan has no repair actions."));
            }
            session.cancellation = CancellationToken::default();
            session.running = true;
            session.repair.active = true;
            session.error = None;
            session.progress = None;
            session.repair.phase = "waiting_for_processes".into();
            session.repair.processed = 0;
            (task, session.cancellation.clone())
        };
        let coordinator = self.clone();
        self.spawn_worker("session-repair-execute", move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                loop {
                    if cancel.is_cancelled() {
                        return Err(failure("Repair cancelled at a safe boundary."));
                    }
                    // Includes other Data Tools processes; current PID is ignored.
                    let blockers =
                        openbitfun_legacy_migration::blocking_writer_processes_for_product(
                            0,
                            &["openbitfun-data-tools", "openbitfun-data-migrator"],
                        )
                        .map_err(failure)?;
                    let stopped = blockers.is_empty();
                    coordinator.lock().blockers = blockers;
                    if stopped {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                let progress = |processed, total, phase: &str| {
                    let mut session = coordinator.lock();
                    session.repair.processed = processed;
                    session.repair.total = total;
                    session.repair.phase = phase.into();
                };
                if rollback {
                    recovery::rollback(&task, || cancel.is_cancelled(), progress).map_err(failure)
                } else {
                    recovery::apply(&task, || cancel.is_cancelled(), progress).map_err(failure)
                }
            }))
            .unwrap_or_else(|_| Err(CommandError::worker_failed()));
            let mut session = coordinator.lock();
            session.repair.phase = recovery::task_phase(&task).unwrap_or_else(|_| "failed".into());
            session.error = result.err();
            session.running = false;
            session.repair.active = false;
            session.repair.saved_tasks = tasks(&session.settings_path);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_scan_creates_durable_task_and_reloads_without_legacy_install() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let mut roots = MigrationRoots::current_user_locations().unwrap();
        roots.legacy_home_root = base.join("legacy-home");
        roots.legacy_user_root = base.join("legacy-config");
        roots.legacy_skills_root = base.join("legacy-skills");
        roots.legacy_ssh_root = base.join("legacy-ssh");
        roots.target_home_root = base.join("home");
        roots.target_user_root = base.join("config");
        roots.target_skills_root = base.join("skills");
        roots.target_ssh_root = base.join("ssh");
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        atomic_write_json(&roots.target_user_root.join("data/workspace_data.json"), &serde_json::json!({"format_version":1,"product_id":"openbitfun","workspaces":{"workspace-1":{"id":"workspace-1","rootPath":workspace,"workspaceKind":"normal"}}})).unwrap();
        let source = roots
            .target_home_root
            .join("projects/legacy/sessions/session-1");
        let metadata = openbitfun_services_core::session::SessionMetadata::new(
            "session-1".into(),
            "Fixture".into(),
            "agent".into(),
            "model".into(),
        );
        let mut metadata = serde_json::to_value(metadata).unwrap();
        metadata["workspaceId"] = serde_json::json!("workspace-1");
        metadata["workspacePath"] = serde_json::json!(workspace);
        atomic_write_json(&source.join("metadata.json"), &metadata).unwrap();
        let settings = base.join("tool/locations.json");
        let coordinator = DataToolsCoordinator::bootstrap_with(roots.clone(), settings.clone());
        assert!(coordinator.snapshot().source.is_none());
        coordinator
            .scan_repair(
                roots.target_home_root.clone(),
                roots.target_user_root.clone(),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while coordinator.is_running() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let view = coordinator.snapshot();
        assert!(view.error.is_none(), "{:?}", view.error);
        assert_eq!(view.repair.phase, "planned");
        assert_eq!(view.repair.actions.len(), 1);
        assert!(source.exists());
        assert!(!view.repair.actions[0].target.exists());
        let run_id = view.repair.run_id.unwrap();
        let restarted = DataToolsCoordinator::bootstrap_with(roots, settings);
        assert!(restarted
            .snapshot()
            .repair
            .saved_tasks
            .iter()
            .any(|t| t.run_id == run_id));
        assert_eq!(
            restarted.load_repair(&run_id).unwrap().repair.actions.len(),
            1
        );
    }
    #[test]
    fn repair_available_without_legacy_source_and_shares_operation_guard() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let mut roots = MigrationRoots::current_user_locations().unwrap();
        roots.legacy_home_root = base.join("missing");
        roots.legacy_user_root = base.join("missing-config");
        roots.target_home_root = base.join("home");
        roots.target_user_root = base.join("config");
        let coordinator =
            DataToolsCoordinator::bootstrap_with(roots, base.join("tool/locations.json"));
        assert!(!coordinator.snapshot().repair.active);
        coordinator.lock().running = true;
        assert!(coordinator
            .scan_repair(base.join("home"), base.join("config"))
            .is_err());
        assert!(coordinator.load_repair("../../escape").is_err());
        assert!(coordinator.finish().is_err());
    }
    #[test]
    fn task_selection_cannot_escape_tool_history() {
        assert!(task_path(Path::new("/settings/locations.json"), "../outside").is_err());
    }
}
