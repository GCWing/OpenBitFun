//! Python runtime for PTC programs on local or remote workspaces.
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

const BOOTSTRAP: &str = r#"import asyncio
import contextlib
import io
import json
import sys
import threading
import traceback
import uuid

_TOKEN = str(uuid.uuid4())
_PENDING = {}
_PENDING_LOCK = threading.Lock()
_LOOP = None
_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
_LOGS = []


def _write(value):
    encoded = json.dumps(_json_safe(value), ensure_ascii=True, separators=(",", ":")).encode("ascii")
    sys.__stdout__.buffer.write(encoded + b"\n")
    sys.__stdout__.buffer.flush()


def _json_safe(value):
    if isinstance(value, str):
        return "".join("\ufffd" if 0xD800 <= ord(character) <= 0xDFFF else character for character in value)
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {_json_safe(key): _json_safe(item) for key, item in value.items()}
    return value


def _log(*values):
    _LOGS.append(" ".join(_json_safe(value) if isinstance(value, str) else json.dumps(_json_safe(value), ensure_ascii=False) for value in values))


def _json_value(value):
    encoded = json.dumps(_json_safe(value), ensure_ascii=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _MAX_OUTPUT_BYTES:
        raise RuntimeError("PTC result exceeds output limit")
    return json.loads(encoded)


async def _call_tool(name, arguments, allowed, enforce_binding=True):
    if enforce_binding and name not in allowed:
        raise RuntimeError(f"tool '{name}' is not available in this PTC snapshot")
    if not isinstance(arguments, dict):
        raise RuntimeError(f"arguments for '{name}' must be an object")
    operation_id = str(uuid.uuid4())
    future = _LOOP.create_future()
    with _PENDING_LOCK:
        _PENDING[operation_id] = future
    _write({"kind": "tool_call", "token": _TOKEN, "operationId": operation_id, "toolName": name, "arguments": arguments, "enforceBinding": enforce_binding})
    return await future


async def _get_tool_spec(name):
    if not isinstance(name, str) or not name:
        raise RuntimeError("get_tool_spec requires a non-empty tool name")
    operation_id = str(uuid.uuid4())
    future = _LOOP.create_future()
    with _PENDING_LOCK:
        _PENDING[operation_id] = future
    _write({"kind": "get_tool_spec", "token": _TOKEN, "operationId": operation_id, "toolName": name})
    return await future


class _Tools:
    def __init__(self, names):
        self._names = names

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda arguments: _call_tool(name, arguments, self._names)

    async def get_tool_spec(self, name):
        return await _get_tool_spec(name)

    async def call_tool(self, name, arguments):
        return await _call_tool(name, arguments, self._names, False)


_SAFE_BUILTINS = {
    "bool": bool, "dict": dict, "enumerate": enumerate, "filter": filter,
    "float": float, "int": int, "len": len, "list": list, "map": map,
    "max": max, "min": min, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip, "abs": abs,
    "all": all, "any": any, "isinstance": isinstance, "print": print,
    "Exception": Exception, "ValueError": ValueError, "TypeError": TypeError,
}


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in {"asyncio", "json"}:
        raise ImportError(f"module '{name}' is not available in PTC programs")
    return {"asyncio": asyncio, "json": json}[name]


_SAFE_BUILTINS["__import__"] = _safe_import


async def _execute(message):
    global _MAX_OUTPUT_BYTES, _LOGS
    configured_limit = message.get("maxOutputBytes")
    _MAX_OUTPUT_BYTES = configured_limit if isinstance(configured_limit, int) and configured_limit > 0 else 8 * 1024 * 1024
    _LOGS = []
    names = {binding.get("name") for binding in message.get("bindings", []) if isinstance(binding, dict) and isinstance(binding.get("name"), str)}
    tools = _Tools(names)
    source = message.get("source")
    if not isinstance(source, str) or not source.strip():
        raise ValueError("PTC execution request is incomplete")
    indented = "\n".join("    " + line if line else "" for line in source.splitlines())
    wrapped = "async def __ptc_main__():\n" + indented + "\n"
    scope = {"__builtins__": _SAFE_BUILTINS, "asyncio": asyncio, "json": json, "tools": tools}
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(wrapped, "openbitfun-ptc.py", "exec"), scope, scope)
        value = await scope["__ptc_main__"]()
    printed = output.getvalue()
    if printed:
        _LOGS.extend(_json_safe(line) for line in printed.rstrip("\n").splitlines())
    result = _json_value(value)
    if len(json.dumps(_json_safe(_LOGS), ensure_ascii=True).encode("ascii")) > _MAX_OUTPUT_BYTES:
        raise RuntimeError("PTC logs exceed output limit")
    return {"value": result, "logs": _LOGS}


