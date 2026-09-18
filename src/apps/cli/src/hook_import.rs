use anyhow::{anyhow, Result};
use clap::{Subcommand, ValueEnum};
use openbitfun_product_domains::external_hook_import::{
    ExternalHookImportApplyRequestV1, ExternalHookImportDependencyV1,
    ExternalHookImportMutationRequestV1, ExternalHookImportMutationV1, ExternalHookImportPlanV1,
    ExternalHookImportSnapshotV1, EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
};
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourceScope, SourceKey,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum HookImportOutputFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum HookImportResetScope {
    User,
    Project,
}

#[derive(Subcommand)]
pub(crate) enum HookAction {
    /// List available and imported Hook sources
    List {
        /// Re-read source files and check imported sources for updates
        #[arg(long)]
        refresh: bool,
        /// Output format for automation
        #[arg(long, value_enum, default_value_t = HookImportOutputFormat::Text)]
        format: HookImportOutputFormat,
    },
    /// Preview or confirm importing one Hook source
    Import {
        /// Stable source key shown by `openbitfun hooks list`
        #[arg(long)]
        source: String,
        /// Confirm the exact plan fingerprint shown by the preview
        #[arg(long, value_name = "PLAN_FINGERPRINT")]
        confirm: Option<String>,
        /// Output format for automation
        #[arg(long, value_enum, default_value_t = HookImportOutputFormat::Text)]
        format: HookImportOutputFormat,
    },
    /// Preview or confirm updating one imported Hook source
    Update {
        import_id: String,
        /// Confirm the exact plan fingerprint shown by the preview
        #[arg(long, value_name = "PLAN_FINGERPRINT")]
        confirm: Option<String>,
        /// Output format for automation
        #[arg(long, value_enum, default_value_t = HookImportOutputFormat::Text)]
        format: HookImportOutputFormat,
    },
    /// Enable one imported Hook source
    Enable { import_id: String },
    /// Disable one imported Hook source without deleting it
    Disable { import_id: String },
    /// Remove only OpenBitFun's managed copy of one imported Hook source
    Remove {
        import_id: String,
        /// Confirm removal of the OpenBitFun-managed copy
        #[arg(long, required = true)]
        confirm: bool,
    },
    /// Reset a corrupt OpenBitFun-managed Hook index without changing source files
    Reset {
        #[arg(value_enum)]
        scope: HookImportResetScope,
        /// Confirm deletion of the corrupt managed index
        #[arg(long, required = true)]
        confirm: bool,
    },
}

