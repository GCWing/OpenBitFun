//! Supervised script runtime for PTC programs on local or remote workspaces.
//!
//! The child process is a failure-containment boundary, not a security
//! sandbox. Both backends expose the same `tools` protocol; host-side policy
//! owns nested tool admission, not direct language filesystem/network access.

#[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
use crate::remote_ssh::{shell_quote_posix, SSHCommandOptions, SSHConnectionManager};
use async_trait::async_trait;
use openbitfun_runtime_ports::{
    PortError, PortErrorKind, PortResult, PtcExecutionRequest, PtcExecutionResponse,
    PtcNestedToolCall, PtcRuntime, PtcRuntimeAvailability, PtcToolCallHandler, PtcToolSpecRequest,
    RuntimeServiceCapability,
};
use openbitfun_services_core::process_tree::ProcessTreeChild;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{timeout, Duration};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const CANCEL_GRACE: Duration = Duration::from_millis(500);
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;

#[path = "ptc_node.rs"]
mod node;

/// Script backend selection; omitted RunCode language remains TypeScript.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PtcScriptLanguage {
    #[default]
    TypeScript,
    Python,
}

impl PtcScriptLanguage {
    fn candidates(self) -> &'static [&'static str] {
        match self {
            Self::TypeScript => &["node"],
            Self::Python => &["python3", "python"],
        }
    }

    fn arguments(self) -> Vec<&'static str> {
        match self {
            Self::TypeScript => vec!["--input-type=module", "--eval", node::BOOTSTRAP],
            Self::Python => vec!["-I", "-u", "-c", include_str!("ptc_python.py")],
        }
    }

    fn supports_version(self, version: &str) -> bool {
        match self {
            Self::TypeScript => supports_type_stripping(version),
            Self::Python => version.strip_prefix("Python ").is_some_and(|version| {
                let mut parts = version
                    .split('.')
                    .filter_map(|part| part.parse::<u64>().ok());
                matches!((parts.next(), parts.next()), (Some(3), Some(minor)) if minor >= 8)
            }),
        }
    }

    fn requirement(self) -> &'static str {
        match self {
            Self::TypeScript => "Node.js 22.6 or newer with stripTypeScriptTypes",
            Self::Python => "Python 3.8 or newer",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    kind: String,
    token: String,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: Option<PtcExecutionResponse>,
    #[serde(default)]
    error_kind: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default = "default_true")]
    enforce_binding: bool,
}

fn default_true() -> bool {
    true
}

type PtcReader = Pin<Box<dyn AsyncRead + Send>>;
type PtcWriter = Pin<Box<dyn AsyncWrite + Send>>;

enum PtcProcessControl {
    Local(Mutex<ProcessTreeChild>),
    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    Remote(crate::remote_ssh::WorkspaceProcessControl),
}

struct PtcProcess {
    stdin: Mutex<PtcWriter>,
    control: PtcProcessControl,
}

impl PtcProcess {
    async fn terminate(&self) {
        match &self.control {
            PtcProcessControl::Local(child) => {
                let _ = child.lock().await.terminate(CANCEL_GRACE).await;
            }
            #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
            PtcProcessControl::Remote(control) => {
                let _ = control.kill().await;
            }
        }
    }

    async fn send(&self, value: Value) -> PortResult<()> {
        let encoded = serde_json::to_vec(&value).map_err(|error| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                format!("invalid PTC frame: {error}"),
            )
        })?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "PTC control frame exceeds the protocol limit",
            ));
        }
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&encoded).await.map_err(|error| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("PTC stdin failed: {error}"),
            )
        })?;
        stdin.write_all(b"\n").await.map_err(|error| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("PTC stdin failed: {error}"),
            )
        })?;
        stdin.flush().await.map_err(|error| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("PTC stdin failed: {error}"),
            )
        })
    }
}

