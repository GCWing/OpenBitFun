use super::types::RoundContext;
use crate::agentic::WorkspaceBinding;
use crate::infrastructure::ai::AIClient;
use crate::service::config::{
    GlobalConfigManager, ModelExchangeTracingConfig, ModelExchangeTracingMode,
};
use crate::service::workspace_runtime::get_workspace_runtime_service_arc;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use log::{debug, warn};
use openbitfun_ai_adapters::{
    ModelExchangeRequestAttempt, ModelExchangeRequestTraceHandle, ModelExchangeResponseTrace,
    ModelExchangeRoundAttempt, ModelExchangeTraceConfig, ModelExchangeTraceSink,
};
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::sync::Mutex;
use uuid::Uuid;

const TRACE_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelExchangeTraceRecord {
    version: u32,
    trace_id: String,
    sequence: u64,
    recorded_at: DateTime<Utc>,
    session_id: String,
    turn_id: String,
    operation_kind: String,
    operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_trigger: Option<String>,
    capture_mode: ModelExchangeTracingMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    response: Option<ModelExchangeResponseTrace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timing: Option<ModelExchangeTraceTiming>,
    request: ModelExchangeTraceRequestRecord,
}

/// Adapter attempt lifecycle, including stream processing and trace-start IO.
/// Provider-capacity queueing, retry backoff and tools are outside this span.
/// An unfinished attempt deliberately has no end or duration, never a fake zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelExchangeTraceTiming {
    started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct PendingModelExchangeTrace {
    path: PathBuf,
    started_at: Instant,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ModelExchangeTraceOperation<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub trigger: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelExchangeTraceRequestRecord {
    provider: String,
    api_format: String,
    model_id: String,
    request_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<Value>,
    /// Adapter-local HTTP/SSE retry number. This restarts for each logical
    /// model-round attempt.
    attempt_number: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    round_attempt: Option<ModelExchangeRoundAttempt>,
}

#[derive(Debug, Clone, Copy)]
struct ModelExchangeTracePolicy {
    mode: ModelExchangeTracingMode,
    capture_request_body: bool,
    capture_response_text: bool,
    capture_reasoning: bool,
    capture_tool_calls: bool,
    capture_usage: bool,
    capture_provider_metadata: bool,
}

impl ModelExchangeTracePolicy {
    fn from_config(config: ModelExchangeTracingConfig) -> Option<Self> {
        match config.mode {
            ModelExchangeTracingMode::Off => None,
            ModelExchangeTracingMode::Full => Some(Self {
                mode: ModelExchangeTracingMode::Full,
                capture_request_body: true,
                capture_response_text: true,
                capture_reasoning: true,
                capture_tool_calls: true,
                capture_usage: true,
                capture_provider_metadata: true,
            }),
            ModelExchangeTracingMode::UsageOnly => Some(Self {
                mode: ModelExchangeTracingMode::UsageOnly,
                capture_request_body: false,
                capture_response_text: false,
                capture_reasoning: false,
                capture_tool_calls: false,
                capture_usage: true,
                capture_provider_metadata: false,
            }),
        }
    }
}

#[derive(Debug)]
struct WorkspaceModelExchangeTraceSink {
    trace_session_dir: PathBuf,
    policy: ModelExchangeTracePolicy,
    session_id: String,
    turn_id: String,
    operation_kind: String,
    operation_id: String,
    operation_trigger: Option<String>,
    provider: String,
    api_format: String,
    model_id: String,
    trace_paths: DashMap<String, PendingModelExchangeTrace>,
}

// Reverse declaration order preserves the previous function-parameter drop
// order; struct literals remain in the original evaluation order.
struct WorkspaceModelExchangeTraceInput {
    model_id: String,
    api_format: String,
    provider: String,
    operation_trigger: Option<String>,
    operation_id: String,
    operation_kind: String,
    turn_id: String,
    session_id: String,
    policy: ModelExchangeTracePolicy,
    trace_session_dir: PathBuf,
}

impl WorkspaceModelExchangeTraceSink {
    fn new(input: WorkspaceModelExchangeTraceInput) -> Self {
        Self {
            trace_session_dir: input.trace_session_dir,
            policy: input.policy,
            session_id: input.session_id,
            turn_id: input.turn_id,
            operation_kind: input.operation_kind,
            operation_id: input.operation_id,
            operation_trigger: input.operation_trigger,
            provider: input.provider,
            api_format: input.api_format,
            model_id: input.model_id,
            trace_paths: DashMap::new(),
        }
    }

    async fn allocate_sequence(&self) -> Result<u64, String> {
        let key = self.trace_session_dir.to_string_lossy().to_string();
        let allocator = sequence_allocators()
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone();
        let mut guard = allocator.lock().await;
        let current = match *guard {
            Some(value) => value,
            None => {
                let detected = detect_last_sequence(&self.trace_session_dir).await?;
                *guard = Some(detected);
                detected
            }
        };
        let next = current.saturating_add(1);
        *guard = Some(next);
        Ok(next)
    }

    fn trace_path(&self, sequence: u64) -> PathBuf {
        self.trace_session_dir
            .join(format!("request-{:06}.json", sequence))
    }

    async fn write_record(
        &self,
        path: &Path,
        record: &ModelExchangeTraceRecord,
    ) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create trace directory: {}", error))?;
        }

        JsonFileStore
            .write_atomic_strict(path, record)
            .await
            .map_err(|error| format!("Failed to write trace record: {}", error))
    }

    async fn read_record(&self, path: &Path) -> Result<ModelExchangeTraceRecord, String> {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| format!("Failed to read trace record: {}", error))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Failed to deserialize trace record: {}", error))
    }

    async fn update_response(
        &self,
        trace_id: &str,
        response: &ModelExchangeResponseTrace,
    ) -> Result<(), String> {
        let Some((path, duration_ms)) = self.trace_paths.get(trace_id).map(|entry| {
            let pending = entry.value();
            (
                pending.path.clone(),
                pending
                    .started_at
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            )
        }) else {
            return Ok(());
        };
        let finished_at = Utc::now();

        let mut record = self.read_record(&path).await?;
        record.response = Some(self.sanitize_response(response));
        if let Some(timing) = record.timing.as_mut() {
            timing.finished_at = Some(finished_at);
            timing.duration_ms = Some(duration_ms);
        }
        self.write_record(&path, &record).await?;
        self.trace_paths.remove(trace_id);
        Ok(())
    }

    fn sanitize_response(
        &self,
        response: &ModelExchangeResponseTrace,
    ) -> ModelExchangeResponseTrace {
        ModelExchangeResponseTrace {
            kind: response.kind.clone(),
            assistant_text: self
                .policy
                .capture_response_text
                .then(|| response.assistant_text.clone())
                .flatten(),
            thinking: self
                .policy
                .capture_reasoning
                .then(|| response.thinking.clone())
                .flatten(),
            tool_calls: self
                .policy
                .capture_tool_calls
                .then(|| response.tool_calls.clone())
                .flatten(),
            usage: self
                .policy
                .capture_usage
                .then(|| response.usage.clone())
                .flatten(),
            provider_metadata: self
                .policy
                .capture_provider_metadata
                .then(|| response.provider_metadata.clone())
                .flatten(),
            partial_recovery_reason: response.partial_recovery_reason.clone(),
            error: response.error.clone(),
        }
    }
}

