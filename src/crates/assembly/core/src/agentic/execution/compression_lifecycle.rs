//! Formal automatic compression lifecycle. This is the only automatic path
//! allowed to run hooks, publish product events and commit session context.

use super::*;

impl ExecutionEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn build_planned_compression_result(
        &self,
        session_id: &str,
        dialog_turn_id: &str,
        runtime_messages: &[Message],
        context_window: usize,
        compression_contract: Option<crate::agentic::core::CompressionContract>,
        ai_client: Arc<crate::infrastructure::ai::AIClient>,
        model_request_context: &ModelRequestContext,
        tool_definitions: &Option<Vec<ToolDefinition>>,
        prepended_prompt_reminders: &PrependedPromptReminders,
        primary_supports_image_understanding: bool,
        workspace: Option<&WorkspaceBinding>,
        workspace_services: Option<&crate::agentic::workspace::WorkspaceServices>,
        trace_config: Option<ModelExchangeTraceConfig>,
    ) -> OpenBitFunResult<Option<crate::agentic::session::CompressionResult>> {
        let job = compression_job::CompressionJob::new(
            self.context_compressor.clone(),
            session_id,
            context_window,
            ContextCompressor::DEFAULT_RECENT_CONTEXT_TOKENS,
            CompressionModelSummaryInput {
                ai_client,
                model_request_context,
                runtime_messages,
                dialog_turn_id,
                workspace,
                workspace_services,
                tool_definitions,
                prepended_prompt_reminders,
                primary_supports_image_understanding,
                trace_config,
            },
        );
        let candidate = job.run().await?;
        self.context_compressor
            .compress_plan_with_contract(
                session_id,
                candidate.plan,
                compression_contract,
                candidate.summary,
            )
            .map(Some)
    }

    /// Compress context, will emit compression events (Started, Completed, and Failed)
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn compress_messages(
        &self,
        session_id: &str,
        dialog_turn_id: &str,
        trigger: &str,
        runtime_messages: Vec<Message>,
        before_pressure: TokenPressureSnapshot,
        context_window: usize,
        ai_client: Arc<crate::infrastructure::ai::AIClient>,
        model_request_context: &ModelRequestContext,
        tool_definitions: &Option<Vec<ToolDefinition>>,
        system_prompt_message: Message,
        prepended_prompt_reminders: &PrependedPromptReminders,
        primary_supports_image_understanding: bool,
        compression_contract_limit: usize,
        workspace: Option<&WorkspaceBinding>,
        workspace_services: Option<&crate::agentic::workspace::WorkspaceServices>,
        prefetch: Option<PrefetchedCompression>,
    ) -> OpenBitFunResult<Option<(usize, Vec<Message>)>> {
        let mut session = self
            .session_manager
            .get_session(session_id)
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;

        // Record start time
        let start_time = std::time::Instant::now();

        let old_messages_len = runtime_messages.len();
        if !runtime_messages
            .iter()
            .any(|message| message.role != MessageRole::System)
        {
            return Ok(None);
        }
        // Generate compression ID
        let compression_id = format!("compression_{}", uuid::Uuid::new_v4());
        // Captured before `ai_client` is consumed by summary generation.
        let ai_client_model = ai_client.config.model.clone();

        let cancellation_token = self.round_executor.ensure_cancel_token(dialog_turn_id);
        // Latch the decision before hooks or any other await can change which
        // side of the formal threshold observes a published failure.
        let claim = prefetch.map(|task| {
            task.claim(&CompressionModelSummaryInput {
                ai_client: ai_client.clone(),
                model_request_context,
                runtime_messages: &runtime_messages,
                dialog_turn_id,
                workspace,
                workspace_services,
                tool_definitions,
                prepended_prompt_reminders,
                primary_supports_image_understanding,
                trace_config: None,
            })
        });
        let canonical_snapshot = self
            .session_manager
            .get_context_messages(session_id)
            .await?;
        let expected_last_turn = session.dialog_turn_ids.last().cloned();
        let planned_result = prepare_compression_cancellable(&cancellation_token, async {
            native_hooks::dispatch_pre_compact(
                Self::native_hook_facts(session_id, dialog_turn_id, workspace, &ai_client_model),
                trigger,
            )
            .await;

            // Emit compression started event
            self.emit_event(
                AgenticEvent::ContextCompressionStarted {
                    session_id: session_id.to_string(),
                    turn_id: dialog_turn_id.to_string(),
                    compression_id: compression_id.clone(),
                    trigger: trigger.to_string(),
                    tokens_before: before_pressure.total_tokens,
                    context_window,
                },
                EventPriority::Normal,
            )
            .await;

            // Execute compression
            let compression_contract = self
                .session_manager
                .compression_contract_for_session(session_id, compression_contract_limit);
            let model_exchange_trace_dir = self
                .session_manager
                .persistent_model_exchange_trace_dir(session_id)
                .await;
            let trace_config = prepare_model_exchange_trace_for_workspace(
                session_id,
                dialog_turn_id,
                workspace,
                model_exchange_trace_dir.as_deref(),
                ModelExchangeTraceOperation {
                    kind: "context_compression",
                    id: &compression_id,
                    trigger: Some(trigger),
                },
                ai_client.as_ref(),
            )
            .await;
            let candidate = match claim {
                Some(openbitfun_agent_runtime::compression_prefetch::PrefetchClaim::Ready(candidate)) => Some(candidate),
                Some(openbitfun_agent_runtime::compression_prefetch::PrefetchClaim::Waiting(task)) => {
                    Some(task.wait().await.map_err(|_| OpenBitFunError::AIClient(
                        "Compression prefetch worker stopped before publishing a result".into()
                    ))??)
                }
                _ => None,
            };
            let is_prefetched = candidate.is_some();
            let candidate = match candidate {
                Some(candidate) => candidate,
                None => CompressionJob::new(self.context_compressor.clone(), session_id,
                    context_window, ContextCompressor::DEFAULT_RECENT_CONTEXT_TOKENS,
                    CompressionModelSummaryInput {
                        ai_client: ai_client.clone(), model_request_context,
                        runtime_messages: &runtime_messages, dialog_turn_id, workspace, workspace_services,
                        tool_definitions, prepended_prompt_reminders, primary_supports_image_understanding,
                        trace_config: trace_config.clone(),
                    }).run().await?,
            };
            let boundary_turn_index = self.session_manager.get_turn_count(session_id).saturating_sub(1);
            let transcript = match self.session_manager.create_compression_transcript_reference(
                session_id, boundary_turn_index, &compression_id, trigger,
            ).await {
                Ok(reference) => reference,
                Err(error) => {
                    warn!("Failed to create automatic compression transcript: session_id={}, error={}", session_id, error);
                    None
                }
            };
            Ok((Some(candidate), is_prefetched, compression_contract, trace_config, transcript))
        })
        .await;
        // Only the owner commits. Rebase against the latest canonical suffix
        // under the append lock; never install the background snapshot's tail.
        let mut commit_guard = None;
        let planned_result = match planned_result {
            Err(error) => Err(error),
            Ok((mut candidate, mut is_prefetched, contract, trace_config, transcript)) => {
                async {
                    loop {
                        let guard = self
                            .session_manager
                            .acquire_session_mutation(session_id)
                            .await?;
                        if cancellation_token.is_cancelled()
                            || self
                                .session_manager
                                .get_session(session_id)
                                .is_none_or(|session| {
                                    session.dialog_turn_ids.last() != expected_last_turn.as_ref()
                                })
                        {
                            return Err(OpenBitFunError::Cancelled(
                                "Compression execution owner changed".into(),
                            ));
                        }
                        let mut latest_runtime = Vec::new();
                        let result = self.session_manager.transform_compression_context(
                            session_id,
                            |latest| {
                                latest_runtime = compression_job::merge_latest_context(
                                    &runtime_messages,
                                    &canonical_snapshot,
                                    latest,
                                )?;
                                let Some(candidate) = candidate.as_ref() else {
                                    return Ok((None, None));
                                };
                                let identity = CompressionJob::request_identity(
                                    &CompressionModelSummaryInput {
                                        ai_client: ai_client.clone(),
                                        model_request_context,
                                        runtime_messages: &latest_runtime,
                                        dialog_turn_id,
                                        workspace,
                                        workspace_services,
                                        tool_definitions,
                                        prepended_prompt_reminders,
                                        primary_supports_image_understanding,
                                        trace_config: None,
                                    },
                                );
                                if candidate.request_identity != identity {
                                    return Ok((None, None));
                                }
                                let Some(plan) = self.context_compressor.rebase_plan(
                                    candidate.plan.clone(),
                                    &latest_runtime,
                                    dialog_turn_id,
                                )?
                                else {
                                    return Ok((None, None));
                                };
                                let mut result =
                                    self.context_compressor.compress_plan_with_contract(
                                        session_id,
                                        plan,
                                        contract.clone(),
                                        candidate.summary.clone(),
                                    )?;
                                if let Some(reference) = transcript.as_ref() {
                                    self.context_compressor.append_transcript_reference(
                                        &mut result,
                                        &reference.uri,
                                        &reference.index_range,
                                    );
                                }
                                let mut preview = vec![system_prompt_message.clone()];
                                preview.extend(result.messages.clone());
                                let pressure = Self::estimate_auto_compression_pressure(
                                    &preview,
                                    tool_definitions.as_deref(),
                                    context_window,
                                    Self::compression_trigger_budget(
                                        context_window,
                                        ai_client.config.max_tokens,
                                    ),
                                    Self::prepended_reminder_tokens_for_pressure(
                                        &prepended_prompt_reminders.ordered_reminders(),
                                    ),
                                );
                                if is_prefetched && pressure.total_tokens >= pressure.input_limit {
                                    return Ok((None, None));
                                }
                                if cancellation_token.is_cancelled() {
                                    return Err(OpenBitFunError::Cancelled(
                                        "Context compaction cancelled".into(),
                                    ));
                                }
                                Ok((Some(result.messages.clone()), Some(result)))
                            },
                        )?;
                        if let Some(result) = result {
                            // Keep session mutations fenced through persistence
                            // and counter/cache updates.
                            commit_guard = Some(guard);
                            return Ok(Some(result));
                        }
                        drop(guard);
                        let job = CompressionJob::new(
                            self.context_compressor.clone(),
                            session_id,
                            context_window,
                            ContextCompressor::DEFAULT_RECENT_CONTEXT_TOKENS,
                            CompressionModelSummaryInput {
                                ai_client: ai_client.clone(),
                                model_request_context,
                                runtime_messages: &latest_runtime,
                                dialog_turn_id,
                                workspace,
                                workspace_services,
                                tool_definitions,
                                prepended_prompt_reminders,
                                primary_supports_image_understanding,
                                trace_config: trace_config.clone(),
                            },
                        );
                        candidate = Some(
                            prepare_compression_cancellable(&cancellation_token, job.run()).await?,
                        );
                        is_prefetched = false;
                    }
                }
                .await
            }
        };
        // Once the synchronous replacement wins admission, persistence must not
        // be dropped halfway through by cancellation.
        match planned_result {
            Ok(Some(compression_result)) => {
                self.session_manager
                    .persist_compression_context(session_id, &compression_result.messages)
                    .await;
                if self
                    .session_manager
                    .rebuild_skill_agent_listing_baseline_to_latest(session_id)
                    .await
                {
                    debug!(
                        "Rebuilt skill-agent listing baseline after compression: session_id={}",
                        session_id
                    );
                }
                self.session_manager
                    .invalidate_prompt_cache(
                        session_id,
                        crate::agentic::session::PromptCacheScope::All,
                        "context_compression_applied",
                    )
                    .await;
                let mut new_messages = vec![system_prompt_message];
                new_messages.extend(compression_result.messages);
                // Update session compression state
                session.compression_state.increment_compression_count();

                // Update session state
                let _ = self
                    .session_manager
                    .update_compression_state_locked(session_id, session.compression_state.clone())
                    .await;

                // Calculate duration
                let duration_ms = elapsed_ms_u64(start_time);

                // Recalculate tokens after compression
                let prepended_reminders = prepended_prompt_reminders.ordered_reminders();
                let prepended_reminder_tokens =
                    Self::prepended_reminder_tokens_for_pressure(&prepended_reminders);
                let after_pressure = Self::estimate_auto_compression_pressure(
                    &new_messages,
                    tool_definitions.as_deref(),
                    context_window,
                    CompressionTriggerBudget {
                        input_limit: before_pressure.input_limit,
                        output_reserve_tokens: before_pressure.output_reserve_tokens,
                        safety_reserve_tokens: before_pressure.safety_reserve_tokens,
                    },
                    prepended_reminder_tokens,
                );
                let compressed_tokens = after_pressure.total_tokens;
                let summary_source = "model";

                info!(
                    "Compression completed: session_id={}, turn_id={}, messages {} -> {}, total_tokens {} -> {}, system_tokens {} -> {}, tool_tokens {} -> {}, prepended_reminder_tokens {} -> {}, conversation_tokens {} -> {}, context_window={}, input_limit={}, output_reserve={}, safety_reserve={}, usage {:.3} -> {:.3}, compression_count={}, duration_ms={}, summary_source={}",
                    session_id,
                    dialog_turn_id,
                    old_messages_len,
                    new_messages.len(),
                    before_pressure.total_tokens,
                    after_pressure.total_tokens,
                    before_pressure.system_tokens,
                    after_pressure.system_tokens,
                    before_pressure.tool_tokens,
                    after_pressure.tool_tokens,
                    before_pressure.prepended_reminder_tokens,
                    after_pressure.prepended_reminder_tokens,
                    before_pressure.conversation_tokens,
                    after_pressure.conversation_tokens,
                    before_pressure.context_window,
                    before_pressure.input_limit,
                    before_pressure.output_reserve_tokens,
                    before_pressure.safety_reserve_tokens,
                    before_pressure.usage_ratio,
                    after_pressure.usage_ratio,
                    session.compression_state.compression_count,
                    duration_ms,
                    summary_source
                );

                // Event consumers may themselves acquire the mutation permit.
                // Finish context/state side effects before publishing completion.
                drop(commit_guard.take());
                // Emit compression completed event
                self.emit_event(
                    AgenticEvent::ContextCompressionCompleted {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        compression_count: session.compression_state.compression_count,
                        tokens_before: before_pressure.total_tokens,
                        tokens_after: compressed_tokens,
                        compression_ratio: if before_pressure.total_tokens == 0 {
                            1.0
                        } else {
                            (compressed_tokens as f64) / (before_pressure.total_tokens as f64)
                        },
                        duration_ms,
                        has_summary: true,
                        summary_source: summary_source.to_string(),
                        applied: true,
                    },
                    EventPriority::Normal,
                )
                .await;

                let _ = prepare_compression_cancellable(&cancellation_token, async {
                    native_hooks::dispatch_post_compact(
                        Self::native_hook_facts(
                            session_id,
                            dialog_turn_id,
                            workspace,
                            &ai_client_model,
                        ),
                        trigger,
                    )
                    .await;
                    Ok(())
                })
                .await;

                Ok(Some((compressed_tokens, new_messages)))
            }
            Ok(None) => Ok(None),
            Err(e) => {
                // Emit compression failed event
                self.emit_event(
                    AgenticEvent::ContextCompressionFailed {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        error: e.to_string(),
                    },
                    EventPriority::High,
                )
                .await;

                Err(manual_compaction_terminal_error(e))
            }
        }
    }
}
