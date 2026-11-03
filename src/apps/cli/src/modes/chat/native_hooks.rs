const MAX_TUI_NATIVE_HOOK_RULES: usize = 100;
const MAX_TUI_NATIVE_HOOK_HANDLERS_PER_RULE: usize = 20;
const MAX_TUI_NATIVE_HOOK_ISSUES: usize = 20;
const MAX_TUI_NATIVE_HOOK_COMMAND_CHARS: usize = 200;
const MAX_TUI_NATIVE_HOOK_STATUS_CHARS: usize = 200;

fn bounded_native_hook_text(value: &str, max_chars: usize) -> (String, bool) {
    let value = value.trim();
    let truncated = value.chars().count() > max_chars;
    let mut summary = value
        .chars()
        .take(max_chars)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if truncated {
        summary.push_str("...");
    }
    (summary, truncated)
}

fn native_hook_location(
    path: &std::path::Path,
    workspace: &std::path::Path,
    user_hooks_file: Option<&std::path::Path>,
) -> String {
    if user_hooks_file.is_some_and(|user| user == path) {
        return "<user-config>/config/hooks.json".to_string();
    }
    if let Ok(relative) = path.strip_prefix(workspace) {
        let relative = relative.to_string_lossy().replace('\\', "/");
        return if relative.is_empty() {
            "<workspace>".to_string()
        } else {
            format!("<workspace>/{relative}")
        };
    }
    let import_id = path
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::file_name)
        .map(|value| value.to_string_lossy())
        .map(|value| {
            value
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "import".to_string());
    format!("<managed-hooks>/{import_id}/hooks.json")
}

fn project_native_hook_overview(
    overview: openbitfun_core::native_hooks::NativeHookOverview,
    workspace: &std::path::Path,
) -> NativeHookOverview {
    let user_hooks_file = openbitfun_core::infrastructure::try_get_path_manager_arc()
        .ok()
        .map(|manager| manager.user_hooks_file());
    let path_labels = overview
        .files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                native_hook_location(&file.path, workspace, user_hooks_file.as_deref()),
            )
        })
        .collect::<Vec<_>>();
    let sanitize_issue = |issue: String| {
        path_labels.iter().fold(issue, |sanitized, (path, label)| {
            let native = path.to_string_lossy();
            let sanitized = sanitized.replace(native.as_ref(), label);
            sanitized.replace(&native.replace('\\', "/"), label)
        })
    };

    // The shared projection DTO has no dedicated slot for the remote fact yet,
    // so it travels as the first issue line: the CLI renders issues verbatim and
    // this keeps the reason hooks did not run visible next to the rules.
    let remote_notice = overview
        .remote_workspace_unsupported
        .then(|| REMOTE_WORKSPACE_HOOKS_NOTICE.to_string());

    NativeHookOverview {
        enabled: overview.enabled,
        project_hooks_enabled: overview.project_hooks_enabled,
        files: overview
            .files
            .into_iter()
            .zip(path_labels.iter())
            .map(|(file, (_, location))| {
                openbitfun_product_domains::native_hooks::NativeHookFileSummary {
                    scope: file.scope.to_string(),
                    location: location.clone(),
                    exists: file.exists,
                    loaded: file.loaded,
                }
            })
            .collect(),
        rules: overview
            .rules
            .into_iter()
            .map(
                |rule| openbitfun_product_domains::native_hooks::NativeHookRuleSummary {
                    event: rule.event.to_string(),
                    matcher: rule.matcher,
                    matcher_is_valid: rule.matcher_is_valid,
                    scope: rule.scope.to_string(),
                    handlers: rule
                        .handlers
                        .into_iter()
                        .map(|handler| {
                            let (command_summary, command_truncated) = bounded_native_hook_text(
                                &handler.command,
                                MAX_TUI_NATIVE_HOOK_COMMAND_CHARS,
                            );
                            openbitfun_product_domains::native_hooks::NativeHookHandlerSummary {
                                command_summary,
                                command_truncated,
                                timeout_seconds: handler.timeout_seconds,
                                status_message: handler.status_message.map(|message| {
                                    bounded_native_hook_text(
                                        &message,
                                        MAX_TUI_NATIVE_HOOK_STATUS_CHARS,
                                    )
                                    .0
                                }),
                            }
                        })
                        .collect(),
                },
            )
            .collect(),
        total_handlers: overview.total_handlers,
        issues: remote_notice
            .into_iter()
            .chain(overview.issues.into_iter().map(sanitize_issue))
            .collect(),
    }
}

