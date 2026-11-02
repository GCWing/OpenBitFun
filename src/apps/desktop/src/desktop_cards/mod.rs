//! Desktop cards: small persistent windows outside the main OpenBitFun window.
//!
//! Core owns the DesktopCard tool contract. This host owns the card store,
//! one native window per visible card, data-source refresh, countdown
//! notifications, and the `app.ai_experience.enable_desktop_cards` gate.

pub mod commands;
#[cfg(windows)]
mod desktop_layer;
mod fetch_gate;
mod refresh;
mod store;
mod windows;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use openbitfun_core::agentic::tools::desktop_card_host::{
    clamp_size, set_desktop_card_handler, DesktopCardDataSnapshot, DesktopCardDataSource,
    DesktopCardDataSourceKind, DesktopCardDraft, DesktopCardHostRequest, DesktopCardOrigin,
    DesktopCardPatch, DesktopCardPosition, DesktopCardRecord, DesktopCardSize, DesktopCardTemplate,
    DesktopCardTemplateKind, DESKTOP_CARD_MAX_CARDS,
};
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::config::{subscribe_config_updates, ConfigUpdateEvent};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use fetch_gate::FetchGate;
use store::CardStore;
pub use windows::DESKTOP_CARD_WINDOW_PREFIX;

pub const DESKTOP_CARD_CHANGED_EVENT: &str = "desktop-card://changed";
pub const DESKTOP_CARD_STATE_EVENT: &str = "desktop-card://state";
const DESKTOP_CARDS_CONFIG_PATH: &str = "app.ai_experience.enable_desktop_cards";
const GEOMETRY_SAVE_DELAY: Duration = Duration::from_millis(600);
/// How long create/update wait for the first fetch so the tool result can
/// report real data; slower sources keep loading in the background.
const FIRST_FETCH_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCardChangedPayload {
    card_id: String,
    card: Option<DesktopCardRecord>,
    deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCardStatePayload {
    enabled: bool,
}

#[derive(Default)]
struct CardTimers {
    refresh: Option<(String, JoinHandle<()>)>,
    countdown: Option<(i64, JoinHandle<()>)>,
}

impl CardTimers {
    fn abort_all(&mut self) {
        if let Some((_, handle)) = self.refresh.take() {
            handle.abort();
        }
        if let Some((_, handle)) = self.countdown.take() {
            handle.abort();
        }
    }
}

pub struct DesktopCards {
    app: AppHandle,
    store: tokio::sync::Mutex<CardStore>,
    enabled: AtomicBool,
    timers: Mutex<HashMap<String, CardTimers>>,
    fetch_gate: FetchGate,
    geometry_save_pending: AtomicBool,
    self_ref: Weak<DesktopCards>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn not_found(card_id: &str) -> String {
    format!("Desktop card not found: {card_id}")
}

fn new_card_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("card-{}", &id[..12])
}

fn source_fingerprint(source: &DesktopCardDataSourceKind) -> String {
    serde_json::to_string(source).unwrap_or_default()
}

fn pending_countdown(card: &DesktopCardRecord) -> Option<i64> {
    match card.template.known()? {
        DesktopCardTemplateKind::Countdown {
            target_at_ms,
            notify: true,
            notified_at_ms: None,
            ..
        } => Some(*target_at_ms),
        _ => None,
    }
}

fn ensure_local_display_surface() -> Result<(), String> {
    if crate::api::peer_host_invoke::attached_controllers().is_empty() {
        Ok(())
    } else {
        Err("This OpenBitFun host is being driven from another device through Peer Device Mode. Desktop cards would appear only on this host's screen, which that user cannot see.".to_string())
    }
}

async fn due_notification_body(message: Option<&str>) -> String {
    if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
        return message.to_string();
    }
    let language =
        match openbitfun_core::service::config::global::GlobalConfigManager::get_service().await {
            Ok(service) => service
                .get_config::<String>(Some("app.language"))
                .await
                .unwrap_or_default(),
            Err(_) => String::new(),
        };
    match language.as_str() {
        "zh-CN" => "倒计时结束".to_string(),
        "zh-TW" => "倒數計時結束".to_string(),
        _ => "Time's up".to_string(),
    }
}

