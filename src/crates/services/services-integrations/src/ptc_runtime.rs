//! Node runtime for PTC programs on local or remote workspaces.
//!
//! The child process is a failure-containment boundary, not a security
//! sandbox.  The bootstrap exposes only the `tools` binding and a small set of
//! language primitives; host-side policy still owns nested tool admission.

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

const BOOTSTRAP: &str = r#"
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const stringify = JSON.stringify.bind(JSON);
const parse = JSON.parse.bind(JSON);
const writeRaw = process.stdout.write.bind(process.stdout);
const token = randomUUID();
const pending = new Map();
let maxOutputBytes = 8 * 1024 * 1024;
let logs = [];

function write(value) { writeRaw(`${stringify(value)}\n`); }
function log(...values) {
  logs.push(values.map((value) => typeof value === 'string' ? value : stringify(value)).join(' '));
}
function failure(message, code = 'exception') {
  const error = new Error(message);
  error.ptcCode = code;
  throw error;
}
function jsonValue(value) {
  if (value === undefined) return null;
  const encoded = stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxOutputBytes) failure('PTC result exceeds output limit', 'output_limit');
  return parse(encoded);
}
function callTool(name, argumentsValue, allowed, enforceBinding = true) {
  if (enforceBinding && !allowed.has(name)) return Promise.reject(new Error(`tool '${name}' is not available in this PTC snapshot`));
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return Promise.reject(new Error(`arguments for '${name}' must be an object`));
  }
  const operationId = randomUUID();
  write({ kind: 'tool_call', token, operationId, toolName: name, arguments: argumentsValue, enforceBinding });
  return new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
}

function getToolSpec(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return Promise.reject(new Error('getToolSpec requires a non-empty tool name'));
  }
  const operationId = randomUUID();
  write({ kind: 'get_tool_spec', token, operationId, toolName: name });
  return new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
}

async function execute(message) {
  maxOutputBytes = Number.isInteger(message.maxOutputBytes) && message.maxOutputBytes > 0
    ? message.maxOutputBytes : 8 * 1024 * 1024;
  logs = [];
  const names = new Set(Array.isArray(message.bindings) ? message.bindings.map((binding) => binding.name) : []);
  const tools = Object.create(null);
  for (const name of names) tools[name] = (args) => callTool(name, args, names);
  tools.getToolSpec = getToolSpec;
  tools.callTool = (name, args) => callTool(name, args, names, false);
  const consoleFacade = Object.freeze({
    log, info: log, warn: log, error: log, debug: log,
  });
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, URL, URLSearchParams,
    clearImmediate, clearInterval, clearTimeout, console: consoleFacade,
    queueMicrotask, setImmediate, setInterval, setTimeout, structuredClone,
  });
  const wrappedSource = `(async (tools) => {\n${message.source}\n})`;
  const source = stripTypeScriptTypes(wrappedSource, { mode: 'strip' });
  const program = new vm.Script(source, {
    filename: 'openbitfun-ptc.ts',
  }).runInContext(context);
  const value = await program(Object.freeze(tools));
  const result = jsonValue(value);
  const logBytes = Buffer.byteLength(stringify(logs), 'utf8');
  if (logBytes > maxOutputBytes) failure('PTC logs exceed output limit', 'output_limit');
  return { value: result, logs };
}

write({ kind: 'ready', token });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try { message = parse(line); } catch { process.exit(1); return; }
  if (message.type === 'tool_result') {
    const call = pending.get(message.operationId);
    if (!call) return;
    pending.delete(message.operationId);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(message.error || 'nested tool call failed'));
    return;
  }
  if (message.type !== 'execute') return;
  void execute(message).then(
    (result) => write({ kind: 'complete', token, id: message.id, ok: true, result }),
    (error) => write({
      kind: 'complete', token, id: message.id, ok: false,
      errorKind: error?.ptcCode || 'exception',
      error: error instanceof Error ? error.message.slice(0, 4096) : 'PTC execution failed',
    }),
  );
});
"#;

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

