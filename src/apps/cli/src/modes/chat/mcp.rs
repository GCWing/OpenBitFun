use openbitfun_product_domains::mcp::{
    McpServerAction, McpServerMutation, McpServerSummary, McpTransport,
};

fn bounded_mcp_terminal_text(value: &str) -> String {
    let escaped = crate::plugin_diagnostics::escape_terminal_text(value);
    let mut chars = escaped.chars();
    let bounded = chars.by_ref().take(512).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

fn mcp_item_from_summary(server: McpServerSummary) -> McpItem {
    let action = match server.action {
        McpServerAction::NativeToggle => McpItemAction::NativeToggle,
        McpServerAction::ReadOnly { reason } => McpItemAction::ReadOnly {
            reason: bounded_mcp_terminal_text(&reason),
        },
        McpServerAction::ExternalDecision {
            candidate_id,
            decision_key,
            approved,
            expected_mcp_generation,
            expected_preference_revision,
        } => McpItemAction::ExternalDecision {
            candidate_id,
            decision_key,
            approved,
            expected_mcp_generation,
            expected_preference_revision,
        },
        McpServerAction::ConflictChoice {
            conflict_key,
            candidate_id,
            approve_external,
            expected_mcp_generation,
            expected_preference_revision,
        } => McpItemAction::ConflictChoice {
            conflict_key,
            candidate_id,
            approve_external,
            expected_mcp_generation,
            expected_preference_revision,
        },
    };
    McpItem {
        id: server.id,
        name: bounded_mcp_terminal_text(&server.name),
        server_type: bounded_mcp_terminal_text(&server.server_type),
        status: bounded_mcp_terminal_text(&server.status),
        tool_count: server.tool_count,
        source_label: bounded_mcp_terminal_text(&server.source_label),
        external: server.external,
        detail: bounded_mcp_terminal_text(&server.detail),
        action,
    }
}

fn native_mcp_detail(config: &openbitfun_core::service::mcp::MCPServerConfig) -> String {
    let server_type = format!("{:?}", config.server_type).to_ascii_lowercase();
    let transport = config.resolved_transport().as_str();
    if config.server_type == openbitfun_core::service::mcp::MCPServerType::Local {
        format!(
            "type: {server_type}; transport: {transport}; command: {}; arguments: {}; environment variables set: {}",
            config.command.as_deref().unwrap_or("unknown"),
            config.args.len(),
            if config.env.is_empty() { "none" } else { "configured" }
        )
    } else {
        let origin = config
            .url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .and_then(|url| {
                let host = url.host_str()?;
                Some(match url.port() {
                    Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
                    None => format!("{}://{}", url.scheme(), host),
                })
            })
            .unwrap_or_else(|| "unknown".to_string());
        format!(
            "type: {server_type}; transport: {transport}; remote origin: {origin}; HTTP headers: {}",
            if config.headers.is_empty() { "none" } else { "configured" }
        )
    }
}

fn external_mcp_action(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
    snapshot: &openbitfun_product_domains::external_sources::ExternalSourceCatalogSnapshot,
) -> McpServerAction {
    use openbitfun_product_domains::external_sources::ExternalMcpActivationState as State;
    match &entry.activation_state {
        State::ApprovalRequired | State::Declined | State::ConfigurationChanged => {
            McpServerAction::ExternalDecision {
                candidate_id: entry.candidate_id.clone(),
                decision_key: entry.decision_key.clone(),
                approved: true,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            }
        }
        State::Starting | State::Active | State::RuntimeUnavailable { .. } => {
            McpServerAction::ExternalDecision {
                candidate_id: entry.candidate_id.clone(),
                decision_key: entry.decision_key.clone(),
                approved: false,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            }
        }
        State::Conflict | State::Covered { .. } => snapshot
            .mcp_conflicts
            .iter()
            .find(|conflict| {
                conflict
                    .candidates
                    .iter()
                    .any(|candidate| candidate.candidate_id == entry.candidate_id)
            })
            .map(|conflict| McpServerAction::ConflictChoice {
                conflict_key: conflict.conflict_key.clone(),
                candidate_id: entry.candidate_id.clone(),
                approve_external: true,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            })
            .unwrap_or_else(|| McpServerAction::ReadOnly {
                reason: "Refresh to review the current conflict".to_string(),
            }),
        State::Unsupported { reason } => McpServerAction::ReadOnly {
            reason: format!("Not supported: {reason}"),
        },
        State::SourceDisabled => McpServerAction::ReadOnly {
            reason: "Enable this server in the source application".to_string(),
        },
        State::Removed => McpServerAction::ReadOnly {
            reason: "Removed".to_string(),
        },
        _ => McpServerAction::ReadOnly {
            reason: "This external MCP state is read-only".to_string(),
        },
    }
}

async fn external_mcp_status(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
    manager: &openbitfun_core::service::mcp::MCPServerManager,
) -> String {
    use openbitfun_product_domains::external_sources::ExternalMcpActivationState as State;
    match &entry.activation_state {
        State::Active => match entry.runtime_id.as_deref() {
            Some(id) => {
                match tokio::time::timeout(Duration::from_millis(30), manager.get_server_status(id))
                    .await
                {
                    Ok(Ok(value)) => format!("{value:?}"),
                    Ok(Err(_)) => "Unavailable".to_string(),
                    Err(_) => "Starting".to_string(),
                }
            }
            None => "Enabled".to_string(),
        },
        State::ApprovalRequired => "Confirmation required".to_string(),
        State::Starting => "Starting".to_string(),
        State::Declined => "Kept disabled".to_string(),
        State::Conflict => "Choice required".to_string(),
        State::Covered { .. } => "Not selected".to_string(),
        State::SourceDisabled => "Source disabled".to_string(),
        State::ConfigurationChanged => "Changed; confirm again".to_string(),
        State::Unsupported { .. } => "Not supported".to_string(),
        State::RuntimeUnavailable { reason } => format!("Unavailable - {reason}"),
        State::Removed => "Removed".to_string(),
        _ => "Unavailable".to_string(),
    }
}

fn external_mcp_detail(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
) -> String {
    let definition = &entry.definition;
    match definition.transport {
        openbitfun_product_domains::external_sources::ExternalMcpTransportKind::LocalStdio => format!(
            "source MCP configuration; local command: {}; arguments: {}; environment variables set: {}",
            definition.command_preview.as_deref().unwrap_or("unknown"),
            definition.argument_count,
            if definition.environment_keys.is_empty() { "none" } else { "configured" },
        ),
        openbitfun_product_domains::external_sources::ExternalMcpTransportKind::StreamableHttp => format!(
            "source MCP configuration; remote origin: {}; HTTP headers: {}",
            definition.remote_url_preview.as_deref().unwrap_or("unknown"),
            if definition.header_names.is_empty() { "none" } else { "configured" },
        ),
        _ => "unsupported external MCP transport".to_string(),
    }
}

fn mcp_config_from_mutation(
    name: &str,
    mutation: McpServerMutation,
) -> Result<openbitfun_core::service::mcp::MCPServerConfig> {
    let (server_type, transport) = match mutation.transport {
        McpTransport::Stdio => (
            openbitfun_core::service::mcp::MCPServerType::Local,
            openbitfun_core::service::mcp::MCPServerTransport::Stdio,
        ),
        McpTransport::Sse => (
            openbitfun_core::service::mcp::MCPServerType::Remote,
            openbitfun_core::service::mcp::MCPServerTransport::Sse,
        ),
        McpTransport::StreamableHttp => (
            openbitfun_core::service::mcp::MCPServerType::Remote,
            openbitfun_core::service::mcp::MCPServerTransport::StreamableHttp,
        ),
    };
    let oauth = mutation
        .oauth
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| anyhow!("MCP OAuth configuration does not match the supported schema"))?;
    let xaa = mutation
        .xaa
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| anyhow!("MCP XAA configuration does not match the supported schema"))?;
    Ok(openbitfun_core::service::mcp::MCPServerConfig {
        id: name.to_string(),
        name: name.to_string(),
        server_type,
        transport: Some(transport),
        command: mutation.command,
        args: mutation.args,
        env: mutation.env,
        working_directory: None,
        inherit_parent_environment: None,
        headers: mutation.headers,
        url: mutation.url,
        auto_start: mutation.auto_start,
        enabled: mutation.enabled,
        location: openbitfun_core::service::mcp::ConfigLocation::User,
        capabilities: Vec::new(),
        settings: std::collections::HashMap::new(),
        oauth,
        oauth_enabled: None,
        xaa,
        timeouts: Default::default(),
    })
}

