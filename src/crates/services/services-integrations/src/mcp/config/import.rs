//! Atomic external MCP snapshot import into the existing user configuration.

use super::service::MCPConfigService;
use crate::mcp::{MCPRuntimeError, MCPRuntimeResult};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

const USER_CONFIG_KEY: &str = "mcp_servers";
const IMPORT_METADATA_KEY: &str = "_openbitfunImport";
const MAX_IMPORT_SERVERS: usize = 256;
const MAX_IMPORT_ID_BYTES: usize = 512;
const MAX_IMPORT_TEXT_BYTES: usize = 4096;
const USER_MUTATION_ATTEMPTS: usize = 3;

#[derive(Clone, PartialEq, Eq)]
pub enum MCPImportTransport {
    Local { command: String, args: Vec<String> },
    Remote { url: String },
}

impl fmt::Debug for MCPImportTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local { args, .. } => formatter
                .debug_struct("Local")
                .field("command", &"[REDACTED]")
                .field("argument_count", &args.len())
                .finish(),
            Self::Remote { .. } => formatter
                .debug_struct("Remote")
                .field("url", &"[REDACTED]")
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct MCPImportServer {
    pub environment: std::collections::BTreeMap<String, String>,
    pub headers: std::collections::BTreeMap<String, String>,
    pub source_id: Option<String>,
    pub native_id: String,
    pub candidate_id: String,
    pub behavior_version: String,
    pub display_name: String,
    pub transport: MCPImportTransport,
    pub working_directory: Option<String>,
    pub timeouts: crate::mcp::MCPServerTimeouts,
    pub oauth_enabled: Option<bool>,
}