def _resolve_tool_result(message):
    operation_id = message.get("operationId")
    with _PENDING_LOCK:
        future = _PENDING.pop(operation_id, None)
    if future is None or future.done():
        return
    if message.get("ok"):
        future.set_result(message.get("value"))
    else:
        future.set_exception(RuntimeError(message.get("error") or "nested tool call failed"))


def _reader():
    for raw_line in sys.stdin.buffer:
        try:
            message = json.loads(raw_line.decode("utf-8"))
        except Exception:
            return
        if message.get("type") == "tool_result":
            _LOOP.call_soon_threadsafe(_resolve_tool_result, message)
        elif message.get("type") == "execute":
            async def run(current):
                try:
                    result = await _execute(current)
                    _write({"kind": "complete", "token": _TOKEN, "id": current.get("id"), "ok": True, "result": result})
                except Exception as error:
                    _write({"kind": "complete", "token": _TOKEN, "id": current.get("id"), "ok": False, "errorKind": "exception", "error": str(error)[:4096]})
            _LOOP.call_soon_threadsafe(lambda: asyncio.create_task(run(message)))


async def _main():
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    _write({"kind": "ready", "token": _TOKEN})
    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()
    await asyncio.Event().wait()


try:
    asyncio.run(_main())
except KeyboardInterrupt:
    pass"#;

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