fn sanitize_mcp_error(error: impl AsRef<str>) -> String {
    let value = error.as_ref();
    let lower = value.to_ascii_lowercase();
    if lower.contains("api key") || lower.contains("authorization") || lower.contains("header") {
        "The MCP owner rejected the request".to_string()
    } else {
        value.to_string()
    }
}

/// Completion message for the `/mcp` add flow. In Shared TUI mode the add
/// mutates the local MCP compatibility owner of this CLI process, not the
/// already-running Shared Runtime Host, so it must not be reported as
/// "started" for that Runtime.
fn mcp_add_completion_message(name: &str, shared: bool) -> String {
    if shared {
        format!(
            "MCP server '{name}' added to the local compatibility owner; the Shared Runtime Host is not reconfigured"
        )
    } else {
        format!("MCP server '{name}' added and started")
    }
}

impl ChatMode {
    fn show_mcp_selector(
        &self,
        chat_view: &mut ChatView,
        _chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        chat_view.show_mcp_selector(self.get_mcp_items(rt_handle));
    }

    pub(super) fn get_mcp_items(&self, rt_handle: &tokio::runtime::Handle) -> Vec<McpItem> {
        tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("MCP management is unavailable for a Remote workspace")
                }
                let mcp = if let Some(mcp) = openbitfun_core::service::mcp::get_global_mcp_service()
                {
                    mcp
                } else {
                    let config = openbitfun_core::service::config::get_global_config_service()
                        .await
                        .map_err(|error| anyhow!(error.to_string()))?;
                    crate::ensure_cli_mcp_service(config)
                        .ok_or_else(|| anyhow!("The current CLI Host has no MCP service"))?
                };
                let workspace = self.agent.workspace_id();
                let external = openbitfun_core::external_sources::external_source_snapshot(
                    workspace.as_deref(),
                    false,
                )
                .await
                .map_err(|error| anyhow!(sanitize_mcp_error(error)))?;
                let tool_registry =
                    openbitfun_core::agentic::tools::registry::get_global_tool_registry();
                let tools = tool_registry.read().await.get_all_tools();
                let configs = mcp
                    .config_service()
                    .load_all_configs()
                    .await
                    .map_err(|error| anyhow!(error.to_string()))?;
                let manager = mcp.server_manager();
                let mut servers = Vec::new();