impl fmt::Debug for MCPImportServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MCPImportServer")
            .field("native_id", &self.native_id)
            .field("candidate_id", &self.candidate_id)
            .field("behavior_version", &self.behavior_version)
            .field("display_name", &self.display_name)
            .field("transport", &self.transport)
            .field(
                "working_directory",
                &self.working_directory.as_ref().map(|_| "[REDACTED]"),
            )
            .field("timeouts", &self.timeouts)
            .field("oauth_enabled", &self.oauth_enabled)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MCPImportedServerSummary {
    pub native_id: String,
    pub candidate_id: String,
    pub behavior_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MCPUserImportSnapshot {
    pub fingerprint: String,
    pub native_ids: BTreeSet<String>,
    pub imports: Vec<MCPImportedServerSummary>,
}

pub struct MCPUserJsonConfigSnapshot {
    pub json_config: String,
    pub fingerprint: String,
}

#[derive(Debug)]
pub enum MCPImportError {
    InvalidRequest(&'static str),
    UnsupportedTargetFormat,
    StaleConfiguration,
    TargetConflict { native_id: String },
    Store(MCPRuntimeError),
}

impl fmt::Display for MCPImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(label) => write!(formatter, "Invalid MCP import {label}"),
            Self::UnsupportedTargetFormat => {
                formatter.write_str("User MCP configuration is not an object")
            }
            Self::StaleConfiguration => {
                formatter.write_str("User MCP configuration changed before write")
            }
            Self::TargetConflict { native_id } => {
                write!(formatter, "MCP server id already exists: {native_id}")
            }
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for MCPImportError {}

impl From<MCPRuntimeError> for MCPImportError {
    fn from(error: MCPRuntimeError) -> Self {
        Self::Store(error)
    }
}

impl MCPConfigService {
    pub async fn user_json_config_snapshot(
        &self,
    ) -> Result<MCPUserJsonConfigSnapshot, MCPImportError> {
        let current = self.config_store.get_config_value(USER_CONFIG_KEY).await?;
        let json_config =
            super::format_mcp_json_config_value(current.as_ref()).map_err(|error| {
                MCPImportError::Store(MCPRuntimeError::configuration(error.to_string()))
            })?;
        Ok(MCPUserJsonConfigSnapshot {
            fingerprint: config_fingerprint(&current),
            json_config,
        })
    }

    pub async fn replace_user_json_config(
        &self,
        expected_fingerprint: &str,
        replacement: Value,
    ) -> Result<(), MCPImportError> {
        validate_id(expected_fingerprint, "fingerprint")?;
        let current = self.config_store.get_config_value(USER_CONFIG_KEY).await?;
        if config_fingerprint(&current) != expected_fingerprint {
            return Err(MCPImportError::StaleConfiguration);
        }
        if !self
            .config_store
            .compare_and_set_config_value(USER_CONFIG_KEY, current, replacement)
            .await?
        {
            return Err(MCPImportError::StaleConfiguration);
        }
        Ok(())
    }

    pub async fn user_import_snapshot(&self) -> Result<MCPUserImportSnapshot, MCPImportError> {
        let current = self.config_store.get_config_value(USER_CONFIG_KEY).await?;
        let servers = cursor_servers(&current)?;
        let mut imports = servers
            .iter()
            .filter_map(|(native_id, server)| import_summary(native_id, server))
            .collect::<Vec<_>>();
        imports.sort_by(|left, right| left.native_id.cmp(&right.native_id));
        Ok(MCPUserImportSnapshot {
            fingerprint: config_fingerprint(&current),
            native_ids: servers.keys().cloned().collect(),
            imports,
        })
    }

    pub async fn apply_user_import(
        &self,
        expected_fingerprint: &str,
        imports: Vec<MCPImportServer>,
    ) -> Result<(), MCPImportError> {
        validate_id(expected_fingerprint, "fingerprint")?;
        if imports.is_empty() || imports.len() > MAX_IMPORT_SERVERS {
            return Err(MCPImportError::InvalidRequest("server count"));
        }
        let mut native_ids = BTreeSet::new();
        let mut candidate_ids = BTreeSet::new();
        for import in &imports {
            import.validate()?;
            if !native_ids.insert(import.native_id.as_str())
                || !candidate_ids.insert(import.candidate_id.as_str())
            {
                return Err(MCPImportError::InvalidRequest("server identity"));
            }
        }

        let current = self.config_store.get_config_value(USER_CONFIG_KEY).await?;
        if config_fingerprint(&current) != expected_fingerprint {
            return Err(MCPImportError::StaleConfiguration);
        }
        let mut replacement = cursor_root(&current)?;
        let servers = replacement
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .expect("cursor_root always creates an MCP object");
        for import in &imports {
            if servers.contains_key(&import.native_id) {
                return Err(MCPImportError::TargetConflict {
                    native_id: import.native_id.clone(),
                });
            }
        }
        for import in imports {
            servers.insert(import.native_id.clone(), imported_server_value(import));
        }
        if !self
            .config_store
            .compare_and_set_config_value(USER_CONFIG_KEY, current, replacement)
            .await?
        {
            return Err(MCPImportError::StaleConfiguration);
        }
        Ok(())
    }

    pub(super) async fn mutate_user_config(
        &self,
        mut mutate: impl FnMut(&mut Map<String, Value>) -> MCPRuntimeResult<()>,
    ) -> MCPRuntimeResult<()> {
        for _ in 0..USER_MUTATION_ATTEMPTS {
            let current = self.config_store.get_config_value(USER_CONFIG_KEY).await?;
            let mut replacement = cursor_root(&current)
                .map_err(|error| MCPRuntimeError::configuration(error.to_string()))?;
            let servers = replacement
                .get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .expect("cursor_root always creates an MCP object");
            mutate(servers)?;
            if self
                .config_store
                .compare_and_set_config_value(USER_CONFIG_KEY, current, replacement)
                .await?
            {
                return Ok(());
            }
        }
        Err(MCPRuntimeError::configuration(
            "User MCP configuration changed repeatedly during update",
        ))
    }
}

impl MCPImportServer {
    fn validate(&self) -> Result<(), MCPImportError> {
        for (values, headers) in [(&self.environment, false), (&self.headers, true)] {
            if values.len() > 256
                || values.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > 256
                        || key.contains(['=', '\0', '\r', '\n'])
                        || value.len() > 65536
                        || value.contains('\0')
                        || (headers
                            && (value.contains(['\r', '\n'])
                                || !key.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || b"!#$%&'*+-.^_`|~".contains(&byte)
                                })))
                })
            {
                return Err(MCPImportError::InvalidRequest("environment or headers"));
            }
        }

        self.timeouts
            .validate()
            .map_err(|_| MCPImportError::InvalidRequest("timeouts"))?;
        if let Some(directory) = &self.working_directory {
            validate_text(directory, "working directory")?;
            if !std::path::Path::new(directory).is_absolute() {
                return Err(MCPImportError::InvalidRequest("working directory"));
            }
        }
        if matches!(&self.transport, MCPImportTransport::Local { .. })
            && self.oauth_enabled.is_some()
            || matches!(&self.transport, MCPImportTransport::Remote { .. })
                && self.working_directory.is_some()
        {
            return Err(MCPImportError::InvalidRequest("transport options"));
        }
        validate_id(&self.native_id, "native id")?;
        validate_id(&self.candidate_id, "candidate id")?;
        validate_id(&self.behavior_version, "behavior version")?;
        validate_text(&self.display_name, "display name")?;
        match &self.transport {
            MCPImportTransport::Local { command, args } => {
                validate_text(command, "command")?;
                if args.len() > MAX_IMPORT_SERVERS {
                    return Err(MCPImportError::InvalidRequest("argument count"));
                }
                for argument in args {
                    validate_text(argument, "argument")?;
                }
            }
            MCPImportTransport::Remote { url } => {
                validate_text(url, "URL")?;
                let parsed =
                    url::Url::parse(url).map_err(|_| MCPImportError::InvalidRequest("URL"))?;
                if parsed.scheme() != "https"
                    || parsed.host_str().is_none()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(MCPImportError::InvalidRequest("URL"));
                }
            }
        }
        Ok(())
    }
}

