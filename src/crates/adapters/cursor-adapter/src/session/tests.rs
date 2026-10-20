use super::*;
use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    reader: CursorSessionReader,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let reader = CursorSessionReader::new(
            root.path().join("cli"),
            root.path().join("data"),
            root.path().join("desktop"),
        );
        Self { root, reader }
    }
    fn cli(&self, id: &str) -> (PathBuf, Connection) {
        let path = self
            .reader
            .config_dir
            .join("chats/workspace")
            .join(id)
            .join("store.db");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=1; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB);").unwrap();
        (path, db)
    }
    fn desktop(&self) -> (PathBuf, Connection) {
        let path = self
            .reader
            .user_data_dir
            .join("User/globalStorage/state.vscdb");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        (path, db)
    }
    fn read(&self, id: &str) -> Result<ExternalSessionDocument, String> {
        self.reader
            .read_candidate(&format!("cursor:{id}"), ExternalSessionImportMode::Full)
    }
}

fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value >= 128 {
        bytes.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
    bytes
}
fn field(number: u64, value: &[u8]) -> Vec<u8> {
    [
        varint((number << 3) | 2),
        varint(value.len() as u64),
        value.to_vec(),
    ]
    .concat()
}
fn blob(db: &Connection, bytes: &[u8]) -> Vec<u8> {
    let id = Sha256::digest(bytes).to_vec();
    db.execute(
        "INSERT OR IGNORE INTO blobs VALUES (?1, ?2)",
        params![hex::encode(&id), bytes],
    )
    .unwrap();
    id
}
fn root(db: &Connection, messages: &[Value]) -> Vec<u8> {
    messages
        .iter()
        .flat_map(|message| field(1, &blob(db, &serde_json::to_vec(message).unwrap())))
        .collect()
}
fn meta(db: &Connection, id: &str, root: &[u8]) {
    let data = json!({"agentId":id,"name":"New Agent","createdAt":1234,"latestRootBlobId":hex::encode(blob(db, root))});
    db.execute(
        "INSERT OR REPLACE INTO meta VALUES ('0', ?1)",
        [hex::encode(serde_json::to_vec(&data).unwrap())],
    )
    .unwrap();
}
fn kv(db: &Connection, key: &str, value: Value) {
    db.execute(
        "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1, ?2)",
        params![key, value.to_string()],
    )
    .unwrap();
}
fn user(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}]})
}
fn assistant(text: &str) -> Value {
    json!({"role":"assistant","content":[{"type":"text","text":text}]})
}

#[test]
fn cli_reachable_snapshot_preserves_original_tools_failure_and_source_bytes() {
    let f = Fixture::new();
    let (path, db) = f.cli("one");
    let messages = vec![
        json!({"role":"system","content":"system","providerOptions":{"cursor":{"systemPromptFingerprint":{"model":"source-model"}}}}),
        json!({"role":"user","content":"runtime context","providerOptions":{"cursor":{"requestContextCompleteness":"full"}}}),
        json!({"role":"user","content":"<timestamp>now</timestamp><user_query>Read the file</user_query>","providerOptions":{"cursor":{"requestId":"request-1"}}}),
        json!({"role":"assistant","content":[{"type":"reasoning","text":"checking"},{"type":"text","text":"I will read it"},{"type":"tool-call","toolCallId":"call\nfc_1","toolName":"Read","args":{"path":"sample.txt"}}]}),
        json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call\nfc_1","toolName":"Read","result":"missing"}],"providerOptions":{"cursor":{"highLevelToolCallResult":{"isError":true}}}}),
        assistant("failed as expected"),
        user("Continue"),
        assistant("done"),
    ];
    let mut current = root(&db, &messages);
    let user_meta = [field(2, b"human-1"), varint(25 << 3), varint(5000)].concat();
    let agent = [field(1, &blob(&db, &user_meta)), field(3, b"request-1")].concat();
    current.extend(field(8, &blob(&db, &field(1, &agent))));
    meta(&db, "one", &current);
    blob(
        &db,
        &serde_json::to_vec(&user("unreachable old branch")).unwrap(),
    );
    std::fs::write(
        path.with_file_name("meta.json"),
        json!({"schemaVersion":1,"cwd":f.root.path(),"updatedAtMs":6000}).to_string(),
    )
    .unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let doc = f.read("one").unwrap();
    assert_eq!(doc.turns.len(), 2);
    assert_eq!(doc.turns[0].user_text, "Read the file");
    assert_eq!(doc.turns[0].source_turn_id, "human-1");
    assert_eq!(doc.turns[0].timestamp, 5000);
    assert_eq!(doc.candidate.model_name.as_deref(), Some("source-model"));
    assert!(
        matches!(&doc.turns[0].items[2], ExternalSessionItem::Tool { id, name, input, result: Some(result), success: Some(false) }
        if id == "call\nfc_1" && name == "Read" && input["path"] == "sample.txt" && result == "missing")
    );
    assert!(
        matches!(&doc.turns[0].items[0], ExternalSessionItem::Thinking { text } if text == "checking")
    );
    assert!(
        matches!(&doc.turns[0].items[1], ExternalSessionItem::Text { text } if text == "I will read it")
    );
    assert_eq!(
        f.reader.discover_all().unwrap().candidates[0]
            .title
            .as_deref(),
        Some("Read the file")
    );
    assert_eq!(before, std::fs::read(path).unwrap());
}

