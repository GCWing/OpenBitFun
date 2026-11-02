//! Host-owned assistant names. Identity names are user content; defaults are projections.

use super::types::{WorkspaceInfo, WorkspaceKind};
use crate::service::i18n::LocaleId;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};

pub(crate) const NUMBER: &str = "assistantNameNumber";
pub(crate) const SOURCE: &str = "assistantNameSource";

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct NameRegistry {
    high_water: u64,
    numbers: HashMap<String, u64>,
}

/// A separate locked ledger survives stale workspace-catalog writes by another
/// GUI/CLI process. IDs and allocated numbers are never recycled.
pub(crate) async fn allocate_number(
    path: &Path,
    id: &str,
    high_water: u64,
    known: HashMap<String, u64>,
) -> OpenBitFunResult<u64> {
    let (number, _) = openbitfun_services_core::json_store::JsonFileStore
        .update_locked(path, NameRegistry::default(), |registry| {
            registry.high_water = registry.high_water.max(high_water);
            for (id, number) in known {
                registry.high_water = registry.high_water.max(number);
                registry.numbers.entry(id).or_insert(number);
            }
            if let Some(number) = registry.numbers.get(id) {
                return Ok(*number);
            }
            let next = registry
                .high_water
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    OpenBitFunError::service("Assistant name number capacity exhausted")
                })?;
            registry.high_water = next;
            registry.numbers.insert(id.into(), next);
            Ok(next)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Failed to allocate assistant name: {error}"))
        })?;
    number
}

pub fn default_assistant_name(number: u64, locale: LocaleId) -> String {
    let label = crate::service::i18n::generated_locale_contract::generated_shared_term(
        locale,
        "agents.Claw",
    )
    .unwrap_or("Assistant");
    if number <= 1 {
        label.to_string()
    } else {
        format!("{label} {number}")
    }
}

pub(crate) fn number(workspace: &WorkspaceInfo) -> Option<u64> {
    workspace.metadata.get(NUMBER)?.as_u64().filter(|n| *n > 0)
}

/// Only expose a localizable default when its source is known. Never inspect a
/// custom name for words such as Claw or Assistant at a presentation boundary.
pub fn default_name_number(workspace: &WorkspaceInfo) -> Option<u64> {
    if workspace.workspace_kind != WorkspaceKind::Assistant
        || workspace
            .identity
            .as_ref()
            .and_then(|i| i.name.as_deref())
            .is_some()
        || workspace.metadata.get(SOURCE).and_then(|v| v.as_str()) != Some("default")
    {
        return None;
    }
    number(workspace)
}

pub(crate) fn legacy_default_name(assistant_id: Option<&str>) -> String {
    match assistant_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => format!("Claw {}", id.trim()),
        None => "Claw".to_string(),
    }
}

/// Called after successfully reading IDENTITY.md. Exact old generated names
/// may migrate; explicit identity/registry names, including "Claw", never do.
pub(crate) fn refresh_name(workspace: &mut WorkspaceInfo, locale: LocaleId) {
    if workspace.workspace_kind != WorkspaceKind::Assistant {
        return;
    }
    if let Some(name) = workspace.identity.as_ref().and_then(|i| i.name.as_ref()) {
        workspace.name = name.clone();
        workspace.metadata.insert(SOURCE.into(), "identity".into());
        return;
    }
    let source = workspace.metadata.get(SOURCE).and_then(|v| v.as_str());
    let is_default = matches!(source, Some("default" | "identity"))
        || (source.is_none()
            && workspace.name == legacy_default_name(workspace.assistant_id.as_deref()));
    if is_default {
        if let Some(number) = number(workspace) {
            workspace.name = default_assistant_name(number, locale);
            workspace.metadata.insert(SOURCE.into(), "default".into());
        }
    } else if source.is_none() {
        workspace.metadata.insert(SOURCE.into(), "custom".into());
    }
}