/// Shared framing, process supervision and nested tool dispatch for all backends.
pub struct ScriptPtcRuntime {
    language: PtcScriptLanguage,
    executable: RwLock<Option<PathBuf>>,
    operations: Mutex<HashMap<String, Arc<PtcProcess>>>,
    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    remote_target: Option<RemotePtcTarget>,
}

#[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
#[derive(Clone)]
struct RemotePtcTarget {
    ssh_manager: SSHConnectionManager,
    connection_id: String,
}

/// Compatibility name for existing Node-only callers.
pub type NodePtcRuntime = ScriptPtcRuntime;

impl Default for ScriptPtcRuntime {
    fn default() -> Self {
        Self::discover()
    }
}

impl ScriptPtcRuntime {
    pub fn discover() -> Self {
        Self {
            language: PtcScriptLanguage::TypeScript,
            executable: RwLock::new(None),
            operations: Mutex::new(HashMap::new()),
            #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
            remote_target: None,
        }
    }

    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    pub fn for_remote(ssh_manager: SSHConnectionManager, connection_id: impl Into<String>) -> Self {
        Self {
            language: PtcScriptLanguage::TypeScript,
            executable: RwLock::new(None),
            operations: Mutex::new(HashMap::new()),
            remote_target: Some(RemotePtcTarget {
                ssh_manager,
                connection_id: connection_id.into(),
            }),
        }
    }

    pub fn with_language(mut self, language: PtcScriptLanguage) -> Self {
        self.language = language;
        self.executable = RwLock::new(None);
        self
    }

    async fn executable(&self) -> Option<PathBuf> {
        if let Some(path) = self.executable.read().await.clone() {
            return Some(path);
        }
        let mut selected = None;
        for candidate in self.language.candidates() {
            if let Ok(path) = which::which(candidate) {
                if let Ok(version) = runtime_executable_version(&path).await {
                    if self.language.supports_version(&version) {
                        selected = Some(path);
                        break;
                    }
                }
            }
        }
        let path = selected?;
        *self.executable.write().await = Some(path.clone());
        Some(path)
    }

