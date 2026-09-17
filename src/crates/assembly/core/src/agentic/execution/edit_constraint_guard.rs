//! Edit constraint guard.
//!
//! Extracts explicit "don't modify X" constraints from user instructions and
//! exposes deterministic checks for file-mutation tools. Extraction evidence is
//! persisted with the session. Optional product diagnostics can record guard
//! decisions and successful direct mutations in a session-scoped JSONL stream.

use log::warn;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::tools::framework::{ToolUseContext, ValidationResult};
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::util::json_extract::extract_json_from_ai_response;
use crate::util::types::Message;

mod complete_shell;
mod model;
mod shell_targets;
pub use complete_shell::check_exec_command;
#[cfg(test)]
pub(crate) use complete_shell::check_with_state as check_shell_with_state;

pub(crate) async fn has_active_shell_constraints(context: &ToolUseContext) -> bool {
    complete_shell::active_state(context).await.is_some()
}

pub use model::{
    AgentCreatedPathRecord, ConstraintExtractionRecord, ConstraintMatcher,
    ConstraintOperationScope, ConstraintRevocation, ConstraintSource, EditConstraintState,
    ExtractedConstraint, ExtractionFailure, ExtractionStatus, ModelExtractionStatus,
};
#[cfg(test)]
use shell_targets::ShellMutationOperation;
use shell_targets::{explicit_bash_mutation_targets, has_unresolved_bash_mutation};

pub const EDIT_CONSTRAINT_METADATA_KEY: &str = "editConstraintGuard";
const EDIT_CONSTRAINT_SCHEMA_VERSION: u32 = 6;
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_RESPONSE_TELEMETRY_CHARS: usize = 4_000;
const MAX_MODEL_ATTEMPTS: usize = 2;
const MAX_RECURSIVE_INSPECTION_ENTRIES: usize = 100_000;
const TELEMETRY_RELATIVE_PATH: &str = "telemetry/edit-constraint-guard.jsonl";
const TELEMETRY_ENV: &str = "OPENBITFUN_EDIT_CONSTRAINT_TELEMETRY";

#[cfg(test)]
tokio::task_local! {
    pub(crate) static TEST_ENABLED: bool;
}

/// The guard is an evaluation-oriented feature and is disabled for normal
/// product sessions unless explicitly enabled in AI settings.
pub async fn is_enabled() -> bool {
    #[cfg(test)]
    if let Ok(enabled) = TEST_ENABLED.try_with(|enabled| *enabled) {
        return enabled;
    }
    let Ok(service) = crate::service::config::get_global_config_service().await else {
        return false;
    };
    service
        .get_config::<bool>(Some("ai.enable_edit_constraint_guard"))
        .await
        .unwrap_or(false)
}

const EXTRACTION_SYSTEM_PROMPT: &str = r#"You update the active file-edit prohibitions for a software task.

You receive the currently active prohibitions and the latest user message.

- Add a prohibition only when the latest message explicitly forbids modifying
  certain files, file types, or categories of files.
- Revoke an active prohibition only when the latest message explicitly cancels,
  relaxes, or contradicts it (e.g. "you may modify tests now"). A revocation
  MUST copy the exact constraint_id from the active list. Never invent an id.
- An unrelated message does not revoke anything.
- Ignore constraints about anything other than *which files may be edited*.

For each added prohibition, classify it into exactly ONE matcher kind and one
operation scope:
- "test_files": the prohibition is about test files / testing logic in general
- "path_contains": the prohibition names specific files or keywords (give the literal substrings)
- "path_under_dir": the prohibition names a specific directory (give the directory names)
- "extension": the prohibition is about a specific file type (give the extensions, including the dot)
- "unmatched": you found a prohibition but it doesn't fit any of the above

Use operation_scope "delete_only" only when the user explicitly prohibits
deleting/removing files, without also prohibiting other edits. Otherwise use
"all".

