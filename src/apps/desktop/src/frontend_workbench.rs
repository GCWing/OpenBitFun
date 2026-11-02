//! Writable packaged-frontend revisions with crash-safe provisional activation.

mod overrides;

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use openbitfun_core::agentic::tools::frontend_workbench_host::{
    set_frontend_workbench_handler, FrontendWorkbenchHostRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Notify;
use uuid::Uuid;

pub const FRONTEND_PROTOCOL_SCHEME: &str = "openbitfun-ui";
pub const FRONTEND_URL: &str = "openbitfun-ui://localhost/index.html";
const CONFIRM_WINDOW_LABEL: &str = "frontend-update-confirm";
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(15);
const CANDIDATE_READY_TIMEOUT: Duration = Duration::from_secs(15);
const TRANSACTION_WAIT_GRACE: Duration = Duration::from_secs(3);
const STATE_SCHEMA_VERSION: u32 = 2;
const BUNDLED_MANIFEST_SCHEMA_VERSION: u32 = 1;
const BUNDLED_MANIFEST_ALGORITHM: &str = "sha256-path-content-v1";
const BUNDLED_MANIFEST_FILE: &str = "frontend-revision.json";
const COPY_STAGING_PREFIX: &str = ".copy-";
const RECOVERY_HTML: &[u8] = include_bytes!("../bootstrap-ui/index.html");
const CONFIRMATION_HTML: &[u8] = include_bytes!("../bootstrap-ui/frontend-update-confirm.html");
const BOOTSTRAP_THEME_CSS: &[u8] = include_bytes!("generated/bootstrap_theme.css");

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FrontendWorkbenchState {
    schema_version: u32,
    bundled_revision: Option<String>,
    /// Last user-confirmed revision. A provisional candidate never becomes
    /// active until the immutable confirmation surface commits it.
    active_revision: Option<String>,
    previous_revision: Option<String>,
    pending: Option<PendingFrontendRevision>,
    last_outcome: Option<FrontendUpdateOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PendingFrontendRevision {
    transaction_id: String,
    revision_id: String,
    previous_revision: String,
    phase: FrontendUpdatePhase,
    candidate_ready_deadline_unix_ms: u64,
    expires_at_unix_ms: Option<u64>,
}

impl Default for PendingFrontendRevision {
    fn default() -> Self {
        Self {
            transaction_id: String::new(),
            revision_id: String::new(),
            previous_revision: String::new(),
            phase: FrontendUpdatePhase::LoadingCandidate,
            candidate_ready_deadline_unix_ms: 0,
            expires_at_unix_ms: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FrontendUpdatePhase {
    #[default]
    LoadingCandidate,
    AwaitingConfirmation,
}

impl FrontendUpdatePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::LoadingCandidate => "loading_candidate",
            Self::AwaitingConfirmation => "awaiting_confirmation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendUpdateOutcome {
    transaction_id: String,
    status: String,
    revision_id: String,
    active_revision: String,
    reason: Option<String>,
    completed_at_unix_ms: u64,
}

#[derive(Debug, Default)]
struct MainNavigationState {
    current_url: Option<Url>,
    armed_url: Option<Url>,
}

#[derive(Debug, Clone)]
struct BundledFrontendSource {
    revision_id: String,
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledFrontendManifest {
    schema_version: u32,
    revision: String,
    algorithm: String,
    digest: String,
    file_count: u64,
    total_bytes: u64,
}

pub struct FrontendWorkbenchManager {
    root: PathBuf,
    state: Mutex<FrontendWorkbenchState>,
    bundled_source: Mutex<Option<BundledFrontendSource>>,
    bundled_materialization_started: AtomicBool,
    app: OnceLock<tauri::AppHandle>,
    transaction_changed: Notify,
    main_navigation: Mutex<MainNavigationState>,
}

impl FrontendWorkbenchManager {
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            root: user_data_dir.join("frontend-workbench"),
            state: Mutex::new(FrontendWorkbenchState::default()),
            bundled_source: Mutex::new(None),
            bundled_materialization_started: AtomicBool::new(false),
            app: OnceLock::new(),
            transaction_changed: Notify::new(),
            main_navigation: Mutex::new(MainNavigationState::default()),
        }
    }

    fn revisions_dir(&self) -> PathBuf {
        self.root.join("revisions")
    }

    fn drafts_dir(&self) -> PathBuf {
        self.root.join("drafts")
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn state_backup_path(&self) -> PathBuf {
        self.root.join("state.previous.json")
    }

    fn revision_dir(&self, revision_id: &str) -> PathBuf {
        self.revisions_dir().join(revision_id)
    }

    pub fn initialize(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        bundled_frontend: &Path,
    ) -> Result<(), String> {
        let started_at = Instant::now();
        // Release bundles carry a build-time content identity. Startup reads
        // only that small manifest and index.html metadata; it must never walk,
        // hash, or copy the complete frontend tree before creating the window.
        let bundled_source = resolve_bundled_frontend_source(bundled_frontend)?;
        let bundled_revision = bundled_source.revision_id.clone();
        *self.bundled_source.lock().map_err(lock_error)? = Some(bundled_source);

        fs::create_dir_all(self.revisions_dir()).map_err(io_error("create revision directory"))?;
        fs::create_dir_all(self.drafts_dir()).map_err(io_error("create draft directory"))?;

        let state = self.load_reconcile_and_save_state(&bundled_revision)?;
        *self.state.lock().map_err(lock_error)? = state;
        let _ = self.app.set(app.clone());
        self.install_tool_host();
        log::info!(
            "Frontend workbench initialized from packaged assets: revision_id={}, cached={}, duration_ms={}",
            bundled_revision,
            self.revision_dir(&bundled_revision)
                .join("index.html")
                .is_file(),
            started_at.elapsed().as_millis()
        );
        Ok(())
    }

    fn load_reconcile_and_save_state(
        &self,
        bundled_revision: &str,
    ) -> Result<FrontendWorkbenchState, String> {
        let mut state = self.load_state();
        state.schema_version = STATE_SCHEMA_VERSION;

        // A pending candidate can never survive a process exit. Schema v1
        // provisionally wrote the candidate into active_revision, while schema
        // v2 keeps active_revision confirmed-only; restoring the recorded prior
        // revision handles both shapes safely.
        if let Some(pending) = state.pending.take() {
            if self.revision_is_available(&pending.previous_revision) {
                state.active_revision = Some(pending.previous_revision.clone());
                state.last_outcome = Some(FrontendUpdateOutcome {
                    transaction_id: pending.transaction_id.clone(),
                    status: "rolled_back".to_string(),
                    revision_id: pending.revision_id,
                    active_revision: pending.previous_revision,
                    reason: Some("process_restart".to_string()),
                    completed_at_unix_ms: unix_ms(),
                });
                log::warn!(
                    "Recovered an unconfirmed frontend update by rolling back: transaction_id={}",
                    pending.transaction_id
                );
            } else {
                // Never keep serving an unconfirmed candidate just because its
                // prior revision was damaged outside OpenBitFun. The bundled copy
                // below becomes the recovery target.
                state.active_revision = None;
                state.previous_revision = None;
                log::warn!(
                    "Discarded an unconfirmed frontend update whose previous revision is unavailable: transaction_id={}",
                    pending.transaction_id
                );
            }
        }

        let bundled_changed = state.bundled_revision.as_deref() != Some(bundled_revision);
        let active_is_valid = state
            .active_revision
            .as_deref()
            .is_some_and(|revision| self.revision_is_available(revision));
        if bundled_changed {
            // Override revisions contain no application bundle. They keep using
            // the newly installed host and its compatible versioned UI API.
            let active_is_overlay = state.active_revision.as_deref().is_some_and(|id| {
                self.revision_root(id)
                    .is_ok_and(|root| overrides::is_overlay(&root))
            });
            if !active_is_valid || !active_is_overlay {
                state.previous_revision = state.active_revision.filter(|_| active_is_valid);
                state.active_revision = Some(bundled_revision.to_string());
            }
            state.bundled_revision = Some(bundled_revision.to_string());
        } else if !active_is_valid {
            state.active_revision = Some(bundled_revision.to_string());
            state.bundled_revision = Some(bundled_revision.to_string());
            state.previous_revision = None;
        }

        // Always commit the reconciled state. load_state deliberately preserves
        // an unreadable primary before falling back to state.previous.json; a
        // conditional write would leave that primary broken and repeat recovery
        // plus state.invalid.* creation on every launch.
        self.save_state(&state)?;
        Ok(state)
    }

    /// Preserve the packaged revision for cross-version rollback without
    /// putting its full tree scan and copy on the window-creation critical
    /// path. The main window calls this after its document finishes loading.
    pub fn materialize_bundled_revision_in_background(self: &Arc<Self>) {
        if self
            .bundled_source
            .lock()
            .ok()
            .and_then(|source| source.clone())
            .is_none()
        {
            return;
        }
        if self
            .bundled_materialization_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }

        let manager = Arc::clone(self);
        let worker = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let result =
                tokio::task::spawn_blocking(move || worker.materialize_current_bundled_revision())
                    .await
                    .map_err(|error| format!("Bundled frontend cache worker failed: {error}"))
                    .and_then(|result| result);
            manager
                .bundled_materialization_started
                .store(false, Ordering::Release);
            match result {
                Ok(Some(revision_id)) => log::info!(
                    "Packaged frontend revision cached after startup: revision_id={}",
                    revision_id
                ),
                Ok(None) => {}
                Err(error) => log::warn!(
                    "Failed to cache packaged frontend revision after startup: error={}",
                    error
                ),
            }
        });
    }

    fn materialize_current_bundled_revision(&self) -> Result<Option<String>, String> {
        let source = self
            .bundled_source
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or_else(|| "Bundled frontend source is unavailable".to_string())?;
        match cleanup_stale_copy_directories(&self.revisions_dir()) {
            Ok(count) if count > 0 => log::info!(
                "Removed stale frontend copy staging directories: count={}",
                count
            ),
            Ok(_) => {}
            Err(error) => log::warn!(
                "Failed to clean stale frontend copy staging directories: error={}",
                error
            ),
        }
        let destination = self.revision_dir(&source.revision_id);
        if destination.join("index.html").is_file() {
            return Ok(None);
        }
        copy_tree_transactional(&source.root, &destination)?;
        Ok(Some(source.revision_id))
    }

    fn install_tool_host(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        set_frontend_workbench_handler(Arc::new(move |request| {
            let manager = Arc::clone(&manager);
            Box::pin(async move { manager.handle_tool_request(request).await })
        }));
    }

    async fn handle_tool_request(
        self: &Arc<Self>,
        request: FrontendWorkbenchHostRequest,
    ) -> Result<Value, String> {
        ensure_local_confirmation_surface(
            crate::api::peer_host_invoke::attached_controllers().len(),
        )?;
        match request.action.as_str() {
            "prepare" => self.prepare(),
            "status" => self.status(),
            "inspect" | "invoke" => {
                let runtime = crate::openbitfun_control_host::dispatch_creation_runtime(
                    &request.action,
                    request.command_id,
                    request.arguments,
                )
                .await?;
                Ok(json!({ "frontend": self.status()?, "runtime": runtime }))
            }
            "apply" => {
                self.apply(
                    request
                        .draft_id
                        .as_deref()
                        .ok_or_else(|| "draft_id is required for apply".to_string())?,
                )
                .await
            }
            "rollback" => self.rollback_confirmed(),
            other => Err(format!("Unsupported FrontendWorkbench action: {other}")),
        }
    }

    fn prepare(&self) -> Result<Value, String> {
        let active_revision = self
            .state
            .lock()
            .map_err(lock_error)?
            .active_revision
            .clone()
            .ok_or_else(|| "No active frontend revision is available".to_string())?;
        validate_revision_id(&active_revision)?;
        let draft_id = Uuid::new_v4().to_string();
        let draft_path = self.drafts_dir().join(&draft_id);
        fs::create_dir_all(&draft_path).map_err(io_error("create customization draft"))?;
        for file in [overrides::CSS, overrides::JS] {
            let source = self
                .asset_root(&active_revision, Path::new(file))?
                .join(file);
            fs::copy(source, draft_path.join(file))
                .map_err(io_error("copy customization entrypoint"))?;
        }
        let source_root = self.revision_root(&active_revision)?;
        if source_root.join("creation-assets").is_dir() {
            copy_asset_tree_transactional(
                &source_root.join("creation-assets"),
                &draft_path.join("creation-assets"),
            )?;
        }
        let bundled = self
            .bundled_source
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or_else(|| "Packaged frontend is unavailable".to_string())?;
        fs::copy(
            bundled.root.join(overrides::API_DOC),
            draft_path.join(overrides::API_DOC),
        )
        .map_err(io_error("copy customization API reference"))?;
        // This base belongs to the host, outside the editable directory.
        fs::write(
            self.drafts_dir().join(format!("{draft_id}.json")),
            serde_json::to_vec(&overrides::DraftBase {
                base_revision: active_revision.clone(),
            })
            .map_err(|error| error.to_string())?,
        )
        .map_err(io_error("write customization draft base"))?;
        fs::write(
            draft_path.join("CREATION.md"),
            format!(
                "# OpenBitFun UI customization\n\nDraft id: `{draft_id}`\nBase revision: `{active_revision}`\n\nRead `openbitfun-creation-api.md`. Edit `openbitfun-creation.css` and `openbitfun-creation.js`; put optional modules/assets under `creation-assets/`. JavaScript exports a default activation function receiving the versioned UI API, and may return cleanup. The host loads it after the real shell is ready and loads CSS last. No repository, Node.js, package installation, build, or index.html edit is needed. Preserve existing customizations unless asked to replace them. Apply with `FrontendWorkbench` and this draft id. The host waits for activation, then provides 15 seconds to keep or roll back.\n"
            ),
        )
        .map_err(io_error("write draft instructions"))?;

        Ok(json!({
            "status": "prepared",
            "draftId": draft_id,
            "draftPath": draft_path.to_string_lossy(),
            "baseRevision": active_revision,
            "format": "overlay",
            "apiVersion": 1,
            "files": {
                "css": draft_path.join(overrides::CSS).to_string_lossy(),
                "javascript": draft_path.join(overrides::JS).to_string_lossy(),
                "apiReference": draft_path.join(overrides::API_DOC).to_string_lossy(),
            },
        }))
    }

    async fn apply(self: &Arc<Self>, draft_id: &str) -> Result<Value, String> {
        let transaction_id = self.begin_apply(draft_id)?;
        let wait_budget = CANDIDATE_READY_TIMEOUT + CONFIRM_TIMEOUT + TRANSACTION_WAIT_GRACE;
        match tokio::time::timeout(wait_budget, self.wait_for_outcome(&transaction_id)).await {
            Ok(outcome) => outcome,
            Err(_) => {
                let rollback = self.rollback_pending(&transaction_id, "host_wait_timeout");
                match rollback {
                    Ok(outcome) => Ok(outcome),
                    Err(error) => Err(format!(
                        "Frontend update did not reach a final state and emergency rollback failed: {error}"
                    )),
                }
            }
        }
    }

    fn begin_apply(self: &Arc<Self>, draft_id: &str) -> Result<String, String> {
        validate_uuid(draft_id, "draft_id")?;
        let draft_path = self.drafts_dir().join(draft_id);
        let base_path = self.drafts_dir().join(format!("{draft_id}.json"));
        let draft_base = if base_path.exists() {
            let base: overrides::DraftBase = serde_json::from_slice(
                &fs::read(base_path).map_err(io_error("read customization draft base"))?,
            )
            .map_err(|error| format!("Invalid customization draft base: {error}"))?;
            overrides::validate(&draft_path)?;
            Some(base)
        } else {
            // Legacy full-frontend drafts retain their original apply path.
            validate_frontend_tree(&draft_path)?;
            None
        };

        if self.state.lock().map_err(lock_error)?.pending.is_some() {
            return Err(
                "Another frontend update is awaiting a decision; keep or roll it back first"
                    .to_string(),
            );
        }

        let revision_id = format!("creative-{}", Uuid::new_v4());
        copy_asset_tree_transactional(&draft_path, &self.revision_dir(&revision_id))?;
        if draft_base.is_some() {
            overrides::write_manifest(&self.revision_dir(&revision_id))?;
        }
        let transaction_id = Uuid::new_v4().to_string();
        let candidate_ready_deadline_unix_ms =
            unix_ms().saturating_add(CANDIDATE_READY_TIMEOUT.as_millis() as u64);

        {
            let mut state = self.state.lock().map_err(lock_error)?;
            if state.pending.is_some() {
                let _ = fs::remove_dir_all(self.revision_dir(&revision_id));
                return Err(
                    "Another frontend update is awaiting a decision; keep or roll it back first"
                        .to_string(),
                );
            }
            let previous_revision = state
                .active_revision
                .clone()
                .ok_or_else(|| "No active frontend revision is available".to_string())?;
            if draft_base
                .as_ref()
                .is_some_and(|base| base.base_revision != previous_revision)
            {
                let _ = fs::remove_dir_all(self.revision_dir(&revision_id));
                return Err("The active frontend changed after this draft was prepared. Prepare a new draft and reapply your edits to avoid overwriting another customization".to_string());
            }
            let mut next = state.clone();
            next.pending = Some(PendingFrontendRevision {
                transaction_id: transaction_id.clone(),
                revision_id: revision_id.clone(),
                previous_revision,
                phase: FrontendUpdatePhase::LoadingCandidate,
                candidate_ready_deadline_unix_ms,
                expires_at_unix_ms: None,
            });
            self.save_state(&next)?;
            *state = next;
        }

        self.arm_phase_timeout(
            transaction_id.clone(),
            FrontendUpdatePhase::LoadingCandidate,
            CANDIDATE_READY_TIMEOUT,
            "candidate_ready_timeout",
        );

        let activation_result = self
            .app
            .get()
            .cloned()
            .ok_or_else(|| "Frontend workbench desktop host is not initialized".to_string())
            .and_then(|app| {
                show_confirmation_window(&app, &transaction_id, Arc::clone(self))?;
                self.navigate_main_to_revision(&app, &revision_id, Some(&transaction_id))
            });
        if let Err(activation_error) = activation_result {
            return match self.rollback_pending(&transaction_id, "activation_error") {
                Ok(_) => Err(activation_error),
                Err(rollback_error) => Err(format!(
                    "{activation_error}; the immediate rollback also failed: {rollback_error}"
                )),
            };
        }

        Ok(transaction_id)
    }

    fn arm_phase_timeout(
        self: &Arc<Self>,
        transaction_id: String,
        expected_phase: FrontendUpdatePhase,
        duration: Duration,
        reason: &'static str,
    ) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(duration).await;
            if let Err(error) = manager.rollback_if_phase(&transaction_id, expected_phase, reason) {
                log::warn!(
                    "Failed to auto-rollback provisional frontend update: transaction_id={}, phase={}, error={}",
                    transaction_id,
                    expected_phase.as_str(),
                    error
                );
            }
        });
    }

    fn rollback_if_phase(
        &self,
        transaction_id: &str,
        expected_phase: FrontendUpdatePhase,
        reason: &str,
    ) -> Result<(), String> {
        let should_rollback = self
            .state
            .lock()
            .map_err(lock_error)?
            .pending
            .as_ref()
            .is_some_and(|pending| {
                pending.transaction_id == transaction_id && pending.phase == expected_phase
            });
        if should_rollback {
            self.rollback_pending(transaction_id, reason)?;
        }
        Ok(())
    }

    async fn wait_for_outcome(&self, transaction_id: &str) -> Result<Value, String> {
        loop {
            let notified = self.transaction_changed.notified();
            {
                let state = self.state.lock().map_err(lock_error)?;
                if let Some(outcome) = state
                    .last_outcome
                    .as_ref()
                    .filter(|outcome| outcome.transaction_id == transaction_id)
                {
                    return Ok(outcome_value(outcome));
                }
                if !state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.transaction_id == transaction_id)
                {
                    return Err(
                        "Frontend update transaction disappeared before completion".to_string()
                    );
                }
            }
            notified.await;
        }
    }

    pub fn mark_candidate_ready(
        self: &Arc<Self>,
        transaction_id: &str,
        document_url: &Url,
    ) -> Result<Value, String> {
        {
            let state = self.state.lock().map_err(lock_error)?;
            let pending = matching_pending(&state, transaction_id)?;
            let expected_url =
                revision_frontend_url_value(&pending.revision_id, Some(&pending.transaction_id))?;
            if !same_main_navigation_target(&expected_url, document_url) {
                return Err(
                    "Frontend readiness came from a document other than the provisional candidate"
                        .to_string(),
                );
            }
        }

        let expires_at_unix_ms = {
            let mut state = self.state.lock().map_err(lock_error)?;
            let (phase, candidate_ready_deadline_unix_ms) = {
                let pending = matching_pending(&state, transaction_id)?;
                (pending.phase, pending.candidate_ready_deadline_unix_ms)
            };
            if phase == FrontendUpdatePhase::AwaitingConfirmation {
                return Ok(self.transaction_status_value(&state, transaction_id)?);
            }
            if unix_ms() >= candidate_ready_deadline_unix_ms {
                drop(state);
                self.rollback_pending(transaction_id, "candidate_ready_timeout")?;
                return Err("The frontend candidate did not become ready in time".to_string());
            }
            let expires_at_unix_ms = unix_ms().saturating_add(CONFIRM_TIMEOUT.as_millis() as u64);
            let mut next = state.clone();
            let next_pending = next
                .pending
                .as_mut()
                .ok_or_else(|| "No frontend update is awaiting readiness".to_string())?;
            next_pending.phase = FrontendUpdatePhase::AwaitingConfirmation;
            next_pending.expires_at_unix_ms = Some(expires_at_unix_ms);
            self.save_state(&next)?;
            *state = next;
            expires_at_unix_ms
        };

        self.arm_phase_timeout(
            transaction_id.to_string(),
            FrontendUpdatePhase::AwaitingConfirmation,
            CONFIRM_TIMEOUT,
            "confirmation_timeout",
        );
        log::info!(
            "Frontend candidate reported interactive readiness: transaction_id={}",
            transaction_id
        );
        Ok(json!({
            "status": FrontendUpdatePhase::AwaitingConfirmation.as_str(),
            "transactionId": transaction_id,
            "expiresAtUnixMs": expires_at_unix_ms,
            "confirmationTimeoutSeconds": CONFIRM_TIMEOUT.as_secs(),
        }))
    }

    fn mark_candidate_failed(
        &self,
        transaction_id: &str,
        document_url: &Url,
        message: &str,
    ) -> Result<Value, String> {
        {
            let state = self.state.lock().map_err(lock_error)?;
            let pending = matching_pending(&state, transaction_id)?;
            let expected = revision_frontend_url_value(&pending.revision_id, Some(transaction_id))?;
            if pending.phase != FrontendUpdatePhase::LoadingCandidate
                || !same_main_navigation_target(&expected, document_url)
            {
                return Err(
                    "Frontend activation failure did not come from the loading candidate".into(),
                );
            }
        }
        let detail: String = message.chars().take(2000).collect();
        self.rollback_pending(
            transaction_id,
            &format!("customization_activation_failed: {detail}"),
        )
    }

    pub fn confirm_pending(&self, transaction_id: &str) -> Result<Value, String> {
        let outcome = {
            let mut state = self.state.lock().map_err(lock_error)?;
            let (phase, expires_at_unix_ms, revision_id, previous_revision) = {
                let pending = matching_pending(&state, transaction_id)?;
                (
                    pending.phase,
                    pending.expires_at_unix_ms,
                    pending.revision_id.clone(),
                    pending.previous_revision.clone(),
                )
            };
            if phase != FrontendUpdatePhase::AwaitingConfirmation {
                return Err("The new frontend is still loading and cannot be kept yet".to_string());
            }
            let expires_at_unix_ms = expires_at_unix_ms
                .ok_or_else(|| "The frontend confirmation deadline is unavailable".to_string())?;
            if unix_ms() >= expires_at_unix_ms {
                drop(state);
                self.rollback_pending(transaction_id, "expired_confirmation")?;
                return Err("The 15-second frontend confirmation window has expired".to_string());
            }
            let outcome = FrontendUpdateOutcome {
                transaction_id: transaction_id.to_string(),
                status: "confirmed".to_string(),
                revision_id: revision_id.clone(),
                active_revision: revision_id.clone(),
                reason: None,
                completed_at_unix_ms: unix_ms(),
            };
            let mut next = state.clone();
            next.active_revision = Some(revision_id);
            next.previous_revision = Some(previous_revision);
            next.pending = None;
            next.last_outcome = Some(outcome.clone());
            self.save_state(&next)?;
            *state = next;
            outcome
        };
        self.transaction_changed.notify_waiters();
        self.close_confirmation_window();
        log::info!(
            "Frontend revision confirmed: transaction_id={}, revision_id={}",
            transaction_id,
            outcome.revision_id
        );
        Ok(outcome_value(&outcome))
    }

    pub fn rollback_pending(&self, transaction_id: &str, reason: &str) -> Result<Value, String> {
        let outcome = {
            let mut state = self.state.lock().map_err(lock_error)?;
            let Some(pending) = state.pending.as_ref() else {
                return self.transaction_status_value(&state, transaction_id);
            };
            if pending.transaction_id != transaction_id {
                return self.transaction_status_value(&state, transaction_id);
            }
            let restored_revision = pending.previous_revision.clone();
            if !self.revision_is_available(&restored_revision) {
                return Err("The previous frontend revision is unavailable".to_string());
            }
            let outcome = FrontendUpdateOutcome {
                transaction_id: transaction_id.to_string(),
                status: "rolled_back".to_string(),
                revision_id: pending.revision_id.clone(),
                active_revision: restored_revision.clone(),
                reason: Some(reason.to_string()),
                completed_at_unix_ms: unix_ms(),
            };
            let mut next = state.clone();
            next.active_revision = Some(restored_revision.clone());
            next.pending = None;
            next.last_outcome = Some(outcome.clone());
            self.save_state(&next)?;
            *state = next;
            outcome
        };
        self.transaction_changed.notify_waiters();
        if let Some(app) = self.app.get() {
            self.navigate_main_to_revision(app, &outcome.active_revision, None)?;
        }
        self.close_confirmation_window();
        log::info!(
            "Frontend revision rolled back: reason={}, restored_revision={}",
            reason,
            outcome.active_revision
        );
        Ok(outcome_value(&outcome))
    }

    fn rollback_confirmed(&self) -> Result<Value, String> {
        let pending_transaction = self
            .state
            .lock()
            .map_err(lock_error)?
            .pending
            .as_ref()
            .map(|pending| pending.transaction_id.clone());
        if let Some(transaction_id) = pending_transaction {
            return self.rollback_pending(&transaction_id, "explicit");
        }

        let restored_revision = {
            let mut state = self.state.lock().map_err(lock_error)?;
            let target = state.previous_revision.clone().ok_or_else(|| {
                "No previous confirmed frontend revision is available".to_string()
            })?;
            if !self.revision_is_available(&target) {
                return Err("The previous frontend revision is unavailable".to_string());
            }
            let mut next = state.clone();
            let current = next.active_revision.replace(target.clone());
            next.previous_revision = current;
            self.save_state(&next)?;
            *state = next;
            target
        };
        if let Some(app) = self.app.get() {
            self.navigate_main_to_revision(app, &restored_revision, None)?;
        }
        Ok(json!({"status": "rolled_back", "activeRevision": restored_revision}))
    }

    fn status(&self) -> Result<Value, String> {
        let state = self.state.lock().map_err(lock_error)?;
        Ok(self.status_value(&state))
    }

    fn status_value(&self, state: &FrontendWorkbenchState) -> Value {
        let status = state
            .pending
            .as_ref()
            .map(|pending| pending.phase.as_str())
            .unwrap_or("ready");
        json!({
            "status": status,
            "activeRevision": state.active_revision,
            "bundledRevision": state.bundled_revision,
            "previousRevision": state.previous_revision,
            "pending": state.pending,
            "lastOutcome": state.last_outcome,
            "candidateReadyTimeoutSeconds": CANDIDATE_READY_TIMEOUT.as_secs(),
            "confirmationTimeoutSeconds": CONFIRM_TIMEOUT.as_secs(),
        })
    }

    pub fn transaction_status(&self, transaction_id: &str) -> Result<Value, String> {
        let state = self.state.lock().map_err(lock_error)?;
        self.transaction_status_value(&state, transaction_id)
    }

    fn transaction_status_value(
        &self,
        state: &FrontendWorkbenchState,
        transaction_id: &str,
    ) -> Result<Value, String> {
        if let Some(pending) = state
            .pending
            .as_ref()
            .filter(|pending| pending.transaction_id == transaction_id)
        {
            return Ok(json!({
                "status": pending.phase.as_str(),
                "transactionId": pending.transaction_id,
                "revisionId": pending.revision_id,
                "activeRevision": state.active_revision,
                "candidateReadyDeadlineUnixMs": pending.candidate_ready_deadline_unix_ms,
                "expiresAtUnixMs": pending.expires_at_unix_ms,
                "confirmationTimeoutSeconds": CONFIRM_TIMEOUT.as_secs(),
            }));
        }
        if let Some(outcome) = state
            .last_outcome
            .as_ref()
            .filter(|outcome| outcome.transaction_id == transaction_id)
        {
            return Ok(outcome_value(outcome));
        }
        Err("The frontend update transaction is stale".to_string())
    }

    /// Returns the confirmed frontend URL used for release startup. Revision
    /// identity is carried as a cache-busting query (rather than a custom
    /// protocol host) because Windows maps every custom scheme to the fixed
    /// `<scheme>.localhost` origin.
    pub fn active_frontend_url(&self) -> WebviewUrl {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.active_revision.clone())
            .and_then(|revision| revision_frontend_url(&revision, None).ok())
            .unwrap_or_else(|| custom_frontend_url("index.html"))
    }

    /// Authorizes only the current main document, local Blob/srcdoc children,
    /// or one exact host-armed transition. This keeps arbitrary page-driven
    /// navigation blocked while allowing a debug-server page to switch to a
    /// Creative candidate and allowing rollback to switch revisions again.
    pub fn should_allow_main_navigation(&self, url: &Url) -> bool {
        let is_embedded_document = url.scheme() == "blob"
            || (url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc"));
        if is_embedded_document {
            return true;
        }

        let Ok(mut navigation) = self.main_navigation.lock() else {
            return false;
        };
        match navigation.current_url.as_ref() {
            None => {
                navigation.current_url = Some(url.clone());
                true
            }
            Some(current) if same_main_navigation_target(current, url) => true,
            Some(_)
                if navigation
                    .armed_url
                    .as_ref()
                    .is_some_and(|armed| same_main_navigation_target(armed, url)) =>
            {
                navigation.current_url = Some(url.clone());
                navigation.armed_url = None;
                true
            }
            Some(_) => false,
        }
    }

    fn navigate_main_to_revision(
        &self,
        app: &tauri::AppHandle,
        revision_id: &str,
        transaction_id: Option<&str>,
    ) -> Result<(), String> {
        let url = revision_frontend_url_value(revision_id, transaction_id)?;
        let webview = app
            .get_webview("main")
            .ok_or_else(|| "Main window is unavailable".to_string())?;
        {
            let mut navigation = self.main_navigation.lock().map_err(lock_error)?;
            navigation.armed_url = Some(url.clone());
        }
        if let Err(error) = webview.navigate(url.clone()) {
            if let Ok(mut navigation) = self.main_navigation.lock() {
                if navigation
                    .armed_url
                    .as_ref()
                    .is_some_and(|armed| same_main_navigation_target(armed, &url))
                {
                    navigation.armed_url = None;
                }
            }
            return Err(format!(
                "Failed to load frontend revision {revision_id}: {error}"
            ));
        }
        Ok(())
    }

    pub fn protocol_response(
        &self,
        request: tauri::http::Request<Vec<u8>>,
    ) -> tauri::http::Response<Vec<u8>> {
        let request_path = request.uri().path();
        if request_path == "/bootstrap-theme.css" {
            return tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, "text/css; charset=utf-8")
                .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
                .body(BOOTSTRAP_THEME_CSS.to_vec())
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
        }
        if request_path == "/frontend-update-confirm.html" {
            return tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/html; charset=utf-8",
                )
                .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
                .body(CONFIRMATION_HTML.to_vec())
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
        }
        match self.read_protocol_asset(request_path) {
            Ok((bytes, content_type)) => tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, content_type)
                .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
                .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(bytes)
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
            Err(error) if matches!(request_path, "" | "/" | "/index.html") => {
                log::error!("Serving immutable frontend recovery page: error={error}");
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::SERVICE_UNAVAILABLE)
                    .header(
                        tauri::http::header::CONTENT_TYPE,
                        "text/html; charset=utf-8",
                    )
                    .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
                    .body(RECOVERY_HTML.to_vec())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
            }
            Err(error) => tauri::http::Response::builder()
                .status(tauri::http::StatusCode::NOT_FOUND)
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/plain; charset=utf-8",
                )
                .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
                .body(error.into_bytes())
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
        }
    }

    fn read_protocol_asset(&self, request_path: &str) -> Result<(Vec<u8>, &'static str), String> {
        let decoded = urlencoding::decode(request_path)
            .map_err(|_| "Invalid frontend asset path encoding".to_string())?;
        let relative = decoded.trim_start_matches('/');
        let relative = if relative.is_empty() {
            "index.html"
        } else {
            relative
        };
        let relative_path = Path::new(relative);
        if relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Invalid frontend asset path".to_string());
        }

        let served_revision = {
            let state = self.state.lock().map_err(lock_error)?;
            state
                .pending
                .as_ref()
                .map(|pending| pending.revision_id.clone())
                .or_else(|| state.active_revision.clone())
                .ok_or_else(|| "Frontend workbench is not initialized".to_string())?
        };
        validate_revision_id(&served_revision)?;
        let root = self.asset_root(&served_revision, relative_path)?;
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("Frontend root is unavailable: {error}"))?;
        let mut candidate = root.join(relative_path);
        if candidate.is_dir() {
            candidate = candidate.join("index.html");
        }
        if !candidate.is_file() && relative_path.extension().is_none() {
            candidate = root.join("index.html");
        }
        let canonical_candidate = candidate
            .canonicalize()
            .map_err(|_| format!("Frontend asset not found: {relative}"))?;
        if !canonical_candidate.starts_with(&canonical_root) || !canonical_candidate.is_file() {
            return Err("Frontend asset path escaped the active revision".to_string());
        }
        let content_type = content_type_for(&canonical_candidate);
        fs::read(&canonical_candidate)
            .map(|bytes| (bytes, content_type))
            .map_err(|error| format!("Failed to read frontend asset: {error}"))
    }

    fn load_state(&self) -> FrontendWorkbenchState {
        let path = self.state_path();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(state) => return state,
                Err(error) => {
                    let preserved = self.root.join(format!("state.invalid.{}.json", unix_ms()));
                    if let Err(copy_error) = fs::copy(&path, &preserved) {
                        log::warn!(
                            "Failed to preserve unreadable frontend state: source={}, destination={}, error={}",
                            path.display(),
                            preserved.display(),
                            copy_error
                        );
                    }
                    log::warn!(
                        "Frontend workbench state is unreadable; attempting the last committed backup: path={}, error={}",
                        path.display(),
                        error
                    );
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!(
                    "Frontend workbench state cannot be read; attempting the last committed backup: path={}, error={}",
                    path.display(),
                    error
                );
            }
        }

        let backup = self.state_backup_path();
        match fs::read(&backup) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(state) => {
                    log::warn!(
                        "Recovered frontend workbench state from the last committed backup: path={}",
                        backup.display()
                    );
                    state
                }
                Err(error) => {
                    log::warn!(
                        "Frontend workbench backup is unreadable and was left untouched: path={}, error={}",
                        backup.display(),
                        error
                    );
                    FrontendWorkbenchState::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                FrontendWorkbenchState::default()
            }
            Err(error) => {
                log::warn!(
                    "Frontend workbench backup cannot be read and was left untouched: path={}, error={}",
                    backup.display(),
                    error
                );
                FrontendWorkbenchState::default()
            }
        }
    }

    fn save_state(&self, state: &FrontendWorkbenchState) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(io_error("create frontend workbench root"))?;
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| format!("Failed to serialize frontend workbench state: {error}"))?;
        let temporary = self.root.join(format!("state.{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, bytes).map_err(io_error("write frontend workbench state"))?;
        let state_path = self.state_path();
        let result: Result<(), String> = (|| {
            let current_state_is_valid = fs::read(&state_path)
                .ok()
                .and_then(|bytes| {
                    serde_json::from_slice::<FrontendWorkbenchState>(&bytes)
                        .ok()
                        .map(|_| ())
                })
                .is_some();
            if current_state_is_valid {
                fs::copy(&state_path, self.state_backup_path())
                    .map_err(io_error("back up frontend workbench state"))?;
            }
            match fs::rename(&temporary, &state_path) {
                Ok(()) => Ok(()),
                Err(_error) if state_path.exists() => {
                    fs::remove_file(&state_path)
                        .map_err(io_error("replace frontend workbench state"))?;
                    fs::rename(&temporary, &state_path)
                        .map_err(io_error("commit frontend workbench state"))
                }
                Err(error) => Err(format!(
                    "Failed to commit frontend workbench state: {error}"
                )),
            }
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn close_confirmation_window(&self) {
        if let Some(window) = self
            .app
            .get()
            .and_then(|app| app.get_webview_window(CONFIRM_WINDOW_LABEL))
        {
            let _ = window.close();
        }
    }

    fn revision_is_available(&self, revision_id: &str) -> bool {
        self.revision_root(revision_id).is_ok_and(|root| {
            root.join("index.html").is_file()
                || (overrides::is_overlay(&root) && overrides::validate(&root).is_ok())
        })
    }

    fn asset_root(&self, revision_id: &str, relative: &Path) -> Result<PathBuf, String> {
        let root = self.revision_root(revision_id)?;
        if overrides::is_overlay(&root) && !overrides::owns_asset(relative) {
            return self
                .bundled_source
                .lock()
                .map_err(lock_error)?
                .as_ref()
                .map(|source| source.root.clone())
                .ok_or_else(|| {
                    "Packaged frontend is unavailable for this customization".to_string()
                });
        }
        Ok(root)
    }

    fn revision_root(&self, revision_id: &str) -> Result<PathBuf, String> {
        validate_revision_id(revision_id)?;
        if let Some(source) = self
            .bundled_source
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .filter(|source| source.revision_id == revision_id)
        {
            return Ok(source.root.clone());
        }
        Ok(self.revision_dir(revision_id))
    }
}

fn ensure_local_confirmation_surface(attached_peer_controllers: usize) -> Result<(), String> {
    if attached_peer_controllers > 0 {
        return Err(
            "FrontendWorkbench is unavailable while this OpenBitFun host is controlled through Peer Device Mode; run Creative mode on the visible local desktop instead"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendUpdateDecisionRequest {
    transaction_id: String,
}

#[tauri::command]
pub async fn frontend_update_candidate_ready(
    state: tauri::State<'_, Arc<FrontendWorkbenchManager>>,
    webview: tauri::Webview,
    request: FrontendUpdateDecisionRequest,
) -> Result<Value, String> {
    require_main_webview(&webview)?;
    let document_url = webview
        .url()
        .map_err(|error| format!("Failed to inspect the main frontend URL: {error}"))?;
    state.mark_candidate_ready(&request.transaction_id, &document_url)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendUpdateFailureRequest {
    transaction_id: String,
    message: String,
}

#[tauri::command]
pub async fn frontend_update_candidate_failed(
    state: tauri::State<'_, Arc<FrontendWorkbenchManager>>,
    webview: tauri::Webview,
    request: FrontendUpdateFailureRequest,
) -> Result<Value, String> {
    require_main_webview(&webview)?;
    let url = webview.url().map_err(|error| error.to_string())?;
    state.mark_candidate_failed(&request.transaction_id, &url, &request.message)
}

#[tauri::command]
pub async fn get_frontend_update_status(
    state: tauri::State<'_, Arc<FrontendWorkbenchManager>>,
    webview: tauri::WebviewWindow,
    request: FrontendUpdateDecisionRequest,
) -> Result<Value, String> {
    require_confirmation_window(&webview)?;
    state.transaction_status(&request.transaction_id)
}

#[tauri::command]
pub async fn confirm_frontend_update(
    state: tauri::State<'_, Arc<FrontendWorkbenchManager>>,
    webview: tauri::WebviewWindow,
    request: FrontendUpdateDecisionRequest,
) -> Result<Value, String> {
    require_confirmation_window(&webview)?;
    state.confirm_pending(&request.transaction_id)
}

#[tauri::command]
pub async fn rollback_frontend_update(
    state: tauri::State<'_, Arc<FrontendWorkbenchManager>>,
    webview: tauri::WebviewWindow,
    request: FrontendUpdateDecisionRequest,
) -> Result<Value, String> {
    require_confirmation_window(&webview)?;
    state.rollback_pending(&request.transaction_id, "user")
}

fn require_confirmation_window(webview: &tauri::WebviewWindow) -> Result<(), String> {
    if webview.label() != CONFIRM_WINDOW_LABEL {
        return Err(
            "Frontend updates can only be confirmed from the immutable confirmation window"
                .to_string(),
        );
    }
    Ok(())
}

fn require_main_webview(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Frontend readiness can only be reported by the main window".to_string());
    }
    Ok(())
}

pub fn custom_frontend_url(path: &str) -> WebviewUrl {
    let suffix = if path.is_empty() {
        "index.html".to_string()
    } else if path.starts_with('?') {
        format!("index.html{path}")
    } else {
        path.trim_start_matches('/').to_string()
    };
    let url = format!("{FRONTEND_PROTOCOL_SCHEME}://localhost/{suffix}")
        .parse::<Url>()
        .expect("static frontend custom-protocol URL must parse");
    WebviewUrl::CustomProtocol(url)
}

fn show_confirmation_window(
    app: &tauri::AppHandle,
    transaction_id: &str,
    manager: Arc<FrontendWorkbenchManager>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONFIRM_WINDOW_LABEL) {
        let _ = window.close();
    }
    let url = confirmation_window_url(transaction_id);
    let window = WebviewWindowBuilder::new(app, CONFIRM_WINDOW_LABEL, url)
        .title("Review OpenBitFun frontend update")
        .inner_size(440.0, 286.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .focused(true)
        .build()
        .map_err(|error| format!("Failed to open frontend confirmation window: {error}"))?;
    let closed_transaction_id = transaction_id.to_string();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            return;
        }
        let manager = Arc::clone(&manager);
        let transaction_id = closed_transaction_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                manager.rollback_pending(&transaction_id, "confirmation_window_closed")
            {
                log::warn!(
                    "Failed to roll back frontend update after its confirmation window closed: transaction_id={}, error={}",
                    transaction_id,
                    error
                );
            }
        });
    });
    Ok(())
}

fn confirmation_window_url(transaction_id: &str) -> WebviewUrl {
    custom_frontend_url(&format!(
        "frontend-update-confirm.html?transactionId={}",
        urlencoding::encode(transaction_id)
    ))
}

fn revision_frontend_url(
    revision_id: &str,
    transaction_id: Option<&str>,
) -> Result<WebviewUrl, String> {
    revision_frontend_url_value(revision_id, transaction_id).map(WebviewUrl::CustomProtocol)
}

fn revision_frontend_url_value(
    revision_id: &str,
    transaction_id: Option<&str>,
) -> Result<Url, String> {
    validate_revision_id(revision_id)?;
    let mut url = FRONTEND_URL
        .parse::<Url>()
        .map_err(|error| format!("Invalid frontend URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("openbitfunFrontendRevision", revision_id);
        if let Some(transaction_id) = transaction_id {
            query.append_pair("openbitfunFrontendTransaction", transaction_id);
        }
    }
    Ok(url)
}

fn matching_pending<'a>(
    state: &'a FrontendWorkbenchState,
    transaction_id: &str,
) -> Result<&'a PendingFrontendRevision, String> {
    let pending = state
        .pending
        .as_ref()
        .ok_or_else(|| "No frontend update is awaiting a decision".to_string())?;
    if pending.transaction_id != transaction_id {
        return Err("The frontend update transaction is stale".to_string());
    }
    Ok(pending)
}

