//! Host-owned routing setup, readiness and immutable per-turn selection.

use super::*;
use crate::service::config::{
    get_global_config_service,
    types::{AIConfig, AuthConfig, ModelCapability},
};
use std::sync::Arc;

const SYSTEM_PROMPT: &str = include_str!("system_prompt.txt");

// Release policy, deliberately independent of user configuration and environment.
// The retained Router algorithms remain available to focused fixtures.
const SMART_MODE_RELEASE_AVAILABLE: bool = false;
const SMART_MODE_UNAVAILABLE: &str = "Smart mode is unavailable in this release";

pub const fn available() -> bool {
    SMART_MODE_RELEASE_AVAILABLE
}

pub fn release_notice_required(mode: Option<&str>) -> bool {
    !available() && (mode == Some("smart") || legacy_requested())
}

fn legacy_requested() -> bool {
    std::env::var("OPENBITFUN_ROUND_ROUTER_URL").is_ok_and(|value| !value.trim().is_empty())
}

pub fn require_available() -> OpenBitFunResult<()> {
    if available() {
        Ok(())
    } else {
        Err(OpenBitFunError::Validation(SMART_MODE_UNAVAILABLE.into()))
    }
}

fn unavailable_status() -> ModelRoutingStatus {
    ModelRoutingStatus {
        api_version: 1,
        available: false,
        mode: "manual".into(),
        default_mode: "manual".into(),
        ready: false,
        issue: Some(SMART_MODE_UNAVAILABLE.into()),
        connected: None,
        connection_issue: None,
        summary_enabled: false,
        estimated_token_budget_supported: true,
        subagent_model: None,
    }
}

pub fn legacy_enabled() -> bool {
    available() && legacy_requested()
}

pub fn routing_enabled(mode: Option<&str>) -> OpenBitFunResult<bool> {
    match mode {
        Some("manual") => Ok(false),
        Some("smart") => Ok(available()),
        None => Ok(legacy_enabled()),
        Some(_) => Err(OpenBitFunError::Configuration(
            "Unsupported model routing strategy; select manual or smart mode".into(),
        )),
    }
}

pub fn economy_model_id(config: &AIConfig, legacy: bool) -> OpenBitFunResult<String> {
    // Environment-only installations retain the original fast-to-primary fallback.
    let legacy_reference = legacy
        .then(|| config.resolve_model_selection("fast"))
        .flatten();
    let reference = if legacy {
        legacy_reference.as_deref()
    } else {
        config.default_models.economy.as_deref()
    };
    reference
        .and_then(|id| {
            config.models.iter().find(|model| {
                model.id == id
                    && model.enabled
                    && model.supports_capability(ModelCapability::TextChat)
            })
        })
        .map(|model| model.id.clone())
        .ok_or_else(|| {
            OpenBitFunError::Configuration(
                "Configure an enabled economy model before using smart mode".into(),
            )
        })
}

fn product_config(config: &AIConfig) -> OpenBitFunResult<HttpRoundModelRouterConfig> {
    // Product smart mode maintains its routing history automatically. Keep the
    // persisted switch readable for older hosts without letting it disable the
    // current runtime's history preparation.
    let summary_model_id = Some(economy_model_id(config, false)?);
    let mut router = product_service_config(config)?;
    router.context.summary_model_id = summary_model_id;
    Ok(router)
}

