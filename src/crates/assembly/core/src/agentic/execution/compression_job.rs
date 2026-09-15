//! Owned summary preparation, separate from formal hooks, events and commit.
//! Background work can only return a candidate; it cannot mutate a session.

use super::*;
use crate::agentic::session::CompressionPlan;
use crate::util::timing::elapsed_ms_u64;
use openbitfun_agent_runtime::compression_prefetch::{CompressionPrefetch, PrefetchClaim};

// Logging-only scope: it must not inspect/consume the publication channel or
// change the failure-at-claim semantics.
struct PrefetchObservation {
    id: String,
    session_id: String,
    turn_id: String,
    started_at: std::time::Instant,
    claimed: bool,
}

impl Drop for PrefetchObservation {
    fn drop(&mut self) {
        if !self.claimed {
            info!(
                "Compression prefetch released: prefetch_id={}, session_id={}, turn_id={}, reason=unclaimed_scope_exit, duration_ms={}",
                self.id, self.session_id, self.turn_id, elapsed_ms_u64(self.started_at)
            );
        }
    }
}

pub(super) struct PrefetchedCompression {
    task: CompressionPrefetch<CompressionCandidate, OpenBitFunError>,
    source_message_ids: Vec<String>,
    request_identity: serde_json::Value,
    observation: PrefetchObservation,
}

impl PrefetchedCompression {
    pub(super) fn claim(
        mut self,
        input: &CompressionModelSummaryInput<'_>,
    ) -> PrefetchClaim<CompressionCandidate, OpenBitFunError> {
        let latest = ContextCompressor::canonical_conversation(input.runtime_messages);
        self.observation.claimed = true;
        let request_matches = self.request_identity == CompressionJob::request_identity(input);
        let prefix_matches = ContextCompressor::has_message_id_prefix(
            latest,
            self.source_message_ids.iter().map(String::as_str),
        );
        if !request_matches || !prefix_matches {
            info!(
                "Discarding invalid compression prefetch: prefetch_id={}, session_id={}, turn_id={}, request_matches={}, prefix_matches={}, duration_ms={}",
                self.observation.id, self.observation.session_id, input.dialog_turn_id,
                request_matches, prefix_matches, elapsed_ms_u64(self.observation.started_at)
            );
            return PrefetchClaim::Discarded;
        }
        let elapsed_ms = elapsed_ms_u64(self.observation.started_at);
        let claim = self.task.claim();
        let state = match &claim {
            PrefetchClaim::Discarded => "failed",
            PrefetchClaim::Ready(_) => "ready",
            PrefetchClaim::Waiting(_) => "running",
        };
        info!(
            "Claiming compression prefetch: prefetch_id={}, session_id={}, turn_id={}, state={}, duration_ms={}",
            self.observation.id, self.observation.session_id, input.dialog_turn_id, state, elapsed_ms
        );
        claim
    }
}

/// The execution snapshot may include ephemeral scaffolding absent from the
/// store. Preserve it and append only canonical messages published since capture.
pub(super) fn merge_latest_context(
    runtime: &[Message],
    snapshot: &[Message],
    latest: &[Message],
) -> OpenBitFunResult<Vec<Message>> {
    if !ContextCompressor::has_message_id_prefix(
        latest,
        snapshot.iter().map(|message| message.id.as_str()),
    ) {
        return Err(OpenBitFunError::Cancelled(
            "Context changed during compression preparation".into(),
        ));
    }
    let mut result = runtime.to_vec();
    for message in &latest[snapshot.len()..] {
        if !result.iter().any(|existing| existing.id == message.id) {
            result.push(message.clone());
        }
    }
    Ok(result)
}

#[derive(Clone)]
pub(super) struct CompressionCandidate {
    pub plan: CompressionPlan,
    pub summary: String,
    pub request_identity: serde_json::Value,
}

