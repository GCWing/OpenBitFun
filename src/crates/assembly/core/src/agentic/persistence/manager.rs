//! Persistence Manager
//!
//! Responsible for project-scoped session persistence.

use crate::agentic::core::{
    sanitize_persisted_session_state, CompressionState, Message, MessageContent,
    PersistedSessionStateFile as StoredSessionStateFile, Session, SessionConfig, SessionState,
    SessionSummary,
};
use crate::agentic::memories::db::{MemoryDatabase, MEMORY_PHASE2_GLOBAL_JOB_KEY};
use crate::agentic::memories::external_context::dialog_turn_uses_external_context;
use crate::agentic::session::revert::{SessionRevertState, SESSION_REVERT_SCHEMA_VERSION};
use crate::agentic::session::transcript_render::{
    render_transcript, rendered_turn_char_count, transcript_display_user_content,
    transcript_fingerprint,
};
use crate::agentic::session::{
    CoreSessionStorePort, SessionPromptCache, TokenAnchor, PROMPT_CACHE_SCHEMA_VERSION,
};
use crate::agentic::session::{
    EvidenceLedgerEvent, PersistedEvidenceLedgerFile, EVIDENCE_LEDGER_SCHEMA_VERSION,
};
use crate::agentic::skill_agent_snapshot::TurnSkillAgentSnapshot;
use crate::infrastructure::PathManager;
use crate::service::config::get_global_config_service;
use crate::service::config::types::{GlobalConfig, MemoryExternalContextPolicy};
use crate::service::remote_ssh::workspace_state::{
    resolve_workspace_session_identity, LOCAL_WORKSPACE_SSH_HOST,
};
use crate::service::session::{
    DialogTurnData, SessionMetadata, SessionTranscriptExport, SessionTranscriptExportOptions,
    SessionTurnCatalog, SessionTurnCatalogEntry, SessionTurnWindowResponse, StoredDialogTurnFile,
    TranscriptLineRange, TurnRailCapsulePreview, TurnRailCapsuleSegment,
    SESSION_STORAGE_SCHEMA_VERSION, SESSION_TURN_CATALOG_SCHEMA_VERSION,
};
use crate::service::workspace_runtime::WorkspaceRuntimeService;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::timing::elapsed_ms_u64;
use futures::{stream, StreamExt};
use log::{debug, info, warn};
use openbitfun_runtime_ports::{
    SessionTurnLoadRequest, SessionTurnLoadTiming, SessionTurnWindowRequest,
};
#[cfg(feature = "product-search")]
use openbitfun_services_core::session_search::SessionSearchSqliteIndex;
use openbitfun_services_core::{
    json_store::{JsonFileStore, JsonFileStoreError},
    session::{
        build_session_metadata as build_persisted_session_metadata, empty_session_metadata_page,
        refresh_session_metadata_from_turns, try_refresh_session_metadata_for_saved_turn,
        DialogTurnKind, SessionLastTurn, SessionMemoryMode, SessionMetadataBuildFacts,
        SessionMetadataStore, SessionMetadataStoreError, SessionStorageLayout, SessionWriteLock,
        SessionWriteLockError, TurnStatus,
    },
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Semaphore};

pub use openbitfun_services_core::session::SessionMetadataPage;

const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
const COMPRESSION_TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
const COMPRESSION_TRANSCRIPT_CREATE_ATTEMPTS: usize = 32;
const TOKEN_ANCHOR_SCHEMA_VERSION: u32 = 1;
const SESSION_TURN_READ_CONCURRENCY: usize = 4;
static SESSION_ACTIVITY_REPAIR_SLOTS: Semaphore = Semaphore::const_new(2);
const SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT: usize = 320;
const TURN_RAIL_CAPSULE_MAX_SEGMENTS: usize = 64;
const TURN_RAIL_CAPSULE_TEXT_LIMIT: usize = 320;
const TURN_RAIL_CAPSULE_LABEL_LIMIT: usize = 160;
const TURN_RAIL_CAPSULE_TITLE_LIMIT: usize = 320;
const SESSION_TURN_WINDOW_MAX_BEFORE: usize = 4;
const SESSION_TURN_WINDOW_MAX_TARGET_AND_AFTER: usize = 12;
pub const SESSION_REFERENCE_TRANSCRIPT_CHAR_LIMIT: usize = 60_000;

static SESSION_PERSISTENCE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();
static SESSION_BRANCH_ALLOCATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    OnceLock::new();

struct PendingSessionDirectory {
    path: PathBuf,
    committed: bool,
}

