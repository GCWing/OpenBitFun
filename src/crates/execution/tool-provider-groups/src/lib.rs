//! Concrete tool-pack owner crate.
//!
//! This crate owns compile-time availability facts and the stable product
//! provider plan. Concrete implementations, registry ordering, permissions,
//! and runtime materialization remain in Core.

use std::collections::HashSet;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolPackFeatureGroup {
    Basic,
    Git,
    Mcp,
    BrowserWeb,
    ComputerUse,
    ImageAnalysis,
    MiniApp,
    Pages,
    Creation,
    Canvas,
    AgentControl,
}

impl ToolPackFeatureGroup {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Basic => "basic",
            Self::Git => "git",
            Self::Mcp => "mcp",
            Self::BrowserWeb => "browser-web",
            Self::ComputerUse => "computer-use",
            Self::ImageAnalysis => "image-analysis",
            Self::MiniApp => "miniapp",
            Self::Pages => "pages",
            Self::Creation => "creation",
            Self::Canvas => "canvas",
            Self::AgentControl => "agent-control",
        }
    }
}

pub const ALL_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[
    ToolPackFeatureGroup::Basic,
    ToolPackFeatureGroup::Git,
    ToolPackFeatureGroup::Mcp,
    ToolPackFeatureGroup::BrowserWeb,
    ToolPackFeatureGroup::ComputerUse,
    ToolPackFeatureGroup::ImageAnalysis,
    ToolPackFeatureGroup::MiniApp,
    ToolPackFeatureGroup::Pages,
    ToolPackFeatureGroup::Creation,
    ToolPackFeatureGroup::Canvas,
    ToolPackFeatureGroup::AgentControl,
];

pub fn all_feature_groups() -> &'static [ToolPackFeatureGroup] {
    ALL_FEATURE_GROUPS
}

pub fn enabled_feature_groups() -> Vec<ToolPackFeatureGroup> {
    [
        (cfg!(feature = "basic"), ToolPackFeatureGroup::Basic),
        (cfg!(feature = "git"), ToolPackFeatureGroup::Git),
        (cfg!(feature = "mcp"), ToolPackFeatureGroup::Mcp),
        (
            cfg!(feature = "browser-web"),
            ToolPackFeatureGroup::BrowserWeb,
        ),
        (
            cfg!(feature = "computer-use"),
            ToolPackFeatureGroup::ComputerUse,
        ),
        (
            cfg!(feature = "image-analysis"),
            ToolPackFeatureGroup::ImageAnalysis,
        ),
        (cfg!(feature = "miniapp"), ToolPackFeatureGroup::MiniApp),
        (cfg!(feature = "pages"), ToolPackFeatureGroup::Pages),
        (cfg!(feature = "creation"), ToolPackFeatureGroup::Creation),
        (cfg!(feature = "canvas"), ToolPackFeatureGroup::Canvas),
        (
            cfg!(feature = "agent-control"),
            ToolPackFeatureGroup::AgentControl,
        ),
    ]
    .into_iter()
    .filter_map(|(enabled, group)| enabled.then_some(group))
    .collect()
}