fn validate_id(value: &str, label: &'static str) -> Result<(), MCPImportError> {
    if value.is_empty()
        || value.len() > MAX_IMPORT_ID_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(MCPImportError::InvalidRequest(label));
    }
    Ok(())
}

fn validate_text(value: &str, label: &'static str) -> Result<(), MCPImportError> {
    if value.is_empty()
        || value.len() > MAX_IMPORT_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(MCPImportError::InvalidRequest(label));
    }
    Ok(())
}

fn cursor_root(current: &Option<Value>) -> Result<Value, MCPImportError> {
    match current {
        None | Some(Value::Null) => Ok(serde_json::json!({ "mcpServers": {} })),
        Some(Value::Object(root)) if root.get("mcpServers").is_some_and(Value::is_object) => {
            Ok(Value::Object(root.clone()))
        }
        _ => Err(MCPImportError::UnsupportedTargetFormat),
    }
}

fn cursor_servers(current: &Option<Value>) -> Result<Map<String, Value>, MCPImportError> {
    Ok(cursor_root(current)?
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .expect("cursor_root always creates an MCP object"))
}

fn imported_server_value(import: MCPImportServer) -> Value {
    let mut server = Map::new();
    if !import.environment.is_empty() {
        server.insert("env".into(), serde_json::json!(import.environment));
    }
    if !import.headers.is_empty() {
        server.insert("headers".into(), serde_json::json!(import.headers));
    }
    if let Some(directory) = import.working_directory {
        server.insert("workingDirectory".into(), Value::String(directory));
    }
    if !import.timeouts.is_empty() {
        server.insert("timeouts".into(), serde_json::json!(import.timeouts));
    }
    if let Some(enabled) = import.oauth_enabled {
        server.insert("oauthEnabled".into(), Value::Bool(enabled));
    }
    match import.transport {
        MCPImportTransport::Local { command, args } => {
            server.insert("type".to_string(), Value::String("stdio".to_string()));
            server.insert("command".to_string(), Value::String(command));
            if !args.is_empty() {
                server.insert("args".to_string(), serde_json::json!(args));
            }
            server.insert("inheritParentEnvironment".to_string(), Value::Bool(false));
        }
        MCPImportTransport::Remote { url } => {
            server.insert(
                "type".to_string(),
                Value::String("streamable-http".to_string()),
            );
            server.insert("url".to_string(), Value::String(url));
        }
    }
    if import.display_name != import.native_id {
        server.insert("name".to_string(), Value::String(import.display_name));
    }
    server.insert("enabled".to_string(), Value::Bool(false));
    server.insert("autoStart".to_string(), Value::Bool(false));
    server.insert(
        IMPORT_METADATA_KEY.to_string(),
        serde_json::json!({
            "sourceCandidateId": import.candidate_id,
            "behaviorVersion": import.behavior_version,
            "sourceId": import.source_id,
        }),
    );
    Value::Object(server)
}

fn import_summary(native_id: &str, value: &Value) -> Option<MCPImportedServerSummary> {
    let metadata = value.get(IMPORT_METADATA_KEY)?.as_object()?;
    let candidate_id = metadata.get("sourceCandidateId")?.as_str()?;
    let behavior_version = metadata.get("behaviorVersion")?.as_str()?;
    validate_id(candidate_id, "candidate id").ok()?;
    validate_id(behavior_version, "behavior version").ok()?;
    Some(MCPImportedServerSummary {
        native_id: native_id.to_string(),
        candidate_id: candidate_id.to_string(),
        behavior_version: behavior_version.to_string(),
    })
}

pub(super) fn config_fingerprint(value: &Option<Value>) -> String {
    let bytes = serde_json::to_vec(value).expect("JSON value serialization cannot fail");
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
