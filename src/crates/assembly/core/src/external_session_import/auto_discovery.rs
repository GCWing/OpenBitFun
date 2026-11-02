//! Workspace-owned, opt-in external history discovery. Imported sessions use the
//! native persistence path; discovery never starts an external Agent runtime.

use super::*;
use crate::service::workspace::{WorkspaceInfo, WorkspaceKind};
use openbitfun_product_domains::session_import::ExternalSessionCatalog;
#[cfg(test)]
use openbitfun_product_domains::session_import::ExternalSessionImportWarning;
use openbitfun_services_core::session::SessionDiscoveryDiagnostic;

#[derive(Default)]
struct DiscoveryState {
    enabled_sources: Option<Vec<String>>,
    activation_revision: Option<i64>,
    snapshot: DiscoverySnapshot,
    cancelled: Arc<AtomicBool>,
    worker: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone, Default)]
pub struct DiscoverySnapshot {
    pub pending: bool,
    pub warnings: Vec<String>,
    pub diagnostics: Vec<SessionDiscoveryDiagnostic>,
}

#[derive(Debug, Default)]
struct DiscoveryResult {
    warnings: Vec<String>,
    diagnostics: Vec<SessionDiscoveryDiagnostic>,
}

type DiscoveryLocks = HashMap<String, Arc<tokio::sync::Mutex<DiscoveryState>>>;
static DISCOVERY: LazyLock<Mutex<DiscoveryLocks>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn enabled_sources() -> Result<Vec<String>, String> {
    let service = crate::service::config::get_global_config_service()
        .await
        .map_err(|error| error.to_string())?;
    let settings: HashMap<String, bool> = service
        .get_config(Some("app.external_session_discovery"))
        .await
        .map_err(|error| error.to_string())?;
    Ok([
        "codex",
        "zcode",
        "claude-code",
        "opencode",
        "pi",
        "deepseek-harness",
        "cursor",
    ]
    .into_iter()
    .filter(|source| settings.get(*source) == Some(&true))
    .map(str::to_owned)
    .collect())
}

/// Opening a workspace explicitly refreshes discovery. Metadata reads also run
/// this once after startup (including restored background workspace rows), and
/// after the user changes a source toggle. Concurrent readers share one scan.
pub async fn discover_workspace(workspace: &WorkspaceInfo, refresh: bool) -> DiscoverySnapshot {
    let enabled = match enabled_sources().await {
        Ok(enabled) => enabled,
        Err(error) => {
            log::warn!("Failed to read external session discovery preferences: {error}");
            return DiscoverySnapshot {
                pending: false,
                warnings: vec!["External session discovery preferences could not be read".into()],
                diagnostics: Vec::new(),
            };
        }
    };
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return if enabled.is_empty() {
            DiscoverySnapshot::default()
        } else {
            DiscoverySnapshot {
                pending: false,
                warnings: vec![
                    "Automatic external session discovery is unavailable for SSH workspaces".into(),
                ],
                diagnostics: Vec::new(),
            }
        };
    }
    let requested_at = Instant::now();
    let key = format!("{}:{}", workspace.id, normalized_path(&workspace.root_path));
    let workspace = workspace.clone();
    let sources = enabled.clone();
    let activation_revision = workspace.last_accessed.timestamp_nanos_opt();
    schedule_discovery(
        key,
        enabled,
        refresh,
        activation_revision,
        move |cancelled| async move {
            discover_enabled(&workspace, &sources, cancelled, requested_at).await
        },
    )
    .await
}