#[async_trait]
impl ModelExchangeTraceSink for WorkspaceModelExchangeTraceSink {
    async fn request_attempt_started(
        &self,
        attempt: &ModelExchangeRequestAttempt,
    ) -> Option<ModelExchangeRequestTraceHandle> {
        let started_at = Instant::now();
        let recorded_at = Utc::now();
        let sequence = match self.allocate_sequence().await {
            Ok(value) => value,
            Err(error) => {
                warn!(
                    "Model exchange trace sequence allocation failed: session_id={}, error={}",
                    self.session_id, error
                );
                return None;
            }
        };

        let trace_id = Uuid::new_v4().to_string();
        let path = self.trace_path(sequence);
        let record = ModelExchangeTraceRecord {
            version: TRACE_LAYOUT_VERSION,
            trace_id: trace_id.clone(),
            sequence,
            recorded_at,
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            operation_kind: self.operation_kind.clone(),
            operation_id: self.operation_id.clone(),
            operation_trigger: self.operation_trigger.clone(),
            capture_mode: self.policy.mode,
            response: None,
            timing: Some(ModelExchangeTraceTiming {
                started_at: recorded_at,
                finished_at: None,
                duration_ms: None,
            }),
            request: ModelExchangeTraceRequestRecord {
                provider: self.provider.clone(),
                api_format: self.api_format.clone(),
                model_id: self.model_id.clone(),
                request_url: attempt.request_url.clone(),
                body: attempt.request_body.clone(),
                attempt_number: attempt.attempt_number,
                round_attempt: attempt.round_attempt.clone(),
            },
        };

        if let Err(error) = self.write_record(&path, &record).await {
            warn!(
                "Model exchange trace write failed: session_id={}, trace_id={}, error={}",
                self.session_id, trace_id, error
            );
            return None;
        }

        self.trace_paths.insert(
            trace_id.clone(),
            PendingModelExchangeTrace { path, started_at },
        );
        Some(ModelExchangeRequestTraceHandle { trace_id })
    }