impl PendingSessionDirectory {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PendingSessionDirectory {
    fn drop(&mut self) {
        if self.committed || !self.path.exists() {
            return;
        }
        if let Err(error) = std::fs::remove_dir_all(&self.path) {
            warn!(
                "Failed to remove an unfinished Session directory: path={}, error={}",
                self.path.display(),
                error
            );
        }
    }
}

async fn memory_pollution_guard_enabled() -> bool {
    match get_global_config_service().await {
        Ok(service) => {
            let config: OpenBitFunResult<GlobalConfig> = service.get_config(None).await;
            config
                .map(|config| {
                    config.memories.generate_memories
                        && config.memories.external_context_policy
                            == MemoryExternalContextPolicy::SkipSession
                })
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

async fn new_session_memory_mode_from_global_config() -> SessionMemoryMode {
    match get_global_config_service().await {
        Ok(service) => {
            let config: OpenBitFunResult<GlobalConfig> = service.get_config(None).await;
            if config
                .map(|config| config.memories.generate_memories)
                .unwrap_or(true)
            {
                SessionMemoryMode::Enabled
            } else {
                SessionMemoryMode::Disabled
            }
        }
        Err(_) => SessionMemoryMode::Enabled,
    }
}

fn current_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// Legacy navigation repair reads only identity/outcome fields. In particular,
/// do not flatten this DTO: serde flatten would materialize ignored messages
/// and tool payloads while collecting the unknown fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTurnActivity {
    #[serde(alias = "turn_id")]
    turn_id: String,
    #[serde(alias = "turn_index")]
    turn_index: usize,
    #[serde(alias = "session_id")]
    session_id: String,
    #[serde(default, alias = "turn_kind")]
    kind: DialogTurnKind,
    status: TurnStatus,
    #[serde(default, alias = "end_time")]
    end_time: Option<u64>,
    #[serde(default, alias = "finish_reason")]
    finish_reason: Option<String>,
    #[serde(default, alias = "recovery_epoch")]
    recovery_epoch: Option<u32>,
    #[serde(default)]
    recovery: Option<openbitfun_services_core::session::DialogTurnRecoveryData>,
}

struct ReadTurnPathsResult {
    turns: Vec<DialogTurnData>,
    missing_turn_file_count: usize,
    max_turn_read_duration_ms: u64,
}

struct BuiltSessionTurnCatalogProjection {
    visible: SessionTurnCatalog,
    physical: SessionTurnCatalog,
    physical_changed: bool,
}

fn truncate_turn_catalog_preview(content: &str) -> (String, bool) {
    let mut chars = content.trim().chars();
    let preview = chars
        .by_ref()
        .take(SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT)
        .collect::<String>();
    (preview, chars.next().is_some())
}

fn bounded_display_text(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn turn_rail_capsule_preview(turn: &DialogTurnData) -> Option<TurnRailCapsulePreview> {
    let metadata = turn.user_message.metadata.as_ref()?.as_object()?;
    let presentation = metadata.get("composerPresentation")?.as_object()?;
    if presentation.get("version")?.as_u64()? != 1 {
        return None;
    }
    let raw_segments = presentation.get("segments")?.as_array()?;
    let mut segments = Vec::new();
    for raw in raw_segments.iter().take(TURN_RAIL_CAPSULE_MAX_SEGMENTS) {
        let segment = raw.as_object()?;
        match segment.get("kind")?.as_str()? {
            "text" => {
                let text = segment.get("text")?.as_str()?;
                if !text.is_empty() {
                    segments.push(TurnRailCapsuleSegment::Text {
                        text: bounded_display_text(text, TURN_RAIL_CAPSULE_TEXT_LIMIT),
                    });
                }
            }
            "context" => {
                let context = segment.get("context")?.as_object()?;
                let context_type = context.get("type")?.as_str()?;
                let label = segment.get("label")?.as_str()?;
                let title = segment
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .map(|value| bounded_display_text(value, TURN_RAIL_CAPSULE_TITLE_LIMIT));
                segments.push(TurnRailCapsuleSegment::Context {
                    context_type: bounded_display_text(context_type, 40),
                    label: bounded_display_text(label, TURN_RAIL_CAPSULE_LABEL_LIMIT),
                    title,
                });
            }
            "inline-token" => {
                let token_type = segment.get("tokenType")?.as_str()?;
                let label = segment.get("label")?.as_str()?;
                segments.push(TurnRailCapsuleSegment::InlineToken {
                    token_type: bounded_display_text(token_type, 40),
                    label: bounded_display_text(label, TURN_RAIL_CAPSULE_LABEL_LIMIT),
                });
            }
            _ => return None,
        }
    }
    (!segments.is_empty()).then_some(TurnRailCapsulePreview { segments })
}

fn turn_catalog_entry(turn: &DialogTurnData, ordinal: usize) -> SessionTurnCatalogEntry {
    let (preview, preview_truncated) =
        truncate_turn_catalog_preview(&transcript_display_user_content(turn));
    SessionTurnCatalogEntry {
        ordinal,
        storage_turn_index: turn.turn_index,
        turn_id: Some(turn.turn_id.clone()),
        preview: Some(preview),
        preview_truncated,
        capsule_preview: turn_rail_capsule_preview(turn),
    }
}

fn placeholder_turn_catalog_entry(
    storage_turn_index: usize,
    ordinal: usize,
) -> SessionTurnCatalogEntry {
    SessionTurnCatalogEntry {
        ordinal,
        storage_turn_index,
        turn_id: None,
        preview: None,
        preview_truncated: false,
        capsule_preview: None,
    }
}

fn complete_turn_catalog_indices(
    indices: impl IntoIterator<Item = usize>,
    minimum_count: usize,
) -> Vec<usize> {
    let mut indices = indices.into_iter().collect::<BTreeSet<_>>();
    let mut candidate = 0usize;
    while indices.len() < minimum_count {
        indices.insert(candidate);
        candidate = candidate.saturating_add(1);
    }
    indices.into_iter().collect()
}

fn turn_catalog_revision(entries: &[SessionTurnCatalogEntry]) -> String {
    let mut hasher = Sha256::new();
    hasher.update((entries.len() as u64).to_le_bytes());
    for entry in entries {
        hasher.update((entry.ordinal as u64).to_le_bytes());
        hasher.update((entry.storage_turn_index as u64).to_le_bytes());
    }
    let digest = hasher.finalize();
    format!("v2-{}", hex::encode(&digest[..8]))
}

fn build_turn_catalog(
    session_id: &str,
    mut entries: Vec<SessionTurnCatalogEntry>,
) -> SessionTurnCatalog {
    entries.sort_by_key(|entry| entry.storage_turn_index);
    for (ordinal, entry) in entries.iter_mut().enumerate() {
        entry.ordinal = ordinal;
    }
    let complete = entries
        .iter()
        .all(|entry| entry.turn_id.is_some() && entry.preview.is_some());
    SessionTurnCatalog {
        schema_version: SESSION_TURN_CATALOG_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        revision: turn_catalog_revision(&entries),
        total_turn_count: entries.len(),
        complete,
        entries,
    }
}

fn is_well_formed_turn_catalog(catalog: &SessionTurnCatalog) -> bool {
    let entries_are_ordered = catalog.entries.iter().enumerate().all(|(ordinal, entry)| {
        entry.ordinal == ordinal
            && (ordinal == 0
                || catalog.entries[ordinal - 1].storage_turn_index < entry.storage_turn_index)
    });
    let entries_are_complete = catalog
        .entries
        .iter()
        .all(|entry| entry.turn_id.is_some() && entry.preview.is_some());

    catalog.total_turn_count == catalog.entries.len()
        && catalog.complete == entries_are_complete
        && entries_are_ordered
        && catalog.revision == turn_catalog_revision(&catalog.entries)
}

fn can_incrementally_update_turn_catalog_after_save(
    catalog: &SessionTurnCatalog,
    physical_indices: &[usize],
    saved_turn_index: usize,
) -> bool {
    let catalog_len = catalog.entries.len();
    let aligned_prefix = catalog
        .entries
        .iter()
        .zip(physical_indices.iter())
        .all(|(entry, index)| entry.storage_turn_index == *index);
    if !aligned_prefix {
        return false;
    }

    match physical_indices.len().checked_sub(catalog_len) {
        Some(0) => catalog
            .entries
            .iter()
            .any(|entry| entry.storage_turn_index == saved_turn_index),
        Some(1) => physical_indices.get(catalog_len) == Some(&saved_turn_index),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSessionPromptCacheFile {
    schema_version: u32,
    #[serde(flatten)]
    cache: SessionPromptCache,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTokenAnchorsFile {
    schema_version: u32,
    session_id: String,
    anchors: Vec<TokenAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTurnContextSnapshotFile {
    schema_version: u32,
    session_id: String,
    turn_index: usize,
    messages: Vec<Message>,
}

/// Borrowed write-side counterpart of [`StoredTurnContextSnapshotFile`]; lets
/// snapshot writes serialize messages without cloning ones that need no
/// sanitization. Field names/order must stay in sync with the stored struct.
#[derive(Debug, Serialize)]
struct TurnContextSnapshotWriteFile<'a> {
    schema_version: u32,
    session_id: &'a str,
    turn_index: usize,
    messages: Vec<Cow<'a, Message>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTurnSkillAgentSnapshotFile {
    schema_version: u32,
    session_id: String,
    turn_index: usize,
    snapshot: TurnSkillAgentSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSkillAgentBaselineOverrideFile {
    schema_version: u32,
    session_id: String,
    snapshot: TurnSkillAgentSnapshot,
}

#[derive(Debug, Default)]
struct ContextSnapshotPayloadStats {
    tool_result_count: usize,
    raw_result_string_chars: usize,
    result_for_assistant_chars: usize,
    largest_raw_result_chars: usize,
    largest_raw_result_path: String,
}

fn collect_json_string_stats(
    value: &serde_json::Value,
    path: &str,
    total: &mut usize,
    largest: &mut (usize, String),
) {
    match value {
        serde_json::Value::String(text) => {
            let char_count = text.chars().count();
            *total += char_count;
            if char_count > largest.0 {
                *largest = (char_count, path.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_json_string_stats(item, &format!("{}[{}]", path, index), total, largest);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                let next_path = if path.is_empty() {
                    key.to_string()
                } else {
                    format!("{}.{}", path, key)
                };
                collect_json_string_stats(item, &next_path, total, largest);
            }
        }
        _ => {}
    }
}

fn context_snapshot_payload_stats(messages: &[Message]) -> ContextSnapshotPayloadStats {
    let mut stats = ContextSnapshotPayloadStats::default();
    for (message_index, message) in messages.iter().enumerate() {
        let MessageContent::ToolResult {
            tool_name,
            result,
            result_for_assistant,
            ..
        } = &message.content
        else {
            continue;
        };

        stats.tool_result_count += 1;
        if let Some(text) = result_for_assistant.as_deref() {
            stats.result_for_assistant_chars += text.chars().count();
        }

        let mut raw_chars = 0usize;
        let mut largest = (0usize, String::new());
        collect_json_string_stats(
            result,
            &format!("message[{}].{}", message_index, tool_name),
            &mut raw_chars,
            &mut largest,
        );
        stats.raw_result_string_chars += raw_chars;
        if largest.0 > stats.largest_raw_result_chars {
            stats.largest_raw_result_chars = largest.0;
            stats.largest_raw_result_path = largest.1;
        }
    }
    stats
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSessionTranscriptFile {
    schema_version: u32,
    #[serde(flatten)]
    transcript: SessionTranscriptExport,
}

/// A generated local artifact that exposes a bounded read-only copy of a
/// referenced session to the consuming session's agent tools.
#[derive(Debug, Clone)]
pub struct MaterializedSessionReferenceTranscript {
    pub uri: String,
    pub turn_count: usize,
    pub char_count: usize,
    pub index_range: TranscriptLineRange,
    pub latest_turn_range: Option<TranscriptLineRange>,
    pub line_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct CompressionTranscriptArtifact {
    pub(crate) uri: String,
    pub(crate) index_range: TranscriptLineRange,
    pub(crate) transcript_path: PathBuf,
    pub(crate) meta_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionTranscriptMetadata {
    schema_version: u32,
    boundary_turn_index: usize,
    short_id: String,
    compression_id: String,
    trigger: String,
    generated_at: u64,
    origin_session_id: String,
    source_fingerprint: String,
    line_count: usize,
    byte_count: usize,
    options: CompressionTranscriptOptionsMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionTranscriptOptionsMetadata {
    tools: bool,
    tool_inputs: bool,
    thinking: bool,
}

#[derive(Debug, Clone, Copy)]
enum TranscriptTurnSelector {
    Index(isize),
    Slice {
        start: Option<isize>,
        end: Option<isize>,
    },
}

#[derive(Debug, Clone)]
struct ParsedTranscriptTurnSelector {
    normalized: String,
    selector: TranscriptTurnSelector,
}

pub struct PersistenceManager {
    path_manager: Arc<PathManager>,
    runtime_service: Arc<WorkspaceRuntimeService>,
    #[cfg(test)]
    fail_next_session_state_write: std::sync::Mutex<Option<String>>,
    #[cfg(test)]
    fail_next_evidence_ledger_write: std::sync::Mutex<Option<String>>,
    #[cfg(test)]
    fail_next_session_metadata_write: std::sync::Mutex<Option<String>>,
    #[cfg(test)]
    fail_next_session_metadata_rollback: std::sync::Mutex<Option<String>>,
    #[cfg(test)]
    fail_next_dialog_turn_write: std::sync::Mutex<Option<String>>,
}

impl PersistenceManager {
    pub fn new(path_manager: Arc<PathManager>) -> OpenBitFunResult<Self> {
        Ok(Self {
            runtime_service: Arc::new(WorkspaceRuntimeService::new(path_manager.clone())),
            path_manager,
            #[cfg(test)]
            fail_next_session_state_write: std::sync::Mutex::new(None),
            #[cfg(test)]
            fail_next_evidence_ledger_write: std::sync::Mutex::new(None),
            #[cfg(test)]
            fail_next_session_metadata_write: std::sync::Mutex::new(None),
            #[cfg(test)]
            fail_next_session_metadata_rollback: std::sync::Mutex::new(None),
            #[cfg(test)]
            fail_next_dialog_turn_write: std::sync::Mutex::new(None),
        })
    }

    fn validate_session_id(session_id: &str) -> OpenBitFunResult<()> {
        openbitfun_core_types::validate_session_id(session_id).map_err(OpenBitFunError::Validation)
    }

    /// Get PathManager reference
    pub fn path_manager(&self) -> &Arc<PathManager> {
        &self.path_manager
    }

    pub fn runtime_service(&self) -> &Arc<WorkspaceRuntimeService> {
        &self.runtime_service
    }

    #[cfg(test)]
    pub(crate) fn fail_next_session_state_write_for_test(&self, session_id: &str) {
        *self
            .fail_next_session_state_write
            .lock()
            .expect("session state fault lock") = Some(session_id.to_string());
    }

    #[cfg(test)]
    pub(crate) fn fail_next_evidence_ledger_write_for_test(&self, session_id: &str) {
        *self
            .fail_next_evidence_ledger_write
            .lock()
            .expect("evidence ledger fault lock") = Some(session_id.to_string());
    }

    #[cfg(test)]
    pub(crate) fn fail_next_session_metadata_write_for_test(&self, session_id: &str) {
        *self
            .fail_next_session_metadata_write
            .lock()
            .expect("session metadata fault lock") = Some(session_id.to_string());
    }

    #[cfg(test)]
    pub(crate) fn fail_next_session_metadata_rollback_for_test(&self, session_id: &str) {
        *self
            .fail_next_session_metadata_rollback
            .lock()
            .expect("session metadata rollback fault lock") = Some(session_id.to_string());
    }

    #[cfg(test)]
    pub(crate) fn fail_next_dialog_turn_write_for_test(&self, session_id: &str) {
        *self
            .fail_next_dialog_turn_write
            .lock()
            .expect("dialog turn fault lock") = Some(session_id.to_string());
    }

    /// Resolve the on-disk sessions directory for `workspace_path`.
    ///
    /// Callers may pass either a logical workspace root or an already-resolved
    /// managed sessions directory. Local workspace roots are slugified under
    /// `~/.openbitfun/projects/`; already-resolved local/remote sessions
    /// directories are used as-is.
    fn project_sessions_dir(&self, workspace_path: &Path) -> PathBuf {
        if self.is_resolved_sessions_dir(workspace_path) {
            return workspace_path.to_path_buf();
        }
        self.path_manager.project_sessions_dir(workspace_path)
    }

    #[cfg(feature = "product-search")]
    async fn invalidate_session_search(&self, workspace_path: &Path, session_id: &str) {
        let index = SessionSearchSqliteIndex::new(self.project_sessions_dir(workspace_path));
        if let Err(error) = index.invalidate_session_if_present(session_id).await {
            warn!(
                "Failed to invalidate derived Session search index: session_id={} error={}",
                session_id, error
            );
        }
    }

    #[cfg(feature = "product-search")]
    async fn remove_session_from_search(&self, workspace_path: &Path, session_id: &str) {
        let index = SessionSearchSqliteIndex::new(self.project_sessions_dir(workspace_path));
        if !index.path().exists() {
            return;
        }
        if let Err(error) = index.remove_session(session_id).await {
            warn!(
                "Failed to remove Session from derived search index: session_id={} error={}",
                session_id, error
            );
        }
    }

    /// Hold this across a multi-step Session write that is not already owned by
    /// a loaded Session runtime.
    pub(crate) fn lock_session_writes(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<SessionWriteLock> {
        let sessions_dir = self.project_sessions_dir(workspace_path);
        SessionWriteLock::try_acquire(&sessions_dir, session_id)
            .map_err(|error| Self::session_write_lock_error(session_id, error))
    }

    pub(super) fn lock_session_write_operation(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<SessionWriteLock> {
        let sessions_dir = self.project_sessions_dir(workspace_path);
        SessionWriteLock::try_acquire_for_operation(&sessions_dir, session_id)
            .map_err(|error| Self::session_write_lock_error(session_id, error))
    }

    fn session_write_lock_error(session_id: &str, error: SessionWriteLockError) -> OpenBitFunError {
        match error {
            SessionWriteLockError::InUse => OpenBitFunError::SessionInUse {
                session_id: session_id.to_string(),
            },
            other => OpenBitFunError::Session(format!(
                "Failed to protect Session writes: session_id={session_id}, code={}, error={other}",
                other.code()
            )),
        }
    }

    pub(crate) fn is_resolved_sessions_dir(&self, path: &Path) -> bool {
        CoreSessionStorePort::resolved_sessions_dir_kind(self.path_manager.as_ref(), path).is_some()
    }

    fn state_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path).state_path(session_id)
    }

    fn evidence_ledger_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .session_dir(session_id)
            .join("evidence-ledger.json")
    }

    fn prompt_cache_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .prompt_cache_path(session_id)
    }

    fn turn_catalog_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .turn_catalog_path(session_id)
    }

    fn token_anchors_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .session_dir(session_id)
            .join("token-anchors.json")
    }

    fn session_revert_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .session_dir(session_id)
            .join("session-revert.json")
    }

    fn turns_dir(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path).turns_dir(session_id)
    }

    fn snapshots_dir(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .snapshots_dir(session_id)
    }

    fn turn_path(&self, workspace_path: &Path, session_id: &str, turn_index: usize) -> PathBuf {
        self.session_layout(workspace_path)
            .turn_path(session_id, turn_index)
    }

    fn context_snapshot_path(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> PathBuf {
        self.session_layout(workspace_path)
            .context_snapshot_path(session_id, turn_index)
    }

    fn skill_agent_snapshot_path(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> PathBuf {
        self.session_layout(workspace_path)
            .skill_agent_snapshot_path(session_id, turn_index)
    }

    fn skill_agent_baseline_override_path(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> PathBuf {
        self.session_layout(workspace_path)
            .skill_agent_baseline_override_path(session_id)
    }

    fn transcript_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .transcript_path(session_id)
    }

    fn transcript_meta_path(&self, workspace_path: &Path, session_id: &str) -> PathBuf {
        self.session_layout(workspace_path)
            .transcript_meta_path(session_id)
    }

    fn session_reference_transcript_path(
        &self,
        workspace_path: &Path,
        session_id: &str,
        reference_artifact_stem: &str,
    ) -> PathBuf {
        self.session_layout(workspace_path)
            .session_reference_transcript_path(session_id, reference_artifact_stem)
    }

    pub(crate) fn compression_transcripts_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> PathBuf {
        self.session_layout(workspace_path)
            .compression_transcripts_dir(session_id)
    }

    #[cfg(test)]
    fn index_path(&self, workspace_path: &Path) -> PathBuf {
        self.session_layout(workspace_path).index_path()
    }

    fn session_layout(&self, workspace_path: &Path) -> SessionStorageLayout {
        SessionStorageLayout::new(self.project_sessions_dir(workspace_path))
    }

    pub(crate) fn session_storage_exists(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        Self::validate_session_id(session_id)?;
        Ok(self
            .session_layout(workspace_path)
            .session_dir(session_id)
            .exists())
    }

    fn session_metadata_store(&self, workspace_path: &Path) -> SessionMetadataStore {
        SessionMetadataStore::new(self.project_sessions_dir(workspace_path))
    }

    fn existing_project_sessions_dir(&self, workspace_path: &Path) -> Option<PathBuf> {
        let dir = self.project_sessions_dir(workspace_path);
        dir.exists().then_some(dir)
    }

    async fn ensure_runtime_for_write(&self, workspace_path: &Path) -> OpenBitFunResult<()> {
        if self.is_resolved_sessions_dir(workspace_path) {
            return Ok(());
        }

        self.runtime_service
            .ensure_local_workspace_runtime(workspace_path)
            .await
            .map(|_| ())
    }

    async fn ensure_session_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        self.session_layout(workspace_path)
            .ensure_session_dir(session_id)
            .await
            .map_err(|e| OpenBitFunError::io(format!("Failed to create session directory: {}", e)))
    }

    async fn ensure_turns_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        self.session_layout(workspace_path)
            .ensure_turns_dir(session_id)
            .await
            .map_err(|e| OpenBitFunError::io(format!("Failed to create turns directory: {}", e)))
    }

    async fn ensure_snapshots_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        self.session_layout(workspace_path)
            .ensure_snapshots_dir(session_id)
            .await
            .map_err(|e| {
                OpenBitFunError::io(format!("Failed to create snapshots directory: {}", e))
            })
    }

    async fn ensure_artifacts_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        self.session_layout(workspace_path)
            .ensure_artifacts_dir(session_id)
            .await
            .map_err(|e| {
                OpenBitFunError::io(format!("Failed to create artifacts directory: {}", e))
            })
    }

    async fn ensure_session_references_dir(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        self.session_layout(workspace_path)
            .ensure_session_references_dir(session_id)
            .await
            .map_err(|e| {
                OpenBitFunError::io(format!(
                    "Failed to create session reference directory: {}",
                    e
                ))
            })
    }

    async fn read_json_optional<T: DeserializeOwned>(
        &self,
        path: &Path,
    ) -> OpenBitFunResult<Option<T>> {
        JsonFileStore
            .read_optional(path)
            .await
            .map_err(Self::json_store_error)
    }

    async fn write_json_atomic<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
    ) -> OpenBitFunResult<()> {
        JsonFileStore
            .write_atomic(path, value)
            .await
            .map_err(Self::json_store_error)
    }

    async fn write_text_atomic(&self, path: &Path, text: &str) -> OpenBitFunResult<()> {
        JsonFileStore
            .write_text_atomic(path, text)
            .await
            .map_err(Self::json_store_error)
    }

    async fn get_session_persistence_lock(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> Arc<Mutex<()>> {
        let session_path = self.session_layout(workspace_path).session_dir(session_id);
        let session_path = dunce::canonicalize(&session_path).unwrap_or_else(|_| {
            session_path
                .parent()
                .and_then(|parent| dunce::canonicalize(parent).ok())
                .and_then(|parent| session_path.file_name().map(|name| parent.join(name)))
                .unwrap_or(session_path)
        });
        let registry = SESSION_PERSISTENCE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut registry_guard = registry.lock().await;
        registry_guard.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = registry_guard.get(&session_path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        registry_guard.insert(session_path, Arc::downgrade(&lock));
        lock
    }

    pub(super) async fn get_session_branch_allocation_lock(
        &self,
        workspace_path: &Path,
    ) -> Arc<Mutex<()>> {
        let registry = SESSION_BRANCH_ALLOCATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut registry_guard = registry.lock().await;
        registry_guard
            .entry(workspace_path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn json_store_error(error: JsonFileStoreError) -> OpenBitFunError {
        if error.is_deserialization() {
            OpenBitFunError::Deserialization(error.to_string())
        } else if error.is_serialization() {
            OpenBitFunError::serialization(error.to_string())
        } else {
            OpenBitFunError::io(error.to_string())
        }
    }

    fn session_metadata_store_error(error: SessionMetadataStoreError) -> OpenBitFunError {
        if error.is_deserialization() {
            OpenBitFunError::Deserialization(error.to_string())
        } else if error.is_serialization() {
            OpenBitFunError::serialization(error.to_string())
        } else {
            OpenBitFunError::io(error.to_string())
        }
    }

    fn system_time_to_unix_ms(time: SystemTime) -> u64 {
        time.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn unix_ms_to_system_time(timestamp_ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(timestamp_ms)
    }

    fn sanitize_messages_for_persistence(messages: &[Message]) -> Vec<Cow<'_, Message>> {
        messages
            .iter()
            .map(Self::sanitize_message_for_persistence)
            .collect()
    }

    /// Returns whether a message would be modified by
    /// [`Self::sanitize_message_for_persistence`]. Used to avoid deep-cloning
    /// messages that need no sanitization (the vast majority).
    fn message_needs_persistence_sanitization(message: &Message) -> bool {
        match &message.content {
            MessageContent::Multimodal { images, .. } => images
                .iter()
                .any(|image| image.data_url.as_ref().is_some_and(|v| !v.is_empty())),
            MessageContent::ToolResult {
                result,
                image_attachments,
                ..
            } => image_attachments.is_some() || Self::json_contains_data_url(result),
            _ => false,
        }
    }

    fn json_contains_data_url(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(map) => {
                map.contains_key("data_url") || map.values().any(Self::json_contains_data_url)
            }
            serde_json::Value::Array(arr) => arr.iter().any(Self::json_contains_data_url),
            _ => false,
        }
    }

    fn sanitize_message_for_persistence(message: &Message) -> Cow<'_, Message> {
        if !Self::message_needs_persistence_sanitization(message) {
            return Cow::Borrowed(message);
        }

        let mut sanitized = message.clone();

        match &mut sanitized.content {
            MessageContent::Multimodal { images, .. } => {
                for image in images.iter_mut() {
                    if image.data_url.as_ref().is_some_and(|v| !v.is_empty()) {
                        image.data_url = None;

                        let mut metadata = image
                            .metadata
                            .take()
                            .unwrap_or_else(|| serde_json::json!({}));
                        if !metadata.is_object() {
                            metadata = serde_json::json!({ "raw_metadata": metadata });
                        }
                        if let Some(obj) = metadata.as_object_mut() {
                            obj.insert("has_data_url".to_string(), serde_json::json!(true));
                        }
                        image.metadata = Some(metadata);
                    }
                }
            }
            MessageContent::ToolResult {
                result,
                image_attachments,
                ..
            } => {
                Self::redact_data_url_in_json(result);
                if image_attachments.is_some() {
                    *image_attachments = None;
                }
            }
            _ => {}
        }

        Cow::Owned(sanitized)
    }

    fn redact_data_url_in_json(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                let had_data_url = map.remove("data_url").is_some();
                if had_data_url {
                    map.insert("has_data_url".to_string(), serde_json::json!(true));
                }
                for child in map.values_mut() {
                    Self::redact_data_url_in_json(child);
                }
            }
            serde_json::Value::Array(arr) => {
                for child in arr {
                    Self::redact_data_url_in_json(child);
                }
            }
            _ => {}
        }
    }

    async fn build_session_metadata(
        &self,
        workspace_path: &Path,
        session: &Session,
        existing: Option<&SessionMetadata>,
    ) -> SessionMetadata {
        let last_active_at = Self::system_time_to_unix_ms(session.last_activity_at);

        let resolved_identity = if let Some(id) = session.config.workspace_id.as_deref() {
            crate::agentic::WorkspaceBinding::resolve(id)
                .await
                .ok()
                .map(|binding| binding.session_identity)
        } else if let Some(workspace_root) = session.config.workspace_path.as_deref() {
            resolve_workspace_session_identity(
                workspace_root,
                session.config.remote_connection_id.as_deref(),
                session.config.remote_ssh_host.as_deref(),
            )
            .await
        } else {
            None
        };

        let workspace_root = resolved_identity
            .as_ref()
            .map(|identity| identity.logical_workspace_path().to_string())
            .or_else(|| session.config.workspace_path.clone())
            .or_else(|| existing.and_then(|value| value.workspace_path.clone()))
            .unwrap_or_else(|| workspace_path.to_string_lossy().to_string());
        let workspace_hostname = resolved_identity
            .as_ref()
            .map(|identity| identity.hostname.clone())
            .or_else(|| existing.and_then(|value| value.workspace_hostname.clone()))
            .or_else(|| {
                if session.config.is_remote_workspace() {
                    session.config.remote_ssh_host.clone()
                } else {
                    Some(LOCAL_WORKSPACE_SSH_HOST.to_string())
                }
            });

        build_persisted_session_metadata(SessionMetadataBuildFacts {
            workspace_id: session.config.workspace_id.as_deref(),
            project_workspace_id: session.config.project_workspace_id.as_deref(),
            session_id: &session.session_id,
            session_name: &session.session_name,
            agent_type: &session.agent_type,
            last_user_dialog_agent_type: session.last_user_dialog_agent_type.as_deref(),
            last_submitted_agent_type: session.last_submitted_agent_type.as_deref(),
            created_by: session.created_by.as_deref(),
            session_kind: session.kind,
            model_name: session.config.model_id.as_deref(),
            created_at_ms: Self::system_time_to_unix_ms(session.created_at),
            last_active_at_ms: last_active_at,
            turn_count: session.dialog_turn_ids.len(),
            snapshot_session_id: session.snapshot_session_id.as_deref(),
            workspace_path: &workspace_root,
            project_workspace_path: session.config.project_workspace_path.as_deref(),
            execution_target: session.config.execution_target.as_ref(),
            workspace_hostname: workspace_hostname.as_deref(),
            new_session_memory_mode: new_session_memory_mode_from_global_config().await,
            existing,
        })
    }

    fn parse_transcript_turn_selectors(
        selectors: &[String],
    ) -> OpenBitFunResult<Vec<ParsedTranscriptTurnSelector>> {
        if selectors.is_empty() {
            return Err(OpenBitFunError::Validation(
                "turns cannot be an empty array".to_string(),
            ));
        }

        selectors
            .iter()
            .map(|selector| Self::parse_transcript_turn_selector(selector))
            .collect()
    }

    fn parse_transcript_turn_selector(
        selector: &str,
    ) -> OpenBitFunResult<ParsedTranscriptTurnSelector> {
        let normalized = selector.trim();
        if normalized.is_empty() {
            return Err(OpenBitFunError::Validation(
                "turns cannot contain empty selectors".to_string(),
            ));
        }

        if normalized.matches(':').count() > 1 {
            return Err(OpenBitFunError::Validation(format!(
                "Invalid turn selector '{}'. Use forms like ':20', '-20:', '10:30', or '15'.",
                normalized
            )));
        }

        let selector = if let Some((start, end)) = normalized.split_once(':') {
            TranscriptTurnSelector::Slice {
                start: if start.is_empty() {
                    None
                } else {
                    Some(Self::parse_transcript_turn_value(start, normalized)?)
                },
                end: if end.is_empty() {
                    None
                } else {
                    Some(Self::parse_transcript_turn_value(end, normalized)?)
                },
            }
        } else {
            TranscriptTurnSelector::Index(Self::parse_transcript_turn_value(
                normalized, normalized,
            )?)
        };

        Ok(ParsedTranscriptTurnSelector {
            normalized: normalized.to_string(),
            selector,
        })
    }

    fn parse_transcript_turn_value(value: &str, selector: &str) -> OpenBitFunResult<isize> {
        value.parse::<isize>().map_err(|_| {
            OpenBitFunError::Validation(format!(
                "Invalid turn selector '{}'. Use forms like ':20', '-20:', '10:30', or '15'.",
                selector
            ))
        })
    }

    fn transcript_normalize_slice_bound(
        total: usize,
        bound: Option<isize>,
        default: usize,
    ) -> usize {
        let Some(bound) = bound else {
            return default;
        };

        let total = total as isize;
        let normalized = if bound < 0 {
            total.saturating_add(bound)
        } else {
            bound
        };
        normalized.clamp(0, total) as usize
    }

    fn transcript_normalize_index(total: usize, index: isize) -> Option<usize> {
        let total = total as isize;
        let normalized = if index < 0 {
            total.saturating_add(index)
        } else {
            index
        };

        if normalized < 0 || normalized >= total {
            None
        } else {
            Some(normalized as usize)
        }
    }

    fn transcript_select_turn_indices(
        total: usize,
        selectors: &[ParsedTranscriptTurnSelector],
    ) -> Vec<usize> {
        let mut selected = vec![false; total];

        for selector in selectors {
            match selector.selector {
                TranscriptTurnSelector::Index(index) => {
                    if let Some(index) = Self::transcript_normalize_index(total, index) {
                        selected[index] = true;
                    }
                }
                TranscriptTurnSelector::Slice { start, end } => {
                    let start = Self::transcript_normalize_slice_bound(total, start, 0);
                    let end = Self::transcript_normalize_slice_bound(total, end, total);
                    if start < end {
                        selected[start..end].fill(true);
                    }
                }
            }
        }

        selected
            .into_iter()
            .enumerate()
            .filter_map(|(index, is_selected)| is_selected.then_some(index))
            .collect()
    }

    pub async fn list_session_metadata(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Vec<SessionMetadata>> {
        if !workspace_path.exists() {
            return Ok(Vec::new());
        }

        if self.existing_project_sessions_dir(workspace_path).is_none() {
            return Ok(Vec::new());
        }

        self.session_metadata_store(workspace_path)
            .list_metadata()
            .await
            .map_err(Self::session_metadata_store_error)
    }

    pub async fn session_metadata_by_ids(
        &self,
        workspace_path: &Path,
        session_ids: &[String],
    ) -> OpenBitFunResult<Vec<SessionMetadata>> {
        self.session_metadata_store(workspace_path)
            .metadata_by_ids(session_ids)
            .await
            .map_err(Self::session_metadata_store_error)
    }

    /// Lazily repair one legacy activity summary on a targeted navigation read.
    /// Current metadata and empty Sessions remain index-only. The caller keeps
    /// initial list reads fast and does not call this for executing Sessions.
    pub(crate) async fn backfill_session_last_turn(
        &self,
        workspace_path: &Path,
        metadata: SessionMetadata,
    ) -> OpenBitFunResult<SessionMetadata> {
        if !metadata.needs_last_turn_backfill() {
            return Ok(metadata);
        }
        Self::validate_session_id(&metadata.session_id)?;
        let _slot = SESSION_ACTIVITY_REPAIR_SLOTS
            .acquire()
            .await
            .expect("activity repair semaphore remains open");
        let _session_write =
            self.lock_session_write_operation(workspace_path, &metadata.session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &metadata.session_id)
            .await;
        let _guard = persistence_lock.lock().await;
        // Re-read under the existing writer locks. A newer Turn, receipt,
        // rename or deletion must win over the list snapshot supplied above.
        let mut current = self
            .load_session_metadata(workspace_path, &metadata.session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session metadata not found: {}",
                    metadata.session_id
                ))
            })?;
        if !current.needs_last_turn_backfill() {
            return Ok(current);
        }
        let boundary = self
            .load_session_revert_state(workspace_path, &current.session_id)
            .await?
            .map(|state| state.boundary_turn);
        // Enumerate filenames once, then read backwards only until the latest
        // user Turn is found. Gaps and trailing maintenance Turns are legal.
        let paths = self
            .list_indexed_turn_paths(workspace_path, &current.session_id)
            .await?;
        if paths.is_empty() {
            return Err(OpenBitFunError::NotFound(format!(
                "Session activity history is missing: {}",
                current.session_id
            )));
        }
        for (index, path) in paths.into_iter().rev() {
            if boundary.is_some_and(|boundary| index >= boundary) {
                continue;
            }
            let turn = self
                .read_json_optional::<StoredTurnActivity>(&path)
                .await?
                .ok_or_else(|| {
                    OpenBitFunError::NotFound(format!(
                        "Session activity Turn is missing: {}",
                        path.display()
                    ))
                })?;
            if turn.session_id != current.session_id || turn.turn_index != index {
                return Err(OpenBitFunError::Validation(format!(
                    "Session activity Turn identity mismatch: {}",
                    path.display()
                )));
            }
            if turn.kind != DialogTurnKind::UserDialog {
                continue;
            }
            current.last_turn = Some(SessionLastTurn {
                turn_id: turn.turn_id,
                turn_index: turn.turn_index,
                status: turn.status.clone(),
                end_time: turn.end_time,
                execution_generation: turn.recovery_epoch.or_else(||
                    turn.recovery.as_ref().map(|recovery| recovery.execution_generation)),
                recovery_pending: Some(turn.status == TurnStatus::Cancelled
                    && turn.finish_reason.as_deref() == Some("interrupted")
                    && turn.recovery.as_ref().is_some_and(|recovery|
                        recovery.status == openbitfun_services_core::session::DialogTurnRecoveryStatus::Interrupted)),
            });
            // Repair outcome only. Inferring a read receipt from old history
            // would revive notifications the user has already acknowledged.
            // A staged revert is a temporary view: never persist its outcome
            // over the physical history that redo may expose again.
            if boundary.is_none() {
                self.session_metadata_store(workspace_path)
                    .save_metadata(&current)
                    .await
                    .map_err(Self::session_metadata_store_error)?;
            }
            return Ok(current);
        }
        Ok(current)
    }

    pub async fn list_session_metadata_page(
        &self,
        workspace_path: &Path,
        cursor: Option<&str>,
        limit: usize,
    ) -> OpenBitFunResult<SessionMetadataPage> {
        if !workspace_path.exists() {
            return Ok(empty_session_metadata_page());
        }

        if self.existing_project_sessions_dir(workspace_path).is_none() {
            return Ok(empty_session_metadata_page());
        }

        self.session_metadata_store(workspace_path)
            .list_metadata_page(cursor, limit)
            .await
            .map_err(Self::session_metadata_store_error)
    }

    pub async fn list_session_metadata_including_internal(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Vec<SessionMetadata>> {
        if !workspace_path.exists() {
            return Ok(Vec::new());
        }

        if self.existing_project_sessions_dir(workspace_path).is_none() {
            return Ok(Vec::new());
        }

        self.session_metadata_store(workspace_path)
            .list_metadata_including_internal()
            .await
            .map_err(Self::session_metadata_store_error)
    }

    pub async fn save_session_metadata(
        &self,
        workspace_path: &Path,
        metadata: &SessionMetadata,
    ) -> OpenBitFunResult<()> {
        let _session_write =
            self.lock_session_write_operation(workspace_path, &metadata.session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &metadata.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        self.save_session_metadata_locked(workspace_path, metadata)
            .await
    }

    async fn save_session_metadata_locked(
        &self,
        workspace_path: &Path,
        metadata: &SessionMetadata,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(&metadata.session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        #[cfg(test)]
        {
            let mut fault = self
                .fail_next_session_metadata_write
                .lock()
                .expect("session metadata fault lock");
            if fault.as_deref() == Some(metadata.session_id.as_str()) {
                *fault = None;
                return Err(OpenBitFunError::io(
                    "Injected session metadata write failure",
                ));
            }
        }
        self.session_metadata_store(workspace_path)
            .save_metadata(metadata)
            .await
            .map_err(Self::session_metadata_store_error)
    }

    pub async fn create_session_metadata_if_absent(
        &self,
        workspace_path: &Path,
        metadata: &SessionMetadata,
    ) -> OpenBitFunResult<bool> {
        Self::validate_session_id(&metadata.session_id)?;
        let _session_write =
            self.lock_session_write_operation(workspace_path, &metadata.session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &metadata.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        if self
            .load_session_metadata(workspace_path, &metadata.session_id)
            .await?
            .is_some()
        {
            return Ok(false);
        }
        self.save_session_metadata_locked(workspace_path, metadata)
            .await?;
        Ok(true)
    }

    pub async fn update_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata),
    ) -> OpenBitFunResult<()> {
        let updated = self
            .update_session_metadata_if_present(workspace_path, session_id, |metadata| {
                update(metadata);
                Ok(())
            })
            .await?;
        if updated {
            Ok(())
        } else {
            Err(OpenBitFunError::NotFound(format!(
                "Session metadata not found: {}",
                session_id
            )))
        }
    }

    pub async fn update_session_title_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
        session_name: &str,
        last_active_at: u64,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let original = self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session metadata not found: {session_id}"))
            })?;
        let mut updated = original.clone();
        updated.session_name = session_name.to_string();
        updated.last_active_at = last_active_at;

        let Err(write_error) = self
            .save_session_metadata_locked(workspace_path, &updated)
            .await
        else {
            return Ok(());
        };
        if self
            .load_session_metadata(workspace_path, session_id)
            .await
            .is_ok_and(|metadata| {
                metadata.is_some_and(|metadata| {
                    metadata.session_name == original.session_name
                        && metadata.last_active_at == original.last_active_at
                })
            })
        {
            return Err(write_error);
        }

        #[cfg(test)]
        let skip_rollback = {
            let mut fault = self
                .fail_next_session_metadata_rollback
                .lock()
                .expect("session metadata rollback fault lock");
            if fault.as_deref() == Some(session_id) {
                *fault = None;
                true
            } else {
                false
            }
        };
        #[cfg(not(test))]
        let skip_rollback = false;

        let rollback_error = if skip_rollback {
            Some(OpenBitFunError::io(
                "Injected session metadata rollback failure",
            ))
        } else {
            self.save_session_metadata_locked(workspace_path, &original)
                .await
                .err()
        };
        if self
            .load_session_metadata(workspace_path, session_id)
            .await
            .is_ok_and(|metadata| {
                metadata.is_some_and(|metadata| {
                    metadata.session_name == original.session_name
                        && metadata.last_active_at == original.last_active_at
                })
            })
        {
            return Err(write_error);
        }

        Err(OpenBitFunError::OutcomeUnknown(format!(
            "Session title persistence failed and rollback did not restore the previous metadata: session_id={session_id}, error={write_error}, rollback_error={}",
            rollback_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "none".to_string())
        )))
    }