                for config in configs {
                    let status = if !config.enabled {
                        "Stopped".to_string()
                    } else {
                        match tokio::time::timeout(
                            Duration::from_millis(30),
                            manager.get_server_status(&config.id),
                        )
                        .await
                        {
                            Ok(Ok(value)) => format!("{value:?}"),
                            _ => "Starting".to_string(),
                        }
                    };
                    let prefix = format!("mcp_{}_", config.id);
                    let tool_count = tools
                        .iter()
                        .filter(|tool| tool.name().starts_with(&prefix))
                        .count();
                    let native_id =
                        openbitfun_core::external_sources::native_mcp_candidate_id(&config.id);
                    let conflict = external.mcp_conflicts.iter().find(|conflict| {
                        conflict
                            .candidates
                            .iter()
                            .any(|candidate| candidate.candidate_id == native_id)
                    });
                    let action = match conflict {
                        Some(conflict)
                            if conflict
                                .candidates
                                .iter()
                                .find(|candidate| candidate.candidate_id == native_id)
                                .is_some_and(|candidate| !candidate.available) =>
                        {
                            let reason = conflict
                                .candidates
                                .iter()
                                .find(|candidate| candidate.candidate_id == native_id)
                                .and_then(|candidate| candidate.unavailable_reason.clone())
                                .unwrap_or_else(|| {
                                    "Enable this OpenBitFun server in its MCP configuration"
                                        .to_string()
                                });
                            McpServerAction::ReadOnly { reason }
                        }
                        Some(conflict)
                            if conflict.selected_candidate_id.as_deref() != Some(&native_id) =>
                        {
                            McpServerAction::ConflictChoice {
                                conflict_key: conflict.conflict_key.clone(),
                                candidate_id: native_id,
                                approve_external: false,
                                expected_mcp_generation: external.mcp_generation,
                                expected_preference_revision: external.preference_revision,
                            }
                        }
                        _ => McpServerAction::NativeToggle,
                    };
                    servers.push(McpServerSummary {
                        id: config.id.clone(),
                        name: config.name.clone(),
                        server_type: format!("{:?}", config.server_type).to_ascii_lowercase(),
                        status,
                        tool_count,
                        source_label: "OpenBitFun".to_string(),
                        external: false,
                        detail: native_mcp_detail(&config),
                        action,
                    });
                }

