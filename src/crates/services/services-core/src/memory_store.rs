//! Durable Memory store schema and synchronous owner access.
//!
//! The live Memory workflow remains in Product Assembly. This module owns the
//! SQLite persistence shape and the small synchronous API needed by both the
//! live runtime and the offline legacy-data migrator.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use thiserror::Error;

pub const MEMORY_STORE_SCHEMA: &str = "openbitfun.memory.stage1.v1";
pub const MEMORY_FILE_NAME: &str = "MEMORY.md";
pub const MEMORY_SUMMARY_FILE_NAME: &str = "memory_summary.md";
pub const MEMORY_EXTENSIONS_DIR_NAME: &str = "extensions";
pub const AD_HOC_EXTENSION_NAME: &str = "ad_hoc";
pub const AD_HOC_NOTES_DIR_NAME: &str = "notes";

pub const EXPECTED_STAGE1_COLUMNS: &[&str] = &[
    "thread_id",
    "workspace_path",
    "rollout_path",
    "source_updated_at",
    "raw_memory",
    "rollout_summary",
    "rollout_slug",
    "generated_at",
    "usage_count",
    "last_usage",
    "selected_for_phase2",
    "selected_for_phase2_source_updated_at",
];

pub const EXPECTED_JOBS_COLUMNS: &[&str] = &[
    "kind",
    "job_key",
    "status",
    "worker_id",
    "ownership_token",
    "started_at",
    "finished_at",
    "lease_until",
    "retry_at",
    "retry_remaining",
    "last_error",
    "input_watermark",
    "last_success_watermark",
];

