impl ChatMode {
    fn displayed_chat_state<'a>(&'a self, root: &'a ChatState) -> &'a ChatState {
        self.lineage_inspection
            .as_ref()
            .map(|inspection| &inspection.chat_state)
            .unwrap_or(root)
    }

    fn project_inspected_lineage_event(&mut self, event: &AgenticEvent) -> bool {
        let Some(event_session_id) = event.session_id() else {
            return false;
        };
        let Some(entry_index) = self.lineage_session_index.get(event_session_id).copied() else {
            return false;
        };
        if is_buffered_lineage_event(event)
            || matches!(event, AgenticEvent::SessionHistoryChanged { .. })
        {
            let generation = self
                .lineage_event_generations
                .entry(event_session_id.to_string())
                .or_default();
            *generation = generation.wrapping_add(1);
        }
        let Some(lineage_active_turn_id) = self
            .lineage_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.sessions.get(entry_index))
            .map(|entry| entry.active_turn_id.clone())
        else {
            return false;
        };
        match event {
            AgenticEvent::DialogTurnStarted { turn_id, .. } => {
                self.retain_lineage_events(event_session_id, Some(turn_id));
            }
            AgenticEvent::DialogTurnCompleted { .. }
            | AgenticEvent::DialogTurnFailed { .. }
            | AgenticEvent::DialogTurnCancelled { .. } => {
                let Some(turn_id) = event.turn_id() else {
                    return false;
                };
                let observed_turn = lineage_active_turn_id.as_deref() == Some(turn_id)
                    || self.lineage_event_buffer.iter().any(|buffered| {
                        buffered.event.session_id() == Some(event_session_id)
                            && buffered.event.turn_id() == Some(turn_id)
                    })
                    || self.lineage_inspection.as_ref().is_some_and(|inspection| {
                        inspection.selected_session_id == event_session_id
                            && inspection.chat_state.current_turn_id() == Some(turn_id)
                    });
                if observed_turn {
                    record_required_settled_lineage_turn(
                        &mut self.lineage_required_settled_turns,
                        event_session_id,
                        turn_id,
                    );
                }
            }
            _ => {}
        }
        let should_buffer = matches!(event, AgenticEvent::SystemError { .. })
            || (event.turn_id().is_some_and(|turn_id| {
                matches!(event, AgenticEvent::DialogTurnStarted { .. })
                    || lineage_active_turn_id.as_deref() == Some(turn_id)
            }) && is_buffered_lineage_event(event));
        if should_buffer {
            push_bounded_lineage_event(
                &mut self.lineage_event_buffer,
                &mut self.lineage_event_buffer_bytes,
                event,
                LINEAGE_EVENT_BUFFER_MAX_BYTES,
                LINEAGE_EVENT_BUFFER_MAX_EVENTS,
            );
        }
        if let Some(snapshot) = self.lineage_snapshot.as_mut() {
            update_lineage_active_turn(snapshot, &self.lineage_session_index, event);
        }
        let Some(inspection) = self
            .lineage_inspection
            .as_mut()
            .filter(|inspection| inspection.selected_session_id == event_session_id)
        else {
            return false;
        };