pub(super) struct CompressionJob {
    compressor: Arc<ContextCompressor>,
    session_id: String,
    turn_id: String,
    messages: Vec<Message>,
    context_window: usize,
    initial_recent: usize,
    client: Arc<crate::infrastructure::ai::AIClient>,
    request_context: ModelRequestContext,
    tools: Option<Vec<ToolDefinition>>,
    reminders: PrependedPromptReminders,
    attach_images: bool,
    workspace: Option<WorkspaceBinding>,
    workspace_services: Option<crate::agentic::workspace::WorkspaceServices>,
    trace: Option<ModelExchangeTraceConfig>,
    request_identity: serde_json::Value,
}

impl CompressionJob {
    pub(super) fn spawn_prefetch(self, parent: &CancellationToken) -> PrefetchedCompression {
        self.spawn_prefetch_with(parent, |job| job.run())
    }

    pub(super) fn spawn_prefetch_with<F, Fut>(
        self,
        parent: &CancellationToken,
        work: F,
    ) -> PrefetchedCompression
    where
        F: FnOnce(Self) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = OpenBitFunResult<CompressionCandidate>> + Send + 'static,
    {
        let source_message_ids = ContextCompressor::canonical_conversation(&self.messages)
            .map(|message| message.id.clone())
            .collect();
        let request_identity = self.request_identity.clone();
        let observation = PrefetchObservation {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            started_at: std::time::Instant::now(),
            claimed: false,
        };
        info!(
            "Compression prefetch started: prefetch_id={}, session_id={}, turn_id={}, source_messages={}, recent_target_tokens={}",
            observation.id, observation.session_id, observation.turn_id,
            self.messages.len(), self.initial_recent
        );
        let id = observation.id.clone();
        let session_id = observation.session_id.clone();
        let turn_id = observation.turn_id.clone();
        let started_at = observation.started_at;
        PrefetchedCompression {
            source_message_ids,
            request_identity,
            observation,
            task: CompressionPrefetch::spawn(parent, async move {
                let result = work(self).await;
                // Do not log provider error bodies: they may contain user input.
                info!(
                    "Compression prefetch finished: prefetch_id={}, session_id={}, turn_id={}, outcome={}, duration_ms={}",
                    id, session_id, turn_id,
                    if result.is_ok() { "success" } else { "failed" },
                    elapsed_ms_u64(started_at)
                );
                result
            }),
        }
    }

    pub(super) fn request_identity(input: &CompressionModelSummaryInput<'_>) -> serde_json::Value {
        serde_json::json!({
            "model": input.ai_client.config,
            "route": input.model_request_context.prompt_cache_route_key,
            "output_schema": input.model_request_context.output_schema,
            "tools": input.tool_definitions,
            "reminders": input.prepended_prompt_reminders.ordered_reminders(),
            "images": input.primary_supports_image_understanding,
            "system": input.runtime_messages.iter()
                .take_while(|message| message.role == MessageRole::System)
                .map(|message| &message.content).collect::<Vec<_>>(),
        })
    }

    pub(super) fn new(
        compressor: Arc<ContextCompressor>,
        session_id: &str,
        context_window: usize,
        initial_recent: usize,
        input: CompressionModelSummaryInput<'_>,
    ) -> Self {
        let request_identity = Self::request_identity(&input);
        Self {
            compressor,
            session_id: session_id.into(),
            turn_id: input.dialog_turn_id.into(),
            messages: input.runtime_messages.to_vec(),
            context_window,
            initial_recent,
            client: input.ai_client,
            request_context: input.model_request_context.clone(),
            tools: input.tool_definitions.clone(),
            reminders: input.prepended_prompt_reminders.clone(),
            attach_images: input.primary_supports_image_understanding,
            workspace: input.workspace.cloned(),
            workspace_services: input.workspace_services.cloned(),
            trace: input.trace_config,
            request_identity,
        }
    }

