//! SQLite-backed account storage for the relay server.
//!
//! The versioned relay stores verified GitHub identity and device public keys.
//! Device private keys never leave their owning clients.

use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Pool, QueryBuilder, Sqlite};
use std::str::FromStr;
use std::time::Duration;

pub type DbPool = Pool<Sqlite>;

pub const MAX_PAGE_KV_KEY_BYTES: usize = 256;
pub const MAX_PAGE_KV_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_PAGE_KV_ENTRIES: i64 = 1_024;
pub const MAX_USER_KV_ENTRIES: i64 = 10_000;
pub const MAX_PAGE_KV_BYTES: i64 = 5 * 1024 * 1024;
pub const MAX_USER_KV_BYTES: i64 = 25 * 1024 * 1024;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  user_id            TEXT PRIMARY KEY,
  username           TEXT UNIQUE NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_name  TEXT,
  device_kind  TEXT,
  public_key   TEXT,
  last_seen_at INTEGER,
  online       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  token_kind  TEXT NOT NULL DEFAULT 'device',
  request_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS delegated_device_keys (
  token TEXT PRIMARY KEY REFERENCES auth_tokens(token) ON DELETE CASCADE,
  controller_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS pages (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  slug        TEXT NOT NULL,
  generation  TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'private',
  title       TEXT NOT NULL DEFAULT '',
  file_count  INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  deployed_version_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id);
CREATE TABLE IF NOT EXISTS page_versions (
  user_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  source_upload_id TEXT,
  title       TEXT NOT NULL DEFAULT '',
  file_count  INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  has_worker  INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug, version_id),
  FOREIGN KEY (user_id, slug) REFERENCES pages(user_id, slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(user_id, slug);
CREATE TABLE IF NOT EXISTS page_kv (
  user_id    TEXT NOT NULL,
  slug       TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug, key)
);
CREATE TABLE IF NOT EXISTS page_blobs (
  user_id    TEXT NOT NULL,
  slug       TEXT NOT NULL,
  blob_id    TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug, blob_id)
);
"#;

// SQLite triggers serialize admission with the insert itself, including concurrent clients.
// Existing devices remain usable above a new quota; no user records are deleted.
const REGISTRATION_QUOTAS: &str = r#"
CREATE TRIGGER IF NOT EXISTS limit_account_devices BEFORE INSERT ON devices
WHEN NOT EXISTS (SELECT 1 FROM devices WHERE user_id = NEW.user_id AND device_id = NEW.device_id)
 AND (SELECT count(*) FROM devices WHERE user_id = NEW.user_id) >= 64
BEGIN SELECT RAISE(ABORT, 'account device quota exceeded'); END;
CREATE TRIGGER IF NOT EXISTS limit_account_tokens BEFORE INSERT ON auth_tokens
WHEN NOT EXISTS (SELECT 1 FROM auth_tokens WHERE request_id = NEW.request_id)
 AND (SELECT count(*) FROM auth_tokens WHERE user_id = NEW.user_id AND expires_at > unixepoch()) >= 256
BEGIN SELECT RAISE(ABORT, 'account token quota exceeded'); END;
"#;

const MIGRATE_PAGES_DEPLOYED_VERSION: &str = r#"
ALTER TABLE pages ADD COLUMN deployed_version_id TEXT;
"#;

const MIGRATE_PAGES_GENERATION: &str = r#"
ALTER TABLE pages ADD COLUMN generation TEXT NOT NULL DEFAULT '';
"#;

const MIGRATE_PAGE_VERSION_SOURCE_UPLOAD_ID: &str = r#"
ALTER TABLE page_versions ADD COLUMN source_upload_id TEXT;
"#;

const MIGRATE_AUTH_TOKEN_KIND: &str = r#"
ALTER TABLE auth_tokens ADD COLUMN token_kind TEXT NOT NULL DEFAULT 'device';
"#;

const MIGRATE_AUTH_TOKEN_REQUEST_ID: &str = r#"
ALTER TABLE auth_tokens ADD COLUMN request_id TEXT;
"#;

const MIGRATE_DEVICE_KIND: &str = r#"
ALTER TABLE devices ADD COLUMN device_kind TEXT;
"#;

/// Open (or create) the SQLite database and ensure the schema exists.
pub async fn connect(db_path: &str) -> Result<DbPool> {
    connect_with_presence_reset(db_path, true).await
}

/// Open the shared database for the out-of-process administration CLI.
/// Unlike a server-process startup, an admin connection must preserve the
/// live relay's durable presence projection: even `list-users` may run via
/// `docker exec` while authenticated WebSockets remain active.
pub async fn connect_for_admin(db_path: &str) -> Result<DbPool> {
    connect_with_presence_reset(db_path, false).await
}

async fn connect_with_presence_reset(db_path: &str, reset_presence: bool) -> Result<DbPool> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{db_path}"))?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::query(SCHEMA).execute(&pool).await?;
    retire_relay_session_history(&pool).await?;
    // Older DBs created pages without deployed_version_id.
    let _ = sqlx::query(MIGRATE_PAGES_DEPLOYED_VERSION)
        .execute(&pool)
        .await;
    if let Err(error) = sqlx::query(MIGRATE_PAGES_GENERATION).execute(&pool).await {
        if !error.to_string().contains("duplicate column name") {
            return Err(anyhow!("migrate page generations: {error}"));
        }
    }
    // A Page generation is an authorization boundary. It must change when a
    // `(user_id, slug)` row is deleted and later recreated, so legacy rows get
    // a random value once instead of sharing a constant migration default.
    sqlx::query(
        "UPDATE pages SET generation = lower(hex(randomblob(16))) \
         WHERE generation = ''",
    )
    .execute(&pool)
    .await
    .map_err(|e| anyhow!("initialize page generations: {e}"))?;
    if let Err(error) = sqlx::query(MIGRATE_PAGE_VERSION_SOURCE_UPLOAD_ID)
        .execute(&pool)
        .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(anyhow!("migrate page version upload ids: {error}"));
        }
    }
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_page_versions_source_upload \
         ON page_versions(user_id, slug, source_upload_id) \
         WHERE source_upload_id IS NOT NULL",
    )
    .execute(&pool)
    .await
    .map_err(|e| anyhow!("index page version upload ids: {e}"))?;
    // Existing tokens predate delegation scopes and are full device tokens.
    if let Err(error) = sqlx::query(MIGRATE_AUTH_TOKEN_KIND).execute(&pool).await {
        if !error.to_string().contains("duplicate column name") {
            return Err(anyhow!("migrate auth token capabilities: {error}"));
        }
    }
    if let Err(error) = sqlx::query(MIGRATE_AUTH_TOKEN_REQUEST_ID)
        .execute(&pool)
        .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(anyhow!("migrate auth token request ids: {error}"));
        }
    }
    migrate_account_scoped_devices(&pool).await?;
    // Runs after the account-scoping migration because that path rebuilds
    // `devices` from the legacy schema; adding the column last covers both the
    // rebuilt table and databases that never needed rebuilding. A NULL kind
    // means "registered before clients reported one" and is read as a desktop.
    if let Err(error) = sqlx::query(MIGRATE_DEVICE_KIND).execute(&pool).await {
        if !error.to_string().contains("duplicate column name") {
            return Err(anyhow!("migrate device kinds: {error}"));
        }
    }
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_request_id \
         ON auth_tokens(request_id) WHERE request_id IS NOT NULL",
    )
    .execute(&pool)
    .await
    .map_err(|e| anyhow!("index auth token request ids: {e}"))?;
    sqlx::raw_sql(REGISTRATION_QUOTAS).execute(&pool).await?;
    let now = Utc::now().timestamp();
    sqlx::query("DELETE FROM auth_tokens WHERE expires_at <= ?")
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|e| anyhow!("clean expired auth tokens: {e}"))?;
    if reset_presence {
        // Online presence is owned by the in-memory connection registry. A
        // fresh *server* process has no live sockets, so never carry stale
        // online flags across a restart or crash. Administration processes
        // intentionally skip this reset because the server may still run.
        sqlx::query("UPDATE devices SET online = 0")
            .execute(&pool)
            .await
            .map_err(|e| anyhow!("reset stale device presence: {e}"))?;
    }
    tracing::info!("Account database initialized at {db_path}");
    Ok(pool)
}

/// Tables that held encrypted session history and metadata for earlier
/// releases. The relay forwards ciphertext and stores no session content, so an
/// upgraded database drops them and returns the file space to the operating
/// system. Dropping is the product decision here, not error recovery: the
/// content belongs to online hosts, which serve it to controllers on demand.
const RETIRED_SESSION_HISTORY_TABLES: [&str; 3] = [
    "realtime_messages",
    "realtime_sessions",
    "realtime_account_sequence",
];

/// Returns true when retired tables were present and have been removed.
pub async fn retire_relay_session_history(pool: &DbPool) -> Result<bool> {
    let mut removed = false;
    for table in RETIRED_SESSION_HISTORY_TABLES {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .bind(table)
                .fetch_optional(pool)
                .await
                .map_err(|e| anyhow!("inspect retired session history table {table}: {e}"))?;
        if exists.is_none() {
            continue;
        }
        sqlx::query(&format!("DROP TABLE IF EXISTS {table}"))
            .execute(pool)
            .await
            .map_err(|e| anyhow!("drop retired session history table {table}: {e}"))?;
        removed = true;
    }
    if removed {
        // Dropped rows only become free pages; VACUUM rewrites the file so the
        // retired ciphertext is not left on disk inside the database.
        sqlx::query("VACUUM")
            .execute(pool)
            .await
            .map_err(|e| anyhow!("reclaim retired session history space: {e}"))?;
        tracing::info!("Removed relay-stored session history tables from the account database");
    }
    Ok(removed)
}