        let requires_authoritative_refresh = matches!(
            event,
            AgenticEvent::DialogTurnCompleted { .. }
                | AgenticEvent::DialogTurnFailed { .. }
                | AgenticEvent::DialogTurnCancelled { .. }
                | AgenticEvent::SessionHistoryChanged { .. }
        );
        let projection = project_transcript_event(&mut inspection.chat_state, event, false);
        if requires_authoritative_refresh {
            let now = Instant::now();
            inspection.refresh_pending = true;
            inspection.refresh_due_at = now + LINEAGE_SETTLEMENT_RETRY_MIN;
            inspection.refresh_deadline = Some(now + LINEAGE_SETTLEMENT_RETRY_WINDOW);
            inspection.refresh_retry_delay = LINEAGE_SETTLEMENT_RETRY_MIN;
        }
        projection.changed || requires_authoritative_refresh
    }

    fn show_session_lineage(
        &mut self,
        chat_view: &mut ChatView,
        root_chat_state: &ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if self.pending_lineage_operation.is_some() {
            chat_view.set_status(Some(
                "A subagent Session operation is already in progress".to_string(),
            ));
            return;
        }
        let root_session_id = self
            .lineage_snapshot
            .as_ref()
            .map(|snapshot| snapshot.root_session_id.as_str())
            .unwrap_or(&root_chat_state.core_session_id)
            .to_string();
        let agent = self.agent.clone();
        let task_root_session_id = root_session_id.clone();
        let handle =
            rt_handle.spawn(async move { agent.session_lineage(&task_root_session_id).await });
        self.pending_lineage_operation = Some(PendingLineageOperation::Query {
            root_session_id,
            handle,
        });
        chat_view.set_status(Some("Loading subagent Sessions...".to_string()));
    }

    fn inspect_lineage_session(
        &mut self,
        session_id: &str,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if matches!(
            self.pending_lineage_operation,
            Some(PendingLineageOperation::Inspect { refresh: true, .. })
        ) {
            if let Some(pending) = self.pending_lineage_operation.take() {
                pending.abort();
            }
        }
        if self.pending_lineage_operation.is_some() {
            chat_view.set_status(Some(
                "A subagent Session operation is already in progress".to_string(),
            ));
            return;
        }
        let Some(snapshot) = self.lineage_snapshot.as_ref() else {
            chat_view.set_status(Some("Reopen View subagents and try again".to_string()));
            return;
        };
        let Some(entry) = self
            .lineage_session_index
            .get(session_id)
            .and_then(|index| snapshot.sessions.get(*index))
            .cloned()
        else {
            chat_view.set_status(Some(
                "That subagent Session is no longer in the current lineage".to_string(),
            ));
            return;
        };
        if entry.session_id == snapshot.root_session_id {
            self.leave_lineage_inspection(chat_view);
            return;
        }
        let root_session_id = snapshot.root_session_id.clone();
        let required_settled_turn_ids = self
            .lineage_required_settled_turns
            .get(&entry.session_id)
            .cloned()
            .unwrap_or_default();
        let agent = self.agent.clone();
        let task_session_id = entry.session_id.clone();
        let event_generation = self.lineage_event_generation(&task_session_id);
        let handle = rt_handle.spawn(async move {
            agent
                .inspect_lineage_session(
                    &root_session_id,
                    &task_session_id,
                    &required_settled_turn_ids,
                )
                .await
                .map_err(LineageInspectionTaskError::Runtime)
        });
        self.pending_lineage_operation = Some(PendingLineageOperation::Inspect {
            entry,
            refresh: false,
            event_generation,
            handle,
        });
        chat_view.set_status(Some("Loading subagent transcript...".to_string()));
    }

    fn refresh_inspected_lineage_if_due(
        &mut self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> bool {
        if self.pending_lineage_operation.is_some() {
            return false;
        }
        let now = Instant::now();
        let Some(selected_session_id) = self.lineage_inspection.as_ref().and_then(|inspection| {
            (inspection.refresh_pending && inspection.refresh_due_at <= now)
                .then(|| inspection.selected_session_id.clone())
        }) else {
            return false;
        };
        let Some(snapshot) = self.lineage_snapshot.as_ref() else {
            return false;
        };
        let root_session_id = snapshot.root_session_id.clone();
        let Some(entry) = self
            .lineage_session_index
            .get(&selected_session_id)
            .and_then(|index| snapshot.sessions.get(*index))
            .cloned()
        else {
            if let Some(inspection) = self.lineage_inspection.as_mut() {
                inspection.refresh_pending = false;
            }
            chat_view.set_status(Some(
                "The inspected subagent is no longer in this lineage".to_string(),
            ));
            return true;
        };
        let Some(deadline) = self
            .lineage_inspection
            .as_ref()
            .and_then(|inspection| inspection.refresh_deadline)
        else {
            return false;
        };
        if now >= deadline {
            if let Some(inspection) = self.lineage_inspection.as_mut() {
                inspection.refresh_pending = false;
                inspection.refresh_deadline = None;
            }
            chat_view.set_status(Some(
                "The subagent transcript is still settling; reopen View subagents to retry"
                    .to_string(),
            ));
            return true;
        }
        let required_settled_turn_ids = self
            .lineage_required_settled_turns
            .get(&selected_session_id)
            .cloned()
            .unwrap_or_default();
        let agent = self.agent.clone();
        let timeout = deadline.saturating_duration_since(now);
        let task_session_id = selected_session_id.clone();
        let handle = rt_handle.spawn(async move {
            match tokio::time::timeout(
                timeout,
                agent.inspect_lineage_session(
                    &root_session_id,
                    &task_session_id,
                    &required_settled_turn_ids,
                ),
            )
            .await
            {
                Ok(result) => result.map_err(LineageInspectionTaskError::Runtime),
                Err(_) => Err(LineageInspectionTaskError::Deadline),
            }
        });
        self.pending_lineage_operation = Some(PendingLineageOperation::Inspect {
            entry,
            refresh: true,
            event_generation: self.lineage_event_generation(&selected_session_id),
            handle,
        });
        false
    }

    fn poll_lineage_operation_completion(
        &mut self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> bool {
        let cancellation_changed = self.poll_lineage_cancellation_completion(chat_view, rt_handle);
        let Some(pending) = self.pending_lineage_operation.as_ref() else {
            return cancellation_changed;
        };
        if !pending.is_finished() {
            return cancellation_changed;
        }
        let pending = self
            .pending_lineage_operation
            .take()
            .expect("finished lineage operation should remain present");
        match pending {
            PendingLineageOperation::Query {
                root_session_id,
                handle,
            } => match tokio::task::block_in_place(|| rt_handle.block_on(handle)) {
                Ok(Ok(Some(snapshot)))
                    if snapshot.root_session_id == root_session_id
                        && snapshot
                            .sessions
                            .iter()
                            .any(|entry| entry.session_id != snapshot.root_session_id) =>
                {
                    self.lineage_session_index = lineage_session_index(&snapshot);
                    chat_view.show_session_lineage_selector(&snapshot);
                    chat_view.set_status(Some(
                        "Select a subagent Session to inspect its transcript".to_string(),
                    ));
                    self.lineage_snapshot = Some(snapshot);
                }
                Ok(Ok(_)) => {
                    self.lineage_snapshot = None;
                    self.lineage_session_index.clear();
                    chat_view.set_status(Some(
                        "No subagent Sessions are available for this conversation".to_string(),
                    ));
                }
                Ok(Err(error)) => {
                    chat_view.set_status(Some(format!("Could not load subagents: {error}")))
                }
                Err(error) => {
                    chat_view.set_status(Some(format!("Subagent Session loading stopped: {error}")))
                }
            },
            PendingLineageOperation::Inspect {
                entry,
                refresh,
                event_generation,
                handle,
            } => match tokio::task::block_in_place(|| rt_handle.block_on(handle)) {
                Ok(Ok(inspection)) => self.apply_lineage_inspection(
                    entry,
                    inspection,
                    refresh,
                    event_generation,
                    chat_view,
                ),
                Ok(Err(error)) => self.apply_lineage_inspection_error(
                    entry,
                    refresh,
                    event_generation,
                    error,
                    chat_view,
                ),
                Err(error) => {
                    if !lineage_inspection_result_is_current(
                        &entry.session_id,
                        event_generation,
                        &self.lineage_event_generations,
                    ) {
                        self.handle_stale_lineage_inspection(&entry, refresh, chat_view);
                    } else {
                        if let Some(current) = self.lineage_inspection.as_mut().filter(|current| {
                            refresh && current.selected_session_id == entry.session_id
                        }) {
                            current.refresh_pending = false;
                            current.refresh_deadline = None;
                        }
                        chat_view.set_status(Some(format!(
                            "Subagent transcript loading stopped: {error}"
                        )));
                    }
                }
            },
        }
        true
    }

    fn poll_lineage_cancellation_completion(
        &mut self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) -> bool {
        let Some(pending) = self.pending_lineage_cancellation.as_ref() else {
            return false;
        };
        if !pending.handle.is_finished() {
            return false;
        }
        let pending = self
            .pending_lineage_cancellation
            .take()
            .expect("finished lineage cancellation should remain present");
        let result = tokio::task::block_in_place(|| rt_handle.block_on(pending.handle));
        let belongs_to_current_navigation = lineage_cancellation_result_is_current(
            pending.navigation_generation,
            self.lineage_navigation_generation,
            &pending.root_session_id,
            self.lineage_snapshot
                .as_ref()
                .map(|snapshot| snapshot.root_session_id.as_str()),
            &pending.session_id,
            self.lineage_inspection
                .as_ref()
                .map(|inspection| inspection.selected_session_id.as_str()),
        );
        if !belongs_to_current_navigation {
            return false;
        }
        match result {
            Ok(Ok(result)) if result.requested => chat_view.set_status(Some(format!(
                "Interrupt requested for subagent Session {}",
                pending.session_id
            ))),
            Ok(Ok(_)) => chat_view.set_status(Some("The subagent has no active turn".to_string())),
            Ok(Err(error)) => chat_view.set_status(Some(format!(
                "Could not interrupt subagent Session: {error}"
            ))),
            Err(error) => {
                chat_view.set_status(Some(format!("Subagent interruption stopped: {error}")))
            }
        }
        true
    }

    fn apply_lineage_inspection(
        &mut self,
        entry: AgentSessionLineageEntry,
        inspection: AgentSessionLineageInspection,
        refresh: bool,
        event_generation: u64,
        chat_view: &mut ChatView,
    ) {
        if !lineage_inspection_result_is_current(
            &entry.session_id,
            event_generation,
            &self.lineage_event_generations,
        ) {
            self.handle_stale_lineage_inspection(&entry, refresh, chat_view);
            return;
        }
        if refresh
            && self
                .lineage_inspection
                .as_ref()
                .is_none_or(|current| current.selected_session_id != entry.session_id)
        {
            return;
        }
        let active_turn_id = inspection.active_turn_id.clone();
        let state = self.build_authoritative_lineage_state(&entry, inspection);
        if let Some(index) = self.lineage_session_index.get(&entry.session_id).copied() {
            if let Some(snapshot_entry) = self
                .lineage_snapshot
                .as_mut()
                .and_then(|snapshot| snapshot.sessions.get_mut(index))
            {
                snapshot_entry.active_turn_id = active_turn_id.clone();
            }
        }
        self.lineage_required_settled_turns
            .remove(&entry.session_id);
        let now = Instant::now();
        self.lineage_inspection = Some(AgentSessionInspection {
            selected_session_id: entry.session_id.clone(),
            chat_state: state,
            refresh_pending: false,
            refresh_due_at: now,
            refresh_deadline: None,
            refresh_retry_delay: LINEAGE_SETTLEMENT_RETRY_MIN,
        });
        self.retain_lineage_events(&entry.session_id, active_turn_id.as_deref());
        chat_view.set_lineage_inspection(Some(entry.agent_id.unwrap_or(entry.session_name)));
        chat_view.invalidate_lines_cache();
        chat_view.set_status(Some(
            "Read-only subagent transcript; root input remains preserved".to_string(),
        ));
    }

    fn apply_lineage_inspection_error(
        &mut self,
        entry: AgentSessionLineageEntry,
        refresh: bool,
        event_generation: u64,
        error: LineageInspectionTaskError,
        chat_view: &mut ChatView,
    ) {
        if !lineage_inspection_result_is_current(
            &entry.session_id,
            event_generation,
            &self.lineage_event_generations,
        ) {
            self.handle_stale_lineage_inspection(&entry, refresh, chat_view);
            return;
        }
        if error.outcome_unknown() {
            if refresh {
                self.schedule_lineage_consistency_retry(&entry.session_id, chat_view);
            } else {
                self.open_provisional_lineage_inspection(&entry, chat_view);
            }
            return;
        }
        if let Some(current) = self
            .lineage_inspection
            .as_mut()
            .filter(|current| refresh && current.selected_session_id == entry.session_id)
        {
            current.refresh_pending = false;
            current.refresh_deadline = None;
        }
        let operation = if refresh { "refresh" } else { "inspect" };
        chat_view.set_status(Some(format!(
            "Could not {operation} subagent Session: {error}"
        )));
    }

    fn handle_stale_lineage_inspection(
        &mut self,
        entry: &AgentSessionLineageEntry,
        refresh: bool,
        chat_view: &mut ChatView,
    ) {
        if !refresh {
            self.open_provisional_lineage_inspection(entry, chat_view);
            return;
        }
        let now = Instant::now();
        let Some(current) = self
            .lineage_inspection
            .as_mut()
            .filter(|current| current.selected_session_id == entry.session_id)
        else {
            return;
        };
        current.refresh_pending = true;
        current.refresh_due_at = now + LINEAGE_SETTLEMENT_RETRY_MIN;
        current
            .refresh_deadline
            .get_or_insert(now + LINEAGE_SETTLEMENT_RETRY_WINDOW);
        chat_view.set_status(Some(
            "Waiting for newer subagent transcript state".to_string(),
        ));
    }

    fn lineage_event_generation(&self, session_id: &str) -> u64 {
        self.lineage_event_generations
            .get(session_id)
            .copied()
            .unwrap_or_default()
    }

    fn schedule_lineage_consistency_retry(&mut self, session_id: &str, chat_view: &mut ChatView) {
        let now = Instant::now();
        let Some(current) = self
            .lineage_inspection
            .as_mut()
            .filter(|current| current.selected_session_id == session_id)
        else {
            return;
        };
        if current
            .refresh_deadline
            .is_some_and(|deadline| now < deadline)
        {
            let delay = current.refresh_retry_delay;
            current.refresh_pending = true;
            current.refresh_due_at = now + delay;
            current.refresh_retry_delay =
                std::cmp::min(delay.saturating_mul(2), LINEAGE_SETTLEMENT_RETRY_MAX);
            return;
        }
        current.refresh_pending = false;
        current.refresh_deadline = None;
        chat_view.set_status(Some(
            "The subagent transcript is still settling; reopen View subagents to retry".to_string(),
        ));
    }

    fn open_provisional_lineage_inspection(
        &mut self,
        entry: &AgentSessionLineageEntry,
        chat_view: &mut ChatView,
    ) {
        let now = Instant::now();
        let events = self.buffered_lineage_session_events(&entry.session_id);
        let state = build_provisional_lineage_chat_state(entry, &events);
        self.lineage_inspection = Some(AgentSessionInspection {
            selected_session_id: entry.session_id.clone(),
            chat_state: state,
            refresh_pending: true,
            refresh_due_at: now + LINEAGE_SETTLEMENT_RETRY_MIN,
            refresh_deadline: Some(now + LINEAGE_SETTLEMENT_RETRY_WINDOW),
            refresh_retry_delay: LINEAGE_SETTLEMENT_RETRY_MIN,
        });
        chat_view.set_lineage_inspection(Some(
            entry
                .agent_id
                .clone()
                .unwrap_or_else(|| entry.session_name.clone()),
        ));
        chat_view.invalidate_lines_cache();
        chat_view.set_status(Some(
            "Waiting for the subagent transcript to settle".to_string(),
        ));
    }

    fn build_authoritative_lineage_state(
        &self,
        entry: &AgentSessionLineageEntry,
        inspection: AgentSessionLineageInspection,
    ) -> ChatState {
        let active_turn_id = inspection.active_turn_id.clone();
        let mut active_events = Vec::new();
        let mut session_events = Vec::new();
        for buffered in &self.lineage_event_buffer {
            if buffered.event.session_id() != Some(entry.session_id.as_str()) {
                continue;
            }
            let Some(turn_id) = buffered.event.turn_id() else {
                session_events.push(buffered.event.clone());
                continue;
            };
            if active_turn_id.as_deref() == Some(turn_id) {
                active_events.push(buffered.event.clone());
            }
        }
        let mut authoritative = build_lineage_chat_state(entry, inspection, &active_events);
        for event in &session_events {
            project_transcript_event(&mut authoritative, event, false);
        }
        authoritative
    }

    fn leave_lineage_inspection(&mut self, chat_view: &mut ChatView) {
        if matches!(
            self.pending_lineage_operation,
            Some(PendingLineageOperation::Inspect { refresh: true, .. })
        ) {
            if let Some(pending) = self.pending_lineage_operation.take() {
                pending.abort();
            }
        }
        if self.lineage_inspection.take().is_some() {
            chat_view.set_lineage_inspection(None);
            chat_view.invalidate_lines_cache();
            chat_view.set_status(Some("Returned to the root conversation".to_string()));
        }
    }

    fn cancel_pending_lineage_load(&mut self, chat_view: &mut ChatView) -> bool {
        let should_cancel = matches!(
            self.pending_lineage_operation,
            Some(PendingLineageOperation::Query { .. })
                | Some(PendingLineageOperation::Inspect { refresh: false, .. })
        );
        if !should_cancel {
            return false;
        }
        if let Some(pending) = self.pending_lineage_operation.take() {
            pending.abort();
        }
        chat_view.set_status(Some("Subagent Session loading cancelled".to_string()));
        true
    }

    fn buffered_lineage_session_events(&self, session_id: &str) -> Vec<AgenticEvent> {
        self.lineage_event_buffer
            .iter()
            .filter(|buffered| buffered.event.session_id() == Some(session_id))
            .map(|buffered| buffered.event.clone())
            .collect()
    }

    fn retain_lineage_events(&mut self, session_id: &str, active_turn_id: Option<&str>) {
        let retained_turn_ids = self
            .lineage_required_settled_turns
            .get(session_id)
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        self.lineage_event_buffer.retain(|buffered| {
            buffered.event.session_id() != Some(session_id)
                || buffered.event.turn_id().is_none()
                || buffered.event.turn_id().is_some_and(|turn_id| {
                    active_turn_id == Some(turn_id) || retained_turn_ids.contains(turn_id)
                })
        });
        self.lineage_event_buffer_bytes = self
            .lineage_event_buffer
            .iter()
            .map(|buffered| buffered.encoded_bytes)
            .sum();
    }

    fn reset_lineage_navigation(&mut self, chat_view: &mut ChatView) {
        if matches!(
            self.pending_lineage_operation,
            Some(PendingLineageOperation::Query { .. })
                | Some(PendingLineageOperation::Inspect { .. })
        ) {
            if let Some(pending) = self.pending_lineage_operation.take() {
                pending.abort();
            }
        }
        self.lineage_snapshot = None;
        self.lineage_session_index.clear();
        self.lineage_inspection = None;
        self.lineage_event_buffer.clear();
        self.lineage_event_buffer_bytes = 0;
        self.lineage_event_generations.clear();
        self.lineage_navigation_generation = self.lineage_navigation_generation.wrapping_add(1);
        self.lineage_required_settled_turns.clear();
        chat_view.set_lineage_inspection(None);
    }

    fn navigate_lineage_parent(
        &mut self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let Some(selected_session_id) = self
            .lineage_inspection
            .as_ref()
            .map(|inspection| inspection.selected_session_id.clone())
        else {
            return;
        };
        let Some(snapshot) = self.lineage_snapshot.as_ref() else {
            self.leave_lineage_inspection(chat_view);
            return;
        };
        let parent_session_id = lineage_parent_session_id(snapshot, &selected_session_id);
        match parent_session_id {
            Some(parent) if parent != snapshot.root_session_id => {
                self.inspect_lineage_session(&parent, chat_view, rt_handle)
            }
            _ => self.leave_lineage_inspection(chat_view),
        }
    }

    fn navigate_lineage_sibling(
        &mut self,
        offset: isize,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let Some(selected_session_id) = self
            .lineage_inspection
            .as_ref()
            .map(|inspection| inspection.selected_session_id.clone())
        else {
            return;
        };
        let Some(snapshot) = self.lineage_snapshot.as_ref() else {
            return;
        };
        let Some(next_session_id) =
            lineage_sibling_session_id(snapshot, &selected_session_id, offset)
        else {
            chat_view.set_status(Some("This subagent has no sibling Session".to_string()));
            return;
        };
        self.inspect_lineage_session(&next_session_id, chat_view, rt_handle);
    }

    fn cancel_inspected_lineage_session(
        &mut self,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if matches!(
            self.pending_lineage_operation,
            Some(PendingLineageOperation::Inspect { refresh: true, .. })
        ) {
            if let Some(pending) = self.pending_lineage_operation.take() {
                pending.abort();
            }
        }
        if self.pending_lineage_operation.is_some() {
            chat_view.set_status(Some(
                "A subagent Session operation is already in progress".to_string(),
            ));
            return;
        }
        if self.pending_lineage_cancellation.is_some() {
            chat_view.set_status(Some(
                "A subagent interruption is already in progress".to_string(),
            ));
            return;
        }
        let (Some(snapshot), Some(inspection)) = (
            self.lineage_snapshot.as_ref(),
            self.lineage_inspection.as_ref(),
        ) else {
            return;
        };
        let agent = self.agent.clone();
        let root_session_id = snapshot.root_session_id.clone();
        let task_root_session_id = root_session_id.clone();
        let session_id = inspection.selected_session_id.clone();
        let Some(expected_active_turn_id) = self
            .lineage_session_index
            .get(&session_id)
            .and_then(|index| snapshot.sessions.get(*index))
            .and_then(|entry| entry.active_turn_id.clone())
        else {
            chat_view.set_status(Some("The subagent has no active turn".to_string()));
            return;
        };
        let task_session_id = session_id.clone();
        let handle = rt_handle.spawn(async move {
            agent
                .cancel_lineage_session(
                    &task_root_session_id,
                    &task_session_id,
                    &expected_active_turn_id,
                )
                .await
        });
        self.pending_lineage_cancellation = Some(PendingLineageCancellation {
            root_session_id,
            session_id,
            navigation_generation: self.lineage_navigation_generation,
            handle,
        });
        chat_view.set_status(Some("Requesting subagent interruption...".to_string()));
    }
}

fn is_buffered_lineage_event(event: &AgenticEvent) -> bool {
    matches!(
        event,
        AgenticEvent::DialogTurnStarted { .. }
            | AgenticEvent::DialogTurnCompleted { .. }
            | AgenticEvent::DialogTurnFailed { .. }
            | AgenticEvent::DialogTurnCancelled { .. }
            | AgenticEvent::TextChunk { .. }
            | AgenticEvent::ThinkingChunk { .. }
            | AgenticEvent::ToolEvent { .. }
            | AgenticEvent::UserSteeringInjected { .. }
            | AgenticEvent::ContextCompressionStarted { .. }
            | AgenticEvent::ContextCompressionCompleted { .. }
            | AgenticEvent::ContextCompressionFailed { .. }
            | AgenticEvent::TokenUsageUpdated { .. }
            | AgenticEvent::SystemError { .. }
    )
}

fn record_required_settled_lineage_turn(
    required_turns: &mut BTreeMap<String, Vec<String>>,
    session_id: &str,
    turn_id: &str,
) {
    let session_turns = required_turns.entry(session_id.to_string()).or_default();
    if session_turns.iter().any(|required| required == turn_id) {
        return;
    }
    session_turns.push(turn_id.to_string());
    if session_turns.len() > LINEAGE_READ_BARRIER_MAX_TURNS_PER_SESSION {
        session_turns.remove(0);
    }
}

fn lineage_inspection_result_is_current(
    session_id: &str,
    request_generation: u64,
    current_generations: &HashMap<String, u64>,
) -> bool {
    request_generation
        == current_generations
            .get(session_id)
            .copied()
            .unwrap_or_default()
}

fn lineage_cancellation_result_is_current(
    request_navigation_generation: u64,
    current_navigation_generation: u64,
    request_root_session_id: &str,
    current_root_session_id: Option<&str>,
    request_session_id: &str,
    current_selected_session_id: Option<&str>,
) -> bool {
    request_navigation_generation == current_navigation_generation
        && current_root_session_id == Some(request_root_session_id)
        && current_selected_session_id == Some(request_session_id)
}

fn push_bounded_lineage_event(
    buffer: &mut VecDeque<BufferedLineageEvent>,
    encoded_bytes: &mut usize,
    event: &AgenticEvent,
    max_bytes: usize,
    max_events: usize,
) {
    let Ok(serialized) = serde_json::to_vec(event) else {
        return;
    };
    let event_bytes = serialized.len();
    if event_bytes > max_bytes || max_events == 0 {
        return;
    }
    while !buffer.is_empty()
        && (buffer.len() >= max_events || encoded_bytes.saturating_add(event_bytes) > max_bytes)
    {
        if let Some(removed) = buffer.pop_front() {
            *encoded_bytes = encoded_bytes.saturating_sub(removed.encoded_bytes);
        }
    }
    buffer.push_back(BufferedLineageEvent {
        event: event.clone(),
        encoded_bytes: event_bytes,
    });
    *encoded_bytes = encoded_bytes.saturating_add(event_bytes);
}

fn build_provisional_lineage_chat_state(
    entry: &AgentSessionLineageEntry,
    replay_events: &[AgenticEvent],
) -> ChatState {
    let transcript = SessionTranscript {
        session_id: entry.session_id.clone(),
        messages: Vec::new(),
    };
    let mut state = ChatState::from_session_transcript(
        entry.session_id.clone(),
        entry
            .agent_id
            .clone()
            .unwrap_or_else(|| entry.session_name.clone()),
        entry.agent_type.clone(),
        entry.workspace_path.clone(),
        &transcript,
    );
    for event in replay_events {
        project_transcript_event(&mut state, event, false);
    }
    state
}

fn build_lineage_chat_state(
    entry: &AgentSessionLineageEntry,
    mut inspection: AgentSessionLineageInspection,
    replay_events: &[AgenticEvent],
) -> ChatState {
    let active_turn_id = inspection.active_turn_id.clone();
    let observed_start = active_turn_id.as_deref().is_some_and(|turn_id| {
        replay_events.iter().any(|event| {
            matches!(
                event,
                AgenticEvent::DialogTurnStarted {
                    turn_id: event_turn_id,
                    ..
                } if event_turn_id == turn_id
            )
        })
    });
    if observed_start {
        inspection
            .transcript
            .messages
            .retain(|message| message.turn_id.as_deref() != active_turn_id.as_deref());
    }
    let mut state = ChatState::from_session_transcript(
        entry.session_id.clone(),
        entry
            .agent_id
            .clone()
            .unwrap_or_else(|| entry.session_name.clone()),
        entry.agent_type.clone(),
        entry.workspace_path.clone(),
        &inspection.transcript,
    );
    state.reconcile_transcript_turn_events(active_turn_id.as_deref());
    if let Some(turn_id) = active_turn_id.as_deref() {
        if !observed_start {
            state.resume_transcript_turn(turn_id);
        }
        for event in replay_events {
            project_transcript_event(&mut state, event, false);
        }
    }
    state
}

fn lineage_session_index(snapshot: &AgentSessionLineageSnapshot) -> HashMap<String, usize> {
    snapshot
        .sessions
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.session_id.clone(), index))
        .collect()
}

