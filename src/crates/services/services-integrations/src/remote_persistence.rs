//! Path-explicit persistence owners shared by Remote Connect, Remote SSH, and
//! the offline retired-product migrator.
//!
//! Runtime loaders may intentionally recover from missing or corrupt files by
//! returning defaults. Importers must not do that: every reader in this module
//! is strict, bounded by its caller, and never logs persisted content.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const NONCE_SIZE: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceIdentityRecord {
    pub device_id: String,
    pub device_name: String,
    pub mac_address: String,
}

impl DeviceIdentityRecord {
    pub fn validate(&self) -> Result<()> {
        if self.device_id.len() != 32
            || !self
                .device_id
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            bail!("device identity has an invalid stable id");
        }
        if self.device_name.trim().is_empty() || self.mac_address.trim().is_empty() {
            bail!("device identity is missing display metadata");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountHintRecord {
    pub username: String,
    pub relay_url: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AccountSessionRecord {
    pub token: String,
    pub user_id: String,
    pub master_key: [u8; 32],
    pub relay_url: String,
    pub device_id: Option<String>,
}

impl std::fmt::Debug for AccountSessionRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountSessionRecord")
            .field("token", &"[REDACTED]")
            .field("user_id", &self.user_id)
            .field("master_key", &"[REDACTED]")
            .field("relay_url", &self.relay_url)
            .field("device_id", &self.device_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineBinding {
    pub hostname: String,
    pub username: String,
    pub os: String,
}

impl MachineBinding {
    pub fn current() -> Self {
        let hostname = hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .unwrap_or_default();
        let username = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default();
        Self {
            hostname,
            username,
            os: std::env::consts::OS.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegacyAccountSessionKeyDomains<'a> {
    pub v1: &'a [u8],
    pub v2: &'a [u8],
}

#[derive(Serialize, Deserialize)]
struct AccountSessionPayload {
    token: String,
    user_id: String,
    master_key_b64: String,
    relay_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

pub fn read_device_identity(path: &Path) -> Result<Option<DeviceIdentityRecord>> {
    let value: Option<DeviceIdentityRecord> = read_optional_json(path)?;
    if let Some(value) = &value {
        value.validate()?;
    }
    Ok(value)
}

pub fn write_device_identity(path: &Path, value: &DeviceIdentityRecord) -> Result<()> {
    value.validate()?;
    write_json_atomic(path, value, false)
}

pub fn read_account_hint(path: &Path) -> Result<Option<AccountHintRecord>> {
    read_optional_json(path)
}

pub fn write_account_hint(path: &Path, value: &AccountHintRecord) -> Result<()> {
    write_json_atomic(path, value, true)
}

pub fn read_legacy_account_session(
    directory: &Path,
    binding: &MachineBinding,
    domains: LegacyAccountSessionKeyDomains<'_>,
) -> Result<Option<AccountSessionRecord>> {
    if domains.v1.is_empty() || domains.v2.is_empty() {
        bail!("legacy account session key domains must not be empty");
    }
    let encrypted_path = directory.join("account_session.enc");
    let Some(packed) = read_encrypted_blob(&encrypted_path)? else {
        return Ok(None);
    };
    let local_secret = match std::fs::read(directory.join("account_session.key")) {
        Ok(bytes) => Some(
            bytes
                .try_into()
                .map_err(|_| anyhow!("legacy account session key has an invalid length"))?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("read legacy account session key"),
    };
    let (nonce, ciphertext) = split_ciphertext(&packed)?;
    let mut plaintext = None;
    if let Some(secret) = local_secret {
        let key = derive_legacy_v2_key(binding, &secret, domains);
        plaintext = decrypt(&key, nonce, ciphertext).ok();
    }
    if plaintext.is_none() {
        let key = derive_legacy_v1_key(binding, domains.v1);
        plaintext = decrypt(&key, nonce, ciphertext).ok();
    }
    let plaintext =
        plaintext.ok_or_else(|| anyhow!("legacy account session cannot be decrypted"))?;
    decode_account_session_payload(&plaintext)
        .context("validate legacy account session")
        .map(Some)
}

pub fn read_current_account_session(
    directory: &Path,
    binding: &MachineBinding,
) -> Result<Option<AccountSessionRecord>> {
    let Some(packed) = read_encrypted_blob(&directory.join("account_session.enc"))? else {
        return Ok(None);
    };
    let secret: [u8; 32] = std::fs::read(directory.join("account_session.key"))
        .context("read current account session key")?
        .try_into()
        .map_err(|_| anyhow!("current account session key has an invalid length"))?;
    let (nonce, ciphertext) = split_ciphertext(&packed)?;
    let key = derive_current_key(binding, &secret);
    let plaintext = decrypt(&key, nonce, ciphertext)
        .map_err(|_| anyhow!("current account session cannot be decrypted"))?;
    decode_account_session_payload(&plaintext)
        .context("validate current account session")
        .map(Some)
}

pub fn write_current_account_session(
    directory: &Path,
    binding: &MachineBinding,
    session: &AccountSessionRecord,
) -> Result<()> {
    validate_account_session(session)?;
    std::fs::create_dir_all(directory).context("create account session directory")?;
    let key_path = directory.join("account_session.key");
    let secret = match std::fs::read(&key_path) {
        Ok(bytes) => bytes
            .try_into()
            .map_err(|_| anyhow!("current account session key has an invalid length"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut value = [0u8; 32];
            OsRng.fill_bytes(&mut value);
            write_atomic(&key_path, &value, true)?;
            value
        }
        Err(error) => return Err(error).context("read current account session key"),
    };
    let payload = AccountSessionPayload {
        token: session.token.clone(),
        user_id: session.user_id.clone(),
        master_key_b64: BASE64.encode(session.master_key),
        relay_url: session.relay_url.clone(),
        device_id: session.device_id.clone(),
    };
    let plaintext = serde_json::to_vec(&payload).context("serialize account session payload")?;
    let key = derive_current_key(binding, &secret);
    let mut nonce = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow!("initialize current account session cipher"))?
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
        .map_err(|_| anyhow!("encrypt current account session"))?;
    let mut packed = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ciphertext);
    write_atomic(
        &directory.join("account_session.enc"),
        BASE64.encode(packed).as_bytes(),
        true,
    )
}

fn validate_account_session(session: &AccountSessionRecord) -> Result<()> {
    if session.token.trim().is_empty()
        || session.user_id.trim().is_empty()
        || session.relay_url.trim().is_empty()
    {
        bail!("account session is missing required identity fields");
    }
    if session.device_id.as_deref().is_some_and(|device_id| {
        device_id.len() != 32 || !device_id.chars().all(|value| value.is_ascii_hexdigit())
    }) {
        bail!("account session has an invalid device id");
    }
    Ok(())
}

fn decode_account_session_payload(bytes: &[u8]) -> Result<AccountSessionRecord> {
    let payload: AccountSessionPayload =
        serde_json::from_slice(bytes).context("deserialize account session payload")?;
    let master_key: [u8; 32] = BASE64
        .decode(payload.master_key_b64)
        .context("decode account session master key")?
        .try_into()
        .map_err(|_| anyhow!("account session master key has an invalid length"))?;
    let session = AccountSessionRecord {
        token: payload.token,
        user_id: payload.user_id,
        master_key,
        relay_url: payload.relay_url,
        device_id: payload.device_id,
    };
    validate_account_session(&session)?;
    Ok(session)
}

fn derive_legacy_v1_key(binding: &MachineBinding, domain: &[u8]) -> [u8; 32] {
    derive_machine_domain_key(binding, domain, None)
}

fn derive_legacy_v2_key(
    binding: &MachineBinding,
    local_secret: &[u8; 32],
    domains: LegacyAccountSessionKeyDomains<'_>,
) -> [u8; 32] {
    let legacy = derive_legacy_v1_key(binding, domains.v1);
    let mut hasher = Sha256::new();
    hasher.update(legacy);
    hasher.update(domains.v2);
    hasher.update(local_secret);
    hasher.finalize().into()
}

fn derive_current_key(binding: &MachineBinding, local_secret: &[u8; 32]) -> [u8; 32] {
    let product_id = openbitfun_services_core::product_identity::product_id();
    derive_machine_domain_key(
        binding,
        format!("{product_id}::session_store::v1|").as_bytes(),
        Some(local_secret),
    )
}

fn derive_machine_domain_key(
    binding: &MachineBinding,
    domain: &[u8],
    local_secret: Option<&[u8; 32]>,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(binding.hostname.as_bytes());
    hasher.update(b"|");
    hasher.update(binding.username.as_bytes());
    hasher.update(b"|");
    hasher.update(binding.os.as_bytes());
    hasher.update(b"|");
    hasher.update(domain);
    if let Some(secret) = local_secret {
        hasher.update(secret);
    }
    hasher.finalize().into()
}

fn read_encrypted_blob(path: &Path) -> Result<Option<Vec<u8>>> {
    let encoded = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("read encrypted persistence file"),
    };
    BASE64
        .decode(encoded.trim())
        .context("decode encrypted persistence file")
        .map(Some)
}

fn split_ciphertext(packed: &[u8]) -> Result<(&[u8], &[u8])> {
    if packed.len() <= NONCE_SIZE {
        bail!("encrypted persistence file is too short");
    }
    Ok(packed.split_at(NONCE_SIZE))
}

fn decrypt(key: &[u8; 32], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow!("initialize encrypted persistence cipher"))?
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow!("decrypt encrypted persistence payload"))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "bot_type", rename_all = "snake_case")]
pub enum BotConfigRecord {
    Feishu {
        app_id: String,
        app_secret: String,
    },
    Telegram {
        bot_token: String,
    },
    Weixin {
        ilink_token: String,
        base_url: String,
        bot_account_id: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BotDisplayModeRecord {
    #[serde(rename = "pro")]
    Pro,
    #[default]
    #[serde(rename = "assistant")]
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotWorkspaceRefRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

fn deserialize_workspace_ref<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<BotWorkspaceRefRecord>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Path(String),
        Full(BotWorkspaceRefRecord),
    }
    match Option::<Raw>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Raw::Path(path)) if path.trim().is_empty() => Ok(None),
        Some(Raw::Path(path)) => Ok(Some(BotWorkspaceRefRecord {
            workspace_id: None,
            path,
            remote_connection_id: None,
            remote_ssh_host: None,
        })),
        Some(Raw::Full(value)) if value.path.trim().is_empty() => Ok(None),
        Some(Raw::Full(value)) => Ok(Some(value)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotChatStateRecord {
    pub chat_id: String,
    pub paired: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_workspace_ref",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_workspace: Option<BotWorkspaceRefRecord>,
    /// Legacy path retained for old readers; selection uses current_assistant_id.
    pub current_assistant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_assistant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_assistant_name: Option<String>,
    pub current_session_id: Option<String>,
    #[serde(default)]
    pub display_mode: BotDisplayModeRecord,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub account_remote_context: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedBotConnectionRecord {
    #[serde(default)]
    pub account_user_id: String,
    pub bot_type: String,
    pub chat_id: String,
    pub config: BotConfigRecord,
    pub chat_state: BotChatStateRecord,
    pub connected_at: i64,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteConnectFormStateRecord {
    pub telegram_bot_token: String,
    pub feishu_app_id: String,
    pub feishu_app_secret: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_ilink_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_bot_account_id: String,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotPersistenceRecord {
    #[serde(default)]
    pub connections: Vec<SavedBotConnectionRecord>,
    #[serde(default)]
    pub form_state: RemoteConnectFormStateRecord,
    #[serde(default)]
    pub verbose_mode: bool,
}

impl std::fmt::Debug for BotPersistenceRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BotPersistenceRecord")
            .field("connection_count", &self.connections.len())
            .field("verbose_mode", &self.verbose_mode)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl BotPersistenceRecord {
    pub fn validate(&self) -> Result<()> {
        let mut types = std::collections::BTreeSet::new();
        for connection in &self.connections {
            if connection.bot_type.trim().is_empty()
                || connection.chat_id != connection.chat_state.chat_id
                || !types.insert(connection.bot_type.as_str())
            {
                bail!("bot persistence contains an invalid or duplicate connection");
            }
            let config_type = match connection.config {
                BotConfigRecord::Feishu { .. } => "feishu",
                BotConfigRecord::Telegram { .. } => "telegram",
                BotConfigRecord::Weixin { .. } => "weixin",
            };
            if connection.bot_type != config_type {
                bail!("bot persistence connection type does not match its configuration");
            }
        }
        Ok(())
    }
}

pub fn read_bot_persistence(path: &Path) -> Result<Option<BotPersistenceRecord>> {
    let value: Option<BotPersistenceRecord> = read_optional_json(path)?;
    if let Some(value) = &value {
        value.validate()?;
    }
    Ok(value)
}

pub fn write_bot_persistence(path: &Path, value: &BotPersistenceRecord) -> Result<()> {
    value.validate()?;
    write_json_atomic(path, value, true)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContainerAccessRecord {
    Sshd,
    DockerExec,
    Auto,
}

fn default_docker_path() -> String {
    "docker".to_string()
}
fn default_container_shell() -> String {
    "/bin/sh".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerWorkspaceRecord {
    pub name: String,
    pub access: ContainerAccessRecord,
    #[serde(default)]
    pub local: bool,
    #[serde(default = "default_docker_path")]
    pub docker_path: String,
    #[serde(default = "default_container_shell")]
    pub shell: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default = "default_true")]
    pub interactive: bool,
}

fn default_connect_timeout_secs() -> u64 {
    30
}
fn default_auth_timeout_secs() -> u64 {
    60
}
fn default_auth_attempts() -> u8 {
    3
}
fn default_connect_attempts() -> u8 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionOptionsRecord {
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_auth_timeout_secs")]
    pub auth_timeout_secs: u64,
    #[serde(default = "default_auth_attempts")]
    pub auth_attempts: u8,
    #[serde(default = "default_connect_attempts")]
    pub connect_attempts: u8,
}

impl Default for SshConnectionOptionsRecord {
    fn default() -> Self {
        Self {
            connect_timeout_secs: default_connect_timeout_secs(),
            auth_timeout_secs: default_auth_timeout_secs(),
            auth_attempts: default_auth_attempts(),
            connect_attempts: default_connect_attempts(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SavedAuthTypeRecord {
    Password,
    PrivateKey {
        #[serde(rename = "keyPath")]
        key_path: String,
        #[serde(default, rename = "certificatePath")]
        certificate_path: Option<String>,
    },
    Agent {
        #[serde(default, rename = "keyFingerprint")]
        key_fingerprint: Option<String>,
        #[serde(default, rename = "fallbackKeyPath")]
        fallback_key_path: Option<String>,
    },
    KeyboardInteractive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnectionRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: SavedAuthTypeRecord,
    #[serde(rename = "defaultWorkspace")]
    pub default_workspace: Option<String>,
    #[serde(rename = "lastConnected")]
    pub last_connected: Option<u64>,
    #[serde(default)]
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub container: Option<ContainerWorkspaceRecord>,
    #[serde(default)]
    pub options: SshConnectionOptionsRecord,
}

impl SavedConnectionRecord {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            bail!("saved SSH connection is missing its identity");
        }
        if self
            .container
            .as_ref()
            .is_none_or(|container| !container.local)
            && (self.host.trim().is_empty() || self.username.trim().is_empty() || self.port == 0)
        {
            bail!("saved SSH connection is missing host information");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceRecord {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub remote_path: String,
    #[serde(default)]
    pub connection_name: String,
    #[serde(default)]
    pub ssh_host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownHostRecord {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

pub fn read_saved_connections(path: &Path) -> Result<Option<Vec<SavedConnectionRecord>>> {
    let values: Option<Vec<SavedConnectionRecord>> = read_optional_json(path)?;
    if let Some(values) = &values {
        for value in values {
            value.validate()?;
        }
    }
    Ok(values)
}

pub fn write_saved_connections(path: &Path, values: &[SavedConnectionRecord]) -> Result<()> {
    for value in values {
        value.validate()?;
    }
    write_json_atomic(path, values, false)
}

pub fn read_current_remote_workspaces(path: &Path) -> Result<Option<Vec<RemoteWorkspaceRecord>>> {
    let values: Option<Vec<RemoteWorkspaceRecord>> = read_optional_json(path)?;
    if let Some(values) = &values {
        validate_remote_workspaces(values)?;
    }
    Ok(values)
}

pub fn read_legacy_remote_workspaces(path: &Path) -> Result<Option<Vec<RemoteWorkspaceRecord>>> {
    let value: Option<serde_json::Value> = read_optional_json(path)?;
    let values = value
        .map(|value| match value {
            serde_json::Value::Array(_) => {
                serde_json::from_value(value).context("parse legacy remote workspace array")
            }
            serde_json::Value::Object(_) => serde_json::from_value(value)
                .map(|value| vec![value])
                .context("parse legacy remote workspace object"),
            _ => bail!("legacy remote workspace must be a JSON object or array"),
        })
        .transpose()?;
    if let Some(values) = &values {
        validate_remote_workspaces(values)?;
    }
    Ok(values)
}

pub fn write_remote_workspaces(path: &Path, values: &[RemoteWorkspaceRecord]) -> Result<()> {
    validate_remote_workspaces(values)?;
    write_json_atomic(path, values, false)
}

fn validate_remote_workspaces(values: &[RemoteWorkspaceRecord]) -> Result<()> {
    for value in values {
        if value.connection_id.trim().is_empty() || value.remote_path.trim().is_empty() {
            bail!("remote workspace is missing its connection or POSIX path");
        }
        if !value.remote_path.starts_with('/') {
            bail!("remote workspace path is not an absolute POSIX path");
        }
    }
    Ok(())
}

pub fn read_known_hosts(path: &Path) -> Result<Option<Vec<KnownHostRecord>>> {
    let values: Option<Vec<KnownHostRecord>> = read_optional_json(path)?;
    if let Some(values) = &values {
        for value in values {
            if value.host.trim().is_empty()
                || value.port == 0
                || value.key_type.trim().is_empty()
                || value.fingerprint.trim().is_empty()
                || value.public_key.trim().is_empty()
            {
                bail!("known-host entry is incomplete");
            }
        }
    }
    Ok(values)
}

pub fn write_known_hosts(path: &Path, values: &[KnownHostRecord]) -> Result<()> {
    let serialized = serde_json::to_vec_pretty(values).context("serialize known hosts")?;
    let _: Vec<KnownHostRecord> =
        serde_json::from_slice(&serialized).context("validate known hosts")?;
    write_atomic(path, &serialized, false)
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SshVaultFile {
    pub entries: BTreeMap<String, String>,
}

impl std::fmt::Debug for SshVaultFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshVaultFile")
            .field("entry_count", &self.entries.len())
            .finish()
    }
}

#[derive(Clone)]
pub struct SshVaultRecord {
    pub key: [u8; 32],
    pub file: SshVaultFile,
}

impl std::fmt::Debug for SshVaultRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshVaultRecord")
            .field("key", &"[REDACTED]")
            .field("file", &self.file)
            .finish()
    }
}

impl SshVaultRecord {
    pub fn decrypt(&self, connection_id: &str) -> Result<Option<String>> {
        self.file
            .entries
            .get(connection_id)
            .map(|ciphertext| decrypt_vault_entry(&self.key, ciphertext))
            .transpose()
    }

    pub fn store(&mut self, connection_id: String, plaintext: &str) -> Result<()> {
        let ciphertext = encrypt_vault_entry(&self.key, plaintext)?;
        self.file.entries.insert(connection_id, ciphertext);
        Ok(())
    }

    pub fn remove(&mut self, connection_id: &str) {
        self.file.entries.remove(connection_id);
    }
}

pub fn read_ssh_vault(directory: &Path) -> Result<Option<SshVaultRecord>> {
    let key_path = directory.join(".ssh_password_vault.key");
    let vault_path = directory.join("ssh_password_vault.json");
    let key_exists = key_path.exists();
    let vault_exists = vault_path.exists();
    if !key_exists && !vault_exists {
        return Ok(None);
    }
    if key_exists != vault_exists {
        bail!("SSH password vault key and ciphertext file must migrate as a pair");
    }
    let key: [u8; 32] = std::fs::read(&key_path)
        .context("read SSH password vault key")?
        .try_into()
        .map_err(|_| anyhow!("SSH password vault key has an invalid length"))?;
    let file: SshVaultFile = read_required_json(&vault_path)?;
    let record = SshVaultRecord { key, file };
    if let Some(connection_id) = record.file.entries.keys().next() {
        let _ = record
            .decrypt(connection_id)
            .context("validate SSH password vault entry")?;
    }
    Ok(Some(record))
}

pub fn new_ssh_vault() -> SshVaultRecord {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    SshVaultRecord {
        key,
        file: SshVaultFile::default(),
    }
}

pub fn write_ssh_vault(directory: &Path, value: &SshVaultRecord) -> Result<()> {
    std::fs::create_dir_all(directory).context("create SSH persistence directory")?;
    for connection_id in value.file.entries.keys() {
        let _ = value
            .decrypt(connection_id)
            .context("validate SSH password vault before writing")?;
    }
    write_atomic(&directory.join(".ssh_password_vault.key"), &value.key, true)?;
    write_json_atomic(
        &directory.join("ssh_password_vault.json"),
        &value.file,
        true,
    )
}

fn encrypt_vault_entry(key: &[u8; 32], plaintext: &str) -> Result<String> {
    let mut nonce = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow!("initialize SSH password vault cipher"))?
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|_| anyhow!("encrypt SSH password vault entry"))?;
    let mut packed = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(packed))
}

fn decrypt_vault_entry(key: &[u8; 32], ciphertext: &str) -> Result<String> {
    let packed = BASE64
        .decode(ciphertext)
        .context("decode SSH password vault entry")?;
    let (nonce, ciphertext) = split_ciphertext(&packed)?;
    let plaintext =
        decrypt(key, nonce, ciphertext).map_err(|_| anyhow!("decrypt SSH password vault entry"))?;
    String::from_utf8(plaintext).context("decode SSH password vault entry")
}

pub fn read_context_tokens(path: &Path) -> Result<Option<BTreeMap<String, String>>> {
    let value: Option<BTreeMap<String, String>> = read_optional_json(path)?;
    if value.as_ref().is_some_and(|tokens| {
        tokens
            .iter()
            .any(|(peer, token)| peer.trim().is_empty() || token.trim().is_empty())
    }) {
        bail!("Weixin context-token store contains an empty peer or token");
    }
    Ok(value)
}

pub fn write_context_tokens(path: &Path, value: &BTreeMap<String, String>) -> Result<()> {
    write_json_atomic(path, value, true)
}

pub fn read_weixin_sync_buffer(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value.trim().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("read Weixin sync buffer"),
    }
}

pub fn write_weixin_sync_buffer(path: &Path, value: &str) -> Result<()> {
    write_atomic(path, value.as_bytes(), true)
}

/// Stable per-account, per-relay device key. Candidate logins must not rotate a
/// public key still used by the active session. A process lock serializes first
/// creation across Desktop and CLI, and malformed keys remain untouched.
pub fn load_or_create_device_secret(
    directory: &Path,
    relay_url: &str,
    user_id: &str,
    device_id: &str,
) -> Result<[u8; 32]> {
    let mut scope = Sha256::new();
    for part in [relay_url.trim_end_matches('/'), user_id, device_id] {
        scope.update((part.len() as u64).to_le_bytes());
        scope.update(part.as_bytes());
    }
    let name = format!("{:x}", scope.finalize());
    let keys = directory.join("device-keys");
    std::fs::create_dir_all(&keys).context("create device key directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(keys.join(format!("{name}.lock")))?;
    fs2::FileExt::lock_exclusive(&lock).context("lock device key")?;
    let path = keys.join(format!("{name}.key"));
    match std::fs::read(&path) {
        Ok(bytes) => bytes
            .try_into()
            .map_err(|_| anyhow!("stored device key has an invalid length")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Preserve the key of an already authenticated install on first migration.
            let previous = read_current_account_session(directory, &MachineBinding::current())?;
            let secret = previous
                .filter(|session| {
                    session.user_id == user_id
                        && session.relay_url.trim_end_matches('/')
                            == relay_url.trim_end_matches('/')
                        && session.device_id.as_deref() == Some(device_id)
                })
                .map(|session| session.master_key)
                .unwrap_or_else(|| {
                    let mut secret = [0; 32];
                    OsRng.fill_bytes(&mut secret);
                    secret
                });
            write_private_bytes(&path, &secret)?;
            Ok(secret)
        }
        Err(error) => Err(error).context("read device key"),
    }
}

pub fn write_private_bytes(path: &Path, value: &[u8]) -> Result<()> {
    write_atomic(path, value, true)
}

fn read_optional_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("parse persisted JSON at {}", path.display()))
            .map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("read persisted JSON at {}", path.display()))
        }
    }
}

fn read_required_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    read_optional_json(path)?.ok_or_else(|| anyhow!("required persisted JSON is missing"))
}

fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T, private: bool) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("serialize persisted JSON")?;
    write_atomic(path, &bytes, private)
}

fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    #[cfg(not(unix))]
    let _ = private;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("persistence path has no parent directory"))?;
    std::fs::create_dir_all(parent).context("create persistence directory")?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .context("restrict persistence directory")?;
    }
    let mut nonce = [0u8; 8];
    OsRng.fill_bytes(&mut nonce);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("persistence path has an invalid file name"))?;
    let suffix = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = parent.join(format!(".{name}.{suffix}.tmp"));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .context("create persistence temporary file")?;
        file.write_all(bytes)
            .context("write persistence temporary file")?;
        file.sync_all()
            .context("flush persistence temporary file")?;
        drop(file);
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .context("restrict persisted file")?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    std::fs::rename(source, target).context("install persisted file")
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .context("install persisted file")
    }
}

