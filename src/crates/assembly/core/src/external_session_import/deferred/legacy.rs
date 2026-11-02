//! Adopt old automatic imports lazily without creating a second navigation row.
//! Native files remain intact, including when validation finds local edits.
use super::*;

const NATIVE: &str = "externalLegacyNative";
const HASH: &str = "externalLegacyNativeHash";
const INDEPENDENT: &str = "externalLegacyIndependent";
const ALIAS: &str = "externalHistoryAliasOf";

pub(super) fn follows_native(metadata: &SessionMetadata) -> bool {
    tracking::is_followed(metadata)
        && metadata
            .custom_metadata
            .as_ref()
            .is_some_and(|custom| custom[NATIVE] == true)
}

pub(super) fn is_alias(metadata: &SessionMetadata) -> bool {
    metadata
        .custom_metadata
        .as_ref()
        .is_some_and(|custom| custom[ALIAS].is_string())
}

pub(super) fn project_metadata(index: &Index, metadata: &mut [SessionMetadata]) {
    for native in metadata {
        if let Some(entry) = index
            .entries
            .get(&native.session_id)
            .filter(|entry| !entry.dismissed && follows_native(&entry.metadata))
        {
            *native = entry.metadata.clone();
        }
        if let Some(lineage) = native
            .custom_metadata
            .as_mut()
            .and_then(|custom| custom.get_mut("externalBranchOf"))
        {
            let canonical = lineage["sessionId"]
                .as_str()
                .and_then(|id| index.entries.get(id))
                .and_then(|entry| entry.metadata.custom_metadata.as_ref())
                .and_then(|custom| custom[ALIAS].as_str());
            if let Some(id) = canonical {
                lineage["sessionId"] = json!(id);
            }
        }
    }
}

pub(super) fn prepare_reference(
    index: &mut Index,
    native: &SessionMetadata,
    candidate: &ExternalSessionCandidate,
) -> bool {
    let Some(entry) = index.entries.get_mut(&native.session_id) else {
        return false;
    };
    if entry.dismissed
        || entry
            .metadata
            .custom_metadata
            .as_ref()
            .is_some_and(|custom| custom[INDEPENDENT] == true)
    {
        return false;
    }
    let mut changed = false;
    if !follows_native(&entry.metadata) {
        let custom = entry
            .metadata
            .custom_metadata
            .get_or_insert_with(|| json!({}));
        custom[NATIVE] = json!(true);
        custom["externalHistoryMode"] = json!("follow");
        custom[PENDING_KEY] = json!(true);
        custom["continuationMode"] = json!("fork_before_continue");
        changed = true;
    }
    // Keep already-published IDs and snapshots usable by existing branch links,
    // while exposing only the original automatic import in navigation.
    for (id, other) in &mut index.entries {
        if id != &native.session_id
            && !other.dismissed
            && tracking::is_followed(&other.metadata)
            && other.metadata.workspace_id == native.workspace_id
            && other.ecosystem_id == candidate.ecosystem_id
            && other.source_session_id == candidate.source_session_id
        {
            let custom = other
                .metadata
                .custom_metadata
                .get_or_insert_with(|| json!({}));
            if custom[ALIAS] != native.session_id {
                custom[ALIAS] = json!(native.session_id);
                changed = true;
            }
        }
    }
    changed
}