fn update_lineage_active_turn(
    snapshot: &mut AgentSessionLineageSnapshot,
    session_index: &HashMap<String, usize>,
    event: &AgenticEvent,
) {
    let Some(session_id) = event.session_id() else {
        return;
    };
    let Some(entry) = session_index
        .get(session_id)
        .and_then(|index| snapshot.sessions.get_mut(*index))
    else {
        return;
    };

    match event {
        AgenticEvent::DialogTurnStarted { turn_id, .. } => {
            entry.active_turn_id = Some(turn_id.clone());
        }
        AgenticEvent::DialogTurnCompleted { turn_id, .. }
        | AgenticEvent::DialogTurnFailed { turn_id, .. }
        | AgenticEvent::DialogTurnCancelled { turn_id, .. }
            if entry.active_turn_id.as_deref() == Some(turn_id.as_str()) =>
        {
            entry.active_turn_id = None;
        }
        _ => {}
    }
}

fn lineage_parent_session_id(
    snapshot: &AgentSessionLineageSnapshot,
    selected_session_id: &str,
) -> Option<String> {
    snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == selected_session_id)
        .and_then(|entry| entry.parent_session_id.clone())
}

fn lineage_sibling_session_id(
    snapshot: &AgentSessionLineageSnapshot,
    selected_session_id: &str,
    offset: isize,
) -> Option<String> {
    let parent = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == selected_session_id)?
        .parent_session_id
        .as_deref();
    let siblings = snapshot
        .sessions
        .iter()
        .filter(|entry| {
            entry.session_id != snapshot.root_session_id
                && entry.parent_session_id.as_deref() == parent
        })
        .map(|entry| entry.session_id.as_str())
        .collect::<Vec<_>>();
    if siblings.len() < 2 {
        return None;
    }
    let index = siblings
        .iter()
        .position(|session_id| *session_id == selected_session_id)?;
    let next = (index as isize + offset).rem_euclid(siblings.len() as isize) as usize;
    Some(siblings[next].to_string())
}

