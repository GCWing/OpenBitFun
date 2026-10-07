//! Shared runtime hook registry.

use super::handler::{HookHandler, RuntimeHookRegistration};
use super::kind::{RuntimeHookKind, RuntimeHookSource};
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeHookActivation {
    Preparing,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeHookErrorPolicy {
    FailTurn,
    SkipHook,
    DenyTool,
    RecordWarning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeHookPlan {
    id: String,
    kind: RuntimeHookKind,
    source: RuntimeHookSource,
    order: u16,
    timeout_millis: u64,
    error_policy: RuntimeHookErrorPolicy,
}

impl RuntimeHookPlan {
    pub fn new(id: impl Into<String>, kind: RuntimeHookKind, source: RuntimeHookSource) -> Self {
        Self {
            id: id.into(),
            kind,
            source,
            order: 100,
            timeout_millis: 1_000,
            error_policy: RuntimeHookErrorPolicy::RecordWarning,
        }
    }

    pub fn with_order(mut self, order: u16) -> Self {
        self.order = order;
        self
    }

    pub fn with_timeout_millis(mut self, timeout_millis: u64) -> Self {
        self.timeout_millis = timeout_millis;
        self
    }

    pub fn with_error_policy(mut self, error_policy: RuntimeHookErrorPolicy) -> Self {
        self.error_policy = error_policy;
        self
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_source(mut self, source: RuntimeHookSource) -> Self {
        self.source = source;
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub const fn kind(&self) -> &RuntimeHookKind {
        &self.kind
    }
    pub const fn source(&self) -> RuntimeHookSource {
        self.source
    }
    pub const fn order(&self) -> u16 {
        self.order
    }
    pub const fn timeout_millis(&self) -> u64 {
        self.timeout_millis
    }
    pub const fn error_policy(&self) -> RuntimeHookErrorPolicy {
        self.error_policy
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeHookRegistryBuildError {
    #[error("runtime hook id must not be empty")]
    EmptyHookId,
    #[error("runtime hook {hook_id} must declare a non-zero timeout")]
    InvalidTimeoutMillis { hook_id: String },
    #[error("duplicate runtime hook id {hook_id}")]
    DuplicateHookId { hook_id: String },
    #[error("invalid session skill hook registration")]
    InvalidSessionSkill,
    #[error("skill hooks changed after activation; start a new session to use the changed skill")]
    SkillChanged,
    #[error("session skill hook handler limit exceeded")]
    SessionHandlerLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeHookRegistryError {
    #[error(transparent)]
    Validation(#[from] RuntimeHookRegistryBuildError),
    #[error("runtime hook source {hook_source} cannot be replaced")]
    InvalidReplacementSource { hook_source: RuntimeHookSource },
    #[error("OpenCode plugin hook batch must contain one target and revision")]
    InvalidPluginBatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeHookCommitToken {
    workspace_scope: String,
    target_id: String,
    generation_key: String,
    revision: String,
    hook_ids: Arc<[String]>,
}

impl RuntimeHookCommitToken {
    pub fn workspace_scope(&self) -> &str {
        &self.workspace_scope
    }

    pub fn target_id(&self) -> &str {
        &self.target_id
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn generation_key(&self) -> &str {
        &self.generation_key
    }
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeHookRegistryBuilder {
    hooks: Vec<RuntimeHookRegistration>,
}

impl RuntimeHookRegistryBuilder {
    pub fn register(mut self, hook: RuntimeHookRegistration) -> Self {
        self.hooks.push(hook);
        self
    }

    pub fn build(self) -> Result<RuntimeHookRegistry, RuntimeHookRegistryBuildError> {
        validate_entries(&self.hooks).map_err(|error| match error {
            RuntimeHookRegistryError::Validation(error) => error,
            RuntimeHookRegistryError::InvalidReplacementSource { .. } => {
                RuntimeHookRegistryBuildError::EmptyHookId
            }
            RuntimeHookRegistryError::InvalidPluginBatch => {
                RuntimeHookRegistryBuildError::EmptyHookId
            }
        })?;
        let registry = RuntimeHookRegistry::default();
        registry
            .replace_state(self.hooks)
            .map_err(|error| match error {
                RuntimeHookRegistryError::Validation(error) => error,
                RuntimeHookRegistryError::InvalidReplacementSource { .. } => {
                    RuntimeHookRegistryBuildError::EmptyHookId
                }
                RuntimeHookRegistryError::InvalidPluginBatch => {
                    RuntimeHookRegistryBuildError::EmptyHookId
                }
            })?;
        Ok(registry)
    }
}

struct RuntimeHookRegistryState {
    entries: BTreeMap<RuntimeHookKind, Arc<[RuntimeHookRegistration]>>,
    source_activation: BTreeMap<(RuntimeHookSource, Option<String>), RuntimeHookActivation>,
    active_plugin_generations: BTreeMap<String, (String, String, String)>,
    session_skills: BTreeMap<String, BTreeMap<String, SessionSkillHooks>>,
}

struct SessionSkillHooks {
    fingerprint: String,
    active: Arc<AtomicBool>,
    cancellation: tokio::sync::watch::Sender<bool>,
    entries: Arc<[RuntimeHookRegistration]>,
}

impl Default for RuntimeHookRegistryState {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            source_activation: BTreeMap::new(),
            active_plugin_generations: BTreeMap::new(),
            session_skills: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Default)]
pub struct RuntimeHookRegistry {
    inner: Arc<RwLock<RuntimeHookRegistryState>>,
}

impl fmt::Debug for RuntimeHookRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let plans = self.plans();
        f.debug_struct("RuntimeHookRegistry")
            .field("plans", &plans)
            .field("count", &plans.len())
            .finish()
    }
}

impl RuntimeHookRegistry {
    pub fn builder() -> RuntimeHookRegistryBuilder {
        RuntimeHookRegistryBuilder::default()
    }

    /// Publish a skill atomically and at most once per session. The fingerprint
    /// pins the invoked definition, including consumed once handlers, until
    /// session teardown; refresh cannot silently replace executable rules.
    pub fn register_session_skill(
        &self,
        session_id: &str,
        skill_key: &str,
        fingerprint: &str,
        mut entries: Vec<RuntimeHookRegistration>,
    ) -> Result<usize, RuntimeHookRegistryError> {
        if session_id.trim().is_empty()
            || skill_key.trim().is_empty()
            || entries.iter().any(|entry| {
                entry.plan.source() != RuntimeHookSource::SkillCommand
                    || !matches!(&entry.handler, HookHandler::Command(_))
            })
        {
            return Err(RuntimeHookRegistryBuildError::InvalidSessionSkill.into());
        }
        validate_entries(&entries)?;
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        let skills = state
            .session_skills
            .entry(session_id.to_string())
            .or_default();
        if let Some(existing) = skills.get(skill_key) {
            return if existing.fingerprint == fingerprint {
                Ok(existing.entries.len())
            } else {
                Err(RuntimeHookRegistryBuildError::SkillChanged.into())
            };
        }
        let count = entries.len();
        if skills
            .values()
            .map(|skill| skill.entries.len())
            .sum::<usize>()
            + count
            > super::settings::MAX_HOOK_HANDLERS
        {
            return Err(RuntimeHookRegistryBuildError::SessionHandlerLimit.into());
        }
        let active = Arc::new(AtomicBool::new(true));
        let (cancellation, receiver) = tokio::sync::watch::channel(false);
        for entry in &mut entries {
            entry.active = Some(active.clone());
            entry.cancellation = Some(receiver.clone());
        }
        skills.insert(
            skill_key.to_string(),
            SessionSkillHooks {
                fingerprint: fingerprint.to_string(),
                active,
                cancellation,
                entries: Arc::from(entries),
            },
        );
        Ok(count)
    }

    /// Invalidate snapshots as well as removing the registry's ownership.
    pub fn clear_session(&self, session_id: &str) {
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        if let Some(skills) = state.session_skills.remove(session_id) {
            for skill in skills.values() {
                skill.active.store(false, Ordering::Release);
                skill.cancellation.send_replace(true);
            }
        }
    }

    pub fn registrations_for_session(
        &self,
        kind: RuntimeHookKind,
        workspace_scope: Option<&str>,
        session_id: &str,
    ) -> Arc<[RuntimeHookRegistration]> {
        let mut entries = self
            .registrations_for_workspace(kind.clone(), workspace_scope)
            .to_vec();
        let state = self.inner.read().expect("hook registry lock poisoned");
        if let Some(skills) = state.session_skills.get(session_id) {
            entries.extend(
                skills
                    .values()
                    .flat_map(|skill| skill.entries.iter())
                    .filter(|entry| {
                        entry.plan.kind() == &kind
                            && entry.is_active()
                            && entry
                                .workspace_scope
                                .as_deref()
                                .is_none_or(|scope| Some(scope) == workspace_scope)
                    })
                    .cloned(),
            );
        }
        entries.sort_by(|left, right| {
            left.plan
                .source()
                .cmp(&right.plan.source())
                .then_with(|| left.plan.order().cmp(&right.plan.order()))
                .then_with(|| left.plan.id().cmp(right.plan.id()))
        });
        Arc::from(entries)
    }

    pub fn register_batch(
        &self,
        entries: Vec<RuntimeHookRegistration>,
    ) -> Result<(), RuntimeHookRegistryError> {
        validate_entries(&entries)?;
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        let mut merged = state
            .entries
            .values()
            .flat_map(|items| items.iter().cloned())
            .collect::<Vec<_>>();
        merged.extend(entries);
        validate_entries(&merged)?;
        rebuild_entries(&mut state.entries, merged);
        Ok(())
    }

    pub fn register_plugin_batch(
        &self,
        entries: Vec<RuntimeHookRegistration>,
    ) -> Result<RuntimeHookCommitToken, RuntimeHookRegistryError> {
        let (workspace_scope, target_id, generation_key, revision) =
            plugin_batch_identity(&entries)?;
        let hook_ids = entries
            .iter()
            .map(|entry| entry.plan.id().to_string())
            .collect::<Vec<_>>();
        self.register_batch(entries)?;
        Ok(RuntimeHookCommitToken {
            workspace_scope,
            target_id,
            generation_key,
            revision,
            hook_ids: Arc::from(hook_ids),
        })
    }

    pub fn rollback_plugin_batch(&self, token: &RuntimeHookCommitToken) {
        let hook_ids = token
            .hook_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        let retained = state.entries.values().flat_map(|items| items.iter().cloned()).filter(|entry| {
            if !hook_ids.contains(entry.plan.id()) { return true; }
            !matches!(&entry.handler, HookHandler::Plugin { instance_id, generation_key, revision, .. }
                if entry.workspace_scope.as_deref() == Some(token.workspace_scope.as_str())
                    && instance_id == &token.target_id
                    && generation_key == &token.generation_key
                    && revision == &token.revision)
        }).collect::<Vec<_>>();
        rebuild_entries(&mut state.entries, retained);
    }

    pub fn replace_command_source(
        &self,
        source: RuntimeHookSource,
        workspace_scope: Option<&str>,
        entries: Vec<RuntimeHookRegistration>,
    ) -> Result<(), RuntimeHookRegistryError> {
        if !matches!(
            source,
            RuntimeHookSource::UserCommand
                | RuntimeHookSource::ProjectCommand
                | RuntimeHookSource::ImportedCommand
        ) {
            return Err(RuntimeHookRegistryError::InvalidReplacementSource {
                hook_source: source,
            });
        }
        validate_entries(&entries)?;
        if entries.iter().any(|entry| entry.plan.source() != source) {
            return Err(RuntimeHookRegistryError::InvalidReplacementSource {
                hook_source: source,
            });
        }
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        let mut merged = state
            .entries
            .values()
            .flat_map(|items| items.iter().cloned())
            .filter(|entry| {
                entry.plan.source() != source || entry.workspace_scope.as_deref() != workspace_scope
            })
            .collect::<Vec<_>>();
        merged.extend(entries);
        validate_entries(&merged)?;
        rebuild_entries(&mut state.entries, merged);
        Ok(())
    }

    pub fn plans(&self) -> Vec<RuntimeHookPlan> {
        let state = self.inner.read().expect("hook registry lock poisoned");
        state
            .entries
            .values()
            .flat_map(|items| items.iter().map(|entry| entry.plan.clone()))
            .collect()
    }

    /// Compatibility spelling for internal callers while migration completes.
    pub fn hooks(&self) -> Vec<RuntimeHookPlan> {
        self.plans()
    }

    pub fn registrations_for(&self, kind: RuntimeHookKind) -> Arc<[RuntimeHookRegistration]> {
        self.registrations_for_workspace(kind, None)
    }

    pub fn registrations_for_workspace(
        &self,
        kind: RuntimeHookKind,
        workspace_scope: Option<&str>,
    ) -> Arc<[RuntimeHookRegistration]> {
        self.registrations_for_workspace_generation(kind, workspace_scope, None)
    }

    pub fn registrations_for_plugin_generation(
        &self,
        kind: RuntimeHookKind,
        workspace_scope: &str,
        generation: &super::handler::PluginHookGenerationIdentity,
    ) -> Arc<[RuntimeHookRegistration]> {
        self.registrations_for_workspace_generation(kind, Some(workspace_scope), Some(generation))
    }

    fn registrations_for_workspace_generation(
        &self,
        kind: RuntimeHookKind,
        workspace_scope: Option<&str>,
        requested_plugin_generation: Option<&super::handler::PluginHookGenerationIdentity>,
    ) -> Arc<[RuntimeHookRegistration]> {
        let state = self.inner.read().expect("hook registry lock poisoned");
        let entries = state
            .entries
            .get(&kind)
            .cloned()
            .unwrap_or_else(|| Arc::from([]));
        let plugin_activation = state
            .source_activation
            .get(&(
                RuntimeHookSource::Plugin,
                workspace_scope.map(str::to_string),
            ))
            .or_else(|| {
                state
                    .source_activation
                    .get(&(RuntimeHookSource::Plugin, None))
            })
            .copied()
            .unwrap_or(RuntimeHookActivation::Unavailable);
        let active_plugin_generation =
            workspace_scope.and_then(|workspace| state.active_plugin_generations.get(workspace));
        Arc::from(
            entries
                .iter()
                .filter(|entry| {
                    let workspace_matches = match (&entry.workspace_scope, workspace_scope) {
                        (Some(expected), Some(actual)) => expected == actual,
                        (None, _) => true,
                        (Some(_), None) => false,
                    };
                    let plugin_generation_matches = if !entry.plan.source().is_plugin() {
                        true
                    } else if plugin_activation != RuntimeHookActivation::Ready {
                        false
                    } else {
                        match (&entry.handler, requested_plugin_generation) {
                            (
                                HookHandler::Plugin {
                                    instance_id,
                                    generation_key,
                                    revision,
                                    ..
                                },
                                Some(requested),
                            ) => {
                                instance_id == &requested.instance_id
                                    && generation_key == &requested.generation_key
                                    && revision == &requested.revision
                            }
                            (
                                HookHandler::Plugin {
                                    instance_id,
                                    generation_key,
                                    revision,
                                    ..
                                },
                                None,
                            ) => {
                                matches!(active_plugin_generation,
                                    Some((active_instance, active_generation, active_revision))
                                        if instance_id == active_instance
                                            && generation_key == active_generation
                                            && revision == active_revision)
                            }
                            _ => false,
                        }
                    };
                    workspace_matches && plugin_generation_matches
                })
                .cloned()
                .collect::<Vec<_>>(),
        )
    }

    pub fn source_activation(&self, source: RuntimeHookSource) -> RuntimeHookActivation {
        self.source_activation_for_workspace(source, None)
    }

    pub fn source_activation_for_workspace(
        &self,
        source: RuntimeHookSource,
        workspace_scope: Option<&str>,
    ) -> RuntimeHookActivation {
        let state = self.inner.read().expect("hook registry lock poisoned");
        state
            .source_activation
            .get(&(source, workspace_scope.map(str::to_string)))
            .or_else(|| state.source_activation.get(&(source, None)))
            .copied()
            .unwrap_or_else(|| {
                if source.is_plugin() {
                    RuntimeHookActivation::Unavailable
                } else {
                    RuntimeHookActivation::Ready
                }
            })
    }

    pub fn set_source_activation(
        &self,
        source: RuntimeHookSource,
        activation: RuntimeHookActivation,
    ) {
        self.set_source_activation_for_workspace(source, None, activation);
    }

    pub fn set_source_activation_for_workspace(
        &self,
        source: RuntimeHookSource,
        workspace_scope: Option<&str>,
        activation: RuntimeHookActivation,
    ) {
        self.inner
            .write()
            .expect("hook registry lock poisoned")
            .source_activation
            .insert((source, workspace_scope.map(str::to_string)), activation);
    }

    pub fn activate_plugin_batch(
        &self,
        workspace_scope: &str,
        token: Option<&RuntimeHookCommitToken>,
    ) {
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        if let Some(token) = token {
            debug_assert_eq!(token.workspace_scope(), workspace_scope);
            state.active_plugin_generations.insert(
                workspace_scope.to_string(),
                (
                    token.target_id().to_string(),
                    token.generation_key().to_string(),
                    token.revision().to_string(),
                ),
            );
        } else {
            state.active_plugin_generations.remove(workspace_scope);
        }
        state.source_activation.insert(
            (RuntimeHookSource::Plugin, Some(workspace_scope.to_string())),
            RuntimeHookActivation::Ready,
        );
    }

    pub fn withdraw_plugin_workspace(&self, workspace_scope: &str) {
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        state.active_plugin_generations.remove(workspace_scope);
        state.source_activation.insert(
            (RuntimeHookSource::Plugin, Some(workspace_scope.to_string())),
            RuntimeHookActivation::Unavailable,
        );
    }

    pub fn clear_source_workspace(&self, source: RuntimeHookSource, workspace_scope: &str) {
        self.clear_source_partition(source, Some(workspace_scope));
    }

    pub fn clear_source_partition(&self, source: RuntimeHookSource, workspace_scope: Option<&str>) {
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        let retained = state
            .entries
            .values()
            .flat_map(|items| items.iter().cloned())
            .filter(|entry| {
                entry.plan.source() != source || entry.workspace_scope.as_deref() != workspace_scope
            })
            .collect::<Vec<_>>();
        rebuild_entries(&mut state.entries, retained);
        state
            .source_activation
            .remove(&(source, workspace_scope.map(str::to_string)));
        if source == RuntimeHookSource::Plugin {
            if let Some(workspace_scope) = workspace_scope {
                state.active_plugin_generations.remove(workspace_scope);
            }
        }
    }

    fn replace_state(
        &self,
        entries: Vec<RuntimeHookRegistration>,
    ) -> Result<(), RuntimeHookRegistryError> {
        let mut state = self.inner.write().expect("hook registry lock poisoned");
        rebuild_entries(&mut state.entries, entries);
        Ok(())
    }
}

fn validate_entries(entries: &[RuntimeHookRegistration]) -> Result<(), RuntimeHookRegistryError> {
    let mut ids = HashSet::with_capacity(entries.len());
    for entry in entries {
        let plan = &entry.plan;
        if plan.id().trim().is_empty() {
            return Err(RuntimeHookRegistryBuildError::EmptyHookId.into());
        }
        if plan.timeout_millis() == 0 {
            return Err(RuntimeHookRegistryBuildError::InvalidTimeoutMillis {
                hook_id: plan.id().to_string(),
            }
            .into());
        }
        if !ids.insert(plan.id().to_string()) {
            return Err(RuntimeHookRegistryBuildError::DuplicateHookId {
                hook_id: plan.id().to_string(),
            }
            .into());
        }
    }
    Ok(())
}

fn plugin_batch_identity(
    entries: &[RuntimeHookRegistration],
) -> Result<(String, String, String, String), RuntimeHookRegistryError> {
    let mut identity = None::<(String, String, String, String)>;
    for entry in entries {
        if entry.plan.source() != RuntimeHookSource::Plugin {
            return Err(RuntimeHookRegistryError::InvalidPluginBatch);
        }
        let HookHandler::Plugin {
            instance_id,
            generation_key,
            revision,
            ..
        } = &entry.handler
        else {
            return Err(RuntimeHookRegistryError::InvalidPluginBatch);
        };
        let Some(workspace_scope) = entry.workspace_scope.as_ref() else {
            return Err(RuntimeHookRegistryError::InvalidPluginBatch);
        };
        match &identity {
            Some((expected_workspace, expected_target, expected_generation, expected_revision))
                if expected_workspace != workspace_scope
                    || expected_target != instance_id
                    || expected_generation != generation_key
                    || expected_revision != revision =>
            {
                return Err(RuntimeHookRegistryError::InvalidPluginBatch)
            }
            None => {
                identity = Some((
                    workspace_scope.clone(),
                    instance_id.clone(),
                    generation_key.clone(),
                    revision.clone(),
                ))
            }
            Some(_) => {}
        }
    }
    identity.ok_or(RuntimeHookRegistryError::InvalidPluginBatch)
}

fn rebuild_entries(
    map: &mut BTreeMap<RuntimeHookKind, Arc<[RuntimeHookRegistration]>>,
    entries: Vec<RuntimeHookRegistration>,
) {
    map.clear();
    let mut by_kind = BTreeMap::<RuntimeHookKind, Vec<RuntimeHookRegistration>>::new();
    for entry in entries {
        by_kind
            .entry(entry.plan.kind().clone())
            .or_default()
            .push(entry);
    }
    for (kind, mut entries) in by_kind {
        entries.sort_by(|left, right| {
            left.plan
                .source()
                .cmp(&right.plan.source())
                .then_with(|| left.plan.order().cmp(&right.plan.order()))
                .then_with(|| left.plan.id().cmp(right.plan.id()))
        });
        map.insert(kind, Arc::from(entries));
    }
}