pub struct NodePtcRuntime {
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

impl Default for NodePtcRuntime {
    fn default() -> Self {
        Self::discover()
    }
}

impl NodePtcRuntime {
    pub fn discover() -> Self {
        Self {
            executable: RwLock::new(which::which("node").ok()),
            operations: Mutex::new(HashMap::new()),
            #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
            remote_target: None,
        }
    }

    #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
    pub fn for_remote(ssh_manager: SSHConnectionManager, connection_id: impl Into<String>) -> Self {
        Self {
            executable: RwLock::new(None),
            operations: Mutex::new(HashMap::new()),
            remote_target: Some(RemotePtcTarget {
                ssh_manager,
                connection_id: connection_id.into(),
            }),
        }
    }

    async fn executable(&self) -> Option<PathBuf> {
        if let Some(path) = self.executable.read().await.clone() {
            return Some(path);
        }
        let path = which::which("node").ok()?;
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
            .arg("--input-type=module")
            .arg("--eval")
            .arg(BOOTSTRAP)
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
                    format!("failed to start Node PTC runtime: {error}"),
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
        let command = format!(
            "unset NODE_OPTIONS NODE_PATH; cd -- {} && exec node --input-type=module --eval {}",
            shell_quote_posix(cwd),
            shell_quote_posix(BOOTSTRAP),
        );
        let transport = target
            .ssh_manager
            .open_workspace_stdio(&target.connection_id, &command)
            .await
            .map_err(|error| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    format!("failed to start remote Node PTC runtime: {error}"),
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
    async fn remote_node_version(target: &RemotePtcTarget) -> Result<String, String> {
        let result = target
            .ssh_manager
            .execute_command_with_options(
                &target.connection_id,
                "node --version",
                SSHCommandOptions {
                    timeout_ms: Some(10_000),
                    cancellation_token: None,
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code != 0 {
            return Err(if result.stderr.trim().is_empty() {
                "remote Node.js version probe failed".to_string()
            } else {
                result.stderr.trim().to_string()
            });
        }
        let version = result.stdout.trim().to_string();
        if version.is_empty() {
            Err("remote Node.js version probe returned no version".to_string())
        } else {
            Ok(version)
        }
    }

    async fn runtime_version(&self) -> PortResult<(Option<PathBuf>, String)> {
        #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
        if let Some(target) = &self.remote_target {
            let version = Self::remote_node_version(target).await.map_err(|reason| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    format!("remote Node.js PTC runtime is unavailable: {reason}"),
                )
            })?;
            return Ok((None, version));
        }

        let executable = self.executable().await.ok_or_else(|| {
            PortError::new(PortErrorKind::NotAvailable, "Node.js is not available")
        })?;
        let version = node_version(&executable).await.map_err(|reason| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("Node.js PTC runtime is unavailable: {reason}"),
            )
        })?;
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
        if !supports_type_stripping(&version) {
            return Err(PortError::new(
                PortErrorKind::NotAvailable,
                format!(
                    "Node.js {version} does not provide stripTypeScriptTypes (requires Node.js 22.6 or newer)"
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
                    tokio::spawn(async move {
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
                    tokio::spawn(async move {
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

async fn node_version(executable: &PathBuf) -> Result<String, String> {
    let output = openbitfun_services_core::process_manager::create_tokio_command(executable)
        .arg("--version")
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Node.js version probe failed".to_string());
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
impl PtcRuntime for NodePtcRuntime {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::PtcRuntime
    }

    async fn availability(&self) -> PtcRuntimeAvailability {
        match self.runtime_version().await {
            Ok((executable, version)) if supports_type_stripping(&version) => {
                PtcRuntimeAvailability::Available {
                    executable: executable
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "node (remote workspace)".to_string()),
                    version,
                }
            }
            Ok((_, version)) => PtcRuntimeAvailability::Unavailable {
                reason: format!(
                    "Node.js {version} does not provide stripTypeScriptTypes (requires Node.js 22.6 or newer)"
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
    use super::{supports_type_stripping, NodePtcRuntime};
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
        let runtime = NodePtcRuntime::discover();
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
        let runtime = NodePtcRuntime::discover();
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
        let runtime = NodePtcRuntime::discover();
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
}