/// Migrate the original globally-keyed `devices(device_id)` table to the
/// account-scoped `(user_id, device_id)` identity model. A physical install id
/// is intentionally stable across logins, so it must be legal for two accounts
/// to register the same value without one account reassigning the other's row.
async fn migrate_account_scoped_devices(pool: &DbPool) -> Result<()> {
    let columns = sqlx::query("PRAGMA table_info(devices)")
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("inspect devices schema: {e}"))?;
    let mut user_pk_order = 0_i64;
    let mut device_pk_order = 0_i64;
    for column in columns {
        let name: String = sqlx::Row::get(&column, "name");
        let pk_order: i64 = sqlx::Row::get(&column, "pk");
        match name.as_str() {
            "user_id" => user_pk_order = pk_order,
            "device_id" => device_pk_order = pk_order,
            _ => {}
        }
    }
    if user_pk_order == 1 && device_pk_order == 2 {
        return Ok(());
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| anyhow!("begin account-scoped device migration: {e}"))?;
    sqlx::query("ALTER TABLE auth_tokens RENAME TO auth_tokens_legacy")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("rename legacy auth_tokens: {e}"))?;
    sqlx::query("ALTER TABLE devices RENAME TO devices_legacy")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("rename legacy devices: {e}"))?;
    sqlx::query(
        "CREATE TABLE devices (\
           device_id TEXT NOT NULL,\
           user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,\
           device_name TEXT, public_key TEXT, last_seen_at INTEGER,\
           online INTEGER NOT NULL DEFAULT 0,\
           PRIMARY KEY (user_id, device_id)\
         )",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow!("create account-scoped devices: {e}"))?;
    sqlx::query(
        "CREATE TABLE auth_tokens (\
           token TEXT PRIMARY KEY,\
           user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,\
           device_id TEXT NOT NULL,\
           token_kind TEXT NOT NULL DEFAULT 'device',\
           request_id TEXT,\
           created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,\
           FOREIGN KEY (user_id, device_id)\
             REFERENCES devices(user_id, device_id) ON DELETE CASCADE\
         )",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow!("create scoped auth_tokens: {e}"))?;
    sqlx::query(
        "INSERT INTO devices \
         (device_id, user_id, device_name, public_key, last_seen_at, online) \
         SELECT device_id, user_id, device_name, public_key, last_seen_at, online \
         FROM devices_legacy",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow!("copy legacy devices: {e}"))?;
    // Discard any historically inconsistent token whose user_id no longer
    // matches the device row. Such a token could only arise from the old global
    // upsert behavior and must not survive the ownership migration.
    sqlx::query(
        "INSERT INTO auth_tokens \
         (token, user_id, device_id, token_kind, request_id, created_at, expires_at) \
         SELECT a.token, a.user_id, a.device_id, a.token_kind, a.request_id, a.created_at, a.expires_at \
         FROM auth_tokens_legacy a \
         INNER JOIN devices_legacy d \
           ON d.user_id = a.user_id AND d.device_id = a.device_id",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow!("copy consistent legacy auth tokens: {e}"))?;
    sqlx::query("DROP TABLE auth_tokens_legacy")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("drop legacy auth_tokens: {e}"))?;
    sqlx::query("DROP TABLE devices_legacy")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("drop legacy devices: {e}"))?;
    sqlx::query("CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id)")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("recreate auth token index: {e}"))?;
    sqlx::query("CREATE INDEX idx_devices_user ON devices(user_id)")
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("recreate device index: {e}"))?;
    tx.commit()
        .await
        .map_err(|e| anyhow!("commit account-scoped device migration: {e}"))?;
    Ok(())
}

// ── Users ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub user_id: String,
    pub username: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl UserRow {
    /// Persist a profile authenticated by the shared GitHub authority. The
    /// immutable numeric GitHub id owns devices; login is display/URL metadata.
    pub async fn upsert_verified(pool: &DbPool, user_id: &str, username: &str) -> Result<UserRow> {
        let now = Utc::now().timestamp();
        let user = sqlx::query_as::<_, UserRow>(
            "INSERT INTO users (user_id, username, created_at, updated_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at \
             RETURNING user_id, username, created_at, updated_at",
        ).bind(user_id).bind(username).bind(now).bind(now).fetch_one(pool).await?;
        Ok(user)
    }

    #[cfg(test)]
    pub async fn create(pool: &DbPool, user_id: &str, username: &str) -> Result<()> {
        Self::upsert_verified(pool, user_id, username).await?;
        Ok(())
    }

    pub async fn find_by_username(pool: &DbPool, username: &str) -> Result<Option<UserRow>> {
        Ok(sqlx::query_as::<_, UserRow>(
            "SELECT user_id, username, created_at, updated_at FROM users WHERE username = ?",
        )
        .bind(username)
        .fetch_optional(pool)
        .await?)
    }

    pub async fn find_by_user_id(pool: &DbPool, user_id: &str) -> Result<Option<UserRow>> {
        Ok(sqlx::query_as::<_, UserRow>(
            "SELECT user_id, username, created_at, updated_at FROM users WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?)
    }

    /// Resolve username for a user id (convenience for page URL construction).
    pub async fn find_by_username_for_user_id(
        pool: &DbPool,
        user_id: &str,
    ) -> Result<Option<String>> {
        Ok(Self::find_by_user_id(pool, user_id)
            .await?
            .map(|u| u.username))
    }

    /// List all usernames (admin tooling). Returns `(username, created_at)`.
    pub async fn list_all(pool: &DbPool) -> Result<Vec<(String, String, i64)>> {
        let rows = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT username, user_id, created_at FROM users ORDER BY created_at",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("list users: {e}"))?;
        Ok(rows)
    }

    /// Permanently delete a user and all associated data (devices, tokens,
    /// pages). Cascading deletes handle FK-linked rows.
    pub async fn delete(pool: &DbPool, user_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM page_kv WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete page_kv: {e}"))?;
        sqlx::query("DELETE FROM page_blobs WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete page_blobs: {e}"))?;
        sqlx::query("DELETE FROM page_versions WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete page_versions: {e}"))?;
        sqlx::query("DELETE FROM pages WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete pages: {e}"))?;
        // auth_tokens and devices have REFERENCES users(user_id) but SQLite
        // doesn't cascade by default, so clean them up explicitly.
        sqlx::query("DELETE FROM auth_tokens WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete auth_tokens: {e}"))?;
        sqlx::query("DELETE FROM devices WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete devices: {e}"))?;
        sqlx::query("DELETE FROM users WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("delete user: {e}"))?;
        Ok(())
    }
}

// ── Devices ─────────────────────────────────────────────────────────────

/// Only desktops can host a remote-control session, so the device list is
/// filtered on this. Phones and watches still register — they need a device
/// row to hold their auth token — they just aren't offered as control targets.
pub const DEVICE_KIND_DESKTOP: &str = "desktop";
pub const DEVICE_KIND_MOBILE: &str = "mobile";
pub const DEVICE_KIND_WATCH: &str = "watch";

pub const DEVICE_KINDS: [&str; 3] = [DEVICE_KIND_DESKTOP, DEVICE_KIND_MOBILE, DEVICE_KIND_WATCH];

pub fn is_valid_device_kind(kind: &str) -> bool {
    DEVICE_KINDS.contains(&kind)
}

/// A missing kind predates client-side reporting, and is read as a desktop:
/// hiding a real desktop would break remote control outright, while a stale
/// phone row corrects itself the next time that phone logs in.
pub fn device_kind_is_desktop(kind: Option<&str>) -> bool {
    matches!(kind, None | Some(DEVICE_KIND_DESKTOP))
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceRow {
    pub device_id: String,
    pub user_id: String,
    pub device_name: Option<String>,
    pub device_kind: Option<String>,
    pub public_key: Option<String>,
    pub last_seen_at: Option<i64>,
    pub online: i64,
}

impl DeviceRow {
    pub async fn upsert(
        pool: &DbPool,
        device_id: &str,
        user_id: &str,
        device_name: &str,
        device_kind: Option<&str>,
        public_key: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        // `device_kind` is only overwritten when the caller actually reported
        // one. A client build that predates the field would otherwise erase a
        // known kind on every login and put the device back in the list.
        sqlx::query(
            "INSERT INTO devices \
               (device_id, user_id, device_name, device_kind, public_key, last_seen_at, online) \
             VALUES (?, ?, ?, ?, ?, ?, 0) \
             ON CONFLICT(user_id, device_id) DO UPDATE SET \
               device_name = excluded.device_name, \
               device_kind = COALESCE(excluded.device_kind, devices.device_kind), \
               public_key = COALESCE(excluded.public_key, devices.public_key), \
               last_seen_at = excluded.last_seen_at",
        )
        .bind(device_id)
        .bind(user_id)
        .bind(device_name)
        .bind(device_kind)
        .bind(public_key)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("upsert device: {e}"))?;
        Ok(())
    }

    pub async fn set_online(
        pool: &DbPool,
        user_id: &str,
        device_id: &str,
        online: bool,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        sqlx::query(
            "UPDATE devices SET online = ?, last_seen_at = ? WHERE user_id = ? AND device_id = ?",
        )
        .bind(online as i64)
        .bind(now)
        .bind(user_id)
        .bind(device_id)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("set device online: {e}"))?;
        Ok(())
    }

    pub async fn list_by_user(pool: &DbPool, user_id: &str) -> Result<Vec<DeviceRow>> {
        let rows = sqlx::query_as::<_, DeviceRow>(
            "SELECT device_id, user_id, device_name, device_kind, public_key, last_seen_at, online \
             FROM devices WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("list devices: {e}"))?;
        Ok(rows)
    }

    /// Delete a device owned by `user_id` and revoke all of its auth tokens.
    ///
    /// Tokens must be removed before the device because `auth_tokens.device_id`
    /// references `devices.device_id`. Keep both operations in one transaction
    /// so a partial deletion cannot leave the account in an inconsistent state.
    pub async fn delete_for_user(pool: &DbPool, user_id: &str, device_id: &str) -> Result<bool> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin device deletion: {e}"))?;

        sqlx::query("DELETE FROM auth_tokens WHERE device_id = ? AND user_id = ?")
            .bind(device_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("revoke device tokens: {e}"))?;

        let result = sqlx::query("DELETE FROM devices WHERE device_id = ? AND user_id = ?")
            .bind(device_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("delete device: {e}"))?;

        tx.commit()
            .await
            .map_err(|e| anyhow!("commit device deletion: {e}"))?;
        Ok(result.rows_affected() > 0)
    }
}

