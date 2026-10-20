use super::*;

fn header(version: u64) -> Value {
    json!({"type":"session","version":version,"id":"one","cwd":"/project","timestamp":"2026-10-18T01:00:00Z"})
}

fn message(id: &str, parent: Option<&str>, role: &str, content: Value) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-18T01:00:00Z",
        "message":{"role":role,"content":content,"timestamp":1000,"stopReason":"stop","provider":"fixture","model":"fixture-model"}})
}

fn transcript(rows: &[Value]) -> String {
    rows.iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn conversation() -> Vec<Value> {
    vec![
        header(3),
        message(
            "u",
            None,
            "user",
            json!([{"type":"text","text":"Read file"}]),
        ),
        message(
            "a",
            Some("u"),
            "assistant",
            json!([
                {"type":"thinking","thinking":"Check the path"},
                {"type":"toolCall","id":"call","name":"read","arguments":{"path":"/project/missing"}}
            ]),
        ),
        {
            let mut result = message(
                "r",
                Some("a"),
                "toolResult",
                json!([
                    {"type":"text","text":"File not found"}, {"type":"image","data":"do-not-copy"}
                ]),
            );
            result["message"]["toolCallId"] = "call".into();
            result["message"]["isError"] = true.into();
            result
        },
        message(
            "done",
            Some("r"),
            "assistant",
            json!([{"type":"text","text":"Done"}]),
        ),
    ]
}

#[test]
fn actual_message_shapes_preserve_tools_thinking_errors_and_omit_image_payloads() {
    let rows = conversation();
    let (turns, warnings) = translate(&transcript(&rows), "one").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].user_text, "Read file");
    assert_eq!(turns[0].items.len(), 3);
    assert!(
        matches!(&turns[0].items[0], ExternalSessionItem::Thinking { text } if text == "Check the path")
    );
    assert!(
        matches!(&turns[0].items[1], ExternalSessionItem::Tool { input, result:Some(result), success:Some(false), .. }
        if input["path"] == "/project/missing" && result[0]["text"] == "File not found")
    );
    assert!(!serde_json::to_string(&turns)
        .unwrap()
        .contains("do-not-copy"));
    assert!(warnings
        .iter()
        .any(|warning| warning.code == "attachments_not_imported"));
    assert_eq!(turns[0].status, ExternalSessionStatus::Complete);
}

#[test]
fn active_tree_branch_and_compaction_do_not_invent_duplicate_user_turns() {
    let mut rows = conversation();
    rows.push(message(
        "old-u",
        Some("done"),
        "user",
        json!("Abandoned branch"),
    ));
    rows.push(message(
        "old-a",
        Some("old-u"),
        "assistant",
        json!([{"type":"text","text":"Abandoned answer"}]),
    ));
    rows.push(json!({"type":"compaction","id":"compact","parentId":"done","summary":"Retained summary","firstKeptEntryId":"done"}));
    rows.push(message(
        "new-u",
        Some("compact"),
        "user",
        json!("Active branch"),
    ));
    rows.push(message(
        "new-a",
        Some("new-u"),
        "assistant",
        json!([{"type":"text","text":"Active answer"}]),
    ));
    let (turns, warnings) = translate(&transcript(&rows), "one").unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1].user_text, "Active branch");
    assert!(!serde_json::to_string(&turns).unwrap().contains("Abandoned"));
    assert!(warnings
        .iter()
        .any(|warning| warning.code == "compaction_retained"));
}

#[test]
fn legacy_v1_and_v2_messages_are_read_without_rewriting_the_source() {
    for version in [1, 2] {
        let mut rows = vec![
            header(version),
            message("u", None, "user", json!("Legacy prompt")),
            message(
                "a",
                Some("u"),
                "assistant",
                json!([{"type":"text","text":"Legacy answer"}]),
            ),
        ];
        if version == 1 {
            rows[0].as_object_mut().unwrap().remove("version");
            for row in rows.iter_mut().skip(1) {
                row.as_object_mut().unwrap().remove("id");
                row.as_object_mut().unwrap().remove("parentId");
            }
        }
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("sessions/project");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("date_one.jsonl");
        let original = transcript(&rows);
        std::fs::write(&path, &original).unwrap();
        let reader = PiSessionReader::new(root.path().into());
        let catalog = reader.discover_all().unwrap();
        assert_eq!(catalog.candidates[0].source_session_id, "one");
        let document = reader
            .read_candidate("pi:one", ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.turns[0].user_text, "Legacy prompt");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert_eq!(document.candidate.format_version, Some(version.to_string()));
    }
}

