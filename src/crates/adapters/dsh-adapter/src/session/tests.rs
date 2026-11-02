use super::*;

fn header() -> Value {
    json!({"type":"session","version":0,"id":"one","createdAt":1000,"cwd":"/project","delegationDepth":0})
}

fn conversation() -> Vec<Value> {
    vec![
        header(),
        json!({"type":"turn/start","data":{"turn":1}}),
        json!({"type":"user/message","surfaceOp":"append","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Read file"}]}}),
        json!({"type":"user/message","surfaceOp":"append","data":{"source":{"kind":"plugin"},"content":[{"type":"text","text":"Internal context"}]}}),
        json!({"type":"assistant/message","surfaceOp":"append","data":{"message":{"content":[
            {"type":"reasoning","text":"Check path"},
            {"type":"tool-call","id":"call","name":"read","arguments":"{\"file_path\":\"/project/missing\"}"}
        ]}}}),
        json!({"type":"tool/call","data":{"callId":"call","name":"read","arguments":"{\"file_path\":\"/project/missing\"}"}}),
        json!({"type":"tool/result","surfaceOp":"append","data":{"message":{"content":[{"type":"tool-result","toolCallId":"call","isError":true,"content":[{"type":"text","text":"Not found"},{"type":"image","attachment":{"data":"do-not-copy"}}]}]}}}),
        json!({"type":"assistant/message","surfaceOp":"append","data":{"message":{"content":[{"type":"text","text":"Done"}]}}}),
        json!({"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}),
    ]
}

fn transcript(rows: &[Value]) -> String {
    rows.iter()
        .enumerate()
        .map(|(i, row)| {
            let mut row = row.clone();
            if i > 0 {
                row["seq"] = json!(i - 1);
                row["time"] = json!(1000 + i);
            }
            row.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

#[test]
fn imports_assembled_messages_once_with_tool_failures_and_thinking() {
    let (turns, warnings) = translate(&transcript(&conversation()), "one").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].user_text, "Read file");
    assert_eq!(turns[0].items.len(), 3);
    assert!(
        matches!(&turns[0].items[0], ExternalSessionItem::Thinking { text } if text == "Check path")
    );
    assert!(
        matches!(&turns[0].items[1], ExternalSessionItem::Tool { input, result: Some(result), success: Some(false), .. }
        if input["file_path"] == "/project/missing" && result[0]["text"] == "Not found")
    );
    assert!(!serde_json::to_string(&turns)
        .unwrap()
        .contains("do-not-copy"));
    assert_eq!(warnings.len(), 2);
    assert_eq!(turns[0].status, ExternalSessionStatus::Complete);
}

#[test]
fn model_surface_replacements_do_not_erase_or_duplicate_human_transcript() {
    let mut rows = conversation();
    rows.push(json!({"type":"user/message","surfaceOp":{"op":"replace","start":1,"end":6},"data":{"source":{"kind":"plugin"},"content":[{"type":"text","text":"Summary duplicate"}]}}));
    let (turns, warnings) = translate(&transcript(&rows), "one").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].items.len(), 3);
    assert!(warnings
        .iter()
        .any(|item| item.code == "compaction_retained"));
    assert!(!serde_json::to_string(&turns)
        .unwrap()
        .contains("Summary duplicate"));
}

#[test]
fn packed_stream_chunks_advance_sequence_without_duplicate_messages() {
    let rows: Vec<Value> = transcript(&conversation())
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut packed = rows[..7].to_vec();
    packed.push(json!({"type":"text-chunks","seq0":6,"time0":1007,"data":{"turn":1,"step":1,"index":0,"texts":["D","o","ne"],"dt":[1,1]}}));
    for mut row in rows.into_iter().skip(7) {
        row["seq"] = json!(row["seq"].as_u64().unwrap() + 3);
        packed.push(row);
    }
    let text = packed
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(translate(&text, "one").unwrap().0[0].items.len(), 3);
    assert!(translate(&text.replace("\"seq0\":6", "\"seq0\":5"), "one").is_err());
    assert!(translate(&text.replace("\"dt\":[1,1]", "\"dt\":[]"), "one").is_err());
}

#[test]
fn unsupported_versions_fail_loudly_but_unknown_events_are_omitted() {
    let mut rows = conversation();
    rows[0]["version"] = 1.into();
    assert!(translate(&transcript(&rows), "one")
        .err()
        .unwrap()
        .contains("version"));
    rows[0] = header();
    rows.push(json!({"type":"future/state","data":{}}));
    let (_, warnings) = translate(&transcript(&rows), "one").unwrap();
    assert!(warnings
        .iter()
        .any(|item| item.code == "unknown_events_omitted"));
    rows.truncate(6);
    assert_eq!(
        translate(&transcript(&rows), "one").unwrap().0[0].status,
        ExternalSessionStatus::Interrupted
    );
}

#[test]
fn empty_seed_session_returns_empty_history() {
    let text = transcript(&[
        header(),
        json!({"type":"permission/preset","data":{}}),
        json!({"type":"sandbox/mode","data":{}}),
        json!({"type":"approval/policy","data":{}}),
        json!({"type":"session/end-seed","data":{}}),
    ]);
    let (turns, warnings) = translate(&text, "one").unwrap();
    assert!(turns.is_empty());
    assert!(warnings.is_empty());
}