#[cfg(test)]
mod session_lineage_tests {
    use openbitfun_events::AgenticEvent;
    use openbitfun_runtime_ports::{
        AgentSessionLifecycleStatus, AgentSessionLineageEntry, AgentSessionLineageInspection,
        AgentSessionLineageSnapshot, SessionTranscript, TranscriptContent, TranscriptMessage,
    };

    use crate::chat_state::{FlowItem, MessageRole};
    use std::collections::{BTreeMap, HashMap, VecDeque};

    use super::{
        build_lineage_chat_state, lineage_cancellation_result_is_current,
        lineage_inspection_result_is_current, lineage_parent_session_id, lineage_session_index,
        lineage_sibling_session_id, project_transcript_event, push_bounded_lineage_event,
        record_required_settled_lineage_turn, update_lineage_active_turn, BufferedLineageEvent,
        LINEAGE_READ_BARRIER_MAX_TURNS_PER_SESSION,
    };

    fn entry(id: &str, parent: Option<&str>) -> AgentSessionLineageEntry {
        AgentSessionLineageEntry {
            session_id: id.to_string(),
            session_name: id.to_string(),
            agent_type: "explore".to_string(),
            created_at_ms: 1,
            status: AgentSessionLifecycleStatus::Completed,
            active_turn_id: None,
            parent_session_id: parent.map(str::to_string),
            parent_tool_call_id: None,
            subagent_type: Some("explore".to_string()),
            agent_id: Some(id.to_string()),
            workspace_id: None,
            workspace_path: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            unread_completion: None,
            needs_user_attention: None,
        }
    }

