//! Application control preferences. A remembered grant never selects or shares a window.
// Migrated from computer-use-rust/grants.rs. OpenBitFun supplies its own
// product-isolated path and preserves additive fields written by newer versions.
#[derive(Debug)]
pub(crate) struct GrantError {
    pub code: String,
    message: String,
    details: Option<serde_json::Value>,
}
impl GrantError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
    fn details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}
impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}
impl std::error::Error for GrantError {}
impl From<std::io::Error> for GrantError {
    fn from(error: std::io::Error) -> Self {
        Self::new("grant_io", error.to_string())
    }
}
impl From<serde_json::Error> for GrantError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("invalid_grant_store", error.to_string())
    }
}
type Result<T> = std::result::Result<T, GrantError>;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const STORE_VERSION: u32 = 1;
// A local preference file has a bounded parsing/serialization allocation budget.
const MAX_STORE_BYTES: u64 = 1024 * 1024;
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantIdentity {
    pub bundle_id: Option<String>,
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub input_mode: String,
    #[serde(default, flatten)]
    pub extensions: std::collections::BTreeMap<String, serde_json::Value>,
}

impl GrantIdentity {
    /// Call only after the sharing boundary verifies the selected process lifetime.
    /// Hashing runs on the native worker, never on the UI thread.
    /// This identifies the on-disk executable, not the process's mapped image or
    /// its loaded libraries. Unix metadata change time also has to predate the
    /// process, because an updater can preserve mtime while replacing the file.
    pub(crate) fn capture(
        bundle_id: Option<String>,
        executable: &Path,
        input_mode: &str,
        process_started: SystemTime,
    ) -> Result<Self> {
        validate_mode(input_mode)?;
        if !executable.is_absolute() {
            return Err(GrantError::new(
                "grant_identity_unavailable",
                "A remembered grant requires an absolute executable path",
            ));
        }
        let canonical = executable.canonicalize()?;
        let mut file = File::open(&canonical)?;
        let before = file.metadata()?;
        if !before.is_file() || changed_after_process_start(&before, process_started)? {
            return Err(GrantError::new(
                "grant_identity_unavailable",
                "The executable is not a regular file or its content or metadata changed after this process started; restart the app before remembering control",
            ));
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let after = file.metadata()?;
        let at_path = fs::metadata(&canonical)?;
        if !same_file_version(&before, &after)
            || !same_file_version(&after, &at_path)
            || executable.canonicalize()? != canonical
        {
            return Err(GrantError::new(
                "grant_identity_changed",
                "The executable changed while its authorization identity was being read",
            ));
        }
        let identity = Self {
            bundle_id,
            executable: canonical,
            executable_sha256: format!("{:x}", digest.finalize()),
            input_mode: input_mode.into(),
            extensions: Default::default(),
        };
        identity.validate()?;
        Ok(identity)
    }

    fn validate(&self) -> Result<()> {
        validate_mode(&self.input_mode)?;
        if !self.executable.is_absolute()
            || self.executable_sha256.len() != 64
            || !self
                .executable_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.bundle_id.as_ref().is_some_and(|id| id.is_empty())
        {
            return Err(GrantError::new(
                "invalid_grant_store",
                "A remembered grant has an invalid application identity",
            ));
        }
        Ok(())
    }
}

fn changed_after_process_start(metadata: &Metadata, process_started: SystemTime) -> Result<bool> {
    if metadata.modified()? > process_started {
        return Ok(true);
    }
    #[cfg(unix)]
    {
        use std::{os::unix::fs::MetadataExt, time::Duration};
        let invalid_time = || {
            GrantError::new(
                "grant_identity_unavailable",
                "The executable metadata change time cannot be verified",
            )
        };
        let nanoseconds = u32::try_from(metadata.ctime_nsec())
            .ok()
            .filter(|value| *value < 1_000_000_000)
            .ok_or_else(invalid_time)?;
        let seconds = metadata.ctime();
        let whole_seconds = Duration::from_secs(seconds.unsigned_abs());
        let base = if seconds >= 0 {
            UNIX_EPOCH.checked_add(whole_seconds)
        } else {
            UNIX_EPOCH.checked_sub(whole_seconds)
        };
        let changed = base
            .and_then(|base| base.checked_add(Duration::from_nanos(u64::from(nanoseconds))))
            .ok_or_else(invalid_time)?;
        Ok(changed > process_started)
    }
    #[cfg(not(unix))]
    {
        Ok(false)
    }
}

fn validate_mode(mode: &str) -> Result<()> {
    if matches!(mode, "foreground" | "background") {
        Ok(())
    } else {
        Err(GrantError::new("invalid_grant_store", "Unknown input mode"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GrantRecord {
    pub identity: GrantIdentity,
    /// A presentation label only; it is never used to match an application.
    pub application_name: String,
    pub granted_at_unix_ms: u64,
    #[serde(default, flatten)]
    pub extensions: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct Document {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    grants: Vec<GrantRecord>,
    #[serde(default, flatten)]
    extensions: std::collections::BTreeMap<String, serde_json::Value>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

pub(crate) struct GrantStore {
    extensions: std::collections::BTreeMap<String, serde_json::Value>,
    path: PathBuf,
    records: Vec<GrantRecord>,
    loaded_bytes: Option<Vec<u8>>,
}

#[derive(Debug)]
pub(crate) struct Persisted {
    #[cfg(test)]
    pub backup: Option<PathBuf>,
    /// Rename completed. A durability/unlock error must not pretend it rolled back.
    pub warning: Option<String>,
}

impl GrantStore {
    pub(crate) fn load(path: PathBuf) -> Result<Self> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err(GrantError::new(
                "invalid_grant_path",
                "The grant file must have an absolute filesystem path",
            ));
        }
        let loaded_bytes = read_store(&path)?;
        let (records, extensions) = match &loaded_bytes {
            None => (Vec::new(), Default::default()),
            Some(bytes) => {
                let document: Document = serde_json::from_slice(bytes)
                    .map_err(|error| GrantError::new("invalid_grant_store", error.to_string()))?;
                if document.version != STORE_VERSION {
                    return Err(GrantError::new(
                        "unsupported_grant_store",
                        format!("Unsupported grant file version {}", document.version),
                    ));
                }
                for (index, grant) in document.grants.iter().enumerate() {
                    grant.identity.validate()?;
                    if document.grants[..index]
                        .iter()
                        .any(|prior| prior.identity == grant.identity)
                    {
                        return Err(GrantError::new(
                            "invalid_grant_store",
                            "Duplicate application authorization identity",
                        ));
                    }
                }
                (document.grants, document.extensions)
            }
        };
        Ok(Self {
            path,
            records,
            loaded_bytes,
            extensions,
        })
    }

    pub(crate) fn records(&self) -> &[GrantRecord] {
        &self.records
    }

    pub(crate) fn contains(&self, identity: &GrantIdentity) -> bool {
        self.records.iter().any(|grant| &grant.identity == identity)
    }

    pub(crate) fn remember(
        &mut self,
        identity: GrantIdentity,
        application_name: String,
    ) -> Result<Persisted> {
        identity.validate()?;
        if self.contains(&identity) {
            return Ok(Persisted {
                #[cfg(test)]
                backup: None,
                warning: None,
            });
        }
        let mut records = self.records.clone();
        records.push(GrantRecord {
            identity,
            application_name,
            granted_at_unix_ms: unix_millis()?,
            extensions: Default::default(),
        });
        self.persist(records)
    }

    pub(crate) fn forget(&mut self, identity: &GrantIdentity) -> Result<Persisted> {
        let mut records = self.records.clone();
        records.retain(|grant| &grant.identity != identity);
        if records.len() == self.records.len() {
            return Ok(Persisted {
                #[cfg(test)]
                backup: None,
                warning: None,
            });
        }
        self.persist(records)
    }

    fn persist(&mut self, records: Vec<GrantRecord>) -> Result<Persisted> {
        let mut bytes = serde_json::to_vec_pretty(&Document {
            version: STORE_VERSION,
            extensions: self.extensions.clone(),
            grants: records.clone(),
        })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(GrantError::new(
                "capacity_exceeded",
                "Remembered grants exceed the 1 MiB preference-file budget",
            ));
        }
        let parent = self.path.parent().expect("absolute file has parent");
        create_private_directories(parent)?;
        // An OS lock survives an atomic data-file replacement and is released on
        // crash/exit. Keeping the lock inode avoids stale or split lock ownership.
        let lock = open_lock(&lock_path(&self.path))?;
        lock.try_lock().map_err(|error| {
            GrantError::new(
                "grant_store_busy",
                format!("Another writer holds the grant file: {error}"),
            )
        })?;
        if read_store(&self.path)? != self.loaded_bytes {
            return Err(GrantError::new(
                "grant_store_changed",
                "The grant file changed in another process; reload it before editing",
            ));
        }
        let backup = self
            .loaded_bytes
            .as_ref()
            .map(|original| write_unique(&self.path, "backup", original))
            .transpose()?;
        let temporary = write_unique(&self.path, "tmp", &bytes)?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let cleanup = fs::remove_file(&temporary).err();
            return Err(GrantError::new("grant_store_write", error.to_string()).details(json!({
                "temporary_path":temporary,"temporary_cleanup_error":cleanup.map(|error|error.to_string()),"backup":backup
            })));
        }
        self.records = records;
        self.loaded_bytes = Some(bytes);
        let mut warnings = Vec::new();
        if let Err(error) = File::open(parent).and_then(|directory| directory.sync_all()) {
            warnings.push(format!(
                "Saved grant file, but directory sync failed: {error}"
            ));
        }
        if let Err(error) = lock.unlock() {
            warnings.push(format!(
                "Saved grant file, but explicit lock release failed: {error}"
            ));
        }
        Ok(Persisted {
            #[cfg(test)]
            backup,
            warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
        })
    }
}

fn unix_millis() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
        .ok_or_else(|| GrantError::new("invalid_clock", "Cannot record the authorization time"))
}

fn same_file_version(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.len() == right.len()
            && left.mtime() == right.mtime()
            && left.mtime_nsec() == right.mtime_nsec()
            && left.ctime() == right.ctime()
            && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len() && left.modified().ok() == right.modified().ok()
    }
}

fn require_private_regular(metadata: &Metadata) -> Result<()> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(GrantError::new(
            "invalid_grant_store",
            "The grant path must be a regular file, not a symlink",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(GrantError::new(
                "invalid_grant_store",
                "Grant and lock files must have private permissions (0600)",
            ));
        }
    }
    Ok(())
}

