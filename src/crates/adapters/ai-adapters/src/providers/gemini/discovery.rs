use crate::client::utils::dedupe_remote_models;
use crate::client::AIClient;
use crate::types::RemoteModelInfo;
use anyhow::Result;
use log::debug;
use serde::Deserialize;

use super::request::{apply_headers, gemini_base_url};

#[derive(Debug, Deserialize)]
struct GeminiModelsResponse {
    #[serde(default)]
    models: Vec<GeminiModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelEntry {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_as_default")]
    supported_generation_methods: Vec<String>,
}

fn deserialize_null_as_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(|value| value.unwrap_or_default())
}

pub(crate) fn resolve_models_url(client: &AIClient) -> String {
    let base = gemini_base_url(&client.config.base_url);
    format!("{}/v1beta/models", base)
}

pub(crate) async fn list_models(client: &AIClient) -> Result<Vec<RemoteModelInfo>> {
    let url = resolve_models_url(client);
    debug!("Gemini models list URL: {}", url);

    let response = apply_headers(client, client.client.get(&url), &url)
        .send()
        .await?
        .error_for_status()?;

    let payload: GeminiModelsResponse = response.json().await?;
    Ok(dedupe_remote_models(
        payload
            .models
            .into_iter()
            .filter(|model| {
                model.supported_generation_methods.is_empty()
                    || model
                        .supported_generation_methods
                        .iter()
                        .any(|method| method == "generateContent")
            })
            .map(|model| {
                let id = model
                    .name
                    .strip_prefix("models/")
                    .unwrap_or(&model.name)
                    .to_string();
                RemoteModelInfo {
                    routing: None,
                    id,
                    display_name: model.display_name,
                }
            })
            .collect(),
    ))
}
