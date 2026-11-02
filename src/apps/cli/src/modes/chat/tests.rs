#[cfg(test)]
mod tests {
    use tokio::sync::broadcast::error::TryRecvError;

    use super::{
        action_opens_extension_management, agent_event_stream_failure, apply_agent_mode_feedback,
        apply_model_selection_feedback, apply_session_model_fallback,
        apply_session_rename_feedback, begin_slash_menu_selection, builtin_arguments_error,
        builtin_arguments_route, builtin_command_reconfirmation,
        clear_selected_native_command_prefill, cli_native_prompt_command_descriptors,
        command_route, consume_selected_native_command_once, context_compression_tool_event,
        extension_command_help_request, external_agent_attention, external_agent_diagnostic_lines,
        external_agent_pending_notice_key, external_agent_result_is_stale,
        external_agent_review_text, external_command_projections, external_control_status_text,
        external_hook_help_text, external_integration_policy_lines,
        external_operation_error_status, external_tool_mutation_result_label,
        external_tool_pending_notice_key, external_tool_result_is_stale, external_tool_review_text,
        external_tool_run_location_label, mark_active_turn_failed,
        merge_external_agent_mutation_snapshot, native_command_choice_is_active,
        native_command_reconfirmation_is_required, native_hook_help_text,
        parse_external_agent_review_action, parse_external_control_action,
        parse_external_tool_review_action, parse_hook_management_action, parse_reload_invocation,
        parse_reload_target, pending_session_operation_blocks_runtime_action,
        previous_session_update_status, primary_model_usage_for_active_turn,
        render_external_hook_catalog, render_native_hook_overview, requested_session_name,
        retain_selected_native_command_for_input, selected_command_prefill,
        session_command_help_note, session_delete_allowed, session_delete_feedback,
        session_switch_targets_pending_delete, session_update_allowed,
        session_update_blocks_typed_submission, session_update_completion_should_exit,
        shared_session_change_is_blocked, steering_unsupported_reason,
        terminal_event_allowed_while_local_effect_pending, CommandRoute, ExternalAgentReviewAction,
        ExternalControlUiAction, ExternalSourceConflictPreferences, ExternalToolReviewAction,
        HookManagementAction, PendingSessionOperationKind, SessionUpdateApplyOutcome,
        SHARED_TUI_CHAT_STATUS,
    };
    use crate::actions::{
        action_conflict_behavior_version, ActionHandler, ActionState, ResolvedKeymap,
    };
    use crate::chat_state::ChatState;
    use crate::config::ShortcutsConfig;
    use crate::ui::chat::ChatView;
    use crate::ui::command_menu::{ExternalCommandProjection, NativeCommandCollisionProjection};
    use crate::ui::theme::Theme;
    use crossterm::event::Event;
    use openbitfun_events::{AgenticEvent, ToolEventData};
    use openbitfun_product_domains::external_hook_catalog::{
        ExternalHookCatalogEntry, ExternalHookCatalogSnapshotV1, ExternalHookHandlerKind,
        ExternalHookMatcherSummary, ExternalHookNativeActivation, ExternalHookProjectionStatus,
    };
    use openbitfun_product_domains::external_source_control::ExternalSourceControlSnapshotV1;
    use openbitfun_product_domains::external_sources::{
        native_prompt_command_conflict_key, ExternalSourceAssetKind,
        ExternalSourceCatalogSnapshot as RawExternalSourceCatalogSnapshot,
        ExternalSourceDiagnostic, ExternalSourceDiagnosticSeverity, ExternalSourceOperationError,
        ExternalSourceOperationErrorCode,
        ExternalSourcePublicSnapshot as ExternalSourceCatalogSnapshot, ExternalSourceScope,
        ExternalToolActivationState,
    };
    use openbitfun_product_domains::external_subagents::{
        ExternalSubagentActivationState, ExternalSubagentModelBindingTarget,
    };
    use openbitfun_product_domains::native_hooks::{
        NativeHookFileSummary as NativeHookFileView,
        NativeHookHandlerSummary as NativeHookHandlerView, NativeHookOverview,
        NativeHookRuleSummary as NativeHookRuleView,
    };
    use openbitfun_runtime_ports::AgentContextReloadTarget;
    use std::collections::{BTreeMap, BTreeSet};

    fn public_external_source_snapshot(value: serde_json::Value) -> ExternalSourceCatalogSnapshot {
        let snapshot: RawExternalSourceCatalogSnapshot =
            serde_json::from_value(value).expect("parse raw external source test snapshot");
        snapshot.into()
    }

    #[test]
    fn goal_prompts_use_normal_runtime_submission_and_pending_guards() {
        use crate::actions::ActionContext;
        for input in [
            "/goal finish tests",
            " /GOAL\nship feature ",
            "/goal pause\nthen verify",
        ] {
            assert!(super::is_runtime_goal_prompt(input));
            assert!(!super::is_local_slash_command(input));
            assert!(session_update_blocks_typed_submission(true, input));
        }
        for input in [
            "/goal",
            "/goal pause",
            "/goal resume",
            "/goal clear",
            "/goalie work",
            "/compact",
        ] {
            assert!(super::is_local_slash_command(input));
        }
        assert_eq!(
            selected_command_prefill(ActionHandler::GoalPrompt),
            Some("/goal ")
        );
        let action = crate::actions::action_for_alias("/goal", ActionContext::Chat).unwrap();
        assert_eq!(action.handler, ActionHandler::GoalPrompt);
        assert!(action.handler.available_in_shared_tui(ActionContext::Chat));
    }

    #[test]
    fn explicit_same_id_agent_selection_rebinds_through_the_runtime_owner() {
        let source = include_str!("selection.rs").replace("\r\n", "\n");
        let selection = source
            .split_once("fn apply_agent_selection(")
            .expect("agent selection method")
            .1
            .split_once("fn poll_session_operation_completion(")
            .expect("agent selection boundary")
            .0;

        assert!(selection.contains(".update_session_mode_with_route("));
        assert!(!selection.contains("selected.id == self.agent_type"));
    }

    #[test]
    fn reload_command_uses_one_closed_optional_target() {
        assert_eq!(
            parse_reload_target("").unwrap(),
            AgentContextReloadTarget::All
        );
        assert_eq!(
            parse_reload_target(" SKILLS ").unwrap(),
            AgentContextReloadTarget::Skills
        );
        assert_eq!(
            parse_reload_target("Instructions").unwrap(),
            AgentContextReloadTarget::Instructions
        );
        assert!(parse_reload_target("mcp").is_err());
        assert!(parse_reload_target("skills instructions").is_err());

        assert_eq!(
            parse_reload_invocation("reload-skills", "")
                .unwrap()
                .unwrap(),
            AgentContextReloadTarget::Skills
        );
        assert!(parse_reload_invocation("reload-skills", "instructions")
            .unwrap()
            .is_err());
        assert!(parse_reload_invocation("other", "").is_none());
    }

    fn external_command(
        name: &str,
        selected_candidate_id: Option<&str>,
    ) -> ExternalCommandProjection {
        ExternalCommandProjection {
            action_id: format!("external-command:{name}"),
            command_name: name.to_string(),
            invocation_alias: format!("/{name}"),
            candidate_id: format!("external:{name}"),
            content_version: "v1".to_string(),
            description: "External command".to_string(),
            restricted: false,
            provider_conflict_key: None,
            native_collision: Some(NativeCommandCollisionProjection {
                native_action_id: name.to_string(),
                native_candidate_id: format!("openbitfun.cli:{name}"),
                external_candidate_id: format!("external:{name}"),
                conflict_key: "conflict-v1".to_string(),
                selected_candidate_id: selected_candidate_id.map(str::to_string),
            }),
        }
    }

    #[test]
    fn external_control_commands_use_one_small_closed_action_set() {
        assert_eq!(
            parse_external_control_action("").unwrap(),
            ExternalControlUiAction::Show
        );
        assert_eq!(
            parse_external_control_action("status").unwrap(),
            ExternalControlUiAction::Show
        );
        assert_eq!(
            parse_external_control_action("refresh").unwrap(),
            ExternalControlUiAction::Refresh
        );
        assert_eq!(
            parse_external_control_action("safe-mode on").unwrap(),
            ExternalControlUiAction::SetSafeMode(true)
        );
        assert_eq!(
            parse_external_control_action("safe-mode off").unwrap(),
            ExternalControlUiAction::SetSafeMode(false)
        );
        assert_eq!(
            parse_external_control_action("disable 1").unwrap(),
            ExternalControlUiAction::SetSourceEnabled {
                source_index: 0,
                enabled: false,
            }
        );
        assert_eq!(
            parse_external_control_action("enable 2").unwrap(),
            ExternalControlUiAction::SetSourceEnabled {
                source_index: 1,
                enabled: true,
            }
        );
        assert!(parse_external_control_action("safe-mode toggle").is_err());
        assert!(parse_external_control_action("enable-everything").is_err());
        assert!(parse_external_control_action("review").is_err());
        let usage = parse_external_control_action("unknown").unwrap_err();
        assert!(!usage.contains("safe-mode"));
        assert!(!usage.contains("review"));
    }

