//! Same-volume, journaled file changes for the standalone maintenance host.
//! Backups are never owned by an automatically deleted temporary directory.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub(super) const WORK_DIR: &str = ".openbitfun-maintenance";
pub(super) const LOCK_FILE: &str = ".openbitfun-maintenance.lock";
pub(super) const INVENTORY: &str = ".openbitfun-installed.json";

#[derive(Serialize, Deserialize)]
struct Entry {
    path: String,
    original: bool,
    replacement: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    schema: u32,
    committed: bool,
    entries: Vec<Entry>,
    #[serde(default)]
    integrations: Option<serde_json::Value>,
}

pub(super) struct Transaction {
    root: PathBuf,
    work: PathBuf,
    _lock: File,
    journal: Journal,
    restore_integrations: fn(&Path, &serde_json::Value) -> Result<(), String>,
}

pub(super) fn relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    // Backslashes are separators in Windows payloads even on a Unix test host.
    if raw.is_empty() || raw.contains(':') || raw.starts_with(['/', '\\']) {
        return Err(format!("Invalid installed file path: {raw}"));
    }
    let normalized = raw.replace('\\', "/");
    #[cfg(windows)]
    if normalized.split('/').any(|part| {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        part.ends_with([' ', '.'])
            || part.chars().any(|c| c.is_control())
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|number| {
                    number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
                })
    }) {
        return Err(format!("Ambiguous Windows installed file path: {raw}"));
    }
    if normalized
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || normalized.eq_ignore_ascii_case(WORK_DIR)
        || normalized
            .to_lowercase()
            .starts_with(&format!("{WORK_DIR}/"))
        || normalized.eq_ignore_ascii_case(LOCK_FILE)
    {
        return Err(format!(
            "Installed file escapes its managed directory: {raw}"
        ));
    }
    Ok(PathBuf::from(normalized))
}

