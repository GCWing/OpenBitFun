//! Managed LoopX CLI integration for the built-in LoopX MiniApp.
//!
//! The product-facing adapter below never accepts an executable or an argv
//! prefix from callers. It selects the packaged binary first and only permits
//! the fixed `loopx` system command when that fallback was explicitly enabled.

use async_trait::async_trait;
use openbitfun_product_domains::miniapp::loopx as loopx_contract;
use openbitfun_services_core::process_tree::ProcessTreeChild;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

pub const LOOPX_PINNED_VERSION: &str = "0.5.1";
pub const LOOPX_PINNED_VERSION_TAG: &str = "v0.5.1";
pub const LOOPX_PINNED_VERSION_OUTPUT: &str = "loopx 0.5.1";
pub const LOOPX_SOURCE_REPOSITORY: &str = "https://github.com/huangruiteng/loopx.git";
pub const LOOPX_PINNED_SOURCE_COMMIT: &str = "1bb42f4cb3e329dcb71c64654228f951098cead1";
pub const LOOPX_BUNDLE_MANIFEST_SCHEMA: u32 = 1;
pub const LOOPX_COMMAND_REFERENCE_SCHEMA: &str = "loopx_command_reference_v0";

const MAX_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES: usize = 32 * 1024;
const MAX_PROGRESS_LINE_BYTES: usize = 4 * 1024;
const PIPE_DRAIN_DEADLINE: Duration = Duration::from_millis(250);
const SETTLEMENT_HISTORY_LIMIT: &str = "100";
const MANAGED_SOURCE_MANIFEST: &str = ".bitfun-managed-source.json";
const MANAGED_SOURCE_MANIFEST_SCHEMA: u32 = 1;
const PYTHON_LOOPX_ENTRYPOINT: &str = "import os,sys; sys.path.insert(0, os.environ['BITFUN_LOOPX_SOURCE']); from loopx.entrypoint import main; raise SystemExit(main())";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopxSystemFallbackPolicy {
    Disabled,
    ExactPinned,
}

#[derive(Debug, Clone)]
pub struct LoopxCliAdapterConfig {
    pub resource_dir: PathBuf,
    pub managed_source_dir: Option<PathBuf>,
    pub system_fallback: LoopxSystemFallbackPolicy,
    pub startup_deadline: Duration,
    pub command_deadline: Duration,
    pub install_deadline: Duration,
    pub terminate_grace: Duration,
}

impl LoopxCliAdapterConfig {
    pub fn packaged(resource_dir: impl Into<PathBuf>) -> Self {
        Self {
            resource_dir: resource_dir.into(),
            managed_source_dir: None,
            system_fallback: LoopxSystemFallbackPolicy::Disabled,
            startup_deadline: Duration::from_secs(60),
            command_deadline: Duration::from_secs(180),
            install_deadline: Duration::from_secs(10 * 60),
            terminate_grace: Duration::from_secs(2),
        }
    }

