//! Agent tool for making a port on an SSH host reachable from this machine.
//!
//! Works from any session, not just a remote-SSH workspace. `target` accepts
//! whatever the caller already knows the host as — a saved OpenBitFun connection,
//! a `~/.ssh/config` alias, or `[user@]host[:port]` — because an Agent that
//! reached a box with `ssh myserver` in a shell should be able to forward its
//! ports with the same name it just used. When the session *is* bound to a
//! remote workspace, `target` can be omitted and that connection is used.

use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
    ValidationResult,
};
#[cfg(feature = "remote-workspace")]
use crate::service::remote_ssh::{
    global_port_forward_manager, list_remote_listening_ports, PortForwardRequest, SSHAuthMethod,
    SSHConnectionConfig, SSHConnectionManager, SSHConnectionOptions,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PortForwardOperation {
    Targets,
    Detect,
    Start,
    List,
    Stop,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct PortForwardToolInput {
    operation: PortForwardOperation,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    remote_port: Option<u16>,
    #[serde(default)]
    remote_host: Option<String>,
    #[serde(default)]
    local_port: Option<u16>,
    #[serde(default)]
    expose_on_lan: bool,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    forward_id: Option<String>,
}

impl PortForwardToolInput {
    fn trimmed_target(&self) -> Option<&str> {
        self.target
            .as_deref()
            .map(str::trim)
            .filter(|target| !target.is_empty())
    }
}

/// An SSH endpoint parsed out of a `[user@]host[:port]` string.
#[cfg_attr(not(feature = "remote-workspace"), allow(dead_code))]
struct ParsedEndpoint {
    user: Option<String>,
    host: String,
    port: Option<u16>,
}

fn parse_endpoint(target: &str) -> Option<ParsedEndpoint> {
    let (user, rest) = match target.rsplit_once('@') {
        Some((user, rest)) if !user.is_empty() && !rest.is_empty() => {
            (Some(user.to_string()), rest)
        }
        Some(_) => return None,
        None => (None, target),
    };
    // `host:port`, but never mistake an IPv6 literal's colons for a port.
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && !host.is_empty() => {
            match port.parse::<u16>() {
                Ok(port) => (host, Some(port)),
                Err(_) => return None,
            }
        }
        _ => (rest, None),
    };
    let host = host.trim_matches(|c| c == '[' || c == ']');
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    Some(ParsedEndpoint {
        user,
        host: host.to_string(),
        port,
    })
}

#[cfg(feature = "remote-workspace")]
fn current_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string())
}

pub struct PortForwardTool;

impl PortForwardTool {
    pub fn new() -> Self {
        Self
    }

    /// Connection bound to this session, when there is one.
    #[cfg(feature = "remote-workspace")]
    fn workspace_connection_id(context: &ToolUseContext) -> Option<String> {
        let workspace = context.workspace.as_ref()?;
        if !workspace.is_remote() {
            return None;
        }
        workspace.connection_id().map(str::to_string)
    }

