use super::*;
use serde_json::json;

fn entry(kind: &str, id: &str, parent: Option<&str>, content: Value) -> Value {
    json!({"type":kind,"uuid":id,"parentUuid":parent,"sessionId":"one","cwd":"/project",
        "timestamp":"2026-10-18T01:00:00Z","version":"2.1.302",
        "message":{"role":kind,"content":content,"model":"test-model","stop_reason":"end_turn"}})
}

fn write(root: &Path, id: &str, rows: &[Value]) -> PathBuf {
    let folder = root.join("projects/project");
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("{id}.jsonl"));
    let content = rows
        .iter()
        .map(|row| {
            let mut row = row.clone();
            row["sessionId"] = id.into();
            row.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&path, content).unwrap();
    path
}

#[test]
fn imports_ordered_messages_thinking_tools_errors_and_attachments_without_writes() {
    let root = tempfile::tempdir().unwrap();
    let rows = vec![
        entry("user", "u1", None, json!("Read the file")),
        entry(
            "assistant",
            "a1",
            Some("u1"),
            json!([
                {"type":"thinking","thinking":"Inspect first"},
                {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/project/missing"}}
            ]),
        ),
        entry(
            "user",
            "r1",
            Some("a1"),
            json!([{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"File not found"}]),
        ),
        entry(
            "assistant",
            "a2",
            Some("r1"),
            json!([{"type":"text","text":"Missing file"}]),
        ),
        entry(
            "user",
            "u2",
            Some("a2"),
            json!([{"type":"text","text":"Here is an image"},{"type":"image","source":{"type":"base64","data":"do-not-copy"}}]),
        ),
        entry(
            "assistant",
            "a3",
            Some("u2"),
            json!([{"type":"text","text":"Done"}]),
        ),
        json!({"type":"custom-title","customTitle":"Saved name"}),
    ];
    let path = write(root.path(), "one", &rows);
    let before = std::fs::read(&path).unwrap();
    let reader = ClaudeCodeSessionReader::new(root.path().into());
    let catalog = reader.discover_all().unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    assert_eq!(catalog.candidates[0].title.as_deref(), Some("Saved name"));
    let document = reader
        .read_candidate("claude-code:one", ExternalSessionImportMode::Full)
        .unwrap();
    assert_eq!(document.turns.len(), 2);
    assert_eq!(document.turns[0].user_text, "Read the file");
    assert_eq!(document.turns[0].items.len(), 3);
    assert!(
        matches!(&document.turns[0].items[0], ExternalSessionItem::Thinking { text } if text == "Inspect first")
    );
    assert!(
        matches!(&document.turns[0].items[1], ExternalSessionItem::Tool { id, result: Some(result), success: Some(false), .. } if id == "t1" && result == "File not found")
    );
    assert_eq!(document.turns[1].status, ExternalSessionStatus::Complete);
    assert!(!serde_json::to_string(&document.turns)
        .unwrap()
        .contains("do-not-copy"));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn omits_claude_local_command_records_from_title_and_history() {
    let root = tempfile::tempdir().unwrap();
    let mut caveat = entry(
        "user",
        "caveat",
        None,
        json!("<local-command-caveat>Caveat: local command output follows</local-command-caveat>"),
    );
    caveat["isMeta"] = true.into();
    let rows = vec![
        caveat,
        entry(
            "user",
            "command",
            Some("caveat"),
            json!("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"),
        ),
        entry(
            "user",
            "stdout",
            Some("command"),
            json!("<local-command-stdout>Set model to Opus</local-command-stdout>"),
        ),
        entry(
            "user",
            "prompt",
            Some("stdout"),
            json!("Please inspect the imported Claude session."),
        ),
        entry(
            "assistant",
            "answer",
            Some("prompt"),
            json!([{"type":"text","text":"I inspected the session."}]),
        ),
        entry(
            "user",
            "task-notification",
            Some("answer"),
            json!("<task-notification>\n<task-id>task123</task-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>"),
        ),
        entry(
            "user",
            "interrupted",
            Some("task-notification"),
            json!("[Request interrupted by user for tool use]"),
        ),
    ];
    let path = write(root.path(), "one", &rows);
    let before = std::fs::read(&path).unwrap();
    let reader = ClaudeCodeSessionReader::new(root.path().into());

    let catalog = reader.discover_all().unwrap();
    assert_eq!(
        catalog.candidates[0].title.as_deref(),
        Some("Please inspect the imported Claude session.")
    );

    let document = reader
        .read_candidate("claude-code:one", ExternalSessionImportMode::Full)
        .unwrap();
    assert_eq!(document.turns.len(), 1);
    assert_eq!(
        document.turns[0].user_text,
        "Please inspect the imported Claude session."
    );
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Interrupted);
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "internal_commands_omitted"));
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "source_turn_interrupted"));
    let serialized = serde_json::to_string(&document.turns).unwrap();
    assert!(!serialized.contains("command-name"));
    assert!(!serialized.contains("local-command-stdout"));
    assert!(!serialized.contains("task-notification"));
    assert!(!serialized.contains("Request interrupted"));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn omits_tool_attachment_payloads_and_rejects_missing_message_ids() {
    let rows = [
        entry("user", "u", None, json!("Read image")),
        entry(
            "assistant",
            "a",
            Some("u"),
            json!([{"type":"tool_use","id":"t","name":"Read","input":{}}]),
        ),
        entry(
            "user",
            "r",
            Some("a"),
            json!([{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"data":"do-not-copy"}},{"type":"text","text":"Readable result"}]}]),
        ),
    ];
    let content = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let (turns, warnings) = translate(&content, "one", ExternalSessionImportMode::Full).unwrap();
    let serialized = serde_json::to_string(&turns).unwrap();
    assert!(!serialized.contains("do-not-copy"));
    assert!(serialized.contains("Readable result"));
    assert!(warnings
        .iter()
        .any(|warning| warning.code == "attachments_not_imported"));
    assert!(translate(
        r#"{"type":"user","message":{"content":"lost"}}"#,
        "one",
        ExternalSessionImportMode::Full
    )
    .is_err());
}