    async fn spawn_local(
        &self,
        executable: &PathBuf,
        cwd: &str,
    ) -> PortResult<(Arc<PtcProcess>, BufReader<PtcReader>)> {
        let mut command =
            openbitfun_services_core::process_manager::create_tokio_command(executable);
        command
            .args(self.language.arguments())
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        let mut child = ProcessTreeChild::spawn(&mut command)
            .await
            .map_err(|error| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    format!("failed to start {:?} PTC runtime: {error}", self.language),
                )
            })?;
        let stdin = child
            .take_stdin()
            .ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC stdin unavailable"))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC stdout unavailable"))?;
        if let Some(mut stderr) = child.take_stderr() {
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
        }
        let process = Arc::new(PtcProcess {
            stdin: Mutex::new(Box::pin(stdin)),
            control: PtcProcessControl::Local(Mutex::new(child)),
        });
        Ok((process, BufReader::new(Box::pin(stdout))))
    }

    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    async fn spawn_remote(
        &self,
        target: &RemotePtcTarget,
        cwd: &str,
    ) -> PortResult<(Arc<PtcProcess>, BufReader<PtcReader>)> {
        let (executable, _) = self
            .remote_runtime_version(target)
            .await
            .map_err(|reason| PortError::new(PortErrorKind::NotAvailable, reason))?;
        let arguments = self
            .language
            .arguments()
            .iter()
            .map(|arg| shell_quote_posix(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "unset NODE_OPTIONS NODE_PATH; cd -- {} && exec {} {}",
            shell_quote_posix(cwd),
            shell_quote_posix(&executable),
            arguments,
        );
        let transport = target
            .ssh_manager
            .open_workspace_stdio(&target.connection_id, &command)
            .await
            .map_err(|error| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    format!(
                        "failed to start remote {:?} PTC runtime: {error}",
                        self.language
                    ),
                )
            })?;
        let (stdin, stdout, mut stderr, control, completion) = transport.into_parts();
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            let _ = completion.wait().await;
        });
        let process = Arc::new(PtcProcess {
            stdin: Mutex::new(stdin),
            control: PtcProcessControl::Remote(control),
        });
        Ok((process, BufReader::new(stdout)))
    }

    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    async fn remote_runtime_version(
        &self,
        target: &RemotePtcTarget,
    ) -> Result<(String, String), String> {
        for executable in self.language.candidates() {
            let result = target
                .ssh_manager
                .execute_command_with_options(
                    &target.connection_id,
                    &format!("{} --version", shell_quote_posix(executable)),
                    SSHCommandOptions {
                        timeout_ms: Some(10_000),
                        cancellation_token: None,
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
            let version = result.stdout.trim().to_string();
            if result.exit_code == 0 && self.language.supports_version(&version) {
                return Ok((executable.to_string(), version));
            }
        }
        Err(format!(
            "remote PTC runtime requires {}; no local fallback is allowed",
            self.language.requirement()
        ))
    }

    async fn runtime_version(&self) -> PortResult<(Option<PathBuf>, String)> {
        #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
        if let Some(target) = &self.remote_target {
            let (_, version) = self
                .remote_runtime_version(target)
                .await
                .map_err(|reason| PortError::new(PortErrorKind::NotAvailable, reason))?;
            return Ok((None, version));
        }
        let executable = self.executable().await.ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("PTC runtime requires {}", self.language.requirement()),
            )
        })?;
        let version = runtime_executable_version(&executable)
            .await
            .map_err(|reason| PortError::new(PortErrorKind::NotAvailable, reason))?;
        Ok((Some(executable), version))
    }

    async fn spawn_process(
        &self,
        executable: Option<&PathBuf>,
        cwd: &str,
    ) -> PortResult<(Arc<PtcProcess>, BufReader<PtcReader>)> {
        #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
        if let Some(target) = &self.remote_target {
            return self.spawn_remote(target, cwd).await;
        }

        self.spawn_local(
            executable.expect("local PTC runtime should have an executable"),
            cwd,
        )
        .await
    }

    async fn execute_inner(
        &self,
        request: PtcExecutionRequest,
        handler: Arc<dyn PtcToolCallHandler>,
    ) -> PortResult<PtcExecutionResponse> {
        if request.operation_id.trim().is_empty() || request.source.trim().is_empty() {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "PTC execution request is incomplete",
            ));
        }
        let (executable, version) = self.runtime_version().await?;
        if !self.language.supports_version(&version) {
            return Err(PortError::new(
                PortErrorKind::NotAvailable,
                format!(
                    "PTC runtime {version} requires {}",
                    self.language.requirement()
                ),
            ));
        }
        let (process, mut reader) = self
            .spawn_process(executable.as_ref(), &request.working_directory)
            .await?;
        self.operations
            .lock()
            .await
            .insert(request.operation_id.clone(), process.clone());
        let mut nested_calls = tokio::task::JoinSet::new();
        let result = async {
            let ready = timeout(STARTUP_TIMEOUT, read_frame(&mut reader))
                .await
                .map_err(|_| PortError::new(PortErrorKind::Timeout, "PTC runtime startup timed out"))??;
            if ready.kind != "ready" || ready.token.len() < 16 || ready.token.len() > 128 {
                return Err(PortError::new(PortErrorKind::Backend, "invalid PTC startup frame"));
            }
            let id = 1_u64;
            process.send(serde_json::json!({
                "type": "execute", "id": id, "source": request.source,
                "bindings": request.bindings, "maxOutputBytes": request.max_output_bytes,
            })).await?;
            let allowed = request.bindings.iter().map(|binding| binding.name.clone()).collect::<HashSet<_>>();
            loop {
                while nested_calls.try_join_next().is_some() {}
                let frame = read_frame(&mut reader).await?;
                if frame.token != ready.token { continue; }
                if frame.kind == "tool_call" {
                    let operation_id = frame.operation_id.ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC tool call has no operation id"))?;
                    let tool_name = frame.tool_name.ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC tool call has no tool name"))?;
                    if frame.enforce_binding && !allowed.contains(&tool_name) {
                        process.send(serde_json::json!({"type":"tool_result","operationId":operation_id,"ok":false,"error":"tool is not in the PTC snapshot"})).await?;
                        continue;
                    }
                    let child_process = process.clone();
                    let handler = handler.clone();
                    nested_calls.spawn(async move {
                        let result = handler.call(PtcNestedToolCall { operation_id: operation_id.clone(), tool_name, arguments: frame.arguments }).await;
                        let payload = match result {
                            Ok(value) => serde_json::json!({"type":"tool_result","operationId":operation_id,"ok":true,"value":value}),
                            Err(error) => serde_json::json!({"type":"tool_result","operationId":operation_id,"ok":false,"error":error.message,"errorKind":error.kind}),
                        };
                        let _ = child_process.send(payload).await;
                    });
                    continue;
                }
                if frame.kind == "get_tool_spec" {
                    let operation_id = frame.operation_id.ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC tool spec request has no operation id"))?;
                    let tool_name = frame.tool_name.ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC tool spec request has no tool name"))?;
                    let child_process = process.clone();
                    let handler = handler.clone();
                    nested_calls.spawn(async move {
                        let result = handler
                            .get_tool_spec(PtcToolSpecRequest { operation_id: operation_id.clone(), tool_name })
                            .await;
                        let payload = match result {
                            Ok(value) => serde_json::json!({"type":"tool_result","operationId":operation_id,"ok":true,"value":value}),
                            Err(error) => serde_json::json!({"type":"tool_result","operationId":operation_id,"ok":false,"error":error.message,"errorKind":error.kind}),
                        };
                        let _ = child_process.send(payload).await;
                    });
                    continue;
                }
                if frame.kind == "complete" && frame.id == Some(id) {
                    if frame.ok {
                        return frame.result.ok_or_else(|| PortError::new(PortErrorKind::Backend, "PTC completion has no result"));
                    }
                    let kind = match frame.error_kind.as_deref() {
                        Some("output_limit") => PortErrorKind::InvalidRequest,
                        Some("abort") => PortErrorKind::Cancelled,
                        _ => PortErrorKind::Backend,
                    };
                    return Err(PortError::new(kind, frame.error.unwrap_or_else(|| "PTC program failed".to_string())));
                }
            }
        }.await;
        nested_calls.abort_all();
        self.operations.lock().await.remove(&request.operation_id);
        process.terminate().await;
        result
    }
}

