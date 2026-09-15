//! Execution Engine Layer
//!
//! Responsible for AI interaction and model round control

pub(super) mod compression_request;
#[cfg(feature = "agent-runtime")]
pub(crate) mod conditional_instructions;
pub mod edit_constraint_guard;
pub mod execution_engine;
pub(crate) mod model_exchange_trace;
pub mod round_executor;
pub mod stream_processor;
pub mod types;
pub mod write_content_sanitizer;

pub use execution_engine::*;
pub use round_executor::*;
pub use stream_processor::*;
pub use types::{ExecutionContext, ExecutionResult, FinishReason, RoundContext, RoundResult};

/// Load the product-wide model-round policy from the initialized global config.
///
/// Product hosts use this shared assembly path so Desktop, CLI, Server, ACP,
/// SDK Host, and detached execution cannot silently drift to different limits.
pub async fn execution_engine_config_from_global_config() -> ExecutionEngineConfig {
    let Ok(config_service) = crate::service::config::get_global_config_service().await else {
        return ExecutionEngineConfig::default();
    };
    let Ok(global_config) = config_service
        .get_config::<crate::service::config::types::GlobalConfig>(None)
        .await
    else {
        return ExecutionEngineConfig::default();
    };
    ExecutionEngineConfig::from_ai_config(&global_config.ai)
}
