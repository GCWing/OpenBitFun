//! Cooperative host resource capacity. Policy and owner registration share one
//! atomic transaction; live ownership is an OS lock, never a timestamp/PID.

use crate::exclusive_file_lease::{ExclusiveFileLease, ExclusiveFileLeaseError};
use crate::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceCapacityPolicy {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub limit: Option<NonZeroU32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCapacitySnapshot {
    pub policy: ResourceCapacityPolicy,
    pub active: u32,
}

#[derive(Debug)]
pub struct ResourceCapacityLease {
    _owner: ExclusiveFileLease,
}

#[derive(Debug, Clone)]
pub struct ResourceCapacityStore {
    directory: PathBuf,
}

impl ResourceCapacityStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn resource_dir(&self, resource: &str) -> PathBuf {
        self.directory
            .join(format!("{:x}", Sha256::digest(resource.as_bytes())))
    }

    async fn read(&self, resource: &str) -> Result<Value, String> {
        let raw = JsonFileStore
            .read_optional::<Value>(&self.resource_dir(resource).join("capacity.json"))
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| json!({"version":1,"owners":[]}));
        decode(&raw)?;
        Ok(raw)
    }

    pub async fn policy(&self, resource: &str) -> Result<ResourceCapacityPolicy, String> {
        decode(&self.read(resource).await?).map(|(policy, _)| policy)
    }

    /// Compare and update policy without killing existing holders. Lowering a
    /// limit blocks new admission until the actual live count falls below it.
    pub async fn set_policy(
        &self,
        resource: &str,
        expected_revision: u64,
        limit: Option<NonZeroU32>,
    ) -> Result<ResourceCapacityPolicy, String> {
        let store = self.clone();
        let resource = resource.to_string();
        tokio::spawn(async move {
            store
                .set_policy_owned(&resource, expected_revision, limit)
                .await
        })
        .await
        .map_err(|error| error.to_string())?
    }

    async fn set_policy_owned(
        &self,
        resource: &str,
        expected_revision: u64,
        limit: Option<NonZeroU32>,
    ) -> Result<ResourceCapacityPolicy, String> {
        let path = self.resource_dir(resource).join("capacity.json");
        let _transaction = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut raw = self.read(resource).await?;
        let (current, _) = decode(&raw)?;
        if current.revision != expected_revision {
            return Err("RESOURCE_CAPACITY_POLICY_CONFLICT: resource policy changed; existing data was preserved".into());
        }
        if current.limit == limit {
            return Ok(current);
        }
        let policy = ResourceCapacityPolicy {
            revision: current
                .revision
                .checked_add(1)
                .ok_or_else(|| "Resource capacity policy revision overflow".to_string())?,
            limit,
        };
        raw["policy"]["revision"] = json!(policy.revision);
        raw["policy"]["limit"] = json!(policy.limit);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .map_err(|error| error.to_string())?;
        Ok(policy)
    }

    pub async fn snapshot(&self, resource: &str) -> Result<ResourceCapacitySnapshot, String> {
        let raw = self.read(resource).await?;
        let (policy, owners) = decode(&raw)?;
        let directory = self.resource_dir(resource);
        let active = tokio::task::spawn_blocking(move || live_owners(&directory, owners, false))
            .await
            .map_err(|error| error.to_string())??
            .len();
        Ok(ResourceCapacitySnapshot {
            policy,
            active: u32::try_from(active)
                .map_err(|_| "Resource capacity owner count overflow".to_string())?,
        })
    }

    pub async fn try_acquire(
        &self,
        resource: &str,
    ) -> Result<Option<ResourceCapacityLease>, String> {
        // Once accepted, finish the atomic transaction even if the waiter is
        // cancelled. Its returned guard is then dropped by the detached task.
        // The JSON transaction lock must outlive every underlying file write.
        let store = self.clone();
        let resource = resource.to_string();
        tokio::spawn(async move { store.try_acquire_owned(&resource).await })
            .await
            .map_err(|error| error.to_string())?
    }

    async fn try_acquire_owned(
        &self,
        resource: &str,
    ) -> Result<Option<ResourceCapacityLease>, String> {
        let directory = self.resource_dir(resource);
        let path = directory.join("capacity.json");
        let _transaction = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut raw = self.read(resource).await?;
        let (policy, owners) = decode(&raw)?;
        let previous_count = owners.len();
        let probe_directory = directory.clone();
        let mut live =
            tokio::task::spawn_blocking(move || live_owners(&probe_directory, owners, true))
                .await
                .map_err(|error| error.to_string())??;
        if policy
            .limit
            .is_some_and(|limit| live.len() >= limit.get() as usize)
        {
            if live.len() != previous_count {
                raw["owners"] = Value::Array(live);
                JsonFileStore
                    .write_atomic_strict(&path, &raw)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let owner_path = directory.join(format!("{id}.lease"));
        let owner =
            tokio::task::spawn_blocking(move || ExclusiveFileLease::try_acquire(&owner_path))
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
        live.push(json!({"id":id}));
        raw["owners"] = Value::Array(live);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Some(ResourceCapacityLease { _owner: owner }))
    }

    /// Dropping this future stops waiting. No capacity is held during a wait;
    /// cancellation after registration drops the OS guard, making it reclaimable.
    pub async fn acquire(&self, resource: &str) -> Result<ResourceCapacityLease, String> {
        loop {
            if let Some(lease) = self.try_acquire(resource).await? {
                return Ok(lease);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
}

fn decode(raw: &Value) -> Result<(ResourceCapacityPolicy, Vec<Value>), String> {
    if raw.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported resource capacity version; existing data was preserved".into());
    }
    let policy = raw
        .get("policy")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            format!("Invalid resource capacity policy; existing data was preserved: {error}")
        })?
        .unwrap_or_default();
    let owners = raw.get("owners").and_then(Value::as_array).ok_or_else(|| {
        "Invalid resource capacity owners; existing data was preserved".to_string()
    })?;
    let mut seen = HashSet::new();
    for owner in owners {
        let id = owner.get("id").and_then(Value::as_str).ok_or_else(|| {
            "Missing resource lease identity; existing data was preserved".to_string()
        })?;
        let parsed = uuid::Uuid::parse_str(id).map_err(|_| {
            "Invalid resource lease identity; existing data was preserved".to_string()
        })?;
        if parsed.get_version_num() != 4 || parsed.to_string() != id || !seen.insert(id) {
            return Err(
                "Invalid or duplicate resource lease identity; existing data was preserved".into(),
            );
        }
    }
    Ok((policy, owners.clone()))
}

