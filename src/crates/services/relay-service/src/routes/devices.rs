//! Authenticated device directory and key lookup. Bidirectional RPC uses realtime.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::db::AuthToken;
use crate::routes::api::AppState;

const MAX_DEVICE_ID_BYTES: usize = 128;

fn is_valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DEVICE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Validate bearer token and return its account principal and capability kind.
pub(crate) async fn validate_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthToken, StatusCode> {
    let db = state.db.as_ref();
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let auth = AuthToken::find(db, &token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !auth.can_control_devices() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(auth)
}

pub fn device_router() -> Router<AppState> {
    Router::new()
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{target_device_id}/key", get(device_key))
        .route(
            "/api/devices/{target_device_id}",
            patch(patch_device).delete(delete_device),
        )
}

#[derive(Serialize)]
pub struct DeviceKeyResponse {
    pub device_id: String,
    pub public_key: String,
}

/// Resolve even hidden controller keys, scoped to the authenticated account.
pub async fn device_key(
    State(state): State<AppState>,
    Path(target_device_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<DeviceKeyResponse>, StatusCode> {
    let auth = validate_user(&state, &headers).await?;
    if !is_valid_device_id(&target_device_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = state.db.as_ref();
    let public_key = sqlx::query_scalar::<_, Option<String>>(
        "SELECT public_key FROM devices WHERE user_id = ?1 AND device_id = ?2
         UNION ALL SELECT k.public_key FROM delegated_device_keys k JOIN auth_tokens t ON t.token = k.token
         WHERE t.user_id = ?1 AND k.controller_id = ?2 AND t.expires_at > unixepoch() LIMIT 1",
    )
    .bind(&auth.user_id)
    .bind(&target_device_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .flatten()
    .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(DeviceKeyResponse {
        device_id: target_device_id,
        public_key,
    }))
}

// ── List devices ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DeviceListEntry {
    pub device_id: String,
    pub device_name: String,
    pub device_kind: Option<String>,
    pub device_alias: Option<String>,
    pub device_model: Option<String>,
    pub device_os: Option<String>,
    pub device_os_version: Option<String>,
    pub client_version: Option<String>,
    pub client_protocol: Option<u32>,
    /// Relay-computed: whether this device can be remote-controlled by the
    /// caller, based on the two stored client protocol versions.
    pub compatible: bool,
    pub online: bool,
    pub last_seen_at: Option<i64>,
}

/// `GET /api/devices` — list the account's remote-control targets.
///
/// Phones and watches register device rows too (they need one to hold an auth
/// token), but they cannot host a session, so they are never listed here.
async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeviceListEntry>>, StatusCode> {
    let auth = validate_user(&state, &headers).await?;
    let user_id = auth.user_id.clone();

    // The caller's own stored build decides compatibility. For a delegated
    // controller token this is the row of the device the token belongs to.
    let caller_protocol = crate::db::stored_client_protocol(
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT client_protocol FROM devices WHERE user_id = ? AND device_id = ?",
        )
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .fetch_optional(state.db.as_ref())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .flatten(),
    );

    // Get online devices from DeviceManager (in-memory)
    let online = state.device_manager.online_devices(&user_id);
    let online_ids: std::collections::HashSet<String> =
        online.iter().map(|(id, _)| id.clone()).collect();

    // Get all registered devices from the DB (online + offline)
    let mut devices = Vec::new();
    let mut hidden_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let db = &state.db;
        if let Ok(db_devices) = crate::db::DeviceRow::list_by_user(db, &user_id).await {
            for row in db_devices {
                if !crate::db::device_kind_is_host(row.device_kind.as_deref()) {
                    hidden_ids.insert(row.device_id);
                    continue;
                }
                let is_online = online_ids.contains(&row.device_id);
                let target_protocol = row.client_protocol_u32();
                devices.push(DeviceListEntry {
                    device_id: row.device_id,
                    device_name: row.device_name.unwrap_or_default(),
                    device_kind: row.device_kind,
                    device_alias: row.device_alias,
                    device_model: row.device_model,
                    device_os: row.device_os,
                    device_os_version: row.device_os_version,
                    client_version: row.client_version,
                    client_protocol: target_protocol,
                    compatible: crate::db::client_builds_compatible(
                        caller_protocol,
                        target_protocol,
                    ),
                    online: is_online,
                    last_seen_at: row.last_seen_at,
                });
            }
        }
    }

    // Also include any online-only devices not yet in the DB. The in-memory
    // registry does not carry a kind, so these are treated like a NULL row —
    // except for ids the DB just told us to hide, which must stay hidden.
    for (id, name) in &online {
        if hidden_ids.contains(id) {
            continue;
        }
        if !devices.iter().any(|d| &d.device_id == id) {
            devices.push(DeviceListEntry {
                device_id: id.clone(),
                device_name: name.clone(),
                device_kind: None,
                device_alias: None,
                device_model: None,
                device_os: None,
                device_os_version: None,
                client_version: None,
                client_protocol: None,
                compatible: crate::db::client_builds_compatible(caller_protocol, None),
                online: true,
                last_seen_at: None,
            });
        }
    }

    Ok(Json(devices))
}

// A custom deserializer preserves explicit null rather than collapsing it into omission.
fn present_nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicePatch {
    #[serde(default, deserialize_with = "present_nullable")]
    device_alias: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_string")]
    device_model: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    device_os: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    device_os_version: Option<String>,
}

async fn patch_device(
    State(state): State<AppState>,
    axum::Extension(io): axum::Extension<socketioxide::SocketIo>,
    headers: HeaderMap,
    Path(target_device_id): Path<String>,
    Json(body): Json<DevicePatch>,
) -> Result<StatusCode, StatusCode> {
    let auth = validate_user(&state, &headers).await?;
    if !auth.is_device_token() {
        return Err(StatusCode::FORBIDDEN);
    }
    if !is_valid_device_id(&target_device_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let metadata_present =
        body.device_model.is_some() || body.device_os.is_some() || body.device_os_version.is_some();
    if ![
        body.device_alias.as_ref().and_then(|v| v.as_deref()),
        body.device_model.as_deref(),
        body.device_os.as_deref(),
        body.device_os_version.as_deref(),
    ]
    .into_iter()
    .flatten()
    .all(crate::db::valid_device_directory_text)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.device_manager.lock_presence_projection().await;
    // BEGIN IMMEDIATE serializes authorization with external/admin revocation too.
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let current = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_tokens WHERE token=? AND user_id=? AND device_id=? AND token_kind='device' AND expires_at>unixepoch()")
        .bind(&auth.token).bind(&auth.user_id).bind(&auth.device_id).fetch_one(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if current != 1 {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM devices WHERE user_id=? AND device_id=?",
    )
    .bind(&auth.user_id)
    .bind(&target_device_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if exists == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    if metadata_present && target_device_id != auth.device_id {
        return Err(StatusCode::FORBIDDEN);
    }
    sqlx::query("UPDATE devices SET device_alias=CASE WHEN ? THEN ? ELSE device_alias END, device_model=COALESCE(?,device_model), device_os=COALESCE(?,device_os), device_os_version=COALESCE(?,device_os_version) WHERE user_id=? AND device_id=?")
        .bind(body.device_alias.is_some()).bind(body.device_alias.flatten())
        .bind(body.device_model).bind(body.device_os).bind(body.device_os_version)
        .bind(&auth.user_id).bind(&target_device_id).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    crate::realtime::presence::broadcast(&io, &state, &auth.user_id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target_device_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let auth = validate_user(&state, &headers).await?;
    if !auth.is_device_token() {
        return Err(StatusCode::FORBIDDEN);
    }
    let user_id = auth.user_id.clone();

    if !is_valid_device_id(&target_device_id) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state.db.as_ref();
    let _presence_projection_guard = state.device_manager.lock_presence_projection().await;
    let current_auth = crate::db::AuthToken::find(db, &auth.token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !current_auth.is_device_token()
        || current_auth.user_id != user_id
        || current_auth.device_id != auth.device_id
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Revoke the target's auth tokens before removing its device row. The DB
    // helper also scopes the deletion to this account and performs both writes
    // atomically so a guessed device id cannot affect another account.
    let deleted = crate::db::DeviceRow::delete_for_user(db, &user_id, &target_device_id)
        .await
        .map_err(|error| {
            tracing::error!(
                user_id = %user_id,
                target_device_id = %target_device_id,
                %error,
                "Failed to delete account device"
            );
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }

    // Disconnect active WS session if any.
    state
        .device_manager
        .disconnect_device(&user_id, &target_device_id);
    drop(_presence_projection_guard);

    tracing::info!("Device {target_device_id} removed from account {user_id}");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connect, AuthToken, DbPool, DeviceRow, UserRow};
    use crate::MemoryAssetStore;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    struct TestContext {
        app: axum::Router,
        db: Arc<DbPool>,
        owner_token: String,
        delegated_token: String,
        target_token: String,
        other_token: String,
    }

    async fn patch_json(
        ctx: &TestContext,
        token: &str,
        id: &str,
        body: serde_json::Value,
    ) -> StatusCode {
        ctx.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/devices/{id}"))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn concurrent_patch_and_revocation_never_restore_deleted_devices() {
        for revoke_caller in [false, true] {
            let ctx = setup_app().await;
            let target = if revoke_caller {
                "owner-device"
            } else {
                "target-device"
            };
            let (patched, deleted) = tokio::join!(
                patch_json(
                    &ctx,
                    &ctx.owner_token,
                    "target-device",
                    serde_json::json!({"device_alias":"Racing"})
                ),
                delete(&ctx.app, &ctx.target_token, target)
            );
            assert_eq!(deleted, StatusCode::NO_CONTENT);
            assert!(matches!(
                patched,
                StatusCode::NO_CONTENT | StatusCode::NOT_FOUND | StatusCode::UNAUTHORIZED
            ));
            assert!(!DeviceRow::list_by_user(&ctx.db, "owner")
                .await
                .unwrap()
                .iter()
                .any(|row| row.device_id == target));
            assert_eq!(
                patch_json(
                    &ctx,
                    &ctx.owner_token,
                    "target-device",
                    serde_json::json!({"device_alias":"After deletion"})
                )
                .await,
                if revoke_caller {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::NOT_FOUND
                }
            );
        }
    }

    #[tokio::test]
    async fn directory_patch_permissions_clearing_and_omission() {
        use serde_json::json;
        let ctx = setup_app().await;
        for (token, id, body, status) in [
            (
                &ctx.delegated_token,
                "target-device",
                json!({"device_alias":"Alias"}),
                StatusCode::FORBIDDEN,
            ),
            (
                &ctx.other_token,
                "target-device",
                json!({"device_alias":"Alias"}),
                StatusCode::NOT_FOUND,
            ),
            (
                &ctx.owner_token,
                "missing",
                json!({"device_os":"Linux"}),
                StatusCode::NOT_FOUND,
            ),
            (
                &ctx.owner_token,
                "target-device",
                json!({"device_alias":"Alias","device_os":"Linux"}),
                StatusCode::FORBIDDEN,
            ),
            (
                &ctx.owner_token,
                "target-device",
                json!({"device_alias":"Alias"}),
                StatusCode::NO_CONTENT,
            ),
            (
                &ctx.target_token,
                "target-device",
                json!({"device_model":"Model","device_os":"Linux","device_os_version":"6"}),
                StatusCode::NO_CONTENT,
            ),
            (
                &ctx.owner_token,
                "target-device",
                json!({}),
                StatusCode::NO_CONTENT,
            ),
        ] {
            assert_eq!(patch_json(&ctx, token, id, body).await, status);
        }
        let row = DeviceRow::list_by_user(&ctx.db, "owner")
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.device_id == "target-device")
            .unwrap();
        assert_eq!(row.device_alias.as_deref(), Some("Alias"));
        assert_eq!(row.device_name.as_deref(), Some("Target"));
        assert_eq!(row.device_os.as_deref(), Some("Linux"));
        DeviceRow::upsert(
            &ctx.db,
            "target-device",
            "owner",
            "New technical name",
            None,
            None,
        )
        .await
        .unwrap();
        let response = ctx
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/devices")
                    .header(header::AUTHORIZATION, format!("Bearer {}", ctx.owner_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 16384)
                .await
                .unwrap(),
        )
        .unwrap();
        let row = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["device_id"] == "target-device")
            .unwrap();
        assert_eq!(row["device_alias"], "Alias");
        assert_eq!(row["device_name"], "New technical name");
        assert_eq!(row["device_model"], "Model");
        assert_eq!(row["device_os_version"], "6");
        assert_eq!(
            patch_json(
                &ctx,
                &ctx.owner_token,
                "target-device",
                json!({"device_alias":null})
            )
            .await,
            StatusCode::NO_CONTENT
        );
        let row = DeviceRow::list_by_user(&ctx.db, "owner")
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.device_id == "target-device")
            .unwrap();
        assert!(row.device_alias.is_none());
        assert_eq!(row.device_os.as_deref(), Some("Linux"));
        for value in [
            "".to_string(),
            "  ".to_string(),
            "bad\nname".to_string(),
            "a".repeat(257),
        ] {
            assert_eq!(
                patch_json(
                    &ctx,
                    &ctx.owner_token,
                    "owner-device",
                    json!({"device_alias":value})
                )
                .await,
                StatusCode::BAD_REQUEST
            );
            assert_eq!(
                patch_json(
                    &ctx,
                    &ctx.owner_token,
                    "owner-device",
                    json!({"device_model":value})
                )
                .await,
                StatusCode::BAD_REQUEST
            );
        }
        for body in [
            json!({"device_os":null}),
            json!({"metadata":{"extra":true}}),
            json!({"device_alias":12}),
        ] {
            assert_eq!(
                patch_json(&ctx, &ctx.owner_token, "owner-device", body).await,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        assert_eq!(
            delete(&ctx.app, &ctx.owner_token, "target-device").await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            patch_json(
                &ctx,
                &ctx.owner_token,
                "target-device",
                json!({"device_alias":"Gone"})
            )
            .await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            patch_json(
                &ctx,
                &ctx.target_token,
                "owner-device",
                json!({"device_alias":"Gone"})
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn delegated_device_keys_are_scoped_and_follow_parent_revocation() {
        let ctx = setup_app().await;
        let controller = AuthToken::create_keyed_delegated(
            &ctx.db,
            "owner",
            "owner-device",
            "controller-public-key",
        )
        .await
        .unwrap();
        let id = controller.routing_device_id(&ctx.db).await.unwrap();
        assert_ne!(id, "owner-device");
        let second =
            AuthToken::create_keyed_delegated(&ctx.db, "owner", "owner-device", "other-public-key")
                .await
                .unwrap();
        assert_ne!(id, second.routing_device_id(&ctx.db).await.unwrap());
        for (token, expected) in [
            (&ctx.owner_token, StatusCode::OK),
            (&ctx.other_token, StatusCode::NOT_FOUND),
        ] {
            let response = ctx
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/devices/{id}/key"))
                        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        AuthToken::revoke_by_device(&ctx.db, "owner", "owner-device")
            .await
            .unwrap();
        assert!(controller.routing_device_id(&ctx.db).await.is_err());
        assert!(second.routing_device_id(&ctx.db).await.is_err());
    }

    async fn setup_app() -> TestContext {
        let db = Arc::new(connect(":memory:").await.unwrap());
        UserRow::create(&db, "owner", "alice").await.unwrap();
        UserRow::create(&db, "other", "bob").await.unwrap();
        DeviceRow::upsert(&db, "owner-device", "owner", "Owner", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&db, "target-device", "owner", "Target", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&db, "other-device", "other", "Other", None, None)
            .await
            .unwrap();

        let owner_token = AuthToken::create(&db, "owner", "owner-device")
            .await
            .unwrap()
            .token;
        let delegated_token = AuthToken::create_delegated(&db, "owner", "owner-device")
            .await
            .unwrap()
            .token;
        let target_token = AuthToken::create(&db, "owner", "target-device")
            .await
            .unwrap()
            .token;
        let other_token = AuthToken::create(&db, "other", "other-device")
            .await
            .unwrap()
            .token;
        let app = crate::build_relay_router(
            Arc::new(MemoryAssetStore::new()),
            std::time::Instant::now(),
            db.clone(),
            "test",
        );

        TestContext {
            app,
            db,
            owner_token,
            delegated_token,
            target_token,
            other_token,
        }
    }

    async fn delete(app: &axum::Router, token: &str, device_id: &str) -> StatusCode {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/devices/{device_id}"))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    async fn list(app: &axum::Router, token: &str) -> StatusCode {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/devices")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    async fn listed_device_ids(app: &axum::Router, token: &str) -> Vec<String> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/devices")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        entries
            .into_iter()
            .map(|entry| entry["device_id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn listed_devices(app: &axum::Router, token: &str) -> Vec<serde_json::Value> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/devices")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn entry<'a>(devices: &'a [serde_json::Value], id: &str) -> &'a serde_json::Value {
        devices
            .iter()
            .find(|device| device["device_id"] == id)
            .unwrap()
    }

    #[tokio::test]
    async fn device_directory_reports_client_build_compatibility() {
        let ctx = setup_app().await;

        // Legacy-to-legacy: neither side reports a build, so compatibility
        // cannot be proven and the device is reported as incompatible — but it
        // is still listed, never hidden.
        let devices = listed_devices(&ctx.app, &ctx.owner_token).await;
        let target = entry(&devices, "target-device");
        assert_eq!(target["compatible"], false);
        assert_eq!(target["device_name"], "Target");
        assert_eq!(target["client_version"], serde_json::Value::Null);
        assert_eq!(target["client_protocol"], serde_json::Value::Null);

        // The caller reports but the target does not: compatibility cannot be
        // proven, so the pair is reported as incompatible.
        DeviceRow::set_client_build(&ctx.db, "owner", "owner-device", Some("1.0.0"), Some(5))
            .await
            .unwrap();
        let devices = listed_devices(&ctx.app, &ctx.owner_token).await;
        assert_eq!(entry(&devices, "target-device")["compatible"], false);
        assert_eq!(entry(&devices, "owner-device")["compatible"], true);

        // Matching protocols are compatible and both fields are exposed.
        DeviceRow::set_client_build(&ctx.db, "owner", "target-device", Some("1.2.0"), Some(5))
            .await
            .unwrap();
        let devices = listed_devices(&ctx.app, &ctx.owner_token).await;
        let target = entry(&devices, "target-device");
        assert_eq!(target["compatible"], true);
        assert_eq!(target["client_version"], "1.2.0");
        assert_eq!(target["client_protocol"], 5);

        // Differing protocols are incompatible but the device stays listed.
        DeviceRow::set_client_build(&ctx.db, "owner", "target-device", Some("1.3.0"), Some(6))
            .await
            .unwrap();
        let devices = listed_devices(&ctx.app, &ctx.owner_token).await;
        let target = entry(&devices, "target-device");
        assert_eq!(target["compatible"], false);
        assert_eq!(target["device_name"], "Target");
        assert_eq!(target["client_protocol"], 6);
    }

    #[tokio::test]
    async fn device_list_hides_mobile_devices_and_keeps_unlabeled_rows() {
        let ctx = setup_app().await;
        DeviceRow::upsert(
            &ctx.db,
            "phone",
            "owner",
            "HarmonyOS Phone",
            Some("mobile"),
            None,
        )
        .await
        .unwrap();
        DeviceRow::upsert(&ctx.db, "mac", "owner", "MacBook", Some("desktop"), None)
            .await
            .unwrap();
        DeviceRow::upsert(
            &ctx.db,
            "headless",
            "owner",
            "Build host",
            Some("cli"),
            None,
        )
        .await
        .unwrap();

        let ids = listed_device_ids(&ctx.app, &ctx.owner_token).await;

        assert!(!ids.contains(&"phone".to_string()));
        assert!(ids.contains(&"mac".to_string()));
        // A CLI host runs the same control plane as a desktop, so it stays a
        // control target instead of being hidden like a controller.
        assert!(ids.contains(&"headless".to_string()));
        // owner-device and target-device were registered before the kind
        // existed; a NULL kind must still be offered as a control target.
        assert!(ids.contains(&"owner-device".to_string()));
        assert!(ids.contains(&"target-device".to_string()));
    }

    #[tokio::test]
    async fn a_login_without_a_kind_does_not_erase_a_known_one() {
        let ctx = setup_app().await;
        DeviceRow::upsert(
            &ctx.db,
            "phone",
            "owner",
            "HarmonyOS Phone",
            Some("mobile"),
            None,
        )
        .await
        .unwrap();

        // An older client build logs in again and reports no kind.
        DeviceRow::upsert(&ctx.db, "phone", "owner", "HarmonyOS Phone", None, None)
            .await
            .unwrap();

        let ids = listed_device_ids(&ctx.app, &ctx.owner_token).await;
        assert!(!ids.contains(&"phone".to_string()));
    }

    #[tokio::test]
    async fn deleting_owned_device_revokes_token_before_device_row() {
        let ctx = setup_app().await;

        let status = delete(&ctx.app, &ctx.owner_token, "target-device").await;

        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(AuthToken::find(&ctx.db, &ctx.target_token)
            .await
            .unwrap()
            .is_none());
        let devices = DeviceRow::list_by_user(&ctx.db, "owner").await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, "owner-device");
    }

    #[tokio::test]
    async fn deleting_current_device_revokes_the_callers_token() {
        let ctx = setup_app().await;

        assert_eq!(
            delete(&ctx.app, &ctx.owner_token, "owner-device").await,
            StatusCode::NO_CONTENT
        );
        assert!(AuthToken::find(&ctx.db, &ctx.owner_token)
            .await
            .unwrap()
            .is_none());
        let devices = DeviceRow::list_by_user(&ctx.db, "owner").await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, "target-device");
    }

    #[tokio::test]
    async fn deleting_another_accounts_device_is_rejected() {
        let ctx = setup_app().await;

        assert_eq!(
            delete(&ctx.app, &ctx.owner_token, "other-device").await,
            StatusCode::NOT_FOUND
        );
        assert!(AuthToken::find(&ctx.db, &ctx.owner_token)
            .await
            .unwrap()
            .is_some());
        assert!(AuthToken::find(&ctx.db, &ctx.other_token)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn delegated_control_token_cannot_delete_its_parent_device() {
        let ctx = setup_app().await;

        assert_eq!(list(&ctx.app, &ctx.delegated_token).await, StatusCode::OK);
        assert_eq!(
            delete(&ctx.app, &ctx.delegated_token, "owner-device").await,
            StatusCode::FORBIDDEN
        );
        assert!(AuthToken::find(&ctx.db, &ctx.owner_token)
            .await
            .unwrap()
            .is_some());
        assert!(DeviceRow::list_by_user(&ctx.db, "owner")
            .await
            .unwrap()
            .iter()
            .any(|device| device.device_id == "owner-device"));
    }
}