#[test]
fn follows_latest_branch_and_retains_pre_compaction_history_without_summary_turns() {
    let mut rows = vec![
        entry("user", "u1", None, json!("Original prompt")),
        entry(
            "assistant",
            "a1",
            Some("u1"),
            json!([{"type":"text","text":"Original answer"}]),
        ),
        entry("user", "obsolete", Some("a1"), json!("Discarded branch")),
        entry(
            "assistant",
            "obsolete-answer",
            Some("obsolete"),
            json!([{"type":"text","text":"Discarded answer"}]),
        ),
        json!({"type":"system","subtype":"compact_boundary","uuid":"compact","parentUuid":null,"logicalParentUuid":"not-persisted","compactMetadata":{"preservedSegment":{"tailUuid":"a1"}},"sessionId":"one"}),
        entry(
            "user",
            "summary",
            Some("compact"),
            json!("Compacted context"),
        ),
        entry("user", "u2", Some("summary"), json!("Follow-up")),
        entry(
            "assistant",
            "a2",
            Some("u2"),
            json!([{"type":"text","text":"Current answer"}]),
        ),
    ];
    rows[5]["isCompactSummary"] = true.into();
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "one", &rows);
    let reader = ClaudeCodeSessionReader::new(root.path().into());
    let document = reader
        .read_candidate("claude-code:one", ExternalSessionImportMode::Full)
        .unwrap();
    assert_eq!(
        document
            .turns
            .iter()
            .map(|turn| turn.user_text.as_str())
            .collect::<Vec<_>>(),
        ["Original prompt", "Follow-up"]
    );
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "compaction_present"));
    let compact = reader
        .read_candidate(
            "claude-code:one",
            ExternalSessionImportMode::LatestCompacted,
        )
        .unwrap();
    assert_eq!(compact.turns[0].user_text, "Compacted context");
}

#[test]
fn discovers_all_pages_but_excludes_subagents_and_metadata_only_files() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..53 {
        write(
            root.path(),
            &index.to_string(),
            &[entry("user", "u", None, json!("Prompt"))],
        );
    }
    let mut side = entry("user", "u", None, json!("Subagent prompt"));
    side["isSidechain"] = true.into();
    write(root.path(), "sidechain", &[side]);
    write(
        root.path(),
        "metadata",
        &[json!({"type":"queue-operation","operation":"enqueue"})],
    );
    let nested = root.path().join("projects/project/one/subagents");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("agent-child.jsonl"), "not a main transcript").unwrap();
    let reader = ClaudeCodeSessionReader::new(root.path().into());
    let all = reader.discover_all().unwrap();
    assert_eq!(all.candidates.len(), 53);
    assert!(all.diagnostics.is_empty());
    let first = reader.discover(0, 50, "").unwrap();
    let second = reader.discover(first.next_cursor.unwrap(), 50, "").unwrap();
    assert_eq!(second.candidates.len(), 3);
    assert!(second.next_cursor.is_none());
    let ids = first
        .candidates
        .iter()
        .chain(&second.candidates)
        .map(|candidate| &candidate.candidate_id)
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 53);
}

