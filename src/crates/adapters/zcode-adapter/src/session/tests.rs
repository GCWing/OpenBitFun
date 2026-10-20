use super::*;
use rusqlite::{params, Connection};
use serde_json::json;
use serde_json::Value;
use std::collections::BTreeSet;

struct Fixture {
    _root: tempfile::TempDir,
    reader: ZcodeSessionReader,
    writer: Connection,
}

impl Fixture {
    fn new(sequence: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("cli/db")).unwrap();
        let writer = Connection::open(root.path().join("cli/db/db.sqlite")).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);").unwrap();
        if sequence {
            writer.execute_batch("ALTER TABLE message ADD COLUMN sequence INTEGER; ALTER TABLE part ADD COLUMN sequence INTEGER;").unwrap();
        }
        Self {
            reader: ZcodeSessionReader::new(root.path().to_owned()),
            _root: root,
            writer,
        }
    }
    fn session(&self, id: &str, cwd: &str, updated: u64) {
        self.writer
            .execute(
                "INSERT INTO session VALUES (?1, NULL, ?2, ?1, '0.16.9', 1000, ?3)",
                params![id, cwd, updated],
            )
            .unwrap();
    }
    fn message(&self, session: &str, id: &str, order: u64, data: Value) {
        self.writer
            .execute(
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
                params![id, session, order, data.to_string()],
            )
            .unwrap();
        if self.writer.prepare("SELECT sequence FROM message").is_ok() {
            self.writer
                .execute(
                    "UPDATE message SET sequence = ?1 WHERE id = ?2",
                    params![order, id],
                )
                .unwrap();
        }
    }
    fn part(&self, session: &str, message: &str, id: &str, order: u64, data: Value) {
        self.writer.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)", params![id, message, session, order, data.to_string()]).unwrap();
        if self.writer.prepare("SELECT sequence FROM part").is_ok() {
            self.writer
                .execute(
                    "UPDATE part SET sequence = ?1 WHERE id = ?2",
                    params![order, id],
                )
                .unwrap();
        }
    }
    fn conversation(&self, id: &str) {
        self.session(id, "/project", 1000);
        self.message(id, &format!("{id}-u"), 1, json!({"role":"user", "time":{"created":1001}, "semantics":{"origin":"real_user","kind":"user_prompt"}}));
        self.part(
            id,
            &format!("{id}-u"),
            &format!("{id}-p1"),
            1,
            json!({"type":"text","text":"Inspect the project"}),
        );
        self.message(id, &format!("{id}-a"), 2, json!({"role":"assistant","parentID":format!("{id}-u"),"modelId":"glm-fixture","providerId":"zcode-fixture","finish":"stop"}));
        self.part(
            id,
            &format!("{id}-a"),
            &format!("{id}-p2"),
            2,
            json!({"type":"text","text":"Done"}),
        );
    }
    fn read(&self, id: &str) -> ExternalSessionDocument {
        self.reader
            .read_candidate(&format!("zcode:{id}"), ExternalSessionImportMode::Full)
            .unwrap()
    }
}

#[test]
fn missing_database_is_empty_without_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let reader = ZcodeSessionReader::new(root.path().to_owned());
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.candidates.is_empty());
    assert!(!root.path().join("cli").exists());
}

#[test]
fn automatic_discovery_reads_all_committed_sessions_beyond_the_ui_page() {
    let fixture = Fixture::new(true);
    for index in 0..57 {
        fixture.session(&format!("session-{index}"), "/project", index);
    }
    assert_eq!(
        fixture
            .reader
            .discover(0, 100, "")
            .unwrap()
            .candidates
            .len(),
        50
    );
    let all = fixture.reader.discover_all().unwrap();
    assert_eq!(all.candidates.len(), 57);
    assert!(all.next_cursor.is_none());
}

#[test]
fn discovery_follows_recent_activity_and_excludes_nested_tasks() {
    let fixture = Fixture::new(true);
    for i in 0..8 {
        fixture.session(&format!("a-{i}"), "C:\\Project", 100 + i);
    }
    fixture.session("a-new", "c:/project/", 300);
    fixture.session("b", "/b", 200);
    fixture.session("a-other", "C:/Project-other", 150);
    fixture.session("side", "/side", 999);
    fixture
        .writer
        .execute(
            "UPDATE session SET parent_id = 'a-new' WHERE id = 'side'",
            [],
        )
        .unwrap();
    let catalog = fixture.reader.discover_all().unwrap();
    assert_eq!(catalog.candidates.len(), 11);
    assert_eq!(catalog.candidates[0].source_session_id, "a-new");
    assert_eq!(catalog.candidates[1].source_session_id, "b");
    assert!(catalog
        .candidates
        .iter()
        .all(|candidate| candidate.source_session_id != "side"));
    assert!(fixture
        .reader
        .read_candidate("zcode:side", ExternalSessionImportMode::Full)
        .is_err());
}