const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL: &str = "memory_consolidate_global";
const JOB_STATUS_DONE: &str = "done";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryRecord {
    pub session_id: String,
    pub workspace_path: String,
    pub rollout_path: String,
    pub source_updated_at_unix_secs: i64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: Option<String>,
    pub generated_at_unix_secs: i64,
    pub usage_count: i64,
    pub last_usage_unix_secs: Option<i64>,
    pub selected_for_phase2: i64,
    pub selected_for_phase2_source_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryJobRecord {
    pub kind: String,
    pub job_key: String,
    pub status: String,
    pub worker_id: Option<String>,
    pub ownership_token: Option<String>,
    pub started_at_unix_secs: Option<i64>,
    pub finished_at_unix_secs: Option<i64>,
    pub lease_until_unix_secs: Option<i64>,
    pub retry_at_unix_secs: Option<i64>,
    pub retry_remaining: i64,
    pub last_error: Option<String>,
    pub input_watermark: Option<i64>,
    pub last_success_watermark: Option<i64>,
}

impl MemoryJobRecord {
    /// Cooldown that keeps a clean, finished consolidation run from being repeated.
    ///
    /// The evaluated input clock advances on idle runs too, so watermark equality
    /// is not a cooldown precondition: an idle completion stamps the newest
    /// evaluated `input_watermark` without writing `last_success_watermark`, and a
    /// predicate that required the two to match would disarm the cooldown after
    /// every no-op run and let each later pass redo the whole evaluation. This
    /// mirrors the phase-2 runner in `agentic/memories/db.rs`, which owns the
    /// freshness decision and delegates here so there is a single implementation.
    pub fn success_cooldown_until_unix_secs(&self, cooldown_seconds: i64) -> Option<i64> {
        if self.kind != JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL
            || self.status != JOB_STATUS_DONE
            || self.last_error.is_some()
            || self.input_watermark.is_none()
        {
            return None;
        }

        self.finished_at_unix_secs
            .map(|finished_at| finished_at.saturating_add(cooldown_seconds.max(0)))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryStoreSnapshot {
    pub records: Vec<MemoryRecord>,
    pub jobs: Vec<MemoryJobRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryWorkspaceFileKind {
    Index,
    Summary,
    AdHocNote,
}

#[derive(Debug, Error)]
pub enum MemoryStoreError {
    #[error("Memory store SQLite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Memory store schema is unsupported: {0}")]
    UnsupportedSchema(String),
    #[error("Memory record is invalid: {0}")]
    InvalidRecord(String),
}

pub fn initialize_memory_schema(conn: &Connection) -> Result<(), MemoryStoreError> {
    recreate_table_if_shape_differs(conn, "stage1_outputs", EXPECTED_STAGE1_COLUMNS)?;
    recreate_table_if_shape_differs(conn, "jobs", EXPECTED_JOBS_COLUMNS)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS stage1_outputs (
            thread_id TEXT PRIMARY KEY NOT NULL,
            workspace_path TEXT NOT NULL,
            rollout_path TEXT NOT NULL,
            source_updated_at INTEGER NOT NULL,
            raw_memory TEXT NOT NULL,
            rollout_summary TEXT NOT NULL,
            rollout_slug TEXT,
            generated_at INTEGER NOT NULL,
            usage_count INTEGER,
            last_usage INTEGER,
            selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
            selected_for_phase2_source_updated_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
            ON stage1_outputs(source_updated_at DESC, thread_id DESC);

        CREATE TABLE IF NOT EXISTS jobs (
            kind TEXT NOT NULL,
            job_key TEXT NOT NULL,
            status TEXT NOT NULL,
            worker_id TEXT,
            ownership_token TEXT,
            started_at INTEGER,
            finished_at INTEGER,
            lease_until INTEGER,
            retry_at INTEGER,
            retry_remaining INTEGER NOT NULL,
            last_error TEXT,
            input_watermark INTEGER,
            last_success_watermark INTEGER,
            PRIMARY KEY (kind, job_key)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
            ON jobs(kind, status, retry_at, lease_until);
        "#,
    )?;
    Ok(())
}

pub fn validate_memory_schema(conn: &Connection) -> Result<(), MemoryStoreError> {
    validate_table_shape(conn, "stage1_outputs", EXPECTED_STAGE1_COLUMNS)?;
    validate_table_shape(conn, "jobs", EXPECTED_JOBS_COLUMNS)
}

pub fn read_memory_store_snapshot(
    conn: &Connection,
) -> Result<MemoryStoreSnapshot, MemoryStoreError> {
    validate_memory_schema(conn)?;
    let mut record_statement = conn.prepare(
        r#"
        SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
               rollout_summary, rollout_slug, generated_at, COALESCE(usage_count, 0),
               last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
        FROM stage1_outputs
        ORDER BY thread_id
        "#,
    )?;
    let records = record_statement
        .query_map([], decode_memory_record)?
        .collect::<Result<Vec<_>, _>>()?;
    for record in &records {
        validate_memory_record(record)?;
    }

    let mut job_statement = conn.prepare(
        r#"
        SELECT kind, job_key, status, worker_id, ownership_token, started_at,
               finished_at, lease_until, retry_at, retry_remaining, last_error,
               input_watermark, last_success_watermark
        FROM jobs
        ORDER BY kind, job_key
        "#,
    )?;
    let jobs = job_statement
        .query_map([], decode_memory_job)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MemoryStoreSnapshot { records, jobs })
}

pub fn upsert_memory_record(
    conn: &Connection,
    record: &MemoryRecord,
    overwrite_usage_and_selection: bool,
) -> Result<(), MemoryStoreError> {
    let overwrite = i64::from(overwrite_usage_and_selection);
    conn.execute(
        UPSERT_STAGE1_OUTPUT_SQL,
        params![
            &record.session_id,
            &record.workspace_path,
            &record.rollout_path,
            record.source_updated_at_unix_secs,
            &record.raw_memory,
            &record.rollout_summary,
            &record.rollout_slug,
            record.generated_at_unix_secs,
            record.usage_count,
            record.last_usage_unix_secs,
            record.selected_for_phase2,
            record.selected_for_phase2_source_updated_at,
            overwrite,
            overwrite,
            overwrite,
            overwrite,
        ],
    )?;
    Ok(())
}

pub fn decode_memory_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        session_id: row.get(0)?,
        workspace_path: row.get(1)?,
        rollout_path: row.get(2)?,
        source_updated_at_unix_secs: row.get(3)?,
        raw_memory: row.get(4)?,
        rollout_summary: row.get(5)?,
        rollout_slug: row.get(6)?,
        generated_at_unix_secs: row.get(7)?,
        usage_count: row.get(8)?,
        last_usage_unix_secs: row.get(9)?,
        selected_for_phase2: row.get(10)?,
        selected_for_phase2_source_updated_at: row.get(11)?,
    })
}

pub fn decode_memory_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryJobRecord> {
    Ok(MemoryJobRecord {
        kind: row.get(0)?,
        job_key: row.get(1)?,
        status: row.get(2)?,
        worker_id: row.get(3)?,
        ownership_token: row.get(4)?,
        started_at_unix_secs: row.get(5)?,
        finished_at_unix_secs: row.get(6)?,
        lease_until_unix_secs: row.get(7)?,
        retry_at_unix_secs: row.get(8)?,
        retry_remaining: row.get(9)?,
        last_error: row.get(10)?,
        input_watermark: row.get(11)?,
        last_success_watermark: row.get(12)?,
    })
}

pub fn classify_memory_workspace_file(path: &Path) -> Option<MemoryWorkspaceFileKind> {
    let components = path.components().collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    if components.len() == 1 {
        let file_name = components[0].as_os_str().to_str()?;
        return match file_name {
            MEMORY_FILE_NAME => Some(MemoryWorkspaceFileKind::Index),
            MEMORY_SUMMARY_FILE_NAME => Some(MemoryWorkspaceFileKind::Summary),
            _ => None,
        };
    }
    if components.len() >= 4
        && components[0].as_os_str() == MEMORY_EXTENSIONS_DIR_NAME
        && components[1].as_os_str() == AD_HOC_EXTENSION_NAME
        && components[2].as_os_str() == AD_HOC_NOTES_DIR_NAME
    {
        let file_name = components.last()?.as_os_str().to_str()?;
        if !file_name.is_empty() && file_name.ends_with(".md") {
            return Some(MemoryWorkspaceFileKind::AdHocNote);
        }
    }
    None
}

fn validate_memory_record(record: &MemoryRecord) -> Result<(), MemoryStoreError> {
    if record.session_id.trim().is_empty() {
        return Err(MemoryStoreError::InvalidRecord(
            "thread_id must not be empty".to_string(),
        ));
    }
    if !matches!(record.selected_for_phase2, 0 | 1) {
        return Err(MemoryStoreError::InvalidRecord(format!(
            "selected_for_phase2 must be 0 or 1 for thread_id {}",
            record.session_id
        )));
    }
    Ok(())
}

fn validate_table_shape(
    conn: &Connection,
    table_name: &str,
    expected_columns: &[&str],
) -> Result<(), MemoryStoreError> {
    let actual = table_columns(conn, table_name)?;
    let expected = expected_columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(MemoryStoreError::UnsupportedSchema(format!(
            "table {table_name} has columns {actual:?}, expected {expected:?}"
        )));
    }
    Ok(())
}

