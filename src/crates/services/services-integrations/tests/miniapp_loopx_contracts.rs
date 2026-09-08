use async_trait::async_trait;
use openbitfun_product_domains::miniapp::loopx::{
    LoopxAgentTurnStatus, LoopxCliBuildTurnRequest, LoopxCliCallContext, LoopxCliCreateGoalRequest,
    LoopxCliErrorKind, LoopxCliGoalContext, LoopxCliHandshakeRequest, LoopxCliInspectGoalRequest,
    LoopxCliInstallManagedSourceRequest, LoopxCliIntakePlan, LoopxCliPlanItemRequest, LoopxCliPort,
    LoopxCliProgress, LoopxCliProgressSink, LoopxCliRunDecision, LoopxCliSettleTurnRequest,
    LoopxCliSettlementStatus, LoopxCliSource, LoopxCliTodoPlan, LoopxIssueKey, LoopxItemKind,
    LoopxPermissionScope, LoopxRemoteItemState, LoopxRepositoryKey, LoopxWorkspaceDisposeRequest,
    LoopxWorkspacePort, LoopxWorkspacePrepareRequest, LoopxWorkspaceProbeRequest,
    LoopxWorkspaceResetRequest,
};
use openbitfun_services_integrations::miniapp::loopx_cli::{
    LoopxCliAdapterConfig, LoopxCliProcessAdapter, LoopxCommandPlan, LoopxCommandSource,
    LoopxFixedCommandLocator, LoopxProcessError, LoopxProcessObserver, LoopxProcessOutput,
    LoopxProcessProgress, LoopxProcessRunner, LoopxProgressStage, LoopxPythonLocator,
    LoopxSystemFallbackPolicy, NoopLoopxProcessObserver, SystemLoopxProcessRunner,
    LOOPX_COMMAND_REFERENCE_SCHEMA, LOOPX_PINNED_SOURCE_COMMIT, LOOPX_SOURCE_REPOSITORY,
};
use openbitfun_services_integrations::miniapp::loopx_workspace::{
    canonical_github_remote, plan_git_clone_command, plan_workspace_layout, LoopxWorkspaceService,
    LoopxWorkspaceServiceConfig,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RecordingProgressSink(Mutex<Vec<LoopxCliProgress>>);

impl LoopxCliProgressSink for RecordingProgressSink {
    fn report(&self, progress: LoopxCliProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

#[derive(Default)]
struct RecordingProcessObserver(Mutex<Vec<LoopxProcessProgress>>);

impl LoopxProcessObserver for RecordingProcessObserver {
    fn on_progress(&self, progress: LoopxProcessProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

#[derive(Default)]
struct FakeRunner {
    results: Mutex<VecDeque<Result<LoopxProcessOutput, LoopxProcessError>>>,
    plans: Mutex<Vec<LoopxCommandPlan>>,
}

impl FakeRunner {
    fn with_results(
        results: impl IntoIterator<Item = Result<LoopxProcessOutput, LoopxProcessError>>,
    ) -> Self {
        Self {
            results: Mutex::new(results.into_iter().collect()),
            plans: Mutex::new(Vec::new()),
        }
    }

    fn plans(&self) -> Vec<LoopxCommandPlan> {
        self.plans.lock().unwrap().clone()
    }
}

#[async_trait]
impl LoopxProcessRunner for FakeRunner {
    async fn run(
        &self,
        plan: LoopxCommandPlan,
        _cancellation: CancellationToken,
        _observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxProcessOutput, LoopxProcessError> {
        self.plans.lock().unwrap().push(plan);
        self.results
            .lock()
            .unwrap()
            .pop_front()
            .expect("fake process result")
    }
}

#[derive(Default)]
struct ManagedInstallFakeRunner {
    plans: Mutex<Vec<LoopxCommandPlan>>,
}

#[async_trait]
impl LoopxProcessRunner for ManagedInstallFakeRunner {
    async fn run(
        &self,
        plan: LoopxCommandPlan,
        _cancellation: CancellationToken,
        _observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxProcessOutput, LoopxProcessError> {
        let is_git = plan.executable.file_stem().and_then(|value| value.to_str()) == Some("git");
        let stdout = if is_git && plan.args.first() == Some(&OsString::from("clone")) {
            let target = PathBuf::from(plan.args.last().expect("clone target"));
            std::fs::create_dir_all(target.join(".git")).unwrap();
            std::fs::create_dir_all(target.join("loopx")).unwrap();
            std::fs::write(target.join(".git").join("HEAD"), LOOPX_PINNED_SOURCE_COMMIT).unwrap();
            for file in [
                "pyproject.toml",
                "LICENSE",
                "NOTICE",
                "LICENSE-MIT",
                "TRADEMARKS.md",
            ] {
                std::fs::write(target.join(file), "fixture\n").unwrap();
            }
            std::fs::write(
                target.join("loopx").join("entrypoint.py"),
                "def main(): pass\n",
            )
            .unwrap();
            String::new()
        } else if is_git && plan.args.last() == Some(&OsString::from("HEAD")) {
            format!("{LOOPX_PINNED_SOURCE_COMMIT}\n")
        } else if plan.args == [OsString::from("--version")] {
            "Python 3.12.8\n".to_string()
        } else if plan.args.last() == Some(&OsString::from("--version")) {
            "loopx 0.5.1\n".to_string()
        } else if plan.args.last() == Some(&OsString::from("commands")) {
            json!({"ok": true, "schema_version": LOOPX_COMMAND_REFERENCE_SCHEMA}).to_string()
        } else {
            String::new()
        };
        self.plans.lock().unwrap().push(plan);
        Ok(LoopxProcessOutput {
            stdout,
            stderr_tail: Vec::new(),
            elapsed: Duration::from_millis(1),
        })
    }
}

#[derive(Default)]
struct WorkspaceFakeRunner {
    plans: Mutex<Vec<LoopxCommandPlan>>,
    remote: Mutex<String>,
    /// Directory paths of registered linked worktrees, used by `worktree list`.
    worktrees: Mutex<Vec<PathBuf>>,
}

impl WorkspaceFakeRunner {
    fn new(remote: &str) -> Self {
        Self {
            plans: Mutex::new(Vec::new()),
            remote: Mutex::new(remote.to_string()),
            worktrees: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl LoopxProcessRunner for WorkspaceFakeRunner {
    async fn run(
        &self,
        plan: LoopxCommandPlan,
        _cancellation: CancellationToken,
        _observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxProcessOutput, LoopxProcessError> {
        if plan.args.first() == Some(&OsString::from("clone")) {
            // Shared layout: `git clone --bare <url> <bare_path>`.
            let target = PathBuf::from(plan.args.last().expect("clone target"));
            std::fs::create_dir_all(target.join("objects")).unwrap();
            std::fs::create_dir_all(target.join("refs")).unwrap();
        } else if plan.args.windows(3).any(|w| {
            w == [
                OsString::from("worktree"),
                OsString::from("add"),
                OsString::from("-b"),
            ]
        }) {
            // `git -C <bare> worktree add -b <branch> <worktree>`.
            let worktree = PathBuf::from(plan.args.last().expect("worktree add path"));
            let bare = PathBuf::from(&plan.args[1]);
            std::fs::create_dir_all(&worktree).unwrap();
            // Real git puts a `gitdir: <path>` pointer file in the linked
            // worktree; simulate that so the ownership marker lands in the
            // bare repo's per-worktree gitdir.
            let name = worktree
                .file_name()
                .expect("worktree name")
                .to_string_lossy();
            let gitdir = bare.join("worktrees").join(name.as_ref());
            std::fs::create_dir_all(&gitdir).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}\n", gitdir.to_string_lossy()),
            )
            .unwrap();
            std::fs::write(gitdir.join("bfx-linked"), b"ok").unwrap();
            self.worktrees.lock().unwrap().push(worktree.clone());
        } else if plan.args.windows(3).any(|w| {
            w == [
                OsString::from("worktree"),
                OsString::from("remove"),
                OsString::from("--force"),
            ]
        }) {
            let worktree = PathBuf::from(plan.args.last().expect("worktree remove path"));
            let _ = std::fs::remove_dir_all(&worktree);
            self.worktrees
                .lock()
                .unwrap()
                .retain(|path| path != &worktree);
        } else if plan
            .args
            .windows(2)
            .any(|w| w == [OsString::from("worktree"), OsString::from("list")])
        {
            // Porcelain output: first entry is the bare repository itself.
            let mut stdout = format!(
                "worktree {}\nHEAD 0000000000000000000000000000000000000000\n\n",
                plan.args[1].to_string_lossy()
            );
            for worktree in self.worktrees.lock().unwrap().iter() {
                stdout.push_str(&format!(
                    "worktree {}\nHEAD 1111111111111111111111111111111111111111\n\n",
                    worktree.to_string_lossy()
                ));
            }
            self.plans.lock().unwrap().push(plan);
            return Ok(LoopxProcessOutput {
                stdout,
                stderr_tail: Vec::new(),
                elapsed: Duration::from_millis(1),
            });
        }
        let stdout = if plan.args == [OsString::from("--version")] {
            "git version 2.53.0\n".to_string()
        } else if plan
            .args
            .windows(3)
            .any(|args| args == ["config", "--get", "remote.origin.url"])
        {
            format!("{}\n", self.remote.lock().unwrap())
        } else {
            String::new()
        };
        self.plans.lock().unwrap().push(plan);
        Ok(LoopxProcessOutput {
            stdout,
            stderr_tail: Vec::new(),
            elapsed: Duration::from_millis(1),
        })
    }
}

struct FakeLocator {
    path: Option<PathBuf>,
    calls: AtomicUsize,
}

impl FakeLocator {
    fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            calls: AtomicUsize::new(0),
        }
    }
}

impl LoopxFixedCommandLocator for FakeLocator {
    fn locate(&self) -> Result<Option<PathBuf>, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.path.clone())
    }
}

struct FakePythonLocator(PathBuf);

impl LoopxPythonLocator for FakePythonLocator {
    fn locate(&self) -> Result<Option<PathBuf>, String> {
        Ok(Some(self.0.clone()))
    }
}

fn output(stdout: impl Into<String>) -> Result<LoopxProcessOutput, LoopxProcessError> {
    Ok(LoopxProcessOutput {
        stdout: stdout.into(),
        stderr_tail: Vec::new(),
        elapsed: Duration::from_millis(1),
    })
}

fn stage_bundle(root: &Path, version: &str, schema: u32) -> PathBuf {
    let bundle = root.join("loopx");
    std::fs::create_dir_all(&bundle).unwrap();
    let executable = bundle.join(if cfg!(windows) { "loopx.exe" } else { "loopx" });
    let bytes = b"test-only-loopx-binary";
    std::fs::write(&executable, bytes).unwrap();
    let digest = hex::encode(Sha256::digest(bytes));
    std::fs::write(
        bundle.join("manifest.json"),
        serde_json::to_vec_pretty(&json!({
            "schema_version": schema,
            "name": "loopx",
            "version": version,
            "sha256": format!("sha256:{digest}"),
        }))
        .unwrap(),
    )
    .unwrap();
    executable
}

fn stage_managed_source(root: &Path) -> PathBuf {
    let source = root.join("managed-source");
    std::fs::create_dir_all(source.join(".git")).unwrap();
    std::fs::create_dir_all(source.join("loopx")).unwrap();
    std::fs::write(source.join(".git").join("HEAD"), LOOPX_PINNED_SOURCE_COMMIT).unwrap();
    std::fs::write(
        source.join("pyproject.toml"),
        "[project]\nversion = \"0.5.1\"\n",
    )
    .unwrap();
    std::fs::write(
        source.join("loopx").join("entrypoint.py"),
        "def main(): pass\n",
    )
    .unwrap();
    std::fs::write(
        source.join(".git").join(".bitfun-managed-source.json"),
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "source_repository": LOOPX_SOURCE_REPOSITORY,
            "source_tag": "v0.5.1",
            "source_commit": LOOPX_PINNED_SOURCE_COMMIT,
            "loopx_version": "0.5.1"
        }))
        .unwrap(),
    )
    .unwrap();
    source
}

fn handshake_results(
    version: &str,
    schema: &str,
) -> Vec<Result<LoopxProcessOutput, LoopxProcessError>> {
    vec![
        output(format!("{version}\n")),
        output(json!({"ok": true, "schema_version": schema}).to_string()),
    ]
}

fn adapter_with_runner(
    resource_dir: &Path,
    runner: Arc<FakeRunner>,
    locator: Arc<FakeLocator>,
) -> LoopxCliProcessAdapter {
    let mut config = LoopxCliAdapterConfig::packaged(resource_dir);
    config.system_fallback = LoopxSystemFallbackPolicy::ExactPinned;
    config.startup_deadline = Duration::from_secs(3);
    config.command_deadline = Duration::from_secs(9);
    LoopxCliProcessAdapter::with_dependencies(
        config,
        runner,
        locator,
        Arc::new(FakePythonLocator(PathBuf::from("python"))),
        Arc::new(NoopLoopxProcessObserver),
    )
}

fn handshake_request(operation_id: &str) -> LoopxCliHandshakeRequest {
    LoopxCliHandshakeRequest {
        call: LoopxCliCallContext {
            operation_id: operation_id.to_string(),
            deadline_at: None,
        },
        ..LoopxCliHandshakeRequest::default()
    }
}

#[test]
fn packaged_startup_budget_covers_measured_windows_onefile_cold_start() {
    let config = LoopxCliAdapterConfig::packaged(PathBuf::from("resources"));
    assert!(config.startup_deadline >= Duration::from_secs(60));
    assert_eq!(config.command_deadline, Duration::from_secs(180));
}

#[tokio::test]
async fn packaged_bundle_is_preferred_and_exactly_handshaken() {
    let temporary = tempfile::tempdir().unwrap();
    let bundled = stage_bundle(temporary.path(), "v0.5.1", 1);
    let runner = Arc::new(FakeRunner::with_results(handshake_results(
        "loopx 0.5.1",
        LOOPX_COMMAND_REFERENCE_SCHEMA,
    )));
    let locator = Arc::new(FakeLocator::new(Some(PathBuf::from("system-loopx"))));
    let adapter = adapter_with_runner(temporary.path(), runner.clone(), locator.clone());

    let manifest = adapter
        .handshake(
            handshake_request("handshake-bundle"),
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(manifest.executable.source, LoopxCliSource::Bundled);
    assert_eq!(manifest.loopx_version, "0.5.1");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(
        manifest.executable.path.as_deref(),
        Some(bundled.to_string_lossy().as_ref())
    );
    assert!(manifest
        .executable
        .sha256
        .as_deref()
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(locator.calls.load(Ordering::SeqCst), 0);
    let plans = runner.plans();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].executable, bundled);
    assert_eq!(plans[0].args, vec![OsString::from("--version")]);
    assert_eq!(
        plans[1].args,
        ["--format", "json", "commands"]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn managed_github_source_is_preferred_before_the_system_fallback() {
    let temporary = tempfile::tempdir().unwrap();
    let source = stage_managed_source(temporary.path());
    // The managed-source candidate runs the pristine-source probe (`git
    // status --porcelain`) before the version handshake, so the first result
    // is the probe's clean empty stdout.
    let runner = Arc::new(FakeRunner::with_results([output("")].into_iter().chain(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA),
    )));
    let system_locator = Arc::new(FakeLocator::new(Some(PathBuf::from("old-system-loopx"))));
    let mut config = LoopxCliAdapterConfig::packaged(temporary.path().join("missing-resources"))
        .with_managed_source_dir(&source);
    config.system_fallback = LoopxSystemFallbackPolicy::ExactPinned;
    let adapter = LoopxCliProcessAdapter::with_dependencies(
        config,
        runner.clone(),
        system_locator.clone(),
        Arc::new(FakePythonLocator(PathBuf::from("python"))),
        Arc::new(NoopLoopxProcessObserver),
    );

    let manifest = adapter
        .handshake(
            handshake_request("handshake-managed-source"),
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(manifest.executable.source, LoopxCliSource::PythonFallback);
    assert_eq!(system_locator.calls.load(Ordering::SeqCst), 0);
    let plans = runner.plans();
    let version = plans
        .iter()
        .find(|plan| {
            plan.executable == PathBuf::from("python")
                && plan.args.last() == Some(&OsString::from("--version"))
        })
        .expect("managed source version handshake");
    assert_eq!(version.args[0], OsString::from("-I"));
    assert_eq!(version.args[1], OsString::from("-c"));
    assert_eq!(version.args[3], OsString::from("--version"));
    assert_eq!(
        version
            .environment
            .get(&OsString::from("BITFUN_LOOPX_SOURCE")),
        Some(&source.as_os_str().to_owned())
    );
}

#[tokio::test]
async fn managed_source_install_clones_the_pinned_github_revision_and_activates_it() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("runtime").join("loopx-source-v0.5.1");
    let runner = Arc::new(ManagedInstallFakeRunner::default());
    let config = LoopxCliAdapterConfig::packaged(temporary.path().join("missing-resources"))
        .with_managed_source_dir(&target);
    let adapter = LoopxCliProcessAdapter::with_dependencies(
        config,
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
        Arc::new(FakePythonLocator(PathBuf::from("python"))),
        Arc::new(NoopLoopxProcessObserver),
    );

    let installed = adapter
        .install_managed_source(
            LoopxCliInstallManagedSourceRequest {
                call: LoopxCliCallContext {
                    operation_id: "install-managed-source".to_string(),
                    deadline_at: None,
                },
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(installed.source_repository, LOOPX_SOURCE_REPOSITORY);
    assert_eq!(installed.source_commit, LOOPX_PINNED_SOURCE_COMMIT);
    assert_eq!(installed.install_path, target.to_string_lossy().as_ref());
    assert!(target
        .join(".git")
        .join(".bitfun-managed-source.json")
        .is_file());
    let plans = runner.plans.lock().unwrap();
    let clone = plans
        .iter()
        .find(|plan| {
            plan.executable.file_stem().and_then(|value| value.to_str()) == Some("git")
                && plan.args[0] == OsString::from("clone")
        })
        .expect("git clone plan");
    assert!(clone
        .args
        .contains(&OsString::from(LOOPX_SOURCE_REPOSITORY)));
    assert!(clone.args.contains(&OsString::from("v0.5.1")));
    assert!(clone.args.contains(&OsString::from("--filter=blob:none")));
    assert!(clone.args.contains(&OsString::from("--sparse")));
    assert!(plans.iter().any(|plan| {
        plan.args.windows(3).any(|args| {
            args == [
                OsString::from("sparse-checkout"),
                OsString::from("set"),
                OsString::from("--no-cone"),
            ]
        })
    }));
    assert!(plans.iter().any(|plan| {
        plan.args.contains(&OsString::from("/loopx/"))
            && plan.args.contains(&OsString::from("/pyproject.toml"))
            && plan.args.contains(&OsString::from("/LICENSE"))
    }));
}

#[tokio::test]
async fn runtime_version_mismatch_is_a_non_retryable_typed_error() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let runner = Arc::new(FakeRunner::with_results([output("loopx 0.2.12\n")]));
    let adapter = adapter_with_runner(temporary.path(), runner, Arc::new(FakeLocator::new(None)));

    let error = adapter
        .handshake(
            handshake_request("handshake-version"),
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, LoopxCliErrorKind::VersionMismatch);
    assert!(!error.retryable);
}

#[tokio::test]
async fn command_reference_schema_mismatch_is_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let runner = Arc::new(FakeRunner::with_results(handshake_results(
        "loopx 0.5.1",
        "future_schema_v99",
    )));
    let adapter = adapter_with_runner(temporary.path(), runner, Arc::new(FakeLocator::new(None)));

    let error = adapter
        .handshake(
            handshake_request("handshake-schema"),
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, LoopxCliErrorKind::SchemaMismatch);
}

#[tokio::test]
async fn item_plan_uses_structured_registry_and_worktree_arguments() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let workflow = json!({
        "ok": true,
        "schema_version": "issue_fix_workflow_plan_packet_v0",
        "ordered_loopx_todo_writeback_preview": [{
            "role": "agent",
            "task_class": "advancement_task",
            "action_kind": "fix_issue",
            "text": "[P1] Fix issue #42"
        }]
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([output(workflow.to_string())]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };
    let request = LoopxCliPlanItemRequest {
        context: LoopxCliGoalContext {
            call: LoopxCliCallContext {
                operation_id: "plan-item".to_string(),
                deadline_at: None,
            },
            task_id: "task-42".to_string(),
            generation: 1,
            worktree_path: worktree.to_string_lossy().into_owned(),
            registry_path: registry.to_string_lossy().into_owned(),
            available_capabilities: vec!["shell".to_string()],
        },
        item,
        title: "Issue with “UTF-8” title".to_string(),
        state: LoopxRemoteItemState::Open,
        labels: vec!["bug".to_string()],
    };

    let plan = adapter
        .plan_item(request, &RecordingProgressSink::default())
        .await
        .unwrap();

    // The goal objective now comes from the host-resolved title; the packet
    // itself carries no objective field.
    assert_eq!(plan.objective, "Fix #42: Issue with “UTF-8” title");
    assert_eq!(plan.todos.len(), 1);
    let command = runner.plans().pop().unwrap();
    assert_eq!(command.current_dir.as_deref(), Some(worktree.as_path()));
    // The sidecar env intentionally forces UTF-8 stdio for the PyInstaller
    // bundle (8cf71c7bf): the command is not environment-clean, it carries
    // exactly the UTF-8 pair.
    assert_eq!(
        command.environment.get(OsStr::new("PYTHONUTF8")),
        Some(&OsString::from("1"))
    );
    assert_eq!(
        command.environment.get(OsStr::new("PYTHONIOENCODING")),
        Some(&OsString::from("utf-8"))
    );
    assert_eq!(command.environment.len(), 2);
    assert_eq!(command.deadline, Duration::from_secs(9));
    assert_eq!(
        command.args,
        vec![
            OsString::from("--format"),
            OsString::from("json"),
            OsString::from("--registry"),
            registry.as_os_str().to_owned(),
            // Project-local runtime root (cc7f0b426): every CLI call stays
            // inside the worktree's `.loopx` namespace and never touches the
            // shared `~/.codex/loopx` global.
            OsString::from("--runtime-root"),
            worktree
                .join(".loopx")
                .join("runtime")
                .as_os_str()
                .to_owned(),
            OsString::from("issue-fix"),
            OsString::from("workflow-plan"),
            OsString::from("--url"),
            OsString::from("https://github.com/owner/repo/issues/42"),
            OsString::from("--repo-path"),
            worktree.as_os_str().to_owned(),
            OsString::from("--metadata-json"),
            OsString::from(
                json!({
                    "number": 42,
                    "state": "open",
                    "title": "Issue with “UTF-8” title",
                    "labels": ["bug"],
                    "kind": "issue",
                })
                .to_string(),
            ),
        ]
    );
}

#[tokio::test]
async fn item_plan_process_failure_preserves_the_stderr_cause() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([Err(LoopxProcessError::Exited {
                code: Some(1),
                stdout_tail: vec![
                    "irrelevant output before the error".repeat(30),
                    r#"{"ok":false,"error":"metadata projection failed"}"#.to_string(),
                ],
                stderr_tail: Vec::new(),
                payload: None,
            })]),
    ));
    let adapter = adapter_with_runner(temporary.path(), runner, Arc::new(FakeLocator::new(None)));
    let error = adapter
        .plan_item(
            LoopxCliPlanItemRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "plan-item-failure".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-42".to_string(),
                    generation: 1,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec!["shell".to_string()],
                },
                item: LoopxIssueKey {
                    repository: LoopxRepositoryKey {
                        host: "github.com".to_string(),
                        owner: "owner".to_string(),
                        repository: "repo".to_string(),
                    },
                    kind: LoopxItemKind::Issue,
                    number: 42,
                },
                title: "Issue with UTF-8 title".to_string(),
                state: LoopxRemoteItemState::Unknown,
                labels: Vec::new(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, LoopxCliErrorKind::Process);
    assert!(error.message.contains("metadata projection failed"));
    assert!(error.message.contains("status Some(1)"));
}

#[tokio::test]
async fn waiting_goal_without_typed_gate_projects_owner_action_summary() {
    // A7 regression (live 2026-09-08, issue 2): LoopX projected a user wait
    // whose open user todo is a plain owner review/merge queue entry
    // (`task_class: user_action`, not a typed `user_gate`). The old
    // projection failed the whole inspection with SchemaMismatch and parked
    // a fully finished task (PR already opened) as recovery_required. The
    // projection must return no gate plus a human summary instead.
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let turn_plan = json!({
        "ok": true,
        "status": "operator_gate_notify",
        "schema_version": "loopx_turn_plan_v0",
        "turn_envelope": {
            "should_run": true,
            "state": "active",
            "effective_action": "operator_gate_notify",
            "open_count": 1,
            "user": {
                "action_required": true,
                "open_count": 1
            },
            "action_signature": {
                "source_decision_hash": "sha256:owner-action-revision"
            }
        }
    });
    let todos = json!({
        "ok": true,
        "todos": [{
            "todo_id": "todo_owner_review",
            "role": "user",
            "task_class": "user_action",
            "status": "open",
            "done": false,
            "text": "Review and merge the open pull request that fixes issue 2"
        }]
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([output(turn_plan.to_string()), output(todos.to_string())]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let snapshot = adapter
        .inspect_goal(
            LoopxCliInspectGoalRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "inspect-owner-action".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-42".to_string(),
                    generation: 3,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: [
                        "filesystem_read",
                        "filesystem_write",
                        "shell",
                        "network",
                        "external_evidence_poll",
                    ]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                },
                goal_id: "goal-42".to_string(),
                agent_id: "bitfun-agent".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    // `should_run=true` keeps driving independent safe work (same policy as
    // the typed-gate test above); the owner-action wait is projected
    // alongside as a summary, not a host-answerable gate.
    assert_eq!(snapshot.run_decision, LoopxCliRunDecision::RunNow);
    assert!(snapshot.pending_user_gate.is_none());
    let summary = snapshot
        .waiting_user_summary
        .as_deref()
        .expect("owner action summary projected");
    assert!(summary.contains("Review and merge"));
}

#[tokio::test]
async fn waiting_goal_projects_the_concrete_open_user_gate() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let turn_plan = json!({
        "ok": true,
        "status": "operator_gate_notify",
        "schema_version": "loopx_turn_plan_v0",
        "turn_envelope": {
            "should_run": true,
            "state": "active",
            "effective_action": "operator_gate_notify",
            "open_count": 1,
            "user": {
                "action_required": true,
                "open_count": 1
            },
            "action_signature": {
                "source_decision_hash": "sha256:user-gate-revision"
            }
        }
    });
    let todos = json!({
        "ok": true,
        "todos": [{
            "todo_id": "todo_release_approval",
            "role": "user",
            "task_class": "user_gate",
            "status": "open",
            "done": false,
            "text": "Approve creating the draft pull request",
            "action_kind": "gate"
        }]
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([output(turn_plan.to_string()), output(todos.to_string())]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let snapshot = adapter
        .inspect_goal(
            LoopxCliInspectGoalRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "inspect-user-gate".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-42".to_string(),
                    generation: 3,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: [
                        "filesystem_read",
                        "filesystem_write",
                        "shell",
                        "network",
                        "external_evidence_poll",
                    ]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                },
                goal_id: "goal-42".to_string(),
                agent_id: "bitfun-agent".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    // Since the custom-runner alignment (9fa63eb8c), `should_run=true` wins
    // over a pending user gate: the controller keeps driving independent
    // safe work while projecting the gate concurrently, so the snapshot is
    // `RunNow` with the concrete open user gate still attached.
    assert_eq!(snapshot.run_decision, LoopxCliRunDecision::RunNow);
    assert_eq!(snapshot.waiting_user_todo_count, 1);
    let gate = snapshot.pending_user_gate.expect("projected user gate");
    assert_eq!(gate.gate_id, "todo_release_approval");
    assert_eq!(gate.message, "Approve creating the draft pull request");
    assert_eq!(gate.action_kind.as_deref(), Some("gate"));
    let commands = runner
        .plans()
        .into_iter()
        .skip(2)
        .map(|plan| plan.args)
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 2);
    for capability in ["filesystem_read", "filesystem_write", "shell", "network"] {
        assert!(commands[0].windows(2).any(|args| {
            args == [
                OsString::from("--available-capability"),
                OsString::from(capability),
            ]
        }));
    }
    assert!(commands[1]
        .windows(2)
        .any(|args| { args == [OsString::from("todo"), OsString::from("list")] }));
}

/// The pinned CLI answers `turn plan` for its plan-exhausted replan frontier
/// (all todos done or blocked, open replan obligation, no selected todo) with
/// `ok:false`, the `host-bound routes require ... lineage` error, and exit 1.
/// `inspect_goal` must salvage the typed payload into the equivalent
/// read-only `RunNow`-without-todo snapshot so the controller parks the task
/// instead of failing it with a raw process error (observed live on task
/// anywhere-labs/dsh-desktop#827).
#[tokio::test]
async fn inspect_goal_salvages_the_replan_lineage_contract_error() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let turn_plan = json!({
        "ok": false,
        "schema_version": "loopx_turn_plan_v0",
        "error": "host-bound routes require goal, agent, todo, and action-hash lineage",
        "route": {"kind": "contract_error"},
        "turn_envelope": {
            "should_run": true,
            "state": "active",
            "effective_action": "autonomous_replan_required",
            "open_count": 0,
            "user": {"action_required": false, "open_count": 0},
            "action": {"selected_todo": null},
            "replan_action_packet": {"obligation_id": "replan-1"},
            "compaction": {"within_budget": true},
            "action_signature": {
                "source_decision_hash": "sha256:replan-lineage-revision"
            }
        }
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([Err(LoopxProcessError::Exited {
                code: Some(1),
                stdout_tail: Vec::new(),
                stderr_tail: Vec::new(),
                payload: Some(turn_plan),
            })]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let snapshot = adapter
        .inspect_goal(
            LoopxCliInspectGoalRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "inspect-replan-lineage".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-827".to_string(),
                    generation: 6,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec!["shell".to_string()],
                },
                goal_id: "goal-827".to_string(),
                agent_id: "bitfun-agent".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(snapshot.run_decision, LoopxCliRunDecision::RunNow);
    assert_eq!(snapshot.open_todo_count, 0);
    assert_eq!(snapshot.waiting_user_todo_count, 0);
    assert_eq!(snapshot.selected_todo, None);
    assert_eq!(snapshot.durable_revision, "sha256:replan-lineage-revision");
    // The open obligation must ride along so the controller drives the
    // replan turn instead of parking the task.
    assert_eq!(
        snapshot.pending_replan_obligation_id.as_deref(),
        Some("replan-1")
    );
    assert!(!snapshot.envelope_over_budget);
    // The salvaged projection performs no follow-up todo list command.
    assert_eq!(runner.plans().len(), 3);
}

/// A turn that completed its writeback and quota spend must still settle when
/// the CLI answers the settlement inspection with the replan-lineage contract
/// error: durable evidence comes from `history`, and the salvaged snapshot
/// feeds `after_revision` (observed live: task #827's final onboarding turn
/// failed settlement purely because of this inspection error).
#[tokio::test]
async fn settle_turn_survives_the_replan_lineage_contract_error() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let turn_plan = json!({
        "ok": false,
        "schema_version": "loopx_turn_plan_v0",
        "error": "host-bound routes require goal, agent, todo, and action-hash lineage",
        "turn_envelope": {
            "should_run": true,
            "state": "active",
            "effective_action": "autonomous_replan_required",
            "open_count": 0,
            "user": {"action_required": false, "open_count": 0},
            "action": {"selected_todo": null},
            "replan_action_packet": {"obligation_id": "replan-1"},
            "compaction": {"within_budget": true},
            "action_signature": {
                "source_decision_hash": "sha256:replan-lineage-revision"
            }
        }
    });
    let effect_id = "goal-827:bitfun-agent:todo-1:turn-827";
    let history = json!({
        "ok": true,
        "goals": [{
            "id": "goal-827",
            "latest_runs": [
                {
                    "goal_id": "goal-827",
                    "agent_id": "bitfun-agent",
                    "todo_id": "todo-1",
                    "turn_instance_id": "turn-827",
                    "classification": "quota_slot_spent",
                    "settlement_identity": {
                        "schema_version": "quota_settlement_identity_v0",
                        "effect_id": effect_id,
                        "goal_id": "goal-827",
                        "agent_id": "bitfun-agent",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-827"
                    }
                },
                {
                    "goal_id": "goal-827",
                    "agent_id": "bitfun-agent",
                    "todo_id": "todo-1",
                    "turn_instance_id": "turn-827",
                    "classification": "validated_progress",
                    "delivery_outcome": "outcome_progress",
                    "settlement_identity": {
                        "schema_version": "quota_settlement_identity_v0",
                        "effect_id": effect_id,
                        "goal_id": "goal-827",
                        "agent_id": "bitfun-agent",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-827"
                    }
                }
            ]
        }]
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([
                Err(LoopxProcessError::Exited {
                    code: Some(1),
                    stdout_tail: Vec::new(),
                    stderr_tail: Vec::new(),
                    payload: Some(turn_plan),
                }),
                output(history.to_string()),
            ]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let settlement = adapter
        .verify_turn_settlement(
            LoopxCliSettleTurnRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "settle-replan-lineage".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-827".to_string(),
                    generation: 6,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec![],
                },
                goal_id: "goal-827".to_string(),
                agent_id: "bitfun-agent".to_string(),
                turn_id: "turn-827".to_string(),
                settlement_token: effect_id.to_string(),
                expected_durable_revision: "sha256:replan-lineage-revision".to_string(),
                agent_status: LoopxAgentTurnStatus::Completed,
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(settlement.status, LoopxCliSettlementStatus::Settled);
    assert_eq!(settlement.receipt_id, effect_id);
    assert_eq!(settlement.after_revision, "sha256:replan-lineage-revision");
    // The settlement must still consult durable history evidence.
    let commands = runner
        .plans()
        .into_iter()
        .skip(2)
        .map(|plan| plan.args)
        .collect::<Vec<_>>();
    assert!(commands.iter().any(|args| {
        args.windows(2)
            .any(|w| w == [OsString::from("history"), OsString::from("--goal-id")])
    }));
}

/// Only the exact replan-lineage contract error is salvaged; other non-zero
/// exits keep their typed process error so unrelated CLI failures still
/// surface.
#[tokio::test]
async fn inspect_goal_keeps_other_process_failures() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let unrelated = json!({
        "ok": false,
        "schema_version": "loopx_turn_plan_v0",
        "error": "some other CLI failure",
        "turn_envelope": {
            "should_run": true,
            "action": {"selected_todo": null},
            "replan_action_packet": {"obligation_id": "replan-1"}
        }
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([Err(LoopxProcessError::Exited {
                code: Some(1),
                stdout_tail: vec![r#"  "error": "some other CLI failure""#.to_string()],
                stderr_tail: Vec::new(),
                payload: Some(unrelated),
            })]),
    ));
    let adapter = adapter_with_runner(temporary.path(), runner, Arc::new(FakeLocator::new(None)));

    let error = adapter
        .inspect_goal(
            LoopxCliInspectGoalRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "inspect-unrelated-failure".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-x".to_string(),
                    generation: 1,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec![],
                },
                goal_id: "goal-x".to_string(),
                agent_id: "bitfun-agent".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap_err();

    assert!(error.message.contains("some other CLI failure"));
}

#[tokio::test]
async fn ordinary_monitor_wait_does_not_require_a_user_gate() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let turn_plan = json!({
        "ok": true,
        "schema_version": "loopx_turn_plan_v0",
        "turn_envelope": {
            "should_run": false,
            "state": "waiting",
            "action_required": false,
            "user": {
                "action_required": false,
                "open_count": 0
            },
            "action_signature": {
                "source_decision_hash": "sha256:monitor-wait-revision"
            }
        }
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([output(turn_plan.to_string())]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let snapshot = adapter
        .inspect_goal(
            LoopxCliInspectGoalRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "inspect-monitor-wait".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-monitor".to_string(),
                    generation: 1,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec!["shell".to_string()],
                },
                goal_id: "goal-monitor".to_string(),
                agent_id: "bitfun-agent".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert_eq!(snapshot.run_decision, LoopxCliRunDecision::Wait);
    assert_eq!(snapshot.pending_user_gate, None);
    assert_eq!(runner.plans().len(), 3);
}

#[tokio::test]
async fn build_turn_accepts_a_fresh_guard_revision_as_the_agent_contract() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let envelope = json!({
        "ok": true,
        "schema_version": "loopx_turn_envelope_v0",
        "goal_id": "goal-42",
        "agent_id": "bitfun-agent",
        "should_run": true,
        "state": "eligible",
        "action": {
            "recommended_action": "Fix the selected issue.",
            "selected_todo": {"todo_id": "todo-42"}
        },
        "required_reads": [],
        "boundary": {"write_scope": "workspace"},
        "execution_policy": {"normal_delivery_allowed": true},
        "writeback": {"spend_after_validation": true},
        "contract_capsule": {"schema_version": "loopx_contract_capsule_v0"},
        "action_signature": {"source_hash": "sha256:durable-revision"}
    });
    let runner = Arc::new(FakeRunner::with_results(
        handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
            .into_iter()
            .chain([output(envelope.to_string())]),
    ));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );

    let turn = adapter
        .build_turn(
            LoopxCliBuildTurnRequest {
                context: LoopxCliGoalContext {
                    call: LoopxCliCallContext {
                        operation_id: "build-turn".to_string(),
                        deadline_at: None,
                    },
                    task_id: "task-42".to_string(),
                    generation: 3,
                    worktree_path: worktree.to_string_lossy().into_owned(),
                    registry_path: registry.to_string_lossy().into_owned(),
                    available_capabilities: vec!["shell".to_string()],
                },
                goal_id: "goal-42".to_string(),
                agent_id: "bitfun-agent".to_string(),
                expected_durable_revision: "sha256:earlier-inspect-revision".to_string(),
            },
            &RecordingProgressSink::default(),
        )
        .await
        .unwrap();

    assert!(turn.agent_instruction.contains("Fix the selected issue."));
    assert!(turn
        .agent_instruction
        .contains("Claim the selected executable todo"));
    assert_eq!(turn.durable_revision, "sha256:durable-revision");
    assert_eq!(
        turn.settlement_token,
        format!("goal-42:bitfun-agent:todo-42:{}", turn.turn_id)
    );
    let commands = runner
        .plans()
        .into_iter()
        .skip(2)
        .map(|plan| plan.args)
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 1);
    assert!(commands[0]
        .windows(2)
        .any(|args| args == ["quota", "should-run"]));
    assert!(commands[0].contains(&OsString::from("--turn-envelope")));
    assert!(commands[0].windows(2).any(|args| {
        args == [
            OsString::from("--available-capability"),
            OsString::from("shell"),
        ]
    }));
    assert!(!commands[0].windows(2).any(|args| args == ["turn", "plan"]));
}

#[tokio::test]
async fn create_goal_recovery_does_not_duplicate_an_existing_planned_todo() {
    let temporary = tempfile::tempdir().unwrap();
    stage_bundle(temporary.path(), "v0.5.1", 1);
    let worktree = temporary.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let registry = worktree.join(".loopx").join("registry.json");
    let planned_todo = LoopxCliTodoPlan {
        role: "agent".to_string(),
        task_class: "advancement_task".to_string(),
        action_kind: Some("fix_issue".to_string()),
        text: "[P1] Fix issue #42".to_string(),
        target_key: None,
    };
    let results = handshake_results("loopx 0.5.1", LOOPX_COMMAND_REFERENCE_SCHEMA)
        .into_iter()
        .chain([
            output(json!({"ok": true, "state_action": "kept"}).to_string()),
            // register-agent acknowledgment.
            output(json!({"ok": true}).to_string()),
            // agent-onboard pack (fetched after registration so the pack
            // carries the registered agent id).
            output(
                json!({
                    "ok": true,
                    "schema_version": "loopx_agent_onboarding_v0",
                    "agent_type": "other-agent",
                    "agent_id": "bitfun-agent"
                })
                .to_string(),
            ),
            output(
                json!({
                    "ok": true,
                    "todos": [{
                        "role": planned_todo.role.clone(),
                        "task_class": planned_todo.task_class.clone(),
                        "action_kind": planned_todo.action_kind.clone(),
                        "text": planned_todo.text.clone(),
                    }]
                })
                .to_string(),
            ),
            output(
                json!({
                    "ok": true,
                    "schema_version": "loopx_turn_plan_v0",
                    "turn_envelope": {
                        "action_signature": {"source_decision_hash": "sha256:durable-revision"}
                    },
                    "transaction": {"turn_key": "sha256:turn"}
                })
                .to_string(),
            ),
        ]);
    let runner = Arc::new(FakeRunner::with_results(results));
    let adapter = adapter_with_runner(
        temporary.path(),
        runner.clone(),
        Arc::new(FakeLocator::new(None)),
    );
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };
    let request = LoopxCliCreateGoalRequest {
        context: LoopxCliGoalContext {
            call: LoopxCliCallContext {
                operation_id: "create-recovery".to_string(),
                deadline_at: None,
            },
            task_id: "task-42".to_string(),
            generation: 2,
            worktree_path: worktree.to_string_lossy().into_owned(),
            registry_path: registry.to_string_lossy().into_owned(),
            available_capabilities: vec!["shell".to_string()],
        },
        goal_id: "goal-42".to_string(),
        agent_id: "bitfun-agent".to_string(),
        intake: LoopxCliIntakePlan {
            item,
            objective: "Fix issue 42".to_string(),
            todos: vec![planned_todo],
        },
        granted_scopes: vec![LoopxPermissionScope::WorkspaceWrite],
    };

    let result = adapter
        .create_goal(request, &RecordingProgressSink::default())
        .await
        .unwrap();

    assert!(!result.created);
    assert_eq!(result.durable_revision, "sha256:durable-revision");
    let commands = runner
        .plans()
        .into_iter()
        .skip(2)
        .map(|plan| plan.args)
        .collect::<Vec<_>>();
    // bootstrap + register-agent + agent-onboard + todo list + turn-plan
    // inspection: the onboard pack fetch (after registration so it carries
    // the registered agent id) adds exactly one command.
    assert_eq!(commands.len(), 5);
    assert!(commands.iter().any(|args| {
        args.windows(2)
            .any(|pair| pair[0] == OsString::from("agent-onboard"))
    }));
    assert!(!commands.iter().any(|args| {
        args.windows(2)
            .any(|pair| pair[0] == OsString::from("todo") && pair[1] == OsString::from("add"))
    }));
}

#[test]
fn workspace_plan_uses_hashed_paths_and_noninteractive_structured_clone() {
    let root = if cfg!(windows) {
        PathBuf::from(r"C:\managed-loopx")
    } else {
        PathBuf::from("/managed-loopx")
    };
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "Owner".to_string(),
            repository: "Repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };

    let layout = plan_workspace_layout(&root, "task-sensitive-name", &item).unwrap();
    let command = plan_git_clone_command(Path::new("git"), &layout);

    assert!(layout.worktree_path.starts_with(&root));
    assert!(!layout.worktree_path.to_string_lossy().contains("Owner"));
    assert!(layout
        .registry_path
        .ends_with(Path::new(".loopx/registry.json")));
    assert_eq!(command.args[0], OsString::from("clone"));
    assert_eq!(command.args[1], OsString::from("--no-checkout"));
    assert!(command.args.contains(&OsString::from("--")));
    assert_eq!(
        command
            .environment
            .get(&OsString::from("GIT_TERMINAL_PROMPT")),
        Some(&OsString::from("0"))
    );
    assert_eq!(
        canonical_github_remote("git@github.com:OWNER/Repo.git").as_deref(),
        Some("github.com/owner/repo")
    );
}

#[tokio::test]
async fn workspace_prepare_clones_once_then_reuses_verified_marker_and_origin() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("loopx-workspaces");
    let runner = Arc::new(WorkspaceFakeRunner::new(
        "https://github.com/owner/repo.git",
    ));
    let mut config = LoopxWorkspaceServiceConfig::new(&root, "git");
    config.clone_deadline = Duration::from_secs(7);
    config.command_deadline = Duration::from_secs(3);
    let service = LoopxWorkspaceService::with_runner(
        config,
        runner.clone(),
        Arc::new(NoopLoopxProcessObserver),
    );
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };
    let request = LoopxWorkspacePrepareRequest {
        operation_id: "workspace-first".to_string(),
        task_id: "task-42".to_string(),
        item: item.clone(),
    };

    let created = service.prepare(request).await.unwrap();
    let reused = service
        .prepare(LoopxWorkspacePrepareRequest {
            operation_id: "workspace-second".to_string(),
            task_id: "task-42".to_string(),
            item,
        })
        .await
        .unwrap();

    assert!(!created.reused);
    assert!(created.repository_verified);
    assert!(reused.reused);
    assert_eq!(created.worktree_path, reused.worktree_path);
    assert!(Path::new(&created.registry_path).ends_with(Path::new(".loopx/registry.json")));
    let plans = runner.plans.lock().unwrap();
    // Shared layout: bare clone + worktree add + origin verify, then the
    // reuse path verifies the origin again.
    assert_eq!(plans.len(), 4);
    assert_eq!(plans[0].deadline, Duration::from_secs(7));
    assert_eq!(plans[1].deadline, Duration::from_secs(7));
    assert_eq!(plans[2].deadline, Duration::from_secs(3));
    assert_eq!(plans[3].deadline, Duration::from_secs(3));
    assert_eq!(plans[0].args[0], OsString::from("clone"));
    assert!(plans[0].args.contains(&OsString::from("--bare")));
    assert!(plans[1].args.windows(3).any(|w| w
        == [
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("-b")
        ]));
}

#[tokio::test]
async fn workspace_dispose_removes_linked_worktree_and_last_shared_bare_repository() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("loopx-workspaces");
    let runner = Arc::new(WorkspaceFakeRunner::new(
        "https://github.com/owner/repo.git",
    ));
    let service = LoopxWorkspaceService::with_runner(
        LoopxWorkspaceServiceConfig::new(&root, "git"),
        runner.clone(),
        Arc::new(NoopLoopxProcessObserver),
    );
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };

    let prepared = service
        .prepare(LoopxWorkspacePrepareRequest {
            operation_id: "workspace-dispose-prepare".to_string(),
            task_id: "task-42".to_string(),
            item: item.clone(),
        })
        .await
        .unwrap();

    // A marker outside the worktree keeps dispose from touching it.
    let worktree = PathBuf::from(&prepared.worktree_path);
    assert!(worktree.exists());
    let bare = worktree.parent().expect("worktree parent").join("bare.git");
    assert!(bare.exists());

    let disposed = service
        .dispose(LoopxWorkspaceDisposeRequest {
            operation_id: "workspace-dispose".to_string(),
            task_id: "task-42".to_string(),
            item,
        })
        .await
        .unwrap();
    assert!(disposed.removed);
    assert!(!worktree.exists());
    // Last linked worktree was removed, so the bare repository is gone too.
    assert!(!bare.exists());

    let plans = runner.plans.lock().unwrap();
    assert!(plans.iter().any(|plan| {
        plan.args.windows(3).any(|w| {
            w == [
                OsString::from("worktree"),
                OsString::from("remove"),
                OsString::from("--force"),
            ]
        })
    }));
    assert!(plans.iter().any(|plan| {
        plan.args
            .windows(2)
            .any(|w| w == [OsString::from("worktree"), OsString::from("list")])
    }));
}

#[tokio::test]
async fn workspace_reset_detaches_tasks_but_retains_bare_repository_cache() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("loopx-workspaces");
    let runner = Arc::new(WorkspaceFakeRunner::new(
        "https://github.com/owner/repo.git",
    ));
    let service = LoopxWorkspaceService::with_runner(
        LoopxWorkspaceServiceConfig::new(&root, "git"),
        runner.clone(),
        Arc::new(NoopLoopxProcessObserver),
    );
    let item = LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        },
        kind: LoopxItemKind::Issue,
        number: 42,
    };
    let prepared = service
        .prepare(LoopxWorkspacePrepareRequest {
            operation_id: "workspace-reset-prepare".to_string(),
            task_id: "task-42".to_string(),
            item,
        })
        .await
        .unwrap();
    let worktree = PathBuf::from(prepared.worktree_path);
    let repository_dir = worktree.parent().unwrap().to_path_buf();
    let bare = repository_dir.join("bare.git");
    std::fs::write(worktree.join("large-generated-file"), b"payload").unwrap();

    let reset = service
        .reset(LoopxWorkspaceResetRequest {
            operation_id: "workspace-reset".to_string(),
        })
        .await
        .unwrap();

    assert!(reset.removed);
    assert!(root.exists());
    assert!(bare.exists());
    assert!(!worktree.exists());
    assert!(runner.plans.lock().unwrap().iter().any(|plan| {
        plan.args
            .windows(2)
            .any(|pair| pair == ["worktree", "prune"])
    }));
}

