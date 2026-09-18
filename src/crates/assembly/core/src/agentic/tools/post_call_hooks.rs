//! Post-call hooks for generic tool execution.
//!
//! The tool framework stays generic and calls this module after successful
//! tool execution. Domain-specific hooks must keep their own gating inside the
//! owning domain module.

use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use serde_json::Value;

pub(crate) async fn record_successful_tool_call(
    tool_name: &str,
    input: &Value,
    context: &ToolUseContext,
) {
    crate::native_hooks::dispatch_successful_tool_post_call(
        context.workspace_id(),
        context.workspace_root(),
        context.is_remote(),
        tool_name,
        input,
        &context.custom_data,
        context.agent_type.as_deref(),
    )
    .await;
}