    pub fn with_managed_source_dir(mut self, managed_source_dir: impl Into<PathBuf>) -> Self {
        self.managed_source_dir = Some(managed_source_dir.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopxCommandSource {
    PackagedBundle,
    ManagedSource,
    FixedSystemCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLoopxCommand {
    pub executable: PathBuf,
    pub prefix_args: Vec<OsString>,
    pub environment: BTreeMap<OsString, OsString>,
    pub source: LoopxCommandSource,
    pub version: String,
    pub bundle_manifest_schema: Option<u32>,
    pub command_reference_schema: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopxCommandPlan {
    pub operation_id: String,
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub environment: BTreeMap<OsString, OsString>,
    pub deadline: Duration,
    pub terminate_grace: Duration,
}

impl LoopxCommandPlan {
    fn handshake(
        operation_id: impl Into<String>,
        executable: PathBuf,
        prefix_args: &[OsString],
        environment: &BTreeMap<OsString, OsString>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        deadline: Duration,
        terminate_grace: Duration,
    ) -> Self {
        let mut command_args = prefix_args.to_vec();
        command_args.extend(args.into_iter().map(Into::into));
        Self {
            operation_id: operation_id.into(),
            executable,
            args: command_args,
            current_dir: None,
            environment: environment.clone(),
            deadline,
            terminate_grace,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopxProgressStage {
    Starting,
    Stderr,
    Exited,
    Cancelling,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopxProcessProgress {
    pub operation_id: String,
    pub stage: LoopxProgressStage,
    pub message: String,
    pub occurred_at_unix_ms: u64,
}

pub trait LoopxProcessObserver: Send + Sync {
    fn on_progress(&self, progress: LoopxProcessProgress);
}

#[derive(Debug, Default)]
pub struct NoopLoopxProcessObserver;

impl LoopxProcessObserver for NoopLoopxProcessObserver {
    fn on_progress(&self, _progress: LoopxProcessProgress) {}
}

/// Forces UTF-8 stdio for the packaged LoopX sidecar.
///
/// The bundled `loopx.exe` is a PyInstaller-built Python CLI. On Windows hosts
/// whose ANSI code page is not UTF-8 (e.g. zh-CN / cp936), Python's stdio
/// encoding for a piped child defaults to the locale code page, so JSON output
/// containing non-ASCII text is emitted as GBK bytes. The host captures stdout
/// as UTF-8 (lossy), which replaces those bytes with U+FFFD and persists
/// mojibake in gate messages and readbacks. `PYTHONUTF8` / `PYTHONIOENCODING`
/// make the CPython runtime use UTF-8 for stdio regardless of the host code
/// page, keeping the durable readback and gate messages intact.
fn with_utf8_stdio(mut environment: BTreeMap<OsString, OsString>) -> BTreeMap<OsString, OsString> {
    environment.insert(OsString::from("PYTHONUTF8"), OsString::from("1"));
    environment.insert(OsString::from("PYTHONIOENCODING"), OsString::from("utf-8"));
    environment
}

/// Decodes LoopX process output as UTF-8 with a GBK fallback.
///
/// The packaged `loopx.exe` is a PyInstaller bundle whose Python runtime keeps
/// its stdio on the host ANSI code page (cp936 on zh-CN hosts) even when
/// `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` are set; the managed-source
/// Python entrypoint does honor those variables. Decoding the bundle's GBK
/// bytes as UTF-8 lossily turns every non-ASCII character into U+FFFD, which
/// then lands in gate messages, todo text and readbacks. Try strict UTF-8
/// first, fall back to GBK, and only then apply the lossy decode.
fn decode_loopx_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
    decoded.into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopxProcessOutput {
    pub stdout: String,
    pub stderr_tail: Vec<String>,
    pub elapsed: Duration,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LoopxProcessError {
    #[error("failed to start LoopX process: {message}")]
    Start { message: String },
    #[error("LoopX process IO failed: {message}")]
    Io { message: String },
    #[error("LoopX process exited with status {code:?}")]
    Exited {
        code: Option<i32>,
        stdout_tail: Vec<String>,
        stderr_tail: Vec<String>,
        /// Full JSON payload the CLI printed on stdout before the non-zero
        /// exit, when it parses. The pinned CLI renders typed `ok:false`
        /// failures as a complete payload followed by exit 1 (for example the
        /// `RunNow`-without-todo replan frontier, whose host-bound route
        /// lineage check fails); callers can salvage that projection instead
        /// of failing on the raw process exit. `None` when stdout was not a
        /// single JSON document.
        payload: Option<Value>,
    },
    #[error("LoopX process timed out after {deadline_ms} ms")]
    Timeout {
        deadline_ms: u64,
        stderr_tail: Vec<String>,
    },
    #[error("LoopX process was cancelled")]
    Cancelled { stderr_tail: Vec<String> },
    #[error("LoopX stdout exceeded the {limit_bytes}-byte limit")]
    OutputLimit { limit_bytes: usize },
}

#[async_trait]
pub trait LoopxProcessRunner: Send + Sync {
    async fn run(
        &self,
        plan: LoopxCommandPlan,
        cancellation: CancellationToken,
        observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxProcessOutput, LoopxProcessError>;
}

#[derive(Debug, Default)]
pub struct SystemLoopxProcessRunner;

#[async_trait]
impl LoopxProcessRunner for SystemLoopxProcessRunner {
    async fn run(
        &self,
        plan: LoopxCommandPlan,
        cancellation: CancellationToken,
        observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxProcessOutput, LoopxProcessError> {
        emit_progress(
            observer,
            &plan.operation_id,
            LoopxProgressStage::Starting,
            "Starting LoopX process",
        );

        let started = Instant::now();
        let mut command = Command::new(&plan.executable);
        command
            .args(&plan.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(current_dir) = &plan.current_dir {
            command.current_dir(current_dir);
        }
        if !plan.environment.is_empty() {
            command.envs(&plan.environment);
        }

        let mut child = ProcessTreeChild::spawn(&mut command)
            .await
            .map_err(|error| LoopxProcessError::Start {
                message: error.to_string(),
            })?;
        let stdout = child.take_stdout().ok_or_else(|| LoopxProcessError::Io {
            message: "LoopX stdout pipe was not available".to_string(),
        })?;
        let stderr = child.take_stderr().ok_or_else(|| LoopxProcessError::Io {
            message: "LoopX stderr pipe was not available".to_string(),
        })?;

        let mut stdout_task = tokio::spawn(capture_stdout(stdout));
        let (stderr_line_tx, mut stderr_line_rx) = mpsc::channel(128);
        let mut stderr_task =
            tokio::spawn(async move { capture_stderr(stderr, stderr_line_tx).await });

        enum Completion {
            Exited(std::io::Result<std::process::ExitStatus>),
            Cancelled,
            TimedOut,
        }

        let deadline = tokio::time::sleep(plan.deadline);
        tokio::pin!(deadline);
        let completion = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break Completion::Cancelled,
                _ = &mut deadline => break Completion::TimedOut,
                status = child.wait() => break Completion::Exited(status),
                line = stderr_line_rx.recv() => {
                    if let Some(line) = line {
                        emit_progress(
                            observer,
                            &plan.operation_id,
                            LoopxProgressStage::Stderr,
                            &line,
                        );
                    }
                }
            }
        };
        while let Ok(line) = stderr_line_rx.try_recv() {
            emit_progress(
                observer,
                &plan.operation_id,
                LoopxProgressStage::Stderr,
                &line,
            );
        }

        match completion {
            Completion::Cancelled => {
                emit_progress(
                    observer,
                    &plan.operation_id,
                    LoopxProgressStage::Cancelling,
                    "Cancelling LoopX process tree",
                );
                let _ = child.terminate(plan.terminate_grace).await;
                let stderr_tail = drain_stderr_task(&mut stderr_task).await;
                stdout_task.abort();
                Err(LoopxProcessError::Cancelled { stderr_tail })
            }
            Completion::TimedOut => {
                emit_progress(
                    observer,
                    &plan.operation_id,
                    LoopxProgressStage::TimedOut,
                    "LoopX process deadline expired",
                );
                let _ = child.terminate(plan.terminate_grace).await;
                let stderr_tail = drain_stderr_task(&mut stderr_task).await;
                stdout_task.abort();
                Err(LoopxProcessError::Timeout {
                    deadline_ms: duration_millis(plan.deadline),
                    stderr_tail,
                })
            }
            Completion::Exited(status) => {
                let status = status.map_err(|error| LoopxProcessError::Io {
                    message: error.to_string(),
                })?;
                let stdout_capture = drain_stdout_task(&mut stdout_task).await?;
                let stderr_tail = drain_stderr_task(&mut stderr_task).await;
                emit_progress(
                    observer,
                    &plan.operation_id,
                    LoopxProgressStage::Exited,
                    if status.success() {
                        "LoopX process exited successfully"
                    } else {
                        "LoopX process exited with an error"
                    },
                );
                if !status.success() {
                    return Err(LoopxProcessError::Exited {
                        code: status.code(),
                        stdout_tail: output_tail(&stdout_capture.bytes),
                        stderr_tail,
                        payload: serde_json::from_str(&decode_loopx_output(&stdout_capture.bytes)).ok(),
                    });
                }
                if stdout_capture.exceeded_limit {
                    return Err(LoopxProcessError::OutputLimit {
                        limit_bytes: MAX_STDOUT_BYTES,
                    });
                }
                Ok(LoopxProcessOutput {
                    stdout: decode_loopx_output(&stdout_capture.bytes),
                    stderr_tail,
                    elapsed: started.elapsed(),
                })
            }
        }
    }
}

pub trait LoopxFixedCommandLocator: Send + Sync {
    fn locate(&self) -> Result<Option<PathBuf>, String>;
}

pub trait LoopxPythonLocator: Send + Sync {
    fn locate(&self) -> Result<Option<PathBuf>, String>;
}

#[async_trait]
pub trait LoopxIntakeMetadataProvider: Send + Sync {
    async fn resolve(
        &self,
        request: &loopx_contract::LoopxCliResolveIntakeRequest,
        deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliResolveIntakeResult>;

    /// Pre-flight GitHub access probe used to populate the `github_auth`
    /// environment fact before any intake is submitted.
    async fn probe_auth(
        &self,
        deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxGithubAuthProbe>;

    /// Whether the authenticated GitHub identity can merge pull requests in
    /// the repository. `Ok(None)` = unknown (no credential or probe failure);
    /// callers must fail open to interactive decisions.
    async fn viewer_merge_authority(
        &self,
        _repository: &loopx_contract::LoopxRepositoryKey,
        _deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<Option<bool>> {
        Ok(None)
    }
}

#[derive(Debug, Default)]
pub struct UnsupportedLoopxIntakeMetadataProvider;

#[async_trait]
impl LoopxIntakeMetadataProvider for UnsupportedLoopxIntakeMetadataProvider {
    async fn resolve(
        &self,
        request: &loopx_contract::LoopxCliResolveIntakeRequest,
        _deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliResolveIntakeResult> {
        Err(loopx_contract::LoopxCliError::new(
            loopx_contract::LoopxCliErrorKind::NotFound,
            "LoopX intake metadata provider is not configured",
        )
        .for_operation(&request.call.operation_id)
        .retryable(true))
    }

    async fn probe_auth(
        &self,
        _deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxGithubAuthProbe> {
        Ok(loopx_contract::LoopxGithubAuthProbe {
            authenticated: false,
            detail: Some("GitHub intake metadata provider is not configured".to_string()),
            ..loopx_contract::LoopxGithubAuthProbe::default()
        })
    }
}

#[derive(Debug, Default)]
pub struct SystemLoopxFixedCommandLocator;

impl LoopxFixedCommandLocator for SystemLoopxFixedCommandLocator {
    fn locate(&self) -> Result<Option<PathBuf>, String> {
        match which::which("loopx") {
            Ok(path) => Ok(Some(path)),
            Err(which::Error::CannotFindBinaryPath) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[derive(Debug, Default)]
pub struct SystemLoopxPythonLocator;

impl LoopxPythonLocator for SystemLoopxPythonLocator {
    fn locate(&self) -> Result<Option<PathBuf>, String> {
        let candidates = if cfg!(windows) {
            ["python", "python3"]
        } else {
            ["python3", "python"]
        };
        for candidate in candidates {
            match which::which(candidate) {
                Ok(path) => return Ok(Some(path)),
                Err(which::Error::CannotFindBinaryPath) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(None)
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LoopxCliAdapterError {
    #[error("compatible LoopX runtime is not available")]
    Unavailable,
    #[error("invalid packaged LoopX manifest: {message}")]
    Manifest { message: String },
    #[error("LoopX version mismatch: expected {expected}, got {actual}")]
    VersionMismatch { expected: String, actual: String },
    #[error("LoopX schema mismatch: expected {expected}, got {actual}")]
    SchemaMismatch { expected: String, actual: String },
    #[error("LoopX operation id is already running: {operation_id}")]
    Conflict { operation_id: String },
    #[error("LoopX returned invalid JSON: {message}")]
    InvalidJson { message: String },
    #[error(transparent)]
    Process(#[from] LoopxProcessError),
}

#[derive(Debug, Clone)]
pub struct LoopxJsonOutput {
    pub payload: Value,
    pub stderr_tail: Vec<String>,
    pub elapsed: Duration,
}

pub struct LoopxCliProcessAdapter {
    config: LoopxCliAdapterConfig,
    runner: Arc<dyn LoopxProcessRunner>,
    locator: Arc<dyn LoopxFixedCommandLocator>,
    python_locator: Arc<dyn LoopxPythonLocator>,
    observer: Arc<dyn LoopxProcessObserver>,
    intake_metadata: Arc<dyn LoopxIntakeMetadataProvider>,
    intake_metadata_configured: bool,
    install_lock: Mutex<()>,
    verified: Mutex<Option<VerifiedLoopxCommand>>,
    running: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl std::fmt::Debug for LoopxCliProcessAdapter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LoopxCliProcessAdapter")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl LoopxCliProcessAdapter {
    pub fn new(config: LoopxCliAdapterConfig) -> Self {
        Self::with_dependencies(
            config,
            Arc::new(SystemLoopxProcessRunner),
            Arc::new(SystemLoopxFixedCommandLocator),
            Arc::new(SystemLoopxPythonLocator),
            Arc::new(NoopLoopxProcessObserver),
        )
    }

    pub fn with_dependencies(
        config: LoopxCliAdapterConfig,
        runner: Arc<dyn LoopxProcessRunner>,
        locator: Arc<dyn LoopxFixedCommandLocator>,
        python_locator: Arc<dyn LoopxPythonLocator>,
        observer: Arc<dyn LoopxProcessObserver>,
    ) -> Self {
        Self {
            config,
            runner,
            locator,
            python_locator,
            observer,
            intake_metadata: Arc::new(UnsupportedLoopxIntakeMetadataProvider),
            intake_metadata_configured: false,
            install_lock: Mutex::new(()),
            verified: Mutex::new(None),
            running: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub fn with_intake_metadata_provider(
        mut self,
        provider: Arc<dyn LoopxIntakeMetadataProvider>,
    ) -> Self {
        self.intake_metadata = provider;
        self.intake_metadata_configured = true;
        self
    }

    pub async fn verify_handshake(
        &self,
        operation_id: &str,
    ) -> Result<VerifiedLoopxCommand, LoopxCliAdapterError> {
        let (cancellation, _registration) = self.register_operation(operation_id)?;
        self.ensure_verified(
            operation_id,
            cancellation,
            self.config.startup_deadline,
            self.observer.as_ref(),
        )
        .await
    }

    pub fn cancel_operation(&self, operation_id: &str) -> bool {
        let running = self
            .running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(cancellation) = running.get(operation_id) {
            cancellation.cancel();
            true
        } else {
            false
        }
    }

    async fn run_json_command(
        &self,
        operation_id: &str,
        registry_path: &Path,
        current_dir: Option<&Path>,
        command_args: Vec<OsString>,
        deadline: Duration,
        observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxJsonOutput, LoopxCliAdapterError> {
        let (cancellation, _registration) = self.register_operation(operation_id)?;
        let verified = self
            .ensure_verified(
                operation_id,
                cancellation.clone(),
                deadline.min(self.config.startup_deadline),
                observer,
            )
            .await?;
        let mut args = verified.prefix_args.clone();
        // `--runtime-root` is a global LoopX option: it overrides the runtime
        // root resolved from the registry so every controller + agent-side CLI
        // invocation stays inside this project's `.loopx/runtime` instead of
        // the shared `~/.codex/loopx` (2026-09-07 codex comparison: global
        // runtime root caused cross-session lock contention and write
        // denials; localizing it removed the failure loop entirely).
        let runtime_root_arg = registry_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("runtime");
        args.extend([
            OsString::from("--format"),
            OsString::from("json"),
            OsString::from("--registry"),
            registry_path.as_os_str().to_owned(),
            OsString::from("--runtime-root"),
            runtime_root_arg.as_os_str().to_owned(),
        ]);
        args.extend(command_args);
        let output = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: verified.executable,
                    args,
                    current_dir: current_dir.map(Path::to_path_buf),
                    environment: verified.environment,
                    deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation,
                observer,
            )
            .await?;
        let payload = serde_json::from_str(&output.stdout).map_err(|error| {
            LoopxCliAdapterError::InvalidJson {
                message: error.to_string(),
            }
        })?;
        Ok(LoopxJsonOutput {
            payload,
            stderr_tail: output.stderr_tail,
            elapsed: output.elapsed,
        })
    }

    async fn run_global_json_command(
        &self,
        operation_id: &str,
        command_args: Vec<OsString>,
        deadline: Duration,
        observer: &dyn LoopxProcessObserver,
    ) -> Result<LoopxJsonOutput, LoopxCliAdapterError> {
        let (cancellation, _registration) = self.register_operation(operation_id)?;
        let verified = self
            .ensure_verified(
                operation_id,
                cancellation.clone(),
                deadline.min(self.config.startup_deadline),
                observer,
            )
            .await?;
        let mut args = verified.prefix_args.clone();
        args.extend([OsString::from("--format"), OsString::from("json")]);
        args.extend(command_args);
        let output = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: verified.executable,
                    args,
                    current_dir: None,
                    environment: verified.environment,
                    deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation,
                observer,
            )
            .await?;
        let payload = serde_json::from_str(&output.stdout).map_err(|error| {
            LoopxCliAdapterError::InvalidJson {
                message: error.to_string(),
            }
        })?;
        Ok(LoopxJsonOutput {
            payload,
            stderr_tail: output.stderr_tail,
            elapsed: output.elapsed,
        })
    }

    async fn ensure_verified(
        &self,
        operation_id: &str,
        cancellation: CancellationToken,
        startup_deadline: Duration,
        observer: &dyn LoopxProcessObserver,
    ) -> Result<VerifiedLoopxCommand, LoopxCliAdapterError> {
        let mut verified_guard = self.verified.lock().await;
        if let Some(verified) = verified_guard.as_ref() {
            return Ok(verified.clone());
        }

        let candidate = self.select_candidate().await?;
        if let Some(source_dir) = candidate.managed_source_dir.as_ref() {
            let git = which::which("git").map_err(|error| LoopxCliAdapterError::Manifest {
                message: format!("Git is required to verify managed LoopX source: {error}"),
            })?;
            let status = self
                .runner
                .run(
                    LoopxCommandPlan {
                        operation_id: operation_id.to_string(),
                        executable: git,
                        args: vec![
                            OsString::from("-C"),
                            source_dir.as_os_str().to_owned(),
                            OsString::from("status"),
                            OsString::from("--porcelain"),
                            OsString::from("--untracked-files=all"),
                        ],
                        current_dir: None,
                        environment: BTreeMap::new(),
                        deadline: startup_deadline,
                        terminate_grace: self.config.terminate_grace,
                    },
                    cancellation.clone(),
                    observer,
                )
                .await?;
            if !status.stdout.trim().is_empty() {
                return Err(LoopxCliAdapterError::Manifest {
                    message: "managed LoopX source was modified; reinstall it from GitHub"
                        .to_string(),
                });
            }
        }
        let version_output = self
            .runner
            .run(
                LoopxCommandPlan::handshake(
                    operation_id,
                    candidate.executable.clone(),
                    &candidate.prefix_args,
                    &candidate.environment,
                    ["--version"],
                    startup_deadline,
                    self.config.terminate_grace,
                ),
                cancellation.clone(),
                observer,
            )
            .await?;
        let actual_version = version_output.stdout.trim();
        if actual_version != LOOPX_PINNED_VERSION_OUTPUT {
            return Err(LoopxCliAdapterError::VersionMismatch {
                expected: LOOPX_PINNED_VERSION_OUTPUT.to_string(),
                actual: actual_version.to_string(),
            });
        }

        let schema_output = self
            .runner
            .run(
                LoopxCommandPlan::handshake(
                    operation_id,
                    candidate.executable.clone(),
                    &candidate.prefix_args,
                    &candidate.environment,
                    ["--format", "json", "commands"],
                    startup_deadline,
                    self.config.terminate_grace,
                ),
                cancellation,
                observer,
            )
            .await?;
        let schema_payload: Value =
            serde_json::from_str(&schema_output.stdout).map_err(|error| {
                LoopxCliAdapterError::InvalidJson {
                    message: error.to_string(),
                }
            })?;
        let actual_schema = schema_payload
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if schema_payload.get("ok").and_then(Value::as_bool) != Some(true)
            || actual_schema != LOOPX_COMMAND_REFERENCE_SCHEMA
        {
            return Err(LoopxCliAdapterError::SchemaMismatch {
                expected: LOOPX_COMMAND_REFERENCE_SCHEMA.to_string(),
                actual: actual_schema.to_string(),
            });
        }

        let verified = VerifiedLoopxCommand {
            executable: candidate.executable,
            prefix_args: candidate.prefix_args,
            environment: with_utf8_stdio(candidate.environment),
            source: candidate.source,
            version: LOOPX_PINNED_VERSION.to_string(),
            bundle_manifest_schema: candidate.bundle_manifest_schema,
            command_reference_schema: LOOPX_COMMAND_REFERENCE_SCHEMA.to_string(),
            sha256: candidate.sha256,
        };
        *verified_guard = Some(verified.clone());
        Ok(verified)
    }

    async fn select_candidate(&self) -> Result<LoopxCandidate, LoopxCliAdapterError> {
        let bundle_dir = self.config.resource_dir.join("loopx");
        let executable = bundle_dir.join(if cfg!(windows) { "loopx.exe" } else { "loopx" });
        let manifest_path = bundle_dir.join("manifest.json");
        let executable_exists = tokio::fs::try_exists(&executable).await.map_err(|error| {
            LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            }
        })?;
        let manifest_exists = tokio::fs::try_exists(&manifest_path)
            .await
            .map_err(|error| LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            })?;

        if executable_exists || manifest_exists {
            if !executable_exists || !manifest_exists {
                return Err(LoopxCliAdapterError::Manifest {
                    message: "bundle must contain both the executable and manifest.json"
                        .to_string(),
                });
            }
            let raw = tokio::fs::read(&manifest_path).await.map_err(|error| {
                LoopxCliAdapterError::Manifest {
                    message: error.to_string(),
                }
            })?;
            let manifest: BundledLoopxManifest =
                serde_json::from_slice(&raw).map_err(|error| LoopxCliAdapterError::Manifest {
                    message: error.to_string(),
                })?;
            verify_manifest(&manifest)?;
            let digest = sha256_file(&executable).await?;
            let expected_digest = manifest
                .sha256
                .strip_prefix("sha256:")
                .unwrap_or(&manifest.sha256);
            if digest != expected_digest {
                return Err(LoopxCliAdapterError::Manifest {
                    message: "bundle executable checksum does not match manifest.json".to_string(),
                });
            }
            return Ok(LoopxCandidate {
                executable,
                prefix_args: Vec::new(),
                environment: BTreeMap::new(),
                managed_source_dir: None,
                source: LoopxCommandSource::PackagedBundle,
                bundle_manifest_schema: Some(manifest.schema_version),
                sha256: Some(digest),
            });
        }

        if let Some(candidate) = self.managed_source_candidate().await? {
            return Ok(candidate);
        }

        if self.config.system_fallback == LoopxSystemFallbackPolicy::ExactPinned {
            let located = self
                .locator
                .locate()
                .map_err(|message| LoopxCliAdapterError::Manifest { message })?;
            if let Some(executable) = located {
                return Ok(LoopxCandidate {
                    executable,
                    prefix_args: Vec::new(),
                    environment: BTreeMap::new(),
                    managed_source_dir: None,
                    source: LoopxCommandSource::FixedSystemCommand,
                    bundle_manifest_schema: None,
                    sha256: None,
                });
            }
        }
        Err(LoopxCliAdapterError::Unavailable)
    }

    async fn managed_source_candidate(
        &self,
    ) -> Result<Option<LoopxCandidate>, LoopxCliAdapterError> {
        let Some(source_dir) = self.config.managed_source_dir.as_ref() else {
            return Ok(None);
        };
        let manifest_path = source_dir.join(".git").join(MANAGED_SOURCE_MANIFEST);
        if !tokio::fs::try_exists(&manifest_path)
            .await
            .map_err(|error| LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            })?
        {
            return Ok(None);
        }
        let raw = tokio::fs::read(&manifest_path).await.map_err(|error| {
            LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            }
        })?;
        let manifest: ManagedLoopxSourceManifest =
            serde_json::from_slice(&raw).map_err(|error| LoopxCliAdapterError::Manifest {
                message: format!("invalid managed LoopX source manifest: {error}"),
            })?;
        verify_managed_source_manifest(&manifest)?;
        let head = tokio::fs::read_to_string(source_dir.join(".git").join("HEAD"))
            .await
            .map_err(|error| LoopxCliAdapterError::Manifest {
                message: format!("failed to read managed LoopX source revision: {error}"),
            })?;
        if head.trim() != LOOPX_PINNED_SOURCE_COMMIT {
            return Err(LoopxCliAdapterError::Manifest {
                message: format!(
                    "managed LoopX source revision mismatch: expected {LOOPX_PINNED_SOURCE_COMMIT}, got {}",
                    head.trim()
                ),
            });
        }
        for required in ["pyproject.toml", "loopx/entrypoint.py"] {
            if !tokio::fs::try_exists(source_dir.join(required))
                .await
                .map_err(|error| LoopxCliAdapterError::Manifest {
                    message: error.to_string(),
                })?
            {
                return Err(LoopxCliAdapterError::Manifest {
                    message: format!("managed LoopX source is missing {required}"),
                });
            }
        }
        let python = self
            .python_locator
            .locate()
            .map_err(|message| LoopxCliAdapterError::Manifest { message })?
            .ok_or_else(|| LoopxCliAdapterError::Manifest {
                message: "Python 3.11 or newer is required to run managed LoopX source".to_string(),
            })?;
        let mut environment = BTreeMap::new();
        environment.insert(
            OsString::from("BITFUN_LOOPX_SOURCE"),
            source_dir.as_os_str().to_owned(),
        );
        Ok(Some(LoopxCandidate {
            executable: python,
            prefix_args: vec![
                OsString::from("-I"),
                OsString::from("-c"),
                OsString::from(PYTHON_LOOPX_ENTRYPOINT),
            ],
            environment,
            managed_source_dir: Some(source_dir.clone()),
            source: LoopxCommandSource::ManagedSource,
            bundle_manifest_schema: None,
            sha256: None,
        }))
    }

    async fn install_managed_source_checkout(
        &self,
        operation_id: &str,
        staging_dir: &Path,
        cancellation: CancellationToken,
        progress: &dyn loopx_contract::LoopxCliProgressSink,
    ) -> Result<(), LoopxCliAdapterError> {
        let python = self
            .python_locator
            .locate()
            .map_err(|message| LoopxCliAdapterError::Manifest { message })?
            .ok_or_else(|| LoopxCliAdapterError::Manifest {
                message: "Python 3.11 or newer is required to install LoopX from source"
                    .to_string(),
            })?;
        report_port_progress(
            progress,
            operation_id,
            None,
            loopx_contract::LoopxCliProgressStage::InstallingRuntime,
            "Checking the Python runtime for managed LoopX source",
        );
        let python_version = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: python,
                    args: vec![OsString::from("--version")],
                    current_dir: None,
                    environment: BTreeMap::new(),
                    deadline: self.config.startup_deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation.clone(),
                self.observer.as_ref(),
            )
            .await?;
        log::info!(
            "LoopX install Python check completed: operation_id={operation_id}, duration_ms={}",
            python_version.elapsed.as_millis()
        );
        let version_text = if python_version.stdout.trim().is_empty() {
            python_version.stderr_tail.join(" ")
        } else {
            python_version.stdout
        };
        if !python_version_supported(&version_text) {
            return Err(LoopxCliAdapterError::Manifest {
                message: format!(
                    "Python 3.11 or newer is required to install LoopX from source; found {}",
                    version_text.trim()
                ),
            });
        }
        let git = which::which("git").map_err(|error| LoopxCliAdapterError::Manifest {
            message: format!("Git is required to download LoopX source: {error}"),
        })?;

        report_port_progress(
            progress,
            operation_id,
            None,
            loopx_contract::LoopxCliProgressStage::InstallingRuntime,
            "Downloading LoopX v0.5.1 source from GitHub",
        );
        let clone_output = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: git.clone(),
                    args: [
                        "clone",
                        "--depth",
                        "1",
                        "--filter=blob:none",
                        "--sparse",
                        "--branch",
                        LOOPX_PINNED_VERSION_TAG,
                        "--single-branch",
                        LOOPX_SOURCE_REPOSITORY,
                    ]
                    .into_iter()
                    .map(OsString::from)
                    .chain(std::iter::once(staging_dir.as_os_str().to_owned()))
                    .collect(),
                    current_dir: None,
                    environment: BTreeMap::new(),
                    deadline: self.config.install_deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation.clone(),
                self.observer.as_ref(),
            )
            .await?;
        log::info!(
            "LoopX install GitHub clone completed: operation_id={operation_id}, duration_ms={}",
            clone_output.elapsed.as_millis()
        );

        report_port_progress(
            progress,
            operation_id,
            None,
            loopx_contract::LoopxCliProgressStage::InstallingRuntime,
            "Preparing only the LoopX runtime source files",
        );
        let sparse_output = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: git.clone(),
                    args: [
                        OsString::from("-C"),
                        staging_dir.as_os_str().to_owned(),
                        OsString::from("sparse-checkout"),
                        OsString::from("set"),
                        OsString::from("--no-cone"),
                        OsString::from("/loopx/"),
                        OsString::from("/pyproject.toml"),
                        OsString::from("/LICENSE"),
                        OsString::from("/NOTICE"),
                        OsString::from("/LICENSE-MIT"),
                        OsString::from("/TRADEMARKS.md"),
                    ]
                    .into_iter()
                    .collect(),
                    current_dir: None,
                    environment: BTreeMap::new(),
                    deadline: self.config.install_deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation.clone(),
                self.observer.as_ref(),
            )
            .await?;
        log::info!(
            "LoopX install sparse checkout completed: operation_id={operation_id}, duration_ms={}",
            sparse_output.elapsed.as_millis()
        );

        report_port_progress(
            progress,
            operation_id,
            None,
            loopx_contract::LoopxCliProgressStage::InstallingRuntime,
            "Verifying the pinned LoopX source revision",
        );
        let revision = self
            .runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: git,
                    args: vec![
                        OsString::from("-C"),
                        staging_dir.as_os_str().to_owned(),
                        OsString::from("rev-parse"),
                        OsString::from("HEAD"),
                    ],
                    current_dir: None,
                    environment: BTreeMap::new(),
                    deadline: self.config.startup_deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation,
                self.observer.as_ref(),
            )
            .await?;
        log::info!(
            "LoopX install revision check completed: operation_id={operation_id}, duration_ms={}",
            revision.elapsed.as_millis()
        );
        if revision.stdout.trim() != LOOPX_PINNED_SOURCE_COMMIT {
            return Err(LoopxCliAdapterError::Manifest {
                message: format!(
                    "downloaded LoopX source revision mismatch: expected {LOOPX_PINNED_SOURCE_COMMIT}, got {}",
                    revision.stdout.trim()
                ),
            });
        }
        for required in [
            "pyproject.toml",
            "loopx/entrypoint.py",
            "LICENSE",
            "NOTICE",
            "LICENSE-MIT",
            "TRADEMARKS.md",
        ] {
            if !tokio::fs::try_exists(staging_dir.join(required))
                .await
                .map_err(|error| LoopxCliAdapterError::Manifest {
                    message: error.to_string(),
                })?
            {
                return Err(LoopxCliAdapterError::Manifest {
                    message: format!("downloaded LoopX source is missing {required}"),
                });
            }
        }
        let manifest = ManagedLoopxSourceManifest {
            schema_version: MANAGED_SOURCE_MANIFEST_SCHEMA,
            source_repository: LOOPX_SOURCE_REPOSITORY.to_string(),
            source_tag: LOOPX_PINNED_VERSION_TAG.to_string(),
            source_commit: LOOPX_PINNED_SOURCE_COMMIT.to_string(),
            loopx_version: LOOPX_PINNED_VERSION.to_string(),
        };
        let raw = serde_json::to_vec_pretty(&manifest).map_err(|error| {
            LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            }
        })?;
        tokio::fs::write(staging_dir.join(".git").join(MANAGED_SOURCE_MANIFEST), raw)
            .await
            .map_err(|error| LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            })?;
        Ok(())
    }

    fn register_operation(
        &self,
        operation_id: &str,
    ) -> Result<(CancellationToken, OperationRegistration), LoopxCliAdapterError> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if running.contains_key(operation_id) {
            return Err(LoopxCliAdapterError::Conflict {
                operation_id: operation_id.to_string(),
            });
        }
        let cancellation = CancellationToken::new();
        running.insert(operation_id.to_string(), cancellation.clone());
        Ok((
            cancellation,
            OperationRegistration {
                operation_id: operation_id.to_string(),
                running: self.running.clone(),
            },
        ))
    }
}

struct PortProcessObserver<'a> {
    progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    fallback: &'a dyn LoopxProcessObserver,
    task_id: Option<String>,
    stage: loopx_contract::LoopxCliProgressStage,
}

impl LoopxProcessObserver for PortProcessObserver<'_> {
    fn on_progress(&self, progress: LoopxProcessProgress) {
        self.fallback.on_progress(progress.clone());
        self.progress.report(loopx_contract::LoopxCliProgress {
            operation_id: progress.operation_id,
            task_id: self.task_id.clone(),
            stage: self.stage,
            message: progress.message,
            occurred_at: progress.occurred_at_unix_ms.try_into().unwrap_or(i64::MAX),
        });
    }
}

impl loopx_contract::LoopxCliPort for LoopxCliProcessAdapter {
    fn install_managed_source<'a>(
        &'a self,
        request: loopx_contract::LoopxCliInstallManagedSourceRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliInstallManagedSourceResult>
    {
        Box::pin(async move {
            let operation_id = &request.call.operation_id;
            let received_at = Instant::now();
            log::info!("LoopX managed source install received: operation_id={operation_id}");
            validate_operation_id(operation_id)?;
            let lock_started_at = Instant::now();
            let _install = self.install_lock.lock().await;
            log::info!(
                "LoopX managed source install lock acquired: operation_id={operation_id}, wait_ms={}",
                lock_started_at.elapsed().as_millis()
            );
            let target_dir = self.config.managed_source_dir.clone().ok_or_else(|| {
                port_error(
                    loopx_contract::LoopxCliErrorKind::Backend,
                    operation_id,
                    "managed LoopX source installation is not configured",
                    false,
                )
            })?;
            let parent = target_dir.parent().ok_or_else(|| {
                port_error(
                    loopx_contract::LoopxCliErrorKind::InvalidInput,
                    operation_id,
                    "managed LoopX source path has no parent directory",
                    false,
                )
            })?;
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                port_error(
                    loopx_contract::LoopxCliErrorKind::Io,
                    operation_id,
                    format!("failed to create managed LoopX directory: {error}"),
                    true,
                )
            })?;
            let suffix = format!("{}-{}", std::process::id(), now_unix_ms());
            let staging_dir = parent.join(format!(".loopx-source-install-{suffix}"));
            let backup_dir = parent.join(format!(".loopx-source-backup-{suffix}"));
            let (cancellation, _registration) = self
                .register_operation(operation_id)
                .map_err(|error| map_port_error(error, operation_id))?;

            if let Err(error) = self
                .install_managed_source_checkout(
                    operation_id,
                    &staging_dir,
                    cancellation.clone(),
                    progress,
                )
                .await
            {
                let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                return Err(map_port_error(error, operation_id));
            }

            report_port_progress(
                progress,
                operation_id,
                None,
                loopx_contract::LoopxCliProgressStage::InstallingRuntime,
                "Activating the verified LoopX source",
            );
            let had_previous = tokio::fs::try_exists(&target_dir).await.map_err(|error| {
                port_error(
                    loopx_contract::LoopxCliErrorKind::Io,
                    operation_id,
                    error.to_string(),
                    true,
                )
            })?;
            if had_previous {
                tokio::fs::rename(&target_dir, &backup_dir)
                    .await
                    .map_err(|error| {
                        port_error(
                            loopx_contract::LoopxCliErrorKind::Io,
                            operation_id,
                            format!("failed to stage the previous LoopX source: {error}"),
                            true,
                        )
                    })?;
            }
            if let Err(error) = tokio::fs::rename(&staging_dir, &target_dir).await {
                if had_previous {
                    let _ = tokio::fs::rename(&backup_dir, &target_dir).await;
                }
                let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::Io,
                    operation_id,
                    format!("failed to activate managed LoopX source: {error}"),
                    true,
                ));
            }

            self.verified.lock().await.take();
            if let Err(error) = self
                .ensure_verified(
                    operation_id,
                    cancellation,
                    self.config.startup_deadline,
                    self.observer.as_ref(),
                )
                .await
            {
                self.verified.lock().await.take();
                let _ = tokio::fs::remove_dir_all(&target_dir).await;
                if had_previous {
                    let _ = tokio::fs::rename(&backup_dir, &target_dir).await;
                }
                return Err(map_port_error(error, operation_id));
            }
            if had_previous {
                let _ = tokio::fs::remove_dir_all(&backup_dir).await;
            }
            log::info!(
                "LoopX managed source install activated: operation_id={operation_id}, duration_ms={}",
                received_at.elapsed().as_millis()
            );
            Ok(loopx_contract::LoopxCliInstallManagedSourceResult {
                source_repository: LOOPX_SOURCE_REPOSITORY.to_string(),
                source_tag: LOOPX_PINNED_VERSION_TAG.to_string(),
                source_commit: LOOPX_PINNED_SOURCE_COMMIT.to_string(),
                install_path: target_dir.to_string_lossy().into_owned(),
                loopx_version: LOOPX_PINNED_VERSION.to_string(),
            })
        })
    }

    fn handshake<'a>(
        &'a self,
        request: loopx_contract::LoopxCliHandshakeRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliManifest> {
        Box::pin(async move {
            validate_operation_id(&request.call.operation_id)?;
            report_port_progress(
                progress,
                &request.call.operation_id,
                None,
                loopx_contract::LoopxCliProgressStage::StartingSidecar,
                "Selecting the managed LoopX executable",
            );
            if request.required_loopx_version != LOOPX_PINNED_VERSION {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::VersionMismatch,
                    &request.call.operation_id,
                    format!(
                        "adapter is pinned to LoopX {LOOPX_PINNED_VERSION}; requested {}",
                        request.required_loopx_version
                    ),
                    false,
                ));
            }
            if request.required_schema_version != loopx_contract::LOOPX_CLI_SCHEMA_VERSION {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                    &request.call.operation_id,
                    format!(
                        "adapter schema is {}; requested {}",
                        loopx_contract::LOOPX_CLI_SCHEMA_VERSION,
                        request.required_schema_version
                    ),
                    false,
                ));
            }
            let deadline = effective_deadline(
                request.call.deadline_at,
                self.config.startup_deadline,
                &request.call.operation_id,
            )?;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: None,
                stage: loopx_contract::LoopxCliProgressStage::Handshake,
            };
            let (cancellation, _registration) = self
                .register_operation(&request.call.operation_id)
                .map_err(|error| map_port_error(error, &request.call.operation_id))?;
            let verified = self
                .ensure_verified(
                    &request.call.operation_id,
                    cancellation,
                    deadline,
                    &observer,
                )
                .await
                .map_err(|error| map_port_error(error, &request.call.operation_id))?;
            let mut capabilities = vec![
                "issue_fix_workflow_plan_v0".to_string(),
                "goal_bootstrap_v0".to_string(),
                "loopx_turn_plan_v0".to_string(),
                "custom_agent_runner_v0".to_string(),
                "typed_gate_decision_v0".to_string(),
                "managed_process_tree_v1".to_string(),
            ];
            if self.intake_metadata_configured {
                capabilities.push("intake_metadata_provider_v1".to_string());
            }
            Ok(loopx_contract::LoopxCliManifest {
                adapter_version: env!("CARGO_PKG_VERSION").to_string(),
                loopx_version: verified.version,
                schema_version: loopx_contract::LOOPX_CLI_SCHEMA_VERSION,
                executable: loopx_contract::LoopxCliExecutableIdentity {
                    source: match verified.source {
                        LoopxCommandSource::PackagedBundle => {
                            loopx_contract::LoopxCliSource::Bundled
                        }
                        LoopxCommandSource::ManagedSource => {
                            loopx_contract::LoopxCliSource::PythonFallback
                        }
                        LoopxCommandSource::FixedSystemCommand => {
                            loopx_contract::LoopxCliSource::System
                        }
                    },
                    identity: match verified.source {
                        LoopxCommandSource::PackagedBundle => {
                            "bitfun-bundled-loopx-v0.5.1".to_string()
                        }
                        LoopxCommandSource::ManagedSource => {
                            "bitfun-managed-github-source-loopx-v0.5.1".to_string()
                        }
                        LoopxCommandSource::FixedSystemCommand => {
                            "fixed-system-loopx-v0.5.1".to_string()
                        }
                    },
                    path: Some(verified.executable.to_string_lossy().into_owned()),
                    sha256: verified.sha256.map(|digest| format!("sha256:{digest}")),
                },
                capabilities,
            })
        })
    }

    fn resolve_intake<'a>(
        &'a self,
        request: loopx_contract::LoopxCliResolveIntakeRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliResolveIntakeResult> {
        Box::pin(async move {
            validate_operation_id(&request.call.operation_id)?;
            let deadline = effective_deadline(
                request.call.deadline_at,
                self.config.command_deadline,
                &request.call.operation_id,
            )?;
            report_port_progress(
                progress,
                &request.call.operation_id,
                None,
                loopx_contract::LoopxCliProgressStage::ResolvingIntake,
                "Resolving live repository metadata",
            );
            self.intake_metadata.resolve(&request, deadline).await
        })
    }

    fn probe_github_auth<'a>(
        &'a self,
        request: loopx_contract::LoopxGithubAuthProbeRequest,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxGithubAuthProbe> {
        Box::pin(async move {
            validate_operation_id(&request.call.operation_id)?;
            let deadline = effective_deadline(
                request.call.deadline_at,
                self.config.command_deadline,
                &request.call.operation_id,
            )?;
            self.intake_metadata.probe_auth(deadline).await
        })
    }

    fn plan_item<'a>(
        &'a self,
        request: loopx_contract::LoopxCliPlanItemRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliIntakePlan> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            validate_github_item(&request.item, &request.context.call.operation_id)?;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::PlanningItem,
            };
            let operation_id = &request.context.call.operation_id;
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::PlanningItem,
                "Building the pinned LoopX issue-fix plan",
            );
            let deadline = effective_deadline(
                request.context.call.deadline_at,
                self.config.command_deadline,
                operation_id,
            )?;
            let output = self
                .run_json_command(
                    operation_id,
                    Path::new(&request.context.registry_path),
                    Some(Path::new(&request.context.worktree_path)),
                    plan_item_args(&request),
                    deadline,
                    &observer,
                )
                .await
                .map_err(|error| map_port_error(error, operation_id))?;
            require_payload_ok(&output.payload, operation_id)?;
            require_schema(
                &output.payload,
                "issue_fix_workflow_plan_packet_v0",
                operation_id,
            )?;
            let previews = output
                .payload
                .get("ordered_loopx_todo_writeback_preview")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    port_error(
                        loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                        operation_id,
                        "workflow plan did not contain ordered_loopx_todo_writeback_preview",
                        false,
                    )
                })?;
            let mut todos = Vec::with_capacity(previews.len());
            for preview in previews {
                let role = required_json_string(preview, "role", operation_id)?;
                let task_class = required_json_string(preview, "task_class", operation_id)?;
                let text = required_json_string(preview, "text", operation_id)?;
                let action_kind = preview
                    .get("action_kind")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let target_key = preview
                    .get("target_key")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                todos.push(loopx_contract::LoopxCliTodoPlan {
                    role,
                    task_class,
                    action_kind,
                    text,
                    target_key,
                });
            }
            if todos.is_empty() {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::Backend,
                    operation_id,
                    "workflow plan produced no writable todos",
                    true,
                ));
            }
            // LoopX's issue-fix workflow contract pins the goal objective to
            // the host-resolved issue title; the packet itself carries no
            // objective field.
            let objective = compact_objective(&request.item, &request.title);
            Ok(loopx_contract::LoopxCliIntakePlan {
                item: request.item,
                objective,
                todos,
            })
        })
    }

    fn create_goal<'a>(
        &'a self,
        request: loopx_contract::LoopxCliCreateGoalRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliCreateGoalResult> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            validate_nonempty(
                "goal_id",
                &request.goal_id,
                &request.context.call.operation_id,
            )?;
            validate_nonempty(
                "agent_id",
                &request.agent_id,
                &request.context.call.operation_id,
            )?;
            if request.intake.todos.is_empty() {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::InvalidInput,
                    &request.context.call.operation_id,
                    "create_goal requires at least one planned todo",
                    false,
                ));
            }
            let operation_id = &request.context.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::CreatingGoal,
            };
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::CreatingGoal,
                "Creating one LoopX goal for the selected item",
            );

            let bootstrap =
                run_port_command(self, &request.context, bootstrap_args(&request), &observer)
                    .await?;
            require_payload_ok(&bootstrap.payload, operation_id)?;
            // 2026-09-07 codex comparison: LoopX defaults `common_runtime_root`
            // to the shared `~/.codex/loopx`; that global file is the root of
            // the write-denial / lock-contention failure loop seen in both
            // hosts. Point the project registry at the local runtime root
            // right after bootstrap so every later CLI call (controller and
            // agent side) stays project-local and never touches the shared
            // global registry.
            let _ = patch_registry_local_runtime_root(Path::new(
                &request.context.registry_path,
            ));
            let state_action = bootstrap
                .payload
                .get("state_action")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    port_error(
                        loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                        operation_id,
                        "bootstrap response did not contain state_action",
                        false,
                    )
                })?;
            let created = matches!(state_action, "created" | "replaced");

            let registration = run_port_command(
                self,
                &request.context,
                register_agent_args(&request),
                &observer,
            )
            .await?;
            require_payload_ok(&registration.payload, operation_id)?;

            let existing_todos = run_port_command(
                self,
                &request.context,
                list_todos_args(&request.goal_id),
                &observer,
            )
            .await?;
            require_payload_ok(&existing_todos.payload, operation_id)?;
            let existing_todos = existing_todos
                .payload
                .get("todos")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    port_error(
                        loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                        operation_id,
                        "todo list response did not contain todos",
                        false,
                    )
                })?;
            for todo in &request.intake.todos {
                if existing_todos
                    .iter()
                    .any(|existing| todo_matches(existing, todo))
                {
                    continue;
                }
                let result = run_port_command(
                    self,
                    &request.context,
                    add_todo_args(&request, todo)?,
                    &observer,
                )
                .await?;
                require_payload_ok(&result.payload, operation_id)?;
            }

            let mut inspection_args = turn_plan_args(&request.goal_id, &request.agent_id, None);
            extend_available_capability_args(
                &mut inspection_args,
                &request.context.available_capabilities,
                operation_id,
            )?;
            let inspection =
                run_port_command(self, &request.context, inspection_args, &observer).await?;
            require_payload_ok(&inspection.payload, operation_id)?;
            let durable_revision = extract_durable_revision(&inspection.payload, operation_id)?;
            Ok(loopx_contract::LoopxCliCreateGoalResult {
                goal_id: request.goal_id,
                created,
                durable_revision,
            })
        })
    }

    fn inspect_goal<'a>(
        &'a self,
        request: loopx_contract::LoopxCliInspectGoalRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliGoalSnapshot> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            let operation_id = &request.context.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::InspectingGoal,
            };
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::InspectingGoal,
                "Inspecting durable LoopX goal state",
            );
            let mut args = turn_plan_args(&request.goal_id, &request.agent_id, None);
            extend_available_capability_args(
                &mut args,
                &request.context.available_capabilities,
                operation_id,
            )?;
            let mut snapshot =
                inspect_goal_snapshot(self, &request.goal_id, &request.context, args, &observer)
                    .await?;
            if snapshot.waiting_user_todo_count > 0
                || snapshot.run_decision == loopx_contract::LoopxCliRunDecision::WaitingForUser
            {
                let todos = run_port_command(
                    self,
                    &request.context,
                    list_todos_args(&request.goal_id),
                    &observer,
                )
                .await?;
                snapshot.pending_user_gate =
                    Some(project_pending_user_gate(&todos.payload, operation_id)?);
            }
            Ok(snapshot)
        })
    }

    fn build_turn<'a>(
        &'a self,
        request: loopx_contract::LoopxCliBuildTurnRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliBuildTurnResult> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            let operation_id = &request.context.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::BuildingTurn,
            };
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::BuildingTurn,
                "Building a fresh LoopX custom-runner turn contract",
            );
            let turn_id = stable_turn_id(&request);
            let mut guard_args =
                quota_guard_args(&request.goal_id, &request.agent_id, None, &turn_id);
            guard_args.push(OsString::from("--turn-envelope"));
            extend_available_capability_args(
                &mut guard_args,
                &request.context.available_capabilities,
                operation_id,
            )?;
            let guard = run_port_command(self, &request.context, guard_args, &observer).await?;
            require_payload_ok(&guard.payload, operation_id)?;
            require_schema(&guard.payload, "loopx_turn_envelope_v0", operation_id)?;
            let durable_revision = extract_durable_revision(&guard.payload, operation_id)?;
            if durable_revision != request.expected_durable_revision {
                // `turn plan` and `quota should-run` are two different LoopX
                // envelope builders; loopx does not promise their action
                // signatures agree for identical state. The fresh guard packet
                // below is the authoritative execution contract, and durable
                // settlement evidence is verified against the same turn
                // identity, so a mismatch here is informational only.
                log::info!(
                    "LoopX guard revision differs from inspect projection: task_id={} goal={} turn_instance={} inspect_revision={} guard_revision={}",
                    request.context.task_id,
                    request.goal_id,
                    turn_id,
                    request.expected_durable_revision,
                    durable_revision
                );
            }
            require_turn_owner(
                &guard.payload,
                &request.goal_id,
                &request.agent_id,
                operation_id,
            )?;
            if guard.payload.get("should_run").and_then(Value::as_bool) != Some(true) {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::Conflict,
                    operation_id,
                    "LoopX quota guard no longer permits host execution",
                    true,
                ));
            }
            let settlement_binding = planned_settlement_binding(&guard.payload);
            log::info!(
                "LoopX turn guard accepted: task_id={} goal={} turn_instance={} should_run=true revision={} binding={:?}",
                request.context.task_id,
                request.goal_id,
                turn_id,
                durable_revision,
                settlement_binding.as_ref().map(|binding| match binding {
                    SettlementBinding::Todo { todo_id } => format!("todo:{todo_id}"),
                    SettlementBinding::AutonomousReplan { obligation_id } => {
                        format!("replan:{obligation_id}")
                    }
                }),
            );
            let settlement_token = planned_settlement_token(
                &guard.payload,
                &request.goal_id,
                &request.agent_id,
                &turn_id,
                operation_id,
            )?;
            let verified = self.verified.lock().await.clone().ok_or_else(|| {
                port_error(
                    loopx_contract::LoopxCliErrorKind::Backend,
                    operation_id,
                    "LoopX executable identity disappeared after handshake",
                    true,
                )
            })?;
            let agent_instruction = render_agent_reentry_instruction(
                &guard.payload,
                &verified,
                &request.context.registry_path,
                &turn_id,
                settlement_binding.as_ref(),
                operation_id,
            )?;
            Ok(loopx_contract::LoopxCliBuildTurnResult {
                goal_id: request.goal_id,
                turn_id,
                agent_instruction,
                settlement_token,
                durable_revision,
                deadline_at: request.context.call.deadline_at,
            })
        })
    }

    fn viewer_merge_authority<'a>(
        &'a self,
        _context: &'a loopx_contract::LoopxCliGoalContext,
        repository: &'a loopx_contract::LoopxRepositoryKey,
    ) -> loopx_contract::LoopxCliFuture<'a, Option<bool>> {
        Box::pin(async move {
            self.intake_metadata
                .viewer_merge_authority(repository, Duration::from_secs(15))
                .await
        })
    }

    fn answer_gate<'a>(
        &'a self,
        request: loopx_contract::LoopxCliAnswerGateRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliAnswerGateResult> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            let operation_id = &request.context.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::AnsweringGate,
            };
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::AnsweringGate,
                "Applying the typed LoopX gate decision",
            );
            let decision = run_port_command(
                self,
                &request.context,
                answer_gate_args(&request)?,
                &observer,
            )
            .await?;
            require_payload_ok(&decision.payload, operation_id)?;
            let mut inspection_args = turn_plan_args(&request.goal_id, &request.agent_id, None);
            extend_available_capability_args(
                &mut inspection_args,
                &request.context.available_capabilities,
                operation_id,
            )?;
            let snapshot = inspect_goal_snapshot(
                self,
                &request.goal_id,
                &request.context,
                inspection_args,
                &observer,
            )
            .await?;
            Ok(loopx_contract::LoopxCliAnswerGateResult {
                goal_id: request.goal_id,
                gate_id: request.gate_id,
                applied: true,
                durable_revision: snapshot.durable_revision,
                goal_state: snapshot.state,
            })
        })
    }

    fn verify_turn_settlement<'a>(
        &'a self,
        request: loopx_contract::LoopxCliSettleTurnRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliSettleTurnResult> {
        Box::pin(async move {
            validate_goal_context(&request.context)?;
            validate_nonempty(
                "agent_id",
                &request.agent_id,
                &request.context.call.operation_id,
            )?;
            report_port_progress(
                progress,
                &request.context.call.operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::SettlingTurn,
                "Verifying durable LoopX progress and quota settlement evidence",
            );
            let operation_id = &request.context.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: Some(request.context.task_id.clone()),
                stage: loopx_contract::LoopxCliProgressStage::SettlingTurn,
            };
            let mut inspection_args =
                turn_plan_args(&request.goal_id, &request.agent_id, Some(&request.turn_id));
            extend_available_capability_args(
                &mut inspection_args,
                &request.context.available_capabilities,
                operation_id,
            )?;
            // The settlement inspection is read-only bookkeeping: its snapshot
            // feeds `after_revision` and the terminal-state check, while the
            // durable evidence below comes from `history`. When the pinned CLI
            // answers this inspection with the plan-exhausted replan-lineage
            // contract error (all todos done or blocked, open replan
            // obligation, no selected todo), salvage the typed payload instead
            // of failing the settlement of a turn that did complete its
            // writeback and quota spend: the post-settlement goal projection
            // then drives one autonomous replan turn bound to the obligation
            // (or parks the task if no obligation remains) through the normal
            // frontier handling.
            let (snapshot, inspection_payload) = match run_port_command_raw(
                self,
                &request.context,
                inspection_args,
                &observer,
            )
            .await
            {
                Ok(inspection) => {
                    require_payload_ok(&inspection.payload, operation_id)?;
                    require_schema(&inspection.payload, "loopx_turn_plan_v0", operation_id)?;
                    (
                        project_goal_snapshot(&request.goal_id, &inspection.payload, operation_id)?,
                        Some(inspection.payload),
                    )
                }
                Err(RawPortError::Port(error)) => return Err(error),
                Err(RawPortError::Adapter(error)) => {
                    let Some(payload) = salvage_replan_lineage_payload(&error) else {
                        return Err(map_port_error(error, operation_id));
                    };
                    log::warn!(
                            "LoopX settlement inspection hit the plan-exhausted replan lineage contract error; continuing settlement from durable history evidence: task_id={} goal={} turn={} error=\"{}\"",
                            request.context.task_id,
                            request.goal_id,
                            request.turn_id,
                            LOOPX_REPLAN_LINEAGE_ERROR
                        );
                    (
                        salvaged_replan_lineage_snapshot(&request.goal_id, &payload, operation_id)
                            .map(|(snapshot, _)| snapshot)
                            .ok_or_else(|| map_port_error(error, operation_id))?,
                        None,
                    )
                }
            };
            if is_legacy_turn_key(&request.settlement_token) {
                if let Some(receipt) = inspection_payload.as_ref().and_then(|payload| {
                    matching_settlement_receipt(payload, &request.settlement_token)
                }) {
                    return project_legacy_settlement(&request, &snapshot, receipt, operation_id);
                }
            }
            let history = run_port_command(
                self,
                &request.context,
                settlement_history_args(&request.goal_id),
                &observer,
            )
            .await?;
            require_payload_ok(&history.payload, operation_id)?;
            let evidence = matching_durable_progress(
                &history.payload,
                &request.goal_id,
                &request.agent_id,
                &request.turn_id,
                &request.settlement_token,
                operation_id,
            )?;
            let Some(evidence) = evidence else {
                report_port_progress(
                    progress,
                    operation_id,
                    Some(request.context.task_id.clone()),
                    loopx_contract::LoopxCliProgressStage::SettlingTurn,
                    "No matching durable LoopX writeback was found for this turn",
                );
                let status = if matches!(
                    request.agent_status,
                    loopx_contract::LoopxAgentTurnStatus::Failed
                        | loopx_contract::LoopxAgentTurnStatus::Cancelled
                        | loopx_contract::LoopxAgentTurnStatus::Interrupted
                ) {
                    loopx_contract::LoopxCliSettlementStatus::RetryRequired
                } else {
                    loopx_contract::LoopxCliSettlementStatus::NoDurableProgress
                };
                return Ok(loopx_contract::LoopxCliSettleTurnResult {
                    goal_id: request.goal_id,
                    turn_id: request.turn_id,
                    status,
                    before_revision: request.expected_durable_revision,
                    after_revision: snapshot.durable_revision,
                    scheduler_hint_ms: snapshot.scheduler_hint_ms,
                    ..loopx_contract::LoopxCliSettleTurnResult::default()
                });
            };
            if !evidence.quota_spent {
                report_port_progress(
                    progress,
                    operation_id,
                    Some(request.context.task_id.clone()),
                    loopx_contract::LoopxCliProgressStage::SettlingTurn,
                    "Matching durable LoopX writeback exists, but its quota settlement is missing",
                );
                return Ok(loopx_contract::LoopxCliSettleTurnResult {
                    goal_id: request.goal_id,
                    turn_id: request.turn_id,
                    status: loopx_contract::LoopxCliSettlementStatus::RetryRequired,
                    before_revision: request.expected_durable_revision,
                    after_revision: snapshot.durable_revision,
                    scheduler_hint_ms: snapshot.scheduler_hint_ms,
                    ..loopx_contract::LoopxCliSettleTurnResult::default()
                });
            }
            report_port_progress(
                progress,
                operation_id,
                Some(request.context.task_id.clone()),
                loopx_contract::LoopxCliProgressStage::SettlingTurn,
                "Matched validated LoopX progress and quota settlement evidence",
            );
            Ok(loopx_contract::LoopxCliSettleTurnResult {
                goal_id: request.goal_id,
                turn_id: request.turn_id,
                receipt_id: evidence.effect_id,
                status: if snapshot.state == loopx_contract::LoopxCliGoalState::Completed {
                    loopx_contract::LoopxCliSettlementStatus::GoalCompleted
                } else {
                    loopx_contract::LoopxCliSettlementStatus::Settled
                },
                before_revision: request.expected_durable_revision,
                after_revision: snapshot.durable_revision,
                validation_succeeded: true,
                scheduler_hint_ms: snapshot.scheduler_hint_ms,
            })
        })
    }

    fn cancel<'a>(
        &'a self,
        request: loopx_contract::LoopxCliCancelRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliCancelResult> {
        Box::pin(async move {
            validate_operation_id(&request.call.operation_id)?;
            validate_nonempty(
                "target_operation_id",
                &request.target_operation_id,
                &request.call.operation_id,
            )?;
            report_port_progress(
                progress,
                &request.call.operation_id,
                None,
                loopx_contract::LoopxCliProgressStage::Cancelling,
                "Cancelling the managed LoopX process tree",
            );
            let cancelled = self.cancel_operation(&request.target_operation_id);
            Ok(loopx_contract::LoopxCliCancelResult {
                operation_id: request.call.operation_id,
                target_operation_id: request.target_operation_id,
                cancelled,
            })
        })
    }

    fn reset_goals<'a>(
        &'a self,
        request: loopx_contract::LoopxCliResetGoalsRequest,
        progress: &'a dyn loopx_contract::LoopxCliProgressSink,
    ) -> loopx_contract::LoopxCliFuture<'a, loopx_contract::LoopxCliResetGoalsResult> {
        Box::pin(async move {
            validate_operation_id(&request.call.operation_id)?;
            let goal_ids = request
                .goal_ids
                .into_iter()
                .map(|goal_id| goal_id.trim().to_string())
                .filter(|goal_id| !goal_id.is_empty())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if goal_ids.is_empty() {
                return Err(port_error(
                    loopx_contract::LoopxCliErrorKind::InvalidInput,
                    &request.call.operation_id,
                    "reset_goals requires at least one explicit goal id",
                    false,
                ));
            }
            let operation_id = &request.call.operation_id;
            let observer = PortProcessObserver {
                progress,
                fallback: self.observer.as_ref(),
                task_id: None,
                stage: loopx_contract::LoopxCliProgressStage::Cancelling,
            };
            report_port_progress(
                progress,
                operation_id,
                None,
                loopx_contract::LoopxCliProgressStage::Cancelling,
                "Retiring global LoopX goal routes and archiving runtime state",
            );
            let deadline = effective_deadline(
                request.call.deadline_at,
                self.config.command_deadline,
                operation_id,
            )?;
            let mut result = loopx_contract::LoopxCliResetGoalsResult {
                requested_goal_ids: goal_ids.clone(),
                ..loopx_contract::LoopxCliResetGoalsResult::default()
            };

            for goal_id in goal_ids {
                let retired = run_idempotent_global_command(
                    self,
                    operation_id,
                    retire_global_goal_args(&goal_id),
                    "goal_id not found in global registry:",
                    deadline,
                    &observer,
                )
                .await?;
                if let Some(output) = retired {
                    require_payload_ok(&output.payload, operation_id)?;
                    require_schema(
                        &output.payload,
                        "loopx_global_goal_retirement_v0",
                        operation_id,
                    )?;
                    let retired_ids = output
                        .payload
                        .get("retired_goal_ids")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if !retired_ids
                        .iter()
                        .any(|value| value.as_str() == Some(&goal_id))
                    {
                        return Err(port_error(
                            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                            operation_id,
                            format!("retire-global-goal did not confirm goal {goal_id}"),
                            false,
                        ));
                    }
                    result.retired_goal_ids.push(goal_id.clone());
                    if let Some(path) = output.payload.get("backup_path").and_then(Value::as_str) {
                        result.backup_paths.push(path.to_string());
                    }
                } else {
                    result.already_absent_goal_ids.push(goal_id.clone());
                }

                let archived = run_idempotent_global_command(
                    self,
                    operation_id,
                    archive_runtime_args(&goal_id),
                    "runtime goal directory does not exist:",
                    deadline,
                    &observer,
                )
                .await?;
                if let Some(output) = archived {
                    require_payload_ok(&output.payload, operation_id)?;
                    if output.payload.get("archived").and_then(Value::as_bool) != Some(true) {
                        return Err(port_error(
                            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                            operation_id,
                            format!("archive-runtime did not confirm goal {goal_id}"),
                            false,
                        ));
                    }
                    result.archived_goal_ids.push(goal_id.clone());
                    if let Some(path) = output.payload.get("archive_path").and_then(Value::as_str) {
                        result.archive_paths.push(path.to_string());
                    }
                } else {
                    result.missing_runtime_goal_ids.push(goal_id);
                }
            }
            Ok(result)
        })
    }
}

