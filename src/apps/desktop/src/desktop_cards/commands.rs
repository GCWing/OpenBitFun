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
    /// Omitted by older clients: retain the original always-on-top operation.
    #[serde(default)]
    pub desktop_pinned: Option<bool>,
}

/// Runtime capability of this host, never a persisted card field. Clients
/// negotiate with it before extending the legacy stacking request, so an
/// older host keeps receiving the original always-on-top payload.
fn desktop_pinning_supported() -> bool {
    cfg!(windows)
}

/// Host capabilities live beside the card list so management surfaces can
/// offer desktop pinning for hidden cards without loading every card.
fn with_host_capabilities(mut payload: Value) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "desktopPinningSupported".to_string(),
            serde_json::json!(desktop_pinning_supported()),
        );
    }
    payload
}

#[tauri::command]
pub async fn desktop_card_list(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardListRequest,
) -> Result<Value, String> {
    let DesktopCardListRequest {} = request;
    Ok(with_host_capabilities(cards.list().await))
}

#[tauri::command]
pub async fn desktop_card_get(
    cards: State<'_, Arc<DesktopCards>>,
    request: DesktopCardIdRequest,
) -> Result<DesktopCardRecord, String> {
    let mut card = cards.get(&request.card_id).await?;
    // Runtime capability only, never persisted. New clients must negotiate
    // before extending the legacy stacking request sent to an older host.
    card.extra.insert(
        "desktopPinningSupported".to_string(),
        serde_json::json!(desktop_pinning_supported()),
    );
    Ok(card)
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
        .set_stacking(
            &request.card_id,
            request.always_on_top,
            request.desktop_pinned,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_stacking_requests_do_not_require_desktop_pinning() {
        let request: DesktopCardAlwaysOnTopRequest = serde_json::from_value(json!({
            "cardId": "card-1", "alwaysOnTop": true
        }))
        .unwrap();
        assert!(request.always_on_top);
        assert_eq!(request.desktop_pinned, None);
        let request: DesktopCardAlwaysOnTopRequest = serde_json::from_value(json!({
            "cardId": "card-1", "alwaysOnTop": false, "desktopPinned": true
        }))
        .unwrap();
        assert!(!request.always_on_top);
        assert_eq!(request.desktop_pinned, Some(true));
    }

    #[test]
    fn list_advertises_pinning_as_an_additive_capability() {
        let payload = with_host_capabilities(json!({
            "enabled": true,
            "cards": [{ "id": "card-1", "desktopPinned": true }]
        }));
        assert_eq!(
            payload["desktopPinningSupported"],
            json!(desktop_pinning_supported())
        );
        // Older readers keep working: the original keys are untouched.
        assert_eq!(payload["enabled"], json!(true));
        assert_eq!(
            payload["cards"],
            json!([{ "id": "card-1", "desktopPinned": true }])
        );
        // A non-object payload is returned unchanged instead of patched.
        assert_eq!(with_host_capabilities(json!(null)), json!(null));
    }
}