impl DesktopCards {
    fn new(app: AppHandle, store: CardStore) -> Arc<Self> {
        Arc::new_cyclic(|self_ref| Self {
            app,
            store: tokio::sync::Mutex::new(store),
            enabled: AtomicBool::new(false),
            timers: Mutex::new(HashMap::new()),
            fetch_gate: FetchGate::default(),
            geometry_save_pending: AtomicBool::new(false),
            self_ref: self_ref.clone(),
        })
    }

    fn arc(&self) -> Option<Arc<Self>> {
        self.self_ref.upgrade()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    fn emit_changed(&self, card_id: &str, card: Option<&DesktopCardRecord>, deleted: bool) {
        let payload = DesktopCardChangedPayload {
            card_id: card_id.to_string(),
            card: card.cloned(),
            deleted,
        };
        if let Err(error) = self.app.emit(DESKTOP_CARD_CHANGED_EVENT, payload) {
            log::warn!(
                "Failed to emit desktop card change: card_id={}, error={}",
                card_id,
                error
            );
        }
    }

    fn save_locked(store: &mut CardStore) -> Result<(), String> {
        store.save().map_err(|error| {
            log::warn!("Failed to save desktop cards: error={}", error);
            error
        })
    }

    pub async fn list(&self) -> Value {
        let store = self.store.lock().await;
        json!({
            "enabled": self.is_enabled(),
            "cards": store.snapshot(),
        })
    }

    pub async fn get(&self, card_id: &str) -> Result<DesktopCardRecord, String> {
        self.store
            .lock()
            .await
            .get(card_id)
            .cloned()
            .ok_or_else(|| not_found(card_id))
    }

    fn require_enabled(&self) -> Result<(), String> {
        if self.is_enabled() {
            Ok(())
        } else {
            Err("Desktop cards are turned off in OpenBitFun settings.".to_string())
        }
    }

    pub async fn create(
        &self,
        draft: DesktopCardDraft,
        origin: DesktopCardOrigin,
    ) -> Result<DesktopCardRecord, String> {
        self.require_enabled()?;
        let card = {
            let mut store = self.store.lock().await;
            if store.card_count() >= DESKTOP_CARD_MAX_CARDS {
                return Err(format!(
                    "There are already {DESKTOP_CARD_MAX_CARDS} desktop cards. Delete cards that are no longer useful before creating more."
                ));
            }
            let now = now_ms();
            let card = DesktopCardRecord {
                id: new_card_id(),
                title: draft.title,
                subtitle: draft.subtitle,
                icon: draft.icon,
                accent: draft.accent,
                template: DesktopCardTemplate::Known(draft.template),
                data: draft.data,
                data_source: draft.data_source.map(DesktopCardDataSource::Known),
                link: draft.link,
                size: draft.size,
                position: None,
                visible: true,
                always_on_top: draft.always_on_top,
                origin,
                created_at_ms: now,
                updated_at_ms: now,
                last_data: None,
                extra: Map::new(),
            };
            store.insert(card.clone());
            Self::save_locked(&mut store)?;
            card
        };
        log::info!(
            "Desktop card created: card_id={}, template={}",
            card.id,
            card.template.kind()
        );
        let card = self.sync_card_runtime(card).await;
        self.emit_changed(&card.id, Some(&card), false);
        Ok(self.await_first_fetch(card).await)
    }

    /// Waits (bounded) for the first fetch of a shown card whose source has no
    /// data yet. The refresh loop usually runs it; the fetch gate makes this
    /// reuse that result instead of starting a second command.
    async fn await_first_fetch(&self, card: DesktopCardRecord) -> DesktopCardRecord {
        if card.last_data.is_some() || !card.visible || !self.is_enabled() {
            return card;
        }
        let Some(source) = card
            .data_source
            .as_ref()
            .and_then(DesktopCardDataSource::known)
            .cloned()
        else {
            return card;
        };
        let Some(service) = self.arc() else {
            return card;
        };
        let card_id = card.id.clone();
        // Spawned so that giving up on the wait never kills the approved
        // command. Any stored data for the current source is a valid first
        // result, because changing the source clears the snapshot.
        let fetch = tauri::async_runtime::spawn(async move {
            service.run_fetch(&card_id, &source, Some(i64::MIN)).await
        });
        match tokio::time::timeout(FIRST_FETCH_WAIT, fetch).await {
            Ok(Ok(Some(fetched))) => fetched,
            Ok(_) => self.get(&card.id).await.unwrap_or(card),
            Err(_) => {
                log::debug!(
                    "Desktop card first fetch still running after wait: card_id={}",
                    card.id
                );
                self.get(&card.id).await.unwrap_or(card)
            }
        }
    }

    pub async fn update(
        &self,
        card_id: &str,
        patch: DesktopCardPatch,
    ) -> Result<DesktopCardRecord, String> {
        if let Some(always_on_top) = patch.always_on_top {
            self.set_stacking(card_id, always_on_top, None).await?;
        }
        let card = {
            let mut store = self.store.lock().await;
            let card = store.get_mut(card_id).ok_or_else(|| not_found(card_id))?;
            patch.apply_to(card);
            if let Some(size) = card.size {
                card.size = Some(clamp_size(size));
            }
            card.updated_at_ms = now_ms();
            let card = card.clone();
            Self::save_locked(&mut store)?;
            card
        };
        if let Some(size) = patch.size {
            windows::apply_window_size(&self.app, card_id, clamp_size(size));
        }
        let card = self.sync_card_runtime(card).await;
        self.emit_changed(card_id, Some(&card), false);
        Ok(self.await_first_fetch(card).await)
    }

    pub async fn set_visible(
        &self,
        card_id: &str,
        visible: bool,
    ) -> Result<DesktopCardRecord, String> {
        let card = {
            let mut store = self.store.lock().await;
            let card = store.get_mut(card_id).ok_or_else(|| not_found(card_id))?;
            if visible && self.is_enabled() && windows::desktop_pinned(card) {
                let position = windows::resolve_position(
                    &self.app,
                    card,
                    windows::open_card_labels(&self.app).len(),
                );
                windows::open_window(&self.app, card, position).await?;
            }
            card.visible = visible;
            let card = card.clone();
            Self::save_locked(&mut store)?;
            card
        };
        let card = self.sync_card_runtime(card).await;
        self.emit_changed(card_id, Some(&card), false);
        Ok(card)
    }

    pub async fn delete(&self, card_id: &str) -> Result<(), String> {
        {
            let mut store = self.store.lock().await;
            store.remove(card_id).ok_or_else(|| not_found(card_id))?;
            Self::save_locked(&mut store)?;
        }
        self.stop_card_runtime(card_id);
        windows::close_window(&self.app, card_id);
        log::info!("Desktop card deleted: card_id={}", card_id);
        self.emit_changed(card_id, None, true);
        Ok(())
    }

    pub async fn refresh_now(&self, card_id: &str) -> Result<DesktopCardRecord, String> {
        let source = {
            let store = self.store.lock().await;
            let card = store.get(card_id).ok_or_else(|| not_found(card_id))?;
            card.data_source
                .as_ref()
                .and_then(DesktopCardDataSource::known)
                .cloned()
        };
        match source {
            Some(source) => self
                .run_fetch(card_id, &source, Some(now_ms()))
                .await
                .ok_or_else(|| not_found(card_id)),
            None => self.get(card_id).await,
        }
    }

    pub async fn set_checklist_item(
        &self,
        card_id: &str,
        item_id: &str,
        done: bool,
    ) -> Result<DesktopCardRecord, String> {
        let card = {
            let mut store = self.store.lock().await;
            let card = store.get_mut(card_id).ok_or_else(|| not_found(card_id))?;
            let DesktopCardTemplate::Known(DesktopCardTemplateKind::Checklist { items }) =
                &mut card.template
            else {
                return Err(format!("Desktop card {card_id} is not a checklist"));
            };
            let item = items
                .iter_mut()
                .find(|item| item.id == item_id)
                .ok_or_else(|| format!("Checklist item not found: {item_id}"))?;
            item.done = done;
            card.updated_at_ms = now_ms();
            let card = card.clone();
            Self::save_locked(&mut store)?;
            card
        };
        self.emit_changed(card_id, Some(&card), false);
        Ok(card)
    }

    pub async fn set_stacking(
        &self,
        card_id: &str,
        always_on_top: bool,
        desktop_pinned: Option<bool>,
    ) -> Result<DesktopCardRecord, String> {
        if desktop_pinned == Some(true) && !cfg!(windows) {
            return Err("Pinning cards to the desktop is supported only on Windows.".to_string());
        }
        if desktop_pinned == Some(true) && always_on_top {
            return Err(
                "Desktop pinning and global always-on-top are mutually exclusive.".to_string(),
            );
        }
        // Serialize presentation changes with persistence. Do not announce or
        // persist success when Windows refuses to attach/detach the window.
        let mut store = self.store.lock().await;
        let previous = store
            .get(card_id)
            .ok_or_else(|| not_found(card_id))?
            .clone();
        let mut card = previous.clone();
        card.always_on_top = always_on_top;
        card.extra.insert(
            "desktopPinned".to_string(),
            json!(desktop_pinned.unwrap_or(false)),
        );
        let apply = windows::apply_stacking(
            &self.app,
            card_id,
            always_on_top,
            windows::desktop_pinned(&card),
        )
        .await;
        if let Err(error) = apply {
            let rollback = windows::apply_stacking(
                &self.app,
                card_id,
                previous.always_on_top,
                windows::desktop_pinned(&previous),
            )
            .await;
            return Err(format!("{error}; rollback: {rollback:?}"));
        }
        *store.get_mut(card_id).ok_or_else(|| not_found(card_id))? = card.clone();
        if let Err(error) = Self::save_locked(&mut store) {
            *store.get_mut(card_id).ok_or_else(|| not_found(card_id))? = previous.clone();
            let rollback = windows::apply_stacking(
                &self.app,
                card_id,
                previous.always_on_top,
                windows::desktop_pinned(&previous),
            )
            .await;
            return Err(format!("{error}; rollback: {rollback:?}"));
        }
        drop(store);
        self.emit_changed(card_id, Some(&card), false);
        Ok(card)
    }

    pub async fn set_enabled(&self, enabled: bool) {
        let previous = self.enabled.swap(enabled, Ordering::SeqCst);
        if previous == enabled && enabled {
            return;
        }
        log::info!("Desktop cards availability applied: enabled={}", enabled);
        let cards = self.store.lock().await.snapshot();
        for card in cards {
            self.sync_card_runtime(card).await;
        }
        if !enabled {
            for label in windows::open_card_labels(&self.app) {
                if let Some(card_id) = windows::card_id_from_label(&label) {
                    windows::close_window(&self.app, card_id);
                }
            }
        }
        if let Err(error) = self.app.emit(
            DESKTOP_CARD_STATE_EVENT,
            DesktopCardStatePayload { enabled },
        ) {
            log::warn!("Failed to emit desktop card state: error={}", error);
        }
    }

    /// Reconciles the window and timers of one card with the enable gate and
    /// its visibility. Returns the record including any placement it assigned.
    async fn sync_card_runtime(&self, mut card: DesktopCardRecord) -> DesktopCardRecord {
        let enabled = self.is_enabled();
        let active = enabled && card.visible;

        if active {
            let cascade_index = windows::open_card_labels(&self.app).len();
            let position = windows::resolve_position(&self.app, &card, cascade_index);
            match windows::open_window(&self.app, &card, position).await {
                Ok(()) => {
                    if position.is_some() && position != card.position {
                        card.position = position;
                        let mut store = self.store.lock().await;
                        if let Some(stored) = store.get_mut(&card.id) {
                            stored.position = position;
                            let _ = Self::save_locked(&mut store);
                        }
                    }
                }
                Err(error) => {
                    log::warn!(
                        "Failed to open desktop card window: card_id={}, error={}",
                        card.id,
                        error
                    );
                }
            }
        } else {
            windows::close_window(&self.app, &card.id);
        }

        let source = card
            .data_source
            .as_ref()
            .and_then(DesktopCardDataSource::known)
            .filter(|_| active)
            .cloned();
        let countdown = pending_countdown(&card).filter(|_| enabled);
        let Some(service) = self.arc() else {
            return card;
        };
        let mut timers = match self.timers.lock() {
            Ok(timers) => timers,
            Err(poisoned) => poisoned.into_inner(),
        };
        let entry = timers.entry(card.id.clone()).or_default();

        match source {
            Some(source) => {
                let fingerprint = source_fingerprint(&source);
                let current = entry.refresh.as_ref().is_some_and(|(existing, handle)| {
                    *existing == fingerprint && !handle.inner().is_finished()
                });
                if !current {
                    if let Some((_, handle)) = entry.refresh.take() {
                        handle.abort();
                    }
                    let initial_delay = initial_refresh_delay(&card, &source);
                    let handle = tauri::async_runtime::spawn(refresh_loop(
                        Arc::downgrade(&service),
                        card.id.clone(),
                        source,
                        initial_delay,
                        now_ms(),
                    ));
                    entry.refresh = Some((fingerprint, handle));
                }
            }
            None => {
                if let Some((_, handle)) = entry.refresh.take() {
                    handle.abort();
                }
            }
        }

        match countdown {
            Some(target_at_ms) => {
                let current = entry.countdown.as_ref().is_some_and(|(existing, handle)| {
                    *existing == target_at_ms && !handle.inner().is_finished()
                });
                if !current {
                    if let Some((_, handle)) = entry.countdown.take() {
                        handle.abort();
                    }
                    let handle = tauri::async_runtime::spawn(countdown_task(
                        Arc::downgrade(&service),
                        card.id.clone(),
                        target_at_ms,
                    ));
                    entry.countdown = Some((target_at_ms, handle));
                }
            }
            None => {
                if let Some((_, handle)) = entry.countdown.take() {
                    handle.abort();
                }
            }
        }
        card
    }

    fn stop_card_runtime(&self, card_id: &str) {
        let mut timers = match self.timers.lock() {
            Ok(timers) => timers,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut entry) = timers.remove(card_id) {
            entry.abort_all();
        }
        drop(timers);
        self.fetch_gate.forget(card_id);
    }

    /// Fetches the source and stores the snapshot. A stored fetch of the same
    /// source that started at or after `not_before_ms` (typically one that ran
    /// while this call waited for its turn) is reused instead of repeated.
    async fn run_fetch(
        &self,
        card_id: &str,
        source: &DesktopCardDataSourceKind,
        not_before_ms: Option<i64>,
    ) -> Option<DesktopCardRecord> {
        let mut turn = self.fetch_gate.turn(card_id).await;
        {
            let store = self.store.lock().await;
            let Some(card) = store.get(card_id) else {
                drop(store);
                self.fetch_gate.forget(card_id);
                return None;
            };
            let started_since_request =
                not_before_ms.is_some_and(|not_before| turn.started_since(not_before));
            if can_reuse_fetch(card, source, started_since_request) {
                return Some(card.clone());
            }
        }
        let started_at_ms = now_ms();
        let result = refresh::fetch(source).await;
        let card = {
            let mut store = self.store.lock().await;
            let Some(card) = store.get_mut(card_id) else {
                drop(store);
                self.fetch_gate.forget(card_id);
                return None;
            };
            if !fetches_source(card, source) {
                return Some(card.clone());
            }
            let previous = card
                .last_data
                .as_ref()
                .map(|snapshot| snapshot.value.clone())
                .unwrap_or(Value::Null);
            card.last_data = Some(match result {
                Ok(output) => DesktopCardDataSnapshot {
                    fetched_at_ms: now_ms(),
                    value: output.value,
                    error: None,
                    warning: output.warning,
                },
                Err(error) => {
                    log::debug!(
                        "Desktop card data refresh failed: card_id={}, error={}",
                        card_id,
                        error
                    );
                    DesktopCardDataSnapshot {
                        fetched_at_ms: now_ms(),
                        value: previous,
                        error: Some(error),
                        warning: None,
                    }
                }
            });
            let card = card.clone();
            let _ = Self::save_locked(&mut store);
            card
        };
        turn.record_stored_fetch(started_at_ms);
        drop(turn);
        self.emit_changed(card_id, Some(&card), false);
        Some(card)
    }

    async fn fire_countdown(&self, card_id: &str, target_at_ms: i64) {
        let card = {
            let mut store = self.store.lock().await;
            let Some(card) = store.get_mut(card_id) else {
                return;
            };
            let DesktopCardTemplate::Known(DesktopCardTemplateKind::Countdown {
                target_at_ms: current_target,
                notified_at_ms,
                notify: true,
                ..
            }) = &mut card.template
            else {
                return;
            };
            if *current_target != target_at_ms || notified_at_ms.is_some() {
                return;
            }
            *notified_at_ms = Some(now_ms());
            card.visible = true;
            let card = card.clone();
            let _ = Self::save_locked(&mut store);
            card
        };
        log::info!("Desktop card countdown finished: card_id={}", card_id);
        let message = match card.template.known() {
            Some(DesktopCardTemplateKind::Countdown { message, .. }) => message.clone(),
            _ => None,
        };
        let body = due_notification_body(message.as_deref()).await;
        if let Err(error) = crate::api::system_api::send_system_notification(
            self.app.clone(),
            crate::api::system_api::SendNotificationRequest {
                title: card.title.clone(),
                body: Some(body),
            },
        )
        .await
        {
            log::warn!(
                "Failed to send desktop card notification: card_id={}, error={}",
                card_id,
                error
            );
        }
        let card = self.sync_card_runtime(card).await;
        if self.is_enabled() && !windows::desktop_pinned(&card) {
            windows::bring_to_front(&self.app, card_id);
        }
        self.emit_changed(card_id, Some(&card), false);
    }

    fn record_geometry(
        &self,
        card_id: String,
        position: Option<DesktopCardPosition>,
        size: Option<DesktopCardSize>,
    ) {
        let Some(service) = self.arc() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            {
                let mut store = service.store.lock().await;
                let Some(card) = store.get_mut(&card_id) else {
                    return;
                };
                let mut changed = false;
                if let Some(position) = position {
                    let differs = card.position.is_none_or(|current| {
                        (current.x - position.x).abs() >= 0.5
                            || (current.y - position.y).abs() >= 0.5
                    });
                    if differs {
                        card.position = Some(position);
                        changed = true;
                    }
                }
                if let Some(size) = size {
                    let size = clamp_size(size);
                    let current = windows::card_size(card);
                    if (current.width - size.width).abs() >= 0.5
                        || (current.height - size.height).abs() >= 0.5
                    {
                        card.size = Some(size);
                        changed = true;
                    }
                }
                if !changed {
                    return;
                }
            }
            if service.geometry_save_pending.swap(true, Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(GEOMETRY_SAVE_DELAY).await;
            service.geometry_save_pending.store(false, Ordering::SeqCst);
            let mut store = service.store.lock().await;
            let _ = Self::save_locked(&mut store);
        });
    }

