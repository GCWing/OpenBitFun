use anyhow::{anyhow, Result};
use clap::ValueEnum;
use openbitfun_product_domains::external_sources::{
    ExternalMcpImportApplyOutcomeV1, ExternalMcpImportApplyRequestV1,
    ExternalMcpImportDispositionV1, ExternalMcpImportPlanV1, ExternalMcpImportSelectionV1,
    EXTERNAL_MCP_IMPORT_SCHEMA_V1,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum McpImportOutputFormat {
    Text,
    Json,
}

pub(crate) struct McpImportCommand {
    pub apply: bool,
    pub candidates: Vec<String>,
    pub native_id: Option<String>,
    pub format: McpImportOutputFormat,
}

pub(crate) async fn execute(command: McpImportCommand) -> Result<()> {
    let workspace = Some(
        crate::create_cli_local_workspace(&std::env::current_dir()?)
            .await?
            .id,
    );
    let plan = openbitfun_core::external_mcp_import::plan_external_mcp_import(workspace.clone())
        .await
        .map_err(operation_error)?;
    if !command.apply {
        return print_value(command.format, &plan, render_plan(&plan));
    }
    let selections = selections(&plan, &command.candidates, command.native_id)?;
    if selections.is_empty() {
        return Err(anyhow!(
            "No eligible external MCP servers are available to import"
        ));
    }
    let result = openbitfun_core::external_mcp_import::apply_external_mcp_import(
        workspace,
        ExternalMcpImportApplyRequestV1 {
            schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
            plan_fingerprint: plan.plan_fingerprint.clone(),
            selections,
        },
    )
    .await
    .map_err(operation_error)?;
    let text = match &result.outcome {
        ExternalMcpImportApplyOutcomeV1::Applied { imported } => format!(
            "Imported {} MCP server(s) as disabled native entries. Enable them from MCP settings when ready.",
            imported.len()
        ),
        ExternalMcpImportApplyOutcomeV1::Stale { .. } => {
            "The import plan changed. Review the refreshed plan and run --apply again.".to_string()
        }
    };
    print_value(command.format, &result, text)
}

fn selections(
    plan: &ExternalMcpImportPlanV1,
    requested: &[String],
    native_id: Option<String>,
) -> Result<Vec<ExternalMcpImportSelectionV1>> {
    if native_id.is_some() && requested.len() != 1 {
        return Err(anyhow!("--native-id requires exactly one --candidate"));
    }
    let eligible =
        |item: &&openbitfun_product_domains::external_sources::ExternalMcpImportPlanItemV1| {
            matches!(
                item.disposition,
                ExternalMcpImportDispositionV1::Eligible
                    | ExternalMcpImportDispositionV1::AutomaticRename
            )
        };
    if requested.is_empty() {
        return Ok(plan
            .items
            .iter()
            .filter(eligible)
            .map(|item| ExternalMcpImportSelectionV1 {
                candidate_id: item.candidate_id.clone(),
                requested_native_id: None,
            })
            .collect());
    }
    requested
        .iter()
        .map(|candidate_id| {
            let item = plan
                .items
                .iter()
                .find(|item| &item.candidate_id == candidate_id)
                .filter(eligible)
                .ok_or_else(|| {
                    anyhow!("Candidate is not eligible in the current plan: {candidate_id}")
                })?;
            Ok(ExternalMcpImportSelectionV1 {
                candidate_id: item.candidate_id.clone(),
                requested_native_id: native_id.clone(),
            })
        })
        .collect()
}

fn render_plan(plan: &ExternalMcpImportPlanV1) -> String {
    let eligible = plan
        .items
        .iter()
        .filter(|item| {
            matches!(
                item.disposition,
                ExternalMcpImportDispositionV1::Eligible
                    | ExternalMcpImportDispositionV1::AutomaticRename
            )
        })
        .collect::<Vec<_>>();
    let mut lines = vec![format!(
        "{} external MCP server(s) can be imported:",
        eligible.len()
    )];
    let display_name_counts = eligible.iter().fold(BTreeMap::new(), |mut counts, item| {
        *counts.entry(item.display_name.as_str()).or_insert(0usize) += 1;
        counts
    });
    for item in eligible {
        let display_name = crate::plugin_diagnostics::escape_terminal_text(&item.display_name);
        let display_name = if display_name_counts
            .get(item.display_name.as_str())
            .is_some_and(|count| *count > 1)
        {
            format!(
                "{} [{}]",
                display_name,
                crate::plugin_diagnostics::escape_terminal_text(&item.candidate_id)
            )
        } else {
            display_name
        };
        lines.push(format!(
            "- {} -> {}",
            display_name,
            crate::plugin_diagnostics::escape_terminal_text(
                item.proposed_native_id.as_deref().unwrap_or("unavailable")
            )
        ));
    }
    lines.push("Preview only. Use --apply to write disabled native entries.".to_string());
    lines.join("\n")
}

fn print_value(
    value_format: McpImportOutputFormat,
    value: &impl serde::Serialize,
    text: String,
) -> Result<()> {
    match value_format {
        McpImportOutputFormat::Text => println!("{text}"),
        McpImportOutputFormat::Json => println!("{}", serde_json::to_string(value)?),
    }
    Ok(())
}

fn operation_error(
    error: openbitfun_product_domains::external_sources::ExternalSourceOperationError,
) -> anyhow::Error {
    anyhow!("{}: {}", error.code.as_str(), error.detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::external_sources::{
        ExternalMcpImportPlanItemV1, ExternalMcpTransportKind,
    };

    fn item(
        candidate_id: &str,
        display_name: &str,
        native_id: &str,
    ) -> ExternalMcpImportPlanItemV1 {
        ExternalMcpImportPlanItemV1 {
            candidate_id: candidate_id.to_string(),
            display_name: display_name.to_string(),
            transport: ExternalMcpTransportKind::LocalStdio,
            proposed_native_id: Some(native_id.to_string()),
            disposition: ExternalMcpImportDispositionV1::Eligible,
            reason_code: None,
        }
    }

    #[test]
    fn render_plan_adds_candidate_ids_only_for_duplicate_display_names() {
        let plan = ExternalMcpImportPlanV1 {
            schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
            plan_fingerprint: "plan".to_string(),
            items: vec![
                item("opencode::user::docs", "Docs", "docs"),
                item("codex::project::docs", "Docs", "docs-codex"),
                item("claude::user::search", "Search", "search"),
            ],
        };

        let rendered = render_plan(&plan);

        assert!(rendered.contains("- Docs [opencode::user::docs] -> docs"));
        assert!(rendered.contains("- Docs [codex::project::docs] -> docs-codex"));
        assert!(rendered.contains("- Search -> search"));
        assert!(!rendered.contains("Search [claude::user::search]"));
    }

    #[test]
    fn render_plan_ignores_ineligible_duplicate_names_when_deciding_labels() {
        let mut ineligible = item("old::docs", "Docs", "docs-old");
        ineligible.disposition = ExternalMcpImportDispositionV1::AlreadyImported;
        let plan = ExternalMcpImportPlanV1 {
            schema_version: EXTERNAL_MCP_IMPORT_SCHEMA_V1,
            plan_fingerprint: "plan".to_string(),
            items: vec![item("codex::docs", "Docs", "docs"), ineligible],
        };

        let rendered = render_plan(&plan);

        assert!(rendered.contains("- Docs -> docs"));
        assert!(!rendered.contains("Docs [codex::docs]"));
    }
}
