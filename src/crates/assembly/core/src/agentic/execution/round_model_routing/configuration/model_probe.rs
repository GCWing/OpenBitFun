//! Reuse the configured Router wire contract for model-editor/card probes.

use super::{available, cached_router, product_service_config, SMART_MODE_UNAVAILABLE};
use crate::service::config::{
    get_global_config_service,
    types::{AIConfig, AIModelConfig},
};
use crate::util::{errors::OpenBitFunResult, types::ConnectionTestResult};
use std::time::Instant;

/// Returns `None` for ordinary models so each host keeps its existing chat and
/// image checks. Router identity comes from the execution host's saved selection,
/// while the connection itself uses the supplied model draft without persisting it.
pub async fn test_configured_router_connection(
    candidate: &AIModelConfig,
) -> OpenBitFunResult<Option<ConnectionTestResult>> {
    if candidate.id.is_empty() {
        return Ok(None);
    }
    let host = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    Ok(probe_for_config(&host, candidate, available()).await)
}

async fn probe_for_config(
    host: &AIConfig,
    candidate: &AIModelConfig,
    released: bool,
) -> Option<ConnectionTestResult> {
    if candidate.id.is_empty()
        || host.model_routing.router_model_id.as_deref() != Some(candidate.id.as_str())
    {
        return None;
    }
    let started = Instant::now();
    let result = async {
        if !released {
            return Err(crate::util::errors::OpenBitFunError::Validation(
                SMART_MODE_UNAVAILABLE.into(),
            ));
        }
        let mut config = host.clone();
        // Draft endpoint/auth/body changes must be tested, never silently replaced
        // with the saved model's values just because their IDs match.
        config.models.retain(|model| model.id != candidate.id);
        config.models.push(candidate.clone());
        let router = cached_router(product_service_config(&config)?).await?;
        let prediction = router
            .predict("Task: inspect a file and explain its purpose", None)
            .await?;
        if prediction.simple_probability.is_none() {
            return Err(crate::util::errors::OpenBitFunError::Configuration(
                "Router protocol mismatch: valid classifier probabilities are required".into(),
            ));
        }
        Ok(())
    }
    .await;
    Some(ConnectionTestResult {
        success: result.is_ok(),
        response_time_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        model_response: None,
        message_code: None,
        error_details: result.err().map(|error| error.to_string()),
    })
}

#[cfg(test)]
mod tests;