    pub async fn update_session_metadata_if_present(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata) -> OpenBitFunResult<()>,
    ) -> OpenBitFunResult<bool> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        self.update_session_metadata_if_present_locked(workspace_path, session_id, update)
            .await
    }

    async fn update_session_metadata_if_present_locked(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata) -> OpenBitFunResult<()>,
    ) -> OpenBitFunResult<bool> {
        let Some(mut metadata) = self
            .load_session_metadata(workspace_path, session_id)
            .await?
        else {
            return Ok(false);
        };
        update(&mut metadata)?;
        self.save_session_metadata_locked(workspace_path, &metadata)
            .await?;
        Ok(true)
    }

    pub async fn set_session_memory_mode(
        &self,
        workspace_path: &Path,
        session_id: &str,
        mode: SessionMemoryMode,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let mut metadata = self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session metadata not found: {}", session_id))
            })?;
        metadata.memory_mode = mode;
        self.save_session_metadata_locked(workspace_path, &metadata)
            .await
    }

    pub async fn mark_session_memory_mode_polluted(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let mut metadata = self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session metadata not found: {}", session_id))
            })?;
        let should_enqueue_phase2 = matches!(
            metadata.memory_mode,
            SessionMemoryMode::Enabled | SessionMemoryMode::Polluted
        );
        if metadata.memory_mode == SessionMemoryMode::Enabled {
            metadata.memory_mode = SessionMemoryMode::Polluted;
            self.save_session_metadata_locked(workspace_path, &metadata)
                .await?;
        }
        if should_enqueue_phase2 {
            self.enqueue_phase2_if_session_selected(session_id, current_unix_secs())
                .await?;
        }
        Ok(())
    }

    async fn enqueue_phase2_if_session_selected(
        &self,
        session_id: &str,
        input_watermark: i64,
    ) -> OpenBitFunResult<()> {
        let db = MemoryDatabase::new(self.path_manager.clone());
        db.initialize().await?;
        if db.phase2_selected_for_session(session_id).await? {
            db.enqueue_phase2_job(MEMORY_PHASE2_GLOBAL_JOB_KEY, input_watermark)
                .await?;
        }
        Ok(())
    }

    pub async fn load_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionMetadata>> {
        Self::validate_session_id(session_id)?;
        self.session_metadata_store(workspace_path)
            .load_metadata(session_id)
            .await
            .map_err(Self::session_metadata_store_error)
    }

    async fn load_stored_session_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<StoredSessionStateFile>> {
        self.read_json_optional::<StoredSessionStateFile>(
            &self.state_path(workspace_path, session_id),
        )
        .await
    }

    async fn save_stored_session_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
        state: &StoredSessionStateFile,
    ) -> OpenBitFunResult<()> {
        #[cfg(test)]
        {
            let mut fault = self
                .fail_next_session_state_write
                .lock()
                .expect("session state fault lock");
            if fault.as_deref() == Some(session_id) {
                *fault = None;
                return Err(OpenBitFunError::io("Injected session state write failure"));
            }
        }
        self.write_json_atomic(&self.state_path(workspace_path, session_id), state)
            .await
    }

    pub(crate) async fn load_evidence_ledger_events(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<EvidenceLedgerEvent>> {
        Self::validate_session_id(session_id)?;
        let path = self.evidence_ledger_path(workspace_path, session_id);
        let file = JsonFileStore
            .read_locked_optional::<PersistedEvidenceLedgerFile>(&path)
            .await
            .map_err(Self::json_store_error)?;
        file.map(|file| {
            file.validated_events(session_id)
                .map_err(|error| OpenBitFunError::parse(error.to_string()))
        })
        .transpose()
        .map(Option::unwrap_or_default)
    }

    pub(crate) async fn append_evidence_ledger_event(
        &self,
        workspace_path: &Path,
        event: &EvidenceLedgerEvent,
    ) -> OpenBitFunResult<Vec<EvidenceLedgerEvent>> {
        Self::validate_session_id(&event.session_id)?;
        let _session_write =
            self.lock_session_write_operation(workspace_path, &event.session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &event.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        self.ensure_session_dir(workspace_path, &event.session_id)
            .await?;

        #[cfg(test)]
        {
            let mut fault = self
                .fail_next_evidence_ledger_write
                .lock()
                .expect("evidence ledger fault lock");
            if fault.as_deref() == Some(event.session_id.as_str()) {
                *fault = None;
                return Err(OpenBitFunError::io(
                    "Injected evidence ledger write failure",
                ));
            }
        }

        let path = self.evidence_ledger_path(workspace_path, &event.session_id);
        let _file_lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(Self::json_store_error)?;
        let mut file = JsonFileStore
            .read_optional::<PersistedEvidenceLedgerFile>(&path)
            .await
            .map_err(Self::json_store_error)?
            .unwrap_or_else(|| PersistedEvidenceLedgerFile::new(event.session_id.clone()));
        file.append(event.clone())
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
        file.schema_version = EVIDENCE_LEDGER_SCHEMA_VERSION;
        JsonFileStore
            .write_atomic_strict(&path, &file)
            .await
            .map_err(Self::json_store_error)?;
        file.validated_events(&event.session_id)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))
    }

    pub(crate) async fn retain_evidence_ledger_events(
        &self,
        workspace_path: &Path,
        session_id: &str,
        surviving_turn_ids: &std::collections::HashSet<String>,
    ) -> OpenBitFunResult<Option<Vec<EvidenceLedgerEvent>>> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;

        let path = self.evidence_ledger_path(workspace_path, session_id);
        let _file_lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(Self::json_store_error)?;
        if !path.exists() {
            return Ok(None);
        }
        let Some(mut file) = JsonFileStore
            .read_optional::<PersistedEvidenceLedgerFile>(&path)
            .await
            .map_err(Self::json_store_error)?
        else {
            return Err(OpenBitFunError::io(format!(
                "Evidence ledger disappeared while retaining: {}",
                path.display()
            )));
        };
        let retained = file
            .retain_turn_ids(session_id, surviving_turn_ids)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
        file.schema_version = EVIDENCE_LEDGER_SCHEMA_VERSION;
        JsonFileStore
            .write_atomic_strict(&path, &file)
            .await
            .map_err(Self::json_store_error)?;
        Ok(Some(retained))
    }

    /// Write a complete evidence ledger sidecar for a session. Used by session
    /// branching to copy inherited evidence into the fork target. The caller
    /// must already hold the session write lock for `session_id`.
    pub(crate) async fn save_evidence_ledger_events(
        &self,
        workspace_path: &Path,
        session_id: &str,
        events: Vec<EvidenceLedgerEvent>,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        self.ensure_session_dir(workspace_path, session_id).await?;
        let path = self.evidence_ledger_path(workspace_path, session_id);
        let _file_lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(Self::json_store_error)?;
        let file = PersistedEvidenceLedgerFile {
            schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            events,
        };
        // Validate before writing so a bad session_id on an event is caught.
        file.clone()
            .validated_events(session_id)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
        JsonFileStore
            .write_atomic_strict(&path, &file)
            .await
            .map_err(Self::json_store_error)?;
        Ok(())
    }

    pub async fn load_prompt_cache(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionPromptCache>> {
        Self::validate_session_id(session_id)?;
        Ok(self
            .read_json_optional::<StoredSessionPromptCacheFile>(
                &self.prompt_cache_path(workspace_path, session_id),
            )
            .await?
            .map(|file| file.cache))
    }

    pub async fn save_prompt_cache(
        &self,
        workspace_path: &Path,
        session_id: &str,
        cache: &SessionPromptCache,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_session_dir(workspace_path, session_id).await?;

        self.write_json_atomic(
            &self.prompt_cache_path(workspace_path, session_id),
            &StoredSessionPromptCacheFile {
                schema_version: PROMPT_CACHE_SCHEMA_VERSION,
                cache: cache.clone(),
            },
        )
        .await
    }

    pub async fn delete_prompt_cache(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        match fs::remove_file(self.prompt_cache_path(workspace_path, session_id)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(OpenBitFunError::io(format!(
                "Failed to delete prompt cache for session {}: {}",
                session_id, error
            ))),
        }
    }

    pub(crate) async fn load_session_revert_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionRevertState>> {
        Self::validate_session_id(session_id)?;
        let state = self
            .read_json_optional::<SessionRevertState>(
                &self.session_revert_path(workspace_path, session_id),
            )
            .await?;
        if let Some(state) = state.as_ref() {
            if state.schema_version != SESSION_REVERT_SCHEMA_VERSION {
                return Err(OpenBitFunError::Deserialization(format!(
                    "Unsupported Session revert schema version: session_id={}, version={}",
                    session_id, state.schema_version
                )));
            }
        }
        Ok(state)
    }

    pub(crate) async fn save_session_revert_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
        state: &SessionRevertState,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_session_dir(workspace_path, session_id).await?;
        self.write_json_atomic(&self.session_revert_path(workspace_path, session_id), state)
            .await
    }

    pub(crate) async fn delete_session_revert_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        match fs::remove_file(self.session_revert_path(workspace_path, session_id)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(OpenBitFunError::io(format!(
                "Failed to delete staged Session revert for {}: {}",
                session_id, error
            ))),
        }
    }

    pub async fn load_token_anchors(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<Vec<TokenAnchor>>> {
        Self::validate_session_id(session_id)?;
        Ok(self
            .read_json_optional::<StoredTokenAnchorsFile>(
                &self.token_anchors_path(workspace_path, session_id),
            )
            .await?
            .map(|file| file.anchors))
    }

    pub async fn save_token_anchors(
        &self,
        workspace_path: &Path,
        session_id: &str,
        anchors: &[TokenAnchor],
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_session_dir(workspace_path, session_id).await?;

        self.write_json_atomic(
            &self.token_anchors_path(workspace_path, session_id),
            &StoredTokenAnchorsFile {
                schema_version: TOKEN_ANCHOR_SCHEMA_VERSION,
                session_id: session_id.to_string(),
                anchors: anchors.to_vec(),
            },
        )
        .await
    }

    pub async fn delete_token_anchors(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        match fs::remove_file(self.token_anchors_path(workspace_path, session_id)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(OpenBitFunError::io(format!(
                "Failed to delete token anchors for session {}: {}",
                session_id, error
            ))),
        }
    }

    // ============ Turn context snapshot (sent to model)============

    pub async fn save_turn_context_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
        messages: &[Message],
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_snapshots_dir(workspace_path, session_id)
            .await?;

        let snapshot = TurnContextSnapshotWriteFile {
            schema_version: SESSION_STORAGE_SCHEMA_VERSION,
            session_id,
            turn_index,
            messages: Self::sanitize_messages_for_persistence(messages),
        };

        self.write_json_atomic(
            &self.context_snapshot_path(workspace_path, session_id, turn_index),
            &snapshot,
        )
        .await
    }

    pub async fn load_turn_context_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<Option<Vec<Message>>> {
        Self::validate_session_id(session_id)?;
        let snapshot = self
            .read_json_optional::<StoredTurnContextSnapshotFile>(&self.context_snapshot_path(
                workspace_path,
                session_id,
                turn_index,
            ))
            .await?;
        Ok(snapshot.map(|value| value.messages))
    }

    pub async fn load_latest_turn_context_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<(usize, Vec<Message>)>> {
        self.load_latest_turn_context_snapshot_before(workspace_path, session_id, usize::MAX)
            .await
    }

    pub(crate) async fn load_latest_turn_context_snapshot_before(
        &self,
        workspace_path: &Path,
        session_id: &str,
        exclusive_turn_index: usize,
    ) -> OpenBitFunResult<Option<(usize, Vec<Message>)>> {
        Self::validate_session_id(session_id)?;
        let started_at = Instant::now();
        let dir = self.snapshots_dir(workspace_path, session_id);
        if !dir.exists() {
            return Ok(None);
        }

        let scan_started_at = Instant::now();
        let mut latest: Option<usize> = None;
        let mut snapshot_file_count = 0usize;
        let mut rd = fs::read_dir(&dir).await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to read snapshots directory: {}", e))
        })?;

        while let Some(entry) = rd.next_entry().await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to iterate snapshots directory: {}", e))
        })? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(index_str) = stem.strip_prefix("context-") else {
                continue;
            };
            if let Ok(index) = index_str.parse::<usize>() {
                snapshot_file_count += 1;
                if index < exclusive_turn_index {
                    latest = Some(latest.map(|value| value.max(index)).unwrap_or(index));
                }
            }
        }
        let scan_duration = scan_started_at.elapsed();

        let Some(turn_index) = latest else {
            return Ok(None);
        };

        let load_started_at = Instant::now();
        let Some(messages) = self
            .load_turn_context_snapshot(workspace_path, session_id, turn_index)
            .await?
        else {
            return Ok(None);
        };
        let load_duration = load_started_at.elapsed();
        let total_duration = started_at.elapsed();

        if total_duration >= Duration::from_millis(80) || snapshot_file_count >= 10 {
            let payload_stats = context_snapshot_payload_stats(&messages);
            debug!(
                "Loaded latest context snapshot: session_id={} turn_index={} snapshot_file_count={} scan_duration_ms={} load_duration_ms={} total_duration_ms={} message_count={} tool_result_count={} raw_result_string_chars={} result_for_assistant_chars={} largest_raw_result_chars={} largest_raw_result_path={}",
                session_id,
                turn_index,
                snapshot_file_count,
                scan_duration.as_millis(),
                load_duration.as_millis(),
                total_duration.as_millis(),
                messages.len(),
                payload_stats.tool_result_count,
                payload_stats.raw_result_string_chars,
                payload_stats.result_for_assistant_chars,
                payload_stats.largest_raw_result_chars,
                payload_stats.largest_raw_result_path
            );
        }

        Ok(Some((turn_index, messages)))
    }

    pub async fn save_turn_skill_agent_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
        snapshot: &TurnSkillAgentSnapshot,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_snapshots_dir(workspace_path, session_id)
            .await?;

        self.write_json_atomic(
            &self.skill_agent_snapshot_path(workspace_path, session_id, turn_index),
            &StoredTurnSkillAgentSnapshotFile {
                schema_version: SESSION_STORAGE_SCHEMA_VERSION,
                session_id: session_id.to_string(),
                turn_index,
                snapshot: snapshot.clone(),
            },
        )
        .await
    }

    pub async fn load_turn_skill_agent_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<Option<TurnSkillAgentSnapshot>> {
        Self::validate_session_id(session_id)?;
        let stored = self
            .read_json_optional::<StoredTurnSkillAgentSnapshotFile>(
                &self.skill_agent_snapshot_path(workspace_path, session_id, turn_index),
            )
            .await?;
        Ok(stored.map(|value| value.snapshot))
    }

    pub async fn delete_turn_skill_agent_snapshots_from(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let dir = self.snapshots_dir(workspace_path, session_id);
        if !dir.exists() {
            return Ok(());
        }

        let mut rd = fs::read_dir(&dir).await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to read snapshots directory: {}", e))
        })?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to iterate snapshots directory: {}", e))
        })? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(index_str) = stem.strip_prefix("skill-agent-") else {
                continue;
            };
            let Ok(index) = index_str.parse::<usize>() else {
                continue;
            };
            if index >= turn_index {
                let _ = fs::remove_file(&path).await;
            }
        }

        Ok(())
    }

    pub async fn save_skill_agent_baseline_override_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
        snapshot: &TurnSkillAgentSnapshot,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        self.ensure_snapshots_dir(workspace_path, session_id)
            .await?;

        self.write_json_atomic(
            &self.skill_agent_baseline_override_path(workspace_path, session_id),
            &StoredSkillAgentBaselineOverrideFile {
                schema_version: SESSION_STORAGE_SCHEMA_VERSION,
                session_id: session_id.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .await
    }

    pub async fn load_skill_agent_baseline_override_snapshot(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<TurnSkillAgentSnapshot>> {
        Self::validate_session_id(session_id)?;
        let stored = self
            .read_json_optional::<StoredSkillAgentBaselineOverrideFile>(
                &self.skill_agent_baseline_override_path(workspace_path, session_id),
            )
            .await?;
        Ok(stored.map(|value| value.snapshot))
    }

    pub async fn delete_turn_context_snapshots_from(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let dir = self.snapshots_dir(workspace_path, session_id);
        if !dir.exists() {
            return Ok(());
        }

        let mut rd = fs::read_dir(&dir).await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to read snapshots directory: {}", e))
        })?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| {
            OpenBitFunError::io(format!("Failed to iterate snapshots directory: {}", e))
        })? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let index_str = if let Some(index) = stem.strip_prefix("context-") {
                index
            } else if let Some(index) = stem.strip_prefix("skill-agent-") {
                index
            } else {
                continue;
            };
            let Ok(index) = index_str.parse::<usize>() else {
                continue;
            };
            if index >= turn_index {
                let _ = fs::remove_file(&path).await;
            }
        }

        Ok(())
    }

    // ============ Session Persistence ============

    /// Persist a newly created session without overwriting an existing session ID.
    ///
    /// The final session directory is created exclusively so this manager owns any
    /// cleanup required by a failed first write. This also prevents a losing
    /// creator in another runtime or process from deleting the winning session.
    pub(crate) async fn create_session_if_absent(
        &self,
        workspace_path: &Path,
        session: &Session,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(&session.session_id)?;
        let _session_write =
            self.lock_session_write_operation(workspace_path, &session.session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;

        let sessions_dir = self.project_sessions_dir(workspace_path);
        fs::create_dir_all(&sessions_dir).await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to create sessions directory {}: {}",
                sessions_dir.display(),
                error
            ))
        })?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &session.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let session_dir = self
            .session_layout(workspace_path)
            .session_dir(&session.session_id);
        match fs::create_dir(&session_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                return Err(OpenBitFunError::Validation(format!(
                    "Persisted session ID already exists: {}",
                    session.session_id
                )));
            }
            Err(error) => {
                return Err(OpenBitFunError::io(format!(
                    "Failed to claim session directory {}: {}",
                    session_dir.display(),
                    error
                )));
            }
        }
        // Dropping an interrupted future removes the directory while the
        // cross-process writer is still held. A stale index entry is repaired
        // by the existing index validation on the next read.
        let pending_session_dir = PendingSessionDirectory::new(session_dir);

        if let Err(error) = self
            .save_session_files_locked(workspace_path, session)
            .await
        {
            if let Err(cleanup_error) = self
                .session_metadata_store(workspace_path)
                .delete_session_dir_and_index(&session.session_id)
                .await
            {
                warn!(
                    "Failed to clean up partial session persistence: session_id={}, error={}",
                    session.session_id, cleanup_error
                );
                return Err(OpenBitFunError::SessionCreateCleanupRequired {
                    session_id: session.session_id.clone(),
                    error: error.to_string(),
                    cleanup_error: cleanup_error.to_string(),
                });
            }
            pending_session_dir.commit();
            return Err(error);
        }

        pending_session_dir.commit();
        Ok(())
    }

    /// Save session
    pub async fn save_session(
        &self,
        workspace_path: &Path,
        session: &Session,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(&session.session_id)?;
        let _session_write =
            self.lock_session_write_operation(workspace_path, &session.session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &session.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        self.ensure_session_dir(workspace_path, &session.session_id)
            .await?;
        self.save_session_files_locked(workspace_path, session)
            .await
    }

    async fn save_session_files_locked(
        &self,
        workspace_path: &Path,
        session: &Session,
    ) -> OpenBitFunResult<()> {
        let existing_metadata = self
            .load_session_metadata(workspace_path, &session.session_id)
            .await?;
        let metadata = self
            .build_session_metadata(workspace_path, session, existing_metadata.as_ref())
            .await;
        self.save_session_metadata_locked(workspace_path, &metadata)
            .await?;

        let state = StoredSessionStateFile {
            schema_version: SESSION_STORAGE_SCHEMA_VERSION,
            config: session.config.clone(),
            snapshot_session_id: session.snapshot_session_id.clone(),
            last_user_dialog_agent_type: session.last_user_dialog_agent_type.clone(),
            last_submitted_agent_type: session.last_submitted_agent_type.clone(),
            compression_state: session.compression_state.clone(),
            runtime_state: sanitize_persisted_session_state(&session.state),
        };
        self.save_stored_session_state(workspace_path, &session.session_id, &state)
            .await
    }

    /// Load session
    pub async fn load_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        Self::validate_session_id(session_id)?;
        let (session, _) = self
            .load_session_with_turns(workspace_path, session_id)
            .await?;
        Ok(session)
    }

    async fn build_session_from_persisted_parts(
        metadata: SessionMetadata,
        stored_state: Option<StoredSessionStateFile>,
        turns: &[DialogTurnData],
    ) -> OpenBitFunResult<Session> {
        let legacy_minimal = stored_state
            .as_ref()
            .is_some_and(|value| value.config.legacy_minimal_agent);
        let mut config = stored_state
            .as_ref()
            .map(|value| value.config.clone())
            .unwrap_or_default();
        config.legacy_minimal_agent = false;
        if config.project_workspace_id.is_none() {
            config.project_workspace_id = metadata.project_workspace_id.clone();
        }
        if config.workspace_id.is_none() {
            config.workspace_id = metadata.workspace_id.clone();
        }
        if config.workspace_path.is_none() {
            config.workspace_path = metadata.workspace_path.clone();
        }
        if config.remote_ssh_host.is_none() {
            config.remote_ssh_host = metadata
                .workspace_hostname
                .clone()
                .filter(|host| host != LOCAL_WORKSPACE_SSH_HOST && host != "_unresolved");
        }
        crate::agentic::workspace::normalize_session_workspace(&mut config).await?;
        if config.model_id.is_none() && !metadata.model_name.is_empty() {
            config.model_id = Some(metadata.model_name.clone());
        }

        let compression_state = stored_state
            .as_ref()
            .map(|value| value.compression_state.clone())
            .unwrap_or_default();
        let runtime_state = stored_state
            .as_ref()
            .map(|value| sanitize_persisted_session_state(&value.runtime_state))
            .unwrap_or(SessionState::Idle);
        let created_at = Self::unix_ms_to_system_time(metadata.created_at);
        let last_activity_at = Self::unix_ms_to_system_time(metadata.last_active_at);
        let dialog_turn_ids = turns.iter().map(|turn| turn.turn_id.clone()).collect();

        Ok(Session {
            session_id: metadata.session_id.clone(),
            session_name: metadata.session_name.clone(),
            agent_type: if legacy_minimal {
                "Minimal".to_string()
            } else {
                metadata.agent_type.clone()
            },
            last_user_dialog_agent_type: stored_state
                .as_ref()
                .and_then(|value| value.last_user_dialog_agent_type.clone())
                .or_else(|| metadata.last_user_dialog_agent_type.clone()),
            last_submitted_agent_type: stored_state
                .as_ref()
                .and_then(|value| value.last_submitted_agent_type.clone())
                .or_else(|| metadata.last_submitted_agent_type.clone()),
            created_by: metadata.created_by.clone(),
            kind: metadata.session_kind,
            snapshot_session_id: stored_state
                .as_ref()
                .and_then(|value| value.snapshot_session_id.clone())
                .or(metadata.snapshot_session_id.clone()),
            dialog_turn_ids,
            state: runtime_state,
            config,
            compression_state,
            created_at,
            updated_at: last_activity_at,
            last_activity_at,
        })
    }

    /// Read identity/config facts without loading dialog content or restoring a
    /// runtime. Callers needing a stable view hold the Session read permit.
    pub(crate) async fn load_session_header(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        Self::validate_session_id(session_id)?;
        let metadata = self
            .load_session_metadata(storage_path, session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session metadata not found: {session_id}"))
            })?;
        let state = self
            .load_stored_session_state(storage_path, session_id)
            .await?;
        Self::build_session_from_persisted_parts(metadata, state, &[]).await
    }

    /// Load session and return the persisted turns read while rebuilding the session header.
    pub async fn load_session_with_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        Self::validate_session_id(session_id)?;
        self.load_session_with_turns_timed(workspace_path, session_id)
            .await
            .map(|(session, turns, _)| (session, turns))
    }

    pub async fn load_session_with_turns_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionTurnLoadTiming)> {
        Self::validate_session_id(session_id)?;
        let request = SessionTurnLoadRequest {
            workspace_path: workspace_path.to_path_buf(),
            session_id: session_id.to_string(),
            tail_turn_count: None,
        };
        let started_at = Instant::now();
        let metadata_started_at = Instant::now();
        let metadata = self
            .load_session_metadata(&request.workspace_path, &request.session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session metadata not found: {}",
                    request.session_id
                ))
            })?;
        let metadata_duration_ms = elapsed_ms_u64(metadata_started_at);

        let state_started_at = Instant::now();
        let stored_state = self
            .load_stored_session_state(&request.workspace_path, &request.session_id)
            .await?;
        let state_duration_ms = elapsed_ms_u64(state_started_at);

        let scan_started_at = Instant::now();
        let indexed_paths = self
            .list_indexed_turn_paths(&request.workspace_path, &request.session_id)
            .await?;
        let scan_duration_ms = elapsed_ms_u64(scan_started_at);

        let read_started_at = Instant::now();
        let turn_file_count = indexed_paths.len();
        let read_result = self.read_turn_paths(indexed_paths).await?;
        let read_duration_ms = elapsed_ms_u64(read_started_at);
        let missing_turn_file_count = read_result.missing_turn_file_count;
        let max_turn_read_duration_ms = read_result.max_turn_read_duration_ms;
        let turns = read_result.turns;

        let build_started_at = Instant::now();
        let session =
            Self::build_session_from_persisted_parts(metadata, stored_state, &turns).await?;
        let build_session_duration_ms = elapsed_ms_u64(build_started_at);
        let total_duration_ms = elapsed_ms_u64(started_at);

        if total_duration_ms >= 80 || turn_file_count >= 50 {
            debug!(
                "Loaded session turns: session_id={} turn_count={} turn_file_count={} missing_turn_file_count={} metadata_duration_ms={} state_duration_ms={} scan_duration_ms={} read_duration_ms={} max_turn_read_duration_ms={} build_session_duration_ms={} total_duration_ms={}",
                request.session_id,
                turns.len(),
                turn_file_count,
                missing_turn_file_count,
                metadata_duration_ms,
                state_duration_ms,
                scan_duration_ms,
                read_duration_ms,
                max_turn_read_duration_ms,
                build_session_duration_ms,
                total_duration_ms
            );
        }

        let timing = SessionTurnLoadTiming {
            requested_tail_turn_count: None,
            loaded_turn_count: turns.len(),
            total_turn_count: turn_file_count,
            turn_file_count,
            missing_turn_file_count,
            fast_path: false,
            metadata_duration_ms,
            state_duration_ms,
            scan_duration_ms,
            read_duration_ms,
            max_turn_read_duration_ms,
            build_session_duration_ms,
            total_duration_ms,
        };

        Ok((session, turns, timing))
    }

    pub async fn load_session_with_tail_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, usize)> {
        Self::validate_session_id(session_id)?;
        self.load_session_with_tail_turns_timed(workspace_path, session_id, tail_turn_count)
            .await
            .map(|(session, turns, total_turn_count, _)| (session, turns, total_turn_count))
    }

    pub async fn load_session_with_tail_turns_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, usize, SessionTurnLoadTiming)> {
        Self::validate_session_id(session_id)?;
        let request = SessionTurnLoadRequest {
            workspace_path: workspace_path.to_path_buf(),
            session_id: session_id.to_string(),
            tail_turn_count: Some(tail_turn_count),
        };
        let started_at = Instant::now();
        let metadata_started_at = Instant::now();
        let metadata = self
            .load_session_metadata(&request.workspace_path, &request.session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session metadata not found: {}",
                    request.session_id
                ))
            })?;
        let metadata_duration = metadata_started_at.elapsed();

        let state_started_at = Instant::now();
        let stored_state = self
            .load_stored_session_state(&request.workspace_path, &request.session_id)
            .await?;
        let state_duration = state_started_at.elapsed();

        let fast_path_started_at = Instant::now();
        let fast_path_turns = self
            .read_metadata_tail_turns(
                &request.workspace_path,
                &request.session_id,
                metadata.turn_count,
                tail_turn_count,
            )
            .await?;
        let fast_path_duration = fast_path_started_at.elapsed();

        let (
            turns,
            total_turn_count,
            scan_duration,
            read_duration,
            fast_path,
            missing_turn_file_count,
            max_turn_read_duration_ms,
        ) = if let Some(turns) = fast_path_turns {
            (
                turns.turns,
                metadata.turn_count,
                Duration::ZERO,
                fast_path_duration,
                true,
                turns.missing_turn_file_count,
                turns.max_turn_read_duration_ms,
            )
        } else {
            let scan_started_at = Instant::now();
            let indexed_paths = self
                .list_indexed_turn_paths(&request.workspace_path, &request.session_id)
                .await?;
            let scan_duration = scan_started_at.elapsed();
            let total_turn_count = indexed_paths.len();
            let start = indexed_paths.len().saturating_sub(tail_turn_count);
            let selected_paths = indexed_paths.into_iter().skip(start).collect::<Vec<_>>();

            let read_started_at = Instant::now();
            let read_result = self.read_turn_paths(selected_paths).await?;
            let read_duration = read_started_at.elapsed();

            (
                read_result.turns,
                total_turn_count,
                scan_duration,
                read_duration,
                false,
                read_result.missing_turn_file_count,
                read_result.max_turn_read_duration_ms,
            )
        };
        let build_started_at = Instant::now();
        let session =
            Self::build_session_from_persisted_parts(metadata, stored_state, &turns).await?;
        let build_session_duration_ms = elapsed_ms_u64(build_started_at);
        let total_duration = started_at.elapsed();

        if total_duration >= Duration::from_millis(40) || total_turn_count >= 50 {
            debug!(
                "Loaded session tail view: session_id={} turn_count={} requested_count={} total_turn_count={} missing_turn_file_count={} fast_path={} metadata_duration_ms={} state_duration_ms={} scan_duration_ms={} read_duration_ms={} max_turn_read_duration_ms={} build_session_duration_ms={} total_duration_ms={}",
                request.session_id,
                turns.len(),
                request.tail_turn_count.unwrap_or(tail_turn_count),
                total_turn_count,
                missing_turn_file_count,
                fast_path,
                metadata_duration.as_millis(),
                state_duration.as_millis(),
                scan_duration.as_millis(),
                read_duration.as_millis(),
                max_turn_read_duration_ms,
                build_session_duration_ms,
                total_duration.as_millis()
            );
        }

        let timing = SessionTurnLoadTiming {
            requested_tail_turn_count: request.tail_turn_count,
            loaded_turn_count: turns.len(),
            total_turn_count,
            turn_file_count: total_turn_count,
            missing_turn_file_count,
            fast_path,
            metadata_duration_ms: metadata_duration.as_millis() as u64,
            state_duration_ms: state_duration.as_millis() as u64,
            scan_duration_ms: scan_duration.as_millis() as u64,
            read_duration_ms: read_duration.as_millis() as u64,
            max_turn_read_duration_ms,
            build_session_duration_ms,
            total_duration_ms: total_duration.as_millis() as u64,
        };

        Ok((session, turns, total_turn_count, timing))
    }

    /// Save session state
    pub async fn save_session_state(
        &self,
        workspace_path: &Path,
        session_id: &str,
        state: &SessionState,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let mut stored_state = self
            .load_stored_session_state(workspace_path, session_id)
            .await?
            .unwrap_or(StoredSessionStateFile {
                schema_version: SESSION_STORAGE_SCHEMA_VERSION,
                config: SessionConfig {
                    workspace_path: None,
                    ..Default::default()
                },
                snapshot_session_id: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: None,
                compression_state: CompressionState::default(),
                runtime_state: SessionState::Idle,
            });
        stored_state.schema_version = SESSION_STORAGE_SCHEMA_VERSION;
        stored_state.runtime_state = sanitize_persisted_session_state(state);
        self.save_stored_session_state(workspace_path, session_id, &stored_state)
            .await
    }

    /// Delete session
    pub async fn delete_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        #[cfg(feature = "product-search")]
        self.remove_session_from_search(workspace_path, session_id)
            .await;
        self.session_metadata_store(workspace_path)
            .delete_session_dir_and_index(session_id)
            .await
            .map_err(Self::session_metadata_store_error)?;
        info!("Session deleted: session_id={}", session_id);
        Ok(())
    }

    /// List all sessions
    pub async fn list_sessions(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Vec<SessionSummary>> {
        let metadata_list = self.list_session_metadata(workspace_path).await?;
        let mut summaries = Vec::with_capacity(metadata_list.len());

        for metadata in metadata_list {
            let (state, reasoning_preset, legacy_minimal) = self
                .load_stored_session_state(workspace_path, &metadata.session_id)
                .await?
                .map(|value| {
                    (
                        sanitize_persisted_session_state(&value.runtime_state),
                        value.config.reasoning_preset,
                        value.config.legacy_minimal_agent,
                    )
                })
                .unwrap_or((SessionState::Idle, None, false));

            summaries.push(SessionSummary {
                session_id: metadata.session_id,
                session_name: metadata.session_name,
                agent_type: if legacy_minimal {
                    "Minimal".to_string()
                } else {
                    metadata.agent_type
                },
                model_id: (!metadata.model_name.trim().is_empty()).then_some(metadata.model_name),
                reasoning_preset,
                last_user_dialog_agent_type: metadata.last_user_dialog_agent_type,
                last_submitted_agent_type: metadata.last_submitted_agent_type,
                created_by: metadata.created_by,
                kind: metadata.session_kind,
                turn_count: metadata.turn_count,
                created_at: Self::unix_ms_to_system_time(metadata.created_at),
                last_activity_at: Self::unix_ms_to_system_time(metadata.last_active_at),
                state,
            });
        }

        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.last_activity_at));
        Ok(summaries)
    }

    async fn read_session_turn_catalog_cache(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> Option<SessionTurnCatalog> {
        match self
            .read_json_optional::<SessionTurnCatalog>(
                &self.turn_catalog_path(workspace_path, session_id),
            )
            .await
        {
            Ok(Some(catalog))
                if catalog.schema_version == SESSION_TURN_CATALOG_SCHEMA_VERSION
                    && catalog.session_id == session_id
                    && is_well_formed_turn_catalog(&catalog) =>
            {
                Some(catalog)
            }
            Ok(Some(catalog)) => {
                warn!(
                    "Ignoring incompatible Session Turn catalog: session_id={} schema_version={} catalog_session_id={}",
                    session_id, catalog.schema_version, catalog.session_id
                );
                None
            }
            Ok(None) => None,
            Err(error) => {
                warn!(
                    "Ignoring unreadable Session Turn catalog: session_id={} error={}",
                    session_id, error
                );
                None
            }
        }
    }

    /// Build the lightweight navigation catalog for a Session view.
    ///
    /// Missing or stale legacy entries are returned as index-only placeholders.
    /// Metadata for the already-loaded Turns is merged into the derived sidecar
    /// so reopening the Session does not discard completed migration work.
    pub async fn load_session_turn_catalog(
        &self,
        workspace_path: &Path,
        session_id: &str,
        loaded_turns: &[DialogTurnData],
        visible_total_turn_count: usize,
    ) -> OpenBitFunResult<SessionTurnCatalog> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;

        let (physical_indices, can_persist_physical_projection) = match self
            .list_indexed_turn_paths(workspace_path, session_id)
            .await
        {
            Ok(paths) => {
                let persisted_indices = paths
                    .into_iter()
                    .map(|(index, _)| index)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                let projected_indices = complete_turn_catalog_indices(
                    persisted_indices
                        .iter()
                        .copied()
                        .chain(loaded_turns.iter().map(|turn| turn.turn_index)),
                    visible_total_turn_count,
                );
                let can_persist = projected_indices == persisted_indices;
                (projected_indices, can_persist)
            }
            Err(error) => {
                warn!(
                    "Failed to list Turn files while building Session Turn catalog; using bounded placeholders: session_id={} visible_turn_count={} error={}",
                    session_id, visible_total_turn_count, error
                );
                (
                    complete_turn_catalog_indices(
                        loaded_turns.iter().map(|turn| turn.turn_index),
                        visible_total_turn_count,
                    ),
                    false,
                )
            }
        };

        let projection = self
            .build_session_turn_catalog_projection_with_physical(
                workspace_path,
                session_id,
                physical_indices,
                loaded_turns,
                visible_total_turn_count,
            )
            .await?;
        if can_persist_physical_projection && projection.physical_changed {
            if let Err(error) = self
                .write_json_atomic(
                    &self.turn_catalog_path(workspace_path, session_id),
                    &projection.physical,
                )
                .await
            {
                warn!(
                    "Failed to persist incrementally repaired Session Turn catalog: session_id={} error={}",
                    session_id, error
                );
            }
        }
        Ok(projection.visible)
    }

    async fn build_session_turn_catalog_projection(
        &self,
        workspace_path: &Path,
        session_id: &str,
        physical_indices: Vec<usize>,
        loaded_turns: &[DialogTurnData],
        visible_total_turn_count: usize,
    ) -> OpenBitFunResult<SessionTurnCatalog> {
        Ok(self
            .build_session_turn_catalog_projection_with_physical(
                workspace_path,
                session_id,
                physical_indices,
                loaded_turns,
                visible_total_turn_count,
            )
            .await?
            .visible)
    }

    async fn build_session_turn_catalog_projection_with_physical(
        &self,
        workspace_path: &Path,
        session_id: &str,
        physical_indices: Vec<usize>,
        loaded_turns: &[DialogTurnData],
        visible_total_turn_count: usize,
    ) -> OpenBitFunResult<BuiltSessionTurnCatalogProjection> {
        let cached = self
            .read_session_turn_catalog_cache(workspace_path, session_id)
            .await;
        let mut cached_by_index = cached
            .as_ref()
            .map(|catalog| {
                catalog
                    .entries
                    .iter()
                    .cloned()
                    .map(|entry| (entry.storage_turn_index, entry))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let loaded_by_index = loaded_turns
            .iter()
            .map(|turn| (turn.turn_index, turn))
            .collect::<HashMap<_, _>>();

        let physical_entries = physical_indices
            .into_iter()
            .enumerate()
            .map(|(ordinal, storage_turn_index)| {
                if let Some(turn) = loaded_by_index.get(&storage_turn_index) {
                    turn_catalog_entry(turn, ordinal)
                } else if let Some(mut entry) = cached_by_index.remove(&storage_turn_index) {
                    entry.ordinal = ordinal;
                    entry
                } else {
                    placeholder_turn_catalog_entry(storage_turn_index, ordinal)
                }
            })
            .collect::<Vec<_>>();
        let physical_catalog = build_turn_catalog(session_id, physical_entries);
        let visible_entries = physical_catalog
            .entries
            .iter()
            .take(visible_total_turn_count)
            .cloned()
            .collect::<Vec<_>>();
        let physical_changed = cached.as_ref() != Some(&physical_catalog);
        Ok(BuiltSessionTurnCatalogProjection {
            visible: build_turn_catalog(session_id, visible_entries),
            physical: physical_catalog,
            physical_changed,
        })
    }

    /// Load a bounded, contiguous Turn window without materializing the full
    /// Session transcript.
    ///
    /// The operation holds the persisted writer lease while it snapshots the
    /// staged-revert boundary, catalog, and selected Turn files. A raced or
    /// missing file therefore never produces a sparse ready range.
    pub async fn load_session_turn_window(
        &self,
        request: &SessionTurnWindowRequest,
    ) -> OpenBitFunResult<SessionTurnWindowResponse> {
        Self::validate_session_id(&request.session_id)?;
        let _session_write =
            self.lock_session_write_operation(&request.workspace_path, &request.session_id)?;
        let boundary_turn = self
            .load_session_revert_state(&request.workspace_path, &request.session_id)
            .await?
            .map(|state| state.boundary_turn);
        let physical_indexed_paths = self
            .list_indexed_turn_paths(&request.workspace_path, &request.session_id)
            .await?;
        let physical_indices = physical_indexed_paths
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        let indexed_paths = physical_indexed_paths
            .into_iter()
            .filter(|(index, _)| boundary_turn.is_none_or(|boundary| *index < boundary))
            .collect::<Vec<_>>();
        let visible_indices = indexed_paths
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        let catalog = self
            .build_session_turn_catalog_projection(
                &request.workspace_path,
                &request.session_id,
                visible_indices.clone(),
                &[],
                visible_indices.len(),
            )
            .await?;

        if request
            .expected_catalog_revision
            .as_deref()
            .is_some_and(|revision| revision != catalog.revision)
        {
            return Ok(SessionTurnWindowResponse::Stale { catalog });
        }

        let Some(target_ordinal) = catalog
            .entries
            .iter()
            .position(|entry| entry.storage_turn_index == request.target_storage_turn_index)
        else {
            return Ok(SessionTurnWindowResponse::NotFound { catalog });
        };
        if let (Some(expected_turn_id), Some(catalog_turn_id)) = (
            request.expected_turn_id.as_deref(),
            catalog.entries[target_ordinal].turn_id.as_deref(),
        ) {
            if expected_turn_id != catalog_turn_id {
                return Ok(SessionTurnWindowResponse::Stale { catalog });
            }
        }

        let before = request.before.min(SESSION_TURN_WINDOW_MAX_BEFORE);
        let target_and_after = request
            .after
            .clamp(1, SESSION_TURN_WINDOW_MAX_TARGET_AND_AFTER);
        let start_ordinal = target_ordinal.saturating_sub(before);
        let end_ordinal_exclusive = indexed_paths
            .len()
            .min(target_ordinal.saturating_add(target_and_after));
        let selected_paths = indexed_paths[start_ordinal..end_ordinal_exclusive].to_vec();
        let selected_indices = selected_paths
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        let read_result = self.read_turn_paths(selected_paths).await?;

        if read_result.missing_turn_file_count > 0
            || read_result.turns.len() != selected_indices.len()
        {
            let refreshed_indices = self
                .list_indexed_turn_paths(&request.workspace_path, &request.session_id)
                .await?
                .into_iter()
                .filter(|(index, _)| boundary_turn.is_none_or(|boundary| *index < boundary))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let catalog = self
                .build_session_turn_catalog_projection(
                    &request.workspace_path,
                    &request.session_id,
                    refreshed_indices.clone(),
                    &[],
                    refreshed_indices.len(),
                )
                .await?;
            return Ok(SessionTurnWindowResponse::NotFound { catalog });
        }

        for (turn, expected_index) in read_result.turns.iter().zip(selected_indices.iter()) {
            if turn.session_id != request.session_id || turn.turn_index != *expected_index {
                return Err(OpenBitFunError::Validation(format!(
                    "Persisted Turn identity does not match its storage path: session_id={} expected_turn_index={} actual_session_id={} actual_turn_index={}",
                    request.session_id, expected_index, turn.session_id, turn.turn_index
                )));
            }
        }

        let repaired_projection = self
            .build_session_turn_catalog_projection_with_physical(
                &request.workspace_path,
                &request.session_id,
                physical_indices.clone(),
                &read_result.turns,
                physical_indices.len(),
            )
            .await?;
        if repaired_projection.physical_changed {
            if let Err(error) = self
                .write_json_atomic(
                    &self.turn_catalog_path(&request.workspace_path, &request.session_id),
                    &repaired_projection.physical,
                )
                .await
            {
                warn!(
                    "Failed to persist Session Turn catalog metadata loaded by a window request: session_id={} start_ordinal={} end_ordinal_exclusive={} error={}",
                    request.session_id, start_ordinal, end_ordinal_exclusive, error
                );
            }
        }

        let target_offset = target_ordinal - start_ordinal;
        let target_turn = &read_result.turns[target_offset];
        if request
            .expected_turn_id
            .as_deref()
            .is_some_and(|expected_turn_id| expected_turn_id != target_turn.turn_id)
        {
            let catalog = self
                .build_session_turn_catalog_projection(
                    &request.workspace_path,
                    &request.session_id,
                    visible_indices,
                    &read_result.turns,
                    indexed_paths.len(),
                )
                .await?;
            return Ok(SessionTurnWindowResponse::Stale { catalog });
        }

        Ok(SessionTurnWindowResponse::Ready {
            catalog_revision: catalog.revision,
            total_turn_count: catalog.total_turn_count,
            start_ordinal,
            end_ordinal_exclusive,
            target_turn_id: target_turn.turn_id.clone(),
            turns: read_result.turns,
        })
    }

    async fn persist_session_turn_catalog_after_save(
        &self,
        workspace_path: &Path,
        turn: &DialogTurnData,
    ) -> OpenBitFunResult<()> {
        let cached = self
            .read_session_turn_catalog_cache(workspace_path, &turn.session_id)
            .await;
        if let Some(catalog) = cached.as_ref().filter(|catalog| catalog.complete) {
            if catalog
                .entries
                .iter()
                .find(|entry| entry.storage_turn_index == turn.turn_index)
                .is_some_and(|entry| turn_catalog_entry(turn, entry.ordinal) == *entry)
            {
                return Ok(());
            }
        }

        let next_entry = turn_catalog_entry(turn, 0);
        let indexed_paths = self
            .list_indexed_turn_paths(workspace_path, &turn.session_id)
            .await?;
        let physical_indices = indexed_paths
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        // Completeness is independent from structural alignment. A legacy
        // catalog with placeholders can safely repair only the saved entry as
        // long as its indices still match the physical Turn sequence.
        let can_update_incrementally = cached.as_ref().is_some_and(|catalog| {
            can_incrementally_update_turn_catalog_after_save(
                catalog,
                &physical_indices,
                turn.turn_index,
            )
        });

        let next_catalog = if can_update_incrementally {
            let mut entries = cached
                .as_ref()
                .map(|catalog| catalog.entries.clone())
                .unwrap_or_default();
            if let Some(entry) = entries
                .iter_mut()
                .find(|entry| entry.storage_turn_index == turn.turn_index)
            {
                *entry = next_entry;
            } else {
                entries.push(next_entry);
            }
            build_turn_catalog(&turn.session_id, entries)
        } else {
            let read_result = self.read_turn_paths(indexed_paths).await?;
            let loaded_by_index = read_result
                .turns
                .iter()
                .map(|loaded_turn| (loaded_turn.turn_index, loaded_turn))
                .collect::<HashMap<_, _>>();
            let entries = physical_indices
                .into_iter()
                .enumerate()
                .map(|(ordinal, storage_turn_index)| {
                    loaded_by_index
                        .get(&storage_turn_index)
                        .map(|loaded_turn| turn_catalog_entry(loaded_turn, ordinal))
                        .unwrap_or_else(|| {
                            placeholder_turn_catalog_entry(storage_turn_index, ordinal)
                        })
                })
                .collect::<Vec<_>>();
            build_turn_catalog(&turn.session_id, entries)
        };

        if cached.as_ref() == Some(&next_catalog) {
            return Ok(());
        }

        self.write_json_atomic(
            &self.turn_catalog_path(workspace_path, &turn.session_id),
            &next_catalog,
        )
        .await
    }

    async fn persist_complete_session_turn_catalog(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turns: &[DialogTurnData],
    ) -> OpenBitFunResult<()> {
        let next_catalog = build_turn_catalog(
            session_id,
            turns
                .iter()
                .enumerate()
                .map(|(ordinal, turn)| turn_catalog_entry(turn, ordinal))
                .collect(),
        );
        if self
            .read_session_turn_catalog_cache(workspace_path, session_id)
            .await
            .as_ref()
            == Some(&next_catalog)
        {
            return Ok(());
        }

        self.write_json_atomic(
            &self.turn_catalog_path(workspace_path, session_id),
            &next_catalog,
        )
        .await
    }

    pub async fn save_dialog_turn(
        &self,
        workspace_path: &Path,
        turn: &DialogTurnData,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(&turn.session_id)?;
        #[cfg(test)]
        {
            let mut fault = self
                .fail_next_dialog_turn_write
                .lock()
                .expect("dialog turn fault lock");
            if fault.as_deref() == Some(turn.session_id.as_str()) {
                *fault = None;
                return Err(OpenBitFunError::io("Injected dialog turn write failure"));
            }
        }
        let _session_write = self.lock_session_write_operation(workspace_path, &turn.session_id)?;
        let save_started_at = Instant::now();
        self.ensure_runtime_for_write(workspace_path).await?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, &turn.session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        let mut metadata = self
            .load_session_metadata(workspace_path, &turn.session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session metadata not found: {}",
                    turn.session_id
                ))
            })?;
        self.ensure_turns_dir(workspace_path, &turn.session_id)
            .await?;

        let previous_turn = match self
            .load_dialog_turn(workspace_path, &turn.session_id, turn.turn_index)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                warn!(
                    "Failed to load existing dialog turn before save; falling back to full metadata refresh: session_id={} turn_index={} error={}",
                    turn.session_id,
                    turn.turn_index,
                    error
                );
                None
            }
        };
        let previous_turn_load_failed = previous_turn.is_none()
            && self
                .turn_path(workspace_path, &turn.session_id, turn.turn_index)
                .exists();
        if let Some(revert) = self
            .read_json_optional::<SessionRevertState>(
                &self.session_revert_path(workspace_path, &turn.session_id),
            )
            .await?
        {
            if revert.schema_version != SESSION_REVERT_SCHEMA_VERSION {
                return Err(OpenBitFunError::Deserialization(format!(
                    "Unsupported Session revert schema version: session_id={}, version={}",
                    turn.session_id, revert.schema_version
                )));
            }
            if turn.turn_index >= revert.boundary_turn {
                return Err(OpenBitFunError::Validation(format!(
                    "Cannot persist a Turn over the staged Session suffix: session_id={}, turn_index={}, boundary_turn={}",
                    turn.session_id, turn.turn_index, revert.boundary_turn
                )));
            }
        }

        #[cfg(feature = "product-search")]
        self.invalidate_session_search(workspace_path, &turn.session_id)
            .await;

        let file = StoredDialogTurnFile::new(turn.clone());
        let write_started_at = Instant::now();
        self.write_json_atomic(
            &self.turn_path(workspace_path, &turn.session_id, turn.turn_index),
            &file,
        )
        .await?;
        let write_duration = write_started_at.elapsed();

        if let Err(error) = self
            .persist_session_turn_catalog_after_save(workspace_path, turn)
            .await
        {
            warn!(
                "Failed to refresh derived Session Turn catalog after Turn save: session_id={} turn_index={} error={}",
                turn.session_id, turn.turn_index, error
            );
        }

        let last_active_at = turn
            .end_time
            .unwrap_or_else(|| Self::system_time_to_unix_ms(SystemTime::now()));
        let mut metadata_refresh_mode = "incremental";
        let workspace_path_text = workspace_path.to_string_lossy();
        if previous_turn_load_failed
            || !try_refresh_session_metadata_for_saved_turn(
                &mut metadata,
                workspace_path_text.as_ref(),
                previous_turn.as_ref(),
                turn,
                last_active_at,
            )
        {
            metadata_refresh_mode = "full_scan";
            let turns = self
                .load_session_turns(workspace_path, &turn.session_id)
                .await?;
            refresh_session_metadata_from_turns(
                &mut metadata,
                workspace_path_text.as_ref(),
                &turns,
                last_active_at,
            );
        }
        let uses_external_context = dialog_turn_uses_external_context(turn);
        let should_pollute_memory = memory_pollution_guard_enabled().await && uses_external_context;
        let should_enqueue_phase2_for_pollution = should_pollute_memory
            && matches!(
                metadata.memory_mode,
                SessionMemoryMode::Enabled | SessionMemoryMode::Polluted
            );
        if should_pollute_memory && metadata.memory_mode == SessionMemoryMode::Enabled {
            metadata.memory_mode = SessionMemoryMode::Polluted;
        }

        let metadata_started_at = Instant::now();
        self.save_session_metadata_locked(workspace_path, &metadata)
            .await?;
        if should_enqueue_phase2_for_pollution {
            self.enqueue_phase2_if_session_selected(&turn.session_id, current_unix_secs())
                .await?;
        }
        let metadata_duration = metadata_started_at.elapsed();
        let total_duration = save_started_at.elapsed();
        if total_duration >= Duration::from_millis(80) || metadata_refresh_mode == "full_scan" {
            debug!(
                "Saved dialog turn: session_id={} turn_index={} metadata_refresh={} write_duration_ms={} metadata_duration_ms={} total_duration_ms={}",
                turn.session_id,
                turn.turn_index,
                metadata_refresh_mode,
                write_duration.as_millis(),
                metadata_duration.as_millis(),
                total_duration.as_millis()
            );
        }

        Ok(())
    }

    pub async fn load_dialog_turn(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<Option<DialogTurnData>> {
        Self::validate_session_id(session_id)?;
        Ok(self
            .read_json_optional::<StoredDialogTurnFile>(&self.turn_path(
                workspace_path,
                session_id,
                turn_index,
            ))
            .await?
            .map(|file| file.turn))
    }

    async fn list_indexed_turn_paths(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<(usize, PathBuf)>> {
        self.session_layout(workspace_path)
            .list_indexed_turn_paths(session_id)
            .await
            .map_err(|e| OpenBitFunError::io(format!("Failed to list dialog turn files: {}", e)))
    }

    async fn read_turn_paths(
        &self,
        indexed_paths: Vec<(usize, PathBuf)>,
    ) -> OpenBitFunResult<ReadTurnPathsResult> {
        let mut turns = Vec::with_capacity(indexed_paths.len());
        let mut missing_turn_file_count = 0usize;
        let mut max_turn_read_duration_ms = 0u64;
        let reads = stream::iter(indexed_paths.into_iter().map(|(_, path)| {
            let manager = self;
            async move {
                let started_at = Instant::now();
                let result = manager
                    .read_json_optional::<StoredDialogTurnFile>(&path)
                    .await;
                (result, elapsed_ms_u64(started_at))
            }
        }))
        .buffered(SESSION_TURN_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        for (result, duration_ms) in reads {
            max_turn_read_duration_ms = max_turn_read_duration_ms.max(duration_ms);
            if let Some(file) = result? {
                turns.push(file.turn);
            } else {
                missing_turn_file_count += 1;
            }
        }

        Ok(ReadTurnPathsResult {
            turns,
            missing_turn_file_count,
            max_turn_read_duration_ms,
        })
    }

    async fn read_metadata_tail_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
        total_turn_count: usize,
        requested_count: usize,
    ) -> OpenBitFunResult<Option<ReadTurnPathsResult>> {
        if requested_count == 0 {
            return Ok(Some(ReadTurnPathsResult {
                turns: Vec::new(),
                missing_turn_file_count: 0,
                max_turn_read_duration_ms: 0,
            }));
        }
        if total_turn_count == 0 {
            return Ok(None);
        }

        let start = total_turn_count.saturating_sub(requested_count);
        let indexed_paths = (start..total_turn_count)
            .map(|index| (index, self.turn_path(workspace_path, session_id, index)))
            .collect::<Vec<_>>();
        let result = self.read_turn_paths(indexed_paths).await?;
        if result.missing_turn_file_count > 0 {
            return Ok(None);
        }

        Ok(Some(result))
    }

    pub async fn load_session_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        Self::validate_session_id(session_id)?;
        let started_at = Instant::now();
        let scan_started_at = Instant::now();
        let indexed_paths = self
            .list_indexed_turn_paths(workspace_path, session_id)
            .await?;
        let scan_duration = scan_started_at.elapsed();

        let read_started_at = Instant::now();
        let turn_file_count = indexed_paths.len();
        let read_result = self.read_turn_paths(indexed_paths).await?;
        let read_duration = read_started_at.elapsed();
        let missing_turn_file_count = read_result.missing_turn_file_count;
        let max_turn_read_duration_ms = read_result.max_turn_read_duration_ms;
        let turns = read_result.turns;
        let total_duration = started_at.elapsed();
        if total_duration >= Duration::from_millis(80) || turn_file_count >= 50 {
            debug!(
                "Loaded session turns: session_id={} turn_count={} turn_file_count={} missing_turn_file_count={} scan_duration_ms={} read_duration_ms={} max_turn_read_duration_ms={} total_duration_ms={}",
                session_id,
                turns.len(),
                turn_file_count,
                missing_turn_file_count,
                scan_duration.as_millis(),
                read_duration.as_millis(),
                max_turn_read_duration_ms,
                total_duration.as_millis()
            );
        }

        Ok(turns)
    }

    /// Load the product-visible Session history while retaining the current
    /// process's persisted writer lease across the marker and Turn reads.
    ///
    /// Runtime owners that reconcile, redo, or permanently discard a staged
    /// suffix must use [`Self::load_session_turns`] instead. Passive product
    /// consumers must enter through Core's per-Session mutation owner before
    /// using this projection; the persistence lease supplies cross-process,
    /// not in-process, ordering.
    pub async fn load_visible_session_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let boundary_turn = self
            .load_session_revert_state(workspace_path, session_id)
            .await?
            .map(|state| state.boundary_turn);
        let mut turns = self.load_session_turns(workspace_path, session_id).await?;
        if let Some(boundary_turn) = boundary_turn {
            turns.retain(|turn| turn.turn_index < boundary_turn);
        }
        Ok(turns)
    }

    pub async fn load_session_tail_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
        count: usize,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        Self::validate_session_id(session_id)?;
        if count == 0 {
            return Ok(Vec::new());
        }

        let started_at = Instant::now();
        let metadata_started_at = Instant::now();
        let metadata = self
            .load_session_metadata(workspace_path, session_id)
            .await?;
        let metadata_duration = metadata_started_at.elapsed();

        let fast_path_started_at = Instant::now();
        let fast_path_turns = if let Some(metadata) = metadata.as_ref() {
            self.read_metadata_tail_turns(workspace_path, session_id, metadata.turn_count, count)
                .await?
        } else {
            None
        };
        let fast_path_duration = fast_path_started_at.elapsed();

        let (
            turns,
            turn_file_count,
            scan_duration,
            read_duration,
            fast_path,
            missing_turn_file_count,
            max_turn_read_duration_ms,
        ) = if let Some(turns) = fast_path_turns {
            let turn_file_count = metadata
                .as_ref()
                .map(|metadata| metadata.turn_count)
                .unwrap_or(turns.turns.len());
            (
                turns.turns,
                turn_file_count,
                Duration::ZERO,
                fast_path_duration,
                true,
                turns.missing_turn_file_count,
                turns.max_turn_read_duration_ms,
            )
        } else {
            let scan_started_at = Instant::now();
            let indexed_paths = self
                .list_indexed_turn_paths(workspace_path, session_id)
                .await?;
            let scan_duration = scan_started_at.elapsed();
            let turn_file_count = indexed_paths.len();
            let start = indexed_paths.len().saturating_sub(count);
            let selected_paths = indexed_paths.into_iter().skip(start).collect::<Vec<_>>();

            let read_started_at = Instant::now();
            let read_result = self.read_turn_paths(selected_paths).await?;
            let read_duration = read_started_at.elapsed();

            (
                read_result.turns,
                turn_file_count,
                scan_duration,
                read_duration,
                false,
                read_result.missing_turn_file_count,
                read_result.max_turn_read_duration_ms,
            )
        };
        let total_duration = started_at.elapsed();
        if total_duration >= Duration::from_millis(40) || turn_file_count >= 50 {
            debug!(
                "Loaded session tail turns: session_id={} turn_count={} requested_count={} turn_file_count={} missing_turn_file_count={} fast_path={} metadata_duration_ms={} scan_duration_ms={} read_duration_ms={} max_turn_read_duration_ms={} total_duration_ms={}",
                session_id,
                turns.len(),
                count,
                turn_file_count,
                missing_turn_file_count,
                fast_path,
                metadata_duration.as_millis(),
                scan_duration.as_millis(),
                read_duration.as_millis(),
                max_turn_read_duration_ms,
                total_duration.as_millis()
            );
        }

        Ok(turns)
    }

    pub async fn delete_dialog_turns_from(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        #[cfg(feature = "product-search")]
        self.invalidate_session_search(workspace_path, session_id)
            .await;
        if !self.turns_dir(workspace_path, session_id).exists() {
            if self.turn_catalog_path(workspace_path, session_id).exists() {
                if let Err(error) = self
                    .persist_complete_session_turn_catalog(workspace_path, session_id, &[])
                    .await
                {
                    warn!(
                        "Failed to clear derived Session Turn catalog without a Turn directory: session_id={} error={}",
                        session_id, error
                    );
                }
            }
            return Ok(());
        }

        self.session_layout(workspace_path)
            .delete_indexed_turn_paths_from(session_id, turn_index)
            .await
            .map_err(|e| {
                OpenBitFunError::io(format!("Failed to delete dialog turn files: {}", e))
            })?;

        let turns = self.load_session_turns(workspace_path, session_id).await?;
        if self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .is_some()
        {
            let workspace_path_text = workspace_path.to_string_lossy();
            self.update_session_metadata_if_present_locked(
                workspace_path,
                session_id,
                |metadata| {
                    refresh_session_metadata_from_turns(
                        metadata,
                        workspace_path_text.as_ref(),
                        &turns,
                        Self::system_time_to_unix_ms(SystemTime::now()),
                    );
                    Ok(())
                },
            )
            .await?;
        }

        if let Err(error) = self
            .persist_complete_session_turn_catalog(workspace_path, session_id, &turns)
            .await
        {
            warn!(
                "Failed to refresh derived Session Turn catalog after Turn deletion: session_id={} start_turn_index={} error={}",
                session_id, turn_index, error
            );
        }

        Ok(())
    }

    pub async fn load_recent_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
        count: usize,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        Self::validate_session_id(session_id)?;
        let turns = self
            .load_visible_session_turns(workspace_path, session_id)
            .await?;
        let start = turns.len().saturating_sub(count);
        Ok(turns[start..].to_vec())
    }

    fn compression_transcript_boundary_from_file_name(file_name: &str) -> Option<usize> {
        let stem = file_name
            .strip_suffix(".meta.json")
            .or_else(|| file_name.strip_suffix(".txt"))?;
        let (boundary, short_id) = stem.rsplit_once('-')?;
        if short_id.len() != 4
            || !short_id
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
            || boundary.is_empty()
            || !boundary.bytes().all(|value| value.is_ascii_digit())
        {
            return None;
        }
        boundary.parse().ok()
    }

    pub(crate) async fn create_compression_transcript(
        &self,
        workspace_path: &Path,
        session_id: &str,
        boundary_turn_index: usize,
        compression_id: &str,
        trigger: &str,
    ) -> OpenBitFunResult<Option<CompressionTranscriptArtifact>> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let all_turns = self.load_session_turns(workspace_path, session_id).await?;
        let selected_indices = all_turns
            .iter()
            .enumerate()
            .filter_map(|(index, turn)| (turn.turn_index <= boundary_turn_index).then_some(index))
            .collect::<Vec<_>>();
        if selected_indices.is_empty() {
            return Ok(None);
        }

        let options = SessionTranscriptExportOptions {
            tools: true,
            tool_inputs: true,
            thinking: false,
            turns: Some(vec![format!("0:{}", boundary_turn_index.saturating_add(1))]),
        };
        let selected_turns = selected_indices
            .iter()
            .map(|&index| all_turns[index].clone())
            .collect::<Vec<_>>();
        let source_fingerprint = transcript_fingerprint(session_id, &selected_turns, &options)?;
        let rendered = render_transcript(&all_turns, &selected_indices, &options);
        let transcript_content = rendered.lines.join("\n");
        let transcript_bytes = transcript_content.as_bytes();
        let generated_at = Self::system_time_to_unix_ms(SystemTime::now());

        let layout = self.session_layout(workspace_path);
        layout
            .ensure_compression_transcripts_dir(session_id)
            .await
            .map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to create compression transcript directory: {}",
                    error
                ))
            })?;

        for _ in 0..COMPRESSION_TRANSCRIPT_CREATE_ATTEMPTS {
            let short_id = uuid::Uuid::new_v4().simple().to_string()[..4].to_string();
            let stem = format!("{}-{}", boundary_turn_index, short_id);
            let transcript_path = layout.compression_transcript_path(session_id, &stem);
            let meta_path = layout.compression_transcript_meta_path(session_id, &stem);
            let metadata = CompressionTranscriptMetadata {
                schema_version: COMPRESSION_TRANSCRIPT_SCHEMA_VERSION,
                boundary_turn_index,
                short_id,
                compression_id: compression_id.to_string(),
                trigger: trigger.to_string(),
                generated_at,
                origin_session_id: session_id.to_string(),
                source_fingerprint: source_fingerprint.clone(),
                line_count: rendered.lines.len(),
                byte_count: transcript_bytes.len(),
                options: CompressionTranscriptOptionsMetadata {
                    tools: true,
                    tool_inputs: true,
                    thinking: false,
                },
            };
            let mut metadata_bytes = serde_json::to_vec_pretty(&metadata).map_err(|error| {
                OpenBitFunError::serialization(format!(
                    "Failed to serialize compression transcript metadata: {}",
                    error
                ))
            })?;
            metadata_bytes.push(b'\n');

            let mut transcript_file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&transcript_path)
                .await
            {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(OpenBitFunError::io(format!(
                        "Failed to reserve compression transcript {}: {}",
                        transcript_path.display(),
                        error
                    )))
                }
            };

            let mut meta_file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&meta_path)
                .await
            {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    let _ = fs::remove_file(&transcript_path).await;
                    continue;
                }
                Err(error) => {
                    let _ = fs::remove_file(&transcript_path).await;
                    return Err(OpenBitFunError::io(format!(
                        "Failed to reserve compression transcript metadata {}: {}",
                        meta_path.display(),
                        error
                    )));
                }
            };

            let write_result = async {
                transcript_file.write_all(transcript_bytes).await?;
                transcript_file.flush().await?;
                meta_file.write_all(&metadata_bytes).await?;
                meta_file.flush().await
            }
            .await;
            if let Err(error) = write_result {
                drop(transcript_file);
                drop(meta_file);
                let _ = fs::remove_file(&transcript_path).await;
                let _ = fs::remove_file(&meta_path).await;
                return Err(OpenBitFunError::io(format!(
                    "Failed to write compression transcript pair: {}",
                    error
                )));
            }

            let uri = openbitfun_agent_tools::build_openbitfun_current_session_uri(&format!(
                "artifacts/compression-transcripts/{}.txt",
                stem
            ))
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
            return Ok(Some(CompressionTranscriptArtifact {
                uri,
                index_range: rendered.index_range.clone(),
                transcript_path,
                meta_path,
            }));
        }

        Err(OpenBitFunError::io(format!(
            "Failed to allocate a unique compression transcript name after {} attempts",
            COMPRESSION_TRANSCRIPT_CREATE_ATTEMPTS
        )))
    }

    pub(crate) async fn delete_compression_transcripts_from(
        &self,
        workspace_path: &Path,
        session_id: &str,
        start_turn_index: usize,
    ) -> OpenBitFunResult<usize> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let dir = self.compression_transcripts_dir(workspace_path, session_id);
        if !dir.exists() {
            return Ok(0);
        }
        let mut deleted = 0usize;
        let mut entries = fs::read_dir(&dir).await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to read compression transcript directory {}: {}",
                dir.display(),
                error
            ))
        })?;
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to enumerate compression transcript directory {}: {}",
                dir.display(),
                error
            ))
        })? {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if Self::compression_transcript_boundary_from_file_name(&file_name)
                .is_some_and(|boundary| boundary >= start_turn_index)
            {
                fs::remove_file(entry.path()).await.map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to delete compression transcript artifact {}: {}",
                        entry.path().display(),
                        error
                    ))
                })?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    pub(crate) async fn copy_compression_transcripts_through(
        &self,
        workspace_path: &Path,
        source_session_id: &str,
        target_session_id: &str,
        end_turn_index: usize,
    ) -> OpenBitFunResult<usize> {
        Self::validate_session_id(source_session_id)?;
        Self::validate_session_id(target_session_id)?;
        let _session_write =
            self.lock_session_write_operation(workspace_path, target_session_id)?;
        let source_dir = self.compression_transcripts_dir(workspace_path, source_session_id);
        if !source_dir.exists() {
            return Ok(0);
        }
        let target_dir = self
            .session_layout(workspace_path)
            .ensure_compression_transcripts_dir(target_session_id)
            .await
            .map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to create branched compression transcript directory: {}",
                    error
                ))
            })?;
        let mut copied = 0usize;
        let mut entries = fs::read_dir(&source_dir).await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to read source compression transcript directory {}: {}",
                source_dir.display(),
                error
            ))
        })?;
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to enumerate source compression transcripts: {}",
                error
            ))
        })? {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if Self::compression_transcript_boundary_from_file_name(&file_name)
                .is_some_and(|boundary| boundary <= end_turn_index)
            {
                fs::copy(entry.path(), target_dir.join(&file_name))
                    .await
                    .map_err(|error| {
                        OpenBitFunError::io(format!(
                            "Failed to copy compression transcript artifact {}: {}",
                            entry.path().display(),
                            error
                        ))
                    })?;
                copied += 1;
            }
        }
        Ok(copied)
    }

    pub async fn export_session_transcript(
        &self,
        workspace_path: &Path,
        session_id: &str,
        options: &SessionTranscriptExportOptions,
    ) -> OpenBitFunResult<SessionTranscriptExport> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        if self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .is_none()
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Session metadata not found: {}",
                session_id
            )));
        }

        let transcript_path = self.transcript_path(workspace_path, session_id);
        let transcript_meta_path = self.transcript_meta_path(workspace_path, session_id);

        let parsed_turn_selectors = options
            .turns
            .as_ref()
            .map(|selectors| Self::parse_transcript_turn_selectors(selectors))
            .transpose()?;
        let normalized_options = SessionTranscriptExportOptions {
            tools: options.tools,
            tool_inputs: options.tool_inputs,
            thinking: options.thinking,
            turns: parsed_turn_selectors.as_ref().map(|selectors| {
                selectors
                    .iter()
                    .map(|selector| selector.normalized.clone())
                    .collect()
            }),
        };

        let revert_boundary = self
            .load_session_revert_state(workspace_path, session_id)
            .await?
            .map(|state| state.boundary_turn);
        let mut all_turns = self.load_session_turns(workspace_path, session_id).await?;
        if let Some(boundary_turn) = revert_boundary {
            all_turns.retain(|turn| turn.turn_index < boundary_turn);
        }
        let selected_indices = parsed_turn_selectors
            .as_ref()
            .map(|selectors| Self::transcript_select_turn_indices(all_turns.len(), selectors))
            .unwrap_or_else(|| (0..all_turns.len()).collect::<Vec<_>>());
        let turns = selected_indices
            .iter()
            .map(|&index| all_turns[index].clone())
            .collect::<Vec<_>>();

        let source_fingerprint = transcript_fingerprint(session_id, &turns, &normalized_options)?;
        if transcript_path.exists() {
            if let Some(stored) = self
                .read_json_optional::<StoredSessionTranscriptFile>(&transcript_meta_path)
                .await?
            {
                if stored.transcript.source_fingerprint == source_fingerprint
                    && stored.transcript.index_range.start_line > 0
                    && stored.transcript.index_range.end_line > 0
                {
                    return Ok(stored.transcript);
                }
            }
        }

        self.ensure_artifacts_dir(workspace_path, session_id)
            .await?;

        let generated_at = Self::system_time_to_unix_ms(SystemTime::now());
        let rendered = render_transcript(&all_turns, &selected_indices, &normalized_options);
        let lines = rendered.lines;
        let index_range = rendered.index_range;
        let index = rendered.index;

        let transcript_content = lines.join("\n");
        fs::write(&transcript_path, transcript_content)
            .await
            .map_err(|e| {
                OpenBitFunError::io(format!(
                    "Failed to write transcript file {}: {}",
                    transcript_path.display(),
                    e
                ))
            })?;

        let transcript = SessionTranscriptExport {
            session_id: session_id.to_string(),
            transcript_path: transcript_path.to_string_lossy().to_string(),
            generated_at,
            source_fingerprint,
            includes_tools: normalized_options.tools,
            includes_tool_inputs: normalized_options.tool_inputs,
            includes_thinking: normalized_options.thinking,
            turns: normalized_options.turns,
            turn_count: turns.len(),
            line_count: lines.len(),
            index_range,
            index,
        };

        self.write_json_atomic(
            &transcript_meta_path,
            &StoredSessionTranscriptFile {
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
                transcript: transcript.clone(),
            },
        )
        .await?;

        Ok(transcript)
    }

    /// Render the newest complete persisted turns from `reference_session_id`
    /// into an artifact owned by `source_session_id`. The source artifact is
    /// overwritten on each use so agent tools only ever read the current
    /// reference copy, never another session's storage directory.
    pub async fn materialize_session_reference_transcript(
        &self,
        source_workspace_path: &Path,
        source_session_id: &str,
        reference_workspace_path: &Path,
        reference_session_id: &str,
        reference_artifact_stem: &str,
    ) -> OpenBitFunResult<MaterializedSessionReferenceTranscript> {
        Self::validate_session_id(source_session_id)?;
        Self::validate_session_id(reference_session_id)?;
        Self::validate_session_id(reference_artifact_stem)?;
        let _session_write =
            self.lock_session_write_operation(source_workspace_path, source_session_id)?;

        if self
            .load_session_metadata(reference_workspace_path, reference_session_id)
            .await?
            .is_none()
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Referenced session metadata not found: {}",
                reference_session_id
            )));
        }

        let options = SessionTranscriptExportOptions {
            tools: true,
            tool_inputs: true,
            thinking: false,
            turns: None,
        };
        let all_turns = self
            .load_visible_session_turns(reference_workspace_path, reference_session_id)
            .await?;

        // Pick complete turns backwards from the newest one. The first turn
        // is admitted whenever the current total is below the limit, even if
        // that individual turn crosses it; this keeps references coherent.
        let mut selected_indices_reversed = Vec::new();
        let mut selected_turn_chars = 0usize;
        for index in (0..all_turns.len()).rev() {
            if selected_turn_chars >= SESSION_REFERENCE_TRANSCRIPT_CHAR_LIMIT {
                break;
            }
            selected_turn_chars += rendered_turn_char_count(&all_turns[index], &options);
            selected_indices_reversed.push(index);
        }
        selected_indices_reversed.reverse();

        let rendered = render_transcript(&all_turns, &selected_indices_reversed, &options);
        let content = rendered.lines.join("\n");
        let char_count = content.chars().count();
        self.ensure_session_references_dir(source_workspace_path, source_session_id)
            .await?;
        let artifact_path = self.session_reference_transcript_path(
            source_workspace_path,
            source_session_id,
            reference_artifact_stem,
        );
        self.write_text_atomic(&artifact_path, &content).await?;

        Ok(MaterializedSessionReferenceTranscript {
            uri: format!(
                "openbitfun://current-session/artifacts/session-references/{}.txt",
                reference_artifact_stem
            ),
            turn_count: selected_indices_reversed.len(),
            char_count,
            index_range: rendered.index_range,
            latest_turn_range: rendered.index.last().map(|entry| entry.turn_range.clone()),
            line_count: rendered.lines.len(),
        })
    }

    pub async fn delete_turns_after(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<usize> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        #[cfg(feature = "product-search")]
        self.invalidate_session_search(workspace_path, session_id)
            .await;
        let turns = self.load_session_turns(workspace_path, session_id).await?;
        let mut deleted = 0usize;

        for turn in turns
            .into_iter()
            .filter(|value| value.turn_index > turn_index)
        {
            let path = self.turn_path(workspace_path, session_id, turn.turn_index);
            if path.exists() {
                fs::remove_file(&path).await.map_err(|e| {
                    OpenBitFunError::io(format!("Failed to delete turn file: {}", e))
                })?;
                deleted += 1;
            }
        }

        let remaining_turns = self.load_session_turns(workspace_path, session_id).await?;
        if self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .is_some()
        {
            let workspace_path_text = workspace_path.to_string_lossy();
            self.update_session_metadata_if_present_locked(
                workspace_path,
                session_id,
                |metadata| {
                    refresh_session_metadata_from_turns(
                        metadata,
                        workspace_path_text.as_ref(),
                        &remaining_turns,
                        Self::system_time_to_unix_ms(SystemTime::now()),
                    );
                    Ok(())
                },
            )
            .await?;
        }

        if let Err(error) = self
            .persist_complete_session_turn_catalog(workspace_path, session_id, &remaining_turns)
            .await
        {
            warn!(
                "Failed to refresh derived Session Turn catalog after Turn deletion: session_id={} start_turn_index={} error={}",
                session_id,
                turn_index.saturating_add(1),
                error
            );
        }

        Ok(deleted)
    }

    pub async fn delete_turns_from(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<usize> {
        Self::validate_session_id(session_id)?;
        let _session_write = self.lock_session_write_operation(workspace_path, session_id)?;
        let persistence_lock = self
            .get_session_persistence_lock(workspace_path, session_id)
            .await;
        let _persistence_guard = persistence_lock.lock().await;
        #[cfg(feature = "product-search")]
        self.invalidate_session_search(workspace_path, session_id)
            .await;
        let turns = self.load_session_turns(workspace_path, session_id).await?;
        let mut deleted = 0usize;

        for turn in turns
            .into_iter()
            .filter(|value| value.turn_index >= turn_index)
        {
            let path = self.turn_path(workspace_path, session_id, turn.turn_index);
            if path.exists() {
                fs::remove_file(&path).await.map_err(|e| {
                    OpenBitFunError::io(format!("Failed to delete turn file: {}", e))
                })?;
                deleted += 1;
            }
        }

        let remaining_turns = self.load_session_turns(workspace_path, session_id).await?;
        if self
            .load_session_metadata(workspace_path, session_id)
            .await?
            .is_some()
        {
            let workspace_path_text = workspace_path.to_string_lossy();
            self.update_session_metadata_if_present_locked(
                workspace_path,
                session_id,
                |metadata| {
                    refresh_session_metadata_from_turns(
                        metadata,
                        workspace_path_text.as_ref(),
                        &remaining_turns,
                        Self::system_time_to_unix_ms(SystemTime::now()),
                    );
                    Ok(())
                },
            )
            .await?;
        }

        if let Err(error) = self
            .persist_complete_session_turn_catalog(workspace_path, session_id, &remaining_turns)
            .await
        {
            warn!(
                "Failed to refresh derived Session Turn catalog after Turn deletion: session_id={} start_turn_index={} error={}",
                session_id, turn_index, error
            );
        }

        Ok(deleted)
    }

    pub async fn touch_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        self.update_session_metadata_if_present(workspace_path, session_id, |metadata| {
            metadata.touch();
            Ok(())
        })
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_turn_catalog, context_snapshot_payload_stats, current_unix_secs,
        is_well_formed_turn_catalog, placeholder_turn_catalog_entry, truncate_turn_catalog_preview,
        turn_catalog_entry, PendingSessionDirectory, PersistenceManager, StoredDialogTurnFile,
        SESSION_REFERENCE_TRANSCRIPT_CHAR_LIMIT, SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT,
    };
    use crate::agentic::core::{Message, Session, SessionConfig, SessionKind, ToolResult};
    use crate::agentic::memories::db::{MemoryDatabase, MemoryRow, MEMORY_PHASE2_GLOBAL_JOB_KEY};
    use crate::agentic::session::revert::{
        SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
    };
    use crate::agentic::session::{TokenAnchor, TokenAnchorInput};
    use crate::agentic::skill_agent_snapshot::{
        AgentSnapshotEntry, SkillSnapshotEntry, TurnSkillAgentSnapshot,
    };
    use crate::infrastructure::PathManager;
    use crate::service::session::{
        DialogTurnData, ModelRoundData, SessionMemoryMode, SessionMetadata, SessionRelationship,
        SessionRelationshipKind, SessionTranscriptExportOptions, SessionTurnCatalog,
        SessionTurnWindowResponse, StoredSessionIndexFile, TextItemData, UserMessageData,
    };
    use crate::OpenBitFunError;
    use openbitfun_runtime_ports::SessionTurnWindowRequest;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Instant;
    use uuid::Uuid;

    struct TestWorkspace {
        path: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openbitfun-session-transcript-test-{}",
                Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("test workspace should be created");
            // Sessions only exist inside registered workspaces; register the
            // fixture directory like a host that opened this folder. Keep the
            // canonical path so record-derived IO projections compare equal.
            let path = dunce::canonicalize(&path).expect("test workspace should canonicalize");
            crate::service::workspace::legacy_compat::register_local_fixture_blocking(&path);
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn path_manager(&self) -> Arc<PathManager> {
            Arc::new(PathManager::with_user_root_for_tests(
                self.path.join("user-root"),
            ))
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn staged_session_revert_state_round_trips_and_clears_independently() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 2,
            original_turn_end: 5,
            phase: SessionRevertPhase::Staged,
            workspace_checkpoint: Vec::new(),
        };

        manager
            .save_session_revert_state(workspace.path(), "session-1", &state)
            .await
            .expect("staged revert should persist");
        assert_eq!(
            manager
                .load_session_revert_state(workspace.path(), "session-1")
                .await
                .expect("staged revert should load"),
            Some(state)
        );

        manager
            .delete_session_revert_state(workspace.path(), "session-1")
            .await
            .expect("staged revert should clear");
        assert!(manager
            .load_session_revert_state(workspace.path(), "session-1")
            .await
            .expect("cleared staged revert should stay absent")
            .is_none());
    }

    #[tokio::test]
    async fn staged_revert_rejects_overwriting_a_hidden_turn_index() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = "session-hidden-suffix";
        manager
            .save_session_metadata(
                workspace.path(),
                &SessionMetadata::new(
                    session_id.to_string(),
                    "Hidden suffix".to_string(),
                    "Standard".to_string(),
                    "model-a".to_string(),
                ),
            )
            .await
            .expect("session metadata should persist");

        for index in 0..=1 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session_id.to_string(),
                UserMessageData {
                    id: format!("user-{index}"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("fixture turn should persist");
        }
        manager
            .save_session_revert_state(
                workspace.path(),
                session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("staged revert should persist");

        let replacement = DialogTurnData::new(
            "local-command".to_string(),
            1,
            session_id.to_string(),
            UserMessageData {
                id: "local-command-user".to_string(),
                content: "usage report".to_string(),
                timestamp: 3,
                metadata: None,
            },
        );
        let error = manager
            .save_dialog_turn(workspace.path(), &replacement)
            .await
            .expect_err("a staged hidden turn must not be overwritten");
        assert!(
            error.to_string().contains("staged Session suffix"),
            "{error}"
        );

        let preserved = manager
            .load_dialog_turn(workspace.path(), session_id, 1)
            .await
            .expect("hidden turn should remain readable")
            .expect("hidden turn should remain present");
        assert_eq!(preserved.turn_id, "turn-1");
    }

    #[test]
    fn unfinished_session_directory_is_removed_when_creation_is_cancelled() {
        let workspace = TestWorkspace::new();
        let session_dir = workspace.path().join("cancelled-session");
        std::fs::create_dir(&session_dir).expect("claimed session directory");

        drop(PendingSessionDirectory::new(session_dir.clone()));

        assert!(!session_dir.exists());
    }

    #[test]
    fn completed_session_directory_is_kept() {
        let workspace = TestWorkspace::new();
        let session_dir = workspace.path().join("completed-session");
        std::fs::create_dir(&session_dir).expect("claimed session directory");

        PendingSessionDirectory::new(session_dir.clone()).commit();

        assert!(session_dir.exists());
    }

    #[tokio::test]
    async fn unsafe_session_ids_are_rejected_before_turn_path_resolution() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let error = manager
            .load_session_turns(workspace.path(), "../another-project/session")
            .await
            .expect_err("path-like session id must be rejected");

        assert!(error.to_string().contains("session_id"), "{error}");
    }

    #[tokio::test]
    async fn legacy_local_session_identity_is_repaired_after_restart_and_resave() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let mut value = serde_json::to_value(SessionConfig::default()).unwrap();
        value["workspace_path"] = serde_json::json!(workspace.path().to_string_lossy());
        value["remote_ssh_host"] = serde_json::json!("localhost");
        value.as_object_mut().unwrap().remove("workspace_kind");
        let config: SessionConfig = serde_json::from_value(value).unwrap();
        let session = Session::new_with_id(
            "legacy-local-identity".into(),
            "Keep title".into(),
            "Standard".into(),
            config,
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .unwrap();
        drop(manager);
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let restored = manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .unwrap();
        assert_eq!(restored.session_name, "Keep title");
        assert_eq!(
            restored.config.workspace_kind,
            Some(openbitfun_core_types::WorkspaceKind::Normal)
        );
        assert!(restored.config.remote_ssh_host.is_none());
        assert!(!restored.config.is_remote_workspace());
        manager
            .save_session(workspace.path(), &restored)
            .await
            .unwrap();
        drop(manager);
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let again = manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .unwrap();
        assert_eq!(again.config.workspace_kind, restored.config.workspace_kind);
        assert!(again.config.remote_ssh_host.is_none());
    }

    #[tokio::test]
    async fn session_list_preserves_the_persisted_model_selector() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session = Session::new_with_id(
            format!("model-summary-{}", Uuid::new_v4()),
            "Model summary".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                model_id: Some("fast".to_string()),
                reasoning_preset: Some("high".to_string()),
                ..Default::default()
            },
        );

        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should persist");
        let sessions = manager
            .list_sessions(workspace.path())
            .await
            .expect("session list should load");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].model_id.as_deref(), Some("fast"));
        assert_eq!(sessions[0].reasoning_preset.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn concurrent_first_session_persistence_keeps_the_winner() {
        let workspace = TestWorkspace::new();
        let manager_a = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("first persistence manager"),
        );
        let manager_b = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("second persistence manager"),
        );
        let session_id = format!("concurrent-session-{}", Uuid::new_v4());
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };
        let session_a = Session::new_with_id(
            session_id.clone(),
            "First contender".to_string(),
            "agent".to_string(),
            config.clone(),
        );
        let session_b = Session::new_with_id(
            session_id.clone(),
            "Second contender".to_string(),
            "agent".to_string(),
            config,
        );
        let workspace_path = workspace.path().to_path_buf();
        let barrier = Arc::new(tokio::sync::Barrier::new(3));

        let first = tokio::spawn({
            let manager = manager_a.clone();
            let barrier = barrier.clone();
            let workspace_path = workspace_path.clone();
            async move {
                barrier.wait().await;
                let result = manager
                    .create_session_if_absent(&workspace_path, &session_a)
                    .await;
                ("First contender", result)
            }
        });
        let second = tokio::spawn({
            let manager = manager_b.clone();
            let barrier = barrier.clone();
            let workspace_path = workspace_path.clone();
            async move {
                barrier.wait().await;
                let result = manager
                    .create_session_if_absent(&workspace_path, &session_b)
                    .await;
                ("Second contender", result)
            }
        });
        barrier.wait().await;

        let first = first.await.expect("first contender should finish");
        let second = second.await.expect("second contender should finish");
        let outcomes = [first, second];
        let winner = outcomes
            .iter()
            .find_map(|(name, result)| result.is_ok().then_some(*name))
            .expect("one contender must persist the session");
        let failures = outcomes
            .iter()
            .filter_map(|(_, result)| result.as_ref().err())
            .collect::<Vec<_>>();

        assert_eq!(failures.len(), 1, "exactly one contender must fail");
        assert!(matches!(failures[0], OpenBitFunError::Validation(_)));
        let persisted = manager_a
            .load_session(workspace.path(), &session_id)
            .await
            .expect("the winning session must remain persisted");
        assert_eq!(persisted.session_name, winner);
    }

    #[tokio::test]
    async fn token_anchors_save_load_and_delete_roundtrip() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = format!("session-{}", Uuid::new_v4());
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("hello".to_string()),
        ];
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: session_id.clone(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &messages,
        );

        manager
            .save_token_anchors(workspace.path(), &session_id, std::slice::from_ref(&anchor))
            .await
            .expect("token anchors should save");
        let loaded = manager
            .load_token_anchors(workspace.path(), &session_id)
            .await
            .expect("token anchors should load")
            .expect("token anchor file should exist");

        assert_eq!(loaded, vec![anchor]);

        manager
            .delete_token_anchors(workspace.path(), &session_id)
            .await
            .expect("token anchors should delete");
        let loaded_after_delete = manager
            .load_token_anchors(workspace.path(), &session_id)
            .await
            .expect("deleted token anchor load should succeed");

        assert!(loaded_after_delete.is_none());
    }

    #[test]
    fn transcript_turn_selectors_support_head_and_tail_ranges() {
        let selectors = PersistenceManager::parse_transcript_turn_selectors(&[
            ":1".to_string(),
            "-3:".to_string(),
        ])
        .expect("selectors should parse");

        let selected = PersistenceManager::transcript_select_turn_indices(8, &selectors);

        assert_eq!(selected, vec![0, 5, 6, 7]);
    }

    #[test]
    fn transcript_turn_selectors_deduplicate_and_sort_results() {
        let selectors = PersistenceManager::parse_transcript_turn_selectors(&[
            "4".to_string(),
            "2:5".to_string(),
            "-1".to_string(),
        ])
        .expect("selectors should parse");

        let selected = PersistenceManager::transcript_select_turn_indices(6, &selectors);

        assert_eq!(selected, vec![2, 3, 4, 5]);
    }

    #[test]
    fn transcript_turn_selectors_reject_invalid_syntax() {
        let error = PersistenceManager::parse_transcript_turn_selectors(&["1:2:3".to_string()])
            .expect_err("selector should be rejected");

        assert!(
            error.to_string().contains("Invalid turn selector"),
            "unexpected error: {}",
            error
        );
    }

    #[tokio::test]
    async fn export_session_transcript_handles_first_selected_turn_without_panicking() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();

        let metadata = SessionMetadata::new(
            session_id.clone(),
            "Transcript test".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        let user_message = UserMessageData {
            id: "user-1".to_string(),
            content: "hello transcript".to_string(),
            timestamp: 0,
            metadata: None,
        };
        let mut turn =
            DialogTurnData::new("turn-1".to_string(), 0, session_id.clone(), user_message);
        turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");
        let mut hidden_turn = DialogTurnData::new(
            "turn-hidden".to_string(),
            1,
            session_id.clone(),
            UserMessageData {
                id: "user-hidden".to_string(),
                content: "hidden transcript payload".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        hidden_turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &hidden_turn)
            .await
            .expect("hidden turn should save");
        manager
            .save_session_revert_state(
                workspace.path(),
                &session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("staged marker should save");

        let export = manager
            .export_session_transcript(
                workspace.path(),
                &session_id,
                &SessionTranscriptExportOptions::default(),
            )
            .await
            .expect("transcript export should succeed");

        assert_eq!(export.turn_count, 1);
        assert_eq!(export.index.len(), 1);

        let transcript = std::fs::read_to_string(&export.transcript_path)
            .expect("transcript file should be readable");
        assert!(transcript.contains("## Turn 0"));
        assert!(transcript.contains("hello transcript"));
        assert!(!transcript.contains("hidden transcript payload"));

        let selected = manager
            .export_session_transcript(
                workspace.path(),
                &session_id,
                &SessionTranscriptExportOptions {
                    turns: Some(vec!["-1".to_string()]),
                    ..Default::default()
                },
            )
            .await
            .expect("visible-relative transcript selection should succeed");
        assert_eq!(selected.turn_count, 1);
        let selected_transcript = std::fs::read_to_string(&selected.transcript_path)
            .expect("selected transcript should be readable");
        assert!(selected_transcript.contains("hello transcript"));
        assert!(!selected_transcript.contains("hidden transcript payload"));
    }

    #[tokio::test]
    async fn materialized_session_reference_keeps_newest_complete_turn_and_overwrites_artifact() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let source_session_id = Uuid::new_v4().to_string();
        let reference_session_id = Uuid::new_v4().to_string();
        let reference_artifact_stem = reference_session_id.chars().take(8).collect::<String>();
        let metadata = SessionMetadata::new(
            reference_session_id.clone(),
            "Referenced transcript".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("reference metadata should save");

        let mut older_turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            reference_session_id.clone(),
            user_message("older prompt"),
        );
        older_turn.model_rounds.push(round_with_text(
            "turn-0",
            vec![text_item("text-0", "older response")],
        ));
        older_turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &older_turn)
            .await
            .expect("older turn should save");

        let mut newest_turn = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            reference_session_id.clone(),
            user_message("newest prompt"),
        );
        newest_turn.model_rounds.push(round_with_text(
            "turn-1",
            vec![text_item(
                "text-1",
                &"x".repeat(SESSION_REFERENCE_TRANSCRIPT_CHAR_LIMIT + 1),
            )],
        ));
        newest_turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &newest_turn)
            .await
            .expect("newest turn should save");

        let first = manager
            .materialize_session_reference_transcript(
                workspace.path(),
                &source_session_id,
                workspace.path(),
                &reference_session_id,
                &reference_artifact_stem,
            )
            .await
            .expect("reference should materialize");
        assert_eq!(first.turn_count, 1);
        assert!(first.char_count > SESSION_REFERENCE_TRANSCRIPT_CHAR_LIMIT);
        assert!(first.latest_turn_range.is_some());
        assert_eq!(
            first.line_count,
            first.latest_turn_range.as_ref().unwrap().end_line
        );
        assert_eq!(
            first.uri,
            format!(
                "openbitfun://current-session/artifacts/session-references/{}.txt",
                reference_artifact_stem
            )
        );
        let artifact_path = manager.session_reference_transcript_path(
            workspace.path(),
            &source_session_id,
            &reference_artifact_stem,
        );
        let first_content =
            std::fs::read_to_string(&artifact_path).expect("reference artifact should be readable");
        assert!(first_content.contains("## Turn 1"));
        assert!(!first_content.contains("## Turn 0"));

        manager
            .delete_turns_after(workspace.path(), &reference_session_id, 0)
            .await
            .expect("newest reference turn should delete");
        let second = manager
            .materialize_session_reference_transcript(
                workspace.path(),
                &source_session_id,
                workspace.path(),
                &reference_session_id,
                &reference_artifact_stem,
            )
            .await
            .expect("reference should overwrite");
        assert_eq!(second.turn_count, 1);
        let second_content = std::fs::read_to_string(&artifact_path)
            .expect("overwritten reference artifact should be readable");
        assert!(second_content.contains("## Turn 0"));
        assert!(!second_content.contains("## Turn 1"));
    }

    #[tokio::test]
    async fn load_session_tail_turns_returns_latest_turns_in_chronological_order() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let metadata = SessionMetadata::new(
            session_id.clone(),
            "Tail turns test".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        for index in 0..5 {
            let user_message = UserMessageData {
                id: format!("user-{index}"),
                content: format!("prompt {index}"),
                timestamp: index as u64,
                metadata: None,
            };
            let mut turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session_id.clone(),
                user_message,
            );
            turn.mark_completed();
            manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        let tail = manager
            .load_session_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail turns should load");

        let turn_indices = tail.iter().map(|turn| turn.turn_index).collect::<Vec<_>>();
        let prompts = tail
            .iter()
            .map(|turn| turn.user_message.content.as_str())
            .collect::<Vec<_>>();

        assert_eq!(turn_indices, vec![3, 4]);
        assert_eq!(prompts, vec!["prompt 3", "prompt 4"]);

        let (_session, view_tail, total_turn_count) = manager
            .load_session_with_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail view should load");
        let view_turn_indices = view_tail
            .iter()
            .map(|turn| turn.turn_index)
            .collect::<Vec<_>>();

        assert_eq!(view_turn_indices, vec![3, 4]);
        assert_eq!(total_turn_count, 5);
    }

    #[tokio::test]
    async fn load_session_tail_turns_uses_metadata_turn_count_as_normal_path_boundary() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let metadata = SessionMetadata::new(
            session_id.clone(),
            "Tail turns boundary test".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        for index in 0..5 {
            let user_message = UserMessageData {
                id: format!("user-{index}"),
                content: format!("prompt {index}"),
                timestamp: index as u64,
                metadata: None,
            };
            let mut turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session_id.clone(),
                user_message,
            );
            turn.mark_completed();
            manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        let orphan_user_message = UserMessageData {
            id: "user-99".to_string(),
            content: "orphan prompt".to_string(),
            timestamp: 99,
            metadata: None,
        };
        let mut orphan_turn = DialogTurnData::new(
            "turn-99".to_string(),
            99,
            session_id.clone(),
            orphan_user_message,
        );
        orphan_turn.mark_completed();
        let orphan_file = StoredDialogTurnFile {
            schema_version: super::SESSION_STORAGE_SCHEMA_VERSION,
            turn: orphan_turn,
        };
        let orphan_json =
            serde_json::to_string_pretty(&orphan_file).expect("orphan turn should serialize");
        std::fs::write(
            manager.turn_path(workspace.path(), &session_id, 99),
            orphan_json,
        )
        .expect("orphan turn should be written");

        let tail = manager
            .load_session_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail turns should load");

        let turn_indices = tail.iter().map(|turn| turn.turn_index).collect::<Vec<_>>();
        let prompts = tail
            .iter()
            .map(|turn| turn.user_message.content.as_str())
            .collect::<Vec<_>>();

        assert_eq!(turn_indices, vec![3, 4]);
        assert_eq!(prompts, vec!["prompt 3", "prompt 4"]);

        let (_session, view_tail, total_turn_count) = manager
            .load_session_with_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail view should load");
        let view_turn_indices = view_tail
            .iter()
            .map(|turn| turn.turn_index)
            .collect::<Vec<_>>();

        assert_eq!(view_turn_indices, vec![3, 4]);
        assert_eq!(total_turn_count, 5);
    }

    #[tokio::test]
    async fn load_session_with_turns_returns_session_and_persisted_turns() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Load once".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let user_message = UserMessageData {
            id: "user-1".to_string(),
            content: "hello once".to_string(),
            timestamp: 0,
            metadata: None,
        };
        let mut turn =
            DialogTurnData::new("turn-1".to_string(), 0, session_id.clone(), user_message);
        turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");

        let (loaded_session, loaded_turns) = manager
            .load_session_with_turns(workspace.path(), &session_id)
            .await
            .expect("session and turns should load together");

        assert_eq!(loaded_session.dialog_turn_ids, vec!["turn-1".to_string()]);
        assert_eq!(loaded_turns.len(), 1);
        assert_eq!(loaded_turns[0].turn_id, "turn-1");
    }

    fn user_message(content: &str) -> UserMessageData {
        UserMessageData {
            id: format!("user-{}", content),
            content: content.to_string(),
            timestamp: 0,
            metadata: None,
        }
    }

    fn text_item(id: &str, content: &str) -> TextItemData {
        TextItemData {
            id: id.to_string(),
            content: content.to_string(),
            is_streaming: false,
            timestamp: 0,
            is_markdown: true,
            order_index: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            status: None,
            attempt_id: None,
            attempt_index: None,
        }
    }

    fn round_with_text(turn_id: &str, text_items: Vec<TextItemData>) -> ModelRoundData {
        ModelRoundData {
            id: format!("round-{}", turn_id),
            turn_id: turn_id.to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 0,
            text_items,
            tool_items: Vec::new(),
            thinking_items: Vec::new(),
            start_time: 0,
            end_time: Some(0),
            duration_ms: Some(0),
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        }
    }

    #[test]
    fn turn_catalog_preview_truncates_on_unicode_scalar_boundaries() {
        let content = "界".repeat(SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT + 1);
        let (preview, truncated) = truncate_turn_catalog_preview(&content);

        assert_eq!(
            preview.chars().count(),
            SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT
        );
        assert!(truncated);
        assert!(preview.is_char_boundary(preview.len()));

        let exact = "🙂".repeat(SESSION_TURN_CATALOG_PREVIEW_CHAR_LIMIT);
        let (preview, truncated) = truncate_turn_catalog_preview(&exact);
        assert_eq!(preview, exact);
        assert!(!truncated);
    }

    #[test]
    fn turn_rail_capsule_preview_keeps_only_display_facts() {
        let mut turn = DialogTurnData::new(
            "turn-capsule".to_string(),
            0,
            "session-capsule".to_string(),
            UserMessageData {
                id: "user-capsule".to_string(),
                content: "[$pdf] #file: auth.ts".to_string(),
                timestamp: 0,
                metadata: Some(serde_json::json!({
                    "composerPresentation": {
                        "version": 1,
                        "segments": [
                            { "kind": "inline-token", "token": "[$pdf]", "tokenType": "skill", "label": "pdf" },
                            { "kind": "text", "text": " " },
                            {
                                "kind": "context",
                                "context": {
                                    "id": "file-1",
                                    "type": "file",
                                    "filePath": "E:/workspace/auth.ts",
                                    "fileName": "auth.ts",
                                    "selectedText": "large secret payload that must not enter catalog"
                                },
                                "tag": "#file: auth.ts",
                                "label": "auth.ts",
                                "title": "E:/workspace/auth.ts"
                            }
                        ]
                    }
                })),
            },
        );
        let entry = turn_catalog_entry(&turn, 0);
        let preview = entry.capsule_preview.expect("capsule preview");
        assert_eq!(preview.segments.len(), 3);
        let encoded = serde_json::to_string(&preview).expect("preview should serialize");
        let encoded_json: serde_json::Value =
            serde_json::from_str(&encoded).expect("preview JSON should parse");
        assert_eq!(encoded_json["segments"][0]["kind"], "inlineToken");
        assert_eq!(encoded_json["segments"][0]["tokenType"], "skill");
        assert!(encoded_json["segments"][0].get("token_type").is_none());
        assert_eq!(encoded_json["segments"][2]["kind"], "context");
        assert_eq!(encoded_json["segments"][2]["contextType"], "file");
        assert!(encoded_json["segments"][2].get("context_type").is_none());
        assert!(encoded.contains("auth.ts"));
        assert!(!encoded.contains("large secret payload"));
        assert!(!encoded.contains("filePath"));
        turn.user_message.metadata = None;
        assert!(turn_catalog_entry(&turn, 0).capsule_preview.is_none());
    }

    #[tokio::test]
    async fn turn_catalog_sidecar_is_complete_idempotent_and_truncates_with_turns() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Catalog persistence".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let turn_0 = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("first prompt"),
        );
        let turn_1 = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            session_id.clone(),
            user_message("second prompt"),
        );
        manager
            .save_dialog_turn(workspace.path(), &turn_0)
            .await
            .expect("first turn should save");
        manager
            .save_dialog_turn(workspace.path(), &turn_1)
            .await
            .expect("second turn should save");

        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        let catalog: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("catalog should be readable"),
        )
        .expect("catalog should deserialize");
        assert!(catalog.complete);
        assert_eq!(catalog.total_turn_count, 2);
        assert_eq!(catalog.entries[0].turn_id.as_deref(), Some("turn-0"));
        assert_eq!(catalog.entries[1].preview.as_deref(), Some("second prompt"));

        let serialized_with_trailing_whitespace = format!(
            "{}\n ",
            std::fs::read_to_string(&catalog_path).expect("catalog should be readable")
        );
        std::fs::write(&catalog_path, &serialized_with_trailing_whitespace)
            .expect("catalog whitespace fixture should write");
        manager
            .save_dialog_turn(workspace.path(), &turn_1)
            .await
            .expect("repeated save should succeed");
        assert_eq!(
            std::fs::read_to_string(&catalog_path).expect("catalog should remain readable"),
            serialized_with_trailing_whitespace,
            "unchanged user input must not rewrite the catalog during streaming checkpoints"
        );

        manager
            .delete_dialog_turns_from(workspace.path(), &session_id, 1)
            .await
            .expect("turn suffix should delete");
        let catalog: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("truncated catalog should be readable"),
        )
        .expect("truncated catalog should deserialize");
        assert!(catalog.complete);
        assert_eq!(catalog.total_turn_count, 1);
        assert_eq!(catalog.entries[0].turn_id.as_deref(), Some("turn-0"));
    }

    #[tokio::test]
    async fn turn_catalog_restore_projects_placeholders_and_repairs_from_loaded_turns() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Catalog restore".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        for index in 0..5 {
            manager
                .save_dialog_turn(
                    workspace.path(),
                    &DialogTurnData::new(
                        format!("turn-{index}"),
                        index,
                        session_id.clone(),
                        user_message(&format!("prompt {index}")),
                    ),
                )
                .await
                .expect("turn should save");
        }

        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        std::fs::remove_file(&catalog_path).expect("legacy fixture should omit catalog");
        let tail = manager
            .load_session_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail turns should load");
        let catalog = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &tail, 5)
            .await
            .expect("partial catalog should load");
        assert!(!catalog.complete);
        assert_eq!(catalog.total_turn_count, 5);
        assert!(catalog.entries[..3]
            .iter()
            .all(|entry| entry.turn_id.is_none() && entry.preview.is_none()));
        assert_eq!(catalog.entries[3].turn_id.as_deref(), Some("turn-3"));
        assert_eq!(catalog.entries[4].preview.as_deref(), Some("prompt 4"));
        let persisted_tail: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path)
                .expect("tail repair should create the catalog sidecar"),
        )
        .expect("tail-repaired catalog should deserialize");
        assert_eq!(persisted_tail, catalog);

        std::fs::write(&catalog_path, "{ not valid json")
            .expect("corrupt catalog fixture should write");
        let fallback = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &tail, 5)
            .await
            .expect("corrupt catalog should fall back safely");
        assert_eq!(fallback, catalog);
        let repaired_fallback: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path)
                .expect("corrupt catalog should be repaired during restore"),
        )
        .expect("repaired catalog should deserialize");
        assert_eq!(repaired_fallback, catalog);

        let all_turns = manager
            .load_session_turns(workspace.path(), &session_id)
            .await
            .expect("full history should load");
        let complete = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &all_turns, 5)
            .await
            .expect("loaded turns should repair catalog projection");
        assert!(complete.complete);
        assert_eq!(complete.entries.len(), 5);
        assert_eq!(complete.entries[0].turn_id.as_deref(), Some("turn-0"));
        let persisted_complete: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path)
                .expect("full restore should persist the complete catalog"),
        )
        .expect("complete catalog should deserialize");
        assert_eq!(persisted_complete, complete);
    }

    #[tokio::test]
    async fn legacy_turn_catalog_window_avoids_synthetic_stale_and_persists_loaded_metadata() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Legacy catalog window".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        for index in 0..6 {
            manager
                .save_dialog_turn(
                    workspace.path(),
                    &DialogTurnData::new(
                        format!("turn-{index}"),
                        index,
                        session_id.clone(),
                        user_message(&format!("prompt {index}")),
                    ),
                )
                .await
                .expect("turn should save");
        }

        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        std::fs::remove_file(&catalog_path).expect("legacy fixture should omit catalog");
        let tail = manager
            .load_session_tail_turns(workspace.path(), &session_id, 2)
            .await
            .expect("tail turns should load");
        let initial_catalog = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &tail, 6)
            .await
            .expect("legacy catalog should project");
        assert!(initial_catalog.entries[1].turn_id.is_none());
        assert_eq!(
            initial_catalog.entries[4].turn_id.as_deref(),
            Some("turn-4")
        );

        let response = manager
            .load_session_turn_window(&SessionTurnWindowRequest {
                workspace_path: workspace.path().to_path_buf(),
                session_id: session_id.clone(),
                include_internal: false,
                target_storage_turn_index: 1,
                expected_turn_id: None,
                expected_catalog_revision: Some(initial_catalog.revision.clone()),
                before: 0,
                after: 1,
            })
            .await
            .expect("legacy window should load without a retry");
        assert!(matches!(
            response,
            SessionTurnWindowResponse::Ready {
                target_turn_id,
                ..
            } if target_turn_id == "turn-1"
        ));

        let repaired: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path)
                .expect("window metadata should persist to the catalog sidecar"),
        )
        .expect("window-repaired catalog should deserialize");
        assert_eq!(repaired.revision, initial_catalog.revision);
        assert_eq!(repaired.entries[1].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(repaired.entries[1].preview.as_deref(), Some("prompt 1"));
        assert_eq!(repaired.entries[4].turn_id.as_deref(), Some("turn-4"));
        assert!(!repaired.complete);

        let reopened = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &tail, 6)
            .await
            .expect("reopened catalog should retain repaired metadata");
        assert_eq!(reopened.entries[1].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(reopened.entries[1].preview.as_deref(), Some("prompt 1"));
    }

    #[tokio::test]
    async fn turn_catalog_restore_does_not_persist_padded_missing_file_indices() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Catalog missing file".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        let turns = (0..3)
            .map(|index| {
                DialogTurnData::new(
                    format!("turn-{index}"),
                    index,
                    session_id.clone(),
                    user_message(&format!("prompt {index}")),
                )
            })
            .collect::<Vec<_>>();
        for turn in &turns {
            manager
                .save_dialog_turn(workspace.path(), turn)
                .await
                .expect("turn should save");
        }

        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        std::fs::remove_file(&catalog_path).expect("fixture should omit catalog");
        std::fs::remove_file(manager.turn_path(workspace.path(), &session_id, 1))
            .expect("fixture should omit one Turn file");

        let projected = manager
            .load_session_turn_catalog(
                workspace.path(),
                &session_id,
                std::slice::from_ref(&turns[2]),
                3,
            )
            .await
            .expect("missing file catalog should still project safely");

        assert_eq!(projected.total_turn_count, 3);
        assert!(!catalog_path.exists());
    }

    #[tokio::test]
    async fn incomplete_turn_catalog_repairs_saved_entries_without_rebuilding_placeholders() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Incremental catalog repair".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let turns = (0..5)
            .map(|index| {
                DialogTurnData::new(
                    format!("turn-{index}"),
                    index,
                    session_id.clone(),
                    user_message(&format!("prompt {index}")),
                )
            })
            .collect::<Vec<_>>();
        for turn in &turns {
            manager
                .save_dialog_turn(workspace.path(), turn)
                .await
                .expect("turn should save");
        }

        let incomplete = build_turn_catalog(
            &session_id,
            turns
                .iter()
                .enumerate()
                .map(|(ordinal, turn)| {
                    if ordinal < 3 {
                        placeholder_turn_catalog_entry(turn.turn_index, ordinal)
                    } else {
                        turn_catalog_entry(turn, ordinal)
                    }
                })
                .collect(),
        );
        assert!(!incomplete.complete);
        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        manager
            .write_json_atomic(&catalog_path, &incomplete)
            .await
            .expect("incomplete catalog fixture should save");

        let updated_turn = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            session_id.clone(),
            user_message("updated prompt 1"),
        );
        manager
            .save_dialog_turn(workspace.path(), &updated_turn)
            .await
            .expect("existing turn should update");

        let repaired: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("catalog should be readable"),
        )
        .expect("catalog should deserialize");
        assert!(is_well_formed_turn_catalog(&repaired));
        assert!(!repaired.complete);
        assert_eq!(repaired.total_turn_count, 5);
        assert!(repaired.entries[0].turn_id.is_none());
        assert_eq!(repaired.entries[1].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            repaired.entries[1].preview.as_deref(),
            Some("updated prompt 1")
        );
        assert!(repaired.entries[2].preview.is_none());
        assert_eq!(repaired.entries[4].turn_id.as_deref(), Some("turn-4"));

        let appended_turn = DialogTurnData::new(
            "turn-5".to_string(),
            5,
            session_id.clone(),
            user_message("prompt 5"),
        );
        manager
            .save_dialog_turn(workspace.path(), &appended_turn)
            .await
            .expect("new tail turn should append");

        let appended: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("catalog should be readable"),
        )
        .expect("catalog should deserialize");
        assert!(is_well_formed_turn_catalog(&appended));
        assert!(!appended.complete);
        assert_eq!(appended.total_turn_count, 6);
        assert!(appended.entries[0].turn_id.is_none());
        assert!(appended.entries[2].preview.is_none());
        assert_eq!(appended.entries[5].turn_id.as_deref(), Some("turn-5"));
        assert_eq!(appended.entries[5].preview.as_deref(), Some("prompt 5"));
    }

    #[tokio::test]
    async fn misaligned_incomplete_turn_catalog_falls_back_to_full_rebuild() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Catalog rebuild fallback".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let turns = (0..3)
            .map(|index| {
                DialogTurnData::new(
                    format!("turn-{index}"),
                    index,
                    session_id.clone(),
                    user_message(&format!("prompt {index}")),
                )
            })
            .collect::<Vec<_>>();
        for turn in &turns {
            manager
                .save_dialog_turn(workspace.path(), turn)
                .await
                .expect("turn should save");
        }

        let misaligned = build_turn_catalog(
            &session_id,
            vec![
                placeholder_turn_catalog_entry(0, 0),
                placeholder_turn_catalog_entry(2, 1),
            ],
        );
        assert!(!misaligned.complete);
        let catalog_path = manager.turn_catalog_path(workspace.path(), &session_id);
        manager
            .write_json_atomic(&catalog_path, &misaligned)
            .await
            .expect("misaligned catalog fixture should save");

        manager
            .save_dialog_turn(workspace.path(), &turns[0])
            .await
            .expect("saved turn should trigger safe fallback");

        let rebuilt: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("catalog should be readable"),
        )
        .expect("catalog should deserialize");
        assert!(is_well_formed_turn_catalog(&rebuilt));
        assert!(rebuilt.complete);
        assert_eq!(rebuilt.total_turn_count, 3);
        assert_eq!(rebuilt.entries[0].storage_turn_index, 0);
        assert_eq!(rebuilt.entries[1].storage_turn_index, 1);
        assert_eq!(rebuilt.entries[2].storage_turn_index, 2);
        assert_eq!(rebuilt.entries[2].preview.as_deref(), Some("prompt 2"));
    }

    #[tokio::test]
    async fn staged_revert_catalog_projection_hides_the_physical_suffix() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Catalog staged revert".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        let visible_turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("visible"),
        );
        let hidden_turn = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            session_id.clone(),
            user_message("hidden"),
        );
        manager
            .save_dialog_turn(workspace.path(), &visible_turn)
            .await
            .expect("visible turn should save");
        manager
            .save_dialog_turn(workspace.path(), &hidden_turn)
            .await
            .expect("hidden turn should save before staging");
        manager
            .save_session_revert_state(
                workspace.path(),
                &session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("staged revert should save");

        let projected = manager
            .load_session_turn_catalog(
                workspace.path(),
                &session_id,
                std::slice::from_ref(&visible_turn),
                1,
            )
            .await
            .expect("visible catalog should project");
        assert_eq!(projected.total_turn_count, 1);
        assert_eq!(projected.entries[0].turn_id.as_deref(), Some("turn-0"));

        let physical: SessionTurnCatalog = serde_json::from_str(
            &std::fs::read_to_string(manager.turn_catalog_path(workspace.path(), &session_id))
                .expect("physical catalog should remain readable"),
        )
        .expect("physical catalog should deserialize");
        assert_eq!(physical.total_turn_count, 2);
        assert_eq!(physical.entries[1].turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn turn_window_is_bounded_revision_aware_and_staged_revert_safe() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Turn window".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        for index in 0..30 {
            manager
                .save_dialog_turn(
                    workspace.path(),
                    &DialogTurnData::new(
                        format!("turn-{index}"),
                        index,
                        session_id.clone(),
                        user_message(&format!("prompt {index}")),
                    ),
                )
                .await
                .expect("turn should save");
        }

        let catalog = manager
            .load_session_turn_catalog(workspace.path(), &session_id, &[], 30)
            .await
            .expect("catalog should load");
        let request = SessionTurnWindowRequest {
            workspace_path: workspace.path().to_path_buf(),
            session_id: session_id.clone(),
            include_internal: false,
            target_storage_turn_index: 10,
            expected_turn_id: Some("turn-10".to_string()),
            expected_catalog_revision: Some(catalog.revision.clone()),
            before: usize::MAX,
            after: usize::MAX,
        };

        let ready = manager
            .load_session_turn_window(&request)
            .await
            .expect("window should load");
        match ready {
            SessionTurnWindowResponse::Ready {
                catalog_revision,
                total_turn_count,
                start_ordinal,
                end_ordinal_exclusive,
                target_turn_id,
                turns,
            } => {
                assert_eq!(catalog_revision, catalog.revision);
                assert_eq!(total_turn_count, 30);
                assert_eq!(start_ordinal, 6);
                assert_eq!(end_ordinal_exclusive, 22);
                assert_eq!(target_turn_id, "turn-10");
                assert_eq!(turns.len(), 16);
                assert_eq!(turns.first().map(|turn| turn.turn_index), Some(6));
                assert_eq!(turns.last().map(|turn| turn.turn_index), Some(21));
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let mut stale_revision_request = request.clone();
        stale_revision_request.expected_catalog_revision = Some("obsolete".to_string());
        assert!(matches!(
            manager
                .load_session_turn_window(&stale_revision_request)
                .await
                .expect("stale revision should be structured"),
            SessionTurnWindowResponse::Stale { .. }
        ));

        let mut stale_turn_request = request.clone();
        stale_turn_request.expected_turn_id = Some("replaced-turn".to_string());
        assert!(matches!(
            manager
                .load_session_turn_window(&stale_turn_request)
                .await
                .expect("stale Turn ID should be structured"),
            SessionTurnWindowResponse::Stale { .. }
        ));

        manager
            .save_session_revert_state(
                workspace.path(),
                &session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 8,
                    original_turn_end: 30,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("staged revert should save");
        let hidden = manager
            .load_session_turn_window(&SessionTurnWindowRequest {
                expected_catalog_revision: None,
                ..request
            })
            .await
            .expect("hidden target should be structured");
        match hidden {
            SessionTurnWindowResponse::NotFound { catalog } => {
                assert_eq!(catalog.total_turn_count, 8);
                assert!(catalog
                    .entries
                    .iter()
                    .all(|entry| entry.storage_turn_index < 8));
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[test]
    fn compression_transcript_file_name_parser_is_strict() {
        assert_eq!(
            PersistenceManager::compression_transcript_boundary_from_file_name("12-a3f9.txt"),
            Some(12)
        );
        assert_eq!(
            PersistenceManager::compression_transcript_boundary_from_file_name("12-a3f9.meta.json"),
            Some(12)
        );

        for invalid in [
            "12-A3F9.txt",
            "12-a3f.txt",
            "12-a3f90.txt",
            "12-a3f9.txt.bak",
            "-1-a3f9.txt",
            "a3f9.txt",
            "12-a3f9.json",
        ] {
            assert_eq!(
                PersistenceManager::compression_transcript_boundary_from_file_name(invalid),
                None,
                "unexpectedly accepted {invalid}"
            );
        }
    }

    #[tokio::test]
    async fn compression_transcripts_are_stable_unique_and_rollback_aware() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Compression transcripts".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        for turn_index in 0..=2 {
            let turn_id = format!("turn-{}", turn_index);
            let mut turn = DialogTurnData::new(
                turn_id.clone(),
                turn_index,
                session_id.clone(),
                user_message(&format!("user {}", turn_index)),
            );
            let mut current_text = text_item(
                &format!("text-{}", turn_index),
                &format!("assistant {}", turn_index),
            );
            let mut text_items = Vec::new();
            if turn_index == 0 {
                let mut superseded_text = text_item("text-0-attempt-1", "superseded assistant 0");
                superseded_text.attempt_id = Some(format!("{turn_id}:attempt:1"));
                superseded_text.attempt_index = Some(1);
                text_items.push(superseded_text);

                current_text.attempt_id = Some(format!("{turn_id}:attempt:2"));
                current_text.attempt_index = Some(2);
            }
            text_items.push(current_text);

            let mut round = round_with_text(&turn_id, text_items);
            if turn_index == 0 {
                round.attempt_count = Some(2);
            }
            turn.model_rounds.push(round);
            turn.mark_completed();
            manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        let first = manager
            .create_compression_transcript(
                workspace.path(),
                &session_id,
                1,
                "compression-first",
                "auto",
            )
            .await
            .expect("first transcript should create")
            .expect("persisted turns should produce a transcript");
        let second = manager
            .create_compression_transcript(
                workspace.path(),
                &session_id,
                2,
                "compression-second",
                "manual",
            )
            .await
            .expect("second transcript should create")
            .expect("persisted turns should produce a transcript");

        assert_ne!(first.transcript_path, second.transcript_path);
        assert!(first
            .uri
            .starts_with("openbitfun://current-session/artifacts/compression-transcripts/1-"));
        assert!(second
            .uri
            .starts_with("openbitfun://current-session/artifacts/compression-transcripts/2-"));
        assert_eq!(first.index_range.start_line, 1);
        assert_eq!(first.index_range.end_line, 3);
        assert_eq!(second.index_range.start_line, 1);
        assert_eq!(second.index_range.end_line, 4);
        assert!(first.transcript_path.exists());
        assert!(first.meta_path.exists());
        assert!(second.transcript_path.exists());
        assert!(second.meta_path.exists());
        assert_ne!(
            first.transcript_path,
            manager.transcript_path(workspace.path(), &session_id)
        );

        let transcript = std::fs::read_to_string(&first.transcript_path)
            .expect("compression transcript should be readable");
        assert!(transcript.contains("## Turn 0\n[user]\nuser 0\n[/user]"));
        assert!(transcript.contains("[assistant step=0]\nassistant 0\n[/assistant]"));
        assert!(!transcript.contains("superseded assistant 0"));
        assert!(transcript.contains("## Turn 1"));
        assert!(!transcript.contains("## Turn 2"));
        assert!(!transcript.contains("[assistant_round"));
        assert!(!transcript.contains("[text]"));
        let metadata: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&first.meta_path).expect("metadata should be readable"),
        )
        .expect("metadata should be valid JSON");
        assert_eq!(metadata["boundaryTurnIndex"], 1);
        assert_eq!(metadata["compressionId"], "compression-first");
        assert_eq!(metadata["options"]["tools"], true);
        assert_eq!(metadata["options"]["toolInputs"], true);
        assert_eq!(metadata["options"]["thinking"], false);

        std::fs::write(
            manager
                .compression_transcripts_dir(workspace.path(), &session_id)
                .join("not-owned.txt"),
            "keep",
        )
        .expect("malformed artifact should save");
        let deleted = manager
            .delete_compression_transcripts_from(workspace.path(), &session_id, 2)
            .await
            .expect("rollback cleanup should succeed");
        assert_eq!(deleted, 2);
        assert!(first.transcript_path.exists());
        assert!(first.meta_path.exists());
        assert!(!second.transcript_path.exists());
        assert!(!second.meta_path.exists());
        assert!(manager
            .compression_transcripts_dir(workspace.path(), &session_id)
            .join("not-owned.txt")
            .exists());
    }

    #[tokio::test]
    async fn metadata_patch_and_turn_save_share_one_read_modify_write_lock() {
        let workspace = TestWorkspace::new();
        let manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Concurrent metadata".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let metadata_lock = manager
            .get_session_persistence_lock(workspace.path(), &session_id)
            .await;
        let metadata_guard = metadata_lock.lock().await;
        let workspace_path = workspace.path().to_path_buf();

        let patch_task = tokio::spawn({
            let manager = manager.clone();
            let workspace_path = workspace_path.clone();
            let session_id = session_id.clone();
            async move {
                manager
                    .update_session_metadata(&workspace_path, &session_id, |metadata| {
                        metadata.agent_type = "Cowork".to_string();
                    })
                    .await
            }
        });

        let mut turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("concurrent turn"),
        );
        turn.mark_completed();
        let turn_task = tokio::spawn({
            let manager = manager.clone();
            let workspace_path = workspace_path.clone();
            async move { manager.save_dialog_turn(&workspace_path, &turn).await }
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!patch_task.is_finished());
        assert!(!turn_task.is_finished());
        drop(metadata_guard);

        patch_task
            .await
            .expect("metadata patch task should join")
            .expect("metadata patch should save");
        turn_task
            .await
            .expect("turn save task should join")
            .expect("turn should save");

        let metadata = manager
            .load_session_metadata(&workspace_path, &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.agent_type, "Cowork");
        assert_eq!(metadata.turn_count, 1);
    }

    #[tokio::test]
    async fn save_dialog_turn_updates_metadata_without_scanning_unrelated_turn_files() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Incremental metadata".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let mut turn_0 = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("first"),
        );
        turn_0.model_rounds.push(round_with_text(
            "turn-0",
            vec![text_item("text-0", "first response")],
        ));
        turn_0.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn_0)
            .await
            .expect("first turn should save");

        let mut turn_1 = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            session_id.clone(),
            user_message("second"),
        );
        turn_1.model_rounds.push(round_with_text(
            "turn-1",
            vec![text_item("text-1", "second response")],
        ));
        turn_1.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn_1)
            .await
            .expect("second turn should save");

        std::fs::write(
            manager.turn_path(workspace.path(), &session_id, 0),
            "{ not valid json",
        )
        .expect("old turn file should be replaceable for test");

        turn_1.model_rounds[0]
            .text_items
            .push(text_item("text-2", "additional response"));
        manager
            .save_dialog_turn(workspace.path(), &turn_1)
            .await
            .expect("saving current turn should not scan unrelated old turn files");

        let metadata = manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.turn_count, 2);
        assert_eq!(metadata.message_count, 5);
    }

    #[tokio::test]
    async fn turn_deletion_waits_for_the_session_metadata_transaction() {
        let workspace = TestWorkspace::new();
        let manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Transactional deletion".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        let mut turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("turn to delete"),
        );
        turn.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");

        let metadata_lock = manager
            .get_session_persistence_lock(workspace.path(), &session_id)
            .await;
        let metadata_guard = metadata_lock.lock().await;
        let turn_path = manager.turn_path(workspace.path(), &session_id, 0);
        let delete_task = tokio::spawn({
            let manager = manager.clone();
            let workspace_path = workspace.path().to_path_buf();
            let session_id = session_id.clone();
            async move {
                manager
                    .delete_turns_from(&workspace_path, &session_id, 0)
                    .await
            }
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            turn_path.exists(),
            "turn files must not change before the metadata transaction is acquired"
        );
        assert!(!delete_task.is_finished());
        drop(metadata_guard);

        assert_eq!(
            delete_task
                .await
                .expect("delete task should join")
                .expect("delete should succeed"),
            1
        );
        assert!(!turn_path.exists());
        let metadata = manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.turn_count, 0);
    }

    #[tokio::test]
    async fn whole_session_deletion_waits_for_the_persistence_transaction() {
        let workspace = TestWorkspace::new();
        let manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Transactional session deletion".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let persistence_lock = manager
            .get_session_persistence_lock(workspace.path(), &session_id)
            .await;
        let persistence_guard = persistence_lock.lock().await;
        let session_dir = manager
            .session_layout(workspace.path())
            .session_dir(&session_id);
        let delete_task = tokio::spawn({
            let manager = manager.clone();
            let workspace_path = workspace.path().to_path_buf();
            let session_id = session_id.clone();
            async move { manager.delete_session(&workspace_path, &session_id).await }
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(session_dir.exists());
        assert!(!delete_task.is_finished());
        drop(persistence_guard);

        delete_task
            .await
            .expect("delete task should join")
            .expect("session delete should succeed");
        assert!(!session_dir.exists());
    }

    #[tokio::test]
    async fn metadata_lock_identity_normalizes_workspace_path_aliases() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Canonical metadata lock".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        std::fs::create_dir_all(workspace.path().join("alias-component"))
            .expect("alias component should exist");
        let alias = workspace.path().join("alias-component").join("..");
        let canonical_lock = manager
            .get_session_persistence_lock(workspace.path(), &session_id)
            .await;
        let alias_lock = manager
            .get_session_persistence_lock(&alias, &session_id)
            .await;

        assert!(Arc::ptr_eq(&canonical_lock, &alias_lock));
    }

    #[tokio::test]
    async fn save_dialog_turn_persists_last_finished_at() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Finished timestamp metadata".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let mut turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("finished"),
        );
        turn.model_rounds.push(round_with_text(
            "turn-0",
            vec![text_item("text-0", "finished response")],
        ));
        turn.mark_completed();
        let finished_at = turn.end_time;

        manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");

        let metadata = manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");

        assert_eq!(metadata.last_finished_at, finished_at);
    }

    #[tokio::test]
    async fn concurrent_dialog_turn_saves_keep_metadata_counts_consistent() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Concurrent metadata".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let mut turn_0 = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session_id.clone(),
            user_message("first"),
        );
        turn_0.model_rounds.push(round_with_text(
            "turn-0",
            vec![text_item("text-0", "first response")],
        ));
        turn_0.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn_0)
            .await
            .expect("first turn should save");

        let mut turn_1 = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            session_id.clone(),
            user_message("second"),
        );
        turn_1.model_rounds.push(round_with_text(
            "turn-1",
            vec![text_item("text-1", "second response")],
        ));
        turn_1.mark_completed();
        manager
            .save_dialog_turn(workspace.path(), &turn_1)
            .await
            .expect("second turn should save");

        let mut updated_turn_0 = turn_0.clone();
        updated_turn_0.model_rounds[0]
            .text_items
            .push(text_item("text-0b", "first follow-up"));

        let mut updated_turn_1 = turn_1.clone();
        updated_turn_1.model_rounds[0]
            .text_items
            .push(text_item("text-1b", "second follow-up"));
        updated_turn_1.model_rounds[0]
            .text_items
            .push(text_item("text-1c", "second final"));

        let (first_result, second_result) = tokio::join!(
            manager.save_dialog_turn(workspace.path(), &updated_turn_0),
            manager.save_dialog_turn(workspace.path(), &updated_turn_1)
        );
        first_result.expect("first concurrent save should succeed");
        second_result.expect("second concurrent save should succeed");

        let metadata = manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.turn_count, 2);
        assert_eq!(metadata.message_count, 7);
    }

    #[test]
    fn context_snapshot_payload_stats_counts_tool_result_payloads_without_contents() {
        let messages = vec![
            Message::assistant("hello".to_string()),
            Message::tool_result(ToolResult {
                tool_id: "tool-1".to_string(),
                tool_name: "ExecCommand".to_string(),
                effective_tool_name: None,
                result: serde_json::json!({ "output": "x".repeat(40) }),
                result_for_assistant: Some("assistant summary".to_string()),
                is_error: false,
                duration_ms: Some(1),
                image_attachments: None,
            }),
        ];

        let stats = context_snapshot_payload_stats(&messages);

        assert_eq!(stats.tool_result_count, 1);
        assert_eq!(stats.raw_result_string_chars, 40);
        assert_eq!(stats.result_for_assistant_chars, 17);
        assert_eq!(stats.largest_raw_result_chars, 40);
        assert_eq!(
            stats.largest_raw_result_path,
            "message[1].ExecCommand.output"
        );
        assert!(!stats.largest_raw_result_path.contains(&"x".repeat(40)));
    }

    #[tokio::test]
    async fn subagent_session_kind_is_hidden_from_visible_session_index() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let mut metadata = SessionMetadata::new(
            Uuid::new_v4().to_string(),
            "Subagent: repo sweep".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        metadata.session_kind = SessionKind::Subagent;

        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        let visible = manager
            .list_session_metadata(workspace.path())
            .await
            .expect("visible metadata should load");
        let raw = manager
            .list_session_metadata_including_internal(workspace.path())
            .await
            .expect("raw metadata should load");

        assert!(visible.is_empty());
        assert_eq!(raw.len(), 1);
        assert!(raw[0].is_subagent());
    }

    #[tokio::test]
    async fn legacy_leaked_subagent_is_hidden_from_visible_session_index() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let mut metadata = SessionMetadata::new(
            Uuid::new_v4().to_string(),
            "Subagent: stale task".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        metadata.created_by = Some("session-parent".to_string());

        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        let visible = manager
            .list_session_metadata(workspace.path())
            .await
            .expect("visible metadata should load");
        let raw = manager
            .list_session_metadata_including_internal(workspace.path())
            .await
            .expect("raw metadata should load");

        assert!(visible.is_empty());
        assert_eq!(raw.len(), 1);
        assert!(raw[0].is_legacy_leaked_subagent_candidate());
    }

    #[tokio::test]
    async fn listing_sessions_does_not_create_sessions_dir_for_uninitialized_runtime() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let visible = manager
            .list_session_metadata(workspace.path())
            .await
            .expect("visible listing should succeed");
        let raw = manager
            .list_session_metadata_including_internal(workspace.path())
            .await
            .expect("raw listing should succeed");

        assert!(visible.is_empty());
        assert!(raw.is_empty());
        assert!(
            !manager.project_sessions_dir(workspace.path()).exists(),
            "listing sessions should not create the runtime sessions directory"
        );
    }

    async fn legacy_activity_fixture(
        manager: &PersistenceManager,
        workspace: &Path,
    ) -> SessionMetadata {
        let mut metadata = SessionMetadata::new(
            "legacy-activity".into(),
            "Original title".into(),
            "agent".into(),
            "model".into(),
        );
        metadata.turn_count = 2;
        metadata.last_active_at = 100;
        metadata.last_finished_at = Some(100);
        manager
            .session_metadata_store(workspace)
            .save_metadata(&metadata)
            .await
            .unwrap();
        // Sparse storage positions are legal. An unrelated old Turn and the
        // runtime sidecar are deliberately unreadable: repair must not hydrate them.
        manager
            .write_text_atomic(
                &manager.turn_path(workspace, &metadata.session_id, 0),
                "not-json",
            )
            .await
            .unwrap();
        manager
            .write_text_atomic(
                &manager.state_path(workspace, &metadata.session_id),
                "not-json",
            )
            .await
            .unwrap();
        manager
            .write_json_atomic(
                &manager.turn_path(workspace, &metadata.session_id, 3),
                &serde_json::json!({
                    "turn_id": "legacy-turn", "turn_index": 3, "session_id": metadata.session_id,
                    "status": "error", "end_time": 100,
                    // Unknown fields and legacy aliases do not require a full Turn DTO.
                    "modelRounds": {"futurePayload": true}, "futureField": [1, 2, 3]
                }),
            )
            .await
            .unwrap();
        metadata
    }

    #[tokio::test]
    async fn session_activity_backfill_reads_only_the_latest_user_outcome_and_preserves_receipts() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let metadata = legacy_activity_fixture(&manager, workspace.path()).await;
        manager
            .write_json_atomic(
                &manager.turn_path(workspace.path(), &metadata.session_id, 5),
                &serde_json::json!({
                    "turnId": "utility", "turnIndex": 5, "sessionId": metadata.session_id,
                    "kind": "local_command", "status": "completed"
                }),
            )
            .await
            .unwrap();
        let page = manager
            .list_session_metadata_page(workspace.path(), None, 5)
            .await
            .unwrap();
        assert!(
            page.sessions[0].last_turn.is_none(),
            "initial lists must remain metadata-only"
        );

        let (first, overlapping) = tokio::join!(
            manager.backfill_session_last_turn(workspace.path(), metadata.clone()),
            manager.backfill_session_last_turn(workspace.path(), metadata.clone())
        );
        let repaired = first.unwrap();
        assert_eq!(repaired.last_turn, overlapping.unwrap().last_turn);
        let last = repaired.last_turn.as_ref().unwrap();
        assert_eq!(last.turn_id, "legacy-turn");
        assert_eq!(last.turn_index, 3);
        assert_eq!(last.status, super::TurnStatus::Error);
        assert_eq!(last.recovery_pending, Some(false));
        assert!(
            repaired.unread_completion.is_none(),
            "old viewed results must stay read"
        );
        assert_eq!(repaired.last_active_at, metadata.last_active_at);
        assert_eq!(repaired.last_finished_at, metadata.last_finished_at);
        assert_eq!(repaired.session_name, metadata.session_name);

        // A later request, even one holding the old page, reuses persisted facts.
        manager
            .write_text_atomic(
                &manager.turn_path(workspace.path(), &metadata.session_id, 3),
                "not-json",
            )
            .await
            .unwrap();
        let again = manager
            .backfill_session_last_turn(workspace.path(), metadata)
            .await
            .unwrap();
        assert_eq!(again.last_turn, repaired.last_turn);
        let indexed = manager
            .session_metadata_by_ids(workspace.path(), &[again.session_id.clone()])
            .await
            .unwrap();
        assert_eq!(indexed[0].last_turn, again.last_turn);
    }

    #[tokio::test]
    async fn session_activity_backfill_distinguishes_a_recoverable_pause_from_cancellation() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let mut metadata = legacy_activity_fixture(&manager, workspace.path()).await;
        metadata.unread_completion = Some("interrupted".into());
        manager
            .session_metadata_store(workspace.path())
            .save_metadata(&metadata)
            .await
            .unwrap();
        manager.write_json_atomic(&manager.turn_path(workspace.path(), &metadata.session_id, 3), &serde_json::json!({
            "turnId": "paused-turn", "turnIndex": 3, "sessionId": metadata.session_id,
            "status": "cancelled", "finishReason": "interrupted",
            "recovery": {"status": "interrupted", "executionGeneration": 2, "resumeCount": 1}
        })).await.unwrap();
        let repaired = manager
            .backfill_session_last_turn(workspace.path(), metadata.clone())
            .await
            .unwrap();
        let last = repaired.last_turn.as_ref().unwrap();
        assert_eq!(last.recovery_pending, Some(true));
        assert_eq!(last.execution_generation, Some(2));
        assert_eq!(repaired.unread_completion, metadata.unread_completion);

        // Upgrade a summary written by the immediately previous version too.
        let mut legacy_summary = repaired;
        legacy_summary.last_turn.as_mut().unwrap().recovery_pending = None;
        manager
            .session_metadata_store(workspace.path())
            .save_metadata(&legacy_summary)
            .await
            .unwrap();
        let upgraded = manager
            .backfill_session_last_turn(workspace.path(), legacy_summary)
            .await
            .unwrap();
        assert_eq!(upgraded.last_turn.unwrap().recovery_pending, Some(true));
    }

    #[tokio::test]
    async fn session_activity_backfill_keeps_a_newer_write_and_does_not_revive_deleted_sessions() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let metadata = legacy_activity_fixture(&manager, workspace.path()).await;
        let mut current = metadata.clone();
        current.session_name = "New title".into();
        current.unread_completion = Some("completed".into());
        current.last_turn = Some(super::SessionLastTurn {
            turn_id: "new-turn".into(),
            turn_index: 4,
            status: super::TurnStatus::Completed,
            end_time: Some(200),
            execution_generation: None,
            recovery_pending: Some(false),
        });
        manager
            .session_metadata_store(workspace.path())
            .save_metadata(&current)
            .await
            .unwrap();
        let repaired = manager
            .backfill_session_last_turn(workspace.path(), metadata.clone())
            .await
            .unwrap();
        assert_eq!(repaired.last_turn, current.last_turn);
        assert_eq!(repaired.session_name, current.session_name);
        assert_eq!(repaired.unread_completion, current.unread_completion);

        manager
            .delete_session(workspace.path(), &metadata.session_id)
            .await
            .unwrap();
        assert!(manager
            .backfill_session_last_turn(workspace.path(), metadata.clone())
            .await
            .is_err());
        assert!(!manager
            .session_layout(workspace.path())
            .session_dir(&metadata.session_id)
            .exists());
    }

    #[tokio::test]
    async fn session_activity_backfill_keeps_unreadable_history_unknown_without_rewriting_it() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let metadata = legacy_activity_fixture(&manager, workspace.path()).await;
        let tail = manager.turn_path(workspace.path(), &metadata.session_id, 3);
        manager.write_text_atomic(&tail, "not-json").await.unwrap();
        assert!(manager
            .backfill_session_last_turn(workspace.path(), metadata.clone())
            .await
            .is_err());
        let retained = manager
            .load_session_metadata(workspace.path(), &metadata.session_id)
            .await
            .unwrap()
            .unwrap();
        assert!(retained.last_turn.is_none());
        assert_eq!(std::fs::read_to_string(tail).unwrap(), "not-json");
    }

    #[tokio::test]
    async fn session_activity_backfill_does_not_persist_a_staged_revert_projection() {
        let workspace = TestWorkspace::new();
        let manager = PersistenceManager::new(workspace.path_manager()).unwrap();
        let metadata = legacy_activity_fixture(&manager, workspace.path()).await;
        manager.write_json_atomic(&manager.turn_path(workspace.path(), &metadata.session_id, 1), &serde_json::json!({
            "turnId": "visible-turn", "turnIndex": 1, "sessionId": metadata.session_id, "status": "completed"
        })).await.unwrap();
        manager
            .save_session_revert_state(
                workspace.path(),
                &metadata.session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 2,
                    original_turn_end: 4,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .unwrap();
        let projected = manager
            .backfill_session_last_turn(workspace.path(), metadata.clone())
            .await
            .unwrap();
        assert_eq!(projected.last_turn.unwrap().turn_id, "visible-turn");
        assert!(manager
            .load_session_metadata(workspace.path(), &metadata.session_id)
            .await
            .unwrap()
            .unwrap()
            .last_turn
            .is_none());
        manager
            .delete_session_revert_state(workspace.path(), &metadata.session_id)
            .await
            .unwrap();
        let restored = manager
            .backfill_session_last_turn(workspace.path(), metadata)
            .await
            .unwrap();
        assert_eq!(restored.last_turn.unwrap().turn_id, "legacy-turn");
    }

    #[tokio::test]
    async fn list_session_metadata_page_returns_visible_top_level_page_with_children() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        for index in 0..12 {
            let mut metadata = SessionMetadata::new(
                format!("parent-{index}"),
                format!("Parent {index}"),
                "agent".to_string(),
                "model".to_string(),
            );
            metadata.last_active_at = 1_000 + index;
            manager
                .save_session_metadata(workspace.path(), &metadata)
                .await
                .expect("parent metadata should save");
        }

        let mut child = SessionMetadata::new(
            "child-latest".to_string(),
            "Child latest".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        child.last_active_at = 2_000;
        child.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Btw),
            parent_session_id: Some("parent-11".to_string()),
            ..Default::default()
        });
        manager
            .save_session_metadata(workspace.path(), &child)
            .await
            .expect("child metadata should save");

        let page = manager
            .list_session_metadata_page(workspace.path(), None, 5)
            .await
            .expect("session metadata page should load");
        let session_ids = page
            .sessions
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(page.total_top_level_count, 12);
        assert_eq!(page.loaded_top_level_count, 5);
        assert!(page.next_cursor.is_some());
        assert!(page.has_more);
        assert_eq!(
            session_ids,
            vec![
                "parent-11",
                "child-latest",
                "parent-10",
                "parent-9",
                "parent-8",
                "parent-7",
            ]
        );

        let second_page = manager
            .list_session_metadata_page(workspace.path(), page.next_cursor.as_deref(), 5)
            .await
            .expect("second session metadata page should load");
        let second_page_session_ids = second_page
            .sessions
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(second_page.loaded_top_level_count, 5);
        assert_eq!(
            second_page_session_ids,
            vec!["parent-6", "parent-5", "parent-4", "parent-3", "parent-2"]
        );
    }

    #[tokio::test]
    async fn list_session_metadata_page_rebuilds_stale_visible_page_entry() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let mut older = SessionMetadata::new(
            "older-session".to_string(),
            "Older session".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        older.last_active_at = 1_000;
        let mut newer = SessionMetadata::new(
            "newer-session".to_string(),
            "Newer session".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        newer.last_active_at = 2_000;

        manager
            .save_session_metadata(workspace.path(), &older)
            .await
            .expect("older metadata should save");
        manager
            .save_session_metadata(workspace.path(), &newer)
            .await
            .expect("newer metadata should save");

        let mut missing = SessionMetadata::new(
            "missing-session".to_string(),
            "Missing session".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        missing.last_active_at = 3_000;

        let stale_index = StoredSessionIndexFile::new(0, vec![missing, older]);
        manager
            .write_json_atomic(&manager.index_path(workspace.path()), &stale_index)
            .await
            .expect("stale index should be written");

        let page = manager
            .list_session_metadata_page(workspace.path(), None, 5)
            .await
            .expect("session metadata page should rebuild stale index");
        let session_ids = page
            .sessions
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(page.total_top_level_count, 2);
        assert_eq!(session_ids, vec!["newer-session", "older-session"]);
    }

    #[tokio::test]
    async fn session_memory_mode_helpers_update_and_preserve_disabled_precedence() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let mut metadata = SessionMetadata::new(
            "session-memory-mode".to_string(),
            "Memory Mode".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        manager
            .mark_session_memory_mode_polluted(workspace.path(), &metadata.session_id)
            .await
            .expect("enabled session should mark polluted");
        metadata = manager
            .load_session_metadata(workspace.path(), &metadata.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.memory_mode, SessionMemoryMode::Polluted);

        manager
            .set_session_memory_mode(
                workspace.path(),
                &metadata.session_id,
                SessionMemoryMode::Disabled,
            )
            .await
            .expect("memory mode should update");
        manager
            .mark_session_memory_mode_polluted(workspace.path(), &metadata.session_id)
            .await
            .expect("disabled session should keep disabled");
        metadata = manager
            .load_session_metadata(workspace.path(), &metadata.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.memory_mode, SessionMemoryMode::Disabled);
    }

    #[tokio::test]
    async fn polluted_selected_memory_session_enqueues_phase2() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let manager = PersistenceManager::new(path_manager.clone()).expect("persistence manager");
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.expect("memory db should initialize");

        let mut metadata = SessionMetadata::new(
            "session-memory-polluted-selected".to_string(),
            "Memory Polluted Selected".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );
        metadata.memory_mode = SessionMemoryMode::Polluted;
        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        let now = current_unix_secs();
        db.upsert_memory(&MemoryRow {
            session_id: metadata.session_id.clone(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            rollout_path: workspace
                .path()
                .join("sessions")
                .join(&metadata.session_id)
                .to_string_lossy()
                .to_string(),
            source_updated_at_unix_secs: now,
            raw_memory: "memory".to_string(),
            rollout_summary: "summary".to_string(),
            rollout_slug: None,
            generated_at_unix_secs: now,
            usage_count: 1,
            last_usage_unix_secs: Some(now),
            selected_for_phase2: 1,
            selected_for_phase2_source_updated_at: Some(now),
        })
        .await
        .expect("memory row should save");

        manager
            .mark_session_memory_mode_polluted(workspace.path(), &metadata.session_id)
            .await
            .expect("already polluted selected session should enqueue phase2");

        let job = db
            .get_phase2_job(MEMORY_PHASE2_GLOBAL_JOB_KEY)
            .await
            .expect("phase2 job should load")
            .expect("phase2 job should be enqueued");
        assert!(job.input_watermark.unwrap_or_default() >= now);
        assert!(job.retry_at_unix_secs.is_none());
        assert!(job.last_error.is_none());
    }

    #[tokio::test]
    #[ignore = "local performance benchmark; prints timing data only"]
    async fn bench_session_metadata_page_vs_full_list() {
        const SESSION_COUNT: usize = 1_000;
        const ITERATIONS: usize = 10;

        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        for index in 0..SESSION_COUNT {
            let mut metadata = SessionMetadata::new(
                format!("bench-parent-{index}"),
                format!("Bench parent {index}"),
                "agent".to_string(),
                "model".to_string(),
            );
            metadata.last_active_at = 1_000_000 + index as u64;
            manager
                .save_session_metadata(workspace.path(), &metadata)
                .await
                .expect("benchmark metadata should save");
        }

        manager
            .list_session_metadata(workspace.path())
            .await
            .expect("warm full list should load");
        manager
            .list_session_metadata_page(workspace.path(), None, 5)
            .await
            .expect("warm page should load");

        let mut full_list_total_ms = 0.0;
        for _ in 0..ITERATIONS {
            let started = Instant::now();
            let full = manager
                .list_session_metadata(workspace.path())
                .await
                .expect("full list should load");
            assert_eq!(full.len(), SESSION_COUNT);
            full_list_total_ms += started.elapsed().as_secs_f64() * 1000.0;
        }

        let mut page_total_ms = 0.0;
        for _ in 0..ITERATIONS {
            let started = Instant::now();
            let page = manager
                .list_session_metadata_page(workspace.path(), None, 5)
                .await
                .expect("page should load");
            assert_eq!(page.loaded_top_level_count, 5);
            assert_eq!(page.total_top_level_count, SESSION_COUNT);
            page_total_ms += started.elapsed().as_secs_f64() * 1000.0;
        }

        let full_avg_ms = full_list_total_ms / ITERATIONS as f64;
        let page_avg_ms = page_total_ms / ITERATIONS as f64;
        println!(
            "session_metadata_bench sessions={} iterations={} full_list_avg_ms={:.3} page5_avg_ms={:.3} speedup={:.1}x",
            SESSION_COUNT,
            ITERATIONS,
            full_avg_ms,
            page_avg_ms,
            full_avg_ms / page_avg_ms.max(0.001)
        );
    }

    #[tokio::test]
    async fn saving_session_metadata_ensures_runtime_layout_before_writing() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");

        let metadata = SessionMetadata::new(
            Uuid::new_v4().to_string(),
            "Runtime ensure".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );

        manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        let runtime = manager
            .runtime_service()
            .context_for_local_workspace(workspace.path());
        assert!(runtime.runtime_root.exists());
        assert!(runtime.sessions_dir.exists());
        assert!(runtime.snapshot_by_hash_dir.exists());
        assert!(runtime.snapshot_metadata_dir.exists());
        assert!(runtime.snapshot_operations_dir.exists());
        assert!(runtime.plans_dir.exists());
        assert!(runtime.layout_state_file.exists());
    }

    #[tokio::test]
    async fn local_sessions_dir_input_is_used_without_reslugging() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let sessions_dir = path_manager.project_sessions_dir(workspace.path());
        let manager = PersistenceManager::new(path_manager).expect("persistence manager");

        let metadata = SessionMetadata::new(
            Uuid::new_v4().to_string(),
            "Resolved sessions root".to_string(),
            "agent".to_string(),
            "model".to_string(),
        );

        manager
            .save_session_metadata(&sessions_dir, &metadata)
            .await
            .expect("metadata should save under resolved sessions dir");

        assert_eq!(
            manager.index_path(&sessions_dir),
            sessions_dir.join("index.json")
        );
        assert!(sessions_dir
            .join(&metadata.session_id)
            .join("metadata.json")
            .exists());
    }

    #[tokio::test]
    async fn remote_sessions_dir_input_is_used_without_accepting_runtime_root() {
        let test_root =
            std::env::temp_dir().join(format!("openbitfun-persistence-test-{}", Uuid::new_v4()));
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            test_root.join("user"),
        ));
        let manager = PersistenceManager::new(path_manager.clone()).expect("persistence manager");
        let runtime_root = path_manager
            .remote_ssh_mirror_root_dir()
            .join("example-host")
            .join("root")
            .join("repo");
        let sessions_dir = runtime_root.join("sessions");

        assert_eq!(manager.project_sessions_dir(&sessions_dir), sessions_dir);
        assert_ne!(manager.project_sessions_dir(&runtime_root), runtime_root);

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[tokio::test]
    async fn corrupt_remote_index_does_not_block_history_updates_or_new_sessions() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let manager = PersistenceManager::new(path_manager.clone()).expect("persistence manager");
        let remote_path = format!("/home/wsp/corrupt-index-{}", Uuid::new_v4());
        let remote_workspace = crate::service::workspace::legacy_compat::register_remote_fixture(
            &remote_path,
            "ssh-1",
            "dev-host",
        )
        .await;
        let sessions_dir = crate::service::WorkspaceRuntimeService::new(path_manager)
            .context_for_remote_workspace("dev-host", &remote_path)
            .sessions_dir;
        let config = SessionConfig {
            workspace_id: Some(remote_workspace.id.clone()),
            workspace_path: Some(remote_path.clone()),
            remote_connection_id: Some("ssh-1".to_string()),
            remote_ssh_host: Some("dev-host".to_string()),
            ..Default::default()
        };
        let historical_id = Uuid::new_v4().to_string();
        let historical = Session::new_with_id(
            historical_id.clone(),
            "Historical remote session".to_string(),
            "Standard".to_string(),
            config.clone(),
        );
        manager
            .create_session_if_absent(&sessions_dir, &historical)
            .await
            .expect("historical remote session should persist");
        let first_turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            historical_id.clone(),
            UserMessageData {
                id: "user-0".to_string(),
                content: "before restart".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        manager
            .save_dialog_turn(&sessions_dir, &first_turn)
            .await
            .expect("historical remote turn should persist");
        let state_path = sessions_dir.join(&historical_id).join("state.json");
        let first_turn_path = sessions_dir
            .join(&historical_id)
            .join("turns")
            .join("turn-0000.json");
        let state_before = std::fs::read(&state_path).expect("historical state should exist");
        let first_turn_before =
            std::fs::read(&first_turn_path).expect("historical turn should exist");

        std::fs::write(sessions_dir.join("index.json"), b"")
            .expect("simulate an empty remote index after abnormal restart");
        let restored = manager
            .load_session(&sessions_dir, &historical_id)
            .await
            .expect("history must open even before the derived index is repaired");
        assert_eq!(restored.dialog_turn_ids, vec!["turn-0"]);

        let second_turn = DialogTurnData::new(
            "turn-1".to_string(),
            1,
            historical_id.clone(),
            UserMessageData {
                id: "user-1".to_string(),
                content: "after restart".to_string(),
                timestamp: 2,
                metadata: None,
            },
        );
        manager
            .save_dialog_turn(&sessions_dir, &second_turn)
            .await
            .expect("the historical Session must accept a new turn with a corrupt index");

        std::fs::write(sessions_dir.join("index.json"), b"{")
            .expect("simulate another interrupted index write before Session creation");
        let new_session_id = Uuid::new_v4().to_string();
        let new_session = Session::new_with_id(
            new_session_id.clone(),
            "New remote session".to_string(),
            "Standard".to_string(),
            config,
        );
        manager
            .create_session_if_absent(&sessions_dir, &new_session)
            .await
            .expect("a corrupt remote index must not block new Session creation");

        std::fs::write(sessions_dir.join("index.json"), b" ")
            .expect("simulate a corrupt index before listing");
        let listed = manager
            .list_session_metadata(&sessions_dir)
            .await
            .expect("remote Session listing should rebuild its derived index");
        let listed_ids = listed
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            listed_ids,
            HashSet::from([historical_id.as_str(), new_session_id.as_str()])
        );

        let restored = manager
            .load_session(&sessions_dir, &historical_id)
            .await
            .expect("updated historical Session should remain restorable");
        assert_eq!(restored.dialog_turn_ids, vec!["turn-0", "turn-1"]);
        assert_eq!(
            std::fs::read(state_path).expect("historical state remains readable"),
            state_before
        );
        assert_eq!(
            std::fs::read(first_turn_path).expect("historical turn remains readable"),
            first_turn_before
        );
    }

    #[tokio::test]
    async fn skill_agent_snapshots_persist_and_truncate_with_context_snapshots() {
        let workspace = TestWorkspace::new();
        let manager =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let session_id = Uuid::new_v4().to_string();
        let snapshot = TurnSkillAgentSnapshot {
            skills: vec![SkillSnapshotEntry {
                name: "skill-a".to_string(),
                description: "desc-a".to_string(),
                location: "/skills/a".to_string(),
            }],
            subagents: vec![AgentSnapshotEntry {
                id: "agent-a".to_string(),
                description: "desc-a".to_string(),
                default_tools: vec!["Read".to_string()],
            }],
        };

        manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session_id,
                0,
                &[Message::user("hi".to_string())],
            )
            .await
            .expect("context snapshot should save");
        manager
            .save_turn_skill_agent_snapshot(workspace.path(), &session_id, 0, &snapshot)
            .await
            .expect("skill-agent snapshot should save");

        let loaded = manager
            .load_turn_skill_agent_snapshot(workspace.path(), &session_id, 0)
            .await
            .expect("skill-agent snapshot should load")
            .expect("skill-agent snapshot should exist");
        assert_eq!(loaded, snapshot);

        manager
            .delete_turn_context_snapshots_from(workspace.path(), &session_id, 0)
            .await
            .expect("snapshot deletion should succeed");

        assert!(manager
            .load_turn_skill_agent_snapshot(workspace.path(), &session_id, 0)
            .await
            .expect("skill-agent snapshot reload should succeed")
            .is_none());
        assert!(manager
            .load_turn_context_snapshot(workspace.path(), &session_id, 0)
            .await
            .expect("context snapshot reload should succeed")
            .is_none());
    }
}

