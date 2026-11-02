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
const FINGERPRINT_KIND: &str = "directory-layout-v1";
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
    pub fingerprint_kind: String,
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
        plan.version == FORMAT_VERSION && plan.fingerprint_kind == FINGERPRINT_KIND,
        "Unsupported session repair plan version"
    );
    Ok(plan)
}

/// Scan is read-only. Malformed or ambiguous identities become diagnostics.
pub fn scan(home: &Path, user_root: &Path, cancelled: impl Fn() -> bool) -> Result<RepairPlan> {
    scan_with_progress(home, user_root, cancelled, |_, _, _, _| {})
}

pub fn scan_with_progress(
    home: &Path,
    user_root: &Path,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(usize, usize, &str, &Path),
) -> Result<RepairPlan> {
    safe(home, home)?;
    safe(user_root, user_root)?;
    let (records, registry_sha256) = identity::registry(user_root)?;
    let aliases = identity::aliases(home, &records)?;
    let mut plan = RepairPlan {
        version: FORMAT_VERSION,
        fingerprint_kind: FINGERPRINT_KIND.into(),
        home: home.into(),
        user_root: user_root.into(),
        registry_sha256,
        operations: vec![],
        diagnostics: vec![],
        catalogs: BTreeMap::new(),
    };
    let mut roots = Vec::new();
    let mut catalog_cache: BTreeMap<PathBuf, CatalogSnapshot> = BTreeMap::new();
    for runtime in children(&home.join("projects"))? {
        if runtime.is_dir() {
            roots.push(runtime.join("sessions"));
        }
    }
    collect_remote_roots(&home.join("remote_ssh"), &mut roots)?;
    let total_sessions = roots
        .iter()
        .map(|root| {
            children(root).map(|entries| entries.iter().filter(|path| path.is_dir()).count())
        })
        .sum::<Result<usize>>()?;
    let mut completed_sessions = 0;
    for root in roots {
        ensure!(!cancelled(), "Repair cancelled at a safe boundary");
        if !root.is_dir() {
            continue;
        }
        let session_dirs = children(&root)?;
        let result = (|| -> Result<()> {
            safe(&root, home)?;
            let source_catalog = cached_catalog(&root, &mut catalog_cache)?;
            plan.catalogs
                .insert(root.clone(), source_catalog.catalog.clone());
            for source in session_dirs {
                ensure!(!cancelled(), "Repair cancelled at a safe boundary");
                if !source.is_dir() {
                    continue;
                }
                let operation = (|| -> Result<Option<RepairOperation>> {
                    safe(&source, home)?;
                    let sid = filename(&source)?;
                    ensure!(safe_id(&sid), "Invalid session directory name");
                    let cached_metadata = source_catalog
                        .entries
                        .get(&sid)
                        .context("Session metadata is absent from catalog")?;
                    let documents = documents(&source, Some(cached_metadata))?;
                    let owner = identity::owner(
                        &source,
                        documents.clone(),
                        &records,
                        &aliases,
                        Some(cached_metadata),
                    )?;
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
                                    before: if name == "metadata.json" {
                                        cached_metadata.raw.clone()
                                    } else {
                                        read(&source.join(name))?
                                    },
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
                    let target_catalog =
                        cached_catalog(target.parent().unwrap(), &mut catalog_cache)?;
                    plan.catalogs.insert(
                        target.parent().unwrap().into(),
                        target_catalog.catalog.clone(),
                    );
                    let (sha256, repaired_sha256) = directory_fingerprint_pair(
                        &source,
                        &BTreeMap::new(),
                        &update_side(&updates, false),
                    )?;
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
                let progress_path = source.clone();
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
                completed_sessions += 1;
                progress(
                    completed_sessions,
                    total_sessions,
                    "scanning_sessions",
                    &progress_path,
                );
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
#[derive(Debug, Clone)]
struct CatalogEntry {
    raw: Vec<u8>,
    value: Value,
    metadata: crate::session::SessionMetadata,
}

#[derive(Debug, Clone)]
struct CatalogSnapshot {
    catalog: Catalog,
    entries: BTreeMap<String, CatalogEntry>,
}

fn documents(path: &Path, metadata: Option<&CatalogEntry>) -> Result<BTreeMap<String, Value>> {
    let metadata = match metadata {
        Some(entry) => entry.value.clone(),
        None => json(&path.join("metadata.json"))?,
    };
    let mut values = BTreeMap::from([("metadata.json".into(), metadata)]);
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
    Ok(catalog_snapshot(path)?.catalog)
}
fn catalog_snapshot(path: &Path) -> Result<CatalogSnapshot> {
    let mut catalog = BTreeMap::new();
    let mut entries = BTreeMap::new();
    for child in children(path)? {
        if child.is_dir() && child.join("metadata.json").exists() {
            let sid = filename(&child)?;
            ensure!(safe_id(&sid), "Invalid session ID");
            let raw = read(&child.join("metadata.json"))?;
            let value: Value =
                serde_json::from_slice(raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw))?;
            let parsed = metadata(&child, value.clone())?;
            let sha256 = hash(&raw);
            catalog.insert(sid.clone(), sha256.clone());
            entries.insert(
                sid,
                CatalogEntry {
                    raw,
                    value,
                    metadata: parsed,
                },
            );
        }
    }
    Ok(CatalogSnapshot { catalog, entries })
}
fn cached_catalog(
    path: &Path,
    cache: &mut BTreeMap<PathBuf, CatalogSnapshot>,
) -> Result<CatalogSnapshot> {
    if let Some(snapshot) = cache.get(path) {
        return Ok(snapshot.clone());
    }
    let snapshot = catalog_snapshot(path)?;
    cache.insert(path.into(), snapshot.clone());
    Ok(snapshot)
}
fn index_bytes(path: &Path) -> Result<Vec<u8>> {
    let mut entries = Vec::new();
    for entry in catalog_snapshot(path)?.entries.values() {
        entries.push(entry.metadata.clone());
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
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("session recovery runtime initialization")
    });
    runtime.block_on(
        crate::json_store::JsonFileStore.write_bytes_atomic_strict(path, bytes.to_vec()),
    )?;
    Ok(())
}
fn copy_file(source: &Path, target: &Path) -> Result<()> {
    safe(source, source)?;
    safe(target, target)?;
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("session recovery runtime initialization")
    });
    runtime.block_on(crate::json_store::JsonFileStore.copy_file_atomic_strict(source, target))?;
    Ok(())
}
fn directory_fingerprint_pair(
    root: &Path,
    before_overrides: &BTreeMap<String, Vec<u8>>,
    after_overrides: &BTreeMap<String, Vec<u8>>,
) -> Result<(String, String)> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<String, Option<u64>>) -> Result<()> {
        for child in children(path)? {
            let relative = child
                .strip_prefix(root)?
                .to_str()
                .context("Non-UTF8 path")?
                .replace('\\', "/");
            if child.is_dir() {
                out.insert(relative, None);
                visit(root, &child, out)?;
            } else {
                out.insert(relative, Some(fs::metadata(&child)?.len()));
            }
        }
        Ok(())
    }
    safe(root, root)?;
    ensure!(root.is_dir(), "Session directory is unavailable");
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries)?;
    let fingerprint = |overrides: &BTreeMap<String, Vec<u8>>| -> Result<String> {
        let entries = entries
            .iter()
            .map(|(path, size)| {
                (
                    path.clone(),
                    size.map(|value| {
                        overrides
                            .get(path)
                            .map_or(value, |bytes| bytes.len() as u64)
                    }),
                )
            })
            .collect::<BTreeMap<_, _>>();
        Ok(hash(&encode(&entries)?))
    };
    Ok((
        fingerprint(before_overrides)?,
        fingerprint(after_overrides)?,
    ))
}
fn tree_hash(root: &Path, overrides: &BTreeMap<String, Vec<u8>>) -> Result<String> {
    directory_fingerprint_pair(root, overrides, &BTreeMap::new()).map(|pair| pair.0)
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