fn normalize(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            // Import timestamps can be synthesized for source records lacking a
            // timestamp. Compare the content, provenance and execution records.
            for key in ["timestamp", "startTime", "endTime", "durationMs"] {
                fields.remove(key);
            }
            for key in [
                "userMessage",
                "modelRounds",
                "textItems",
                "toolItems",
                "thinkingItems",
            ] {
                if let Some(value) = fields.get_mut(key) {
                    normalize(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize),
        _ => {}
    }
}

fn unedited_prefix(
    before: &OfflineSessionBundle,
    after: &OfflineSessionBundle,
) -> OpenBitFunResult<bool> {
    if can_repair_history(before, after) {
        return Ok(true);
    }
    if before.metadata.status == SessionStatus::Active || before.turns.len() > after.turns.len() {
        return Ok(false);
    }
    let mut compatible = before.metadata.clone();
    compatible.normalize_legacy_imported_agent_type();
    for (old, new) in before.turns.iter().zip(&after.turns) {
        let mut old = old.clone();
        // The retired imported placeholder and its corrected native mode are
        // equivalent for comparison only. Keep the persisted history intact,
        // and still detect any other mode or content edit as a local change.
        if old.agent_type.as_deref() == Some(before.metadata.agent_type.as_str())
            && new.agent_type.as_deref() == Some(compatible.agent_type.as_str())
        {
            old.agent_type = new.agent_type.clone();
        }
        // A downgraded host may retain a view's versioned turn identity.
        if old.turn_id
            == format!(
                "{}-v{}-turn-{}",
                before.metadata.session_id,
                before
                    .metadata
                    .custom_metadata
                    .as_ref()
                    .and_then(|custom| custom["externalContentVersion"].as_str())
                    .unwrap_or_default(),
                old.turn_index
            )
        {
            old.turn_id = new.turn_id.clone();
        }
        if let Some(metadata) = old
            .user_message
            .metadata
            .as_mut()
            .and_then(Value::as_object_mut)
        {
            metadata.remove("externalContentVersion");
        }
        let mut old = serde_json::to_value(old).map_err(index_error)?;
        let mut new = serde_json::to_value(new).map_err(index_error)?;
        normalize(&mut old);
        normalize(&mut new);
        if old != new {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixture;
    use super::*;
    use crate::external_session_import::auto_discovery::tests::{candidate, document};

    #[tokio::test]
    async fn legacy_mode_comparison_preserves_history_and_detects_real_edits() {
        let (_temp, workspace, _root, _manager) = fixture();
        for ecosystem in ["codex", "zcode"] {
            let source = document(candidate(ecosystem, "source-1", &workspace.root_path));
            let convert = |mode| {
                convert_document(
                    "legacy",
                    &workspace,
                    &workspace,
                    mode,
                    "Old import",
                    &source,
                    true,
                    true,
                )
                .unwrap()
            };
            let before = convert("primary");
            let after = convert("Standard");
            let original = serde_json::to_value(&before).unwrap();
            assert!(unedited_prefix(&before, &after).unwrap());
            assert_eq!(serde_json::to_value(&before).unwrap(), original);

            let mut edited = before.clone();
            edited.turns[0].agent_type = Some("Creative".into());
            assert!(!unedited_prefix(&edited, &after).unwrap());

            let mut edited = before.clone();
            edited.turns[0].user_message.content = "Local prompt edit".into();
            assert!(!unedited_prefix(&edited, &after).unwrap());

            let mut unknown = before;
            unknown.metadata.custom_metadata = None;
            assert!(!unedited_prefix(&unknown, &after).unwrap());
        }
    }
}

/// Called only when opening one source, never while discovering/listing it.
pub(super) async fn validate_native(
    root: &Path,
    entry: &Reference,
    source: &OfflineSessionBundle,
) -> OpenBitFunResult<bool> {
    if !follows_native(&entry.metadata) {
        return Ok(true);
    }
    let Some(native) = OfflineSessionImportStore::new(root)
        .load_bundle(&entry.metadata.session_id)
        .await
        .map_err(index_error)?
    else {
        return Ok(true);
    };
    let hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&native.turns).map_err(index_error)?,
    ));
    if entry
        .metadata
        .custom_metadata
        .as_ref()
        .is_some_and(|custom| custom[HASH] == hash)
        || unedited_prefix(&native, source)?
    {
        update_index(root, |index| {
            let Some(current) = index.entries.get_mut(&entry.metadata.session_id) else {
                return ((), false);
            };
            let custom = current
                .metadata
                .custom_metadata
                .get_or_insert_with(|| json!({}));
            if custom[HASH] == hash {
                return ((), false);
            }
            custom[HASH] = json!(hash);
            ((), true)
        })
        .await?;
        return Ok(true);
    }
    // A native continuation/edit already exists. Keep it and expose a separate
    // source, reusing any duplicate reference created by the previous version.
    update_index(root, |index| {
        let mut native = native.metadata;
        tracking::project_native_metadata(&mut native);
        let custom = native.custom_metadata.get_or_insert_with(|| json!({}));
        custom[INDEPENDENT] = json!(true);
        custom[NATIVE] = json!(false);
        if let Some(current) = index.entries.get_mut(&entry.metadata.session_id) {
            current.metadata = native;
        }
        let alias = index
            .entries
            .iter()
            .find(|(_, other)| {
                !other.dismissed
                    && other
                        .metadata
                        .custom_metadata
                        .as_ref()
                        .is_some_and(|custom| custom[ALIAS] == entry.metadata.session_id)
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = alias {
            index
                .entries
                .get_mut(&id)
                .unwrap()
                .metadata
                .custom_metadata
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(ALIAS);
        } else {
            let mut id = format!("external-{}", entry.metadata.session_id);
            let mut suffix = 2;
            while index.entries.contains_key(&id) {
                id = format!("external-{}-{suffix}", entry.metadata.session_id);
                suffix += 1;
            }
            let mut source = entry.clone();
            source.metadata.session_id = id.clone();
            source.metadata.turn_count = 0;
            source.metadata.message_count = 0;
            source.metadata.tool_call_count = 0;
            source.metadata.last_turn = None;
            let custom = source
                .metadata
                .custom_metadata
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap();
            for key in [NATIVE, HASH, INDEPENDENT, ALIAS, "externalContentVersion"] {
                custom.remove(key);
            }
            index.entries.insert(id, source);
        }
        ((), true)
    })
    .await?;
    Ok(false)
}

pub(crate) async fn has_native_view(root: &Path, id: &str) -> OpenBitFunResult<bool> {
    Ok(metadata(root, id)
        .await?
        .as_ref()
        .is_some_and(follows_native))
}
