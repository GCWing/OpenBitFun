use super::*;
use rusqlite::{params, Connection};

struct Fixture {
    dir: tempfile::TempDir,
    state: Connection,
    history: Connection,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Connection::open(dir.path().join("state_5.sqlite")).unwrap();
        state
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
                created_at INTEGER, updated_at INTEGER, rollout_path TEXT,
                history_mode TEXT, source TEXT, archived INTEGER, first_user_message TEXT,
                model_provider TEXT, model TEXT, cli_version TEXT);",
            )
            .unwrap();
        let history = Connection::open(dir.path().join("thread_history_1.sqlite")).unwrap();
        history
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
                status TEXT, started_at INTEGER, error_json TEXT,
                PRIMARY KEY(thread_id, turn_id));
            CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
                rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT,
                PRIMARY KEY(thread_id, turn_id, item_id));",
            )
            .unwrap();
        Self {
            dir,
            state,
            history,
        }
    }

    fn reader(&self) -> CodexSessionReader {
        CodexSessionReader::new(self.dir.path().into())
    }

    fn thread(&self, id: &str, source: &str, archived: bool) {
        self.state
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, NULL, '/project',
            1700000000, 1700000001, ?3, 'paginated', ?4, ?5, 'Original request',
            'openai', 'test-model', 'test-version')",
                params![
                    id,
                    format!("Saved {id}"),
                    self.dir
                        .path()
                        .join("sessions")
                        .join(format!("rollout-{id}.jsonl"))
                        .to_string_lossy(),
                    source,
                    archived
                ],
            )
            .unwrap();
    }

    fn turn(&self, thread: &str, id: &str, ordinal: i64, status: &str) {
        self.history
            .execute(
                "INSERT INTO thread_turns VALUES (?1, ?2, ?3, ?4, 1700000000, NULL)",
                params![thread, id, ordinal, status],
            )
            .unwrap();
    }

    fn item(&self, thread: &str, turn: &str, ordinal: i64, item: Value) {
        self.history
            .execute(
                "INSERT INTO thread_items VALUES (?1, ?2, ?3, ?4, 1700000000123, ?5)",
                params![
                    thread,
                    turn,
                    item["id"].as_str().unwrap(),
                    ordinal,
                    item.to_string()
                ],
            )
            .unwrap();
    }

    fn conversation(&self, id: &str) {
        self.thread(id, "vscode", false);
        self.turn(id, "turn-1", 0, "completed");
        self.item(
            id,
            "turn-1",
            1,
            json!({"type":"userMessage", "id":"user-1",
            "content":[{"type":"text","text":"Original request","text_elements":[]}]}),
        );
        self.item(
            id,
            "turn-1",
            2,
            json!({"type":"agentMessage", "id":"answer-1", "text":"Saved answer"}),
        );
    }

    fn read(&self, reader: &CodexSessionReader, id: &str) -> CodexSessionDocument {
        let catalog = reader.discover_all().unwrap();
        let candidate = catalog
            .candidates
            .iter()
            .find(|candidate| candidate.source_session_id == id)
            .expect("The SQLite-only thread must be discoverable");
        reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap()
    }
}

#[test]
fn sqlite_only_threads_are_discovered_across_pages_without_reading_bodies() {
    let fixture = Fixture::new();
    for index in 0..63 {
        fixture.thread(&format!("thread-{index:03}"), "vscode", index == 0);
    }
    fixture.thread(
        "child",
        r#"{"subagent":{"thread_spawn":{"parent_thread_id":"thread-000"}}}"#,
        false,
    );
    // Discovery must not need a history table, including while a source is offline.
    fixture
        .history
        .execute_batch("DROP TABLE thread_items; DROP TABLE thread_turns;")
        .unwrap();
    let reader = fixture.reader();
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.diagnostics.is_empty());
    assert_eq!(catalog.candidates.len(), 63);
    assert_eq!(reader.discover(0, 50, "").unwrap().next_cursor, Some(50));
    assert_eq!(reader.discover(50, 50, "").unwrap().candidates.len(), 13);
    let candidate = &reader
        .discover(0, 50, "Saved thread-000")
        .unwrap()
        .candidates[0];
    assert_eq!(candidate.title.as_deref(), Some("Saved thread-000"));
    assert!(candidate.title_is_source_name);
    assert_eq!(candidate.cwd.as_deref(), Some("/project"));
    assert_eq!(candidate.created_at, Some(1700000000000));
    assert_eq!(candidate.updated_at, Some(1700000001000));
    assert_eq!(
        reader
            .header_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[test]
fn sqlite_history_reads_committed_wal_and_keeps_explicit_turn_status() {
    let fixture = Fixture::new();
    fixture.conversation("one");
    fixture
        .history
        .execute("UPDATE thread_turns SET status = 'interrupted'", [])
        .unwrap();
    let reader = fixture.reader();
    let document = fixture.read(&reader, "one");
    assert_eq!(document.turns.len(), 1);
    assert_eq!(document.turns[0].user_text, "Original request");
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Interrupted);
    assert!(
        matches!(&document.turns[0].items[0], ExternalSessionItem::Text { text } if text == "Saved answer")
    );
    assert_eq!(document.candidate.model_name.as_deref(), Some("test-model"));
    assert_eq!(document.candidate.title.as_deref(), Some("Saved one"));
    let original = document.candidate.fingerprint;
    fixture
        .history
        .execute_batch("BEGIN IMMEDIATE; UPDATE thread_turns SET status = 'completed';")
        .unwrap();
    assert_eq!(fixture.read(&reader, "one").candidate.fingerprint, original);
    fixture.history.execute_batch("COMMIT;").unwrap();
    let updated = fixture.read(&reader, "one");
    assert_eq!(updated.turns[0].status, ExternalSessionStatus::Complete);
    assert_ne!(updated.candidate.fingerprint, original);
    assert_eq!(
        fixture.read(&reader, "one").candidate.fingerprint,
        updated.candidate.fingerprint
    );
}