async fn schedule_discovery<F, Fut>(
    key: String,
    enabled: Vec<String>,
    refresh: bool,
    activation_revision: Option<i64>,
    work: F,
) -> DiscoverySnapshot
where
    F: FnOnce(Arc<AtomicBool>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = DiscoveryResult> + Send + 'static,
{
    let lock = DISCOVERY
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(key)
        .or_default()
        .clone();
    let mut state = lock.lock().await;
    if enabled.is_empty() {
        state.cancelled.store(true, Ordering::Release);
        state.enabled_sources = Some(enabled);
        state.activation_revision = activation_revision;
        state.snapshot = DiscoverySnapshot::default();
        return state.snapshot.clone();
    }
    if state.enabled_sources.as_ref() == Some(&enabled)
        && (state.snapshot.pending
            || (!refresh && state.activation_revision == activation_revision))
    {
        return state.snapshot.clone();
    }
    state.cancelled.store(true, Ordering::Release);
    let cancelled = Arc::new(AtomicBool::new(false));
    state.cancelled = cancelled.clone();
    state.enabled_sources = Some(enabled);
    state.activation_revision = activation_revision;
    state.snapshot = DiscoverySnapshot {
        pending: true,
        warnings: Vec::new(),
        diagnostics: Vec::new(),
    };
    let worker = state.worker.clone();
    let completion_state = lock.clone();
    tokio::spawn(async move {
        // Host-owned work outlives the initiating view or relay request. A
        // restarted host resumes through persisted source identities.
        let _worker = worker.lock().await;
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        let result = work(cancelled.clone()).await;
        let mut state = completion_state.lock().await;
        if Arc::ptr_eq(&state.cancelled, &cancelled) && !cancelled.load(Ordering::Acquire) {
            state.snapshot = DiscoverySnapshot {
                pending: false,
                warnings: result.warnings,
                diagnostics: result.diagnostics,
            };
        }
    });
    state.snapshot.clone()
}

/// Resolve identities from this host's workspace registry. In particular, a
/// remote workspace's synthetic local storage directory is never treated as a
/// source directory and cannot cause a scan of controller-side history.
pub async fn discover_for_storage_path(storage_path: &Path) -> DiscoverySnapshot {
    let Some(service) = crate::service::workspace::get_global_workspace_service() else {
        return DiscoverySnapshot::default();
    };
    let workspaces = service.list_workspace_infos().await;
    let runtime =
        crate::service::WorkspaceRuntimeService::new(crate::infrastructure::get_path_manager_arc());
    let mut snapshot = DiscoverySnapshot::default();
    for workspace in workspaces_for_storage_path(storage_path, &workspaces, &runtime) {
        let discovery = discover_workspace(workspace, false).await;
        snapshot.pending |= discovery.pending;
        snapshot.warnings.extend(discovery.warnings);
        snapshot.diagnostics.extend(discovery.diagnostics);
    }
    snapshot.warnings.sort();
    snapshot.warnings.dedup();
    snapshot.diagnostics.sort_by(|left, right| {
        left.ecosystem_id
            .cmp(&right.ecosystem_id)
            .then_with(|| left.code.cmp(&right.code))
    });
    snapshot
        .diagnostics
        .dedup_by(|left, right| left.ecosystem_id == right.ecosystem_id && left.code == right.code);
    snapshot
}

fn workspaces_for_storage_path<'a>(
    storage_path: &Path,
    workspaces: &'a [WorkspaceInfo],
    runtime: &crate::service::WorkspaceRuntimeService,
) -> Vec<&'a WorkspaceInfo> {
    let path = normalized_path(storage_path);
    // Session APIs resolve IDs to the owner's centralized sessions directory.
    // Source cwd and project root are separate IO projections, never that directory.
    let Some(project) = workspaces.iter().find(|workspace| {
        workspace.workspace_kind != WorkspaceKind::Remote
            && workspace.project_workspace_id().ok() == Some(workspace.id.as_str())
            && (normalized_path(&workspace.root_path) == path
                || normalized_path(
                    &runtime
                        .context_for_local_workspace(&workspace.root_path)
                        .sessions_dir,
                ) == path)
    }) else {
        return Vec::new();
    };
    workspaces
        .iter()
        .filter(|workspace| {
            workspace.workspace_kind != WorkspaceKind::Remote
                && workspace.project_workspace_id().ok() == Some(project.id.as_str())
        })
        .collect()
}

