use super::*;
use rusqlite::{params, Connection};
use serde_json::json;
use serde_json::Value;

struct Fixture {
    _root: tempfile::TempDir,
    reader: OpenCodeSessionReader,
    writer: Connection,
}

impl Fixture {
    fn new(sequence: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let writer = Connection::open(root.path().join("opencode.db")).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);").unwrap();
        if sequence {
            writer.execute_batch("ALTER TABLE message ADD COLUMN sequence INTEGER; ALTER TABLE part ADD COLUMN sequence INTEGER;").unwrap();
        }
        Self {
            reader: OpenCodeSessionReader::new(root.path().to_owned()),
            _root: root,
            writer,
        }
    }
    fn session(&self, id: &str, cwd: &str, updated: u64) {
        self.writer
            .execute(
                "INSERT INTO session VALUES (?1, NULL, ?2, ?1, '1.2.25', 1000, ?3)",
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
        self.message(id, &format!("{id}-1"), 1, json!({"role":"user", "time":{"created":1001}, "semantics":{"origin":"real_user","kind":"user_prompt"}}));
        self.part(
            id,
            &format!("{id}-1"),
            &format!("{id}-p1"),
            1,
            json!({"type":"text","text":"Inspect the project"}),
        );
        self.message(id, &format!("{id}-2"), 2, json!({"role":"assistant","parentID":format!("{id}-1"),"modelID":"model-fixture","providerID":"provider-fixture","finish":"stop"}));
        self.part(
            id,
            &format!("{id}-2"),
            &format!("{id}-p2"),
            2,
            json!({"type":"text","text":"Done"}),
        );
    }
    fn read(&self, id: &str) -> ExternalSessionDocument {
        self.reader
            .read_candidate(&format!("opencode:{id}"), ExternalSessionImportMode::Full)
            .unwrap()
    }
}

#[test]
fn reads_committed_wal_and_uses_one_read_only_snapshot() {
    let fixture = Fixture::new(true);
    fixture.conversation("main");
    assert!(fixture._root.path().join("opencode.db-wal").exists());
    let (connection, _) = fixture.reader.open().unwrap().unwrap();
    assert!(connection
        .is_readonly(rusqlite::DatabaseName::Main)
        .unwrap());
    fixture
        .writer
        .execute(
            "UPDATE part SET data = ?1 WHERE id='main-p2'",
            [json!({"type":"text","text":"New committed answer"}).to_string()],
        )
        .unwrap();
    let old: String = connection
        .query_row("SELECT data FROM part WHERE id='main-p2'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&old).unwrap()["text"], "Done");
    assert!(connection.execute("DELETE FROM session", []).is_err());
    assert!(
        matches!(&fixture.read("main").turns[0].items[0], ExternalSessionItem::Text { text } if text == "New committed answer")
    );
}

#[test]
fn imports_open_code_casing_tools_and_legacy_columns_without_source_writes() {
    let fixture = Fixture::new(false);
    fixture.conversation("main");
    fixture.part("main", "main-2", "tool", 3, json!({"type":"tool","callID":"call","tool":"read", "state":{"status":"error","input":{"filePath":"/project/missing"},"error":"File not found"}}));
    fixture.part(
        "main",
        "main-2",
        "thinking",
        4,
        json!({"type":"reasoning","text":"Inspect first"}),
    );
    let before: String = fixture
        .writer
        .query_row("SELECT data FROM part WHERE id='tool'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let document = fixture.read("main");
    assert_eq!(document.candidate.ecosystem_id, "opencode");
    assert_eq!(
        document.candidate.model_name.as_deref(),
        Some("model-fixture")
    );
    assert_eq!(
        document.candidate.model_provider.as_deref(),
        Some("provider-fixture")
    );
    assert_eq!(document.turns.len(), 1);
    assert!(document.turns[0].items.iter().any(|item| matches!(item, ExternalSessionItem::Tool { success:Some(false), input, .. } if input["filePath"] == "/project/missing")));
    assert!(document.turns[0].items.iter().any(
        |item| matches!(item, ExternalSessionItem::Thinking {text} if text == "Inspect first")
    ));
    let after: String = fixture
        .writer
        .query_row("SELECT data FROM part WHERE id='tool'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn pending_undo_excludes_reverted_messages_without_mutating_the_store() {
    let fixture = Fixture::new(false);
    fixture.conversation("main");
    fixture
        .writer
        .execute_batch("ALTER TABLE session ADD COLUMN revert TEXT")
        .unwrap();
    fixture
        .writer
        .execute(
            "UPDATE session SET revert=?1",
            [json!({"messageID":"next-u"}).to_string()],
        )
        .unwrap();
    fixture.message("main", "next-u", 10, json!({"role":"user"}));
    fixture.part(
        "main",
        "next-u",
        "next-p",
        10,
        json!({"type":"text","text":"Undone prompt"}),
    );
    let document = fixture.read("main");
    assert_eq!(document.turns.len(), 1);
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.code.ends_with("reverted_history_omitted")));
    assert_eq!(
        fixture
            .writer
            .query_row("SELECT count(*) FROM message", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
    fixture
        .writer
        .execute(
            "UPDATE session SET revert=?1",
            [json!({"messageID":"main-2", "partID":"main-p2"}).to_string()],
        )
        .unwrap();
    let document = fixture.read("main");
    assert!(document.turns[0].items.is_empty());
    assert_eq!(document.turns[0].status, ExternalSessionStatus::Interrupted);
}

#[test]
fn source_identity_missing_store_and_unsupported_schema_are_explicit() {
    let root = tempfile::tempdir().unwrap();
    let reader = OpenCodeSessionReader::new(root.path().into());
    assert!(reader.discover_all().unwrap().candidates.is_empty());
    assert!(!root.path().join("opencode.db").exists());
    let fixture = Fixture::new(false);
    fixture.conversation("main");
    assert!(fixture
        .reader
        .read_candidate("zcode:main", ExternalSessionImportMode::Full)
        .is_err());
    fixture.writer.execute_batch("DROP TABLE part").unwrap();
    assert!(fixture
        .reader
        .discover_all()
        .unwrap_err()
        .contains("Unsupported"));
}

#[test]
#[ignore = "Reads installed OpenCode history without changing it; prints counts only"]
fn inspect_installed_opencode() {
    let reader = std::env::var_os("OPENBITFUN_TEST_OPENCODE_DATA")
        .map(|path| OpenCodeSessionReader::new(path.into()))
        .unwrap_or_default();
    let catalog = reader.discover_all().unwrap();
    assert!(!catalog.candidates.is_empty());
    let expected = std::env::var("OPENBITFUN_TEST_OPENCODE_SESSION").ok();
    let mut total = (0, 0, 0);
    for candidate in catalog.candidates.iter().filter(|candidate| {
        expected
            .as_ref()
            .is_none_or(|id| id == &candidate.source_session_id)
    }) {
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        total.0 += 1;
        total.1 += document.turns.len();
        total.2 += document
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
            .count();
        if expected.is_some() {
            assert_eq!(document.turns.len(), 2);
            assert!(document.turns[1].items.iter().any(|item| matches!(item, ExternalSessionItem::Text { text } if text.contains("OPENCODE_RESUME_OK"))));
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
    assert!(total.0 > 0);
    println!(
        "OpenCode: {} sessions, {} turns, {} tools",
        total.0, total.1, total.2
    );
}
