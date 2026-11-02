//! Incremental, execution-host-owned repair of Router history from visible turns.

use super::history_source::RouterHistorySource;
use super::*;
use openbitfun_agent_runtime::router_context::RouterHistoryBatch;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, Weak};

#[derive(Clone)]
struct BootstrapUpdate {
    state: RouterContextState,
    done: bool,
    error: Option<String>,
}

pub(super) struct BootstrapHandle {
    updates: watch::Receiver<BootstrapUpdate>,
    base_sequence: u64,
    initial_ids: HashSet<String>,
}

struct BootstrapLease(watch::Sender<bool>, tokio_util::sync::CancellationToken);

fn claim_job(session_id: &str, cancel: tokio_util::sync::CancellationToken) -> Arc<BootstrapLease> {
    static JOBS: OnceLock<Mutex<HashMap<String, Weak<BootstrapLease>>>> = OnceLock::new();
    let mut jobs = JOBS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    jobs.retain(|_, job| job.strong_count() != 0);
    if let Some(previous) = jobs.get(session_id).and_then(Weak::upgrade) {
        previous.0.send_replace(false);
    }
    let lease = Arc::new(BootstrapLease(watch::channel(true).0, cancel));
    jobs.insert(session_id.into(), Arc::downgrade(&lease));
    lease
}

impl RoundRouterContext {
    pub(in crate::agentic::execution) fn history_source_unavailable(
        &mut self,
        visible_turn_ids: &[String],
    ) {
        if self.factory.config.summary_enabled && visible_turn_ids.len() > 1 {
            self.state.history_bootstrap = Some(
                openbitfun_agent_runtime::router_context::RouterHistoryBootstrap {
                    turn_ids: visible_turn_ids[..visible_turn_ids.len() - 1].to_vec(),
                    ..Default::default()
                },
            );
        }
    }

    pub(in crate::agentic::execution) fn set_history_cancellation(
        &mut self,
        token: tokio_util::sync::CancellationToken,
    ) {
        self.history_cancellation = token;
    }

    /// The source and visible lineage belong to the host executing this turn.
    pub(in crate::agentic::execution) fn prepare_history(
        &mut self,
        source: Arc<dyn RouterHistorySource>,
        visible_turn_ids: &[String],
        messages: &[Message],
    ) {
        self.history_turn_ids =
            visible_turn_ids[..visible_turn_ids.len().saturating_sub(1)].to_vec();
        self.history_source = Some(source);
        if self.history_turn_ids.is_empty() || !self.factory.config.summary_enabled {
            return;
        }
        if self.state.history_bootstrap.is_some()
            || self.state.omitted_through != 0
            || self.state.history_coverage != self.history_turn_ids
        {
            self.start_history_bootstrap(messages);
        }
    }

    fn start_history_bootstrap(&mut self, messages: &[Message]) {
        let Some(source) = self.history_source.clone() else {
            return;
        };
        let resume = self
            .state
            .history_bootstrap
            .as_ref()
            .is_some_and(|progress| {
                self.state.omitted_through == 0
                    && self.history_turn_ids.starts_with(&progress.turn_ids)
                    && progress.turn_cursor <= progress.turn_ids.len()
            });
        let mut rebuilding = if resume {
            self.state.clone()
        } else {
            // Keep sequence ordering above the damaged checkpoint. Only Router
            // projections are rebuilt; the original transcript is never changed.
            RouterContextState {
                session_id: self.state.session_id.clone(),
                dialog_turn_id: self.state.dialog_turn_id.clone(),
                task: self.state.task.clone(),
                next_sequence: self.state.next_sequence,
                summarized_through: self.state.next_sequence.saturating_sub(1),
                ..Default::default()
            }
        };
        let progress = rebuilding
            .history_bootstrap
            .get_or_insert_with(Default::default);
        progress.turn_ids = self.history_turn_ids.clone();
        progress.complete = false;
        let historical_turns = self
            .history_turn_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let initial_ids = messages
            .iter()
            .filter(|message| {
                // Durable backfill excludes this active turn. Only claim input
                // proven to belong to its historical source; recovered active
                // and unknown-turn messages must replay into the live suffix.
                message.role == MessageRole::System
                    || matches!(
                        message.metadata.semantic_kind,
                        Some(
                            MessageSemanticKind::CompressionSummary
                                | MessageSemanticKind::CompressionBoundaryMarker
                        )
                    )
                    || message
                        .metadata
                        .turn_id
                        .as_deref()
                        .is_some_and(|turn| historical_turns.contains(turn))
            })
            .map(|message| message.id.clone())
            .collect::<HashSet<_>>();
        let base_sequence = self.state.next_sequence;
        self.state = RouterContextState {
            session_id: rebuilding.session_id.clone(),
            dialog_turn_id: rebuilding.dialog_turn_id.clone(),
            task: rebuilding.task.clone(),
            next_sequence: base_sequence,
            summarized_through: base_sequence.saturating_sub(1),
            history_bootstrap: rebuilding.history_bootstrap.clone(),
            seen_message_ids: initial_ids.clone(),
            ..Default::default()
        };
        let (sender, updates) = watch::channel(BootstrapUpdate {
            state: rebuilding.clone(),
            done: false,
            error: None,
        });
        self.history_bootstrap = Some(BootstrapHandle {
            updates,
            base_sequence,
            initial_ids,
        });
        let factory = self.factory.clone();
        let checkpoint = self.session_checkpoint.clone();
        let root_session_id = self.root_session_id.clone();
        let lease = claim_job(&self.state.session_id, self.history_cancellation.clone());
        // This host-owned job may finish between turns. Every accepted chunk is
        // durable, and a successor execution cancels the previous generation.
        tokio::spawn(async move {
            let result = rebuild(
                &mut rebuilding,
                source,
                &factory,
                checkpoint.as_ref(),
                &root_session_id,
                &lease,
                &sender,
            )
            .await;
            if *lease.0.borrow() {
                let error = result.err().map(|error| error.to_string());
                if let Some(error) = &error {
                    warn!("Router history preparation failed; retaining resumable progress: session_id={}, error={error}", rebuilding.session_id);
                }
                sender.send_replace(BootstrapUpdate {
                    state: rebuilding,
                    done: true,
                    error,
                });
            }
        });
    }