pub fn tool_feature_group(tool_name: &str) -> Option<ToolPackFeatureGroup> {
    match tool_name {
        "LS" | "Read" | "Glob" | "Grep" | "Write" | "Edit" | "Delete" | "ExecCommand"
        | "WriteStdin" | "ExecControl" | "GetTime" | "ListModels" => {
            Some(ToolPackFeatureGroup::Basic)
        }
        "Worktree" | "ReviewPlatform" | "GetFileDiff" => Some(ToolPackFeatureGroup::Git),
        "ListMCPResources" | "ReadMCPResource" | "ListMCPPrompts" | "GetMCPPrompt" => {
            Some(ToolPackFeatureGroup::Mcp)
        }
        "WebSearch" | "WebFetch" | "ControlHub" => Some(ToolPackFeatureGroup::BrowserWeb),
        "ComputerUse" => Some(ToolPackFeatureGroup::ComputerUse),
        "view_image" | "analyze_image" => Some(ToolPackFeatureGroup::ImageAnalysis),
        "GenerativeUI" | "InitMiniApp" | "FinalizeMiniApp" | "PublishMiniApp"
        | "PublishAppearance" | "Playbook" => Some(ToolPackFeatureGroup::MiniApp),
        "PageDeploy" | "PagePublish" => Some(ToolPackFeatureGroup::Pages),
        "FrontendWorkbench" => Some(ToolPackFeatureGroup::Creation),
        "CreateCanvas" | "ReadCanvas" | "UpdateCanvas" | "PatchCanvas" => {
            Some(ToolPackFeatureGroup::Canvas)
        }
        "Task" | "AgentSpawn" | "AgentSendInput" | "AgentControl" | "AgentList" | "AgentWait"
        | "LaunchReviewAgent" | "Skill" | "AskUserQuestion" | "TodoWrite" | "get_goal"
        | "create_goal" | "update_goal" | "submit_code_review" | "GetToolSpec"
        | "CallDeferredTool" | "ListWorkspaces" | "SessionControl" | "SessionMessage"
        | "SessionHistory" | "Cron" | "PortForward" | "OpenBitFunControl" => {
            Some(ToolPackFeatureGroup::AgentControl)
        }
        _ => None,
    }
}

pub fn unavailable_feature_groups(requested: &[ToolPackFeatureGroup]) -> Vec<ToolPackFeatureGroup> {
    let enabled = enabled_feature_groups().into_iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    requested
        .iter()
        .copied()
        .filter(|group| !enabled.contains(group))
        .filter(|group| seen.insert(*group))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolProviderGroupPlan {
    provider_id: &'static str,
    feature_groups: &'static [ToolPackFeatureGroup],
    tool_names: &'static [&'static str],
}

impl ToolProviderGroupPlan {
    pub const fn provider_id(self) -> &'static str {
        self.provider_id
    }

    pub const fn feature_groups(self) -> &'static [ToolPackFeatureGroup] {
        self.feature_groups
    }

    pub const fn tool_names(self) -> &'static [&'static str] {
        self.tool_names
    }
}

const CORE_BASIC_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[
    ToolPackFeatureGroup::Basic,
    ToolPackFeatureGroup::ImageAnalysis,
];
const CORE_AGENT_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::AgentControl];
const CORE_REVIEW_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::AgentControl];
const CORE_CANVAS_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::Canvas];
const CORE_SESSION_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::AgentControl];
const CORE_GIT_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::Git];
const CORE_WEB_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::BrowserWeb];
const CORE_MCP_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::Mcp];
const CORE_COMPUTER_USE_FEATURE_GROUPS: &[ToolPackFeatureGroup] =
    &[ToolPackFeatureGroup::ComputerUse];
const CORE_MINIAPP_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::MiniApp];
const CORE_CREATION_FEATURE_GROUPS: &[ToolPackFeatureGroup] = &[ToolPackFeatureGroup::Creation];