#[test]
fn preserves_order_raw_tool_payloads_and_failed_results_without_runtime_reminders() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    fixture.message(
        "main",
        "hidden",
        2,
        json!({"role":"user","semantics":{"kind":"todo_reminder","uiVisibility":"hidden"}}),
    );
    fixture.part(
        "main",
        "hidden",
        "hidden-part",
        3,
        json!({"type":"text","text":"internal reminder","synthetic":true}),
    );
    fixture.part(
        "main",
        "main-a",
        "reasoning",
        0,
        json!({"type":"reasoning","text":"Reasoning history"}),
    );
    let input = json!({"command":"echo fixture", "timeout":1000});
    fixture.part("main", "main-a", "tool", 1, json!({"type":"tool","callID":"call-1","tool":"Bash","state":{"status":"completed","input":input,"output":{"stdout":"fixture","exitCode":0}}}));
    fixture.part("main", "main-a", "failed-tool", 3, json!({"type":"tool","callID":"call-2","tool":"Read","state":{"status":"error","input":{"path":"missing"},"error":"File not found"}}));
    let document = fixture.read("main");
    assert_eq!(document.turns.len(), 1);
    assert_eq!(document.turns[0].user_text, "Inspect the project");
    assert_eq!(document.turns[0].timestamp, 1001);
    assert_eq!(
        document.candidate.model_name.as_deref(),
        Some("glm-fixture")
    );
    let items = &document.turns[0].items;
    assert!(
        matches!(&items[0], ExternalSessionItem::Thinking { text } if text == "Reasoning history")
    );
    assert!(
        matches!(&items[1], ExternalSessionItem::Tool { id, input: actual, result: Some(result), success: Some(true), .. }
        if id == "call-1" && actual == &input && result["stdout"] == "fixture")
    );
    assert!(matches!(&items[2], ExternalSessionItem::Text { text } if text == "Done"));
    assert!(
        matches!(&items[3], ExternalSessionItem::Tool { result: Some(Value::String(error)), success: Some(false), .. } if error == "File not found")
    );
}

#[test]
fn parent_ids_keep_interleaved_replies_with_their_original_user_turns() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    fixture.message("main", "later-user", 2, json!({"role":"user"}));
    fixture.part(
        "main",
        "later-user",
        "later-text",
        1,
        json!({"type":"text","text":"Follow-up"}),
    );
    fixture
        .writer
        .execute("UPDATE message SET sequence=3 WHERE id='main-a'", [])
        .unwrap();
    let document = fixture.read("main");
    assert_eq!(document.turns.len(), 2);
    assert_eq!(document.turns[0].items.len(), 1);
    assert!(document.turns[1].items.is_empty());
    assert_eq!(document.turns[1].status, ExternalSessionStatus::Interrupted);
}

#[test]
fn unknown_parent_ids_cannot_attach_history_to_an_unrelated_user_turn() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    fixture
        .writer
        .execute(
            "UPDATE message SET data = ?1 WHERE id='main-a'",
            [json!({"role":"assistant","parentID":"missing-user","finish":"stop"}).to_string()],
        )
        .unwrap();
    assert!(fixture
        .reader
        .read_candidate("zcode:main", ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("no readable user turn"));
    fixture
        .writer
        .execute(
            "UPDATE message SET data = ?1 WHERE id='main-a'",
            [json!({"role":"assistant","finish":"stop"}).to_string()],
        )
        .unwrap();
    assert!(
        matches!(&fixture.read("main").turns[0].items[0], ExternalSessionItem::Text { text } if text == "Done")
    );
}

#[test]
fn replies_to_hidden_context_do_not_become_part_of_visible_history() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    fixture.message(
        "main",
        "hidden-user",
        3,
        json!({"role":"user","semantics":{"uiVisibility":"hidden"}}),
    );
    fixture.part(
        "main",
        "hidden-user",
        "hidden-input",
        3,
        json!({"type":"text","text":"Internal context"}),
    );
    fixture.message(
        "main",
        "hidden-reply",
        4,
        json!({"role":"assistant","parentID":"hidden-user","finish":"stop"}),
    );
    fixture.part(
        "main",
        "hidden-reply",
        "hidden-output",
        4,
        json!({"type":"text","text":"Internal reply"}),
    );
    let document = fixture.read("main");
    assert_eq!(document.turns.len(), 1);
    assert_eq!(document.turns[0].items.len(), 1);
    assert!(
        matches!(&document.turns[0].items[0], ExternalSessionItem::Text { text } if text == "Done")
    );
}