async fn discover_enabled(
    workspace: &WorkspaceInfo,
    enabled: &[String],
    cancelled: Arc<AtomicBool>,
    requested_at: Instant,
) -> DiscoveryResult {
    let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() else {
        return DiscoveryResult {
            warnings: vec![
                "Runtime ownership is unavailable for external session discovery".into(),
            ],
            ..DiscoveryResult::default()
        };
    };
    if let Err(error) =
        coordinator.ensure_workspace_runtime_ownership(&workspace.root_path, None, None)
    {
        log::warn!("External session discovery could not acquire workspace ownership: {error}");
        return DiscoveryResult {
            warnings: vec![
                "Another runtime owns this workspace; automatic session import is unavailable"
                    .into(),
            ],
            ..DiscoveryResult::default()
        };
    }
    let Some(service) = crate::service::workspace::get_global_workspace_service() else {
        return DiscoveryResult {
            warnings: vec![
                "Workspace service is unavailable for external session discovery".into(),
            ],
            ..DiscoveryResult::default()
        };
    };
    let workspaces = service.list_workspace_infos().await;
    let (store, project) = match import_storage(workspace).await {
        Ok(storage) => storage,
        Err(error) => {
            return DiscoveryResult {
                warnings: vec![error.detail],
                ..DiscoveryResult::default()
            }
        }
    };
    let mut result = DiscoveryResult::default();
    for ecosystem in enabled {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let source = match ImportSource::from_ecosystem(ecosystem) {
            Ok(source) => source,
            Err(_) => continue,
        };
        let catalog = shared_catalog(&SOURCE_CATALOGS, ecosystem, requested_at, move || {
            source.discover_all()
        })
        .await;
        match catalog {
            Ok(catalog) => {
                let registration = register_catalog(
                    &store,
                    workspace,
                    &project,
                    &workspaces,
                    &catalog,
                    cancelled.as_ref(),
                )
                .await;
                result.warnings.extend(registration.warnings);
                result.diagnostics.extend(registration.diagnostics);
            }
            error => {
                log::warn!("External session discovery failed for {ecosystem}: {error:?}");
                result.warnings.push(format!(
                    "{} session history could not be discovered",
                    source.name()
                ));
            }
        }
    }
    result
}

#[derive(Debug)]
struct SourceCatalog {
    catalog: ExternalSessionCatalog,
    ownership: Mutex<Option<CatalogOwnership>>,
    #[cfg(test)]
    ownership_resolutions: std::sync::atomic::AtomicUsize,
}

#[derive(Debug)]
struct CatalogOwnership {
    roots: Vec<(String, PathBuf)>,
    candidates: HashMap<String, Vec<usize>>,
}

