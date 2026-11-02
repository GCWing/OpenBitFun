use async_trait::async_trait;
use std::sync::Arc;

use crate::service::config::ConfigService;
use crate::service::mcp::server::MCPServerConfig;
use crate::util::errors::OpenBitFunResult;

pub struct MCPConfigService {
    pub(super) inner: openbitfun_services_integrations::mcp::config::MCPConfigService,
}

struct CoreMCPConfigStore {
    config_service: Arc<ConfigService>,
}

#[async_trait]
impl openbitfun_services_integrations::mcp::config::MCPConfigStore for CoreMCPConfigStore {
    async fn get_config_value(
        &self,
        key: &str,
    ) -> openbitfun_services_integrations::mcp::MCPRuntimeResult<Option<serde_json::Value>> {
        match self
            .config_service
            .get_config::<serde_json::Value>(Some(key))
            .await
        {
            Ok(value) => Ok(Some(value)),
            Err(crate::util::errors::OpenBitFunError::NotFound(_)) => Ok(None),
            Err(error) => Err(
                openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(
                    error.to_string(),
                ),
            ),
        }
    }

    async fn set_config_value(
        &self,
        key: &str,
        value: serde_json::Value,
    ) -> openbitfun_services_integrations::mcp::MCPRuntimeResult<()> {
        self.config_service
            .set_config(key, value)
            .await
            .map_err(|e| {
                openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(e.to_string())
            })
    }

    async fn compare_and_set_config_value(
        &self,
        key: &str,
        expected: Option<serde_json::Value>,
        replacement: serde_json::Value,
    ) -> openbitfun_services_integrations::mcp::MCPRuntimeResult<bool> {
        self.config_service
            .compare_and_set_json_config(key, expected, replacement)
            .await
            .map_err(|error| {
                openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(
                    error.to_string(),
                )
            })
    }
}

impl MCPConfigService {
    pub fn get_remote_authorization_value(config: &MCPServerConfig) -> Option<String> {
        openbitfun_services_integrations::mcp::config::MCPConfigService::get_remote_authorization_value(
            config,
        )
    }

    pub fn get_remote_authorization_source(config: &MCPServerConfig) -> Option<&'static str> {
        openbitfun_services_integrations::mcp::config::MCPConfigService::get_remote_authorization_source(
            config,
        )
    }

    pub fn has_remote_authorization(config: &MCPServerConfig) -> bool {
        openbitfun_services_integrations::mcp::config::MCPConfigService::has_remote_authorization(
            config,
        )
    }

    pub fn has_remote_oauth(config: &MCPServerConfig) -> bool {
        openbitfun_services_integrations::mcp::config::MCPConfigService::has_remote_oauth(config)
    }

    pub fn has_remote_xaa(config: &MCPServerConfig) -> bool {
        openbitfun_services_integrations::mcp::config::MCPConfigService::has_remote_xaa(config)
    }

    pub fn new(config_service: Arc<ConfigService>) -> OpenBitFunResult<Self> {
        let store = Arc::new(CoreMCPConfigStore { config_service });
        Ok(Self {
            inner: openbitfun_services_integrations::mcp::config::MCPConfigService::new(store),
        })
    }

    pub async fn load_all_configs(&self) -> OpenBitFunResult<Vec<MCPServerConfig>> {
        Ok(self.inner.load_all_configs().await?)
    }

    pub async fn user_control_snapshot(
        &self,
    ) -> Result<
        openbitfun_services_integrations::mcp::config::MCPControlConfigSnapshot,
        openbitfun_services_integrations::mcp::config::MCPImportError,
    > {
        self.inner.user_control_snapshot().await
    }

    pub async fn edit_user_server(
        &self,
        expected_fingerprint: &str,
        server_id: &str,
        patch: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<(), openbitfun_services_integrations::mcp::config::MCPImportError> {
        self.inner
            .edit_user_server(expected_fingerprint, server_id, patch)
            .await
    }

    pub async fn get_server_config(
        &self,
        server_id: &str,
    ) -> OpenBitFunResult<Option<MCPServerConfig>> {
        Ok(self.inner.get_server_config(server_id).await?)
    }

    pub async fn save_server_config(&self, config: &MCPServerConfig) -> OpenBitFunResult<()> {
        Ok(self.inner.save_server_config(config).await?)
    }

    pub async fn set_remote_authorization(
        &self,
        server_id: &str,
        authorization_value: &str,
    ) -> OpenBitFunResult<MCPServerConfig> {
        Ok(self
            .inner
            .set_remote_authorization(server_id, authorization_value)
            .await?)
    }

    pub async fn clear_remote_authorization(
        &self,
        server_id: &str,
    ) -> OpenBitFunResult<MCPServerConfig> {
        Ok(self.inner.clear_remote_authorization(server_id).await?)
    }

    pub async fn delete_server_config(&self, server_id: &str) -> OpenBitFunResult<()> {
        Ok(self.inner.delete_server_config(server_id).await?)
    }

    pub async fn user_import_snapshot(
        &self,
    ) -> Result<
        openbitfun_services_integrations::mcp::config::MCPUserImportSnapshot,
        openbitfun_services_integrations::mcp::config::MCPImportError,
    > {
        self.inner.user_import_snapshot().await
    }

    pub async fn apply_user_import(
        &self,
        expected_fingerprint: &str,
        imports: Vec<openbitfun_services_integrations::mcp::config::MCPImportServer>,
    ) -> Result<(), openbitfun_services_integrations::mcp::config::MCPImportError> {
        self.inner
            .apply_user_import(expected_fingerprint, imports)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::mcp::config::ConfigLocation;
    use crate::service::mcp::server::MCPServerType;
    use std::collections::HashMap;

    fn make_config(
        id: &str,
        location: ConfigLocation,
        server_type: MCPServerType,
        command: Option<&str>,
        url: Option<&str>,
    ) -> MCPServerConfig {
        MCPServerConfig {
            id: id.to_string(),
            name: id.to_string(),
            server_type,
            transport: None,
            command: command.map(str::to_string),
            args: Vec::new(),
            env: HashMap::new(),
            working_directory: None,
            inherit_parent_environment: None,
            headers: HashMap::new(),
            url: url.map(str::to_string),
            auto_start: true,
            enabled: true,
            location,
            capabilities: Vec::new(),
            settings: Default::default(),
            oauth: None,
            oauth_enabled: None,
            xaa: None,
            timeouts: Default::default(),
        }
    }

    #[test]
    fn remote_authorization_prefers_headers_and_normalizes_tokens() {
        let mut config = make_config(
            "remote-auth",
            ConfigLocation::User,
            MCPServerType::Remote,
            None,
            Some("https://example.com/mcp"),
        );
        config
            .env
            .insert("Authorization".to_string(), "process-env-token".to_string());
        config.headers.insert(
            "Authorization".to_string(),
            "Bearer header-token".to_string(),
        );

        assert_eq!(
            MCPConfigService::get_remote_authorization_value(&config).as_deref(),
            Some("Bearer header-token")
        );
        assert_eq!(
            MCPConfigService::get_remote_authorization_source(&config),
            Some("headers")
        );
        assert_eq!(
            openbitfun_services_integrations::mcp::config::normalize_mcp_authorization_value(
                "plain-token"
            )
            .as_deref(),
            Some("Bearer plain-token")
        );
    }
}