    async fn handle_tool_request(&self, request: DesktopCardHostRequest) -> Result<Value, String> {
        let action = request.action();
        let result = match request {
            DesktopCardHostRequest::Create { draft, origin } => {
                ensure_local_display_surface()?;
                json!({ "card": self.create(draft, origin).await? })
            }
            DesktopCardHostRequest::Update { card_id, patch } => {
                json!({ "card": self.update(&card_id, patch).await? })
            }
            DesktopCardHostRequest::List => self.list().await,
            DesktopCardHostRequest::Get { card_id } => {
                json!({ "card": self.get(&card_id).await?, "enabled": self.is_enabled() })
            }
            DesktopCardHostRequest::Show { card_id } => {
                ensure_local_display_surface()?;
                self.require_enabled()?;
                json!({ "card": self.set_visible(&card_id, true).await? })
            }
            DesktopCardHostRequest::Hide { card_id } => {
                json!({ "card": self.set_visible(&card_id, false).await? })
            }
            DesktopCardHostRequest::Delete { card_id } => {
                self.delete(&card_id).await?;
                json!({ "card": { "id": card_id }, "deleted": true })
            }
            DesktopCardHostRequest::Refresh { card_id } => {
                json!({ "card": self.refresh_now(&card_id).await? })
            }
        };
        log::debug!("Desktop card tool request handled: action={}", action);
        Ok(result)
    }
}