/// Service checks do not depend on the execution models used after classification.
fn product_service_config(config: &AIConfig) -> OpenBitFunResult<HttpRoundModelRouterConfig> {
    let setup = &config.model_routing;
    let model = setup
        .router_model_id
        .as_deref()
        .and_then(|id| {
            config
                .models
                .iter()
                .find(|model| model.id == id && model.enabled)
        })
        .ok_or_else(|| {
            OpenBitFunError::Configuration(
                "Configure a Router service model in model settings".into(),
            )
        })?;
    if !matches!(model.auth, AuthConfig::ApiKey) {
        return Err(OpenBitFunError::Configuration(
            "Router requires an API-key service; subscription authentication is unsupported".into(),
        ));
    }
    // Router classification uses Chat Completions directly, rather than the
    // model's normal chat adapter. Reject other formats before deriving an
    // endpoint or sending their credentials with a different wire protocol.
    if !model.provider.trim().eq_ignore_ascii_case("openai") {
        return Err(OpenBitFunError::Configuration(
            "Router requires OpenAI Chat Completions API format; select an OpenAI-compatible classifier service".into(),
        ));
    }
    if !(0.0..=1.0).contains(&setup.simple_threshold) || setup.timeout_ms == 0 {
        return Err(OpenBitFunError::Configuration(
            "Router threshold must be between 0 and 1 and timeout must be positive".into(),
        ));
    }
    if model
        .custom_request_body
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(OpenBitFunError::Configuration(
            "Router models cannot override the classifier request body".into(),
        ));
    }
    let base = model
        .request_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&model.base_url)
        .trim_end_matches('/');
    let endpoint = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    let context_defaults = RouterContextConfig::default();
    let context_window = model
        .context_window
        .map(|tokens| tokens as usize)
        .unwrap_or(context_defaults.context_window);
    Ok(HttpRoundModelRouterConfig {
        endpoint,
        model: model.model_name.clone(),
        system_prompt: SYSTEM_PROMPT.into(),
        api_key: (!model.api_key.is_empty()).then(|| model.api_key.clone()),
        timeout: Duration::from_millis(setup.timeout_ms),
        admission: RouterAdmissionLimits::from_env()?,
        recent_rounds: 3,
        simple_threshold: setup.simple_threshold,
        trace_path: None,
        context: RouterContextConfig {
            context_window,
            max_input_tokens: context_defaults.max_input_tokens.min(context_window),
            summary_enabled: true,
            ..context_defaults
        },
        tokenizer_path: (!setup.tokenizer_path.trim().is_empty())
            .then(|| PathBuf::from(&setup.tokenizer_path)),
        proxy: Some(config.proxy.clone()),
        custom_headers: model.custom_headers.clone().unwrap_or_default(),
        skip_ssl_verify: model.skip_ssl_verify,
    })
}

pub struct TurnRouting {
    pub router: Arc<dyn RoundModelRouter>,
    pub economy_model_id: String,
}

/// Cache only the transport/tokenizer, never a session context or a routing decision.
async fn configured_router(config: &AIConfig) -> OpenBitFunResult<Arc<HttpRoundModelRouter>> {
    let router_config = if config.model_routing.router_model_id.is_some() {
        product_config(config)?
    } else {
        service_config(config)?
    };
    cached_router(router_config).await
}

fn service_config(config: &AIConfig) -> OpenBitFunResult<HttpRoundModelRouterConfig> {
    if config.model_routing.router_model_id.is_some() {
        product_service_config(config)
    } else {
        HttpRoundModelRouterConfig::from_env()?.ok_or_else(|| {
            OpenBitFunError::Configuration("Configure a Router service in model settings".into())
        })
    }
}

async fn cached_router(
    router_config: HttpRoundModelRouterConfig,
) -> OpenBitFunResult<Arc<HttpRoundModelRouter>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(String, Arc<HttpRoundModelRouter>)>>> =
        OnceLock::new();
    // This private in-memory identity includes credential/proxy revisions. Never log it.
    let key = format!("{router_config:?}");
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    if let Some((saved, router)) = cache.lock().await.as_ref() {
        if *saved == key {
            return Ok(router.clone());
        }
    }
    let router = Arc::new(
        tokio::task::spawn_blocking(move || HttpRoundModelRouter::new(router_config))
            .await
            .map_err(|error| {
                OpenBitFunError::Configuration(format!("Failed to initialize Router: {error}"))
            })??,
    );
    *cache.lock().await = Some((key, router.clone()));
    Ok(router)
}