/// English line shown in `/hooks` when the session workspace is remote.
const REMOTE_WORKSPACE_HOOKS_NOTICE: &str =
    "Remote workspace: user and imported Hooks are skipped; enabled project Hooks are read and run on the target workspace host.";

fn native_hook_help_text() -> String {
    [
        "Hooks",
        "",
        "Usage: /hooks [refresh | import <source-number> [--confirm] | update <import-number> [--confirm] | enable <import-number> | disable <import-number> | remove <import-number> --confirm | reset <user|project> --confirm]",
        "",
        "Shows native OpenBitFun Hooks plus compatible Claude Code and Codex command Hooks.",
        "Import and update are preview-only until the exact reviewed plan is confirmed. Source files are never edited.",
        "Compatibility aliases: /hooks_external and /hooks-external.",
        "",
        "Help: /help hooks, /hooks -h, or /hooks --help",
    ]
    .join("\n")
}

fn truncate_hook_command(command: &str) -> String {
    let command = command.trim();
    if command.chars().count() <= MAX_TUI_NATIVE_HOOK_COMMAND_CHARS {
        return command.to_string();
    }
    let kept = command
        .chars()
        .take(MAX_TUI_NATIVE_HOOK_COMMAND_CHARS)
        .collect::<String>();
    format!("{kept}…")
}

fn native_hook_rule_line(rule: &NativeHookRuleView) -> String {
    format!(
        "  matcher: {} [{}; {} handler{}{}]",
        crate::plugin_diagnostics::escape_terminal_text(&rule.matcher),
        rule.scope,
        rule.handlers.len(),
        plural(rule.handlers.len()),
        if rule.matcher_is_valid {
            ""
        } else {
            "; invalid pattern, never matches"
        },
    )
}

