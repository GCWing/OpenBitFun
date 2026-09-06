//! MiniApp module — V2: ESM UI + Node Worker, Runtime Adapter, permission policy.

#[cfg(feature = "agent-runtime")]
pub mod agent_context;
pub mod builtin;
pub mod compiler;
pub mod exporter;
#[cfg(feature = "agent-runtime")]
pub mod host_dispatch;
pub mod js_worker;
pub mod js_worker_pool;
#[cfg(feature = "agent-runtime")]
pub mod loopx;
pub mod manager;
pub mod runtime_detect;
pub mod storage;
pub use openbitfun_product_domains::miniapp::customization::{
    MiniAppAvailableBuiltinUpdate, MiniAppCustomizationMetadata, MiniAppCustomizationOrigin,
    MiniAppCustomizationOriginKind, MiniAppDeclinedBuiltinUpdate, MiniAppPermissionDiff,
};
pub use openbitfun_product_domains::miniapp::draft::{MiniAppDraft, MiniAppDraftManifest};
pub use openbitfun_product_domains::miniapp::{
    agent_bridge, ai_bridge, bridge_builder, lifecycle, permission_policy, rate_limit, types,
};
pub use openbitfun_product_domains::miniapp::builtin::builtin_content_hash;

pub use builtin::{seed_builtin_miniapps, BuiltinApp, BUILTIN_APPS};
pub use exporter::{ExportCheckResult, ExportOptions, ExportResult, ExportTarget, MiniAppExporter};
#[cfg(feature = "agent-runtime")]
pub use host_dispatch::{dispatch_host, is_host_primitive};
pub use js_worker_pool::{InstallResult, JsWorkerPool};
pub use manager::{
    initialize_global_miniapp_manager, try_get_global_miniapp_manager, MiniAppManager,
};
pub use permission_policy::resolve_policy;
pub use runtime_detect::{DetectedRuntime, RuntimeKind};
pub use storage::MiniAppStorage;
pub use types::{
    AgentPermissions, AiPermissions, EsmDep, FsPermissions, MiniApp, MiniAppAiContext, MiniAppMeta,
    MiniAppPermissions, MiniAppSource, NetPermissions, NodePermissions, NpmDep, PathScope,
    ShellPermissions,
};