#[cfg(test)]
mod image_persistence_tests {
    use super::*;
    use crate::agentic::image_analysis::{attachments, process_image_contexts_for_provider};
    use crate::agentic::tools::framework::ToolUseContext;
    use crate::agentic::workspace::WorkspaceBinding;

    #[tokio::test]
    async fn persisted_image_messages_reopen_after_inline_pixels_are_redacted() {
        let dir = tempfile::tempdir().unwrap();
        let mut context = ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new(
                Some("workspace".into()),
                dir.path().to_path_buf(),
            )),
            None,
        );
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".into(),
            serde_json::json!(dir.path()),
        );
        let mut images = vec![attachments::test_image()];
        attachments::prepare_inline_image_attachments(&mut images, &context)
            .await
            .unwrap();
        let original = Message::user_multimodal("Read the screenshot".into(), images);
        let persisted = PersistenceManager::sanitize_message_for_persistence(&original);
        let json = serde_json::to_value(persisted.as_ref()).unwrap();
        assert!(!json.to_string().contains("data:image/"));
        let restored: Message = serde_json::from_value(json).unwrap();
        let MessageContent::Multimodal { images, .. } = restored.content else {
            panic!("image message")
        };
        assert!(images[0].data_url.is_none());
        assert!(images[0].metadata.as_ref().unwrap()["has_data_url"]
            .as_bool()
            .unwrap());
        let processed = process_image_contexts_for_provider(&images, "openai", None)
            .await
            .unwrap();
        assert_eq!((processed[0].width, processed[0].height), (8, 6));
        let MessageContent::Multimodal {
            images: live_images,
            ..
        } = &original.content
        else {
            panic!("live image")
        };
        assert!(live_images[0].data_url.is_some());

        // A pre-upgrade image record has no new required fields or migration marker.
        let legacy: crate::agentic::image_analysis::ImageContextData =
            serde_json::from_value(serde_json::json!({
                "id": "old-image", "image_path": images[0].image_path,
                "data_url": null, "mime_type": "image/png", "metadata": {"has_data_url": true}
            }))
            .unwrap();
        let round_trip = serde_json::from_value(serde_json::to_value(legacy).unwrap()).unwrap();
        assert_eq!(
            process_image_contexts_for_provider(&[round_trip], "anthropic", None)
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
