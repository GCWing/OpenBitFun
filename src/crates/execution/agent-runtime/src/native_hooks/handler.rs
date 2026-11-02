//! Executable hook handler variants.

use super::call::HookCall;
use super::kind::{RuntimeHookKind, RuntimeHookSource};
use super::registry::RuntimeHookPlan;
use super::settings::{AgentHookHandler, AgentHookMatcher};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A host-supplied translation for a command hook's tool vocabulary. Native
/// command registrations have no mapping and retain their existing contract.
#[derive(Debug, Clone)]
pub struct HookToolMapping {
    pub runtime_name: String,
    pub hook_name: String,
    /// Runtime argument name -> hook argument name; reversed for updatedInput.
    pub input_fields: BTreeMap<String, String>,
    pub input_adapter: Option<Arc<dyn HookInputAdapter>>,
}

/// Provider-owned transformations for tools with different input encodings.
pub trait HookInputAdapter: Send + Sync + std::fmt::Debug {
    fn to_hook(&self, input: &mut Value) -> Result<(), String>;
    fn to_runtime(&self, input: &mut Value) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct CommandHookOptions {
    pub environment: BTreeMap<String, String>,
    pub tool_mappings: Vec<HookToolMapping>,
    /// Opt-in for sources whose contract supports a PreToolUse ask decision.
    pub supports_ask: bool,
    /// Shared across dispatch snapshots; failures leave this false for retry.
    pub once: Option<tokio::sync::Mutex<bool>>,
}

#[derive(Clone)]
pub enum HookHandler {
    Command(AgentHookHandler),
    Plugin {
        executor: Arc<dyn PluginHookExecutor>,
        hook_name: String,
        instance_id: String,
        generation_key: String,
        revision: String,
    },
    Builtin {
        executor: Arc<dyn BuiltinHookExecutor>,
    },
}

impl std::fmt::Debug for HookHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Command(handler) => f.debug_tuple("Command").field(handler).finish(),
            Self::Plugin {
                hook_name,
                instance_id,
                generation_key,
                revision,
                ..
            } => f
                .debug_struct("Plugin")
                .field("hook_name", hook_name)
                .field("instance_id", instance_id)
                .field("generation_key", generation_key)
                .field("revision", revision)
                .finish_non_exhaustive(),
            Self::Builtin { .. } => f.debug_struct("Builtin").finish_non_exhaustive(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HookHandlerResult {
    pub warnings: Vec<String>,
    pub block_reason: Option<String>,
    pub additional_context: Vec<String>,
}

#[async_trait]
pub trait BuiltinHookExecutor: Send + Sync {
    async fn execute(&self, call: &HookCall) -> HookHandlerResult;
}

#[derive(Debug, Clone, PartialEq)]
pub struct PluginHookCall {
    pub instance_id: String,
    pub workspace_scope: String,
    pub generation_key: String,
    pub revision: String,
    pub hook_name: String,
    pub input: Value,
    pub output: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PluginHookResult {
    pub instance_id: String,
    pub generation_key: String,
    pub revision: String,
    pub hook_name: String,
    pub input: Value,
    pub output: Value,
}

#[async_trait]
pub trait PluginHookExecutor: Send + Sync {
    async fn execute(&self, call: PluginHookCall) -> Result<PluginHookResult, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHookGenerationIdentity {
    pub instance_id: String,
    pub generation_key: String,
    pub revision: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeHookRegistration {
    pub plan: RuntimeHookPlan,
    pub handler: HookHandler,
    pub matcher: AgentHookMatcher,
    pub workspace_scope: Option<String>,
    pub command_options: Arc<CommandHookOptions>,
    pub requires_project_trust: bool,
    pub(crate) active: Option<Arc<AtomicBool>>,
    pub(crate) cancellation: Option<tokio::sync::watch::Receiver<bool>>,
}

impl RuntimeHookRegistration {
    pub fn new(plan: RuntimeHookPlan, handler: HookHandler, matcher: AgentHookMatcher) -> Self {
        Self {
            plan,
            handler,
            matcher,
            workspace_scope: None,
            command_options: Arc::default(),
            requires_project_trust: false,
            active: None,
            cancellation: None,
        }
    }

    pub fn with_command_options(mut self, options: CommandHookOptions) -> Self {
        self.command_options = Arc::new(options);
        self
    }

    pub(crate) fn is_active(&self) -> bool {
        self.active
            .as_ref()
            .is_none_or(|active| active.load(Ordering::Acquire))
    }

    pub(crate) async fn cancelled(&self) {
        let Some(mut cancellation) = self.cancellation.clone() else {
            return std::future::pending().await;
        };
        if *cancellation.borrow() {
            return;
        }
        let _ = cancellation.changed().await;
    }

    pub fn with_workspace_scope(mut self, workspace_scope: impl Into<String>) -> Self {
        self.workspace_scope = Some(workspace_scope.into());
        self
    }

    pub fn command(
        id: impl Into<String>,
        kind: RuntimeHookKind,
        source: RuntimeHookSource,
        handler: AgentHookHandler,
        matcher: AgentHookMatcher,
    ) -> Self {
        Self::new(
            RuntimeHookPlan::new(id, kind, source),
            HookHandler::Command(handler),
            matcher,
        )
    }

    pub fn plugin(
        plan: RuntimeHookPlan,
        hook_name: impl Into<String>,
        instance_id: impl Into<String>,
        generation_key: impl Into<String>,
        revision: impl Into<String>,
        executor: Arc<dyn PluginHookExecutor>,
        matcher: AgentHookMatcher,
    ) -> Self {
        Self::new(
            plan,
            HookHandler::Plugin {
                executor,
                hook_name: hook_name.into(),
                instance_id: instance_id.into(),
                generation_key: generation_key.into(),
                revision: revision.into(),
            },
            matcher,
        )
    }
}
