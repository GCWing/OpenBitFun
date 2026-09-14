use super::support::merge_dynamic_mcp_tools;
use super::{AgentRegistry, ExternalSubagentRegistration, ExternalSubagentRoute};
use crate::agentic::agents::definitions::custom::{CustomMode, CustomSubagent, CustomSubagentKind};
use crate::agentic::agents::registry::builtin::default_model_id_for_builtin_agent;
use crate::agentic::agents::registry::types::{
    subagent_source_from_custom_kind, AgentCategory, AgentEntry, AgentSource, CustomSubagentConfig,
    SubAgentSource, SubagentListScope, SubagentOverrideState, SubagentQueryContext,
};
use crate::agentic::agents::registry::visibility::{
    BuiltinSubagentExposure, SubagentVisibilityPolicy,
};
use crate::agentic::agents::{
    builtin_agent_specs, resolve_mode_config_profile_id, Agent, UserContextPolicy,
};
use crate::agentic::workspace::session_execution_workspace_root;
use crate::service::config::types::AgentSubagentOverrideState;
use async_trait::async_trait;
use openbitfun_agent_runtime::custom_agent::{
    custom_agent_save_markdown_file, CustomAgentDefinition, CustomAgentDiscoveryRoots,
    CustomAgentKind, CustomAgentLevel,
};
use openbitfun_agent_runtime::sdk::{RuntimeAgentRegistry, RuntimeAgentRegistryQuery};
use openbitfun_agent_runtime::session::SessionConfig;
use openbitfun_agent_runtime::thread_goal_tools::THREAD_GOAL_TOOL_NAMES;
use openbitfun_product_domains::external_sources::EcosystemId;
use openbitfun_product_domains::external_subagents::ExternalSubagentMode;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct TestAgent {
    id: String,
}

#[async_trait]
impl Agent for TestAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.id
    }

    fn description(&self) -> &str {
        "Test subagent"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "test_agent"
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
    }

    fn default_tools(&self) -> Vec<String> {
        vec!["Read".to_string()]
    }
}

fn test_project_entry(id: &str, model: &str) -> AgentEntry {
    AgentEntry {
        category: AgentCategory::SubAgent,
        source: AgentSource::Project,
        subagent_source: Some(SubAgentSource::Project),
        agent: Arc::new(TestAgent { id: id.to_string() }),
        visibility_policy: SubagentVisibilityPolicy::public(),
        custom_config: Some(CustomSubagentConfig {
            model: model.to_string(),
            model_is_explicit: true,
        }),
    }
}

fn test_project_custom_entry(id: &str, review: bool) -> AgentEntry {
    let mut agent = CustomSubagent::new(
        id.to_string(),
        "Project custom subagent".to_string(),
        vec!["Read".to_string()],
        "prompt".to_string(),
        review,
        format!("{id}.md"),
        CustomSubagentKind::Project,
    );
    agent.data.review = review;

    AgentEntry {
        category: AgentCategory::SubAgent,
        source: AgentSource::Project,
        subagent_source: Some(SubAgentSource::Project),
        agent: Arc::new(agent),
        visibility_policy: SubagentVisibilityPolicy::public(),
        custom_config: Some(CustomSubagentConfig {
            model: "fast".to_string(),
            model_is_explicit: true,
        }),
    }
}

fn test_source_custom_entry(id: &str, prompt: &str, kind: CustomSubagentKind) -> AgentEntry {
    let source = match kind {
        CustomSubagentKind::Project => AgentSource::Project,
        CustomSubagentKind::User => AgentSource::User,
    };
    let subagent_source = subagent_source_from_custom_kind(kind);
    let agent = CustomSubagent::new(
        id.to_string(),
        format!("{id} description"),
        vec!["Read".to_string()],
        prompt.to_string(),
        true,
        format!("{id}.md"),
        kind,
    );
    AgentEntry {
        category: AgentCategory::SubAgent,
        source,
        subagent_source: Some(subagent_source),
        agent: Arc::new(agent),
        visibility_policy: SubagentVisibilityPolicy::public(),
        custom_config: Some(CustomSubagentConfig {
            model: "fast".to_string(),
            model_is_explicit: true,
        }),
    }
}

fn insert_project_subagent(registry: &AgentRegistry, workspace: &Path, id: &str, model: &str) {
    let mut entries = HashMap::new();
    entries.insert(id.to_string(), test_project_entry(id, model));
    registry
        .write_project_subagents()
        .insert(workspace.to_path_buf(), entries);
}

#[test]
fn source_qualified_key_resolves_the_matching_custom_subagent() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("source-qualified-review-workspace");
    let id = "SameNamedReviewer";
    registry.write_agents().insert(
        id.to_string(),
        test_source_custom_entry(id, "user review guidance", CustomSubagentKind::User),
    );
    registry.write_project_subagents().insert(
        workspace.clone(),
        HashMap::from([(
            id.to_string(),
            test_source_custom_entry(id, "project review guidance", CustomSubagentKind::Project),
        )]),
    );

    let project = registry
        .get_custom_agent_detail_by_key_inner(
            "project::openbitfun::SameNamedReviewer",
            Some(&workspace),
        )
        .expect("project key should select the project definition");
    let user = registry
        .get_custom_agent_detail_by_key_inner(
            "user::openbitfun::SameNamedReviewer",
            Some(&workspace),
        )
        .expect("user key should select the user definition");

    assert_eq!(project.prompt, "project review guidance");
    assert_eq!(user.prompt, "user review guidance");
}

#[tokio::test]
async fn review_lookup_is_scoped_to_the_requested_workspace() {
    let registry = AgentRegistry::new();
    let review_workspace = PathBuf::from("review-workspace");
    let ordinary_workspace = PathBuf::from("ordinary-workspace");
    let agent_id = "SharedProjectAgent";

    registry.write_project_subagents().insert(
        review_workspace.clone(),
        HashMap::from([(
            agent_id.to_string(),
            test_project_custom_entry(agent_id, true),
        )]),
    );
    registry.write_project_subagents().insert(
        ordinary_workspace.clone(),
        HashMap::from([(
            agent_id.to_string(),
            test_project_custom_entry(agent_id, false),
        )]),
    );

    assert_eq!(
        registry
            .get_subagent_is_review_for_workspace(agent_id, Some(&review_workspace))
            .await,
        Some(true)
    );
    assert_eq!(
        registry
            .get_subagent_is_review_for_workspace(agent_id, Some(&ordinary_workspace))
            .await,
        Some(false)
    );
    assert_eq!(
        registry
            .get_subagent_is_review_for_workspace(agent_id, None)
            .await,
        None,
        "a project agent must not leak into an unrelated workspace lookup"
    );
}

#[tokio::test]
async fn review_lookup_cold_loads_the_requested_project_registry() {
    let env = CustomAgentTestEnv::new("openbitfun-project-review-lookup");
    let registry = AgentRegistry::new();
    let agent_id = "ProjectReviewer";
    write_project_custom_review_subagent(
        &env.workspace_agents_dir.join("project-reviewer.md"),
        agent_id,
    );

    assert_eq!(
        registry
            .get_subagent_is_review_for_workspace(agent_id, Some(&env.workspace_root))
            .await,
        Some(true)
    );
}

#[test]
fn top_level_modes_default_to_auto() {
    for agent_type in [
        "Standard",
        "Cowork",
        "Creative",
        "Claw",
        "DeepResearch",
        "Ultimate",
    ] {
        assert_eq!(default_model_id_for_builtin_agent(agent_type), "primary");
    }
}

#[test]
fn custom_subagent_kind_maps_to_registry_source() {
    assert_eq!(
        subagent_source_from_custom_kind(CustomSubagentKind::Project),
        SubAgentSource::Project
    );
    assert_eq!(
        subagent_source_from_custom_kind(CustomSubagentKind::User),
        SubAgentSource::User
    );
}

