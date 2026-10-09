//! Typed owner facts for user-facing OpenBitFun product controls.
//!
//! This registry is deliberately separate from the explanatory capability
//! overlay. Config paths, command handlers, value schemas, risk, and argument
//! scope are executable product facts and therefore live in compiled Rust.
//! The capability generator exports this registry and joins it with titles,
//! search terms, tutorials, and other presentation-only metadata.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::product_control::{
    ProductCapabilityOperationHandler, ProductCapabilityOptionHandler, ProductControlArgumentScope,
    ProductControlRisk, ProductControlValueSchema, ProductControlValueType,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductControlOwnerDefinition {
    Option {
        capability_id: String,
        option_id: String,
        value_schema: ProductControlValueSchema,
        handler: ProductCapabilityOptionHandler,
    },
    Operation {
        capability_id: String,
        operation_id: String,
        risk: ProductControlRisk,
        input_schema: Value,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        argument_scopes: BTreeMap<String, ProductControlArgumentScope>,
        handler: ProductCapabilityOperationHandler,
    },
}

fn schema(value_type: ProductControlValueType) -> ProductControlValueSchema {
    ProductControlValueSchema {
        value_type,
        nullable: false,
        r#enum: None,
        minimum: None,
        maximum: None,
        min_length: None,
        max_length: None,
    }
}

fn boolean() -> ProductControlValueSchema {
    schema(ProductControlValueType::Boolean)
}

fn string() -> ProductControlValueSchema {
    schema(ProductControlValueType::String)
}

fn string_enum(values: &[&str]) -> ProductControlValueSchema {
    ProductControlValueSchema {
        r#enum: Some(
            values
                .iter()
                .map(|value| Value::String((*value).to_string()))
                .collect(),
        ),
        ..string()
    }
}

fn string_length(minimum: usize, maximum: usize) -> ProductControlValueSchema {
    ProductControlValueSchema {
        min_length: Some(minimum),
        max_length: Some(maximum),
        ..string()
    }
}

fn integer_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        minimum: Some(minimum),
        maximum: Some(maximum),
        ..schema(ProductControlValueType::Integer)
    }
}

fn nullable_integer_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        nullable: true,
        ..integer_range(minimum, maximum)
    }
}

fn number_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        minimum: Some(minimum),
        maximum: Some(maximum),
        ..schema(ProductControlValueType::Number)
    }
}

fn option(
    capability_id: &str,
    option_id: &str,
    value_schema: ProductControlValueSchema,
    handler: ProductCapabilityOptionHandler,
) -> ProductControlOwnerDefinition {
    ProductControlOwnerDefinition::Option {
        capability_id: capability_id.to_string(),
        option_id: option_id.to_string(),
        value_schema,
        handler,
    }
}

fn config(path: &str) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::Config {
        path: path.to_string(),
    }
}

fn merge_config(path: &str, fields: &[&str]) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::MergeConfig {
        path: path.to_string(),
        fields: fields.iter().map(|field| (*field).to_string()).collect(),
    }
}

fn provider(provider_id: &str, option_id: &str) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::Provider {
        provider_id: provider_id.to_string(),
        option_id: option_id.to_string(),
    }
}

fn operation(
    capability_id: &str,
    operation_id: &str,
    risk: ProductControlRisk,
    input_schema: Value,
    argument_scopes: &[(&str, ProductControlArgumentScope)],
    handler: ProductCapabilityOperationHandler,
) -> ProductControlOwnerDefinition {
    ProductControlOwnerDefinition::Operation {
        capability_id: capability_id.to_string(),
        operation_id: operation_id.to_string(),
        risk,
        input_schema,
        argument_scopes: argument_scopes
            .iter()
            .map(|(name, scope)| ((*name).to_string(), *scope))
            .collect(),
        handler,
    }
}

fn product_action(action_id: &str) -> ProductCapabilityOperationHandler {
    ProductCapabilityOperationHandler::ProductAction {
        action_id: action_id.to_string(),
    }
}

fn operation_provider(provider_id: &str, operation_id: &str) -> ProductCapabilityOperationHandler {
    ProductCapabilityOperationHandler::Provider {
        provider_id: provider_id.to_string(),
        operation_id: operation_id.to_string(),
    }
}