    async fn request_attempt_failed(
        &self,
        handle: Option<&ModelExchangeRequestTraceHandle>,
        error: &str,
    ) {
        let Some(handle) = handle else {
            return;
        };

        if let Err(write_error) = self
            .update_response(
                &handle.trace_id,
                &ModelExchangeResponseTrace {
                    kind: "error".to_string(),
                    assistant_text: None,
                    thinking: None,
                    tool_calls: None,
                    usage: None,
                    provider_metadata: None,
                    partial_recovery_reason: None,
                    error: Some(error.to_string()),
                },
            )
            .await
        {
            warn!(
                "Model exchange trace failure update failed: session_id={}, trace_id={}, error={}",
                self.session_id, handle.trace_id, write_error
            );
        }
    }

    async fn request_attempt_completed(
        &self,
        handle: &ModelExchangeRequestTraceHandle,
        response: &ModelExchangeResponseTrace,
    ) {
        if let Err(error) = self.update_response(&handle.trace_id, response).await {
            warn!(
                "Model exchange trace completion update failed: session_id={}, trace_id={}, error={}",
                self.session_id, handle.trace_id, error
            );
        }
    }
}

pub(super) async fn prepare_model_exchange_trace(
    context: &RoundContext,
    round_id: &str,
    ai_client: &AIClient,
) -> Option<ModelExchangeTraceConfig> {
    prepare_model_exchange_trace_for_workspace(
        &context.session_id,
        &context.dialog_turn_id,
        context.workspace.as_ref(),
        context.model_exchange_trace_dir.as_deref(),
        ModelExchangeTraceOperation {
            kind: "model_round",
            id: round_id,
            trigger: None,
        },
        ai_client,
    )
    .await
}

pub(super) async fn prepare_model_exchange_trace_for_workspace(
    session_id: &str,
    turn_id: &str,
    workspace: Option<&WorkspaceBinding>,
    model_exchange_trace_dir: Option<&Path>,
    operation: ModelExchangeTraceOperation<'_>,
    ai_client: &AIClient,
) -> Option<ModelExchangeTraceConfig> {
    let policy = current_model_exchange_trace_policy().await?;

    let Some(workspace) = workspace else {
        debug!(
            "Model exchange trace skipped because operation has no workspace: session_id={}, turn_id={}, operation_kind={}, operation_id={}",
            session_id, turn_id, operation.kind, operation.id
        );
        return None;
    };

    let trace_session_dir = match model_exchange_trace_dir {
        Some(path) => path.to_path_buf(),
        None => match get_workspace_runtime_service_arc()
            .ensure_runtime_for_workspace_binding(workspace)
            .await
        {
            Ok(result) => result.context.request_trace_session_dir(session_id),
            Err(error) => {
                warn!(
                    "Model exchange trace skipped because runtime init failed: session_id={}, operation_kind={}, operation_id={}, error={}",
                    session_id, operation.kind, operation.id, error
                );
                return None;
            }
        },
    };

    Some(ModelExchangeTraceConfig::new(
        Arc::new(WorkspaceModelExchangeTraceSink::new(
            WorkspaceModelExchangeTraceInput {
                trace_session_dir,
                policy,
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                operation_kind: operation.kind.to_string(),
                operation_id: operation.id.to_string(),
                operation_trigger: operation.trigger.map(str::to_string),
                provider: ai_client.config.format.clone(),
                api_format: ai_client.config.format.clone(),
                model_id: ai_client.config.model.clone(),
            },
        )),
        policy.capture_request_body,
    ))
}