fn checked_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                #[cfg(windows)]
                let redirected = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let redirected = meta.file_type().is_symlink();
                if redirected {
                    return Err(format!(
                        "Refusing redirected installed path: {}",
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect {}: {error}", current.display())),
        }
    }
    Ok(current)
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

impl Transaction {
    pub(super) fn open(root: &Path) -> Result<Self, String> {
        Self::open_with_recovery(root, |_, _| {
            Err("Integration recovery is unavailable".into())
        })
    }

    pub(super) fn open_with_recovery(
        root: &Path,
        restore_integrations: fn(&Path, &serde_json::Value) -> Result<(), String>,
    ) -> Result<Self, String> {
        if !root.is_absolute()
            || root.parent().is_none()
            || root.components().any(|c| matches!(c, Component::ParentDir))
        {
            return Err("Maintenance requires an absolute installation directory".into());
        }
        fs::create_dir_all(root)
            .map_err(|e| format!("Cannot create installation directory: {e}"))?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let parent = root
            .parent()
            .ok_or("Installation has no parent directory")?;
        let name = root
            .file_name()
            .ok_or("Installation has no directory name")?
            .to_string_lossy();
        let lock_path = checked_path(parent, Path::new(&format!(".{name}.maintenance.lock")))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("Cannot open maintenance lock: {e}"))?;
        lock.try_lock()
            .map_err(|_| "Another maintenance operation is already in progress".to_string())?;
        let work = checked_path(&root, Path::new(WORK_DIR))?;
        let journal_path = checked_path(&work, Path::new("journal.json"))?;
        let journal = match fs::read(&journal_path) {
            Ok(bytes) => {
                let journal: Journal = serde_json::from_slice(&bytes).map_err(|e| {
                    format!(
                        "Maintenance journal is unreadable; preserved at {}: {e}",
                        work.display()
                    )
                })?;
                if journal.schema != 1 {
                    return Err(format!(
                        "Unsupported maintenance journal; preserved at {}",
                        work.display()
                    ));
                }
                journal
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Journal {
                schema: 1,
                committed: false,
                entries: vec![],
                integrations: None,
            },
            Err(e) => return Err(format!("Cannot read maintenance journal: {e}")),
        };
        let mut transaction = Self {
            root,
            work,
            _lock: lock,
            journal,
            restore_integrations,
        };
        if transaction.journal.committed {
            transaction.clean_work()?;
        } else if !transaction.journal.entries.is_empty()
            || transaction.journal.integrations.is_some()
        {
            transaction.rollback()?;
        } else if transaction.work.exists() {
            // An interruption before publication can leave staging but no backups.
            if transaction.work.join("backup").exists() {
                return Err(format!(
                    "Unrecorded maintenance backup; repair required at {}",
                    transaction.work.display()
                ));
            }
            transaction.clean_work()?;
        }
        fs::create_dir_all(transaction.stage()).map_err(|e| e.to_string())?;
        Ok(transaction)
    }

    pub(super) fn stage(&self) -> PathBuf {
        self.work.join("stage")
    }

    pub(super) fn snapshot_integrations(
        &mut self,
        snapshot: serde_json::Value,
    ) -> Result<(), String> {
        self.journal.integrations = Some(snapshot);
        self.persist()
    }

    pub(super) fn publish(
        &mut self,
        replacements: &[String],
        removals: &[String],
    ) -> Result<(), String> {
        if !self.journal.entries.is_empty() {
            return Err("Maintenance already prepared".into());
        }
        let mut all = std::collections::BTreeMap::new();
        for raw in removals {
            all.insert(raw.to_lowercase(), (raw.clone(), false));
        }
        for raw in replacements {
            all.insert(raw.to_lowercase(), (raw.clone(), true));
        }
        // Prepare the entire journal before the first rename, including validation
        // of every destination. A locked executable never leaves a half-install.
        for (_, (raw, replace)) in all {
            let relative = relative_path(&raw)?;
            let target = checked_path(&self.root, &relative)?;
            if target.exists() && !target.is_file() {
                return Err(format!(
                    "Installed file is not a regular file: {}",
                    target.display()
                ));
            }
            let replacement = if replace {
                Some(digest(&checked_path(&self.stage(), &relative)?)?)
            } else {
                None
            };
            self.journal.entries.push(Entry {
                path: raw,
                original: target.exists(),
                replacement,
            });
        }
        self.persist()?;
        let result = self.apply();
        if let Err(error) = result {
            return match self.rollback() {
                Ok(()) => Err(format!("{error}. Previous files were restored")),
                Err(rollback) => Err(format!(
                    "{error}. Recovery failed: {rollback}. Backups preserved at {}",
                    self.work.display()
                )),
            };
        }
        Ok(())
    }

    fn apply(&self) -> Result<(), String> {
        // Back up *all* old files before publishing any replacement. Failure to
        // move a running Windows binary therefore restores only old file names.
        for entry in &self.journal.entries {
            let relative = relative_path(&entry.path)?;
            if entry.original {
                let backup = checked_path(&self.work.join("backup"), &relative)?;
                fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(checked_path(&self.root, &relative)?, backup).map_err(|e| {
                    format!(
                        "Cannot back up {} (close the application and retry): {e}",
                        entry.path
                    )
                })?;
            }
        }
        for entry in &self.journal.entries {
            if entry.replacement.is_some() {
                let relative = relative_path(&entry.path)?;
                let target = checked_path(&self.root, &relative)?;
                fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(checked_path(&self.stage(), &relative)?, target)
                    .map_err(|e| format!("Cannot publish {}: {e}", entry.path))?;
            }
        }
        Ok(())
    }

    pub(super) fn rollback(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        for entry in self.journal.entries.iter().rev() {
            let relative = relative_path(&entry.path)?;
            let target = checked_path(&self.root, &relative)?;
            let backup = checked_path(&self.work.join("backup"), &relative)?;
            if backup.exists() || !entry.original {
                if target.exists() {
                    if entry.replacement.as_deref() != Some(digest(&target)?.as_str()) {
                        failures.push(format!(
                            "{} was modified after maintenance started",
                            entry.path
                        ));
                        continue;
                    }
                    if let Err(e) = fs::remove_file(&target) {
                        failures.push(e.to_string());
                        continue;
                    }
                }
                if backup.exists() {
                    if let Err(e) = fs::rename(&backup, &target) {
                        failures.push(format!("restore {}: {e}", entry.path));
                    }
                }
            }
        }
        if let Some(snapshot) = &self.journal.integrations {
            if let Err(error) = (self.restore_integrations)(&self.root, snapshot) {
                failures.push(error);
            }
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        self.clean_work()?;
        self.journal.entries.clear();
        self.journal.integrations = None;
        Ok(())
    }

    pub(super) fn commit(&mut self) -> Result<bool, String> {
        self.journal.committed = true;
        if let Err(error) = self.persist() {
            self.journal.committed = false;
            return match self.rollback() {
                Ok(()) => Err(format!(
                    "Cannot commit maintenance; previous installation restored: {error}"
                )),
                Err(recovery) => Err(format!(
                    "Cannot commit maintenance: {error}; recovery retained at {}: {recovery}",
                    self.work.display()
                )),
            };
        }
        // Cleanup is not allowed to turn a committed installation into a
        // reported failure or to trigger rollback. Retry it on the next open.
        match self.clean_work() {
            Ok(()) => Ok(true),
            Err(error) => {
                log::warn!("Maintenance cleanup pending: {error}");
                Ok(false)
            }
        }
    }

    fn persist(&self) -> Result<(), String> {
        fs::create_dir_all(&self.work).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(&self.work).map_err(|e| e.to_string())?;
        temp.write_all(&serde_json::to_vec(&self.journal).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(self.work.join("journal.json"))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn clean_work(&self) -> Result<(), String> {
        // Never follow links while recursively deleting our own transaction tree.
        fn remove_tree(path: &Path) -> Result<(), String> {
            if !path.exists() {
                return Ok(());
            }
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                checked_path(path, Path::new(&entry.file_name()))?;
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    remove_tree(&entry.path())?;
                } else {
                    fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                }
            }
            fs::remove_dir(path).map_err(|e| e.to_string())
        }
        remove_tree(&self.work)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(transaction: &Transaction, name: &str, bytes: &[u8]) {
        let target = transaction.stage().join(name);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }

    #[test]
    fn interruption_restores_old_files_and_removes_only_new_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("app.exe"), b"old").unwrap();
        fs::write(temp.path().join("user.txt"), b"user").unwrap();
        {
            let mut tx = Transaction::open(temp.path()).unwrap();
            staged(&tx, "app.exe", b"new");
            staged(&tx, "runtime/new.js", b"new runtime");
            tx.publish(&["app.exe".into(), "runtime/new.js".into()], &[])
                .unwrap();
            // No commit: simulate process death, releasing only the OS lock.
        }
        let _recovered = Transaction::open(temp.path()).unwrap();
        assert_eq!(fs::read(temp.path().join("app.exe")).unwrap(), b"old");
        assert!(!temp.path().join("runtime/new.js").exists());
        assert_eq!(fs::read(temp.path().join("user.txt")).unwrap(), b"user");
    }

    #[test]
    fn committed_replacement_removes_obsolete_owned_files_only() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("obsolete.js"), b"old").unwrap();
        let mut tx = Transaction::open(temp.path()).unwrap();
        staged(&tx, "app.exe", b"new");
        tx.publish(&["app.exe".into()], &["obsolete.js".into()])
            .unwrap();
        tx.commit().unwrap();
        drop(tx);
        let _next = Transaction::open(temp.path()).unwrap();
        assert_eq!(fs::read(temp.path().join("app.exe")).unwrap(), b"new");
        assert!(!temp.path().join("obsolete.js").exists());
    }

    #[test]
    fn second_writer_is_refused_without_deleting_the_first_lock() {
        let temp = tempfile::tempdir().unwrap();
        let first = Transaction::open(temp.path()).unwrap();
        assert!(Transaction::open(temp.path()).is_err());
        drop(first);
        assert!(Transaction::open(temp.path()).is_ok());
    }

    #[test]
    fn modified_replacement_keeps_recovery_backup() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("app.exe"), b"old").unwrap();
        let mut tx = Transaction::open(temp.path()).unwrap();
        staged(&tx, "app.exe", b"new");
        tx.publish(&["app.exe".into()], &[]).unwrap();
        fs::write(temp.path().join("app.exe"), b"unexpected").unwrap();
        assert!(tx.rollback().is_err());
        assert_eq!(fs::read(tx.work.join("backup/app.exe")).unwrap(), b"old");
    }

    #[test]
    fn rejects_root_relative_drive_relative_and_parent_entries() {
        for path in [
            "",
            "/etc/a",
            "\\outside",
            "C:outside",
            "C:\\outside",
            "a/../b",
            "a\\..\\b",
            WORK_DIR,
            LOCK_FILE,
        ] {
            assert!(relative_path(path).is_err(), "accepted {path}");
        }
        assert!(relative_path("frontend/dist/index.html").is_ok());
        #[cfg(windows)]
        for path in ["a/.. /outside", "NUL", "COM1.txt", "trailing."] {
            assert!(relative_path(path).is_err(), "accepted {path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_publication_into_another_directory() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("user.txt"), b"preserve").unwrap();
        let status = super::super::commands::create_windows_silent_command(super::super::commands::system_powershell().unwrap())
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:OPENBITFUN_TEST_LINK -Target $env:OPENBITFUN_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .env("OPENBITFUN_TEST_LINK", root.path().join("redirect"))
            .env("OPENBITFUN_TEST_TARGET", outside.path()).status().unwrap();
        assert!(status.success());
        let mut tx = Transaction::open(root.path()).unwrap();
        staged(&tx, "redirect/user.txt", b"replacement");
        assert!(tx
            .publish(&["redirect/user.txt".into()], &[])
            .unwrap_err()
            .contains("redirected"));
        assert_eq!(
            fs::read(outside.path().join("user.txt")).unwrap(),
            b"preserve"
        );
    }

    #[test]
    fn unreadable_unknown_and_unrecorded_recovery_data_are_preserved() {
        for data in [
            b"invalid".as_slice(),
            br#"{"schema":99,"committed":false,"entries":[]}"#,
        ] {
            let temp = tempfile::tempdir().unwrap();
            fs::create_dir(temp.path().join(WORK_DIR)).unwrap();
            let journal = temp.path().join(WORK_DIR).join("journal.json");
            fs::write(&journal, data).unwrap();
            assert!(Transaction::open(temp.path()).is_err());
            assert_eq!(fs::read(journal).unwrap(), data);
        }
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join(WORK_DIR).join("backup");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("app.exe"), b"only copy").unwrap();
        assert!(Transaction::open(temp.path()).is_err());
        assert_eq!(fs::read(backup.join("app.exe")).unwrap(), b"only copy");
    }

    #[cfg(windows)]
    #[test]
    fn occupied_file_restores_every_earlier_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.js"), b"old runtime").unwrap();
        fs::write(temp.path().join("z.exe"), b"old app").unwrap();
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(temp.path().join("z.exe"))
            .unwrap();
        let mut tx = Transaction::open(temp.path()).unwrap();
        staged(&tx, "a.js", b"new runtime");
        staged(&tx, "z.exe", b"new app");
        assert!(tx.publish(&["a.js".into(), "z.exe".into()], &[]).is_err());
        drop(locked);
        assert_eq!(fs::read(temp.path().join("a.js")).unwrap(), b"old runtime");
        assert_eq!(fs::read(temp.path().join("z.exe")).unwrap(), b"old app");
    }

    #[cfg(windows)]
    #[test]
    fn mapped_uninstaller_defers_cleanup_without_reversing_a_committed_removal() {
        use std::process::{Child, Stdio};
        struct Running(Child);
        impl Drop for Running {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let ping = PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap()).join("System32/ping.exe");
        let mapped = temp.path().join("uninstall.exe");
        fs::copy(ping, &mapped).unwrap();
        let running = Running(
            super::super::commands::create_windows_silent_command(&mapped)
                .args(["-n", "30", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut tx = Transaction::open(temp.path()).unwrap();
        tx.publish(&[], &["uninstall.exe".into()]).unwrap();
        assert!(
            !tx.commit().unwrap(),
            "the mapped image must report pending cleanup"
        );
        assert!(!mapped.exists());
        assert!(tx.work.join("backup/uninstall.exe").exists());
        drop(tx);
        drop(running);
        let mut recovered = Transaction::open(temp.path()).unwrap();
        assert!(
            !mapped.exists(),
            "cleanup must not restore an already committed removal"
        );
        assert!(recovered.commit().unwrap());
    }
}