fn read_store(path: &Path) -> Result<Option<Vec<u8>>> {
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    require_private_regular(&before)?;
    if before.len() > MAX_STORE_BYTES {
        return Err(GrantError::new(
            "capacity_exceeded",
            "Grant file exceeds 1 MiB",
        ));
    }
    let file = File::open(path)?;
    let opened = file.metadata()?;
    if !same_file_version(&before, &opened) {
        return Err(GrantError::new(
            "grant_store_changed",
            "Grant file changed while opening",
        ));
    }
    let mut bytes = Vec::new();
    (&file).take(MAX_STORE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STORE_BYTES
        || !same_file_version(&opened, &file.metadata()?)
        || !same_file_version(&opened, &fs::symlink_metadata(path)?)
    {
        return Err(GrantError::new(
            "grant_store_changed",
            "Grant file changed while reading",
        ));
    }
    Ok(Some(bytes))
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .expect("absolute grant path has filename")
        .to_os_string();
    name.push(".lock");
    path.with_file_name(name)
}

fn open_lock(path: &Path) -> Result<File> {
    match private_options().create_new(true).open(path) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let before = fs::symlink_metadata(path)?;
            require_private_regular(&before)?;
            let file = private_options().open(path)?;
            if !same_file_version(&before, &file.metadata()?) {
                return Err(GrantError::new(
                    "grant_store_changed",
                    "Grant lock changed while opening",
                ));
            }
            Ok(file)
        }
        Err(error) => Err(error.into()),
    }
}

