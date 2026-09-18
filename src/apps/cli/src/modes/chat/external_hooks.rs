const MAX_TUI_HOOK_SOURCES_PER_PROVIDER: usize = 10;
const MAX_TUI_HOOK_ENTRIES_PER_PROVIDER: usize = 100;
const MAX_TUI_HOOK_DIAGNOSTICS_PER_PROVIDER: usize = 20;
const MAX_TUI_HOOK_CATALOG_DIAGNOSTICS: usize = 20;

#[derive(Debug, Clone)]
struct HookManagementSnapshot {
    native: NativeHookOverview,
    imports: ExternalHookImportSnapshotV1,
}

enum HookManagementResult {
    Snapshot(HookManagementSnapshot),
    Plan(ExternalHookImportPlanV1),
    Changed {
        snapshot: HookManagementSnapshot,
        status: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HookManagementAction {
    Show { refresh: bool },
    Import { source_number: usize, confirm: bool },
    Update { import_number: usize, confirm: bool },
    Enable { import_number: usize },
    Disable { import_number: usize },
    Remove { import_number: usize },
    Reset { scope: ExternalSourceScope },
}

fn parse_hook_management_action(arguments: &str) -> Result<HookManagementAction, String> {
    let parts = arguments.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [] => Ok(HookManagementAction::Show { refresh: false }),
        ["refresh"] => Ok(HookManagementAction::Show { refresh: true }),
        ["reset", scope] => Err(format!(
            "Resetting a corrupt managed index requires: /hooks reset {scope} --confirm"
        )),
        ["reset", scope, "--confirm"] => match *scope {
            "user" => Ok(HookManagementAction::Reset {
                scope: ExternalSourceScope::UserGlobal,
            }),
            "project" => Ok(HookManagementAction::Reset {
                scope: ExternalSourceScope::Project,
            }),
            _ => Err("Hook reset scope must be user or project".to_string()),
        },
        [action, number] | [action, number, "--confirm"] => {
            let number = number
                .parse::<usize>()
                .ok()
                .filter(|number| *number > 0)
                .ok_or_else(|| "Hook source/import number must be 1 or greater".to_string())?;
            let confirm = parts.len() == 3;
            match *action {
                "import" => Ok(HookManagementAction::Import {
                    source_number: number,
                    confirm,
                }),
                "update" => Ok(HookManagementAction::Update {
                    import_number: number,
                    confirm,
                }),
                "enable" if !confirm => Ok(HookManagementAction::Enable {
                    import_number: number,
                }),
                "disable" if !confirm => Ok(HookManagementAction::Disable {
                    import_number: number,
                }),
                "remove" if confirm => Ok(HookManagementAction::Remove {
                    import_number: number,
                }),
                "remove" => Err(
                    "Removing a managed copy requires: /hooks remove <number> --confirm"
                        .to_string(),
                ),
                _ => Err(hook_management_usage()),
            }
        }
        _ => Err(hook_management_usage()),
    }
}

fn hook_management_usage() -> String {
    "Usage: /hooks [refresh | import <source-number> [--confirm] | update <import-number> [--confirm] | enable <import-number> | disable <import-number> | remove <import-number> --confirm | reset <user|project> --confirm]".to_string()
}

fn external_hook_help_text() -> String {
    native_hook_help_text()
}

fn extension_command_help_request(command_name: &str, arguments: &str) -> Option<String> {
    let arguments = arguments.trim();
    let requested = if command_name.eq_ignore_ascii_case("help") {
        arguments
    } else if matches!(arguments, "-h" | "--help" | "help") {
        command_name
    } else {
        return None;
    };
    match requested.to_ascii_lowercase().as_str() {
        "hooks" | "hooks_external" | "hooks-external" => Some(external_hook_help_text()),
        "extensions" => Some([
            "External integrations",
            "",
            "Usage: /extensions [status | refresh | safe-mode on | safe-mode off | source enable <source-key> | source disable <source-key>]",
            "",
            "Shows external AI application sources and controls OpenBitFun Safe Mode. Source files remain owned by their native application.",
            "",
            "Help: /help extensions, /extensions -h, or /extensions --help",
        ].join("\n")),
        "tools" => Some([
            "Tools",
            "",
            "Usage: /tools [refresh | enable <number> | disable <number> | choose <conflict-number> <choice-number>]",
            "",
            "Shows OpenBitFun, MCP, and compatible external tool sources. Activation and conflicts remain guarded by OpenBitFun policy.",
            "",
            "Help: /help tools, /tools -h, or /tools --help",
        ].join("\n")),
        "agent" | "agents" => Some([
            "Agents",
            "",
            "Usage: /agent [refresh | enable <number> | disable <number> | choose <conflict-number> <choice-number>]",
            "Alias: /agents",
            "",
            "Without arguments, opens the agent selector. Management arguments review compatible external subagents.",
            "",
            "Help: /help agent, /agent -h, or /agent --help",
        ].join("\n")),
        "mcp" | "mcps" => Some([
            "MCP servers",
            "",
            "Usage: /mcp",
            "Alias: /mcps",
            "",
            "Opens the shared MCP server manager, including compatible external MCP definitions after approval.",
            "",
            "Help: /help mcp, /mcp -h, or /mcp --help",
        ].join("\n")),
        _ => None,
    }
}

fn render_external_hook_catalog(snapshot: &ExternalHookCatalogSnapshotV1) -> String {
    let mut lines = vec![
        "Available external Hook sources".to_string(),
        "Discovery is read-only. Review an exact import plan before OpenBitFun copies or enables anything."
            .to_string(),
        String::new(),
    ];
    if snapshot.discovery_pending {
        lines.push("Hook discovery is still pending. Run /hooks refresh again.".to_string());
        return lines.join("\n");
    }
    if snapshot.sources.is_empty()
        && snapshot.failed_provider_ids.is_empty()
        && snapshot.stale_provider_ids.is_empty()
    {
        lines.push("No supported Hook configuration was found.".to_string());
    }
    if !snapshot.providers.is_empty() {
        let source_by_key = snapshot
            .sources
            .iter()
            .map(|source| (&source.key, source))
            .collect::<BTreeMap<_, _>>();
        for provider in &snapshot.providers {
            let provider_sources = snapshot
                .sources
                .iter()
                .filter(|source| source.key.provider_id == provider.provider_id)
                .collect::<Vec<_>>();
            let provider_entry_count = snapshot
                .entries
                .iter()
                .filter(|entry| entry.source.provider_id == provider.provider_id)
                .count();
            let stale = snapshot
                .stale_provider_ids
                .iter()
                .any(|provider_id| provider_id == &provider.provider_id);
            let failed = snapshot
                .failed_provider_ids
                .iter()
                .any(|provider_id| provider_id == &provider.provider_id);
            lines.push(format!(
                "{}: {} Hook{}, {} source{}{}",
                crate::plugin_diagnostics::escape_terminal_text(&provider.display_name),
                provider_entry_count,
                plural(provider_entry_count),
                provider_sources.len(),
                plural(provider_sources.len()),
                if failed {
                    " (discovery failed)"
                } else if stale {
                    " (stale)"
                } else {
                    ""
                },
            ));
            if provider_sources.is_empty() {
                lines.push(if failed {
                    "  No valid catalog is available because static discovery failed.".to_string()
                } else if stale {
                    "  The last valid catalog is empty; the latest refresh failed.".to_string()
                } else {
                    "  No supported static Hook source was found.".to_string()
                });
                continue;
            }
            let mut rendered_entries = 0;
            let mut rendered_diagnostics = 0;
            for source in provider_sources
                .iter()
                .take(MAX_TUI_HOOK_SOURCES_PER_PROVIDER)
            {
                let source_number = snapshot
                    .sources
                    .iter()
                    .position(|candidate| candidate.key == source.key)
                    .map(|index| index + 1)
                    .unwrap_or(0);
                lines.push(format!(
                    "  {source_number}. {} [{}; {}; {}; key: {}]",
                    crate::plugin_diagnostics::escape_terminal_text(&source.display_name),
                    source_scope_label(source.scope),
                    source_health_label(source.health),
                    crate::plugin_diagnostics::escape_terminal_text(&source.location_hint),
                    crate::plugin_diagnostics::escape_terminal_text(&source.key.stable_key()),
                ));
                for entry in snapshot
                    .entries
                    .iter()
                    .filter(|entry| entry.source == source.key)
                    .take(MAX_TUI_HOOK_ENTRIES_PER_PROVIDER - rendered_entries)
                {
                    lines.push(format!(
                        "    - {} [{}; {}; {}; matcher: {}]",
                        crate::plugin_diagnostics::escape_terminal_text(&entry.native_event),
                        hook_handler_label(entry.handler_kind),
                        projection_label(entry),
                        native_activation_label(entry.native_activation),
                        crate::plugin_diagnostics::escape_terminal_text(&matcher_label(
                            &entry.matcher
                        )),
                    ));
                    rendered_entries += 1;
                }
                for diagnostic in source
                    .diagnostics
                    .iter()
                    .take(MAX_TUI_HOOK_DIAGNOSTICS_PER_PROVIDER - rendered_diagnostics)
                {
                    lines.push(format!(
                        "    ! {}: {}",
                        crate::plugin_diagnostics::escape_terminal_text(&diagnostic.code),
                        crate::plugin_diagnostics::escape_terminal_text(&diagnostic.message)
                    ));
                    rendered_diagnostics += 1;
                }
            }
            let omitted_sources = provider_sources
                .len()
                .saturating_sub(MAX_TUI_HOOK_SOURCES_PER_PROVIDER);
            let omitted_entries = provider_entry_count.saturating_sub(rendered_entries);
            let provider_diagnostic_count = provider_sources
                .iter()
                .map(|source| source.diagnostics.len())
                .sum::<usize>();
            let omitted_diagnostics =
                provider_diagnostic_count.saturating_sub(rendered_diagnostics);
            if omitted_sources + omitted_entries + omitted_diagnostics > 0 {
                lines.push(format!(
                    "  … omitted {omitted_sources} source(s), {omitted_entries} Hook(s), and {omitted_diagnostics} diagnostic(s); use Desktop settings for the full catalog."
                ));
            }
        }
        for entry in snapshot
            .entries
            .iter()
            .filter(|entry| !source_by_key.contains_key(&entry.source))
            .take(MAX_TUI_HOOK_ENTRIES_PER_PROVIDER)
        {
            lines.push(format!(
                "External: {}",
                crate::plugin_diagnostics::escape_terminal_text(&entry.native_event)
            ));
        }
    }
    let catalog_diagnostics = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.source.is_none())
        .collect::<Vec<_>>();
    if !catalog_diagnostics.is_empty() {
        lines.push(String::new());
        lines.push("Catalog diagnostics:".to_string());
        for diagnostic in catalog_diagnostics
            .iter()
            .take(MAX_TUI_HOOK_CATALOG_DIAGNOSTICS)
        {
            lines.push(format!(
                "  - {}: {}",
                crate::plugin_diagnostics::escape_terminal_text(&diagnostic.code),
                crate::plugin_diagnostics::escape_terminal_text(&diagnostic.message)
            ));
        }
        if catalog_diagnostics.len() > MAX_TUI_HOOK_CATALOG_DIAGNOSTICS {
            lines.push(format!(
                "  … {} additional catalog diagnostic(s) omitted.",
                catalog_diagnostics.len() - MAX_TUI_HOOK_CATALOG_DIAGNOSTICS
            ));
        }
    }
    lines.push(String::new());
    lines.push(
        "Preview with /hooks import <source-number>. The source application's files remain unchanged."
            .to_string(),
    );
    lines.join("\n")
}