#[test]
fn rejects_corrupt_unknown_or_incomplete_history_and_relative_homes() {
    let bad = [
        vec![entry("user", "u", Some("missing"), json!("Prompt"))],
        vec![entry("user", "u", Some("u"), json!("Prompt"))],
        vec![
            entry("user", "u", None, json!("Prompt")),
            entry(
                "assistant",
                "a",
                Some("u"),
                json!([{"type":"future-content"}]),
            ),
        ],
        vec![
            entry("user", "u", None, json!("Prompt")),
            entry(
                "user",
                "r",
                Some("u"),
                json!([{"type":"tool_result","tool_use_id":"missing","content":"Result"}]),
            ),
        ],
    ];
    for rows in bad {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "one", &rows);
        let reader = ClaudeCodeSessionReader::new(root.path().into());
        assert!(reader
            .read_candidate("claude-code:one", ExternalSessionImportMode::Full)
            .is_err());
        assert!(reader
            .read_candidate("claude-code:../one", ExternalSessionImportMode::Full)
            .is_err());
    }
    assert!(ClaudeCodeSessionReader::new("relative".into())
        .discover_all()
        .is_err());
    let root = tempfile::tempdir().unwrap();
    assert!(ClaudeCodeSessionReader::new(root.path().into())
        .discover_all()
        .unwrap()
        .candidates
        .is_empty());
}

#[test]
fn unfinished_tool_and_api_error_are_not_successful_turns() {
    let mut error = entry(
        "assistant",
        "e",
        Some("a"),
        json!([{"type":"text","text":"Source API error"}]),
    );
    error["isApiErrorMessage"] = true.into();
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "one",
        &[
            entry("user", "u", None, json!("Prompt")),
            entry(
                "assistant",
                "a",
                Some("u"),
                json!([{"type":"tool_use","id":"t","name":"Read","input":{}}]),
            ),
            error,
        ],
    );
    let document = ClaudeCodeSessionReader::new(root.path().into())
        .read_candidate("claude-code:one", ExternalSessionImportMode::Full)
        .unwrap();
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Interrupted);
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "source_turn_error"));
}

#[test]
#[ignore = "reads the installed Claude Code source; prints counts only"]
fn inspect_installed_claude_code() {
    let reader = std::env::var_os("OPENBITFUN_TEST_CLAUDE_HOME")
        .map(PathBuf::from)
        .map(ClaudeCodeSessionReader::new)
        .unwrap_or_default();
    let catalog = reader.discover_all().unwrap();
    assert!(
        catalog.diagnostics.is_empty(),
        "Source discovery has diagnostics"
    );
    assert!(
        !catalog.candidates.is_empty(),
        "No installed Claude Code sessions"
    );
    let mut turns = 0;
    let mut tools = 0;
    let mut errors = 0;
    let mut failures = Vec::new();
    let mut ids = HashSet::new();
    for candidate in &catalog.candidates {
        assert!(ids.insert(candidate.source_session_id.clone()));
        match reader.read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full) {
            Ok(document) => {
                turns += document.turns.len();
                for item in document.turns.iter().flat_map(|turn| &turn.items) {
                    if let ExternalSessionItem::Tool { success, .. } = item {
                        tools += 1;
                        errors += usize::from(*success == Some(false));
                    }
                }
                if std::env::var("OPENBITFUN_TEST_CLAUDE_SESSION")
                    .ok()
                    .as_deref()
                    == Some(candidate.source_session_id.as_str())
                {
                    assert_eq!(document.turns.len(), 2);
                    assert_eq!(
                        document
                            .turns
                            .iter()
                            .flat_map(|turn| &turn.items)
                            .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
                            .count(),
                        4
                    );
                    assert!(document.turns.iter().flat_map(|turn| &turn.items).any(|item| matches!(item, ExternalSessionItem::Text { text } if text.contains("CLAUDE_RESUME_OK"))));
                    assert!(document.turns.iter().flat_map(|turn| &turn.items).any(
                        |item| matches!(
                            item,
                            ExternalSessionItem::Tool {
                                success: Some(false),
                                ..
                            }
                        )
                    ));
                }
            }
            Err(error) => failures.push(format!("{}: {error}", candidate.source_session_id)),
        }
    }
    let mut paged = HashSet::new();
    let mut cursor = 0;
    loop {
        let page = reader.discover(cursor, 3, "").unwrap();
        for candidate in page.candidates {
            assert!(paged.insert(candidate.source_session_id));
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
    }
    assert_eq!(ids, paged);
    println!(
        "{}",
        json!({"candidates":ids.len(),"turns":turns,"tools":tools,"source_tool_errors":errors,"failures":failures})
    );
    assert!(failures.is_empty());
}