pub(crate) async fn run(action: Option<HookAction>) -> Result<()> {
    let workspace = Some(
        crate::create_cli_local_workspace(&std::env::current_dir()?)
            .await?
            .id,
    );
    match action.unwrap_or(HookAction::List {
        refresh: false,
        format: HookImportOutputFormat::Text,
    }) {
        HookAction::List { refresh, format } => {
            let snapshot = openbitfun_core::external_hook_import::external_hook_import_snapshot(
                workspace.as_deref(),
                refresh,
            )
            .await
            .map_err(operation_error)?;
            print_value(format, &snapshot, render_snapshot(&snapshot))
        }
        HookAction::Import {
            source,
            confirm,
            format,
        } => {
            let source = SourceKey::from_stable_key(&source)
                .ok_or_else(|| anyhow!("Invalid Hook source key: {}", escape(&source)))?;
            preview_or_apply(workspace.as_deref(), source, confirm, format).await
        }
        HookAction::Update {
            import_id,
            confirm,
            format,
        } => {
            let snapshot = openbitfun_core::external_hook_import::external_hook_import_snapshot(
                workspace.as_deref(),
                false,
            )
            .await
            .map_err(operation_error)?;
            let source = snapshot
                .imports
                .iter()
                .find(|item| item.import_id == import_id)
                .map(|item| item.source.key.clone())
                .ok_or_else(|| anyhow!("Hook import not found: {}", escape(&import_id)))?;
            preview_or_apply(workspace.as_deref(), source, confirm, format).await
        }
        HookAction::Enable { import_id } => {
            mutate(
                workspace.as_deref(),
                ExternalHookImportMutationV1::SetEnabled {
                    import_id: import_id.clone(),
                    enabled: true,
                },
            )
            .await
            .map_err(operation_error)?;
            println!("Enabled imported Hooks: {}", escape(&import_id));
            Ok(())
        }
        HookAction::Disable { import_id } => {
            mutate(
                workspace.as_deref(),
                ExternalHookImportMutationV1::SetEnabled {
                    import_id: import_id.clone(),
                    enabled: false,
                },
            )
            .await
            .map_err(operation_error)?;
            println!("Disabled imported Hooks: {}", escape(&import_id));
            Ok(())
        }
        HookAction::Remove { import_id, .. } => {
            mutate(
                workspace.as_deref(),
                ExternalHookImportMutationV1::Remove {
                    import_id: import_id.clone(),
                },
            )
            .await
            .map_err(operation_error)?;
            println!(
                "Removed OpenBitFun's managed Hook copy; the source was not changed: {}",
                escape(&import_id)
            );
            Ok(())
        }
        HookAction::Reset { scope, .. } => {
            let scope = match scope {
                HookImportResetScope::User => ExternalSourceScope::UserGlobal,
                HookImportResetScope::Project => ExternalSourceScope::Project,
            };
            mutate(
                workspace.as_deref(),
                ExternalHookImportMutationV1::ResetCorruptStore { scope },
            )
            .await
            .map_err(operation_error)?;
            println!(
                "Reset the corrupt {:?} managed Hook index; source files were not changed.",
                scope
            );
            Ok(())
        }
    }
}

async fn preview_or_apply(
    workspace: Option<&str>,
    source: SourceKey,
    confirm: Option<String>,
    format: HookImportOutputFormat,
) -> Result<()> {
    let plan =
        openbitfun_core::external_hook_import::plan_external_hook_import(workspace, source.clone())
            .await
            .map_err(operation_error)?;
    let Some(plan_fingerprint) = confirm else {
        return print_value(format, &plan, render_plan(&plan));
    };
    let result = openbitfun_core::external_hook_import::apply_external_hook_import(
        workspace,
        ExternalHookImportApplyRequestV1 {
            schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
            source: source.clone(),
            plan_fingerprint,
        },
    )
    .await
    .map_err(operation_error)?;
    let text = match &result.outcome {
        openbitfun_product_domains::external_hook_import::ExternalHookImportApplyOutcomeV1::Applied {
            snapshot,
        } => completed_import_status(snapshot, &source, true).to_string(),
        openbitfun_product_domains::external_hook_import::ExternalHookImportApplyOutcomeV1::Unchanged {
            snapshot,
        } => completed_import_status(snapshot, &source, false).to_string(),
        openbitfun_product_domains::external_hook_import::ExternalHookImportApplyOutcomeV1::Stale {
            refreshed_plan,
        } => format!(
            "The Hook source changed; nothing was written. Review the refreshed plan:\n{}",
            render_plan(refreshed_plan)
        ),
    };
    print_value(format, &result, text)
}

pub(crate) fn completed_import_status(
    snapshot: &ExternalHookImportSnapshotV1,
    source: &SourceKey,
    applied: bool,
) -> &'static str {
    let enabled = snapshot
        .imports
        .iter()
        .find(|item| item.source.key == *source)
        .map(|item| item.enabled);
    match (applied, enabled) {
        (true, Some(true)) => {
            "Imported Hooks are enabled. The main Hook switch still controls whether they run."
        }
        (true, Some(false)) => "Imported Hooks were updated and remain disabled.",
        (false, Some(true)) => {
            "The reviewed Hook import is current and enabled. The main Hook switch still controls whether it runs."
        }
        (false, Some(false)) => "The reviewed Hook import is already current and remains disabled.",
        (_, None) => "Hook import completed; refresh the Hook list to verify its current state.",
    }
}

