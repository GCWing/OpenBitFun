use super::*;
use crate::agentic::persistence::session_branch::TransientSessionBranchSource;
use crate::external_session_import::deferred::{self, tracking};
use openbitfun_services_core::session::OfflineSessionBundle;

pub(crate) fn external_history_catalog(bundle: &OfflineSessionBundle) -> SessionTurnCatalog {
    build_turn_catalog(
        &bundle.metadata.session_id,
        bundle
            .turns
            .iter()
            .enumerate()
            .map(|(ordinal, turn)| turn_catalog_entry(turn, ordinal))
            .collect(),
    )
}

impl PersistenceManager {
    pub(crate) async fn restore_external_session_reference(
        &self,
        workspace: &Path,
        workspace_id: &str,
        ecosystem_id: &str,
        id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(id)?;
        let _session_write = self.lock_session_write_operation(workspace, id)?;
        let persistence_lock = self.get_session_persistence_lock(workspace, id).await;
        let _persistence_guard = persistence_lock.lock().await;
        self.ensure_runtime_for_write(workspace).await?;
        deferred::restore_reference(
            &self.project_sessions_dir(workspace),
            workspace_id,
            ecosystem_id,
            id,
        )
        .await
    }

    async fn has_independent_native_history(
        &self,
        workspace: &Path,
        id: &str,
    ) -> OpenBitFunResult<bool> {
        let Some(native) = self
            .session_metadata_store(workspace)
            .load_metadata(id)
            .await
            .map_err(Self::session_metadata_store_error)?
        else {
            return Ok(false);
        };
        if !native
            .custom_metadata
            .as_ref()
            .is_some_and(|custom| custom["importedFrom"].is_string())
        {
            return Ok(true);
        }
        match deferred::has_native_view(&self.project_sessions_dir(workspace), id).await {
            Ok(followed) => Ok(!followed),
            Err(error) => {
                log::warn!(
                    "External history index could not be read; retaining native history: {error}"
                );
                Ok(true)
            }
        }
    }
    pub(crate) async fn assert_relay_history_supported(
        &self,
        workspace: &Path,
        id: &str,
    ) -> OpenBitFunResult<()> {
        if self
            .load_session_metadata(workspace, id)
            .await?
            .as_ref()
            .is_some_and(tracking::is_followed)
        {
            return Err(OpenBitFunError::Validation(
                "Following external source history through Relay is not supported. Open it on its owning host or use a native OpenBitFun branch.".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn assert_native_history_mutation(
        &self,
        workspace: &Path,
        id: &str,
    ) -> OpenBitFunResult<()> {
        if self
            .load_session_metadata(workspace, id)
            .await?
            .as_ref()
            .is_some_and(tracking::is_followed)
        {
            return Err(OpenBitFunError::Validation(
                "This session follows an external source and is read-only. Fork the viewed history in OpenBitFun before continuing or editing it. This client must support session forks.".into(),
            ));
        }
        Ok(())
    }

    pub(super) async fn external_history_snapshot(
        &self,
        workspace: &Path,
        id: &str,
        refresh: bool,
    ) -> OpenBitFunResult<Option<tracking::HistorySnapshot>> {
        if self.has_independent_native_history(workspace, id).await? {
            return Ok(None);
        }
        // Keep source decoding state out of every native persistence future.
        // Native restores and undo/fork paths already nest several async owners.
        Box::pin(tracking::snapshot_shared(
            &self.project_sessions_dir(workspace),
            id,
            refresh,
        ))
        .await
    }

    pub(super) async fn external_history_for_loaded_turns(
        &self,
        workspace: &Path,
        id: &str,
        turns: &[DialogTurnData],
    ) -> OpenBitFunResult<Option<tracking::HistorySnapshot>> {
        if self.has_independent_native_history(workspace, id).await? {
            return Ok(None);
        }
        if let Some(turn) = turns.first() {
            tracking::snapshot_at_turn_shared(
                &self.project_sessions_dir(workspace),
                id,
                &turn.turn_id,
            )
            .await
        } else {
            self.external_history_snapshot(workspace, id, false).await
        }
    }

    pub(super) async fn load_external_history_view(
        &self,
        workspace: &Path,
        id: &str,
        tail: Option<usize>,
    ) -> OpenBitFunResult<Option<(Session, Vec<DialogTurnData>, usize, SessionTurnLoadTiming)>>
    {
        let started = Instant::now();
        let Some(bundle) = self.external_history_snapshot(workspace, id, true).await? else {
            return Ok(None);
        };
        let total = bundle.turns().len();
        let session =
            Self::build_session_from_persisted_parts(bundle.metadata.clone(), None, bundle.turns())
                .await?;
        let start = tail.map_or(0, |count| total.saturating_sub(count));
        let turns = if start == 0 {
            bundle.into_bundle().turns
        } else {
            bundle.copy_turns(start..total)
        };
        let timing = SessionTurnLoadTiming {
            requested_tail_turn_count: tail,
            loaded_turn_count: turns.len(),
            total_turn_count: total,
            total_duration_ms: elapsed_ms_u64(started),
            ..Default::default()
        };
        Ok(Some((session, turns, total, timing)))
    }

    pub(super) async fn external_history_window(
        &self,
        request: &SessionTurnWindowRequest,
    ) -> OpenBitFunResult<Option<SessionTurnWindowResponse>> {
        if self
            .has_independent_native_history(&request.workspace_path, &request.session_id)
            .await?
        {
            return Ok(None);
        }
        let root = self.project_sessions_dir(&request.workspace_path);
        let bundle = if let Some(turn_id) = request.expected_turn_id.as_deref() {
            tracking::snapshot_at_turn_shared(&root, &request.session_id, turn_id).await?
        } else {
            tracking::snapshot_shared(&root, &request.session_id, false).await?
        };
        let Some(bundle) = bundle else {
            return Ok(None);
        };
        let catalog = bundle.catalog();
        if request
            .expected_catalog_revision
            .as_deref()
            .is_some_and(|revision| revision != catalog.revision)
        {
            return Ok(Some(SessionTurnWindowResponse::Stale {
                catalog: catalog.clone(),
            }));
        }
        let Some(target) = bundle.turn_position(request.target_storage_turn_index) else {
            return Ok(Some(SessionTurnWindowResponse::NotFound {
                catalog: catalog.clone(),
            }));
        };
        let start = target.saturating_sub(request.before.min(SESSION_TURN_WINDOW_MAX_BEFORE));
        let end = bundle.turns().len().min(
            target.saturating_add(
                request
                    .after
                    .clamp(1, SESSION_TURN_WINDOW_MAX_TARGET_AND_AFTER),
            ),
        );
        Ok(Some(SessionTurnWindowResponse::Ready {
            catalog_revision: catalog.revision.clone(),
            total_turn_count: catalog.total_turn_count,
            start_ordinal: start,
            end_ordinal_exclusive: end,
            target_turn_id: bundle.turns()[target].turn_id.clone(),
            turns: bundle.copy_turns(start..end),
        }))
    }

    pub(crate) async fn external_history_branch_source(
        &self,
        workspace: &Path,
        id: &str,
        turn_id: Option<&str>,
    ) -> OpenBitFunResult<Option<TransientSessionBranchSource>> {
        if self.has_independent_native_history(workspace, id).await? {
            return Ok(None);
        }
        let root = self.project_sessions_dir(workspace);
        if !deferred::metadata(&root, id)
            .await?
            .as_ref()
            .is_some_and(tracking::is_followed)
        {
            return Ok(None);
        }
        let bundle = match turn_id {
            Some(turn) => tracking::snapshot_at_turn(&root, id, turn).await?,
            None => tracking::snapshot(&root, id, false).await?,
        }
        .ok_or_else(|| OpenBitFunError::NotFound("External source view is unavailable".into()))?;
        let session =
            Self::build_session_from_persisted_parts(bundle.metadata.clone(), None, &bundle.turns)
                .await?;
        Ok(Some(TransientSessionBranchSource {
            session,
            metadata: Some(bundle.metadata),
            turns: bundle.turns,
            context_snapshots: Vec::new(),
            prompt_cache: None,
            skill_agent_snapshots: Vec::new(),
            baseline_override: None,
            evidence_events: Vec::new(),
        }))
    }
}
