//! GitHub-authenticated device credentials and pairwise encrypted relay messages.

use super::device_crypto;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, OnceCell};

use crate::remote_connect::device::DeviceIdentity;
use crate::remote_connect::relay_http::{
    relay_http_client, send_with_retry, BufferedRelayResponse, RelayHttpRetry,
};

pub const MASTER_KEY_LEN: usize = 32;

/// A retired official deployment has its own credential database. Authenticate
/// with the new deployment instead of replaying its token or deleting the record.
///
/// Every official release lives under `https://remote.openbitfun.com/v/<version>`;
/// any such endpoint other than the one this build targets is retired.
pub fn is_retired_official_relay(value: &str) -> bool {
    let current = reqwest::Url::parse(openbitfun_product_domains::account::DEFAULT_RELAY_URL)
        .expect("official relay endpoint is a valid URL");
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == current.host_str()
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && is_retired_official_version_path(url.path(), current.path())
    })
}

fn is_retired_official_version_path(path: &str, current: &str) -> bool {
    let path = path.trim_end_matches('/');
    let current = current.trim_end_matches('/');
    path != current
        && path
            .strip_prefix("/v/")
            .is_some_and(|version| !version.is_empty() && !version.contains('/'))
}

/// A host announced that one of its streams changed. Hints are lossy wake-ups;
/// the subscriber always reads the authoritative page from the host.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamHint {
    pub source_device_id: String,
    pub stream_id: String,
    pub epoch: u64,
    pub cursor: u64,
}

/// Device-scoped relay credentials and a locally owned X25519 private key.
#[derive(Clone)]
pub struct AccountSession {
    pub token: String,
    hints: tokio::sync::broadcast::Sender<Option<StreamHint>>,
    pub user_id: String,
    pub master_key: [u8; MASTER_KEY_LEN],
    peer_keys: Arc<Mutex<HashMap<String, Arc<OnceCell<[u8; 32]>>>>>,
    transports: Arc<Mutex<HashMap<String, Arc<OnceCell<Arc<super::relay_client::RelayClient>>>>>>,
}

impl std::fmt::Debug for AccountSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountSession")
            .field("user_id", &self.user_id)
            .finish_non_exhaustive()
    }
}

