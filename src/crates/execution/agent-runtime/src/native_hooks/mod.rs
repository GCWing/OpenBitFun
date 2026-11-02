//! Native OpenBitFun agent lifecycle hooks.
//!
//! This module owns the portable hook engine that executes user-configured
//! command hooks at agent lifecycle events. The configuration document, event
//! names, process interface (stdin JSON payload, exit-code semantics, stdout
//! decision schema), matcher semantics, and timeout defaults are kept
//! consistent with Codex hooks so users can reuse existing hook scripts.
//!
//! The engine is host-independent: it receives already-loaded settings layers
//! and fully-built payloads, and never resolves OpenBitFun config paths itself.
//! Config discovery, scope gating, and dispatch-site integration live in
//! `openbitfun-core` (`native_hooks` wiring).
//!
//! Distinct from:
//! - `post_call_hooks`: internal compiled-in Rust hooks (not user-configured).
//! - the external hook catalog (`openbitfun-product-domains`): read-only
//!   inspection of other AI applications' hook configuration.

#[cfg(feature = "native-hook-runtime")]
mod call;
#[cfg(feature = "native-hook-runtime")]
mod engine;
#[cfg(feature = "native-hook-runtime")]
mod handler;
#[cfg(feature = "native-hook-runtime")]
mod kind;
#[cfg(feature = "native-hook-runtime")]
mod output;
#[cfg(feature = "native-hook-runtime")]
mod payload;
#[cfg(feature = "native-hook-runtime")]
mod registry;
mod settings;

#[cfg(feature = "native-hook-runtime")]
pub use call::{HookCall, HookCallPayload};
#[cfg(feature = "native-hook-runtime")]
pub use engine::{AgentHookEngine, PluginHookDispatchResult, MAX_HOOK_MODEL_OUTPUT_BYTES};
#[cfg(feature = "native-hook-runtime")]
pub use handler::{
    BuiltinHookExecutor, CommandHookOptions, HookHandler, HookHandlerResult, HookInputAdapter,
    HookToolMapping, PluginHookCall, PluginHookExecutor, PluginHookGenerationIdentity,
    PluginHookResult, RuntimeHookRegistration,
};
#[cfg(feature = "native-hook-runtime")]
pub use kind::{RuntimeHookKind, RuntimeHookSource};
#[cfg(feature = "native-hook-runtime")]
pub use output::{AgentHookOutcome, AgentHookPermissionOutcome};
#[cfg(feature = "native-hook-runtime")]
pub use payload::{
    AgentHookEventPayload, AgentHookPayload, AgentHookPayloadCommon, AgentHookPermissionMode,
};
#[cfg(feature = "native-hook-runtime")]
pub use registry::{
    RuntimeHookActivation, RuntimeHookCommitToken, RuntimeHookErrorPolicy, RuntimeHookPlan,
    RuntimeHookRegistry, RuntimeHookRegistryBuildError, RuntimeHookRegistryBuilder,
    RuntimeHookRegistryError,
};
pub use settings::{
    AgentHookEvent, AgentHookHandler, AgentHookMatcher, AgentHookRule, AgentHookScope,
    AgentHookSettings, AgentHookSettingsIssue, AgentHookSettingsLayer, MAX_HOOKS_FILE_BYTES,
    MAX_HOOK_HANDLERS,
};