async fn read_frame<R>(reader: &mut BufReader<R>) -> PortResult<Frame>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| PortError::new(PortErrorKind::NotAvailable, error.to_string()))?;
        if available.is_empty() {
            return Err(PortError::new(
                PortErrorKind::NotAvailable,
                "PTC runtime exited",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        if bytes.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "PTC frame exceeds the protocol limit",
            ));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        PortError::new(
            PortErrorKind::Backend,
            format!("invalid PTC frame: {error}"),
        )
    })
}

async fn runtime_executable_version(executable: &PathBuf) -> Result<String, String> {
    let mut command = openbitfun_services_core::process_manager::create_tokio_command(executable);
    command.arg("--version").kill_on_drop(true);
    let output = timeout(STARTUP_TIMEOUT, command.output())
        .await
        .map_err(|_| "PTC runtime version probe timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("PTC runtime version probe failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn supports_type_stripping(version: &str) -> bool {
    let version = version.trim().trim_start_matches('v');
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok());
    let Some(major) = parts.next() else {
        return false;
    };
    let minor = parts.next().unwrap_or(0);
    major > 22 || (major == 22 && minor >= 6)
}

#[async_trait]
impl PtcRuntime for ScriptPtcRuntime {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::PtcRuntime
    }

    async fn availability(&self) -> PtcRuntimeAvailability {
        match self.runtime_version().await {
            Ok((executable, version)) if self.language.supports_version(&version) => {
                PtcRuntimeAvailability::Available {
                    executable: executable
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| format!("{:?} (remote workspace)", self.language)),
                    version,
                }
            }
            Ok((_, version)) => PtcRuntimeAvailability::Unavailable {
                reason: format!(
                    "PTC runtime {version} requires {}",
                    self.language.requirement()
                ),
            },
            Err(error) => PtcRuntimeAvailability::Unavailable {
                reason: error.message,
            },
        }
    }

    async fn execute(
        &self,
        request: PtcExecutionRequest,
        handler: Arc<dyn PtcToolCallHandler>,
    ) -> PortResult<PtcExecutionResponse> {
        let deadline = Duration::from_millis(
            request
                .timeout_ms
                .unwrap_or(DEFAULT_TIMEOUT.as_millis() as u64)
                .max(1),
        );
        match timeout(deadline, self.execute_inner(request.clone(), handler)).await {
            Ok(result) => result,
            Err(_) => {
                let _ = self.cancel(&request.operation_id).await;
                Err(PortError::new(
                    PortErrorKind::Timeout,
                    "PTC program timed out",
                ))
            }
        }
    }

    async fn cancel(&self, operation_id: &str) -> PortResult<()> {
        let process = self
            .operations
            .lock()
            .await
            .remove(operation_id)
            .ok_or_else(|| {
                PortError::new(PortErrorKind::NotFound, "PTC operation is not running")
            })?;
        process.terminate().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{supports_type_stripping, PtcScriptLanguage, ScriptPtcRuntime};
    use async_trait::async_trait;
    use openbitfun_runtime_ports::{
        PtcExecutionRequest, PtcNestedToolCall, PtcRuntime, PtcToolBinding, PtcToolCallHandler,
        PtcToolSpecRequest,
    };
    use serde_json::{json, Value};
    use std::sync::Arc;

    #[test]
    fn type_stripping_requires_node_22_6_or_newer() {
        assert!(!supports_type_stripping("v22.5.1"));
        assert!(supports_type_stripping("v22.6.0"));
        assert!(supports_type_stripping("v23.0.0"));
        assert!(!supports_type_stripping("not-a-version"));
    }

    struct Handler;
    #[async_trait]
    impl PtcToolCallHandler for Handler {
        async fn call(
            &self,
            request: PtcNestedToolCall,
        ) -> openbitfun_runtime_ports::PortResult<Value> {
            Ok(json!({"tool": request.tool_name, "arguments": request.arguments}))
        }

        async fn get_tool_spec(
            &self,
            request: PtcToolSpecRequest,
        ) -> openbitfun_runtime_ports::PortResult<Value> {
            Ok(json!({
                "tool_name": request.tool_name,
                "catalog_generation": 7,
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            }))
        }
    }

    #[tokio::test]
    async fn executes_program_and_dispatches_nested_tool_call_when_node_is_available() {
        let runtime = ScriptPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-test".to_string(),
            source: "const result = await tools.Read({ path: 'src/lib.rs' }); return result;"
                .to_string(),
            bindings: vec![PtcToolBinding {
                name: "Read".to_string(),
            }],
            working_directory: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            session_id: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(1024 * 1024),
        };
        let response = runtime.execute(request, Arc::new(Handler)).await.unwrap();
        assert_eq!(response.value["tool"], "Read");
    }

    #[tokio::test]
    async fn exposes_ptc_spec_loading_and_generic_call_api() {
        let runtime = ScriptPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-spec-test".to_string(),
            source: "const spec = await tools.getToolSpec('Deferred'); const result = await tools.callTool('Deferred', { value: 1 }); return { spec, result };".to_string(),
            bindings: Vec::new(),
            working_directory: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            session_id: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(1024 * 1024),
        };
        let response = runtime.execute(request, Arc::new(Handler)).await.unwrap();
        assert_eq!(response.value["spec"]["tool_name"], "Deferred");
        assert_eq!(response.value["result"]["tool"], "Deferred");
    }

    #[tokio::test]
    async fn timeout_terminates_a_long_running_program() {
        let runtime = ScriptPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-timeout-test".to_string(),
            source: "await new Promise((resolve) => setTimeout(resolve, 5000)); return 1;"
                .to_string(),
            bindings: Vec::new(),
            working_directory: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            session_id: None,
            timeout_ms: Some(100),
            max_output_bytes: Some(1024 * 1024),
        };
        let error = runtime
            .execute(request, Arc::new(Handler))
            .await
            .expect_err("long-running PTC program should time out");
        assert_eq!(error.kind, openbitfun_runtime_ports::PortErrorKind::Timeout);
    }

    fn python_request(source: &str) -> PtcExecutionRequest {
        PtcExecutionRequest {
            operation_id: "python-test".to_string(),
            source: source.to_string(),
            bindings: vec![PtcToolBinding {
                name: "Read".to_string(),
            }],
            working_directory: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            session_id: None,
            timeout_ms: Some(30_000),
            max_output_bytes: Some(1024 * 1024),
        }
    }

    async fn python_runtime() -> Option<ScriptPtcRuntime> {
        let runtime = ScriptPtcRuntime::discover().with_language(PtcScriptLanguage::Python);
        if let openbitfun_runtime_ports::PtcRuntimeAvailability::Unavailable { reason } =
            runtime.availability().await
        {
            eprintln!("Skipping Python PTC test: {reason}");
            return None;
        }
        Some(runtime)
    }

    #[test]
    fn python_version_requirement_is_independent_of_node() {
        assert!(PtcScriptLanguage::Python.supports_version("Python 3.8.0"));
        assert!(PtcScriptLanguage::Python.supports_version("Python 3.13.1"));
        assert!(!PtcScriptLanguage::Python.supports_version("Python 3.7.9"));
        assert!(!PtcScriptLanguage::Python.supports_version("v24.0.0"));
        assert!(!PtcScriptLanguage::Python.supports_version("garbage"));
    }

    #[tokio::test]
    async fn python_dispatches_concurrent_calls_and_captures_unicode_logs() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let response = runtime.execute(python_request(
            "import asyncio\nprint('hello \\u4e16\\u754c')\nresults = await asyncio.gather(tools.Read({'path': 'a.py'}), tools['Read']({'path': 'b.py'}))\nreturn results"
        ), Arc::new(Handler)).await.unwrap();
        assert_eq!(response.value[0]["arguments"]["path"], "a.py");
        assert_eq!(response.value[1]["arguments"]["path"], "b.py");
        assert_eq!(response.logs, vec!["hello \u{4e16}\u{754c}"]);
    }

    #[tokio::test]
    async fn python_loads_deferred_specs_and_calls_by_name() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let response = runtime.execute(python_request(
            "spec = await tools.getToolSpec('Deferred')\nresult = await tools.callTool('Deferred', {'value': 1})\nreturn {'spec': spec, 'result': result}"
        ), Arc::new(Handler)).await.unwrap();
        assert_eq!(response.value["spec"]["tool_name"], "Deferred");
        assert_eq!(response.value["result"]["arguments"]["value"], 1);
    }

    #[tokio::test]
    async fn python_reports_exceptions_and_rejects_unbound_tools() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        for source in [
            "raise ValueError('failure')",
            "return await tools.Unbound({})",
            "return await tools.Read([])",
            "return float('nan')",
            "return (",
        ] {
            let error = runtime
                .execute(python_request(source), Arc::new(Handler))
                .await
                .unwrap_err();
            assert_eq!(
                error.kind,
                openbitfun_runtime_ports::PortErrorKind::Backend,
                "{source}"
            );
        }
    }

    #[tokio::test]
    async fn python_enforces_result_and_log_limits() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        for source in ["return 'x' * 1000", "print('x' * 1000)\nreturn None"] {
            let mut request = python_request(source);
            request.max_output_bytes = Some(100);
            let error = runtime
                .execute(request, Arc::new(Handler))
                .await
                .unwrap_err();
            assert_eq!(
                error.kind,
                openbitfun_runtime_ports::PortErrorKind::InvalidRequest
            );
        }
    }

    #[tokio::test]
    async fn python_timeout_terminates_cpu_bound_program() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let mut request = python_request("while True:\n    pass");
        request.timeout_ms = Some(500);
        let error = runtime
            .execute(request, Arc::new(Handler))
            .await
            .unwrap_err();
        assert_eq!(error.kind, openbitfun_runtime_ports::PortErrorKind::Timeout);
        assert!(runtime.operations.lock().await.is_empty());
    }

    #[tokio::test]
    async fn python_cancellation_terminates_running_program() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let request = python_request("import asyncio\nawait asyncio.sleep(60)");
        let operation_id = request.operation_id.clone();
        let runtime = Arc::new(runtime);
        let execution = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.execute(request, Arc::new(Handler)).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while runtime.operations.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.cancel(&operation_id).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), execution)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(runtime.operations.lock().await.is_empty());
    }

    #[tokio::test]
    async fn python_protocol_uses_utf8_for_source_and_nested_results() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let response = runtime
            .execute(
                python_request("return await tools.Read({'path': '\u{4e16}\u{754c}.py'})"),
                Arc::new(Handler),
            )
            .await
            .unwrap();
        assert_eq!(response.value["arguments"]["path"], "\u{4e16}\u{754c}.py");
    }

    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    #[tokio::test]
    async fn remote_python_never_falls_back_to_local_runtime() {
        let data = tempfile::tempdir().unwrap();
        let manager = crate::remote_ssh::SSHConnectionManager::new(data.path().to_path_buf());
        let runtime = ScriptPtcRuntime::for_remote(manager, "offline-test")
            .with_language(PtcScriptLanguage::Python);
        assert!(matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Unavailable { .. }
        ));
        let mut request = python_request("return 'must not run locally'");
        request.working_directory = "/remote workspace".to_string();
        let error = runtime
            .execute(request, Arc::new(Handler))
            .await
            .unwrap_err();
        assert_eq!(
            error.kind,
            openbitfun_runtime_ports::PortErrorKind::NotAvailable
        );
        assert!(runtime.executable.read().await.is_none());
        assert!(runtime.operations.lock().await.is_empty());
    }

    struct DeniedHandler;

    #[async_trait]
    impl PtcToolCallHandler for DeniedHandler {
        async fn call(
            &self,
            _request: PtcNestedToolCall,
        ) -> openbitfun_runtime_ports::PortResult<Value> {
            Err(openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::PermissionDenied,
                "permission denied by host",
            ))
        }
    }

    #[tokio::test]
    async fn python_propagates_nested_permission_denial() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let response = runtime.execute(python_request(
            "try:\n    await tools.Read({})\nexcept RuntimeError as error:\n    return str(error)"
        ), Arc::new(DeniedHandler)).await.unwrap();
        assert_eq!(response.value, "permission denied by host");
    }

    struct PendingHandler {
        started: tokio::sync::Notify,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    struct PendingCallGuard(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for PendingCallGuard {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl PtcToolCallHandler for PendingHandler {
        async fn call(
            &self,
            request: PtcNestedToolCall,
        ) -> openbitfun_runtime_ports::PortResult<Value> {
            if request.tool_name == "Wait" {
                let _guard = PendingCallGuard(self.dropped.clone());
                self.started.notify_one();
                std::future::pending().await
            } else {
                self.started.notified().await;
                Ok(Value::Null)
            }
        }
    }

    #[tokio::test]
    async fn python_completion_cancels_pending_nested_calls() {
        let Some(runtime) = python_runtime().await else {
            return;
        };
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler = Arc::new(PendingHandler {
            started: tokio::sync::Notify::new(),
            dropped: dropped.clone(),
        });
        runtime.execute(python_request(
            "import asyncio\nasyncio.create_task(tools.callTool('Wait', {}))\nawait tools.Read({})\nreturn None"
        ), handler).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !dropped.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("nested handler future should be dropped when the program ends");
    }
}