fn live_owners(
    directory: &std::path::Path,
    owners: Vec<Value>,
    cleanup: bool,
) -> Result<Vec<Value>, String> {
    let mut live = Vec::new();
    for owner in owners {
        // decode validated the identity before it can become a path.
        let path = directory.join(format!(
            "{}.lease",
            owner["id"].as_str().expect("validated identity")
        ));
        if !path.try_exists().map_err(|error| error.to_string())? {
            continue;
        }
        match ExclusiveFileLease::try_acquire(&path) {
            Err(ExclusiveFileLeaseError::InUse) => live.push(owner),
            Ok(probe) => {
                drop(probe);
                if cleanup {
                    match std::fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Child(std::process::Child);

    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[tokio::test]
    async fn capacity_process_fixture() {
        let Some(directory) = std::env::var_os("OPENBITFUN_CAPACITY_FIXTURE_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let store = ResourceCapacityStore::new(directory.join("capacity"));
        let _holder = store.acquire("resource").await.unwrap();
        tokio::fs::write(directory.join("ready"), b"ready")
            .await
            .unwrap();
        // Parent kills the process without dropping this guard.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }

    #[tokio::test]
    async fn another_process_observes_capacity_and_crash_releases_without_a_timeout() {
        use std::time::{Duration, Instant};
        let directory = tempfile::tempdir().unwrap();
        let store = ResourceCapacityStore::new(directory.path().join("capacity"));
        store
            .set_policy("resource", 0, NonZeroU32::new(1))
            .await
            .unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = Child(
            command
                .args([
                    "--exact",
                    "resource_capacity::tests::capacity_process_fixture",
                    "--nocapture",
                ])
                .env("OPENBITFUN_CAPACITY_FIXTURE_DIR", directory.path())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.path().join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "capacity child exited early"
            );
            assert!(Instant::now() < deadline, "capacity child did not acquire");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(store.snapshot("resource").await.unwrap().active, 1);
        assert!(store.try_acquire("resource").await.unwrap().is_none());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let restarted = ResourceCapacityStore::new(directory.path().join("capacity"));
        let _holder = restarted
            .try_acquire("resource")
            .await
            .unwrap()
            .expect("OS released the crashed owner");
        assert_eq!(restarted.snapshot("resource").await.unwrap().active, 1);
        assert!(restarted.try_acquire("resource").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unlimited_holders_remain_counted_when_policy_is_lowered_and_waiters_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let store = ResourceCapacityStore::new(dir.path().join("capacity"));
        assert_eq!(store.snapshot("account").await.unwrap().active, 0);
        assert!(!dir.path().join("capacity").exists());
        let first = store.acquire("account").await.unwrap();
        let second = store.acquire("account").await.unwrap();
        let policy = store
            .set_policy("account", 0, NonZeroU32::new(1))
            .await
            .unwrap();
        assert_eq!(policy.revision, 1);
        assert_eq!(store.snapshot("account").await.unwrap().active, 2);
        assert!(store.try_acquire("account").await.unwrap().is_none());
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(50),
            store.acquire("account")
        )
        .await
        .is_err());
        drop(first);
        assert!(store.try_acquire("account").await.unwrap().is_none());
        drop(second);
        let restarted = ResourceCapacityStore::new(dir.path().join("capacity"));
        let _third = restarted.acquire("account").await.unwrap();
        assert_eq!(restarted.snapshot("account").await.unwrap().active, 1);
        assert_eq!(restarted.snapshot("other-account").await.unwrap().active, 0);
    }

    #[tokio::test]
    async fn simultaneous_instances_cannot_overbook_and_policy_edits_use_compare_exchange() {
        let dir = tempfile::tempdir().unwrap();
        let a = ResourceCapacityStore::new(dir.path().into());
        let b = a.clone();
        a.set_policy("account", 0, NonZeroU32::new(1))
            .await
            .unwrap();
        let (x, y) = tokio::join!(a.try_acquire("account"), b.try_acquire("account"));
        assert_eq!(
            usize::from(x.as_ref().unwrap().is_some()) + usize::from(y.as_ref().unwrap().is_some()),
            1
        );
        assert!(b
            .set_policy("account", 0, NonZeroU32::new(3))
            .await
            .unwrap_err()
            .contains("CONFLICT"));
        assert_eq!(a.policy("account").await.unwrap().limit, NonZeroU32::new(1));
        drop((x, y));
        assert!(b.try_acquire("account").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn old_shapes_and_unknown_fields_survive_and_invalid_state_never_resets() {
        let dir = tempfile::tempdir().unwrap();
        let store = ResourceCapacityStore::new(dir.path().into());
        let directory = store.resource_dir("account");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join("capacity.json");
        JsonFileStore
            .write_atomic_strict(&path, &json!({"version":1,"owners":[],"future":true}))
            .await
            .unwrap();
        assert_eq!(
            store.policy("account").await.unwrap(),
            ResourceCapacityPolicy::default()
        );
        store
            .set_policy("account", 0, NonZeroU32::new(1))
            .await
            .unwrap();
        let _holder = store.acquire("account").await.unwrap();
        let mut raw = store.read("account").await.unwrap();
        raw["policy"]["future"] = json!("keep");
        raw["owners"][0]["future"] = json!(123);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .unwrap();
        store
            .set_policy("account", 1, NonZeroU32::new(2))
            .await
            .unwrap();
        let _another = store.acquire("account").await.unwrap();
        let after = store.read("account").await.unwrap();
        assert_eq!(after["future"], true);
        assert_eq!(after["policy"]["future"], "keep");
        assert_eq!(after["owners"][0]["future"], 123);
        for bytes in [
            b"broken".as_slice(),
            b"{\"version\":99,\"owners\":[]}",
            b"{\"version\":1,\"policy\":{\"limit\":0},\"owners\":[]}",
            b"{\"version\":1,\"owners\":[{\"id\":\"../bad\"}]}",
        ] {
            tokio::fs::write(&path, bytes).await.unwrap();
            assert!(store.try_acquire("account").await.is_err());
            assert!(store.snapshot("account").await.is_err());
            assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
        }
    }
}