    /// Turn whatever the caller called the host into a live connection id.
    ///
    /// Saved connections win over `~/.ssh/config` so an explicitly configured
    /// profile (with its stored credentials) is preferred over re-deriving one,
    /// and a bare endpoint is the last resort.
    #[cfg(feature = "remote-workspace")]
    async fn resolve_target(
        manager: &SSHConnectionManager,
        target: Option<&str>,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<String> {
        let Some(target) = target else {
            return Self::workspace_connection_id(context).ok_or_else(|| {
                OpenBitFunError::tool(
                    "This session is not bound to a remote SSH workspace. Pass `target` with a \
                     saved connection, an ~/.ssh/config host, or [user@]host[:port]. Use \
                     operation \"targets\" to see what is available."
                        .to_string(),
                )
            });
        };

        let saved = manager.get_saved_connections().await;
        if let Some(found) = saved
            .iter()
            .find(|connection| connection.id == target)
            .or_else(|| {
                saved
                    .iter()
                    .find(|connection| connection.name.eq_ignore_ascii_case(target))
            })
            .or_else(|| {
                saved
                    .iter()
                    .find(|connection| connection.host.eq_ignore_ascii_case(target))
            })
        {
            manager
                .ensure_connected(&found.id)
                .await
                .map_err(|error| OpenBitFunError::tool(format!("{error:#}")))?;
            return Ok(found.id.clone());
        }

        Self::connect_ad_hoc(manager, target).await
    }

    /// Build a connection from `~/.ssh/config` or a bare endpoint and open it.
    ///
    /// The id is derived from the endpoint so repeated calls reuse one session
    /// instead of stacking a new one per tool call. Nothing is persisted to the
    /// user's saved connections.
    #[cfg(feature = "remote-workspace")]
    async fn connect_ad_hoc(
        manager: &SSHConnectionManager,
        target: &str,
    ) -> OpenBitFunResult<String> {
        let endpoint = parse_endpoint(target).ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "'{target}' is not a saved connection, an ~/.ssh/config host, or [user@]host[:port]"
            ))
        })?;

        let lookup = manager.get_ssh_config(&endpoint.host).await;
        let config_entry = lookup.config;

        let host = config_entry
            .as_ref()
            .and_then(|entry| entry.hostname.clone())
            .unwrap_or_else(|| endpoint.host.clone());
        let port = endpoint
            .port
            .or_else(|| config_entry.as_ref().and_then(|entry| entry.port))
            .unwrap_or(22);
        let username = endpoint
            .user
            .clone()
            .or_else(|| config_entry.as_ref().and_then(|entry| entry.user.clone()))
            .unwrap_or_else(current_username);

        // Only non-interactive auth can work here: there is no one to type a
        // passphrase into a tool call.
        let auth = match config_entry
            .as_ref()
            .and_then(|entry| entry.identity_file.clone())
        {
            Some(key_path) => SSHAuthMethod::PrivateKey {
                key_path,
                passphrase: None,
                certificate_path: config_entry
                    .as_ref()
                    .and_then(|entry| entry.certificate_file.clone()),
            },
            None => SSHAuthMethod::Agent {
                key_fingerprint: None,
                fallback_key_path: None,
            },
        };

        let connection_id = format!("port-forward:{username}@{host}:{port}");
        if manager.is_connected(&connection_id).await {
            return Ok(connection_id);
        }

        let result = manager
            .connect(SSHConnectionConfig {
                id: connection_id.clone(),
                name: target.to_string(),
                host,
                port,
                username,
                auth,
                default_workspace: None,
                proxy_jump: config_entry.and_then(|entry| entry.proxy_jump),
                container: None,
                wsl: None,
                options: SSHConnectionOptions::default(),
            })
            .await
            .map_err(|error| OpenBitFunError::tool(format!("{error:#}")))?;

        if !result.success {
            return Err(OpenBitFunError::tool(format!(
                "Could not connect to '{target}': {}. Key or agent authentication is required; \
                 a target that needs a password must be saved in OpenBitFun's SSH connections first.",
                result.error.unwrap_or_else(|| "unknown error".to_string())
            )));
        }
        Ok(connection_id)
    }

    fn require_remote_port(input: &PortForwardToolInput) -> OpenBitFunResult<u16> {
        input
            .remote_port
            .filter(|port| *port != 0)
            .ok_or_else(|| OpenBitFunError::tool("start requires remote_port".to_string()))
    }

    fn require_forward_id(input: &PortForwardToolInput) -> OpenBitFunResult<String> {
        input
            .forward_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .ok_or_else(|| OpenBitFunError::tool("stop requires forward_id".to_string()))
    }
}