#[test]
fn cli_expands_archives_in_order_and_skips_generated_summaries() {
    for archive_field in [11, 13] {
        let f = Fixture::new();
        let (_, db) = f.cli("compact");
        let archive = root(&db, &[user("before compaction"), assistant("old answer")]);
        let current = [field(archive_field, &blob(&db, &archive)), root(&db, &[
        json!({"role":"user","content":"generated summary","providerOptions":{"cursor":{"isSummary":true}}}),
        user("after compaction"), assistant("new answer")])].concat();
        meta(&db, "compact", &current);
        let doc = f.read("compact").unwrap();
        assert_eq!(
            doc.turns
                .iter()
                .map(|t| t.user_text.as_str())
                .collect::<Vec<_>>(),
            ["before compaction", "after compaction"]
        );
        assert!(doc.warnings.iter().any(|w| w.code == "source_compacted"));
    }
}

#[test]
fn cli_missing_referenced_message_fails_without_importing_partial_history() {
    let f = Fixture::new();
    let (_, db) = f.cli("missing");
    meta(
        &db,
        "missing",
        &[root(&db, &[user("visible")]), field(1, &[9; 32])].concat(),
    );
    assert!(f.read("missing").err().unwrap().contains("missing blob"));
}

#[test]
fn cli_reads_committed_wal_and_rejects_future_required_store_versions() {
    let f = Fixture::new();
    let (_, db) = f.cli("wal");
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    meta(
        &db,
        "wal",
        &root(&db, &[user("from WAL"), assistant("yes")]),
    );
    assert_eq!(f.read("wal").unwrap().turns[0].user_text, "from WAL");
    db.execute_batch("PRAGMA user_version=99;").unwrap();
    let catalog = f.reader.discover_all().unwrap();
    assert!(catalog.candidates.is_empty());
    assert!(catalog
        .diagnostics
        .iter()
        .any(|w| w.detail.contains("version 99")));
}

#[test]
fn cli_rejects_corrupt_reference_envelopes() {
    let f = Fixture::new();
    let (_, db) = f.cli("corrupt");
    meta(&db, "corrupt", &[10, 255, 255]);
    assert!(f.read("corrupt").is_err());
}

#[test]
fn duplicate_cli_locations_prefer_newer_history_and_do_not_treat_remote_uris_as_local_paths() {
    let f = Fixture::new();
    for (directory, updated, prompt) in [("old", 1, "old prompt"), ("new", 2, "new prompt")] {
        let (path, db) = f.cli(directory);
        meta(
            &db,
            "same",
            &root(&db, &[user(prompt), assistant("answer")]),
        );
        std::fs::write(
            path.with_file_name("meta.json"),
            json!({"cwd":"vscode-remote://ssh-remote+host/home/project","updatedAtMs":updated})
                .to_string(),
        )
        .unwrap();
    }
    let catalog = f.reader.discover_all().unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    assert_eq!(catalog.candidates[0].cwd, None);
    assert!(catalog
        .diagnostics
        .iter()
        .any(|w| w.code == "workspace_unresolved"));
    assert_eq!(f.read("same").unwrap().turns[0].user_text, "new prompt");
}