pub fn safe_account_file_component(value: &str) -> Option<String> {
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

pub fn is_safe_weixin_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn legacy_v2_account_session_reencrypts_for_the_current_owner() {
        let source = test_tempdir("legacy-session-source");
        let target = test_tempdir("legacy-session-target");
        let binding = MachineBinding {
            hostname: "fixture-host".to_string(),
            username: "fixture-user".to_string(),
            os: "windows".to_string(),
        };
        let domains = LegacyAccountSessionKeyDomains {
            v1: b"retired-product::session_store::v1",
            v2: b"|retired-product::session_store::v2|",
        };
        let session = AccountSessionRecord {
            token: "synthetic-token".to_string(),
            user_id: "fixture-account".to_string(),
            master_key: [0x42; 32],
            relay_url: "https://relay.example.invalid".to_string(),
            device_id: Some("0123456789abcdef0123456789abcdef".to_string()),
        };
        let local_secret = [0x24; 32];
        std::fs::write(source.path().join("account_session.key"), local_secret).unwrap();
        write_legacy_session_fixture(source.path(), &binding, &session, &local_secret, domains);

        let decoded = read_legacy_account_session(source.path(), &binding, domains)
            .unwrap()
            .expect("legacy session");
        assert_eq!(decoded, session);
        write_current_account_session(target.path(), &binding, &decoded).unwrap();
        assert_eq!(
            read_current_account_session(target.path(), &binding).unwrap(),
            Some(session)
        );
        let ciphertext =
            std::fs::read_to_string(target.path().join("account_session.enc")).unwrap();
        assert!(!ciphertext.contains("synthetic-token"));
    }

    #[test]
    fn bot_owner_upgrades_bare_workspace_and_redacts_debug_output() {
        let root = test_tempdir("bot-persistence");
        let path = root.path().join("remote_connect_persistence.json");
        std::fs::write(
            &path,
            r#"{
                "connections":[{
                    "bot_type":"telegram",
                    "chat_id":"chat-1",
                    "config":{"bot_type":"telegram","bot_token":"secret-token"},
                    "chat_state":{
                        "chat_id":"chat-1",
                        "paired":true,
                        "current_workspace":"/srv/project",
                        "current_assistant":null,
                        "current_session_id":"session-1",
                        "account_remote_context":true
                    },
                    "connected_at":1
                }]
            }"#,
        )
        .unwrap();
        let data = read_bot_persistence(&path).unwrap().expect("bot data");
        assert_eq!(
            data.connections[0]
                .chat_state
                .current_workspace
                .as_ref()
                .map(|workspace| workspace.path.as_str()),
            Some("/srv/project")
        );
        assert!(data.connections[0].chat_state.account_remote_context);
        let debug = format!("{data:?}");
        assert!(!debug.contains("secret-token"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn ssh_owner_accepts_legacy_workspace_and_validates_vault_entries() {
        let root = test_tempdir("ssh-persistence");
        let workspace_path = root.path().join("remote_workspace.json");
        std::fs::write(
            &workspace_path,
            r#"{"connectionId":"ssh-user@example.invalid:22","remotePath":"/srv/project"}"#,
        )
        .unwrap();
        let legacy = read_legacy_remote_workspaces(&workspace_path)
            .unwrap()
            .expect("legacy workspace");
        assert_eq!(legacy.len(), 1);
        assert!(read_current_remote_workspaces(&workspace_path).is_err());
        write_remote_workspaces(&workspace_path, &legacy).unwrap();
        assert_eq!(
            read_current_remote_workspaces(&workspace_path)
                .unwrap()
                .expect("current workspaces"),
            legacy
        );

        let mut vault = new_ssh_vault();
        vault
            .store(
                "ssh-user@example.invalid:22".to_string(),
                "fixture-password",
            )
            .unwrap();
        write_ssh_vault(root.path(), &vault).unwrap();
        let loaded = read_ssh_vault(root.path()).unwrap().expect("vault");
        assert_eq!(
            loaded
                .decrypt("ssh-user@example.invalid:22")
                .unwrap()
                .as_deref(),
            Some("fixture-password")
        );
        assert!(!format!("{loaded:?}").contains("fixture-password"));
    }

    #[test]
    fn ssh_owner_treats_an_empty_legacy_workspace_array_as_no_workspaces() {
        let root = test_tempdir("ssh-empty-workspaces");
        let workspace_path = root.path().join("remote_workspace.json");
        std::fs::write(&workspace_path, "[]").unwrap();

        assert_eq!(
            read_legacy_remote_workspaces(&workspace_path).unwrap(),
            Some(Vec::new())
        );

        std::fs::write(&workspace_path, "{}").unwrap();
        assert!(read_legacy_remote_workspaces(&workspace_path).is_err());
    }

    fn write_legacy_session_fixture(
        directory: &Path,
        binding: &MachineBinding,
        session: &AccountSessionRecord,
        local_secret: &[u8; 32],
        domains: LegacyAccountSessionKeyDomains<'_>,
    ) {
        let payload = AccountSessionPayload {
            token: session.token.clone(),
            user_id: session.user_id.clone(),
            master_key_b64: BASE64.encode(session.master_key),
            relay_url: session.relay_url.clone(),
            device_id: session.device_id.clone(),
        };
        let plaintext = serde_json::to_vec(&payload).unwrap();
        let key = derive_legacy_v2_key(binding, local_secret, domains);
        let nonce = [0x11; NONCE_SIZE];
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .unwrap();
        let mut packed = nonce.to_vec();
        packed.extend(ciphertext);
        std::fs::write(directory.join("account_session.enc"), BASE64.encode(packed)).unwrap();
    }

    fn test_tempdir(label: &str) -> tempfile::TempDir {
        let root = std::env::var_os("OPENBITFUN_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&root).expect("test temporary root");
        tempfile::Builder::new()
            .prefix(&format!("remote-persistence-{label}-"))
            .tempdir_in(root)
            .expect("test temporary directory")
    }
}

#[cfg(test)]
mod device_secret_tests {
    use super::*;

    #[test]
    fn device_keys_survive_relogin_and_are_scoped_to_account_and_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let key = load_or_create_device_secret(dir.path(), "http://127.0.0.1:9700", "1", "device")
            .unwrap();
        assert_eq!(
            key,
            load_or_create_device_secret(dir.path(), "http://127.0.0.1:9700/", "1", "device")
                .unwrap()
        );
        assert_ne!(
            key,
            load_or_create_device_secret(dir.path(), "http://127.0.0.1:9700", "2", "device")
                .unwrap()
        );
        assert_ne!(
            key,
            load_or_create_device_secret(
                dir.path(),
                "https://remote.openbitfun.com/v/1.0.1",
                "1",
                "device"
            )
            .unwrap()
        );
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let path = dir.path();
                scope.spawn(move || {
                    assert_eq!(
                        key,
                        load_or_create_device_secret(path, "http://127.0.0.1:9700", "1", "device")
                            .unwrap()
                    )
                });
            }
        });
    }
}