impl Default for PortForwardTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PortForwardTool {
    fn name(&self) -> &str {
        "PortForward"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Make a port listening on an SSH host reachable from the user's machine, so they can open it in a browser.

Operations:
- "targets": List SSH hosts you can forward from (saved OpenBitFun connections and ~/.ssh/config hosts). Read-only.
- "detect": List TCP ports currently listening on the host. Read-only; forwards nothing.
- "start": Forward one remote port. Requires remote_port. Returns the local address to give the user.
- "list": Show forwards currently running for the host.
- "stop": Stop one forward by forward_id.

`target` names the SSH host: a saved connection (id or name), a ~/.ssh/config Host, or [user@]host[:port]. Omit it only when the session already runs in a remote SSH workspace. Ad-hoc targets authenticate with an SSH agent or a config-declared key; a host needing a password must be saved in OpenBitFun's SSH connections first.

The returned local_port is authoritative and is NOT always the port requested: if that local port is in use, a free one is bound instead and requested_local_port records what was asked for. Always report the returned local_address rather than assuming it matches the remote port.

Forwards bind 127.0.0.1 and last until stopped or the connection drops. Set expose_on_lan only when the user wants other devices on their network to reach the service too."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Forward a port from any SSH host to the user's machine.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    /// Hidden in builds without remote SSH support. The tool stays in the
    /// provider plan so registry construction is total, but a build with no SSH
    /// transport has nothing for it to forward over, and offering a tool that
    /// can only fail is worse than not offering it.
    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        cfg!(feature = "remote-workspace")
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["targets", "detect", "start", "list", "stop"]
                },
                "target": {
                    "type": "string",
                    "description": "SSH host: a saved connection (id or name), a ~/.ssh/config Host, or [user@]host[:port]. Optional in a remote SSH workspace, where it defaults to that workspace's host."
                },
                "remote_port": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 65535,
                    "description": "Required for start. The port as seen from the SSH host."
                },
                "remote_host": {
                    "type": "string",
                    "description": "Address the SSH host uses to reach the service. Defaults to 127.0.0.1, which is what a server bound to localhost needs. Set it to reach a service on another machine in the host's network."
                },
                "local_port": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 65535,
                    "description": "Preferred local port for start. Omit to get a free one; a requested port that is taken is replaced, not refused."
                },
                "expose_on_lan": {
                    "type": "boolean",
                    "default": false,
                    "description": "Bind every local interface instead of 127.0.0.1, so other devices on the user's network can reach the service."
                },
                "label": {
                    "type": "string",
                    "description": "Short name shown to the user, e.g. the service name."
                },
                "forward_id": {
                    "type": "string",
                    "description": "Required for stop. Comes from start or list."
                }
            },
            "required": ["operation"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "operation": {"type": "string", "enum": ["targets", "detect", "start", "list", "stop"]},
                "target": {"type": "string"},
                "count": {"type": "integer"},
                "targets": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
                "listening_ports": {"type": "array", "items": {"type": "integer"}},
                "local_address": {"type": "string"},
                "local_url": {"type": "string"},
                "local_port_moved": {"type": "boolean"},
                "forward": {"type": "object", "additionalProperties": true},
                "forwards": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
                "forward_id": {"type": "string"},
                "note": {"type": "string"}
            },
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let input: PortForwardToolInput = serde_json::from_value(input.clone())
            .map_err(|error| OpenBitFunError::validation(format!("Invalid input: {error}")))?;
        let target = input.trimmed_target().unwrap_or("workspace").to_string();
        let intent = match input.operation {
            // Reading what exists changes nothing on either machine.
            PortForwardOperation::Targets
            | PortForwardOperation::Detect
            | PortForwardOperation::List => return Ok(Vec::new()),
            PortForwardOperation::Start => PermissionIntent::new(
                "port_forward.start",
                vec![format!(
                    "{target}:{}",
                    input.remote_port.unwrap_or_default()
                )],
            ),
            PortForwardOperation::Stop => PermissionIntent::new(
                "port_forward.stop",
                vec![format!(
                    "{target}:{}",
                    input.forward_id.as_deref().unwrap_or_default()
                )],
            ),
        };
        Ok(vec![intent])
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let target = input
            .get("target")
            .and_then(Value::as_str)
            .map(|target| format!(" on {target}"))
            .unwrap_or_default();
        match input.get("operation").and_then(Value::as_str) {
            Some("targets") => "Listing SSH hosts available for forwarding".to_string(),
            Some("detect") => format!("Detecting listening ports{target}"),
            Some("list") => format!("Listing port forwards{target}"),
            Some("start") => match input.get("remote_port").and_then(Value::as_u64) {
                Some(port) => format!("Forwarding port {port}{target}"),
                None => format!("Starting a port forward{target}"),
            },
            Some("stop") => "Stopping a port forward".to_string(),
            _ => "Port forwarding".to_string(),
        }
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let invalid = |message: String| ValidationResult {
            result: false,
            message: Some(message),
            error_code: Some(400),
            meta: None,
        };

        let parsed: PortForwardToolInput = match serde_json::from_value(input.clone()) {
            Ok(parsed) => parsed,
            Err(error) => return invalid(format!("Invalid input: {error}")),
        };
        match parsed.operation {
            PortForwardOperation::Start => {
                if let Err(error) = Self::require_remote_port(&parsed) {
                    return invalid(error.to_string());
                }
            }
            PortForwardOperation::Stop => {
                if let Err(error) = Self::require_forward_id(&parsed) {
                    return invalid(error.to_string());
                }
            }
            _ => {}
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    #[cfg(not(feature = "remote-workspace"))]
    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Err(OpenBitFunError::tool(
            "This build has no remote SSH support, so ports cannot be forwarded".to_string(),
        ))
    }

    #[cfg(feature = "remote-workspace")]
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let input: PortForwardToolInput = serde_json::from_value(input.clone())
            .map_err(|error| OpenBitFunError::tool(format!("Invalid input: {error}")))?;
        let ssh_manager = resolve_ssh_manager().await?;
        let forwards = global_port_forward_manager();

        // `stop` addresses a forward directly and `targets` has no host yet, so
        // neither needs a connection resolved first.
        let data = match input.operation {
            PortForwardOperation::Targets => {
                let saved = ssh_manager.get_saved_connections().await;
                let mut targets = Vec::new();
                for connection in &saved {
                    targets.push(json!({
                        "target": connection.id,
                        "name": connection.name,
                        "host": connection.host,
                        "port": connection.port,
                        "username": connection.username,
                        "source": "saved",
                        "connected": ssh_manager.is_connected(&connection.id).await,
                    }));
                }
                for entry in ssh_manager.list_ssh_config_hosts().await {
                    if saved
                        .iter()
                        .any(|connection| connection.host.eq_ignore_ascii_case(&entry.host))
                    {
                        continue;
                    }
                    targets.push(json!({
                        "target": entry.host,
                        "host": entry.hostname.unwrap_or_else(|| entry.host.clone()),
                        "port": entry.port,
                        "username": entry.user,
                        "source": "ssh_config",
                        "connected": false,
                    }));
                }
                json!({
                    "success": true,
                    "operation": "targets",
                    "count": targets.len(),
                    "targets": targets,
                    "note": "Any [user@]host[:port] also works as a target, not only these.",
                })
            }
            PortForwardOperation::Detect => {
                let connection_id =
                    Self::resolve_target(&ssh_manager, input.trimmed_target(), context).await?;
                let ports = list_remote_listening_ports(&ssh_manager, &connection_id)
                    .await
                    .map_err(|error| OpenBitFunError::tool(format!("{error:#}")))?;
                json!({
                    "success": true,
                    "operation": "detect",
                    "target": connection_id,
                    "count": ports.len(),
                    "listening_ports": ports,
                })
            }
            PortForwardOperation::Start => {
                let remote_port = Self::require_remote_port(&input)?;
                let connection_id =
                    Self::resolve_target(&ssh_manager, input.trimmed_target(), context).await?;
                let forward = forwards
                    .start_local_forward(&PortForwardRequest {
                        connection_id: connection_id.clone(),
                        remote_port,
                        remote_host: input.remote_host.clone(),
                        local_port: input.local_port,
                        expose_on_lan: input.expose_on_lan,
                        label: input.label.clone(),
                    })
                    .await
                    .map_err(|error| OpenBitFunError::tool(format!("{error:#}")))?;
                let moved = forward.requested_local_port.is_some();
                json!({
                    "success": true,
                    "operation": "start",
                    "target": connection_id,
                    "local_address": forward.local_address(),
                    "local_url": format!("http://{}", forward.local_address()),
                    "local_port_moved": moved,
                    "forward": forward,
                    "note": if moved {
                        "The requested local port was unavailable, so a different one was bound. Report local_address to the user."
                    } else {
                        "Report local_address to the user."
                    },
                })
            }
            PortForwardOperation::List => {
                let connection_id =
                    Self::resolve_target(&ssh_manager, input.trimmed_target(), context).await?;
                let active = forwards.list_forwards_for_connection(&connection_id).await;
                json!({
                    "success": true,
                    "operation": "list",
                    "target": connection_id,
                    "count": active.len(),
                    "forwards": active,
                })
            }
            PortForwardOperation::Stop => {
                let forward_id = Self::require_forward_id(&input)?;
                forwards
                    .stop_forward(&forward_id)
                    .await
                    .map_err(|error| OpenBitFunError::tool(format!("{error:#}")))?;
                json!({
                    "success": true,
                    "operation": "stop",
                    "forward_id": forward_id,
                })
            }
        };

        Ok(vec![ToolResult::Result {
            result_for_assistant: Some(data.to_string()),
            data,
            image_attachments: None,
        }])
    }
}