fn empty_input() -> Value {
    json!({ "type": "object", "additionalProperties": false })
}

fn miniapp_input(action: &str) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if action != "list" && action != "create" {
        properties.insert("appId".into(), json!({ "type": "string", "minLength": 1 }));
        required.push("appId");
    }
    if matches!(action, "update" | "delete") {
        properties.insert(
            "expectedVersion".into(),
            json!({ "type": "integer", "minimum": 1 }),
        );
    }
    if matches!(action, "create" | "update") {
        for field in [
            "name",
            "description",
            "icon",
            "category",
            "html",
            "css",
            "uiJs",
            "workerJs",
        ] {
            properties.insert(
                field.into(),
                if field == "name" {
                    json!({ "type": "string", "minLength": 1 })
                } else {
                    json!({ "type": "string" })
                },
            );
        }
        properties.insert(
            "tags".into(),
            json!({ "type": "array", "items": { "type": "string" } }),
        );
        properties.insert("permissions".into(), json!({ "type": "object" }));
        properties.insert("esmDependencies".into(), json!({ "type": "array", "items": {
            "type": "object", "required": ["name"], "additionalProperties": false,
            "properties": { "name": { "type": "string" }, "version": { "type": "string" }, "url": { "type": "string" } }
        } }));
        properties.insert(
            "npmDependencies".into(),
            json!({ "type": "array", "items": {
            "type": "object", "required": ["name", "version"], "additionalProperties": false,
            "properties": { "name": { "type": "string" }, "version": { "type": "string" } }
        } }),
        );
        if action == "create" {
            required.push("name");
        }
    }
    json!({ "type": "object", "additionalProperties": false, "properties": properties, "required": required })
}