    async fn request_summary(&self, messages: &[Message]) -> OpenBitFunResult<String> {
        let mut messages = ExecutionEngine::build_ai_messages_for_send(
            messages,
            &self.client.config.format,
            self.workspace.as_ref(),
            self.workspace_services.as_ref(),
            &self.turn_id,
            self.attach_images,
            &self.reminders.ordered_reminders(),
        )
        .await?;
        messages.push(AIMessage::user(self.compressor.build_compact_prompt()));
        super::super::compression_request::request_summary(
            self.client.clone(),
            messages,
            self.tools.clone(),
            &self.request_context,
            self.trace.clone(),
        )
        .await
    }

    pub(super) async fn run(self) -> OpenBitFunResult<CompressionCandidate> {
        let session_id = self.session_id.as_str();
        let dialog_turn_id = self.turn_id.as_str();
        let runtime_messages = self.messages.as_slice();
        let context_window = self.context_window;
        let mut recent_target = self
            .initial_recent
            .min(context_window.saturating_div(2).max(1));
        let mut previous_cutoff = None;

        for attempt in 0..ExecutionEngine::MAX_COMPRESSION_OVERFLOW_ATTEMPTS {
            let Some(plan) = self.compressor.plan_compression_for_turn(
                session_id,
                dialog_turn_id,
                runtime_messages,
                context_window,
                recent_target,
            )?
            else {
                return Err(OpenBitFunError::AIClient(
                    "Context compression has no eligible plan".to_string(),
                ));
            };
            if previous_cutoff.is_some_and(|cutoff| plan.cutoff_message_index >= cutoff) {
                return Err(OpenBitFunError::AIClient(
                    "Context compression cannot reduce the summary input further".to_string(),
                ));
            }
            previous_cutoff = Some(plan.cutoff_message_index);
            info!(
                "Compression context plan: session_id={}, turn_id={}, attempt={}/{}, retained_user_token_budget={}, retained_user_tokens={}, retained_user_messages={}, recent_target_tokens={}, recent_tail_tokens={}, cutoff_message_index={}, summary_messages={}, recent_tail_messages={}",
                session_id,
                dialog_turn_id,
                attempt + 1,
                ExecutionEngine::MAX_COMPRESSION_OVERFLOW_ATTEMPTS,
                plan.retained_user_token_budget,
                plan.retained_user_tokens,
                plan.retained_user_messages.len(),
                plan.recent_target_tokens,
                plan.recent_tail_tokens,
                plan.cutoff_message_index,
                plan.summary_messages.len(),
                plan.recent_tail_messages.len()
            );

            let summary_result = self.request_summary(&plan.summary_request_messages).await;

            match summary_result {
                Ok(summary) => {
                    return Ok(CompressionCandidate {
                        plan,
                        summary,
                        request_identity: self.request_identity.clone(),
                    });
                }
                Err(err) if err.is_recoverable_context_overflow() => {
                    warn!(
                        "Compression request exceeded provider context: session_id={}, turn_id={}, attempt={}/{}, recent_target_tokens={}, cutoff_message_index={}, next_recent_target_tokens={:?}, error={}",
                        session_id,
                        dialog_turn_id,
                        attempt + 1,
                        ExecutionEngine::MAX_COMPRESSION_OVERFLOW_ATTEMPTS,
                        plan.recent_target_tokens,
                        plan.cutoff_message_index,
                        plan.next_recent_target_tokens,
                        err
                    );
                    let can_retry = attempt + 1
                        < ExecutionEngine::MAX_COMPRESSION_OVERFLOW_ATTEMPTS
                        && plan.next_recent_target_tokens.is_some();
                    let next_recent_target = plan.next_recent_target_tokens;
                    if can_retry {
                        recent_target = recent_target
                            .saturating_add(ContextCompressor::RECENT_CONTEXT_RETRY_STEP_TOKENS)
                            .max(next_recent_target.expect("retry target checked above"));
                        continue;
                    }
                    return Err(compression_plan_error(err, attempt + 1));
                }
                Err(err) => return Err(compression_plan_error(err, attempt + 1)),
            }
        }

        unreachable!("compression planning returns a result or terminal error")
    }
}
