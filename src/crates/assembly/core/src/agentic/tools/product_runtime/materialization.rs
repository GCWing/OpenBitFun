//! Product tool materialization owner.

use crate::agentic::tools::framework::Tool;
use crate::agentic::tools::implementations::*;
use crate::agentic::tools::product_runtime::CallDeferredTool;
use crate::agentic::tools::registry::ProductToolDecoratorRef;
use openbitfun_agent_tools::{
    StaticToolMaterializationError, StaticToolProviderFactory, ToolRegistry as AgentToolRegistry,
    ToolRuntimeAssembly,
};
use openbitfun_tool_packs::{
    tool_feature_group, unavailable_feature_groups, ToolPackFeatureGroup, ToolProviderGroupPlan,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

// Product capability groups own inclusion. Core keeps the established registry
// order because it is observable in model tool manifests and deferred catalogs.
const PRODUCT_TOOL_REGISTRATION_ORDER: &[&str] = &[
    "LS",
    "Read",
    "view_image",
    "analyze_image",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Delete",
    "ExecCommand",
    "WriteStdin",
    "ExecControl",
    "GetTime",
    "ListModels",
    "Task",
    "AgentSpawn",
    "AgentSendInput",
    "AgentControl",
    "AgentList",
    "AgentWait",
    "LaunchReviewAgent",
    "Skill",
    "AskUserQuestion",
    "TodoWrite",
    "get_goal",
    "create_goal",
    "update_goal",
    "submit_code_review",
    "GetToolSpec",
    "CallDeferredTool",
    "OpenBitFunControl",
    "GetFileDiff",
    "CreateCanvas",
    "ReadCanvas",
    "UpdateCanvas",
    "PatchCanvas",
    "ListWorkspaces",
    "SessionControl",
    "SessionMessage",
    "SessionHistory",
    "Cron",
    "PortForward",
    "WebSearch",
    "WebFetch",
    "ListMCPResources",
    "ReadMCPResource",
    "ListMCPPrompts",
    "GetMCPPrompt",
    "GenerativeUI",
    "Worktree",
    "ReviewPlatform",
    "InitMiniApp",
    "FinalizeMiniApp",
    "PublishMiniApp",
    "FrontendWorkbench",
    "PublishAppearance",
    "PageDeploy",
    "PagePublish",
    "ControlHub",
    "ComputerUse",
    "Playbook",
];

#[derive(Debug, thiserror::Error)]
pub(crate) enum ProductToolMaterializationError {
    #[error("product capability plan requires tool groups absent from this binary: {groups}")]
    UnavailableFeatureGroups { groups: String },
    #[error("product tool {tool_name} in provider {provider_id} has no feature owner")]
    MissingFeatureOwner {
        provider_id: &'static str,
        tool_name: &'static str,
    },
    #[error("product tool {tool_name} in provider {provider_id} has no registry order")]
    MissingRegistrationOrder {
        provider_id: &'static str,
        tool_name: &'static str,
    },
    #[error(transparent)]
    StaticToolMaterialization(#[from] StaticToolMaterializationError),
}

#[derive(Debug, Clone, Copy, Default)]
pub(in crate::agentic::tools) struct ProductConcreteToolFactory;

impl StaticToolProviderFactory<dyn Tool> for ProductConcreteToolFactory {
    fn materialize_tool(&self, tool_name: &str) -> Option<Arc<dyn Tool>> {
        match tool_name {
            "LS" => Some(Arc::new(LSTool::new())),
            "Read" => Some(Arc::new(FileReadTool::new())),
            #[cfg(feature = "tools-image-analysis")]
            "view_image" => Some(Arc::new(ViewImageTool::new())),
            #[cfg(feature = "tools-image-analysis")]
            "analyze_image" => Some(Arc::new(AnalyzeImageTool::new())),
            "Glob" => Some(Arc::new(GlobTool::new())),
            "Grep" => Some(Arc::new(GrepTool::new())),
            "Write" => Some(Arc::new(FileWriteTool::new())),
            "Edit" => Some(Arc::new(FileEditTool::new())),
            "Delete" => Some(Arc::new(DeleteFileTool::new())),
            "ExecCommand" => Some(Arc::new(ExecCommandTool::new())),
            "WriteStdin" => Some(Arc::new(WriteStdinTool::new())),
            "ExecControl" => Some(Arc::new(ExecControlTool::new())),
            "GetTime" => Some(Arc::new(GetTimeTool::new())),
            "ListModels" => Some(Arc::new(ListModelsTool::new())),
            "OpenBitFunControl" => Some(Arc::new(OpenBitFunControlTool::new())),
            "Task" => Some(Arc::new(TaskTool::new())),
            "AgentSpawn" => Some(Arc::new(AgentSpawnTool::new())),
            "AgentSendInput" => Some(Arc::new(AgentSendInputTool::new())),
            "AgentControl" => Some(Arc::new(AgentControlTool::new())),
            "AgentList" => Some(Arc::new(AgentListTool::new())),
            "AgentWait" => Some(Arc::new(AgentWaitTool::new())),
            "LaunchReviewAgent" => Some(Arc::new(LaunchReviewAgentTool::new())),
            "Skill" => Some(Arc::new(SkillTool::new())),
            "AskUserQuestion" => Some(Arc::new(AskUserQuestionTool::new())),
            "TodoWrite" => Some(Arc::new(TodoWriteTool::new())),
            "get_goal" => Some(Arc::new(GetGoalTool::new())),
            "create_goal" => Some(Arc::new(CreateGoalTool::new())),
            "update_goal" => Some(Arc::new(UpdateGoalTool::new())),
            #[cfg(feature = "tools-canvas")]
            "CreateCanvas" => Some(Arc::new(CreateCanvasTool::new())),
            #[cfg(feature = "tools-canvas")]
            "ReadCanvas" => Some(Arc::new(ReadCanvasTool::new())),
            #[cfg(feature = "tools-canvas")]
            "UpdateCanvas" => Some(Arc::new(UpdateCanvasTool::new())),
            #[cfg(feature = "tools-canvas")]
            "PatchCanvas" => Some(Arc::new(PatchCanvasTool::new())),
            "submit_code_review" => Some(Arc::new(CodeReviewTool::new())),
            "GetToolSpec" => Some(Arc::new(GetToolSpecTool::new())),
            "CallDeferredTool" => Some(Arc::new(CallDeferredTool::new())),
            #[cfg(feature = "tools-git")]
            "GetFileDiff" => Some(Arc::new(GetFileDiffTool::new())),
            "ListWorkspaces" => Some(Arc::new(ListWorkspacesTool::new())),
            "SessionControl" => Some(Arc::new(SessionControlTool::new())),
            "SessionMessage" => Some(Arc::new(SessionMessageTool::new())),
            "SessionHistory" => Some(Arc::new(SessionHistoryTool::new())),
            #[cfg(feature = "tools-agent-control")]
            "Cron" => Some(Arc::new(CronTool::new())),
            #[cfg(feature = "tools-agent-control")]
            "PortForward" => Some(Arc::new(PortForwardTool::new())),
            #[cfg(feature = "tools-browser-web")]
            "WebSearch" => Some(Arc::new(WebSearchTool::new())),
            #[cfg(feature = "tools-browser-web")]
            "WebFetch" => Some(Arc::new(WebFetchTool::new())),
            #[cfg(feature = "tools-mcp")]
            "ListMCPResources" => Some(Arc::new(ListMCPResourcesTool::new())),
            #[cfg(feature = "tools-mcp")]
            "ReadMCPResource" => Some(Arc::new(ReadMCPResourceTool::new())),
            #[cfg(feature = "tools-mcp")]
            "ListMCPPrompts" => Some(Arc::new(ListMCPPromptsTool::new())),
            #[cfg(feature = "tools-mcp")]
            "GetMCPPrompt" => Some(Arc::new(GetMCPPromptTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "GenerativeUI" => Some(Arc::new(GenerativeUITool::new())),
            #[cfg(feature = "tools-git")]
            "Worktree" => Some(Arc::new(WorktreeTool::new())),
            #[cfg(feature = "tools-git")]
            "ReviewPlatform" => Some(Arc::new(ReviewPlatformTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "InitMiniApp" => Some(Arc::new(InitMiniAppTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "FinalizeMiniApp" => Some(Arc::new(FinalizeMiniAppTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "PublishMiniApp" => Some(Arc::new(PublishMiniAppTool::new())),
            #[cfg(feature = "tools-creation")]
            "FrontendWorkbench" => Some(Arc::new(FrontendWorkbenchTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "PublishAppearance" => Some(Arc::new(PublishAppearanceTool::new())),
            #[cfg(feature = "tools-pages")]
            "PageDeploy" => Some(Arc::new(PageDeployTool::new())),
            #[cfg(feature = "tools-pages")]
            "PagePublish" => Some(Arc::new(PagePublishTool::new())),
            #[cfg(feature = "tools-browser-web")]
            "ControlHub" => Some(Arc::new(ControlHubTool::new())),
            #[cfg(feature = "tools-computer-use")]
            "ComputerUse" => Some(Arc::new(ComputerUseTool::new())),
            #[cfg(feature = "tools-miniapp")]
            "Playbook" => Some(Arc::new(PlaybookTool::new())),
            _ => None,
        }
    }
}

pub(in crate::agentic::tools) fn create_product_tool_registry_from_plan(
    plan: &[ToolProviderGroupPlan],
    requested_feature_groups: &[ToolPackFeatureGroup],
    tool_decorator: ProductToolDecoratorRef,
) -> Result<AgentToolRegistry<dyn Tool>, ProductToolMaterializationError> {
    let unavailable = unavailable_feature_groups(requested_feature_groups);
    if !unavailable.is_empty() {
        return Err(ProductToolMaterializationError::UnavailableFeatureGroups {
            groups: unavailable
                .iter()
                .map(|group| group.id())
                .collect::<Vec<_>>()
                .join(", "),
        });
    }

    let requested = requested_feature_groups
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let mut selected_tools = HashMap::new();
    for provider in plan {
        for tool_name in provider.tool_names() {
            let feature_group = tool_feature_group(tool_name).ok_or(
                ProductToolMaterializationError::MissingFeatureOwner {
                    provider_id: provider.provider_id(),
                    tool_name,
                },
            )?;
            if requested.contains(&feature_group) {
                selected_tools.insert(*tool_name, provider.provider_id());
            }
        }
    }

    let mut entries = Vec::new();
    for tool_name in PRODUCT_TOOL_REGISTRATION_ORDER {
        if let Some(provider_id) = selected_tools.remove(tool_name) {
            entries.push((provider_id, vec![*tool_name]));
        }
    }
    if let Some((tool_name, provider_id)) = selected_tools.into_iter().next() {
        return Err(ProductToolMaterializationError::MissingRegistrationOrder {
            provider_id,
            tool_name,
        });
    }

    Ok(ToolRuntimeAssembly::with_tool_decorator(tool_decorator)
        .create_registry_from_static_provider_entries(entries, &ProductConcreteToolFactory)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::ToolExposure;
    use openbitfun_tool_packs::product_tool_provider_group_plan;

    /// Every tool name the provider plan advertises must materialize.
    ///
    /// Registry construction treats an unknown name as a hard error, so a tool
    /// that is listed but not built takes down every session in a build that
    /// requests its feature group — the failure is total, not local to the tool.
    #[test]
    fn every_planned_tool_name_materializes() {
        let factory = ProductConcreteToolFactory;
        for provider in product_tool_provider_group_plan() {
            for tool_name in provider.tool_names() {
                let Some(group) = tool_feature_group(tool_name) else {
                    panic!("{tool_name} has no feature owner");
                };
                if unavailable_feature_groups(&[group]).is_empty() {
                    assert!(
                        factory.materialize_tool(tool_name).is_some(),
                        "{tool_name} is planned under provider {} but does not materialize",
                        provider.provider_id()
                    );
                }
            }
        }
    }

    #[test]
    fn list_workspaces_materializes_as_readonly_deferred_discovery() {
        let tool = ProductConcreteToolFactory
            .materialize_tool("ListWorkspaces")
            .expect("workspace catalog belongs to the session tool provider");
        assert!(tool.is_readonly());
        assert!(matches!(tool.default_exposure(), ToolExposure::Deferred));
    }

    #[cfg(all(feature = "tools-agent-control", feature = "remote-workspace"))]
    #[test]
    fn port_forward_materializes_as_a_deferred_tool() {
        let tool = ProductConcreteToolFactory
            .materialize_tool("PortForward")
            .expect("PortForward should materialize when its feature group is present");
        assert_eq!(tool.name(), "PortForward");
        // Deferred keeps it out of the default manifest; the model finds it
        // through the GetToolSpec catalog, which is built from this exposure.
        assert!(matches!(tool.default_exposure(), ToolExposure::Deferred));
        assert!(
            !tool.short_description().trim().is_empty(),
            "the catalog entry is how the model learns this tool exists"
        );
    }
}