impl SourceCatalog {
    fn new(catalog: ExternalSessionCatalog) -> Self {
        Self {
            catalog,
            ownership: Mutex::new(None),
            #[cfg(test)]
            ownership_resolutions: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn workspace_candidates(
        &self,
        workspace: &WorkspaceInfo,
        workspaces: &[WorkspaceInfo],
        mut normalize: impl FnMut(&Path) -> String,
    ) -> Vec<ExternalSessionCandidate> {
        if workspace.workspace_kind == WorkspaceKind::Remote {
            return Vec::new();
        }
        // Registry order is significant when two registered roots are equal:
        // matching_workspace selects the last equally specific owner.
        let roots = workspaces
            .iter()
            .filter(|workspace| workspace.workspace_kind != WorkspaceKind::Remote)
            .map(|workspace| (workspace.id.clone(), workspace.root_path.clone()))
            .collect::<Vec<_>>();
        let mut ownership = self
            .ownership
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if ownership
            .as_ref()
            .is_none_or(|cached| cached.roots != roots)
        {
            let mut normalized = HashMap::<PathBuf, String>::new();
            let mut normalize_once = |path: &Path| {
                normalized
                    .entry(path.to_path_buf())
                    .or_insert_with(|| normalize(path))
                    .clone()
            };
            let normalized_roots = roots
                .iter()
                .map(|(id, root)| (id, normalize_once(root)))
                .collect::<Vec<_>>();
            let mut owners = HashMap::<&str, Option<&String>>::new();
            let mut candidates = HashMap::<String, Vec<usize>>::new();
            for (index, candidate) in self.catalog.candidates.iter().enumerate() {
                let Some(cwd) = candidate.cwd.as_deref() else {
                    continue;
                };
                let owner = owners.entry(cwd).or_insert_with(|| {
                    #[cfg(test)]
                    self.ownership_resolutions.fetch_add(1, Ordering::Relaxed);
                    let source = normalize_once(Path::new(cwd));
                    normalized_roots
                        .iter()
                        .filter(|(_, root)| {
                            source == *root
                                || source
                                    .strip_prefix(root.as_str())
                                    .is_some_and(|suffix| suffix.starts_with('/'))
                        })
                        .max_by_key(|(_, root)| root.len())
                        .map(|(id, _)| *id)
                });
                if let Some(owner) = owner {
                    candidates.entry((*owner).clone()).or_default().push(index);
                }
            }
            *ownership = Some(CatalogOwnership { roots, candidates });
        }
        ownership
            .as_ref()
            .unwrap()
            .candidates
            .get(&workspace.id)
            .into_iter()
            .flatten()
            .map(|index| self.catalog.candidates[*index].clone())
            .collect()
    }
}

type SourceCatalogs = tokio::sync::Mutex<HashMap<String, (Instant, Arc<SourceCatalog>)>>;
static SOURCE_CATALOGS: LazyLock<SourceCatalogs> = LazyLock::new(Default::default);

async fn shared_catalog(
    cache: &SourceCatalogs,
    ecosystem: &str,
    requested_at: Instant,
    read: impl FnOnce() -> Result<ExternalSessionCatalog, String> + Send + 'static,
) -> Result<Arc<SourceCatalog>, String> {
    // Serialize source scans across workspaces. Requests already queued when a
    // scan finishes share that snapshot; a later workspace activation refreshes it.
    let mut cache = cache.lock().await;
    if let Some((completed_at, catalog)) = cache.get(ecosystem) {
        if *completed_at >= requested_at {
            return Ok(catalog.clone());
        }
    }
    let catalog = Arc::new(SourceCatalog::new(
        tokio::task::spawn_blocking(read)
            .await
            .map_err(|error| error.to_string())??,
    ));
    cache.insert(ecosystem.into(), (Instant::now(), catalog.clone()));
    Ok(catalog)
}

async fn register_catalog(
    store: &OfflineSessionImportStore,
    workspace: &WorkspaceInfo,
    project: &WorkspaceInfo,
    workspaces: &[WorkspaceInfo],
    catalog: &SourceCatalog,
    cancelled: &AtomicBool,
) -> DiscoveryResult {
    if cancelled.load(Ordering::Acquire) {
        return DiscoveryResult::default();
    }
    let mut result = DiscoveryResult::default();
    let has_workspace_unresolved = catalog
        .catalog
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "workspace_unresolved");
    let has_read_failure = catalog
        .catalog
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code != "workspace_unresolved");
    if has_read_failure {
        result.warnings.push(format!(
            "Some {} source records could not be read",
            catalog.catalog.ecosystem_id
        ));
    }
    if has_workspace_unresolved {
        result.warnings.push(format!(
            "Some {} sessions could not be matched to a workspace",
            catalog.catalog.ecosystem_id
        ));
    }
    result
        .diagnostics
        .extend(
            catalog
                .catalog
                .diagnostics
                .iter()
                .map(|diagnostic| SessionDiscoveryDiagnostic {
                    ecosystem_id: catalog.catalog.ecosystem_id.clone(),
                    code: diagnostic.code.clone(),
                }),
        );
    let candidates = catalog.workspace_candidates(workspace, workspaces, normalized_path);
    if let Err(error) =
        super::deferred::register(store.sessions_root(), workspace, project, candidates).await
    {
        log::warn!("External session index could not be updated: {error}");
        result
            .warnings
            .push("External session discovery index could not be updated".into());
    }
    result
}