#[test]
fn registry_exposes_sdk_agent_ids_without_leaking_core_agent_details() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/project");
    let other_workspace = PathBuf::from("D:/workspace/other");
    insert_project_subagent(&registry, &workspace, "ProjectReviewer", "fast");
    insert_project_subagent(&registry, &other_workspace, "OtherProjectReviewer", "fast");

    let global_agent_ids =
        RuntimeAgentRegistry::agent_ids(&registry, RuntimeAgentRegistryQuery::default());

    assert!(global_agent_ids.contains(&"Standard".to_string()));
    assert!(global_agent_ids.contains(&"Explore".to_string()));
    assert!(!global_agent_ids.contains(&"ProjectReviewer".to_string()));
    assert!(!global_agent_ids.contains(&"OtherProjectReviewer".to_string()));

    let agent_ids = RuntimeAgentRegistry::agent_ids(
        &registry,
        RuntimeAgentRegistryQuery {
            workspace_root: Some(&workspace),
        },
    );

    assert!(agent_ids.contains(&"ProjectReviewer".to_string()));
    assert!(!agent_ids.contains(&"OtherProjectReviewer".to_string()));
    assert_eq!(
        agent_ids,
        {
            let mut sorted = agent_ids.clone();
            sorted.sort();
            sorted.dedup();
            sorted
        },
        "SDK agent registry projection must be stable and deduplicated"
    );
}

#[tokio::test]
async fn computer_use_is_builtin_subagent_not_mode() {
    let registry = AgentRegistry::new();
    let modes = registry.get_modes_info().await;
    assert!(
        !modes.iter().any(|agent| agent.id == "ComputerUse"),
        "ComputerUse should be delegated through Task as a built-in sub-agent, not exposed as a top-level mode"
    );

    let subagents = registry.get_subagents_info(None).await;
    let computer_use = subagents
        .iter()
        .find(|agent| agent.id == "ComputerUse")
        .expect("ComputerUse should be registered as a built-in sub-agent");
    assert!(computer_use
        .default_tools
        .contains(&"ControlHub".to_string()));
    assert!(computer_use
        .default_tools
        .contains(&"ComputerUse".to_string()));
    assert_eq!(
        computer_use.visibility.as_ref().map(|value| value.exposure),
        Some(BuiltinSubagentExposure::Restricted)
    );
}

#[test]
fn every_builtin_standard_mode_defaults_to_the_thread_goal_lifecycle() {
    for spec in builtin_agent_specs()
        .iter()
        .filter(|spec| spec.category == AgentCategory::Mode)
    {
        let mode = (spec.factory)();
        if matches!(mode.id(), "Minimal" | "Ultimate") {
            continue;
        }
        let default_tools = mode.default_tools();
        for tool_name in THREAD_GOAL_TOOL_NAMES {
            assert!(
                default_tools.iter().any(|tool| tool == tool_name),
                "builtin primary mode {} is missing {}",
                mode.id(),
                tool_name
            );
        }
    }
}

#[test]
fn creation_tools_default_only_to_creative_mode() {
    const CREATION_TOOLS: &[&str] = &[
        "InitMiniApp",
        "FinalizeMiniApp",
        "PublishMiniApp",
        "FrontendWorkbench",
    ];

    for spec in builtin_agent_specs()
        .iter()
        .filter(|spec| spec.category == AgentCategory::Mode)
    {
        let mode = (spec.factory)();
        let default_tools = mode.default_tools();
        for tool_name in CREATION_TOOLS {
            assert_eq!(
                default_tools.iter().any(|tool| tool == tool_name),
                mode.id() == "Creative",
                "creation tool {tool_name} has unexpected default exposure in {}",
                mode.id()
            );
        }
    }
}

#[test]
fn every_builtin_mode_with_control_hub_can_also_schedule_with_cron() {
    // ControlHub's `wait` documentation tells the agent to schedule anything
    // repeating — or further out than an hour — with Cron instead of holding
    // the turn open. A mode that offers one without the other sends the agent
    // after a tool that is not in its list; Cowork answered a "check every 30
    // minutes" request with "I have no cron tool" for exactly this reason.
    for spec in builtin_agent_specs()
        .iter()
        .filter(|spec| spec.category == AgentCategory::Mode)
    {
        let mode = (spec.factory)();
        let default_tools = mode.default_tools();
        if !default_tools.iter().any(|tool| tool == "ControlHub") {
            continue;
        }
        assert!(
            default_tools.iter().any(|tool| tool == "Cron"),
            "builtin mode {} offers ControlHub but cannot schedule with Cron",
            mode.id()
        );
    }
}

#[test]
fn builtin_modes_carrying_the_environment_tools_can_forward_a_port_they_opened() {
    // The allowlist is what the deferred catalog is built from, so a tool
    // missing here is invisible to the model however it is registered — the
    // Agent then reinvents the feature as hand-written `ssh -L` instructions
    // for the user to run.
    //
    // Cron is the marker for "carries the environment-control set" rather than
    // ExecCommand, which even the deliberately narrow modes have: `minimal` is
    // a fixed six-tool manifest and `Ultra` is a planner whose workers do the
    // running, and neither carries Git or Cron either.
    for spec in builtin_agent_specs()
        .into_iter()
        .filter(|spec| spec.category == AgentCategory::Mode)
    {
        let mode = (spec.factory)();
        let default_tools = mode.default_tools();
        let runs_commands = default_tools.iter().any(|tool| tool == "ExecCommand");
        let schedules = default_tools.iter().any(|tool| tool == "Cron");
        if !(runs_commands && schedules) {
            continue;
        }
        assert!(
            default_tools.iter().any(|tool| tool == "PortForward"),
            "builtin mode {} can run commands but cannot forward a port it opened",
            mode.id()
        );
    }
}

#[test]
fn agent_list_and_delete_are_exposed_only_to_swarm_planners() {
    for spec in builtin_agent_specs() {
        let agent = (spec.factory)();
        let has_list = agent.default_tools().iter().any(|tool| tool == "AgentList");
        let has_delete = agent
            .default_tools()
            .iter()
            .any(|tool| tool == "AgentDelete");
        let should_have_controls = matches!(agent.id(), "Ultimate" | "SwarmPlanner");
        assert_eq!(
            has_list,
            should_have_controls,
            "unexpected AgentList exposure for {}",
            agent.id()
        );
        assert_eq!(
            has_delete,
            should_have_controls,
            "unexpected AgentDelete exposure for {}",
            agent.id()
        );
    }
}

#[test]
fn skill_tool_is_exposed_only_to_ultra_and_swarm_worker_within_the_swarm_catalog() {
    for spec in builtin_agent_specs() {
        let agent = (spec.factory)();
        if !matches!(
            agent.id(),
            "Ultimate" | "SwarmPlanner" | "SwarmWorker" | "SwarmReviewer"
        ) {
            continue;
        }
        assert_eq!(
            agent.default_tools().iter().any(|tool| tool == "Skill"),
            matches!(agent.id(), "Ultimate" | "SwarmWorker"),
            "unexpected Skill exposure for {}",
            agent.id()
        );
    }
}

#[test]
fn non_deep_review_builtin_subagents_default_to_primary() {
    for agent_type in [
        "Explore",
        "CodeReview",
        "GeneralPurpose",
        "MemoryPhase2",
        "SwarmPlanner",
        "SwarmWorker",
    ] {
        assert_eq!(
            default_model_id_for_builtin_agent(agent_type),
            "primary",
            "{agent_type} should default to the primary model slot"
        );
    }
}

#[test]
fn memory_phase2_hidden_agent_is_registered() {
    let registry = AgentRegistry::new();
    let agent = registry
        .get_agent("MemoryPhase2", None)
        .expect("MemoryPhase2 should be registered as a hidden built-in agent");

    assert_eq!(agent.id(), "MemoryPhase2");
    assert_eq!(agent.name(), "Memory Phase 2");
}

#[test]
fn sdk_agent_registry_excludes_desktop_product_workflows() {
    let registry =
        AgentRegistry::for_profile(openbitfun_product_capabilities::DeliveryProfile::Sdk);
    let plan = openbitfun_product_capabilities::product_assembly_plan_for_profile(
        openbitfun_product_capabilities::DeliveryProfile::Sdk,
    );

    for product_agent in [
        "DeepResearch",
        "ResearchSpecialist",
        "DeepReview",
        "CodeReview",
        "ReviewWorker",
        "ReviewJudge",
        "ReviewFixer",
    ] {
        assert!(
            !registry.check_agent_exists(product_agent),
            "SDK registry must not contain {product_agent}"
        );
    }
    for code_agent in plan.agent_ids() {
        assert!(
            registry.check_agent_exists(code_agent),
            "SDK registry must contain {code_agent}"
        );
    }
}

#[test]
fn product_full_agent_registry_preserves_the_complete_builtin_catalog() {
    let mut selected =
        AgentRegistry::for_profile(openbitfun_product_capabilities::DeliveryProfile::ProductFull)
            .agent_ids(RuntimeAgentRegistryQuery::default());
    let mut compatibility = AgentRegistry::new().agent_ids(RuntimeAgentRegistryQuery::default());
    selected.sort();
    compatibility.sort();

    assert_eq!(selected, compatibility);
}

