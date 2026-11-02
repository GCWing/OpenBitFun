//! MCP JSON config validation and formatting helpers.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MCPJsonConfigValidationError {
    message: String,
}

impl MCPJsonConfigValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for MCPJsonConfigValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MCPJsonConfigValidationError {}

/// Canonicalizes a `type` / `transport` / `source` token before matching.
///
/// The MCP client ecosystem is inconsistent about casing: Cursor, Cline, and
/// other clients emit `streamableHttp`, while others use `streamable-http`,
/// `streamable_http`, `streamablehttp`, or `http`. The visual editor already
/// lowercases these tokens before matching, so the core validator and parser
/// must do the same, or a config the form accepts fails again when it is saved.
/// Accepting a spelling never changes the canonical value we persist.
pub(super) fn normalized_token(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_source(value: &str) -> Option<&'static str> {
    match normalized_token(value).as_str() {
        "local" => Some("local"),
        "remote" => Some("remote"),
        _ => None,
    }
}

fn normalize_transport(value: &str) -> Option<&'static str> {
    match normalized_token(value).as_str() {
        "stdio" => Some("stdio"),
        "sse" => Some("sse"),
        "http" | "streamable_http" | "streamable-http" | "streamablehttp" => {
            Some("streamable-http")
        }
        _ => None,
    }
}

fn normalize_legacy_type(value: &str) -> Option<(Option<&'static str>, Option<&'static str>)> {
    match normalized_token(value).as_str() {
        "stdio" => Some((None, Some("stdio"))),
        "local" => Some((Some("local"), Some("stdio"))),
        "sse" => Some((Some("remote"), Some("sse"))),
        "remote" => Some((Some("remote"), Some("streamable-http"))),
        "http" | "streamable_http" | "streamable-http" | "streamablehttp" => {
            Some((Some("remote"), Some("streamable-http")))
        }
        _ => None,
    }
}

fn string_field<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn format_mcp_json_config_value(
    value: Option<&serde_json::Value>,
) -> serde_json::Result<String> {
    let Some(value) = value else {
        return serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": {}
        }));
    };

    if value.get("mcpServers").is_some() {
        return serde_json::to_string_pretty(value);
    }

    if let Some(servers) = value.as_array() {
        let mut mcp_servers = serde_json::Map::new();
        for server in servers {
            if let Some(id) = server.get("id").and_then(|v| v.as_str()) {
                mcp_servers.insert(id.to_string(), server.clone());
            }
        }
        return serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": mcp_servers
        }));
    }

    serde_json::to_string_pretty(value)
}