// ── Auth tokens ─────────────────────────────────────────────────────────

const DEVICE_TOKEN_TTL_SECS: i64 = 30 * 24 * 3600;
const DELEGATED_TOKEN_TTL_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthToken {
    pub token: String,
    pub user_id: String,
    pub device_id: String,
    pub token_kind: String,
    pub request_id: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

impl AuthToken {
    pub async fn create(pool: &DbPool, user_id: &str, device_id: &str) -> Result<AuthToken> {
        Self::create_with_kind(pool, user_id, device_id, "device", None).await
    }

    pub async fn create_idempotent(
        pool: &DbPool,
        user_id: &str,
        device_id: &str,
        request_id: &str,
    ) -> Result<AuthToken> {
        Self::create_with_kind(pool, user_id, device_id, "device", Some(request_id)).await
    }

    /// Atomically register a brand-new account device and issue its first full
    /// device token. `None` means that device id already belongs to this
    /// account and must not be silently taken over by a bootstrap retry.
    /// Replaying the same request id returns the original token.
    pub async fn provision_new_device(
        pool: &DbPool,
        user_id: &str,
        device_id: &str,
        device_name: &str,
        device_kind: Option<&str>,
        request_id: &str,
        public_key: &str,
    ) -> Result<Option<AuthToken>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| anyhow!("begin device provisioning: {error}"))?;
        let now = Utc::now().timestamp();

        if let Some(existing) = sqlx::query_as::<_, AuthToken>(
            "SELECT token, user_id, device_id, token_kind, request_id, created_at, expires_at \
             FROM auth_tokens WHERE request_id = ?",
        )
        .bind(request_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| anyhow!("find provisioned device token: {error}"))?
        {
            if existing.user_id != user_id
                || existing.device_id != device_id
                || !existing.is_device_token()
                || existing.expires_at <= now
            {
                return Err(anyhow!(
                    "device provisioning request id conflicts with another request"
                ));
            }
            let stored_name = sqlx::query_scalar::<_, Option<String>>(
                "SELECT device_name FROM devices WHERE user_id = ? AND device_id = ?",
            )
            .bind(user_id)
            .bind(device_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| anyhow!("read provisioned device: {error}"))?
            .flatten();
            if stored_name.as_deref() != Some(device_name) {
                return Err(anyhow!(
                    "device provisioning request id conflicts with another device name"
                ));
            }
            let stored_key = sqlx::query_scalar::<_, Option<String>>(
                "SELECT public_key FROM devices WHERE user_id = ? AND device_id = ?",
            )
            .bind(user_id)
            .bind(device_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            if stored_key.as_deref() != Some(public_key) {
                return Err(anyhow!(
                    "device provisioning request id conflicts with another public key"
                ));
            }
            return Ok(Some(existing));
        }

        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO devices \
             (device_id, user_id, device_name, device_kind, public_key, last_seen_at, online) \
             VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(device_id)
        .bind(user_id)
        .bind(device_name)
        .bind(device_kind)
        .bind(public_key)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|error| anyhow!("register provisioned device: {error}"))?;
        if inserted.rows_affected() == 0 {
            return Ok(None);
        }

        let token = generate_token();
        let expires_at = now + DEVICE_TOKEN_TTL_SECS;
        sqlx::query(
            "INSERT INTO auth_tokens \
             (token, user_id, device_id, token_kind, request_id, created_at, expires_at) \
             VALUES (?, ?, ?, 'device', ?, ?, ?)",
        )
        .bind(&token)
        .bind(user_id)
        .bind(device_id)
        .bind(request_id)
        .bind(now)
        .bind(expires_at)
        .execute(&mut *tx)
        .await
        .map_err(|error| anyhow!("issue provisioned device token: {error}"))?;
        tx.commit()
            .await
            .map_err(|error| anyhow!("commit device provisioning: {error}"))?;

        Ok(Some(AuthToken {
            token,
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            token_kind: "device".to_string(),
            request_id: Some(request_id.to_string()),
            created_at: now,
            expires_at,
        }))
    }

    pub async fn create_keyed_delegated(
        pool: &DbPool,
        user_id: &str,
        parent_device_id: &str,
        public_key: &str,
    ) -> Result<AuthToken> {
        let token = generate_token();
        let now = Utc::now().timestamp();
        let expires_at = now + DELEGATED_TOKEN_TTL_SECS;
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "INSERT INTO auth_tokens (token, user_id, device_id, token_kind, created_at, expires_at) \
             VALUES (?, ?, ?, 'delegated_control', ?, ?)",
        )
        .bind(&token).bind(user_id).bind(parent_device_id).bind(now).bind(expires_at)
        .execute(&mut *transaction).await?;
        let controller_id = format!("controller-{}", uuid::Uuid::new_v4());
        sqlx::query(
            "INSERT INTO delegated_device_keys (token, controller_id, public_key) VALUES (?, ?, ?)",
        )
        .bind(&token)
        .bind(&controller_id)
        .bind(public_key)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(AuthToken {
            token,
            user_id: user_id.to_string(),
            device_id: parent_device_id.to_string(),
            token_kind: "delegated_control".to_string(),
            request_id: None,
            created_at: now,
            expires_at,
        })
    }

    /// The owner device remains the revocation parent; routing uses a distinct controller key.
    pub async fn routing_device_id(&self, pool: &DbPool) -> Result<String> {
        if self.is_device_token() {
            return Ok(self.device_id.clone());
        }
        sqlx::query_scalar::<_, String>(
            "SELECT controller_id FROM delegated_device_keys WHERE token = ?",
        )
        .bind(&self.token)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| anyhow!("controller has no registered device key"))
    }

    pub async fn create_delegated(
        pool: &DbPool,
        user_id: &str,
        device_id: &str,
    ) -> Result<AuthToken> {
        let now = Utc::now().timestamp();
        if let Some(existing) = sqlx::query_as::<_, AuthToken>(
            "SELECT token, user_id, device_id, token_kind, request_id, created_at, expires_at \
             FROM auth_tokens \
             WHERE user_id = ? AND device_id = ? \
               AND token_kind = 'delegated_control' AND expires_at > ? \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .bind(now)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("find reusable delegated token: {e}"))?
        {
            return Ok(existing);
        }
        Self::create_with_kind(pool, user_id, device_id, "delegated_control", None).await
    }

    async fn create_with_kind(
        pool: &DbPool,
        user_id: &str,
        device_id: &str,
        token_kind: &str,
        request_id: Option<&str>,
    ) -> Result<AuthToken> {
        let token = generate_token();
        let now = Utc::now().timestamp();
        let ttl = if token_kind == "delegated_control" {
            DELEGATED_TOKEN_TTL_SECS
        } else {
            DEVICE_TOKEN_TTL_SECS
        };
        let expires_at = now + ttl;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO auth_tokens \
             (token, user_id, device_id, token_kind, request_id, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&token)
        .bind(user_id)
        .bind(device_id)
        .bind(token_kind)
        .bind(request_id)
        .bind(now)
        .bind(expires_at)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("create token: {e}"))?;
        if result.rows_affected() == 0 {
            let request_id =
                request_id.ok_or_else(|| anyhow!("unexpected auth token collision"))?;
            let existing = sqlx::query_as::<_, AuthToken>(
                "SELECT token, user_id, device_id, token_kind, request_id, created_at, expires_at \
                 FROM auth_tokens WHERE request_id = ?",
            )
            .bind(request_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| anyhow!("find idempotent token: {e}"))?
            .ok_or_else(|| anyhow!("idempotent auth token disappeared"))?;
            if existing.user_id != user_id
                || existing.device_id != device_id
                || existing.token_kind != token_kind
                || existing.expires_at <= now
            {
                return Err(anyhow!(
                    "auth token request id conflicts with another request"
                ));
            }
            return Ok(existing);
        }
        Ok(AuthToken {
            token,
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            token_kind: token_kind.to_string(),
            request_id: request_id.map(str::to_string),
            created_at: now,
            expires_at,
        })
    }

    pub fn is_device_token(&self) -> bool {
        self.token_kind == "device"
    }

    pub fn can_control_devices(&self) -> bool {
        self.is_device_token() || self.token_kind == "delegated_control"
    }

    /// Look up a token; returns None if missing or expired (expired rows are
    /// deleted as a side effect).
    pub async fn find(pool: &DbPool, token: &str) -> Result<Option<AuthToken>> {
        if !is_valid_auth_token(token) {
            return Ok(None);
        }
        let row = sqlx::query_as::<_, AuthToken>(
            "SELECT token, user_id, device_id, token_kind, request_id, created_at, expires_at \
             FROM auth_tokens WHERE token = ?",
        )
        .bind(token)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("find token: {e}"))?;

        let Some(auth_token) = row else {
            return Ok(None);
        };

        if auth_token.expires_at <= Utc::now().timestamp() {
            let _ = sqlx::query("DELETE FROM auth_tokens WHERE token = ?")
                .bind(token)
                .execute(pool)
                .await;
            return Ok(None);
        }
        Ok(Some(auth_token))
    }

    /// Batch-load active device tokens for the server-side revocation reaper.
    /// Chunking keeps the query below SQLite's bind-variable limit even when a
    /// relay has many connected devices.
    pub async fn find_valid_device_tokens(
        pool: &DbPool,
        tokens: &[String],
    ) -> Result<Vec<AuthToken>> {
        const TOKEN_QUERY_CHUNK_SIZE: usize = 200;
        let now = Utc::now().timestamp();
        let mut valid = Vec::new();
        for chunk in tokens.chunks(TOKEN_QUERY_CHUNK_SIZE) {
            let mut query = QueryBuilder::<Sqlite>::new(
                "SELECT token, user_id, device_id, token_kind, request_id, created_at, expires_at \
                 FROM auth_tokens WHERE token_kind = 'device' AND expires_at > ",
            );
            query.push_bind(now);
            query.push(" AND token IN (");
            let mut separated = query.separated(", ");
            for token in chunk {
                separated.push_bind(token);
            }
            separated.push_unseparated(")");
            valid.extend(
                query
                    .build_query_as::<AuthToken>()
                    .fetch_all(pool)
                    .await
                    .map_err(|e| anyhow!("batch find active device tokens: {e}"))?,
            );
        }
        Ok(valid)
    }

    /// Revoke (delete) all tokens belonging to a specific device.
    pub async fn revoke_by_device(pool: &DbPool, user_id: &str, device_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM auth_tokens WHERE user_id = ? AND device_id = ?")
            .bind(user_id)
            .bind(device_id)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("revoke tokens by device: {e}"))?;
        Ok(())
    }
}

fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Account tokens are fixed-size lowercase hexadecimal bearer secrets. Check
/// the shape before hitting SQLite so oversized or malformed untrusted input
/// cannot become a database lookup key.
pub fn is_valid_auth_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// ── Pages (published static sites) ──────────────────────────────────────

/// Visibility levels for a published OpenBitFun Page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageVisibility {
    /// Only the page owner (with their token) can access.
    Private,
    /// Any authenticated user on this relay can access.
    Relay,
    /// Anyone on the internet can access without credentials.
    Public,
}

impl PageVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Relay => "relay",
            Self::Public => "public",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "private" => Some(Self::Private),
            "relay" => Some(Self::Relay),
            "public" => Some(Self::Public),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PageRow {
    pub user_id: String,
    pub slug: String,
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub deployed_version_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Page row joined with the owning username (for public URL serving).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PageWithUsername {
    pub user_id: String,
    pub username: String,
    pub slug: String,
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub deployed_version_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PageVersionRow {
    pub user_id: String,
    pub slug: String,
    pub version_id: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub has_worker: i64,
    pub note: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SavePageVersionOutcome {
    Saved,
    PageLimitReached,
    VersionLimitReached,
    GenerationMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletePageVersionOutcome {
    Deleted,
    Deployed,
    NotFound,
    GenerationMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageMutationOutcome<T> {
    Applied(T),
    NotFound,
    GenerationMismatch,
}

impl PageRow {
    pub fn visibility_enum(&self) -> Option<PageVisibility> {
        PageVisibility::parse(&self.visibility)
    }

    const SELECT_COLS: &'static str =
        "user_id, slug, generation, visibility, title, file_count, total_bytes, \
             deployed_version_id, created_at, updated_at";

    /// Ensure a page metadata row exists (draft upload / first save).
    pub async fn ensure(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        visibility: PageVisibility,
        title: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let generation = new_page_generation();
        sqlx::query(
            "INSERT INTO pages \
             (user_id, slug, generation, visibility, title, file_count, total_bytes, deployed_version_id, \
              created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?) \
             ON CONFLICT(user_id, slug) DO UPDATE SET \
               visibility = excluded.visibility, \
               title = CASE WHEN excluded.title = '' THEN pages.title ELSE excluded.title END, \
               updated_at = excluded.updated_at",
        )
        .bind(user_id)
        .bind(slug)
        .bind(generation)
        .bind(visibility.as_str())
        .bind(title)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("ensure page: {e}"))?;
        Ok(())
    }

    pub async fn get(pool: &DbPool, user_id: &str, slug: &str) -> Result<Option<PageRow>> {
        let row = sqlx::query_as::<_, PageRow>(&format!(
            "SELECT {} FROM pages WHERE user_id = ? AND slug = ?",
            Self::SELECT_COLS
        ))
        .bind(user_id)
        .bind(slug)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("get page: {e}"))?;
        Ok(row)
    }

    pub async fn list_for_user(pool: &DbPool, user_id: &str) -> Result<Vec<PageRow>> {
        let rows = sqlx::query_as::<_, PageRow>(&format!(
            "SELECT {} FROM pages WHERE user_id = ? ORDER BY updated_at DESC",
            Self::SELECT_COLS
        ))
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("list pages: {e}"))?;
        Ok(rows)
    }

    pub async fn count_for_user(pool: &DbPool, user_id: &str) -> Result<i64> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(|e| anyhow!("count pages: {e}"))?;
        Ok(row.0)
    }

    /// Atomically create/update Page metadata and insert its immutable version.
    /// A failed version insert or quota check must never leak title/visibility
    /// changes onto the previously deployed Page.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_version_with_meta(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        visibility: PageVisibility,
        title: &str,
        version_id: &str,
        file_count: i64,
        total_bytes: i64,
        has_worker: bool,
        note: &str,
        source_upload_id: Option<&str>,
        max_pages_per_user: i64,
        max_versions_per_page: i64,
        expected_generation: Option<&str>,
        create: bool,
    ) -> Result<SavePageVersionOutcome> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin save page version transaction: {e}"))?;

        let page_exists: Option<(String,)> =
            sqlx::query_as("SELECT generation FROM pages WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| anyhow!("read page before saving version: {e}"))?;
        let version_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM page_versions WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| anyhow!("count page versions before save: {e}"))?;
        if version_count.0 >= max_versions_per_page {
            return Ok(SavePageVersionOutcome::VersionLimitReached);
        }

        let now = Utc::now().timestamp();
        if let Some((generation,)) = page_exists {
            if create || expected_generation != Some(generation.as_str()) {
                return Ok(SavePageVersionOutcome::GenerationMismatch);
            }
            let result = sqlx::query(
                "UPDATE pages SET visibility = ?, title = ?, updated_at = ? \
                 WHERE user_id = ? AND slug = ? AND generation = ?",
            )
            .bind(visibility.as_str())
            .bind(title)
            .bind(now)
            .bind(user_id)
            .bind(slug)
            .bind(&generation)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("update page metadata while saving version: {e}"))?;
            if result.rows_affected() == 0 {
                return Err(anyhow!("page disappeared while saving version"));
            }
        } else {
            if !create || expected_generation.is_some() {
                return Ok(SavePageVersionOutcome::GenerationMismatch);
            }
            let page_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages WHERE user_id = ?")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| anyhow!("count pages before save: {e}"))?;
            if page_count.0 >= max_pages_per_user {
                return Ok(SavePageVersionOutcome::PageLimitReached);
            }
            let inserted = sqlx::query(
                "INSERT INTO pages \
                 (user_id, slug, generation, visibility, title, file_count, total_bytes, \
                  deployed_version_id, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?) \
                 ON CONFLICT(user_id, slug) DO NOTHING",
            )
            .bind(user_id)
            .bind(slug)
            .bind(new_page_generation())
            .bind(visibility.as_str())
            .bind(title)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("create page while saving version: {e}"))?;
            if inserted.rows_affected() == 0 {
                return Ok(SavePageVersionOutcome::GenerationMismatch);
            }
        }

        sqlx::query(
            "INSERT INTO page_versions \
             (user_id, slug, version_id, source_upload_id, title, file_count, total_bytes, has_worker, note, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .bind(source_upload_id)
        .bind(title)
        .bind(file_count)
        .bind(total_bytes)
        .bind(has_worker as i64)
        .bind(note)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("insert page version with metadata: {e}"))?;

        tx.commit()
            .await
            .map_err(|e| anyhow!("commit saved page version: {e}"))?;
        Ok(SavePageVersionOutcome::Saved)
    }

    pub async fn update_meta(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        expected_generation: &str,
        visibility: Option<PageVisibility>,
        title: Option<&str>,
    ) -> Result<PageMutationOutcome<PageRow>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin update page transaction: {e}"))?;
        let existing = sqlx::query_as::<_, PageRow>(&format!(
            "SELECT {} FROM pages WHERE user_id = ? AND slug = ?",
            Self::SELECT_COLS
        ))
        .bind(user_id)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| anyhow!("read page before metadata update: {e}"))?;
        let Some(page) = existing else {
            return Ok(PageMutationOutcome::NotFound);
        };
        if page.generation != expected_generation {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        let now = Utc::now().timestamp();
        let new_vis = visibility
            .map(|v| v.as_str().to_string())
            .unwrap_or(page.visibility);
        let new_title = title.map(|t| t.to_string()).unwrap_or(page.title);
        let result = sqlx::query(
            "UPDATE pages SET visibility = ?, title = ?, updated_at = ? \
             WHERE user_id = ? AND slug = ? AND generation = ?",
        )
        .bind(&new_vis)
        .bind(&new_title)
        .bind(now)
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("update page meta: {e}"))?;
        if result.rows_affected() == 0 {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        let updated = sqlx::query_as::<_, PageRow>(&format!(
            "SELECT {} FROM pages WHERE user_id = ? AND slug = ? AND generation = ?",
            Self::SELECT_COLS
        ))
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| anyhow!("read updated page metadata: {e}"))?;
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit update page transaction: {e}"))?;
        Ok(PageMutationOutcome::Applied(updated))
    }

    pub async fn set_deployed_version(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
        file_count: i64,
        total_bytes: i64,
        title: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        sqlx::query(
            "UPDATE pages SET deployed_version_id = ?, file_count = ?, total_bytes = ?, \
             title = CASE WHEN ? = '' THEN title ELSE ? END, updated_at = ? \
             WHERE user_id = ? AND slug = ?",
        )
        .bind(version_id)
        .bind(file_count)
        .bind(total_bytes)
        .bind(title)
        .bind(title)
        .bind(now)
        .bind(user_id)
        .bind(slug)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("set deployed version: {e}"))?;
        Ok(())
    }

    /// Atomically attach the synthetic `v1` record used by the pre-versioned
    /// asset-layout migration. The generation fence prevents a stale migration
    /// from inserting an orphan version or updating a delete/recreated Page.
    #[allow(clippy::too_many_arguments)]
    pub async fn migrate_legacy_version(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        expected_generation: &str,
        version_id: &str,
        title: &str,
        file_count: i64,
        total_bytes: i64,
        has_worker: bool,
    ) -> Result<PageMutationOutcome<bool>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin legacy page migration transaction: {e}"))?;
        let page: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT generation, deployed_version_id FROM pages WHERE user_id = ? AND slug = ?",
        )
        .bind(user_id)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| anyhow!("read page before legacy migration: {e}"))?;
        let Some((generation, deployed_version_id)) = page else {
            return Ok(PageMutationOutcome::NotFound);
        };
        if generation != expected_generation {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        let version_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM page_versions WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| anyhow!("count versions before legacy migration: {e}"))?;
        if deployed_version_id.is_some() || version_count.0 > 0 {
            return Ok(PageMutationOutcome::Applied(false));
        }

        let now = Utc::now().timestamp();
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO page_versions \
             (user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'migrated', ?)",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .bind(title)
        .bind(file_count)
        .bind(total_bytes)
        .bind(has_worker as i64)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("insert migrated legacy page version: {e}"))?;
        if inserted.rows_affected() == 0 {
            return Ok(PageMutationOutcome::Applied(false));
        }
        let updated = sqlx::query(
            "UPDATE pages SET deployed_version_id = ?, updated_at = ? \
             WHERE user_id = ? AND slug = ? AND generation = ? AND deployed_version_id IS NULL",
        )
        .bind(version_id)
        .bind(now)
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("deploy migrated legacy page version: {e}"))?;
        if updated.rows_affected() == 0 {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit legacy page migration: {e}"))?;
        Ok(PageMutationOutcome::Applied(true))
    }

    /// Deploy a version and return the resulting Page from one transaction.
    /// The version lookup and production-pointer update cannot race a version
    /// deletion performed through the paired transactional API below.
    pub async fn deploy_version(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
        expected_generation: &str,
    ) -> Result<PageMutationOutcome<PageRow>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin deploy page version transaction: {e}"))?;
        let page_generation: Option<(String,)> =
            sqlx::query_as("SELECT generation FROM pages WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| anyhow!("read page before deploy: {e}"))?;
        let Some((page_generation,)) = page_generation else {
            return Ok(PageMutationOutcome::NotFound);
        };
        if page_generation != expected_generation {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }

        let version = sqlx::query_as::<_, PageVersionRow>(
            "SELECT user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at \
             FROM page_versions WHERE user_id = ? AND slug = ? AND version_id = ?",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| anyhow!("get page version for deploy: {e}"))?;
        let Some(version) = version else {
            return Ok(PageMutationOutcome::NotFound);
        };

        let now = Utc::now().timestamp();
        let updated = sqlx::query(
            "UPDATE pages SET deployed_version_id = ?, file_count = ?, total_bytes = ?, \
             title = CASE WHEN ? = '' THEN title ELSE ? END, updated_at = ? \
             WHERE user_id = ? AND slug = ? AND generation = ?",
        )
        .bind(&version.version_id)
        .bind(version.file_count)
        .bind(version.total_bytes)
        .bind(&version.title)
        .bind(&version.title)
        .bind(now)
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("deploy page version: {e}"))?;
        if updated.rows_affected() == 0 {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        let page = sqlx::query_as::<_, PageRow>(&format!(
            "SELECT {} FROM pages WHERE user_id = ? AND slug = ? AND generation = ?",
            Self::SELECT_COLS
        ))
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| anyhow!("read deployed page: {e}"))?;
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit deployed page version: {e}"))?;
        Ok(PageMutationOutcome::Applied(page))
    }

    pub async fn clear_deployed_version(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        expected_generation: &str,
    ) -> Result<PageMutationOutcome<()>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin unpublish page transaction: {e}"))?;
        let now = Utc::now().timestamp();
        let result = sqlx::query(
            "UPDATE pages SET deployed_version_id = NULL, updated_at = ? \
             WHERE user_id = ? AND slug = ? AND generation = ?",
        )
        .bind(now)
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("clear deployed version: {e}"))?;
        if result.rows_affected() == 0 {
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT generation FROM pages WHERE user_id = ? AND slug = ?")
                    .bind(user_id)
                    .bind(slug)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| anyhow!("read page after failed unpublish: {e}"))?;
            return Ok(if exists.is_some() {
                PageMutationOutcome::GenerationMismatch
            } else {
                PageMutationOutcome::NotFound
            });
        }
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit unpublish page transaction: {e}"))?;
        Ok(PageMutationOutcome::Applied(()))
    }

    pub async fn delete(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        expected_generation: &str,
    ) -> Result<PageMutationOutcome<()>> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin page delete transaction: {e}"))?;
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT generation FROM pages WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| anyhow!("read page before delete: {e}"))?;
        let Some((generation,)) = existing else {
            return Ok(PageMutationOutcome::NotFound);
        };
        if generation != expected_generation {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        sqlx::query("DELETE FROM page_kv WHERE user_id = ? AND slug = ?")
            .bind(user_id)
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("delete page_kv: {e}"))?;
        sqlx::query("DELETE FROM page_blobs WHERE user_id = ? AND slug = ?")
            .bind(user_id)
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("delete page_blobs: {e}"))?;
        sqlx::query("DELETE FROM page_versions WHERE user_id = ? AND slug = ?")
            .bind(user_id)
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("delete page_versions: {e}"))?;
        let result =
            sqlx::query("DELETE FROM pages WHERE user_id = ? AND slug = ? AND generation = ?")
                .bind(user_id)
                .bind(slug)
                .bind(expected_generation)
                .execute(&mut *tx)
                .await
                .map_err(|e| anyhow!("delete page: {e}"))?;
        if result.rows_affected() == 0 {
            return Ok(PageMutationOutcome::GenerationMismatch);
        }
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit page delete transaction: {e}"))?;
        Ok(PageMutationOutcome::Applied(()))
    }

    /// Resolve a page by public URL components `(username, slug)`.
    pub async fn get_by_username(
        pool: &DbPool,
        username: &str,
        slug: &str,
    ) -> Result<Option<PageWithUsername>> {
        let row = sqlx::query_as::<_, PageWithUsername>(
            "SELECT p.user_id, u.username, p.slug, p.generation, p.visibility, p.title, \
             p.file_count, p.total_bytes, p.deployed_version_id, p.created_at, p.updated_at \
             FROM pages p JOIN users u ON u.user_id = p.user_id \
             WHERE u.username = ? AND p.slug = ?",
        )
        .bind(username)
        .bind(slug)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("get page by username: {e}"))?;
        Ok(row)
    }
}