impl AccountSession {
    pub fn new(token: String, user_id: String, device_secret: [u8; 32]) -> Self {
        Self {
            token,
            hints: tokio::sync::broadcast::channel(64).0,
            user_id,
            master_key: device_secret,
            peer_keys: Arc::new(Mutex::new(HashMap::new())),
            transports: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Stream change hints from hosts. `None` marks a (re)connect; receiver lag
    /// means catch up every subscribed stream.
    pub fn stream_hints(&self) -> tokio::sync::broadcast::Receiver<Option<StreamHint>> {
        self.hints.subscribe()
    }

    /// Route an already-decrypted `DeviceEvent` from `source_device_id` to the
    /// local stream subscribers. Returns true when the event was a stream hint.
    pub fn deliver_device_event(
        &self,
        source_device_id: &str,
        event: &str,
        payload: &serde_json::Value,
    ) -> bool {
        if event != super::host_stream::HOST_STREAM_CHANGED_EVENT {
            return false;
        }
        let (Some(stream_id), Some(epoch), Some(cursor)) = (
            payload["stream_id"].as_str(),
            payload["epoch"].as_u64(),
            payload["cursor"].as_u64(),
        ) else {
            return true;
        };
        let _ = self.hints.send(Some(StreamHint {
            source_device_id: source_device_id.to_owned(),
            stream_id: stream_id.to_owned(),
            epoch,
            cursor,
        }));
        true
    }

    pub async fn clear_peer_keys(&self) {
        self.peer_keys.lock().await.clear();
    }

    pub async fn peer_message_key(&self, relay_url: &str, device_id: &str) -> Result<[u8; 32]> {
        let endpoint = AccountClient::endpoint(
            relay_url,
            &format!("/api/devices/{}/key", urlencoding::encode(device_id)),
        )?;
        let cache_id = endpoint.to_string();
        let cell = {
            let mut keys = self.peer_keys.lock().await;
            keys.entry(cache_id).or_default().clone()
        };
        // Only callers for this peer share initialization. No account-wide
        // lock survives network IO. Failed/cancelled lookups can be retried;
        // invalidation removes the cell so an older lookup cannot refill it.
        cell.get_or_try_init(|| async {
            let response = relay_http_client()
                .get(endpoint)
                .bearer_auth(&self.token)
                .send()
                .await?;
            if !response.status().is_success() {
                return Err(AccountClient::into_error(response).await);
            }
            #[derive(Deserialize)]
            struct PeerKey {
                device_id: String,
                public_key: String,
            }
            let peer: PeerKey = response.json().await?;
            if peer.device_id != device_id {
                return Err(anyhow!("relay returned a different device identity"));
            }
            let public = super::encryption::parse_public_key(&peer.public_key)?;
            let key = device_crypto::derive_message_key(&self.master_key, &public)?;
            Ok(key)
        })
        .await
        .copied()
    }

    pub async fn encrypt_for_peer(
        &self,
        relay_url: &str,
        device_id: &str,
        plaintext: &str,
    ) -> Result<(String, String)> {
        let key = self.peer_message_key(relay_url, device_id).await?;
        super::encryption::encrypt_to_base64(&key, plaintext)
    }

    pub async fn decrypt_from_peer(
        &self,
        relay_url: &str,
        device_id: &str,
        data: &str,
        nonce: &str,
    ) -> Result<String> {
        let key = self.peer_message_key(relay_url, device_id).await?;
        match super::encryption::decrypt_from_base64(&key, data, nonce) {
            Ok(plaintext) => Ok(plaintext),
            Err(_) => {
                // A device can rotate its private key while a controller is
                // disconnected. Refresh its authenticated key once on failure.
                let endpoint = AccountClient::endpoint(
                    relay_url,
                    &format!("/api/devices/{}/key", urlencoding::encode(device_id)),
                )?;
                self.peer_keys.lock().await.remove(endpoint.as_str());
                let key = self.peer_message_key(relay_url, device_id).await?;
                super::encryption::decrypt_from_base64(&key, data, nonce)
            }
        }
    }
}

/// A delegated token for a paired client (mobile-web / IM bot).
/// The desktop requests this from the relay and transmits it along
/// with a fresh controller private key over the authenticated E2E channel.
#[derive(Clone)]
pub struct DelegateToken {
    pub token: String,
    pub user_id: String,
    pub device_secret: [u8; 32],
}

/// Full device credential minted for a distinct SSH host. Unlike
/// [`DelegateToken`], this token may authenticate a device WebSocket and is
/// therefore only issued by the narrow authenticated provisioning endpoint.
#[derive(Clone, Serialize, Deserialize)]
pub struct ProvisionedDeviceToken {
    pub token: String,
    pub user_id: String,
    pub device_id: String,
}

// ── Relay HTTP client ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct AuthResponse {
    token: String,
    user_id: String,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
    #[serde(default)]
    retry_after_secs: Option<i64>,
}

/// HTTP client for the relay's account endpoints.
pub struct AccountClient {
    http: reqwest::Client,
}

/// Check whether an account/relay error message indicates an invalid or
/// expired account token (relay auth failure). Shared by Desktop, CLI, and
/// account surfaces so they all react to the same relay wording.
pub fn error_indicates_expired_token(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("http 401")
        || lower.contains("unauthorized")
        || lower.contains("invalid or expired token")
        || lower.contains("relay auth error")
}

/// Parse a user/config supplied relay base URL at the shared transport
/// boundary. Paths are allowed for reverse-proxy prefixes; credentials,
/// query strings, fragments, and non-HTTP schemes are not.
pub fn validate_relay_base_url(relay_url: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(relay_url.trim())
        .map_err(|error| anyhow!("invalid relay URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "relay URL must be an http(s) server address without credentials, query, or fragment"
        ));
    }
    Ok(url)
}