Respond with ONLY a fenced ```json code block containing this exact shape:
```json
{
  "additions": [
    {"description": "<short paraphrase>", "operation_scope": "all", "matcher": {"kind": "test_files"}},
    {"description": "<short paraphrase>", "operation_scope": "all", "matcher": {"kind": "path_contains", "substrings": ["..."]}},
    {"description": "<short paraphrase>", "operation_scope": "all", "matcher": {"kind": "path_under_dir", "dirs": ["..."]}},
    {"description": "<short paraphrase>", "operation_scope": "all", "matcher": {"kind": "extension", "exts": [".ext"]}},
    {"description": "<short paraphrase>", "operation_scope": "all", "matcher": {"kind": "unmatched"}}
  ],
  "revocations": [
    {"constraint_id": "<exact active constraint id>", "description": "<what the user explicitly relaxed>"}
  ]
}
```
If the latest message changes nothing, return empty `additions` and
`revocations`."#;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtractionResponse {
    additions: Vec<ExtractedConstraint>,
    revocations: Vec<ConstraintRevocation>,
}

pub fn message_sha256(message: &str) -> String {
    format!("{:x}", Sha256::digest(message.as_bytes()))
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn truncate_for_extraction(message: &str) -> (String, bool) {
    let chars = message.chars().collect::<Vec<_>>();
    if chars.len() <= MAX_PROMPT_CHARS {
        return (message.to_string(), false);
    }

    let side = MAX_PROMPT_CHARS / 2;
    let mut output = chars[..side].iter().collect::<String>();
    output.push_str("\n...[middle of task omitted for constraint extraction]...\n");
    output.extend(chars[chars.len() - side..].iter());
    (output, true)
}

fn relevant_sentences(message: &str) -> impl Iterator<Item = &str> {
    message
        .split_inclusive(|character: char| {
            matches!(character, '.' | '!' | '?' | '\n' | '。' | '！' | '？')
        })
        .map(str::trim)
        .filter(|sentence| !sentence.is_empty())
}

fn has_prohibition_signal(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "do not",
        "don't",
        "dont",
        "must not",
        "should not",
        "never modify",
        "never change",
        "do not delete",
        "don't delete",
        "must not delete",
        "not allowed to modify",
        "avoid modifying",
        "keep ",
        "leave ",
        "off limits",
        "read-only",
        "must remain unchanged",
        "must remain untouched",
        "without modifying",
        "without changing",
        "only modify",
        "only change",
        "non-test files only",
        "不得",
        "不能修改",
        "不能删除",
        "禁止修改",
        "禁止删除",
        "不要修改",
        "不要更改",
        "不要删除",
        "测试文件保持不变",
        "仅修改非测试",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
}

fn has_relaxation_signal(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "may modify",
        "can modify",
        "may change",
        "can change",
        "may edit",
        "can edit",
        "allowed to modify",
        "allowed to change",
        "allowed to edit",
        "feel free to modify",
        "feel free to change",
        "feel free to edit",
        "restriction is lifted",
        "restriction no longer applies",
        "no longer off limits",
        "forget that restriction",
        "remove that restriction",
        "可以修改",
        "可以改",
        "允许修改",
        "不再禁止",
        "取消限制",
        "解除限制",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
}

fn matches_any_regex(
    patterns: &'static OnceLock<Vec<Regex>>,
    sources: &[&str],
    text: &str,
) -> bool {
    patterns
        .get_or_init(|| {
            sources
                .iter()
                .map(|source| Regex::new(source).expect("valid edit-constraint regex"))
                .collect()
        })
        .iter()
        .any(|pattern| pattern.is_match(text))
}

fn explicit_test_mutation_restriction(text: &str) -> bool {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    matches_any_regex(
        &PATTERNS,
        &[
            r"\b(?:do not|don't|dont|must not|should not|never|avoid)\s+(?:modify|change|edit|touch|update|alter|write)\s+(?:any\s+)?(?:of\s+)?(?:the\s+)?(?:test files?|tests?|testing logic)\b",
            r"\b(?:test files?|tests?|testing logic)\s+(?:must|should|can)\s+not\s+be\s+(?:modified|changed|edited|touched|updated|altered|written)\b",
            r"\b(?:keep|leave)\s+(?:the\s+)?(?:test files?|tests?|testing logic)\s+(?:unchanged|untouched|as[- ]is)\b",
            r"\b(?:test files?|tests?|testing logic)\s+(?:are|is)\s+(?:off limits|read[- ]only)\b",
            r"\b(?:test files?|tests?|testing logic)\s+must\s+remain\s+(?:unchanged|untouched)\b",
            r"\bwithout\s+(?:modifying|changing|editing|touching|updating|altering)\s+(?:the\s+)?(?:test files?|tests?|testing logic)\b",
            r"\bonly\s+(?:modify|change|edit|touch|update)\s+(?:the\s+)?non[- ]tests?(?:\s+files?)?\b",
            r"\b(?:changes?|edits?)\s+(?:must|should)\s+be\s+(?:limited|restricted)\s+to\s+non[- ]tests?(?:\s+files?)?\b",
            r"(?:不要|不得|禁止|不能)(?:修改|改动|更改|编辑|触碰|写入)(?:任何)?(?:测试文件|测试|测试逻辑)",
            r"(?:测试文件|测试|测试逻辑)(?:不得|禁止|不能)(?:被)?(?:修改|改动|更改|编辑|触碰|写入)",
            r"(?:保持|维持)(?:测试文件|测试|测试逻辑)不变",
            r"(?:测试文件|测试|测试逻辑)(?:保持|维持)不变",
            r"仅(?:修改|改动|更改|编辑)非测试(?:文件)?",
        ],
        text,
    )
}

fn explicit_test_delete_restriction(text: &str) -> bool {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    matches_any_regex(
        &PATTERNS,
        &[
            r"\b(?:do not|don't|dont|must not|should not|never|avoid)\s+(?:delete|remove|unlink)\s+(?:any\s+)?(?:of\s+)?(?:the\s+)?(?:test files?|tests?|testing logic)\b",
            r"\b(?:test files?|tests?|testing logic)\s+(?:must|should|can)\s+not\s+be\s+(?:deleted|removed|unlinked)\b",
            r"(?:不要|不得|禁止|不能)(?:删除|移除)(?:任何)?(?:测试文件|测试|测试逻辑)",
            r"(?:测试文件|测试|测试逻辑)(?:不得|禁止|不能)(?:被)?(?:删除|移除)",
        ],
        text,
    )
}

fn deterministic_test_constraint(message: &str) -> Option<ExtractedConstraint> {
    relevant_sentences(message).find_map(|sentence| {
        let lower = sentence.to_lowercase();
        let explicitly_relaxes_tests = [
            "may modify tests",
            "may modify test files",
            "can modify tests",
            "can modify test files",
            "allowed to modify tests",
            "allowed to modify test files",
            "tests are no longer off limits",
            "test files are no longer off limits",
            "test restriction is lifted",
            "test-file restriction is lifted",
            "可以修改测试",
            "可以改测试",
            "允许修改测试",
            "测试文件可以修改",
            "测试可以修改",
            "不再禁止修改测试",
        ]
        .iter()
        .any(|signal| lower.contains(signal));
        if explicitly_relaxes_tests {
            return None;
        }
        let prohibits_mutation = explicit_test_mutation_restriction(&lower);
        let prohibits_delete = explicit_test_delete_restriction(&lower);

        (prohibits_mutation || prohibits_delete).then(|| {
            let source_text = sentence.chars().take(500).collect::<String>();
            ExtractedConstraint {
                id: if prohibits_delete && !prohibits_mutation {
                    "deterministic:test_files:delete_only".to_string()
                } else {
                    "deterministic:test_files".to_string()
                },
                description: if prohibits_delete && !prohibits_mutation {
                    "The task explicitly says not to delete test files or testing logic".to_string()
                } else {
                    "The task explicitly says not to modify test files or testing logic".to_string()
                },
                operation_scope: if prohibits_delete && !prohibits_mutation {
                    ConstraintOperationScope::DeleteOnly
                } else {
                    ConstraintOperationScope::All
                },
                matcher: ConstraintMatcher::TestFiles,
                source: ConstraintSource::Deterministic,
                source_text: Some(source_text),
            }
        })
    })
}

fn candidate_paths(context: Option<&ToolUseContext>, file_path: &str) -> Vec<String> {
    let mut candidates = vec![file_path.replace('\\', "/")];
    let Some(context) = context else {
        return candidates;
    };
    let Ok(resolved) = context.resolve_tool_path(file_path) else {
        return candidates;
    };
    for path in [
        resolved.logical_path.clone(),
        resolved.resolved_path.clone(),
    ] {
        let normalized = path.replace('\\', "/");
        if !candidates.contains(&normalized) {
            candidates.push(normalized);
        }
    }
    if !resolved.uses_remote_workspace_backend() {
        let resolved_path = Path::new(&resolved.resolved_path);
        let canonical = fs::canonicalize(resolved_path).ok().or_else(|| {
            let parent = resolved_path.parent()?;
            let file_name = resolved_path.file_name()?;
            fs::canonicalize(parent)
                .ok()
                .map(|parent| parent.join(file_name))
        });
        if let Some(canonical) = canonical {
            let normalized = canonical.to_string_lossy().replace('\\', "/");
            if !candidates.contains(&normalized) {
                candidates.push(normalized);
            }
        }
    }
    candidates
}

fn normalize_model_constraints(constraints: &mut [ExtractedConstraint], message_sha256: &str) {
    let message_prefix = message_sha256.chars().take(12).collect::<String>();
    for (index, constraint) in constraints.iter_mut().enumerate() {
        constraint.id = format!("model:{message_prefix}:{index}");
        constraint.source = ConstraintSource::Model;
    }
}

fn validated_revocation_ids(
    revocations: &[ConstraintRevocation],
    active_constraints: &[ExtractedConstraint],
    revocation_authorized: bool,
) -> (Vec<String>, Vec<String>) {
    if !revocation_authorized {
        return (Vec::new(), Vec::new());
    }

    let mut revoked = Vec::new();
    let mut unmatched = Vec::new();
    for revocation in revocations {
        let constraint_id = revocation.constraint_id.trim();
        if active_constraints
            .iter()
            .any(|constraint| constraint.id == constraint_id)
        {
            if !revoked.iter().any(|existing| existing == constraint_id) {
                revoked.push(constraint_id.to_string());
            }
        } else if !unmatched.iter().any(|existing| existing == constraint_id) {
            unmatched.push(constraint_id.to_string());
        }
    }
    (revoked, unmatched)
}

fn response_excerpt(response: &str) -> String {
    response
        .chars()
        .take(MAX_RESPONSE_TELEMETRY_CHARS)
        .collect()
}

/// Extract constraints from one user instruction when there is no prior
/// session state. Kept as the simple entry point for callers and tests that do
/// not need revocation semantics.
pub async fn extract_constraints(user_message: &str) -> ConstraintExtractionRecord {
    extract_constraints_with_active(user_message, &[]).await
}

/// Extract additions and explicit revocations from one user instruction.
/// Explicit test-file prohibitions are recognized deterministically before the
/// model call, while revocations are accepted only from a successfully parsed
/// fast-model response that references an active constraint id.
pub async fn extract_constraints_with_active(
    user_message: &str,
    active_constraints: &[ExtractedConstraint],
) -> ConstraintExtractionRecord {
    extract_constraints_with_active_and_revocation_authorization(
        user_message,
        active_constraints,
        true,
    )
    .await
}

/// Extract additions and explicit revocations from one instruction, applying
/// revocations only when the caller has established that the text came from a
/// real user submission. Internal follow-ups may add protections but must
/// never relax a protection on the user's behalf.
pub async fn extract_constraints_with_active_and_revocation_authorization(
    user_message: &str,
    active_constraints: &[ExtractedConstraint],
    revocation_authorized: bool,
) -> ConstraintExtractionRecord {
    let message = if is_enabled().await { user_message } else { "" };
    extract_instruction(message, active_constraints, revocation_authorized).await
}

async fn extract_instruction(
    user_message: &str,
    active_constraints: &[ExtractedConstraint],
    revocation_authorized: bool,
) -> ConstraintExtractionRecord {
    let started_at = Instant::now();
    let input_chars = user_message.chars().count();
    let message_sha256 = message_sha256(user_message);
    let active_constraint_ids = active_constraints
        .iter()
        .map(|constraint| constraint.id.clone())
        .collect::<Vec<_>>();
    if user_message.trim().is_empty() {
        return ConstraintExtractionRecord {
            message_sha256,
            dialog_turn_id: None,
            status: ExtractionStatus::NoConstraints,
            constraints: Vec::new(),
            deterministic_constraint_count: 0,
            model_attempts: 0,
            active_constraint_ids,
            revocation_authorized,
            model_status: ModelExtractionStatus::NotRun,
            model_constraints: Vec::new(),
            model_revocations: Vec::new(),
            revoked_constraint_ids: Vec::new(),
            unmatched_revocation_ids: Vec::new(),
            input_chars,
            prompt_chars: 0,
            input_truncated: false,
            latency_ms: 0,
            extracted_at_ms: timestamp_ms(),
            failure: None,
            response_excerpt: None,
        };
    }

    let mut constraints = deterministic_test_constraint(user_message)
        .into_iter()
        .collect::<Vec<_>>();
    let deterministic_constraint_count = constraints.len();
    let (truncated, input_truncated) = truncate_for_extraction(user_message);
    let prompt_chars = truncated.chars().count();

    // Irrelevant follow-ups stay on the local fast path even when constraints
    // are active. Only messages that may add or relax a file-edit boundary use
    // the model-backed classifier.
    if !has_prohibition_signal(user_message) && !has_relaxation_signal(user_message) {
        return ConstraintExtractionRecord {
            message_sha256,
            dialog_turn_id: None,
            status: if constraints.is_empty() {
                ExtractionStatus::NoConstraints
            } else {
                ExtractionStatus::Extracted
            },
            constraints,
            deterministic_constraint_count,
            model_attempts: 0,
            active_constraint_ids,
            revocation_authorized,
            model_status: ModelExtractionStatus::NotRun,
            model_constraints: Vec::new(),
            model_revocations: Vec::new(),
            revoked_constraint_ids: Vec::new(),
            unmatched_revocation_ids: Vec::new(),
            input_chars,
            prompt_chars,
            input_truncated,
            latency_ms: started_at
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            extracted_at_ms: timestamp_ms(),
            failure: None,
            response_excerpt: None,
        };
    }

    let factory = match get_global_ai_client_factory().await {
        Ok(factory) => factory,
        Err(error) => {
            return extraction_with_failure(
                started_at,
                message_sha256,
                constraints,
                deterministic_constraint_count,
                0,
                active_constraint_ids,
                revocation_authorized,
                input_chars,
                prompt_chars,
                input_truncated,
                "client_factory",
                error.to_string(),
                None,
            );
        }
    };
    let client = match factory.get_client_resolved("fast").await {
        Ok(client) => client,
        Err(error) => {
            return extraction_with_failure(
                started_at,
                message_sha256,
                constraints,
                deterministic_constraint_count,
                0,
                active_constraint_ids,
                revocation_authorized,
                input_chars,
                prompt_chars,
                input_truncated,
                "client_resolution",
                error.to_string(),
                None,
            );
        }
    };

    let active_constraints_json =
        serde_json::to_string(active_constraints).unwrap_or_else(|_| "[]".to_string());
    let task_message = format!(
        "<active_constraints>\n{active_constraints_json}\n</active_constraints>\n\
         <latest_user_message>\n{truncated}\n</latest_user_message>"
    );
    let mut failure = None;
    let mut last_response_excerpt = None;
    let mut model_attempts = 0;
    let mut model_status = ModelExtractionStatus::Failed;
    let mut model_constraints = Vec::new();
    let mut model_revocations = Vec::new();
    let mut revoked_constraint_ids = Vec::new();
    let mut unmatched_revocation_ids = Vec::new();

    for attempt in 1..=MAX_MODEL_ATTEMPTS {
        model_attempts = attempt;
        let response = match client
            .send_message(
                vec![
                    Message::system(EXTRACTION_SYSTEM_PROMPT.to_string()),
                    Message::user(task_message.clone()),
                ],
                None,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                failure = Some(ExtractionFailure {
                    stage: "model_request".to_string(),
                    reason: error.to_string(),
                });
                continue;
            }
        };

        last_response_excerpt = Some(response_excerpt(&response.text));
        if response.text.trim().is_empty() {
            failure = Some(ExtractionFailure {
                stage: "empty_response".to_string(),
                reason: "The extraction model returned no text".to_string(),
            });
            continue;
        }
        let Some(json_string) = extract_json_from_ai_response(&response.text) else {
            failure = Some(ExtractionFailure {
                stage: "json_extraction".to_string(),
                reason: "No JSON object was found in the extraction response".to_string(),
            });
            continue;
        };
        match serde_json::from_str::<ExtractionResponse>(&json_string) {
            Ok(mut parsed) => {
                normalize_model_constraints(&mut parsed.additions, &message_sha256);
                model_constraints = parsed.additions.clone();
                model_revocations = parsed.revocations;

                (revoked_constraint_ids, unmatched_revocation_ids) = validated_revocation_ids(
                    &model_revocations,
                    active_constraints,
                    revocation_authorized,
                );

                for constraint in &model_constraints {
                    if !constraints
                        .iter()
                        .any(|existing| existing.matcher == constraint.matcher)
                    {
                        constraints.push(constraint.clone());
                    }
                }
                model_status = ModelExtractionStatus::Parsed;
                failure = None;
                break;
            }
            Err(error) => {
                failure = Some(ExtractionFailure {
                    stage: "schema_validation".to_string(),
                    reason: error.to_string(),
                });
            }
        }
    }

    let status = if !constraints.is_empty() || !revoked_constraint_ids.is_empty() {
        ExtractionStatus::Extracted
    } else if failure.is_some() {
        ExtractionStatus::Failed
    } else {
        ExtractionStatus::NoConstraints
    };

    ConstraintExtractionRecord {
        message_sha256,
        dialog_turn_id: None,
        status,
        constraints,
        deterministic_constraint_count,
        model_attempts,
        active_constraint_ids,
        revocation_authorized,
        model_status,
        model_constraints,
        model_revocations,
        revoked_constraint_ids,
        unmatched_revocation_ids,
        input_chars,
        prompt_chars,
        input_truncated,
        latency_ms: started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        extracted_at_ms: timestamp_ms(),
        failure,
        response_excerpt: last_response_excerpt,
    }
}

/// Returns whether an extraction contains state or diagnostic evidence worth
/// persisting. The common no-signal path deliberately leaves session metadata
/// untouched so ordinary turns do not grow the guard history.
pub fn extraction_requires_session_state(record: &ConstraintExtractionRecord) -> bool {
    record.status != ExtractionStatus::NoConstraints || record.model_attempts > 0
}

#[allow(clippy::too_many_arguments)]
fn extraction_with_failure(
    started_at: Instant,
    message_sha256: String,
    constraints: Vec<ExtractedConstraint>,
    deterministic_constraint_count: usize,
    model_attempts: usize,
    active_constraint_ids: Vec<String>,
    revocation_authorized: bool,
    input_chars: usize,
    prompt_chars: usize,
    input_truncated: bool,
    stage: &str,
    reason: String,
    response_excerpt: Option<String>,
) -> ConstraintExtractionRecord {
    ConstraintExtractionRecord {
        message_sha256,
        dialog_turn_id: None,
        status: if constraints.is_empty() {
            ExtractionStatus::Failed
        } else {
            ExtractionStatus::Extracted
        },
        constraints,
        deterministic_constraint_count,
        model_attempts,
        active_constraint_ids,
        revocation_authorized,
        model_status: ModelExtractionStatus::Failed,
        model_constraints: Vec::new(),
        model_revocations: Vec::new(),
        revoked_constraint_ids: Vec::new(),
        unmatched_revocation_ids: Vec::new(),
        input_chars,
        prompt_chars,
        input_truncated,
        latency_ms: started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        extracted_at_ms: timestamp_ms(),
        failure: Some(ExtractionFailure {
            stage: stage.to_string(),
            reason,
        }),
        response_excerpt,
    }
}

pub fn find_violation<'a>(
    constraints: &'a [ExtractedConstraint],
    file_path: &str,
) -> Option<&'a ExtractedConstraint> {
    find_violation_for_operation(constraints, file_path, "write")
}

fn find_violation_for_operation<'a>(
    constraints: &'a [ExtractedConstraint],
    file_path: &str,
    operation: &str,
) -> Option<&'a ExtractedConstraint> {
    constraints.iter().find(|constraint| {
        constraint.operation_scope.applies_to(operation) && constraint.matcher.matches(file_path)
    })
}

pub fn violation_message(file_path: &str, constraint: &ExtractedConstraint) -> String {
    format!(
        "This file (`{file_path}`) matches a constraint stated in the task: \"{}\". \
         This edit was not applied.\n\n\
         Editing a file you were told not to touch usually means your own implementation \
         doesn't match what's expected — not that the file is wrong. Reconsider your \
         source-code approach instead of adjusting this file.",
        constraint.description
    )
}

fn telemetry_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn telemetry_setting_enabled(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn edit_constraint_telemetry_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| telemetry_setting_enabled(std::env::var(TELEMETRY_ENV).ok().as_deref()))
}

fn try_append_tool_telemetry(
    context: &ToolUseContext,
    event: &Value,
) -> Result<std::path::PathBuf, String> {
    let Some(session_id) = context.session_id.as_deref() else {
        return Err("tool context has no session id".to_string());
    };
    let session_dir = context
        .current_workspace_session_dir(session_id)
        .map_err(|error| format!("failed to resolve session directory: {error}"))?;
    let path = session_dir.join(TELEMETRY_RELATIVE_PATH);
    append_jsonl(&path, event)?;
    Ok(path)
}

fn append_jsonl(path: &Path, event: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "telemetry path has no parent".to_string())?;

    let _guard = telemetry_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create telemetry directory: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open telemetry stream: {error}"))?;
    serde_json::to_writer(&mut file, event)
        .and_then(|_| file.write_all(b"\n").map_err(serde_json::Error::io))
        .map_err(|error| format!("failed to append telemetry event: {error}"))?;
    Ok(())
}

fn append_tool_telemetry(context: &ToolUseContext, event: &Value) {
    if !edit_constraint_telemetry_enabled() {
        return;
    }
    if let Err(error) = try_append_tool_telemetry(context, event) {
        warn!("Failed to append edit constraint telemetry event: {error}");
    }
}

fn resolved_path(context: &ToolUseContext, file_path: &str) -> Option<String> {
    context
        .resolve_tool_path(file_path)
        .ok()
        .map(|resolved| resolved.resolved_path)
}

fn decision_result(
    context: Option<&ToolUseContext>,
    tool_name: &str,
    operation: &str,
    file_path: &str,
    decision: &str,
    force_requested: bool,
    state: Option<&EditConstraintState>,
    violation: Option<&ExtractedConstraint>,
    message: Option<String>,
    error_code: Option<i32>,
) -> Option<ValidationResult> {
    let telemetry_enabled = edit_constraint_telemetry_enabled();
    if message.is_none() && !telemetry_enabled {
        return None;
    }
    let decision_id = Uuid::new_v4().to_string();
    if telemetry_enabled {
        if let Some(context) = context {
            append_tool_telemetry(
                context,
                &json!({
                    "event": "guard_decision",
                    "schema_version": EDIT_CONSTRAINT_SCHEMA_VERSION,
                    "decision_id": decision_id,
                    "timestamp_ms": timestamp_ms(),
                    "session_id": context.session_id,
                    "dialog_turn_id": context.dialog_turn_id,
                    "tool_call_id": context.tool_call_id,
                    "agent_type": context.agent_type,
                    "tool_name": tool_name,
                    "operation": operation,
                    "requested_path": file_path,
                    "resolved_path": resolved_path(context, file_path),
                    "workspace_kind": if context.is_remote() { "remote" } else { "local" },
                    "decision": decision,
                    "force_requested": force_requested,
                    "extraction_status": state.and_then(EditConstraintState::latest_status),
                    "constraint": violation,
                }),
            );
        }
    }

    message.map(|message| ValidationResult {
        result: false,
        message: Some(message),
        error_code,
        meta: Some(json!({
            "failure_kind": "edit_constraint_guard",
            "blocks_input_rewrite": true,
            "guard_decision_id": decision_id,
            "guard_decision": decision,
            "constraint_id": violation.map(|constraint| constraint.id.as_str()),
            "protected_path": file_path,
            "force_requested": force_requested,
        })),
    })
}

/// Deterministic guard check shared by direct file mutation tools.
///
/// `force` is no longer a model-controlled escape hatch. A stale caller that
/// still sends it is rejected and recorded explicitly.
fn check(
    context: Option<&ToolUseContext>,
    tool_name: &str,
    operation: &str,
    file_path: &str,
    force_requested: bool,
) -> Option<ValidationResult> {
    let state = context
        .and_then(|value| value.session_id.as_deref())
        .and_then(|session_id| {
            get_global_coordinator()?
                .get_session_manager()
                .edit_constraint_state(session_id)
        });

    if !force_requested
        && !edit_constraint_telemetry_enabled()
        && state
            .as_ref()
            .is_none_or(|state| !state.has_enforceable_constraints())
    {
        return None;
    }
    if !force_requested
        && state
            .as_ref()
            .is_none_or(|state| !state.has_enforceable_constraints())
    {
        if edit_constraint_telemetry_enabled() {
            decision_result(
                context,
                tool_name,
                operation,
                file_path,
                "allow_no_active_constraint",
                false,
                state.as_ref(),
                None,
                None,
                None,
            );
        }
        return None;
    }

    if force_requested {
        return decision_result(
            context,
            tool_name,
            operation,
            file_path,
            "force_denied",
            true,
            state.as_ref(),
            None,
            Some(
                "`force` cannot override constraints stated by the user. Reconsider the source-code approach without modifying the protected file."
                    .to_string(),
            ),
            Some(403),
        );
    }

    let paths = candidate_paths(context, file_path);
    let violation = state.as_ref().and_then(|state| {
        paths
            .iter()
            .find_map(|path| find_violation_for_operation(&state.constraints, path, operation))
    });
    if let Some(violation) = violation {
        return decision_result(
            context,
            tool_name,
            operation,
            file_path,
            "deny",
            false,
            state.as_ref(),
            Some(violation),
            Some(violation_message(file_path, violation)),
            Some(403),
        );
    }

    let decision = match state.as_ref().and_then(EditConstraintState::latest_status) {
        Some(ExtractionStatus::Failed) | None => "allow_extraction_unavailable",
        _ => "allow",
    };
    decision_result(
        context,
        tool_name,
        operation,
        file_path,
        decision,
        false,
        state.as_ref(),
        None,
        None,
        None,
    );
    None
}

async fn write_target_exists(context: &ToolUseContext, file_path: &str) -> Option<bool> {
    let resolved = context.resolve_tool_path(file_path).ok()?;
    if resolved.uses_remote_workspace_backend() {
        let fs = context.ws_fs()?;
        // Treat a failed remote inspection as existing so an unavailable
        // filesystem cannot become a way to overwrite a protected test file.
        return Some(fs.exists(&resolved.resolved_path).await.unwrap_or(true));
    }

    Some(Path::new(&resolved.resolved_path).exists())
}

fn has_only_relaxable_test_file_violations(
    state: &EditConstraintState,
    paths: &[String],
    operation: &str,
) -> bool {
    let violations = paths
        .iter()
        .flat_map(|path| {
            state.constraints.iter().filter(move |constraint| {
                constraint.operation_scope.applies_to(operation) && constraint.matcher.matches(path)
            })
        })
        .collect::<Vec<_>>();

    !violations.is_empty()
        && violations.iter().all(|constraint| {
            matches!(&constraint.matcher, ConstraintMatcher::TestFiles)
                && constraint.operation_scope == ConstraintOperationScope::All
        })
}

fn can_mutate_agent_created_test_file(
    state: Option<&EditConstraintState>,
    paths: &[String],
    operation: &str,
    newly_created: bool,
) -> bool {
    state.is_some_and(|state| {
        (newly_created || state.is_agent_created_path(paths))
            && has_only_relaxable_test_file_violations(state, paths, operation)
    })
}

/// Guard a Write operation while allowing a newly-created test helper.
///
/// A task instruction not to modify tests protects the repository's existing
/// tests from being adjusted to satisfy the task. It does not prohibit an
/// agent from creating an untracked repro or verification file. Other
/// constraint kinds retain their strict create-or-modify semantics.
pub async fn check_write(
    context: Option<&ToolUseContext>,
    tool_name: &str,
    operation: &str,
    file_path: &str,
    force_requested: bool,
) -> Option<ValidationResult> {
    if !is_enabled().await {
        return None;
    }
    let state = context
        .and_then(|value| value.session_id.as_deref())
        .and_then(|session_id| {
            get_global_coordinator()?
                .get_session_manager()
                .edit_constraint_state(session_id)
        });

    if !force_requested
        && state
            .as_ref()
            .is_none_or(|state| !state.tracks_agent_created_test_paths())
    {
        return check(context, tool_name, operation, file_path, false);
    }

    let is_new_file = if force_requested {
        false
    } else if let Some(context) = context {
        write_target_exists(context, file_path).await == Some(false)
    } else {
        false
    };
    let paths = candidate_paths(context, file_path);

    if can_mutate_agent_created_test_file(state.as_ref(), &paths, operation, is_new_file) {
        decision_result(
            context,
            tool_name,
            operation,
            file_path,
            if is_new_file {
                "allow_new_test_file"
            } else {
                "allow_agent_created_test_file"
            },
            false,
            state.as_ref(),
            None,
            None,
            None,
        );
        return None;
    }

    check(context, tool_name, operation, file_path, force_requested)
}

/// Guard an Edit operation while preserving the session provenance of helper
/// tests the agent created itself.
pub async fn check_edit(
    context: Option<&ToolUseContext>,
    tool_name: &str,
    operation: &str,
    file_path: &str,
    force_requested: bool,
) -> Option<ValidationResult> {
    if !is_enabled().await {
        return None;
    }
    let state = context
        .and_then(|value| value.session_id.as_deref())
        .and_then(|session_id| {
            get_global_coordinator()?
                .get_session_manager()
                .edit_constraint_state(session_id)
        });
    if !force_requested
        && !edit_constraint_telemetry_enabled()
        && state
            .as_ref()
            .is_none_or(|state| !state.has_enforceable_constraints())
    {
        return None;
    }
    if !force_requested
        && state
            .as_ref()
            .is_none_or(|state| !state.tracks_agent_created_test_paths())
    {
        return check(context, tool_name, operation, file_path, false);
    }
    let paths = candidate_paths(context, file_path);
    if !force_requested
        && can_mutate_agent_created_test_file(state.as_ref(), &paths, operation, false)
    {
        decision_result(
            context,
            tool_name,
            operation,
            file_path,
            "allow_agent_created_test_file",
            false,
            state.as_ref(),
            None,
            None,
            None,
        );
        return None;
    }
    check(context, tool_name, operation, file_path, force_requested)
}

/// Guard a Delete operation while allowing the agent to clean up a test file
/// it created in this session. A user-authored delete-only prohibition remains
/// strict and is never relaxed by file provenance.
pub async fn check_delete(
    context: Option<&ToolUseContext>,
    tool_name: &str,
    operation: &str,
    file_path: &str,
    force_requested: bool,
) -> Option<ValidationResult> {
    check_edit(context, tool_name, operation, file_path, force_requested).await
}

/// Preflight file targets in terminal commands. Explicit targets are checked
/// directly. When constraints are active, high-risk commands whose targets
/// remain dynamic or implicit are rejected before execution; ordinary build,
/// test, and read-only commands retain the normal shell path.
pub async fn check_bash_command(
    context: &ToolUseContext,
    command: &str,
) -> Option<ValidationResult> {
    if !is_enabled().await {
        return None;
    }
    let has_active_constraints = context.session_id.as_deref().is_some_and(|session_id| {
        get_global_coordinator()
            .and_then(|coordinator| {
                coordinator
                    .get_session_manager()
                    .edit_constraint_state(session_id)
            })
            .is_some_and(|state| state.has_enforceable_constraints())
    });
    if !has_active_constraints {
        return None;
    }
    let targets = explicit_bash_mutation_targets(command);
    for target in &targets {
        if let Some(rejection) = check(
            Some(context),
            "ExecCommand",
            target.operation.guard_operation(),
            &target.path,
            false,
        ) {
            return Some(rejection);
        }
    }
    if has_unresolved_bash_mutation(command, &targets) {
        let state = context.session_id.as_deref().and_then(|session_id| {
            get_global_coordinator()?
                .get_session_manager()
                .edit_constraint_state(session_id)
        });
        if let Some((state, constraint)) = state.and_then(|state| {
            let constraint = state
                .constraints
                .iter()
                .find(|constraint| constraint.matcher.enforceable())?
                .clone();
            Some((state, constraint))
        }) {
            return decision_result(
                Some(context),
                "ExecCommand",
                "unresolved_shell_mutation",
                "<dynamic shell target>",
                "deny_unresolved_target",
                false,
                Some(&state),
                Some(&constraint),
                Some(
                    "This command may modify files through a dynamic or implicit target while an edit constraint is active. Use a direct file tool or a command with explicit literal paths so the protected scope can be checked before execution."
                        .to_string(),
                ),
                Some(403),
            );
        }
    }
    None
}

pub async fn check_git_command(
    context: &ToolUseContext,
    operation: &str,
    arguments: &str,
) -> Option<ValidationResult> {
    let command = if arguments.trim().is_empty() {
        format!("git {operation}")
    } else {
        format!("git {operation} {}", arguments.trim())
    };
    check_bash_command(context, &command).await
}

/// Checks the target and every non-symlink descendant before recursive delete.
/// Inspection failures are fail-closed only when an enforceable constraint is
/// active, because otherwise there is no protected path to discover.
pub async fn check_recursive_delete(
    context: Option<&ToolUseContext>,
    root_path: &str,
    force_requested: bool,
) -> Option<ValidationResult> {
    if !is_enabled().await {
        return None;
    }
    if let Some(rejection) = check_delete(
        context,
        "Delete",
        "recursive_delete",
        root_path,
        force_requested,
    )
    .await
    {
        return Some(rejection);
    }
    let context = context?;
    let session_id = context.session_id.as_deref()?;
    let state = get_global_coordinator()?
        .get_session_manager()
        .edit_constraint_state(session_id)?;
    if !state.has_enforceable_constraints() {
        return None;
    }

    let resolved = match context.resolve_tool_path(root_path) {
        Ok(resolved) => resolved,
        Err(_) => return None,
    };
    let Some(workspace_fs) = context.ws_fs() else {
        if resolved.uses_remote_workspace_backend() {
            return decision_result(
                Some(context),
                "Delete",
                "recursive_delete",
                root_path,
                "deny_inspection_failed",
                false,
                Some(&state),
                None,
                Some(
                    "Recursive delete was not applied because the remote workspace filesystem is unavailable"
                        .to_string(),
                ),
                Some(503),
            );
        }
        return check_local_recursive_delete(context, root_path, &resolved.resolved_path, &state);
    };
    match workspace_fs.is_dir(&resolved.resolved_path).await {
        Ok(true) => {}
        Ok(false) => return None,
        Err(error) => {
            return decision_result(
                Some(context),
                "Delete",
                "recursive_delete",
                root_path,
                "deny_inspection_failed",
                false,
                Some(&state),
                None,
                Some(format!(
                    "Recursive delete was not applied because the target type could not be inspected: {error}"
                )),
                Some(503),
            );
        }
    }

    let mut pending = vec![resolved.resolved_path];
    let mut inspected = 0usize;
    while let Some(directory) = pending.pop() {
        let entries = match workspace_fs.read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) => {
                return decision_result(
                    Some(context),
                    "Delete",
                    "recursive_delete",
                    root_path,
                    "deny_inspection_failed",
                    false,
                    Some(&state),
                    None,
                    Some(format!(
                        "Recursive delete was not applied because protected descendants could not be inspected: {error}"
                    )),
                    Some(503),
                );
            }
        };

        for entry in entries {
            if entry.is_symlink {
                continue;
            }
            inspected += 1;
            if inspected > MAX_RECURSIVE_INSPECTION_ENTRIES {
                return decision_result(
                    Some(context),
                    "Delete",
                    "recursive_delete",
                    root_path,
                    "deny_inspection_limit",
                    false,
                    Some(&state),
                    None,
                    Some("Recursive delete was not applied because protected-path inspection exceeded its safety limit".to_string()),
                    Some(413),
                );
            }
            let entry_paths = vec![entry.path.clone()];
            if !can_mutate_agent_created_test_file(
                Some(&state),
                &entry_paths,
                "recursive_delete",
                false,
            ) {
                if let Some(violation) = find_violation_for_operation(
                    &state.constraints,
                    &entry.path,
                    "recursive_delete",
                ) {
                    return decision_result(
                        Some(context),
                        "Delete",
                        "recursive_delete",
                        &entry.path,
                        "deny",
                        false,
                        Some(&state),
                        Some(violation),
                        Some(violation_message(&entry.path, violation)),
                        Some(403),
                    );
                }
            }
            if entry.is_dir {
                pending.push(entry.path);
            }
        }
    }
    None
}

fn check_local_recursive_delete(
    context: &ToolUseContext,
    root_path: &str,
    resolved_root: &str,
    state: &EditConstraintState,
) -> Option<ValidationResult> {
    let root = Path::new(resolved_root);
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) => {
            return decision_result(
                Some(context),
                "Delete",
                "recursive_delete",
                root_path,
                "deny_inspection_failed",
                false,
                Some(state),
                None,
                Some(format!(
                    "Recursive delete was not applied because the target could not be inspected: {error}"
                )),
                Some(503),
            );
        }
    };
    if !metadata.is_dir() {
        return None;
    }

    let mut pending = vec![root.to_path_buf()];
    let mut inspected = 0usize;
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                return decision_result(
                    Some(context),
                    "Delete",
                    "recursive_delete",
                    root_path,
                    "deny_inspection_failed",
                    false,
                    Some(state),
                    None,
                    Some(format!(
                        "Recursive delete was not applied because protected descendants could not be inspected: {error}"
                    )),
                    Some(503),
                );
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    return decision_result(
                        Some(context),
                        "Delete",
                        "recursive_delete",
                        root_path,
                        "deny_inspection_failed",
                        false,
                        Some(state),
                        None,
                        Some(format!(
                            "Recursive delete was not applied because a descendant could not be inspected: {error}"
                        )),
                        Some(503),
                    );
                }
            };
            let path = entry.path();
            let entry_metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    return decision_result(
                        Some(context),
                        "Delete",
                        "recursive_delete",
                        root_path,
                        "deny_inspection_failed",
                        false,
                        Some(state),
                        None,
                        Some(format!(
                            "Recursive delete was not applied because a descendant type could not be inspected: {error}"
                        )),
                        Some(503),
                    );
                }
            };
            if entry_metadata.file_type().is_symlink() {
                continue;
            }
            inspected += 1;
            if inspected > MAX_RECURSIVE_INSPECTION_ENTRIES {
                return decision_result(
                    Some(context),
                    "Delete",
                    "recursive_delete",
                    root_path,
                    "deny_inspection_limit",
                    false,
                    Some(state),
                    None,
                    Some("Recursive delete was not applied because protected-path inspection exceeded its safety limit".to_string()),
                    Some(413),
                );
            }
            let path_string = path.to_string_lossy().to_string();
            let entry_paths = vec![path_string.clone()];
            if !can_mutate_agent_created_test_file(
                Some(state),
                &entry_paths,
                "recursive_delete",
                false,
            ) {
                if let Some(violation) = find_violation_for_operation(
                    &state.constraints,
                    &path_string,
                    "recursive_delete",
                ) {
                    return decision_result(
                        Some(context),
                        "Delete",
                        "recursive_delete",
                        &path_string,
                        "deny",
                        false,
                        Some(state),
                        Some(violation),
                        Some(violation_message(&path_string, violation)),
                        Some(403),
                    );
                }
            }
            if entry_metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    None
}

/// Records that a path was first created through a direct agent file tool.
/// This provenance is persisted with the session so later Write/Edit/Delete
/// calls can clean up the helper without being confused for repository tests.
pub async fn remember_agent_created_file(context: &ToolUseContext, file_path: &str) {
    if !is_enabled().await {
        return;
    }
    let Some(session_id) = context.session_id.as_deref() else {
        return;
    };
    let coordinator = get_global_coordinator();
    let should_track = coordinator.as_ref().is_some_and(|coordinator| {
        coordinator
            .get_session_manager()
            .edit_constraint_state(session_id)
            .is_some_and(|state| state.tracks_agent_created_test_paths())
    });
    let telemetry_enabled = edit_constraint_telemetry_enabled();
    if !should_track && !telemetry_enabled {
        return;
    }
    let paths = candidate_paths(Some(context), file_path);
    if should_track {
        let coordinator = coordinator.expect("coordinator checked above");
        coordinator
            .get_session_manager()
            .remember_edit_constraint_agent_created_paths(
                session_id,
                paths.clone(),
                context.dialog_turn_id.as_deref().unwrap_or_default(),
            )
            .await;
    }
    if telemetry_enabled {
        append_tool_telemetry(
            context,
            &json!({
            "event": "session_file_origin",
            "schema_version": EDIT_CONSTRAINT_SCHEMA_VERSION,
            "timestamp_ms": timestamp_ms(),
            "session_id": context.session_id,
            "dialog_turn_id": context.dialog_turn_id,
            "tool_call_id": context.tool_call_id,
            "requested_path": file_path,
            "resolved_path": resolved_path(context, file_path),
            "origin": "agent_created",
            }),
        );
    }
}

/// Clears agent-created provenance after a successful direct delete.
pub async fn forget_agent_created_file(context: &ToolUseContext, file_path: &str) {
    if !is_enabled().await {
        return;
    }
    let Some(session_id) = context.session_id.as_deref() else {
        return;
    };
    let coordinator = get_global_coordinator();
    let should_forget = coordinator.as_ref().is_some_and(|coordinator| {
        coordinator
            .get_session_manager()
            .edit_constraint_state(session_id)
            .is_some_and(|state| state.has_agent_created_paths())
    });
    let telemetry_enabled = edit_constraint_telemetry_enabled();
    if !should_forget && !telemetry_enabled {
        return;
    }
    let paths = candidate_paths(Some(context), file_path);
    if should_forget {
        let coordinator = coordinator.expect("coordinator checked above");
        coordinator
            .get_session_manager()
            .forget_edit_constraint_agent_created_paths_under(session_id, paths.clone())
            .await;
    }
    if telemetry_enabled {
        append_tool_telemetry(
            context,
            &json!({
            "event": "session_file_origin",
            "schema_version": EDIT_CONSTRAINT_SCHEMA_VERSION,
            "timestamp_ms": timestamp_ms(),
            "session_id": context.session_id,
            "dialog_turn_id": context.dialog_turn_id,
            "tool_call_id": context.tool_call_id,
            "requested_path": file_path,
            "resolved_path": resolved_path(context, file_path),
            "origin": "removed",
            }),
        );
    }
}

/// Records a successful direct mutation when product diagnostics are enabled.
pub async fn record_mutation_applied(
    context: &ToolUseContext,
    tool_name: &str,
    operation: &str,
    file_path: &str,
) {
    if !is_enabled().await {
        return;
    }
    if !edit_constraint_telemetry_enabled() {
        return;
    }
    append_tool_telemetry(
        context,
        &json!({
            "event": "mutation_applied",
            "schema_version": EDIT_CONSTRAINT_SCHEMA_VERSION,
            "mutation_id": Uuid::new_v4().to_string(),
            "timestamp_ms": timestamp_ms(),
            "session_id": context.session_id,
            "dialog_turn_id": context.dialog_turn_id,
            "tool_call_id": context.tool_call_id,
            "agent_type": context.agent_type,
            "tool_name": tool_name,
            "operation": operation,
            "requested_path": file_path,
            "resolved_path": resolved_path(context, file_path),
            "workspace_kind": if context.is_remote() { "remote" } else { "local" },
        }),
    );
}

#[cfg(test)]
mod tests;