impl PageWithUsername {
    pub fn visibility_enum(&self) -> Option<PageVisibility> {
        PageVisibility::parse(&self.visibility)
    }
}

impl PageVersionRow {
    pub async fn insert(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
        title: &str,
        file_count: i64,
        total_bytes: i64,
        has_worker: bool,
        note: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO page_versions \
             (user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .bind(title)
        .bind(file_count)
        .bind(total_bytes)
        .bind(has_worker as i64)
        .bind(note)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("insert page version: {e}"))?;
        Ok(())
    }

    pub async fn get(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
    ) -> Result<Option<PageVersionRow>> {
        let row = sqlx::query_as::<_, PageVersionRow>(
            "SELECT user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at \
             FROM page_versions WHERE user_id = ? AND slug = ? AND version_id = ?",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("get page version: {e}"))?;
        Ok(row)
    }

    pub async fn get_by_source_upload_id(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        source_upload_id: &str,
    ) -> Result<Option<PageVersionRow>> {
        let row = sqlx::query_as::<_, PageVersionRow>(
            "SELECT user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at \
             FROM page_versions \
             WHERE user_id = ? AND slug = ? AND source_upload_id = ?",
        )
        .bind(user_id)
        .bind(slug)
        .bind(source_upload_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow!("get page version by upload id: {e}"))?;
        Ok(row)
    }