#[test]
fn generate_doc_hidden_agent_defaults_to_fast() {
    assert_eq!(default_model_id_for_builtin_agent("GenerateDoc"), "fast");
}

#[test]
fn deep_review_family_defaults_to_fast() {
    for agent_type in [
        "DeepReview",
        "ReviewWorker",
        "ReviewGeneral",
        "ReviewBusinessLogic",
        "ReviewPerformance",
        "ReviewSecurity",
        "ReviewArchitecture",
        "ReviewFrontend",
        "ReviewJudge",
        "ReviewFixer",
        "SwarmReviewer",
    ] {
        assert_eq!(
            default_model_id_for_builtin_agent(agent_type),
            "fast",
            "{agent_type} should stay on the fast model slot"
        );
    }
}

#[tokio::test]
async fn dynamic_reviewer_is_registered_as_review_subagent() {
    let registry = AgentRegistry::new();
    let subagents = registry.get_subagents_info(None).await;
    let worker = subagents
        .iter()
        .find(|agent| agent.id == "ReviewWorker")
        .expect("ReviewWorker should be registered as a subagent");

    assert!(worker.is_review);
    assert!(worker.is_readonly);
}

#[test]
fn built_in_readonly_reviewers_are_marked_as_review_agents() {
    let registry = AgentRegistry::new();

    for agent_type in [
        "ReviewWorker",
        "ReviewGeneral",
        "ReviewBusinessLogic",
        "ReviewPerformance",
        "ReviewSecurity",
        "ReviewArchitecture",
        "ReviewFrontend",
        "ReviewJudge",
        "CodeReview",
    ] {
        assert_eq!(
            registry.get_subagent_is_review(agent_type),
            Some(true),
            "{agent_type} must pass DeepReview Task policy validation"
        );
    }
}

#[test]
fn historical_reviewer_invocations_bind_to_the_current_worker_runtime() {
    let registry = AgentRegistry::new();
    let binding = registry
        .resolve_subagent_for_fresh_invocation("ReviewSecurity", None, false)
        .expect("the historical reviewer alias should resolve");

    assert_eq!(binding.logical_id, "ReviewSecurity");
    assert_eq!(binding.runtime_agent_key, "ReviewWorker");
}

#[tokio::test]
async fn task_visible_subagents_are_filtered_by_parent_agent() {
    let registry = AgentRegistry::new();

    let agentic_visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Standard"),
            workspace_root: None,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    assert!(agentic_visible.iter().any(|agent| agent.id == "Explore"));
    assert!(agentic_visible
        .iter()
        .any(|agent| agent.id == "GeneralPurpose"));
    let code_review = agentic_visible
        .iter()
        .find(|agent| agent.id == "CodeReview")
        .expect("CodeReview should be available as an isolated review task");
    assert!(code_review.is_review);
    assert!(code_review.is_readonly);
    assert!(!agentic_visible
        .iter()
        .any(|agent| agent.id == "ReviewSecurity"));
    assert!(!agentic_visible
        .iter()
        .any(|agent| agent.id == "ResearchSpecialist"));

    let deep_review_visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("DeepReview"),
            workspace_root: None,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    assert!(deep_review_visible
        .iter()
        .any(|agent| agent.id == "ReviewWorker"));
    assert!(!deep_review_visible
        .iter()
        .any(|agent| agent.id == "ReviewSecurity"));
    assert!(!deep_review_visible
        .iter()
        .any(|agent| agent.id == "ResearchSpecialist"));

    let deep_research_visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("DeepResearch"),
            workspace_root: None,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    assert!(deep_research_visible
        .iter()
        .any(|agent| agent.id == "ResearchSpecialist"));
    assert!(!deep_research_visible
        .iter()
        .any(|agent| agent.id == "ReviewWorker"));

    let ultra_visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Ultimate"),
            workspace_root: None,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    for swarm_id in ["SwarmPlanner", "SwarmWorker", "SwarmReviewer"] {
        assert!(ultra_visible.iter().any(|agent| agent.id == swarm_id));
    }
    assert_eq!(ultra_visible.len(), 3);
    assert!(!ultra_visible
        .iter()
        .any(|agent| agent.id == "GeneralPurpose"));

    let planner_visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("SwarmPlanner"),
            workspace_root: None,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    assert_eq!(planner_visible.len(), 3);
    for swarm_id in ["SwarmPlanner", "SwarmWorker", "SwarmReviewer"] {
        assert!(planner_visible.iter().any(|agent| agent.id == swarm_id));
    }
}

#[test]
fn merge_dynamic_mcp_tools_appends_registered_mcp_tools_once() {
    let configured_tools = vec!["Read".to_string(), "ExecCommand".to_string()];
    let registered_tool_names = vec![
        "Read".to_string(),
        "mcp__notion__notion-search".to_string(),
        "mcp__github__list_issues".to_string(),
        "mcp__notion__notion-search".to_string(),
    ];

    let merged = merge_dynamic_mcp_tools(configured_tools, &registered_tool_names);

    assert_eq!(
        merged,
        vec![
            "Read".to_string(),
            "ExecCommand".to_string(),
            "mcp__notion__notion-search".to_string(),
            "mcp__github__list_issues".to_string(),
        ]
    );
}

#[test]
fn project_subagent_config_lookup_is_workspace_scoped() {
    let registry = AgentRegistry::new();
    let workspace_a = PathBuf::from("D:/workspace/project-a");
    let workspace_b = PathBuf::from("D:/workspace/project-b");
    insert_project_subagent(&registry, &workspace_a, "SharedReviewer", "fast");
    insert_project_subagent(&registry, &workspace_b, "SharedReviewer", "primary");

    assert_eq!(
        registry
            .get_custom_subagent_config("SharedReviewer", Some(&workspace_a))
            .expect("workspace A config")
            .model,
        "fast"
    );
    assert_eq!(
        registry
            .get_custom_subagent_config("SharedReviewer", Some(&workspace_b))
            .expect("workspace B config")
            .model,
        "primary"
    );
    assert!(
        registry
            .get_custom_subagent_config("SharedReviewer", None)
            .is_none(),
        "unscoped lookup must not pick an arbitrary project subagent"
    );
    assert!(registry.has_project_custom_subagent("SharedReviewer"));
}

#[tokio::test]
async fn prompt_stability_task_visible_subagents_are_sorted_deterministically() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/project-c");

    registry.register_agent(
        Arc::new(TestAgent {
            id: "zBuiltin".to_string(),
        }),
        AgentCategory::SubAgent,
        AgentSource::Builtin,
        Some(SubAgentSource::Builtin),
        None,
    );
    registry.register_agent(
        Arc::new(TestAgent {
            id: "ABuiltin".to_string(),
        }),
        AgentCategory::SubAgent,
        AgentSource::Builtin,
        Some(SubAgentSource::Builtin),
        None,
    );

    let mut project_entries = HashMap::new();
    project_entries.insert(
        "zProject".to_string(),
        test_project_entry("zProject", "fast"),
    );
    project_entries.insert(
        "AProject".to_string(),
        test_project_entry("AProject", "fast"),
    );
    registry
        .write_project_subagents()
        .insert(workspace.clone(), project_entries);

    registry.register_agent(
        Arc::new(TestAgent {
            id: "zUser".to_string(),
        }),
        AgentCategory::SubAgent,
        AgentSource::User,
        Some(SubAgentSource::User),
        Some(CustomSubagentConfig {
            model: "fast".to_string(),
            model_is_explicit: true,
        }),
    );
    registry.register_agent(
        Arc::new(TestAgent {
            id: "AUser".to_string(),
        }),
        AgentCategory::SubAgent,
        AgentSource::User,
        Some(SubAgentSource::User),
        Some(CustomSubagentConfig {
            model: "fast".to_string(),
            model_is_explicit: true,
        }),
    );
    registry.set_user_custom_agents_loaded(true);

    let visible = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: None,
            workspace_root: Some(&workspace),
            list_scope: SubagentListScope::RegistryManagement,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;

    let ids: Vec<&str> = visible.iter().map(|agent| agent.id.as_str()).collect();
    let expected = vec![
        "ABuiltin",
        "Explore",
        "GeneralPurpose",
        "zBuiltin",
        "AProject",
        "zProject",
        "AUser",
        "zUser",
    ];

    assert_eq!(ids, expected);
}

