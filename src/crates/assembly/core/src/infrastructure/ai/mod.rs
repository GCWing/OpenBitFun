//! AI infrastructure
//!
//! Provides AI clients and related services

pub(crate) mod account_client_source;
pub(crate) mod channel_client_source;
pub mod client_factory;
pub(crate) mod provider_catalog;
pub(crate) mod reasoning_catalog;
pub mod tool_call_accumulator;

use std::time::Duration;

pub use openbitfun_ai_adapters::providers;
pub use openbitfun_ai_adapters::stream as ai_stream_handlers;

pub use client_factory::{
    get_global_ai_client_factory, initialize_global_ai_client_factory, AIClientFactory,
};
pub use openbitfun_ai_adapters::{AIClient, StreamOptions, StreamResponse};

use crate::service::config::types::{AIConfig, AIModelConfig};

pub fn build_stream_options(config: &AIConfig) -> StreamOptions {
    build_stream_options_for_model(config, None)
}

pub fn build_stream_options_for_model(
    config: &AIConfig,
    _model_config: Option<&AIModelConfig>,
) -> StreamOptions {
    let idle_timeout = config.stream_idle_timeout_secs.map(Duration::from_secs);

    StreamOptions {
        idle_timeout,
        ttft_timeout: config.stream_ttft_timeout_secs.map(Duration::from_secs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::config::types::AIModelConfig;

    #[test]
    fn model_reasoning_config_does_not_override_stream_timeouts() {
        let config = AIConfig::default();
        let model = AIModelConfig {
            reasoning: Some(openbitfun_core_types::ReasoningConfig::default()),
            ..Default::default()
        };

        let options = build_stream_options_for_model(&config, Some(&model));

        assert_eq!(options.ttft_timeout, Some(Duration::from_secs(600)));
        assert_eq!(options.idle_timeout, Some(Duration::from_secs(600)));
    }

    #[test]
    fn explicit_none_stream_timeouts_mean_wait_indefinitely() {
        let config = AIConfig {
            stream_idle_timeout_secs: None,
            stream_ttft_timeout_secs: None,
            ..Default::default()
        };

        let options = build_stream_options_for_model(&config, None);

        assert_eq!(options.ttft_timeout, None);
        assert_eq!(options.idle_timeout, None);
    }
}