#[tokio::test]
async fn workspace_dispose_keeps_shared_bare_repository_while_other_worktrees_exist() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("loopx-workspaces");
    let runner = Arc::new(WorkspaceFakeRunner::new(
        "https://github.com/owner/repo.git",
    ));
    let service = LoopxWorkspaceService::with_runner(
        LoopxWorkspaceServiceConfig::new(&root, "git"),
        runner.clone(),
        Arc::new(NoopLoopxProcessObserver),
    );
    let repo = LoopxRepositoryKey {
        host: "github.com".to_string(),
        owner: "owner".to_string(),
        repository: "repo".to_string(),
    };
    let item_42 = LoopxIssueKey {
        repository: repo.clone(),
        kind: LoopxItemKind::Issue,
        number: 42,
    };
    let item_43 = LoopxIssueKey {
        repository: repo,
        kind: LoopxItemKind::Issue,
        number: 43,
    };

    let first = service
        .prepare(LoopxWorkspacePrepareRequest {
            operation_id: "workspace-shared-prepare-1".to_string(),
            task_id: "task-42".to_string(),
            item: item_42.clone(),
        })
        .await
        .unwrap();
    let second = service
        .prepare(LoopxWorkspacePrepareRequest {
            operation_id: "workspace-shared-prepare-2".to_string(),
            task_id: "task-43".to_string(),
            item: item_43.clone(),
        })
        .await
        .unwrap();
    let bare = PathBuf::from(&first.worktree_path)
        .parent()
        .expect("worktree parent")
        .join("bare.git");
    assert!(bare.exists());
    // Same repository shares one bare object database.
    assert_eq!(
        Path::new(&first.worktree_path)
            .parent()
            .expect("first parent"),
        Path::new(&second.worktree_path)
            .parent()
            .expect("second parent")
    );

    // Removing only one worktree keeps the shared bare repository.
    let disposed = service
        .dispose(LoopxWorkspaceDisposeRequest {
            operation_id: "workspace-shared-dispose-1".to_string(),
            task_id: "task-42".to_string(),
            item: item_42,
        })
        .await
        .unwrap();
    assert!(disposed.removed);
    assert!(!Path::new(&first.worktree_path).exists());
    assert!(bare.exists());

    // Removing the last worktree removes the bare repository as well.
    let final_dispose = service
        .dispose(LoopxWorkspaceDisposeRequest {
            operation_id: "workspace-shared-dispose-2".to_string(),
            task_id: "task-43".to_string(),
            item: item_43,
        })
        .await
        .unwrap();
    assert!(final_dispose.removed);
    assert!(!bare.exists());
}