pub(crate) async fn mutate(
    workspace: Option<&str>,
    action: ExternalHookImportMutationV1,
) -> std::result::Result<ExternalHookImportSnapshotV1, ExternalSourceOperationError> {
    let snapshot =
        openbitfun_core::external_hook_import::external_hook_import_snapshot(workspace, false)
            .await?;
    openbitfun_core::external_hook_import::mutate_external_hook_import(
        workspace,
        ExternalHookImportMutationRequestV1 {
            schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
            expected_revision: snapshot.revision,
            action,
        },
    )
    .await
}

fn render_snapshot(snapshot: &ExternalHookImportSnapshotV1) -> String {
    let mut lines = vec![format!(
        "Available Hook sources ({}):",
        snapshot.catalog.sources.len()
    )];
    for source in &snapshot.catalog.sources {
        lines.push(format!(
            "- {} [{}] ({:?}, {:?})",
            escape(&source.display_name),
            escape(&source.key.stable_key()),
            source.scope,
            source.health
        ));
    }
    lines.push(format!(
        "Imported Hook sources ({}):",
        snapshot.imports.len()
    ));
    for imported in &snapshot.imports {
        lines.push(format!(
            "- {} [{}] enabled={} state={:?}",
            escape(&imported.source.display_name),
            escape(&imported.import_id),
            imported.enabled,
            imported.state
        ));
    }
    for diagnostic in &snapshot.diagnostics {
        lines.push(format!(
            "- diagnostic {}: {}",
            escape(&diagnostic.code),
            escape(&diagnostic.message)
        ));
    }
    lines.join("\n")
}

fn render_plan_lines(plan: &ExternalHookImportPlanV1) -> Vec<String> {
    let mut lines = vec![format!(
        "Hook import {:?}: {} handler(s) from {}",
        plan.disposition,
        plan.handlers.len(),
        escape(&plan.source.display_name)
    )];
    for handler in &plan.handlers {
        lines.push(format!(
            "- {} event={} matcher={} timeout={}s",
            escape(&handler.stable_key),
            escape(&handler.event),
            handler
                .matcher
                .as_deref()
                .map(escape)
                .unwrap_or_else(|| "*".to_string()),
            handler.timeout_seconds.unwrap_or(60)
        ));
        lines.push(format!("  command: {}", escape(&handler.command)));
        if let Some(command) = &handler.command_windows {
            lines.push(format!("  commandWindows: {}", escape(command)));
        }
        for dependency in &handler.dependencies {
            let (kind, value) = match dependency {
                ExternalHookImportDependencyV1::Managed { relative_path } => {
                    ("managed", relative_path)
                }
                ExternalHookImportDependencyV1::External { location } => ("external", location),
            };
            lines.push(format!("  dependency ({kind}): {}", escape(value)));
        }
    }
    for skipped in &plan.skipped {
        lines.push(format!(
            "- skipped {}: {}",
            escape(&skipped.reason_code),
            skipped.count
        ));
    }
    lines
}

pub(crate) fn render_plan(plan: &ExternalHookImportPlanV1) -> String {
    let mut lines = render_plan_lines(plan);
    lines.push(format!(
        "Plan fingerprint: {}",
        escape(&plan.plan_fingerprint)
    ));
    lines.push("Preview only until this exact fingerprint is passed with --confirm.".to_string());
    lines.join("\n")
}

pub(crate) fn render_plan_for_tui(plan: &ExternalHookImportPlanV1) -> String {
    let mut lines = render_plan_lines(plan);
    lines.push(
        "Preview only; repeat the same import/update command with --confirm after review."
            .to_string(),
    );
    lines.join("\n")
}