    pub async fn list_for_page(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
    ) -> Result<Vec<PageVersionRow>> {
        let rows = sqlx::query_as::<_, PageVersionRow>(
            "SELECT user_id, slug, version_id, title, file_count, total_bytes, has_worker, note, created_at \
             FROM page_versions WHERE user_id = ? AND slug = ? ORDER BY created_at DESC",
        )
        .bind(user_id)
        .bind(slug)
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("list page versions: {e}"))?;
        Ok(rows)
    }

    pub async fn count_for_page(pool: &DbPool, user_id: &str, slug: &str) -> Result<i64> {
        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM page_versions WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_one(pool)
                .await
                .map_err(|e| anyhow!("count page versions: {e}"))?;
        Ok(row.0)
    }

    pub async fn delete(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
    ) -> Result<bool> {
        let result = sqlx::query(
            "DELETE FROM page_versions WHERE user_id = ? AND slug = ? AND version_id = ?",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .execute(pool)
        .await
        .map_err(|e| anyhow!("delete page version: {e}"))?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_if_not_deployed(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        version_id: &str,
        expected_generation: &str,
    ) -> Result<DeletePageVersionOutcome> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("begin delete page version transaction: {e}"))?;
        let page: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT generation, deployed_version_id FROM pages WHERE user_id = ? AND slug = ?",
        )
        .bind(user_id)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| anyhow!("read page before version delete: {e}"))?;
        let Some((generation, deployed_version_id)) = page else {
            return Ok(DeletePageVersionOutcome::NotFound);
        };
        if generation != expected_generation {
            return Ok(DeletePageVersionOutcome::GenerationMismatch);
        }
        if deployed_version_id.as_deref() == Some(version_id) {
            return Ok(DeletePageVersionOutcome::Deployed);
        }
        let result = sqlx::query(
            "DELETE FROM page_versions WHERE user_id = ? AND slug = ? AND version_id = ? \
             AND EXISTS (SELECT 1 FROM pages WHERE user_id = ? AND slug = ? AND generation = ?)",
        )
        .bind(user_id)
        .bind(slug)
        .bind(version_id)
        .bind(user_id)
        .bind(slug)
        .bind(expected_generation)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("delete undeployed page version: {e}"))?;
        if result.rows_affected() == 0 {
            return Ok(DeletePageVersionOutcome::NotFound);
        }
        tx.commit()
            .await
            .map_err(|e| anyhow!("commit page version delete: {e}"))?;
        Ok(DeletePageVersionOutcome::Deleted)
    }
}

/// Page KV helpers (mutable runtime data, keyed by page not version).
pub mod page_kv {
    use super::*;

    fn validate_key(key: &str) -> Result<()> {
        if key.is_empty() || key.len() > MAX_PAGE_KV_KEY_BYTES || key.chars().any(char::is_control)
        {
            return Err(anyhow!(
                "page KV key must be non-empty, control-free, and at most {} bytes",
                MAX_PAGE_KV_KEY_BYTES
            ));
        }
        Ok(())
    }

    pub async fn get(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        key: &str,
    ) -> Result<Option<String>> {
        validate_key(key)?;
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM page_kv WHERE user_id = ? AND slug = ? AND key = ?")
                .bind(user_id)
                .bind(slug)
                .bind(key)
                .fetch_optional(pool)
                .await
                .map_err(|e| anyhow!("page_kv get: {e}"))?;
        Ok(row.map(|r| r.0))
    }

