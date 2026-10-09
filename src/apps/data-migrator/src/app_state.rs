use openbitfun_legacy_migration::{
    atomic_write_json, blocking_writer_processes, export_failure_diagnostics, list_tasks,
    load_task, probe_legacy_source, save_task, CancellationToken, LegacyMigrationError,
    LegacyMigrationResult, MigrationEngine, MigrationLayout, MigrationRoots, NoCrashInjection,
    ProbeLimits, ResetDirectory, SavedMigrationTask, TargetResetResult, WriterProcess,
};
use openbitfun_legacy_migration_adapters::adapters_for_groups;
use openbitfun_product_domains::legacy_migration::{
    FindingSeverity, LegacySourceDescriptor, MigrationPhase, MigrationPlan, MigrationProgressEvent,
    MigrationRunReport, MigrationRunStatus, MigrationSelection, ScanFinding,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[derive(Debug, Clone)]
struct TaskRequest {
    run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

impl CommandError {
    fn new(code: &str, message: &str, recoverable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            recoverable,
        }
    }

    pub(crate) fn worker_failed() -> Self {
        Self::new(
            "worker_failed",
            "The migration worker stopped before returning a result.",
            true,
        )
    }

    fn operation_in_progress() -> Self {
        Self::new(
            "operation_in_progress",
            "Another migration operation is still running.",
            true,
        )
    }

    fn from_legacy(error: &LegacyMigrationError) -> Self {
        match error {
            LegacyMigrationError::PathUnavailable(_) => Self::new(
                "path_unavailable",
                "A required data location is unavailable for the current user.",
                true,
            ),
            LegacyMigrationError::SourceEqualsTarget(_) => Self::new(
                "source_equals_target",
                "The legacy and OpenBitFun data locations are not safely separated.",
                false,
            ),
            LegacyMigrationError::UnsupportedSource(_) => Self::new(
                "unsupported_source",
                "This legacy BitFun data format is not supported by this migrator.",
                false,
            ),
            LegacyMigrationError::UnsupportedTarget(_) => Self::new(
                "unsupported_target",
                "The destination data format is not supported. Use a compatible migrator or an empty destination.",
                true,
            ),
            LegacyMigrationError::InvalidRequest(_) => Self::new(
                "invalid_task",
                "The selected migration task or data locations are invalid.",
                false,
            ),
            LegacyMigrationError::InvalidPlan(_) => Self::new(
                "invalid_plan",
                "The saved migration plan no longer matches this request or source.",
                true,
            ),
            LegacyMigrationError::PathEscape(_) | LegacyMigrationError::LinkedPath(_) => Self::new(
                "unsafe_source_path",
                "Migration stopped because a source path failed its safety check.",
                false,
            ),
            LegacyMigrationError::ResourceLimit(_) => Self::new(
                "resource_limit",
                "Migration stopped at a configured safety limit.",
                true,
            ),
            LegacyMigrationError::LockUnavailable => Self::new(
                "migration_locked",
                "Another migration process currently owns the migration lock.",
                true,
            ),
            LegacyMigrationError::Cancelled => Self::new(
                "cancelled",
                "Migration was cancelled at a safe boundary.",
                true,
            ),
            LegacyMigrationError::ProcessInspection(_) => Self::new(
                "process_inspection_failed",
                "OpenBitFun could not verify that all data-writing processes have stopped.",
                true,
            ),
            LegacyMigrationError::UntrustedExecutable(_)
            | LegacyMigrationError::TrustedInstallationUnavailable(_) => Self::new(
                "trusted_installation_unavailable",
                "The signed OpenBitFun installation could not be verified.",
                true,
            ),
            LegacyMigrationError::InjectedCrash(_) => Self::new(
                "migration_interrupted",
                "Migration was interrupted and can be resumed from its journal.",
                true,
            ),
            LegacyMigrationError::Domain { .. } => Self::new(
                "domain_failed",
                "One migration domain failed validation. Other verified domains remain intact.",
                true,
            ),
            LegacyMigrationError::Io { .. }
            | LegacyMigrationError::Json { .. }
            | LegacyMigrationError::Sqlite { .. } => Self::new(
                "storage_failed",
                "Migration could not safely read or write one of its data stores.",
                true,
            ),
        }
    }

    fn from_report_failure(report: &MigrationRunReport) -> Option<Self> {
        let diagnostic = report.diagnostics.iter().rev().find(|diagnostic| {
            diagnostic.severity == FindingSeverity::Blocking
                && diagnostic.domain.is_some()
                && diagnostic.code.starts_with("domain_")
        })?;
        let mut message = diagnostic.message.clone();
        if let Some(action) = diagnostic.action.as_deref() {
            if !message.is_empty() && !message.ends_with(char::is_whitespace) {
                message.push(' ');
            }
            message.push_str(action);
        }
        Some(Self {
            code: diagnostic.code.clone(),
            message,
            recoverable: true,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigratorView {
    pub tool_version: String,
    pub locations: MigrationRoots,
    pub saved_tasks: Vec<SavedMigrationTask>,
    pub source: Option<LegacySourceDescriptor>,
    pub selection: MigrationSelection,
    pub findings: Vec<ScanFinding>,
    pub plan: Option<MigrationPlan>,
    pub report: Option<MigrationRunReport>,
    pub workspace_counts: Option<openbitfun_legacy_migration_adapters::WorkspaceReportCounts>,
    pub progress: Option<MigrationProgressEvent>,
    pub blockers: Vec<WriterProcess>,
    pub status: MigrationRunStatus,
    pub running: bool,
    pub can_execute: bool,
    pub recovery: bool,
    pub error: Option<CommandError>,
    pub reset_preview: Option<ResetPreviewView>,
    pub reset_result: Option<TargetResetResult>,
    pub resetting: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetPreviewView {
    pub confirmation_id: String,
    pub directories: Vec<ResetDirectory>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsExportView {
    pub file_path: String,
}

#[derive(Debug)]
struct MigratorSession {
    roots: MigrationRoots,
    request: TaskRequest,
    recovery: bool,
    saved_tasks: Vec<SavedMigrationTask>,
    settings_path: PathBuf,
    source: Option<LegacySourceDescriptor>,
    selection: MigrationSelection,
    findings: Vec<ScanFinding>,
    plan: Option<MigrationPlan>,
    report: Option<MigrationRunReport>,
    progress: Option<MigrationProgressEvent>,
    blockers: Vec<WriterProcess>,
    status: MigrationRunStatus,
    running: bool,
    error: Option<CommandError>,
    cancellation: CancellationToken,
    reset_preview: Option<ResetPreviewView>,
    reset_result: Option<TargetResetResult>,
    resetting: bool,
}

#[derive(Clone)]
pub(crate) struct MigratorCoordinator {
    session: Arc<Mutex<MigratorSession>>,
}

impl MigratorCoordinator {
    pub(crate) fn bootstrap(settings_path: PathBuf) -> LegacyMigrationResult<Self> {
        let defaults = MigrationRoots::current_user_locations()?;
        let layout = MigrationLayout::new(&defaults, "preferences");
        let saved = layout.read_json::<MigrationRoots>(&settings_path);
        let (roots, error) = match saved {
            Ok(Some(roots)) => (roots, None),
            Ok(None) => (defaults, None),
            Err(error) => (defaults, Some(CommandError::from_legacy(&error))),
        };
        let coordinator = Self::bootstrap_with(roots, settings_path);
        if let Some(error) = error {
            coordinator.lock().error = Some(error);
        }
        Ok(coordinator)
    }

    fn bootstrap_with(roots: MigrationRoots, settings_path: PathBuf) -> Self {
        let probe = crate::locations::validate(&roots)
            .and_then(|_| probe_legacy_source(&roots, ProbeLimits::default()));
        let (source, mut error) = match probe {
            Ok(source) => (source, None),
            Err(error) => (None, Some(CommandError::from_legacy(&error))),
        };
        let saved_tasks = match list_tasks(&roots) {
            Ok(tasks) => tasks,
            Err(failure) => {
                error = Some(CommandError::from_legacy(&failure));
                Vec::new()
            }
        };
        Self {
            session: Arc::new(Mutex::new(MigratorSession {
                roots,
                settings_path,
                saved_tasks,
                request: TaskRequest {
                    run_id: uuid::Uuid::new_v4().to_string(),
                },
                recovery: false,
                status: if source.is_some() {
                    MigrationRunStatus::Discovered
                } else {
                    MigrationRunStatus::default()
                },
                source,
                error,
                selection: MigrationSelection::all(),
                findings: Vec::new(),
                plan: None,
                report: None,
                progress: None,
                blockers: Vec::new(),
                running: false,
                cancellation: CancellationToken::default(),
                reset_preview: None,
                reset_result: None,
                resetting: false,
            })),
        }
    }

    pub(crate) fn set_locations(
        &self,
        roots: MigrationRoots,
    ) -> Result<MigratorView, CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        crate::locations::validate(&roots).map_err(|error| CommandError::from_legacy(&error))?;
        atomic_write_json(&session.settings_path, &roots)
            .map_err(|error| CommandError::from_legacy(&error))?;
        let replacement = Self::bootstrap_with(roots, session.settings_path.clone());
        std::mem::swap(&mut *session, &mut *replacement.lock());
        Ok(snapshot(&session))
    }

    pub(crate) fn new_task(&self) -> Result<MigratorView, CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        let replacement =
            Self::bootstrap_with(session.roots.clone(), session.settings_path.clone());
        std::mem::swap(&mut *session, &mut *replacement.lock());
        Ok(snapshot(&session))
    }

    pub(crate) fn resume_task(&self, run_id: &str) -> Result<MigratorView, CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        let (plan, report) =
            load_task(&session.roots, run_id).map_err(|error| CommandError::from_legacy(&error))?;
        session.request.run_id = run_id.to_string();
        session.selection = plan.selection.clone();
        session.findings = plan.findings.clone();
        session.status = report
            .as_ref()
            .map(|report| report.status)
            .unwrap_or(MigrationRunStatus::Planned);
        session.plan = Some(plan);
        session.report = report;
        session.progress = None;
        session.recovery = true;
        session.error = None;
        session.reset_preview = None;
        session.reset_result = None;
        Ok(snapshot(&session))
    }

    pub(crate) fn snapshot(&self) -> MigratorView {
        let session = self.lock();
        snapshot(&session)
    }

    pub(crate) fn preview_reset(&self) -> Result<MigratorView, CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        let protected = reset_protected_directories(&session.settings_path)?;
        let directories = openbitfun_legacy_migration::plan_target_reset(&session.roots, &protected)
            .map_err(|_| CommandError::new("unsafe_reset_locations", "Reset refused: a destination overlaps source data, a protected directory, or a linked path. Check the selected locations.", false))?;
        session.reset_preview = Some(ResetPreviewView {
            confirmation_id: uuid::Uuid::new_v4().to_string(),
            directories,
        });
        session.reset_result = None;
        session.error = None;
        Ok(snapshot(&session))
    }

    pub(crate) fn start_reset(
        &self,
        confirmation_id: String,
        confirmation: String,
    ) -> Result<MigratorView, CommandError> {
        let (roots, preview, protected) = {
            let mut session = self.lock();
            if session.running {
                return Err(CommandError::operation_in_progress());
            }
            let preview = session
                .reset_preview
                .clone()
                .filter(|preview| preview.confirmation_id == confirmation_id)
                .ok_or_else(|| {
                    CommandError::new(
                        "reset_confirmation_required",
                        "Review the reset directories again before continuing.",
                        true,
                    )
                })?;
            if confirmation != "RESET" {
                return Err(CommandError::new(
                    "reset_confirmation_required",
                    "Type RESET to confirm permanent deletion of OpenBitFun data.",
                    true,
                ));
            }
            let protected = reset_protected_directories(&session.settings_path)?;
            session.running = true;
            session.resetting = true;
            session.progress = None;
            session.error = None;
            session.reset_result = None;
            session.reset_preview = None;
            (session.roots.clone(), preview, protected)
        };
        let coordinator = self.clone();
        self.spawn_worker("openbitfun-data-reset", move || {
            coordinator.reset_background(roots, preview, protected);
        })
    }

    fn reset_background(
        &self,
        roots: MigrationRoots,
        preview: ResetPreviewView,
        protected: Vec<PathBuf>,
    ) {
        let mut blockers = Vec::new();
        let result = (|| {
            blockers = openbitfun_legacy_migration::blocking_writer_processes_for_product(
                0,
                &["openbitfun-data-migrator"],
            )
            .map_err(|error| CommandError::from_legacy(&error))?;
            if !blockers.is_empty() {
                return Err(CommandError::new("reset_writers_running", "Close BitFun, OpenBitFun, their CLI/background writers, and other Data Migrator instances, then retry reset.", true));
            }
            openbitfun_legacy_migration::reset_target_data(&roots, &preview.directories, &protected)
                .map_err(|_| CommandError::new("reset_scope_changed", "Reset stopped because the directories failed revalidation. Review the paths again; some data may already have been removed.", true))
        })();
        self.finish_reset(roots, result, blockers);
    }

    fn finish_reset(
        &self,
        roots: MigrationRoots,
        result: Result<TargetResetResult, CommandError>,
        blockers: Vec<WriterProcess>,
    ) {
        let mut session = self.lock();
        // Reload even after failure: a partial deletion invalidates old plans.
        let replacement = Self::bootstrap_with(roots, session.settings_path.clone());
        std::mem::swap(&mut *session, &mut *replacement.lock());
        session.blockers = blockers;
        match result {
            Ok(result) => {
                if !result.failed.is_empty() {
                    session.error = Some(CommandError::new("reset_incomplete", "Some OpenBitFun directories could not be fully removed. Close applications using them, then review and retry reset before migrating.", true));
                }
                session.reset_result = Some(result);
            }
            Err(error) => {
                session.error = Some(error);
            }
        }
    }

    pub(crate) fn export_diagnostics(&self) -> Result<DiagnosticsExportView, CommandError> {
        let session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        let report = session.report.clone().ok_or_else(|| {
            CommandError::new(
                "diagnostics_unavailable",
                "Failure diagnostics are available after a migration failure.",
                false,
            )
        })?;
        let layout = MigrationLayout::new(&session.roots, &report.run_id);
        drop(session);
        let path = export_failure_diagnostics(&layout, &report).map_err(|_| {
            CommandError::new(
                "diagnostics_export_failed",
                "OpenBitFun could not write the sanitized migration diagnostics file.",
                true,
            )
        })?;
        Ok(DiagnosticsExportView {
            file_path: path.to_string_lossy().to_string(),
        })
    }

    pub(crate) fn scan(&self, selection: MigrationSelection) -> Result<MigratorView, CommandError> {
        let (roots, request, cancellation) = self.begin_operation(&selection)?;
        let coordinator = self.clone();
        self.spawn_worker("legacy-migration-scan", move || {
            coordinator.scan_background(roots, request, selection, cancellation);
        })
    }

    fn scan_background(
        &self,
        roots: MigrationRoots,
        _request: TaskRequest,
        selection: MigrationSelection,
        cancellation: CancellationToken,
    ) {
        let result = (|| {
            let source = probe_legacy_source(&roots, ProbeLimits::default())?.ok_or_else(|| {
                LegacyMigrationError::UnsupportedSource(
                    "no supported legacy BitFun data was discovered".to_string(),
                )
            })?;
            let engine = migration_engine(roots.clone(), &selection)?;
            let scans = engine.scan(&selection, &cancellation)?;
            Ok::<_, LegacyMigrationError>((
                source,
                scans
                    .into_iter()
                    .map(|scan| scan.finding)
                    .collect::<Vec<_>>(),
            ))
        })();

        let mut session = self.lock();
        session.running = false;
        match result {
            Ok((source, findings)) => {
                session.source = Some(source);
                session.selection = selection;
                session.findings = findings;
                session.plan = None;
                session.report = None;
                session.status = MigrationRunStatus::Scanned;
                session.progress = Some(MigrationProgressEvent {
                    run_id: session.request.run_id.clone(),
                    phase: MigrationPhase::Scan,
                    processed: session.selection.expanded_domains().len() as u64,
                    total: session.selection.expanded_domains().len() as u64,
                    safe_to_cancel: true,
                    code: "scan_completed".to_string(),
                    ..MigrationProgressEvent::default()
                });
                session.error = None;
            }
            Err(error) => {
                self.finish_error_locked(&mut session, &error);
            }
        }
    }

    pub(crate) fn prepare(
        &self,
        selection: MigrationSelection,
    ) -> Result<MigratorView, CommandError> {
        let (roots, request, cancellation) = self.begin_operation(&selection)?;
        let coordinator = self.clone();
        self.spawn_worker("legacy-migration-plan", move || {
            coordinator.prepare_background(roots, request, selection, cancellation);
        })
    }

    fn prepare_background(
        &self,
        roots: MigrationRoots,
        request: TaskRequest,
        selection: MigrationSelection,
        cancellation: CancellationToken,
    ) {
        let result = (|| {
            let source = probe_legacy_source(&roots, ProbeLimits::default())?.ok_or_else(|| {
                LegacyMigrationError::UnsupportedSource(
                    "no supported legacy BitFun data was discovered".to_string(),
                )
            })?;
            let engine = migration_engine(roots.clone(), &selection)?;
            let plan = engine.plan_with_run_id(
                &source,
                selection.clone(),
                request.run_id.clone(),
                &cancellation,
            )?;
            save_task(&roots, &plan)?;
            let blockers = writer_processes()?;
            Ok::<_, LegacyMigrationError>((source, plan, blockers))
        })();

        let mut session = self.lock();
        session.running = false;
        match result {
            Ok((source, plan, blockers)) => {
                session.source = Some(source);
                session.selection = selection;
                session.findings = plan.findings.clone();
                session.plan = Some(plan);
                session.saved_tasks =
                    list_tasks(&session.roots).unwrap_or_else(|_| session.saved_tasks.clone());
                session.report = None;
                session.blockers = blockers;
                session.status = MigrationRunStatus::Planned;
                session.progress = Some(MigrationProgressEvent {
                    run_id: session.request.run_id.clone(),
                    phase: MigrationPhase::Plan,
                    processed: session.selection.expanded_domains().len() as u64,
                    total: session.selection.expanded_domains().len() as u64,
                    safe_to_cancel: true,
                    code: "plan_ready".to_string(),
                    ..MigrationProgressEvent::default()
                });
                session.error = None;
            }
            Err(error) => {
                self.finish_error_locked(&mut session, &error);
            }
        }
    }

    pub(crate) fn refresh_blockers(&self) -> Result<MigratorView, CommandError> {
        if self.is_running() {
            return Err(CommandError::operation_in_progress());
        }
        match writer_processes() {
            Ok(blockers) => {
                let mut session = self.lock();
                session.blockers = blockers;
                session.error = None;
                Ok(snapshot(&session))
            }
            Err(error) => {
                let mut session = self.lock();
                Err(self.finish_error_locked(&mut session, &error))
            }
        }
    }

    pub(crate) fn start(&self, plan_hash: String) -> Result<MigratorView, CommandError> {
        let (roots, request, plan, cancellation) = {
            let mut session = self.lock();
            if session.running {
                return Err(CommandError::operation_in_progress());
            }
            let plan = session.plan.clone().ok_or_else(|| {
                CommandError::new(
                    "plan_required",
                    "Run the preflight plan before starting migration.",
                    true,
                )
            })?;
            if plan.plan_hash != plan_hash {
                return Err(CommandError::new(
                    "stale_plan",
                    "The confirmed plan is no longer the active migration plan.",
                    true,
                ));
            }
            let (saved, _) = load_task(&session.roots, &session.request.run_id)
                .map_err(|error| CommandError::from_legacy(&error))?;
            if saved != plan {
                return Err(CommandError::new(
                    "stale_plan",
                    "Review the saved plan again before continuing.",
                    true,
                ));
            }
            if matches!(
                session.status,
                MigrationRunStatus::Completed | MigrationRunStatus::CompletedWithWarnings
            ) {
                return Err(CommandError::new(
                    "task_completed",
                    "This task is already complete. Start a new scan to import other data.",
                    true,
                ));
            }

            session.cancellation = CancellationToken::default();
            session.running = true;
            session.error = None;
            session.status = MigrationRunStatus::WaitingForProcesses;
            session.progress = Some(MigrationProgressEvent {
                run_id: session.request.run_id.clone(),
                phase: MigrationPhase::Acquire,
                processed: 0,
                total: plan.steps.len() as u64,
                safe_to_cancel: true,
                code: "waiting_for_writer_processes".to_string(),
                ..MigrationProgressEvent::default()
            });
            (
                session.roots.clone(),
                session.request.clone(),
                plan,
                session.cancellation.clone(),
            )
        };

        let coordinator = self.clone();
        self.spawn_worker("legacy-data-migration", move || {
            coordinator.execute_background(roots, request, plan, cancellation);
        })
    }

    pub(crate) fn cancel(&self) -> MigratorView {
        let mut session = self.lock();
        if session.resetting {
            return snapshot(&session);
        }
        session.cancellation.cancel();
        if let Some(progress) = &mut session.progress {
            progress.code = if progress.safe_to_cancel {
                "cancellation_requested".to_string()
            } else {
                "cancellation_pending_safe_boundary".to_string()
            };
        }
        snapshot(&session)
    }

    pub(crate) fn is_running(&self) -> bool {
        self.lock().running
    }

    pub(crate) fn finish(&self) -> Result<(), CommandError> {
        if self.is_running() {
            return Err(CommandError::operation_in_progress());
        }
        Ok(())
    }

    fn begin_operation(
        &self,
        selection: &MigrationSelection,
    ) -> Result<(MigrationRoots, TaskRequest, CancellationToken), CommandError> {
        let mut session = self.lock();
        if session.running {
            return Err(CommandError::operation_in_progress());
        }
        validate_selection(selection)?;
        // A changed scan/selection is a new task. Never overwrite an old journal.
        session.request.run_id = uuid::Uuid::new_v4().to_string();
        session.recovery = false;
        session.selection = selection.clone();
        session.plan = None;
        session.report = None;
        session.findings.clear();
        session.cancellation = CancellationToken::default();
        session.running = true;
        session.error = None;
        session.reset_preview = None;
        session.reset_result = None;
        session.progress = Some(MigrationProgressEvent {
            run_id: session.request.run_id.clone(),
            phase: MigrationPhase::Scan,
            processed: 0,
            total: selection.expanded_domains().len() as u64,
            safe_to_cancel: true,
            code: "scanning_source".to_string(),
            ..MigrationProgressEvent::default()
        });
        Ok((
            session.roots.clone(),
            session.request.clone(),
            session.cancellation.clone(),
        ))
    }

    fn spawn_worker(
        &self,
        name: &str,
        worker: impl FnOnce() + Send + 'static,
    ) -> Result<MigratorView, CommandError> {
        if std::thread::Builder::new()
            .name(name.to_string())
            .spawn(worker)
            .is_err()
        {
            let mut session = self.lock();
            session.running = false;
            session.resetting = false;
            let error = CommandError::worker_failed();
            session.error = Some(error.clone());
            return Err(error);
        }

        Ok(self.snapshot())
    }

    fn execute_background(
        &self,
        roots: MigrationRoots,
        _request: TaskRequest,
        plan: MigrationPlan,
        cancellation: CancellationToken,
    ) {
        loop {
            if cancellation.is_cancelled() {
                self.finish_cancelled_before_execution(&plan);
                return;
            }
            match writer_processes() {
                Ok(blockers) => {
                    let done = blockers.is_empty();
                    let mut session = self.lock();
                    session.blockers = blockers;
                    if let Some(progress) = &mut session.progress {
                        progress.code = if done {
                            "writer_processes_stopped".to_string()
                        } else {
                            "waiting_for_writer_processes".to_string()
                        };
                    }
                    drop(session);
                    if done {
                        break;
                    }
                }
                Err(error) => {
                    let mut session = self.lock();
                    session.running = false;
                    self.finish_error_locked(&mut session, &error);
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }

        let engine = match migration_engine(roots.clone(), &plan.selection) {
            Ok(engine) => engine,
            Err(error) => {
                let mut session = self.lock();
                session.running = false;
                self.finish_error_locked(&mut session, &error);
                return;
            }
        };
        let coordinator = self.clone();
        let result = engine.execute_with_progress(
            &plan,
            &cancellation,
            &NoCrashInjection,
            move |progress| coordinator.record_progress(progress),
        );

        let mut session = self.lock();
        session.running = false;
        match result {
            Ok(report) => {
                session.status = report.status;
                session.report = Some(report);
                session.error = None;
                session.saved_tasks =
                    list_tasks(&session.roots).unwrap_or_else(|_| session.saved_tasks.clone());
            }
            Err(error) => {
                let layout = MigrationLayout::new(&roots, &plan.run_id);
                if let Ok(Some(report)) =
                    layout.read_json::<MigrationRunReport>(&layout.report_path())
                {
                    session.status = report.status;
                    session.report = Some(report);
                } else if matches!(error, LegacyMigrationError::Cancelled) {
                    session.status = MigrationRunStatus::Cancelled;
                }
                self.finish_error_locked(&mut session, &error);
            }
        }
    }

    fn finish_cancelled_before_execution(&self, plan: &MigrationPlan) {
        let mut session = self.lock();
        session.running = false;
        session.status = MigrationRunStatus::Cancelled;
        session.progress = Some(MigrationProgressEvent {
            run_id: plan.run_id.clone(),
            phase: MigrationPhase::Acquire,
            processed: 0,
            total: plan.steps.len() as u64,
            safe_to_cancel: true,
            code: "migration_cancelled".to_string(),
            ..MigrationProgressEvent::default()
        });
        session.error = Some(CommandError::from_legacy(&LegacyMigrationError::Cancelled));
    }

    fn record_progress(&self, progress: MigrationProgressEvent) {
        let mut session = self.lock();
        session.status = status_for_phase(progress.phase);
        session.progress = Some(progress);
    }

    fn finish_error_locked(
        &self,
        session: &mut MigratorSession,
        error: &LegacyMigrationError,
    ) -> CommandError {
        session.running = false;
        if matches!(error, LegacyMigrationError::Cancelled) {
            session.status = MigrationRunStatus::Cancelled;
            if let Some(progress) = &mut session.progress {
                progress.safe_to_cancel = true;
                progress.code = "migration_cancelled".to_string();
            }
        }
        let command_error = session
            .report
            .as_ref()
            .and_then(CommandError::from_report_failure)
            .unwrap_or_else(|| CommandError::from_legacy(error));
        session.error = Some(command_error.clone());
        command_error
    }

    fn lock(&self) -> MutexGuard<'_, MigratorSession> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn migration_engine(
    roots: MigrationRoots,
    selection: &MigrationSelection,
) -> LegacyMigrationResult<MigrationEngine> {
    crate::locations::validate(&roots)?;
    openbitfun_legacy_migration_adapters::validate_target(&roots)?;
    MigrationEngine::new(roots, adapters_for_groups(selection))
}

fn writer_processes() -> LegacyMigrationResult<Vec<WriterProcess>> {
    blocking_writer_processes(0)
}

fn reset_protected_directories(settings: &std::path::Path) -> Result<Vec<PathBuf>, CommandError> {
    let settings_root = settings.parent().ok_or_else(|| {
        CommandError::new(
            "unsafe_reset_locations",
            "The migrator configuration directory is unavailable.",
            false,
        )
    })?;
    let executable = std::env::current_exe().map_err(|_| {
        CommandError::new(
            "unsafe_reset_locations",
            "The migrator installation directory is unavailable.",
            false,
        )
    })?;
    let executable_root = executable.parent().ok_or_else(|| {
        CommandError::new(
            "unsafe_reset_locations",
            "The migrator installation directory is unavailable.",
            false,
        )
    })?;
    Ok(vec![
        settings_root.to_path_buf(),
        executable_root.to_path_buf(),
    ])
}

fn validate_selection(selection: &MigrationSelection) -> Result<(), CommandError> {
    if selection.groups.is_empty() {
        return Err(CommandError::new(
            "empty_selection",
            "Select at least one migration group.",
            true,
        ));
    }
    Ok(())
}

fn snapshot(session: &MigratorSession) -> MigratorView {
    let plan = session.plan.as_ref().map(redact_plan_for_ui);
    let report = session.report.as_ref().map(redact_report_for_ui);
    let workspace_counts = session.report.as_ref().and_then(|report| {
        openbitfun_legacy_migration_adapters::workspace_report_counts(&session.roots, report).ok()
    });
    MigratorView {
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        locations: session.roots.clone(),
        saved_tasks: session.saved_tasks.clone(),
        source: session.source.clone(),
        selection: session.selection.clone(),
        findings: session
            .findings
            .iter()
            .cloned()
            .map(redact_finding_for_ui)
            .collect(),
        can_execute: plan.is_some()
            && session
                .source
                .as_ref()
                .is_some_and(|source| source.supported)
            && !session.running
            && !matches!(
                session.status,
                MigrationRunStatus::Completed | MigrationRunStatus::CompletedWithWarnings
            ),
        plan,
        report,
        workspace_counts,
        progress: session.progress.clone(),
        blockers: session.blockers.clone(),
        status: session.status,
        running: session.running,
        recovery: session.recovery,
        error: session.error.clone(),
        reset_preview: session.reset_preview.clone(),
        reset_result: session.reset_result.clone(),
        resetting: session.resetting,
    }
}

fn redact_finding_for_ui(mut finding: ScanFinding) -> ScanFinding {
    finding.detail = finding.code.replace('_', " ");
    finding
}

fn redact_plan_for_ui(plan: &MigrationPlan) -> MigrationPlan {
    let mut redacted = plan.clone();
    redacted.findings = redacted
        .findings
        .into_iter()
        .map(redact_finding_for_ui)
        .collect();
    for conflict in &mut redacted.conflicts {
        conflict.source_summary = "Legacy item".to_string();
        conflict.target_summary = "Existing OpenBitFun item".to_string();
    }
    redacted
}

fn redact_report_for_ui(report: &MigrationRunReport) -> MigrationRunReport {
    let mut redacted = report.clone();
    for diagnostic in &mut redacted.diagnostics {
        diagnostic.relative_path = None;
        diagnostic.message = diagnostic.code.replace('_', " ");
        diagnostic.action = None;
    }
    for result in &mut redacted.domain_results {
        for warning in &mut result.warnings {
            warning.relative_path = None;
            warning.message = warning.code.replace('_', " ");
            warning.action = None;
        }
    }
    redacted
}

fn status_for_phase(phase: MigrationPhase) -> MigrationRunStatus {
    match phase {
        MigrationPhase::Discover => MigrationRunStatus::Discovered,
        MigrationPhase::Scan => MigrationRunStatus::Scanned,
        MigrationPhase::Plan => MigrationRunStatus::Planned,
        MigrationPhase::Acquire => MigrationRunStatus::WaitingForProcesses,
        MigrationPhase::Stage => MigrationRunStatus::Staging,
        MigrationPhase::ValidateStage => MigrationRunStatus::ValidatingStage,
        MigrationPhase::Commit => MigrationRunStatus::Committing,
        MigrationPhase::ValidateCommit => MigrationRunStatus::ValidatingCommit,
        MigrationPhase::Finalize => MigrationRunStatus::Completed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    fn fixture_roots(root: &Path) -> MigrationRoots {
        MigrationRoots {
            legacy_user_root: root.join("legacy/user"),
            legacy_home_root: root.join("legacy/home"),
            legacy_skills_root: root.join("legacy/skills"),
            legacy_ssh_root: root.join("legacy/ssh"),
            target_user_root: root.join("target/user"),
            target_home_root: root.join("target/home"),
            target_skills_root: root.join("target/skills"),
            target_ssh_root: root.join("target/ssh"),
        }
    }

    #[test]
    fn starts_without_desktop_request_or_data() {
        let temp = tempfile::tempdir().unwrap();
        let roots = fixture_roots(temp.path());
        let coordinator = MigratorCoordinator::bootstrap_with(
            roots.clone(),
            temp.path().join("tool/locations.json"),
        );
        let view = coordinator.snapshot();
        assert!(view.source.is_none());
        assert!(view.error.is_none());
        assert!(!view.running);
        coordinator.finish().unwrap();
        assert!(!roots.target_user_root.exists());
    }

    #[test]
    fn cancelled_scan_preserves_safe_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let roots = fixture_roots(temp.path());
        fs::create_dir_all(roots.legacy_user_root.join("config")).unwrap();
        fs::write(
            roots.legacy_user_root.join("config/app.json"),
            br#"{"version":"0.2.19"}"#,
        )
        .unwrap();
        let coordinator =
            MigratorCoordinator::bootstrap_with(roots, temp.path().join("tool/locations.json"));
        let selection = MigrationSelection::all();
        let (roots, request, cancellation) = coordinator.begin_operation(&selection).unwrap();
        assert!(coordinator.finish().is_err());
        assert!(coordinator.new_task().is_err());
        cancellation.cancel();
        coordinator.scan_background(roots, request, selection, cancellation);
        assert_eq!(coordinator.snapshot().status, MigrationRunStatus::Cancelled);
        assert!(!coordinator.is_running());
    }

    #[test]
    fn rejects_nested_locations_without_writing_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let mut roots = fixture_roots(temp.path());
        let settings = temp.path().join("tool/locations.json");
        let coordinator = MigratorCoordinator::bootstrap_with(roots.clone(), settings.clone());
        roots.target_home_root = roots.legacy_user_root.join("nested");
        assert!(coordinator.set_locations(roots).is_err());
        assert!(!settings.exists());
    }

    #[test]
    fn reset_requires_fresh_confirmation_and_excludes_running_operations() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let roots = fixture_roots(&root);
        fs::create_dir_all(&roots.target_user_root).unwrap();
        let keep = roots.target_user_root.join("keep");
        fs::write(&keep, "target").unwrap();
        let coordinator =
            MigratorCoordinator::bootstrap_with(roots, root.join("tool/locations.json"));
        assert!(coordinator
            .start_reset("stale".into(), "RESET".into())
            .is_err());
        let preview = coordinator.preview_reset().unwrap().reset_preview.unwrap();
        assert!(coordinator
            .start_reset(preview.confirmation_id.clone(), "reset".into())
            .is_err());
        coordinator.preview_reset().unwrap();
        assert!(coordinator
            .start_reset(preview.confirmation_id, "RESET".into())
            .is_err());
        coordinator.lock().running = true;
        assert!(coordinator.preview_reset().is_err());
        assert!(coordinator
            .start_reset("stale".into(), "RESET".into())
            .is_err());
        assert_eq!(fs::read_to_string(keep).unwrap(), "target");
    }

    #[test]
    fn reset_reloads_history_after_success_or_partial_failure_and_preserves_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let roots = fixture_roots(&root);
        let settings = root.join("tool/locations.json");
        atomic_write_json(&settings, &roots).unwrap();
        let coordinator = MigratorCoordinator::bootstrap_with(roots.clone(), settings.clone());
        fs::create_dir_all(&roots.target_user_root).unwrap();
        fs::write(roots.target_user_root.join("keep"), "target").unwrap();
        let preview = coordinator.preview_reset().unwrap().reset_preview.unwrap();
        let protected = reset_protected_directories(&settings).unwrap();
        let result = openbitfun_legacy_migration::reset_target_data(
            &roots,
            &preview.directories,
            &protected,
        )
        .unwrap();
        coordinator.finish_reset(roots.clone(), Ok(result), Vec::new());
        let view = coordinator.snapshot();
        assert!(view.reset_result.unwrap().failed.is_empty());
        assert!(view.plan.is_none());
        assert!(view.report.is_none());
        assert!(view.saved_tasks.is_empty());
        assert!(view.reset_preview.is_none());
        assert!(!view.running && !view.resetting);
        assert!(settings.exists());
        assert!(!roots.target_user_root.exists());

        coordinator.lock().running = true;
        coordinator.lock().resetting = true;
        coordinator.finish_reset(
            roots.clone(),
            Ok(TargetResetResult {
                failed: vec![roots.target_home_root.clone()],
                ..Default::default()
            }),
            Vec::new(),
        );
        let view = coordinator.snapshot();
        assert_eq!(view.error.unwrap().code, "reset_incomplete");
        assert!(!view.running && !view.resetting);
        assert!(view.reset_preview.is_none());
        coordinator.finish_reset(
            roots,
            Err(CommandError::new("reset_scope_changed", "Changed", true)),
            Vec::new(),
        );
        assert_eq!(
            coordinator.snapshot().error.unwrap().code,
            "reset_scope_changed"
        );
        assert!(settings.exists());
    }

    #[test]
    fn unsupported_target_is_rejected_before_scan_or_any_writes() {
        let temp = tempfile::tempdir().unwrap();
        let roots = fixture_roots(temp.path());
        assert!(migration_engine(roots.clone(), &MigrationSelection::all()).is_ok());
        assert!(!roots.target_user_root.exists());
        let target = roots.target_user_root.join("config/app.json");
        for value in [
            serde_json::json!({"product_id":"openbitfun", "schema_version":999, "version":"9.0.0"}),
            serde_json::json!({"product_id":"other-product", "schema_version":1, "version":"1.0.0"}),
            serde_json::json!({"version":"0.2.19"}),
        ] {
            atomic_write_json(&target, &value).unwrap();
            let before = fs::read(&target).unwrap();
            assert!(matches!(
                migration_engine(roots.clone(), &MigrationSelection::all()),
                Err(LegacyMigrationError::UnsupportedTarget(_))
            ));
            assert_eq!(fs::read(&target).unwrap(), before);
            assert!(!roots.migration_root().exists());
            assert!(!roots.legacy_user_root.exists());
        }
    }
    #[test]
    fn command_errors_do_not_expose_storage_paths() {
        let error = LegacyMigrationError::Io {
            path: Path::new("C:/Users/private/secret.json").to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "secret"),
        };
        let command = CommandError::from_legacy(&error);
        let serialized = serde_json::to_string(&command).unwrap();

        assert_eq!(command.code, "storage_failed");
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn report_failure_errors_use_sanitized_domain_diagnostics() {
        let report = MigrationRunReport {
            diagnostics: vec![
                openbitfun_product_domains::legacy_migration::MigrationDiagnostic {
                    code: "domain_io_permission_denied".to_string(),
                    severity: FindingSeverity::Blocking,
                    domain: Some(
                        openbitfun_product_domains::legacy_migration::MigrationDomainId::WorkspaceSessions,
                    ),
                    relative_path: Some("C:/Users/private/session-state.json".to_string()),
                    message: "A migration-owned file or directory denied access.".to_string(),
                    action: Some("Close programs using the data, check permissions, and retry.".to_string()),
                },
            ],
            ..MigrationRunReport::default()
        };

        let command = CommandError::from_report_failure(&report).unwrap();
        let serialized = serde_json::to_string(&command).unwrap();

        assert_eq!(command.code, "domain_io_permission_denied");
        assert!(command.message.contains("check permissions"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("session-state"));
    }
}