fn fetches_source(card: &DesktopCardRecord, source: &DesktopCardDataSourceKind) -> bool {
    card.data_source
        .as_ref()
        .and_then(DesktopCardDataSource::known)
        == Some(source)
}

/// Whether a fetch that started at or after the caller's request can be
/// reused: it must have been stored for the card's current source.
fn can_reuse_fetch(
    card: &DesktopCardRecord,
    source: &DesktopCardDataSourceKind,
    fetch_started_since_request: bool,
) -> bool {
    fetch_started_since_request && fetches_source(card, source) && card.last_data.is_some()
}

fn initial_refresh_delay(card: &DesktopCardRecord, source: &DesktopCardDataSourceKind) -> Duration {
    let interval_ms = (source.interval_seconds() as i64).saturating_mul(1000);
    match &card.last_data {
        Some(snapshot) if snapshot.error.is_none() => {
            let elapsed = now_ms().saturating_sub(snapshot.fetched_at_ms).max(0);
            Duration::from_millis(interval_ms.saturating_sub(elapsed).max(0) as u64)
        }
        _ => Duration::ZERO,
    }
}

async fn refresh_loop(
    service: Weak<DesktopCards>,
    card_id: String,
    source: DesktopCardDataSourceKind,
    initial_delay: Duration,
    spawned_at_ms: i64,
) {
    tokio::time::sleep(initial_delay).await;
    let interval = Duration::from_secs(source.interval_seconds());
    let mut not_before_ms = spawned_at_ms;
    loop {
        let Some(service) = service.upgrade() else {
            return;
        };
        if service
            .run_fetch(&card_id, &source, Some(not_before_ms))
            .await
            .is_none()
        {
            return;
        }
        drop(service);
        tokio::time::sleep(interval).await;
        not_before_ms = now_ms();
    }
}

