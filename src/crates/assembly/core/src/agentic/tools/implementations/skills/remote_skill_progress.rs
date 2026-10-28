//! Forward package preparation status through the invoking tool's existing stream.

use super::SkillLoadProgress;
use crate::agentic::tools::framework::ToolUseContext;
use crate::infrastructure::events::event_system::{get_global_event_system, BackendEvent};
use crate::util::types::event::ToolExecutionProgressInfo;
use std::sync::Arc;

pub(crate) fn skill_load_progress(
    context: &ToolUseContext,
    tool_name: &'static str,
) -> SkillLoadProgress {
    let tool_call_id = context.tool_call_id.clone();
    // Package scanning invokes this callback on a blocking worker. Capture the
    // runtime here so that those updates can use the same event transport.
    let runtime = tokio::runtime::Handle::current();
    Arc::new(move |progress_message, percentage| {
        let Some(tool_use_id) = tool_call_id.clone() else {
            return;
        };
        let event_system = get_global_event_system();
        let event = BackendEvent::ToolExecutionProgress(ToolExecutionProgressInfo {
            tool_use_id,
            tool_name: tool_name.to_string(),
            progress_message,
            percentage,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        });
        runtime.spawn(async move {
            let _ = event_system.emit(event).await;
        });
    })
}