#[tokio::test]
async fn parent_subagent_overrides_follow_source_scopes() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("__test_workspace__/project-d");

    registry.register_agent(
        Arc::new(CustomSubagent::new(
            "UserScout".to_string(),
            "User scout".to_string(),
            vec!["Read".to_string()],
            "prompt".to_string(),
            true,
            "user-scout.md".to_string(),
            CustomSubagentKind::User,
        )),
        AgentCategory::SubAgent,
        AgentSource::User,
        Some(SubAgentSource::User),
        Some(CustomSubagentConfig {
            model: "fast".to_string(),
            model_is_explicit: true,
        }),
    );
    registry.set_user_custom_agents_loaded(true);

    let mut project_entries = HashMap::new();
    project_entries.insert(
        "ProjectScout".to_string(),
        AgentEntry {
            category: AgentCategory::SubAgent,
            source: AgentSource::Project,
            subagent_source: Some(SubAgentSource::Project),
            agent: Arc::new(CustomSubagent::new(
                "ProjectScout".to_string(),
                "Project scout".to_string(),
                vec!["Read".to_string()],
                "prompt".to_string(),
                true,
                "project-scout.md".to_string(),
                CustomSubagentKind::Project,
            )),
            visibility_policy: SubagentVisibilityPolicy::public(),
            custom_config: Some(CustomSubagentConfig {
                model: "fast".to_string(),
                model_is_explicit: true,
            }),
        },
    );
    registry
        .write_project_subagents()
        .insert(workspace.clone(), project_entries);

    let builtin_query = SubagentQueryContext {
        parent_agent_type: Some("Standard"),
        workspace_root: Some(&workspace),
        list_scope: SubagentListScope::RegistryManagement,
        include_disabled: true,
        external_sources_supported: false,
    };

    let project_override_key = "project::openbitfun::ProjectScout".to_string();
    let user_override_key = "user::openbitfun::UserScout".to_string();
    let builtin_override_key = "builtin::builtin::Explore".to_string();

    let mut project_parent_map = HashMap::new();
    project_parent_map.insert(
        project_override_key.clone(),
        AgentSubagentOverrideState::Disabled,
    );
    project_parent_map.insert(
        user_override_key.clone(),
        AgentSubagentOverrideState::Disabled,
    );
    project_parent_map.insert(
        builtin_override_key.clone(),
        AgentSubagentOverrideState::Disabled,
    );
    let mut project_overrides = HashMap::new();
    project_overrides.insert(
        resolve_mode_config_profile_id("Standard").into_owned(),
        project_parent_map,
    );

    let mut user_parent_map = HashMap::new();
    user_parent_map.insert(
        project_override_key.clone(),
        AgentSubagentOverrideState::Enabled,
    );
    user_parent_map.insert(user_override_key, AgentSubagentOverrideState::Disabled);
    user_parent_map.insert(builtin_override_key, AgentSubagentOverrideState::Disabled);
    let mut user_overrides = HashMap::new();
    user_overrides.insert(
        resolve_mode_config_profile_id("Standard").into_owned(),
        user_parent_map,
    );

    let visible = {
        use crate::agentic::agents::registry::availability::resolve_availability;

        let explore = registry
            .find_agent_entry("Explore", Some(&workspace))
            .expect("builtin entry");
        let user = registry
            .find_agent_entry("UserScout", Some(&workspace))
            .expect("user entry");
        let project = registry
            .find_agent_entry("ProjectScout", Some(&workspace))
            .expect("project entry");

        (
            resolve_availability(
                &explore,
                builtin_query.parent_agent_type,
                Some(&project_overrides),
                &user_overrides,
            ),
            resolve_availability(
                &user,
                builtin_query.parent_agent_type,
                Some(&project_overrides),
                &user_overrides,
            ),
            resolve_availability(
                &project,
                builtin_query.parent_agent_type,
                Some(&project_overrides),
                &user_overrides,
            ),
        )
    };

    assert_eq!(
        visible.0.override_state,
        Some(SubagentOverrideState::Disabled)
    );
    assert_eq!(
        visible.1.override_state,
        Some(SubagentOverrideState::Disabled)
    );
    assert_eq!(
        visible.2.override_state,
        Some(SubagentOverrideState::Disabled)
    );
}

#[tokio::test]
async fn explicit_custom_mode_load_exposes_user_mode_metadata_in_modes_info() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-load");
    let registry = AgentRegistry::new();
    let mode_path = env.user_agents_dir.join("planner-plus.md");
    write_user_custom_mode(
        &mode_path,
        "PlannerPlus",
        "Planner Plus",
        vec!["Read".to_string(), "Grep".to_string()],
        UserContextPolicy::empty().with_workspace_instructions(),
        "primary",
        true,
    );

    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;

    let mode = registry
        .get_modes_info()
        .await
        .into_iter()
        .find(|agent| agent.id == "PlannerPlus")
        .expect("custom mode should be present in modes info");

    assert_eq!(mode.source, AgentSource::User);
    assert_eq!(mode.path, Some(mode_path.to_string_lossy().to_string()));
    assert_eq!(mode.model, Some("primary".to_string()));
    assert!(mode.default_tools.contains(&"Read".to_string()));
    assert!(mode.default_tools.contains(&"Grep".to_string()));
    assert!(mode.is_readonly);
}

#[tokio::test]
async fn custom_mode_does_not_appear_in_subagent_list() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-separation");
    let registry = AgentRegistry::new();
    write_user_custom_mode(
        &env.user_agents_dir.join("planner-plus.md"),
        "PlannerPlus",
        "Planner Plus",
        vec!["Read".to_string()],
        UserContextPolicy::empty().with_workspace_instructions(),
        "primary",
        false,
    );
    write_user_custom_subagent(&env.user_agents_dir.join("helper.md"), "Helper");

    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;

    let subagents = registry.get_subagents_info(None).await;
    assert!(!subagents.iter().any(|agent| agent.id == "PlannerPlus"));
    assert!(subagents.iter().any(|agent| agent.id == "Helper"));
}

#[tokio::test]
async fn project_scoped_custom_mode_is_skipped_while_project_subagent_loads() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-project");
    let registry = AgentRegistry::new();
    let workspace_root = env.workspace_root.clone();

    write_project_custom_mode(
        &env.workspace_agents_dir.join("project-mode.md"),
        "ProjectPlanner",
    );
    write_project_custom_subagent(
        &env.workspace_agents_dir.join("project-helper.md"),
        "ProjectHelper",
    );

    registry
        .load_custom_agents_from_test_roots(
            Some(&workspace_root),
            &env.discovery_roots(Some(workspace_root.clone())),
        )
        .await;

    let modes = registry.get_modes_info().await;
    let subagents = registry.get_subagents_info(Some(&workspace_root)).await;

    assert!(!modes.iter().any(|agent| agent.id == "ProjectPlanner"));
    assert!(subagents.iter().any(|agent| agent.id == "ProjectHelper"));
}

#[tokio::test]
async fn custom_mode_detail_reports_kind_level_model_path_and_policy() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-detail");
    let registry = AgentRegistry::new();
    let mode_path = env.user_agents_dir.join("planner-plus.md");
    write_user_custom_mode(
        &mode_path,
        "PlannerPlus",
        "Planner Plus",
        vec!["Read".to_string(), "Grep".to_string()],
        UserContextPolicy::empty().with_workspace_instructions(),
        "primary",
        true,
    );

    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;

    let detail = registry
        .get_custom_agent_detail("PlannerPlus", None)
        .await
        .expect("custom mode detail should load");

    assert_eq!(detail.kind, "mode");
    assert_eq!(detail.level, "user");
    assert_eq!(detail.model, "primary");
    assert_eq!(detail.path, mode_path.to_string_lossy().to_string());
    assert_eq!(
        detail.user_context_policy,
        vec!["workspace_instructions".to_string()]
    );
    assert_eq!(detail.tools, vec!["Read".to_string(), "Grep".to_string()]);
    assert!(detail.readonly);
    assert!(!detail.review);
}