    fn snapshot() -> AgentSessionLineageSnapshot {
        AgentSessionLineageSnapshot {
            root_session_id: "root".to_string(),
            sessions: vec![
                entry("root", None),
                entry("first", Some("root")),
                entry("nested", Some("first")),
                entry("second", Some("root")),
            ],
        }
    }

    #[test]
    fn parent_navigation_returns_the_authoritative_parent() {
        let snapshot = snapshot();

        assert_eq!(
            lineage_parent_session_id(&snapshot, "nested").as_deref(),
            Some("first")
        );
        assert_eq!(
            lineage_parent_session_id(&snapshot, "first").as_deref(),
            Some("root")
        );
    }

    #[test]
    fn sibling_navigation_wraps_without_treating_root_as_a_child() {
        let snapshot = snapshot();

        assert_eq!(
            lineage_sibling_session_id(&snapshot, "first", 1).as_deref(),
            Some("second")
        );
        assert_eq!(
            lineage_sibling_session_id(&snapshot, "first", -1).as_deref(),
            Some("second")
        );
        assert_eq!(lineage_sibling_session_id(&snapshot, "nested", 1), None);
    }

    #[test]
    fn inspection_freshness_is_scoped_to_the_selected_session() {
        let generations = HashMap::from([
            ("selected".to_string(), 4),
            ("streaming-sibling".to_string(), 99),
        ]);

        assert!(lineage_inspection_result_is_current(
            "selected",
            4,
            &generations
        ));
        assert!(!lineage_inspection_result_is_current(
            "selected",
            3,
            &generations
        ));
    }

