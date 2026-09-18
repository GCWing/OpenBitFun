//! Shared low-level product DTOs.
//!
//! This crate must stay lightweight: do not add runtime, network, platform, or
//! product assembly dependencies here.

pub mod agent_identity;
pub mod agent_identity_wire;
pub mod ai;
pub mod errors;
pub mod installer_config_handoff;
pub mod model;
pub mod product_identity;
pub mod session;
pub mod session_usage;
pub mod speech;
pub mod surface;
pub mod tool_image_attachment;
pub mod worktree;

pub use ai::{
    AIConfig, ConnectionTestMessageCode, ConnectionTestResult, Message, ModelReasoningSummaryPart,
    ModelRequestContext, ModelResponseReplay, ModelResponseReplayItem, ModelsDevCatalogSource,
    ModelsDevCatalogStatus, ModelsDevReasoningCatalog, ModelsDevReasoningModel,
    ModelsDevReasoningProvider, ModelsDevRefreshResult, ModelsDevRefreshStatus, ProviderCatalog,
    ProviderCatalogEndpoint, ProviderCatalogModel, ProviderCatalogModelCapabilities,
    ProviderCatalogModelLimits, ProviderCatalogModelPricing, ProviderCatalogModelSource,
    ProviderCatalogProvider, ProviderCatalogSource, ProviderCatalogUpstreamProvider, ProxyConfig,
    ReasoningCapabilityStatus, ReasoningCatalogBinding, ReasoningCatalogProjection,
    ReasoningCatalogProjectionRequest, ReasoningConfig, ReasoningContentKind, ReasoningPreset,
    ReasoningPresetAction, ReasoningPresetDescriptor, ReasoningPresetSource, RemoteModelInfo,
    RemoteModelRouting, ToolCall, ToolCallConfirmationDetails, ToolCallRequestInfo,
    ToolCallResponseInfo, ToolDefinition,
};
pub use errors::{AiErrorDetail, ErrorCategory};
pub use model::{
    ModelEditProjection, ModelListProjection, ModelMutation, ModelSummary, SecretUpdate,
    TuiModelCatalogProjection,
};
pub use session::{
    validate_session_id, SessionAgentRouteOwner, SessionContinuationPolicy, SessionKind,
    SessionModelBindingPolicy, SESSION_PROVIDER_ACP, SESSION_PROVIDER_METADATA_KEY,
};
pub use session_usage::*;
pub use speech::*;
pub use surface::{
    ApprovalSource, CapabilityRequest, CapabilityRequestKind, PermissionDecision, PermissionScope,
    RuntimeArtifactKind, RuntimeArtifactRef, SurfaceKind, ThreadEnvironment, ThreadEnvironmentKind,
};
pub use tool_image_attachment::ToolImageAttachment;
pub use worktree::{
    SessionExecutionTarget, SessionExecutionTargetKind, SessionExecutionTargetRequest,
    WorktreeError, WorktreeErrorCode, WorktreeLifecycle, WorktreeSessionSummary, WorktreeSettings,
    WorktreeSummary,
};

pub mod workspace;
pub use workspace::WorkspaceKind;