fn matching_settlement_receipt<'a>(payload: &'a Value, turn_key: &str) -> Option<&'a Value> {
    payload
        .pointer("/transaction/receipts")
        .and_then(Value::as_array)?
        .iter()
        .find(|receipt| {
            receipt.get("turn_key").and_then(Value::as_str) == Some(turn_key)
                || receipt.get("settlement_token").and_then(Value::as_str) == Some(turn_key)
        })
}

fn turn_envelope<'a>(
    payload: &'a Value,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<&'a Value> {
    if payload.get("schema_version").and_then(Value::as_str) == Some("loopx_turn_envelope_v0") {
        return Ok(payload);
    }
    payload.get("turn_envelope").ok_or_else(|| {
        port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            "LoopX response omitted the TurnEnvelope",
            false,
        )
    })
}

fn require_turn_owner(
    packet: &Value,
    goal_id: &str,
    agent_id: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<()> {
    let envelope = turn_envelope(packet, operation_id)?;
    if envelope.get("goal_id").and_then(Value::as_str) != Some(goal_id)
        || envelope.get("agent_id").and_then(Value::as_str) != Some(agent_id)
    {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            "LoopX TurnEnvelope owner did not match the requested goal and agent",
            false,
        ));
    }
    Ok(())
}

fn planned_settlement_token(
    payload: &Value,
    goal_id: &str,
    agent_id: &str,
    turn_id: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<String> {
    if let Some(binding) = planned_settlement_binding(payload) {
        return Ok(binding.effect_id(goal_id, agent_id, turn_id));
    }

    payload
        .pointer("/transaction/turn_key")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "LoopX turn packet did not contain a selected Todo or transaction.turn_key",
                false,
            )
        })
}