    #[test]
    fn cancellation_result_is_hidden_after_switching_to_a_sibling() {
        assert!(lineage_cancellation_result_is_current(
            4,
            4,
            "root",
            Some("root"),
            "child-a",
            Some("child-a"),
        ));
        assert!(!lineage_cancellation_result_is_current(
            4,
            4,
            "root",
            Some("root"),
            "child-a",
            Some("child-b"),
        ));
        assert!(!lineage_cancellation_result_is_current(
            4,
            4,
            "root",
            Some("root"),
            "child-a",
            None,
        ));
    }

    #[test]
    fn lineage_runtime_io_is_started_off_the_tui_loop_and_polled_once() {
        let source = include_str!("session_lineage.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production lineage source");
        for method in [
            "show_session_lineage",
            "inspect_lineage_session",
            "refresh_inspected_lineage_if_due",
            "cancel_inspected_lineage_session",
        ] {
            let body = source
                .split(&format!("fn {method}"))
                .nth(1)
                .and_then(|source| source.split("\n    }").next())
                .expect("lineage operation body");
            assert!(body.contains("rt_handle.spawn"), "{method} must spawn I/O");
            assert!(
                !body.contains("block_in_place"),
                "{method} must not synchronously wait on Runtime I/O"
            );
        }
        let poll = source
            .split("fn poll_lineage_operation_completion")
            .nth(1)
            .and_then(|source| source.split("fn apply_lineage_inspection").next())
            .expect("lineage completion polling");
        assert!(
            poll.find("is_finished").expect("finished gate")
                < poll.find("block_in_place").expect("finished join")
        );
    }