/// Boxed with an explicit `Send` bound because firing a countdown re-syncs the
/// card, which may schedule this task again; the recursive opaque future would
/// otherwise not be provably `Send`.
fn countdown_task(
    service: Weak<DesktopCards>,
    card_id: String,
    target_at_ms: i64,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        let delay = target_at_ms.saturating_sub(now_ms()).max(0) as u64;
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if let Some(service) = service.upgrade() {
            service.fire_countdown(&card_id, target_at_ms).await;
        }
    })
}

async fn configured_enabled() -> bool {
    match openbitfun_core::service::config::global::GlobalConfigManager::get_service().await {
        Ok(service) => service
            .get_config::<bool>(Some(DESKTOP_CARDS_CONFIG_PATH))
            .await
            .unwrap_or(true),
        Err(error) => {
            log::warn!(
                "Config service unavailable for desktop cards, keeping defaults: error={}",
                error
            );
            true
        }
    }
}

fn spawn_config_listener(service: Arc<DesktopCards>) {
    tauri::async_runtime::spawn(async move {
        let receiver = subscribe_config_updates();
        service.set_enabled(configured_enabled().await).await;
        let Some(mut receiver) = receiver else {
            log::warn!("Config update subscription unavailable for desktop cards");
            return;
        };
        loop {
            match receiver.recv().await {
                Ok(ConfigUpdateEvent::AppUpdated | ConfigUpdateEvent::ConfigReloaded) => {
                    let enabled = configured_enabled().await;
                    if enabled != service.is_enabled() {
                        service.set_enabled(enabled).await;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    log::warn!("Desktop card config listener channel closed");
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    log::warn!("Desktop card config listener lagged by {} messages", count);
                    let enabled = configured_enabled().await;
                    if enabled != service.is_enabled() {
                        service.set_enabled(enabled).await;
                    }
                }
            }
        }
    });
}

/// Loads the card store, registers the DesktopCard tool host, and restores
/// visible cards once the enable gate has been read.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let path = try_get_path_manager_arc()
        .map_err(|error| format!("Path manager unavailable for desktop cards: {error}"))?
        .user_data_dir()
        .join("desktop-cards")
        .join("cards.json");
    let service = DesktopCards::new(app.clone(), CardStore::load(path));
    app.manage(Arc::clone(&service));

    let handler_service = Arc::clone(&service);
    set_desktop_card_handler(Arc::new(move |request| {
        let service = Arc::clone(&handler_service);
        Box::pin(async move { service.handle_tool_request(request).await })
    }));

    spawn_config_listener(service);
    Ok(())
}