                for entry in &external.mcp_servers {
                    let source_label = external
                        .sources
                        .iter()
                        .find(|source| source.record.key == entry.definition.id.source)
                        .map(|source| source.record.display_name.clone())
                        .unwrap_or_else(|| "External AI app".to_string());
                    let action = external_mcp_action(entry, &external);
                    let status = external_mcp_status(entry, manager.as_ref()).await;
                    let tool_count = entry.runtime_id.as_deref().map_or(0, |runtime_id| {
                        let prefix = format!("mcp_{runtime_id}_");
                        tools
                            .iter()
                            .filter(|tool| tool.name().starts_with(&prefix))
                            .count()
                    });
                    servers.push(McpServerSummary {
                        id: entry.candidate_id.clone(),
                        name: entry.definition.name.clone(),
                        server_type: "external".to_string(),
                        status,
                        tool_count,
                        source_label,
                        external: true,
                        detail: external_mcp_detail(entry),
                        action,
                    });
                }

                if servers.is_empty() && external.discovery_pending {
                    servers.push(McpServerSummary {
                        id: "external-mcp-discovery-pending".to_string(),
                        name: "External MCP servers".to_string(),
                        server_type: "external".to_string(),
                        status: "Checking".to_string(),
                        tool_count: 0,
                        source_label: "External AI applications".to_string(),
                        external: true,
                        detail: "OpenBitFun is still checking compatible MCP settings".to_string(),
                        action: McpServerAction::ReadOnly {
                            reason: "Still checking; this list updates automatically".to_string(),
                        },
                    });
                }

