//! The single app-input executor: a validated program, ordered receipts and one observation.
//! Never retries a submitted step; a new model decision starts a new program.
use crate::agentic::tools::computer_use_host::{
    AppInputAction, AppInputSettle, AppInputSettlePolicy, AppInputSettleStatus, AppSelector,
    AppStateSnapshot, AppWindowInfo, ComputerUseHost, ControlSnapshot,
};
use crate::agentic::tools::framework::ToolUseContext;
use serde_json::{json, Value};

pub(super) struct ProgramObservation {
    pub receipt: Value,
    pub snapshot: Option<AppStateSnapshot>,
}

/// Check structural target errors before the first mutation. Native providers
/// still validate current window bounds, retained identities and screenshot IDs.
pub(super) fn validate_step(step: &AppInputAction) -> Result<(), String> {
    step.validate()
}

pub(super) async fn execute(
    host: &dyn ComputerUseHost,
    app: AppSelector,
    steps: Vec<AppInputAction>,
    context: Option<&ToolUseContext>,
    include_image: bool,
) -> ProgramObservation {
    let initial_control = host.control_snapshot();
    let started = std::time::Instant::now();
    let windows_before = live_windows(host).await;
    let requested = steps.len();
    let mut receipts = Vec::new();
    let mut completed = 0;
    let mut interrupted = false;
    for (index, step) in steps.into_iter().enumerate() {
        if !same_active_control(&initial_control, &host.control_snapshot())
            || context
                .and_then(ToolUseContext::cancellation_token)
                .is_some_and(|token| token.is_cancelled())
        {
            interrupted = true;
            break;
        }
        let step_started = std::time::Instant::now();
        let name = step.name();
        // A wait has no side effects and can be interrupted immediately. Native
        // input is allowed to return its receipt; dropping a partially executed
        // native gesture here would lose which input was actually submitted.
        let result = if matches!(&step, AppInputAction::Wait { .. }) {
            if let Some(token) = context.and_then(ToolUseContext::cancellation_token) {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        interrupted = true;
                        receipts.push(json!({"index":index,"action":name,"status":"cancelled","input_may_have_been_submitted":false,"elapsed_ms":step_started.elapsed().as_millis()}));
                        break;
                    }
                    result = host.dispatch_app_input(app.clone(), step) => result,
                }
            } else {
                host.dispatch_app_input(app.clone(), step).await
            }
        } else {
            host.dispatch_app_input(app.clone(), step).await
        };
        match result {
            Ok(()) => {
                completed += 1;
                receipts.push(json!({"index":index,"action":name,"status":"submitted","elapsed_ms":step_started.elapsed().as_millis()}));
            }
            Err(error) => {
                // A failed step may already have focused/clicked before typing
                // failed. It must never be described as safe to replay.
                receipts.push(json!({"index":index,"action":name,"status":"failed","input_may_have_been_submitted":true,"error":error.to_string(),"elapsed_ms":step_started.elapsed().as_millis()}));
                break;
            }
        }
    }
    interrupted |= context
        .and_then(ToolUseContext::cancellation_token)
        .is_some_and(|token| token.is_cancelled());
    let input_submitted = receipts.iter().any(|receipt| {
        receipt["action"] != "wait"
            && (receipt["status"] == "submitted" || receipt["status"] == "failed")
    });
    let settle = if !input_submitted {
        AppInputSettle::skipped()
    } else if interrupted || !same_active_control(&initial_control, &host.control_snapshot()) {
        AppInputSettle {
            status: AppInputSettleStatus::Interrupted,
            waited_ms: 0,
            changed: None,
            reason: Some("Control was cancelled, stopped or rebound before settling".into()),
        }
    } else {
        settle_after_input(host, app.clone(), context).await
    };
    let observation_started = std::time::Instant::now();
    let (snapshot, observation_error) = if same_active_control(
        &initial_control,
        &host.control_snapshot(),
    ) {
        observe_after_input(host, app.clone(), context, include_image).await
    } else {
        (None, Some("CONTROL_CHANGED_DURING_INPUT: No observation was taken after control stopped or changed scope. Submitted inputs were not replayed.".into()))
    };
    interrupted |= context
        .and_then(ToolUseContext::cancellation_token)
        .is_some_and(|token| token.is_cancelled())
        || !same_active_control(&initial_control, &host.control_snapshot());
    let opened = match windows_before {
        Some(before) if input_submitted && !interrupted => {
            opened_windows(host, &before, &app, snapshot.as_ref()).await
        }
        _ => Vec::new(),
    };
    let mut receipt = json!({
        "action":"app_batch", "target_app":app,
        "status":if interrupted {"cancelled"} else if completed == requested {"submitted"} else {"partial"},
        "requested_steps":requested,"completed_steps":completed,"steps":receipts,
        "observation_error":observation_error,"elapsed_ms":started.elapsed().as_millis(),
        "settle":settle,
        "observation_elapsed_ms":observation_started.elapsed().as_millis(),
        "verification":"Submission is not proof of task completion. Inspect the final observation; never replay the whole batch to repair a failed step or observation. Unattempted steps were not executed."
    });
    if !opened.is_empty() {
        receipt["opened_windows"] = json!(opened);
        receipt["opened_windows_hint"] = json!("These top-level windows appeared on screen while this input was processed, possibly in another process (an app helper, a dialog service or a launched application). The observation above is still the bound window. If the task continues in one of them, observe it with get_app_state app:{pid,window_id}; nothing was selected automatically.");
    }
    ProgramObservation { receipt, snapshot }
}

