//! Mode system for OpenBitFun
//!
//! Provides flexible mode selection with different system prompts and tool sets

mod definitions;
mod prompt_builder;
mod registry;

use crate::agentic::session::{SystemPromptCacheIdentity, UserContextCacheIdentity};
use crate::agentic::tools::framework::ToolExposure;
use crate::agentic::WorkspaceBinding;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
pub use definitions::custom::{CustomMode, CustomSubagent, CustomSubagentKind};
#[cfg(feature = "external-sources")]
pub(crate) use definitions::external::ExternalProvidedAgent;
pub use definitions::hidden::{CodeReviewAgent, DeepReviewAgent, GenerateDocAgent};
pub use definitions::modes::{
    ClawMode, CoworkMode, CreativeHarness, DeepResearchMode, MinimalHarness, StandardHarness,
    UltimateHarness,
};
pub use definitions::review::{ReviewFixerAgent, ReviewJudgeAgent, ReviewWorkerAgent};
pub use definitions::shared::ReadonlySubagent;
pub use definitions::subagents::{
    ComputerUseMode, ExploreAgent, GeneralPurposeAgent, ResearchSpecialistAgent, SwarmPlannerAgent,
    SwarmReviewerAgent, SwarmWorkerAgent,
};
use indexmap::IndexMap;
pub use openbitfun_agent_runtime::agents::{
    is_swarm_delegate_agent_type, is_swarm_planner_agent_type, mode_config_profile_label,
    mode_config_profile_member_mode_ids, mode_presentation_rank, resolve_mode_config_profile_id,
    standard_harness_user_context_policy, STANDARD_HARNESS_CONFIG_ID,
    STANDARD_HARNESS_CONFIG_LABEL, STANDARD_HARNESS_CONFIG_MEMBERS,
    STANDARD_HARNESS_PROMPT_TEMPLATE, SWARM_DELEGATE_AGENT_TYPES, SWARM_PLANNER_AGENT_TYPES,
};
pub use openbitfun_agent_runtime::custom_agent::{
    custom_agent_model_or_default, custom_agent_review_writable_tools, default_custom_agent_tools,
    default_custom_agent_user_context_policy, CustomAgentKind, CustomAgentLevel,
};
use openbitfun_runtime_ports::PermissionConstraintLayer;
pub use prompt_builder::{
    build_prompt_context_for_workspace, render_direct_tool_listing_body, PrependedPromptReminders,
    PromptBuilder, PromptBuilderContext, RemoteExecutionHints, RuntimeContextNeeds,
    ToolListingSections, UserContextPolicy, UserContextSection,
};
pub use registry::catalog::{builtin_agent_specs, BuiltinAgentSpec};
#[cfg(feature = "external-sources")]
pub(crate) use registry::external_subagent_runtime_key;
pub(crate) use registry::initialize_global_agent_registry_for_profile;
pub use registry::types::{
    subagent_source_from_custom_kind, AgentCategory, AgentInfo, AgentSource, AgentToolPolicy,
    CustomSubagentConfig, SubAgentSource, SubagentListScope, SubagentQueryContext,
    SubagentStateReason,
};
pub use registry::visibility::{
    BuiltinSubagentExposure, SubagentVisibilityPolicy, SubagentVisibilitySummary,
};
pub use registry::{
    get_agent_registry, AgentRegistry, CustomAgentDetail, CustomSubagentDetail,
    ExternalPrimaryAgentTurnBinding, ExternalSubagentGenerationLease,
    ExternalSubagentInvocationBinding, ExternalSubagentModelBinding, ExternalSubagentRegistration,
    ExternalSubagentRoute,
};
use std::any::Any;

pub use openbitfun_agent_content::EMBEDDED_PROMPTS;

/// Returns a built-in Agent prompt by its stable compatibility key.
pub fn get_embedded_prompt(prompt_name: &str) -> Option<&'static str> {
    openbitfun_agent_content::agent_prompt(prompt_name)
}

/// Returns all built-in Agent prompt keys.
#[allow(dead_code)]
pub fn get_all_embedded_prompt_names() -> Vec<&'static str> {
    openbitfun_agent_content::agent_prompt_names()
}