fn render_native_hook_overview(overview: &NativeHookOverview) -> String {
    let mut lines = vec![
        "Hooks (OpenBitFun)".to_string(),
        "Commands OpenBitFun runs at agent lifecycle events. Nothing was executed to build this view."
            .to_string(),
        String::new(),
    ];
    lines.push(format!(
        "Hooks: {} (app.hooks.enabled)",
        if overview.enabled {
            "enabled"
        } else {
            "disabled"
        }
    ));
    lines.push(format!(
        "Project hook file: {} (app.hooks.project_hooks_enabled)",
        if overview.project_hooks_enabled {
            "enabled"
        } else {
            "disabled"
        }
    ));

    lines.push(String::new());
    if overview.files.is_empty() {
        lines.push("No hook configuration path is available on this host.".to_string());
    } else {
        lines.push("Configuration:".to_string());
        for file in &overview.files {
            lines.push(format!(
                "  {} [{}; {}]: {}",
                file.scope,
                if file.loaded { "loaded" } else { "not loaded" },
                if file.exists { "present" } else { "missing" },
                crate::plugin_diagnostics::escape_terminal_text(&file.location),
            ));
        }
    }

    lines.push(String::new());
    if !overview.enabled {
        lines.push("All hooks are off; set app.hooks.enabled to run them.".to_string());
    } else if overview.rules.is_empty() {
        lines.push("No hooks are configured.".to_string());
    } else {
        lines.push(format!(
            "{} matcher group{}, {} handler{}:",
            overview.rules.len(),
            plural(overview.rules.len()),
            overview.total_handlers,
            plural(overview.total_handlers),
        ));
        let mut current_event = "";
        for rule in overview.rules.iter().take(MAX_TUI_NATIVE_HOOK_RULES) {
            if rule.event != current_event {
                current_event = rule.event.as_str();
                lines.push(String::new());
                lines.push(crate::plugin_diagnostics::escape_terminal_text(&rule.event));
            }
            lines.push(native_hook_rule_line(rule));
            for handler in rule
                .handlers
                .iter()
                .take(MAX_TUI_NATIVE_HOOK_HANDLERS_PER_RULE)
            {
                lines.push(format!(
                    "    - {} [timeout {}s{}]",
                    truncate_hook_command(&crate::plugin_diagnostics::escape_terminal_text(
                        &handler.command_summary,
                    )),
                    handler.timeout_seconds,
                    match handler.status_message.as_deref() {
                        Some(message) if !message.trim().is_empty() => format!(
                            "; status: {}",
                            crate::plugin_diagnostics::escape_terminal_text(message.trim())
                        ),
                        _ => String::new(),
                    },
                ));
            }
            let omitted_handlers = rule
                .handlers
                .len()
                .saturating_sub(MAX_TUI_NATIVE_HOOK_HANDLERS_PER_RULE);
            if omitted_handlers > 0 {
                lines.push(format!("    … omitted {omitted_handlers} handler(s)."));
            }
        }
        let omitted_rules = overview
            .rules
            .len()
            .saturating_sub(MAX_TUI_NATIVE_HOOK_RULES);
        if omitted_rules > 0 {
            lines.push(String::new());
            lines.push(format!(
                "… omitted {omitted_rules} matcher group(s); open the hook files for the full configuration."
            ));
        }
    }

    if !overview.issues.is_empty() {
        lines.push(String::new());
        lines.push("Configuration issues:".to_string());
        for issue in overview.issues.iter().take(MAX_TUI_NATIVE_HOOK_ISSUES) {
            lines.push(format!(
                "  ! {}",
                crate::plugin_diagnostics::escape_terminal_text(issue)
            ));
        }
        if overview.issues.len() > MAX_TUI_NATIVE_HOOK_ISSUES {
            lines.push(format!(
                "  … {} additional issue(s) omitted.",
                overview.issues.len() - MAX_TUI_NATIVE_HOOK_ISSUES
            ));
        }
    }

    lines.push(String::new());
    lines.push("Manual Hooks remain editable in hooks.json. Imported Hooks are managed through /hooks. Help: /help hooks, /hooks -h, or /hooks --help".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod remote_hook_projection_tests {
    use super::{
        project_native_hook_overview, render_native_hook_overview, REMOTE_WORKSPACE_HOOKS_NOTICE,
    };

    fn core_overview(
        remote_workspace_unsupported: bool,
    ) -> openbitfun_core::native_hooks::NativeHookOverview {
        openbitfun_core::native_hooks::NativeHookOverview {
            enabled: true,
            project_hooks_enabled: false,
            files: Vec::new(),
            rules: Vec::new(),
            total_handlers: 0,
            issues: vec!["Hook event 'PreTool' is not a supported event name".to_string()],
            remote_workspace_unsupported,
        }
    }

    #[test]
    fn remote_workspace_overview_renders_target_side_semantics_before_issues() {
        let workspace = std::path::Path::new("/srv/remote-project");
        let projected = project_native_hook_overview(core_overview(true), workspace);
        assert_eq!(
            projected.issues.first().map(String::as_str),
            Some(REMOTE_WORKSPACE_HOOKS_NOTICE)
        );
        assert_eq!(projected.issues.len(), 2);

        let text = render_native_hook_overview(&projected);
        assert!(
            text.contains("enabled project Hooks are read and run on the target workspace host")
        );
        assert!(text.contains("is not a supported event name"));
    }

    #[test]
    fn local_workspace_overview_does_not_mention_remote_workspaces() {
        let workspace = std::path::Path::new("/srv/local-project");
        let projected = project_native_hook_overview(core_overview(false), workspace);
        assert_eq!(projected.issues.len(), 1);
        assert!(!render_native_hook_overview(&projected).contains("remote workspace"));
    }
}