impl Default for AccountClient {
    fn default() -> Self {
        Self::new()
    }
}

impl AccountClient {
    /// Reuse the shared GitHub login used by the OpenBitFun marketplaces.
    pub async fn login_with_identity(
        &self,
        relay_url: &str,
        device: &DeviceIdentity,
    ) -> Result<(
        AccountSession,
        openbitfun_product_domains::account::GitHubUser,
    )> {
        let mut identity =
            crate::account_identity::AccountIdentityClient::from_environment().await?;
        let profile = identity
            .me()
            .await?
            .ok_or_else(|| anyhow!("Sign in to continue"))?;
        let access_token = identity
            .access_token()
            .await?
            .ok_or_else(|| anyhow!("Sign in to continue"))?;
        let account_id = profile
            .user
            .identity_id()
            .ok_or_else(|| anyhow!("Unsupported account identity"))?;
        let device_secret =
            super::session_store::device_secret(relay_url, &account_id, &device.device_id)?;
        let body = serde_json::json!({
            "access_token": access_token,
            "device_id": device.device_id,
            "device_name": device.device_name,
            "device_kind": "desktop",
            "public_key": device_crypto::public_key_base64(&device_secret),
            "request_id": uuid::Uuid::new_v4().to_string(),
        });
        let response = send_with_retry(
            "GitHub relay login",
            self.http
                .post(Self::endpoint(relay_url, "/api/auth/login")?)
                .json(&body),
            RelayHttpRetry::IdempotentWrite,
        )
        .await?;
        if !response.status().is_success() {
            return Err(Self::into_buffered_error(response));
        }
        let auth: AuthResponse = response.json().await?;
        if auth.user_id != account_id {
            return Err(anyhow!("relay returned a different account identity"));
        }
        Ok((
            AccountSession::new(auth.token, auth.user_id, device_secret),
            profile.user,
        ))
    }

    pub fn new() -> Self {
        Self {
            http: relay_http_client(),
        }
    }

    fn endpoint(relay_url: &str, path: &str) -> Result<reqwest::Url> {
        let mut url = validate_relay_base_url(relay_url)?;
        let base_path = url.path().trim_end_matches('/').to_string();
        url.set_path(&format!("{base_path}{path}"));
        Ok(url)
    }

    /// Map a non-2xx relay response into a human-readable error.
    async fn into_error(resp: reqwest::Response) -> anyhow::Error {
        let status = resp.status();
        let body = resp.bytes().await.unwrap_or_default();
        Self::error_from_response_parts(status, &body)
    }

    fn into_buffered_error(resp: BufferedRelayResponse) -> anyhow::Error {
        let (status, body) = resp.into_parts();
        Self::error_from_response_parts(status, &body)
    }

