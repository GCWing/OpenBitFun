//! Machine-bound persistent session store.
//!
//! Saves the device `AccountSession` (token + private key + user_id) and relay
//! URL to disk, encrypted with a key that combines machine identity and a
//! random per-install secret. Secret files are owner-only on Unix and replaced
//! through a private temporary file. This lets Desktop / CLI restart without
//! requiring a fresh GitHub sign-in while keeping copied session ciphertext
//! unusable without the separate install key.
//!
//! File location: `<OPENBITFUN_HOME>/relay-v1.0.0/account_session.enc` when configured,
//! otherwise `~/.openbitfun/relay-v1.0.0/account_session.enc`.
//! Format: base64(nonce || ciphertext) where the plaintext is a JSON
//! payload `{ token, user_id, master_key_b64, relay_url }`.

use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

fn session_store_directory_override() -> &'static RwLock<Option<PathBuf>> {
    static OVERRIDE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| RwLock::new(None))
}

/// Redirects session, local-key, and credential-hint files for integration
/// tests. Tests must use this instead of changing HOME or touching real login
/// state shared by Desktop and CLI.
pub fn set_session_store_directory_for_test(path: PathBuf) {
    let mut override_path = session_store_directory_override()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *override_path = Some(path);
}

fn session_store_directory() -> Result<PathBuf> {
    let override_path = session_store_directory_override()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(path) = override_path.as_ref() {
        return Ok(path.join("relay-v1.0.0"));
    }
    drop(override_path);
    super::product_home_dir()
        .map(|path| path.join("relay-v1.0.0"))
        .ok_or_else(|| anyhow!("cannot determine OpenBitFun home directory"))
}

/// Resolve the persistent session file path.
fn session_file_path() -> Result<PathBuf> {
    Ok(session_store_directory()?.join("account_session.enc"))
}

// ── Public API ──────────────────────────────────────────────────────────

pub fn device_secret(relay_url: &str, user_id: &str, device_id: &str) -> Result<[u8; 32]> {
    crate::remote_persistence::load_or_create_device_secret(
        &session_store_directory()?,
        relay_url,
        user_id,
        device_id,
    )
}

/// Persist the session (token, master_key, user_id, relay_url) to disk,
/// encrypted with the machine-bound key.
pub fn save_session(
    token: &str,
    user_id: &str,
    master_key: &[u8; 32],
    relay_url: &str,
) -> Result<()> {
    save_session_with_device(token, user_id, master_key, relay_url, None)
}

/// Persist the session including the account-bound `device_id`.
pub fn save_session_with_device(
    token: &str,
    user_id: &str,
    master_key: &[u8; 32],
    relay_url: &str,
    device_id: Option<&str>,
) -> Result<()> {
    let payload = crate::remote_persistence::AccountSessionRecord {
        token: token.to_string(),
        user_id: user_id.to_string(),
        master_key: *master_key,
        relay_url: relay_url.to_string(),
        device_id: device_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    };
    crate::remote_persistence::write_current_account_session(
        &session_store_directory()?,
        &crate::remote_persistence::MachineBinding::current(),
        &payload,
    )
}

/// Loaded account session fields from disk.
#[derive(Debug, Clone)]
pub struct LoadedSession {
    pub token: String,
    pub user_id: String,
    pub master_key: [u8; 32],
    pub relay_url: String,
    pub device_id: Option<String>,
}

/// Load and decrypt the session from disk.
/// Returns `Ok(None)` if the file doesn't exist (not an error).
pub fn load_session() -> Result<Option<(String, String, [u8; 32], String)>> {
    Ok(load_session_detailed()?.map(|s| (s.token, s.user_id, s.master_key, s.relay_url)))
}

/// Load and decrypt the session, including optional account-bound `device_id`.
pub fn load_session_detailed() -> Result<Option<LoadedSession>> {
    Ok(crate::remote_persistence::read_current_account_session(
        &session_store_directory()?,
        &crate::remote_persistence::MachineBinding::current(),
    )?
    .map(|payload| LoadedSession {
        token: payload.token,
        user_id: payload.user_id,
        master_key: payload.master_key,
        relay_url: payload.relay_url,
        device_id: payload.device_id,
    }))
}

/// Remove the persisted session file (called on logout).
pub fn clear_session() {
    if let Ok(path) = session_file_path() {
        let _ = std::fs::remove_file(&path);
    }
}

// ── Credential hint (non-secret: username + relay_url) ─────────────────
// Shared by Desktop and CLI so login forms pre-fill the same values.

fn credential_hint_path() -> Result<PathBuf> {
    Ok(session_store_directory()?.join("account_hint.json"))
}

/// Non-secret login pre-fill (never stores password or master key).
pub use crate::remote_persistence::AccountHintRecord as AccountHint;

/// Persist username + relay URL for the next login form.
pub fn save_credential_hint(username: &str, relay_url: &str) {
    let hint = AccountHint {
        username: username.to_string(),
        relay_url: relay_url.to_string(),
    };
    if let Ok(path) = credential_hint_path() {
        let _ = crate::remote_persistence::write_account_hint(&path, &hint);
    }
}

/// Load the persisted credential hint, if any.
pub fn load_credential_hint() -> Option<AccountHint> {
    crate::remote_persistence::read_account_hint(&credential_hint_path().ok()?)
        .ok()
        .flatten()
}

/// Clear the credential hint (called on logout).
pub fn clear_credential_hint() {
    if let Ok(path) = credential_hint_path() {
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_file_writer_uses_owner_only_permissions_and_replaces_atomically() {
        let root = tempfile::tempdir().unwrap();
        let private_dir = root.path().join("private");
        let path = private_dir.join("session.enc");

        crate::remote_persistence::write_private_bytes(&path, b"first").unwrap();
        crate::remote_persistence::write_private_bytes(&path, b"second").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(
            std::fs::metadata(&private_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(std::fs::read_dir(&private_dir)
            .unwrap()
            .all(|entry| entry.unwrap().path() == path));
    }
}