pub type AgentToolPolicyOverrides = IndexMap<String, ToolExposure>;

static EMPTY_AGENT_TOOL_POLICY_OVERRIDES: std::sync::LazyLock<AgentToolPolicyOverrides> =
    std::sync::LazyLock::new(AgentToolPolicyOverrides::default);
static EMPTY_PERMISSION_CONSTRAINTS: std::sync::LazyLock<PermissionConstraintLayer> =
    std::sync::LazyLock::new(PermissionConstraintLayer::default);

pub fn standard_harness_tools() -> Vec<String> {
    vec![
        "Task".to_string(),
        "ListModels".to_string(),
        "AgentWait".to_string(),
        "Read".to_string(),
        "view_image".to_string(),
        "analyze_image".to_string(),
        "Write".to_string(),
        "Edit".to_string(),
        "Delete".to_string(),
        "ExecCommand".to_string(),
        "WriteStdin".to_string(),
        "ExecControl".to_string(),
        // The companion to ExecCommand for remote work: a server started on
        // an SSH host is unreachable from the user's machine until a forward
        // exists, and an Agent that cannot see this tool reinvents it with
        // hand-written `ssh -L` instructions the user has to run themselves.
        "PortForward".to_string(),
        "Grep".to_string(),
        "Glob".to_string(),
        "WebSearch".to_string(),
        "WebFetch".to_string(),
        "TodoWrite".to_string(),
        "get_goal".to_string(),
        "create_goal".to_string(),
        "update_goal".to_string(),
        "GenerativeUI".to_string(),
        "Skill".to_string(),
        "AskUserQuestion".to_string(),
        "ReviewPlatform".to_string(),
        "OpenBitFunControl".to_string(),
        "ControlHub".to_string(),
        // Pairs with ControlHub: its `wait` sends anything repeating, or
        // further out than an hour, to Cron rather than holding the turn open
        // for the interval.
        "Cron".to_string(),
        "PublishAppearance".to_string(),
        "PageDeploy".to_string(),
        "PagePublish".to_string(),
    ]
}