fn outcome_value(outcome: &FrontendUpdateOutcome) -> Value {
    json!({
        "status": outcome.status,
        "transactionId": outcome.transaction_id,
        "revisionId": outcome.revision_id,
        "activeRevision": outcome.active_revision,
        "reason": outcome.reason,
        "completedAtUnixMs": outcome.completed_at_unix_ms,
    })
}

fn same_main_navigation_target(left: &Url, right: &Url) -> bool {
    main_navigation_key(left) == main_navigation_key(right)
}

fn main_navigation_key(url: &Url) -> String {
    let is_native_custom_protocol = url.scheme() == FRONTEND_PROTOCOL_SCHEME;
    let is_windows_custom_protocol = matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some("openbitfun-ui.localhost");
    if is_native_custom_protocol || is_windows_custom_protocol {
        let mut key = format!("{FRONTEND_PROTOCOL_SCHEME}://localhost{}", url.path());
        if let Some(query) = url.query() {
            key.push('?');
            key.push_str(query);
        }
        return key;
    }
    url.as_str().to_string()
}

fn resolve_bundled_frontend_source(root: &Path) -> Result<BundledFrontendSource, String> {
    if !root.is_dir() {
        return Err(format!(
            "Frontend directory is unavailable: {}",
            root.display()
        ));
    }
    if !root.join("index.html").is_file() {
        return Err(format!(
            "Frontend directory has no index.html: {}",
            root.display()
        ));
    }

    let manifest_path = root.join(BUNDLED_MANIFEST_FILE);
    let revision_id = if manifest_path.is_file() {
        let metadata = fs::metadata(&manifest_path)
            .map_err(io_error("inspect bundled frontend revision manifest"))?;
        if metadata.len() > 64 * 1024 {
            return Err("Bundled frontend revision manifest is unexpectedly large".to_string());
        }
        let bytes = fs::read(&manifest_path)
            .map_err(io_error("read bundled frontend revision manifest"))?;
        let manifest: BundledFrontendManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Bundled frontend revision manifest is invalid: {error}"))?;
        validate_bundled_frontend_manifest(&manifest)?;
        manifest.revision
    } else {
        let revision_id = legacy_bundled_revision_id(root)?;
        log::warn!(
            "Bundled frontend revision manifest is unavailable; using compatibility identity: revision_id={}",
            revision_id
        );
        revision_id
    };

    Ok(BundledFrontendSource {
        revision_id,
        root: root.to_path_buf(),
    })
}

