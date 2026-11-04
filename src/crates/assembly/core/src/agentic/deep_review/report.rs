//! Deep Review report product assembly bridge.
//!
//! Provider-neutral packet metadata, reliability-signal shaping, and cache
//! updates are owned by `openbitfun-agent-runtime::deep_review::report`. This file
//! keeps core-only context lookup, diagnostics logging, and session metadata IO.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::core::CompressionContract;
use crate::agentic::deep_review_policy::{
    deep_review_capacity_skip_count, deep_review_concurrency_cap_rejection_count,
    deep_review_runtime_diagnostics_snapshot,
};
use crate::agentic::session::DEFAULT_COMPRESSION_CONTRACT_LIMIT;
use crate::agentic::tools::framework::ToolUseContext;
use crate::util::errors::OpenBitFunResult;
use log::debug;
use openbitfun_agent_runtime::deep_review::diagnostics as runtime_diagnostics;
use openbitfun_agent_runtime::deep_review::report as runtime_report;
pub(crate) use openbitfun_agent_runtime::deep_review::report::{
    apply_review_evidence_guardrail, apply_review_runtime_limitation, apply_review_runtime_stale,
    deep_review_cache_from_completed_reviewers, fill_deep_review_cache_update_signals,
    fill_deep_review_packet_metadata,
};
use openbitfun_services_core::session::set_deep_review_cache;
use serde_json::Value;

pub(crate) fn is_deep_review_context(context: Option<&ToolUseContext>) -> bool {
    context
        .and_then(|context| context.agent_type.as_deref())
        .map(str::trim)
        .is_some_and(|agent_type| agent_type == "DeepReview")
}

pub(crate) fn compression_contract_for_context(
    context: &ToolUseContext,
) -> Option<CompressionContract> {
    let session_id = context.session_id.as_deref()?;
    let coordinator = get_global_coordinator()?;
    let session = coordinator.get_session_manager().get_session(session_id)?;
    let contract = coordinator
        .get_session_manager()
        .compression_contract_for_session(session_id, DEFAULT_COMPRESSION_CONTRACT_LIMIT)?;
    should_report_compression_preserved(
        session.compression_state.compression_count,
        Some(&contract),
    )
    .then_some(contract)
}

pub(crate) fn should_report_compression_preserved(
    compression_count: usize,
    compression_contract: Option<&CompressionContract>,
) -> bool {
    compression_count > 0 && compression_contract.is_some_and(|contract| !contract.is_empty())
}

pub(crate) fn compression_contract_signal_count(contract: &CompressionContract) -> usize {
    contract.touched_files.len()
        + contract.verification_commands.len()
        + contract.blocking_failures.len()
        + contract.subagent_statuses.len()
}

pub(crate) fn fill_deep_review_reliability_signals(
    input: &mut Value,
    run_manifest: Option<&Value>,
    compression_contract: Option<&CompressionContract>,
) {
    let compression_preserved_signal_count = compression_contract
        .filter(|contract| !contract.is_empty())
        .map(compression_contract_signal_count)
        .filter(|count| *count > 0);
    runtime_report::fill_deep_review_reliability_signals(
        input,
        run_manifest,
        compression_preserved_signal_count,
    );
}

pub(crate) fn fill_deep_review_runtime_tracker_signals(
    input: &mut Value,
    dialog_turn_id: Option<&str>,
) {
    let Some(dialog_turn_id) = dialog_turn_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let count = deep_review_concurrency_cap_rejection_count(dialog_turn_id)
        + deep_review_capacity_skip_count(dialog_turn_id);
    runtime_report::fill_deep_review_runtime_tracker_signal(input, count);
}

pub(crate) fn log_deep_review_runtime_diagnostics(dialog_turn_id: Option<&str>) {
    let Some(dialog_turn_id) = dialog_turn_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(diagnostics) = deep_review_runtime_diagnostics_snapshot(dialog_turn_id) else {
        return;
    };
    debug!(
        "{}",
        runtime_diagnostics::deep_review_runtime_diagnostics_log_line(&diagnostics)
    );
}

pub(crate) async fn persist_deep_review_cache(
    context: &ToolUseContext,
    cache_value: Value,
) -> OpenBitFunResult<()> {
    let Some(session_id) = context.session_id.as_deref() else {
        return Ok(());
    };
    let Some(workspace) = context.workspace.as_ref() else {
        return Ok(());
    };
    let Some(coordinator) = get_global_coordinator() else {
        return Ok(());
    };
    let session_storage_dir = workspace.session_storage_dir();
    let session_manager = coordinator.get_session_manager();
    session_manager
        .persistence_manager()
        .update_session_metadata_if_present(&session_storage_dir, session_id, |metadata| {
            set_deep_review_cache(metadata, cache_value);
            Ok(())
        })
        .await
        .map(|_| ())
}
