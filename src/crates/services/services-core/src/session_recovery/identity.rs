use super::*;
use crate::workspace_identity as wi;

pub(super) type Records = BTreeMap<String, Value>;
pub(super) type Aliases = BTreeMap<String, (String, String, String)>;
pub(super) struct Owner {
    pub id: String,
    pub root: String,
    pub metadata: crate::session::SessionMetadata,
    pub documents: BTreeMap<String, Value>,
    snapshot_id: Option<String>,
    remote: Option<(String, String, Option<String>)>,
}
pub(super) fn registry(user_root: &Path) -> Result<(Records, String)> {
    let path = user_root.join("data/workspace_data.json");
    let raw = json(&path)?;
    ensure!(
        raw["format_version"] == crate::workspace_persistence::WORKSPACE_PERSISTENCE_FORMAT_VERSION
            && raw["product_id"] == openbitfun_core_types::product_identity::product_id(),
        "Unsupported workspace registry format"
    );
    let records = raw["workspaces"]
        .as_object()
        .context("Workspace registry has no workspaces map")?;
    for (id, record) in records {
        ensure!(
            record.is_object() && record.get("id").is_none_or(|v| v == id),
            "Invalid workspace registry identity: {id}"
        );
    }
    Ok((
        records
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        file_hash(&path)?,
    ))
}
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}
fn remote_path(value: &str) -> Result<String> {
    ensure!(
        value.starts_with('/') && !value.contains('\0'),
        "Remote workspace path must be absolute POSIX"
    );
    let normalized = wi::normalize_remote_workspace_path(value);
    ensure!(
        !normalized.split('/').any(|p| p == "." || p == ".."),
        "Ambiguous remote workspace path"
    );
    Ok(normalized)
}
fn local_path(value: &str) -> Result<String> {
    ensure!(
        Path::new(value).is_absolute(),
        "Local workspace path must be absolute"
    );
    let value = value.replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(windows)]
    let value = value.to_lowercase();
    Ok(value)
}
fn equal_path(a: &str, b: &str, remote: bool) -> Result<bool> {
    Ok(if remote {
        remote_path(a)? == remote_path(b)?
    } else {
        local_path(a)? == local_path(b)?
    })
}
fn record_root(record: &Value) -> Result<String> {
    Ok(string(record, "rootPath")
        .context("Workspace registry has no root path")?
        .into())
}
fn host(record: &Value) -> Result<String> {
    Ok(string(&record["metadata"], "sshHost")
        .context("Remote registry record has no SSH host")?
        .trim()
        .to_lowercase())
}
pub(super) fn runtime_key(record: &Value) -> Result<String> {
    let root = record_root(record)?;
    if string(record, "workspaceKind") == Some("remote") {
        Ok(wi::remote_workspace_runtime_key(
            &host(record)?,
            &remote_path(&root)?,
        ))
    } else {
        ensure!(
            Path::new(&root).is_dir(),
            "Local workspace directory is unavailable: {root}"
        );
        Ok(wi::local_workspace_runtime_key(
            &wi::normalize_local_workspace_root_for_stable_id(Path::new(&root))
                .map_err(anyhow::Error::msg)?,
        ))
    }
}
pub(super) fn aliases(home: &Path, records: &Records) -> Result<Aliases> {
    let mut result = BTreeMap::new();
    if home.file_name().and_then(|s| s.to_str()) != Some(".openbitfun") {
        return Ok(result);
    }
    for (id, record) in records {
        if string(record, "workspaceKind") != Some("assistant") {
            continue;
        }
        let root = record_root(record)?;
        let Ok(relative) = Path::new(&root).strip_prefix(home.join("personal_assistant")) else {
            continue;
        };
        // Never guess the old default assistant into a named assistant.
        if relative.components().count() != 1 || !filename(relative)?.starts_with("workspace-") {
            continue;
        }
        let old = home
            .with_file_name(".bitfun")
            .join("personal_assistant")
            .join(relative)
            .to_str()
            .context("Non-UTF8 assistant path")?
            .to_string();
        let alias = wi::local_workspace_stable_storage_id(&old.replace('\\', "/"));
        if records.contains_key(&alias) {
            continue;
        }
        ensure!(
            result.insert(alias, (id.clone(), old, root)).is_none(),
            "Ambiguous legacy assistant identity"
        );
    }
    Ok(result)
}
pub(super) fn owner(
    directory: &Path,
    mut documents: BTreeMap<String, Value>,
    records: &Records,
    aliases: &Aliases,
    cached_metadata: Option<&super::CatalogEntry>,
) -> Result<Owner> {
    ensure!(
        documents["metadata.json"].is_object(),
        "Metadata must be a JSON object"
    );
    if let Some(state) = documents.get("state.json") {
        ensure!(
            state.is_object()
                && state
                    .get("schema_version")
                    .is_none_or(|value| value.as_u64() == Some(2)),
            "Unsupported session state"
        );
        ensure!(
            state.get("config").is_none_or(Value::is_object),
            "Session config must be an object"
        );
    }
    for (alias, (id, old, new)) in aliases {
        for (name, document) in &mut documents {
            let container = if name == "state.json" {
                document.get_mut("config")
            } else {
                Some(document)
            };
            let Some(container) = container else { continue };
            for key in [
                "workspaceId",
                "workspace_id",
                "projectWorkspaceId",
                "project_workspace_id",
            ] {
                if string(container, key) == Some(alias) {
                    container[key] = Value::String(id.clone());
                }
            }
            for key in [
                "workspacePath",
                "workspace_path",
                "projectWorkspacePath",
                "project_workspace_path",
            ] {
                if string(container, key)
                    .is_some_and(|p| equal_path(p, old, false).unwrap_or(false))
                {
                    container[key] = Value::String(new.clone());
                }
            }
            for key in ["executionTarget", "execution_target"] {
                if let Some(target) = container.get_mut(key).filter(|v| v.is_object()) {
                    for field in ["rootPath", "root_path"] {
                        if string(target, field)
                            .is_some_and(|p| equal_path(p, old, false).unwrap_or(false))
                        {
                            target[field] = Value::String(new.clone());
                        }
                    }
                }
            }
        }
    }
    let metadata = match cached_metadata.filter(|entry| entry.value == documents["metadata.json"]) {
        Some(entry) => entry.metadata.clone(),
        None => metadata(directory, documents["metadata.json"].clone())?,
    };
    let meta = serde_json::to_value(&metadata)?;
    let state = documents.get("state.json").cloned().unwrap_or(Value::Null);
    let config = &state["config"];
    let remote = string(config, "workspace_kind") == Some("remote")
        || metadata
            .workspace_id
            .as_ref()
            .is_some_and(|id| id.starts_with("remote_"))
        || string(config, "workspace_id").is_some_and(|id| id.starts_with("remote_"))
        || string(&meta, "workspaceHostname").is_some_and(|h| h != "localhost")
        || string(config, "remote_ssh_host").is_some_and(|h| h != "localhost");
    let mut values = BTreeMap::new();
    for (key, state_key) in [
        ("workspaceId", "workspace_id"),
        ("projectWorkspaceId", "project_workspace_id"),
        ("workspacePath", "workspace_path"),
        ("projectWorkspacePath", "project_workspace_path"),
        ("workspaceKind", "workspace_kind"),
        ("workspaceHostname", "remote_ssh_host"),
        ("executionTarget", "execution_target"),
    ] {
        // WorkspaceKind is not part of metadata DTO; retain its legacy evidence.
        let left = if key == "workspaceKind" {
            &documents["metadata.json"][key]
        } else {
            &meta[key]
        };
        let right = &config[state_key];
        if !left.is_null() && !right.is_null() {
            let same = if key.ends_with("Path") {
                equal_path(
                    left.as_str().context("Invalid workspace path")?,
                    right.as_str().context("Invalid workspace path")?,
                    remote,
                )?
            } else {
                left == right
            };
            ensure!(same, "Metadata/state disagree on {key}");
        }
        values.insert(
            key,
            if !left.is_null() {
                left.clone()
            } else {
                right.clone()
            },
        );
    }
    let field = |key: &str| {
        values
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    ensure!(
        matches!(
            field("workspaceKind"),
            None | Some("normal" | "assistant" | "remote")
        ),
        "Worktree session requires manual repair"
    );
    if let (Some(a), Some(b)) = (field("workspaceId"), field("projectWorkspaceId")) {
        ensure!(a == b, "Linked worktree session requires manual repair");
    }
    if let (Some(a), Some(b)) = (field("workspacePath"), field("projectWorkspacePath")) {
        ensure!(
            equal_path(a, b, remote)?,
            "Execution/project workspace paths differ"
        );
    }
    let path = field("projectWorkspacePath").or_else(|| field("workspacePath"));
    let id = if let Some(id) = field("projectWorkspaceId").or_else(|| field("workspaceId")) {
        ensure!(records.contains_key(id), "Unknown workspace ID: {id}");
        id.to_string()
    } else {
        let mut matches = Vec::new();
        for (id, record) in records {
            if (string(record, "workspaceKind") == Some("remote")) != remote {
                continue;
            }
            if let Some(path) = path {
                if equal_path(path, &record_root(record)?, remote)?
                    && (!remote
                        || Some(host(record)?.as_str())
                            == field("workspaceHostname")
                                .map(str::trim)
                                .map(str::to_lowercase)
                                .as_deref())
                {
                    matches.push(id.clone());
                }
            }
        }
        ensure!(
            matches.len() == 1,
            "Legacy path does not identify exactly one workspace"
        );
        matches.remove(0)
    };
    let record = &records[&id];
    ensure!(
        matches!(
            string(record, "workspaceKind"),
            None | Some("normal" | "assistant" | "remote")
        ),
        "Worktree registry record requires manual repair"
    );
    ensure!(
        (string(record, "workspaceKind") == Some("remote")) == remote,
        "Session and registry disagree on local/remote identity"
    );
    let root = record_root(record)?;
    if let Some(path) = path {
        ensure!(
            equal_path(path, &root, remote)?,
            "Session identity disagrees with registry path"
        );
    }
    let target = &values["executionTarget"];
    if !target.is_null() {
        ensure!(
            target.is_object() && string(target, "kind") == Some("local"),
            "Unsupported execution target"
        );
        ensure!(
            equal_path(
                string(target, "rootPath")
                    .or_else(|| string(target, "root_path"))
                    .context("Execution target has no root")?,
                &root,
                remote
            )?,
            "Execution target disagrees with registry"
        );
    }
    let remote = if remote {
        let host = host(record)?;
        ensure!(
            field("workspaceHostname")
                .map(str::trim)
                .map(str::to_lowercase)
                .as_deref()
                == Some(&host),
            "Session and registry SSH hosts disagree"
        );
        let session_connection =
            string(config, "remote_connection_id").map(wi::canonical_ssh_connection_id);
        let registered_connection =
            string(&record["metadata"], "connectionId").map(wi::canonical_ssh_connection_id);
        if let (Some(a), Some(b)) = (&session_connection, &registered_connection) {
            ensure!(a == b, "Session and registry SSH connections disagree");
        }
        Some((
            host,
            remote_path(&root)?,
            session_connection.or(registered_connection),
        ))
    } else {
        None
    };
    let mut snapshots = BTreeSet::new();
    for value in [
        metadata.snapshot_session_id.as_deref(),
        string(&state, "snapshot_session_id"),
    ] {
        if let Some(value) = value {
            ensure!(safe_id(value), "Invalid snapshot session ID");
            snapshots.insert(value.to_string());
        }
    }
    ensure!(
        snapshots.len() <= 1,
        "Metadata/state snapshot session IDs disagree"
    );
    Ok(Owner {
        id,
        root,
        metadata,
        documents,
        remote,
        snapshot_id: snapshots.into_iter().next(),
    })
}
fn references(value: &Value, ids: &mut BTreeSet<String>) -> Result<()> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if [
                    "snapshot_id",
                    "snapshotId",
                    "before_snapshot_id",
                    "after_snapshot_id",
                ]
                .contains(&key.as_str())
                    && !child.is_null()
                    && child != ""
                {
                    let id = child.as_str().context("Invalid snapshot reference")?;
                    ensure!(safe_id(id), "Invalid snapshot reference");
                    ids.insert(id.into());
                } else {
                    references(child, ids)?;
                }
            }
        }
        Value::Array(children) => {
            for child in children {
                references(child, ids)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn snapshot_assets(source: &Path, target: &Path, owner: &Owner) -> Result<Vec<Asset>> {
    let source_runtime = source.parent().unwrap().parent().unwrap();
    let target_runtime = target.parent().unwrap().parent().unwrap();
    let evidence = if source.exists() { source } else { target };
    let revert = evidence.join("session-revert.json");
    let mut ids = BTreeSet::new();
    if revert.exists() {
        references(&json(&revert)?, &mut ids)?;
    }
    let relative = if let Some(remote) = &owner.remote {
        if remote.2.is_none() {
            ensure!(
                !source_runtime
                    .join("snapshots/workspace-identities")
                    .exists()
                    && ids.is_empty(),
                "Remote snapshot dependencies require an SSH connection ID"
            );
            return Ok(vec![]);
        }
        PathBuf::from("snapshots/workspace-identities").join(hash(&serde_json::to_vec(remote)?))
    } else {
        PathBuf::from("snapshots")
    };
    let snapshots = source_runtime.join(relative);
    let mut assets = BTreeMap::new();
    let mut add = |path: PathBuf| -> Result<Value> {
        safe(&path, source_runtime)?;
        let sha256 = file_hash(&path)?;
        let dest = target_runtime.join(path.strip_prefix(source_runtime)?);
        safe(&dest, target_runtime)?;
        let old = optional_hash(&dest)?;
        ensure!(
            old.as_ref().is_none_or(|s| s == &sha256),
            "Snapshot destination conflict: {}",
            dest.display()
        );
        assets.insert(
            dest.clone(),
            Asset {
                source: path.clone(),
                target: dest,
                sha256,
                existed: old.is_some(),
            },
        );
        if path.extension().is_some_and(|s| s == "json") {
            json(&path)
        } else {
            Ok(Value::Null)
        }
    };
    let sessions = BTreeSet::from([
        filename(source)?,
        owner.snapshot_id.clone().unwrap_or(filename(source)?),
    ]);
    for sid in sessions {
        let history = snapshots.join("operations").join(format!("{sid}.json"));
        if history.exists() {
            let raw = add(history)?;
            ensure!(
                raw["session_id"] == sid,
                "Snapshot history session ID mismatch"
            );
            references(&raw, &mut ids)?;
        }
    }
    for sid in ids {
        let category = if sid.starts_with("baseline_") {
            "baselines"
        } else {
            "metadata"
        };
        let value = add(snapshots.join(category).join(format!("{sid}.json")))?;
        ensure!(value["snapshot_id"] == sid, "Snapshot metadata ID mismatch");
        let content_hash =
            string(&value, "content_hash").context("Snapshot content hash is missing")?;
        ensure!(
            content_hash.len() == 32
                && content_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Unsupported snapshot content hash"
        );
        let blob = snapshots
            .join("by_hash")
            .join(format!("{content_hash}.snap"));
        if blob.exists() {
            add(blob)?;
        } else {
            ensure!(
                value
                    .get("compressed_content")
                    .is_some_and(|v| !v.is_null() && v != "" && v != &serde_json::json!([])),
                "Missing snapshot content: {sid}"
            );
        }
    }
    Ok(assets.into_values().collect())
}