const PRODUCT_TOOL_PROVIDER_GROUP_PLAN: &[ToolProviderGroupPlan] = &[
    ToolProviderGroupPlan {
        provider_id: "core.basic",
        feature_groups: CORE_BASIC_FEATURE_GROUPS,
        tool_names: &[
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
        ],
    },
    ToolProviderGroupPlan {
        provider_id: "core.agent",
        feature_groups: CORE_AGENT_FEATURE_GROUPS,
        tool_names: &[
            "Task",
            "AgentSpawn",
            "AgentSendInput",
            "AgentControl",
            "AgentList",
            "AgentWait",
            "Skill",
            "AskUserQuestion",
            "TodoWrite",
            "get_goal",
            "create_goal",
            "update_goal",
            "GetToolSpec",
            "CallDeferredTool",
            "OpenBitFunControl",
        ],
    },
    ToolProviderGroupPlan {
        provider_id: "core.session",
        feature_groups: CORE_SESSION_FEATURE_GROUPS,
        tool_names: &[
            "ListWorkspaces",
            "SessionControl",
            "SessionMessage",
            "SessionHistory",
            "Cron",
            "PortForward",
        ],
    },
    ToolProviderGroupPlan {
        provider_id: "core.git",
        feature_groups: CORE_GIT_FEATURE_GROUPS,
        tool_names: &["GetFileDiff", "Worktree", "ReviewPlatform"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.web",
        feature_groups: CORE_WEB_FEATURE_GROUPS,
        tool_names: &["WebSearch", "WebFetch", "ControlHub"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.mcp",
        feature_groups: CORE_MCP_FEATURE_GROUPS,
        tool_names: &[
            "ListMCPResources",
            "ReadMCPResource",
            "ListMCPPrompts",
            "GetMCPPrompt",
        ],
    },
    ToolProviderGroupPlan {
        provider_id: "core.computer-use",
        feature_groups: CORE_COMPUTER_USE_FEATURE_GROUPS,
        tool_names: &["ComputerUse"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.review",
        feature_groups: CORE_REVIEW_FEATURE_GROUPS,
        tool_names: &["LaunchReviewAgent", "submit_code_review"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.miniapp",
        feature_groups: CORE_MINIAPP_FEATURE_GROUPS,
        tool_names: &[
            "GenerativeUI",
            "InitMiniApp",
            "FinalizeMiniApp",
            "PublishMiniApp",
            "PublishAppearance",
            "Playbook",
        ],
    },
    ToolProviderGroupPlan {
        provider_id: "core.pages",
        feature_groups: &[ToolPackFeatureGroup::Pages],
        tool_names: &["PageDeploy", "PagePublish"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.creation",
        feature_groups: CORE_CREATION_FEATURE_GROUPS,
        tool_names: &["FrontendWorkbench"],
    },
    ToolProviderGroupPlan {
        provider_id: "core.canvas",
        feature_groups: CORE_CANVAS_FEATURE_GROUPS,
        tool_names: &["CreateCanvas", "ReadCanvas", "UpdateCanvas", "PatchCanvas"],
    },
];

pub fn product_tool_provider_group_plan() -> &'static [ToolProviderGroupPlan] {
    PRODUCT_TOOL_PROVIDER_GROUP_PLAN
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolProviderGroupPlanSelectionError {
    UnknownToolProviderGroup { provider_id: &'static str },
}

impl fmt::Display for ToolProviderGroupPlanSelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownToolProviderGroup { provider_id } => {
                write!(formatter, "unknown tool provider group {provider_id}")
            }
        }
    }
}

impl std::error::Error for ToolProviderGroupPlanSelectionError {}

pub fn try_product_tool_provider_group_plan_for_ids(
    provider_ids: &[&'static str],
) -> Result<Vec<ToolProviderGroupPlan>, ToolProviderGroupPlanSelectionError> {
    let requested_provider_ids = provider_ids.iter().copied().collect::<HashSet<_>>();
    let mut found_provider_ids = HashSet::new();
    let mut plan = Vec::new();

    for group_plan in product_tool_provider_group_plan() {
        if requested_provider_ids.contains(group_plan.provider_id()) {
            found_provider_ids.insert(group_plan.provider_id());
            plan.push(*group_plan);
        }
    }

    for provider_id in provider_ids {
        if !found_provider_ids.contains(provider_id) {
            return Err(
                ToolProviderGroupPlanSelectionError::UnknownToolProviderGroup { provider_id },
            );
        }
    }

    Ok(plan)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        all_feature_groups, enabled_feature_groups, product_tool_provider_group_plan,
        tool_feature_group, try_product_tool_provider_group_plan_for_ids,
        unavailable_feature_groups, ToolPackFeatureGroup, ToolProviderGroupPlanSelectionError,
    };

    #[test]
    fn all_feature_groups_cover_planned_tool_pack_scaffold() {
        let feature_ids = all_feature_groups()
            .iter()
            .map(|group| group.id())
            .collect::<Vec<_>>();

        assert_eq!(
            feature_ids,
            vec![
                "basic",
                "git",
                "mcp",
                "browser-web",
                "computer-use",
                "image-analysis",
                "miniapp",
                "pages",
                "creation",
                "canvas",
                "agent-control"
            ]
        );
    }

    #[test]
    fn enabled_feature_groups_reflect_compile_time_features() {
        let groups = enabled_feature_groups();

        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::Basic),
            cfg!(feature = "basic")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::Git),
            cfg!(feature = "git")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::Mcp),
            cfg!(feature = "mcp")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::BrowserWeb),
            cfg!(feature = "browser-web")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::ComputerUse),
            cfg!(feature = "computer-use")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::ImageAnalysis),
            cfg!(feature = "image-analysis")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::MiniApp),
            cfg!(feature = "miniapp")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::Creation),
            cfg!(feature = "creation")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::Canvas),
            cfg!(feature = "canvas")
        );
        assert_eq!(
            groups.contains(&ToolPackFeatureGroup::AgentControl),
            cfg!(feature = "agent-control")
        );
    }

    #[test]
    fn provider_plan_reports_every_requested_group_missing_from_the_binary() {
        let unavailable = unavailable_feature_groups(all_feature_groups());
        for group in all_feature_groups() {
            assert_eq!(
                unavailable.contains(group),
                !enabled_feature_groups().contains(group),
                "{} availability must reflect the compiled tool-pack feature",
                group.id(),
            );
        }
    }

    #[test]
    fn every_builtin_tool_has_one_compile_time_owner_group() {
        for tool_name in product_tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names())
        {
            assert!(
                tool_feature_group(tool_name).is_some(),
                "{tool_name} must have a compile-time feature owner"
            );
        }
    }

    #[test]
    fn every_provider_declares_exactly_its_tool_owner_groups() {
        for provider in product_tool_provider_group_plan() {
            let declared = provider
                .feature_groups()
                .iter()
                .copied()
                .collect::<HashSet<_>>();
            let actual = provider
                .tool_names()
                .iter()
                .map(|tool_name| {
                    tool_feature_group(tool_name).unwrap_or_else(|| {
                        panic!("{tool_name} must have a compile-time feature owner")
                    })
                })
                .collect::<HashSet<_>>();

            assert_eq!(
                declared,
                actual,
                "{} feature groups must match its tool owners",
                provider.provider_id()
            );
            assert_eq!(
                provider.feature_groups().len(),
                declared.len(),
                "{} must not declare duplicate feature groups",
                provider.provider_id()
            );
        }
    }

    #[test]
    fn feature_group_ids_match_cargo_feature_names() {
        assert_eq!(ToolPackFeatureGroup::Basic.id(), "basic");
        assert_eq!(ToolPackFeatureGroup::Git.id(), "git");
        assert_eq!(ToolPackFeatureGroup::Mcp.id(), "mcp");
        assert_eq!(ToolPackFeatureGroup::BrowserWeb.id(), "browser-web");
        assert_eq!(ToolPackFeatureGroup::ComputerUse.id(), "computer-use");
        assert_eq!(ToolPackFeatureGroup::ImageAnalysis.id(), "image-analysis");
        assert_eq!(ToolPackFeatureGroup::MiniApp.id(), "miniapp");
        assert_eq!(ToolPackFeatureGroup::Creation.id(), "creation");
        assert_eq!(ToolPackFeatureGroup::Canvas.id(), "canvas");
        assert_eq!(ToolPackFeatureGroup::AgentControl.id(), "agent-control");
    }

    #[test]
    fn product_provider_group_plan_exposes_atomic_runtime_owners() {
        let provider_ids = product_tool_provider_group_plan()
            .iter()
            .map(|group| group.provider_id())
            .collect::<Vec<_>>();

        assert_eq!(
            provider_ids,
            vec![
                "core.basic",
                "core.agent",
                "core.session",
                "core.git",
                "core.web",
                "core.mcp",
                "core.computer-use",
                "core.review",
                "core.miniapp",
                "core.pages",
                "core.creation",
                "core.canvas",
            ]
        );
    }

    #[test]
    fn product_provider_group_plan_keeps_stable_atomic_owner_tool_listings() {
        let tool_names = product_tool_provider_group_plan()
            .iter()
            .flat_map(|group| group.tool_names().iter().copied())
            .collect::<Vec<_>>();

        assert_eq!(
            tool_names,
            vec![
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
                "Skill",
                "AskUserQuestion",
                "TodoWrite",
                "get_goal",
                "create_goal",
                "update_goal",
                "GetToolSpec",
                "CallDeferredTool",
                "OpenBitFunControl",
                "ListWorkspaces",
                "SessionControl",
                "SessionMessage",
                "SessionHistory",
                "Cron",
                "PortForward",
                "GetFileDiff",
                "Worktree",
                "ReviewPlatform",
                "WebSearch",
                "WebFetch",
                "ControlHub",
                "ListMCPResources",
                "ReadMCPResource",
                "ListMCPPrompts",
                "GetMCPPrompt",
                "ComputerUse",
                "LaunchReviewAgent",
                "submit_code_review",
                "GenerativeUI",
                "InitMiniApp",
                "FinalizeMiniApp",
                "PublishMiniApp",
                "PublishAppearance",
                "Playbook",
                "PageDeploy",
                "PagePublish",
                "FrontendWorkbench",
                "CreateCanvas",
                "ReadCanvas",
                "UpdateCanvas",
                "PatchCanvas",
            ]
        );
    }

    #[test]
    fn product_provider_group_plan_preserves_feature_group_mapping() {
        let feature_groups = product_tool_provider_group_plan()
            .iter()
            .map(|group| {
                (
                    group.provider_id(),
                    group
                        .feature_groups()
                        .iter()
                        .map(|feature_group| feature_group.id())
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            feature_groups,
            vec![
                ("core.basic", vec!["basic", "image-analysis"]),
                ("core.agent", vec!["agent-control"]),
                ("core.session", vec!["agent-control"]),
                ("core.git", vec!["git"]),
                ("core.web", vec!["browser-web"]),
                ("core.mcp", vec!["mcp"]),
                ("core.computer-use", vec!["computer-use"]),
                ("core.review", vec!["agent-control"]),
                ("core.miniapp", vec!["miniapp"]),
                ("core.pages", vec!["pages"]),
                ("core.creation", vec!["creation"]),
                ("core.canvas", vec!["canvas"]),
            ]
        );
    }

    #[test]
    fn product_provider_group_plan_selector_preserves_product_plan_order_for_requested_ids() {
        let plan = try_product_tool_provider_group_plan_for_ids(&["core.mcp", "core.basic"])
            .expect("known provider groups should select");

        let provider_ids = plan
            .iter()
            .map(|group| group.provider_id())
            .collect::<Vec<_>>();

        assert_eq!(provider_ids, vec!["core.basic", "core.mcp"]);
    }

    #[test]
    fn product_provider_group_plan_selector_rejects_unknown_provider_ids() {
        let error = try_product_tool_provider_group_plan_for_ids(&["core.basic", "core.missing"])
            .expect_err("unknown provider ids must not be silently ignored");

        assert_eq!(
            error,
            ToolProviderGroupPlanSelectionError::UnknownToolProviderGroup {
                provider_id: "core.missing"
            }
        );
    }
}