pub async fn prepare_turn(
    mode: Option<&str>,
    eligible: bool,
) -> OpenBitFunResult<Option<TurnRouting>> {
    if !available() || !eligible || !routing_enabled(mode)? {
        return Ok(None);
    }
    let config = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    let economy_model_id = economy_model_id(&config, mode.is_none())?;
    let router = configured_router(&config).await?;
    Ok(Some(TurnRouting {
        router,
        economy_model_id,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoutingStatus {
    pub api_version: u32,
    pub available: bool,
    pub mode: String,
    pub default_mode: String,
    pub ready: bool,
    pub issue: Option<String>,
    /// Only an explicit protocol probe establishes a connection, not a config read.
    pub connected: Option<bool>,
    /// Probe failure only; role/readiness errors remain in `issue`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_issue: Option<String>,
    pub summary_enabled: bool,
    /// Older hosts may still require a locally configured tokenizer file.
    pub estimated_token_budget_supported: bool,
    /// Older clients use presence as a feature gate; current hosts no longer expose this control.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_model: Option<String>,
}

pub async fn session_status(
    session: Option<&crate::agentic::core::Session>,
    probe: bool,
) -> OpenBitFunResult<ModelRoutingStatus> {
    let eligible = session.is_none_or(session_eligible);
    status(
        session.and_then(|session| session.config.model_routing.as_deref()),
        eligible,
        probe,
    )
    .await
}

pub fn session_eligible(session: &crate::agentic::core::Session) -> bool {
    session.config.model_pool_id.is_none()
        && session.config.model_binding_policy
            != crate::agentic::core::SessionModelBindingPolicy::Pool
        && session.kind != crate::agentic::core::SessionKind::Subagent
        && session.config.model_binding_policy
            != crate::agentic::core::SessionModelBindingPolicy::ApprovedImmutable
        && matches!(
            session.config.agent_route_owner,
            crate::agentic::core::SessionAgentRouteOwner::Local
        )
}

pub async fn status(
    mode: Option<&str>,
    eligible: bool,
    probe: bool,
) -> OpenBitFunResult<ModelRoutingStatus> {
    if !available() {
        return Ok(unavailable_status());
    }
    let config = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    Ok(status_for_config(&config, mode, eligible, probe).await)
}

async fn status_for_config(
    config: &AIConfig,
    mode: Option<&str>,
    eligible: bool,
    probe: bool,
) -> ModelRoutingStatus {
    let default_mode = config
        .model_routing
        .default_mode
        .clone()
        .unwrap_or_else(|| {
            if legacy_enabled() {
                "smart".into()
            } else {
                "manual".into()
            }
        });
    let mut result = ModelRoutingStatus {
        api_version: 1,
        available: true,
        mode: mode
            .unwrap_or(if legacy_enabled() { "smart" } else { "manual" })
            .into(),
        default_mode,
        ready: false,
        issue: None,
        connected: None,
        connection_issue: None,
        summary_enabled: true,
        estimated_token_budget_supported: true,
        subagent_model: None,
    };
    let check = async {
        if !eligible { return Err(OpenBitFunError::Configuration("Smart mode is unavailable for external agents, subagents and immutable dispatched sessions".into())); }
        economy_model_id(config, mode.is_none() && legacy_enabled())?;
        if config.resolve_model_selection("primary").is_none() {
            return Err(OpenBitFunError::Configuration("Configure an enabled primary model before using smart mode".into()));
        }
        configured_router(config).await
    }.await;
    let ready_router = match check {
        Ok(router) => {
            result.ready = true;
            // Environment-only installations retain their explicit summary policy.
            result.summary_enabled = router.config.context.summary_enabled;
            Some(router)
        }
        Err(error) => {
            result.issue = Some(error.to_string());
            None
        }
    };
    if probe {
        let connection = async {
            let router = match ready_router {
                Some(router) => router,
                None => cached_router(service_config(config)?).await?,
            };
            let prediction = router
                .predict("Task: inspect a file and explain its purpose", None)
                .await?;
            if prediction.simple_probability.is_none() {
                return Err(OpenBitFunError::Configuration(
                    "Router protocol mismatch: classifier token IDs and logprobs are required"
                        .into(),
                ));
            }
            Ok::<(), OpenBitFunError>(())
        }
        .await;
        result.connected = Some(connection.is_ok());
        if let Err(error) = connection {
            let issue = error.to_string();
            // Older clients still receive a useful failure in the original field.
            result.issue.get_or_insert_with(|| issue.clone());
            result.connection_issue = Some(issue);
            result.ready = false;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::config::types::AIModelConfig;

    #[test]
    fn smart_release_gate_ignores_legacy_environment_without_router_or_summary_io() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut command = openbitfun_services_core::process_manager::create_command(
            std::env::current_exe().unwrap(),
        );
        let output = command.args([
            "--exact",
            "agentic::execution::round_model_routing::configuration::tests::smart_release_gate_fixture_child",
            "--ignored", "--nocapture",
        ])
        .env("OPENBITFUN_SMART_RELEASE_GATE_FIXTURE", "1")
        .env("OPENBITFUN_ROUND_ROUTER_URL", format!("http://{}/v1/chat/completions", listener.local_addr().unwrap()))
        .env("OPENBITFUN_ROUND_ROUTER_MODEL", "synthetic-router")
        .env("OPENBITFUN_ROUND_ROUTER_SUMMARY_ENABLED", "true")
        .env("OPENBITFUN_ROUND_ROUTER_CONTEXT_WINDOW", "invalid-unread-settings")
        .env("OPENBITFUN_ROUND_ROUTER_SUMMARY_MODEL", "synthetic-summary")
        .output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    #[ignore = "Invoked by its parent with isolated synthetic legacy routing environment"]
    async fn smart_release_gate_fixture_child() {
        assert!(!crate::service::config::GlobalConfigManager::is_initialized());
        assert_eq!(
            std::env::var("OPENBITFUN_SMART_RELEASE_GATE_FIXTURE").unwrap(),
            "1"
        );
        assert!(!available());
        assert!(!legacy_enabled());
        assert!(release_notice_required(None));
        assert!(release_notice_required(Some("smart")));
        assert!(!routing_enabled(None).unwrap());
        assert!(!routing_enabled(Some("smart")).unwrap());
        assert!(require_available()
            .unwrap_err()
            .to_string()
            .contains("unavailable in this release"));
        for mode in [None, Some("smart"), Some("manual")] {
            for probe in [false, true] {
                let value = status(mode, true, probe).await.unwrap();
                assert_eq!(value.api_version, 1);
                assert!(!value.available);
                assert!(!value.ready);
                assert_eq!(value.mode, "manual");
                assert_eq!(value.default_mode, "manual");
                assert!(!value.summary_enabled);
                assert_eq!(value.connected, None);
                assert!(value.issue.unwrap().contains("unavailable in this release"));
            }
            assert!(prepare_turn(mode, true).await.unwrap().is_none());
        }
    }

    fn connection_fixture(endpoint: &str) -> AIConfig {
        let mut config = AIConfig::default();
        for id in ["primary-fixture", "economy-fixture", "router-service"] {
            config.models.push(AIModelConfig {
                id: id.into(),
                enabled: true,
                provider: "openai".into(),
                base_url: endpoint.into(),
                model_name: "router-fixture".into(),
                api_key: "fixture-token".into(),
                ..Default::default()
            });
        }
        config.default_models.primary = Some("primary-fixture".into());
        config.default_models.economy = Some("economy-fixture".into());
        config.model_routing.router_model_id = Some("router-service".into());
        config
    }

    #[tokio::test]
    async fn router_probe_rejects_incompatible_api_formats_without_provider_io() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        for provider in ["anthropic", "response", "responses", "gemini", ""] {
            let mut config = connection_fixture(&endpoint);
            config.model_routing.timeout_ms = 50;
            config.models[2].provider = provider.into();
            config.models[2].request_url = Some(format!("{endpoint}/v1/messages"));
            config.default_models.economy = None;
            let status = status_for_config(&config, Some("smart"), true, true).await;
            assert!(!status.ready);
            assert_eq!(status.connected, Some(false));
            assert!(status.issue.as_deref().unwrap().contains("economy model"));
            assert!(status
                .connection_issue
                .as_deref()
                .unwrap()
                .contains("requires OpenAI Chat Completions API format"));
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    fn classifier_response() -> Value {
        json!({"choices": [{
            "message": {"content": "{\"simple_type\":\"simple\"}"},
            "logprobs": {"content": [
                {"bytes": b"{\"simple_type\":\"".to_vec(), "top_logprobs": []},
                {"bytes": b"simple".to_vec(), "top_logprobs": [
                    {"token": "token_id:22944", "logprob": -0.2},
                    {"token": "token_id:6280", "logprob": -1.4}
                ]},
                {"bytes": b"\"}".to_vec(), "top_logprobs": []}
            ]}, "token_ids": [1, 22944, 2]
        }]})
    }

    async fn connection_server(response: Value) -> (String, tokio::task::JoinHandle<Value>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let length = stream.read(&mut chunk).await.unwrap();
                assert!(length > 0);
                request.extend_from_slice(&chunk[..length]);
                if let Some(offset) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break offset + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            assert!(headers.starts_with("post /v1/chat/completions "));
            assert!(headers.contains("authorization: bearer fixture-token\r\n"));
            let content_length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut body = request[header_end..].to_vec();
            while body.len() < content_length {
                let mut chunk = [0; 4096];
                let length = stream.read(&mut chunk).await.unwrap();
                assert!(length > 0);
                body.extend_from_slice(&chunk[..length]);
            }
            let response = response.to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await.unwrap();
            serde_json::from_slice(&body[..content_length]).unwrap()
        });
        (endpoint, server)
    }

    #[tokio::test]
    async fn router_probe_connects_independently_of_missing_or_invalid_execution_roles() {
        for invalid_role in [
            "missing-both",
            "missing-primary",
            "invalid-primary",
            "disabled-economy",
        ] {
            let (endpoint, server) = connection_server(classifier_response()).await;
            let mut config = connection_fixture(&endpoint);
            let expected_issue = match invalid_role {
                "missing-both" => {
                    config.default_models.primary = None;
                    config.default_models.economy = None;
                    "economy model"
                }
                "missing-primary" => {
                    config.default_models.primary = None;
                    "primary model"
                }
                "invalid-primary" => {
                    config.default_models.primary = Some("removed-model".into());
                    "primary model"
                }
                _ => {
                    config.models[1].enabled = false;
                    "economy model"
                }
            };
            let status = status_for_config(&config, Some("smart"), true, true).await;
            assert!(!status.ready, "{invalid_role}");
            assert_eq!(status.connected, Some(true), "{invalid_role}");
            assert!(status.issue.as_deref().unwrap().contains(expected_issue));
            assert!(status.connection_issue.is_none());
            let payload = serde_json::to_value(status).unwrap();
            assert!(payload.get("connectionIssue").is_none());
            let request = server.await.unwrap();
            assert_eq!(request["model"], "router-fixture");
            assert_eq!(request["logprobs"], true);
            assert_eq!(request["return_token_ids"], true);
            assert_eq!(request["messages"][0]["content"], SYSTEM_PROMPT);
        }
    }

    #[tokio::test]
    async fn router_probe_failure_identifies_router_without_erasing_role_readiness_issue() {
        for missing_economy in [false, true] {
            let (endpoint, server) = connection_server(json!({"choices": [{
                "message": {"content": "{\"simple_type\":\"simple\"}"}
            }]}))
            .await;
            let mut config = connection_fixture(&endpoint);
            if missing_economy {
                config.default_models.economy = None;
            } else {
                let status = status_for_config(&config, Some("smart"), true, false).await;
                assert!(status.ready);
                assert!(status.connected.is_none());
                assert!(status.connection_issue.is_none());
            }
            let status = status_for_config(&config, Some("smart"), true, true).await;
            assert!(!status.ready);
            assert_eq!(status.connected, Some(false));
            assert!(status
                .connection_issue
                .as_deref()
                .unwrap()
                .contains("protocol mismatch"));
            if missing_economy {
                assert!(status.issue.as_deref().unwrap().contains("economy model"));
            } else {
                assert_eq!(status.issue, status.connection_issue);
            }
            assert!(serde_json::to_value(status).unwrap()["connectionIssue"].is_string());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn successful_router_probe_retains_product_summary_and_readiness_policy() {
        let (endpoint, server) = connection_server(classifier_response()).await;
        let mut config = connection_fixture(&endpoint);
        let status = status_for_config(&config, Some("smart"), true, true).await;
        assert!(status.ready);
        assert_eq!(status.connected, Some(true));
        assert!(status.issue.is_none());
        assert!(status.connection_issue.is_none());
        assert!(status.summary_enabled);
        let runtime_config = product_config(&config).unwrap();
        assert!(runtime_config.context.summary_enabled);
        assert_eq!(
            runtime_config.context.summary_model_id.as_deref(),
            Some("economy-fixture")
        );
        config.default_models.economy = None;
        assert!(product_config(&config).is_err());
        assert!(service_config(&config).is_ok());
        config.models[2].custom_request_body = Some("{}".into());
        assert!(service_config(&config)
            .unwrap_err()
            .to_string()
            .contains("request body"));
        config.models[2].custom_request_body = None;
        config.models[2].auth = serde_json::from_value(json!({
            "type": "subscription", "provider": "codex"
        }))
        .unwrap();
        assert!(service_config(&config)
            .unwrap_err()
            .to_string()
            .contains("API-key service"));
        server.await.unwrap();
    }

    #[test]
    fn restored_subagents_and_immutable_jobs_never_enter_smart_routing() {
        use crate::agentic::core::{
            Session, SessionConfig, SessionKind, SessionModelBindingPolicy,
        };
        let mut session = Session::new("test".into(), "Standard".into(), SessionConfig::default());
        assert!(session_eligible(&session));
        session.kind = SessionKind::Subagent;
        assert!(!session_eligible(&session));
        session.config.model_routing = Some("smart".into());
        session.config.delegation_model_routing = Some("smart".into());
        assert!(!session_eligible(&session));
        // Eligibility is read-only: old records remain recoverable and their
        // concrete model or pool target continues to own execution.
        assert_eq!(session.config.model_routing.as_deref(), Some("smart"));
        session.kind = SessionKind::Standard;
        session.config.model_binding_policy = SessionModelBindingPolicy::ApprovedImmutable;
        assert!(!session_eligible(&session));
        session.config.model_binding_policy = SessionModelBindingPolicy::Pool;
        assert!(!session_eligible(&session));
        session.config.model_binding_policy = SessionModelBindingPolicy::Mutable;
        session.config.model_pool_id = Some("daily".into());
        assert!(!session_eligible(&session));
    }

    #[test]
    fn product_router_uses_host_model_credentials_and_validates_auxiliary_configuration() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            id: "router-service".into(),
            enabled: true,
            provider: " OpenAI ".into(),
            base_url: "https://router.example.invalid/v1/".into(),
            model_name: "router-fixture".into(),
            api_key: "fixture-token".into(),
            ..Default::default()
        });
        config.model_routing.router_model_id = Some("router-service".into());
        config.model_routing.tokenizer_path = "/execution-host/tokenizer.json".into();
        config.model_routing.summary_enabled = false;
        assert!(product_config(&config)
            .unwrap_err()
            .to_string()
            .contains("economy model"));
        config.models.push(AIModelConfig {
            id: "economy-fixture".into(),
            enabled: true,
            ..Default::default()
        });
        config.default_models.economy = Some("economy-fixture".into());
        let router = product_config(&config).unwrap();
        assert_eq!(
            router.endpoint,
            "https://router.example.invalid/v1/chat/completions"
        );
        assert_eq!(router.api_key.as_deref(), Some("fixture-token"));
        assert_eq!(router.model, "router-fixture");
        assert_eq!(
            router.tokenizer_path.as_deref(),
            Some(std::path::Path::new("/execution-host/tokenizer.json"))
        );
        assert!(router.context.summary_enabled);
        assert_eq!(
            router.context.summary_model_id.as_deref(),
            Some("economy-fixture")
        );
        // Reading an old opt-out never resets its persisted record or task defaults.
        assert!(!config.model_routing.summary_enabled);
        assert!(config.default_models.fast.is_none());
        config.models[0].custom_request_body = Some("{}".into());
        assert!(product_config(&config).is_err());
        config.models[0].custom_request_body = None;
        config.model_routing.simple_threshold = f64::NAN;
        assert!(product_config(&config).is_err());
    }

    #[tokio::test]
    async fn product_router_without_tokenizer_prepares_context_using_the_model_window() {
        let directory = tempfile::tempdir().unwrap();
        let missing_path = directory.path().join("legacy-tokenizer.json");
        let missing_path = missing_path.to_str().unwrap();
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            id: "router-service".into(),
            enabled: true,
            provider: "openai".into(),
            base_url: "https://router.example.invalid/v1".into(),
            model_name: "router-fixture".into(),
            ..Default::default()
        });
        config.model_routing.router_model_id = Some("router-service".into());
        config.models.push(AIModelConfig {
            id: "economy-fixture".into(),
            enabled: true,
            ..Default::default()
        });
        config.default_models.economy = Some("economy-fixture".into());
        for (window, expected_window, expected_input) in [
            (None, 65_536, 65_536),
            (Some(8_192), 8_192, 8_192),
            (Some(131_072), 131_072, 65_536),
        ] {
            config.models[0].context_window = window;
            for tokenizer_path in ["", " \t ", missing_path] {
                config.model_routing.tokenizer_path = tokenizer_path.into();
                let router_config = product_config(&config).unwrap();
                assert_eq!(
                    router_config.tokenizer_path.is_none(),
                    tokenizer_path.trim().is_empty()
                );
                assert_eq!(router_config.context.context_window, expected_window);
                assert_eq!(router_config.context.max_input_tokens, expected_input);
                let router = HttpRoundModelRouter::new(router_config).unwrap();
                let mut context = router
                    .create_context("session", "turn", "Inspect the parser")
                    .unwrap();
                let prepared = context.prepare(&[]).await;
                assert!(prepared.user_prompt.contains("Inspect the parser"));
                assert!(prepared.input_tokens > 0);
                assert!(prepared.input_tokens <= prepared.budget_tokens);
                assert!(prepared.budget_tokens < expected_window);
                assert_eq!(config.model_routing.tokenizer_path, tokenizer_path);
            }
        }
    }

    #[test]
    fn manual_never_uses_environment_and_unknown_modes_are_explicit() {
        assert!(!routing_enabled(Some("manual")).unwrap());
        assert!(!routing_enabled(Some("smart")).unwrap());
        assert!(routing_enabled(Some("future-mode")).is_err());
    }

    #[test]
    fn economy_is_independent_of_fast_and_never_silently_falls_back() {
        let mut config = AIConfig::default();
        for id in ["primary", "worker", "economical"] {
            config.models.push(AIModelConfig {
                id: id.into(),
                enabled: true,
                ..Default::default()
            });
        }
        config.default_models.primary = Some("primary".into());
        config.default_models.fast = Some("worker".into());
        assert!(economy_model_id(&config, false).is_err());
        assert_eq!(economy_model_id(&config, true).unwrap(), "worker");
        config.default_models.fast = None;
        assert_eq!(economy_model_id(&config, true).unwrap(), "primary");
        config.default_models.economy = Some("economical".into());
        assert_eq!(economy_model_id(&config, false).unwrap(), "economical");
        config.models[2].enabled = false;
        assert!(economy_model_id(&config, false).is_err());
    }
}
