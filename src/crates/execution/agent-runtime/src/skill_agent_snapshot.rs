use crate::prompt::ToolListingSections;
use dashmap::DashMap;
use openbitfun_agent_tools::{
    build_get_tool_spec_catalog_description, render_get_tool_spec_deferred_tool_entry,
    GetToolSpecDeferredToolSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillSnapshotEntry {
    pub name: String,
    pub description: String,
    pub location: String,
}

impl SkillSnapshotEntry {
    fn to_xml_desc(&self) -> String {
        format!(
            r#"<skill name="{}">{}</skill>"#,
            self.name, self.description
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSnapshotEntry {
    pub id: String,
    pub description: String,
    pub default_tools: Vec<String>,
}

impl AgentSnapshotEntry {
    fn to_xml_desc(&self) -> String {
        format!(
            "<agent type=\"{}\">\n<description>\n{}\n</description>\n<tools>{}</tools>\n</agent>",
            self.id,
            self.description,
            self.default_tools.join(", ")
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredToolSnapshotEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
}

impl DeferredToolSnapshotEntry {
    fn to_summary(&self) -> GetToolSpecDeferredToolSummary {
        GetToolSpecDeferredToolSummary {
            name: self.name.clone(),
            short_description: self.short_description.clone(),
        }
    }
}

impl From<&GetToolSpecDeferredToolSummary> for DeferredToolSnapshotEntry {
    fn from(summary: &GetToolSpecDeferredToolSummary) -> Self {
        Self {
            name: summary.name.clone(),
            short_description: summary.short_description.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnSkillAgentSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillSnapshotEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<AgentSnapshotEntry>,
    /// Deferred tools listed for GetToolSpec. `None` marks snapshots persisted
    /// before deferred tools were tracked; their sessions keep rendering the
    /// current deferred listing instead of diffing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_tools: Option<Vec<DeferredToolSnapshotEntry>>,
}

impl TurnSkillAgentSnapshot {
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty() && self.subagents.is_empty() && !self.lists_deferred_tools()
    }

    /// Whether a listing baseline built from this snapshot renders deferred
    /// tools, so later deferred-tool changes travel as diff reminders.
    pub fn lists_deferred_tools(&self) -> bool {
        self.deferred_tools
            .as_ref()
            .is_some_and(|tools| !tools.is_empty())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillAgentDiff {
    pub added_skills: Vec<SkillSnapshotEntry>,
    pub changed_skills: Vec<SkillSnapshotEntry>,
    pub removed_skills: Vec<String>,
    pub added_subagents: Vec<AgentSnapshotEntry>,
    pub changed_subagents: Vec<AgentSnapshotEntry>,
    pub removed_subagents: Vec<String>,
    pub added_deferred_tools: Vec<DeferredToolSnapshotEntry>,
    pub changed_deferred_tools: Vec<DeferredToolSnapshotEntry>,
    pub removed_deferred_tools: Vec<String>,
}

impl SkillAgentDiff {
    pub fn is_empty(&self) -> bool {
        self.added_skills.is_empty()
            && self.changed_skills.is_empty()
            && self.removed_skills.is_empty()
            && self.added_subagents.is_empty()
            && self.changed_subagents.is_empty()
            && self.removed_subagents.is_empty()
            && self.added_deferred_tools.is_empty()
            && self.changed_deferred_tools.is_empty()
            && self.removed_deferred_tools.is_empty()
    }

    pub fn render_skill_listing_update(&self) -> Option<String> {
        if self.added_skills.is_empty()
            && self.changed_skills.is_empty()
            && self.removed_skills.is_empty()
        {
            return None;
        }

        let mut sections = Vec::new();
        if !self.added_skills.is_empty() {
            sections.push(render_titled_skill_entries(
                "Added Skills",
                &self.added_skills,
            ));
        }
        if !self.changed_skills.is_empty() {
            sections.push(render_titled_skill_entries(
                "Changed Skills",
                &self.changed_skills,
            ));
        }
        if !self.removed_skills.is_empty() {
            sections.push(render_removed_name_entries(
                "Removed Skills",
                &self.removed_skills,
            ));
        }

        Some(format!(
            "# Skill Listing Update\n\n{}",
            sections.join("\n\n")
        ))
    }

    pub fn render_agent_listing_update(&self) -> Option<String> {
        if self.added_subagents.is_empty()
            && self.changed_subagents.is_empty()
            && self.removed_subagents.is_empty()
        {
            return None;
        }

        let mut sections = Vec::new();
        if !self.added_subagents.is_empty() {
            sections.push(render_titled_subagent_entries(
                "Added Agents",
                &self.added_subagents,
            ));
        }
        if !self.changed_subagents.is_empty() {
            sections.push(render_titled_subagent_entries(
                "Changed Agents",
                &self.changed_subagents,
            ));
        }
        if !self.removed_subagents.is_empty() {
            sections.push(render_removed_name_entries(
                "Removed Agents",
                &self.removed_subagents,
            ));
        }

        Some(format!(
            "# Agent Listing Update\n\n{}",
            sections.join("\n\n")
        ))
    }

    pub fn render_deferred_tool_listing_update(&self) -> Option<String> {
        if self.added_deferred_tools.is_empty()
            && self.changed_deferred_tools.is_empty()
            && self.removed_deferred_tools.is_empty()
        {
            return None;
        }

        let mut sections = Vec::new();
        if !self.added_deferred_tools.is_empty() {
            sections.push(render_titled_deferred_tool_entries(
                "Added Deferred Tools",
                &self.added_deferred_tools,
            ));
        }
        if !self.changed_deferred_tools.is_empty() {
            sections.push(render_titled_deferred_tool_entries(
                "Changed Deferred Tools",
                &self.changed_deferred_tools,
            ));
        }
        if !self.removed_deferred_tools.is_empty() {
            sections.push(render_removed_name_entries(
                "Removed Deferred Tools",
                &self.removed_deferred_tools,
            ));
        }

        Some(format!(
            "# Deferred Tool Listing Update\n\n{}",
            sections.join("\n\n")
        ))
    }
}

pub fn diff_skill_agent_snapshot(
    previous: &TurnSkillAgentSnapshot,
    current: &TurnSkillAgentSnapshot,
) -> SkillAgentDiff {
    let previous_skills = previous
        .skills
        .iter()
        .cloned()
        .map(|entry| (entry.name.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let current_skills = current
        .skills
        .iter()
        .cloned()
        .map(|entry| (entry.name.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let previous_subagents = previous
        .subagents
        .iter()
        .cloned()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let current_subagents = current
        .subagents
        .iter()
        .cloned()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<BTreeMap<_, _>>();

    let mut diff = SkillAgentDiff::default();

    for (name, entry) in &current_skills {
        match previous_skills.get(name) {
            None => diff.added_skills.push(entry.clone()),
            Some(previous) if previous != entry => diff.changed_skills.push(entry.clone()),
            Some(_) => {}
        }
    }
    for name in previous_skills.keys() {
        if !current_skills.contains_key(name) {
            diff.removed_skills.push(name.clone());
        }
    }

    for (id, entry) in &current_subagents {
        match previous_subagents.get(id) {
            None => diff.added_subagents.push(entry.clone()),
            Some(previous) if !agent_snapshot_entries_match_for_diff(previous, entry) => {
                diff.changed_subagents.push(entry.clone())
            }
            Some(_) => {}
        }
    }
    for id in previous_subagents.keys() {
        if !current_subagents.contains_key(id) {
            diff.removed_subagents.push(id.clone());
        }
    }

    // A snapshot without deferred-tool tracking says nothing about the
    // deferred catalog, so it cannot anchor a deferred-tool diff.
    if let (Some(previous_deferred), Some(current_deferred)) =
        (&previous.deferred_tools, &current.deferred_tools)
    {
        let previous_deferred = previous_deferred
            .iter()
            .map(|entry| (entry.name.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let current_deferred = current_deferred
            .iter()
            .map(|entry| (entry.name.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        for (name, entry) in &current_deferred {
            match previous_deferred.get(name) {
                None => diff.added_deferred_tools.push((*entry).clone()),
                Some(previous) if previous != entry => {
                    diff.changed_deferred_tools.push((*entry).clone())
                }
                Some(_) => {}
            }
        }
        for name in previous_deferred.keys() {
            if !current_deferred.contains_key(name) {
                diff.removed_deferred_tools.push((*name).to_string());
            }
        }
    }

    diff
}

fn agent_snapshot_entries_match_for_diff(
    previous: &AgentSnapshotEntry,
    current: &AgentSnapshotEntry,
) -> bool {
    previous.id == current.id
        && previous.description == current.description
        && sorted_tool_names(&previous.default_tools) == sorted_tool_names(&current.default_tools)
}

fn sorted_tool_names(tool_names: &[String]) -> Vec<&str> {
    let mut normalized = tool_names.iter().map(String::as_str).collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized
}

pub fn render_full_skill_listing_body(skills: &[SkillSnapshotEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    format!(
        "<available_skills>\n{}\n</available_skills>",
        skills
            .iter()
            .map(SkillSnapshotEntry::to_xml_desc)
            .collect::<Vec<_>>()
            .join("\n")
    )
}

pub fn render_full_agent_listing_body(subagents: &[AgentSnapshotEntry]) -> String {
    if subagents.is_empty() {
        return String::new();
    }
    format!(
        "<available_agents>\n{}\n</available_agents>",
        subagents
            .iter()
            .map(AgentSnapshotEntry::to_xml_desc)
            .collect::<Vec<_>>()
            .join("\n")
    )
}

pub fn render_full_deferred_tool_listing_body(
    deferred_tools: &[DeferredToolSnapshotEntry],
) -> Option<String> {
    let summaries = deferred_tools
        .iter()
        .map(DeferredToolSnapshotEntry::to_summary)
        .collect::<Vec<_>>();
    build_get_tool_spec_catalog_description(&summaries)
}

/// Listing sections reproduced from a baseline snapshot. The direct tool
/// listing is left empty because it follows the request's own tool
/// definitions rather than the baseline.
pub fn build_skill_agent_tool_listing_sections_from_snapshot(
    snapshot: &TurnSkillAgentSnapshot,
) -> ToolListingSections {
    ToolListingSections {
        skill_listing: (!snapshot.skills.is_empty())
            .then(|| render_full_skill_listing_body(&snapshot.skills))
            .filter(|body| !body.is_empty()),
        agent_listing: (!snapshot.subagents.is_empty())
            .then(|| render_full_agent_listing_body(&snapshot.subagents))
            .filter(|body| !body.is_empty()),
        direct_tool_listing: None,
        deferred_tool_listing: snapshot
            .deferred_tools
            .as_deref()
            .and_then(render_full_deferred_tool_listing_body),
        ptc_tool_calling_guide: None,
    }
}

fn render_titled_skill_entries(title: &str, entries: &[SkillSnapshotEntry]) -> String {
    format!(
        "## {}\n\n{}",
        title,
        entries
            .iter()
            .map(SkillSnapshotEntry::to_xml_desc)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn render_titled_subagent_entries(title: &str, entries: &[AgentSnapshotEntry]) -> String {
    format!(
        "## {}\n\n{}",
        title,
        entries
            .iter()
            .map(AgentSnapshotEntry::to_xml_desc)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn render_titled_deferred_tool_entries(
    title: &str,
    entries: &[DeferredToolSnapshotEntry],
) -> String {
    format!(
        "## {}\n\n{}",
        title,
        entries
            .iter()
            .map(|entry| render_get_tool_spec_deferred_tool_entry(&entry.to_summary()))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn render_removed_name_entries(title: &str, names: &[String]) -> String {
    let entries = names
        .iter()
        .map(|name| format!("- {}", name))
        .collect::<Vec<_>>()
        .join("\n");
    format!("## {}\n\n{}", title, entries)
}

#[derive(Default)]
pub struct TurnSkillAgentSnapshotStore {
    session_snapshots: Arc<DashMap<String, BTreeMap<usize, TurnSkillAgentSnapshot>>>,
}

impl TurnSkillAgentSnapshotStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_session(&self, session_id: &str) {
        self.session_snapshots
            .entry(session_id.to_string())
            .or_default();
    }

    pub fn get_snapshot(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> Option<TurnSkillAgentSnapshot> {
        self.session_snapshots
            .get(session_id)
            .and_then(|snapshots| snapshots.get(&turn_index).cloned())
    }

    pub fn set_snapshot(
        &self,
        session_id: &str,
        turn_index: usize,
        snapshot: TurnSkillAgentSnapshot,
    ) {
        if let Some(mut snapshots) = self.session_snapshots.get_mut(session_id) {
            snapshots.insert(turn_index, snapshot);
        } else {
            let mut snapshots = BTreeMap::new();
            snapshots.insert(turn_index, snapshot);
            self.session_snapshots
                .insert(session_id.to_string(), snapshots);
        }
    }

    pub fn latest_snapshot_at_or_before(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> Option<(usize, TurnSkillAgentSnapshot)> {
        self.session_snapshots
            .get(session_id)
            .and_then(|snapshots| {
                snapshots
                    .range(..=turn_index)
                    .next_back()
                    .map(|(index, snapshot)| (*index, snapshot.clone()))
            })
    }

    pub fn delete_session(&self, session_id: &str) {
        self.session_snapshots.remove(session_id);
    }

    pub fn remove_from(&self, session_id: &str, turn_index: usize) {
        if let Some(mut snapshots) = self.session_snapshots.get_mut(session_id) {
            snapshots.retain(|index, _| *index < turn_index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_skill_agent_tool_listing_sections_from_snapshot, diff_skill_agent_snapshot,
        AgentSnapshotEntry, DeferredToolSnapshotEntry, SkillSnapshotEntry, TurnSkillAgentSnapshot,
        TurnSkillAgentSnapshotStore,
    };

    #[test]
    fn skill_agent_diff_renders_changed_added_and_removed_entries() {
        let previous = TurnSkillAgentSnapshot {
            skills: vec![
                SkillSnapshotEntry {
                    name: "skill-a".to_string(),
                    description: "desc-a".to_string(),
                    location: "C:/skills/skill-a".to_string(),
                },
                SkillSnapshotEntry {
                    name: "skill-b".to_string(),
                    description: "desc-b".to_string(),
                    location: "C:/skills/skill-b".to_string(),
                },
            ],
            subagents: vec![AgentSnapshotEntry {
                id: "agent-a".to_string(),
                description: "desc-a".to_string(),
                default_tools: vec!["Read".to_string()],
            }],
            deferred_tools: None,
        };
        let current = TurnSkillAgentSnapshot {
            skills: vec![
                SkillSnapshotEntry {
                    name: "skill-a".to_string(),
                    description: "desc-a2".to_string(),
                    location: "C:/skills/skill-a".to_string(),
                },
                SkillSnapshotEntry {
                    name: "skill-c".to_string(),
                    description: "desc-c".to_string(),
                    location: "C:/skills/skill-c".to_string(),
                },
            ],
            subagents: vec![AgentSnapshotEntry {
                id: "agent-a".to_string(),
                description: "desc-a".to_string(),
                default_tools: vec!["Read".to_string(), "Grep".to_string()],
            }],
            deferred_tools: None,
        };

        let diff = diff_skill_agent_snapshot(&previous, &current);
        let skill_update = diff
            .render_skill_listing_update()
            .expect("skill update should render");
        let agent_update = diff
            .render_agent_listing_update()
            .expect("agent update should render");

        assert!(skill_update.contains("## Changed Skills"));
        assert!(skill_update.contains("## Added Skills"));
        assert!(skill_update.contains("## Removed Skills"));
        assert!(skill_update.contains(r#"<skill name="skill-a">desc-a2</skill>"#));
        assert!(skill_update.contains(r#"<skill name="skill-c">desc-c</skill>"#));
        assert!(!skill_update.contains("C:/skills/skill-a"));
        assert!(!skill_update.contains("C:/skills/skill-c"));
        assert!(skill_update.contains("- skill-b"));
        assert!(agent_update.contains("## Changed Agents"));
        assert!(agent_update.contains("Grep"));
    }

    #[test]
    fn full_skill_listing_renders_inline_name_and_description_without_location() {
        let listing = super::render_full_skill_listing_body(&[SkillSnapshotEntry {
            name: "skill-a".to_string(),
            description: "desc-a".to_string(),
            location: "C:/skills/skill-a".to_string(),
        }]);

        assert!(listing.contains("<available_skills>"));
        assert!(listing.contains(r#"<skill name="skill-a">desc-a</skill>"#));
        assert!(!listing.contains("<location>"));
        assert!(!listing.contains("C:/skills/skill-a"));
    }

    #[test]
    fn skill_agent_diff_ignores_default_tool_reordering_for_agents() {
        let previous = TurnSkillAgentSnapshot {
            subagents: vec![AgentSnapshotEntry {
                id: "agent-a".to_string(),
                description: "desc-a".to_string(),
                default_tools: vec!["Read".to_string(), "Grep".to_string()],
            }],
            ..Default::default()
        };
        let current = TurnSkillAgentSnapshot {
            subagents: vec![AgentSnapshotEntry {
                id: "agent-a".to_string(),
                description: "desc-a".to_string(),
                default_tools: vec!["Grep".to_string(), "Read".to_string()],
            }],
            ..Default::default()
        };

        let diff = diff_skill_agent_snapshot(&previous, &current);

        assert!(diff.changed_subagents.is_empty());
        assert!(diff.is_empty());
    }

    fn deferred(name: &str, description: Option<&str>) -> DeferredToolSnapshotEntry {
        DeferredToolSnapshotEntry {
            name: name.to_string(),
            short_description: description.map(str::to_string),
        }
    }

    fn deferred_snapshot(tools: Vec<DeferredToolSnapshotEntry>) -> TurnSkillAgentSnapshot {
        TurnSkillAgentSnapshot {
            deferred_tools: Some(tools),
            ..Default::default()
        }
    }

    #[test]
    fn deferred_tool_diff_tracks_names_and_descriptions_but_not_order() {
        let previous = deferred_snapshot(vec![
            deferred("WebFetch", Some("Fetch a page")),
            deferred("mcp__docs__search", None),
            deferred("Cron", Some("Schedule jobs")),
        ]);
        let reordered = deferred_snapshot(vec![
            deferred("Cron", Some("Schedule jobs")),
            deferred("WebFetch", Some("Fetch a page")),
            deferred("mcp__docs__search", None),
        ]);
        assert!(diff_skill_agent_snapshot(&previous, &reordered).is_empty());

        let current = deferred_snapshot(vec![
            deferred("WebFetch", Some("Fetch a web page")),
            deferred("mcp__docs__search", None),
            deferred("mcp__git__log", None),
        ]);
        let diff = diff_skill_agent_snapshot(&previous, &current);
        assert_eq!(
            diff.added_deferred_tools,
            vec![deferred("mcp__git__log", None)]
        );
        assert_eq!(
            diff.changed_deferred_tools,
            vec![deferred("WebFetch", Some("Fetch a web page"))]
        );
        assert_eq!(diff.removed_deferred_tools, vec!["Cron".to_string()]);
        assert_eq!(diff.render_skill_listing_update(), None);
        assert_eq!(
            diff.render_deferred_tool_listing_update().as_deref(),
            Some(
                "# Deferred Tool Listing Update\n\n\
                 ## Added Deferred Tools\n\n- mcp__git__log\n\n\
                 ## Changed Deferred Tools\n\n- WebFetch: Fetch a web page\n\n\
                 ## Removed Deferred Tools\n\n- Cron"
            )
        );
    }

    #[test]
    fn untracked_snapshots_never_produce_deferred_tool_diffs() {
        let untracked = TurnSkillAgentSnapshot::default();
        let tracked = deferred_snapshot(vec![deferred("WebFetch", None)]);

        assert!(diff_skill_agent_snapshot(&untracked, &tracked).is_empty());
        assert!(diff_skill_agent_snapshot(&tracked, &untracked).is_empty());
        assert!(
            diff_skill_agent_snapshot(&deferred_snapshot(Vec::new()), &tracked)
                .render_deferred_tool_listing_update()
                .is_some()
        );
    }

    #[test]
    fn legacy_snapshot_without_deferred_tools_stays_untracked_across_round_trip() {
        let legacy: TurnSkillAgentSnapshot = serde_json::from_value(serde_json::json!({
            "skills": [{ "name": "skill-a", "description": "desc-a", "location": "/s/a" }]
        }))
        .expect("legacy snapshot should deserialize");
        assert_eq!(legacy.deferred_tools, None);
        assert!(!legacy.lists_deferred_tools());
        let reserialized = serde_json::to_value(&legacy).expect("serialize legacy");
        assert!(reserialized.get("deferred_tools").is_none());

        let tracked_empty = deferred_snapshot(Vec::new());
        let value = serde_json::to_value(&tracked_empty).expect("serialize tracked");
        assert_eq!(value["deferred_tools"], serde_json::json!([]));
        let restored: TurnSkillAgentSnapshot =
            serde_json::from_value(value).expect("tracked snapshot should deserialize");
        assert_eq!(restored, tracked_empty);
        assert!(!restored.lists_deferred_tools());
    }

    #[test]
    fn baseline_sections_reproduce_the_snapshot_deferred_listing_in_snapshot_order() {
        let sections =
            build_skill_agent_tool_listing_sections_from_snapshot(&deferred_snapshot(vec![
                deferred("WebFetch", Some("Fetch a page")),
                deferred("mcp__docs__search", None),
            ]));
        assert_eq!(
            sections.deferred_tool_listing.as_deref(),
            Some("<deferred_tools>\n- WebFetch: Fetch a page\n- mcp__docs__search\n</deferred_tools>")
        );
        assert_eq!(sections.direct_tool_listing, None);

        let empty =
            build_skill_agent_tool_listing_sections_from_snapshot(&deferred_snapshot(Vec::new()));
        assert_eq!(empty.deferred_tool_listing, None);
        assert_eq!(
            build_skill_agent_tool_listing_sections_from_snapshot(
                &TurnSkillAgentSnapshot::default()
            )
            .deferred_tool_listing,
            None
        );
    }

    #[test]
    fn latest_snapshot_at_or_before_returns_nearest_sparse_snapshot() {
        let store = TurnSkillAgentSnapshotStore::new();
        store.create_session("session");
        store.set_snapshot(
            "session",
            0,
            TurnSkillAgentSnapshot {
                skills: vec![SkillSnapshotEntry {
                    name: "skill-a".to_string(),
                    description: "desc-a".to_string(),
                    location: "C:/skills/skill-a".to_string(),
                }],
                ..Default::default()
            },
        );
        store.set_snapshot(
            "session",
            3,
            TurnSkillAgentSnapshot {
                skills: vec![SkillSnapshotEntry {
                    name: "skill-b".to_string(),
                    description: "desc-b".to_string(),
                    location: "C:/skills/skill-b".to_string(),
                }],
                ..Default::default()
            },
        );

        let nearest = store
            .latest_snapshot_at_or_before("session", 2)
            .expect("nearest snapshot should exist");
        let latest = store
            .latest_snapshot_at_or_before("session", 4)
            .expect("latest snapshot should exist");

        assert_eq!(nearest.0, 0);
        assert_eq!(nearest.1.skills[0].name, "skill-a");
        assert_eq!(latest.0, 3);
        assert_eq!(latest.1.skills[0].name, "skill-b");
    }
}