fn print_value(format: HookImportOutputFormat, value: &impl Serialize, text: String) -> Result<()> {
    match format {
        HookImportOutputFormat::Text => println!("{text}"),
        HookImportOutputFormat::Json => println!("{}", serde_json::to_string(value)?),
    }
    Ok(())
}

fn operation_error(error: ExternalSourceOperationError) -> anyhow::Error {
    anyhow!("{}: {}", error.code.as_str(), escape(&error.detail))
}

fn escape(value: &str) -> String {
    crate::plugin_diagnostics::escape_terminal_text(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::external_hook_catalog::{
        ExternalHookCatalogSnapshotV1, ExternalHookSource, ExternalHookSourceKind,
    };
    use openbitfun_product_domains::external_hook_import::{
        ExternalHookImportDispositionV1, ImportedHookSourceSnapshotV1, ImportedHookSourceStateV1,
    };
    use openbitfun_product_domains::external_sources::{
        EcosystemId, ExternalSourceHealth, ExternalSourceScope,
    };

    fn disabled_snapshot() -> (SourceKey, ExternalHookImportSnapshotV1) {
        let source_key = SourceKey::new("claude", "user-hooks").unwrap();
        let source = ExternalHookSource {
            key: source_key.clone(),
            ecosystem_id: EcosystemId::new("claude-code").unwrap(),
            display_name: "Claude Code user Hooks".to_string(),
            source_kind: ExternalHookSourceKind::Settings,
            scope: ExternalSourceScope::UserGlobal,
            location_hint: "user settings".to_string(),
            health: ExternalSourceHealth::Available,
            content_version: "sha256:source".to_string(),
            diagnostics: Vec::new(),
        };
        (
            source_key,
            ExternalHookImportSnapshotV1 {
                schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
                revision: "sha256:revision".to_string(),
                catalog: ExternalHookCatalogSnapshotV1::default(),
                imports: vec![ImportedHookSourceSnapshotV1 {
                    import_id: "hook-import".to_string(),
                    source,
                    enabled: false,
                    behavior_version: "sha256:behavior".to_string(),
                    state: ImportedHookSourceStateV1::Current,
                }],
                diagnostics: Vec::new(),
            },
        )
    }

    #[test]
    fn completed_update_reports_that_the_import_remains_disabled() {
        let (source, snapshot) = disabled_snapshot();

        assert_eq!(
            completed_import_status(&snapshot, &source, true),
            "Imported Hooks were updated and remain disabled."
        );
    }

    #[test]
    fn unchanged_import_reports_that_it_remains_disabled() {
        let (source, snapshot) = disabled_snapshot();

        assert_eq!(
            completed_import_status(&snapshot, &source, false),
            "The reviewed Hook import is already current and remains disabled."
        );
    }

    #[test]
    fn enabled_completion_does_not_claim_the_global_hook_switch_is_on() {
        let (source, mut snapshot) = disabled_snapshot();
        snapshot.imports[0].enabled = true;

        assert_eq!(
            completed_import_status(&snapshot, &source, true),
            "Imported Hooks are enabled. The main Hook switch still controls whether they run."
        );
    }

    #[test]
    fn tui_plan_hides_the_internal_fingerprint_and_uses_its_own_confirmation_hint() {
        let (_, snapshot) = disabled_snapshot();
        let plan = ExternalHookImportPlanV1 {
            schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
            source: snapshot.imports[0].source.clone(),
            disposition: ExternalHookImportDispositionV1::Update,
            behavior_version: "sha256:behavior".to_string(),
            handlers: Vec::new(),
            skipped: Vec::new(),
            plan_fingerprint: "sha256:internal-plan".to_string(),
        };

        assert!(render_plan(&plan).contains("sha256:internal-plan"));
        let rendered = render_plan_for_tui(&plan);
        assert!(!rendered.contains("sha256:internal-plan"));
        assert!(rendered.contains("repeat the same import/update command with --confirm"));
    }
}
