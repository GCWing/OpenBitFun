//! Shared decision-model connection and device-local credential storage.

use crate::infrastructure::try_get_path_manager_arc;
use crate::service::config::types::DecisionModelConfig;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_services_core::credential_vault::CredentialVault;
use serde::{Deserialize, Serialize};

const VAULT_KEY_FILE: &str = "credentials.key";
const VAULT_FILE: &str = "credentials.json";
const API_KEY_ENTRY: &str = "decision-model-api-key";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionModelCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDecisionModelCredentialRequest {
    pub secret: String,
}

fn credential_vault() -> OpenBitFunResult<CredentialVault> {
    let directory = try_get_path_manager_arc()?
        .user_data_dir()
        .join("decision-model");
    Ok(CredentialVault::new(
        directory.join(VAULT_KEY_FILE),
        directory.join(VAULT_FILE),
    ))
}

pub async fn get_config() -> OpenBitFunResult<DecisionModelConfig> {
    crate::service::config::get_global_config_service()
        .await?
        .get_config(Some("ai.decision_model"))
        .await
}

pub async fn get_api_key() -> OpenBitFunResult<Option<String>> {
    let Some(bytes) = credential_vault()?
        .get(API_KEY_ENTRY)
        .await
        .map_err(|error| {
            OpenBitFunError::config(format!("Failed to read decision-model credential: {error}"))
        })?
    else {
        return Ok(None);
    };
    String::from_utf8(bytes).map(Some).map_err(|error| {
        OpenBitFunError::config(format!("Invalid decision-model credential: {error}"))
    })
}

pub async fn get_credential_status() -> OpenBitFunResult<DecisionModelCredentialStatus> {
    Ok(DecisionModelCredentialStatus {
        configured: get_api_key()
            .await?
            .is_some_and(|key| !key.trim().is_empty()),
    })
}

pub async fn save_credential(
    request: SaveDecisionModelCredentialRequest,
) -> OpenBitFunResult<DecisionModelCredentialStatus> {
    if request.secret.trim().is_empty() {
        return Err(OpenBitFunError::validation(
            "Decision-model credential cannot be empty".to_string(),
        ));
    }
    credential_vault()?
        .set(API_KEY_ENTRY, request.secret.trim().as_bytes())
        .await
        .map_err(|error| {
            OpenBitFunError::config(format!("Failed to save decision-model credential: {error}"))
        })?;
    Ok(DecisionModelCredentialStatus { configured: true })
}

pub async fn clear_credential() -> OpenBitFunResult<DecisionModelCredentialStatus> {
    credential_vault()?
        .remove(API_KEY_ENTRY)
        .await
        .map_err(|error| {
            OpenBitFunError::config(format!(
                "Failed to clear decision-model credential: {error}"
            ))
        })?;
    Ok(DecisionModelCredentialStatus { configured: false })
}