#[test]
fn legacy_databases_without_sequence_and_future_optional_fields_remain_readable() {
    let fixture = Fixture::new(false);
    fixture.conversation("legacy");
    fixture
        .writer
        .execute_batch("ALTER TABLE session ADD COLUMN future_field TEXT;")
        .unwrap();
    let document = fixture.read("legacy");
    assert_eq!(document.turns.len(), 1);
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Complete);
    assert_eq!(document.candidate.format_version.as_deref(), Some("0.16.9"));
}

#[test]
fn fingerprint_tracks_history_changes_but_not_unrelated_sessions() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    let original = fixture.read("main").candidate.fingerprint;
    fixture.conversation("other");
    assert_eq!(fixture.read("main").candidate.fingerprint, original);
    fixture
        .writer
        .execute(
            "UPDATE part SET data = ?1 WHERE id='main-p2'",
            [json!({"type":"text","text":"Changed"}).to_string()],
        )
        .unwrap();
    assert_ne!(fixture.read("main").candidate.fingerprint, original);
}

#[test]
fn running_tools_remain_interrupted_and_malformed_records_fail_without_repairing_source() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    fixture.part("main", "main-a", "running", 3, json!({"type":"tool","callID":"running","tool":"Bash","state":{"status":"running","input":{"command":"pending"}}}));
    let document = fixture.read("main");
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Interrupted);
    assert!(matches!(
        &document.turns[0].items[1],
        ExternalSessionItem::Tool {
            result: None,
            success: None,
            ..
        }
    ));
    fixture
        .writer
        .execute("UPDATE part SET data='{' WHERE id='running'", [])
        .unwrap();
    assert!(fixture
        .reader
        .read_candidate("zcode:main", ExternalSessionImportMode::Full)
        .err()
        .unwrap()
        .contains("Malformed"));
    let raw: String = fixture
        .writer
        .query_row("SELECT data FROM part WHERE id='running'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(raw, "{");
}

#[test]
fn unsupported_schema_and_candidate_paths_do_not_return_empty_success() {
    let fixture = Fixture::new(false);
    fixture.conversation("main");
    assert!(fixture
        .reader
        .read_candidate("zcode:main' OR 1=1 --", ExternalSessionImportMode::Full)
        .is_err());
    assert!(fixture
        .reader
        .read_candidate("codex:main", ExternalSessionImportMode::Full)
        .is_err());
    fixture.writer.execute_batch("DROP TABLE part;").unwrap();
    assert!(fixture
        .reader
        .discover(0, 5, "")
        .err()
        .unwrap()
        .contains("Unsupported"));
}

#[test]
#[ignore = "Reads the installed Zcode session database without changing it"]
fn inspect_installed_zcode() {
    let reader = ZcodeSessionReader::default();
    let catalog = reader.discover_all().unwrap();
    assert!(
        !catalog.candidates.is_empty(),
        "No installed Zcode sessions found"
    );
    let connection = Connection::open_with_flags(
        reader.zcode_home.join("cli/db/db.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let source_ids = connection
        .prepare("SELECT id FROM session WHERE parent_id IS NULL")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<BTreeSet<_>, _>>()
        .unwrap();
    let discovered_ids = catalog
        .candidates
        .iter()
        .map(|candidate| candidate.source_session_id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        discovered_ids, source_ids,
        "Every source main session must be discovered"
    );
    assert_eq!(
        catalog.candidates.len(),
        source_ids.len(),
        "No duplicate source sessions"
    );
    let mut paged_ids = Vec::new();
    let mut cursor = 0;
    loop {
        let page = reader.discover(cursor, 50, "").unwrap();
        paged_ids.extend(
            page.candidates
                .into_iter()
                .map(|candidate| candidate.source_session_id),
        );
        let Some(next) = page.next_cursor else { break };
        assert!(next > cursor);
        cursor = next;
    }
    assert_eq!(paged_ids.len(), source_ids.len());
    assert_eq!(paged_ids.into_iter().collect::<BTreeSet<_>>(), source_ids);
    let mut turns = 0;
    let mut tools = 0;
    for candidate in &catalog.candidates {
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        turns += document.turns.len();
        tools += document
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
            .count();
    }
    println!(
        "Zcode read-only import: {} source main sessions matched by ID and pagination, {turns} user turns, {tools} tool calls",
        catalog.candidates.len()
    );
}
