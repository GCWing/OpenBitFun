//! Session metadata pagination and cursor shaping.

use super::types::{SessionMetadata, SessionStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Read-only navigation query. A host echoes it only after applying every
/// field; clients without that acknowledgement must retain legacy traversal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogQuery {
    pub workspace_id: String,
    pub ordering: SessionCatalogOrdering,
    pub source: String,
    /// The view freezes recency on hydration and advances it on a new run.
    /// Preserve those already-observed timestamps when selecting older rows.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub sort_timestamps: HashMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionCatalogOrdering {
    Created,
    Updated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiscoveryDiagnostic {
    /// Ecosystem adapter that produced the diagnostic (for example, `cursor`).
    pub ecosystem_id: String,
    /// Stable adapter-owned code. Presentation layers localize this code.
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadataPage {
    pub sessions: Vec<SessionMetadata>,
    pub total_top_level_count: usize,
    pub loaded_top_level_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub has_more: bool,
    /// Optional read-only extension. Absence identifies older hosts; an empty
    /// array is an authoritative empty status batch, not a missing capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activities: Option<Vec<SessionActivitySummary>>,
    /// Non-fatal host discovery issues. Native history remains available.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discovery_warnings: Vec<String>,
    /// Structured discovery issues for clients that can localize and present
    /// each category separately. Older clients continue to use
    /// `discovery_warnings`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discovery_diagnostics: Vec<SessionDiscoveryDiagnostic>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub discovery_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_query: Option<SessionCatalogQuery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_revision: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub catalog_reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivitySummary {
    pub session_id: String,
    /// Runtime-owned execution fact; unknown external owners remain explicit.
    pub execution: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    pub pending_approvals: usize,
    pub pending_questions: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<super::types::SessionLastTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_completion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_turn: Option<super::types::SessionLastTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadataPageCursor {
    last_active_at: u64,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog_revision: Option<String>,
}

pub fn empty_session_metadata_page() -> SessionMetadataPage {
    SessionMetadataPage {
        sessions: Vec::new(),
        total_top_level_count: 0,
        loaded_top_level_count: 0,
        next_cursor: None,
        has_more: false,
        activities: None,
        discovery_warnings: Vec::new(),
        discovery_diagnostics: Vec::new(),
        discovery_pending: false,
        catalog_query: None,
        catalog_revision: None,
        catalog_reset: false,
    }
}

pub fn build_session_metadata_page(
    indexed_sessions: Vec<SessionMetadata>,
    cursor: Option<&str>,
    limit: usize,
) -> SessionMetadataPage {
    build_session_metadata_page_with_query(indexed_sessions, cursor, limit, None)
}

pub fn build_session_metadata_page_with_query(
    indexed_sessions: Vec<SessionMetadata>,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&SessionCatalogQuery>,
) -> SessionMetadataPage {
    PreparedSessionCatalog::new(indexed_sessions, query).page(cursor, limit)
}

/// Immutable navigation projection. Hosts can reuse it for a stable index
/// revision; each page clones only its selected parents and their children.
pub struct PreparedSessionCatalog {
    top_level_sessions: Vec<SessionMetadata>,
    children_by_parent: HashMap<String, Vec<SessionMetadata>>,
    offsets: HashMap<String, usize>,
    query: Option<SessionCatalogQuery>,
    revision: Option<String>,
}

impl PreparedSessionCatalog {
    pub fn new(
        indexed_sessions: Vec<SessionMetadata>,
        query: Option<&SessionCatalogQuery>,
    ) -> Self {
        // Older records can require the client's workspace registry to resolve
        // ownership. Do not guess from the shared storage directory.
        let query = query.filter(|query| {
            !query.workspace_id.is_empty()
                && indexed_sessions.iter().all(|metadata| {
                    metadata.should_hide_from_user_lists()
                        || metadata.status == SessionStatus::Archived
                        || catalog_hides_subagent(metadata)
                        || catalog_workspace_id(metadata).is_some()
                })
        });
        let visible_sessions = indexed_sessions
            .into_iter()
            .filter(|metadata| {
                !metadata.should_hide_from_user_lists()
                    && metadata.status != SessionStatus::Archived
                    && query.is_none_or(|query| {
                        catalog_workspace_id(metadata) == Some(query.workspace_id.as_str())
                            && !catalog_hides_subagent(metadata)
                    })
            })
            .collect::<Vec<_>>();
        let visible_ids = visible_sessions
            .iter()
            .map(|metadata| metadata.session_id.clone())
            .collect::<HashSet<_>>();

        let mut top_level_sessions = Vec::new();
        let mut children_by_parent: HashMap<String, Vec<SessionMetadata>> = HashMap::new();
        for metadata in visible_sessions {
            let parent_id = if query.is_some() {
                catalog_parent_id(&metadata)
            } else {
                session_parent_id(&metadata)
            };
            if let Some(parent_id) = parent_id {
                if visible_ids.contains(&parent_id) {
                    children_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(metadata);
                    continue;
                }
            }

            top_level_sessions.push(metadata);
        }

        if let Some(query) = query {
            top_level_sessions.retain(|metadata| catalog_source_matches(metadata, &query.source));
            top_level_sessions.sort_by(|left, right| catalog_order(left, right, query));
        }

        for children in children_by_parent.values_mut() {
            if let Some(query) = query {
                children.retain(|metadata| catalog_source_matches(metadata, &query.source));
                children.sort_by(|left, right| catalog_order(left, right, query));
            } else {
                children.sort_by_key(|metadata| std::cmp::Reverse(metadata.last_active_at));
            }
        }
        let offsets = top_level_sessions
            .iter()
            .enumerate()
            .map(|(index, metadata)| (metadata.session_id.clone(), index))
            .collect();
        Self {
            top_level_sessions,
            children_by_parent,
            offsets,
            query: query.cloned(),
            revision: None,
        }
    }

    pub fn with_revision(mut self, revision: String) -> Self {
        if self.query.is_some() {
            self.revision = Some(revision);
        }
        self
    }

    pub fn page(&self, cursor: Option<&str>, limit: usize) -> SessionMetadataPage {
        let query = self.query.as_ref();
        let top_level_sessions = &self.top_level_sessions;
        let catalog_reset = self.revision.as_ref().is_some_and(|revision| {
            cursor.is_some_and(|cursor| {
                serde_json::from_str::<SessionMetadataPageCursor>(cursor)
                    .ok()
                    .and_then(|cursor| cursor.catalog_revision)
                    .as_ref()
                    != Some(revision)
            })
        });
        let cursor = cursor.filter(|_| !catalog_reset);

        let total_top_level_count = top_level_sessions.len();
        let limit = limit.max(1);
        let offset = session_metadata_page_offset(cursor, &self.offsets);
        let offset = offset.min(total_top_level_count);
        let mut next_offset = offset.saturating_add(limit).min(total_top_level_count);
        if let Some(query) = query {
            // The client uses locale-aware ID ordering for equal timestamps. Keep
            // the entire boundary tie together so it can preserve that order.
            while next_offset > offset
                && next_offset < total_top_level_count
                && catalog_sort_key(&top_level_sessions[next_offset - 1], query)
                    == catalog_sort_key(&top_level_sessions[next_offset], query)
            {
                next_offset += 1;
            }
        }
        let selected_top_level = top_level_sessions
            .iter()
            .skip(offset)
            .take(next_offset - offset)
            .cloned()
            .collect::<Vec<_>>();
        let loaded_top_level_count = selected_top_level.len();
        let has_more = next_offset < total_top_level_count;
        let next_cursor = has_more
            .then(|| {
                selected_top_level
                    .last()
                    .map(|metadata| session_metadata_page_cursor(metadata, self.revision.clone()))
            })
            .flatten();

        let mut sessions = Vec::new();
        for metadata in selected_top_level {
            let session_id = metadata.session_id.clone();
            sessions.push(metadata);

            if let Some(children) = self.children_by_parent.get(&session_id) {
                sessions.extend(children.iter().cloned());
            }
        }

        SessionMetadataPage {
            sessions,
            total_top_level_count,
            loaded_top_level_count,
            next_cursor,
            has_more,
            activities: None,
            discovery_warnings: Vec::new(),
            discovery_diagnostics: Vec::new(),
            discovery_pending: false,
            catalog_query: query.cloned(),
            catalog_revision: self.revision.clone(),
            catalog_reset,
        }
    }
}

fn catalog_workspace_id(metadata: &SessionMetadata) -> Option<&str> {
    use openbitfun_core_types::SessionExecutionTargetKind;
    let isolated = metadata
        .execution_target
        .as_ref()
        .is_some_and(|target| target.kind != SessionExecutionTargetKind::Local);
    if isolated {
        // Missing project identity requires the legacy workspace resolver.
        metadata.project_workspace_id.as_deref()
    } else {
        metadata.workspace_id.as_deref()
    }
}

fn catalog_source_matches(metadata: &SessionMetadata, source: &str) -> bool {
    source == "all"
        || metadata
            .custom_metadata
            .as_ref()
            .and_then(|custom| custom.get("importedFrom"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("openbitfun")
            == source
}

fn catalog_parent_id(metadata: &SessionMetadata) -> Option<String> {
    use super::types::SessionRelationshipKind;
    // Match the existing UI projection: structured Btw and Review sessions are
    // children; legacy unstructured Btw and MiniApp records are standalone.
    if let Some(kind) = metadata
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.kind.as_ref())
    {
        if !matches!(
            kind,
            SessionRelationshipKind::Btw
                | SessionRelationshipKind::Review
                | SessionRelationshipKind::DeepReview
        ) {
            return None;
        }
        return metadata
            .relationship
            .as_ref()
            .and_then(|relationship| relationship.parent_session_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
    }
    let kind = metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| custom.get("kind"))
        .and_then(serde_json::Value::as_str);
    matches!(kind, Some("review" | "deep_review"))
        .then(|| {
            metadata
                .custom_metadata
                .as_ref()
                .and_then(|custom| custom.get("parentSessionId"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .flatten()
}

fn catalog_hides_subagent(metadata: &SessionMetadata) -> bool {
    if let Some(kind) = metadata
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.kind.as_ref())
    {
        return *kind == super::types::SessionRelationshipKind::Subagent;
    }
    metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| custom.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("subagent")
}

fn catalog_sort_key(metadata: &SessionMetadata, query: &SessionCatalogQuery) -> (u64, u64) {
    let timestamp = if query.ordering == SessionCatalogOrdering::Created {
        metadata.created_at
    } else {
        query
            .sort_timestamps
            .get(&metadata.session_id)
            .copied()
            .or(metadata.last_finished_at)
            .or_else(|| {
                metadata
                    .custom_metadata
                    .as_ref()
                    .and_then(|custom| custom.get("lastFinishedAt"))
                    .and_then(serde_json::Value::as_u64)
            })
            .unwrap_or(metadata.created_at)
    };
    (timestamp, metadata.created_at)
}

fn catalog_order(
    left: &SessionMetadata,
    right: &SessionMetadata,
    query: &SessionCatalogQuery,
) -> std::cmp::Ordering {
    catalog_sort_key(right, query)
        .cmp(&catalog_sort_key(left, query))
        .then(left.session_id.cmp(&right.session_id))
}

fn session_parent_id(metadata: &SessionMetadata) -> Option<String> {
    if let Some(parent_id) = metadata
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.parent_session_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(parent_id.to_string());
    }

    metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| {
            custom
                .get("parentSessionId")
                .or_else(|| custom.get("parent_session_id"))
        })
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn is_false(value: &bool) -> bool {
    !value
}

fn session_metadata_page_offset(cursor: Option<&str>, offsets: &HashMap<String, usize>) -> usize {
    let Some(cursor) = cursor else {
        return 0;
    };

    if let Ok(parsed) = serde_json::from_str::<SessionMetadataPageCursor>(cursor) {
        if let Some(index) = offsets.get(&parsed.session_id) {
            return index + 1;
        }
    }

    cursor.parse::<usize>().unwrap_or(0)
}

fn session_metadata_page_cursor(metadata: &SessionMetadata, revision: Option<String>) -> String {
    serde_json::to_string(&SessionMetadataPageCursor {
        last_active_at: metadata.last_active_at,
        session_id: metadata.session_id.clone(),
        catalog_revision: revision,
    })
    .unwrap_or_else(|_| metadata.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_page_round_trips_without_discovery_fields() {
        let legacy = serde_json::json!({"sessions": [], "totalTopLevelCount": 0, "loadedTopLevelCount": 0, "hasMore": false});
        let page: SessionMetadataPage = serde_json::from_value(legacy.clone()).unwrap();
        assert!(page.discovery_warnings.is_empty());
        assert!(page.discovery_diagnostics.is_empty());
        assert_eq!(serde_json::to_value(page).unwrap(), legacy);
    }

    #[test]
    fn structured_discovery_diagnostics_round_trip_with_legacy_warnings() {
        let mut page = empty_session_metadata_page();
        page.discovery_warnings.push("legacy warning".into());
        page.discovery_diagnostics.push(SessionDiscoveryDiagnostic {
            ecosystem_id: "cursor".into(),
            code: "workspace_unresolved".into(),
        });

        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(
            wire["discoveryDiagnostics"][0],
            serde_json::json!({"ecosystemId": "cursor", "code": "workspace_unresolved"})
        );
        let restored: SessionMetadataPage = serde_json::from_value(wire).unwrap();
        assert_eq!(restored.discovery_warnings, vec!["legacy warning"]);
        assert_eq!(restored.discovery_diagnostics.len(), 1);
        assert_eq!(restored.discovery_diagnostics[0].ecosystem_id, "cursor");
    }

    fn entry(id: &str, workspace: &str, created: u64) -> SessionMetadata {
        let mut metadata =
            SessionMetadata::new(id.into(), id.into(), "agent".into(), "model".into());
        metadata.workspace_id = Some(workspace.into());
        metadata.created_at = created;
        metadata.last_active_at = 10_000 - created;
        metadata
    }

    fn query(source: &str) -> SessionCatalogQuery {
        SessionCatalogQuery {
            workspace_id: "main".into(),
            ordering: SessionCatalogOrdering::Updated,
            source: source.into(),
            sort_timestamps: HashMap::new(),
        }
    }

    #[test]
    fn catalog_pages_scope_and_sort_before_selecting_rows() {
        let entries = (0..655)
            .flat_map(|index| {
                [
                    entry(&format!("main-{index:04}"), "main", index),
                    entry(&format!("other-{index:04}"), "other", 1000 + index),
                ]
            })
            .collect::<Vec<_>>();
        let query = query("all");
        let first = build_session_metadata_page_with_query(entries.clone(), None, 5, Some(&query));
        assert_eq!(first.sessions.len(), 5);
        assert_eq!(first.total_top_level_count, 655);
        assert_eq!(first.loaded_top_level_count, 5);
        assert_eq!(first.sessions[0].session_id, "main-0654");
        assert_eq!(first.sessions[4].session_id, "main-0650");
        assert_eq!(first.catalog_query, Some(query.clone()));
        let second = build_session_metadata_page_with_query(
            entries,
            first.next_cursor.as_deref(),
            5,
            Some(&query),
        );
        assert_eq!(second.sessions.len(), 5);
        assert_eq!(second.sessions[0].session_id, "main-0649");
        assert_eq!(second.sessions[4].session_id, "main-0645");
    }

    #[test]
    fn catalog_recency_preserves_legacy_finish_times_and_observed_run_order() {
        let mut finished = entry("finished", "main", 1);
        finished.custom_metadata = Some(serde_json::json!({"lastFinishedAt": 20}));
        let mut explicit = entry("explicit", "main", 2);
        explicit.last_finished_at = Some(30);
        let entries = vec![
            entry("created", "main", 10),
            finished,
            explicit,
            entry("running", "main", 0),
        ];
        let mut query = query("all");
        query.sort_timestamps.insert("running".into(), 40);
        let page = build_session_metadata_page_with_query(entries.clone(), None, 5, Some(&query));
        assert_eq!(
            page.sessions
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            ["running", "explicit", "finished", "created"]
        );
        query.ordering = SessionCatalogOrdering::Created;
        let page = build_session_metadata_page_with_query(entries, None, 5, Some(&query));
        assert_eq!(
            page.sessions
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            ["created", "explicit", "finished", "running"]
        );
    }

    #[test]
    fn catalog_observed_recency_prevents_host_updates_from_displacing_unseen_rows() {
        let mut observed = entry("already-observed", "main", 1);
        observed.last_finished_at = Some(1_000);
        let entries = vec![observed, entry("unseen-newer", "main", 20)];
        let mut query = query("all");
        let without_observation =
            build_session_metadata_page_with_query(entries.clone(), None, 1, Some(&query));
        assert_eq!(
            without_observation.sessions[0].session_id,
            "already-observed"
        );

        // The view captured 10 before another host completed this session.
        // Its frozen ordering needs the unseen row, despite the newer disk value.
        query.sort_timestamps.insert("already-observed".into(), 10);
        let pinned = build_session_metadata_page_with_query(entries, None, 1, Some(&query));
        assert_eq!(pinned.sessions[0].session_id, "unseen-newer");
        assert_eq!(pinned.total_top_level_count, 2);
        assert!(pinned.has_more);
    }

    #[test]
    fn catalog_source_counts_keep_children_with_the_selected_parent() {
        let mut parent = entry("codex", "main", 1);
        parent.custom_metadata = Some(serde_json::json!({"importedFrom": "codex"}));
        let mut child = entry("review", "main", 9);
        child.custom_metadata = Some(
            serde_json::json!({"kind": "review", "parentSessionId": "codex", "importedFrom": "codex"}),
        );
        let mut native_child = entry("native-review", "main", 10);
        native_child.custom_metadata =
            Some(serde_json::json!({"kind": "review", "parentSessionId": "codex"}));
        let mut archived = entry("archived", "main", 100);
        archived.status = SessionStatus::Archived;
        let entries = vec![
            parent,
            child,
            native_child,
            archived,
            entry("native", "main", 2),
        ];
        let page =
            build_session_metadata_page_with_query(entries.clone(), None, 1, Some(&query("codex")));
        assert_eq!(page.total_top_level_count, 1);
        assert_eq!(page.loaded_top_level_count, 1);
        assert_eq!(
            page.sessions
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            ["codex", "review"]
        );
        let page =
            build_session_metadata_page_with_query(entries, None, 1, Some(&query("openbitfun")));
        assert_eq!(page.total_top_level_count, 1);
        assert_eq!(page.sessions[0].session_id, "native");
    }

    #[test]
    fn catalog_worktrees_use_execution_kind_and_legacy_ownership_remains_unscoped() {
        let mut isolated = entry("isolated", "worktree", 1);
        isolated.project_workspace_id = Some("main".into());
        isolated.execution_target = Some(
            serde_json::from_value(serde_json::json!({
                "kind": "managedWorktree", "rootPath": "/remote/project/worktree"
            }))
            .unwrap(),
        );
        let mut linked = entry("linked", "worktree", 2);
        linked.project_workspace_id = Some("main".into());
        let entries = vec![isolated, linked];
        let page =
            build_session_metadata_page_with_query(entries.clone(), None, 5, Some(&query("all")));
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].session_id, "isolated");
        let mut legacy = entries;
        legacy[0].project_workspace_id = None;
        let page =
            build_session_metadata_page_with_query(legacy.clone(), None, 5, Some(&query("all")));
        assert!(page.catalog_query.is_none());
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            serde_json::to_value(build_session_metadata_page(legacy, None, 5)).unwrap()
        );
    }

    #[test]
    fn catalog_empty_query_is_acknowledged_and_query_round_trips() {
        let query = query("codex");
        let page = build_session_metadata_page_with_query(Vec::new(), None, 5, Some(&query));
        assert_eq!(page.total_top_level_count, 0);
        assert!(!page.has_more);
        let wire = serde_json::to_value(page).unwrap();
        let restored: SessionMetadataPage = serde_json::from_value(wire).unwrap();
        assert_eq!(restored.catalog_query, Some(query));
    }

    #[test]
    fn catalog_keeps_timestamp_ties_together_for_client_locale_ordering() {
        let entries = vec![
            entry("Z", "main", 9),
            entry("_a", "main", 9),
            entry("-a", "main", 9),
            entry("a", "main", 8),
        ];
        let first =
            build_session_metadata_page_with_query(entries.clone(), None, 1, Some(&query("all")));
        assert_eq!(first.loaded_top_level_count, 3);
        assert!(first.sessions.iter().all(|record| record.created_at == 9));
        let next = build_session_metadata_page_with_query(
            entries,
            first.next_cursor.as_deref(),
            1,
            Some(&query("all")),
        );
        assert_eq!(next.sessions[0].session_id, "a");
        assert!(!next.has_more);
    }

    #[test]
    fn catalog_cursor_restarts_on_revision_change_and_old_pages_remain_compatible() {
        let entries = (0..12)
            .map(|index| entry(&index.to_string(), "main", index))
            .collect::<Vec<_>>();
        let first_catalog = PreparedSessionCatalog::new(entries.clone(), Some(&query("all")))
            .with_revision("query-a-version-1".into());
        let first = first_catalog.page(None, 5);
        let next = first_catalog.page(first.next_cursor.as_deref(), 5);
        assert_eq!(next.sessions[0].session_id, "6");
        assert!(!next.catalog_reset);
        let changed = PreparedSessionCatalog::new(entries.clone(), Some(&query("all")))
            .with_revision("query-a-version-2".into())
            .page(first.next_cursor.as_deref(), 5);
        assert!(changed.catalog_reset);
        assert_eq!(changed.sessions[0].session_id, "11");
        let wire = serde_json::to_value(&changed).unwrap();
        let restored: SessionMetadataPage = serde_json::from_value(wire).unwrap();
        assert_eq!(
            restored.catalog_revision.as_deref(),
            Some("query-a-version-2")
        );
        assert!(restored.catalog_reset);
        // Hosts that ignore optional query/revision fields can still read the
        // legacy ID anchor embedded in the new opaque cursor.
        let legacy = build_session_metadata_page(entries, first.next_cursor.as_deref(), 5);
        assert!(legacy.catalog_revision.is_none());
        assert!(!legacy.catalog_reset);
        assert_eq!(legacy.sessions[0].session_id, "8");
    }

    #[test]
    fn catalog_preserves_structured_and_legacy_child_visibility() {
        let parent = entry("parent", "main", 1);
        let mut legacy_btw = entry("legacy-btw", "main", 2);
        legacy_btw.custom_metadata =
            Some(serde_json::json!({"kind": "btw", "parentSessionId": "parent"}));
        let mut structured_btw = legacy_btw.clone();
        structured_btw.session_id = "structured-btw".into();
        structured_btw.relationship = Some(
            serde_json::from_value(serde_json::json!({"kind": "btw", "parentSessionId": "parent"}))
                .unwrap(),
        );
        let mut subagent = entry("legacy-subagent", "main", 3);
        subagent.custom_metadata =
            Some(serde_json::json!({"kind": "subagent", "parentSessionId": "parent"}));
        subagent.workspace_id = None;
        let mut miniapp = entry("miniapp", "main", 4);
        miniapp.custom_metadata =
            Some(serde_json::json!({"kind": "review", "parentSessionId": "parent"}));
        miniapp.relationship = Some(
            serde_json::from_value(
                serde_json::json!({"kind": "miniapp", "parentSessionId": "parent"}),
            )
            .unwrap(),
        );
        let page = build_session_metadata_page_with_query(
            vec![parent, legacy_btw, structured_btw, subagent, miniapp],
            None,
            5,
            Some(&query("all")),
        );
        assert!(page.catalog_query.is_some());
        assert_eq!(page.total_top_level_count, 3);
        assert_eq!(
            page.sessions
                .iter()
                .map(|record| record.session_id.as_str())
                .collect::<Vec<_>>(),
            ["miniapp", "legacy-btw", "parent", "structured-btw"]
        );
    }
}