fn matcher_label(matcher: &ExternalHookMatcherSummary) -> String {
    match matcher {
        ExternalHookMatcherSummary::Any => "all".to_string(),
        ExternalHookMatcherSummary::Pattern { display } => display.clone(),
        ExternalHookMatcherSummary::Dynamic => "dynamic".to_string(),
        ExternalHookMatcherSummary::Unavailable => "unavailable".to_string(),
        _ => "unknown".to_string(),
    }
}

fn projection_label(
    entry: &openbitfun_product_domains::external_hook_catalog::ExternalHookCatalogEntry,
) -> &'static str {
    match entry.projection_status {
        ExternalHookProjectionStatus::Mapped => match entry
            .mapping
            .as_ref()
            .map(|mapping| mapping.hook_point)
        {
            Some(
                openbitfun_product_domains::external_hook_contributions::ExternalHookPoint::ToolBefore,
            ) => "coverage mapped: OpenBitFun tool before",
            Some(
                openbitfun_product_domains::external_hook_contributions::ExternalHookPoint::ToolAfter,
            ) => "coverage mapped: OpenBitFun tool after",
            None => "invalid mapping",
        },
        ExternalHookProjectionStatus::NativeOnly => "native only",
        ExternalHookProjectionStatus::Opaque => "opaque static registration",
        _ => "unknown projection",
    }
}

