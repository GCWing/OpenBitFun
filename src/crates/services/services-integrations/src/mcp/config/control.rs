//! Credential-safe inspection and optimistic, per-server user configuration edits.

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::import::config_fingerprint;
use super::{
    config_to_cursor_format, parse_cursor_format, validate_mcp_json_config, MCPConfigService,
    MCPImportError,
};
use crate::mcp::server::MCPServerConfig;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPControlConfigSnapshot {
    pub fingerprint: String,
    pub servers: Vec<MCPControlServerSummary>,
}

/// Raw commands, arguments, URLs, environment, headers and extension values can
/// all contain credentials. Discovery exposes structure and health, not values.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPControlServerSummary {
    pub server_id: String,
    pub name: String,
    pub config_valid: bool,
    pub enabled: Option<bool>,
    pub auto_start: Option<bool>,
    pub transport: Option<String>,
    pub configured_fields: Vec<String>,
}

impl MCPConfigService {
    pub async fn user_control_snapshot(&self) -> Result<MCPControlConfigSnapshot, MCPImportError> {
        let current = self.config_store.get_config_value("mcp_servers").await?;
        let document = control_document(&current)?;
        let servers = document["mcpServers"]
            .as_object()
            .expect("validated document")
            .iter()
            .map(|(id, entry)| {
                let single = json!({ "mcpServers": { id: entry } });
                let parsed = validate_mcp_json_config(&single)
                    .ok()
                    .and_then(|()| parse_cursor_format(&single).into_iter().next())
                    .filter(|config| config.validate().is_ok());
                MCPControlServerSummary {
                    server_id: id.clone(),
                    name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                    config_valid: parsed.is_some(),
                    enabled: parsed.as_ref().map(|config| config.enabled),
                    auto_start: parsed.as_ref().map(|config| config.auto_start),
                    transport: parsed
                        .as_ref()
                        .map(|config| config.resolved_transport().as_str().to_string()),
                    configured_fields: entry
                        .as_object()
                        .map(|entry| entry.keys().cloned().collect())
                        .unwrap_or_default(),
                }
            })
            .collect();
        Ok(MCPControlConfigSnapshot {
            fingerprint: config_fingerprint(&current),
            servers,
        })
    }

    /// Merge supplied fields into one entry, or remove that entry when patch is
    /// None. Omitted fields (including credentials and future fields) survive.
    /// The fingerprint covers the whole document, including legacy records.
    pub async fn edit_user_server(
        &self,
        expected_fingerprint: &str,
        server_id: &str,
        patch: Option<&Map<String, Value>>,
    ) -> Result<(), MCPImportError> {
        if server_id.trim().is_empty()
            || server_id.trim() != server_id
            || server_id.chars().any(char::is_control)
        {
            return Err(MCPImportError::InvalidRequest("server id"));
        }
        let current = self.config_store.get_config_value("mcp_servers").await?;
        if config_fingerprint(&current) != expected_fingerprint {
            return Err(MCPImportError::StaleConfiguration);
        }
        let mut document = control_document(&current)?;
        let servers = document["mcpServers"]
            .as_object_mut()
            .expect("validated document");
        let mut updated_config = None;
        if let Some(patch) = patch {
            if patch.is_empty() {
                return Err(MCPImportError::InvalidRequest("empty server patch"));
            }
            let mut entry = match servers.get(server_id) {
                Some(Value::Object(entry)) => entry.clone(),
                Some(_) => {
                    return Err(MCPImportError::InvalidRequest(
                        "existing server configuration",
                    ))
                }
                None => Map::new(),
            };
            for (key, value) in patch {
                if value.is_null() {
                    entry.remove(key);
                } else {
                    entry.insert(key.clone(), value.clone());
                }
            }
            // The legacy boolean OAuth shorthand takes precedence in the
            // reader. Keep it aligned with an explicit enabled-state patch;
            // an OAuth options object (which may contain credentials) survives.
            if let Some(enabled) = patch.get("oauthEnabled").filter(|value| value.is_boolean()) {
                if entry.get("oauth").is_some_and(Value::is_boolean) {
                    entry.insert("oauth".into(), enabled.clone());
                }
            }
            let single = json!({ "mcpServers": { server_id: entry } });
            // Do not include raw values in validation errors returned to agents.
            validate_mcp_json_config(&single).map_err(|_| {
                MCPImportError::InvalidRequest(
                    "server configuration; check command/url and transport fields",
                )
            })?;
            let parsed = parse_cursor_format(&single)
                .into_iter()
                .next()
                .ok_or(MCPImportError::InvalidRequest("server configuration"))?;
            parsed
                .validate()
                .map_err(|_| MCPImportError::InvalidRequest("server configuration"))?;
            updated_config = Some(parsed);
            servers.insert(server_id.to_string(), Value::Object(entry));
        } else if servers.remove(server_id).is_none() {
            return Err(MCPImportError::InvalidRequest("unknown user server id"));
        }
        let replacement = match &current {
            Some(Value::Array(entries)) => edit_legacy_entries(entries, server_id, updated_config)?,
            _ => document,
        };
        // Use the existing CAS owner; never retry a stale user decision.
        if !self
            .config_store
            .compare_and_set_config_value("mcp_servers", current, replacement)
            .await?
        {
            return Err(MCPImportError::StaleConfiguration);
        }
        Ok(())
    }
}