    #[test]
    fn background_child_events_refresh_the_existing_lineage_snapshot() {
        let mut snapshot = snapshot();
        let session_index = lineage_session_index(&snapshot);
        update_lineage_active_turn(
            &mut snapshot,
            &session_index,
            &AgenticEvent::DialogTurnStarted {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
                turn_index: 1,
                user_input: "continue".to_string(),
                original_user_input: None,
                user_message_metadata: None,
            },
        );
        assert_eq!(
            snapshot.sessions[1].active_turn_id.as_deref(),
            Some("turn-live")
        );

        update_lineage_active_turn(
            &mut snapshot,
            &session_index,
            &AgenticEvent::DialogTurnCancelled {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
            },
        );
        assert_eq!(snapshot.sessions[1].active_turn_id, None);
    }

    #[test]
    fn cached_start_rebuilds_the_active_turn_without_duplicate_messages() {
        let entry = entry("first", Some("root"));
        let inspection = AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: "first".to_string(),
                messages: vec![
                    TranscriptMessage {
                        id: Some("persisted-user".to_string()),
                        role: "user".to_string(),
                        turn_id: Some("turn-live".to_string()),
                        timestamp_ms: Some(1),
                        content: TranscriptContent::Text("continue".to_string()),
                    },
                    TranscriptMessage {
                        id: Some("persisted-assistant".to_string()),
                        role: "assistant".to_string(),
                        turn_id: Some("turn-live".to_string()),
                        timestamp_ms: Some(2),
                        content: TranscriptContent::Text("stale output".to_string()),
                    },
                ],
            },
            active_turn_id: Some("turn-live".to_string()),
        };
        let replay_events = vec![
            AgenticEvent::DialogTurnStarted {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
                turn_index: 1,
                user_input: "continue".to_string(),
                original_user_input: None,
                user_message_metadata: None,
            },
            AgenticEvent::TextChunk {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
                round_id: "round-live".to_string(),
                attempt_id: None,
                attempt_index: None,
                text: "hello".to_string(),
            },
        ];

        let state = build_lineage_chat_state(&entry, inspection, &replay_events);

        assert_eq!(state.current_turn_id(), Some("turn-live"));
        assert_eq!(
            state
                .messages
                .iter()
                .filter(|message| message.role == MessageRole::User)
                .count(),
            1
        );
        assert!(state.messages.iter().any(|message| {
            message.role == MessageRole::Assistant
                && message.flow_items.iter().any(
                    |item| matches!(item, FlowItem::Text { content, .. } if content == "hello"),
                )
        }));
        assert!(!state.messages.iter().any(|message| {
            message.flow_items.iter().any(
                |item| matches!(item, FlowItem::Text { content, .. } if content == "stale output"),
            )
        }));
    }

    #[test]
    fn active_child_replays_cached_tail_and_keeps_streaming_live() {
        let entry = entry("first", Some("root"));
        let inspection = AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: "first".to_string(),
                messages: vec![TranscriptMessage {
                    id: Some("persisted-user".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-live".to_string()),
                    timestamp_ms: Some(1),
                    content: TranscriptContent::Text("continue".to_string()),
                }],
            },
            active_turn_id: Some("turn-live".to_string()),
        };
        let first_chunk = AgenticEvent::TextChunk {
            session_id: "first".to_string(),
            turn_id: "turn-live".to_string(),
            round_id: "round-live".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: "hello".to_string(),
        };
        let mut state = build_lineage_chat_state(&entry, inspection, &[first_chunk]);
        let second_chunk = AgenticEvent::TextChunk {
            session_id: "first".to_string(),
            turn_id: "turn-live".to_string(),
            round_id: "round-live".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: " world".to_string(),
        };

        let outcome = project_transcript_event(&mut state, &second_chunk, false);

        assert!(outcome.changed);
        assert!(state.messages.iter().any(|message| {
            message.role == MessageRole::Assistant
                && message.flow_items.iter().any(|item| {
                    matches!(item, FlowItem::Text { content, .. } if content == "hello world")
                })
        }));
    }

    #[test]
    fn reopened_cancelled_child_replays_the_terminal_event_and_partial_output() {
        let entry = entry("first", Some("root"));
        let inspection = AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: "first".to_string(),
                messages: vec![TranscriptMessage {
                    id: Some("persisted-user".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-live".to_string()),
                    timestamp_ms: Some(1),
                    content: TranscriptContent::Text("continue".to_string()),
                }],
            },
            active_turn_id: Some("turn-live".to_string()),
        };
        let replay_events = vec![
            AgenticEvent::TextChunk {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
                round_id: "round-live".to_string(),
                attempt_id: None,
                attempt_index: None,
                text: "partial".to_string(),
            },
            AgenticEvent::DialogTurnCancelled {
                session_id: "first".to_string(),
                turn_id: "turn-live".to_string(),
            },
        ];

        let state = build_lineage_chat_state(&entry, inspection, &replay_events);

        assert_eq!(state.current_turn_id(), None);
        assert!(!state.is_processing);
        assert!(state.messages.iter().any(|message| {
            message.role == MessageRole::Assistant
                && message.flow_items.iter().any(
                    |item| matches!(item, FlowItem::Text { content, .. } if content == "partial"),
                )
        }));
    }

    #[test]
    fn observed_terminal_turn_is_kept_as_a_runtime_read_barrier() {
        let mut required_turns = BTreeMap::new();
        record_required_settled_lineage_turn(&mut required_turns, "first", "turn-old");

        assert_eq!(required_turns["first"], ["turn-old"]);
    }

    #[test]
    fn duplicate_terminal_for_the_same_turn_is_ignored() {
        let mut required_turns = BTreeMap::new();
        record_required_settled_lineage_turn(&mut required_turns, "first", "turn-live");
        record_required_settled_lineage_turn(&mut required_turns, "first", "turn-live");

        assert_eq!(required_turns["first"], ["turn-live"]);
    }

    #[test]
    fn terminal_read_barriers_have_an_explicit_per_session_bound() {
        let mut required_turns = BTreeMap::new();
        for index in 0..=LINEAGE_READ_BARRIER_MAX_TURNS_PER_SESSION {
            record_required_settled_lineage_turn(
                &mut required_turns,
                "first",
                &format!("turn-{index}"),
            );
        }

        assert_eq!(
            required_turns["first"].len(),
            LINEAGE_READ_BARRIER_MAX_TURNS_PER_SESSION
        );
        assert_eq!(required_turns["first"][0], "turn-1");
    }

    #[test]
    fn consecutive_terminal_turns_remain_independent_read_barriers() {
        let mut required_turns = BTreeMap::new();
        record_required_settled_lineage_turn(&mut required_turns, "first", "turn-a");
        record_required_settled_lineage_turn(&mut required_turns, "first", "turn-b");

        assert_eq!(required_turns["first"], vec!["turn-a", "turn-b"]);
    }

    #[test]
    fn lineage_event_buffer_is_bounded_by_serialized_bytes_and_count() {
        let event = |text: &str| AgenticEvent::TextChunk {
            session_id: "first".to_string(),
            turn_id: "turn-live".to_string(),
            round_id: "round-live".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: text.to_string(),
        };
        let first = event("first");
        let second = event("second");
        let max_bytes = serde_json::to_vec(&second).unwrap().len();
        let mut buffer: VecDeque<BufferedLineageEvent> = VecDeque::new();
        let mut encoded_bytes = 0;

        push_bounded_lineage_event(&mut buffer, &mut encoded_bytes, &first, max_bytes, 1);
        push_bounded_lineage_event(&mut buffer, &mut encoded_bytes, &second, max_bytes, 1);

        assert_eq!(buffer.len(), 1);
        assert!(matches!(
            &buffer[0].event,
            AgenticEvent::TextChunk { text, .. } if text == "second"
        ));
        assert!(encoded_bytes <= max_bytes);

        let oversized = event(&"x".repeat(max_bytes));
        push_bounded_lineage_event(&mut buffer, &mut encoded_bytes, &oversized, max_bytes, 1);
        assert_eq!(buffer.len(), 1);
    }

    #[test]
    fn delayed_start_for_a_persisted_turn_is_ignored_after_inspection() {
        let entry = entry("first", Some("root"));
        let inspection = AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: "first".to_string(),
                messages: vec![
                    TranscriptMessage {
                        id: Some("user".to_string()),
                        role: "user".to_string(),
                        turn_id: Some("turn-done".to_string()),
                        timestamp_ms: Some(1),
                        content: TranscriptContent::Text("question".to_string()),
                    },
                    TranscriptMessage {
                        id: Some("assistant".to_string()),
                        role: "assistant".to_string(),
                        turn_id: Some("turn-done".to_string()),
                        timestamp_ms: Some(2),
                        content: TranscriptContent::Text("answer".to_string()),
                    },
                ],
            },
            active_turn_id: None,
        };
        let mut state = build_lineage_chat_state(&entry, inspection, &[]);
        let before = state.messages.len();

        let outcome = project_transcript_event(
            &mut state,
            &AgenticEvent::DialogTurnStarted {
                session_id: "first".to_string(),
                turn_id: "turn-done".to_string(),
                turn_index: 0,
                user_input: "question".to_string(),
                original_user_input: None,
                user_message_metadata: None,
            },
            false,
        );

        assert!(!outcome.changed);
        assert_eq!(state.messages.len(), before);
    }
}