#[tokio::test]
async fn updating_custom_mode_model_persists_and_keeps_mode_category() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-update-model");
    let registry = AgentRegistry::new();
    let mode_path = env.user_agents_dir.join("planner-plus.md");
    write_user_custom_mode(
        &mode_path,
        "PlannerPlus",
        "Planner Plus",
        vec!["Read".to_string()],
        UserContextPolicy::empty().with_workspace_instructions(),
        "primary",
        false,
    );

    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;
    registry
        .update_and_save_custom_agent_config("PlannerPlus", Some("fast".to_string()), false, None)
        .expect("mode model update should save");

    let mode = registry
        .get_modes_info()
        .await
        .into_iter()
        .find(|agent| agent.id == "PlannerPlus")
        .expect("updated mode should still be present");
    let saved = std::fs::read_to_string(&mode_path).expect("updated mode file should be readable");

    assert_eq!(mode.model, Some("fast".to_string()));
    assert_eq!(mode.source, AgentSource::User);
    assert!(registry.get_mode_agent("PlannerPlus").is_some());
    assert!(!registry
        .get_subagents_info(None)
        .await
        .iter()
        .any(|agent| agent.id == "PlannerPlus"));
    assert!(saved.contains("kind: mode"));
    assert!(saved.contains("model: fast"));
}

#[tokio::test]
async fn updating_custom_mode_definition_rewrites_file_and_preserves_mode_kind() {
    let env = CustomAgentTestEnv::new("openbitfun-custom-mode-registry-update-definition");
    let registry = AgentRegistry::new();
    let mode_path = env.user_agents_dir.join("planner-plus.md");
    write_user_custom_mode(
        &mode_path,
        "PlannerPlus",
        "Planner Plus",
        vec!["Read".to_string()],
        UserContextPolicy::empty().with_workspace_instructions(),
        "primary",
        false,
    );

    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;
    registry
        .update_custom_agent_definition(
            "PlannerPlus",
            None,
            "Planner Pro".to_string(),
            "Updated planning mode".to_string(),
            "Always explain your plan first.".to_string(),
            Some(vec!["Read".to_string(), "Grep".to_string()]),
            Some(true),
            None,
            Some(UserContextPolicy::empty().with_workspace_context()),
            Some("fast".to_string()),
        )
        .await
        .expect("mode definition update should save");

    let detail = registry
        .get_custom_agent_detail("PlannerPlus", None)
        .await
        .expect("updated mode detail should load");
    let saved = std::fs::read_to_string(&mode_path).expect("updated mode file should be readable");

    assert_eq!(detail.kind, "mode");
    assert_eq!(detail.name, "Planner Pro");
    assert_eq!(detail.description, "Updated planning mode");
    assert_eq!(detail.prompt, "Always explain your plan first.");
    assert_eq!(detail.model, "fast");
    assert_eq!(detail.tools, vec!["Read".to_string(), "Grep".to_string()]);
    assert_eq!(
        detail.user_context_policy,
        vec!["workspace_context".to_string()]
    );
    assert!(saved.contains("kind: mode"));
    assert!(saved.contains("name: Planner Pro"));
    assert!(saved.contains("model: fast"));
    assert!(saved.contains("- workspace_context"));
}

#[tokio::test]
async fn user_agent_queries_refresh_after_file_changes() {
    let env = CustomAgentTestEnv::new("agent-watch");
    std::fs::remove_dir(&env.user_agents_dir).unwrap();
    let registry = AgentRegistry::new();
    registry
        .load_custom_agents_from_test_roots(None, &env.discovery_roots(None))
        .await;
    std::fs::create_dir_all(&env.user_agents_dir).unwrap();
    let path = env.user_agents_dir.join("watched.md");
    let write_mode = |name: &str| {
        write_user_custom_mode(
            &path,
            "watched",
            name,
            vec!["Read".into()],
            UserContextPolicy::default(),
            "primary",
            false,
        )
    };
    write_mode("First");
    wait_for_watched_mode(&registry, Some("First")).await;
    write_mode("Updated");
    wait_for_watched_mode(&registry, Some("Updated")).await;
    std::fs::remove_file(&path).unwrap();
    wait_for_watched_mode(&registry, None).await;
    let replacement = env.root.join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    write_user_custom_mode(
        &replacement.join("watched.md"),
        "watched",
        "Replacement",
        vec!["Read".into()],
        UserContextPolicy::default(),
        "primary",
        false,
    );
    std::fs::remove_dir(&env.user_agents_dir).unwrap();
    std::fs::rename(replacement, &env.user_agents_dir).unwrap();
    wait_for_watched_mode(&registry, Some("Replacement")).await;
    write_mode("After replacement");
    wait_for_watched_mode(&registry, Some("After replacement")).await;
}

async fn wait_for_watched_mode(registry: &AgentRegistry, expected: Option<&str>) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let modes = registry.get_modes_info_for_workspace(None, false).await;
            let name = modes
                .iter()
                .find(|mode| mode.id == "watched")
                .map(|mode| mode.name.as_str());
            if name == expected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("mode queries should observe user agent file changes");
}

struct CustomAgentTestEnv {
    root: PathBuf,
    workspace_root: PathBuf,
    workspace_agents_dir: PathBuf,
    user_agents_dir: PathBuf,
}

impl CustomAgentTestEnv {
    fn new(prefix: &str) -> Self {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", unique_suffix()));
        let workspace_root = root.join("workspace");
        let workspace_agents_dir = workspace_root.join(".openbitfun").join("agents");
        let user_agents_dir = root.join("user-root").join("agents");
        std::fs::create_dir_all(&workspace_agents_dir)
            .expect("workspace agents dir should be created");
        std::fs::create_dir_all(&user_agents_dir).expect("user agents dir should be created");

        Self {
            root,
            workspace_root,
            workspace_agents_dir,
            user_agents_dir,
        }
    }

    fn discovery_roots(&self, workspace_root: Option<PathBuf>) -> CustomAgentDiscoveryRoots {
        CustomAgentDiscoveryRoots {
            workspace_root,
            openbitfun_user_agents_dir: Some(self.user_agents_dir.clone()),
            home_dir: None,
        }
    }
}

impl Drop for CustomAgentTestEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_user_custom_mode(
    path: &Path,
    id: &str,
    name: &str,
    tools: Vec<String>,
    user_context_policy: UserContextPolicy,
    model: &str,
    readonly: bool,
) {
    let mode = CustomMode::new(
        id.to_string(),
        name.to_string(),
        "User-defined custom mode".to_string(),
        tools,
        "Act as a focused project specialist.".to_string(),
        readonly,
        path.to_string_lossy().to_string(),
        model.to_string(),
        user_context_policy,
    );
    mode.save_to_file(None)
        .expect("custom mode markdown should save");
}

fn write_project_custom_mode(path: &Path, id: &str) {
    let definition = CustomAgentDefinition::from_front_matter_fields(
        Some(id),
        Some(id),
        Some("Project custom mode"),
        Some(CustomAgentKind::Mode),
        None,
        None,
        None,
        None,
        None,
        "Project-scoped modes should be rejected.".to_string(),
        CustomAgentLevel::Project,
    )
    .expect("project mode definition should be valid")
    .definition;
    custom_agent_save_markdown_file(path, &definition).expect("project mode markdown should save");
}

fn write_user_custom_subagent(path: &Path, id: &str) {
    let subagent = CustomSubagent::new_with_id(
        id.to_string(),
        id.to_string(),
        "User helper subagent".to_string(),
        vec!["Read".to_string()],
        "Investigate the relevant files.".to_string(),
        true,
        path.to_string_lossy().to_string(),
        CustomSubagentKind::User,
        "fast".to_string(),
        UserContextPolicy::empty().with_workspace_instructions(),
    );
    subagent
        .save_to_file(None)
        .expect("custom subagent markdown should save");
}

fn write_project_custom_subagent(path: &Path, id: &str) {
    let subagent = CustomSubagent::new_with_id(
        id.to_string(),
        id.to_string(),
        "Project helper subagent".to_string(),
        vec!["Read".to_string()],
        "Investigate the relevant files.".to_string(),
        true,
        path.to_string_lossy().to_string(),
        CustomSubagentKind::Project,
        "fast".to_string(),
        UserContextPolicy::empty().with_workspace_instructions(),
    );
    subagent
        .save_to_file(None)
        .expect("project subagent markdown should save");
}

fn write_project_custom_review_subagent(path: &Path, id: &str) {
    let mut subagent = CustomSubagent::new_with_id(
        id.to_string(),
        id.to_string(),
        "Project review subagent".to_string(),
        vec!["Read".to_string()],
        "Review the relevant files.".to_string(),
        true,
        path.to_string_lossy().to_string(),
        CustomSubagentKind::Project,
        "fast".to_string(),
        UserContextPolicy::empty().with_workspace_instructions(),
    );
    subagent.data.review = true;
    subagent
        .save_to_file(None)
        .expect("project review subagent markdown should save");
}

fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after UNIX epoch")
        .as_nanos()
        .to_string()
}