#[test]
fn context_edits_apply_only_on_the_active_branch_and_extension_notes_are_not_human_turns() {
    let mut rows = vec![
        header(3),
        message("u", None, "user", json!("Original private text")),
        message(
            "a",
            Some("u"),
            "assistant",
            json!([{"type":"text","text":"Original answer"}]),
        ),
    ];
    rows.push(json!({"type":"context_edit","id":"edit","parentId":"a","targetId":"u","replacement":{"content":"Edited prompt"}}));
    rows.push(json!({"type":"custom_message","id":"custom","parentId":"edit","display":true,"content":"Extension note"}));
    rows.push(json!({"type":"custom_message","id":"hidden","parentId":"custom","display":false,"content":"Hidden data"}));
    let (turns, warnings) = translate(&transcript(&rows), "one").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].user_text, "Edited prompt");
    let text = serde_json::to_string(&turns).unwrap();
    assert!(text.contains("Extension note"));
    assert!(!text.contains("Original private text"));
    assert!(!text.contains("Hidden data"));
    assert!(warnings
        .iter()
        .any(|warning| warning.code == "context_edits_applied"));
    rows[3]["targetId"] = "missing".into();
    assert!(translate(&transcript(&rows), "one").is_err());
}

#[test]
fn interrupted_or_malformed_history_does_not_report_success() {
    let mut rows = conversation();
    rows.truncate(3);
    let (turns, _) = translate(&transcript(&rows), "one").unwrap();
    assert_eq!(turns[0].status, ExternalSessionStatus::Interrupted);
    rows[2]["parentId"] = "missing".into();
    assert!(translate(&transcript(&rows), "one")
        .err()
        .unwrap()
        .contains("parent"));
    rows[2]["parentId"] = "a".into();
    assert!(translate(&transcript(&rows), "one")
        .err()
        .unwrap()
        .contains("cycle"));
    rows[0]["version"] = 99.into();
    assert!(translate(&transcript(&rows), "one")
        .err()
        .unwrap()
        .contains("version"));
    rows[0]["version"] = "invalid".into();
    assert!(translate(&transcript(&rows), "one")
        .err()
        .unwrap()
        .contains("version"));
    assert!(translate("{", "one").is_err());
}

#[test]
fn discovery_reads_all_pages_and_explicit_session_directory_without_duplicates() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("sessions/project");
    std::fs::create_dir_all(&folder).unwrap();
    for index in 0..55 {
        let mut rows = conversation();
        rows[0]["id"] = format!("session-{index}").into();
        rows.push(json!({"type":"session_info","id":"name","parentId":"done","name":format!("Named {index}")}));
        std::fs::write(folder.join(format!("{index}.jsonl")), transcript(&rows)).unwrap();
    }
    std::fs::write(
        root.path().join("settings.json"),
        json!({"sessionDir":folder}).to_string(),
    )
    .unwrap();
    let reader = PiSessionReader::new(root.path().into());
    assert_eq!(reader.discover_all().unwrap().candidates.len(), 55);
    let page = reader.discover(0, 50, "").unwrap();
    assert_eq!(page.candidates.len(), 50);
    assert_eq!(
        reader
            .discover(page.next_cursor.unwrap(), 50, "")
            .unwrap()
            .candidates
            .len(),
        5
    );
    assert_eq!(
        reader.discover(0, 50, "Named 54").unwrap().candidates.len(),
        1
    );
}

#[test]
#[ignore = "Reads real Pi sessions without writes; prints counts only"]
fn inspect_installed_pi() {
    let reader = PiSessionReader::default();
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.diagnostics.is_empty(), "{:?}", catalog.diagnostics);
    let expected = std::env::var("OPENBITFUN_TEST_PI_SESSION").ok();
    let mut counts = (0, 0, 0);
    for candidate in catalog.candidates.iter().filter(|candidate| {
        expected
            .as_ref()
            .is_none_or(|id| id == &candidate.source_session_id)
    }) {
        let path = PathBuf::from(candidate.source_location.as_ref().unwrap());
        let before = std::fs::read(&path).unwrap();
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        counts.0 += 1;
        counts.1 += document.turns.len();
        counts.2 += document
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
            .count();
        if expected.is_some() {
            assert_eq!(document.turns.len(), 2);
            assert!(document.turns[1].items.iter().any(|item| matches!(item, ExternalSessionItem::Text { text } if text.contains("PI_RESUME_OK"))));
            assert!(document
                .turns
                .iter()
                .flat_map(|turn| &turn.items)
                .any(|item| matches!(
                    item,
                    ExternalSessionItem::Tool {
                        success: Some(false),
                        ..
                    }
                )));
        }
    }
    assert!(counts.0 > 0);
    println!(
        "Pi: {} sessions, {} turns, {} tools",
        counts.0, counts.1, counts.2
    );
}
