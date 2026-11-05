//! Runtime helpers for code-review read receipts.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::session::{FileRevision, ReviewReadCoverage};
use crate::agentic::tools::framework::ToolPathResolution;
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use sha2::{Digest, Sha256};
use std::time::UNIX_EPOCH;
use tool_runtime::fs::read_file::ReadFileResult;

pub fn review_read_receipts_enabled(context: &ToolUseContext) -> bool {
    context.custom_data.contains_key("deep_review_run_manifest")
        || context.agent_type.as_deref().is_some_and(|agent_type| {
            matches!(
                agent_type,
                "CodeReview" | "DeepReview" | "ReviewWorker" | "ReviewJudge"
            )
        })
}

/// Capture the same revision facts from either workspace provider. The hash
/// is streamed and the metadata is checked again so a detected concurrent
/// change never becomes a reusable review receipt.
pub async fn file_revision(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
) -> Option<FileRevision> {
    use tokio::io::AsyncReadExt;
    let file_system = context.file_system_for_path(resolved).ok()?;
    let before = file_system
        .metadata(&resolved.resolved_path, true)
        .await
        .ok()??;
    if before.kind != openbitfun_runtime_ports::WorkspacePathKind::File {
        return None;
    }
    let modified_ns = before.modified?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let mut reader = file_system.open_read(&resolved.resolved_path).await.ok()?;
    let mut hasher = Sha256::new();
    let mut byte_len = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).await.ok()?;
        if count == 0 {
            break;
        }
        byte_len = byte_len.checked_add(count as u64)?;
        hasher.update(&buffer[..count]);
    }
    let after = file_system
        .metadata(&resolved.resolved_path, true)
        .await
        .ok()??;
    if before.kind != after.kind || before.size != after.size || before.modified != after.modified {
        return None;
    }
    if after.size.is_some_and(|size| size != byte_len) {
        return None;
    }
    Some(FileRevision {
        modified_ns,
        byte_len,
        content_sha256: hasher.finalize().into(),
    })
}

pub fn get_review_read_coverage(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
    revision: FileRevision,
    start_line: usize,
    limit: usize,
) -> Option<ReviewReadCoverage> {
    if !review_read_receipts_enabled(context) {
        return None;
    }
    let session_id = context.session_id.as_deref()?;
    let coordinator = get_global_coordinator()?;
    coordinator.get_session_manager().review_read_coverage(
        session_id,
        &resolved.logical_path,
        revision,
        start_line,
        limit,
    )
}

pub fn record_review_read_receipt(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
    revision: FileRevision,
    read_result: &ReadFileResult,
) {
    if read_result.content_truncated || !review_read_receipts_enabled(context) {
        return;
    }
    let Some(session_id) = context.session_id.as_deref() else {
        return;
    };
    let Some(coordinator) = get_global_coordinator() else {
        return;
    };
    coordinator.get_session_manager().record_review_read(
        session_id,
        &resolved.logical_path,
        revision,
        read_result.start_line,
        read_result.end_line,
        read_result.total_lines,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::tool_context_runtime::ToolUseContext;
    use crate::agentic::WorkspaceBinding;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn test_context(session_id: Option<&str>, root: PathBuf) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: session_id.map(str::to_string),
            dialog_turn_id: Some("turn-1".to_string()),
            workspace: Some(WorkspaceBinding::new(None, root)),
            loaded_deferred_tool_specs: Vec::new(),
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn file_revision_detects_same_size_content_changes_with_restored_mtime() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("review.txt");
        std::fs::write(&path, b"alpha").expect("write original");
        let original_mtime = filetime::FileTime::from_last_modification_time(
            &std::fs::metadata(&path).expect("original metadata"),
        );
        let context = test_context(None, temp.path().to_path_buf());
        let resolved = context
            .resolve_tool_path("review.txt")
            .expect("resolve file");
        let original = file_revision(&context, &resolved)
            .await
            .expect("original revision");

        std::fs::write(&path, b"bravo").expect("write replacement");
        filetime::set_file_mtime(&path, original_mtime).expect("restore mtime");
        let replacement = file_revision(&context, &resolved)
            .await
            .expect("replacement revision");

        assert_eq!(original.modified_ns, replacement.modified_ns);
        assert_eq!(original.byte_len, replacement.byte_len);
        assert_ne!(original.content_sha256, replacement.content_sha256);
        assert_ne!(original, replacement);
    }

    #[test]
    fn review_read_receipts_do_not_treat_a_custom_legacy_name_as_a_builtin_worker() {
        let mut custom = test_context(Some("session-1"), PathBuf::from("/tmp"));
        custom.agent_type = Some("ReviewSecurity".to_string());
        assert!(!review_read_receipts_enabled(&custom));

        custom.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            serde_json::json!({}),
        );
        assert!(review_read_receipts_enabled(&custom));

        let mut worker = test_context(Some("session-2"), PathBuf::from("/tmp"));
        worker.agent_type = Some("ReviewWorker".to_string());
        assert!(review_read_receipts_enabled(&worker));
    }
}