/// Agent trait defining the interface for all agents
#[async_trait]
pub trait Agent: Send + Sync + 'static {
    /// downcast to specific type
    fn as_any(&self) -> &dyn Any;

    /// Unique identifier for the agent
    fn id(&self) -> &str;

    /// Human-readable name
    fn name(&self) -> &str;

    /// Description of what the agent does
    fn description(&self) -> &str;

    /// Prompt template name for the agent.
    fn prompt_template_name(&self, model_name: Option<&str>) -> &str;

    fn system_prompt_cache_identity(&self, model_name: Option<&str>) -> SystemPromptCacheIdentity {
        let template_name = self.prompt_template_name(model_name).trim();
        let scope_key = if template_name.is_empty() {
            format!("agent:{}", self.id())
        } else {
            format!("template:{}", template_name)
        };

        SystemPromptCacheIdentity::new(scope_key)
    }

    fn user_context_cache_identity(&self) -> UserContextCacheIdentity {
        UserContextCacheIdentity::new(self.user_context_policy().cache_scope_key())
    }

    fn system_reminder_template_name(&self) -> Option<&str> {
        None // by default, no system reminder
    }

    fn user_context_policy(&self) -> UserContextPolicy;

    /// Build the system prompt for this agent
    async fn build_prompt(&self, context: &PromptBuilderContext) -> OpenBitFunResult<String> {
        let prompt_components = PromptBuilder::new(context.clone());
        let template_name = self.prompt_template_name(context.model_name.as_deref());
        let system_prompt_template = get_embedded_prompt(template_name).ok_or_else(|| {
            OpenBitFunError::Agent(format!("{} not found in embedded files", template_name))
        })?;

        let prompt = prompt_components
            .build_prompt_from_template(system_prompt_template)
            .await?;

        Ok(prompt)
    }

    /// Get the system prompt for this agent
    async fn get_system_prompt(
        &self,
        context: Option<&PromptBuilderContext>,
    ) -> OpenBitFunResult<String> {
        if let Some(context) = context {
            self.build_prompt(context).await
        } else {
            Err(OpenBitFunError::Agent(
                "Prompt build context is required".to_string(),
            ))
        }
    }

    /// Get the system reminder for this agent, only used for modes.
    /// The returned reminder may be prepended immediately before the user's
    /// actual message in runtime context.
    /// `previous_agent_type` can be used to distinguish first entry vs staying
    /// in the same mode across turns.
    async fn get_system_reminder(
        &self,
        _previous_agent_type: Option<&str>,
        _workspace: Option<&WorkspaceBinding>,
    ) -> OpenBitFunResult<String> {
        if let Some(system_reminder_template_name) = self.system_reminder_template_name() {
            let system_reminder =
                get_embedded_prompt(system_reminder_template_name).ok_or_else(|| {
                    OpenBitFunError::Agent(format!(
                        "{} not found in embedded files",
                        system_reminder_template_name
                    ))
                })?;
            Ok(system_reminder.to_string())
        } else {
            Ok("".to_string())
        }
    }

    /// Get the list of default tools for this agent
    fn default_tools(&self) -> Vec<String>;

    /// Per-agent exposure overrides for allowed tools.
    ///
    /// Tools omitted here inherit their tool-defined default exposure.
    fn tool_exposure_overrides(&self) -> &AgentToolPolicyOverrides {
        &EMPTY_AGENT_TOOL_POLICY_OVERRIDES
    }

    /// Independent restrictions contributed by the immutable agent definition.
    /// They may tighten, but never widen, the resolved host permission policy.
    fn permission_constraints(&self) -> &PermissionConstraintLayer {
        &EMPTY_PERMISSION_CONSTRAINTS
    }

    /// Whether dynamic MCP tools may be appended to this Agent's manifest.
    fn include_dynamic_mcp_tools(&self) -> bool {
        true
    }

    /// Optional model sampling temperature supplied by an external Agent
    /// definition. The execution owner applies this to a per-turn client
    /// clone; built-in Agents inherit the configured model temperature.
    fn model_temperature_override(&self) -> Option<f64> {
        None
    }

    /// Whether this agent is read-only (prevents file modifications)
    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        get_embedded_prompt, standard_harness_tools, standard_harness_user_context_policy, Agent,
        MinimalHarness, StandardHarness, EMBEDDED_PROMPTS,
    };

    #[test]
    fn embedded_prompt_catalog_compatibility_export_matches_lookup() {
        assert_eq!(
            EMBEDDED_PROMPTS.get("agentic_mode").copied(),
            get_embedded_prompt("agentic_mode")
        );
    }

    #[test]
    fn minimal_agent_prompt_resolves_to_embedded_prompt() {
        assert!(
            get_embedded_prompt(MinimalHarness::new().prompt_template_name(None)).is_some(),
            "minimal Agent prompt must resolve through the embedded prompt catalog"
        );
    }

    #[test]
    fn standard_harness_tools_exclude_create_plan_and_include_goal_tools() {
        let tools = standard_harness_tools();

        assert!(tools.contains(&"ListModels".to_string()));
        assert!(!tools.contains(&"CreatePlan".to_string()));
        assert!(tools.contains(&"get_goal".to_string()));
        assert!(tools.contains(&"update_goal".to_string()));
    }

    #[test]
    fn standard_harness_tools_include_review_platform() {
        let tools = standard_harness_tools();

        assert!(tools.contains(&"ReviewPlatform".to_string()));
    }

    #[test]
    fn standard_harness_tools_keep_canvas_provider_tools_opt_in() {
        let tools = standard_harness_tools();

        assert!(!tools.contains(&"CreateCanvas".to_string()));
        assert!(!tools.contains(&"ReadCanvas".to_string()));
        assert!(!tools.contains(&"UpdateCanvas".to_string()));
        assert!(!tools.contains(&"PatchCanvas".to_string()));
    }

    #[test]
    fn agentic_mode_uses_shared_coding_tools() {
        let shared_tools = standard_harness_tools();

        assert_eq!(StandardHarness::new().default_tools(), shared_tools);
    }

    #[test]
    fn agentic_mode_uses_shared_coding_user_context_policy() {
        let shared_policy = standard_harness_user_context_policy();

        assert_eq!(StandardHarness::new().user_context_policy(), shared_policy);
    }
}