pub struct PythonPtcRuntime {
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

impl Default for PythonPtcRuntime {
    fn default() -> Self {
        Self::discover()
    }
}

impl PythonPtcRuntime {
    pub fn discover() -> Self {
        Self {
            executable: RwLock::new(
                which::which("python3")
                    .or_else(|_| which::which("python"))
                    .ok(),
            ),
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
        let path = which::which("python3")
            .or_else(|_| which::which("python"))
            .ok()?;
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
            .arg("-u")
            .arg("-c")
            .arg(BOOTSTRAP)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME");
        let mut child = ProcessTreeChild::spawn(&mut command)
            .await
            .map_err(|error| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    format!("failed to start Python PTC runtime: {error}"),
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
            "unset NODE_OPTIONS NODE_PATH; PYTHON=$(for candidate in python3 python; do if command -v \"$candidate\" >/dev/null 2>&1; then version=$(\"$candidate\" --version 2>&1) || continue; case \"$version\" in Python\\ 3.*) command -v \"$candidate\"; break;; esac; fi; done); test -n \"$PYTHON\" || {{ echo 'Python 3 is not available' >&2; exit 127; }}; cd -- {} && exec \"$PYTHON\" -u -c {}",
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
                    format!("failed to start remote Python PTC runtime: {error}"),
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
    async fn remote_python_version(target: &RemotePtcTarget) -> Result<String, String> {
        let result = target
            .ssh_manager
            .execute_command_with_options(
                &target.connection_id,
                "for candidate in python3 python; do if command -v \"$candidate\" >/dev/null 2>&1; then version=$(\"$candidate\" --version 2>&1) || continue; case \"$version\" in Python\\ 3.*) printf '%s' \"$version\"; exit 0;; esac; fi; done; exit 127",
                SSHCommandOptions {
                    timeout_ms: Some(10_000),
                    cancellation_token: None,
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code != 0 {
            return Err(if result.stderr.trim().is_empty() {
                "remote Python version probe failed".to_string()
            } else {
                result.stderr.trim().to_string()
            });
        }
        let version = if result.stdout.trim().is_empty() {
            result.stderr.trim().to_string()
        } else {
            result.stdout.trim().to_string()
        };
        if version.is_empty() {
            Err("remote Python version probe returned no version".to_string())
        } else if !version.starts_with("Python 3.") {
            Err("Python 3 is required".to_string())
        } else {
            Ok(version)
        }
    }

    async fn runtime_version(&self) -> PortResult<(Option<PathBuf>, String)> {
        #[cfg(all(feature = "remote-ssh", feature = "remote-ssh-concrete"))]
        if let Some(target) = &self.remote_target {
            let version = Self::remote_python_version(target)
                .await
                .map_err(|reason| {
                    PortError::new(
                        PortErrorKind::NotAvailable,
                        format!("remote Python PTC runtime is unavailable: {reason}"),
                    )
                })?;
            return Ok((None, version));
        }

        let executable = self.executable().await.ok_or_else(|| {
            PortError::new(PortErrorKind::NotAvailable, "Python is not available")
        })?;
        let version = python_version(&executable).await.map_err(|reason| {
            PortError::new(
                PortErrorKind::NotAvailable,
                format!("Python PTC runtime is unavailable: {reason}"),
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
        let (executable, _version) = self.runtime_version().await?;
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

async fn python_version(executable: &PathBuf) -> Result<String, String> {
    let output = openbitfun_services_core::process_manager::create_tokio_command(executable)
        .arg("--version")
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Python version probe failed".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let version = version.trim().to_string();
    if !version.starts_with("Python 3.") {
        return Err("Python 3 is required".to_string());
    }
    Ok(version)
}

#[async_trait]
impl PtcRuntime for PythonPtcRuntime {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::PtcRuntime
    }

    async fn availability(&self) -> PtcRuntimeAvailability {
        match self.runtime_version().await {
            Ok((executable, version)) => PtcRuntimeAvailability::Available {
                executable: executable
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "python (remote workspace)".to_string()),
                version,
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
    use super::PythonPtcRuntime;
    use async_trait::async_trait;
    use openbitfun_runtime_ports::{
        PtcExecutionRequest, PtcNestedToolCall, PtcRuntime, PtcToolBinding, PtcToolCallHandler,
        PtcToolSpecRequest,
    };
    use serde_json::{json, Value};
    use std::sync::Arc;

    struct Handler;
    #[async_trait]
    impl PtcToolCallHandler for Handler {
        async fn call(
            &self,
            request: PtcNestedToolCall,
        ) -> openbitfun_runtime_ports::PortResult<Value> {
            Ok(json!({
                "tool": request.tool_name,
                "arguments": request.arguments,
                "content": "是一个中文结果"
            }))
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
    async fn executes_program_and_dispatches_nested_tool_call_when_python_is_available() {
        let runtime = PythonPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-test".to_string(),
            source: "result = await tools.Read({'path': 'src/lib.rs'})\nreturn result".to_string(),
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
        let runtime = PythonPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-spec-test".to_string(),
            source: "spec = await tools.get_tool_spec('Deferred')\nresult = await tools.call_tool('Deferred', {'value': 1})\nreturn {'spec': spec, 'result': result}".to_string(),
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
    async fn permits_preloaded_asyncio_import_and_sanitizes_surrogates() {
        let runtime = PythonPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-unicode-test".to_string(),
            source: "import asyncio\nprint('\\udcaf')\nawait asyncio.sleep(0)\nreturn {'value': '\\udcaf'}"
                .to_string(),
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
        assert_eq!(response.value["value"], "�");
        assert_eq!(response.logs, vec!["�"]);
    }

    #[tokio::test]
    async fn preserves_utf8_tool_results_across_the_python_frame() {
        let runtime = PythonPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-utf8-result-test".to_string(),
            source: "result = await tools.Read({'path': 'x'})\nreturn result".to_string(),
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
        assert_eq!(response.value["content"], "是一个中文结果");
    }

    #[tokio::test]
    async fn timeout_terminates_a_long_running_program() {
        let runtime = PythonPtcRuntime::discover();
        if !matches!(
            runtime.availability().await,
            openbitfun_runtime_ports::PtcRuntimeAvailability::Available { .. }
        ) {
            return;
        }
        let request = PtcExecutionRequest {
            operation_id: "ptc-timeout-test".to_string(),
            source: "await asyncio.sleep(5)\nreturn 1".to_string(),
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