#[test]
fn unsupported_source_version_is_classified_separately() {
    let mut rows = conversation();
    rows[0]["version"] = 1.into();
    let error = super::header(&transcript(&rows)).unwrap_err();
    assert!(is_unsupported_error(&error));
}

fn write_session(root: &Path, text: &str, compressed: bool) -> PathBuf {
    let dir = root.join("sessions/project/one");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(if compressed {
        "session.jsonl.zstd"
    } else {
        "session.jsonl"
    });
    let bytes = if compressed {
        let (head, rest) = text.split_once('\n').unwrap();
        let mut bytes = zstd::encode_all(format!("{head}\n").as_bytes(), 1).unwrap();
        bytes.extend(zstd::encode_all(rest.as_bytes(), 1).unwrap());
        bytes
    } else {
        text.as_bytes().to_vec()
    };
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn raw_and_concatenated_zstd_frames_have_identical_read_only_imports() {
    let raw = tempfile::tempdir().unwrap();
    let compressed = tempfile::tempdir().unwrap();
    let text = transcript(&conversation());
    let raw_path = write_session(raw.path(), &text, false);
    let compressed_path = write_session(compressed.path(), &text, true);
    let bytes = std::fs::read(&compressed_path).unwrap();
    let read = |path: &Path| {
        DshSessionReader::new(path.into())
            .read_candidate("deepseek-harness:one", ExternalSessionImportMode::Full)
            .unwrap()
    };
    assert_eq!(
        serde_json::to_value(read(raw.path()).turns).unwrap(),
        serde_json::to_value(read(compressed.path()).turns).unwrap()
    );
    assert_eq!(std::fs::read(&compressed_path).unwrap(), bytes);
    assert_eq!(std::fs::read_to_string(raw_path).unwrap(), text);
    assert!(DshSessionReader::new(raw.path().into())
        .read_candidate(
            "deepseek-harness:../../one",
            ExternalSessionImportMode::Full
        )
        .is_err());
    std::fs::write(&compressed_path, &bytes[..bytes.len() - 2]).unwrap();
    assert!(read_text(&compressed_path, MAX_BYTES).is_err());
}

#[test]
fn discovery_pages_beyond_fifty_and_excludes_subagents() {
    let root = tempfile::tempdir().unwrap();
    for i in 0..56 {
        let mut rows = conversation();
        rows[0]["id"] = format!("id-{i}").into();
        if i == 55 {
            rows[0]["origin"] = "subagent".into();
            rows[0]["delegationDepth"] = 1.into();
        }
        let path = root.path().join(format!("sessions/project/id-{i}"));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("session.jsonl"), transcript(&rows)).unwrap();
    }
    let reader = DshSessionReader::new(root.path().into());
    let first = reader.discover(0, 50, "").unwrap();
    assert_eq!(first.candidates.len(), 50);
    assert_eq!(
        reader
            .discover(first.next_cursor.unwrap(), 50, "")
            .unwrap()
            .candidates
            .len(),
        5
    );
    assert_eq!(reader.discover_all().unwrap().candidates.len(), 55);
}

#[test]
#[ignore = "Reads installed DeepSeek Harness history without modifying it"]
fn inspect_installed_dsh_session_read_only() {
    let reader = DshSessionReader::default();
    let id = std::env::var("OPENBITFUN_TEST_DSH_SESSION").expect("Select a real DSH session");
    let catalog = reader.discover_all().unwrap();
    let candidate = catalog
        .candidates
        .iter()
        .find(|candidate| candidate.source_session_id == id)
        .expect("Installed session must be discovered");
    let path = PathBuf::from(candidate.source_location.as_ref().unwrap());
    let before = std::fs::read(&path).unwrap();
    let doc = reader
        .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
        .unwrap();
    assert_eq!(doc.turns.len(), 2);
    let tools: Vec<_> = doc
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
        .collect();
    assert_eq!(tools.len(), 4);
    assert_eq!(
        tools
            .iter()
            .filter(|item| matches!(
                item,
                ExternalSessionItem::Tool {
                    success: Some(false),
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(doc.turns[1].items.iter().any(
        |item| matches!(item, ExternalSessionItem::Text { text } if text.contains("DSH_RESUME_OK"))
    ));
    assert_eq!(std::fs::read(path).unwrap(), before);
    eprintln!(
        "Installed DeepSeek Harness: {} turns, {} tools, source unchanged",
        doc.turns.len(),
        tools.len()
    );
}

#[test]
#[ignore = "Reads every installed DeepSeek Harness history without modifying it"]
fn inspect_all_installed_dsh_sessions_read_only() {
    let reader = DshSessionReader::default();
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.candidates.len() >= 5);
    for candidate in catalog.candidates {
        let path = PathBuf::from(candidate.source_location.as_ref().unwrap());
        let before = std::fs::read(&path).unwrap();
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        eprintln!(
            "Installed DeepSeek Harness {}: {} turns, {} warnings, source unchanged",
            candidate.source_session_id,
            document.turns.len(),
            document.warnings.len()
        );
    }
}
