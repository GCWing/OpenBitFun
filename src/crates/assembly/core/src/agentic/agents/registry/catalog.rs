use super::types::AgentCategory;
use super::visibility::SubagentVisibilityPolicy;
use crate::agentic::agents::{
    Agent, ClawMode, CodeReviewAgent, ComputerUseMode, CoworkMode, CreativeHarness,
    DeepResearchMode, DeepReviewAgent, ExploreAgent, GeneralPurposeAgent, GenerateDocAgent,
    MinimalHarness, OpenBitFunAgent, ResearchSpecialistAgent, ReviewFixerAgent, ReviewJudgeAgent,
    ReviewWorkerAgent, StandardHarness, SwarmPlannerAgent, SwarmReviewerAgent, SwarmWorkerAgent,
    UltimateHarness,
};
use crate::agentic::memories::MemoryPhase2Agent;
use openbitfun_agent_runtime::agents as runtime_agents;
use std::sync::Arc;

#[derive(Clone)]
pub struct BuiltinAgentSpec {
    pub factory: fn() -> Arc<dyn Agent>,
    pub category: AgentCategory,
    pub visibility_policy: SubagentVisibilityPolicy,
}

pub fn builtin_agent_specs() -> Vec<BuiltinAgentSpec> {
    builtin_agent_specs_for_ids(
        runtime_agents::builtin_agent_definition_specs()
            .iter()
            .map(|spec| spec.id),
    )
}

pub(crate) fn builtin_agent_specs_for_ids<'a>(
    agent_ids: impl IntoIterator<Item = &'a str>,
) -> Vec<BuiltinAgentSpec> {
    let selected = agent_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    runtime_agents::builtin_agent_definition_specs()
        .into_iter()
        .filter(|spec| selected.contains(spec.id))
        .map(|spec| BuiltinAgentSpec {
            factory: builtin_agent_factory(spec.id),
            category: spec.category,
            visibility_policy: spec.visibility_policy,
        })
        .collect()
}

fn builtin_agent_factory(id: &str) -> fn() -> Arc<dyn Agent> {
    match id {
        "OpenBitFun" => || Arc::new(OpenBitFunAgent),
        "Minimal" => || Arc::new(MinimalHarness::new()),
        "Standard" => || Arc::new(StandardHarness::new()),
        "Cowork" => || Arc::new(CoworkMode::new()),
        "Creative" => || Arc::new(CreativeHarness::new()),
        "Claw" => || Arc::new(ClawMode::new()),
        "DeepResearch" => || Arc::new(DeepResearchMode::new()),
        "Ultimate" => || Arc::new(UltimateHarness::new()),
        "SwarmPlanner" => || Arc::new(SwarmPlannerAgent::new()),
        "SwarmWorker" => || Arc::new(SwarmWorkerAgent::new()),
        "SwarmReviewer" => || Arc::new(SwarmReviewerAgent::new()),
        "ComputerUse" => || Arc::new(ComputerUseMode::new()),
        "Explore" => || Arc::new(ExploreAgent::new()),
        "GeneralPurpose" => || Arc::new(GeneralPurposeAgent::new()),
        "ResearchSpecialist" => || Arc::new(ResearchSpecialistAgent::new()),
        "ReviewWorker" => || Arc::new(ReviewWorkerAgent::new()),
        "ReviewJudge" => || Arc::new(ReviewJudgeAgent::new()),
        "ReviewFixer" => || Arc::new(ReviewFixerAgent::new()),
        "CodeReview" => || Arc::new(CodeReviewAgent::new()),
        "DeepReview" => || Arc::new(DeepReviewAgent::new()),
        "GenerateDoc" => || Arc::new(GenerateDocAgent::new()),
        "MemoryPhase2" => || Arc::new(MemoryPhase2Agent::new()),
        _ => panic!("missing legacy Agent factory for builtin agent {id}"),
    }
}