#[tokio::test]
async fn external_routes_are_workspace_scoped_fail_closed_and_generation_leased() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("C:/workspace/external-agent-registry");
    let runtime_v1 = "external::candidate::behavior-v1";
    let agent_v1: Arc<dyn Agent> = Arc::new(TestAgent {
        id: runtime_v1.to_string(),
    });
    registry.install_external_subagent_routes(
        &workspace,
        vec![ExternalSubagentRegistration {
            runtime_key: runtime_v1.to_string(),
            logical_id: "Explore".to_string(),
            route_key: "opencode:test:explore".to_string(),
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            provider_label: "OpenCode".to_string(),
            model_binding: super::ExternalSubagentModelBinding::Fixed {
                model_id: "inherit".to_string(),
                configuration_fingerprint: "model-config-v1".to_string(),
            },
            hidden: false,
            mode: ExternalSubagentMode::All,
            agent: agent_v1,
        }],
        [(
            "explore".to_string(),
            ExternalSubagentRoute::External(runtime_v1.to_string()),
        )]
        .into_iter()
        .collect(),
    );

    let local_only = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Standard"),
            workspace_root: Some(&workspace),
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        })
        .await;
    assert!(local_only
        .iter()
        .any(|agent| { agent.id == "Explore" && agent.source == AgentSource::Builtin }));

    let external = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Standard"),
            workspace_root: Some(&workspace),
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: true,
        })
        .await;
    let projected = external
        .iter()
        .find(|agent| agent.id == "Explore")
        .expect("external route replaces the same-name local projection");
    assert_eq!(projected.source, AgentSource::External);
    assert_eq!(
        projected.external_provider_label.as_deref(),
        Some("OpenCode")
    );
    assert_eq!(projected.model.as_deref(), Some("inherit"));
    assert_eq!(projected.model_is_explicit, Some(true));
    assert!(!projected.supports_follow_up);
    let primary_modes = registry
        .get_modes_info_for_workspace(Some(&workspace), true)
        .await;
    let primary = primary_modes
        .iter()
        .find(|agent| agent.id == "Explore")
        .expect("an all-role external definition is also projected as a main agent");
    assert_eq!(primary.source, AgentSource::External);
    assert!(primary.supports_follow_up);
    let primary_binding = registry
        .resolve_primary_agent_for_turn("Explore", Some(&workspace), true, None)
        .expect("the logical main-agent id resolves to an immutable generation");
    assert_eq!(primary_binding.runtime_agent_key, runtime_v1);
    assert_eq!(
        primary_binding.route_owner,
        openbitfun_core_types::SessionAgentRouteOwner::External
    );
    drop(primary_binding);
    assert!(registry.is_external_subagent_route("Explore", Some(&workspace)));
    assert!(registry.is_external_subagent_route("EXPLORE", Some(&workspace)));
    assert!(!registry.is_external_subagent_route("Explore", None));
    assert!(!registry.is_external_subagent_route("Explore", Some(Path::new("C:/workspace/other"))));
    assert!(registry
        .resolve_external_subagent_for_fresh_invocation(
            "Explore",
            &EcosystemId::new("claude-code").unwrap(),
            Some(&workspace),
        )
        .is_none());
    assert!(registry
        .resolve_external_subagent_for_fresh_invocation(
            "Explore",
            &EcosystemId::new("opencode").unwrap(),
            None,
        )
        .is_none());
    let command_binding = registry
        .resolve_external_subagent_for_fresh_invocation(
            "Explore",
            &EcosystemId::new("opencode").unwrap(),
            Some(&workspace),
        )
        .expect("command delegation resolves only the exact external ecosystem route");
    assert_eq!(command_binding.runtime_agent_key, runtime_v1);
    drop(command_binding);

    let binding = registry
        .resolve_subagent_for_fresh_invocation("Explore", Some(&workspace), true)
        .expect("external invocation binding");
    assert_eq!(binding.runtime_agent_key, runtime_v1);
    assert!(!binding.supports_follow_up);
    let leased_model = binding
        .lease
        .as_ref()
        .expect("external binding keeps a generation lease")
        .model_binding();
    assert_eq!(leased_model.fixed_model_id(), Some("inherit"));
    assert_eq!(
        leased_model.configuration_fingerprint(),
        Some("model-config-v1")
    );

    let runtime_v2 = "external::candidate::behavior-v2";
    let agent_v2: Arc<dyn Agent> = Arc::new(TestAgent {
        id: runtime_v2.to_string(),
    });
    registry.install_external_subagent_routes(
        &workspace,
        vec![ExternalSubagentRegistration {
            runtime_key: runtime_v2.to_string(),
            logical_id: "Explore".to_string(),
            route_key: "opencode:test:explore".to_string(),
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            provider_label: "OpenCode".to_string(),
            model_binding: super::ExternalSubagentModelBinding::Fixed {
                model_id: "inherit".to_string(),
                configuration_fingerprint: "model-config-v2".to_string(),
            },
            hidden: false,
            mode: ExternalSubagentMode::All,
            agent: agent_v2,
        }],
        [(
            "explore".to_string(),
            ExternalSubagentRoute::External(runtime_v2.to_string()),
        )]
        .into_iter()
        .collect(),
    );
    assert!(registry.get_agent(runtime_v1, Some(&workspace)).is_some());
    assert_eq!(
        binding
            .lease
            .as_ref()
            .expect("old generation remains leased")
            .model_binding()
            .configuration_fingerprint(),
        Some("model-config-v1")
    );

    registry.install_external_subagent_routes(
        &workspace,
        Vec::new(),
        [("Explore".to_string(), ExternalSubagentRoute::Unavailable)]
            .into_iter()
            .collect(),
    );
    assert!(registry.get_agent(runtime_v1, Some(&workspace)).is_some());
    assert!(registry.get_agent(runtime_v2, Some(&workspace)).is_none());
    assert!(registry
        .resolve_subagent_for_fresh_invocation("Explore", Some(&workspace), true)
        .is_none());
    assert!(registry.is_external_subagent_route("Explore", Some(&workspace)));
    registry.install_external_subagent_routes(&workspace, Vec::new(), BTreeMap::new());
    assert!(registry
        .resolve_subagent_for_fresh_invocation("Explore", Some(&workspace), true)
        .is_none());
    assert!(registry.is_external_subagent_route("Explore", Some(&workspace)));
    drop(binding);
    assert!(registry.get_agent(runtime_v1, Some(&workspace)).is_none());
}

#[tokio::test]
async fn external_routes_use_one_canonical_workspace_identity_for_all_operations() {
    let registry = AgentRegistry::new();
    let workspace = tempfile::tempdir().expect("workspace");
    let alias_component = workspace.path().join("alias-component");
    std::fs::create_dir(&alias_component).expect("alias component");
    let workspace_alias = alias_component.join("..");
    let runtime_key = "external::canonical-workspace";
    registry.install_external_subagent_routes(
        workspace.path(),
        vec![ExternalSubagentRegistration {
            runtime_key: runtime_key.to_string(),
            logical_id: "canonical-profile".to_string(),
            route_key: "opencode:test:canonical-profile".to_string(),
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            provider_label: "OpenCode".to_string(),
            model_binding: super::ExternalSubagentModelBinding::InheritParent,
            hidden: false,
            mode: ExternalSubagentMode::Primary,
            agent: Arc::new(TestAgent {
                id: runtime_key.to_string(),
            }),
        }],
        [(
            "canonical-profile".to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )]
        .into_iter()
        .collect(),
    );

    assert!(registry.is_external_subagent_route("canonical-profile", Some(&workspace_alias)));
    let binding = registry
        .resolve_primary_agent_for_turn("canonical-profile", Some(&workspace_alias), true, None)
        .expect("alias path should resolve the installed external generation");
    assert_eq!(binding.runtime_agent_key, runtime_key);
    drop(binding);
    let routed_entry = registry
        .find_external_route_entry("canonical-profile", &workspace_alias)
        .expect("model lookup should resolve the logical id through the external route");
    assert_eq!(routed_entry.agent.id(), runtime_key);
    assert_eq!(
        registry
            .get_model_id_for_agent("canonical-profile", Some(&workspace_alias))
            .await
            .expect("external logical id should resolve a model fallback"),
        default_model_id_for_builtin_agent("canonical-profile").to_string()
    );
    assert!(registry
        .get_modes_info_for_workspace(Some(&workspace_alias), true)
        .await
        .iter()
        .any(|agent| agent.id == "canonical-profile"));

    registry.release_external_subagent_workspace(&workspace_alias);
    assert!(!registry.is_external_subagent_route("canonical-profile", Some(workspace.path())));
}