    #[test]
    fn external_control_status_projects_shared_runtime_facts() {
        let control: ExternalSourceControlSnapshotV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "executionDomainId": "local-user",
            "refreshGeneration": 9,
            "preferenceRevision": 4,
            "safeMode": true,
            "hostCapabilities": {
                "canRefresh": true,
                "canMutatePolicy": true,
                "canManageSources": true,
                "canApproveRuntime": true,
                "canExecuteExternalAssets": true,
                "canSetSafeMode": true
            },
            "sources": [{
                "stableKey": "opencode.commands:project",
                "ecosystemId": "opencode",
                "displayName": "OpenCode project commands",
                "scope": "project",
                "contentVersion": "v1",
                "discovery": "current",
                "desired": "enabled",
                "review": { "state": "not_required" },
                "runtime": "not_applicable",
                "support": "supported",
                "effectiveStatus": "available"
            }],
            "capabilities": [{
                "kind": "tool",
                "revision": 9,
                "itemCount": 2,
                "pendingReviewCount": 1,
                "unresolvedConflictCount": 0,
                "runtime": "inactive",
                "support": "supported"
            }],
            "diagnostics": [],
            "recoveryActions": [{ "type": "exit_safe_mode" }]
        }))
        .unwrap();

        let text = external_control_status_text(&control);
        assert!(text.contains("Extensions"));
        assert!(text.contains("1. OpenCode project commands - Available"));
        assert!(text.contains("Disable: /extensions disable 1"));
        assert!(text.contains("Refresh: /extensions refresh"));
        assert!(text.contains("External access is paused. Resume: /extensions safe-mode off"));
        for hidden in [
            "Generation",
            "Execution domain",
            "opencode.commands:project",
            "review",
            "items",
            "conflicts",
            "<source-key>",
        ] {
            assert!(!text.contains(hidden), "leaked {hidden}:\n{text}");
        }

        let mut read_only = control.clone();
        read_only.host_capabilities.can_manage_sources = false;
        let read_only_text = external_control_status_text(&read_only);
        assert!(read_only_text.contains("This connection can only show extension status."));
        assert!(!read_only_text.contains("/extensions disable 1"));

        let mut permission_needed = control.clone();
        permission_needed.sources[0].effective_status =
            openbitfun_product_domains::external_source_control::ExternalSourceEffectiveStatus::ReviewRequired;
        let permission_text = external_control_status_text(&permission_needed);
        assert!(permission_text.contains("Needs permission"));
        assert!(permission_text.contains("Manage permissions: /tools, /agent, /mcp, or /hooks"));
    }

    #[test]
    fn external_control_status_keeps_empty_provider_failures_actionable() {
        let control: ExternalSourceControlSnapshotV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "executionDomainId": "local-user",
            "refreshGeneration": 10,
            "preferenceRevision": 4,
            "safeMode": false,
            "hostCapabilities": {
                "canRefresh": true,
                "canMutatePolicy": true,
                "canManageSources": true,
                "canApproveRuntime": true,
                "canExecuteExternalAssets": true,
                "canSetSafeMode": true
            },
            "sources": [],
            "capabilities": [{
                "kind": "tool",
                "revision": 10,
                "itemCount": 0,
                "pendingReviewCount": 0,
                "unresolvedConflictCount": 0,
                "runtime": "inactive",
                "support": "partial"
            }],
            "diagnostics": [{
                "severity": "error",
                "assetKind": "tool",
                "code": "external_tool.runtime_unavailable",
                "message": "Node runtime is unavailable"
            }],
            "recoveryActions": [
                { "type": "refresh" },
                { "type": "install_runtime" }
            ]
        }))
        .unwrap();

        let text = external_control_status_text(&control);
        assert!(text.contains("No extensions found."));
        assert!(!text.contains("External access is paused"));
        assert!(text.contains("Needs attention"));
        assert!(!text.contains("external_tool.runtime_unavailable"));
        assert!(text.contains("/extensions refresh"));
        assert!(text.contains("install or repair the required runtime"));
    }

    fn external_tool_review_snapshot() -> ExternalSourceCatalogSnapshot {
        public_external_source_snapshot(serde_json::json!({
            "generation": 3,
            "discoveryPending": false,
            "sources": [{
                "stableKey": "opencode-tools-project",
                "record": {
                    "key": { "providerId": "opencode.tools", "sourceId": "project" },
                    "ecosystemId": "opencode",
                    "displayName": "OpenCode project tools",
                    "sourceKind": "tools",
                    "scope": "project",
                    "location": "<workspace>/.opencode/tools",
                    "executionDomainId": "local:D:/repo",
                    "health": "available",
                    "contentVersion": "source-v1"
                },
                "lifecycle": "available"
            }],
            "commands": [],
            "tools": [{
                "definition": {
                    "id": {
                        "target": {
                            "source": { "providerId": "opencode.tools", "sourceId": "project" },
                            "localId": "review.js"
                        },
                        "exportId": "default"
                    },
                    "name": "review",
                    "descriptionPreview": "Review a change",
                    "modulePath": "<workspace>/.opencode/tools/review.js",
                    "workingDirectory": "<workspace>/",
                    "runtimeKind": "java_script",
                    "capabilities": ["file_system", "network", "environment", "process"],
                    "contentVersion": "content-v1",
                    "staticStatus": { "state": "ready" }
                },
                "approvalKey": "approval-v1",
                "decisionKey": "decision-v1",
                "activation": { "state": "approval_required" }
            }, {
                "definition": {
                    "id": {
                        "target": {
                            "source": { "providerId": "opencode.tools", "sourceId": "project" },
                            "localId": "weather.js"
                        },
                        "exportId": "default"
                    },
                    "name": "weather",
                    "descriptionPreview": "Read weather",
                    "modulePath": "<workspace>/.opencode/tools/weather.js",
                    "workingDirectory": "<workspace>/",
                    "runtimeKind": "java_script",
                    "capabilities": ["network"],
                    "contentVersion": "content-v1",
                    "staticStatus": { "state": "ready" }
                },
                "approvalKey": "approval-v2",
                "decisionKey": "decision-v2",
                "activation": { "state": "declined" }
            }, {
                "definition": {
                    "id": {
                        "target": {
                            "source": { "providerId": "opencode.tools", "sourceId": "project" },
                            "localId": "deploy.js"
                        },
                        "exportId": "default"
                    },
                    "name": "deploy",
                    "descriptionPreview": "Deploy a build",
                    "modulePath": "<workspace>/.opencode/tools/deploy.js",
                    "workingDirectory": "<workspace>/",
                    "runtimeKind": "java_script",
                    "capabilities": ["process"],
                    "contentVersion": "content-v1",
                    "staticStatus": { "state": "ready" }
                },
                "approvalKey": "approval-v3",
                "decisionKey": "decision-v3",
                "activation": { "state": "active" }
            }, {
                "definition": {
                    "id": {
                        "target": {
                            "source": { "providerId": "opencode.tools", "sourceId": "project" },
                            "localId": "broken.ts"
                        },
                        "exportId": "default"
                    },
                    "name": "broken",
                    "descriptionPreview": "Broken tool",
                    "modulePath": "<workspace>/.opencode/tools/broken.ts",
                    "workingDirectory": "<workspace>/",
                    "runtimeKind": "type_script",
                    "capabilities": ["file_system"],
                    "contentVersion": "content-v1",
                    "staticStatus": { "state": "ready" }
                },
                "approvalKey": "approval-v4",
                "decisionKey": "decision-v4",
                "activation": {
                    "state": "load_failed",
                    "reason": "PR2 worker could not import the module"
                }
            }],
            "toolApprovalRequests": [{
                "approvalKey": "approval-v1",
                "decisionKey": "decision-v1",
                "targetId": {
                    "source": { "providerId": "opencode.tools", "sourceId": "project" },
                    "localId": "review.js"
                },
                "sourceDisplayName": "OpenCode project tools",
                "sourceScope": "project",
                "sourceLocation": "<workspace>/.opencode/tools/review.js",
                "workingDirectory": "<workspace>/",
                "runtimeKind": "java_script",
                "capabilities": ["file_system", "network", "environment", "process"],
                "contentVersion": "content-v1",
                "toolNames": ["review"]
            }],
            "toolConflicts": [{
                "conflictKey": "conflict-v1",
                "toolName": "review",
                "candidates": [{
                    "candidateId": "openbitfun:review",
                    "displayName": "OpenBitFun review",
                    "kind": "built_in",
                    "providerId": "openbitfun",
                    "contentVersion": "builtin-v1"
                }, {
                    "candidateId": "external:review",
                    "displayName": "OpenCode review",
                    "kind": "external",
                    "providerId": "opencode.tools",
                    "contentVersion": "content-v1",
                    "source": { "providerId": "opencode.tools", "sourceId": "project" },
                    "sourceLocation": "<workspace>/.opencode/tools/review.js"
                }]
            }],
            "integrationPolicy": {
                "schemaMajor": 1,
                "status": "compatible",
                "userDefaults": { "enabled": true },
                "globalEffective": {
                    "enabled": true,
                    "ecosystems": {
                        "opencode": {
                            "ecosystemId": "opencode",
                            "mode": "recommended",
                            "capabilities": {
                                "command": "auto",
                                "tool": "ask_before_use",
                                "subagent": "ask_before_use",
                                "mcp": "ask_before_use"
                            }
                        }
                    }
                },
                "effective": {
                    "enabled": true,
                    "ecosystems": {
                        "opencode": {
                            "ecosystemId": "opencode",
                            "mode": "recommended",
                            "capabilities": {
                                "command": "auto",
                                "tool": "ask_before_use",
                                "subagent": "ask_before_use",
                                "mcp": "ask_before_use"
                            }
                        }
                    }
                },
                "registeredEcosystems": [{
                    "ecosystemId": "opencode",
                    "displayName": "OpenCode",
                    "adapterRevision": "1",
                    "capabilities": [
                        {
                            "capabilityId": "command",
                            "recommendedAccess": "auto",
                            "safetyCeiling": "auto"
                        },
                        {
                            "capabilityId": "tool",
                            "recommendedAccess": "ask_before_use",
                            "safetyCeiling": "ask_before_use"
                        },
                        {
                            "capabilityId": "subagent",
                            "recommendedAccess": "ask_before_use",
                            "safetyCeiling": "ask_before_use"
                        },
                        {
                            "capabilityId": "mcp",
                            "recommendedAccess": "ask_before_use",
                            "safetyCeiling": "ask_before_use"
                        }
                    ]
                }]
            },
            "diagnostics": [{
                "severity": "warning",
                "code": "opencode.tool.directory_read_failed",
                "message": "PR2 worker could not read one tool directory",
                "source": { "providerId": "opencode.tools", "sourceId": "project" }
            }]
        }))
    }

    #[test]
    fn external_review_projects_effective_scope_and_capability_policy() {
        let lines = external_integration_policy_lines(&external_tool_review_snapshot());
        let text = lines.join("\n");

        assert!(text.contains("Access: enabled"));
        assert!(text.contains("this project inherits global settings"));
        assert!(text.contains("OpenCode: recommended"));
        assert!(text.contains("command auto"));
        assert!(text.contains("tool ask"));
        assert!(text.contains("openbitfun config external --help"));
    }

    #[test]
    fn external_operation_errors_use_stable_tui_copy_without_raw_details() {
        let stale = ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::StaleRevision,
            "raw stale detail",
            true,
        )
        .with_default_recovery_actions();
        let policy = ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::PolicyLimited,
            "raw policy detail",
            false,
        )
        .with_default_recovery_actions();
        let internal = ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::Internal,
            "database password must not be shown",
            true,
        )
        .with_correlation_id("external-source-ref-9")
        .with_default_recovery_actions();

        let stale_status = external_operation_error_status("tools", &stale);
        assert!(stale_status.contains("settings changed"));
        assert!(stale_status.contains("/tools refresh"));
        assert!(!stale_status.contains("raw stale detail"));

        let policy_status = external_operation_error_status("agents", &policy);
        assert!(policy_status.contains("safety policy"));
        assert!(policy_status.contains("review the listed external items"));
        assert!(!policy_status.contains("raw policy detail"));

        let internal_status = external_operation_error_status("tools", &internal);
        assert!(internal_status.contains("external-source-ref-9"));
        assert!(!internal_status.contains("database password"));
    }

    #[test]
    fn external_tool_review_summary_discloses_execution_boundary_and_commands() {
        let summary = external_tool_review_text(Some(&external_tool_review_snapshot()));

        assert!(summary.contains("OpenBitFun and MCP"));
        assert!(summary.contains("External AI applications"));
        assert!(summary.contains("Use /mcp to manage MCP servers"));
        assert!(summary.contains("OpenBitFun does not run external code while checking sources"));
        assert!(summary.contains("filesystem, network, process, environment variables"));
        assert!(summary.contains("inherited environment variables"));
        assert!(summary.contains("processes it starts may keep running after cancellation"));
        assert!(summary.contains("/tools enable 1"));
        assert!(summary.contains("/tools choose 1 2"));
        assert!(summary.contains("<workspace>/.opencode/tools/review.js"));
        assert!(summary.contains("Source folder: <workspace>/.opencode/tools"));
        assert!(summary.contains("Applies to: current workspace"));
        assert!(summary.contains("Runs in: this computer"));
        assert!(!summary.contains("local:D:/repo"));
        assert!(summary.contains("disabled"));
        assert!(summary.contains("enabled"));
        assert!(summary.contains("loaded and ready to use"));
        assert!(summary.contains("could not load"));
        assert!(summary.contains("<workspace>/.opencode/tools/broken.ts"));
        assert!(!summary.contains("D:/repo"));
        assert!(summary.contains("Issues"));
        assert!(summary.contains("Technical details:"));
        assert!(summary.contains("opencode.tool.directory_read_failed"));
        assert!(!summary.contains("PR2"));
    }

    #[test]
    fn external_tool_runtime_recovery_starts_with_refresh_without_restart_pressure() {
        let mut snapshot = external_tool_review_snapshot();
        snapshot.tools[0].activation = ExternalToolActivationState::RuntimeUnavailable {
            reason: "OpenBitFun could not find Node.js for external tools".to_string(),
        };

        let summary = external_tool_review_text(Some(&snapshot));
        assert!(summary.contains("Install or repair Node.js, then refresh"));
        assert!(summary.contains("continue without external JavaScript tools"));
        assert!(!summary.to_ascii_lowercase().contains("restart"));
    }

    #[test]
    fn external_tool_review_keeps_remembered_conflicts_visible_and_changeable() {
        let mut snapshot = external_tool_review_snapshot();
        let external_candidate_id = snapshot.tools[0].definition.candidate_id();
        snapshot.tool_conflicts[0].candidates[1].candidate_id = external_candidate_id.clone();
        snapshot.tool_conflicts[0].selected_candidate_id = Some(external_candidate_id);

        let summary = external_tool_review_text(Some(&snapshot));
        assert!(summary.contains("Current choices"));
        assert!(summary.contains("OpenCode review [selected, currently unavailable]"));
        assert!(summary.contains("OpenBitFun review [not selected]"));
        assert!(summary.contains("/tools choose 1 1"));

        snapshot.tools[0].activation = ExternalToolActivationState::Active;
        let active_summary = external_tool_review_text(Some(&snapshot));
        assert!(active_summary.contains("OpenCode review [selected]"));
        assert!(!active_summary.contains("selected, currently unavailable"));

        assert_eq!(
            parse_external_tool_review_action("choose 1 1", Some(&snapshot), None).unwrap(),
            ExternalToolReviewAction::Choose {
                conflict_key: "conflict-v1".to_string(),
                candidate_id: "openbitfun:review".to_string(),
            }
        );
        let notice = external_tool_pending_notice_key(&snapshot).unwrap();
        assert!(notice.contains("approval:decision-v1"));
        assert!(notice.contains("opencode.tool.directory_read_failed"));
        assert!(!notice.contains("conflict:conflict-v1"));
    }

    #[test]
    fn external_tool_review_commands_resolve_indices_to_stable_keys() {
        let snapshot = external_tool_review_snapshot();

        assert_eq!(
            parse_external_tool_review_action("enable 2", Some(&snapshot), None).unwrap(),
            ExternalToolReviewAction::Decide {
                approval_key: "approval-v2".to_string(),
                decision_key: "decision-v2".to_string(),
                approved: true,
            }
        );
        assert_eq!(
            parse_external_tool_review_action("disable 3", Some(&snapshot), None).unwrap(),
            ExternalToolReviewAction::Decide {
                approval_key: "approval-v3".to_string(),
                decision_key: "decision-v3".to_string(),
                approved: false,
            }
        );
        assert_eq!(
            parse_external_tool_review_action("disable 4", Some(&snapshot), None).unwrap(),
            ExternalToolReviewAction::Decide {
                approval_key: "approval-v4".to_string(),
                decision_key: "decision-v4".to_string(),
                approved: false,
            }
        );
        assert_eq!(
            parse_external_tool_review_action("choose 1 2", Some(&snapshot), None).unwrap(),
            ExternalToolReviewAction::Choose {
                conflict_key: "conflict-v1".to_string(),
                candidate_id: "external:review".to_string(),
            }
        );
        assert!(parse_external_tool_review_action("enable 3", Some(&snapshot), None).is_err());
    }

    #[test]
    fn external_tool_review_commands_keep_the_indices_from_the_displayed_review() {
        let reviewed = external_tool_review_snapshot();
        let mut current = reviewed.clone();
        current.tools.swap(0, 1);

        assert_eq!(
            parse_external_tool_review_action("enable 2", Some(&current), Some(&reviewed)).unwrap(),
            ExternalToolReviewAction::Decide {
                approval_key: "approval-v2".to_string(),
                decision_key: "decision-v2".to_string(),
                approved: true,
            }
        );
    }

    #[test]
    fn external_tool_enable_result_reports_the_returned_activation() {
        let mut snapshot = external_tool_review_snapshot();
        snapshot.tools[0].activation = ExternalToolActivationState::LoadFailed {
            reason: "module import failed".to_string(),
        };
        let action = ExternalToolReviewAction::Decide {
            approval_key: "approval-v1".to_string(),
            decision_key: "decision-v1".to_string(),
            approved: true,
        };

        assert_eq!(
            external_tool_mutation_result_label(&action, &snapshot),
            "External tool enabled, but loading failed"
        );
    }

    #[test]
    fn external_tool_notice_key_changes_for_pending_decisions_or_diagnostics() {
        let snapshot = external_tool_review_snapshot();
        let key = external_tool_pending_notice_key(&snapshot).unwrap();
        let mut generation_only = snapshot.clone();
        generation_only.generation += 1;
        assert_eq!(
            external_tool_pending_notice_key(&generation_only),
            Some(key.clone())
        );

        generation_only.tool_approval_requests[0].decision_key = "decision-v2".to_string();
        assert_ne!(
            external_tool_pending_notice_key(&generation_only),
            Some(key.clone())
        );

        let mut diagnostic_change = snapshot;
        diagnostic_change.diagnostics[0].message = "different failure".to_string();
        assert_ne!(
            external_tool_pending_notice_key(&diagnostic_change),
            Some(key)
        );
    }

    #[test]
    fn external_tool_mutation_result_does_not_overwrite_a_newer_catalog_generation() {
        let incoming = external_tool_review_snapshot();
        let mut current = incoming.clone();
        current.generation += 1;

        assert!(external_tool_result_is_stale(Some(&current), &incoming));
        assert!(!external_tool_result_is_stale(Some(&incoming), &current));
        assert!(!external_tool_result_is_stale(None, &incoming));
    }

    #[test]
    fn hooks_uses_the_existing_native_command_collision_flow() {
        let action =
            crate::actions::action_for_alias("/hooks", crate::actions::ActionContext::Chat)
                .expect("/hooks must be registered");
        assert_eq!(action.id, "hooks");
        // /hooks shows OpenBitFun's own executable hooks; the external read-only
        // catalog keeps its own command.
        assert_eq!(action.handler, ActionHandler::NativeHooks);
        for alias in ["/hooks_external", "/hooks-external"] {
            let external =
                crate::actions::action_for_alias(alias, crate::actions::ActionContext::Chat)
                    .unwrap_or_else(|| panic!("{alias} must be registered"));
            assert_eq!(external.id, "hooks_external");
            assert_eq!(external.handler, ActionHandler::ExternalHooks);
        }
        let collision = external_command("hooks", None);
        assert_eq!(
            command_route(true, Some(&collision), false, false),
            CommandRoute::AskForCollisionChoice
        );
        let selected_external = external_command("hooks", Some("external:hooks"));
        assert_eq!(
            command_route(true, Some(&selected_external), false, false),
            CommandRoute::External
        );
        assert!(extension_command_help_request("hooks", "--help").is_some());
        assert!(extension_command_help_request("hooks", "unexpected").is_none());
        assert!(extension_command_help_request("help", "hooks").is_some());
        assert!(extension_command_help_request("hooks_external", "--help").is_some());
        assert!(extension_command_help_request("help", "other").is_none());
        assert!(extension_command_help_request("extensions", "-h")
            .unwrap()
            .contains("Usage: /extensions"));
        assert!(extension_command_help_request("help", "mcp")
            .unwrap()
            .contains("Usage: /mcp"));
        let agent_help = extension_command_help_request("agent", "-h").unwrap();
        assert!(agent_help.contains("Usage: /agent"));
        assert!(agent_help.contains("Alias: /agents"));
        assert_eq!(
            extension_command_help_request("help", "agents"),
            Some(agent_help)
        );
    }

    #[test]
    fn hooks_management_requires_an_explicit_second_step_for_writes() {
        assert_eq!(
            parse_hook_management_action("import 2").unwrap(),
            HookManagementAction::Import {
                source_number: 2,
                confirm: false,
            }
        );
        assert_eq!(
            parse_hook_management_action("update 1 --confirm").unwrap(),
            HookManagementAction::Update {
                import_number: 1,
                confirm: true,
            }
        );
        assert!(parse_hook_management_action("remove 1").is_err());
        assert_eq!(
            parse_hook_management_action("remove 1 --confirm").unwrap(),
            HookManagementAction::Remove { import_number: 1 }
        );
        assert!(parse_hook_management_action("reset user").is_err());
        assert_eq!(
            parse_hook_management_action("reset project --confirm").unwrap(),
            HookManagementAction::Reset {
                scope: ExternalSourceScope::Project,
            }
        );
        assert!(parse_hook_management_action("enable 0").is_err());
    }

    #[test]
    fn selected_external_help_keeps_its_hooks_argument() {
        let selected_external = external_command("help", Some("external:help"));
        assert_eq!(
            command_route(true, Some(&selected_external), false, false),
            CommandRoute::External
        );
    }

    #[test]
    fn hook_catalog_text_is_read_only_redacted_and_explains_native_only_events() {
        let snapshot: ExternalHookCatalogSnapshotV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "discoveryPending": false,
            "providers": [{
                "providerId": "claude-code.hooks",
                "ecosystemId": "claude-code",
                "displayName": "Claude Code Hooks"
            }],
            "sources": [{
                "key": {"providerId": "claude-code.hooks", "sourceId": "project-settings"},
                "ecosystemId": "claude-code",
                "displayName": "Claude Code project settings",
                "sourceKind": "settings",
                "scope": "project",
                "locationHint": ".claude/settings.json",
                "health": "available",
                "contentVersion": "sha256:source"
            }],
            "entries": [
                {
                    "stableKey": "claude-pre",
                    "source": {"providerId": "claude-code.hooks", "sourceId": "project-settings"},
                    "nativeEvent": "PreToolUse",
                    "matcher": {"kind": "pattern", "display": "Bash|Edit"},
                    "handlerKind": "command",
                    "projectionStatus": "mapped",
                    "nativeActivation": "unknown",
                    "mapping": {"hookPoint": "tool_before"},
                    "contentVersion": "sha256:pre"
                },
                {
                    "stableKey": "claude-session",
                    "source": {"providerId": "claude-code.hooks", "sourceId": "project-settings"},
                    "nativeEvent": "SessionStart",
                    "matcher": {"kind": "any"},
                    "handlerKind": "http",
                    "projectionStatus": "native_only",
                    "nativeActivation": "unknown",
                    "contentVersion": "sha256:session"
                },
                {
                    "stableKey": "claude-opaque",
                    "source": {"providerId": "claude-code.hooks", "sourceId": "project-settings"},
                    "nativeEvent": "<dynamic>",
                    "matcher": {"kind": "dynamic"},
                    "handlerKind": "function",
                    "projectionStatus": "opaque",
                    "nativeActivation": "unknown",
                    "contentVersion": "sha256:opaque"
                }
            ],
            "staleProviderIds": [],
            "diagnostics": []
        }))
        .unwrap();

        let text = render_external_hook_catalog(&snapshot);
        assert!(text.contains("Available external Hook sources"));
        assert!(text.contains("Discovery is read-only"));
        assert!(text.contains("Claude Code"));
        assert!(text.contains("PreToolUse"));
        assert!(text.contains("coverage mapped: OpenBitFun tool before"));
        assert!(text.contains("SessionStart"));
        assert!(text.contains("native only"));
        assert!(text.contains("opaque static registration"));
        assert!(text.contains("Bash|Edit"));
        assert!(!text.contains("command body"));
    }

    fn native_hook_overview() -> NativeHookOverview {
        NativeHookOverview {
            enabled: true,
            project_hooks_enabled: false,
            files: vec![
                NativeHookFileView {
                    scope: "user".to_string(),
                    location: "<user-config>/config/hooks.json".to_string(),
                    exists: true,
                    loaded: true,
                },
                NativeHookFileView {
                    scope: "project".to_string(),
                    location: "<workspace>/.openbitfun/config/hooks.json".to_string(),
                    exists: true,
                    loaded: false,
                },
            ],
            rules: vec![NativeHookRuleView {
                event: "PreToolUse".to_string(),
                matcher: "Bash".to_string(),
                matcher_is_valid: true,
                scope: "user".to_string(),
                handlers: vec![NativeHookHandlerView {
                    command_summary: "jq -r '.tool_input.command' >> ~/log".to_string(),
                    command_truncated: false,
                    timeout_seconds: 600,
                    status_message: None,
                }],
            }],
            total_handlers: 1,
            issues: vec!["Hook event 'PreTool' is not a supported event name: /ws".to_string()],
        }
    }

    #[test]
    fn native_hook_text_reports_gating_layers_and_issues() {
        let text = render_native_hook_overview(&native_hook_overview());

        assert!(text.contains("Hooks (OpenBitFun)"));
        assert!(text.contains("Hooks: enabled (app.hooks.enabled)"));
        assert!(text.contains("Project hook file: disabled (app.hooks.project_hooks_enabled)"));
        assert!(text.contains("user [loaded; present]"));
        assert!(text.contains("project [not loaded; present]"));
        assert!(text.contains("PreToolUse"));
        assert!(text.contains("matcher: Bash [user; 1 handler]"));
        assert!(text.contains("timeout 600s"));
        assert!(text.contains("is not a supported event name"));
    }

    #[test]
    fn native_hook_text_explains_an_empty_or_disabled_configuration() {
        let mut overview = native_hook_overview();
        overview.rules.clear();
        overview.total_handlers = 0;
        overview.issues.clear();
        assert!(render_native_hook_overview(&overview).contains("No hooks are configured."));

        overview.enabled = false;
        let disabled = render_native_hook_overview(&overview);
        assert!(disabled.contains("Hooks: disabled (app.hooks.enabled)"));
        assert!(disabled.contains("set app.hooks.enabled to run them"));
    }

    #[test]
    fn native_hook_text_flags_a_matcher_that_never_matches() {
        let mut overview = native_hook_overview();
        overview.rules[0].matcher = "Bash(".to_string();
        overview.rules[0].matcher_is_valid = false;

        let text = render_native_hook_overview(&overview);

        assert!(text.contains("invalid pattern, never matches"));
    }

    #[test]
    fn external_hooks_help_uses_the_established_slash_help_pattern() {
        let help = external_hook_help_text();
        assert!(help.contains("Usage: /hooks"));
        assert!(help.contains("Compatibility aliases: /hooks_external and /hooks-external"));
        assert!(help.contains("/help hooks"));
        assert!(help.contains("/hooks -h"));
        assert!(help.contains("/hooks --help"));
        assert!(!help.contains("/builtin:hooks"));
    }

    #[test]
    fn native_hooks_help_uses_the_established_slash_help_pattern() {
        let help = native_hook_help_text();
        assert!(help.contains("Usage: /hooks"));
        assert!(help.contains("/help hooks"));
        assert!(help.contains("/hooks -h"));
        assert!(help.contains("/hooks --help"));
        // The two views must stay distinguishable from their help alone.
        assert!(help.contains("/hooks_external"));
        assert!(!help.contains("Usage: /hooks_external"));
    }

    #[test]
    fn hook_catalog_text_distinguishes_failed_empty_providers() {
        let snapshot: ExternalHookCatalogSnapshotV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "discoveryPending": false,
            "providers": [{
                "providerId": "failed.hooks",
                "ecosystemId": "failed",
                "displayName": "Failed Hooks"
            }],
            "sources": [],
            "entries": [],
            "failedProviderIds": ["failed.hooks"],
            "diagnostics": [{
                "severity": "error",
                "assetKind": "hook",
                "code": "failed.hook.read_failed",
                "message": "read failed"
            }]
        }))
        .unwrap();

        let text = render_external_hook_catalog(&snapshot);

        assert!(text.contains("Failed Hooks: 0 Hooks, 0 sources (discovery failed)"));
        assert!(text.contains("No valid catalog is available"));
        assert!(!text.contains("No supported Hook configuration was found"));
    }

    #[test]
    fn hook_catalog_text_does_not_call_a_stale_empty_catalog_successful() {
        let snapshot: ExternalHookCatalogSnapshotV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "discoveryPending": false,
            "providers": [{
                "providerId": "stale.hooks",
                "ecosystemId": "stale",
                "displayName": "Stale Hooks"
            }],
            "sources": [],
            "entries": [],
            "staleProviderIds": ["stale.hooks"],
            "diagnostics": []
        }))
        .unwrap();

        let text = render_external_hook_catalog(&snapshot);

        assert!(text.contains("The last valid catalog is empty"));
        assert!(!text.contains("No supported Hook configuration was found"));
    }

    #[test]
    fn hook_catalog_text_bounds_large_provider_output() {
        let mut snapshot: ExternalHookCatalogSnapshotV1 =
            serde_json::from_value(serde_json::json!({
                "schemaVersion": 1,
                "discoveryPending": false,
                "providers": [{
                    "providerId": "test.hooks",
                    "ecosystemId": "test",
                    "displayName": "Test Hooks"
                }],
                "sources": [{
                    "key": {"providerId": "test.hooks", "sourceId": "project"},
                    "ecosystemId": "test",
                    "displayName": "Project Hooks",
                    "sourceKind": "settings",
                    "scope": "project",
                    "locationHint": ".test/settings.json",
                    "health": "available",
                    "contentVersion": "source-v1"
                }],
                "entries": [],
                "staleProviderIds": [],
                "diagnostics": []
            }))
            .unwrap();
        snapshot.entries = (0..105)
            .map(|index| ExternalHookCatalogEntry {
                stable_key: format!("test-{index}"),
                source: snapshot.sources[0].key.clone(),
                native_event: format!("Event{index}"),
                matcher: ExternalHookMatcherSummary::Any,
                handler_kind: ExternalHookHandlerKind::Command,
                projection_status: ExternalHookProjectionStatus::NativeOnly,
                native_activation: ExternalHookNativeActivation::Unknown,
                mapping: None,
                content_version: format!("entry-v{index}"),
            })
            .collect();

        let text = render_external_hook_catalog(&snapshot);

        assert_eq!(text.matches("    - Event").count(), 100);
        assert!(text.contains("omitted 0 source(s), 5 Hook(s)"));
    }

    #[test]
    fn unresolved_provider_conflicts_expose_explicit_cli_choices() {
        let snapshot = public_external_source_snapshot(serde_json::json!({
            "generation": 1,
            "discoveryPending": false,
            "sources": [
                {
                    "stableKey": "first",
                    "record": {
                        "key": { "providerId": "first.commands", "sourceId": "global" },
                        "ecosystemId": "first",
                        "displayName": "First commands",
                        "sourceKind": "prompt_commands",
                        "scope": "user_global",
                        "location": "/first",
                        "executionDomainId": "local-user",
                        "health": "available",
                        "contentVersion": "source-v1"
                    },
                    "lifecycle": "available"
                },
                {
                    "stableKey": "second",
                    "record": {
                        "key": { "providerId": "second.commands", "sourceId": "global" },
                        "ecosystemId": "second",
                        "displayName": "Second commands",
                        "sourceKind": "prompt_commands",
                        "scope": "user_global",
                        "location": "/second",
                        "executionDomainId": "local-user",
                        "health": "available",
                        "contentVersion": "source-v1"
                    },
                    "lifecycle": "available"
                }
            ],
            "commands": [],
            "commandConflicts": [{
                "conflictKey": "provider-conflict-v1",
                "commandName": "review",
                "candidates": [
                    {
                        "candidateId": "first-candidate",
                        "source": { "providerId": "first.commands", "sourceId": "global" },
                        "sourceDisplayName": "First commands",
                        "ecosystemId": "first",
                        "contentVersion": "command-v1",
                        "commandDescription": "First review",
                        "sourceScope": "user_global",
                        "sourceLocation": "/first",
                        "availability": { "state": "available" }
                    },
                    {
                        "candidateId": "second-candidate",
                        "source": { "providerId": "second.commands", "sourceId": "global" },
                        "sourceDisplayName": "Second commands",
                        "ecosystemId": "second",
                        "contentVersion": "command-v1",
                        "commandDescription": "Second review",
                        "sourceScope": "user_global",
                        "sourceLocation": "/second",
                        "availability": { "state": "available" }
                    }
                ]
            }]
        }));

        let projections = external_command_projections(&snapshot, &BTreeMap::new());

        assert_eq!(projections.len(), 2);
        assert!(projections.iter().all(|projection| {
            projection.provider_conflict_key.as_deref() == Some("provider-conflict-v1")
        }));
        assert!(projections
            .iter()
            .all(|projection| projection.invocation_alias == "/review"));
    }

    #[test]
    fn native_collision_requires_one_choice_and_then_reuses_it() {
        let unresolved = external_command("help", None);
        assert_eq!(
            command_route(true, Some(&unresolved), false, false),
            CommandRoute::AskForCollisionChoice
        );
        let selected = external_command("help", Some("external:help"));
        assert_eq!(
            command_route(true, Some(&selected), false, false),
            CommandRoute::External
        );
    }

    #[test]
    fn rename_arguments_run_only_after_the_builtin_collision_route_wins() {
        let action =
            crate::actions::action_for_alias("/rename", crate::actions::ActionContext::Chat)
                .expect("rename action");

        assert!(builtin_arguments_route(
            CommandRoute::Builtin,
            action.handler,
        ));
        for route in [
            CommandRoute::External,
            CommandRoute::AskForCollisionChoice,
            CommandRoute::WaitForDiscovery,
        ] {
            assert!(!builtin_arguments_route(route, action.handler));
        }
    }

    #[test]
    fn session_actions_reject_arguments_only_after_the_builtin_route_wins() {
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::CompactSession,
                "unexpected"
            ),
            Some("Usage: /compact")
        );
        assert_eq!(
            builtin_arguments_error(CommandRoute::Builtin, ActionHandler::CompactSession, "   "),
            None
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::External,
                ActionHandler::CompactSession,
                "unexpected"
            ),
            None
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::ForkSession,
                "unexpected"
            ),
            Some("Usage: /fork")
        );
        assert_eq!(
            builtin_arguments_error(CommandRoute::Builtin, ActionHandler::Timeline, "unexpected"),
            Some("Usage: /timeline")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::UndoSession,
                "unexpected"
            ),
            Some("Usage: /undo")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::RedoSession,
                "unexpected"
            ),
            Some("Usage: /redo")
        );
        assert_eq!(
            builtin_arguments_error(CommandRoute::Builtin, ActionHandler::Editor, "unexpected"),
            Some("Usage: /editor")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::ToggleTimestamps,
                "unexpected"
            ),
            Some("Usage: /timestamps")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::ToggleThinking,
                "unexpected"
            ),
            Some("Usage: /thinking")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::CopyTranscript,
                "unexpected"
            ),
            Some("Usage: /copy")
        );
        assert_eq!(
            builtin_arguments_error(
                CommandRoute::Builtin,
                ActionHandler::ExportTranscript,
                "unexpected"
            ),
            Some("Usage: /export")
        );
    }

    #[test]
    fn pending_local_effect_fences_input_but_keeps_resize_events() {
        assert!(!terminal_event_allowed_while_local_effect_pending(
            &Event::Paste("new draft".to_string())
        ));
        assert!(!terminal_event_allowed_while_local_effect_pending(
            &Event::FocusLost
        ));
        assert!(terminal_event_allowed_while_local_effect_pending(
            &Event::Resize(120, 40)
        ));
    }

    #[test]
    fn native_choice_is_reused_when_multiple_external_candidates_remain_unresolved() {
        let selected_native = "openbitfun.cli:help";
        let first = external_command("help", Some(selected_native));
        let mut second = external_command("help", Some(selected_native));
        second.candidate_id = "external:help:second".to_string();
        second
            .native_collision
            .as_mut()
            .unwrap()
            .external_candidate_id = second.candidate_id.clone();

        assert!(native_command_choice_is_active(None, &[first, second]));
        assert!(!native_command_reconfirmation_is_required(
            false, true, true,
        ));
        assert_eq!(
            command_route(true, None, false, false),
            CommandRoute::Builtin,
        );
    }

    #[test]
    fn discovery_pending_does_not_block_known_openbitfun_commands() {
        assert_eq!(
            command_route(true, None, true, false),
            CommandRoute::Builtin
        );
        assert_eq!(
            command_route(false, None, true, false),
            CommandRoute::WaitForDiscovery
        );
    }

    #[test]
    fn mcp_primary_and_compatibility_aliases_keep_the_native_candidate_identity() {
        for alias in ["mcp", "mcps"] {
            let descriptors = cli_native_prompt_command_descriptors(alias);
            assert_eq!(descriptors.len(), 1);
            assert_eq!(descriptors[0].command_name, alias);
            assert_eq!(descriptors[0].candidate_id, "openbitfun.cli:mcp_servers");
        }
    }

    #[test]
    fn removed_external_candidate_requires_builtin_reconfirmation() {
        assert_eq!(
            command_route(true, None, false, true),
            CommandRoute::AskForCollisionChoice
        );
    }

    #[test]
    fn persisted_collision_history_detects_a_removed_external_candidate() {
        let action =
            crate::actions::action_for_alias("/help", crate::actions::ActionContext::Chat).unwrap();
        let mut preferences = ExternalSourceConflictPreferences {
            choices: BTreeMap::new(),
            lineage_current_keys: BTreeMap::new(),
            conflicted_candidate_ids: BTreeSet::from([
                "openbitfun.cli:help".to_string(),
                "external:help".to_string(),
            ]),
        };

        let pending = builtin_command_reconfirmation(action.id, "help", &preferences).unwrap();
        assert!(!pending.confirmed);

        let conflict_key = native_prompt_command_conflict_key(
            "local-user",
            "help",
            [(
                pending.candidate_id.as_str(),
                action_conflict_behavior_version(action.id),
            )],
        );
        preferences
            .choices
            .insert(conflict_key, pending.candidate_id.clone());
        let confirmed = builtin_command_reconfirmation(action.id, "help", &preferences).unwrap();
        assert!(confirmed.confirmed);
    }

    #[test]
    fn agent_event_stream_failure_ignores_empty_queue() {
        assert_eq!(agent_event_stream_failure(TryRecvError::Empty), None);
    }

    #[test]
    fn agent_event_stream_failure_treats_lagged_and_closed_as_fatal() {
        let lagged = agent_event_stream_failure(TryRecvError::Lagged(7))
            .expect("lagged stream must be fatal");
        assert!(lagged.contains("lagged by 7 events"));
        assert!(lagged.contains("can no longer be trusted"));

        let closed =
            agent_event_stream_failure(TryRecvError::Closed).expect("closed stream must be fatal");
        assert!(closed.contains("closed"));
        assert!(closed.contains("can no longer be trusted"));
    }

    #[test]
    fn agent_event_stream_failure_marks_active_turn_failed() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.handle_turn_started("turn", "hello");

        assert!(mark_active_turn_failed(
            &mut state,
            "Agent event stream closed; chat state can no longer be trusted"
        ));
        assert_eq!(state.current_turn_id(), None);
        assert!(!state.is_processing);
    }

    #[test]
    fn primary_model_usage_projection_rejects_other_sessions_turns_and_subagents() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.handle_turn_started("turn", "hello");

        let event =
            |session_id: &str, turn_id: &str, is_subagent: bool| AgenticEvent::TokenUsageUpdated {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                model_config_id: "model-config".to_string(),
                effective_model_name: "example-model".to_string(),
                input_tokens: 80_000,
                output_tokens: Some(2_000),
                total_tokens: 82_000,
                max_context_tokens: Some(128_000),
                is_subagent,
                cached_tokens: Some(10_000),
                token_details: None,
            };

        let usage = primary_model_usage_for_active_turn(&event("session", "turn", false), &state)
            .expect("matching primary-model event");
        assert_eq!(usage.total_tokens, 82_000);
        assert_eq!(usage.effective_model_name, "example-model");

        assert!(primary_model_usage_for_active_turn(
            &event("other-session", "turn", false),
            &state
        )
        .is_none());
        assert!(primary_model_usage_for_active_turn(
            &event("session", "other-turn", false),
            &state
        )
        .is_none());
        assert!(
            primary_model_usage_for_active_turn(&event("session", "turn", true), &state).is_none()
        );
    }

    #[test]
    fn context_compression_projection_is_scoped_to_the_active_session_turn() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.handle_turn_started("turn", "/compact");

        let started = AgenticEvent::ContextCompressionStarted {
            session_id: "session".to_string(),
            turn_id: "turn".to_string(),
            compression_id: "compression".to_string(),
            trigger: "manual".to_string(),
            tokens_before: 80_000,
            context_window: 128_000,
        };
        let projected =
            context_compression_tool_event(&started, &state).expect("active compression event");
        match projected {
            ToolEventData::Started {
                identity, params, ..
            } => {
                assert_eq!(identity.tool_id, "compression");
                assert_eq!(identity.effective_name(), "ContextCompression");
                assert_eq!(params["trigger"], "manual");
                assert_eq!(params["tokens_before"], 80_000);
            }
            _ => panic!("expected started tool event"),
        }

        let other_turn = AgenticEvent::ContextCompressionStarted {
            session_id: "session".to_string(),
            turn_id: "other-turn".to_string(),
            compression_id: "other-compression".to_string(),
            trigger: "manual".to_string(),
            tokens_before: 80_000,
            context_window: 128_000,
        };
        assert!(context_compression_tool_event(&other_turn, &state).is_none());

        let other_session = AgenticEvent::ContextCompressionStarted {
            session_id: "other-session".to_string(),
            turn_id: "turn".to_string(),
            compression_id: "other-compression".to_string(),
            trigger: "manual".to_string(),
            tokens_before: 80_000,
            context_window: 128_000,
        };
        assert!(context_compression_tool_event(&other_session, &state).is_none());
    }

    #[test]
    fn context_compression_completion_projects_the_persisted_tool_shape() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.handle_turn_started("turn", "/compact");
        let completed = AgenticEvent::ContextCompressionCompleted {
            session_id: "session".to_string(),
            turn_id: "turn".to_string(),
            compression_id: "compression".to_string(),
            compression_count: 2,
            tokens_before: 80_000,
            tokens_after: 20_000,
            compression_ratio: 0.25,
            duration_ms: 42,
            has_summary: true,
            summary_source: "model".to_string(),
            applied: true,
        };

        match context_compression_tool_event(&completed, &state)
            .expect("active compression completion")
        {
            ToolEventData::Completed {
                identity,
                result,
                duration_ms,
                ..
            } => {
                assert_eq!(identity.tool_id, "compression");
                assert_eq!(result["tokens_before"], 80_000);
                assert_eq!(result["tokens_after"], 20_000);
                assert_eq!(result["applied"], true);
                assert_eq!(result["summary_source"], "model");
                assert_eq!(duration_ms, 42);
            }
            _ => panic!("expected completed tool event"),
        }
    }

    #[test]
    fn context_compression_failure_projects_the_existing_tool_error_shape() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.handle_turn_started("turn", "/compact");
        let failed = AgenticEvent::ContextCompressionFailed {
            session_id: "session".to_string(),
            turn_id: "turn".to_string(),
            compression_id: "compression".to_string(),
            error: "summary request failed".to_string(),
        };

        match context_compression_tool_event(&failed, &state).expect("active compression failure") {
            ToolEventData::Failed {
                identity, error, ..
            } => {
                assert_eq!(identity.tool_id, "compression");
                assert_eq!(error, "summary request failed");
            }
            _ => panic!("expected failed tool event"),
        }
    }

    #[test]
    fn model_selection_commits_only_the_current_session_state_after_runtime_success() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("old-model-id".to_string());
        state.current_model_name = "Old model".to_string();

        apply_model_selection_feedback(
            &mut state,
            "New model / Provider",
            "new-model-id",
            SessionUpdateApplyOutcome::Applied,
        );

        assert_eq!(state.current_model_id.as_deref(), Some("new-model-id"));
        assert_eq!(state.current_model_name, "New model / Provider");
        assert!(state.messages.is_empty());
    }

    #[test]
    fn runtime_model_fallback_replaces_the_visible_session_model_and_explains_why() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("removed-model".to_string());
        state.current_model_name = "Removed model".to_string();

        assert!(apply_session_model_fallback(
            &mut state,
            "session",
            "removed-model",
            "replacement-model",
            "model_deleted",
        ));

        assert_eq!(state.current_model_id.as_deref(), Some("replacement-model"));
        assert_eq!(state.current_model_name, "replacement-model");
        let notice = state.messages.last().expect("fallback notice");
        let crate::chat_state::FlowItem::Text { content, .. } = &notice.flow_items[0] else {
            panic!("fallback notice must be text");
        };
        assert!(content.contains("removed-model"));
        assert!(content.contains("replacement-model"));
        assert!(content.contains("model_deleted"));
    }

    #[test]
    fn runtime_model_fallback_ignores_another_session() {
        let mut state = ChatState::new(
            "current-session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("removed-model".to_string());
        state.current_model_name = "Removed model".to_string();

        assert!(!apply_session_model_fallback(
            &mut state,
            "other-session",
            "removed-model",
            "replacement-model",
            "model_deleted",
        ));
        assert_eq!(state.current_model_id.as_deref(), Some("removed-model"));
        assert!(state.messages.is_empty());
    }

    #[test]
    fn runtime_model_fallback_ignores_a_stale_previous_selector() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("newer-explicit-model".to_string());
        state.current_model_name = "Newer explicit model".to_string();

        assert!(!apply_session_model_fallback(
            &mut state,
            "session",
            "removed-model",
            "primary",
            "model_deleted",
        ));
        assert_eq!(
            state.current_model_id.as_deref(),
            Some("newer-explicit-model")
        );
        assert!(state.messages.is_empty());
    }

    #[test]
    fn model_selection_reports_when_the_current_session_update_fails() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("old-model-id".to_string());
        state.current_model_name = "Old model".to_string();

        apply_model_selection_feedback(
            &mut state,
            "New model / Provider",
            "new-model-id",
            SessionUpdateApplyOutcome::SessionUpdateFailed("session unavailable".to_string()),
        );

        assert_eq!(state.current_model_id.as_deref(), Some("old-model-id"));
        assert_eq!(state.current_model_name, "Old model");
        let notice = state.messages.last().expect("failure notice");
        let crate::chat_state::FlowItem::Text { content, .. } = &notice.flow_items[0] else {
            panic!("failure notice must be text");
        };
        assert!(content.contains("was not changed"));
        assert!(content.contains("retry"));
    }

    #[test]
    fn unknown_model_update_outcome_requires_restore_before_retry() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        state.current_model_id = Some("old-model-id".to_string());
        state.current_model_name = "Old model".to_string();

        apply_model_selection_feedback(
            &mut state,
            "New model / Provider",
            "new-model-id",
            SessionUpdateApplyOutcome::OutcomeUnknown("request timed out".to_string()),
        );

        assert_eq!(state.current_model_id.as_deref(), Some("old-model-id"));
        assert_eq!(state.current_model_name, "Old model");
        let notice = state.messages.last().expect("unknown-outcome notice");
        let crate::chat_state::FlowItem::Text { content, .. } = &notice.flow_items[0] else {
            panic!("unknown-outcome notice must be text");
        };
        assert!(content.contains("outcome is unknown"));
        assert!(content.contains("restore this session"));
    }

    #[test]
    fn mode_selection_commits_visible_state_only_after_runtime_success() {
        let mut current_mode = "Standard".to_string();
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );

        let applied = apply_agent_mode_feedback(
            &mut current_mode,
            &mut state,
            "plan",
            SessionUpdateApplyOutcome::Applied,
        );

        assert!(applied);
        assert_eq!(current_mode, "plan");
        assert_eq!(state.agent_type, "plan");
    }

    #[test]
    fn mode_selection_failure_preserves_visible_state_and_explains_retry() {
        let mut current_mode = "Standard".to_string();
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );

        let applied = apply_agent_mode_feedback(
            &mut current_mode,
            &mut state,
            "plan",
            SessionUpdateApplyOutcome::SessionUpdateFailed(
                "session storage unavailable".to_string(),
            ),
        );

        assert!(!applied);
        assert_eq!(current_mode, "Standard");
        assert_eq!(state.agent_type, "Standard");
        let notice = state.messages.last().expect("failure notice");
        let crate::chat_state::FlowItem::Text { content, .. } = &notice.flow_items[0] else {
            panic!("failure notice must be text");
        };
        assert!(content.contains("was not changed"));
        assert!(content.contains("retry"));
    }

    #[test]
    fn previous_session_update_failure_is_not_reported_as_a_success() {
        let status = previous_session_update_status(
            "mode",
            "Cowork",
            &SessionUpdateApplyOutcome::SessionUpdateFailed("storage unavailable".to_string()),
        );

        assert!(status.contains("failed"));
        assert!(status.contains("storage unavailable"));
        assert!(status.contains("retry"));
    }

    #[test]
    fn previous_session_unknown_outcome_requires_a_reload() {
        let status = previous_session_update_status(
            "name",
            "Renamed",
            &SessionUpdateApplyOutcome::OutcomeUnknown("rollback was not confirmed".to_string()),
        );

        assert!(status.contains("This TUI is closing"));
        assert!(status.contains("restore that session"));
        assert!(!status.contains("Shared TUI"));
    }

    #[test]
    fn unknown_mode_update_outcome_requires_restore_before_retry() {
        let mut current_mode = "Standard".to_string();
        let mut state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );

        let applied = apply_agent_mode_feedback(
            &mut current_mode,
            &mut state,
            "plan",
            SessionUpdateApplyOutcome::OutcomeUnknown("request timed out".to_string()),
        );

        assert!(!applied);
        assert_eq!(current_mode, "Standard");
        assert_eq!(state.agent_type, "Standard");
        let notice = state.messages.last().expect("unknown-outcome notice");
        let crate::chat_state::FlowItem::Text { content, .. } = &notice.flow_items[0] else {
            panic!("unknown-outcome notice must be text");
        };
        assert!(content.contains("outcome is unknown"));
        assert!(content.contains("This TUI is closing"));
        assert!(content.contains("restore this session"));
        assert!(!content.contains("was not changed"));
    }

    #[test]
    fn rename_arguments_are_trimmed_and_empty_names_show_usage() {
        assert_eq!(
            requested_session_name("  Auth refactor  ").as_deref(),
            Some("Auth refactor")
        );
        assert!(requested_session_name("").is_none());
        assert!(requested_session_name("   ").is_none());
    }

    #[test]
    fn session_name_changes_only_after_runtime_confirmation() {
        let mut state = ChatState::new(
            "session".to_string(),
            "Original".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );

        assert!(!apply_session_rename_feedback(
            &mut state,
            "Rejected",
            SessionUpdateApplyOutcome::SessionUpdateFailed("storage failed".to_string()),
        ));
        assert_eq!(state.session_name, "Original");

        assert!(!apply_session_rename_feedback(
            &mut state,
            "Unknown",
            SessionUpdateApplyOutcome::OutcomeUnknown("request timed out".to_string()),
        ));
        assert_eq!(state.session_name, "Original");

        assert!(apply_session_rename_feedback(
            &mut state,
            "Auth refactor",
            SessionUpdateApplyOutcome::Applied,
        ));
        assert_eq!(state.session_name, "Auth refactor");
    }

    #[test]
    fn shared_session_delete_is_available_only_when_idle_and_no_operation_is_pending() {
        assert!(session_delete_allowed(false, true, false, false));
        assert!(!session_delete_allowed(true, true, false, false));
        assert!(!session_delete_allowed(false, true, true, false));
        assert!(!session_delete_allowed(false, true, false, true));

        // Embedded deletion keeps its existing ability to delete another
        // Session while the current Session is running a Turn.
        assert!(session_delete_allowed(false, false, true, false));
    }

    #[test]
    fn session_delete_removes_the_item_only_after_runtime_confirmation() {
        let (remove, status) = session_delete_feedback(
            "Old session",
            &SessionUpdateApplyOutcome::SessionUpdateFailed("session in use".to_string()),
        );
        assert!(!remove);
        assert!(status.contains("session in use"));

        let (remove, status) =
            session_delete_feedback("Old session", &SessionUpdateApplyOutcome::Applied);
        assert!(remove);
        assert_eq!(status, "Session deleted: Old session");

        let (remove, status) = session_delete_feedback(
            "Old session",
            &SessionUpdateApplyOutcome::OutcomeUnknown("request timed out".to_string()),
        );
        assert!(!remove);
        assert!(status.contains("unknown outcome"));
        assert!(status.contains("closing"));
    }

    #[test]
    fn chat_session_delete_reuses_the_existing_async_session_slot() {
        let source = include_str!("sessions.rs").replace("\r\n", "\n");
        let delete = source
            .split_once("fn handle_session_delete(")
            .expect("delete handler")
            .1;

        assert!(delete.contains("rt_handle.spawn"));
        assert!(delete.contains("pending_session_operation = Some(PendingSessionOperation"));
        assert!(!delete.contains("block_in_place"));
        assert!(!source.contains("PendingSessionDelete"));
    }

    #[test]
    fn delegated_command_checks_session_state_before_materializing_a_worktree() {
        let source = include_str!("sessions.rs").replace("\r\n", "\n");
        let submission = source
            .split_once("fn send_external_subagent_command_to_agent(")
            .expect("delegated command submission")
            .1
            .split_once("fn send_draft_to_agent(")
            .expect("delegated command submission boundary")
            .0;

        let shared_guard = submission.find("if self.agent.is_shared()").unwrap();
        let pending_guard = submission.find("pending_session_operation").unwrap();
        let busy_guard = submission.find("if chat_state.is_processing").unwrap();
        let worktree_materialization = submission
            .find("self.materialize_requested_worktree")
            .unwrap();
        assert!(shared_guard < worktree_materialization);
        assert!(pending_guard < worktree_materialization);
        assert!(busy_guard < worktree_materialization);
        assert!(
            submission
                .matches("chat_view.set_draft(submitted_draft)")
                .count()
                >= 4
        );
    }

    #[test]
    fn workspace_diff_load_does_not_block_the_tui_event_loop() {
        let commands = include_str!("commands.rs").replace("\r\n", "\n");
        let handler = commands
            .split_once("ActionHandler::WorkspaceDiff => {")
            .expect("workspace diff handler")
            .1
            .split_once("ActionHandler::CompactSession => {")
            .expect("workspace diff handler boundary")
            .0;
        let run_loop = include_str!("run.rs").replace("\r\n", "\n");

        assert!(handler.contains("rt_handle.spawn"));
        assert!(handler.contains("pending_workspace_diff"));
        assert!(!handler.contains("block_in_place"));
        assert!(run_loop.contains("poll_workspace_diff"));
    }

    #[test]
    fn shared_workspace_diff_pending_state_serializes_runtime_actions_only() {
        use crate::actions::ActionHandler;
        use crate::modes::chat::pending_workspace_diff_blocks_runtime_action;

        assert!(pending_workspace_diff_blocks_runtime_action(
            true,
            true,
            ActionHandler::SubmitInput
        ));
        assert!(pending_workspace_diff_blocks_runtime_action(
            true,
            true,
            ActionHandler::SelectModel
        ));
        assert!(pending_workspace_diff_blocks_runtime_action(
            true,
            true,
            ActionHandler::NewSession
        ));
        assert!(!pending_workspace_diff_blocks_runtime_action(
            true,
            true,
            ActionHandler::SelectTheme
        ));
        assert!(!pending_workspace_diff_blocks_runtime_action(
            false,
            true,
            ActionHandler::SubmitInput
        ));
        assert!(!pending_workspace_diff_blocks_runtime_action(
            true,
            false,
            ActionHandler::SubmitInput
        ));
    }

    #[test]
    fn pending_session_operation_routes_commands_to_their_action_guards() {
        assert!(session_update_blocks_typed_submission(true, "continue"));
        assert!(!session_update_blocks_typed_submission(true, "/new"));
        assert!(!session_update_blocks_typed_submission(true, "/sessions"));
        assert!(!session_update_blocks_typed_submission(true, "/exit"));
        assert!(!session_update_blocks_typed_submission(false, "continue"));

        assert!(pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::Sessions,
        ));
        assert!(pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::Init,
        ));
        assert!(pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::RenameSession,
        ));
        assert!(!pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::Exit,
        ));
        assert!(!pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::OpenAgentSelector,
        ));
        assert!(!pending_session_operation_blocks_runtime_action(
            false,
            true,
            ActionHandler::Sessions,
        ));
        assert!(pending_session_operation_blocks_runtime_action(
            false,
            true,
            ActionHandler::UndoSession,
        ));
        assert!(pending_session_operation_blocks_runtime_action(
            true,
            true,
            ActionHandler::RedoSession,
        ));
        assert!(!pending_session_operation_blocks_runtime_action(
            true,
            false,
            ActionHandler::Sessions,
        ));
    }

    #[test]
    fn parameterized_slash_selection_prefills_the_native_command() {
        assert_eq!(
            selected_command_prefill(ActionHandler::RenameSession),
            Some("/rename ")
        );
        assert_eq!(selected_command_prefill(ActionHandler::Sessions), None);
    }

    #[test]
    fn explicit_native_selection_is_consumed_by_one_matching_submission() {
        let mut selected = Some("rename".to_string());
        assert!(consume_selected_native_command_once(
            &mut selected,
            "rename"
        ));
        assert!(selected.is_none());
        assert!(!consume_selected_native_command_once(
            &mut selected,
            "rename"
        ));

        let mut different = Some("rename".to_string());
        assert!(!consume_selected_native_command_once(
            &mut different,
            "help"
        ));
        assert!(different.is_none());
    }

    #[test]
    fn selected_native_command_choice_is_cleared_when_prefill_is_edited_away() {
        let mut selected = Some("rename".to_string());

        retain_selected_native_command_for_input(&mut selected, "/rename Auth refactor");
        assert_eq!(selected.as_deref(), Some("rename"));

        retain_selected_native_command_for_input(&mut selected, "/renam Auth refactor");
        assert!(selected.is_none());
    }

    #[test]
    fn selected_native_command_prefill_is_cleared_without_discarding_normal_drafts() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        view.set_input("/rename Release notes");
        let mut selected = Some("rename".to_string());

        clear_selected_native_command_prefill(&mut selected, &mut view);

        assert!(selected.is_none());
        assert!(view.input_text().is_empty());

        view.set_input("Keep this normal draft");
        clear_selected_native_command_prefill(&mut selected, &mut view);
        assert_eq!(view.input_text(), "Keep this normal draft");
    }

    #[test]
    fn every_new_slash_menu_selection_clears_the_pending_native_choice() {
        let mut selected = Some("rename".to_string());
        begin_slash_menu_selection(&mut selected, Some("external-command"));
        assert_eq!(selected, None);

        selected = Some("rename".to_string());
        begin_slash_menu_selection(&mut selected, Some("auto"));
        assert_eq!(selected, None);

        selected = Some("rename".to_string());
        begin_slash_menu_selection(&mut selected, None);
        assert_eq!(selected.as_deref(), Some("rename"));
    }

    #[test]
    fn session_command_help_comes_from_the_action_registry() {
        let help = session_command_help_note();
        let rename =
            crate::actions::action_for_alias("/rename", crate::actions::ActionContext::Chat)
                .expect("rename action");

        assert!(help.contains("Session Commands"));
        assert!(help.contains(rename.description));
        assert!(help.contains("/rename <name>"));
        assert!(help.contains("/timeline"));
        assert!(help.contains("/undo"));
        assert!(help.contains("/redo"));
    }

    #[test]
    fn shared_session_change_waits_for_the_current_session_update_result() {
        assert!(shared_session_change_is_blocked(true, true));
        assert!(!shared_session_change_is_blocked(true, false));
        assert!(!shared_session_change_is_blocked(false, true));
    }

    #[test]
    fn embedded_session_switch_waits_only_when_the_target_is_being_deleted() {
        let deleting = PendingSessionOperationKind::Delete {
            session_name: "Old session".to_string(),
        };
        let renaming = PendingSessionOperationKind::Rename {
            session_name: "New name".to_string(),
        };

        assert!(session_switch_targets_pending_delete(
            "session-b",
            Some(("session-b", &deleting)),
        ));
        assert!(!session_switch_targets_pending_delete(
            "session-a",
            Some(("session-b", &deleting)),
        ));
        assert!(!session_switch_targets_pending_delete(
            "session-b",
            Some(("session-b", &renaming)),
        ));
        assert!(!session_switch_targets_pending_delete("session-b", None));
    }

    #[test]
    fn shared_chat_status_describes_local_compatibility_management() {
        assert!(SHARED_TUI_CHAT_STATUS.contains("current Session Agent mode"));
        assert!(!SHARED_TUI_CHAT_STATUS.contains("current Session model"));
        assert!(SHARED_TUI_CHAT_STATUS.contains("current Session name"));
        assert!(SHARED_TUI_CHAT_STATUS.contains("/reload [skills|instructions]"));
        assert!(SHARED_TUI_CHAT_STATUS.contains("Model, Skill, Subagent, and MCP management"));
        assert!(SHARED_TUI_CHAT_STATUS.contains("local compatibility owner"));
        assert!(SHARED_TUI_CHAT_STATUS
            .contains("do not reconfigure an already-running Shared Runtime Host"));
        assert!(SHARED_TUI_CHAT_STATUS.contains("other management remain Embedded"));
    }

    #[test]
    fn failed_session_update_cancels_automatic_exit() {
        assert!(session_update_completion_should_exit(true, true));
        assert!(!session_update_completion_should_exit(true, false));
        assert!(!session_update_completion_should_exit(false, true));
    }

    #[test]
    fn session_updates_require_an_idle_session_and_one_pending_operation() {
        assert!(session_update_allowed(false, false));
        assert!(!session_update_allowed(true, false));
        assert!(!session_update_allowed(false, true));
    }

    #[test]
    fn shortcut_registry_contract_help_uses_resolved_keymap() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());

        let help = keymap.help_text(ActionState::chat(false, false));
        assert!(help.contains("Ctrl+P"));
        assert!(help.contains("Command Palette"));
    }
    fn external_agent_review_snapshot() -> ExternalSourceCatalogSnapshot {
        public_external_source_snapshot(serde_json::json!({
            "generation": 9,
            "discoveryPending": false,
            "sources": [],
            "commands": [],
            "subagentGeneration": 4,
            "preferenceRevision": 7,
            "subagents": [{
                "candidateId": "external_subagent:opencode:review:v1",
                "logicalId": "review",
                "displayName": "Review agent",
                "description": "Review a change",
                "providerLabel": "OpenCode",
                "scope": "project",
                "sourceKeys": [{
                    "providerId": "opencode.agents",
                    "sourceId": "project-review"
                }],
                "sourceLocationLabels": ["<workspace>/.opencode/agents/review.md"],
                "sourceCount": 1,
                "requestedModel": {
                    "kind": "reference",
                    "providerHint": "anthropic",
                    "modelName": "claude-sonnet-4"
                },
                "requestedModelProfile": { "kind": "named_variant", "name": "high" },
                "modelBindingMethod": "binding_required",
                "modelBindingKey": "external_subagent_model_binding:review",
                "effectiveModelLabel": "fast",
                "effectiveToolLabels": ["read", "search"],
                "supportsFollowUp": false,
                "compatibilityState": "ready",
                "diagnostics": [],
                "activationState": { "state": "approval_required" },
                "decisionKey": "decision-v1"
            }],
            "subagentModelBindingGroups": [{
                "bindingKey": "external_subagent_model_binding:review",
                "request": {
                    "kind": "reference",
                    "providerHint": "anthropic",
                    "modelName": "claude-sonnet-4"
                },
                "profileRequest": { "kind": "named_variant", "name": "high" },
                "scope": "project",
                "method": "binding_required",
                "affectedCandidateIds": [
                    "external_subagent:opencode:review:v1",
                    "external_subagent:claude:review:v1"
                ]
            }],
            "subagentModelBindingOptions": [{
                "target": { "kind": "primary" },
                "effectiveModelLabel": "GPT-5",
                "configuredReasoningEffort": "high"
            }, {
                "target": { "kind": "fast" },
                "effectiveModelLabel": "GLM-4.5-Air"
            }],
            "subagentConflicts": [{
                "conflictKey": "conflict-v1",
                "logicalId": "review",
                "candidates": [{
                    "candidateId": "openbitfun:review",
                    "displayName": "OpenBitFun review",
                    "sourceLabel": "OpenBitFun",
                    "external": false
                }, {
                    "candidateId": "external_subagent:opencode:review:v1",
                    "displayName": "Review agent",
                    "sourceLabel": "OpenCode",
                    "external": true
                }]
            }],
            "pendingSubagentApprovals": ["external_subagent:opencode:review:v1"]
        }))
    }

    #[test]
    fn external_agent_review_is_explicit_single_run_and_does_not_expose_prompt() {
        let summary = external_agent_review_text(Some(&external_agent_review_snapshot()));

        assert!(summary.contains("one run only; no follow-up"));
        assert!(summary.contains("Model: fast"));
        assert!(summary.contains("Requested model: anthropic/claude-sonnet-4"));
        assert!(summary.contains("Requested profile: named variant high"));
        assert!(summary.contains("configured effort: high"));
        assert!(summary.contains("Resolution: choose a OpenBitFun model"));
        assert!(summary.contains("Affects 2 agents"));
        assert!(summary.contains("/agent bind 1 2"));
        assert!(summary.contains("Tools: read, search"));
        assert!(summary.contains("/agent enable 1"));
        assert!(summary.contains("/agent choose 1 2"));
        assert!(summary.contains("/agent choose 1 0"));
        assert!(summary.contains("Runs on: this computer in the current workspace"));
        assert!(summary.contains("instructions guide the selected model"));
        assert!(summary.contains("may call the tools listed below"));
        assert!(summary.contains("asks again if the instructions, model, tools"));
        assert!(summary.contains("<workspace>/.opencode/agents/review.md"));
        assert!(summary.contains("This choice also confirms"));
        assert!(!summary.contains("D:/repo"));
        assert!(!summary.to_ascii_lowercase().contains("system prompt"));

        let mut unavailable = external_agent_review_snapshot();
        unavailable.subagents[0].effective_model_label = None;
        assert!(external_agent_review_text(Some(&unavailable)).contains("Model: unavailable"));

        let mut inherited = external_agent_review_snapshot();
        inherited.subagents[0].requested_model =
            openbitfun_product_domains::external_subagents::ExternalSubagentModelRequest::Inherit;
        inherited.subagents[0].model_binding_method =
            openbitfun_product_domains::external_subagents::ExternalSubagentModelBindingMethod::Inherit;
        inherited.subagents[0].model_binding_key = None;
        inherited.subagents[0].effective_model_label = None;
        let inherited_summary = external_agent_review_text(Some(&inherited));
        assert!(inherited_summary
            .contains("Model: resolved from the parent session when the task starts"));
        assert!(!inherited_summary.contains("Model: unavailable"));
    }

    #[test]
    fn opening_unified_management_does_not_imply_a_native_command_choice() {
        let tools = crate::actions::action_for_alias("/tools", crate::actions::ActionContext::Chat)
            .unwrap();
        let agents =
            crate::actions::action_for_alias("/agent", crate::actions::ActionContext::Chat)
                .unwrap();
        let help =
            crate::actions::action_for_alias("/help", crate::actions::ActionContext::Chat).unwrap();

        assert!(action_opens_extension_management(tools));
        assert!(action_opens_extension_management(agents));
        assert!(!action_opens_extension_management(help));
    }

    #[test]
    fn agent_management_behavior_change_invalidates_an_old_native_choice() {
        let candidate_id = "openbitfun.cli:switch_agent";
        let old_key = native_prompt_command_conflict_key(
            "local-user",
            "agents",
            [(candidate_id, "switch-mode-v1")],
        );
        let current_key = native_prompt_command_conflict_key(
            "local-user",
            "agent",
            [(
                candidate_id,
                action_conflict_behavior_version("switch_agent"),
            )],
        );

        assert_ne!(old_key, current_key);
    }

    #[test]
    fn external_agent_review_keeps_remembered_conflicts_visible_and_changeable() {
        let mut snapshot = external_agent_review_snapshot();
        snapshot.subagent_conflicts[0].selected_candidate_id =
            Some("external_subagent:opencode:review:v1".to_string());
        snapshot.pending_subagent_approvals.clear();

        let summary = external_agent_review_text(Some(&snapshot));
        assert!(summary.contains("Current choices"));
        assert!(
            summary.contains("Review agent (OpenCode, external) [selected, currently unavailable]")
        );
        assert!(summary.contains("OpenBitFun review (OpenBitFun, OpenBitFun/local) [not selected]"));
        assert!(summary.contains("/agent choose 1 1"));

        snapshot.subagents[0].activation_state = ExternalSubagentActivationState::Active;
        let active_summary = external_agent_review_text(Some(&snapshot));
        assert!(active_summary.contains("Review agent (OpenCode, external) [selected]"));
        assert!(!active_summary.contains("selected, currently unavailable"));

        assert_eq!(
            parse_external_agent_review_action("choose 1 1", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Choose {
                conflict_key: "conflict-v1".to_string(),
                candidate_id: "openbitfun:review".to_string(),
                approve_external: false,
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
        assert_eq!(external_agent_attention(None, &snapshot).conflicts, 0);
    }

    #[test]
    fn external_agent_model_settings_recovery_does_not_require_restart() {
        let lines = external_agent_diagnostic_lines(
            "external_subagent.configuration_unavailable",
            true,
            "",
        );
        let text = lines.join("\n");
        assert!(text.contains("check that OpenBitFun can read and save its settings, then refresh"));
        assert!(!text.to_ascii_lowercase().contains("restart"));
    }

    #[test]
    fn external_agent_review_shows_agent_storage_issues_only_on_the_agent_surface() {
        let mut snapshot = external_agent_review_snapshot();
        snapshot.diagnostics.push(ExternalSourceDiagnostic {
            severity: ExternalSourceDiagnosticSeverity::Warning,
            asset_kind: ExternalSourceAssetKind::Subagent,
            code: "external_subagent.conflict_history_write_failed".to_string(),
            message: "routes remain unavailable".to_string(),
            source: None,
        });
        snapshot.diagnostics.push(ExternalSourceDiagnostic {
            severity: ExternalSourceDiagnosticSeverity::Error,
            asset_kind: ExternalSourceAssetKind::Subagent,
            code: "future_host.agent_map_invalid".to_string(),
            message: "agent map is invalid".to_string(),
            source: None,
        });

        let agents = external_agent_review_text(Some(&snapshot));
        assert!(agents.contains("OpenBitFun could not save conflict information"));
        assert!(agents.contains("check OpenBitFun settings storage, then refresh"));
        assert!(agents.contains("external_subagent.conflict_history_write_failed"));
        assert!(agents.contains("future_host.agent_map_invalid"));

        let tools = external_tool_review_text(Some(&snapshot));
        assert!(!tools.contains("external_subagent.conflict_history_write_failed"));
        assert!(!tools.contains("future_host.agent_map_invalid"));
    }

    #[test]
    fn external_agent_review_actions_bind_generation_revision_and_stable_keys() {
        let snapshot = external_agent_review_snapshot();

        assert_eq!(
            parse_external_agent_review_action("enable 1", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Decide {
                candidate_id: "external_subagent:opencode:review:v1".to_string(),
                decision_key: "decision-v1".to_string(),
                approved: true,
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
        assert_eq!(
            parse_external_agent_review_action("bind 1 2", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Bind {
                binding_key: "external_subagent_model_binding:review".to_string(),
                target: Some(ExternalSubagentModelBindingTarget::Fast),
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
        assert_eq!(
            parse_external_agent_review_action("bind 1 0", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Bind {
                binding_key: "external_subagent_model_binding:review".to_string(),
                target: None,
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
        assert_eq!(
            parse_external_agent_review_action("choose 1 2", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Choose {
                conflict_key: "conflict-v1".to_string(),
                candidate_id: "external_subagent:opencode:review:v1".to_string(),
                approve_external: true,
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
        assert_eq!(
            parse_external_agent_review_action("choose 1 0", Some(&snapshot), None).unwrap(),
            ExternalAgentReviewAction::Choose {
                conflict_key: "conflict-v1".to_string(),
                candidate_id: "__openbitfun_disabled__".to_string(),
                approve_external: false,
                expected_subagent_generation: 4,
                expected_preference_revision: 7,
            }
        );
    }

    #[test]
    fn external_agent_freshness_ignores_unrelated_catalog_generation() {
        let current = external_agent_review_snapshot();
        let mut unrelated_update = current.clone();
        unrelated_update.generation += 1;

        assert!(!external_agent_result_is_stale(
            Some(&unrelated_update),
            &current
        ));

        let mut notice_only_update = unrelated_update.clone();
        notice_only_update.subagent_generation += 1;
        notice_only_update.preference_revision += 1;
        let notice_key = external_agent_pending_notice_key(None, &current);
        assert!(notice_key.is_some());
        assert_eq!(
            external_agent_pending_notice_key(None, &notice_only_update),
            notice_key
        );

        notice_only_update.subagents[0].decision_key = "agent-decision-v2".to_string();
        assert_ne!(
            external_agent_pending_notice_key(None, &notice_only_update),
            notice_key
        );
    }

    #[test]
    fn external_agent_attention_reports_active_agents_that_become_unavailable_or_disappear() {
        let mut previous = external_agent_review_snapshot();
        previous.pending_subagent_approvals.clear();
        previous.subagent_conflicts.clear();
        previous.subagents[0].activation_state = ExternalSubagentActivationState::Active;

        let mut blocked = previous.clone();
        blocked.subagent_generation += 1;
        blocked.subagents[0].activation_state = ExternalSubagentActivationState::Blocked;
        let blocked_attention = external_agent_attention(Some(&previous), &blocked);
        assert_eq!(blocked_attention.unavailable, 1);
        assert!(external_agent_pending_notice_key(Some(&previous), &blocked).is_some());

        let mut removed = previous.clone();
        removed.subagent_generation += 1;
        removed.subagents.clear();
        let removed_attention = external_agent_attention(Some(&previous), &removed);
        assert_eq!(removed_attention.unavailable, 1);
        assert!(external_agent_pending_notice_key(Some(&previous), &removed).is_some());
    }

    #[test]
    fn external_agent_attention_includes_only_agent_warning_and_error_diagnostics() {
        let mut snapshot = external_agent_review_snapshot();
        snapshot.pending_subagent_approvals.clear();
        snapshot.subagent_conflicts.clear();
        snapshot.diagnostics = vec![
            ExternalSourceDiagnostic {
                severity: ExternalSourceDiagnosticSeverity::Warning,
                asset_kind: ExternalSourceAssetKind::Subagent,
                code: "future_host.agent_map_invalid".to_string(),
                message: "agent map is invalid".to_string(),
                source: None,
            },
            ExternalSourceDiagnostic {
                severity: ExternalSourceDiagnosticSeverity::Warning,
                asset_kind: ExternalSourceAssetKind::Tool,
                code: "opencode.tool.directory_read_failed".to_string(),
                message: "tool directory is unavailable".to_string(),
                source: None,
            },
        ];

        let attention = external_agent_attention(None, &snapshot);
        assert_eq!(attention.diagnostics, 1);
        assert!(external_agent_pending_notice_key(None, &snapshot).is_some());
    }

    #[test]
    fn external_agent_result_preserves_newer_unrelated_catalog_partitions() {
        let result = external_agent_review_snapshot();
        let mut current = result.clone();
        current.generation += 1;
        current.commands.clear();
        current.tools.clear();

        let merged = merge_external_agent_mutation_snapshot(Some(&current), result.clone());

        assert_eq!(merged.generation, current.generation);
        assert!(merged.commands.is_empty());
        assert!(merged.tools.is_empty());
        assert_eq!(merged.subagents, result.subagents);
        assert_eq!(merged.subagent_conflicts, result.subagent_conflicts);
        assert_eq!(
            merged.pending_subagent_approvals,
            result.pending_subagent_approvals
        );
    }

    #[test]
    fn external_review_copy_classifies_unknown_locations_and_agent_diagnostics_safely() {
        assert_eq!(external_tool_run_location_label("custom-domain"), "unknown");

        let prompt =
            external_agent_diagnostic_lines("opencode_agent_prompt_not_imported", true, "")
                .join(" ");
        assert!(prompt.contains("does not support"));
        assert!(!prompt.contains("invalid or missing required value"));

        let default_permissions = external_agent_diagnostic_lines(
            "opencode_default_permission_semantics_not_imported",
            false,
            "",
        )
        .join(" ");
        assert!(default_permissions.contains("does not use this setting"));
        assert!(!default_permissions.contains("cannot be enabled"));

        let invalid =
            external_agent_diagnostic_lines("opencode_agent_definition_type_invalid", true, "")
                .join(" ");
        assert!(invalid.contains("invalid or missing required value"));

        let config = external_agent_diagnostic_lines(
            "external_subagent.configuration_unavailable",
            true,
            "",
        )
        .join(" ");
        assert!(config.contains("could not read its model settings"));
        assert!(config.contains("can read and save its settings"));
        assert!(!config.contains("requested model is not available"));
    }

    #[test]
    fn busy_chat_submission_steers_without_inventing_a_command_or_losing_the_draft() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let submission = source
            .split_once("fn submit_input(")
            .expect("submit input")
            .1
            .split_once("fn send_shell_command(")
            .expect("submit input boundary")
            .0;
        let steering = source
            .split_once("fn steer_draft_to_agent(")
            .expect("steering submission")
            .1
            .split_once("fn send_shell_command(")
            .expect("steering submission boundary")
            .0;

        assert!(submission.contains("if chat_state.is_processing"));
        assert!(submission.contains("steering_unsupported_reason"));
        assert!(submission.contains("self.steer_draft_to_agent"));
        assert!(!submission.contains("/steer"));
        assert!(steering.contains("agent.steer_current_turn"));
        assert!(steering.contains("chat_state.handle_user_steering"));
        assert!(steering.contains("chat_view.set_draft(draft)"));
    }

    #[test]
    fn active_turn_steering_accepts_text_and_rejects_rich_drafts() {
        let plain = crate::ui::composer::ComposerDraft::from_text("check tests");
        assert_eq!(steering_unsupported_reason(&plain), None);

        let mut referenced = plain.clone();
        referenced
            .workspace_references
            .push(openbitfun_runtime_ports::AgentWorkspaceReference {
                path: "src/lib.rs".to_string(),
                kind: openbitfun_runtime_ports::AgentWorkspaceReferenceKind::File,
                start_line: None,
                end_line: None,
                source: openbitfun_runtime_ports::AgentWorkspaceReferenceSourceRange {
                    start: 0,
                    end: 11,
                    value: "@src/lib.rs".to_string(),
                },
            });
        assert!(steering_unsupported_reason(&referenced)
            .expect("workspace reference rejection")
            .contains("Workspace references"));

        let mut imaged = plain;
        imaged
            .image_attachments
            .push(crate::ui::composer::ComposerImageAttachment {
                image: crate::ui::composer::ComposerImage::new(
                    "image-1",
                    "image.png",
                    "image/png",
                    std::sync::Arc::<[u8]>::from([1, 2, 3]),
                ),
                source: crate::ui::composer::ComposerSourceRange {
                    start: 0,
                    end: 9,
                    value: "[Image 1]".to_string(),
                },
            });
        assert!(steering_unsupported_reason(&imaged)
            .expect("image rejection")
            .contains("Images"));
    }
}