    pub(super) fn poll_history_bootstrap(&mut self) {
        let Some(handle) = self.history_bootstrap.as_ref() else {
            return;
        };
        let update = handle.updates.borrow().clone();
        if !update.done {
            return;
        }
        if let Some(error) = update.error {
            // Keep the incomplete marker and accepted cursor for next-turn recovery.
            // Never clear a gap because a request merely returned some text.
            warn!("Router history is not ready; primary fallback remains active: {error}");
            return;
        }
        if self.state.omitted_through >= handle.base_sequence {
            // The live suffix itself outran the bounded observation buffer.
            // Recover it from durable source on a later execution, never certify it.
            return;
        }
        let mut ready = update.state;
        ready
            .seen_message_ids
            .extend(handle.initial_ids.iter().cloned());
        ready
            .seen_message_ids
            .extend(self.state.seen_message_ids.iter().cloned());
        ready.latest_user_updates = self.state.latest_user_updates.clone();
        for entry in &self.state.entries {
            if ready.observation_buffer_full() {
                // Preserve both sides until a subsequent source pass can cover
                // the larger suffix. Do not introduce a fresh gap while merging.
                return;
            }
            let mut entry = entry.clone();
            entry.sequence = ready.next_sequence;
            ready.next_sequence += 1;
            ready.entries.push_back(entry);
        }
        ready.observed_rounds += self.state.observed_rounds;
        ready.history_coverage = self.history_turn_ids.clone();
        ready.history_bootstrap = None;
        // Strictly newer than the worker's final publication, even with no delta.
        ready.next_sequence += 1;
        self.state = ready;
        self.history_bootstrap = None;
        self.last_attempt_round = None;
        self.checkpoint_revision = None;
        self.queue_save();
    }
}

async fn publish(
    state: &RouterContextState,
    checkpoint: Option<&SessionRouterCheckpoint>,
    updates: &watch::Sender<BootstrapUpdate>,
) -> OpenBitFunResult<()> {
    if let Some(checkpoint) = checkpoint {
        checkpoint.save(state).await?;
    }
    updates.send_replace(BootstrapUpdate {
        state: state.clone(),
        done: false,
        error: None,
    });
    Ok(())
}

