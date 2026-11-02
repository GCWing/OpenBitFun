//! Persisted, provider-neutral channel membership. Channels reference existing
//! model configurations; credentials and protocol options are never copied.
use crate::AIModelConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// Resolve output reservation exactly as conversion::AIConfig does. Both
// channels retain the same safety reserve, so it does not affect comparison.
fn input_capacity(model: &AIModelConfig) -> u32 {
    let context = model
        .context_window
        .unwrap_or(crate::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
    let output = model
        .max_tokens
        .filter(|tokens| crate::is_valid_configured_max_output_tokens(context, *tokens))
        .unwrap_or_else(|| crate::automatic_max_output_tokens(context));
    context.saturating_sub(output)
}

fn version_one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelChannelRouting {
    #[serde(default = "version_one")]
    pub version: u32,
    #[serde(default)]
    pub fallback_model_ids: Vec<String>,
    /// Fixed member selected by the user. Absent enables ordered failover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_channel: Option<String>,
}

impl Default for ModelChannelRouting {
    fn default() -> Self {
        Self {
            version: 1,
            fallback_model_ids: Vec::new(),
            manual_channel: None,
        }
    }
}

/// A single explicit ordered route. Nested routes are rejected rather than
/// silently expanding a graph or introducing another request-attempt budget.
pub fn channel_members<'a>(
    model: &'a AIModelConfig,
    models: &'a [AIModelConfig],
) -> Result<Vec<&'a AIModelConfig>, String> {
    let mut members = vec![model];
    let Some(route) = &model.channel_routing else {
        return Ok(members);
    };
    if route.version != 1 {
        return Err(format!(
            "Unsupported channel routing version: {}",
            route.version
        ));
    }
    let mut seen = HashSet::from([model.id.as_str()]);
    for id in &route.fallback_model_ids {
        if id.trim().is_empty() || id.trim() != id || !seen.insert(id.as_str()) {
            return Err("Channel routing requires distinct model configuration IDs".into());
        }
        let mut matches = models.iter().filter(|candidate| candidate.id == *id);
        let next = matches
            .next()
            .ok_or_else(|| format!("Fallback channel not found: {id}"))?;
        if matches.next().is_some() {
            return Err(format!("Ambiguous fallback channel: {id}"));
        }
        if !next.supports_text_generation() {
            return Err(format!("Fallback channel does not generate text: {id}"));
        }
        if next
            .channel_routing
            .as_ref()
            .is_some_and(|route| !route.fallback_model_ids.is_empty() || route.version != 1)
        {
            return Err(format!("Nested channel routing is not supported: {id}"));
        }
        // The runtime assembles context against the primary channel's limits
        // and capability facts. A backup must preserve those input contracts.
        if next
            .context_window
            .unwrap_or(crate::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
            < model
                .context_window
                .unwrap_or(crate::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
            || input_capacity(next) < input_capacity(model)
            || model
                .capabilities
                .iter()
                .any(|capability| !next.capabilities.contains(capability))
        {
            return Err(format!(
                "Fallback channel cannot preserve the primary input contract: {id}"
            ));
        }
        members.push(next);
    }
    if route
        .manual_channel
        .as_ref()
        .is_some_and(|id| !members.iter().any(|model| &model.id == id))
    {
        return Err("Manual channel must be a member of the configured route".into());
    }
    Ok(members)
}

pub fn validate_channel_routes(models: &[AIModelConfig]) -> Result<(), String> {
    for model in models {
        channel_members(model, models)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model(id: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.into(),
            ..Default::default()
        }
    }
    #[test]
    fn legacy_round_trip_does_not_enable_fallback() {
        let value = serde_json::to_value(model("primary")).unwrap();
        assert!(value.get("channel_routing").is_none());
        let old: AIModelConfig = serde_json::from_value(value).unwrap();
        assert!(old.channel_routing.is_none());
    }
    #[test]
    fn ordered_members_preserve_independent_endpoint_and_auth() {
        let mut a = model("a");
        let mut b = model("b");
        a.base_url = "https://primary.invalid".into();
        b.base_url = "https://backup.invalid".into();
        b.api_key = "synthetic-backup".into();
        a.channel_routing = Some(ModelChannelRouting {
            version: 1,
            fallback_model_ids: vec!["b".into()],
            manual_channel: None,
        });
        let models = vec![a, b];
        let members = channel_members(&models[0], &models).unwrap();
        assert_eq!(
            members
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(members[1].api_key, "synthetic-backup");
        let restored: Vec<AIModelConfig> =
            serde_json::from_value(serde_json::to_value(&models).unwrap()).unwrap();
        assert_eq!(restored[0].channel_routing, models[0].channel_routing);
    }
    #[test]
    fn invalid_graphs_and_unknown_versions_are_rejected() {
        for ids in [vec!["a"], vec!["b", "b"], vec!["missing"], vec![" b"]] {
            let mut a = model("a");
            a.channel_routing = Some(ModelChannelRouting {
                version: 1,
                fallback_model_ids: ids.into_iter().map(str::to_string).collect(),
                manual_channel: None,
            });
            assert!(validate_channel_routes(&[a, model("b")]).is_err());
        }
        let mut a = model("a");
        a.channel_routing = Some(ModelChannelRouting {
            version: 9,
            fallback_model_ids: vec![],
            manual_channel: None,
        });
        assert!(validate_channel_routes(&[a]).is_err());
    }
    #[test]
    fn backups_preserve_effective_default_context_and_declared_input_capabilities() {
        let mut a = model("a");
        a.channel_routing = Some(ModelChannelRouting {
            fallback_model_ids: vec!["b".into()],
            ..Default::default()
        });
        let mut b = model("b");
        b.context_window = Some(32000);
        assert!(validate_channel_routes(&[a.clone(), b.clone()]).is_err());
        a.context_window = Some(32000);
        b.context_window = Some(64000);
        assert!(validate_channel_routes(&[a.clone(), b.clone()]).is_ok());
        a.capabilities
            .push(crate::ModelCapability::ImageUnderstanding);
        assert!(validate_channel_routes(&[a, b]).is_err());
    }
    #[test]
    fn backups_preserve_input_capacity_after_output_reservation() {
        let mut primary = model("primary");
        primary.context_window = Some(128_000);
        primary.max_tokens = Some(8_000);
        primary.channel_routing = Some(ModelChannelRouting {
            fallback_model_ids: vec!["backup".into()],
            ..Default::default()
        });
        let mut backup = model("backup");
        backup.context_window = Some(128_000);
        for output in [Some(48_000), None, Some(0), Some(128_000)] {
            backup.max_tokens = output;
            assert!(validate_channel_routes(&[primary.clone(), backup.clone()]).is_err());
        }
        backup.max_tokens = Some(8_000);
        assert!(validate_channel_routes(&[primary.clone(), backup.clone()]).is_ok());
        backup.max_tokens = Some(48_000);
        backup.context_window = Some(256_000);
        assert!(validate_channel_routes(&[primary, backup]).is_ok());
    }
}
