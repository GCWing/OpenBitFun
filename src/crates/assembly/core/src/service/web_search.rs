//! Product runtime selection and device-local credentials for WebSearch.

use crate::infrastructure::try_get_path_manager_arc;
use crate::service::config::types::{AIConfig, WebSearchConfig};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_runtime_ports::{
    WebSearchError, WebSearchErrorKind, WebSearchProvider, WebSearchProviderId, WebSearchRequest,
    WebSearchResponse,
};
use openbitfun_services_core::credential_vault::CredentialVault;
use openbitfun_services_integrations::web_tools::{
    DeepSeekSearchProvider, ExaSearchApiProvider, FreeExaMcpProvider, OpenBitFunSearchHttpAuth,
    OpenBitFunSearchHttpProvider, TavilySearchProvider,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

const WEB_SEARCH_VAULT_KEY_FILE: &str = "credentials.key";
const WEB_SEARCH_VAULT_FILE: &str = "credentials.json";

pub struct WebSearchRuntime {
    provider: RwLock<Arc<dyn WebSearchProvider>>,
}

impl Default for WebSearchRuntime {
    fn default() -> Self {
        Self {
            provider: RwLock::new(Arc::new(FreeExaMcpProvider)),
        }
    }
}

impl WebSearchRuntime {
    async fn replace(&self, provider: Arc<dyn WebSearchProvider>) {
        *self.provider.write().await = provider;
    }

    async fn refresh(&self, config: &WebSearchConfig) {
        self.replace(resolve_provider(config).await).await;
    }
}

#[async_trait]
impl WebSearchProvider for WebSearchRuntime {
    fn id(&self) -> WebSearchProviderId {
        // The concrete provider id is returned in WebSearchResponse. This id is
        // intentionally stable for diagnostics before a request is dispatched.
        WebSearchProviderId::new("configured")
    }

    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResponse, WebSearchError> {
        let provider = Arc::clone(&*self.provider.read().await);
        provider.search(request).await
    }
}

static GLOBAL_WEB_SEARCH_RUNTIME: OnceLock<Arc<WebSearchRuntime>> = OnceLock::new();

pub fn global_web_search_runtime() -> Arc<dyn WebSearchProvider> {
    GLOBAL_WEB_SEARCH_RUNTIME
        .get_or_init(|| Arc::new(WebSearchRuntime::default()))
        .clone()
}

pub async fn refresh_global_web_search_runtime(ai_config: &AIConfig) {
    GLOBAL_WEB_SEARCH_RUNTIME
        .get_or_init(|| Arc::new(WebSearchRuntime::default()))
        .refresh(&ai_config.web_search)
        .await;
}

fn credential_vault() -> OpenBitFunResult<CredentialVault> {
    let directory = try_get_path_manager_arc()?
        .user_data_dir()
        .join("web-search");
    Ok(credential_vault_in(&directory))
}

fn credential_vault_in(directory: &Path) -> CredentialVault {
    CredentialVault::new(
        directory.join(WEB_SEARCH_VAULT_KEY_FILE),
        directory.join(WEB_SEARCH_VAULT_FILE),
    )
}

fn credential_entry_id(credential_id: &str) -> OpenBitFunResult<&str> {
    let credential_id = credential_id.trim();
    if credential_id.is_empty() {
        return Err(OpenBitFunError::config(
            "WebSearch credential reference is empty".to_string(),
        ));
    }
    Ok(credential_id)
}

async fn read_credential(vault: &CredentialVault, credential_id: &str) -> OpenBitFunResult<String> {
    let credential_id = credential_entry_id(credential_id)?;
    let bytes = vault
        .get(credential_id)
        .await
        .map_err(|error| {
            OpenBitFunError::config(format!("Failed to read WebSearch credential: {error}"))
        })?
        .ok_or_else(|| {
            OpenBitFunError::config(
                "WebSearch credential is not configured on this device".to_string(),
            )
        })?;
    String::from_utf8(bytes)
        .map_err(|_| OpenBitFunError::config("WebSearch credential is not valid UTF-8".to_string()))
}

async fn resolve_provider(config: &WebSearchConfig) -> Arc<dyn WebSearchProvider> {
    let selected = config.provider.trim();
    let provider_id = WebSearchProviderId::new(if selected.is_empty() {
        WebSearchProviderId::EXA_MCP_FREE
    } else {
        selected
    });
    let resolved: OpenBitFunResult<Arc<dyn WebSearchProvider>> = async {
        match provider_id.as_str() {
            WebSearchProviderId::EXA_MCP_FREE => {
                Ok(Arc::new(FreeExaMcpProvider) as Arc<dyn WebSearchProvider>)
            }
            WebSearchProviderId::EXA_SEARCH_API => {
                let vault = credential_vault()?;
                let secret =
                    read_credential(&vault, &config.providers.exa_search_api.credential_id).await?;
                Ok(Arc::new(ExaSearchApiProvider::new(secret)) as Arc<dyn WebSearchProvider>)
            }
            WebSearchProviderId::TAVILY => {
                let vault = credential_vault()?;
                let secret =
                    read_credential(&vault, &config.providers.tavily.credential_id).await?;
                Ok(Arc::new(TavilySearchProvider::new(secret)) as Arc<dyn WebSearchProvider>)
            }
            WebSearchProviderId::DEEPSEEK => {
                let vault = credential_vault()?;
                let secret =
                    read_credential(&vault, &config.providers.deepseek.credential_id).await?;
                Ok(Arc::new(DeepSeekSearchProvider::new(secret)) as Arc<dyn WebSearchProvider>)
            }
            WebSearchProviderId::OPENBITFUN_SEARCH_HTTP => {
                let http = &config.providers.openbitfun_search_http;
                if http.endpoint.trim().is_empty() {
                    return Err(OpenBitFunError::config(
                        "OpenBitFun Search HTTP endpoint is not configured".to_string(),
                    ));
                }
                let auth = match http.auth.mode.trim() {
                    "" | "none" => OpenBitFunSearchHttpAuth::None,
                    "bearer" => {
                        let vault = credential_vault()?;
                        OpenBitFunSearchHttpAuth::Bearer(
                            read_credential(&vault, &http.auth.credential_id).await?,
                        )
                    }
                    "header" => {
                        if http.auth.header_name.trim().is_empty() {
                            return Err(OpenBitFunError::config(
                                "OpenBitFun Search HTTP auth header name is not configured"
                                    .to_string(),
                            ));
                        }
                        let vault = credential_vault()?;
                        OpenBitFunSearchHttpAuth::Header {
                            name: http.auth.header_name.trim().to_string(),
                            value: read_credential(&vault, &http.auth.credential_id).await?,
                        }
                    }
                    mode => {
                        return Err(OpenBitFunError::config(format!(
                            "Unsupported OpenBitFun Search HTTP authentication mode '{mode}'"
                        )))
                    }
                };
                let provider = OpenBitFunSearchHttpProvider::new(http.endpoint.trim(), auth)
                    .map_err(|error| OpenBitFunError::config(error.message))?;
                Ok(Arc::new(provider) as Arc<dyn WebSearchProvider>)
            }
            unknown => Err(OpenBitFunError::config(format!(
                "Unsupported WebSearch provider '{unknown}'"
            ))),
        }
    }
    .await;

    resolved.unwrap_or_else(|error| {
        Arc::new(UnavailableWebSearchProvider {
            provider: provider_id,
            message: error.to_string(),
        })
    })
}

struct UnavailableWebSearchProvider {
    provider: WebSearchProviderId,
    message: String,
}

#[async_trait]
impl WebSearchProvider for UnavailableWebSearchProvider {
    fn id(&self) -> WebSearchProviderId {
        self.provider.clone()
    }

    async fn search(
        &self,
        _request: WebSearchRequest,
    ) -> Result<WebSearchResponse, WebSearchError> {
        Err(WebSearchError::new(
            self.provider.clone(),
            WebSearchErrorKind::InvalidConfiguration,
            self.message.clone(),
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebSearchCredentialRequest {
    pub provider: String,
    pub secret: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearWebSearchCredentialRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchCredentialStatus {
    pub provider: String,
    pub configured: bool,
}

fn credential_id_for_provider<'a>(
    config: &'a WebSearchConfig,
    provider: &str,
) -> OpenBitFunResult<&'a str> {
    match provider.trim() {
        WebSearchProviderId::EXA_SEARCH_API => {
            Ok(config.providers.exa_search_api.credential_id.as_str())
        }
        WebSearchProviderId::TAVILY => Ok(config.providers.tavily.credential_id.as_str()),
        WebSearchProviderId::DEEPSEEK => Ok(config.providers.deepseek.credential_id.as_str()),
        WebSearchProviderId::OPENBITFUN_SEARCH_HTTP => {
            if matches!(
                config.providers.openbitfun_search_http.auth.mode.trim(),
                "" | "none"
            ) {
                return Err(OpenBitFunError::validation(
                    "OpenBitFun Search HTTP authentication mode does not use a credential"
                        .to_string(),
                ));
            }
            Ok(config
                .providers
                .openbitfun_search_http
                .auth
                .credential_id
                .as_str())
        }
        _ => Err(OpenBitFunError::validation(format!(
            "WebSearch provider '{provider}' does not accept a device credential"
        ))),
    }
}

async fn current_ai_config() -> OpenBitFunResult<AIConfig> {
    crate::service::config::get_global_config_service()
        .await?
        .get_config(Some("ai"))
        .await
}

async fn credential_is_configured(
    vault: &CredentialVault,
    credential_id: &str,
) -> OpenBitFunResult<bool> {
    let credential_id = credential_entry_id(credential_id)?;
    vault
        .get(credential_id)
        .await
        .map(|secret| secret.is_some())
        .map_err(|error| {
            OpenBitFunError::config(format!("Failed to read WebSearch credential: {error}"))
        })
}

async fn store_credential(
    vault: &CredentialVault,
    credential_id: &str,
    secret: &str,
) -> OpenBitFunResult<()> {
    let credential_id = credential_entry_id(credential_id)?;
    vault
        .set(credential_id, secret.as_bytes())
        .await
        .map_err(|error| {
            OpenBitFunError::config(format!("Failed to save WebSearch credential: {error}"))
        })
}

async fn remove_credential(vault: &CredentialVault, credential_id: &str) -> OpenBitFunResult<()> {
    let credential_id = credential_entry_id(credential_id)?;
    vault.remove(credential_id).await.map_err(|error| {
        OpenBitFunError::config(format!("Failed to clear WebSearch credential: {error}"))
    })
}

pub async fn get_web_search_credential_status(
    provider: &str,
) -> OpenBitFunResult<WebSearchCredentialStatus> {
    let ai = current_ai_config().await?;
    let credential_id = credential_id_for_provider(&ai.web_search, provider)?;
    let configured = credential_is_configured(&credential_vault()?, credential_id).await?;
    Ok(WebSearchCredentialStatus {
        provider: provider.to_string(),
        configured,
    })
}

pub async fn save_web_search_credential(
    request: SaveWebSearchCredentialRequest,
) -> OpenBitFunResult<WebSearchCredentialStatus> {
    if request.secret.trim().is_empty() {
        return Err(OpenBitFunError::validation(
            "WebSearch credential cannot be empty".to_string(),
        ));
    }
    let ai = current_ai_config().await?;
    let credential_id = credential_id_for_provider(&ai.web_search, request.provider.trim())?;
    store_credential(&credential_vault()?, credential_id, &request.secret).await?;
    refresh_global_web_search_runtime(&ai).await;
    Ok(WebSearchCredentialStatus {
        provider: request.provider,
        configured: true,
    })
}

pub async fn clear_web_search_credential(
    request: ClearWebSearchCredentialRequest,
) -> OpenBitFunResult<WebSearchCredentialStatus> {
    let ai = current_ai_config().await?;
    let credential_id = credential_id_for_provider(&ai.web_search, request.provider.trim())?;
    remove_credential(&credential_vault()?, credential_id).await?;
    refresh_global_web_search_runtime(&ai).await;
    Ok(WebSearchCredentialStatus {
        provider: request.provider,
        configured: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::WebSearchResult;
    use std::time::Duration;
    use tempfile::Builder;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct FixedProvider {
        id: &'static str,
    }

    #[async_trait]
    impl WebSearchProvider for FixedProvider {
        fn id(&self) -> WebSearchProviderId {
            WebSearchProviderId::new(self.id)
        }

        async fn search(
            &self,
            _request: WebSearchRequest,
        ) -> Result<WebSearchResponse, WebSearchError> {
            Ok(WebSearchResponse {
                provider: self.id(),
                results: Vec::new(),
            })
        }
    }

    struct WaitingProvider {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl WebSearchProvider for WaitingProvider {
        fn id(&self) -> WebSearchProviderId {
            WebSearchProviderId::new("waiting")
        }

        async fn search(
            &self,
            _request: WebSearchRequest,
        ) -> Result<WebSearchResponse, WebSearchError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(WebSearchResponse {
                provider: self.id(),
                results: vec![WebSearchResult {
                    title: "Waiting result".to_string(),
                    url: "https://example.com/waiting".to_string(),
                    published_at: None,
                    author: None,
                }],
            })
        }
    }

    fn test_request() -> WebSearchRequest {
        WebSearchRequest {
            query: "runtime switch".to_string(),
            max_results: 1,
        }
    }

    #[tokio::test]
    async fn unavailable_provider_fails_loudly_without_fallback() {
        let mut config = WebSearchConfig::default();
        config.provider = "future_search".to_string();

        let provider = resolve_provider(&config).await;
        let error = provider
            .search(test_request())
            .await
            .expect_err("unknown provider must remain unavailable");

        assert_eq!(error.provider.as_str(), "future_search");
        assert_eq!(error.kind, WebSearchErrorKind::InvalidConfiguration);
        assert!(error.message.contains("Unsupported WebSearch provider"));
    }

    #[tokio::test]
    async fn provider_replacement_does_not_hold_the_lock_across_search_await() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runtime = Arc::new(WebSearchRuntime {
            provider: RwLock::new(Arc::new(WaitingProvider {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
            })),
        });

        let in_flight_runtime = Arc::clone(&runtime);
        let in_flight = tokio::spawn(async move { in_flight_runtime.search(test_request()).await });
        started.notified().await;

        tokio::time::timeout(
            Duration::from_secs(1),
            runtime.replace(Arc::new(FixedProvider { id: "replacement" })),
        )
        .await
        .expect("provider replacement must not wait for an in-flight network call");

        let replacement_response = runtime
            .search(test_request())
            .await
            .expect("replacement provider should serve new calls");
        assert_eq!(replacement_response.provider.as_str(), "replacement");

        release.notify_one();
        let original_response = in_flight
            .await
            .expect("in-flight task should join")
            .expect("in-flight provider should complete");
        assert_eq!(original_response.provider.as_str(), "waiting");
    }

    #[tokio::test]
    async fn device_local_credential_lifecycle_keeps_secret_out_of_config() {
        std::fs::create_dir_all("E:/tmp").expect("E:/tmp should be available for tests");
        let directory = Builder::new()
            .prefix("openbitfun-web-search-vault-")
            .tempdir_in("E:/tmp")
            .expect("create WebSearch test directory");
        let vault = credential_vault_in(directory.path());
        let config = WebSearchConfig::default();
        for provider in [
            WebSearchProviderId::EXA_SEARCH_API,
            WebSearchProviderId::DEEPSEEK,
        ] {
            let credential_id =
                credential_id_for_provider(&config, provider).expect("Search API credential id");
            let secret = "search-test-secret-that-must-not-enter-config";

            assert!(!credential_is_configured(&vault, credential_id)
                .await
                .expect("read empty credential status"));
            store_credential(&vault, credential_id, secret)
                .await
                .expect("save credential");
            assert!(credential_is_configured(&vault, credential_id)
                .await
                .expect("read configured credential status"));
            assert_eq!(
                read_credential(&vault, credential_id)
                    .await
                    .expect("read saved credential"),
                secret
            );

            let serialized = serde_json::to_string(&config).expect("serialize WebSearch config");
            assert!(!serialized.contains(secret));
            assert!(serialized.contains(credential_id));

            remove_credential(&vault, credential_id)
                .await
                .expect("clear credential");
            assert!(!credential_is_configured(&vault, credential_id)
                .await
                .expect("read cleared credential status"));
        }
    }

    #[tokio::test]
    async fn credential_helpers_normalize_entry_id_without_changing_secret() {
        std::fs::create_dir_all("E:/tmp").expect("E:/tmp should be available for tests");
        let directory = Builder::new()
            .prefix("openbitfun-web-search-vault-normalization-")
            .tempdir_in("E:/tmp")
            .expect("create WebSearch test directory");
        let vault = credential_vault_in(directory.path());
        let padded_credential_id = "  web-search:test  ";
        let secret = "  value-with-significant-whitespace  ";

        store_credential(&vault, padded_credential_id, secret)
            .await
            .expect("save credential with normalized entry id");
        assert!(credential_is_configured(&vault, "web-search:test")
            .await
            .expect("read normalized credential status"));
        assert_eq!(
            read_credential(&vault, padded_credential_id)
                .await
                .expect("read credential without changing the secret"),
            secret
        );

        remove_credential(&vault, padded_credential_id)
            .await
            .expect("clear credential with normalized entry id");
        assert!(!credential_is_configured(&vault, "web-search:test")
            .await
            .expect("read cleared normalized credential status"));
    }
}