/// Return the complete compiled registry of executable product-control facts.
///
/// Every public option and operation must appear exactly once. Structural
/// generation gates reject both missing explanatory overlays and stale owner
/// definitions, so adding a setting or command cannot silently disappear from
/// Agent discovery, global search, or the Playbook.
pub fn owner_definitions() -> Vec<ProductControlOwnerDefinition> {
    use ProductCapabilityOptionHandler::{
        AppearanceSelection, FlowChatPermissionModeControl, Language,
    };
    use ProductControlArgumentScope::ProductHostLocal;
    use ProductControlRisk::{Destructive, Read, Ui, Write};

    vec![
        operation(
            "feature.miniapps",
            "list-apps",
            Read,
            miniapp_input("list"),
            &[],
            operation_provider("miniapp", "list"),
        ),
        operation(
            "feature.miniapps",
            "inspect-app",
            Read,
            miniapp_input("inspect"),
            &[],
            operation_provider("miniapp", "inspect"),
        ),
        operation(
            "feature.miniapps",
            "create-app",
            Write,
            miniapp_input("create"),
            &[],
            operation_provider("miniapp", "create"),
        ),
        operation(
            "feature.miniapps",
            "update-app",
            Write,
            miniapp_input("update"),
            &[],
            operation_provider("miniapp", "update"),
        ),
        operation(
            "feature.miniapps",
            "delete-app",
            Destructive,
            miniapp_input("delete"),
            &[],
            operation_provider("miniapp", "delete"),
        ),
        operation(
            "feature.ai-assistant",
            "new-session",
            Ui,
            empty_input(),
            &[],
            product_action("session.new"),
        ),
        operation(
            "feature.projects",
            "open-project",
            Ui,
            empty_input(),
            &[],
            product_action("project.open"),
        ),
        operation(
            "feature.projects",
            "new-project",
            Ui,
            empty_input(),
            &[],
            product_action("project.new"),
        ),
        operation(
            "feature.terminal",
            "new-terminal",
            Ui,
            empty_input(),
            &[],
            product_action("surface.terminal.open"),
        ),
        option(
            "setting.application.general",
            "launch-at-login",
            boolean(),
            provider("desktop-lifecycle", "launch-at-login"),
        ),
        option(
            "setting.application.general",
            "prevent-sleep",
            boolean(),
            provider("desktop-lifecycle", "prevent-sleep"),
        ),
        option(
            "setting.application.general",
            "auto-update",
            boolean(),
            config("app.auto_update"),
        ),
        option(
            "setting.application.general",
            "close-button-behavior",
            string_enum(&["ask", "minimize_to_tray", "quit"]),
            config("app.close_button_behavior"),
        ),
        option(
            "setting.application.general",
            "completion-notification",
            boolean(),
            config("app.notifications.dialog_completion_notify"),
        ),
        option(
            "setting.application.general",
            "permission-notification",
            boolean(),
            config("app.notifications.permission_request_notify"),
        ),
        option(
            "setting.application.general",
            "startup-tips",
            boolean(),
            config("app.notifications.enable_startup_tips"),
        ),
        option(
            "setting.application.appearance",
            "theme",
            string(),
            AppearanceSelection,
        ),
        option(
            "setting.application.appearance",
            "language",
            string(),
            Language,
        ),
        option(
            "setting.application.pet",
            "enabled",
            boolean(),
            merge_config("app.ai_experience", &["enable_agent_companion"]),
        ),
        operation(
            "setting.application.pet",
            "list-pets",
            Read,
            empty_input(),
            &[],
            operation_provider("agent-companion-pet", "list"),
        ),
        operation(
            "setting.application.pet",
            "use-pet",
            Write,
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "path": { "type": "string", "minLength": 1, "description": "Local Petdex directory or archive path." },
                    "id": { "type": "string", "minLength": 1, "description": "Already imported pet ID." }
                },
                "anyOf": [{ "required": ["path"] }, { "required": ["id"] }]
            }),
            &[("path", ProductHostLocal)],
            operation_provider("agent-companion-pet", "use"),
        ),
        operation(
            "setting.application.pet",
            "delete-pet",
            Destructive,
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string", "minLength": 1, "description": "Imported pet ID." },
                    "packagePath": { "type": "string", "minLength": 1, "description": "Imported OpenBitFun pet-package directory." }
                },
                "anyOf": [{ "required": ["id"] }, { "required": ["packagePath"] }]
            }),
            &[("packagePath", ProductHostLocal)],
            operation_provider("agent-companion-pet", "delete"),
        ),
        option(
            "setting.application.input",
            "voice-enabled",
            boolean(),
            merge_config("app.ai_experience", &["voice_input.enabled"]),
        ),
        option(
            "setting.application.input",
            "auto-show-selection-toolbar",
            boolean(),
            config("app.flow_chat.auto_show_selection_toolbar"),
        ),
        option(
            "setting.application.input",
            "voice-language",
            string_enum(&["auto", "zh", "en", "ja", "yue"]),
            merge_config("app.ai_experience", &["voice_input.default_language"]),
        ),
        option(
            "setting.application.input",
            "max-recording-seconds",
            integer_range(10.0, 600.0),
            merge_config("app.ai_experience", &["voice_input.max_recording_seconds"]),
        ),
        option(
            "setting.application.terminal",
            "terminal-default-shell",
            string(),
            config("terminal.default_shell"),
        ),
        option(
            "setting.application.terminal",
            "terminal-panel-position",
            string_enum(&["right", "bottom"]),
            config("terminal.terminal_panel_position"),
        ),
        option(
            "setting.application.development",
            "editor-font-family",
            string(),
            config("editor.font_family"),
        ),
        option(
            "setting.application.development",
            "editor-font-weight",
            string_enum(&["normal", "bold"]),
            config("editor.font_weight"),
        ),
        option(
            "setting.application.development",
            "editor-font-size",
            integer_range(10.0, 32.0),
            config("editor.font_size"),
        ),
        option(
            "setting.application.development",
            "editor-line-height",
            number_range(1.0, 3.0),
            config("editor.line_height"),
        ),
        option(
            "setting.application.development",
            "editor-cursor-style",
            string_enum(&[
                "line",
                "line-thin",
                "block",
                "block-outline",
                "underline",
                "underline-thin",
            ]),
            config("editor.cursor_style"),
        ),
        option(
            "setting.application.development",
            "editor-cursor-blinking",
            string_enum(&["blink", "smooth", "phase", "expand", "solid"]),
            config("editor.cursor_blinking"),
        ),
        option(
            "setting.application.development",
            "editor-tab-size",
            integer_range(1.0, 8.0),
            config("editor.tab_size"),
        ),
        option(
            "setting.application.development",
            "editor-insert-spaces",
            boolean(),
            config("editor.insert_spaces"),
        ),
        option(
            "setting.application.development",
            "editor-detect-indentation",
            boolean(),
            config("editor.detect_indentation"),
        ),
        option(
            "setting.application.development",
            "editor-word-wrap",
            string_enum(&["off", "on", "wordWrapColumn", "bounded"]),
            config("editor.word_wrap"),
        ),
        option(
            "setting.application.development",
            "editor-line-numbers",
            string_enum(&["on", "off", "relative", "interval"]),
            config("editor.line_numbers"),
        ),
        option(
            "setting.application.development",
            "editor-smooth-scrolling",
            boolean(),
            config("editor.smooth_scrolling"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-enabled",
            boolean(),
            config("editor.minimap.enabled"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-side",
            string_enum(&["left", "right"]),
            config("editor.minimap.side"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-size",
            string_enum(&["proportional", "fill", "fit"]),
            config("editor.minimap.size"),
        ),
        option(
            "setting.application.development",
            "editor-render-whitespace",
            string_enum(&["none", "boundary", "selection", "trailing", "all"]),
            config("editor.render_whitespace"),
        ),
        option(
            "setting.application.development",
            "editor-render-line-highlight",
            string_enum(&["none", "gutter", "line", "all"]),
            config("editor.render_line_highlight"),
        ),
        option(
            "setting.application.development",
            "editor-scroll-beyond-last-line",
            boolean(),
            config("editor.scroll_beyond_last_line"),
        ),
        option(
            "setting.application.development",
            "editor-auto-save",
            string_enum(&["off", "afterDelay", "onFocusChange", "onWindowChange"]),
            config("editor.auto_save"),
        ),
        option(
            "setting.application.development",
            "editor-auto-save-delay",
            integer_range(100.0, 60_000.0),
            config("editor.auto_save_delay"),
        ),
        option(
            "setting.application.development",
            "editor-semantic-highlighting",
            boolean(),
            config("editor.semantic_highlighting"),
        ),
        option(
            "setting.application.development",
            "editor-bracket-pair-colorization",
            boolean(),
            config("editor.bracket_pair_colorization"),
        ),
        option(
            "setting.application.development",
            "editor-format-on-save",
            boolean(),
            config("editor.format_on_save"),
        ),
        option(
            "setting.application.development",
            "editor-format-on-paste",
            boolean(),
            config("editor.format_on_paste"),
        ),
        option(
            "setting.application.development",
            "editor-trim-auto-whitespace",
            boolean(),
            config("editor.trim_auto_whitespace"),
        ),
        option(
            "setting.ai.models",
            "stream-ttft-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.stream_ttft_timeout_secs"),
        ),
        option(
            "setting.ai.models",
            "stream-idle-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.stream_idle_timeout_secs"),
        ),
        option(
            "setting.ai.memory",
            "enabled",
            boolean(),
            merge_config("memories", &["generate_memories", "use_memories"]),
        ),
        option(
            "setting.ai.memory",
            "btw-sessions",
            boolean(),
            merge_config("memories", &["generate_for_btw_sessions"]),
        ),
        option(
            "setting.ai.memory",
            "external-context-policy",
            string_enum(&["clear_tool_results", "allow", "skip_session"]),
            merge_config("memories", &["external_context_policy"]),
        ),
        option(
            "setting.ai.memory",
            "minimum-rollout-idle-hours",
            integer_range(1.0, 48.0),
            merge_config("memories", &["min_rollout_idle_hours"]),
        ),
        option(
            "setting.ai.memory",
            "maximum-rollout-age-days",
            integer_range(0.0, 90.0),
            merge_config("memories", &["max_rollout_age_days"]),
        ),
        option(
            "setting.ai.memory",
            "startup-rollout-limit",
            integer_range(1.0, 128.0),
            merge_config("memories", &["max_rollouts_per_startup"]),
        ),
        option(
            "setting.ai.memory",
            "startup-rollout-scan-limit",
            integer_range(1.0, 50_000.0),
            merge_config("memories", &["max_rollouts_scan_limit"]),
        ),
        option(
            "setting.ai.memory",
            "extraction-concurrency",
            integer_range(1.0, 16.0),
            merge_config("memories", &["phase1_max_concurrency"]),
        ),
        option(
            "setting.ai.memory",
            "raw-memory-limit",
            integer_range(1.0, 4096.0),
            merge_config("memories", &["max_raw_memories_for_consolidation"]),
        ),
        option(
            "setting.ai.memory",
            "memory-retention-days",
            integer_range(0.0, 365.0),
            merge_config("memories", &["max_unused_days"]),
        ),
        option(
            "setting.workspace.session",
            "session-title-generation",
            boolean(),
            merge_config("app.ai_experience", &["enable_session_title_generation"]),
        ),
        option(
            "setting.workspace.session",
            "workspace-search",
            boolean(),
            merge_config("app.ai_experience", &["enable_workspace_search"]),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-root-path",
            string_length(1, 4096),
            config("app.worktrees.rootPath"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-branch-prefix",
            string_length(1, 200),
            config("app.worktrees.branchPrefix"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-copy-local-changes",
            boolean(),
            config("app.worktrees.copyLocalChanges"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-auto-delete-enabled",
            boolean(),
            config("app.worktrees.autoDeleteEnabled"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-auto-delete-limit",
            integer_range(1.0, 100.0),
            config("app.worktrees.autoDeleteLimit"),
        ),
        option(
            "setting.tools.execution",
            "show-permission-mode-control",
            boolean(),
            FlowChatPermissionModeControl,
        ),
        option(
            "setting.tools.execution",
            "deferred-tool-loading",
            boolean(),
            config("ai.enable_deferred_tool_loading"),
        ),
        option(
            "setting.tools.execution",
            "subagent-batch-policy",
            string_enum(&["safe_only", "force_parallel", "serial"]),
            config("ai.subagent_batch_execution_policy"),
        ),
        option(
            "setting.tools.execution",
            "subagent-max-concurrency",
            integer_range(1.0, 32.0),
            config("ai.subagent_max_concurrency"),
        ),
        option(
            "setting.tools.execution",
            "swarm-max-concurrency",
            integer_range(1.0, 64.0),
            config("ai.swarm_max_concurrency"),
        ),
        option(
            "setting.tools.execution",
            "tool-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.tool_execution_timeout_secs"),
        ),
        option(
            "setting.tools.execution",
            "computer-use-enabled",
            boolean(),
            config("ai.computer_use_enabled"),
        ),
        option(
            "setting.tools.execution",
            "browser-auto-connect",
            boolean(),
            config("ai.browser_control_auto_connect_on_startup"),
        ),
        option(
            "setting.tools.execution",
            "tool-json-repair",
            boolean(),
            config("ai.allow_tool_json_repair"),
        ),
        option(
            "setting.tools.automation",
            "hooks-enabled",
            boolean(),
            merge_config("app.hooks", &["enabled"]),
        ),
        option(
            "setting.tools.automation",
            "project-hooks-enabled",
            boolean(),
            merge_config("app.hooks", &["project_hooks_enabled"]),
        ),
        option(
            "setting.data.diagnostics",
            "log-level",
            string_enum(&["error", "warn", "info", "debug", "trace"]),
            config("app.logging.level"),
        ),
        option(
            "setting.data.diagnostics",
            "sensitive-diagnostics",
            boolean(),
            config("app.logging.include_sensitive_diagnostics"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn owner_definition_ids_are_unique() {
        let mut ids = BTreeSet::new();
        for definition in owner_definitions() {
            let id = match definition {
                ProductControlOwnerDefinition::Option {
                    capability_id,
                    option_id,
                    ..
                } => format!("{capability_id}:option:{option_id}"),
                ProductControlOwnerDefinition::Operation {
                    capability_id,
                    operation_id,
                    ..
                } => format!("{capability_id}:operation:{operation_id}"),
            };
            assert!(ids.insert(id.clone()), "duplicate owner definition: {id}");
        }
    }
}