#[test]
fn desktop_preserves_results_stored_in_additional_data_and_reports_plaintext_only_sources() {
    let f = Fixture::new();
    let (_, db) = f.desktop();
    kv(
        &db,
        "composerData:projected",
        json!({"conversation":[
        {"type":1,"text":"search files"},
        {"type":2,"toolFormerData":{"tool":41,"toolCallId":"grep","status":"completed","params":"{\"pattern\":\"hello\"}","additionalData":{"output":"file.txt:1:hello"}}},
        {"type":2,"text":"found"}]}),
    );
    let doc = f.read("projected").unwrap();
    assert!(
        matches!(&doc.turns[0].items[0], ExternalSessionItem::Tool { result: Some(value), .. } if value["output"] == "file.txt:1:hello")
    );
    assert!(doc
        .warnings
        .iter()
        .any(|w| w.code == "desktop_tool_projection"));
    let text = f
        .reader
        .data_dir
        .join("projects/slug/agent-transcripts/plain.txt");
    std::fs::create_dir_all(text.parent().unwrap()).unwrap();
    std::fs::write(text, "user:\nprompt").unwrap();
    let catalog = f.reader.discover_all().unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    assert!(catalog
        .diagnostics
        .iter()
        .any(|w| w.code == "plaintext_transcript_unsupported"));
}

#[test]
fn desktop_follows_headers_and_preserves_serialized_results() {
    let f = Fixture::new();
    let (path, db) = f.desktop();
    let uri = url::Url::from_directory_path(f.root.path())
        .unwrap()
        .to_string();
    kv(
        &db,
        "composerData:desk",
        json!({"_v":18,"composerId":"desk","name":"Desktop history","workspaceIdentifier":{"uri":uri},
        "createdAt":100,"lastUpdatedAt":200,"fullConversationHeadersOnly":[{"bubbleId":"z-user"},{"bubbleId":"a-tool"},{"bubbleId":"b-answer"}]}),
    );
    kv(
        &db,
        "bubbleId:desk:z-user",
        json!({"type":1,"text":"read desktop file","createdAt":101}),
    );
    kv(
        &db,
        "bubbleId:desk:a-tool",
        json!({"type":2,"thinking":{"text":"inspect"},"toolFormerData":{"tool":40,"toolCallId":"desktop-tool","params":"{\"targetFile\":\"file.txt\"}","result":"{\"contents\":\"hello\"}","status":"completed"}}),
    );
    kv(
        &db,
        "bubbleId:desk:b-answer",
        json!({"type":2,"text":"done"}),
    );
    kv(
        &db,
        "bubbleId:desk:unreferenced",
        json!({"type":1,"text":"stale branch"}),
    );
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let doc = f.read("desk").unwrap();
    assert_eq!(doc.turns.len(), 1);
    assert!(doc.candidate.cwd.is_some());
    assert!(
        matches!(&doc.turns[0].items[1], ExternalSessionItem::Tool { name, input, result: Some(result), success: Some(true), .. }
        if name == "read_file_v2" && input["targetFile"] == "file.txt" && result["contents"] == "hello")
    );
    assert_eq!(before, std::fs::read(path).unwrap());
}

#[test]
fn desktop_separate_headers_supply_workspace_and_participate_in_snapshot_validation() {
    let f = Fixture::new();
    let (path, db) = f.desktop();
    db.execute_batch("CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, value TEXT);")
        .unwrap();
    let uri = url::Url::from_directory_path(f.root.path()).unwrap();
    let header = json!({"composerId":"current", "name":"Desktop header title", "lastUpdatedAt":200,
        "workspaceIdentifier":{"id":"workspace", "uri":{"scheme":"file", "path":uri.path()}}});
    db.execute(
        "INSERT INTO composerHeaders VALUES (?1, ?2)",
        params!["current", header.to_string()],
    )
    .unwrap();
    kv(
        &db,
        "composerData:current",
        json!({"_v":18,"composerId":"current","createdAt":100,
        "conversation":[{"type":1,"text":"real desktop prompt"},{"type":2,"text":"done"}]}),
    );
    let before = std::fs::read(&path).unwrap();
    let doc = f.read("current").unwrap();
    assert_eq!(
        doc.candidate.cwd,
        uri_path(&header["workspaceIdentifier"]["uri"])
    );
    assert_eq!(doc.candidate.title.as_deref(), Some("Desktop header title"));
    assert_eq!(doc.candidate.updated_at, Some(200));
    assert_eq!(doc.turns[0].user_text, "real desktop prompt");
    assert_eq!(before, std::fs::read(&path).unwrap());
    let source = f.reader.sources().unwrap().0.pop().unwrap();
    let mut changed = header;
    changed["name"] = json!("Renamed in Cursor");
    db.execute(
        "UPDATE composerHeaders SET value = ?1 WHERE composerId = 'current'",
        [changed.to_string()],
    )
    .unwrap();
    assert!(desktop::read(source)
        .err()
        .unwrap()
        .contains("changed during discovery"));
}