#[tokio::test]
async fn workspace_probe_checks_git_root_writability_and_repository_access() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("loopx-workspaces");
    let runner = Arc::new(WorkspaceFakeRunner::new(
        "https://github.com/owner/repo.git",
    ));
    let service = LoopxWorkspaceService::with_runner(
        LoopxWorkspaceServiceConfig::new(&root, "git"),
        runner.clone(),
        Arc::new(NoopLoopxProcessObserver),
    );

    let result = service
        .probe(LoopxWorkspaceProbeRequest {
            operation_id: "workspace-probe".to_string(),
            repository: Some(LoopxRepositoryKey {
                host: "github.com".to_string(),
                owner: "owner".to_string(),
                repository: "repo".to_string(),
            }),
        })
        .await
        .unwrap();

    assert_eq!(result.git_version.as_deref(), Some("git version 2.53.0"));
    assert!(result.repository_verified);
    assert!(Path::new(&result.workspace_root).is_absolute());
    let plans = runner.plans.lock().unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].args, [OsString::from("--version")]);
    assert_eq!(plans[1].args[0], OsString::from("ls-remote"));
    assert!(plans[1]
        .args
        .contains(&OsString::from("https://github.com/owner/repo.git")));
}

#[tokio::test]
async fn workspace_probe_surfaces_the_actionable_git_stderr() {
    let temporary = tempfile::tempdir().unwrap();
    let runner = Arc::new(FakeRunner::with_results([Err(LoopxProcessError::Exited {
        code: Some(128),
        stdout_tail: Vec::new(),
        stderr_tail: vec!["fatal: unable to access repository".to_string()],
        payload: None,
    })]));
    let service = LoopxWorkspaceService::with_runner(
        LoopxWorkspaceServiceConfig::new(temporary.path().join("workspaces"), "git"),
        runner,
        Arc::new(NoopLoopxProcessObserver),
    );

    let error = service
        .probe(LoopxWorkspaceProbeRequest {
            operation_id: "workspace-probe-error".to_string(),
            repository: None,
        })
        .await
        .unwrap_err();

    assert!(error.message.contains("status Some(128)"));
    assert!(error.message.contains("fatal: unable to access repository"));
}