#[test]
fn persisted_external_owner_never_falls_back_to_a_same_name_local_mode() {
    let registry = AgentRegistry::new();

    assert!(registry
        .resolve_primary_agent_for_turn(
            "Standard",
            Some(Path::new("C:/workspace/restarted-external-owner")),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::External),
        )
        .is_none());
    let local = registry
        .resolve_primary_agent_for_turn(
            "Standard",
            Some(Path::new("C:/workspace/legacy-local-owner")),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::Local),
        )
        .expect("legacy local sessions keep their local route");
    assert_eq!(
        local.route_owner,
        openbitfun_core_types::SessionAgentRouteOwner::Local
    );
}

#[tokio::test]
async fn external_agent_role_controls_main_and_task_projection() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("C:/workspace/external-agent-roles");
    let logical_id = "external-role-profile";
    let registration = |runtime_key: &str, mode| ExternalSubagentRegistration {
        runtime_key: runtime_key.to_string(),
        logical_id: logical_id.to_string(),
        route_key: format!("opencode:test:{logical_id}"),
        ecosystem_id: EcosystemId::new("opencode").unwrap(),
        provider_label: "OpenCode".to_string(),
        model_binding: super::ExternalSubagentModelBinding::InheritParent,
        hidden: false,
        mode,
        agent: Arc::new(TestAgent {
            id: runtime_key.to_string(),
        }),
    };
    let route = |runtime_key: &str| {
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )]
        .into_iter()
        .collect()
    };

    registry.install_external_subagent_routes(
        &workspace,
        vec![registration(
            "external::primary",
            ExternalSubagentMode::Primary,
        )],
        route("external::primary"),
    );
    registry
        .get_modes_info_for_workspace(Some(&workspace), true)
        .await
        .into_iter()
        .find(|agent| agent.id == logical_id)
        .expect("external primary projection should be visible");
    assert!(!registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Standard"),
            workspace_root: Some(&workspace),
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: true,
        })
        .await
        .iter()
        .any(|agent| agent.id == logical_id));

    registry.install_external_subagent_routes(
        &workspace,
        vec![registration(
            "external::subagent",
            ExternalSubagentMode::Subagent,
        )],
        route("external::subagent"),
    );
    assert!(!registry
        .get_modes_info_for_workspace(Some(&workspace), true)
        .await
        .iter()
        .any(|agent| agent.id == logical_id));
    let subagent = registry
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: Some("Standard"),
            workspace_root: Some(&workspace),
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: true,
        })
        .await
        .into_iter()
        .find(|agent| agent.id == logical_id)
        .expect("external subagent projection should be visible");
    for tool_name in THREAD_GOAL_TOOL_NAMES {
        assert!(!subagent.default_tools.iter().any(|tool| tool == tool_name));
    }
}

#[test]
fn persisted_primary_route_owner_rejects_same_name_route_takeover() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/owner-takeover");
    let logical_id = "Standard";
    let runtime_key = "external::agentic";
    registry.install_external_subagent_routes(
        &workspace,
        vec![ExternalSubagentRegistration {
            runtime_key: runtime_key.to_string(),
            logical_id: logical_id.to_string(),
            route_key: format!("opencode:test:{logical_id}"),
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            provider_label: "OpenCode".to_string(),
            model_binding: super::ExternalSubagentModelBinding::InheritParent,
            hidden: false,
            mode: ExternalSubagentMode::Primary,
            agent: Arc::new(TestAgent {
                id: runtime_key.to_string(),
            }),
        }],
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )]
        .into_iter()
        .collect(),
    );

    assert!(registry
        .resolve_primary_agent_for_turn(
            logical_id,
            Some(&workspace),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::Local),
        )
        .is_none());

    registry.install_external_subagent_routes(
        &workspace,
        Vec::new(),
        [(logical_id.to_string(), ExternalSubagentRoute::Local)]
            .into_iter()
            .collect(),
    );
    assert!(registry
        .resolve_primary_agent_for_turn(
            logical_id,
            Some(&workspace),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::External),
        )
        .is_none());
}

#[test]
fn validated_generation_replacement_restores_same_name_local_agent() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/plugin-agent-removed");
    let logical_id = "Standard";
    let runtime_key = "external::agentic::generation-1";
    registry.install_external_subagent_routes(
        &workspace,
        vec![ExternalSubagentRegistration {
            runtime_key: runtime_key.to_string(),
            logical_id: logical_id.to_string(),
            route_key: format!("opencode:test:{logical_id}"),
            ecosystem_id: EcosystemId::new("opencode").unwrap(),
            provider_label: "OpenCode".to_string(),
            model_binding: super::ExternalSubagentModelBinding::InheritParent,
            hidden: false,
            mode: ExternalSubagentMode::Primary,
            agent: Arc::new(TestAgent {
                id: runtime_key.to_string(),
            }),
        }],
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )]
        .into_iter()
        .collect(),
    );
    let old_turn = registry
        .resolve_primary_agent_for_turn(logical_id, Some(&workspace), true, None)
        .expect("external generation");
    assert_eq!(old_turn.runtime_agent_key, runtime_key);

    registry.replace_external_subagent_routes(&workspace, Vec::new(), BTreeMap::new());

    let fresh_turn = registry
        .resolve_primary_agent_for_turn(logical_id, Some(&workspace), true, None)
        .expect("same-name local agent");
    assert_eq!(
        fresh_turn.route_owner,
        openbitfun_core_types::SessionAgentRouteOwner::Local
    );
    assert_eq!(fresh_turn.runtime_agent_key, logical_id);
    assert_eq!(old_turn.runtime_agent_key, runtime_key);
}

#[test]
fn route_overlay_overrides_without_replacing_base_external_routes() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/plugin-agent-overlay");
    let registration = |runtime_key: &str,
                        logical_id: &str,
                        provider: &str,
                        ecosystem: &str|
     -> ExternalSubagentRegistration {
        ExternalSubagentRegistration {
            runtime_key: runtime_key.to_string(),
            logical_id: logical_id.to_string(),
            route_key: format!("{ecosystem}:{provider}:{logical_id}"),
            ecosystem_id: EcosystemId::new(ecosystem).unwrap(),
            provider_label: provider.to_string(),
            model_binding: super::ExternalSubagentModelBinding::InheritParent,
            hidden: false,
            mode: ExternalSubagentMode::Primary,
            agent: Arc::new(TestAgent {
                id: runtime_key.to_string(),
            }),
        }
    };
    let route = |logical_id: &str, runtime_key: &str| {
        (
            logical_id.to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )
    };

    registry.install_external_subagent_routes(
        &workspace,
        vec![
            registration("external::base-agentic", "Standard", "Base", "claude-code"),
            registration("external::base-only", "base-only", "Base", "claude-code"),
        ],
        [
            route("Standard", "external::base-agentic"),
            route("base-only", "external::base-only"),
        ]
        .into_iter()
        .collect(),
    );
    registry.replace_external_subagent_route_overlay(
        &workspace,
        "opencode-plugin-config",
        vec![
            registration("external::plugin-agentic", "Standard", "Plugin", "opencode"),
            registration("external::plugin-only", "plugin-only", "Plugin", "opencode"),
        ],
        [
            route("Standard", "external::plugin-agentic"),
            route("plugin-only", "external::plugin-only"),
        ]
        .into_iter()
        .collect(),
    );

    let plugin_turn = registry
        .resolve_primary_agent_for_turn("Standard", Some(&workspace), true, None)
        .expect("overlay route");
    assert_eq!(plugin_turn.runtime_agent_key, "external::plugin-agentic");
    assert_eq!(
        registry
            .resolve_primary_agent_for_turn("base-only", Some(&workspace), true, None)
            .expect("unrelated base route")
            .runtime_agent_key,
        "external::base-only"
    );
    assert_eq!(
        registry
            .resolve_primary_agent_for_turn("plugin-only", Some(&workspace), true, None)
            .expect("plugin-only overlay route")
            .runtime_agent_key,
        "external::plugin-only"
    );

    registry.install_external_subagent_routes(
        &workspace,
        vec![
            registration(
                "external::base-agentic-v2",
                "Standard",
                "Base v2",
                "claude-code",
            ),
            registration("external::base-only", "base-only", "Base", "claude-code"),
        ],
        [
            route("Standard", "external::base-agentic-v2"),
            route("base-only", "external::base-only"),
        ]
        .into_iter()
        .collect(),
    );
    assert_eq!(
        registry
            .resolve_primary_agent_for_turn("Standard", Some(&workspace), true, None)
            .expect("overlay still wins after base refresh")
            .runtime_agent_key,
        "external::plugin-agentic"
    );

    registry.release_external_subagent_route_overlay(&workspace, "opencode-plugin-config");

    assert_eq!(
        registry
            .resolve_primary_agent_for_turn("Standard", Some(&workspace), true, None)
            .expect("latest base route restored")
            .runtime_agent_key,
        "external::base-agentic-v2"
    );
    assert_eq!(
        registry
            .resolve_primary_agent_for_turn("base-only", Some(&workspace), true, None)
            .expect("base route retained")
            .runtime_agent_key,
        "external::base-only"
    );
    assert!(registry
        .resolve_primary_agent_for_turn("plugin-only", Some(&workspace), true, None)
        .is_none());
    assert!(registry.check_agent_exists("external::plugin-agentic"));
    drop(plugin_turn);
    assert!(!registry.check_agent_exists("external::plugin-agentic"));
}