fn create_private_directories(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

fn write_unique(path: &Path, kind: &str, bytes: &[u8]) -> Result<PathBuf> {
    let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    let mut name = path
        .file_name()
        .expect("absolute grant path has filename")
        .to_os_string();
    name.push(format!(
        ".{kind}-{}-{}-{sequence}",
        std::process::id(),
        unix_millis()?
    ));
    let destination = path.with_file_name(name);
    let mut file = private_options().create_new(true).open(&destination)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let cleanup = fs::remove_file(&destination).err();
        return Err(
            GrantError::new("grant_store_write", error.to_string()).details(json!({
                "path":destination,"cleanup_error":cleanup.map(|error|error.to_string())
            })),
        );
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_missing_version_and_future_additive_fields_survive_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grants.json");
        let id = identity(directory.path(), "background");
        GrantStore::load(path.clone())
            .unwrap()
            .remember(id.clone(), "Old app".into())
            .unwrap();
        let document = json!({"future_document": {"keep": true}, "grants": [{
            "identity": id, "application_name": "Old app", "granted_at_unix_ms": 1, "future_record": 7
        }]});
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let mut store = GrantStore::load(path.clone()).unwrap();
        assert!(store.contains(&id));
        let second = identity(directory.path(), "foreground");
        store.remember(second, "Second mode".into()).unwrap();
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["future_document"], document["future_document"]);
        assert_eq!(written["grants"][0]["future_record"], 7);
        let mut future = written;
        future["grants"][0]["identity"]["future_identity_requirement"] = json!("unknown");
        fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();
        let reloaded = GrantStore::load(path).unwrap();
        assert!(
            !reloaded.contains(&id),
            "unknown identity constraints must never broaden an old grant"
        );
        assert_eq!(
            reloaded.records()[0].identity.extensions["future_identity_requirement"],
            "unknown"
        );
    }
    use std::time::Duration;

    fn identity(directory: &Path, mode: &str) -> GrantIdentity {
        let executable = directory.join("application");
        if !executable.exists() {
            fs::write(&executable, b"executable version one").unwrap();
        }
        GrantIdentity::capture(
            Some("test.application".into()),
            &executable,
            mode,
            SystemTime::now() + Duration::from_secs(1),
        )
        .unwrap()
    }

    #[test]
    fn persists_exact_identity_and_mode_then_revokes_with_original_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences/grants.json");
        let id = identity(directory.path(), "foreground");
        let mut store = GrantStore::load(path.clone()).unwrap();
        assert!(!path.exists());
        store.remember(id.clone(), "My Application".into()).unwrap();
        let original = fs::read(&path).unwrap();
        let mut reopened = GrantStore::load(path.clone()).unwrap();
        assert!(reopened.contains(&id));
        let mut changed = id.clone();
        changed.input_mode = "background".into();
        assert!(!reopened.contains(&changed));
        changed = id.clone();
        changed.bundle_id = Some("another.application".into());
        assert!(!reopened.contains(&changed));
        changed = id.clone();
        changed.executable = directory.path().join("another");
        assert!(!reopened.contains(&changed));
        changed = id.clone();
        changed.executable_sha256 = "f".repeat(64);
        assert!(!reopened.contains(&changed));
        let saved = reopened.forget(&id).unwrap();
        assert_eq!(fs::read(saved.backup.unwrap()).unwrap(), original);
        assert!(!GrantStore::load(path.clone()).unwrap().contains(&id));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn changed_binary_and_binary_newer_than_process_need_a_new_grant() {
        let directory = tempfile::tempdir().unwrap();
        let first = identity(directory.path(), "foreground");
        fs::write(&first.executable, b"executable version two").unwrap();
        let second = identity(directory.path(), "foreground");
        assert_ne!(first, second);
        assert!(GrantIdentity::capture(None, &first.executable, "foreground", UNIX_EPOCH).is_err());
    }

    #[test]
    fn corrupt_and_concurrently_changed_files_are_never_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grants.json");
        let id = identity(directory.path(), "foreground");
        let mut first = GrantStore::load(path.clone()).unwrap();
        let mut stale = GrantStore::load(path.clone()).unwrap();
        first.remember(id.clone(), "App".into()).unwrap();
        let original = fs::read(&path).unwrap();
        assert_eq!(
            stale.remember(id.clone(), "App".into()).unwrap_err().code,
            "grant_store_changed"
        );
        assert!(stale.records().is_empty());
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, b"{broken").unwrap();
        assert!(GrantStore::load(path.clone()).is_err());
        assert!(first.forget(&id).is_err());
        assert!(first.contains(&id));
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }

    #[test]
    fn lock_contention_keeps_old_memory_and_disk_and_recovers_after_owner_drops() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grants.json");
        let id = identity(directory.path(), "foreground");
        let mut store = GrantStore::load(path.clone()).unwrap();
        store.remember(id.clone(), "App".into()).unwrap();
        let original = fs::read(&path).unwrap();
        let lock = open_lock(&lock_path(&path)).unwrap();
        lock.try_lock().unwrap();
        assert_eq!(store.forget(&id).unwrap_err().code, "grant_store_busy");
        assert!(store.contains(&id));
        assert_eq!(fs::read(&path).unwrap(), original);
        drop(lock);
        store.forget(&id).unwrap();
        assert!(!store.contains(&id));
    }
}