    fn error_from_response_parts(status: reqwest::StatusCode, body: &[u8]) -> anyhow::Error {
        if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            return anyhow!(
                "relay returned HTTP 413 Payload Too Large \
                 (encrypted session/settings blob exceeds relay body limit; \
                  raise Axum DefaultBodyLimit on /api/sync/* and any reverse-proxy \
                  client_max_body_size)"
            );
        }
        if status == reqwest::StatusCode::INSUFFICIENT_STORAGE {
            return anyhow!(
                "relay returned HTTP 507 Insufficient Storage (the configured account or asset quota is full)"
            );
        }
        match serde_json::from_slice::<ErrorBody>(body) {
            Ok(body) => {
                let msg = body.error;
                if let Some(retry) = body.retry_after_secs {
                    anyhow!("{msg} (HTTP {status}, retry in {retry}s)")
                } else {
                    anyhow!("{msg} (HTTP {status})")
                }
            }
            Err(_) => anyhow!("relay returned HTTP {status}"),
        }
    }

    /// Fetch the login challenge and unwrap the master key locally.
    /// Does not call `/api/auth/login` and does not mint a token.
    fn auth_header(session: &AccountSession) -> String {
        format!("Bearer {}", session.token)
    }

    /// Issue an account token for a paired controller.
    pub async fn delegate_token(
        &self,
        relay_url: &str,
        session: &AccountSession,
    ) -> Result<DelegateToken> {
        let device_secret = super::device_crypto::generate_secret();
        let resp = send_with_retry(
            "delegate account token",
            self.http
                .post(Self::endpoint(relay_url, "/api/auth/delegate")?)
                .header("Authorization", Self::auth_header(session))
                .json(&serde_json::json!({ "public_key": super::device_crypto::public_key_base64(&device_secret) })),
            RelayHttpRetry::SingleAttempt,
        )
        .await?;
        if !resp.status().is_success() {
            return Err(Self::into_buffered_error(resp));
        }
        let auth: AuthResponse = resp.json().await?;
        Ok(DelegateToken {
            token: auth.token,
            user_id: auth.user_id,
            device_secret,
        })
    }

    /// Register a new account device and mint its full routing token.
    ///
    /// `device_kind` is what keeps the minted row out of the wrong lists: this
    /// route serves both an SSH host being bootstrapped (`"desktop"`) and a
    /// keyboard-less peer that cannot type a password (`"watch"`), and only the
    /// caller knows which one it is holding.
    /// `request_id` makes an ambiguous HTTP response safe to replay.
    pub async fn provision_device_token(
        &self,
        relay_url: &str,
        session: &AccountSession,
        device_id: &str,
        device_name: &str,
        device_kind: &str,
        request_id: uuid::Uuid,
        device_secret: &[u8; 32],
    ) -> Result<ProvisionedDeviceToken> {
        let body = serde_json::json!({
            "device_id": device_id,
            "device_name": device_name,
            "device_kind": device_kind,
            "public_key": device_crypto::public_key_base64(device_secret),
            "request_id": request_id.to_string(),
        });
        let resp = send_with_retry(
            "provision account device",
            self.http
                .post(Self::endpoint(relay_url, "/api/auth/provision-device")?)
                .header("Authorization", Self::auth_header(session))
                .json(&body),
            RelayHttpRetry::IdempotentWrite,
        )
        .await?;
        if !resp.status().is_success() {
            return Err(Self::into_buffered_error(resp));
        }
        let provisioned: ProvisionedDeviceToken = resp.json().await?;
        if provisioned.user_id != session.user_id || provisioned.device_id != device_id {
            return Err(anyhow!(
                "relay returned a mismatched provisioned device identity"
            ));
        }
        Ok(provisioned)
    }

    /// Revoke the account token on the relay (server-side logout).
    pub async fn revoke_token(&self, relay_url: &str, session: &AccountSession) -> Result<()> {
        let resp = send_with_retry(
            "revoke account token",
            self.http
                .post(Self::endpoint(relay_url, "/api/auth/logout")?)
                .header("Authorization", Self::auth_header(session)),
            RelayHttpRetry::IdempotentWrite,
        )
        .await?;
        if !resp.status().is_success() {
            // Non-fatal — best-effort revocation
            log::warn!("revoke_token: relay returned {}", resp.status());
        }
        Ok(())
    }

    /// List all devices in the account (online + offline). Returns
    /// `(device_id, device_name, online, last_seen_at)`.
    pub async fn list_devices(
        &self,
        relay_url: &str,
        session: &AccountSession,
    ) -> Result<Vec<DeviceInfo>> {
        let resp = send_with_retry(
            "list devices",
            self.http
                .get(Self::endpoint(relay_url, "/api/devices")?)
                .header("Authorization", Self::auth_header(session)),
            RelayHttpRetry::SafeRead,
        )
        .await?;
        if !resp.status().is_success() {
            return Err(Self::into_buffered_error(resp));
        }
        let entries: Vec<DeviceListEntry> = resp.json().await?;
        Ok(entries
            .into_iter()
            .map(|e| DeviceInfo {
                device_id: e.device_id,
                device_name: e.device_name,
                // Legacy relays omit `online` and only return currently-online
                // devices; treat a missing field as online.
                online: e.online.unwrap_or(true),
                last_seen_at: e.last_seen_at,
            })
            .collect())
    }

    /// Remove a device from the account (DELETE /api/devices/:id).
    pub async fn delete_device(
        &self,
        relay_url: &str,
        session: &AccountSession,
        target_device_id: &str,
    ) -> Result<()> {
        let resp = self
            .http
            .delete(Self::endpoint(
                relay_url,
                &format!("/api/devices/{}", urlencoding::encode(target_device_id)),
            )?)
            .header("Authorization", Self::auth_header(session))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Self::into_error(resp).await);
        }
        Ok(())
    }

    /// Send an encrypted RemoteCommand over the shared account connection.
    /// The relay routes opaque ciphertext and returns the encrypted acknowledgement.
    /// Pairwise device keys protect both directions; the shared account
    /// Socket.IO connection owns acknowledgement and reconnect lifetimes.
    pub async fn device_rpc(
        &self,
        relay_url: &str,
        session: &AccountSession,
        target_device_id: &str,
        plaintext_command: &str,
    ) -> Result<String> {
        // Encrypt for the authenticated target device
        let (data, nonce) = session
            .encrypt_for_peer(relay_url, target_device_id, plaintext_command)
            .await?;
        let cell = {
            let mut transports = session.transports.lock().await;
            transports.entry(relay_url.to_string()).or_default().clone()
        };
        let transport = cell
            .get_or_try_init(|| async {
                let (transport, mut events) = super::relay_client::RelayClient::new_controller();
                transport.connect(relay_url).await?;
                transport
                    .connect_authenticated(&session.token, "Controller")
                    .await?;
                let hints = session.hints.clone();
                let peer_keys = session.peer_keys.clone();
                let event_session = session.clone();
                let event_relay = relay_url.to_string();
                tokio::spawn(async move {
                    while let Some(event) = events.recv().await {
                        use super::relay_client::RelayEvent;
                        match event {
                            RelayEvent::DeviceMessageReceived {
                                source_device_id,
                                correlation_id,
                                encrypted_data,
                                nonce,
                            } if correlation_id.is_empty() => {
                                // Stream hints arrive as encrypted DeviceEvents on
                                // the controller transport; RPC requests to this
                                // device are answered by its routing owner instead.
                                let Ok(plaintext) = event_session
                                    .decrypt_from_peer(
                                        &event_relay,
                                        &source_device_id,
                                        &encrypted_data,
                                        &nonce,
                                    )
                                    .await
                                else {
                                    continue;
                                };
                                let Ok(value) =
                                    serde_json::from_str::<serde_json::Value>(&plaintext)
                                else {
                                    continue;
                                };
                                if value["cmd"] == "device_event" {
                                    if let Some(event) = value["event"].as_str() {
                                        event_session.deliver_device_event(
                                            &source_device_id,
                                            event,
                                            &value["payload"],
                                        );
                                    }
                                }
                            }
                            RelayEvent::Connected
                            | RelayEvent::Reconnected
                            | RelayEvent::AuthOk { .. } => {
                                peer_keys.lock().await.clear();
                                let _ = hints.send(None);
                            }
                            RelayEvent::DevicePresence { .. } => {
                                peer_keys.lock().await.clear();
                            }
                            _ => {}
                        }
                    }
                });
                Ok::<_, anyhow::Error>(Arc::new(transport))
            })
            .await?;
        let (encrypted_data, nonce) = transport
            .request_device(target_device_id, &data, &nonce)
            .await?;
        // Decrypt using the authenticated target device key
        session
            .decrypt_from_peer(relay_url, target_device_id, &encrypted_data, &nonce)
            .await
    }
}