pub(super) fn belongs_to_workspace(
    candidate: &ExternalSessionCandidate,
    workspace: &WorkspaceInfo,
    workspaces: &[WorkspaceInfo],
) -> bool {
    workspace.workspace_kind != WorkspaceKind::Remote
        && candidate
            .cwd
            .as_deref()
            .and_then(|cwd| matching_workspace(workspaces, Path::new(cwd)))
            .is_some_and(|owner| owner.id == workspace.id)
}

pub(super) fn source_identity(custom: Option<&serde_json::Value>) -> Option<(String, String)> {
    let custom = custom?;
    Some((
        custom.get("importedFrom")?.as_str()?.to_owned(),
        custom.get("sourceSessionId")?.as_str()?.to_owned(),
    ))
}

pub(super) fn automatic_session_id(workspace: &str, ecosystem: &str, source: &str) -> String {
    let mut hash = Sha256::new();
    for value in [workspace, ecosystem, source] {
        hash.update(value.len().to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("{ecosystem}-import-{:x}", hash.finalize())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use openbitfun_product_domains::session_import::{
        ExternalSessionItem, ExternalSessionStatus, ExternalSessionTurn,
    };

    #[tokio::test]
    async fn background_discovery_is_shared_and_survives_the_initiating_read() {
        let key = Uuid::new_v4().to_string();
        let (release, wait) = tokio::sync::oneshot::channel();
        let first = schedule_discovery(
            key.clone(),
            vec!["codex".into()],
            false,
            None,
            |_| async move {
                wait.await.unwrap();
                DiscoveryResult {
                    warnings: vec!["fixture warning".into()],
                    ..DiscoveryResult::default()
                }
            },
        )
        .await;
        assert!(first.pending);
        // A metadata read finishes while the worker continues independently.
        let second = schedule_discovery(key.clone(), vec!["codex".into()], true, None, |_| async {
            panic!("An open during discovery must share the running worker")
        })
        .await;
        assert!(second.pending);
        release.send(()).unwrap();
        let final_snapshot = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                tokio::task::yield_now().await;
                let snapshot =
                    schedule_discovery(key.clone(), vec!["codex".into()], false, None, |_| async {
                        panic!("A metadata read must reuse completed discovery")
                    })
                    .await;
                if !snapshot.pending {
                    break snapshot;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(final_snapshot.warnings, vec!["fixture warning"]);
    }

    #[tokio::test]
    async fn disabling_discovery_cancels_pending_work_without_retaining_stale_issues() {
        let key = Uuid::new_v4().to_string();
        let (started, start) = tokio::sync::oneshot::channel();
        let (stopped, stop) = tokio::sync::oneshot::channel();
        schedule_discovery(
            key.clone(),
            vec!["codex".into()],
            false,
            None,
            |cancelled| async move {
                started.send(()).unwrap();
                while !cancelled.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
                stopped.send(()).unwrap();
                DiscoveryResult {
                    warnings: vec!["must not become visible".into()],
                    ..DiscoveryResult::default()
                }
            },
        )
        .await;
        start.await.unwrap();
        let disabled = schedule_discovery(key.clone(), vec![], false, None, |_| async {
            panic!("Disabled reader")
        })
        .await;
        assert!(!disabled.pending);
        tokio::time::timeout(Duration::from_secs(2), stop)
            .await
            .unwrap()
            .unwrap();
        let snapshot = schedule_discovery(key, vec![], false, None, |_| async {
            panic!("Disabled reader")
        })
        .await;
        assert!(snapshot.warnings.is_empty());
    }

    pub(crate) fn workspace(id: &str, root: &Path, kind: WorkspaceKind) -> WorkspaceInfo {
        serde_json::from_value(json!({
            "id": id, "name": id, "rootPath": root, "workspaceType": "Other",
            "workspaceKind": kind, "status": "Inactive", "languages": [],
            "openedAt": "2026-01-01T00:00:00Z", "lastAccessed": "2026-01-01T00:00:00Z",
            "tags": [], "metadata": {}
        }))
        .unwrap()
    }

    pub(crate) fn candidate(source: &str, id: &str, root: &Path) -> ExternalSessionCandidate {
        serde_json::from_value(json!({
            "candidateId": format!("{source}:{id}"), "ecosystemId": source, "sourceSessionId": id,
            "title": id, "cwd": root, "fileSizeBytes": 100, "status": "complete", "fingerprint": "new-version"
        })).unwrap()
    }

    pub(crate) fn document(candidate: ExternalSessionCandidate) -> ExternalSessionDocument {
        ExternalSessionDocument {
            candidate,
            warnings: vec![],
            turns: vec![ExternalSessionTurn {
                source_turn_id: "source-turn".into(),
                timestamp: 1234,
                user_text: "Saved question".into(),
                items: vec![ExternalSessionItem::Text {
                    text: "Saved answer".into(),
                }],
                source_event_count: 2,
                status: ExternalSessionStatus::Complete,
            }],
        }
    }

    fn catalog(source: &str, candidates: Vec<ExternalSessionCandidate>) -> ExternalSessionCatalog {
        ExternalSessionCatalog {
            schema_version: 1,
            ecosystem_id: source.into(),
            source_revision: "test".into(),
            candidates,
            diagnostics: vec![],
            next_cursor: None,
        }
    }

    #[tokio::test]
    async fn catalog_diagnostics_keep_read_and_workspace_failures_separate() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = workspace("project", temp.path(), WorkspaceKind::Normal);
        let mut source_catalog = catalog("cursor", vec![]);
        source_catalog.diagnostics = vec![
            ExternalSessionImportWarning {
                code: "source_unreadable".into(),
                detail: "fixture source could not be read".into(),
            },
            ExternalSessionImportWarning {
                code: "workspace_unresolved".into(),
                detail: "fixture source has no workspace".into(),
            },
        ];

        let result = register_catalog(
            &OfflineSessionImportStore::new(temp.path().join("native")),
            &workspace,
            &workspace,
            std::slice::from_ref(&workspace),
            &SourceCatalog::new(source_catalog),
            &AtomicBool::new(false),
        )
        .await;

        assert_eq!(
            result.warnings,
            vec![
                "Some cursor source records could not be read",
                "Some cursor sessions could not be matched to a workspace",
            ]
        );
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| (diagnostic.ecosystem_id.as_str(), diagnostic.code.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("cursor", "source_unreadable"),
                ("cursor", "workspace_unresolved"),
            ]
        );
    }

    #[tokio::test]
    async fn centralized_metadata_storage_discovers_all_codex_history_beyond_existing_imports() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let project = workspace("project", &project_root, WorkspaceKind::Normal);
        let runtime = crate::service::WorkspaceRuntimeService::new(Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(temp.path().join("user")),
        ));
        let storage = runtime
            .context_for_local_workspace(&project_root)
            .sessions_dir;
        assert_ne!(normalized_path(&storage), normalized_path(&project_root));
        let workspaces = vec![project.clone()];
        let selected = workspaces_for_storage_path(&storage, &workspaces, &runtime);
        assert_eq!(
            selected.len(),
            1,
            "The native metadata API passes centralized storage, not source cwd"
        );
        let codex_home = temp.path().join("codex");
        std::fs::create_dir_all(codex_home.join("sessions")).unwrap();
        for index in 0..57 {
            let events = [
                json!({"type":"session_meta","payload":{"id":index.to_string(),"cwd":project_root}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Saved question"}]}}),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Saved answer"}]}}),
            ];
            std::fs::write(
                codex_home.join(format!("sessions/rollout-{index}.jsonl")),
                events
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap();
        }
        let reader = Arc::new(CodexSessionReader::new(codex_home));
        let discovered = reader.discover_all().unwrap();
        let store = OfflineSessionImportStore::new(&storage);
        // The old UI's one already-imported session must not hide the other 56.
        let existing = reader
            .read_candidate(
                &discovered.candidates[0].candidate_id,
                ExternalSessionImportMode::Full,
            )
            .unwrap();
        let legacy = convert_document(
            "previous-import",
            &project,
            &project,
            "primary",
            "Previously imported",
            &existing,
            true,
            true,
        )
        .unwrap();
        store.write_bundle_atomic(&legacy).await.unwrap();
        let warnings = register_catalog(
            &store,
            selected[0],
            &project,
            &workspaces,
            &SourceCatalog::new(discovered),
            &AtomicBool::new(false),
        )
        .await;
        assert!(
            warnings.warnings.is_empty() && warnings.diagnostics.is_empty(),
            "{warnings:?}"
        );
        let native = store.list_metadata_including_internal().await.unwrap();
        assert_eq!(
            native.len(),
            1,
            "Startup must keep the one existing copy and write no transcript bodies"
        );
        let merged = super::super::deferred::merge_metadata(&storage, native)
            .await
            .unwrap();
        let page = openbitfun_services_core::session::build_session_metadata_page(merged, None, 5);
        assert_eq!(
            page.total_top_level_count, 58,
            "57 followed sources plus the existing independent import"
        );
        assert!(page.has_more);
        assert!(store
            .load_bundle("previous-import")
            .await
            .unwrap()
            .is_some());
    }

    #[test]
    fn centralized_storage_matches_project_and_linked_worktree_but_never_a_remote_mirror() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = crate::service::WorkspaceRuntimeService::new(Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(temp.path().join("user")),
        ));
        let project = workspace(
            "project",
            &temp.path().join("project"),
            WorkspaceKind::Normal,
        );
        let mut tree = workspace("tree", &temp.path().join("tree"), WorkspaceKind::Normal);
        tree.worktree = Some(serde_json::from_value(json!({
            "mainWorkspaceId":"project", "path":tree.root_path, "mainRepoPath":project.root_path, "isMain":false
        })).unwrap());
        let remote = workspace("remote", &project.root_path, WorkspaceKind::Remote);
        let rows = vec![project.clone(), tree, remote];
        let storage = runtime
            .context_for_local_workspace(&project.root_path)
            .sessions_dir;
        let ids = workspaces_for_storage_path(&storage, &rows, &runtime)
            .into_iter()
            .map(|w| w.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["project", "tree"]);
        let mirror = runtime
            .context_for_remote_workspace("host", "/project")
            .sessions_dir;
        assert!(workspaces_for_storage_path(&mirror, &rows, &runtime).is_empty());
    }

    #[tokio::test]
    async fn reopening_a_workspace_refreshes_a_completed_scan_from_its_host_activation_revision() {
        let key = Uuid::new_v4().to_string();
        for activation in [1, 2] {
            assert!(
                schedule_discovery(
                    key.clone(),
                    vec!["codex".into()],
                    false,
                    Some(activation),
                    |_| async { DiscoveryResult::default() }
                )
                .await
                .pending
            );
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    tokio::task::yield_now().await;
                    if !schedule_discovery(
                        key.clone(),
                        vec!["codex".into()],
                        false,
                        Some(activation),
                        |_| async { panic!("The same activation reuses its scan") },
                    )
                    .await
                    .pending
                    {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn queued_workspaces_share_one_source_scan_and_later_activation_refreshes() {
        let cache = SourceCatalogs::default();
        let requested = Instant::now();
        let first = shared_catalog(&cache, "codex", requested, || Ok(catalog("codex", vec![])))
            .await
            .unwrap();
        let second = shared_catalog(&cache, "codex", requested, || {
            panic!("Already scanned for this activation batch")
        })
        .await
        .unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let third = shared_catalog(&cache, "codex", Instant::now(), || {
            Ok(catalog("codex", vec![]))
        })
        .await
        .unwrap();
        assert!(!Arc::ptr_eq(&first, &third));
    }

    #[tokio::test]
    async fn cancelled_registration_creates_no_index_or_session_files() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = workspace("project", temp.path(), WorkspaceKind::Normal);
        let root = temp.path().join("native");
        let warnings = register_catalog(
            &OfflineSessionImportStore::new(&root),
            &workspace,
            &workspace,
            &[workspace.clone()],
            &SourceCatalog::new(catalog("codex", vec![candidate("codex", "a", temp.path())])),
            &AtomicBool::new(true),
        )
        .await;
        assert!(warnings.warnings.is_empty() && warnings.diagnostics.is_empty());
        assert!(!root.exists());
    }

    #[test]
    fn ownership_uses_the_nearest_registered_local_workspace_and_rejects_remote_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = workspace("root", temp.path(), WorkspaceKind::Normal);
        let nested = workspace("nested", &temp.path().join("nested"), WorkspaceKind::Normal);
        let remote = workspace("remote", temp.path(), WorkspaceKind::Remote);
        let sources = vec![root.clone(), nested.clone(), remote.clone()];
        let nested_candidate = candidate("codex", "nested", &nested.root_path.join("src"));
        assert!(belongs_to_workspace(&nested_candidate, &nested, &sources));
        assert!(!belongs_to_workspace(&nested_candidate, &root, &sources));
        assert!(!belongs_to_workspace(
            &candidate("codex", "local", temp.path()),
            &remote,
            &sources
        ));
        assert!(!belongs_to_workspace(
            &candidate("codex", "sibling", &temp.path().with_extension("sibling")),
            &root,
            &sources
        ));
    }

    #[test]
    fn catalog_ownership_normalizes_unique_paths_once_for_all_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let root = workspace("root", temp.path(), WorkspaceKind::Normal);
        let nested = workspace("nested", &temp.path().join("nested"), WorkspaceKind::Normal);
        let remote = workspace("remote", &nested.root_path, WorkspaceKind::Remote);
        let workspaces = vec![root.clone(), nested.clone(), remote.clone()];
        let mut candidates = Vec::new();
        for index in 0..200 {
            let cwd = if index % 2 == 0 {
                root.root_path.join("src")
            } else {
                nested.root_path.join("src")
            };
            candidates.push(candidate("codex", &index.to_string(), &cwd));
        }
        candidates.push(candidate(
            "codex",
            "sibling",
            &temp.path().with_extension("sibling"),
        ));
        let mut missing = candidate("codex", "missing", temp.path());
        missing.cwd = None;
        candidates.push(missing);
        let source = SourceCatalog::new(catalog("codex", candidates));
        let mut normalized = Vec::new();
        for workspace in &workspaces {
            let actual = source.workspace_candidates(workspace, &workspaces, |path| {
                normalized.push(path.to_path_buf());
                normalized_path(path)
            });
            let expected = source
                .catalog
                .candidates
                .iter()
                .filter(|candidate| belongs_to_workspace(candidate, workspace, &workspaces))
                .map(|candidate| &candidate.candidate_id)
                .collect::<Vec<_>>();
            assert_eq!(
                actual
                    .iter()
                    .map(|candidate| &candidate.candidate_id)
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert_eq!(normalized.len(), 5, "Two local roots and three distinct source directories, shared across all workspace readers");
        assert_eq!(
            normalized
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            5
        );

        assert_eq!(
            source.ownership_resolutions.load(Ordering::Relaxed),
            3,
            "Resolve each distinct source directory once, not once per session or workspace"
        );
        let replacement = workspace("replacement", &nested.root_path, WorkspaceKind::Normal);
        let changed_registry = vec![root, nested, remote, replacement.clone()];
        let actual = source.workspace_candidates(&replacement, &changed_registry, |path| {
            normalized.push(path.to_path_buf());
            normalized_path(path)
        });
        assert_eq!(
            actual.len(),
            100,
            "Registry changes invalidate ownership; the last equal root wins"
        );
        assert_eq!(
            normalized.len(),
            10,
            "A new registry snapshot resolves paths afresh, still once per unique path"
        );
        assert_eq!(source.ownership_resolutions.load(Ordering::Relaxed), 6);
    }
}
