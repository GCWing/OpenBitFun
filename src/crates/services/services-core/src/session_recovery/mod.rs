//! Offline, conservative recovery of sessions damaged by directory/brand migrations.
//! No runtime, SSH connection, permission policy or application host is started here.
mod engine;
mod identity;
#[cfg(test)]
mod tests;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub use engine::{apply, rollback, task_phase};
pub const FORMAT_VERSION: u32 = 1;
const CONTROLS: &[&str] = &[
    "index.json",
    "product-search-v1.sqlite",
    "product-search-v1.sqlite-wal",
    "product-search-v1.sqlite-shm",
];
type Catalog = BTreeMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairPlan {
    pub version: u32,
    pub home: PathBuf,
    pub user_root: PathBuf,
    pub registry_sha256: String,
    pub operations: Vec<RepairOperation>,
    pub diagnostics: Vec<RepairDiagnostic>,
    pub catalogs: BTreeMap<PathBuf, Catalog>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairOperation {
    pub source: PathBuf,
    pub target: PathBuf,
    pub session_id: String,
    pub session_name: String,
    pub workspace_id: String,
    pub workspace_path: String,
    pub sha256: String,
    pub repaired_sha256: String,
    pub updates: BTreeMap<String, FileUpdate>,
    pub identity_changes: Vec<IdentityChange>,
    pub assets: Vec<Asset>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUpdate {
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityChange {
    pub file: String,
    pub field: String,
    pub before: Value,
    pub after: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Asset {
    pub source: PathBuf,
    pub target: PathBuf,
    pub sha256: String,
    pub existed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairDiagnostic {
    pub source: PathBuf,
    pub status: String,
    pub reason: Option<String>,
}

pub fn read_plan(task: &Path) -> Result<RepairPlan> {
    safe(task, task)?;
    let plan: RepairPlan = serde_json::from_slice(&read(&task.join("plan.json"))?)?;
    ensure!(
        plan.version == FORMAT_VERSION,
        "Unsupported session repair plan version"
    );
    Ok(plan)
}

/// Scan is read-only. Malformed or ambiguous identities become diagnostics.
pub fn scan(home: &Path, user_root: &Path, cancelled: impl Fn() -> bool) -> Result<RepairPlan> {
    safe(home, home)?;
    safe(user_root, user_root)?;
    let (records, registry_sha256) = identity::registry(user_root)?;
    let aliases = identity::aliases(home, &records)?;
    let mut plan = RepairPlan {
        version: FORMAT_VERSION,
        home: home.into(),
        user_root: user_root.into(),
        registry_sha256,
        operations: vec![],
        diagnostics: vec![],
        catalogs: BTreeMap::new(),
    };
    let mut roots = Vec::new();
    for runtime in children(&home.join("projects"))? {
        if runtime.is_dir() {
            roots.push(runtime.join("sessions"));
        }
    }
    collect_remote_roots(&home.join("remote_ssh"), &mut roots)?;
    for root in roots {
        ensure!(!cancelled(), "Repair cancelled at a safe boundary");
        if !root.is_dir() {
            continue;
        }
        let result = (|| -> Result<()> {
            safe(&root, home)?;
            plan.catalogs.insert(root.clone(), catalog(&root)?);
            for source in children(&root)? {
                ensure!(!cancelled(), "Repair cancelled at a safe boundary");
                if !source.is_dir() {
                    continue;
                }
                let operation = (|| -> Result<Option<RepairOperation>> {
                    safe(&source, home)?;
                    let sid = filename(&source)?;
                    ensure!(safe_id(&sid), "Invalid session directory name");
                    let documents = documents(&source)?;
                    let owner = identity::owner(&source, documents.clone(), &records, &aliases)?;
                    let target = home
                        .join("projects")
                        .join(identity::runtime_key(&records[&owner.id])?)
                        .join("sessions")
                        .join(&sid);
                    safe(&target, home)?;
                    let mut updates = BTreeMap::new();
                    let mut identity_changes = vec![];
                    for (name, repaired) in &owner.documents {
                        if documents[name] != *repaired {
                            updates.insert(
                                name.clone(),
                                FileUpdate {
                                    before: read(&source.join(name))?,
                                    after: encode(repaired)?,
                                },
                            );
                            changes(name, "", &documents[name], repaired, &mut identity_changes);
                        }
                    }
                    if target == source && updates.is_empty() {
                        return Ok(None);
                    }
                    ensure!(
                        source == target || !target.exists(),
                        "Destination session already exists: {}",
                        target.display()
                    );
                    plan.catalogs.insert(
                        target.parent().unwrap().into(),
                        catalog(target.parent().unwrap())?,
                    );
                    let sha256 = tree_hash(&source, &BTreeMap::new())?;
                    let repaired_sha256 = tree_hash(&source, &update_side(&updates, false))?;
                    let assets = identity::snapshot_assets(&source, &target, &owner)?;
                    Ok(Some(RepairOperation {
                        source: source.clone(),
                        target,
                        session_id: sid,
                        session_name: owner.metadata.session_name,
                        workspace_id: owner.id,
                        workspace_path: owner.root,
                        sha256,
                        repaired_sha256,
                        updates,
                        identity_changes,
                        assets,
                    }))
                })();
                match operation {
                    Ok(Some(operation)) => plan.operations.push(operation),
                    Ok(None) => plan.diagnostics.push(RepairDiagnostic {
                        source,
                        status: "correct".into(),
                        reason: None,
                    }),
                    Err(error) => plan.diagnostics.push(RepairDiagnostic {
                        source,
                        status: "skipped".into(),
                        reason: Some(error.to_string()),
                    }),
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            plan.diagnostics.push(RepairDiagnostic {
                source: root,
                status: "skipped".into(),
                reason: Some(error.to_string()),
            });
        }
    }
    ensure!(!cancelled(), "Repair cancelled at a safe boundary");
    let mut targets: BTreeMap<PathBuf, usize> = BTreeMap::new();
    let mut assets: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    for operation in &plan.operations {
        *targets.entry(operation.target.clone()).or_default() += 1;
        for asset in &operation.assets {
            assets
                .entry(asset.target.clone())
                .or_default()
                .insert(asset.sha256.clone());
        }
    }
    plan.operations.retain(|operation| {
        if targets[&operation.target] > 1
            || operation.assets.iter().any(|a| assets[&a.target].len() > 1)
        {
            plan.diagnostics.push(RepairDiagnostic {
                source: operation.source.clone(),
                status: "skipped".into(),
                reason: Some(
                    "Multiple sessions claim conflicting destinations or snapshots".into(),
                ),
            });
            false
        } else {
            true
        }
    });
    let affected: BTreeSet<PathBuf> = plan
        .operations
        .iter()
        .flat_map(|o| {
            [
                o.source.parent().unwrap().into(),
                o.target.parent().unwrap().into(),
            ]
        })
        .collect();
    plan.catalogs.retain(|root, _| affected.contains(root));
    Ok(plan)
}

pub fn save_plan(task: &Path, plan: &RepairPlan) -> Result<()> {
    outside_data(task, plan)?;
    ensure!(!task.exists(), "Repair task already exists");
    fs::create_dir_all(task)?;
    write(&task.join("plan.json"), &encode(plan)?)
}

fn collect_remote_roots(path: &Path, roots: &mut Vec<PathBuf>) -> Result<()> {
    safe(path, path)?;
    if !path.is_dir() {
        return Ok(());
    }
    if filename(path)? == "sessions" {
        roots.push(path.into());
        return Ok(());
    }
    for child in children(path)? {
        if child.is_dir() {
            collect_remote_roots(&child, roots)?;
        }
    }
    Ok(())
}
fn changes(file: &str, field: &str, before: &Value, after: &Value, out: &mut Vec<IdentityChange>) {
    if let (Some(left), Some(right)) = (before.as_object(), after.as_object()) {
        let keys: BTreeSet<_> = left.keys().chain(right.keys()).collect();
        for key in keys {
            changes(
                file,
                &if field.is_empty() {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                },
                &before[key],
                &after[key],
                out,
            );
        }
    } else if before != after {
        out.push(IdentityChange {
            file: file.into(),
            field: field.into(),
            before: before.clone(),
            after: after.clone(),
        });
    }
}
fn documents(path: &Path) -> Result<BTreeMap<String, Value>> {
    let mut values = BTreeMap::from([("metadata.json".into(), json(&path.join("metadata.json"))?)]);
    if path.join("state.json").exists() {
        values.insert("state.json".into(), json(&path.join("state.json"))?);
    }
    Ok(values)
}
fn metadata(path: &Path, raw: Value) -> Result<crate::session::SessionMetadata> {
    ensure!(
        raw.get("schema_version")
            .is_none_or(|value| value.as_u64() == Some(2)),
        "Unsupported metadata schema"
    );
    let metadata: crate::session::SessionMetadata =
        serde_json::from_value(raw).context("Invalid session metadata")?;
    ensure!(
        metadata.session_id == filename(path)?,
        "Metadata session ID does not match its directory"
    );
    Ok(metadata)
}
fn catalog(path: &Path) -> Result<Catalog> {
    let mut result = BTreeMap::new();
    for child in children(path)? {
        if child.is_dir() && child.join("metadata.json").exists() {
            let sid = filename(&child)?;
            ensure!(safe_id(&sid), "Invalid session ID");
            metadata(&child, json(&child.join("metadata.json"))?)?;
            result.insert(sid, file_hash(&child.join("metadata.json"))?);
        }
    }
    Ok(result)
}
fn index_bytes(path: &Path) -> Result<Vec<u8>> {
    let mut entries = Vec::new();
    for id in catalog(path)?.keys() {
        entries.push(metadata(
            &path.join(id),
            json(&path.join(id).join("metadata.json"))?,
        )?);
    }
    // Use the product owner for visibility, aliases, counters and schema.
    encode(&crate::session::build_session_index_snapshot(entries, now_ms()).0)
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn filename(path: &Path) -> Result<String> {
    Ok(path
        .file_name()
        .and_then(|s| s.to_str())
        .context("Non-UTF8 storage path")?
        .into())
}
fn safe(path: &Path, root: &Path) -> Result<()> {
    ensure!(
        path.is_absolute() && root.is_absolute() && path.starts_with(root),
        "Storage path escapes its root: {}",
        path.display()
    );
    ensure!(
        !path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir)),
        "Ambiguous storage path"
    );
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(info) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    info.file_type().is_symlink() || info.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let linked = info.file_type().is_symlink();
                ensure!(
                    !linked,
                    "Linked/reparse paths are unsupported: {}",
                    ancestor.display()
                );
                ensure!(
                    info.is_dir() || info.is_file(),
                    "Special files are unsupported"
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn outside_data(path: &Path, plan: &RepairPlan) -> Result<()> {
    safe(path, path)?;
    for root in [&plan.home, &plan.user_root] {
        ensure!(
            !path.starts_with(root) && !root.starts_with(path),
            "Repair backup must be outside product data"
        );
    }
    Ok(())
}
fn children(path: &Path) -> Result<Vec<PathBuf>> {
    safe(path, path)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut result = fs::read_dir(path)?
        .map(|r| r.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    result.sort();
    for child in &result {
        safe(child, path)?;
    }
    Ok(result)
}
fn read(path: &Path) -> Result<Vec<u8>> {
    safe(path, path)?;
    ensure!(path.is_file(), "Missing regular file: {}", path.display());
    Ok(fs::read(path)?)
}
fn json(path: &Path) -> Result<Value> {
    let raw = read(path)?;
    Ok(
        serde_json::from_slice(raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw))
            .with_context(|| format!("Invalid JSON: {}", path.display()))?,
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String> {
    use std::io::Read;
    safe(path, path)?;
    ensure!(path.is_file(), "Missing regular file: {}", path.display());
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn optional_hash(path: &Path) -> Result<Option<String>> {
    safe(path, path)?;
    if path.exists() {
        Ok(Some(file_hash(path)?))
    } else {
        Ok(None)
    }
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    safe(path, path)?;
    // Reuse the owner strict atomic replacement, including Windows sharing semantics.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(
            crate::json_store::JsonFileStore.write_bytes_atomic_strict(path, bytes.to_vec()),
        )?;
    Ok(())
}
fn tree_hash(root: &Path, overrides: &BTreeMap<String, Vec<u8>>) -> Result<String> {
    fn visit(
        root: &Path,
        path: &Path,
        overrides: &BTreeMap<String, Vec<u8>>,
        out: &mut BTreeMap<String, Option<String>>,
    ) -> Result<()> {
        for child in children(path)? {
            let relative = child
                .strip_prefix(root)?
                .to_str()
                .context("Non-UTF8 path")?
                .replace('\\', "/");
            if child.is_dir() {
                out.insert(relative, None);
                visit(root, &child, overrides, out)?;
            } else {
                out.insert(
                    relative.clone(),
                    Some(match overrides.get(&relative) {
                        Some(bytes) => hash(bytes),
                        None => file_hash(&child)?,
                    }),
                );
            }
        }
        Ok(())
    }
    safe(root, root)?;
    ensure!(root.is_dir(), "Session directory is unavailable");
    let mut entries = BTreeMap::new();
    visit(root, root, overrides, &mut entries)?;
    Ok(hash(&encode(&entries)?))
}
fn update_side(updates: &BTreeMap<String, FileUpdate>, before: bool) -> BTreeMap<String, Vec<u8>> {
    updates
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                if before {
                    value.before.clone()
                } else {
                    value.after.clone()
                },
            )
        })
        .collect()
}