    pub async fn put(
        pool: &DbPool,
        user_id: &str,
        slug: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        validate_key(key)?;
        if value.len() > MAX_PAGE_KV_VALUE_BYTES {
            return Err(anyhow!(
                "page KV value exceeds the {} byte operation limit",
                MAX_PAGE_KV_VALUE_BYTES
            ));
        }

        let mut tx = pool
            .begin()
            .await
            .map_err(|e| anyhow!("page_kv begin quota transaction: {e}"))?;
        let page_exists: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM pages WHERE user_id = ? AND slug = ?")
                .bind(user_id)
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| anyhow!("page_kv verify page exists: {e}"))?;
        if page_exists.is_none() {
            return Err(anyhow!("page no longer exists"));
        }
        let old_bytes: Option<(i64,)> = sqlx::query_as(
            "SELECT length(CAST(key AS BLOB)) + length(CAST(value AS BLOB)) \
             FROM page_kv WHERE user_id = ? AND slug = ? AND key = ?",
        )
        .bind(user_id)
        .bind(slug)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| anyhow!("page_kv read existing size: {e}"))?;
        let page_usage: (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(length(CAST(key AS BLOB)) + \
             length(CAST(value AS BLOB))), 0) FROM page_kv WHERE user_id = ? AND slug = ?",
        )
        .bind(user_id)
        .bind(slug)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| anyhow!("page_kv read page quota: {e}"))?;
        let user_usage: (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(length(CAST(key AS BLOB)) + \
             length(CAST(value AS BLOB))), 0) FROM page_kv WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| anyhow!("page_kv read account quota: {e}"))?;
        enforce_quota(
            page_usage,
            user_usage,
            old_bytes.map_or(0, |row| row.0),
            key.len().saturating_add(value.len()) as i64,
            old_bytes.is_none(),
        )?;

        let now = Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO page_kv (user_id, slug, key, value, updated_at) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(user_id, slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(user_id)
        .bind(slug)
        .bind(key)
        .bind(value)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("page_kv put: {e}"))?;
        tx.commit()
            .await
            .map_err(|e| anyhow!("page_kv commit: {e}"))?;
        Ok(())
    }

    pub async fn delete(pool: &DbPool, user_id: &str, slug: &str, key: &str) -> Result<bool> {
        validate_key(key)?;
        let result = sqlx::query("DELETE FROM page_kv WHERE user_id = ? AND slug = ? AND key = ?")
            .bind(user_id)
            .bind(slug)
            .bind(key)
            .execute(pool)
            .await
            .map_err(|e| anyhow!("page_kv delete: {e}"))?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_keys(pool: &DbPool, user_id: &str, slug: &str) -> Result<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT key FROM page_kv WHERE user_id = ? AND slug = ? ORDER BY key")
                .bind(user_id)
                .bind(slug)
                .fetch_all(pool)
                .await
                .map_err(|e| anyhow!("page_kv list: {e}"))?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    fn enforce_quota(
        page_usage: (i64, i64),
        user_usage: (i64, i64),
        replaced_bytes: i64,
        added_bytes: i64,
        is_new: bool,
    ) -> Result<()> {
        let added_entries = i64::from(is_new);
        if page_usage.0.saturating_add(added_entries) > MAX_PAGE_KV_ENTRIES {
            return Err(anyhow!("page KV entry quota exceeded"));
        }
        if user_usage.0.saturating_add(added_entries) > MAX_USER_KV_ENTRIES {
            return Err(anyhow!("account KV entry quota exceeded"));
        }
        if page_usage
            .1
            .saturating_sub(replaced_bytes)
            .saturating_add(added_bytes)
            > MAX_PAGE_KV_BYTES
        {
            return Err(anyhow!("page KV byte quota exceeded"));
        }
        if user_usage
            .1
            .saturating_sub(replaced_bytes)
            .saturating_add(added_bytes)
            > MAX_USER_KV_BYTES
        {
            return Err(anyhow!("account KV byte quota exceeded"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod quota_tests {
        use super::*;

        #[test]
        fn quota_projection_handles_insert_and_overwrite() {
            assert!(enforce_quota(
                (MAX_PAGE_KV_ENTRIES, 100),
                (MAX_PAGE_KV_ENTRIES, 100),
                10,
                10,
                false,
            )
            .is_ok());
            assert!(enforce_quota(
                (MAX_PAGE_KV_ENTRIES, 100),
                (MAX_PAGE_KV_ENTRIES, 100),
                0,
                1,
                true,
            )
            .is_err());
            assert!(
                enforce_quota((1, MAX_PAGE_KV_BYTES), (1, MAX_PAGE_KV_BYTES), 1, 2, false,)
                    .is_err()
            );
            assert!(enforce_quota((1, 1), (1, MAX_USER_KV_BYTES), 0, 1, false,).is_err());
        }

        #[tokio::test]
        async fn put_rejects_oversized_single_values_before_writing() {
            let pool = connect(":memory:").await.unwrap();
            let value = "x".repeat(MAX_PAGE_KV_VALUE_BYTES + 1);
            let err = put(&pool, "u1", "site", "key", &value).await.unwrap_err();
            assert!(err.to_string().contains("operation limit"));
            assert!(get(&pool, "u1", "site", "key").await.unwrap().is_none());
        }
    }
}

/// Legacy single-room asset key (pre-versioning). Used only for one-time migration.
pub fn page_legacy_asset_key(user_id: &str, slug: &str) -> String {
    format!("pages/{user_id}/{slug}")
}

/// Draft upload namespace (mutable until freeze).
pub fn page_draft_asset_key(user_id: &str, slug: &str) -> String {
    format!("pages/{user_id}/{slug}/draft")
}

/// Immutable version namespace.
pub fn page_version_asset_key(user_id: &str, slug: &str, version_id: &str) -> String {
    format!("pages/{user_id}/{slug}/v/{version_id}")
}

fn new_page_generation() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Generate a new version id (`v` + 12 hex chars).
pub fn new_page_version_id() -> String {
    let bytes: [u8; 6] = rand::random();
    format!(
        "v{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

#[cfg(test)]
mod retired_session_history_tests {
    use super::*;

    const LEGACY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS realtime_sessions (
 account_id TEXT NOT NULL,
 id TEXT NOT NULL,
 machine_id TEXT NOT NULL,
 seq INTEGER NOT NULL DEFAULT 0,
 metadata TEXT NOT NULL,
 metadata_version INTEGER NOT NULL DEFAULT 1,
 agent_state TEXT,
 agent_state_version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id, id)
);
CREATE TABLE IF NOT EXISTS realtime_messages (
 account_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 local_id TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(account_id, session_id, seq)
);
CREATE TABLE IF NOT EXISTS realtime_account_sequence (
 account_id TEXT PRIMARY KEY,
 seq INTEGER NOT NULL DEFAULT 0,
 log_bytes INTEGER NOT NULL DEFAULT 0
);
"#;

    async fn table_names(pool: &DbPool) -> Vec<String> {
        sqlx::query_as::<_, (String,)>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'realtime_%'",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(name,)| name)
        .collect()
    }

    #[tokio::test]
    async fn upgraded_databases_drop_legacy_history_tables_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        let path = path.to_str().unwrap();
        {
            let legacy = sqlx::sqlite::SqlitePoolOptions::new()
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::from_str(&format!("sqlite://{path}"))
                        .unwrap()
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(LEGACY_SCHEMA).execute(&legacy).await.unwrap();
            sqlx::query("INSERT INTO realtime_sessions(account_id,id,machine_id,metadata,created_at,updated_at) VALUES('u','s','m','{}',0,0)")
                .execute(&legacy).await.unwrap();
            sqlx::query("INSERT INTO realtime_messages(account_id,session_id,id,seq,local_id,content,created_at) VALUES('u','s','m1',1,'l1','ciphertext',0)")
                .execute(&legacy).await.unwrap();
            legacy.close().await;
        }
        let pool = connect(path).await.unwrap();
        assert!(
            table_names(&pool).await.is_empty(),
            "legacy history tables are gone"
        );
        assert!(
            !retire_relay_session_history(&pool).await.unwrap(),
            "second run is a no-op"
        );
        pool.close().await;
        // Reopening keeps working and does not recreate the tables.
        let pool = connect(path).await.unwrap();
        assert!(table_names(&pool).await.is_empty());
    }

    #[tokio::test]
    async fn fresh_databases_never_create_history_tables() {
        let pool = connect(":memory:").await.unwrap();
        assert!(table_names(&pool).await.is_empty());
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn delegated_key_failure_rolls_back_token() {
        let pool = super::connect(":memory:").await.unwrap();
        super::UserRow::create(&pool, "u1", "alice").await.unwrap();
        super::DeviceRow::upsert(&pool, "d1", "u1", "desktop", None, None)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_controller_key BEFORE INSERT ON delegated_device_keys BEGIN SELECT RAISE(ABORT, 'test rejection'); END")
            .execute(&pool).await.unwrap();
        assert!(
            super::AuthToken::create_keyed_delegated(&pool, "u1", "d1", "key")
                .await
                .is_err()
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    use super::*;

    async fn setup() -> DbPool {
        let pool = connect(":memory:").await.unwrap();
        // sqlx in-memory needs a single connection to share state
        pool
    }

    #[tokio::test]
    async fn device_quota_is_atomic_and_account_scoped() {
        let pool = connect(":memory:").await.unwrap();
        UserRow::create(&pool, "quota-a", "a").await.unwrap();
        UserRow::create(&pool, "quota-b", "b").await.unwrap();
        for index in 0..63 {
            DeviceRow::upsert(
                &pool,
                &format!("device-{index}"),
                "quota-a",
                "Device",
                None,
                None,
            )
            .await
            .unwrap();
        }
        let (first, second) = tokio::join!(
            DeviceRow::upsert(&pool, "last-a", "quota-a", "Device", None, None),
            DeviceRow::upsert(&pool, "last-b", "quota-a", "Device", None, None),
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        DeviceRow::upsert(&pool, "device-0", "quota-a", "Renamed", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&pool, "new", "quota-b", "Device", None, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn token_quota_preserves_idempotent_replays_and_other_accounts() {
        let pool = connect(":memory:").await.unwrap();
        UserRow::create(&pool, "a", "a").await.unwrap();
        UserRow::create(&pool, "b", "b").await.unwrap();
        DeviceRow::upsert(&pool, "device", "a", "Device", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&pool, "device", "b", "Device", None, None)
            .await
            .unwrap();
        let original = AuthToken::create_idempotent(&pool, "a", "device", "replay")
            .await
            .unwrap();
        for _ in 1..256 {
            AuthToken::create(&pool, "a", "device").await.unwrap();
        }
        assert!(AuthToken::create(&pool, "a", "device").await.is_err());
        assert_eq!(
            AuthToken::create_idempotent(&pool, "a", "device", "replay")
                .await
                .unwrap()
                .token,
            original.token
        );
        AuthToken::create(&pool, "b", "device").await.unwrap();
        sqlx::query("DELETE FROM auth_tokens WHERE token = ?")
            .bind(&original.token)
            .execute(&pool)
            .await
            .unwrap();
        AuthToken::create(&pool, "a", "device").await.unwrap();
    }

    #[tokio::test]
    async fn admin_connection_preserves_live_server_presence_projection() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("relay.db");
        let db_path = db_path.to_str().unwrap();
        let runtime_pool = connect(db_path).await.unwrap();
        UserRow::create(&runtime_pool, "u1", "alice").await.unwrap();
        DeviceRow::upsert(&runtime_pool, "d1", "u1", "Laptop", None, None)
            .await
            .unwrap();
        DeviceRow::set_online(&runtime_pool, "u1", "d1", true)
            .await
            .unwrap();

        let admin_pool = connect_for_admin(db_path).await.unwrap();
        let rows = DeviceRow::list_by_user(&admin_pool, "u1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].online, 1);
    }

    #[tokio::test]
    async fn token_create_and_find() {
        let pool = setup().await;
        UserRow::create(&pool, "u1", "alice").await.unwrap();
        DeviceRow::upsert(&pool, "d1", "u1", "Laptop", None, None)
            .await
            .unwrap();
        let tok = AuthToken::create(&pool, "u1", "d1").await.unwrap();
        let found = AuthToken::find(&pool, &tok.token).await.unwrap();
        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.user_id, "u1");
        assert!(found.is_device_token());

        let delegated = AuthToken::create_delegated(&pool, "u1", "d1")
            .await
            .unwrap();
        let delegated = AuthToken::find(&pool, &delegated.token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delegated.token_kind, "delegated_control");
        assert!(!delegated.is_device_token());

        let missing = AuthToken::find(&pool, "nonexistent").await.unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn the_same_install_device_id_is_isolated_between_accounts() {
        let pool = setup().await;
        UserRow::create(&pool, "u1", "alice").await.unwrap();
        UserRow::create(&pool, "u2", "bob").await.unwrap();

        DeviceRow::upsert(&pool, "shared-install", "u1", "Alice laptop", None, None)
            .await
            .unwrap();
        DeviceRow::upsert(&pool, "shared-install", "u2", "Bob laptop", None, None)
            .await
            .unwrap();
        let token_u1 = AuthToken::create(&pool, "u1", "shared-install")
            .await
            .unwrap();
        let token_u2 = AuthToken::create(&pool, "u2", "shared-install")
            .await
            .unwrap();

        assert_eq!(DeviceRow::list_by_user(&pool, "u1").await.unwrap().len(), 1);
        assert_eq!(DeviceRow::list_by_user(&pool, "u2").await.unwrap().len(), 1);
        DeviceRow::delete_for_user(&pool, "u1", "shared-install")
            .await
            .unwrap();
        assert!(AuthToken::find(&pool, &token_u1.token)
            .await
            .unwrap()
            .is_none());
        assert!(AuthToken::find(&pool, &token_u2.token)
            .await
            .unwrap()
            .is_some());
        assert_eq!(DeviceRow::list_by_user(&pool, "u2").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn legacy_global_device_schema_is_migrated_without_ambiguous_tokens() {
        let db_path = std::env::temp_dir().join(format!(
            "openbitfun-relay-device-migration-{}-{}.db",
            std::process::id(),
            rand::random::<u64>()
        ));
        let db_path_text = db_path.to_string_lossy().to_string();
        let legacy_options = SqliteConnectOptions::from_str(&format!("sqlite://{db_path_text}"))
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(false);
        let legacy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(legacy_options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE users (\
               user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,\
               salt TEXT NOT NULL, kdf_salt TEXT NOT NULL, argon2_params TEXT NOT NULL,\
               password_hash TEXT NOT NULL, wrapped_master_key TEXT NOT NULL,\
               failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,\
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\
             )",
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE devices (\
               device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),\
               device_name TEXT, public_key TEXT, last_seen_at INTEGER,\
               online INTEGER NOT NULL DEFAULT 0\
             )",
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE auth_tokens (\
               token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),\
               device_id TEXT NOT NULL REFERENCES devices(device_id),\
               created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL\
             )",
        )
        .execute(&legacy)
        .await
        .unwrap();
        for (user_id, username) in [("u1", "alice"), ("u2", "bob")] {
            sqlx::query(
                "INSERT INTO users \
                 (user_id, username, salt, kdf_salt, argon2_params, password_hash,\
                  wrapped_master_key, created_at, updated_at) \
                 VALUES (?, ?, 's', 'ks', '{}', 'hash', 'wmk', 1, 1)",
            )
            .bind(user_id)
            .bind(username)
            .execute(&legacy)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO devices (device_id, user_id, device_name, online) \
             VALUES ('shared-install', 'u2', 'Bob laptop', 1)",
        )
        .execute(&legacy)
        .await
        .unwrap();
        let consistent_token = "a".repeat(64);
        let inconsistent_token = "b".repeat(64);
        for (token, user_id) in [(&consistent_token, "u2"), (&inconsistent_token, "u1")] {
            sqlx::query(
                "INSERT INTO auth_tokens \
                 (token, user_id, device_id, created_at, expires_at) \
                 VALUES (?, ?, 'shared-install', 1, 4102444800)",
            )
            .bind(token)
            .bind(user_id)
            .execute(&legacy)
            .await
            .unwrap();
        }
        legacy.close().await;

        let migrated = connect(&db_path_text).await.unwrap();
        assert!(AuthToken::find(&migrated, &consistent_token)
            .await
            .unwrap()
            .is_some());
        assert!(AuthToken::find(&migrated, &inconsistent_token)
            .await
            .unwrap()
            .is_none());
        DeviceRow::upsert(
            &migrated,
            "shared-install",
            "u1",
            "Alice laptop",
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            DeviceRow::list_by_user(&migrated, "u1")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            DeviceRow::list_by_user(&migrated, "u2")
                .await
                .unwrap()
                .len(),
            1
        );
        migrated.close().await;
        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn reopening_a_database_keeps_the_device_kind_column_and_its_values() {
        let db_path = std::env::temp_dir().join(format!(
            "openbitfun-relay-device-kind-migration-{}-{}.db",
            std::process::id(),
            rand::random::<u64>()
        ));
        let db_path_text = db_path.to_string_lossy().to_string();

        let first = connect(&db_path_text).await.unwrap();
        UserRow::create(&first, "u1", "alice").await.unwrap();
        DeviceRow::upsert(
            &first,
            "phone",
            "u1",
            "Phone",
            Some(DEVICE_KIND_MOBILE),
            None,
        )
        .await
        .unwrap();
        first.close().await;

        // The ALTER runs on every startup and must tolerate the column already
        // being there, rather than failing the whole boot.
        let second = connect(&db_path_text).await.unwrap();
        let rows = DeviceRow::list_by_user(&second, "u1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].device_kind.as_deref(), Some(DEVICE_KIND_MOBILE));
        second.close().await;
        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn legacy_pages_receive_nonempty_authorization_generations() {
        let db_path = std::env::temp_dir().join(format!(
            "openbitfun-relay-page-generation-migration-{}-{}.db",
            std::process::id(),
            rand::random::<u64>()
        ));
        let db_path_text = db_path.to_string_lossy().to_string();
        let legacy_options = SqliteConnectOptions::from_str(&format!("sqlite://{db_path_text}"))
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(false);
        let legacy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(legacy_options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE users (\
               user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,\
               salt TEXT NOT NULL, kdf_salt TEXT NOT NULL, argon2_params TEXT NOT NULL,\
               password_hash TEXT NOT NULL, wrapped_master_key TEXT NOT NULL,\
               failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,\
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\
             )",
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE pages (\
               user_id TEXT NOT NULL REFERENCES users(user_id), slug TEXT NOT NULL,\
               visibility TEXT NOT NULL DEFAULT 'private', title TEXT NOT NULL DEFAULT '',\
               file_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,\
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,\
               PRIMARY KEY (user_id, slug)\
             )",
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO users \
             (user_id, username, salt, kdf_salt, argon2_params, password_hash, \
              wrapped_master_key, created_at, updated_at) \
             VALUES ('u1', 'alice', 's', 'ks', '{}', 'hash', 'wmk', 1, 1)",
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pages \
             (user_id, slug, visibility, title, file_count, total_bytes, created_at, updated_at) \
             VALUES ('u1', 'legacy', 'private', 'Legacy', 0, 0, 1, 1)",
        )
        .execute(&legacy)
        .await
        .unwrap();
        legacy.close().await;

        let migrated = connect(&db_path_text).await.unwrap();
        let page = PageRow::get(&migrated, "u1", "legacy")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(page.generation.len(), 32);
        assert!(page.generation.bytes().all(|byte| byte.is_ascii_hexdigit()));
        migrated.close().await;
        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn page_ensure_version_deploy_and_resolve() {
        let pool = setup().await;
        UserRow::create(&pool, "u1", "alice").await.unwrap();
        PageRow::ensure(&pool, "u1", "my-site", PageVisibility::Public, "My Site")
            .await
            .unwrap();
        PageVersionRow::insert(
            &pool, "u1", "my-site", "vabc", "My Site", 3, 1024, false, "first",
        )
        .await
        .unwrap();
        PageRow::set_deployed_version(&pool, "u1", "my-site", "vabc", 3, 1024, "My Site")
            .await
            .unwrap();

        let listed = PageRow::list_for_user(&pool, "u1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].deployed_version_id.as_deref(), Some("vabc"));

        let versions = PageVersionRow::list_for_page(&pool, "u1", "my-site")
            .await
            .unwrap();
        assert_eq!(versions.len(), 1);

        let by_name = PageRow::get_by_username(&pool, "alice", "my-site")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_name.user_id, "u1");
        assert_eq!(by_name.deployed_version_id.as_deref(), Some("vabc"));

        page_kv::put(&pool, "u1", "my-site", "k", "v")
            .await
            .unwrap();
        assert_eq!(
            page_kv::get(&pool, "u1", "my-site", "k")
                .await
                .unwrap()
                .as_deref(),
            Some("v")
        );

        assert_eq!(
            PageRow::delete(&pool, "u1", "my-site", &listed[0].generation)
                .await
                .unwrap(),
            PageMutationOutcome::Applied(())
        );
        assert!(PageRow::get(&pool, "u1", "my-site")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn page_version_metadata_and_lifecycle_mutations_are_atomic() {
        let pool = setup().await;
        UserRow::create(&pool, "u1", "alice").await.unwrap();
        PageRow::ensure(
            &pool,
            "u1",
            "atomic-site",
            PageVisibility::Private,
            "Old title",
        )
        .await
        .unwrap();
        let original = PageRow::get(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .unwrap();
        PageVersionRow::insert(
            &pool,
            "u1",
            "atomic-site",
            "vold",
            "Old title",
            1,
            10,
            false,
            "",
        )
        .await
        .unwrap();

        let limited = PageRow::save_version_with_meta(
            &pool,
            "u1",
            "atomic-site",
            PageVisibility::Public,
            "New title",
            "vnew",
            2,
            20,
            false,
            "new",
            None,
            50,
            1,
            Some(&original.generation),
            false,
        )
        .await
        .unwrap();
        assert_eq!(limited, SavePageVersionOutcome::VersionLimitReached);
        let unchanged = PageRow::get(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.visibility, "private");
        assert_eq!(unchanged.title, "Old title");
        assert_eq!(unchanged.generation, original.generation);
        assert!(PageVersionRow::get(&pool, "u1", "atomic-site", "vnew")
            .await
            .unwrap()
            .is_none());

        assert_eq!(
            PageRow::save_version_with_meta(
                &pool,
                "u1",
                "atomic-site",
                PageVisibility::Public,
                "New title",
                "vnew",
                2,
                20,
                false,
                "new",
                None,
                50,
                2,
                Some(&original.generation),
                false,
            )
            .await
            .unwrap(),
            SavePageVersionOutcome::Saved
        );
        let updated = PageRow::get(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.visibility, "public");
        assert_eq!(updated.title, "New title");
        assert_eq!(updated.generation, original.generation);

        let deployed =
            match PageRow::deploy_version(&pool, "u1", "atomic-site", "vnew", &original.generation)
                .await
                .unwrap()
            {
                PageMutationOutcome::Applied(page) => page,
                outcome => panic!("unexpected deploy outcome: {outcome:?}"),
            };
        assert_eq!(deployed.deployed_version_id.as_deref(), Some("vnew"));
        assert_eq!(
            PageVersionRow::delete_if_not_deployed(
                &pool,
                "u1",
                "atomic-site",
                "vnew",
                &original.generation,
            )
            .await
            .unwrap(),
            DeletePageVersionOutcome::Deployed
        );
        assert_eq!(
            PageVersionRow::delete_if_not_deployed(
                &pool,
                "u1",
                "atomic-site",
                "vold",
                &original.generation,
            )
            .await
            .unwrap(),
            DeletePageVersionOutcome::Deleted
        );

        assert_eq!(
            PageRow::delete(&pool, "u1", "atomic-site", &original.generation)
                .await
                .unwrap(),
            PageMutationOutcome::Applied(())
        );
        PageRow::ensure(
            &pool,
            "u1",
            "atomic-site",
            PageVisibility::Private,
            "Recreated",
        )
        .await
        .unwrap();
        let recreated = PageRow::get(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .unwrap();
        assert_ne!(recreated.generation, original.generation);

        assert_eq!(
            PageRow::migrate_legacy_version(
                &pool,
                "u1",
                "atomic-site",
                &original.generation,
                "v1",
                "Old title",
                1,
                10,
                false,
            )
            .await
            .unwrap(),
            PageMutationOutcome::GenerationMismatch
        );
        assert!(PageVersionRow::list_for_page(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .is_empty());
        let after_stale_migration = PageRow::get(&pool, "u1", "atomic-site")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after_stale_migration.title, "Recreated");
        assert!(after_stale_migration.deployed_version_id.is_none());
        assert!(matches!(
            PageRow::update_meta(
                &pool,
                "u1",
                "atomic-site",
                &original.generation,
                Some(PageVisibility::Public),
                Some("stale"),
            )
            .await
            .unwrap(),
            PageMutationOutcome::GenerationMismatch
        ));
        assert_eq!(
            PageRow::delete(&pool, "u1", "atomic-site", &original.generation)
                .await
                .unwrap(),
            PageMutationOutcome::GenerationMismatch
        );
    }
}