fn validate_bundled_frontend_manifest(manifest: &BundledFrontendManifest) -> Result<(), String> {
    if manifest.schema_version != BUNDLED_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported bundled frontend revision manifest schema: {}",
            manifest.schema_version
        ));
    }
    if manifest.algorithm != BUNDLED_MANIFEST_ALGORITHM {
        return Err(format!(
            "Unsupported bundled frontend revision algorithm: {}",
            manifest.algorithm
        ));
    }
    if manifest.digest.len() != 64
        || !manifest
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Bundled frontend revision digest is invalid".to_string());
    }
    let expected_revision = format!("bundled-{}", &manifest.digest[..16]);
    if manifest.revision != expected_revision {
        return Err("Bundled frontend revision does not match its digest".to_string());
    }
    if manifest.file_count == 0 || manifest.total_bytes == 0 {
        return Err("Bundled frontend revision manifest describes an empty bundle".to_string());
    }
    validate_revision_id(&manifest.revision)
}

fn legacy_bundled_revision_id(root: &Path) -> Result<String, String> {
    let version_path = root.join("version.json");
    let identity_path = if version_path.is_file() {
        version_path
    } else {
        root.join("index.html")
    };
    let bytes = fs::read(&identity_path)
        .map_err(io_error("read bundled frontend compatibility identity"))?;
    let mut hasher = Sha256::new();
    hasher.update(env!("CARGO_PKG_VERSION").as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    let digest = format!("{:x}", hasher.finalize());
    Ok(format!("bundled-legacy-{}", &digest[..16]))
}

fn validate_frontend_tree(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!(
            "Frontend directory is unavailable: {}",
            root.display()
        ));
    }
    if !root.join("index.html").is_file() {
        return Err(format!(
            "Frontend directory has no index.html: {}",
            root.display()
        ));
    }
    visit_tree(root, &mut |path, metadata| {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Frontend revisions cannot contain symbolic links: {}",
                path.display()
            ));
        }
        Ok(())
    })
}