async fn rebuild(
    state: &mut RouterContextState,
    source: Arc<dyn RouterHistorySource>,
    factory: &RouterContextFactory,
    checkpoint: Option<&SessionRouterCheckpoint>,
    root_session_id: &str,
    lease: &BootstrapLease,
    updates: &watch::Sender<BootstrapUpdate>,
) -> OpenBitFunResult<()> {
    let mut cancelled = lease.0.subscribe();
    let budget = factory
        .summary_provider
        .input_budget(&factory.config)
        .await?;
    publish(state, checkpoint, updates).await?;
    let mut batch = RouterHistoryBatch::new(state, budget);
    loop {
        if !*cancelled.borrow() || lease.1.is_cancelled() {
            return Err(OpenBitFunError::Session(
                "Router history preparation superseded or cancelled".into(),
            ));
        }
        let progress = state
            .history_bootstrap
            .as_ref()
            .expect("bootstrap source cursor");
        let Some(turn_id) = progress.turn_ids.get(progress.turn_cursor).cloned() else {
            break;
        };
        let observations = source.observations(&turn_id).await?;
        let start = progress.entry_cursor;
        if start > observations.len() {
            return Err(OpenBitFunError::Session(
                "Router history source changed before its saved cursor".into(),
            ));
        }
        for (index, observation) in observations.into_iter().enumerate().skip(start) {
            if !*cancelled.borrow() || lease.1.is_cancelled() {
                return Err(OpenBitFunError::Session(
                    "Router history preparation superseded or cancelled".into(),
                ));
            }
            // Historical import has its own model-token and serialized-byte
            // budget. Never route it through the live 128-entry eviction path.
            // Retry this exact observation after every accepted prefix; its
            // durable source cursor advances only once append succeeds.
            while !batch.try_append(
                state,
                &observation.source_id,
                observation.kind,
                &observation.content,
                factory.counter.as_ref(),
            ) {
                let recent = retained_recent(state, factory);
                summarize_prefix(
                    state,
                    factory,
                    &batch,
                    recent,
                    root_session_id,
                    &mut cancelled,
                    &lease.1,
                )
                .await?;
                publish(state, checkpoint, updates).await?;
                batch = RouterHistoryBatch::new(state, budget);
            }
            state.history_bootstrap.as_mut().unwrap().entry_cursor = index + 1;
        }
        let progress = state.history_bootstrap.as_mut().unwrap();
        progress.turn_cursor += 1;
        progress.entry_cursor = 0;
        publish(state, checkpoint, updates).await?;
    }
    // Consume the remaining older prefix. A short tail remains verbatim, and
    // an oversized tail is summarized too rather than silently clipped.
    loop {
        let prepared = state.prepare(
            factory.recent_rounds,
            factory.config.max_input_tokens,
            factory.counter.as_ref(),
        );
        let pending = state.pending_tokens(factory.recent_rounds);
        let pressure =
            prepared.input_tokens >= factory.config.max_input_tokens.saturating_mul(3) / 4;
        let feedback_prefix =
            state.observed_rounds == 0 && state.entries.len() > factory.recent_rounds;
        if pending == 0 && !pressure && !feedback_prefix && !state.observation_buffer_full() {
            break;
        }
        if state.entries.is_empty() {
            break;
        }
        let recent = if pending > 0 && !pressure {
            factory.recent_rounds
        } else {
            0
        };
        summarize_prefix(
            state,
            factory,
            &batch,
            recent,
            root_session_id,
            &mut cancelled,
            &lease.1,
        )
        .await?;
        publish(state, checkpoint, updates).await?;
    }
    state.history_bootstrap.as_mut().unwrap().complete = true;
    publish(state, checkpoint, updates).await
}

fn retained_recent(state: &RouterContextState, factory: &RouterContextFactory) -> usize {
    if state.pending_tokens(factory.recent_rounds) > 0 {
        factory.recent_rounds
    } else {
        0
    }
}

async fn summarize_prefix(
    state: &mut RouterContextState,
    factory: &RouterContextFactory,
    batch: &RouterHistoryBatch,
    recent_rounds: usize,
    root_session_id: &str,
    cancelled: &mut watch::Receiver<bool>,
    turn_cancel: &tokio_util::sync::CancellationToken,
) -> OpenBitFunResult<()> {
    // A legacy local tokenizer belongs to the Router, not the economy model.
    let work = batch.summary_work(state, recent_rounds)
        .ok_or_else(|| OpenBitFunError::Configuration("A Router history observation or its summary cannot fit in the summary model input budget".into()))?;
    let (_, ticket) = factory
        .summary_queue
        .submit_for(root_session_id, &state.session_id, work.clone())
        .map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
    if !*cancelled.borrow() {
        return Err(OpenBitFunError::Session(
            "Router history preparation superseded".into(),
        ));
    }
    let result = tokio::select! {
        biased;
        _ = turn_cancel.cancelled() => return Err(OpenBitFunError::cancelled("Router history preparation cancelled")),
        _ = cancelled.changed() => return Err(OpenBitFunError::Session("Router history preparation superseded".into())),
        result = async {
            let Some((work, _permit)) = ticket.start().await else {
                return Err(OpenBitFunError::Session("Router history summary superseded".into()));
            };
            tokio::time::timeout(factory.config.summary_timeout,
                summarize_bounded(factory.summary_provider.as_ref(), work.prompt, &factory.config,
                    Some(SummaryAttemptTrace {
                        path: factory.trace_path.as_ref(),
                        identity: json!({
                            "root_session_id": root_session_id, "session_id": state.session_id,
                            "dialog_turn_id": state.dialog_turn_id, "source": "history_bootstrap",
                            "base_through": work.base_through, "through": work.through,
                        }),
                    }))).await
                .map_err(|_| OpenBitFunError::AIClient("Router history summary timed out".into()))?
        } => result?,
    };
    if !result.complete {
        return Err(OpenBitFunError::AIClient(
            result.incomplete_error().unwrap_or_default(),
        ));
    }
    if !state.apply_summary(&work, &result.text) {
        return Err(OpenBitFunError::Session(
            "Router history summary no longer matches its prefix".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
