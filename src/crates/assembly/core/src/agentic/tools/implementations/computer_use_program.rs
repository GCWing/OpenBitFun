//! The single app-input executor: a validated program, ordered receipts and one observation.
//! Never retries a submitted step; a new model decision starts a new program.
use crate::agentic::tools::computer_use_host::{
    AppInputAction, AppSelector, AppStateSnapshot, ComputerUseHost, ControlSnapshot,
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
    ProgramObservation {
        receipt: json!({
            "action":"app_batch", "target_app":app,
            "status":if interrupted {"cancelled"} else if completed == requested {"submitted"} else {"partial"},
            "requested_steps":requested,"completed_steps":completed,"steps":receipts,
            "observation_error":observation_error,"elapsed_ms":started.elapsed().as_millis(),
            "observation_elapsed_ms":observation_started.elapsed().as_millis(),
            "verification":"Submission is not proof of task completion. Inspect the final observation; never replay the whole batch to repair a failed step or observation. Unattempted steps were not executed."
        }),
        snapshot,
    }
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