/// A device in the account (online or offline).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub last_seen_at: Option<i64>,
}

#[derive(Deserialize)]
struct DeviceListEntry {
    device_id: String,
    device_name: String,
    /// Absent on legacy relays that only listed in-memory online devices.
    /// `None` means "legacy online list" → treat as online.
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    last_seen_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_peer_lookup_does_not_block_another_device_or_invalidation() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::time::{timeout, Duration};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut slow, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            slow.read(&mut request).await.unwrap();
            started_tx.send(()).unwrap();
            let (mut fast, _) = listener.accept().await.unwrap();
            fast.read(&mut request).await.unwrap();
            let reply = |device: &str| {
                let body = serde_json::json!({
                    "device_id": device,
                    "public_key": super::super::encryption::KeyPair::generate().public_key_base64()
                })
                .to_string();
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)
            };
            fast.write_all(reply("fast").as_bytes()).await.unwrap();
            release_rx.await.unwrap();
            slow.write_all(reply("slow").as_bytes()).await.unwrap();
        });
        let session = AccountSession::new("fixture".into(), "fixture".into(), [7; 32]);
        let slow_session = session.clone();
        let slow_url = url.clone();
        let slow =
            tokio::spawn(async move { slow_session.peer_message_key(&slow_url, "slow").await });
        timeout(Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        timeout(
            Duration::from_secs(5),
            session.peer_message_key(&url, "fast"),
        )
        .await
        .unwrap()
        .unwrap();
        timeout(Duration::from_secs(5), session.clear_peer_keys())
            .await
            .unwrap();
        release_tx.send(()).unwrap();
        slow.await.unwrap().unwrap();
        server.await.unwrap();
        assert!(
            session.peer_keys.lock().await.is_empty(),
            "invalidation must survive an older lookup completing"
        );
    }

    #[test]
    fn relay_endpoint_accepts_http_servers_and_rejects_ambiguous_urls() {
        let endpoint =
            AccountClient::endpoint("https://relay.example.com/prefix/", "/api/devices").unwrap();
        assert_eq!(
            endpoint.as_str(),
            "https://relay.example.com/prefix/api/devices"
        );

        for invalid in [
            "file:///tmp/relay",
            "https://user:pass@relay.example.com",
            "https://relay.example.com?target=other",
            "https://relay.example.com/#fragment",
        ] {
            assert!(AccountClient::endpoint(invalid, "/api/devices").is_err());
        }
    }

    #[test]
    fn retired_official_endpoint_does_not_capture_custom_relays() {
        let current = openbitfun_product_domains::account::DEFAULT_RELAY_URL;
        assert_eq!(current, "https://remote.openbitfun.com/v/1.0.2");
        for old in [
            ["https://remote.openbitfun.com", "/v/1.0.0"].concat(),
            ["https://remote.openbitfun.com", "/v/1.0.1"].concat(),
        ] {
            assert!(is_retired_official_relay(&old), "{old}");
            assert!(is_retired_official_relay(&format!("{old}/")), "{old}/");
            assert!(!is_retired_official_relay(&format!("{old}?other=1")));
            assert!(!is_retired_official_relay(&format!("{old}#pair")));
        }
        for endpoint in [
            current,
            &format!("{current}/"),
            "https://custom.example/v/1.0.0",
            "http://127.0.0.1:9700",
            "https://remote.openbitfun.com/relay",
            "https://remote.openbitfun.com/v/",
            "https://remote.openbitfun.com/v/1.0.0/p/alice/demo",
            "https://user@remote.openbitfun.com/v/1.0.0",
            "https://remote.openbitfun.com:444/v/1.0.0",
            "http://remote.openbitfun.com/v/1.0.1",
        ] {
            assert!(!is_retired_official_relay(endpoint), "{endpoint}");
        }
    }
}