/// Bound for the windows reported as opened by one input program.
const MAX_OPENED_WINDOWS: usize = 6;

/// On-screen top-level windows, or `None` when the host has no window
/// discovery. A failed inventory only disables the opened-window report.
async fn live_windows(host: &dyn ComputerUseHost) -> Option<std::collections::HashSet<(i32, u64)>> {
    let windows = host.list_windows(None).await.ok()?;
    Some(
        windows
            .into_iter()
            .filter(|window| window.is_on_screen != Some(false))
            .map(|window| (window.pid, window.window_id))
            .collect(),
    )
}

/// Windows that became visible during the input, across processes: a click
/// often opens its result in a helper process or another application. The
/// bound window, its own popups and this host's overlays are not reported.
async fn opened_windows(
    host: &dyn ComputerUseHost,
    before: &std::collections::HashSet<(i32, u64)>,
    app: &AppSelector,
    snapshot: Option<&AppStateSnapshot>,
) -> Vec<AppWindowInfo> {
    let Ok(mut windows) = host.list_windows(None).await else {
        return Vec::new();
    };
    let own_pid = i32::try_from(std::process::id()).unwrap_or_default();
    let auxiliary: std::collections::HashSet<u64> = snapshot
        .and_then(|snapshot| snapshot.screenshot.as_ref())
        .map(|shot| shot.auxiliary_windows.iter().map(|w| w.window_id).collect())
        .unwrap_or_default();
    windows.retain(|window| {
        window.is_on_screen != Some(false)
            && !before.contains(&(window.pid, window.window_id))
            && window.pid != own_pid
            && Some(window.window_id) != app.window_id
            && !auxiliary.contains(&window.window_id)
    });
    AppWindowInfo::sort_for_discovery(&mut windows);
    windows.truncate(MAX_OPENED_WINDOWS);
    windows
}

/// Settling only waits for pixels and is safe to abandon on cancellation; a
/// host failure degrades to an unavailable report instead of failing the batch.
async fn settle_after_input(
    host: &dyn ComputerUseHost,
    app: AppSelector,
    context: Option<&ToolUseContext>,
) -> AppInputSettle {
    let policy = AppInputSettlePolicy::default();
    let started = std::time::Instant::now();
    let result = if let Some(token) = context.and_then(ToolUseContext::cancellation_token) {
        tokio::select! {
            biased;
            _ = token.cancelled() => {
                return AppInputSettle {
                    status: AppInputSettleStatus::Interrupted,
                    waited_ms: started.elapsed().as_millis() as u64,
                    changed: None,
                    reason: Some("Cancelled while waiting for the window to settle".into()),
                };
            }
            result = host.settle_after_input(app, policy) => result,
        }
    } else {
        host.settle_after_input(app, policy).await
    };
    result.unwrap_or_else(|error| AppInputSettle {
        status: AppInputSettleStatus::Unavailable,
        waited_ms: started.elapsed().as_millis() as u64,
        changed: None,
        reason: Some(error.to_string()),
    })
}

/// A recovery read must preserve cancellation and native Stop Sharing. It never
/// resubmits input, even when the preceding action failed after partial delivery.
pub(super) async fn observe_after_input(
    host: &dyn ComputerUseHost,
    app: AppSelector,
    context: Option<&ToolUseContext>,
    include_image: bool,
) -> (Option<AppStateSnapshot>, Option<String>) {
    let cancelled = context
        .and_then(ToolUseContext::cancellation_token)
        .is_some_and(|token| token.is_cancelled());
    let state = host.control_snapshot();
    if cancelled || (state.supported && state.state != "active") {
        return (
            None,
            Some("Control was cancelled or stopped; no new observation was taken".into()),
        );
    }
    let observation = host
        .get_app_state_with_options(app, 32, true, include_image)
        .await;
    // A read can outlive Stop Sharing, cancellation, or a new control generation.
    // Never attach pixels from an observation that lost its control scope while
    // awaiting the host, even if that host completed the capture successfully.
    let cancelled = context
        .and_then(ToolUseContext::cancellation_token)
        .is_some_and(|token| token.is_cancelled());
    if cancelled || !same_active_control(&state, &host.control_snapshot()) {
        return (None, Some("CONTROL_CHANGED_DURING_OBSERVATION: The observation was discarded because control was cancelled, stopped, or rebound. Submitted inputs were not replayed.".into()));
    }
    match observation {
        Ok(snapshot) => {
            let error = (include_image && snapshot.screenshot.is_none()).then(|| {
                "[CAPTURE_UNAVAILABLE] Accessibility observation succeeded but the requested image is unavailable. Inspect tree_text for the native capture reason; use include_image=false if AX is sufficient. Missing pixels do not establish input failure and do not authorize replay.".into()
            });
            (Some(snapshot), error)
        }
        Err(error) => (None, Some(error.to_string())),
    }
}

pub(super) fn same_active_control(before: &ControlSnapshot, after: &ControlSnapshot) -> bool {
    if !before.supported {
        return !after.supported;
    }
    after.supported
        && after.state == "active"
        && after.generation == before.generation
        && after.owner == before.owner
        && after.mode == before.mode
        && after.target == before.target
        && after.target_revision == before.target_revision
}
