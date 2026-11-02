//! Token usage data types

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Kept in the legacy opaque token-details field so older usage readers and
/// writers retain attribution instead of dropping new top-level fields.
pub const MODEL_REQUEST_CONTEXT_KEY: &str = "openbitfunModelRequest";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRequestOutcome {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageAuthenticationKind {
    ApiKey,
    Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestUsageContext {
    pub version: u8,
    pub round_id: String,
    pub attempt_id: String,
    pub attempt_index: u32,
    pub started_at: DateTime<Utc>,
    pub authentication: UsageAuthenticationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<openbitfun_core_types::ModelAccountOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ModelRequestChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_revision: Option<u64>,
    pub requested_model: String,
    /// Absent when the adapter did not report the response model. Never infer
    /// an actual model from a current setting or silently copy the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    pub outcome: ModelRequestOutcome,
    pub usage_known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_reason: Option<openbitfun_core_types::errors::ErrorCategory>,
    /// Nonfatal routing observations from the executing host. Open strings keep
    /// future observations readable by older statistics and replay consumers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routing_warnings: Vec<String>,
    /// Optional runtime estimate; older persisted attempts have no composition data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_composition: Option<openbitfun_core_types::UsageContextBreakdown>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestChannel {
    pub model_config_id: String,
    pub name: String,
    pub protocol: String,
    pub binding_fingerprint: String,
}

pub fn model_request_context(
    details: Option<&serde_json::Value>,
) -> Result<Option<ModelRequestUsageContext>, String> {
    let Some(value) = details.and_then(|details| details.get(MODEL_REQUEST_CONTEXT_KEY)) else {
        return Ok(None);
    };
    let context: ModelRequestUsageContext =
        serde_json::from_value(value.clone()).map_err(|_| {
            "Unreadable model request usage context; existing records were preserved".to_string()
        })?;
    if context.version != 1
        || context.attempt_id.trim().is_empty()
        || context.round_id.trim().is_empty()
        || context.attempt_index == 0
    {
        return Err(
            "Unsupported model request usage context; existing records were preserved".into(),
        );
    }
    Ok(Some(context))
}

pub fn with_model_request_context(
    details: Option<serde_json::Value>,
    context: &ModelRequestUsageContext,
) -> Result<serde_json::Value, String> {
    let mut details = details.unwrap_or_else(|| serde_json::json!({}));
    let object = details
        .as_object_mut()
        .ok_or_else(|| "Token usage details must be an object".to_string())?;
    object.insert(
        MODEL_REQUEST_CONTEXT_KEY.into(),
        serde_json::to_value(context).map_err(|error| error.to_string())?,
    );
    Ok(details)
}

/// Single token usage record for a specific API call
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageRecord {
    /// Resolved `AIModelConfig.id` used for the request.
    pub model_config_id: String,
    /// Provider model name sent on the request.
    pub effective_model_name: String,
    pub session_id: String,
    pub turn_id: String,
    pub timestamp: DateTime<Utc>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_tokens: u32,
    /// Whether cached token count was explicitly reported by the provider/event.
    #[serde(default)]
    pub cached_tokens_available: bool,
    /// Cache WRITE tokens (Anthropic only: `cache_creation_input_tokens`).
    /// These are tokens written into the cache this call (billed at write price).
    /// Extracted from `token_details.cacheCreationTokenCount` when present.
    #[serde(default)]
    pub cache_write_tokens: u32,
    pub total_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_details: Option<serde_json::Value>,
    /// Whether this record is from a subagent call
    #[serde(default)]
    pub is_subagent: bool,
}

impl TokenUsageRecord {
    pub fn request_context(&self) -> Option<ModelRequestUsageContext> {
        model_request_context(self.token_details.as_ref())
            .ok()
            .flatten()
    }

    /// Legacy records explicitly supplied their required counters. An opaque
    /// future/invalid context is unknown, never a fabricated zero observation.
    pub fn usage_is_known(&self) -> bool {
        match model_request_context(self.token_details.as_ref()) {
            Ok(Some(context)) => context.usage_known,
            Ok(None) => true,
            Err(_) => false,
        }
    }
}

/// Aggregated token statistics for a model
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelTokenStats {
    pub model_id: String,
    pub total_input: u64,
    pub total_output: u64,
    /// Cumulative cache HIT tokens (served from cache, charged at cache-read price).
    pub total_cached: u64,
    /// Cumulative cache WRITE tokens (Anthropic only; charged at cache-write price).
    #[serde(default)]
    pub total_cache_write: u64,
    /// Prompt input tokens from requests where the provider explicitly reported
    /// cache hit telemetry. Used as the cache hit ratio denominator.
    #[serde(default)]
    pub cache_reported_input_tokens: u64,
    pub total_tokens: u64,
    /// Number of distinct sessions that used this model
    pub session_count: u32,
    /// Number of API requests made with this model
    pub request_count: u32,
    /// Set of session IDs that used this model (for dedup counting)
    #[serde(default)]
    pub session_ids: HashSet<String>,
    pub first_used: Option<DateTime<Utc>>,
    pub last_used: Option<DateTime<Utc>>,
}

impl ModelTokenStats {
    /// Fraction of prompt tokens served from cache (0.0–1.0).
    /// Returns `None` when no prompt tokens have been recorded or when the
    /// provider never reported cache token counts.
    pub fn cache_hit_ratio(&self) -> Option<f64> {
        if self.cache_reported_input_tokens == 0 {
            return None;
        }
        Some(self.total_cached as f64 / self.cache_reported_input_tokens as f64)
    }

    /// Estimated cost-savings ratio attributed to prefix-cache hits.
    ///
    /// Uses DeepSeek / Anthropic cache pricing where a cache-read costs about 10%
    /// of a full prompt token. The returned value represents the fraction of prompt
    /// spend that was avoided. Returns `None` when `cache_hit_ratio` is `None`.
    pub fn estimated_cache_savings_ratio(&self) -> Option<f64> {
        self.cache_hit_ratio().map(|r| r * 0.90)
    }
}

/// Token statistics for a specific session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTokenStats {
    pub session_id: String,
    pub model_id: String,
    pub total_input: u32,
    pub total_output: u32,
    /// Cumulative cache HIT tokens for this session.
    pub total_cached: u32,
    /// Cumulative cache WRITE tokens for this session (Anthropic only).
    #[serde(default)]
    pub total_cache_write: u32,
    /// Prompt input tokens from requests where the provider explicitly reported
    /// cache hit telemetry. Used as the cache hit ratio denominator.
    #[serde(default)]
    pub cache_reported_input_tokens: u32,
    pub total_tokens: u32,
    pub request_count: u32,
    pub created_at: DateTime<Utc>,
    pub last_updated: DateTime<Utc>,
}

impl SessionTokenStats {
    /// Fraction of prompt tokens served from cache (0.0–1.0).
    /// Returns `None` when no prompt tokens recorded or provider never reported cache counts.
    pub fn cache_hit_ratio(&self) -> Option<f64> {
        if self.cache_reported_input_tokens == 0 {
            return None;
        }
        Some(self.total_cached as f64 / self.cache_reported_input_tokens as f64)
    }

    /// Estimated cost-savings ratio from prefix-cache hits (cache read about 10% of full price).
    pub fn estimated_cache_savings_ratio(&self) -> Option<f64> {
        self.cache_hit_ratio().map(|r| r * 0.90)
    }
}

/// Time range for querying statistics
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum TimeRange {
    Today,
    ThisWeek,
    ThisMonth,
    All,
    Custom {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    },
}

/// Query parameters for token usage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageQuery {
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub time_range: TimeRange,
    /// IANA time zone used for local-calendar ranges and trend buckets.
    /// Missing values preserve the legacy UTC behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    /// Whether to include subagent token usage in results (default: false)
    #[serde(default)]
    pub include_subagent: bool,
}

/// Summary of token usage with breakdown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageSummary {
    pub total_input: u64,
    pub total_output: u64,
    /// Aggregate cache HIT tokens across all records in the query.
    pub total_cached: u64,
    /// Aggregate cache WRITE tokens across all records in the query (Anthropic only).
    #[serde(default)]
    pub total_cache_write: u64,
    /// Aggregate prompt input tokens from requests where cache hit telemetry was reported.
    #[serde(default)]
    pub cache_reported_input_tokens: u64,
    pub total_tokens: u64,
    pub by_model: HashMap<String, ModelTokenStats>,
    pub by_session: HashMap<String, SessionTokenStats>,
    pub record_count: usize,
}