fn copy_tree_transactional(source: &Path, destination: &Path) -> Result<(), String> {
    validate_frontend_tree(source)?;
    copy_asset_tree_transactional(source, destination)
}

fn copy_asset_tree_transactional(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err(format!(
            "Frontend destination already exists: {}",
            destination.display()
        ));
    }
    if fs::symlink_metadata(source)
        .map_err(io_error("inspect frontend source"))?
        .file_type()
        .is_symlink()
    {
        return Err("Frontend sources cannot be symbolic links".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Frontend destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(io_error("create frontend destination parent"))?;
    let staging = parent.join(format!("{COPY_STAGING_PREFIX}{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(io_error("create frontend copy staging directory"))?;
    let result = copy_tree_contents(source, &staging)
        .and_then(|_| fs::rename(&staging, destination).map_err(io_error("commit frontend copy")));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn cleanup_stale_copy_directories(parent: &Path) -> Result<usize, String> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(io_error("read frontend revision directory")(error)),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(io_error("read frontend revision directory entry"))?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(uuid_text) = file_name.strip_prefix(COPY_STAGING_PREFIX) else {
            continue;
        };
        let Ok(uuid) = Uuid::parse_str(uuid_text) else {
            continue;
        };
        if uuid.to_string() != uuid_text {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(io_error("inspect frontend copy staging entry"))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        fs::remove_dir_all(entry.path())
            .map_err(io_error("remove stale frontend copy staging directory"))?;
        removed += 1;
    }
    Ok(removed)
}

fn copy_tree_contents(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(io_error("read frontend directory"))? {
        let entry = entry.map_err(io_error("read frontend directory entry"))?;
        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(io_error("inspect frontend directory entry"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Frontend revisions cannot contain symbolic links: {}",
                source_path.display()
            ));
        }
        let destination_path = destination.join(entry.file_name());
        if metadata.is_dir() {
            fs::create_dir(&destination_path).map_err(io_error("create frontend subdirectory"))?;
            copy_tree_contents(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path).map_err(io_error("copy frontend asset"))?;
        }
    }
    Ok(())
}

fn visit_tree(
    root: &Path,
    visitor: &mut impl FnMut(&Path, &fs::Metadata) -> Result<(), String>,
) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(io_error("read frontend tree"))? {
        let entry = entry.map_err(io_error("read frontend tree entry"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error("inspect frontend tree"))?;
        visitor(&path, &metadata)?;
        if metadata.is_dir() {
            visit_tree(&path, visitor)?;
        }
    }
    Ok(())
}

fn validate_uuid(value: &str, field: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| format!("{field} is invalid"))?;
    if parsed.to_string() != value.to_ascii_lowercase() {
        return Err(format!("{field} is invalid"));
    }
    Ok(())
}

fn validate_revision_id(value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("Frontend revision id is invalid".to_string());
    }
    Ok(())
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn io_error(operation: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("Failed to {operation}: {error}")
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("Frontend workbench state lock is unavailable: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay_manager(root: &Path, label: &str) -> Arc<FrontendWorkbenchManager> {
        let source = root.join("packaged");
        write_frontend(&source, label);
        fs::write(source.join(overrides::CSS), "/* original */").unwrap();
        fs::write(source.join(overrides::JS), "export default function() {}").unwrap();
        fs::write(source.join(overrides::API_DOC), "UI API v1").unwrap();
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets/app.js"), label).unwrap();
        let manager = Arc::new(FrontendWorkbenchManager::new(root));
        let bundled = resolve_bundled_frontend_source(&source).unwrap();
        let id = bundled.revision_id.clone();
        *manager.bundled_source.lock().unwrap() = Some(bundled);
        fs::create_dir_all(manager.drafts_dir()).unwrap();
        *manager.state.lock().unwrap() = manager.load_reconcile_and_save_state(&id).unwrap();
        manager
    }

    #[test]
    fn creation_drafts_contain_editable_overrides_instead_of_a_build_tree() {
        let root = tempfile::tempdir().unwrap();
        let manager = overlay_manager(root.path(), "installed product");
        let draft = manager.prepare().unwrap();
        let path = PathBuf::from(draft["draftPath"].as_str().unwrap());
        assert!(path.join(overrides::CSS).is_file());
        assert!(path.join(overrides::JS).is_file());
        assert!(path.join(overrides::API_DOC).is_file());
        assert!(!path.join("index.html").exists());
        assert!(!path.join("assets").exists());
        overrides::validate(&path).unwrap();
        fs::write(path.join("index.html"), "replace application").unwrap();
        assert!(overrides::validate(&path)
            .unwrap_err()
            .contains("Unsupported customization file"));
    }

    #[test]
    fn confirmed_customization_survives_upgrade_while_using_the_new_product_bundle() {
        let root = tempfile::tempdir().unwrap();
        let manager = overlay_manager(root.path(), "product v1");
        let draft = manager.prepare().unwrap();
        let draft_path = PathBuf::from(draft["draftPath"].as_str().unwrap());
        fs::write(draft_path.join(overrides::CSS), "/* user design */").unwrap();
        let revision = "creative-user-design";
        copy_asset_tree_transactional(&draft_path, &manager.revision_dir(revision)).unwrap();
        overrides::write_manifest(&manager.revision_dir(revision)).unwrap();
        let mut state = manager.state.lock().unwrap().clone();
        state.previous_revision = state.active_revision.clone();
        state.active_revision = Some(revision.into());
        manager.save_state(&state).unwrap();
        drop(manager);

        let upgraded = overlay_manager(root.path(), "product v2");
        assert_eq!(
            upgraded.state.lock().unwrap().active_revision.as_deref(),
            Some(revision)
        );
        assert_eq!(
            upgraded.read_protocol_asset("/assets/app.js").unwrap().0,
            b"product v2"
        );
        assert_eq!(
            upgraded
                .read_protocol_asset("/openbitfun-creation.css")
                .unwrap()
                .0,
            b"/* user design */"
        );
        assert!(upgraded.revision_dir(revision).is_dir());
    }

    #[test]
    fn stale_draft_cannot_overwrite_a_new_confirmed_customization() {
        let root = tempfile::tempdir().unwrap();
        let manager = overlay_manager(root.path(), "product");
        let draft = manager.prepare().unwrap();
        manager.state.lock().unwrap().active_revision = Some("creative-newer".into());
        let error = manager
            .begin_apply(draft["draftId"].as_str().unwrap())
            .unwrap_err();
        assert!(error.contains("changed after this draft"));
        assert!(manager.state.lock().unwrap().pending.is_none());
        assert_eq!(
            manager.state.lock().unwrap().active_revision.as_deref(),
            Some("creative-newer")
        );
    }

    #[test]
    fn activation_failure_returns_the_real_error_and_restores_the_confirmed_frontend() {
        let root = tempfile::tempdir().unwrap();
        let manager = overlay_manager(root.path(), "product");
        let previous = manager
            .state
            .lock()
            .unwrap()
            .active_revision
            .clone()
            .unwrap();
        manager.state.lock().unwrap().pending = Some(PendingFrontendRevision {
            transaction_id: "transaction".into(),
            revision_id: "creative-candidate".into(),
            previous_revision: previous.clone(),
            candidate_ready_deadline_unix_ms: unix_ms() + 10_000,
            ..PendingFrontendRevision::default()
        });
        let old_url = revision_frontend_url_value(&previous, None).unwrap();
        assert!(manager
            .mark_candidate_failed("transaction", &old_url, "stale document")
            .is_err());
        assert!(manager.state.lock().unwrap().pending.is_some());
        let candidate_url =
            revision_frontend_url_value("creative-candidate", Some("transaction")).unwrap();
        manager
            .mark_candidate_failed(
                "transaction",
                &candidate_url,
                "Unknown UI customization slot: missing",
            )
            .unwrap();
        let result = manager.transaction_status("transaction").unwrap();
        assert_eq!(result["status"], "rolled_back");
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("Unknown UI customization slot"));
        assert_eq!(result["activeRevision"], previous);
        assert!(manager.state.lock().unwrap().pending.is_none());
    }

    fn write_frontend(root: &Path, label: &str) {
        fs::create_dir_all(root.join("assets")).expect("asset directory");
        fs::write(root.join("index.html"), format!("<h1>{label}</h1>")).expect("index.html");
        fs::write(root.join("assets/app.js"), "export {};").expect("asset");
    }

    fn write_bundled_manifest(root: &Path, digest: &str) -> String {
        let revision = format!("bundled-{}", &digest[..16]);
        fs::write(
            root.join(BUNDLED_MANIFEST_FILE),
            serde_json::to_vec(&json!({
                "schemaVersion": BUNDLED_MANIFEST_SCHEMA_VERSION,
                "revision": revision,
                "algorithm": BUNDLED_MANIFEST_ALGORITHM,
                "digest": digest,
                "fileCount": 2,
                "totalBytes": 32,
            }))
            .expect("manifest JSON"),
        )
        .expect("manifest");
        revision
    }

    #[test]
    fn transactional_copy_preserves_a_valid_frontend() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        write_frontend(&source, "source");
        copy_tree_transactional(&source, &destination).expect("copy");
        assert_eq!(
            fs::read_to_string(destination.join("index.html")).expect("copied index"),
            "<h1>source</h1>"
        );
    }

    #[test]
    fn bundled_revision_comes_from_the_build_time_manifest() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source");
        write_frontend(&source, "source");
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let revision = write_bundled_manifest(&source, digest);

        let first = resolve_bundled_frontend_source(&source).expect("bundled source");
        fs::write(source.join("assets/app.js"), "export const changed = true;")
            .expect("change asset");
        let second = resolve_bundled_frontend_source(&source).expect("bundled source");

        assert_eq!(first.revision_id, revision);
        assert_eq!(second.revision_id, revision);
    }

    #[test]
    fn malformed_bundled_manifest_fails_loudly() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source");
        write_frontend(&source, "source");
        fs::write(
            source.join(BUNDLED_MANIFEST_FILE),
            r#"{"schemaVersion":1,"revision":"bundled-wrong","algorithm":"sha256-path-content-v1","digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","fileCount":2,"totalBytes":32}"#,
        )
        .expect("manifest");

        let error = resolve_bundled_frontend_source(&source)
            .expect_err("revision mismatch must be rejected");
        assert!(error.contains("does not match"));
    }

    #[test]
    fn packaged_frontend_is_served_directly_and_materialized_on_demand() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("packaged");
        write_frontend(&source, "packaged");
        let digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let revision = write_bundled_manifest(&source, digest);
        let manager = FrontendWorkbenchManager::new(temp.path());
        *manager.bundled_source.lock().expect("bundled source") =
            Some(resolve_bundled_frontend_source(&source).expect("resolve bundled source"));

        assert_eq!(
            manager.revision_root(&revision).expect("direct root"),
            source
        );
        assert!(!manager.revision_dir(&revision).exists());
        assert_eq!(
            manager
                .materialize_current_bundled_revision()
                .expect("materialize"),
            Some(revision.clone())
        );
        assert_eq!(
            fs::read_to_string(manager.revision_dir(&revision).join("index.html"))
                .expect("cached index"),
            "<h1>packaged</h1>"
        );
    }

    #[test]
    fn packaged_frontend_cache_removes_only_stale_transaction_directories() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("packaged");
        write_frontend(&source, "packaged");
        let digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let revision = write_bundled_manifest(&source, digest);
        let manager = FrontendWorkbenchManager::new(temp.path());
        *manager.bundled_source.lock().expect("bundled source") =
            Some(resolve_bundled_frontend_source(&source).expect("resolve bundled source"));
        write_frontend(&manager.revision_dir(&revision), "cached");

        let stale = manager
            .revisions_dir()
            .join(".copy-38e14f63-30ad-4ad7-9e4e-5ad556450ba3");
        fs::create_dir_all(&stale).expect("stale staging directory");
        fs::write(stale.join("partial.js"), "partial").expect("partial asset");
        let misleading = manager.revisions_dir().join(".copy-not-a-uuid");
        fs::create_dir_all(&misleading).expect("misleading directory");
        let uppercase = manager
            .revisions_dir()
            .join(".copy-48E14F63-30AD-4AD7-9E4E-5AD556450BA3");
        fs::create_dir_all(&uppercase).expect("uppercase directory");
        let matching_file = manager
            .revisions_dir()
            .join(".copy-58e14f63-30ad-4ad7-9e4e-5ad556450ba3");
        fs::write(&matching_file, "keep").expect("matching regular file");

        assert_eq!(
            manager
                .materialize_current_bundled_revision()
                .expect("clean stale staging"),
            None
        );
        assert!(!stale.exists());
        assert!(misleading.is_dir());
        assert!(uppercase.is_dir());
        assert!(matching_file.is_file());
        assert!(manager.revision_dir(&revision).join("index.html").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn validation_rejects_symlinked_assets() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source");
        write_frontend(&source, "source");
        symlink(source.join("index.html"), source.join("linked.html")).expect("symlink");
        assert!(validate_frontend_tree(&source)
            .expect_err("symlink should fail")
            .contains("symbolic links"));
    }

    #[test]
    fn revision_ids_cannot_escape_the_revision_root() {
        for value in ["", ".", "..", "../outside", "/outside"] {
            assert!(validate_revision_id(value).is_err(), "accepted {value}");
        }
        assert!(validate_revision_id("bundled-0123456789abcdef").is_ok());
        assert!(validate_revision_id("creative-38e14f63-30ad-4ad7-9e4e-5ad556450ba3").is_ok());
    }

    #[test]
    fn peer_control_requires_a_visible_local_confirmation_surface() {
        assert!(ensure_local_confirmation_surface(0).is_ok());
        let error = ensure_local_confirmation_surface(1)
            .expect_err("peer-controlled frontend updates must fail loudly");
        assert!(error.contains("Peer Device Mode"));
    }

    #[test]
    fn legacy_state_fields_default_without_data_loss() {
        let state: FrontendWorkbenchState =
            serde_json::from_str(r#"{"activeRevision":"bundled-old","unknownFutureField":true}"#)
                .expect("legacy state");
        assert_eq!(state.active_revision.as_deref(), Some("bundled-old"));
        assert!(state.pending.is_none());
        assert!(state.last_outcome.is_none());
    }

    #[test]
    fn unreadable_primary_state_recovers_the_last_committed_backup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        fs::create_dir_all(&manager.root).expect("workbench root");
        fs::write(manager.state_path(), b"{not-json").expect("broken primary state");
        let backup_state = FrontendWorkbenchState {
            schema_version: 1,
            active_revision: Some("bundled-last-good".to_string()),
            ..FrontendWorkbenchState::default()
        };
        fs::write(
            manager.state_backup_path(),
            serde_json::to_vec(&backup_state).expect("backup JSON"),
        )
        .expect("backup state");

        let recovered = manager.load_state();

        assert_eq!(
            recovered.active_revision.as_deref(),
            Some("bundled-last-good")
        );
        assert_eq!(
            fs::read(manager.state_path()).expect("primary remains preserved"),
            b"{not-json"
        );
        assert!(fs::read_dir(&manager.root)
            .expect("workbench entries")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("state.invalid.")));
    }

    #[test]
    fn initialization_repairs_an_unreadable_primary_recovered_from_backup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("packaged");
        write_frontend(&source, "packaged");
        let digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let revision = write_bundled_manifest(&source, digest);
        let manager = FrontendWorkbenchManager::new(temp.path());
        *manager.bundled_source.lock().expect("bundled source") =
            Some(resolve_bundled_frontend_source(&source).expect("resolve bundled source"));
        fs::create_dir_all(&manager.root).expect("workbench root");
        fs::write(manager.state_path(), b"{not-json").expect("broken primary state");
        let backup_state = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some(revision.clone()),
            active_revision: Some(revision.clone()),
            ..FrontendWorkbenchState::default()
        };
        fs::write(
            manager.state_backup_path(),
            serde_json::to_vec(&backup_state).expect("backup JSON"),
        )
        .expect("backup state");

        let first = manager
            .load_reconcile_and_save_state(&revision)
            .expect("recover and repair state");
        let repaired: FrontendWorkbenchState = serde_json::from_slice(
            &fs::read(manager.state_path()).expect("repaired primary state"),
        )
        .expect("valid repaired state");
        assert_eq!(repaired, first);
        assert_eq!(invalid_state_file_count(&manager.root), 1);

        let second = manager
            .load_reconcile_and_save_state(&revision)
            .expect("load repaired state");
        assert_eq!(second, first);
        assert_eq!(invalid_state_file_count(&manager.root), 1);
    }

    fn invalid_state_file_count(root: &Path) -> usize {
        fs::read_dir(root)
            .expect("workbench entries")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("state.invalid.")
            })
            .count()
    }

    #[test]
    fn expired_confirmation_restores_the_previous_revision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        write_frontend(&manager.revision_dir("previous"), "previous");
        write_frontend(&manager.revision_dir("candidate"), "candidate");
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some("previous".to_string()),
            active_revision: Some("previous".to_string()),
            previous_revision: None,
            pending: Some(PendingFrontendRevision {
                transaction_id: "expired-transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::AwaitingConfirmation,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_sub(2),
                expires_at_unix_ms: Some(unix_ms().saturating_sub(1)),
            }),
            last_outcome: None,
        };

        let error = manager
            .confirm_pending("expired-transaction")
            .expect_err("expired confirmation must fail");
        assert!(error.contains("expired"));
        let state = manager.state.lock().expect("state");
        assert_eq!(state.active_revision.as_deref(), Some("previous"));
        assert!(state.pending.is_none());
        assert_eq!(
            state
                .last_outcome
                .as_ref()
                .map(|outcome| outcome.status.as_str()),
            Some("rolled_back")
        );
    }

    #[test]
    fn confirmation_is_a_two_phase_commit() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        write_frontend(&manager.revision_dir("previous"), "previous");
        write_frontend(&manager.revision_dir("candidate"), "candidate");
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some("previous".to_string()),
            active_revision: Some("previous".to_string()),
            previous_revision: None,
            pending: Some(PendingFrontendRevision {
                transaction_id: "transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::AwaitingConfirmation,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_add(1_000),
                expires_at_unix_ms: Some(unix_ms().saturating_add(1_000)),
            }),
            last_outcome: None,
        };

        let outcome = manager.confirm_pending("transaction").expect("confirm");

        assert_eq!(outcome["status"], "confirmed");
        let state = manager.state.lock().expect("state");
        assert_eq!(state.active_revision.as_deref(), Some("candidate"));
        assert_eq!(state.previous_revision.as_deref(), Some("previous"));
        assert!(state.pending.is_none());
    }

    #[test]
    fn a_loading_candidate_cannot_be_confirmed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        write_frontend(&manager.revision_dir("previous"), "previous");
        write_frontend(&manager.revision_dir("candidate"), "candidate");
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some("previous".to_string()),
            active_revision: Some("previous".to_string()),
            previous_revision: None,
            pending: Some(PendingFrontendRevision {
                transaction_id: "transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::LoadingCandidate,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_add(1_000),
                expires_at_unix_ms: None,
            }),
            last_outcome: None,
        };

        let error = manager
            .confirm_pending("transaction")
            .expect_err("loading preview cannot commit");
        assert!(error.contains("still loading"));
        assert_eq!(
            manager
                .state
                .lock()
                .expect("state")
                .active_revision
                .as_deref(),
            Some("previous")
        );
    }

    #[tokio::test]
    async fn confirmation_countdown_starts_only_after_candidate_readiness() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = Arc::new(FrontendWorkbenchManager::new(temp.path()));
        write_frontend(&manager.revision_dir("previous"), "previous");
        write_frontend(&manager.revision_dir("candidate"), "candidate");
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some("previous".to_string()),
            active_revision: Some("previous".to_string()),
            previous_revision: None,
            pending: Some(PendingFrontendRevision {
                transaction_id: "transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::LoadingCandidate,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_add(5_000),
                expires_at_unix_ms: None,
            }),
            last_outcome: None,
        };
        let before = unix_ms();
        let candidate_url =
            revision_frontend_url_value("candidate", Some("transaction")).expect("candidate URL");

        let status = manager
            .mark_candidate_ready("transaction", &candidate_url)
            .expect("readiness handshake");

        let expires_at = status["expiresAtUnixMs"]
            .as_u64()
            .expect("confirmation deadline");
        assert_eq!(status["status"], "awaiting_confirmation");
        assert!(expires_at >= before + CONFIRM_TIMEOUT.as_millis() as u64);
        let state = manager.state.lock().expect("state");
        assert_eq!(state.active_revision.as_deref(), Some("previous"));
        assert_eq!(
            state.pending.as_ref().map(|pending| pending.phase),
            Some(FrontendUpdatePhase::AwaitingConfirmation)
        );
        drop(state);
        manager
            .rollback_pending("transaction", "test_cleanup")
            .expect("clear provisional transaction");
    }

    #[tokio::test]
    async fn an_expired_loading_candidate_cannot_unlock_confirmation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = Arc::new(FrontendWorkbenchManager::new(temp.path()));
        write_frontend(&manager.revision_dir("previous"), "previous");
        write_frontend(&manager.revision_dir("candidate"), "candidate");
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            bundled_revision: Some("previous".to_string()),
            active_revision: Some("previous".to_string()),
            pending: Some(PendingFrontendRevision {
                transaction_id: "transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::LoadingCandidate,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_sub(1),
                expires_at_unix_ms: None,
            }),
            ..FrontendWorkbenchState::default()
        };
        let candidate_url =
            revision_frontend_url_value("candidate", Some("transaction")).expect("candidate URL");

        let error = manager
            .mark_candidate_ready("transaction", &candidate_url)
            .expect_err("late readiness must roll back");

        assert!(error.contains("did not become ready in time"));
        let state = manager.state.lock().expect("state");
        assert_eq!(state.active_revision.as_deref(), Some("previous"));
        assert!(state.pending.is_none());
        assert_eq!(
            state
                .last_outcome
                .as_ref()
                .and_then(|outcome| outcome.reason.as_deref()),
            Some("candidate_ready_timeout")
        );
    }

    #[tokio::test]
    async fn readiness_from_the_previous_document_cannot_unlock_confirmation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = Arc::new(FrontendWorkbenchManager::new(temp.path()));
        *manager.state.lock().expect("state") = FrontendWorkbenchState {
            schema_version: STATE_SCHEMA_VERSION,
            active_revision: Some("previous".to_string()),
            pending: Some(PendingFrontendRevision {
                transaction_id: "transaction".to_string(),
                revision_id: "candidate".to_string(),
                previous_revision: "previous".to_string(),
                phase: FrontendUpdatePhase::LoadingCandidate,
                candidate_ready_deadline_unix_ms: unix_ms().saturating_add(5_000),
                expires_at_unix_ms: None,
            }),
            ..FrontendWorkbenchState::default()
        };
        let previous_url = "http://localhost:1422/"
            .parse::<Url>()
            .expect("previous document URL");

        let error = manager
            .mark_candidate_ready("transaction", &previous_url)
            .expect_err("the previous page cannot report candidate readiness");

        assert!(error.contains("other than the provisional candidate"));
        let state = manager.state.lock().expect("state");
        assert_eq!(
            state.pending.as_ref().map(|pending| pending.phase),
            Some(FrontendUpdatePhase::LoadingCandidate)
        );
    }

    #[test]
    fn host_armed_navigation_allows_dev_to_candidate_transition_only_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        let dev_url = "http://localhost:1422/".parse::<Url>().expect("dev URL");
        let candidate_url = revision_frontend_url_value(
            "creative-38e14f63-30ad-4ad7-9e4e-5ad556450ba3",
            Some("38e14f63-30ad-4ad7-9e4e-5ad556450ba3"),
        )
        .expect("candidate URL");
        let untrusted_url = "https://example.com/".parse::<Url>().expect("external URL");

        assert!(manager.should_allow_main_navigation(&dev_url));
        assert!(!manager.should_allow_main_navigation(&candidate_url));
        manager
            .main_navigation
            .lock()
            .expect("navigation")
            .armed_url = Some(candidate_url.clone());
        assert!(manager.should_allow_main_navigation(&candidate_url));
        assert!(manager.should_allow_main_navigation(&candidate_url));
        assert!(!manager.should_allow_main_navigation(&untrusted_url));
        assert!(manager
            .should_allow_main_navigation(&"about:srcdoc".parse::<Url>().expect("srcdoc URL")));
    }

    #[test]
    fn custom_frontend_navigation_matches_the_windows_protocol_projection() {
        let native = "openbitfun-ui://localhost/index.html?openbitfunFrontendRevision=creative-1&openbitfunFrontendTransaction=tx"
            .parse::<Url>()
            .expect("native URL");
        let windows = "http://openbitfun-ui.localhost/index.html?openbitfunFrontendRevision=creative-1&openbitfunFrontendTransaction=tx"
            .parse::<Url>()
            .expect("Windows URL");

        assert!(same_main_navigation_target(&native, &windows));
    }

    #[test]
    fn protocol_uses_immutable_recovery_page_when_no_revision_is_ready() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        let request = tauri::http::Request::builder()
            .uri("openbitfun-ui://localhost/index.html")
            .body(Vec::new())
            .expect("request");

        let response = manager.protocol_response(request);

        assert_eq!(
            response.status(),
            tauri::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(String::from_utf8_lossy(response.body()).contains("OpenBitFun frontend recovery"));
    }

    #[test]
    fn confirmation_window_uses_the_host_protocol_instead_of_the_dev_server() {
        let url = confirmation_window_url("transaction with spaces");

        let WebviewUrl::CustomProtocol(url) = url else {
            panic!("confirmation window must use the immutable host protocol");
        };
        assert_eq!(url.scheme(), FRONTEND_PROTOCOL_SCHEME);
        assert_eq!(url.path(), "/frontend-update-confirm.html");
        assert_eq!(
            url.query(),
            Some("transactionId=transaction%20with%20spaces")
        );
    }

    #[test]
    fn protocol_serves_the_immutable_confirmation_page_without_an_active_revision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        let request = tauri::http::Request::builder()
            .uri("openbitfun-ui://localhost/frontend-update-confirm.html?transactionId=probe")
            .body(Vec::new())
            .expect("request");

        let response = manager.protocol_response(request);
        let body = String::from_utf8_lossy(response.body());

        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert!(body.contains("id=\"confirm\""));
        assert!(body.contains("get_frontend_update_status"));
        assert!(body.contains("confirm_frontend_update"));
        assert!(body.contains("rollback_frontend_update"));
    }

    #[test]
    fn protocol_serves_the_generated_bootstrap_theme_without_an_active_revision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = FrontendWorkbenchManager::new(temp.path());
        let request = tauri::http::Request::builder()
            .uri("openbitfun-ui://localhost/bootstrap-theme.css")
            .body(Vec::new())
            .expect("request");

        let response = manager.protocol_response(request);
        let body = String::from_utf8_lossy(response.body());

        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get(tauri::http::header::CONTENT_TYPE),
            Some(&tauri::http::HeaderValue::from_static(
                "text/css; charset=utf-8"
            ))
        );
        assert!(body.contains("--openbitfun-color-surface-canvas"));
        assert!(body.contains("--openbitfun-color-status-danger-content"));
        assert!(!body.contains("--openbitfun-appearance-token-"));
    }
}