#[test]
fn desktop_header_remote_identity_does_not_fall_back_to_local_workspace_metadata() {
    let f = Fixture::new();
    let (_, db) = f.desktop();
    db.execute_batch("CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, value TEXT);")
        .unwrap();
    let workspace = f
        .reader
        .user_data_dir
        .join("User/workspaceStorage/remote/workspace.json");
    std::fs::create_dir_all(workspace.parent().unwrap()).unwrap();
    std::fs::write(
        workspace,
        json!({"folder":url::Url::from_directory_path(f.root.path()).unwrap().as_str()})
            .to_string(),
    )
    .unwrap();
    db.execute("INSERT INTO composerHeaders VALUES ('remote-header', ?1)",
        [json!({"composerId":"remote-header", "workspaceIdentifier":{"id":"remote", "uri":{"scheme":"vscode-remote","path":"/remote/project"}}}).to_string()]).unwrap();
    kv(
        &db,
        "composerData:remote-header",
        json!({"conversation":[{"type":1,"text":"remote prompt"},{"type":2,"text":"done"}]}),
    );
    assert_eq!(f.read("remote-header").unwrap().candidate.cwd, None);
    db.execute(
        "UPDATE composerHeaders SET value = ?1",
        [json!({"composerId":"different-id"}).to_string()],
    )
    .unwrap();
    let catalog = f.reader.discover_all().unwrap();
    assert!(catalog.candidates.is_empty());
    assert!(catalog
        .diagnostics
        .iter()
        .any(|warning| warning.detail.contains("identity")));
}

#[test]
fn desktop_legacy_inline_and_workspace_metadata_remain_readable() {
    let f = Fixture::new();
    let (_, db) = f.desktop();
    let workspace = f
        .reader
        .user_data_dir
        .join("User/workspaceStorage/older/workspace.json");
    std::fs::create_dir_all(workspace.parent().unwrap()).unwrap();
    std::fs::write(
        workspace,
        json!({"folder":url::Url::from_directory_path(f.root.path()).unwrap().to_string()})
            .to_string(),
    )
    .unwrap();
    kv(
        &db,
        "composerData:legacy",
        json!({"workspaceIdentifier":{"id":"older"},"conversation":[
        {"type":1,"bubbleId":"user","text":"older prompt"},{"type":2,"text":"older answer"}]}),
    );
    let doc = f.read("legacy").unwrap();
    assert_eq!(doc.turns[0].user_text, "older prompt");
    assert!(doc.candidate.cwd.is_some());
}

#[test]
fn desktop_missing_bubbles_fail_and_remote_workspace_uris_are_not_local_paths() {
    let f = Fixture::new();
    let (_, db) = f.desktop();
    kv(
        &db,
        "composerData:remote",
        json!({"workspaceIdentifier":{"uri":"vscode-remote://ssh-remote+server/home/project"},"fullConversationHeadersOnly":[{"bubbleId":"human"},{"bubbleId":"missing"}]}),
    );
    kv(
        &db,
        "bubbleId:remote:human",
        json!({"type":1,"text":"remote prompt"}),
    );
    let catalog = f.reader.discover_all().unwrap();
    assert_eq!(catalog.candidates[0].cwd, None);
    assert!(f.read("remote").err().unwrap().contains("missing bubble"));
}

#[test]
fn desktop_drafts_and_subagents_do_not_become_top_level_sessions() {
    let f = Fixture::new();
    let (_, db) = f.desktop();
    for (id, flag) in [
        ("draft", json!({"isDraft":true})),
        (
            "child",
            json!({"subagentInfo":{"parentComposerId":"parent"}}),
        ),
    ] {
        kv(&db, &format!("composerData:{id}"), flag);
    }
    assert!(f.reader.discover_all().unwrap().candidates.is_empty());
}