async fn current_model_exchange_trace_policy() -> Option<ModelExchangeTracePolicy> {
    let Ok(config_service) = GlobalConfigManager::get_service().await else {
        return None;
    };

    let tracing_config: ModelExchangeTracingConfig = config_service
        .get_config(Some("app.logging.model_exchange_tracing"))
        .await
        .unwrap_or_default();
    ModelExchangeTracePolicy::from_config(tracing_config)
}

async fn detect_last_sequence(session_dir: &Path) -> Result<u64, String> {
    let mut last_sequence = 0u64;
    let mut entries = match tokio::fs::read_dir(session_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Failed to inspect trace session directory '{}': {}",
                session_dir.display(),
                error
            ));
        }
    };

    loop {
        let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("Failed to iterate trace session directory: {}", error))?
        else {
            break;
        };

        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(sequence) = parse_trace_sequence(file_name) else {
            continue;
        };
        last_sequence = last_sequence.max(sequence);
    }

    Ok(last_sequence)
}

fn parse_trace_sequence(file_name: &str) -> Option<u64> {
    file_name
        .strip_prefix("request-")?
        .strip_suffix(".json")?
        .parse::<u64>()
        .ok()
}

fn sequence_allocators() -> &'static DashMap<String, Arc<Mutex<Option<u64>>>> {
    static ALLOCATORS: OnceLock<DashMap<String, Arc<Mutex<Option<u64>>>>> = OnceLock::new();
    ALLOCATORS.get_or_init(DashMap::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SequenceAllocatorCleanup(String);

    impl Drop for SequenceAllocatorCleanup {
        fn drop(&mut self) {
            sequence_allocators().remove(&self.0);
        }
    }

    #[tokio::test]
    async fn trace_request_preserves_operation_and_model_identity() {
        let directory = tempfile::tempdir().expect("trace directory should be created");
        let _allocator_cleanup =
            SequenceAllocatorCleanup(directory.path().to_string_lossy().to_string());
        let sink = WorkspaceModelExchangeTraceSink::new(WorkspaceModelExchangeTraceInput {
            trace_session_dir: directory.path().to_path_buf(),
            policy: ModelExchangeTracePolicy {
                mode: ModelExchangeTracingMode::Full,
                capture_request_body: true,
                capture_response_text: true,
                capture_reasoning: true,
                capture_tool_calls: true,
                capture_usage: true,
                capture_provider_metadata: true,
            },
            session_id: "session-identity".to_string(),
            turn_id: "turn-identity".to_string(),
            operation_kind: "context_compression".to_string(),
            operation_id: "compression-identity".to_string(),
            operation_trigger: Some("manual".to_string()),
            provider: "provider-format".to_string(),
            api_format: "api-format".to_string(),
            model_id: "model-identity".to_string(),
        });

        let handle = sink
            .request_attempt_started(&ModelExchangeRequestAttempt {
                request_url: "https://example.invalid/model".to_string(),
                request_body: Some(serde_json::json!({"request": "body"})),
                attempt_number: 2,
                round_attempt: Some(ModelExchangeRoundAttempt {
                    attempt_id: "round-1:attempt:3".to_string(),
                    attempt_index: 3,
                }),
            })
            .await
            .expect("trace request should be recorded");
        let path = sink
            .trace_paths
            .get(&handle.trace_id)
            .expect("trace path should be registered")
            .value()
            .path
            .clone();
        let record = sink
            .read_record(&path)
            .await
            .expect("trace record should be readable");

        assert_eq!(record.session_id, "session-identity");
        assert_eq!(record.turn_id, "turn-identity");
        assert_eq!(record.operation_kind, "context_compression");
        assert_eq!(record.operation_id, "compression-identity");
        assert_eq!(record.operation_trigger.as_deref(), Some("manual"));
        assert_eq!(record.request.provider, "provider-format");
        assert_eq!(record.request.api_format, "api-format");
        assert_eq!(record.request.model_id, "model-identity");
        assert_eq!(record.request.attempt_number, 2);
        assert_eq!(
            record.request.round_attempt,
            Some(ModelExchangeRoundAttempt {
                attempt_id: "round-1:attempt:3".to_string(),
                attempt_index: 3,
            })
        );
        assert_eq!(
            record.request.body,
            Some(serde_json::json!({"request": "body"}))
        );

        let pending = serde_json::to_value(&record).unwrap();
        assert!(pending["timing"]["started_at"].is_string());
        assert!(pending["timing"]["finished_at"].is_null());
        assert!(pending["timing"]["duration_ms"].is_null());
        assert!(record.response.is_none());

        sink.request_attempt_failed(Some(&handle), "synthetic transport failure")
            .await;
        let completed = sink.read_record(&path).await.unwrap();
        let completed = serde_json::to_value(completed).unwrap();
        assert_eq!(completed["response"]["kind"], "error");
        assert_eq!(
            completed["timing"]["started_at"],
            pending["timing"]["started_at"]
        );
        assert!(completed["timing"]["finished_at"].is_string());
        assert!(completed["timing"]["duration_ms"].is_u64());
        assert!(completed["response"]["usage"].is_null());
        assert!(!sink.trace_paths.contains_key(&handle.trace_id));

        // Legacy traces have no timing; round-trip them without inventing data.
        let mut legacy = completed;
        legacy.as_object_mut().unwrap().remove("timing");
        let legacy: ModelExchangeTraceRecord = serde_json::from_value(legacy).unwrap();
        assert!(legacy.timing.is_none());
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("timing")
            .is_none());

        let response = ModelExchangeResponseTrace {
            kind: "completed".to_string(),
            assistant_text: Some("synthetic response".to_string()),
            thinking: Some("synthetic reasoning".to_string()),
            tool_calls: None,
            usage: Some(serde_json::json!({"prompt_tokens": 7, "completion_tokens": 3})),
            provider_metadata: None,
            partial_recovery_reason: None,
            error: None,
        };
        let mut sink = sink;
        sink.policy = ModelExchangeTracePolicy::from_config(ModelExchangeTracingConfig {
            mode: ModelExchangeTracingMode::UsageOnly,
        })
        .unwrap();
        let success = sink
            .request_attempt_started(&ModelExchangeRequestAttempt {
                request_url: "https://example.invalid/model".to_string(),
                request_body: None,
                attempt_number: 3,
                round_attempt: None,
            })
            .await
            .unwrap();
        let success_path = sink
            .trace_paths
            .get(&success.trace_id)
            .unwrap()
            .path
            .clone();
        sink.request_attempt_completed(&success, &response).await;
        let success_record = sink.read_record(&success_path).await.unwrap();
        let success_timing = success_record.timing.unwrap();
        assert!(success_timing.finished_at.unwrap() >= success_timing.started_at);
        assert!(success_timing.duration_ms.is_some());
        let recorded_response = success_record.response.unwrap();
        assert_eq!(recorded_response.usage, response.usage);
        assert!(recorded_response.assistant_text.is_none());
        assert!(recorded_response.thinking.is_none());
        assert_eq!(success_record.request.attempt_number, 3);
        assert!(!sink.trace_paths.contains_key(&success.trace_id));
    }
}