#[test]
fn managed_process_fixture() {
    match std::env::var("BITFUN_LOOPX_PROCESS_FIXTURE").as_deref() {
        Ok("exit") => std::process::exit(23),
        Ok("sleep") => std::thread::sleep(Duration::from_secs(60)),
        Ok("stderr") => eprintln!("fixture progress line"),
        _ => {}
    }
}

fn fixture_plan(kind: &str, deadline: Duration) -> LoopxCommandPlan {
    let mut environment = BTreeMap::new();
    environment.insert(
        OsString::from("BITFUN_LOOPX_PROCESS_FIXTURE"),
        OsString::from(kind),
    );
    LoopxCommandPlan {
        operation_id: format!("fixture-{kind}"),
        executable: std::env::current_exe().unwrap(),
        args: ["--exact", "managed_process_fixture", "--nocapture"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        current_dir: None,
        environment,
        deadline,
        terminate_grace: Duration::from_millis(50),
    }
}

#[tokio::test]
async fn child_exit_is_reported_immediately() {
    let started = Instant::now();
    let error = SystemLoopxProcessRunner
        .run(
            fixture_plan("exit", Duration::from_secs(5)),
            CancellationToken::new(),
            &NoopLoopxProcessObserver,
        )
        .await
        .unwrap_err();

    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(matches!(
        error,
        LoopxProcessError::Exited { code: Some(23), .. }
    ));
}

#[tokio::test]
async fn deadline_terminates_the_managed_process_tree() {
    let started = Instant::now();
    let error = SystemLoopxProcessRunner
        .run(
            fixture_plan("sleep", Duration::from_millis(50)),
            CancellationToken::new(),
            &NoopLoopxProcessObserver,
        )
        .await
        .unwrap_err();

    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(matches!(error, LoopxProcessError::Timeout { .. }));
}

#[tokio::test]
async fn stderr_is_streamed_as_progress_before_success() {
    let observer = RecordingProcessObserver::default();
    SystemLoopxProcessRunner
        .run(
            fixture_plan("stderr", Duration::from_secs(5)),
            CancellationToken::new(),
            &observer,
        )
        .await
        .unwrap();

    let progress = observer.0.lock().unwrap();
    assert!(progress.iter().any(|event| {
        event.stage == LoopxProgressStage::Stderr && event.message.contains("fixture progress line")
    }));
    assert_eq!(
        progress.last().map(|event| event.stage),
        Some(LoopxProgressStage::Exited)
    );
}

#[test]
fn command_sources_keep_packaged_managed_and_system_paths_distinct() {
    assert_ne!(
        LoopxCommandSource::PackagedBundle,
        LoopxCommandSource::ManagedSource
    );
    assert_ne!(
        LoopxCommandSource::ManagedSource,
        LoopxCommandSource::FixedSystemCommand
    );
}