#[test]
fn transcript_fallback_keeps_prompt_and_marks_missing_results_without_guessing_workspace() {
    let f = Fixture::new();
    let path = f
        .reader
        .data_dir
        .join("projects/lossy-path/agent-transcripts/transcript/transcript.jsonl");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let records = [
        json!({"role":"user","message":{"content":[{"type":"text","text":"<user_query>literal</user_query>"}]}}),
        json!({"role":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"path":"output.txt","contents":"ok"}}]}}),
        json!({"type":"turn_ended","status":"success"}),
    ];
    std::fs::write(
        &path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let subagent = path.parent().unwrap().join("subagents/child.jsonl");
    std::fs::create_dir_all(subagent.parent().unwrap()).unwrap();
    std::fs::write(subagent, user("child").to_string()).unwrap();
    let catalog = f.reader.discover_all().unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    let doc = f.read("transcript").unwrap();
    assert_eq!(doc.turns[0].user_text, "<user_query>literal</user_query>");
    assert_eq!(doc.candidate.cwd, None);
    assert_eq!(doc.turns[0].status, ExternalSessionStatus::Interrupted);
    assert!(doc.warnings.iter().any(|w| w.code == "tool_result_missing"));
    assert!(doc
        .warnings
        .iter()
        .any(|w| w.code == "workspace_unresolved"));
}

#[test]
fn catalog_pages_and_filters_and_keeps_unreadable_sessions_diagnostic() {
    let f = Fixture::new();
    for id in ["alpha", "beta", "gamma"] {
        let (path, db) = f.cli(id);
        meta(&db, id, &root(&db, &[user(id), assistant("answer")]));
        std::fs::write(
            path.with_file_name("meta.json"),
            json!({"title":id,"cwd":f.root.path()}).to_string(),
        )
        .unwrap();
    }
    let (_, invalid) = f.cli("invalid");
    invalid.execute_batch("PRAGMA user_version=99").unwrap();
    let page = f.reader.discover(0, 1, "").unwrap();
    assert_eq!(page.candidates.len(), 1);
    assert_eq!(page.next_cursor, Some(1));
    assert_eq!(
        f.reader.discover(0, 1, "beta").unwrap().candidates[0].source_session_id,
        "beta"
    );
    assert!(!page.diagnostics.is_empty());
    assert!(f.read("../../escape").is_err());
}

#[test]
fn duplicate_tool_and_turn_identities_cannot_silently_overwrite_history() {
    let f = Fixture::new();
    let (_, db) = f.cli("duplicate");
    meta(
        &db,
        "duplicate",
        &root(
            &db,
            &[
                user("prompt"),
                json!({"role":"assistant","content":[
        {"type":"tool-call","toolCallId":"same","toolName":"Read","args":{}},
        {"type":"tool-call","toolCallId":"same","toolName":"Write","args":{}}]}),
            ],
        ),
    );
    assert!(f
        .read("duplicate")
        .err()
        .unwrap()
        .contains("Duplicate Cursor tool call"));
}

#[test]
#[ignore = "reads an explicitly selected installed Cursor session; prints counts only"]
fn inspect_installed_cursor() {
    let id = std::env::var("OPENBITFUN_TEST_CURSOR_SESSION_ID")
        .expect("set OPENBITFUN_TEST_CURSOR_SESSION_ID");
    let reader = CursorSessionReader::default();
    let catalog = reader.discover_all().unwrap();
    assert!(catalog.candidates.iter().any(|c| c.source_session_id == id));
    let doc = reader
        .read_candidate(&format!("cursor:{id}"), ExternalSessionImportMode::Full)
        .unwrap();
    let tools = doc
        .turns
        .iter()
        .flat_map(|t| &t.items)
        .filter(|i| matches!(i, ExternalSessionItem::Tool { .. }))
        .count();
    let failed = doc
        .turns
        .iter()
        .flat_map(|t| &t.items)
        .filter(|i| {
            matches!(
                i,
                ExternalSessionItem::Tool {
                    success: Some(false),
                    ..
                }
            )
        })
        .count();
    assert_eq!(doc.turns.len(), 2);
    assert_eq!(tools, 4);
    assert_eq!(failed, 1);
    assert!(doc.turns[0].items.iter().any(
        |i| matches!(i, ExternalSessionItem::Text { text } if text.contains("CURSOR_IMPORT_OK"))
    ));
    assert!(doc.turns[1].items.iter().any(
        |i| matches!(i, ExternalSessionItem::Text { text } if text.contains("CURSOR_RESUME_OK"))
    ));
    println!(
        "Cursor installed-source verified: turns={} tools={tools} failed={failed}",
        doc.turns.len()
    );
}