/// Reach the SSH manager that owns this process's connections.
#[cfg(feature = "remote-workspace")]
async fn resolve_ssh_manager() -> OpenBitFunResult<SSHConnectionManager> {
    let manager = crate::service::remote_ssh::workspace_state::get_remote_workspace_manager()
        .ok_or_else(|| {
            OpenBitFunError::tool("Remote SSH services are not initialized".to_string())
        })?;
    manager
        .get_ssh_manager()
        .await
        .ok_or_else(|| OpenBitFunError::tool("SSH manager is not available".to_string()))
}

#[cfg(test)]
mod tests {
    use super::{parse_endpoint, PortForwardTool};
    use crate::agentic::tools::framework::Tool;
    use serde_json::json;

    #[test]
    fn schema_stays_flat_and_covers_every_operation() {
        let tool = PortForwardTool::new();
        let schema = tool.input_schema();
        let properties = schema["properties"]
            .as_object()
            .expect("properties should be an object");

        // A flat, small property set is what keeps this callable in one shot.
        assert!(
            properties.len() <= 8,
            "schema grew to {} properties",
            properties.len()
        );
        assert_eq!(
            schema["required"].as_array().map(Vec::len),
            Some(1),
            "operation should be the only required field"
        );

        let operations = schema["properties"]["operation"]["enum"]
            .as_array()
            .expect("operation enum");
        for operation in ["targets", "detect", "start", "list", "stop"] {
            assert!(
                operations.contains(&json!(operation)),
                "missing {operation}"
            );
        }
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn the_tool_is_offered_outside_remote_workspaces() {
        // A session that reached a host with `ssh` in a shell still needs to
        // forward its ports, so availability must not depend on the workspace —
        // only on the build carrying an SSH transport at all.
        let tool = PortForwardTool::new();
        assert!(tool.is_available_in_context(None).await);
    }

    #[tokio::test]
    async fn start_and_stop_report_their_missing_field() {
        let tool = PortForwardTool::new();
        assert!(
            !tool
                .validate_input(&json!({ "operation": "start" }), None)
                .await
                .result
        );
        assert!(
            !tool
                .validate_input(&json!({ "operation": "stop" }), None)
                .await
                .result
        );
        // Discovery needs nothing at all.
        assert!(
            tool.validate_input(&json!({ "operation": "targets" }), None)
                .await
                .result
        );
    }

    #[test]
    fn endpoints_parse_the_shapes_an_agent_would_type() {
        let parsed = parse_endpoint("root@10.0.0.5:2222").expect("user, host, and port");
        assert_eq!(parsed.user.as_deref(), Some("root"));
        assert_eq!(parsed.host, "10.0.0.5");
        assert_eq!(parsed.port, Some(2222));

        let alias = parse_endpoint("myserver").expect("a bare alias is a valid target");
        assert_eq!(alias.host, "myserver");
        assert_eq!(alias.user, None);
        assert_eq!(alias.port, None);

        let ipv6 = parse_endpoint("[2001:db8::1]").expect("an IPv6 literal");
        assert_eq!(ipv6.host, "2001:db8::1");
        assert_eq!(
            ipv6.port, None,
            "the address's own colons are not a port number"
        );

        assert!(parse_endpoint("has space").is_none());
        assert!(parse_endpoint("host:not-a-port").is_none());
    }
}
