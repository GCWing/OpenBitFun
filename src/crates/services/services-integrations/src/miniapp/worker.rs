//! JS Worker —single child process (Bun/Node) with stdin/stderr JSON-RPC.

use openbitfun_product_domains::miniapp::runtime::DetectedRuntime;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

type JsWorkerResponse = Result<Value, String>;
type PendingResponseSender = oneshot::Sender<JsWorkerResponse>;
type PendingResponseMap = HashMap<String, PendingResponseSender>;
pub type MiniAppWorkerEventFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct MiniAppWorkerEvent {
    pub app_id: String,
    pub event: String,
    pub data: Value,
}

pub trait MiniAppWorkerEventSink: Send + Sync {
    fn emit_worker_event<'a>(&'a self, event: MiniAppWorkerEvent) -> MiniAppWorkerEventFuture<'a>;
}

pub type SharedMiniAppWorkerEventSink = Arc<dyn MiniAppWorkerEventSink>;

/// Single JS Worker process: stdin for requests, stderr for RPC responses, stdout for user logs.
pub struct JsWorker {
    _child: Child,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<PendingResponseMap>>,
    last_activity: Arc<AtomicI64>,
}

impl JsWorker {
    /// Spawn Worker process: `runtime_path worker_host_path '<policy_json>'` with cwd = app_dir.
    /// The `app_id` is used as the source identifier when emitting worker events.
    /// `resource_dir`, when present, is exported to the worker as `BITFUN_RESOURCE_DIR`
    /// so bundled product resources (e.g. the LoopX CLI) resolve on any host.
    pub async fn spawn(
        runtime: &DetectedRuntime,
        worker_host_path: &Path,
        resource_dir: Option<&Path>,
        app_dir: &Path,
        policy_json: &str,
        app_id: String,
        event_sink: Option<SharedMiniAppWorkerEventSink>,
    ) -> Result<Self, String> {
        let exe = runtime.path.to_string_lossy();
        let host = worker_host_path.to_string_lossy();
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(&*exe);
        command
            .arg(&*host)
            .arg(policy_json)
            .current_dir(app_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = resource_dir {
            command.env("BITFUN_RESOURCE_DIR", dir);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn JS Worker: {}", e))?;

        let stdin_handle = child.stdin.take().ok_or("No stdin")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;
        let _stdout = child.stdout.take();

        let pending = Arc::new(Mutex::new(PendingResponseMap::new()));
        let last_activity = Arc::new(AtomicI64::new(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        ));

        let pending_clone = pending.clone();
        let last_activity_clone = last_activity.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                let _ =
                    last_activity_clone.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |_| {
                        Some(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as i64,
                        )
                    });
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Lines with an `id` are RPC responses —route to the pending map.
                let id = msg.get("id").and_then(Value::as_str).map(String::from);
                if let Some(id) = id {
                    let result = if let Some(err) = msg.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("RPC error");
                        Err(msg.to_string())
                    } else {
                        msg.get("result")
                            .cloned()
                            .ok_or_else(|| "Missing result".to_string())
                    };
                    let mut guard = pending_clone.lock().await;
                    if let Some(tx) = guard.remove(&id) {
                        let _ = tx.send(result);
                    }
                    continue;
                }

                // Lines with an `event` field (no `id`) are push events from the Worker.
                if let Some(event_name) = msg.get("event").and_then(Value::as_str) {
                    let Some(sink) = event_sink.as_ref() else {
                        continue;
                    };
                    let data = msg.get("data").cloned().unwrap_or(Value::Null);
                    sink.emit_worker_event(MiniAppWorkerEvent {
                        app_id: app_id.clone(),
                        event: event_name.to_string(),
                        data,
                    })
                    .await;
                }
            }
        });

        Ok(Self {
            _child: child,
            stdin: Mutex::new(Some(stdin_handle)),
            pending,
            last_activity,
        })
    }

    /// Send a JSON-RPC request and wait for the response (with timeout).
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        let id = format!("rpc-{}", uuid::Uuid::new_v4());
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())? + "\n";

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id.clone(), tx);
        }
        self.last_activity.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            Ordering::SeqCst,
        );

        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard.as_mut().ok_or("Worker stdin closed")?;
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        drop(stdin_guard);

        let timeout = Duration::from_millis(timeout_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => {
                let _ = self.pending.lock().await.remove(&id);
                Err("Worker dropped response".to_string())
            }
            Err(_) => {
                let _ = self.pending.lock().await.remove(&id);
                Err(format!("Worker call timeout ({}ms)", timeout_ms))
            }
        }
    }

    /// Last activity timestamp (millis since epoch).
    pub fn last_activity_ms(&self) -> i64 {
        self.last_activity.load(Ordering::SeqCst)
    }

    /// Kill the worker process.
    pub async fn kill(&mut self) {
        let _ = self._child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self._child.wait()).await;
    }
}
