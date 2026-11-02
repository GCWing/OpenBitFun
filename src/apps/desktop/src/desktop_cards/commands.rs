//! Tauri commands used by the card windows, the home page, and settings.

use std::sync::Arc;

use openbitfun_core::agentic::tools::desktop_card_host::DesktopCardRecord;
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use super::DesktopCards;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardListRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardIdRequest {
    pub card_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardSetVisibleRequest {
    pub card_id: String,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardChecklistItemRequest {
    pub card_id: String,
    pub item_id: String,
    pub done: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardAlwaysOnTopRequest {
    pub card_id: String,
    pub always_on_top: bool,
}

#[tauri::command]
pub async fn desktop_card_list(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardListRequest,
) -> Result<Value, String> {
    let DesktopCardListRequest {} = request;
    Ok(cards.list().await)
}

#[tauri::command]
pub async fn desktop_card_get(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardIdRequest,
) -> Result<DesktopCardRecord, String> {
    cards.get(&request.card_id).await
}

#[tauri::command]
pub async fn desktop_card_set_visible(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardSetVisibleRequest,
) -> Result<DesktopCardRecord, String> {
    if request.visible && !cards.is_enabled() {
        return Err("Desktop cards are turned off in OpenBitFun settings.".to_string());
    }
    cards.set_visible(&request.card_id, request.visible).await
}

#[tauri::command]
pub async fn desktop_card_delete(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardIdRequest,
) -> Result<(), String> {
    cards.delete(&request.card_id).await
}

#[tauri::command]
pub async fn desktop_card_refresh(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardIdRequest,
) -> Result<DesktopCardRecord, String> {
    cards.refresh_now(&request.card_id).await
}

#[tauri::command]
pub async fn desktop_card_set_checklist_item(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardChecklistItemRequest,
) -> Result<DesktopCardRecord, String> {
    cards
        .set_checklist_item(&request.card_id, &request.item_id, request.done)
        .await
}

#[tauri::command]
pub async fn desktop_card_set_always_on_top(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardAlwaysOnTopRequest,
) -> Result<DesktopCardRecord, String> {
    cards
        .set_always_on_top(&request.card_id, request.always_on_top)
        .await
}
