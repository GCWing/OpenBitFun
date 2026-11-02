//! Model discovery runs on the selected host with its proxy and credential owners.
use serde_json::Value;

pub(crate) async fn list_ai_models_by_config(args: &Value) -> Result<Value, String> {
    let request = crate::peer_host::args::request_value(args);
    let config = serde_json::from_value(request.get("config").cloned().ok_or("Missing config")?)
        .map_err(|error| format!("Invalid model configuration: {error}"))?;
    let client = create_transient_ai_client_for_config(config).await?;
    let models = client
        .list_models()
        .await
        .map_err(|error| format!("Failed to list models: {error}"))?;
    serde_json::to_value(models).map_err(|error| error.to_string())
}

async fn create_transient_ai_client_for_config(
    model_config: openbitfun_core::service::config::types::AIModelConfig,
) -> Result<openbitfun_core::infrastructure::ai::AIClient, String> {
    let global_config: openbitfun_core::service::config::GlobalConfig =
        openbitfun_core::service::config::get_global_config_service()
            .await
            .map_err(|e| e.to_string())?
            .get_config(None)
            .await
            .map_err(|e| format!("Failed to get configuration: {}", e))?;
    build_transient_client(model_config, &global_config).await
}

async fn build_transient_client(
    model_config: openbitfun_core::service::config::types::AIModelConfig,
    global_config: &openbitfun_core::service::config::GlobalConfig,
) -> Result<openbitfun_core::infrastructure::ai::AIClient, String> {
    let auth = model_config.auth.clone();
    let stream_options = openbitfun_core::infrastructure::ai::build_stream_options_for_model(
        &global_config.ai,
        Some(&model_config),
    );

    let mut ai_config: openbitfun_core::util::types::AIConfig = model_config
        .clone()
        .try_into()
        .map_err(|e| format!("Failed to convert configuration: {}", e))?;
    let skip_ssl_verify = ai_config.skip_ssl_verify;

    let proxy_config = if global_config.ai.proxy.enabled {
        Some(global_config.ai.proxy.clone())
    } else {
        None
    };
    let subscription_options =
        openbitfun_core::infrastructure::subscription_auth::SubscriptionHttpOptions::new(
            proxy_config.clone(),
            skip_ssl_verify,
        );

    openbitfun_core::infrastructure::ai::client_factory::apply_subscription_auth_with_options(
        &auth,
        &mut ai_config,
        &subscription_options,
    )
    .await
    .map_err(|e| format!("Failed to resolve subscription auth: {}", e))?;

    let client =
        openbitfun_core::infrastructure::ai::client_factory::apply_subscription_request_profile(
            &auth,
            openbitfun_core::infrastructure::ai::AIClient::new_with_runtime_options(
                ai_config,
                proxy_config,
                stream_options,
            ),
        );
    Ok(
        openbitfun_core::infrastructure::ai::client_factory::apply_model_default_reasoning(
            client,
            &model_config,
        )
        .await,
    )
}

pub(crate) async fn get_ai_model_catalog() -> Result<Value, String> {
    // A controller receives configured models, defaults and the session
    // selection. The models.dev bodies stay on the host: they describe the
    // public models.dev catalog, and a controller reads its own snapshot.
    serde_json::to_value(openbitfun_core::get_remote_model_catalog().await?)
        .map_err(|error| error.to_string())
}

pub(crate) async fn project_ai_model_reasoning_catalog(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(crate::peer_host::args::request_value(args).clone())
        .map_err(|error| format!("Invalid reasoning catalog request: {error}"))?;
    serde_json::to_value(openbitfun_core::project_ai_model_reasoning_catalog(request).await)
        .map_err(|error| error.to_string())
}

pub(crate) async fn get_model_configs() -> Result<Value, String> {
    let models = openbitfun_core::service::config::get_global_config_service()
        .await
        .map_err(|error| error.to_string())?
        .get_ai_models()
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(models).map_err(|error| error.to_string())
}

pub(crate) async fn get_models_dev_catalog_status() -> Result<Value, String> {
    serde_json::to_value(openbitfun_core::get_models_dev_catalog_status().await)
        .map_err(|error| error.to_string())
}

pub(crate) async fn refresh_models_dev_catalog_now() -> Result<Value, String> {
    serde_json::to_value(openbitfun_core::refresh_models_dev_catalog_now().await?)
        .map_err(|error| error.to_string())
}

pub(crate) async fn test_ai_config_connection(args: &Value) -> Result<Value, String> {
    use openbitfun_core::service::config::types::{AIModelConfig, ModelCapability, ModelCategory};
    let request = crate::peer_host::args::request_value(args);
    let config: AIModelConfig =
        serde_json::from_value(request.get("config").cloned().ok_or("Missing config")?)
            .map_err(|error| format!("Invalid model configuration: {error}"))?;
    let image_input = config
        .capabilities
        .iter()
        .any(|cap| matches!(cap, ModelCapability::ImageUnderstanding))
        || matches!(config.category, ModelCategory::Multimodal);
    let client = create_transient_ai_client_for_config(config).await?;
    let mut result = client
        .test_connection()
        .await
        .map_err(|error| error.to_string())?;
    if result.success && image_input {
        let image = client
            .test_image_input_connection()
            .await
            .map_err(|error| error.to_string())?;
        result.response_time_ms += image.response_time_ms;
        result.model_response = image.model_response.or(result.model_response);
        if !image.success {
            result.success = false;
            result.message_code = image.message_code;
            result.error_details = image.error_details;
        }
    }
    serde_json::to_value(result).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::config::{types::AIModelConfig, GlobalConfig};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn unsaved_connection_probe_client_keeps_the_model_reasoning_default() {
        let model = AIModelConfig {
            id: "unregistered-draft".into(),
            provider: "openai".into(),
            model_name: "unsaved-reasoning-model".into(),
            base_url: "http://127.0.0.1:1/v1".into(),
            reasoning: Some(openbitfun_core_types::ReasoningConfig {
                default_preset: Some("medium".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let original = serde_json::to_value(&model).unwrap();
        let client = build_transient_client(model.clone(), &GlobalConfig::default())
            .await
            .unwrap();
        assert_eq!(client.config.model, "unsaved-reasoning-model");
        assert_eq!(
            client
                .model_reasoning_preset()
                .map(|preset| preset.id.as_str()),
            Some("medium")
        );
        assert!(client.selected_reasoning_preset().is_none());
        assert_eq!(serde_json::to_value(&model).unwrap(), original);
    }

    #[tokio::test]
    async fn unsaved_openai_compatible_provider_discovers_model_ids_on_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.starts_with("GET /v1/models "));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-key"));
            let body = r#"{"object":"list","data":[{"id":"fixture-chat","object":"model","owned_by":"fixture"}]}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let config = AIModelConfig {
            name: "Unsaved provider".into(),
            provider: "openai".into(),
            model_name: "placeholder".into(),
            base_url: format!("http://{address}/v1"),
            api_key: "fixture-key".into(),
            ..Default::default()
        };
        let client = build_transient_client(config, &GlobalConfig::default())
            .await
            .unwrap();
        let models = tokio::time::timeout(std::time::Duration::from_secs(5), client.list_models())
            .await
            .unwrap()
            .unwrap();
        let wire = serde_json::to_value(models).unwrap();
        assert_eq!(wire[0]["id"], "fixture-chat");
        server.await.unwrap();
    }
}