/// Tracks card geometry and turns a native close into "hide" so the card is kept.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(card_id) = windows::card_id_from_label(window.label()) else {
        return;
    };
    let Some(service) = window.app_handle().try_state::<Arc<DesktopCards>>() else {
        return;
    };
    let service = Arc::clone(service.inner());
    match event {
        tauri::WindowEvent::Moved(position) => {
            // WM_MOVE reports parent-client coordinates for attached windows.
            // Persist screen coordinates so detach and multi-monitor restore do
            // not jump by Explorer's desktop origin or non-client offset.
            #[cfg(windows)]
            let position = match window
                .hwnd()
                .ok()
                .and_then(|hwnd| desktop_layer::screen_position(hwnd).ok())
            {
                Some(point) => tauri::PhysicalPosition::new(point.x, point.y),
                None => *position,
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = position.to_logical::<f64>(scale);
            service.record_geometry(
                card_id.to_string(),
                Some(DesktopCardPosition {
                    x: position.x,
                    y: position.y,
                }),
                None,
            );
        }
        tauri::WindowEvent::Resized(size) => {
            if size.width == 0 || size.height == 0 {
                return;
            }
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = size.to_logical::<f64>(scale);
            service.record_geometry(
                card_id.to_string(),
                None,
                Some(DesktopCardSize {
                    width: size.width,
                    height: size.height,
                }),
            );
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let card_id = card_id.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = service.set_visible(&card_id, false).await {
                    log::warn!(
                        "Failed to hide desktop card after close request: card_id={}, error={}",
                        card_id,
                        error
                    );
                }
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_card(command: &str, last_data: Value) -> DesktopCardRecord {
        serde_json::from_value(json!({
            "id": "card-1",
            "title": "Repo",
            "template": {"kind": "note", "text": "x"},
            "dataSource": {"kind": "command", "command": command, "intervalSeconds": 300},
            "lastData": last_data
        }))
        .unwrap()
    }

    fn source(command: &str) -> DesktopCardDataSourceKind {
        serde_json::from_value(
            json!({"kind": "command", "command": command, "intervalSeconds": 300}),
        )
        .unwrap()
    }

    #[test]
    fn fetches_are_reused_only_when_started_since_the_request_for_the_same_source() {
        let card = command_card("gh api", json!({"fetchedAtMs": 1_000, "value": {"n": 1}}));
        assert!(can_reuse_fetch(&card, &source("gh api"), true));
        assert!(!can_reuse_fetch(&card, &source("gh api"), false));
        assert!(!can_reuse_fetch(&card, &source("gh api --paginate"), true));

        let pending = command_card("gh api", Value::Null);
        assert!(!can_reuse_fetch(&pending, &source("gh api"), true));
    }

    #[test]
    fn failed_or_missing_snapshots_refresh_immediately() {
        let source = source("gh api");
        let pending = command_card("gh api", Value::Null);
        assert_eq!(initial_refresh_delay(&pending, &source), Duration::ZERO);
        let failed = command_card(
            "gh api",
            json!({"fetchedAtMs": now_ms(), "error": "Command exited with 1: boom"}),
        );
        assert_eq!(initial_refresh_delay(&failed, &source), Duration::ZERO);
        let fresh = command_card("gh api", json!({"fetchedAtMs": now_ms(), "value": 1}));
        assert!(initial_refresh_delay(&fresh, &source) > Duration::from_secs(290));
    }
}
