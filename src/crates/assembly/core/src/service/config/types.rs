//! Shared persisted configuration records and live provider interface.

use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
pub use openbitfun_config_contracts::*;

/// Configuration provider interface.
#[async_trait]
pub trait ConfigProvider: Send + Sync {
    /// Provider name.
    fn name(&self) -> &str;

    /// Returns the default configuration.
    fn get_default_config(&self) -> serde_json::Value;

    /// Validates configuration.
    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>>;

    /// Called when configuration changes.
    async fn on_config_changed(
        &self,
        old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()>;
}