// Keep legacy arrays in their original shape. Cursor and legacy records have
// different type/transport and metadata encodings; changing only the container
// would silently change what an older reader sees.
fn edit_legacy_entries(
    entries: &[Value],
    server_id: &str,
    updated: Option<MCPServerConfig>,
) -> Result<Value, MCPImportError> {
    let mut entries = entries.to_vec();
    let position = entries.iter().position(|entry| entry["id"] == server_id);
    match (position, updated) {
        (Some(index), Some(mut updated)) => {
            let previous: MCPServerConfig = serde_json::from_value(entries[index].clone())
                .map_err(|_| MCPImportError::UnsupportedTargetFormat)?;
            let mut entry = entries[index].as_object().expect("legacy record").clone();
            for key in serde_json::to_value(&previous)
                .expect("serializable legacy record")
                .as_object()
                .expect("legacy object")
                .keys()
            {
                entry.remove(key);
            }
            if previous.transport.is_none()
                && previous.resolved_transport() == updated.resolved_transport()
            {
                updated.transport = None;
            }
            updated.settings = previous.settings;
            updated.capabilities = previous.capabilities;
            entry.extend(
                serde_json::to_value(updated)
                    .expect("serializable updated record")
                    .as_object()
                    .expect("updated object")
                    .clone(),
            );
            entries[index] = Value::Object(entry);
        }
        (None, Some(updated)) => {
            entries.push(serde_json::to_value(updated).expect("serializable new record"))
        }
        (Some(index), None) => {
            entries.remove(index);
        }
        (None, None) => return Err(MCPImportError::InvalidRequest("unknown user server id")),
    }
    Ok(Value::Array(entries))
}

fn control_document(current: &Option<Value>) -> Result<Value, MCPImportError> {
    match current {
        None | Some(Value::Null) => Ok(json!({ "mcpServers": {} })),
        Some(Value::Object(root)) if root.get("mcpServers").is_some_and(Value::is_object) => {
            Ok(Value::Object(root.clone()))
        }
        Some(Value::Array(entries)) => {
            let mut servers = Map::new();
            for entry in entries {
                let id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or(MCPImportError::UnsupportedTargetFormat)?;
                let config: MCPServerConfig = serde_json::from_value(entry.clone())
                    .map_err(|_| MCPImportError::UnsupportedTargetFormat)?;
                if servers
                    .insert(id.to_string(), config_to_cursor_format(&config))
                    .is_some()
                {
                    return Err(MCPImportError::UnsupportedTargetFormat);
                }
            }
            Ok(json!({ "mcpServers": servers }))
        }
        _ => Err(MCPImportError::UnsupportedTargetFormat),
    }
}