fn native_activation_label(activation: ExternalHookNativeActivation) -> &'static str {
    match activation {
        ExternalHookNativeActivation::Disabled => "native disabled",
        ExternalHookNativeActivation::Unsupported => "unsupported by native runtime",
        ExternalHookNativeActivation::Unknown => "native activation unknown",
        _ => "native activation unknown",
    }
}

fn source_scope_label(scope: ExternalSourceScope) -> &'static str {
    match scope {
        ExternalSourceScope::UserGlobal => "user",
        ExternalSourceScope::WorkspaceLocal => "workspace",
        ExternalSourceScope::Project => "project",
        _ => "external",
    }
}

fn source_health_label(health: ExternalSourceHealth) -> &'static str {
    match health {
        ExternalSourceHealth::Available => "available",
        ExternalSourceHealth::Partial => "partial",
        ExternalSourceHealth::Degraded => "degraded",
        ExternalSourceHealth::Unavailable => "unavailable",
        _ => "unknown",
    }
}

fn hook_handler_label(
    kind: openbitfun_product_domains::external_hook_catalog::ExternalHookHandlerKind,
) -> &'static str {
    use openbitfun_product_domains::external_hook_catalog::ExternalHookHandlerKind;
    match kind {
        ExternalHookHandlerKind::Function => "function",
        ExternalHookHandlerKind::Command => "command",
        ExternalHookHandlerKind::Http => "http",
        ExternalHookHandlerKind::McpTool => "mcp_tool",
        ExternalHookHandlerKind::Prompt => "prompt",
        ExternalHookHandlerKind::Agent => "agent",
        _ => "unknown",
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

fn render_hook_management(snapshot: &HookManagementSnapshot) -> String {
    let mut sections = vec![render_native_hook_overview(&snapshot.native)];
    let mut imported = vec![format!(
        "Imported Hook sources ({})",
        snapshot.imports.imports.len()
    )];
    if snapshot.imports.imports.is_empty() {
        imported.push("  None. Available sources can be reviewed below.".to_string());
    }
    for (index, item) in snapshot.imports.imports.iter().enumerate() {
        imported.push(format!(
            "  {}. {} [{}; {}; state: {:?}]",
            index + 1,
            crate::plugin_diagnostics::escape_terminal_text(&item.source.display_name),
            crate::plugin_diagnostics::escape_terminal_text(&item.import_id),
            if item.enabled { "enabled" } else { "disabled" },
            item.state,
        ));
    }
    for diagnostic in &snapshot.imports.diagnostics {
        imported.push(format!(
            "  ! {}: {}",
            crate::plugin_diagnostics::escape_terminal_text(&diagnostic.code),
            crate::plugin_diagnostics::escape_terminal_text(&diagnostic.message),
        ));
    }
    imported.push("Manage with /hooks update|enable|disable|remove <import-number>.".to_string());
    sections.push(imported.join("\n"));
    sections.push(render_external_hook_catalog(&snapshot.imports.catalog));
    sections.join("\n\n")
}

impl ChatMode {
    fn handle_hook_management(
        &mut self,
        arguments: &str,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if self.hook_management_rx.is_some() {
            chat_view.set_status(Some(
                "A Hook management operation is already in progress".to_string(),
            ));
            return;
        }
        let action = match parse_hook_management_action(arguments) {
            Ok(action) => action,
            Err(message) => {
                chat_state.add_system_message(message);
                return;
            }
        };
        match action {
            HookManagementAction::Show { refresh } => {
                if let Some(snapshot) = &self.hook_management_snapshot {
                    chat_state.add_system_message(render_hook_management(snapshot));
                }
                if self.agent.is_remote_workspace() {
                    chat_state.add_system_message(
                        "Hook management is unavailable for a Remote workspace".to_string(),
                    );
                    return;
                }
                let workspace =
                    std::path::PathBuf::from(self.agent.project_workspace_path_string());
                let workspace_id = self.agent.workspace_id();
                self.spawn_hook_management(
                    async move {
                        let imports =
                            openbitfun_core::external_hook_import::external_hook_import_snapshot(
                                workspace_id.as_deref(),
                                refresh,
                            )
                            .await?;
                        let native = project_native_hook_overview(
                            openbitfun_core::native_hooks::overview(workspace_id.as_deref())
                                .await
                                .map_err(ExternalSourceOperationError::invalid_request)?,
                            &workspace,
                        );
                        Ok(HookManagementResult::Snapshot(HookManagementSnapshot {
                            native,
                            imports,
                        }))
                    },
                    if refresh {
                        "Refreshing Hooks..."
                    } else {
                        "Loading Hooks..."
                    },
                    chat_view,
                    rt_handle,
                );
            }
            HookManagementAction::Import {
                source_number,
                confirm,
            } => {
                let Some(snapshot) = &self.hook_management_snapshot else {
                    chat_state.add_system_message(
                        "Run /hooks first to load available sources.".to_string(),
                    );
                    return;
                };
                let Some(source) = snapshot
                    .imports
                    .catalog
                    .sources
                    .get(source_number - 1)
                    .map(|source| source.key.clone())
                else {
                    chat_state.add_system_message(format!(
                        "Hook source {source_number} is not available. Run /hooks refresh."
                    ));
                    return;
                };
                self.start_hook_plan_or_apply(source, confirm, chat_view, chat_state, rt_handle);
            }
            HookManagementAction::Update {
                import_number,
                confirm,
            } => {
                let Some(source) = self
                    .import_at(import_number, chat_state)
                    .map(|item| item.source.key.clone())
                else {
                    return;
                };
                self.start_hook_plan_or_apply(source, confirm, chat_view, chat_state, rt_handle);
            }
            HookManagementAction::Enable { import_number } => {
                self.start_hook_mutation(
                    import_number,
                    true,
                    false,
                    chat_view,
                    chat_state,
                    rt_handle,
                );
            }
            HookManagementAction::Disable { import_number } => {
                self.start_hook_mutation(
                    import_number,
                    false,
                    false,
                    chat_view,
                    chat_state,
                    rt_handle,
                );
            }
            HookManagementAction::Remove { import_number } => {
                self.start_hook_mutation(
                    import_number,
                    false,
                    true,
                    chat_view,
                    chat_state,
                    rt_handle,
                );
            }
            HookManagementAction::Reset { scope } => {
                self.start_hook_store_reset(scope, chat_view, chat_state, rt_handle);
            }
        }
    }

    fn start_hook_plan_or_apply(
        &mut self,
        source: SourceKey,
        confirm: bool,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        if self.agent.is_remote_workspace() {
            chat_state.add_system_message(
                "Hook management is unavailable for a Remote workspace".to_string(),
            );
            return;
        }
        let workspace_id = self.agent.workspace_id();
        if !confirm {
            self.spawn_hook_management(
                async move {
                    openbitfun_core::external_hook_import::plan_external_hook_import(
                        workspace_id.as_deref(),
                        source,
                    )
                    .await
                    .map(HookManagementResult::Plan)
                },
                "Preparing Hook import review...",
                chat_view,
                rt_handle,
            );
            return;
        }
        let Some(plan) = self
            .pending_hook_plan
            .as_ref()
            .filter(|plan| plan.source.key == source)
            .cloned()
        else {
            chat_state.add_system_message(
                "Preview this Hook source first, then repeat the same command with --confirm."
                    .to_string(),
            );
            return;
        };
        let workspace = std::path::PathBuf::from(self.agent.project_workspace_path_string());
        let workspace_id = self.agent.workspace_id();
        self.spawn_hook_management(
            async move {
                let result = openbitfun_core::external_hook_import::apply_external_hook_import(
                    workspace_id.as_deref(),
                    ExternalHookImportApplyRequestV1 {
                        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
                        source: source.clone(),
                        plan_fingerprint: plan.plan_fingerprint,
                    },
                )
                .await?;
                let (snapshot, applied) = match result.outcome {
                    ExternalHookImportApplyOutcomeV1::Stale { refreshed_plan } => {
                        return Ok(HookManagementResult::Plan(refreshed_plan));
                    }
                    ExternalHookImportApplyOutcomeV1::Applied { snapshot } => (snapshot, true),
                    ExternalHookImportApplyOutcomeV1::Unchanged { snapshot } => (snapshot, false),
                };
                let status =
                    crate::hook_import::completed_import_status(&snapshot, &source, applied)
                        .to_string();
                let native = project_native_hook_overview(
                    openbitfun_core::native_hooks::overview(workspace_id.as_deref())
                        .await
                        .map_err(ExternalSourceOperationError::invalid_request)?,
                    &workspace,
                );
                Ok(HookManagementResult::Changed {
                    snapshot: HookManagementSnapshot {
                        native,
                        imports: snapshot,
                    },
                    status,
                })
            },
            "Applying reviewed Hook import...",
            chat_view,
            rt_handle,
        );
    }

    fn import_at<'a>(
        &'a self,
        number: usize,
        chat_state: &mut ChatState,
    ) -> Option<&'a openbitfun_product_domains::external_hook_import::ImportedHookSourceSnapshotV1>
    {
        let Some(snapshot) = &self.hook_management_snapshot else {
            chat_state.add_system_message("Run /hooks first to load imported sources.".to_string());
            return None;
        };
        let item = snapshot.imports.imports.get(number - 1);
        if item.is_none() {
            chat_state.add_system_message(format!(
                "Hook import {number} is not available. Run /hooks refresh."
            ));
        }
        item
    }

    fn start_hook_mutation(
        &mut self,
        import_number: usize,
        enabled: bool,
        remove: bool,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let Some(item) = self.import_at(import_number, chat_state) else {
            return;
        };
        let import_id = item.import_id.clone();
        let action = if remove {
            ExternalHookImportMutationV1::Remove {
                import_id: import_id.clone(),
            }
        } else {
            ExternalHookImportMutationV1::SetEnabled {
                import_id: import_id.clone(),
                enabled,
            }
        };
        let expected_revision = self
            .hook_management_snapshot
            .as_ref()
            .map(|snapshot| snapshot.imports.revision.clone())
            .expect("import_at requires a loaded Hook snapshot");
        if self.agent.is_remote_workspace() {
            chat_state.add_system_message(
                "Hook management is unavailable for a Remote workspace".to_string(),
            );
            return;
        }
        let workspace = std::path::PathBuf::from(self.agent.project_workspace_path_string());
        let workspace_id = self.agent.workspace_id();
        self.spawn_hook_management(
            async move {
                let imports = openbitfun_core::external_hook_import::mutate_external_hook_import(
                    workspace_id.as_deref(),
                    ExternalHookImportMutationRequestV1 {
                        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
                        expected_revision,
                        action,
                    },
                )
                .await?;
                let native = project_native_hook_overview(
                    openbitfun_core::native_hooks::overview(workspace_id.as_deref()).await.map_err(ExternalSourceOperationError::invalid_request)?,
                    &workspace,
                );
                let status = if remove {
                    format!(
                        "Removed OpenBitFun's managed copy of {import_id}; the source was unchanged."
                    )
                } else if enabled {
                    format!("Enabled {import_id} for the next matching event.")
                } else {
                    format!("Disabled {import_id} for the next matching event.")
                };
                Ok(HookManagementResult::Changed {
                    snapshot: HookManagementSnapshot { native, imports },
                    status,
                })
            },
            "Updating imported Hooks...",
            chat_view,
            rt_handle,
        );
    }

    fn start_hook_store_reset(
        &mut self,
        scope: ExternalSourceScope,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let Some(snapshot) = &self.hook_management_snapshot else {
            chat_state.add_system_message("Run /hooks first to inspect managed state.".to_string());
            return;
        };
        let scope_key = match scope {
            ExternalSourceScope::UserGlobal => "user_global",
            ExternalSourceScope::Project => "project",
            _ => {
                chat_state
                    .add_system_message("Hook reset scope must be user or project.".to_string());
                return;
            }
        };
        let diagnostic_code = format!("external_hook.import_store_corrupt.{scope_key}");
        if !snapshot
            .imports
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == diagnostic_code)
        {
            chat_state.add_system_message(format!(
                "The {scope_key} managed Hook index is not corrupt; nothing was reset."
            ));
            return;
        }
        let expected_revision = snapshot.imports.revision.clone();
        if self.agent.is_remote_workspace() {
            chat_state.add_system_message(
                "Hook management is unavailable for a Remote workspace".to_string(),
            );
            return;
        }
        let workspace = std::path::PathBuf::from(self.agent.project_workspace_path_string());
        let workspace_id = self.agent.workspace_id();
        self.spawn_hook_management(
            async move {
                let imports = openbitfun_core::external_hook_import::mutate_external_hook_import(
                    workspace_id.as_deref(),
                    ExternalHookImportMutationRequestV1 {
                        schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
                        expected_revision,
                        action: ExternalHookImportMutationV1::ResetCorruptStore { scope },
                    },
                )
                .await?;
                let native = project_native_hook_overview(
                    openbitfun_core::native_hooks::overview(workspace_id.as_deref()).await.map_err(ExternalSourceOperationError::invalid_request)?,
                    &workspace,
                );
                Ok(HookManagementResult::Changed {
                    snapshot: HookManagementSnapshot { native, imports },
                    status: format!(
                        "Reset the corrupt {scope_key} managed Hook index; source files were unchanged."
                    ),
                })
            },
            "Resetting corrupt Hook state...",
            chat_view,
            rt_handle,
        );
    }

    fn spawn_hook_management<F>(
        &mut self,
        future: F,
        status: &str,
        chat_view: &mut ChatView,
        rt_handle: &tokio::runtime::Handle,
    ) where
        F: std::future::Future<
                Output = std::result::Result<HookManagementResult, ExternalSourceOperationError>,
            > + Send
            + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        rt_handle.spawn(async move {
            let _ = sender.send(future.await);
        });
        self.hook_management_rx = Some(receiver);
        chat_view.set_status(Some(status.to_string()));
    }

    fn poll_hook_management(
        &mut self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
    ) -> bool {
        let result = match self.hook_management_rx.as_ref().map(Receiver::try_recv) {
            Some(Ok(result)) => result,
            Some(Err(MpscTryRecvError::Empty)) | None => return false,
            Some(Err(MpscTryRecvError::Disconnected)) => {
                self.hook_management_rx = None;
                chat_view.set_status(Some("Hook management operation failed".to_string()));
                chat_state.add_system_message(
                    "Hooks are unavailable because the background operation ended unexpectedly."
                        .to_string(),
                );
                return true;
            }
        };
        self.hook_management_rx = None;
        match result {
            Ok(HookManagementResult::Snapshot(snapshot)) => {
                chat_state.add_system_message(render_hook_management(&snapshot));
                chat_view.set_status(Some(format!(
                    "Hooks: {} native/imported handlers, {} available sources",
                    snapshot.native.total_handlers,
                    snapshot.imports.catalog.sources.len(),
                )));
                self.hook_management_snapshot = Some(snapshot);
            }
            Ok(HookManagementResult::Plan(plan)) => {
                chat_state.add_system_message(crate::hook_import::render_plan_for_tui(&plan));
                chat_view.set_status(Some(
                    "Review complete; repeat the same import/update command with --confirm."
                        .to_string(),
                ));
                self.pending_hook_plan = Some(plan);
            }
            Ok(HookManagementResult::Changed { snapshot, status }) => {
                let status = crate::plugin_diagnostics::escape_terminal_text(&status);
                chat_state.add_system_message(format!(
                    "{}\n\n{}",
                    status,
                    render_hook_management(&snapshot),
                ));
                chat_view.set_status(Some(status));
                self.hook_management_snapshot = Some(snapshot);
                self.pending_hook_plan = None;
            }
            Err(error) if error.code == ExternalSourceOperationErrorCode::StaleRevision => {
                chat_state.add_system_message(
                    "Hook import state changed; the action was not applied. Run /hooks to refresh, review the new state, and try again."
                        .to_string(),
                );
                chat_view.set_status(Some("Hook import state changed".to_string()));
            }
            Err(error) => {
                chat_state.add_system_message(format!(
                    "Hooks are unavailable ({}): {}",
                    error.code.as_str(),
                    crate::plugin_diagnostics::escape_terminal_text(&error.detail),
                ));
                chat_view.set_status(Some("Hook catalog unavailable".to_string()));
            }
        }
        true
    }
}
