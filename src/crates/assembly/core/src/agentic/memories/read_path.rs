use crate::agentic::memories::workspace::memory_summary_file;
use log::{debug, info, warn};
use std::path::Path;

const MEMORY_SUMMARY_TOKEN_LIMIT: usize = 2_500;
const APPROX_BYTES_PER_TOKEN: usize = 4;

pub(crate) async fn build_memory_read_path_reminder(memory_root: &Path) -> Option<String> {
    let memory_summary_path = memory_summary_file(memory_root);
    debug!(
        "Memory read-path reminder loading summary: memory_root={}, summary_path={}",
        memory_root.display(),
        memory_summary_path.display()
    );
    match tokio::fs::read_to_string(&memory_summary_path).await {
        Ok(summary) => {
            let summary = summary.trim();
            if summary.is_empty() {
                info!(
                    "Memory read-path reminder skipped because summary is empty: path={}",
                    memory_summary_path.display()
                );
                None
            } else {
                let memory_summary = truncate_memory_summary(summary);
                let reminder = render_memory_read_path_reminder(memory_root, &memory_summary);
                info!(
                    "Memory read-path reminder built: memory_root={}, summary_bytes={}, injected_summary_bytes={}, reminder_bytes={}",
                    memory_root.display(),
                    summary.len(),
                    memory_summary.len(),
                    reminder.len()
                );
                Some(reminder)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            info!(
                "Memory read-path reminder skipped because summary file is missing: path={}",
                memory_summary_path.display()
            );
            None
        }
        Err(error) => {
            warn!(
                "Failed to read memory summary: path={} error={}",
                memory_summary_path.display(),
                error
            );
            None
        }
    }
}

fn truncate_memory_summary(summary: &str) -> String {
    truncate_head_tokens(summary.trim(), MEMORY_SUMMARY_TOKEN_LIMIT)
}

fn truncate_head_tokens(text: &str, token_limit: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let byte_limit = token_limit.saturating_mul(APPROX_BYTES_PER_TOKEN);
    if text.len() <= byte_limit {
        return text.to_string();
    }

    let mut end = byte_limit.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let omitted_tokens = approx_token_count(&text[end..]);
    format!(
        "{}\n\n[Memory summary truncated: approximately {} tokens omitted]",
        &text[..end],
        omitted_tokens
    )
}

fn approx_token_count(text: &str) -> usize {
    text.len().div_ceil(APPROX_BYTES_PER_TOKEN)
}

fn render_memory_read_path_reminder(memory_root: &Path, memory_summary: &str) -> String {
    format!(
        r#"## Memory

You have access to a local OpenBitFun memory folder with guidance from prior runs. Use it when it is likely to help with the current request.

Decision boundary:
- Skip memory only when the request is clearly self-contained and does not need workspace history, prior decisions, or user preferences.
- Use memory when the request mentions this repo, paths, modules, prior work, prior decisions, or a non-trivial task related to the memory summary below.
- If unsure, do a quick memory pass.

Memory layout:
- {base_path}/memory_summary.md is already provided below; do not read it again.
- {base_path}/MEMORY.md is the searchable registry and the primary file to inspect for deeper context.
- {base_path}/rollout_summaries/ contains per-rollout evidence snippets referenced by MEMORY.md.
- {base_path}/extensions/ad_hoc/notes/ is where user-requested memory updates should be written.

Quick memory pass:
1. Skim MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search {base_path}/MEMORY.md for those keywords.
3. Only if MEMORY.md points to relevant evidence, read the 1-2 matching files under {base_path}/rollout_summaries/.
4. If there are no relevant hits, stop memory lookup and continue normally.

Tool access:
- Prefer the built-in memory tools when this session exposes them:
  - MemorySearch finds relevant memory entries in the memory folder.
  - MemoryFetch reads one specific memory file and updates the memory usage statistics automatically.
  - MemorySave writes an ad-hoc memory note when the user asks to update, save, or remember memory.
- When those memory tools are not available, use the normal local file/search tools available in this session, such as Read, Grep, Glob, or ExecCommand, against the memory folder above.
- The memory folder path above is an authorized local memory root for this read path. Do not use it to inspect unrelated user files.
- If file/search tools are unavailable, rely only on MEMORY_SUMMARY and say when a useful deeper lookup could not be performed.

Memory citation requirements:
- If any memory files beyond the injected MEMORY_SUMMARY were used, append exactly one <openbitfun-mem-citation> block as the very last content of the final reply.
- Use this structure:
<openbitfun-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[short reason]
rollout_summaries/example.md:3-4|note=[short reason]
</citation_entries>
<rollout_ids>
rollout-or-session-id
</rollout_ids>
</openbitfun-mem-citation>
- citation_entries paths must be relative to the memory root.
- Use tight, non-blank line ranges.
- Include rollout_ids only when the referenced memory file exposes stable rollout or session ids.
- Do not include memory citations inside pull-request messages or other user-requested generated artifacts.
- MemoryFetch records usage on its own, so no citation block is needed for memory read through that tool. The citation block is still required for memory read through the direct file tools (Read, Grep, Glob, ExecCommand).

Updating memories:
- Write ad hoc memory notes only when the user explicitly asks to update, save, or remember memory.
- Prefer MemorySave when it is available; otherwise write one small note under {base_path}/extensions/ad_hoc/notes/.
- Name it YYYY-MM-DDTHH-MM-SS-<short-slug>.md using only lowercase ASCII letters, digits, and hyphens in the slug.
- Use the normal Write tool for this exact path when an ad hoc note is needed.
- Do not edit MEMORY.md or memory_summary.md directly for ad hoc updates.

========= MEMORY_SUMMARY BEGINS =========
{memory_summary}
========= MEMORY_SUMMARY ENDS =========

When memory is likely relevant, start with the quick memory pass before deeper repo exploration."#,
        base_path = memory_root.display(),
        memory_summary = memory_summary.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::{build_memory_read_path_reminder, MEMORY_SUMMARY_TOKEN_LIMIT};

    #[tokio::test]
    async fn memory_read_path_wraps_summary_with_usage_instructions() {
        let temp = tempfile::tempdir().unwrap();
        let memory_root = temp.path().join("memories");
        tokio::fs::create_dir_all(&memory_root).await.unwrap();
        tokio::fs::write(
            crate::agentic::memories::workspace::memory_summary_file(&memory_root),
            "Memory summary body",
        )
        .await
        .unwrap();

        let reminder = build_memory_read_path_reminder(&memory_root)
            .await
            .expect("memory summary should load");

        assert!(reminder.contains("## Memory"));
        assert!(reminder.contains("MEMORY.md is the searchable registry"));
        assert!(reminder.contains("extensions/ad_hoc/notes"));
        assert!(reminder.contains("Use the normal Write tool"));
        assert!(reminder.contains("<openbitfun-mem-citation>"));
        assert!(reminder.contains("Memory summary body"));
        assert!(reminder.contains(&memory_root.display().to_string()));
    }

    #[tokio::test]
    async fn memory_read_path_prefers_builtin_memory_tools() {
        let temp = tempfile::tempdir().unwrap();
        let memory_root = temp.path().join("memories");
        tokio::fs::create_dir_all(&memory_root).await.unwrap();
        tokio::fs::write(
            crate::agentic::memories::workspace::memory_summary_file(&memory_root),
            "Memory summary body",
        )
        .await
        .unwrap();

        let reminder = build_memory_read_path_reminder(&memory_root)
            .await
            .expect("memory summary should load");

        assert!(reminder.contains("MemorySearch"));
        assert!(reminder.contains("MemoryFetch"));
        assert!(reminder.contains("MemorySave"));
        assert!(reminder.contains("updates the memory usage statistics automatically"));
        assert!(reminder.contains("The citation block is still required"));
    }

    #[tokio::test]
    async fn memory_read_path_truncates_large_summary() {
        let temp = tempfile::tempdir().unwrap();
        let memory_root = temp.path().join("memories");
        tokio::fs::create_dir_all(&memory_root).await.unwrap();
        let large_summary = "a".repeat(MEMORY_SUMMARY_TOKEN_LIMIT * 4 + 128);
        tokio::fs::write(
            crate::agentic::memories::workspace::memory_summary_file(&memory_root),
            format!("{large_summary}\nSHOULD_NOT_APPEAR"),
        )
        .await
        .unwrap();

        let reminder = build_memory_read_path_reminder(&memory_root)
            .await
            .expect("memory summary should load");

        assert!(reminder.contains("[Memory summary truncated: approximately"));
        assert!(!reminder.contains("SHOULD_NOT_APPEAR"));
    }
}