pub fn validate_mcp_json_config(
    config_value: &serde_json::Value,
) -> Result<(), MCPJsonConfigValidationError> {
    if config_value.get("mcpServers").is_none() {
        return Err(MCPJsonConfigValidationError::new(
            "Config missing 'mcpServers' field",
        ));
    }

    let Some(servers) = config_value.get("mcpServers").and_then(|v| v.as_object()) else {
        return Err(MCPJsonConfigValidationError::new(
            "'mcpServers' field must be an object",
        ));
    };

    for (server_id, server_config) in servers {
        let Some(obj) = server_config.as_object() else {
            return Err(MCPJsonConfigValidationError::new(format!(
                "Server '{}' config must be an object",
                server_id
            )));
        };

        let type_str = string_field(obj, "type");
        let source_str = string_field(obj, "source");
        let transport_str = string_field(obj, "transport");
        let command = string_field(obj, "command");
        let url = string_field(obj, "url");

        match (command.is_some(), url.is_some()) {
            (true, true) => {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' must not set both 'command' and 'url' fields",
                    server_id
                )));
            }
            (false, false) => {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' must provide either 'command' (stdio) or 'url' (streamable-http)",
                    server_id
                )));
            }
            _ => {}
        }

        let legacy_type = match type_str {
            Some(value) => normalize_legacy_type(value).ok_or_else(|| {
                MCPJsonConfigValidationError::new(format!(
                    "Server '{}' has unsupported 'type' value: '{}'",
                    server_id, value
                ))
            })?,
            None => (None, None),
        };

        let explicit_source = match source_str {
            Some(value) => Some(normalize_source(value).ok_or_else(|| {
                MCPJsonConfigValidationError::new(format!(
                    "Server '{}' has unsupported 'source' value: '{}'",
                    server_id, value
                ))
            })?),
            None => legacy_type.0,
        };

        let explicit_transport = match transport_str {
            Some(value) => Some(normalize_transport(value).ok_or_else(|| {
                MCPJsonConfigValidationError::new(format!(
                    "Server '{}' has unsupported 'transport' value: '{}'",
                    server_id, value
                ))
            })?),
            None => legacy_type.1,
        };

        let effective_source = match (command.is_some(), url.is_some()) {
            (true, false) => match explicit_source {
                Some("remote") => {
                    return Err(MCPJsonConfigValidationError::new(format!(
                        "Server '{}' source='remote' conflicts with command-based configuration",
                        server_id
                    )));
                }
                Some(source) => source,
                None => "local",
            },
            (false, true) => match explicit_source {
                Some("local") => {
                    return Err(MCPJsonConfigValidationError::new(format!(
                        "Server '{}' source='{}' conflicts with url-based configuration",
                        server_id,
                        explicit_source.unwrap_or("unknown")
                    )));
                }
                Some(source) => source,
                None => "remote",
            },
            _ => unreachable!(),
        };

        let effective_transport = match effective_source {
            "local" => {
                if let Some(transport) = explicit_transport {
                    if transport != "stdio" {
                        return Err(MCPJsonConfigValidationError::new(format!(
                            "Server '{}' source='{}' must use stdio transport",
                            server_id, effective_source
                        )));
                    }
                }
                "stdio"
            }
            "remote" => match explicit_transport.unwrap_or("streamable-http") {
                "streamable-http" | "sse" => explicit_transport.unwrap_or("streamable-http"),
                _ => {
                    return Err(MCPJsonConfigValidationError::new(format!(
                        "Server '{}' remote source must use 'streamable-http' or 'sse' transport",
                        server_id
                    )));
                }
            },
            _ => unreachable!(),
        };

        if effective_transport == "stdio" && command.is_none() {
            return Err(MCPJsonConfigValidationError::new(format!(
                "Server '{}' (stdio) must provide 'command' field",
                server_id
            )));
        }

        if matches!(effective_transport, "streamable-http" | "sse") && url.is_none() {
            return Err(MCPJsonConfigValidationError::new(format!(
                "Server '{}' ({}) must provide 'url' field",
                server_id, effective_transport
            )));
        }

        for (key, expected) in [
            ("args", "array"),
            ("env", "object"),
            ("headers", "object"),
            ("xaa", "object"),
            ("timeouts", "object"),
            ("workingDirectory", "string"),
        ] {
            if let Some(value) = obj.get(key) {
                let matches_expected = match expected {
                    "array" => value.is_array(),
                    "object" => value.is_object(),
                    "string" => value.is_string(),
                    _ => false,
                };
                if !matches_expected {
                    return Err(MCPJsonConfigValidationError::new(format!(
                        "Server '{}' '{}' field must be an {}",
                        server_id, key, expected
                    )));
                }
            }
        }

        if let Some(value) = obj.get("oauth") {
            if !value.is_object() && !value.is_boolean() {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' 'oauth' field must be a boolean or an object",
                    server_id
                )));
            }
        }
        if let Some(value) = obj.get("oauthEnabled") {
            if !value.is_boolean() {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' 'oauthEnabled' field must be a boolean",
                    server_id
                )));
            }
            if obj
                .get("oauth")
                .and_then(|oauth| oauth.as_bool())
                .is_some_and(|enabled| Some(enabled) != value.as_bool())
            {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' 'oauth' conflicts with 'oauthEnabled'",
                    server_id
                )));
            }
        }
        if let Some(value) = obj.get("timeouts") {
            let valid = serde_json::from_value::<crate::mcp::MCPServerTimeouts>(value.clone())
                .is_ok_and(|timeouts| timeouts.validate().is_ok());
            if !valid {
                return Err(MCPJsonConfigValidationError::new(format!(
                    "Server '{}' timeouts must contain positive exactly representable millisecond integers", server_id
                )));
            }
        }
    }

    Ok(())
}
