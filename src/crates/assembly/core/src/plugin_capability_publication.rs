use crate::agentic::agents::{
    external_subagent_runtime_key, get_agent_registry, standard_harness_tools, ExploreAgent,
    ExternalProvidedAgent, ExternalSubagentModelBinding, ExternalSubagentRegistration,
    ExternalSubagentRoute,
};
use openbitfun_product_domains::external_sources::EcosystemId;
use openbitfun_product_domains::external_subagents::ExternalSubagentMode;
use openbitfun_product_domains::plugin_capabilities::{PluginCapabilityProjection, PluginToolRef};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};

pub(crate) fn is_agent_runtime_key_for_namespace(
    runtime_agent_key: &str,
    runtime_namespace: &str,
) -> bool {
    runtime_agent_key.starts_with(&format!("external_subagent_runtime:{runtime_namespace}:"))
}

#[derive(Debug, Clone)]
pub(crate) struct PluginPublicationIdentity {
    ecosystem_id: String,
    runtime_namespace: String,
    route_owner: String,
}

impl PluginPublicationIdentity {
    pub(crate) fn new(
        ecosystem_id: impl Into<String>,
        runtime_namespace: impl Into<String>,
        route_owner: impl Into<String>,
    ) -> Self {
        Self {
            ecosystem_id: ecosystem_id.into(),
            runtime_namespace: runtime_namespace.into(),
            route_owner: route_owner.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PluginSkillRootContribution {
    pub(crate) path: PathBuf,
    pub(crate) precedence: usize,
}

#[derive(Debug, Clone)]
struct PublishedSkillGeneration {
    generation_key: String,
    workspace_roots: Vec<PluginSkillRootContribution>,
}

fn skill_generations() -> &'static RwLock<HashMap<(String, String), PublishedSkillGeneration>> {
    static GENERATIONS: OnceLock<RwLock<HashMap<(String, String), PublishedSkillGeneration>>> =
        OnceLock::new();
    GENERATIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

pub(crate) struct PluginCapabilityPublicationPlan {
    workspace_id: String,
    generation_key: String,
    publication: PluginPublicationIdentity,
    registrations: Vec<ExternalSubagentRegistration>,
    routes: BTreeMap<String, ExternalSubagentRoute>,
    runtime_agent_keys: BTreeSet<String>,
    workspace_skill_roots: Vec<PluginSkillRootContribution>,
    tool_runtime_agent_keys: BTreeMap<PluginToolRef, BTreeSet<String>>,
}

impl PluginCapabilityPublicationPlan {
    pub(crate) fn empty(
        workspace_id: &str,
        generation_key: &str,
        publication: PluginPublicationIdentity,
    ) -> Self {
        Self {
            workspace_id: workspace_id.to_owned(),
            generation_key: generation_key.to_string(),
            publication,
            registrations: Vec::new(),
            routes: BTreeMap::new(),
            runtime_agent_keys: BTreeSet::new(),
            workspace_skill_roots: Vec::new(),
            tool_runtime_agent_keys: BTreeMap::new(),
        }
    }

    pub(crate) fn agent_runtime_keys(&self) -> BTreeSet<String> {
        self.runtime_agent_keys.clone()
    }

    pub(crate) fn allowed_runtime_agent_keys_for_tool(
        &self,
        tool: &PluginToolRef,
    ) -> BTreeSet<String> {
        self.tool_runtime_agent_keys
            .get(tool)
            .cloned()
            .unwrap_or_default()
    }

    pub(crate) fn commit(self) {
        get_agent_registry().replace_external_subagent_route_overlay(
            &self.workspace_id,
            &self.publication.route_owner,
            self.registrations,
            self.routes,
        );
        let mut generations = skill_generations()
            .write()
            .expect("plugin skill generation lock poisoned");
        generations.insert(
            (self.workspace_id, self.publication.route_owner),
            PublishedSkillGeneration {
                generation_key: self.generation_key,
                workspace_roots: self.workspace_skill_roots,
            },
        );
    }
}

pub(crate) fn release_workspace(workspace_id: &str, route_owner: &str) {
    let workspace_id = workspace_id.to_owned();
    get_agent_registry().release_external_subagent_route_overlay(&workspace_id, route_owner);
    skill_generations()
        .write()
        .expect("plugin skill generation lock poisoned")
        .remove(&(workspace_id, route_owner.to_string()));
}

pub(crate) fn release_workspace_generation(
    workspace_id: &str,
    route_owner: &str,
    expected_generation_key: &str,
) -> bool {
    let workspace_id = workspace_id.to_owned();
    let mut generations = skill_generations()
        .write()
        .expect("plugin skill generation lock poisoned");
    if generations
        .get(&(workspace_id.clone(), route_owner.to_string()))
        .is_none_or(|generation| generation.generation_key != expected_generation_key)
    {
        return false;
    }
    get_agent_registry().release_external_subagent_route_overlay(&workspace_id, route_owner);
    generations.remove(&(workspace_id, route_owner.to_string()));
    true
}

pub(crate) fn skill_roots_for_agent(
    workspace_id: Option<&str>,
    _runtime_agent_key: Option<&str>,
) -> Vec<PluginSkillRootContribution> {
    let Some(workspace_id) = workspace_id else {
        return Vec::new();
    };
    let workspace_id = workspace_id.to_owned();
    let generations = skill_generations()
        .read()
        .expect("plugin skill generation lock poisoned");
    let mut publications = generations
        .iter()
        .filter(|((root, _), _)| root == &workspace_id)
        .collect::<Vec<_>>();
    publications.sort_by(|((_, left), _), ((_, right), _)| left.cmp(right));
    publications
        .into_iter()
        .flat_map(|(_, generation)| generation.workspace_roots.iter().cloned())
        .enumerate()
        .map(|(precedence, mut root)| {
            root.precedence = precedence;
            root
        })
        .collect()
}

pub(crate) fn prepare(
    workspace_id: &str,
    generation_key: &str,
    publication: PluginPublicationIdentity,
    projection: PluginCapabilityProjection,
) -> crate::OpenBitFunResult<PluginCapabilityPublicationPlan> {
    let workspace_id = workspace_id.to_owned();
    if projection.agents.is_empty() && projection.skill_roots.is_empty() {
        return Ok(PluginCapabilityPublicationPlan::empty(
            &workspace_id,
            generation_key,
            publication,
        ));
    }

    let ecosystem_id = EcosystemId::new(&publication.ecosystem_id).map_err(|error| {
        crate::OpenBitFunError::Validation(format!(
            "Invalid plugin publication ecosystem id '{}': {error}",
            publication.ecosystem_id
        ))
    })?;

    let mut registrations = Vec::new();
    let mut routes = BTreeMap::new();
    let mut runtime_agent_keys = BTreeSet::new();
    let mut tool_runtime_agent_keys = BTreeMap::<PluginToolRef, BTreeSet<String>>::new();
    for projected in projection.agents {
        let mut tools = native_tool_baseline(&projected.logical_id, projected.mode, &workspace_id);
        let permitted_plugin_tools = projected
            .plugin_tools
            .iter()
            .map(|tool| tool.id().to_string())
            .collect::<Vec<_>>();
        tools.extend(permitted_plugin_tools.iter().cloned());
        for plugin_tool in &permitted_plugin_tools {
            if let Some(position) = tools.iter().position(|tool| tool == plugin_tool) {
                tools.remove(position);
                tools.push(plugin_tool.clone());
            }
        }
        tools.sort();
        tools.dedup();

        let mut hasher = Sha256::new();
        hasher.update(generation_key.as_bytes());
        hasher.update([0]);
        hasher.update(projected.contributor.behavior_key().as_bytes());
        hasher.update([0]);
        hasher.update(projected.logical_id.as_bytes());
        hasher.update([0]);
        hasher.update([u8::from(projected.hidden)]);
        hasher.update([0]);
        if let Some(temperature) = projected.temperature {
            hasher.update(temperature.to_bits().to_le_bytes());
        } else {
            hasher.update([0xff]);
        }
        let digest = hex::encode(hasher.finalize());
        let runtime_key =
            external_subagent_runtime_key(&format!("{}:{digest}", publication.runtime_namespace));
        let behavior_version = format!("sha256:{digest}");
        let agent = Arc::new(ExternalProvidedAgent::new(
            runtime_key.clone(),
            projected.logical_id.clone(),
            projected.description,
            projected.prompt,
            tools,
            projected.permission_constraints,
            projected.temperature,
            false,
            behavior_version,
        ));
        registrations.push(ExternalSubagentRegistration {
            runtime_key: runtime_key.clone(),
            logical_id: projected.logical_id.clone(),
            route_key: format!(
                "{}:{}:{}",
                publication.ecosystem_id,
                hex::encode(Sha256::digest(
                    projected.contributor.behavior_key().as_bytes()
                )),
                projected.logical_id.to_ascii_lowercase()
            ),
            ecosystem_id: ecosystem_id.clone(),
            provider_label: projected.contributor.label().to_string(),
            model_binding: ExternalSubagentModelBinding::InheritParent,
            hidden: projected.hidden,
            mode: projected.mode,
            agent,
        });
        routes.insert(
            projected.logical_id,
            ExternalSubagentRoute::External(runtime_key.clone()),
        );
        for tool in projected.plugin_tools {
            tool_runtime_agent_keys
                .entry(tool)
                .or_default()
                .insert(runtime_key.clone());
        }
        runtime_agent_keys.insert(runtime_key);
    }

    let mut workspace_skill_roots = projection
        .skill_roots
        .into_iter()
        .map(|root| PluginSkillRootContribution {
            path: root.path,
            precedence: root.precedence,
        })
        .collect::<Vec<_>>();
    workspace_skill_roots.sort_by_key(|root| root.precedence);
    Ok(PluginCapabilityPublicationPlan {
        workspace_id,
        generation_key: generation_key.to_string(),
        publication,
        registrations,
        routes,
        runtime_agent_keys,
        workspace_skill_roots,
        tool_runtime_agent_keys,
    })
}

fn native_tool_baseline(
    logical_id: &str,
    mode: ExternalSubagentMode,
    workspace_id: &str,
) -> Vec<String> {
    if let Some(local_agent) = get_agent_registry().get_local_agent(logical_id, Some(workspace_id))
    {
        return local_agent.default_tools();
    }
    if mode == ExternalSubagentMode::Subagent {
        use crate::agentic::agents::Agent;
        ExploreAgent::new().default_tools()
    } else {
        standard_harness_tools()
    }
}

pub(crate) fn active_generation_key(workspace_id: &str, route_owner: &str) -> Option<String> {
    let root = workspace_id.to_owned();
    skill_generations()
        .read()
        .ok()?
        .get(&(root, route_owner.to_string()))
        .map(|generation| generation.generation_key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::plugin_capabilities::{
        PluginAgentProjection, PluginContributorIdentity, PluginSkillRootContribution,
    };

    const OPENCODE_ROUTE_OWNER: &str = "opencode-plugin-config";

    fn publication(ecosystem: &str) -> PluginPublicationIdentity {
        PluginPublicationIdentity::new(
            ecosystem,
            format!("{ecosystem}-plugin"),
            format!("{ecosystem}-plugin-config"),
        )
    }

    fn contributor() -> PluginContributorIdentity {
        PluginContributorIdentity::new(
            "opencode-owner",
            "D:/code/deveco_harness\nD:/code/deveco_harness/dist/index.js\n0",
            "deveco-harness",
        )
    }

    #[test]
    fn generation_scoped_release_never_withdraws_a_replacement() {
        let workspace = uuid::Uuid::new_v4().to_string();
        PluginCapabilityPublicationPlan::empty(
            workspace.as_str(),
            "generation-a",
            publication("opencode"),
        )
        .commit();

        assert!(!release_workspace_generation(
            workspace.as_str(),
            OPENCODE_ROUTE_OWNER,
            "generation-b"
        ));
        assert_eq!(
            active_generation_key(workspace.as_str(), OPENCODE_ROUTE_OWNER).as_deref(),
            Some("generation-a")
        );
        assert!(release_workspace_generation(
            workspace.as_str(),
            OPENCODE_ROUTE_OWNER,
            "generation-a"
        ));
        assert_eq!(
            active_generation_key(workspace.as_str(), OPENCODE_ROUTE_OWNER),
            None
        );
    }

    #[test]
    fn keeps_skill_generations_isolated_by_publication_owner() {
        let workspace = uuid::Uuid::new_v4().to_string();
        let first_root = tempfile::tempdir().expect("first skill root");
        let second_root = tempfile::tempdir().expect("second skill root");
        for (ecosystem, root) in [("ecosystem-a", &first_root), ("ecosystem-b", &second_root)] {
            prepare(
                workspace.as_str(),
                &format!("{ecosystem}-generation"),
                publication(ecosystem),
                PluginCapabilityProjection {
                    agents: Vec::new(),
                    skill_roots: vec![PluginSkillRootContribution {
                        path: root.path().to_path_buf(),
                        precedence: 0,
                    }],
                },
            )
            .expect("skill publication")
            .commit();
        }

        let roots = skill_roots_for_agent(Some(workspace.as_str()), None);
        assert_eq!(roots.len(), 2);
        release_workspace(workspace.as_str(), "ecosystem-a-plugin-config");
        let roots = skill_roots_for_agent(Some(workspace.as_str()), None);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, second_root.path());
        release_workspace(workspace.as_str(), "ecosystem-b-plugin-config");
    }

    #[test]
    fn materializes_projected_agent_fields_and_plugin_tool_permissions() {
        let contributor = contributor();
        let tool = PluginToolRef::new(contributor.clone(), "build_project");
        let projection = PluginCapabilityProjection {
            agents: vec![PluginAgentProjection {
                contributor,
                logical_id: "build".to_string(),
                description: "Build projects".to_string(),
                prompt: "Build prompt".to_string(),
                mode: ExternalSubagentMode::Primary,
                hidden: false,
                temperature: Some(0.7),
                permission_constraints: Default::default(),
                plugin_tools: vec![tool.clone()],
            }],
            skill_roots: Vec::new(),
        };
        let plan = prepare(
            "workspace-publication",
            "generation-1",
            publication("opencode"),
            projection,
        )
        .expect("publication");

        assert_eq!(plan.registrations.len(), 1);
        let build = &plan.registrations[0];
        assert_eq!(
            build.runtime_key,
            "external_subagent_runtime:opencode-plugin:0b17c0646a8c5a8f84a65251bdd750e0b7157ec13115d567608913d87a3763ea"
        );
        assert_eq!(
            build.route_key,
            "opencode:ed485fb494e18771e0611903da426ed83c36f4f19b5c422c7f38712b8aa16d76:build"
        );
        assert_eq!(build.mode, ExternalSubagentMode::Primary);
        assert!(!build.hidden);
        assert_eq!(build.agent.model_temperature_override(), Some(0.7));
        assert_eq!(build.agent.description(), "Build projects");
        assert!(build
            .agent
            .default_tools()
            .contains(&"build_project".to_string()));
        assert_eq!(plan.runtime_agent_keys.len(), 1);
        assert!(plan
            .runtime_agent_keys
            .iter()
            .all(|key| is_agent_runtime_key_for_namespace(key, "opencode-plugin")));
        assert_eq!(
            plan.allowed_runtime_agent_keys_for_tool(&tool),
            plan.runtime_agent_keys
        );
    }

    #[test]
    fn displaced_local_baseline_is_case_insensitive() {
        use crate::agentic::agents::{Agent, CoworkMode};

        assert_eq!(
            native_tool_baseline(
                "cowork",
                ExternalSubagentMode::Primary,
                "workspace-publication"
            ),
            CoworkMode::new().default_tools()
        );
    }
}