#[test]
fn persisted_route_key_rejects_same_name_external_provider_takeover() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/plugin-agent-takeover");
    let logical_id = "Standard";
    let registration = |runtime_key: &str, route_key: &str| ExternalSubagentRegistration {
        runtime_key: runtime_key.to_string(),
        logical_id: logical_id.to_string(),
        route_key: route_key.to_string(),
        ecosystem_id: EcosystemId::new("opencode").unwrap(),
        provider_label: "OpenCode".to_string(),
        model_binding: super::ExternalSubagentModelBinding::InheritParent,
        hidden: false,
        mode: ExternalSubagentMode::Primary,
        agent: Arc::new(TestAgent {
            id: runtime_key.to_string(),
        }),
    };
    registry.replace_external_subagent_routes(
        &workspace,
        vec![registration("external::one", "opencode:plugin-one:agentic")],
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External("external::one".to_string()),
        )]
        .into_iter()
        .collect(),
    );
    let binding = registry
        .resolve_primary_agent_for_turn_with_route(
            logical_id,
            Some(&workspace),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::External),
            Some("opencode:plugin-one:agentic"),
        )
        .expect("original route");
    drop(binding);

    registry.replace_external_subagent_routes(
        &workspace,
        vec![registration("external::two", "opencode:plugin-two:agentic")],
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External("external::two".to_string()),
        )]
        .into_iter()
        .collect(),
    );

    assert!(registry
        .resolve_primary_agent_for_turn_with_route(
            logical_id,
            Some(&workspace),
            true,
            Some(openbitfun_core_types::SessionAgentRouteOwner::External),
            Some("opencode:plugin-one:agentic"),
        )
        .is_none());
}

#[test]
fn external_primary_route_follows_the_session_execution_worktree() {
    let registry = AgentRegistry::new();
    let project = PathBuf::from("D:/workspace/project");
    let worktree = PathBuf::from("D:/workspace/worktrees/feature");
    let logical_id = "workspace-profile";
    let registration = |runtime_key: &str| ExternalSubagentRegistration {
        runtime_key: runtime_key.to_string(),
        logical_id: logical_id.to_string(),
        route_key: format!("opencode:test:{logical_id}"),
        ecosystem_id: EcosystemId::new("opencode").unwrap(),
        provider_label: "OpenCode".to_string(),
        model_binding: super::ExternalSubagentModelBinding::InheritParent,
        hidden: false,
        mode: ExternalSubagentMode::Primary,
        agent: Arc::new(TestAgent {
            id: runtime_key.to_string(),
        }),
    };
    let route = |runtime_key: &str| {
        [(
            logical_id.to_string(),
            ExternalSubagentRoute::External(runtime_key.to_string()),
        )]
        .into_iter()
        .collect()
    };
    registry.install_external_subagent_routes(
        &project,
        vec![registration("external::project")],
        route("external::project"),
    );
    registry.install_external_subagent_routes(
        &worktree,
        vec![registration("external::worktree")],
        route("external::worktree"),
    );

    let config = SessionConfig {
        workspace_path: Some(worktree.to_string_lossy().into_owned()),
        project_workspace_path: Some(project.to_string_lossy().into_owned()),
        ..SessionConfig::default()
    };
    let route_root = session_execution_workspace_root(&config).expect("execution root");
    let binding = registry
        .resolve_primary_agent_for_turn(logical_id, Some(route_root), true, None)
        .expect("worktree route should resolve");

    assert_eq!(binding.runtime_agent_key, "external::worktree");
}

#[test]
fn builtin_review_agents_resolve_as_local_session_primaries() {
    let registry = AgentRegistry::new();

    for agent_type in ["CodeReview", "DeepReview", "ReviewFixer"] {
        let binding = registry
            .resolve_primary_agent_for_turn(agent_type, None, false, None)
            .unwrap_or_else(|| {
                panic!("{agent_type} must resolve as a session primary agent for review children")
            });
        assert_eq!(binding.runtime_agent_key, agent_type);
        assert_eq!(
            binding.route_owner,
            openbitfun_core_types::SessionAgentRouteOwner::Local
        );
    }
}

#[test]
fn non_session_primary_subagents_and_unknown_ids_do_not_resolve() {
    let registry = AgentRegistry::new();

    // Registered subagents that are not session-capable stay restricted.
    for agent_type in ["ReviewWorker", "ReviewJudge"] {
        assert!(
            registry
                .resolve_primary_agent_for_turn(agent_type, None, false, None)
                .is_none(),
            "{agent_type} must not resolve as a session primary agent"
        );
    }
    // Unknown ids remain unknown.
    assert!(registry
        .resolve_primary_agent_for_turn("does-not-exist", None, false, None)
        .is_none());
    // The external-owner guard still fails closed for review agents.
    for agent_type in ["CodeReview", "DeepReview", "ReviewFixer"] {
        assert!(
            registry
                .resolve_primary_agent_for_turn(
                    agent_type,
                    None,
                    false,
                    Some(openbitfun_core_types::SessionAgentRouteOwner::External),
                )
                .is_none(),
            "{agent_type} must fail closed for an external owner"
        );
    }
}

#[test]
fn non_builtin_same_name_review_agent_does_not_resolve_as_session_primary() {
    let registry = AgentRegistry::new();

    // Custom-agent loading currently filters ids that conflict with builtin
    // entries, but the session-primary allowlist is source-gated regardless:
    // a non-Builtin entry occupying the builtin "ReviewFixer" id must fail
    // closed instead of inheriting the builtin primary path.
    registry.write_agents().insert(
        "ReviewFixer".to_string(),
        test_source_custom_entry("ReviewFixer", "shadow", CustomSubagentKind::User),
    );

    assert!(
        registry
            .resolve_primary_agent_for_turn("ReviewFixer", None, false, None)
            .is_none(),
        "a non-Builtin entry named ReviewFixer must not resolve as a session primary agent"
    );
}

#[test]
fn local_route_resolves_review_agents_as_session_primaries() {
    let registry = AgentRegistry::new();
    let workspace = PathBuf::from("D:/workspace/review-local-route");
    registry.install_external_subagent_routes(
        &workspace,
        Vec::new(),
        [
            ("CodeReview".to_string(), ExternalSubagentRoute::Local),
            ("DeepReview".to_string(), ExternalSubagentRoute::Local),
            ("ReviewFixer".to_string(), ExternalSubagentRoute::Local),
            ("ReviewWorker".to_string(), ExternalSubagentRoute::Local),
            ("ReviewJudge".to_string(), ExternalSubagentRoute::Local),
        ]
        .into_iter()
        .collect(),
    );

    for agent_type in ["CodeReview", "DeepReview", "ReviewFixer"] {
        let binding = registry
            .resolve_primary_agent_for_turn(agent_type, Some(&workspace), true, None)
            .unwrap_or_else(|| panic!("{agent_type} must resolve through an explicit Local route"));
        assert_eq!(binding.runtime_agent_key, agent_type);
        assert_eq!(
            binding.route_owner,
            openbitfun_core_types::SessionAgentRouteOwner::Local
        );
    }

    // Non-session-primary subagents stay restricted even under a Local route.
    for agent_type in ["ReviewWorker", "ReviewJudge"] {
        assert!(
            registry
                .resolve_primary_agent_for_turn(agent_type, Some(&workspace), true, None)
                .is_none(),
            "{agent_type} must not resolve through a Local route"
        );
    }
}