                Ok::<Vec<McpItem>, anyhow::Error>(
                    servers.into_iter().map(mcp_item_from_summary).collect(),
                )
            })
        })
        .unwrap_or_else(|error| {
            tracing::warn!("Failed to load MCP server catalog: {error}");
            Vec::new()
        })
    }

    fn activate_mcp_item(
        &mut self,
        item: McpItem,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
    ) {
        match &item.action {
            McpItemAction::NativeToggle => self.toggle_mcp_server(&item.id, chat_view),
            McpItemAction::ReadOnly { reason } => {
                chat_state.add_system_message(format!("{}: {}", item.name, reason));
            }
            McpItemAction::ExternalDecision { .. } | McpItemAction::ConflictChoice { .. } => {
                if self.pending_mcp_op.is_some() || self.is_mcp_server_task_running(&item.id) {
                    return;
                }
                chat_view.mcp_selector_set_loading(Some(item.id.clone()));
                self.pending_mcp_op = Some(PendingMcpOp::External(item));
            }
        }
    }

    fn toggle_mcp_server(&mut self, server_id: &str, chat_view: &mut ChatView) {
        if self.pending_mcp_op.is_some() || self.is_mcp_server_task_running(server_id) {
            return;
        }
        chat_view.mcp_selector_set_loading(Some(server_id.to_string()));
        self.pending_mcp_op = Some(PendingMcpOp::Toggle(server_id.to_string()));
    }

    fn execute_mcp_toggle(
        &mut self,
        server_id: &str,
        _chat_view: &mut ChatView,
        _chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let server_id = server_id.to_string();
        let tracked_server_id = server_id.clone();
        let handle = rt_handle.spawn(async move {
            let mcp = openbitfun_core::service::mcp::get_global_mcp_service()
                .ok_or_else(|| "The current CLI Host has no MCP service".to_string())?;
            let manager = mcp.server_manager();
            match manager.get_server_status(&server_id).await {
                Ok(openbitfun_core::service::mcp::MCPServerStatus::Connected)
                | Ok(openbitfun_core::service::mcp::MCPServerStatus::Healthy) => {
                    manager.stop_server(&server_id).await
                }
                _ => manager.start_server(&server_id).await,
            }
            .map_err(|error| anyhow!(error.to_string()))
            .map(|_| ())
            .map_err(|error| error.to_string())
        });
        self.pending_mcp_tasks.push(PendingMcpTask::Toggle {
            server_id: tracked_server_id,
            handle,
        });
    }

    fn execute_external_mcp_action(
        &mut self,
        item: McpItem,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let workspace_id = self.agent.workspace_id();
        let action = item.action.clone();
        let item_id = item.id.clone();
        let item_name = item.name.clone();
        let handle = rt_handle.spawn(async move {
            match action {
                McpItemAction::ExternalDecision {
                    candidate_id,
                    decision_key,
                    approved,
                    expected_mcp_generation,
                    expected_preference_revision,
                } => openbitfun_core::external_sources::set_external_mcp_server_decision(
                    workspace_id.as_deref(),
                    &candidate_id,
                    &decision_key,
                    approved,
                    expected_mcp_generation,
                    expected_preference_revision,
                )
                .await
                .map(|_| ()),
                McpItemAction::ConflictChoice {
                    conflict_key,
                    candidate_id,
                    approve_external,
                    expected_mcp_generation,
                    expected_preference_revision,
                } => openbitfun_core::external_sources::choose_external_mcp_conflict(
                    workspace_id.as_deref(),
                    &conflict_key,
                    &candidate_id,
                    approve_external,
                    expected_mcp_generation,
                    expected_preference_revision,
                )
                .await
                .map(|_| ()),
                McpItemAction::NativeToggle | McpItemAction::ReadOnly { .. } => {
                    Err("The MCP action is no longer available; reopen /mcp".to_string())
                }
            }
            .map_err(|error| error.to_string())
        });
        self.pending_mcp_tasks.push(PendingMcpTask::External {
            item_id,
            item_name,
            handle,
        });
        chat_state.add_system_message(
            "Saving the MCP server choice. Existing sessions continue running while it is applied."
                .to_string(),
        );
        chat_view.mcp_selector_cancel_confirm_external();
    }

    fn is_mcp_server_task_running(&self, server_id: &str) -> bool {
        self.pending_mcp_tasks.iter().any(|task| match task {
            PendingMcpTask::Toggle { server_id: id, .. }
            | PendingMcpTask::Delete { server_id: id, .. } => id == server_id,
            PendingMcpTask::Add { .. } => false,
            PendingMcpTask::External { item_id, .. } => item_id == server_id,
        })
    }

    fn has_pending_mcp_add_task(&self) -> bool {
        self.pending_mcp_tasks
            .iter()
            .any(|task| matches!(task, PendingMcpTask::Add { .. }))
    }

    fn poll_mcp_task_completion(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) -> bool {
        let mut changed = false;
        let mut index = 0;
        while index < self.pending_mcp_tasks.len() {
            let finished = match &self.pending_mcp_tasks[index] {
                PendingMcpTask::Toggle { handle, .. }
                | PendingMcpTask::Add { handle, .. }
                | PendingMcpTask::Delete { handle, .. }
                | PendingMcpTask::External { handle, .. } => handle.is_finished(),
            };
            if !finished {
                index += 1;
                continue;
            }

            changed = true;
            let task = self.pending_mcp_tasks.swap_remove(index);
            let (success_message, failure_context, result) = match task {
                PendingMcpTask::Toggle { server_id, handle } => (
                    None,
                    format!("toggle MCP server '{server_id}'"),
                    tokio::task::block_in_place(|| rt_handle.block_on(handle)),
                ),
                PendingMcpTask::Add { name, handle } => (
                    Some(mcp_add_completion_message(&name, self.agent.is_shared())),
                    format!("add MCP server '{name}'"),
                    tokio::task::block_in_place(|| rt_handle.block_on(handle)),
                ),
                PendingMcpTask::Delete { server_id, handle } => (
                    Some(format!("MCP server '{server_id}' deleted")),
                    format!("delete MCP server '{server_id}'"),
                    tokio::task::block_in_place(|| rt_handle.block_on(handle)),
                ),
                PendingMcpTask::External {
                    item_name, handle, ..
                } => (
                    Some(format!("MCP server choice saved for '{item_name}'")),
                    format!("save the MCP server choice for '{item_name}'"),
                    tokio::task::block_in_place(|| rt_handle.block_on(handle)),
                ),
            };
            match result {
                Ok(Ok(())) => {
                    if let Some(message) = success_message {
                        chat_state.add_system_message(message);
                    }
                }
                Ok(Err(error)) => {
                    chat_state.add_system_message(format!("Could not {failure_context}: {error}"))
                }
                Err(error) => chat_state.add_system_message(format!(
                    "MCP task failed while trying to {failure_context}: {error}"
                )),
            }
            chat_view.set_status(None);
            chat_view.mcp_selector_set_loading(None);
            chat_view.mcp_selector_update_items(self.get_mcp_items(rt_handle));
        }
        changed
    }

    fn add_mcp_server(&mut self, name: &str, config_json_str: &str, chat_view: &mut ChatView) {
        if self.pending_mcp_op.is_some() || self.has_pending_mcp_add_task() {
            return;
        }
        chat_view.set_status(Some(format!("Adding MCP server '{name}'...")));
        self.pending_mcp_op = Some(PendingMcpOp::Add {
            name: name.to_string(),
            config_json: config_json_str.to_string(),
        });
    }

    fn execute_mcp_add(
        &mut self,
        name: &str,
        config_json_str: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let value: serde_json::Value = match serde_json::from_str(config_json_str) {
            Ok(config) => config,
            Err(error) => {
                chat_state.add_system_message(format!("Invalid JSON: {error}"));
                chat_view.set_status(None);
                return;
            }
        };
        let Some(config) = value.as_object() else {
            chat_state.add_system_message("MCP server config must be a JSON object".to_string());
            chat_view.set_status(None);
            return;
        };
        let string_map = |key: &str| {
            config
                .get(key)
                .and_then(serde_json::Value::as_object)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let transport = match config.get("type").and_then(serde_json::Value::as_str) {
            Some("sse") => McpTransport::Sse,
            Some("streamable-http" | "streamable_http" | "http") => McpTransport::StreamableHttp,
            _ => McpTransport::Stdio,
        };
        let mutation = McpServerMutation {
            transport,
            command: config
                .get("command")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            args: config
                .get("args")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            env: string_map("env"),
            headers: string_map("headers"),
            url: config
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            auto_start: config
                .get("autoStart")
                .or_else(|| config.get("auto_start"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            enabled: config
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            oauth: config.get("oauth").cloned(),
            xaa: config.get("xaa").cloned(),
        };
        let name = name.to_string();
        let task_name = name.clone();
        let handle = rt_handle.spawn(async move {
            let mcp = openbitfun_core::service::mcp::get_global_mcp_service()
                .ok_or_else(|| "The current CLI Host has no MCP service".to_string())?;
            let config =
                mcp_config_from_mutation(&name, mutation).map_err(|error| error.to_string())?;
            mcp.server_manager()
                .add_server(config)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        });
        self.pending_mcp_tasks.push(PendingMcpTask::Add {
            name: task_name,
            handle,
        });
    }

    fn delete_mcp_server(&mut self, server_id: &str, chat_view: &mut ChatView) {
        if self.pending_mcp_op.is_some() || self.is_mcp_server_task_running(server_id) {
            return;
        }
        chat_view.mcp_selector_set_loading(Some(server_id.to_string()));
        chat_view.mcp_selector_cancel_confirm_delete();
        self.pending_mcp_op = Some(PendingMcpOp::Delete(server_id.to_string()));
    }

    fn execute_mcp_delete(
        &mut self,
        server_id: &str,
        _chat_view: &mut ChatView,
        _chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let server_id = server_id.to_string();
        let task_server_id = server_id.clone();
        let handle = rt_handle.spawn(async move {
            let mcp = openbitfun_core::service::mcp::get_global_mcp_service()
                .ok_or_else(|| "The current CLI Host has no MCP service".to_string())?;
            mcp.config_service()
                .delete_server_config(&server_id)
                .await
                .map_err(|error| error.to_string())?;
            mcp.server_manager().schedule_stop_server(server_id);
            Ok::<(), String>(())
        });
        self.pending_mcp_tasks.push(PendingMcpTask::Delete {
            server_id: task_server_id,
            handle,
        });
    }

    fn open_mcp_config(&self, chat_state: &mut ChatState, _rt_handle: &tokio::runtime::Handle) {
        let config_path = if self.agent.is_remote_workspace() {
            None
        } else {
            openbitfun_core::infrastructure::try_get_path_manager_arc()
                .ok()
                .map(|manager| manager.app_config_file().display().to_string())
        };
        match config_path {
            Some(config_path) => chat_state.add_system_message(format!(
                "MCP servers are configured in:\n  {config_path}\n\nEdit the \"mcp_servers\" section."
            )),
            None => chat_state.add_system_message(
                "The MCP configuration path is unavailable from this Host.".to_string(),
            ),
        }
    }
}

#[cfg(test)]
mod mcp_terminal_tests {
    use super::*;

    #[test]
    fn mcp_summary_text_is_terminal_safe_and_bounded() {
        let item = mcp_item_from_summary(McpServerSummary {
            id: "server-id".to_string(),
            name: "unsafe\nname".to_string(),
            server_type: "local".to_string(),
            status: "Running\u{202e}".to_string(),
            tool_count: 1,
            source_label: "source\rlabel".to_string(),
            external: false,
            detail: "x".repeat(600),
            action: McpServerAction::ReadOnly {
                reason: "reason\ttext".to_string(),
            },
        });

        assert_eq!(item.name, "unsafe\\nname");
        assert_eq!(item.status, "Running\\u{202e}");
        assert_eq!(item.source_label, "source\\rlabel");
        assert_eq!(item.detail.chars().count(), 513);
        assert!(item.detail.ends_with('…'));
        assert!(matches!(
            item.action,
            McpItemAction::ReadOnly { ref reason } if reason == "reason\\ttext"
        ));
    }

    #[test]
    fn shared_add_does_not_report_runtime_started() {
        // In Shared TUI mode the add mutates this CLI process's local MCP
        // compatibility owner, not the already-running Shared Runtime Host,
        // so the completion message must not claim the server "started" for
        // that Runtime and must state the local scope.
        let shared = mcp_add_completion_message("srv", true);
        assert!(shared.contains("local compatibility owner"));
        assert!(shared.contains("Shared Runtime Host is not reconfigured"));
        assert!(!shared.contains("added and started"));

        // Embedded mode owns the runtime, so "added and started" stays accurate.
        assert_eq!(
            mcp_add_completion_message("srv", false),
            "MCP server 'srv' added and started"
        );
    }
}