#[test]
fn paginated_threads_replace_stale_rollouts_and_keep_deleted_file_locators_usable() {
    let fixture = Fixture::new();
    fixture.conversation("one");
    let directory = fixture.dir.path().join("sessions");
    fs::create_dir(&directory).unwrap();
    let rollout = directory.join("rollout-one.jsonl");
    fs::write(&rollout, format!("{}\n{}\n", json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":"Stale prompt"}}))).unwrap();
    let legacy_id = candidate_id(&rollout);
    for present in [true, false] {
        if !present {
            fs::remove_file(&rollout).unwrap();
        }
        let reader = fixture.reader();
        let catalog = reader.discover_all().unwrap();
        assert_eq!(catalog.candidates.len(), 1);
        let document = reader
            .read_candidate(&legacy_id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(
            document.candidate.candidate_id,
            catalog.candidates[0].candidate_id
        );
        assert_eq!(document.turns[0].user_text, "Original request");
        assert_eq!(document.turns[0].items.len(), 1);
    }
}

#[test]
fn state_wal_refreshes_pagination_metadata_without_changing_source_files() {
    let fixture = Fixture::new();
    fixture.conversation("one");
    let reader = fixture.reader();
    let original = reader.discover_all().unwrap();
    let metadata_reads = reader.titles.lock().unwrap().reads;
    fixture
        .state
        .execute(
            "UPDATE threads SET name = 'Renamed thread in WAL', updated_at = updated_at + 1",
            [],
        )
        .unwrap();
    let updated = reader.discover_all().unwrap();
    assert_eq!(
        updated.candidates[0].title.as_deref(),
        Some("Renamed thread in WAL")
    );
    assert_ne!(
        updated.candidates[0].fingerprint,
        original.candidates[0].fingerprint
    );
    assert_eq!(reader.titles.lock().unwrap().reads, metadata_reads + 1);
    let snapshot = |path: &Path| fs::read(path).unwrap();
    let paths = [
        "state_5.sqlite",
        "state_5.sqlite-wal",
        "thread_history_1.sqlite",
        "thread_history_1.sqlite-wal",
    ]
    .map(|name| fixture.dir.path().join(name));
    let before = paths.iter().map(|path| snapshot(path)).collect::<Vec<_>>();
    fixture.read(&reader, "one");
    let after = paths.iter().map(|path| snapshot(path)).collect::<Vec<_>>();
    assert_eq!(
        before, after,
        "Import must not write source database or WAL content"
    );
}

#[test]
fn paginated_projection_preserves_order_thinking_tools_steering_and_attachments() {
    let fixture = Fixture::new();
    fixture.thread("one", "cli", false);
    // Insert out of order; source ordinals, not row insertion or ids, own order.
    fixture.turn("one", "turn-last", 100, "inProgress");
    fixture.turn("one", "turn-first", 0, "completed");
    let items = vec![
        json!({"type":"userMessage","id":"u1","content":[{"type":"text","text":"Read the file"}]}),
        json!({"type":"reasoning","id":"think","summary":["Check source"],"content":["Inspect the file first"]}),
        json!({"type":"commandExecution","id":"cmd","command":"cat README.md","cwd":"/project",
            "status":"completed","aggregatedOutput":"Contents","exitCode":0,"durationMs":50}),
        json!({"type":"fileChange","id":"patch","status":"completed","changes":[{"path":"a.rs","kind":{"type":"update"},"diff":"-old\n+new"}]}),
        json!({"type":"mcpToolCall","id":"mcp","server":"sample","tool":"lookup","arguments":{"q":"test"},
            "status":"failed","result":null,"error":{"message":"offline"}}),
        json!({"type":"dynamicToolCall","id":"dynamic","namespace":"functions","tool":"exec","arguments":{"code":"1 + 1"},
            "status":"completed","success":true,"contentItems":[{"type":"inputText","text":"2"}]}),
        json!({"type":"webSearch","id":"web","query":"example","action":{"type":"search"},"results":[{"title":"Example"}]}),
        json!({"type":"imageView","id":"view","path":"/unread/image.png"}),
        json!({"type":"sleep","id":"sleep","durationMs":500}),
        json!({"type":"imageGeneration","id":"image","status":"completed","result":"/unread/generated.png"}),
        json!({"type":"subAgentActivity","id":"child","kind":"spawn","agentThreadId":"child-thread"}),
        json!({"type":"collabAgentToolCall","id":"collab","tool":"wait","status":"completed","agentsStates":{}}),
        json!({"type":"agentMessage","id":"a1","text":"First answer","futureField":true}),
        json!({"type":"userMessage","id":"u2","content":[{"type":"text","text":"Also look at this"},{"type":"localImage","path":"/unread/image.png"}]}),
        json!({"type":"agentMessage","id":"a2","text":"Second answer"}),
    ];
    for (index, item) in items.into_iter().enumerate().rev() {
        fixture.item("one", "turn-first", index as i64, item);
    }
    fixture.item(
        "one",
        "turn-last",
        101,
        json!({"type":"userMessage","id":"u3","content":[{"type":"text","text":"Next request"}]}),
    );
    fixture.item(
        "one",
        "turn-last",
        102,
        json!({"type":"agentMessage","id":"a3","text":"Still working"}),
    );
    fixture.item(
        "one",
        "turn-last",
        103,
        json!({"type":"imageGeneration","id":"image-pending",
        "status":"generating","result":"","revisedPrompt":"In progress"}),
    );
    let document = fixture.read(&fixture.reader(), "one");
    assert_eq!(document.turns.len(), 3);
    assert_eq!(document.turns[0].source_turn_id, "turn-first");
    assert_eq!(document.turns[1].source_turn_id, "turn-first:u2");
    assert_eq!(document.turns[2].source_turn_id, "turn-last");
    assert_eq!(document.turns[2].status, ExternalSessionStatus::Interrupted);
    assert!(matches!(
        &document.turns[2].items[1],
        ExternalSessionItem::Tool { success: None, .. }
    ));
    assert!(
        matches!(&document.turns[0].items[0], ExternalSessionItem::Thinking { text } if text.contains("Check source") && text.contains("Inspect the file first"))
    );
    assert!(
        matches!(&document.turns[0].items[1], ExternalSessionItem::Tool { name, input, result:Some(result), success:Some(true), .. }
        if name == "exec_command" && input["cmd"] == "cat README.md" && result["output"] == "Contents" && result["exit_code"] == 0)
    );
    assert!(
        matches!(&document.turns[0].items[3], ExternalSessionItem::Tool { name, result:Some(result), success:Some(false), .. }
        if name == "mcp__sample__lookup" && result["error"]["message"] == "offline")
    );
    assert!(
        matches!(&document.turns[0].items[4], ExternalSessionItem::Tool { name, result:Some(result), .. }
        if name == "functions.exec" && result[0]["type"] == "text" && result[0]["text"] == "2")
    );
    assert!(
        matches!(&document.turns[0].items[8], ExternalSessionItem::Tool { input, result:Some(result), .. }
        if input.get("result").is_none() && result["result"] == "/unread/generated.png")
    );
    assert!(document.turns[1].user_text.contains("Also look at this"));
    assert!(document.turns[1].user_text.contains("/unread/image.png"));
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "attachments_not_imported"));
}

#[test]
fn unknown_corrupt_or_unavailable_paginated_history_never_falls_back_to_partial_jsonl() {
    let fixture = Fixture::new();
    fixture.conversation("one");
    let reader = fixture.reader();
    let id = reader.discover_all().unwrap().candidates[0]
        .candidate_id
        .clone();
    fixture
        .history
        .execute(
            "UPDATE thread_items SET item_json = 'broken json' WHERE item_id = 'answer-1'",
            [],
        )
        .unwrap();
    assert!(reader
        .read_candidate(&id, ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("Malformed"));
    fixture
        .history
        .execute(
            "UPDATE thread_items SET item_json = ?1 WHERE item_id = 'answer-1'",
            [json!({"id":"answer-1","type":"futureBehavior"}).to_string()],
        )
        .unwrap();
    assert!(reader
        .read_candidate(&id, ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("Unsupported Codex history item"));
    fs::write(fixture.dir.path().join("thread_history_2.sqlite"), []).unwrap();
    assert!(reader
        .read_candidate(&id, ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("database version"));
    assert_eq!(reader.discover_all().unwrap().candidates.len(), 1);

    let missing = Fixture::new();
    missing.conversation("missing");
    let missing_id = missing.reader().discover_all().unwrap().candidates[0]
        .candidate_id
        .clone();
    drop(missing.history);
    fs::remove_file(missing.dir.path().join("thread_history_1.sqlite")).unwrap();
    let reader = CodexSessionReader::new(missing.dir.path().into());
    assert!(reader
        .read_candidate(&missing_id, ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("unavailable"));
    assert_eq!(reader.discover_all().unwrap().candidates.len(), 1);
}

#[test]
fn compaction_requires_full_history_and_orphan_items_are_reported() {
    let fixture = Fixture::new();
    fixture.conversation("one");
    fixture.item(
        "one",
        "turn-1",
        3,
        json!({"type":"contextCompaction","id":"compact"}),
    );
    let reader = fixture.reader();
    let document = fixture.read(&reader, "one");
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code == "compaction_present"));
    assert!(reader
        .read_candidate(
            &document.candidate.candidate_id,
            ExternalSessionImportMode::LatestCompacted
        )
        .err()
        .unwrap()
        .contains("select full history"));
    fixture.item(
        "one",
        "missing-turn",
        10,
        json!({"type":"agentMessage","id":"orphan","text":"Must not disappear"}),
    );
    assert!(reader
        .read_candidate(
            &document.candidate.candidate_id,
            ExternalSessionImportMode::Full
        )
        .err()
        .unwrap()
        .contains("without a readable turn"));
}

#[test]
#[ignore = "Read-only installed Codex catalog and history inspection, printing only aggregate counts"]
fn inspect_installed_codex_paginated_workspace() {
    let workspace = std::env::var("OPENBITFUN_TEST_CODEX_WORKSPACE").ok();
    let normalize = |path: &str| {
        let path = path.strip_prefix("\\\\?\\").unwrap_or(path);
        if cfg!(windows) {
            path.replace('\\', "/").trim_end_matches('/').to_lowercase()
        } else {
            path.trim_end_matches('/').to_owned()
        }
    };
    let reader = CodexSessionReader::default();
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.diagnostics.is_empty());
    let candidates = catalog
        .candidates
        .iter()
        .filter(|candidate| {
            workspace.as_ref().is_none_or(|workspace| {
                candidate
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| normalize(cwd) == normalize(workspace))
            })
        })
        .collect::<Vec<_>>();
    // Compare the real state catalog to discovery independently of its cached
    // metadata projection. A count alone cannot detect a missing/repeated ID.
    let state_path = fs::read_dir(&reader.codex_home)
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let name = name.to_str()?;
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .expect("No installed Codex state database")
        .1;
    let connection =
        Connection::open_with_flags(state_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection
        .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION;")
        .unwrap();
    let source_rows = connection
        .prepare("SELECT id, cwd, source FROM threads WHERE history_mode = 'paginated'")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let source_ids = source_rows
        .into_iter()
        .filter(|(_, cwd, source)| {
            let child = serde_json::from_str::<Value>(source)
                .ok()
                .is_some_and(|source| source.get("subagent").is_some());
            !child
                && workspace
                    .as_ref()
                    .is_none_or(|workspace| normalize(cwd) == normalize(workspace))
        })
        .map(|(id, _, _)| id)
        .collect::<BTreeSet<_>>();
    let discovered_ids = candidates
        .iter()
        .map(|candidate| candidate.source_session_id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        discovered_ids, source_ids,
        "Every source main session must be discovered"
    );
    assert_eq!(
        candidates.len(),
        source_ids.len(),
        "No duplicate source sessions"
    );
    let mut loaded = 0;
    let mut empty = 0;
    let mut failed = 0;
    let mut turns = 0;
    let mut tools = 0;
    let mut warning_counts = std::collections::BTreeMap::<String, usize>::new();
    for candidate in &candidates {
        match reader.read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full) {
            Ok(document) => {
                loaded += 1;
                turns += document.turns.len();
                tools += document
                    .turns
                    .iter()
                    .flat_map(|turn| &turn.items)
                    .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
                    .count();
                for warning in document.warnings {
                    *warning_counts.entry(warning.code).or_default() += 1;
                }
            }
            Err(error) if error.starts_with("No usable human conversation") => empty += 1,
            Err(error) => {
                failed += 1;
                eprintln!("Codex source read error: {error}");
            }
        }
    }
    println!("Codex source inspection: {} source main sessions matched by ID, {loaded} readable, {empty} empty, {failed} failed, {turns} turns, {tools} tool items; warnings: {warning_counts:?}", candidates.len());
    assert!(!candidates.is_empty());
    assert_eq!(failed, 0);
}