fn recreate_table_if_shape_differs(
    conn: &Connection,
    table_name: &str,
    expected_columns: &[&str],
) -> Result<(), MemoryStoreError> {
    let columns = table_columns(conn, table_name)?;
    let expected = expected_columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if !columns.is_empty() && columns != expected {
        conn.execute(&format!("DROP TABLE IF EXISTS {table_name}"), [])?;
    }
    Ok(())
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>, MemoryStoreError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

const UPSERT_STAGE1_OUTPUT_SQL: &str = r#"
    INSERT INTO stage1_outputs (
        thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
        rollout_summary, rollout_slug, generated_at, usage_count,
        last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        rollout_path = excluded.rollout_path,
        source_updated_at = excluded.source_updated_at,
        raw_memory = excluded.raw_memory,
        rollout_summary = excluded.rollout_summary,
        rollout_slug = excluded.rollout_slug,
        generated_at = excluded.generated_at,
        usage_count = CASE
            WHEN ? != 0 THEN excluded.usage_count
            ELSE stage1_outputs.usage_count
        END,
        last_usage = CASE
            WHEN ? != 0 THEN excluded.last_usage
            ELSE stage1_outputs.last_usage
        END,
        selected_for_phase2 = CASE
            WHEN ? != 0 THEN excluded.selected_for_phase2
            ELSE stage1_outputs.selected_for_phase2
        END,
        selected_for_phase2_source_updated_at = CASE
            WHEN ? != 0 THEN excluded.selected_for_phase2_source_updated_at
            ELSE stage1_outputs.selected_for_phase2_source_updated_at
        END
    WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_user_notes_keep_owner_classification_without_path_escape() {
        assert!(classify_memory_workspace_file(Path::new(
            "extensions/ad_hoc/notes/project/note.md"
        ))
        .is_some());
        assert!(
            classify_memory_workspace_file(Path::new("extensions/ad_hoc/notes/../note.md"))
                .is_none()
        );
    }

    #[test]
    fn owner_schema_round_trips_records_and_keeps_jobs_separate() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_memory_schema(&connection).unwrap();
        let record = MemoryRecord {
            session_id: "session-1".to_string(),
            workspace_path: "/workspace".to_string(),
            rollout_path: "/workspace/sessions/session-1".to_string(),
            source_updated_at_unix_secs: 10,
            raw_memory: "durable fact".to_string(),
            rollout_summary: "summary".to_string(),
            rollout_slug: Some("fixture".to_string()),
            generated_at_unix_secs: 11,
            usage_count: 2,
            last_usage_unix_secs: Some(12),
            selected_for_phase2: 1,
            selected_for_phase2_source_updated_at: Some(10),
        };
        upsert_memory_record(&connection, &record, true).unwrap();
        connection
            .execute(
                "INSERT INTO jobs (kind, job_key, status, retry_remaining) VALUES ('memory_stage1', 'session-1', 'done', 3)",
                [],
            )
            .unwrap();

        let snapshot = read_memory_store_snapshot(&connection).unwrap();
        assert_eq!(snapshot.records, vec![record]);
        assert_eq!(snapshot.jobs.len(), 1);
        assert_eq!(snapshot.jobs[0].job_key, "session-1");
    }

    #[test]
    fn success_cooldown_survives_an_idle_watermark_advance() {
        let mut job = MemoryJobRecord {
            kind: JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL.to_string(),
            job_key: "global".to_string(),
            status: JOB_STATUS_DONE.to_string(),
            worker_id: None,
            ownership_token: None,
            started_at_unix_secs: Some(1_000),
            finished_at_unix_secs: Some(1_000),
            lease_until_unix_secs: None,
            retry_at_unix_secs: None,
            retry_remaining: 3,
            last_error: None,
            input_watermark: Some(2_000),
            last_success_watermark: Some(1_500),
        };
        // The evaluated input clock is ahead of the last success watermark because
        // an idle run advanced it, which must not disarm the cooldown.
        assert_eq!(job.success_cooldown_until_unix_secs(600), Some(1_600));

        job.last_error = Some("boom".to_string());
        assert_eq!(job.success_cooldown_until_unix_secs(600), None);
        job.last_error = None;

        job.status = "running".to_string();
        assert_eq!(job.success_cooldown_until_unix_secs(600), None);
        job.status = JOB_STATUS_DONE.to_string();

        job.input_watermark = None;
        assert_eq!(job.success_cooldown_until_unix_secs(600), None);
        job.input_watermark = Some(2_000);

        job.kind = "memory_stage1".to_string();
        assert_eq!(job.success_cooldown_until_unix_secs(600), None);
        job.kind = JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL.to_string();

        job.finished_at_unix_secs = None;
        assert_eq!(job.success_cooldown_until_unix_secs(600), None);
    }

    #[test]
    fn workspace_file_contract_accepts_only_durable_owner_inputs() {
        assert_eq!(
            classify_memory_workspace_file(Path::new("MEMORY.md")),
            Some(MemoryWorkspaceFileKind::Index)
        );
        assert_eq!(
            classify_memory_workspace_file(Path::new(
                "extensions/ad_hoc/notes/2026-01-01T00-00-00-note.md"
            )),
            Some(MemoryWorkspaceFileKind::AdHocNote)
        );
        assert_eq!(
            classify_memory_workspace_file(Path::new("raw_memories.md")),
            None
        );
        assert_eq!(
            classify_memory_workspace_file(Path::new("rollout_summaries/generated.md")),
            None
        );
        assert_eq!(
            classify_memory_workspace_file(Path::new("../MEMORY.md")),
            None
        );
    }
}