fn planned_settlement_binding(payload: &Value) -> Option<SettlementBinding> {
    let route_kind = payload.pointer("/route/kind").and_then(Value::as_str);
    if route_kind == Some("replan_required") {
        let obligation_id = payload
            .pointer("/turn_envelope/replan_action_packet/obligation_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())?;
        return Some(SettlementBinding::AutonomousReplan {
            obligation_id: obligation_id.to_string(),
        });
    }

    if let Some(obligation_id) = [
        "/replan_action_packet/obligation_id",
        "/turn_envelope/replan_action_packet/obligation_id",
    ]
    .into_iter()
    .find_map(|pointer| {
        payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    }) {
        return Some(SettlementBinding::AutonomousReplan {
            obligation_id: obligation_id.to_string(),
        });
    }

    planned_todo_id(payload).map(|todo_id| SettlementBinding::Todo {
        todo_id: todo_id.to_string(),
    })
}

fn planned_todo_id(payload: &Value) -> Option<&str> {
    [
        "/route/selected_todo/todo_id",
        "/turn_envelope/action/selected_todo/todo_id",
        "/action/selected_todo/todo_id",
    ]
    .into_iter()
    .find_map(|pointer| {
        payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    })
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum SettlementBinding {
    Todo { todo_id: String },
    AutonomousReplan { obligation_id: String },
}

impl SettlementBinding {
    fn effect_id(&self, goal_id: &str, agent_id: &str, turn_id: &str) -> String {
        match self {
            Self::Todo { todo_id } => settlement_effect_id(goal_id, agent_id, todo_id, turn_id),
            Self::AutonomousReplan { obligation_id } => {
                replan_settlement_effect_id(goal_id, agent_id, obligation_id, turn_id)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableSettlementEvidence {
    effect_id: String,
    binding: SettlementBinding,
    quota_spent: bool,
}

fn matching_durable_progress(
    payload: &Value,
    goal_id: &str,
    agent_id: &str,
    turn_id: &str,
    settlement_token: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<Option<DurableSettlementEvidence>> {
    let goals = payload
        .get("goals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "LoopX history response did not contain goals",
                false,
            )
        })?;
    let Some(goal) = goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
    else {
        return Ok(None);
    };
    let runs = goal
        .get("latest_runs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "LoopX history goal did not contain latest_runs",
                false,
            )
        })?;

    let mut accountable_effects = BTreeMap::<String, SettlementBinding>::new();
    let mut quota_effects = BTreeSet::<String>::new();
    for run in runs {
        let Some((effect_id, binding)) = matching_run_identity(run, goal_id, agent_id, turn_id)
        else {
            continue;
        };
        match run.get("classification").and_then(Value::as_str) {
            Some("quota_slot_spent") => {
                quota_effects.insert(effect_id);
            }
            _ if run_has_accountable_progress(run) => {
                accountable_effects.insert(effect_id, binding);
            }
            _ => {}
        }
    }

    // New turns are fenced to the exact selected todo or replan obligation.
    // Legacy turn keys predate that binding, so persisted in-flight tasks may
    // still settle by their exact goal, agent, and host-issued turn identity.
    let candidates = if is_legacy_turn_key(settlement_token) {
        accountable_effects
    } else {
        accountable_effects
            .into_iter()
            .filter(|(effect_id, _)| settlement_token == effect_id)
            .collect::<BTreeMap<_, _>>()
    };
    // Prefer a candidate whose quota spend already settled; otherwise take the
    // first deterministic entry.
    let chosen = candidates
        .iter()
        .find(|(effect_id, _)| quota_effects.contains(*effect_id))
        .or_else(|| candidates.iter().next());
    let Some((effect_id, binding)) = chosen else {
        return Ok(None);
    };
    Ok(Some(DurableSettlementEvidence {
        effect_id: effect_id.clone(),
        binding: binding.clone(),
        quota_spent: quota_effects.contains(effect_id),
    }))
}

fn run_has_accountable_progress(run: &Value) -> bool {
    if let Some(observation) = run
        .get("progress_observation")
        .filter(|observation| !observation.is_null())
    {
        let typed_progress = observation.get("schema_version").and_then(Value::as_str)
            == Some("typed_progress_observation_v0")
            && matches!(
                observation.get("result_class").and_then(Value::as_str),
                Some("advanced" | "no_followup")
            );
        if typed_progress {
            return true;
        }
    }

    matches!(
        run.get("delivery_outcome").and_then(Value::as_str),
        Some("outcome_progress" | "primary_goal_outcome")
    )
}

fn matching_run_identity(
    run: &Value,
    goal_id: &str,
    agent_id: &str,
    turn_id: &str,
) -> Option<(String, SettlementBinding)> {
    let identity = run.get("settlement_identity")?;
    let effect_id = identity
        .get("effect_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?
        .to_string();
    let exact_owner = identity.get("goal_id").and_then(Value::as_str) == Some(goal_id)
        && identity.get("agent_id").and_then(Value::as_str) == Some(agent_id)
        && identity.get("turn_instance_id").and_then(Value::as_str) == Some(turn_id)
        && run.get("goal_id").and_then(Value::as_str) == Some(goal_id)
        && run.get("agent_id").and_then(Value::as_str) == Some(agent_id)
        && run.get("turn_instance_id").and_then(Value::as_str) == Some(turn_id);
    if !exact_owner {
        return None;
    }

    let binding = match identity.get("schema_version").and_then(Value::as_str) {
        Some("quota_settlement_identity_v0") => {
            let todo_id = identity
                .get("todo_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?;
            if run.get("todo_id").and_then(Value::as_str) != Some(todo_id) {
                return None;
            }
            SettlementBinding::Todo {
                todo_id: todo_id.to_string(),
            }
        }
        Some("quota_settlement_identity_v1")
            if identity.get("binding_kind").and_then(Value::as_str)
                == Some("autonomous_replan") =>
        {
            let obligation_id = identity
                .get("replan_obligation_id")
                .or_else(|| identity.get("binding_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?;
            if run.get("replan_obligation_id").and_then(Value::as_str) != Some(obligation_id) {
                return None;
            }
            SettlementBinding::AutonomousReplan {
                obligation_id: obligation_id.to_string(),
            }
        }
        _ => return None,
    };
    (effect_id == binding.effect_id(goal_id, agent_id, turn_id)).then_some((effect_id, binding))
}

fn settlement_effect_id(goal_id: &str, agent_id: &str, todo_id: &str, turn_id: &str) -> String {
    format!("{goal_id}:{agent_id}:{todo_id}:{turn_id}")
}

fn replan_settlement_effect_id(
    goal_id: &str,
    agent_id: &str,
    obligation_id: &str,
    turn_id: &str,
) -> String {
    format!("{goal_id}:{agent_id}:autonomous_replan:{obligation_id}:{turn_id}")
}

fn is_legacy_turn_key(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn project_legacy_settlement(
    request: &loopx_contract::LoopxCliSettleTurnRequest,
    snapshot: &loopx_contract::LoopxCliGoalSnapshot,
    receipt: &Value,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliSettleTurnResult> {
    let receipt_id = receipt
        .get("receipt_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "matching LoopX settlement receipt has no receipt_id",
                false,
            )
        })?
        .to_string();
    let validation_succeeded = receipt
        .get("validation_succeeded")
        .and_then(Value::as_bool)
        .or_else(|| {
            receipt
                .pointer("/validation/succeeded")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    Ok(loopx_contract::LoopxCliSettleTurnResult {
        goal_id: request.goal_id.clone(),
        turn_id: request.turn_id.clone(),
        receipt_id,
        status: if !validation_succeeded {
            loopx_contract::LoopxCliSettlementStatus::NoDurableProgress
        } else if snapshot.state == loopx_contract::LoopxCliGoalState::Completed {
            loopx_contract::LoopxCliSettlementStatus::GoalCompleted
        } else {
            loopx_contract::LoopxCliSettlementStatus::AlreadySettled
        },
        before_revision: request.expected_durable_revision.clone(),
        after_revision: snapshot.durable_revision.clone(),
        validation_succeeded,
        scheduler_hint_ms: snapshot.scheduler_hint_ms,
    })
}

fn agent_shell_command(command: &VerifiedLoopxCommand) -> String {
    let display = command.executable.to_string_lossy().replace('"', "\\\"");
    let arguments = command
        .prefix_args
        .iter()
        .map(|argument| agent_shell_value(&argument.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    if cfg!(windows) {
        let environment = command
            .environment
            .iter()
            .map(|(key, value)| {
                format!(
                    "$env:{}={}; ",
                    key.to_string_lossy(),
                    agent_shell_value(&value.to_string_lossy())
                )
            })
            .collect::<String>();
        format!(
            "{environment}& \"{display}\"{}",
            if arguments.is_empty() {
                String::new()
            } else {
                format!(" {arguments}")
            }
        )
    } else {
        let environment = command
            .environment
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={} ",
                    key.to_string_lossy(),
                    agent_shell_value(&value.to_string_lossy())
                )
            })
            .collect::<String>();
        format!(
            "{environment}'{}'{}",
            display.replace('\'', "'\\''"),
            if arguments.is_empty() {
                String::new()
            } else {
                format!(" {arguments}")
            }
        )
    }
}

fn agent_shell_value(value: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

const AGENT_SUMMARY_CONTRACT: &str = r#"End your final response with a fenced block holding exactly this JSON shape; it is the human-readable report of this segment. Fill human-facing values as plain self-contained sentences: never use internal codes or identifiers there (candidate numbers like C-1, todo ids, turn keys, effect ids, contract field names). Approval and gate state never goes into this block; the host approval card is the only surface for it. Omit optional fields that do not apply:

```loopx_summary_v1
{
  "issue_verdict": "needs_fix | already_fixed_upstream | wont_fix | needs_info",
  "fixed_by": "link to the upstream fix (required only when already_fixed_upstream)",
  "wont_fix_reason": "duplicate_of:<#issue> | by_design | invalid (required only when wont_fix)",
  "missing_info": ["what is missing"],
  "reproduction": "reproduced | not_reproduced | not_applicable",
  "reproduction_evidence": "link or path (required only when reproduced)",
  "segment_kind": "evidence | route_decision | implementation | validation | delivery",
  "completed": ["up to three plain sentences, each self-contained"],
  "artifacts": ["links to evidence or outputs"],
  "decision": {
    "route": "the chosen approach as one complete plain sentence (no codes)",
    "reason": "why this one",
    "rejected": [ { "route": "...", "why": "..." } ]
  },
  "blockers": ["only obstacles you observed; approval matters never go here"],
  "next_step": "one plain sentence that follows from the decision and completed items"
}
```

Conditional rules: already_fixed_upstream requires fixed_by; wont_fix requires wont_fix_reason; needs_info requires a non-empty missing_info; reproduced requires reproduction_evidence. next_step must not introduce facts that are not in decision or completed. When a user gate is pending, skip decision and next_step — the host approval card carries it."#;

fn render_agent_reentry_instruction(
    packet: &Value,
    command: &VerifiedLoopxCommand,
    registry_path: &str,
    turn_id: &str,
    binding: Option<&SettlementBinding>,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<String> {
    let envelope = turn_envelope(packet, operation_id)?;
    let contract = serde_json::json!({
        "schema_version": "bitfun_loopx_agent_turn_v0",
        "goal_id": envelope.get("goal_id"),
        "agent_id": envelope.get("agent_id"),
        "turn_id": turn_id,
        "decision": envelope.get("decision"),
        "state": envelope.get("state"),
        "effective_action": envelope.get("effective_action"),
        "action": envelope.get("action"),
        "user": envelope.get("user"),
        "required_reads": envelope.get("required_reads"),
        "replan_action_packet": envelope.get("replan_action_packet"),
        "boundary": envelope.get("boundary"),
        "execution_policy": envelope.get("execution_policy"),
        "writeback": envelope.get("writeback"),
        "contract_capsule": envelope.get("contract_capsule"),
        "response_plan": envelope.get("response_plan"),
        "task_orchestration_contract": envelope.get("task_orchestration_contract"),
        "detail_ref": envelope.get("detail_ref"),
    });
    let contract_json = serde_json::to_string_pretty(&contract).map_err(|error| {
        port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            error.to_string(),
            false,
        )
    })?;
    let cli_prefix = format!(
        "{} --format json --registry {}",
        agent_shell_command(command),
        agent_shell_value(registry_path)
    );
    let binding_flags = match binding {
        Some(SettlementBinding::Todo { todo_id }) => format!(
            "--todo-id {} --turn-instance-id {} --agent-id {}",
            agent_shell_value(todo_id),
            agent_shell_value(turn_id),
            agent_shell_value(
                envelope
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        ),
        Some(SettlementBinding::AutonomousReplan { obligation_id }) => format!(
            "--replan-obligation-id {} --turn-instance-id {} --autonomous-replan-recorded --agent-id {}",
            agent_shell_value(obligation_id),
            agent_shell_value(turn_id),
            agent_shell_value(
                envelope
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        ),
        None => format!("--turn-instance-id {}", agent_shell_value(turn_id)),
    };
    // The typed quota guard resolves the scheduler execution context from the
    // invocation flags. Without an explicit declaration the context is missing
    // (`repair_scheduler_execution_context`, "no quota spend for scheduler
    // context repair") and every spend is rejected fail-closed even when the
    // durable writeback validated. The host's own quota guard declares
    // `--runtime-profile outer_controller` for the same goal; the agent's spend
    // must declare exactly the same boundary.
    let goal_id_arg = format!(
        "--goal-id {}",
        agent_shell_value(
            envelope
                .get("goal_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )
    );
    let agent_id_arg = format!(
        "--agent-id {}",
        agent_shell_value(
            envelope
                .get("agent_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )
    );
    let spend_command = match binding {
        Some(SettlementBinding::Todo { todo_id }) => format!(
            "{cli_prefix} quota spend-slot {goal_id_arg} --slots 1 --source heartbeat --execute --todo-id {} --turn-instance-id {} {agent_id_arg} --runtime-profile outer_controller",
            agent_shell_value(todo_id),
            agent_shell_value(turn_id),
        ),
        Some(SettlementBinding::AutonomousReplan { obligation_id }) => format!(
            "{cli_prefix} quota spend-slot {goal_id_arg} --slots 1 --source heartbeat --execute --replan-obligation-id {} --turn-instance-id {} {agent_id_arg} --runtime-profile outer_controller",
            agent_shell_value(obligation_id),
            agent_shell_value(turn_id),
        ),
        None => String::new(),
    };
    let spend_instruction = if spend_command.is_empty() {
        "This turn has no settlement binding; do not spend quota.".to_string()
    } else {
        format!(
            "After the writeback validates, run this exact quota spend command once:\n`{spend_command}`\nRun it verbatim: do not add, remove, or reorder flags, and do not substitute the todo or turn ids. If it returns a typed rejection naming `repair_scheduler_execution_context` or an advanced guard, stop and report the rejection verbatim; do not retry with modified arguments."
        )
    };
    // Replan turns have no selected todo: the replan obligation itself is the
    // work item, so the generic "claim the selected todo" clause would point
    // the agent at a todo that does not exist.
    let work_clause = match binding {
        Some(SettlementBinding::AutonomousReplan { .. }) => {
            "This turn is an autonomous replan turn: no todo is selected and you must not invent a todo claim. Apply the `replan_action_packet` from the contract: first re-read the durable goal state and current evidence, then record exactly one required semantic outcome through the refresh-state writeback flags below — a concrete runnable successor todo only when an executable target is known, otherwise a typed terminal outcome (for example a coverage-backed `no_followup` with the goal vision closed) or a new concrete blocker with evidence. The replan ACK must carry a matching typed `--repair-delta-kind` (for example `no_followup`, `blocker`, `successor_or_supersede`, `goal_vision_patch`, or `exploration_exhausted`): an ACK without a delta is stored as a no-op and does not clear the obligation.".to_string()
        }
        _ => "Claim the selected executable todo before write-capable work. Execute only the selected action in the current worktree. Then use the LoopX CLI prefix to complete, update, block, or defer the selected todo and create a successor only when concrete follow-up remains.".to_string(),
    };
    Ok(format!(
        "You are the BitFun Agent executing one bounded LoopX-controlled work segment.\n\nLoopX CLI prefix for this task: `{cli_prefix}`\nThe BitFun runner already evaluated this turn's fresh quota guard. Do not run another scheduler or create another worktree.\n\nFollow the JSON contract below as the source of truth:\n<loopx_turn_contract>\n{contract_json}\n</loopx_turn_contract>\n\n{work_clause} Validate the real postcondition with tools; a prose claim is not evidence. Run the contract's refresh-state writeback with these exact identity flags: `{binding_flags}`. {spend_instruction} BitFun owns wake, cancellation, UI projection, and scheduler application.\n\n{AGENT_SUMMARY_CONTRACT}"
    ))
}

async fn run_port_command(
    adapter: &LoopxCliProcessAdapter,
    context: &loopx_contract::LoopxCliGoalContext,
    args: Vec<OsString>,
    observer: &dyn LoopxProcessObserver,
) -> loopx_contract::LoopxCliResult<LoopxJsonOutput> {
    run_port_command_raw(adapter, context, args, observer)
        .await
        .map_err(|error| raw_port_error_into(error, &context.call.operation_id))
}

/// Error surface of [`run_port_command_raw`]: either an already-typed port
/// error (preflight/deadline) or the raw adapter error, which keeps the CLI's
/// typed `ok:false` payload attached to a non-zero exit.
enum RawPortError {
    Port(loopx_contract::LoopxCliError),
    Adapter(LoopxCliAdapterError),
}

fn raw_port_error_into(error: RawPortError, operation_id: &str) -> loopx_contract::LoopxCliError {
    match error {
        RawPortError::Port(error) => error,
        RawPortError::Adapter(error) => map_port_error(error, operation_id),
    }
}

/// Raw-error variant of [`run_port_command`]: callers that need to inspect the
/// underlying [`LoopxCliAdapterError`] (for example to salvage a typed
/// `ok:false` payload from a non-zero exit) use this instead.
async fn run_port_command_raw(
    adapter: &LoopxCliProcessAdapter,
    context: &loopx_contract::LoopxCliGoalContext,
    args: Vec<OsString>,
    observer: &dyn LoopxProcessObserver,
) -> Result<LoopxJsonOutput, RawPortError> {
    let operation_id = &context.call.operation_id;
    let deadline = effective_deadline(
        context.call.deadline_at,
        adapter.config.command_deadline,
        operation_id,
    )
    .map_err(RawPortError::Port)?;
    adapter
        .run_json_command(
            operation_id,
            Path::new(&context.registry_path),
            Some(Path::new(&context.worktree_path)),
            args,
            deadline,
            observer,
        )
        .await
        .map_err(RawPortError::Adapter)
}

/// Runs a `turn plan` inspection and projects its goal snapshot. When the
/// pinned CLI exits 1 with the plan-exhausted replan-lineage contract error,
/// the typed payload it printed is salvaged into the equivalent read-only
/// `RunNow`-without-todo snapshot (with the open replan obligation id)
/// instead of failing the operation: the host then drives one autonomous
/// replan turn bound to that obligation, or parks the task when no
/// obligation remains. Any other failure maps to the standard port error.
async fn inspect_goal_snapshot(
    adapter: &LoopxCliProcessAdapter,
    goal_id: &str,
    context: &loopx_contract::LoopxCliGoalContext,
    args: Vec<OsString>,
    observer: &dyn LoopxProcessObserver,
) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliGoalSnapshot> {
    let operation_id = &context.call.operation_id;
    match run_port_command_raw(adapter, context, args, observer).await {
        Ok(output) => project_goal_snapshot(goal_id, &output.payload, operation_id),
        Err(RawPortError::Port(error)) => Err(error),
        Err(RawPortError::Adapter(error)) => {
            let Some(payload) = salvage_replan_lineage_payload(&error) else {
                return Err(map_port_error(error, operation_id));
            };
            log::warn!(
                "LoopX turn plan projected the plan-exhausted replan frontier without a todo lineage; salvaging the typed payload: operation_id={} error=\"{}\"",
                operation_id,
                LOOPX_REPLAN_LINEAGE_ERROR
            );
            salvaged_replan_lineage_snapshot(goal_id, &payload, operation_id)
                .map(|(snapshot, _)| snapshot)
                .ok_or_else(|| map_port_error(error, operation_id))
        }
    }
}

async fn run_idempotent_global_command(
    adapter: &LoopxCliProcessAdapter,
    operation_id: &str,
    args: Vec<OsString>,
    missing_error_prefix: &str,
    deadline: Duration,
    observer: &dyn LoopxProcessObserver,
) -> loopx_contract::LoopxCliResult<Option<LoopxJsonOutput>> {
    match adapter
        .run_global_json_command(operation_id, args, deadline, observer)
        .await
    {
        Ok(output) => Ok(Some(output)),
        Err(error) => {
            if process_error_json(&error)
                .and_then(|payload| {
                    payload
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .is_some_and(|message| message.starts_with(missing_error_prefix))
            {
                return Ok(None);
            }
            Err(map_port_error(error, operation_id))
        }
    }
}

fn process_error_json(error: &LoopxCliAdapterError) -> Option<Value> {
    let LoopxCliAdapterError::Process(LoopxProcessError::Exited { stdout_tail, .. }) = error else {
        return None;
    };
    serde_json::from_str(&stdout_tail.join("\n")).ok()
}

/// The pinned LoopX v0.5.1 CLI renders its plan-exhausted replan frontier
/// (every todo done or blocked, an open autonomous replan obligation, and no
/// selected todo) as `route.kind=contract_error` on `turn plan`: host-bound
/// routes demand a goal/agent/todo/action-hash lineage that a todo-less
/// frontier cannot provide, so the CLI prints the typed `ok:false` payload and
/// exits 1. This is the exact pinned-string marker for that projection.
const LOOPX_REPLAN_LINEAGE_ERROR: &str =
    "host-bound routes require goal, agent, todo, and action-hash lineage";

/// Salvages the typed `turn plan` payload from the pinned CLI's
/// replan-without-todo lineage contract error. Returns `None` for any other
/// process failure so unrelated errors still surface unchanged. The caller
/// must treat the result as read-only: the CLI already refused to execute, so
/// nothing here writes goal state or fabricates a settlement.
fn salvage_replan_lineage_payload(error: &LoopxCliAdapterError) -> Option<Value> {
    let LoopxCliAdapterError::Process(LoopxProcessError::Exited {
        payload: Some(payload),
        ..
    }) = error
    else {
        return None;
    };
    if payload.get("error").and_then(Value::as_str) != Some(LOOPX_REPLAN_LINEAGE_ERROR) {
        return None;
    }
    let envelope = payload.get("turn_envelope")?;
    // Only the plan-exhausted replan frontier is salvaged: the envelope must
    // itself assert `should_run` with an open replan obligation and no
    // selected todo. Any other host-route lineage failure keeps its error.
    if envelope.get("should_run").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let selected_todo = envelope
        .pointer("/action/selected_todo/todo_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !selected_todo.is_empty() {
        return None;
    }
    let obligation = envelope
        .pointer("/replan_action_packet/obligation_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if obligation.is_empty() {
        return None;
    }
    Some(payload.clone())
}

/// Projects the salvaged replan-lineage payload into the same read-only goal
/// snapshot vocabulary `turn plan` uses on success. The frontier is actionable
/// only through an autonomous replan, so the snapshot keeps `RunNow` with no
/// open todo, no waiting user decision, no selected todo, and the open replan
/// obligation id: the host's frontier handling then drives one bounded
/// autonomous replan turn bound to that obligation.
fn salvaged_replan_lineage_snapshot(
    goal_id: &str,
    payload: &Value,
    operation_id: &str,
) -> Option<(loopx_contract::LoopxCliGoalSnapshot, String)> {
    let envelope = payload.get("turn_envelope")?;
    let durable_revision = extract_durable_revision(payload, operation_id).ok()?;
    let open_todo_count = envelope
        .get("open_count")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let waiting_user_todo_count = envelope
        .pointer("/user/open_count")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let obligation_id = envelope
        .pointer("/replan_action_packet/obligation_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?
        .to_string();
    Some((
        loopx_contract::LoopxCliGoalSnapshot {
            goal_id: goal_id.to_string(),
            state: loopx_contract::LoopxCliGoalState::Active,
            durable_revision,
            run_decision: loopx_contract::LoopxCliRunDecision::RunNow,
            scheduler_hint_ms: scheduler_hint_ms(payload),
            open_todo_count: open_todo_count.try_into().unwrap_or(u32::MAX),
            waiting_user_todo_count: waiting_user_todo_count.try_into().unwrap_or(u32::MAX),
            pending_user_gate: None,
            selected_todo: None,
            pending_replan_obligation_id: Some(obligation_id.clone()),
            envelope_over_budget: envelope
                .pointer("/compaction/within_budget")
                .and_then(Value::as_bool)
                == Some(false),
        },
        obligation_id,
    ))
}

/// Maps the host-resolved remote state onto the state vocabulary LoopX's
/// metadata projection accepts (`open` | `closed` | `unknown`). LoopX has no
/// `merged` metadata state; a merged PR is already terminal, so `closed` is
/// the truthful projection.
fn metadata_state(state: loopx_contract::LoopxRemoteItemState) -> &'static str {
    use loopx_contract::LoopxRemoteItemState;
    match state {
        LoopxRemoteItemState::Open => "open",
        LoopxRemoteItemState::Closed | LoopxRemoteItemState::Merged => "closed",
        LoopxRemoteItemState::Unknown => "unknown",
    }
}

/// Builds the goal objective from the host-resolved title. The workflow-plan
/// packet carries no objective field, and the issue title is more meaningful
/// for goal surfaces than the bare canonical URL.
fn compact_objective(item: &loopx_contract::LoopxIssueKey, title: &str) -> String {
    const MAX_TITLE_CHARS: usize = 120;
    let title = title.trim();
    if title.is_empty() {
        return format!("Fix {}", item.canonical_url());
    }
    let mut bounded: String = title.chars().take(MAX_TITLE_CHARS).collect();
    if title.chars().count() > MAX_TITLE_CHARS {
        bounded.push_str("...");
    }
    format!("Fix #{}: {}", item.number, bounded)
}

fn plan_item_args(request: &loopx_contract::LoopxCliPlanItemRequest) -> Vec<OsString> {
    let kind = match request.item.kind {
        loopx_contract::LoopxItemKind::Issue => "issue",
        loopx_contract::LoopxItemKind::PullRequest => "pull_request",
    };
    // The intake adapter already resolved this metadata from the GitHub API;
    // never fabricate an open state or drop labels here, because the plan
    // packet feeds candidate admission, intake classification, and dedup.
    let metadata = serde_json::json!({
        "number": request.item.number,
        "state": metadata_state(request.state),
        "title": request.title,
        "labels": request.labels,
        "kind": kind,
    })
    .to_string();
    [
        "issue-fix".to_string(),
        "workflow-plan".to_string(),
        "--url".to_string(),
        request.item.canonical_url(),
        "--repo-path".to_string(),
        request.context.worktree_path.clone(),
        "--metadata-json".to_string(),
        metadata,
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn bootstrap_args(request: &loopx_contract::LoopxCliCreateGoalRequest) -> Vec<OsString> {
    // LoopX bootstrap defaults this legacy, Codex-named option to `ask`.
    // Explicitly disable it because BitFun owns wakeups through its generic
    // outer controller; this does not enable or emulate a Codex integration.
    let mut args = vec![
        "bootstrap".to_string(),
        "--project".to_string(),
        request.context.worktree_path.clone(),
        "--goal-id".to_string(),
        request.goal_id.clone(),
        "--objective".to_string(),
        request.intake.objective.clone(),
        "--adapter-kind".to_string(),
        "read_only_project_map_v0".to_string(),
        "--adapter-status".to_string(),
        "connected-read-only".to_string(),
        "--no-onboarding-scan".to_string(),
        "--codex-app-heartbeat".to_string(),
        "no".to_string(),
        // With `--runtime-root <worktree>/.loopx/runtime` (injected by
        // run_json_command) bootstrap's shared-registry merge already targets
        // the project-local runtime, so it CREATES
        // `<runtime>/registry.global.json` there instead of touching the
        // shared `~/.codex/loopx`. Do NOT pass `--no-global-sync` here:
        // skipping it leaves the local global registry missing and the next
        // command that merges (e.g. register-agent) fails with "global
        // registry does not exist" (2026-09-07 observed).
    ];
    if request
        .granted_scopes
        .contains(&loopx_contract::LoopxPermissionScope::WorkspaceWrite)
    {
        args.extend(["--write-scope".to_string(), "write".to_string()]);
    }
    // Place the goal state file under the project-local `.loopx` area from the
    // start. LoopX's legacy default is `<project>/.codex/goals/<goal-id>/...`;
    // passing --state-file here means the `.codex` directory is never created
    // in the worktree at all (BitFun and Codex are independent agents; the
    // `.codex` name is only LoopX's legacy default, not a BitFun/Codex
    // coupling). Verified: `bootstrap --help` supports `--state-file`.
    args.extend([
        "--state-file".to_string(),
        Path::new(&request.context.worktree_path)
            .join(".loopx")
            .join("goals")
            .join(&request.goal_id)
            .join("ACTIVE_GOAL_STATE.md")
            .display()
            .to_string(),
    ]);
    args.into_iter().map(OsString::from).collect()
}

fn register_agent_args(request: &loopx_contract::LoopxCliCreateGoalRequest) -> Vec<OsString> {
    [
        "register-agent",
        "--goal-id",
        request.goal_id.as_str(),
        "--agent-id",
        request.agent_id.as_str(),
        "--execute",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// Best-effort rewrite of the project registry's `common_runtime_root` to the
/// project-local runtime directory. LoopX v0.5.1 defaults that field to the
/// shared `~/.codex/loopx`; pointing it at `<registry dir>/runtime` keeps all
/// later CLI calls (controller and agent side) project-local and avoids the
/// shared-global-registry write denial / lock contention observed with both
/// the BitFun sidecar and the codex reference run (2026-09-07).
///
/// Also re-points each goal's default `state_file` from the legacy
/// `.codex/goals/<goal-id>/ACTIVE_GOAL_STATE.md` to
/// `.loopx/goals/<goal-id>/ACTIVE_GOAL_STATE.md` and copies the file over, so
/// the worktree stays fully `.loopx`-namespaced. BitFun and Codex are
/// independent agents; the `.codex` name in these paths is only LoopX's
/// legacy default, not a BitFun/Codex coupling, and this removes the last
/// trace of it from the worktree.
fn patch_registry_local_runtime_root(registry_path: &Path) -> std::io::Result<()> {
    if !registry_path.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(registry_path)?;
    let mut registry: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let project_dir = registry_path.parent().unwrap_or_else(|| Path::new("."));
    let local_runtime = project_dir.join("runtime");
    let local = local_runtime.to_string_lossy().replace('\\', "\\\\");
    let registry_obj = registry.as_object_mut().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "registry is not a JSON object")
    })?;
    let already_local = registry_obj
        .get("common_runtime_root")
        .and_then(serde_json::Value::as_str)
        .map(|current| Path::new(current) == local_runtime)
        .unwrap_or(false);
    if !already_local {
        registry_obj.insert(
            "common_runtime_root".to_string(),
            serde_json::Value::String(local),
        );
    }
    // Re-point each goal's state_file from the legacy `.codex/goals/...` path
    // to the project-local `.loopx/goals/...` path, copying the file over so
    // the goal stays readable at its new location.
    if let Some(goals) = registry_obj.get_mut("goals").and_then(serde_json::Value::as_array_mut) {
        for goal in goals.iter_mut() {
            let goal_obj = match goal.as_object_mut() {
                Some(goal_obj) => goal_obj,
                None => continue,
            };
            let goal_id = match goal_obj.get("id").and_then(serde_json::Value::as_str) {
                Some(goal_id) => goal_id,
                None => continue,
            };
            let state_file = match goal_obj.get("state_file").and_then(serde_json::Value::as_str) {
                Some(state_file) => state_file,
                None => continue,
            };
            let state_path = Path::new(state_file);
            let is_legacy_codex_path = state_path
                .components()
                .any(|component| component.as_os_str() == ".codex");
            if !is_legacy_codex_path {
                continue;
            }
            let new_state = project_dir
                .join(".loopx")
                .join("goals")
                .join(goal_id)
                .join("ACTIVE_GOAL_STATE.md");
            let new_state_escaped = new_state.to_string_lossy().replace('\\', "\\\\");
            if let Some(parent) = new_state.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let source_abs = if state_path.is_absolute() {
                state_path.to_path_buf()
            } else {
                project_dir.join(state_path)
            };
            if source_abs.exists() {
                let _ = std::fs::copy(&source_abs, &new_state);
            }
            goal_obj.insert(
                "state_file".to_string(),
                serde_json::Value::String(new_state_escaped),
            );
        }
    }
    let rewritten = serde_json::to_string_pretty(&registry)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    std::fs::write(registry_path, rewritten)?;
    // Safety net: some commands merge against `<runtime>/registry.global.json`
    // (the shared registry projected into the local runtime root). If it is
    // missing (e.g. an older goal created before this fix), create an empty
    // one so later commands do not fail with "global registry does not exist".
    let global_registry = local_runtime.join("registry.global.json");
    if !global_registry.exists() {
        if let Some(parent) = global_registry.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&global_registry, "{}\n");
    }
    Ok(())
}

fn list_todos_args(goal_id: &str) -> Vec<OsString> {
    ["todo", "list", "--goal-id", goal_id]
        .into_iter()
        .map(OsString::from)
        .collect()
}

fn todo_matches(existing: &Value, planned: &loopx_contract::LoopxCliTodoPlan) -> bool {
    existing.get("role").and_then(Value::as_str) == Some(planned.role.as_str())
        && existing.get("task_class").and_then(Value::as_str) == Some(planned.task_class.as_str())
        && existing.get("text").and_then(Value::as_str) == Some(planned.text.as_str())
        && existing.get("action_kind").and_then(Value::as_str) == planned.action_kind.as_deref()
}

fn add_todo_args(
    request: &loopx_contract::LoopxCliCreateGoalRequest,
    todo: &loopx_contract::LoopxCliTodoPlan,
) -> loopx_contract::LoopxCliResult<Vec<OsString>> {
    let operation_id = &request.context.call.operation_id;
    if !matches!(todo.role.as_str(), "agent" | "user") {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::InvalidInput,
            operation_id,
            "todo role must be agent or user",
            false,
        ));
    }
    if !matches!(
        todo.task_class.as_str(),
        "advancement_task" | "continuous_monitor" | "user_gate" | "user_action" | "blocker"
    ) {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::InvalidInput,
            operation_id,
            "todo task_class is not supported by LoopX v0.5.1",
            false,
        ));
    }
    validate_nonempty("todo.text", &todo.text, operation_id)?;
    let repository = &request.intake.item.repository;
    let mut args = vec![
        "todo".to_string(),
        "add".to_string(),
        "--goal-id".to_string(),
        request.goal_id.clone(),
        "--role".to_string(),
        todo.role.clone(),
        "--task-class".to_string(),
        todo.task_class.clone(),
        "--text".to_string(),
        todo.text.clone(),
    ];
    if let Some(action_kind) = &todo.action_kind {
        if !is_public_token(action_kind) {
            return Err(port_error(
                loopx_contract::LoopxCliErrorKind::InvalidInput,
                operation_id,
                "todo action_kind must be a bounded public-safe token",
                false,
            ));
        }
        args.extend(["--action-kind".to_string(), action_kind.clone()]);
    }
    if todo.role == "agent" {
        args.extend(["--claimed-by".to_string(), request.agent_id.clone()]);
        args.extend([
            "--task-repository".to_string(),
            format!(
                "git:{}/{}/{}",
                repository.host, repository.owner, repository.repository
            )
            .to_lowercase(),
        ]);
    } else {
        args.extend(["--agent-id".to_string(), request.agent_id.clone()]);
    }
    Ok(args.into_iter().map(OsString::from).collect())
}

fn turn_plan_args(goal_id: &str, agent_id: &str, turn_id: Option<&str>) -> Vec<OsString> {
    let mut args = vec![
        "turn".to_string(),
        "plan".to_string(),
        "--goal-id".to_string(),
        goal_id.to_string(),
        "--agent-id".to_string(),
        agent_id.to_string(),
        "--host".to_string(),
        "generic-cli".to_string(),
        "--execution-mode".to_string(),
        "isolated-headless".to_string(),
        "--scheduler-owner".to_string(),
        "outer_controller".to_string(),
        "--include-transaction-detail".to_string(),
    ];
    if let Some(turn_id) = turn_id {
        args.extend(["--turn-instance-id".to_string(), turn_id.to_string()]);
    }
    args.into_iter().map(OsString::from).collect()
}

fn quota_guard_args(
    goal_id: &str,
    agent_id: &str,
    binding: Option<&SettlementBinding>,
    turn_id: &str,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("quota"),
        OsString::from("should-run"),
        OsString::from("--goal-id"),
        OsString::from(goal_id),
        OsString::from("--agent-id"),
        OsString::from(agent_id),
        OsString::from("--runtime-profile"),
        OsString::from("outer_controller"),
        OsString::from("--turn-instance-id"),
        OsString::from(turn_id),
    ];
    if let Some(SettlementBinding::Todo { todo_id }) = binding {
        args.extend([OsString::from("--todo-id"), OsString::from(todo_id)]);
    }
    args
}

fn extend_available_capability_args(
    args: &mut Vec<OsString>,
    capabilities: &[String],
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<()> {
    let mut unique = BTreeSet::new();
    for capability in capabilities {
        let capability = capability.trim();
        if !is_public_token(capability) {
            return Err(port_error(
                loopx_contract::LoopxCliErrorKind::InvalidInput,
                operation_id,
                "available capability must be a bounded public-safe token",
                false,
            ));
        }
        if !unique.insert(capability) {
            continue;
        }
        args.push(OsString::from("--available-capability"));
        args.push(OsString::from(capability));
    }
    Ok(())
}

fn settlement_history_args(goal_id: &str) -> Vec<OsString> {
    [
        "history",
        "--goal-id",
        goal_id,
        "--limit",
        SETTLEMENT_HISTORY_LIMIT,
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn retire_global_goal_args(goal_id: &str) -> Vec<OsString> {
    ["retire-global-goal", "--goal-id", goal_id, "--execute"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

fn archive_runtime_args(goal_id: &str) -> Vec<OsString> {
    ["archive-runtime", "--goal-id", goal_id, "--execute"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

#[cfg(test)]
mod custom_runner_contract_tests {
    use super::{
        answer_gate_args, compact_objective, loopx_contract, matching_durable_progress,
        metadata_state, plan_item_args, planned_settlement_token, project_goal_snapshot,
        quota_guard_args, render_agent_reentry_instruction, LoopxCommandSource, SettlementBinding,
        VerifiedLoopxCommand,
    };
    use openbitfun_product_domains::miniapp::loopx::{
        LoopxCliPlanItemRequest, LoopxIssueKey, LoopxItemKind, LoopxRemoteItemState,
        LoopxRepositoryKey,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn issue_key(number: u64) -> LoopxIssueKey {
        LoopxIssueKey {
            repository: LoopxRepositoryKey {
                host: "github.com".to_string(),
                owner: "owner".to_string(),
                repository: "repo".to_string(),
            },
            kind: LoopxItemKind::Issue,
            number,
        }
    }

    #[test]
    fn plan_item_args_pass_resolved_state_and_labels() {
        let request = LoopxCliPlanItemRequest {
            item: issue_key(42),
            title: "Search returns stale results".to_string(),
            state: LoopxRemoteItemState::Closed,
            labels: vec!["bug".to_string(), "needs-repro".to_string()],
            ..Default::default()
        };
        let metadata = plan_item_args(&request)
            .windows(2)
            .find(|pair| pair[0] == OsString::from("--metadata-json"))
            .map(|pair| pair[1].to_string_lossy().into_owned())
            .expect("metadata json argument");
        let payload: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(payload["state"], "closed");
        assert_eq!(payload["labels"], json!(["bug", "needs-repro"]));
        assert_eq!(payload["number"], 42);
        assert_eq!(payload["kind"], "issue");
    }

    #[test]
    fn answer_gate_args_mark_the_decision_as_an_explicit_effect() {
        let request = loopx_contract::LoopxCliAnswerGateRequest {
            context: loopx_contract::LoopxCliGoalContext::default(),
            goal_id: "goal-1".to_string(),
            agent_id: "agent-1".to_string(),
            gate_id: "todo-user-gate".to_string(),
            decision: loopx_contract::LoopxCliGateDecision::Approve,
            note: None,
            granted_scope: None,
        };

        let args = answer_gate_args(&request).expect("gate args");

        assert!(args.contains(&OsString::from("--execute")));
    }

    #[test]
    fn metadata_state_maps_merged_and_unknown_truthfully() {
        assert_eq!(metadata_state(LoopxRemoteItemState::Open), "open");
        assert_eq!(metadata_state(LoopxRemoteItemState::Closed), "closed");
        // LoopX has no merged metadata state; merged is already terminal.
        assert_eq!(metadata_state(LoopxRemoteItemState::Merged), "closed");
        assert_eq!(metadata_state(LoopxRemoteItemState::Unknown), "unknown");
    }

    #[test]
    fn compact_objective_uses_the_resolved_title_and_bounds_length() {
        let item = issue_key(42);
        assert_eq!(
            compact_objective(&item, "  Crash on empty input  "),
            "Fix #42: Crash on empty input"
        );
        assert_eq!(
            compact_objective(&item, ""),
            format!("Fix {}", item.canonical_url())
        );
        let long = format!("{}-tail", "x".repeat(200));
        let objective = compact_objective(&item, &long);
        assert!(objective.starts_with("Fix #42: "));
        assert!(objective.chars().count() <= "Fix #42: ".len() + 123);
        assert!(objective.ends_with("..."));
    }

    #[test]
    fn custom_runner_instruction_projects_only_the_fresh_turn_contract() {
        let command = VerifiedLoopxCommand {
            executable: PathBuf::from("loopx"),
            prefix_args: Vec::new(),
            environment: BTreeMap::new(),
            source: LoopxCommandSource::FixedSystemCommand,
            version: "0.5.1".to_string(),
            bundle_manifest_schema: None,
            command_reference_schema: "loopx_command_reference_v0".to_string(),
            sha256: None,
        };
        let packet = json!({
            "schema_version": "loopx_turn_envelope_v0",
            "goal_id": "goal-1",
            "agent_id": "agent-1",
            "action": {
                "recommended_action": "Fix the selected issue.",
                "selected_todo": {"todo_id": "todo-1"}
            },
            "user": {
                "action_required": true,
                "actions": [{"todo_id": "user-1", "text": "Approve publication"}]
            },
            "required_reads": [],
            "boundary": {"rule": "stay_in_scope_or_stop"},
            "execution_policy": {"normal_delivery_allowed": true},
            "writeback": {"spend_after_validation": true},
            "contract_capsule": {"schema_version": "loopx_contract_capsule_v0"}
        });
        let binding = SettlementBinding::Todo {
            todo_id: "todo-1".to_string(),
        };
        let instruction = render_agent_reentry_instruction(
            &packet,
            &command,
            ".loopx/registry.json",
            "turn-1",
            Some(&binding),
            "build-turn",
        )
        .expect("custom runner instruction");

        assert!(instruction.contains("BitFun Agent executing one bounded"));
        assert!(instruction.contains("Fix the selected issue."));
        assert!(instruction.contains(".loopx/registry.json"));
        assert!(instruction.contains("turn-1"));
        assert!(instruction.contains("--todo-id"));
        assert!(instruction.contains("Claim the selected executable todo"));
        assert!(instruction.contains("Approve publication"));
        assert!(instruction.contains("a prose claim is not evidence"));
        // The typed quota spend command must carry the scheduler execution
        // context declaration; without it every spend is rejected fail-closed
        // (`repair_scheduler_execution_context`).
        assert!(instruction.contains("quota spend-slot"));
        assert!(instruction.contains("--goal-id"));
        assert!(instruction.contains("goal-1"));
        assert!(instruction.contains("--source heartbeat --execute"));
        assert!(instruction.contains("--runtime-profile outer_controller"));
        assert!(instruction.contains("--turn-instance-id"));

        let guard = quota_guard_args("goal-1", "agent-1", Some(&binding), "turn-1");
        assert!(guard.windows(2).any(|pair| pair == ["--todo-id", "todo-1"]));
    }

    #[test]
    fn selected_todo_builds_the_exact_settlement_effect_identity() {
        let token = planned_settlement_token(
            &json!({
                "route": {"selected_todo": {"todo_id": "todo-1"}},
                "transaction": {"turn_key": "sha256:legacy"}
            }),
            "goal-1",
            "agent-1",
            "turn-1",
            "build-turn",
        )
        .unwrap();

        assert_eq!(token, "goal-1:agent-1:todo-1:turn-1");
    }

    #[test]
    fn replan_route_builds_the_autonomous_replan_effect_identity() {
        let token = planned_settlement_token(
            &json!({
                "route": {
                    "kind": "replan_required",
                    "selected_todo": {"todo_id": "todo-1"}
                },
                "turn_envelope": {
                    "replan_action_packet": {"obligation_id": "replan-1"}
                },
                "transaction": {"turn_key": "sha256:legacy"}
            }),
            "goal-1",
            "agent-1",
            "turn-1",
            "build-turn",
        )
        .unwrap();

        assert_eq!(token, "goal-1:agent-1:autonomous_replan:replan-1:turn-1");
    }

    #[test]
    fn durable_settlement_requires_matching_advanced_progress_and_quota_spend() {
        let effect_id = "goal-1:agent-1:todo-1:turn-1";
        let identity = json!({
            "schema_version": "quota_settlement_identity_v0",
            "effect_id": effect_id,
            "goal_id": "goal-1",
            "agent_id": "agent-1",
            "todo_id": "todo-1",
            "turn_instance_id": "turn-1"
        });
        let payload = json!({
            "goals": [{
                "id": "goal-1",
                "latest_runs": [
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-1",
                        "classification": "validated_progress",
                        "progress_observation": {
                            "schema_version": "typed_progress_observation_v0",
                            "result_class": "advanced",
                            "work_item_id": "todo-1"
                        },
                        "settlement_identity": identity.clone()
                    },
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-1",
                        "classification": "quota_slot_spent",
                        "settlement_identity": identity
                    }
                ]
            }]
        });

        let evidence = matching_durable_progress(
            &payload,
            "goal-1",
            "agent-1",
            "turn-1",
            effect_id,
            "settle-turn",
        )
        .unwrap()
        .expect("settlement evidence");
        assert_eq!(evidence.effect_id, effect_id);
        assert!(evidence.quota_spent);
    }

    #[test]
    fn durable_progress_without_quota_remains_unsettled() {
        let effect_id = "goal-1:agent-1:todo-1:turn-1";
        let payload = json!({
            "goals": [{
                "id": "goal-1",
                "latest_runs": [{
                    "goal_id": "goal-1",
                    "agent_id": "agent-1",
                    "todo_id": "todo-1",
                    "turn_instance_id": "turn-1",
                    "classification": "validated_progress",
                    "progress_observation": {
                        "schema_version": "typed_progress_observation_v0",
                        "result_class": "advanced",
                        "work_item_id": "todo-1"
                    },
                    "settlement_identity": {
                        "schema_version": "quota_settlement_identity_v0",
                        "effect_id": effect_id,
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-1"
                    }
                }]
            }]
        });

        let evidence = matching_durable_progress(
            &payload,
            "goal-1",
            "agent-1",
            "turn-1",
            effect_id,
            "settle-turn",
        )
        .unwrap()
        .expect("validated progress");
        assert!(!evidence.quota_spent);
        assert_eq!(
            evidence.binding,
            SettlementBinding::Todo {
                todo_id: "todo-1".to_string()
            }
        );
    }

    #[test]
    fn autonomous_replan_progress_uses_the_v1_settlement_binding() {
        let effect_id = "goal-1:agent-1:autonomous_replan:replan-1:turn-1";
        let payload = json!({
            "goals": [{
                "id": "goal-1",
                "latest_runs": [{
                    "goal_id": "goal-1",
                    "agent_id": "agent-1",
                    "turn_instance_id": "turn-1",
                    "replan_obligation_id": "replan-1",
                    "classification": "state_projection_repair",
                    "delivery_outcome": "outcome_progress",
                    "progress_observation": {
                        "schema_version": "typed_progress_observation_v0",
                        "result_class": "advanced"
                    },
                    "settlement_identity": {
                        "schema_version": "quota_settlement_identity_v1",
                        "effect_id": effect_id,
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "turn_instance_id": "turn-1",
                        "binding_kind": "autonomous_replan",
                        "binding_id": "replan-1",
                        "replan_obligation_id": "replan-1"
                    }
                }]
            }]
        });

        let evidence = matching_durable_progress(
            &payload,
            "goal-1",
            "agent-1",
            "turn-1",
            "sha256:legacy",
            "settle-turn",
        )
        .unwrap()
        .expect("replan progress");
        assert_eq!(evidence.effect_id, effect_id);
        assert_eq!(
            evidence.binding,
            SettlementBinding::AutonomousReplan {
                obligation_id: "replan-1".to_string()
            }
        );
        assert!(!evidence.quota_spent);
    }

    #[test]
    fn monitor_todo_projection_is_bounded_and_non_authoritative() {
        let snapshot = project_goal_snapshot(
            "goal-1",
            &json!({
                "ok": true,
                "schema_version": "loopx_turn_plan_v0",
                "turn_envelope": {
                    "should_run": false,
                    "state": "monitor_wait",
                    "effective_action": "monitor_wait",
                    "open_count": 1,
                    "action": {
                        "recommended_action": "Wait for CI on the published PR; replan when a maintainer requests changes.",
                        "selected_todo": {
                            "todo_id": "todo-monitor-1",
                            "task_class": "continuous_monitor",
                            "action_kind": "issue_fix_pr_state_checks_pending_monitor",
                            "target_key": "issue_fix_pr_state_checks_pending",
                            "claimed_by": "bitfun-loopx",
                            "next_due_at": "2026-09-03T12:00:00Z"
                        }
                    }
                }
            }),
            "inspect-goal",
        )
        .unwrap();

        assert_eq!(
            snapshot.run_decision,
            loopx_contract::LoopxCliRunDecision::Wait
        );
        let todo = snapshot
            .selected_todo
            .expect("monitor todo projection from the envelope");
        assert_eq!(todo.todo_id, "todo-monitor-1");
        assert_eq!(todo.task_class, "continuous_monitor");
        assert_eq!(
            todo.action_kind,
            "issue_fix_pr_state_checks_pending_monitor"
        );
        assert_eq!(todo.next_due_at.as_deref(), Some("2026-09-03T12:00:00Z"));
        assert!(todo.recommended_action.contains("Wait for CI"));
    }

    #[test]
    fn selected_todo_without_an_id_is_dropped() {
        let snapshot = project_goal_snapshot(
            "goal-1",
            &json!({
                "ok": true,
                "schema_version": "loopx_turn_plan_v0",
                "turn_envelope": {
                    "should_run": false,
                    "state": "eligible",
                    "action": {"selected_todo": {"task_class": "advancement_task"}}
                }
            }),
            "inspect-goal",
        )
        .unwrap();
        assert!(snapshot.selected_todo.is_none());
    }

    #[test]
    fn terminal_no_followup_is_a_completed_goal() {
        let snapshot = project_goal_snapshot(
            "goal-1",
            &json!({
                "ok": true,
                "schema_version": "loopx_turn_plan_v0",
                "turn_envelope": {
                    "should_run": false,
                    "state": "terminal_no_followup",
                    "effective_action": "terminal_no_followup",
                    "action_signature": {
                        "source_hash": "sha256:terminal"
                    }
                }
            }),
            "inspect-goal",
        )
        .unwrap();

        assert_eq!(
            snapshot.run_decision,
            loopx_contract::LoopxCliRunDecision::Complete
        );
        assert_eq!(snapshot.state, loopx_contract::LoopxCliGoalState::Completed);
    }

    #[test]
    fn runnable_agent_work_takes_precedence_over_a_concurrent_user_action() {
        let snapshot = project_goal_snapshot(
            "goal-1",
            &json!({
                "ok": true,
                "schema_version": "loopx_turn_plan_v0",
                "turn_envelope": {
                    "should_run": true,
                    "state": "eligible",
                    "effective_action": "run_selected_todo",
                    "open_count": 2,
                    "user": {
                        "action_required": true,
                        "open_count": 1
                    },
                    "action_signature": {
                        "source_hash": "sha256:mixed-frontier"
                    }
                }
            }),
            "inspect-goal",
        )
        .unwrap();

        assert_eq!(
            snapshot.run_decision,
            loopx_contract::LoopxCliRunDecision::RunNow
        );
        assert_eq!(snapshot.waiting_user_todo_count, 1);
    }

    #[test]
    fn durable_progress_on_an_unplanned_todo_does_not_settle_the_turn() {
        let planned_token = "goal-1:agent-1:todo-planned:turn-1";
        let actual_effect = "goal-1:agent-1:todo-actual:turn-1";
        let identity = json!({
            "schema_version": "quota_settlement_identity_v0",
            "effect_id": actual_effect,
            "goal_id": "goal-1",
            "agent_id": "agent-1",
            "todo_id": "todo-actual",
            "turn_instance_id": "turn-1"
        });
        let payload = json!({
            "goals": [{
                "id": "goal-1",
                "latest_runs": [
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-actual",
                        "turn_instance_id": "turn-1",
                        "classification": "validated_progress",
                        "progress_observation": {
                            "schema_version": "typed_progress_observation_v0",
                            "result_class": "advanced",
                            "work_item_id": "todo-actual"
                        },
                        "settlement_identity": identity.clone()
                    },
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-actual",
                        "turn_instance_id": "turn-1",
                        "classification": "quota_slot_spent",
                        "settlement_identity": identity
                    }
                ]
            }]
        });

        let evidence = matching_durable_progress(
            &payload,
            "goal-1",
            "agent-1",
            "turn-1",
            planned_token,
            "settle-turn",
        )
        .unwrap();
        assert_eq!(evidence, None);
    }

    #[test]
    fn legacy_validated_progress_uses_accountable_delivery_outcome() {
        let effect_id = "goal-1:agent-1:todo-1:turn-1";
        let identity = json!({
            "schema_version": "quota_settlement_identity_v0",
            "effect_id": effect_id,
            "goal_id": "goal-1",
            "agent_id": "agent-1",
            "todo_id": "todo-1",
            "turn_instance_id": "turn-1"
        });
        let payload = json!({
            "goals": [{
                "id": "goal-1",
                "latest_runs": [
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-1",
                        "classification": "validated_progress",
                        "delivery_outcome": "outcome_progress",
                        "settlement_identity": identity.clone()
                    },
                    {
                        "goal_id": "goal-1",
                        "agent_id": "agent-1",
                        "todo_id": "todo-1",
                        "turn_instance_id": "turn-1",
                        "classification": "quota_slot_spent",
                        "settlement_identity": identity
                    }
                ]
            }]
        });

        let evidence = matching_durable_progress(
            &payload,
            "goal-1",
            "agent-1",
            "turn-1",
            effect_id,
            "settle-turn",
        )
        .unwrap()
        .expect("legacy settlement evidence");
        assert!(evidence.quota_spent);
    }
}

fn answer_gate_args(
    request: &loopx_contract::LoopxCliAnswerGateRequest,
) -> loopx_contract::LoopxCliResult<Vec<OsString>> {
    let operation_id = &request.context.call.operation_id;
    validate_nonempty("gate_id", &request.gate_id, operation_id)?;
    let decision = match request.decision {
        loopx_contract::LoopxCliGateDecision::Approve => "approve",
        loopx_contract::LoopxCliGateDecision::Reject => "reject",
    };
    let mut args = vec![
        "todo".to_string(),
        "complete".to_string(),
        "--goal-id".to_string(),
        request.goal_id.clone(),
        "--todo-id".to_string(),
        request.gate_id.clone(),
        "--decision-outcome".to_string(),
        decision.to_string(),
        "--agent-id".to_string(),
        request.agent_id.clone(),
        "--execute".to_string(),
    ];
    if let Some(note) = &request.note {
        if note.len() > 500 {
            return Err(port_error(
                loopx_contract::LoopxCliErrorKind::InvalidInput,
                operation_id,
                "gate note exceeds the 500-byte adapter limit",
                false,
            ));
        }
        args.extend(["--note".to_string(), note.clone()]);
    }
    Ok(args.into_iter().map(OsString::from).collect())
}

/// Bounded plain text for UX projections; never a control fact.
fn bounded_projection_text(value: Option<&str>, limit: usize) -> String {
    let raw = value.unwrap_or_default().trim();
    if raw.chars().count() <= limit {
        return raw.to_string();
    }
    let truncated: String = raw.chars().take(limit).collect();
    format!("{truncated}...")
}

fn bounded_projection_field(value: &Value, key: &str) -> String {
    bounded_projection_text(value.get(key).and_then(Value::as_str), 160)
}

fn project_selected_todo(envelope: &Value) -> Option<loopx_contract::LoopxCurrentTodo> {
    let action = envelope.get("action")?;
    let todo = action.get("selected_todo")?;
    let todo_id = bounded_projection_field(todo, "todo_id");
    if todo_id.is_empty() {
        return None;
    }
    Some(loopx_contract::LoopxCurrentTodo {
        todo_id,
        task_class: bounded_projection_field(todo, "task_class"),
        action_kind: bounded_projection_field(todo, "action_kind"),
        target_key: bounded_projection_field(todo, "target_key"),
        claimed_by: bounded_projection_field(todo, "claimed_by"),
        next_due_at: todo
            .get("next_due_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        recommended_action: bounded_projection_text(
            action.get("recommended_action").and_then(Value::as_str),
            240,
        ),
    })
}

fn project_goal_snapshot(
    goal_id: &str,
    payload: &Value,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliGoalSnapshot> {
    require_payload_ok(payload, operation_id)?;
    require_schema(payload, "loopx_turn_plan_v0", operation_id)?;
    let envelope = payload.get("turn_envelope").ok_or_else(|| {
        port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            "turn plan did not contain turn_envelope",
            false,
        )
    })?;
    let should_run = envelope.get("should_run").and_then(Value::as_bool) == Some(true);
    let user_action_required = envelope
        .pointer("/user/action_required")
        .and_then(Value::as_bool)
        .or_else(|| envelope.get("action_required").and_then(Value::as_bool))
        == Some(true);
    let state_text = envelope
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let effective_action = envelope
        .get("effective_action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let control_status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let operator_gate_notify = matches!(
        effective_action,
        "operator_gate" | "operator_gate_notify" | "waiting_for_user"
    ) || matches!(state_text, "operator_gate" | "operator_gate_notify")
        || control_status == "operator_gate_notify";
    let run_decision = if should_run {
        loopx_contract::LoopxCliRunDecision::RunNow
    } else if user_action_required || operator_gate_notify {
        loopx_contract::LoopxCliRunDecision::WaitingForUser
    } else if effective_action == "terminal_no_followup"
        || matches!(
            state_text,
            "completed" | "complete" | "closed" | "terminal_no_followup"
        )
    {
        loopx_contract::LoopxCliRunDecision::Complete
    } else if matches!(state_text, "failed" | "error") {
        loopx_contract::LoopxCliRunDecision::Failed
    } else {
        loopx_contract::LoopxCliRunDecision::Wait
    };
    let state = match run_decision {
        loopx_contract::LoopxCliRunDecision::RunNow => loopx_contract::LoopxCliGoalState::Active,
        loopx_contract::LoopxCliRunDecision::WaitingForUser => {
            loopx_contract::LoopxCliGoalState::WaitingForUser
        }
        loopx_contract::LoopxCliRunDecision::Complete => {
            loopx_contract::LoopxCliGoalState::Completed
        }
        loopx_contract::LoopxCliRunDecision::Failed => loopx_contract::LoopxCliGoalState::Failed,
        loopx_contract::LoopxCliRunDecision::Wait => {
            if effective_action == "archived" {
                loopx_contract::LoopxCliGoalState::Archived
            } else {
                loopx_contract::LoopxCliGoalState::Active
            }
        }
    };
    Ok(loopx_contract::LoopxCliGoalSnapshot {
        goal_id: goal_id.to_string(),
        state,
        durable_revision: extract_durable_revision(payload, operation_id)?,
        run_decision,
        scheduler_hint_ms: scheduler_hint_ms(payload),
        open_todo_count: envelope
            .get("open_count")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .try_into()
            .unwrap_or(u32::MAX),
        waiting_user_todo_count: envelope
            .pointer("/user/open_count")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .try_into()
            .unwrap_or(u32::MAX),
        pending_user_gate: None,
        selected_todo: project_selected_todo(envelope),
        pending_replan_obligation_id: envelope
            .pointer("/replan_action_packet/obligation_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        envelope_over_budget: envelope
            .pointer("/compaction/within_budget")
            .and_then(Value::as_bool)
            == Some(false),
    })
}

fn project_pending_user_gate(
    payload: &Value,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliUserGate> {
    require_payload_ok(payload, operation_id)?;
    let todos = payload
        .get("todos")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "todo list response did not contain todos",
                false,
            )
        })?;
    let gate = todos
        .iter()
        .find(|todo| {
            let status = todo
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            todo.get("role").and_then(Value::as_str) == Some("user")
                && todo.get("task_class").and_then(Value::as_str) == Some("user_gate")
                && todo.get("done").and_then(Value::as_bool) != Some(true)
                && !matches!(
                    status,
                    "completed" | "closed" | "done" | "archived" | "cancelled"
                )
        })
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                "LoopX requested a user decision without an open typed user gate",
                false,
            )
        })?;
    Ok(loopx_contract::LoopxCliUserGate {
        gate_id: required_json_string(gate, "todo_id", operation_id)?,
        message: truncate_message(&required_json_string(gate, "text", operation_id)?),
        action_kind: gate
            .get("action_kind")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
    })
}

fn extract_durable_revision(
    payload: &Value,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<String> {
    [
        "/action_signature/source_decision_hash",
        "/action_signature/source_hash",
        "/turn_envelope/action_signature/source_decision_hash",
        "/turn_envelope/action_signature/source_hash",
        "/transaction/turn_key",
    ]
    .into_iter()
    .find_map(|pointer| {
        payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    })
    .map(str::to_string)
    .ok_or_else(|| {
        port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            "LoopX turn packet did not expose a durable revision identity",
            false,
        )
    })
}

fn stable_turn_id(request: &loopx_contract::LoopxCliBuildTurnRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(request.context.task_id.as_bytes());
    hasher.update([0]);
    hasher.update(request.context.generation.to_le_bytes());
    hasher.update([0]);
    hasher.update(request.goal_id.as_bytes());
    hasher.update([0]);
    hasher.update(request.expected_durable_revision.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("bitfun-{}", &digest[..32])
}

fn scheduler_hint_ms(payload: &Value) -> Option<u64> {
    [
        "/scheduler/hint_ms",
        "/scheduler/next_poll_ms",
        "/turn_envelope/scheduler/hint_ms",
        "/turn_envelope/scheduler/next_poll_ms",
        "/scheduler_hint_ms",
    ]
    .into_iter()
    .find_map(|pointer| payload.pointer(pointer).and_then(Value::as_u64))
}

fn require_payload_ok(payload: &Value, operation_id: &str) -> loopx_contract::LoopxCliResult<()> {
    if payload.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("LoopX rejected the operation");
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::Backend,
            operation_id,
            truncate_message(message),
            false,
        ));
    }
    Ok(())
}

fn require_schema(
    payload: &Value,
    expected: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<()> {
    let actual = payload
        .get("schema_version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if actual != expected {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::SchemaMismatch,
            operation_id,
            format!("expected response schema {expected}, got {actual}"),
            false,
        ));
    }
    Ok(())
}

fn required_json_string(
    payload: &Value,
    field: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            port_error(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                operation_id,
                format!("LoopX response field {field} is missing or invalid"),
                false,
            )
        })
}

fn validate_goal_context(
    context: &loopx_contract::LoopxCliGoalContext,
) -> loopx_contract::LoopxCliResult<()> {
    let operation_id = &context.call.operation_id;
    validate_operation_id(operation_id)?;
    validate_nonempty("task_id", &context.task_id, operation_id)?;
    validate_nonempty("worktree_path", &context.worktree_path, operation_id)?;
    validate_nonempty("registry_path", &context.registry_path, operation_id)?;
    if !Path::new(&context.worktree_path).is_absolute()
        || !Path::new(&context.registry_path).is_absolute()
    {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::InvalidInput,
            operation_id,
            "LoopX local worktree and registry paths must be absolute",
            false,
        ));
    }
    Ok(())
}

fn validate_github_item(
    item: &loopx_contract::LoopxIssueKey,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<()> {
    if !item.repository.host.eq_ignore_ascii_case("github.com")
        || item.repository.owner.is_empty()
        || item.repository.repository.is_empty()
        || item.number == 0
    {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::InvalidInput,
            operation_id,
            "LoopX v0.5.1 issue-fix planning requires a canonical GitHub item",
            false,
        ));
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> loopx_contract::LoopxCliResult<()> {
    validate_nonempty("operation_id", operation_id, operation_id)
}

fn validate_nonempty(
    field: &str,
    value: &str,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<()> {
    if value.trim().is_empty() {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::InvalidInput,
            operation_id,
            format!("{field} is required"),
            false,
        ));
    }
    Ok(())
}

fn effective_deadline(
    deadline_at: Option<i64>,
    configured: Duration,
    operation_id: &str,
) -> loopx_contract::LoopxCliResult<Duration> {
    let Some(deadline_at) = deadline_at else {
        return Ok(configured);
    };
    let remaining_ms = deadline_at.saturating_sub(now_unix_ms());
    if remaining_ms <= 0 {
        return Err(port_error(
            loopx_contract::LoopxCliErrorKind::Timeout,
            operation_id,
            "LoopX operation deadline has already expired",
            true,
        ));
    }
    Ok(configured.min(Duration::from_millis(
        remaining_ms.try_into().unwrap_or(u64::MAX),
    )))
}

fn map_port_error(
    error: LoopxCliAdapterError,
    operation_id: &str,
) -> loopx_contract::LoopxCliError {
    let (kind, retryable) = match &error {
        LoopxCliAdapterError::Unavailable => (loopx_contract::LoopxCliErrorKind::NotFound, true),
        LoopxCliAdapterError::Manifest { .. } => (loopx_contract::LoopxCliErrorKind::Io, false),
        LoopxCliAdapterError::VersionMismatch { .. } => {
            (loopx_contract::LoopxCliErrorKind::VersionMismatch, false)
        }
        LoopxCliAdapterError::SchemaMismatch { .. } => {
            (loopx_contract::LoopxCliErrorKind::SchemaMismatch, false)
        }
        LoopxCliAdapterError::Conflict { .. } => {
            (loopx_contract::LoopxCliErrorKind::Conflict, true)
        }
        LoopxCliAdapterError::InvalidJson { .. } => {
            (loopx_contract::LoopxCliErrorKind::Backend, false)
        }
        LoopxCliAdapterError::Process(LoopxProcessError::Timeout { .. }) => {
            (loopx_contract::LoopxCliErrorKind::Timeout, true)
        }
        LoopxCliAdapterError::Process(LoopxProcessError::Cancelled { .. }) => {
            (loopx_contract::LoopxCliErrorKind::Cancelled, true)
        }
        LoopxCliAdapterError::Process(LoopxProcessError::Io { .. }) => {
            (loopx_contract::LoopxCliErrorKind::Io, true)
        }
        LoopxCliAdapterError::Process(_) => (loopx_contract::LoopxCliErrorKind::Process, true),
    };
    let message = match &error {
        LoopxCliAdapterError::Process(LoopxProcessError::Exited {
            code,
            stdout_tail,
            stderr_tail,
            ..
        }) if !stderr_tail.is_empty() || !stdout_tail.is_empty() => {
            let details = if stderr_tail.is_empty() {
                stdout_tail
            } else {
                stderr_tail
            };
            format!(
                "LoopX process exited with status {code:?}: {}",
                process_error_detail(details)
            )
        }
        _ => error.to_string(),
    };
    port_error(kind, operation_id, message, retryable)
}

fn port_error(
    kind: loopx_contract::LoopxCliErrorKind,
    operation_id: &str,
    message: impl Into<String>,
    retryable: bool,
) -> loopx_contract::LoopxCliError {
    loopx_contract::LoopxCliError::new(kind, message)
        .for_operation(operation_id)
        .retryable(retryable)
}

fn report_port_progress(
    progress: &dyn loopx_contract::LoopxCliProgressSink,
    operation_id: &str,
    task_id: Option<String>,
    stage: loopx_contract::LoopxCliProgressStage,
    message: &str,
) {
    progress.report(loopx_contract::LoopxCliProgress {
        operation_id: operation_id.to_string(),
        task_id,
        stage,
        message: message.to_string(),
        occurred_at: now_unix_ms(),
    });
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn truncate_message(message: &str) -> String {
    message.chars().take(500).collect()
}

fn python_version_supported(output: &str) -> bool {
    let Some(version) = output.split_whitespace().find(|part| {
        part.chars()
            .next()
            .map(|character| character.is_ascii_digit())
            .unwrap_or(false)
    }) else {
        return false;
    };
    let mut components = version.split('.');
    let major = components
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    let minor = components
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    matches!((major, minor), (Some(major), Some(minor)) if major > 3 || (major == 3 && minor >= 11))
}

fn output_tail(bytes: &[u8]) -> Vec<String> {
    let lines = decode_loopx_output(bytes)
        .lines()
        .rev()
        .take(20)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.into_iter().rev().collect()
}

fn process_error_detail(lines: &[String]) -> String {
    let detail = lines
        .iter()
        .rev()
        .find(|line| line.contains("\"error\""))
        .cloned()
        .unwrap_or_else(|| lines.join(" | "));
    truncate_message(&detail)
}

fn is_public_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

#[derive(Debug)]
struct LoopxCandidate {
    executable: PathBuf,
    prefix_args: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    managed_source_dir: Option<PathBuf>,
    source: LoopxCommandSource,
    bundle_manifest_schema: Option<u32>,
    sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManagedLoopxSourceManifest {
    schema_version: u32,
    source_repository: String,
    source_tag: String,
    source_commit: String,
    loopx_version: String,
}

fn verify_managed_source_manifest(
    manifest: &ManagedLoopxSourceManifest,
) -> Result<(), LoopxCliAdapterError> {
    if manifest.schema_version != MANAGED_SOURCE_MANIFEST_SCHEMA
        || manifest.source_repository != LOOPX_SOURCE_REPOSITORY
        || manifest.source_tag != LOOPX_PINNED_VERSION_TAG
        || manifest.source_commit != LOOPX_PINNED_SOURCE_COMMIT
        || manifest.loopx_version != LOOPX_PINNED_VERSION
    {
        return Err(LoopxCliAdapterError::Manifest {
            message: "managed LoopX source manifest does not match the pinned release".to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BundledLoopxManifest {
    schema_version: u32,
    name: String,
    version: String,
    sha256: String,
}

fn verify_manifest(manifest: &BundledLoopxManifest) -> Result<(), LoopxCliAdapterError> {
    if manifest.schema_version != LOOPX_BUNDLE_MANIFEST_SCHEMA {
        return Err(LoopxCliAdapterError::SchemaMismatch {
            expected: LOOPX_BUNDLE_MANIFEST_SCHEMA.to_string(),
            actual: manifest.schema_version.to_string(),
        });
    }
    if manifest.name != "loopx" {
        return Err(LoopxCliAdapterError::Manifest {
            message: format!("expected bundle name loopx, got {}", manifest.name),
        });
    }
    if manifest.version != LOOPX_PINNED_VERSION_TAG {
        return Err(LoopxCliAdapterError::VersionMismatch {
            expected: LOOPX_PINNED_VERSION_TAG.to_string(),
            actual: manifest.version.clone(),
        });
    }
    let digest = manifest.sha256.strip_prefix("sha256:").unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(LoopxCliAdapterError::Manifest {
            message: "manifest sha256 must contain a 64-digit sha256 digest".to_string(),
        });
    }
    Ok(())
}

async fn sha256_file(path: &Path) -> Result<String, LoopxCliAdapterError> {
    let mut file =
        tokio::fs::File::open(path)
            .await
            .map_err(|error| LoopxCliAdapterError::Manifest {
                message: error.to_string(),
            })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read =
            file.read(&mut buffer)
                .await
                .map_err(|error| LoopxCliAdapterError::Manifest {
                    message: error.to_string(),
                })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

struct OperationRegistration {
    operation_id: String,
    running: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl Drop for OperationRegistration {
    fn drop(&mut self) {
        self.running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&self.operation_id);
    }
}

struct StdoutCapture {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

async fn capture_stdout(mut reader: impl AsyncRead + Unpin) -> StdoutCapture {
    let mut bytes = Vec::new();
    let mut exceeded_limit = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = MAX_STDOUT_BYTES.saturating_sub(bytes.len());
        if read > remaining {
            bytes.extend_from_slice(&buffer[..remaining]);
            exceeded_limit = true;
        } else {
            bytes.extend_from_slice(&buffer[..read]);
        }
    }
    StdoutCapture {
        bytes,
        exceeded_limit,
    }
}

async fn capture_stderr(
    mut reader: impl AsyncRead + Unpin,
    line_sender: mpsc::Sender<String>,
) -> Vec<String> {
    let mut pending = Vec::new();
    let mut tail = VecDeque::new();
    let mut tail_bytes = 0_usize;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        pending.extend_from_slice(&buffer[..read]);
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=newline).collect::<Vec<_>>();
            record_stderr_line(&line, &line_sender, &mut tail, &mut tail_bytes);
        }
        if pending.len() > MAX_PROGRESS_LINE_BYTES * 2 {
            let line = pending.drain(..MAX_PROGRESS_LINE_BYTES).collect::<Vec<_>>();
            record_stderr_line(&line, &line_sender, &mut tail, &mut tail_bytes);
        }
    }
    if !pending.is_empty() {
        record_stderr_line(&pending, &line_sender, &mut tail, &mut tail_bytes);
    }
    tail.into_iter().collect()
}

fn record_stderr_line(
    raw: &[u8],
    line_sender: &mpsc::Sender<String>,
    tail: &mut VecDeque<String>,
    tail_bytes: &mut usize,
) {
    let raw = raw
        .strip_suffix(b"\n")
        .unwrap_or(raw)
        .strip_suffix(b"\r")
        .unwrap_or(raw);
    if raw.is_empty() {
        return;
    }
    let line = decode_loopx_output(&raw[..raw.len().min(MAX_PROGRESS_LINE_BYTES)]);
    let _ = line_sender.try_send(line.clone());
    *tail_bytes += line.len();
    tail.push_back(line);
    while *tail_bytes > MAX_STDERR_TAIL_BYTES {
        if let Some(removed) = tail.pop_front() {
            *tail_bytes = tail_bytes.saturating_sub(removed.len());
        } else {
            break;
        }
    }
}

async fn drain_stdout_task(
    task: &mut tokio::task::JoinHandle<StdoutCapture>,
) -> Result<StdoutCapture, LoopxProcessError> {
    match tokio::time::timeout(PIPE_DRAIN_DEADLINE, &mut *task).await {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(error)) => Err(LoopxProcessError::Io {
            message: error.to_string(),
        }),
        Err(_) => {
            task.abort();
            Err(LoopxProcessError::Io {
                message: "LoopX stdout pipe stayed open after process exit".to_string(),
            })
        }
    }
}

async fn drain_stderr_task(task: &mut tokio::task::JoinHandle<Vec<String>>) -> Vec<String> {
    match tokio::time::timeout(PIPE_DRAIN_DEADLINE, &mut *task).await {
        Ok(Ok(tail)) => tail,
        Ok(Err(_)) => Vec::new(),
        Err(_) => {
            task.abort();
            Vec::new()
        }
    }
}

fn emit_progress(
    observer: &dyn LoopxProcessObserver,
    operation_id: &str,
    stage: LoopxProgressStage,
    message: &str,
) {
    observer.on_progress(LoopxProcessProgress {
        operation_id: operation_id.to_string(),
        stage,
        message: message.to_string(),
        occurred_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    });
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}
