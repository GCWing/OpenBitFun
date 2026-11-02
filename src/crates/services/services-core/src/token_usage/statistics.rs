//! Aggregation of raw token usage records into dashboard statistics.
//!
//! The pure functions in this module own the shape of the usage statistics
//! surfaced by the settings "usage statistics" page: totals, distribution
//! breakdowns (model / provider group / endpoint) with per-entry cache hit
//! rates, and a token trend series. Callers supply per-record attribution
//! (provider group, endpoint) so the module stays free of configuration and
//! catalog dependencies.

use super::time_zone::{local_date_start_utc, parse_time_zone};
use super::types::TokenUsageRecord;
use chrono::{DateTime, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Bucketing granularity for the token usage trend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageGranularity {
    Hour,
    Day,
}

/// Dimension selected by the usage statistics text filter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatisticsFilterKind {
    #[default]
    All,
    Provider,
    Model,
}

/// Optional text filter applied before usage records are aggregated.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatisticsFilter {
    pub kind: UsageStatisticsFilterKind,
    pub query: String,
}

/// Per-record attribution resolved by the caller.
#[derive(Debug, Clone)]
pub struct UsageAttribution {
    pub model: UsageDimensionAttribution,
    pub group: UsageDimensionAttribution,
    pub endpoint: UsageDimensionAttribution,
}

/// Whether a usage dimension could be resolved through its persisted model
/// configuration identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageAttributionStatus {
    Resolved,
    ConfigMissing,
    ConfigIdMissing,
}

/// Stable aggregation identity plus display metadata for one usage dimension.
#[derive(Debug, Clone)]
pub struct UsageDimensionAttribution {
    pub key: String,
    pub name: String,
    pub provider_name: Option<String>,
    pub attribution_status: UsageAttributionStatus,
}

/// One row of a distribution breakdown (model / group / endpoint).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatisticsEntry {
    pub key: String,
    pub name: String,
    pub provider_name: Option<String>,
    pub attribution_status: UsageAttributionStatus,
    pub requests: u32,
    #[serde(default)]
    pub unknown_usage_requests: u32,
    pub tokens: u64,
    /// Cache hit ratio (0.0..=1.0) for this entry when any request reported
    /// cache telemetry, otherwise `None`.
    pub cache_hit_rate: Option<f64>,
    /// Cache HIT tokens served for this entry.
    #[serde(skip)]
    pub cached_tokens: u64,
    /// Prompt input tokens from requests that reported cache telemetry.
    #[serde(skip)]
    pub reported_input_tokens: u64,
}

impl UsageStatisticsEntry {
    fn new(attribution: UsageDimensionAttribution) -> Self {
        Self {
            key: attribution.key,
            name: attribution.name,
            provider_name: attribution.provider_name,
            attribution_status: attribution.attribution_status,
            requests: 0,
            unknown_usage_requests: 0,
            tokens: 0,
            cache_hit_rate: None,
            cached_tokens: 0,
            reported_input_tokens: 0,
        }
    }
}

/// One bucket of the token usage trend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    /// Bucket start serialized as UTC. The instant is aligned to the requested
    /// time zone's hour or local-calendar midnight.
    pub bucket: DateTime<Utc>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Tokens served from prefix cache (cache HIT).
    pub cache_read_tokens: u64,
    /// Tokens written into the cache (Anthropic cache WRITE).
    pub cache_write_tokens: u64,
    /// Cache hit ratio (0.0..=1.0) when the bucket contains cache telemetry,
    /// otherwise `None`.
    pub cache_hit_rate: Option<f64>,
}

/// Complete statistics payload for the usage dashboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatistics {
    pub total_requests: u32,
    #[serde(default)]
    pub unknown_usage_requests: u32,
    #[serde(default)]
    pub failed_requests: u32,
    #[serde(default)]
    pub by_account: Vec<AccountUsageStatistics>,
    /// Frozen request-time channels; legacy records stay explicitly unattributed.
    #[serde(default)]
    pub by_channel: Vec<UsageStatisticsEntry>,
    /// Latest native attempts in this range; legacy records have no invented IDs.
    #[serde(default)]
    pub recent_attempts: Vec<UsageAttemptSummary>,
    #[serde(default)]
    pub attempts_truncated: bool,
    pub total_tokens: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cached_tokens: u64,
    pub total_cache_write_tokens: u64,
    /// Prompt input tokens from requests that reported cache telemetry. Together
    /// with `total_cached_tokens` it yields the overall cache hit rate.
    pub total_cache_reported_input_tokens: u64,
    pub by_model: Vec<UsageStatisticsEntry>,
    pub by_group: Vec<UsageStatisticsEntry>,
    pub by_endpoint: Vec<UsageStatisticsEntry>,
    pub trend: Vec<UsageTrendPoint>,
    /// Granularity actually used for the trend (may be coarser than requested
    /// when the requested bucketing would produce too many points).
    pub granularity: UsageGranularity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageStatistics {
    pub key: String,
    /// `subscription`, `subscription_identity_unknown`, `api_key` or
    /// `historical_unknown`; account lookup never rewrites recorded identity.
    pub kind: String,
    pub provider: Option<String>,
    pub account_id: Option<String>,
    pub upstream_account_id: Option<String>,
    pub requests: u32,
    pub failed_requests: u32,
    pub unknown_usage_requests: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
}

/// Non-secret attempt facts from the ledger, never joined to current credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttemptSummary {
    pub account_key: String,
    pub timestamp: DateTime<Utc>,
    pub session_id: String,
    pub turn_id: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    #[serde(flatten)]
    pub request: super::types::ModelRequestUsageContext,
}

const MAX_RECENT_ATTEMPTS: usize = 50;

/// Upper bound on trend points. Very long time ranges (e.g. "all time" with
/// hourly buckets) are coarsened or truncated to the most recent buckets so the
/// payload stays small.
const MAX_TREND_POINTS: usize = 800;

/// Aggregate raw records into dashboard statistics.
///
/// `attribute` maps every record to its provider group and endpoint label; the
/// aggregation itself is pure.
pub fn aggregate_statistics<F>(
    records: &[TokenUsageRecord],
    granularity: UsageGranularity,
    attribute: F,
) -> UsageStatistics
where
    F: Fn(&TokenUsageRecord) -> UsageAttribution,
{
    aggregate_statistics_with_time_zone(records, granularity, None, attribute)
}

/// Aggregate records while aligning trend buckets to an IANA time zone.
/// Invalid or missing zones preserve the legacy UTC behavior.
pub fn aggregate_statistics_with_time_zone<F>(
    records: &[TokenUsageRecord],
    granularity: UsageGranularity,
    time_zone: Option<&str>,
    attribute: F,
) -> UsageStatistics
where
    F: Fn(&TokenUsageRecord) -> UsageAttribution,
{
    let mut total_requests = 0u32;
    let mut unknown_usage_requests = 0u32;
    let mut failed_requests = 0u32;
    let mut by_account = HashMap::<String, AccountUsageStatistics>::new();
    let mut recent_attempts = Vec::<UsageAttemptSummary>::new();
    let mut native_attempt_count = 0usize;
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cached = 0u64;
    let mut total_cache_write = 0u64;
    let mut total_cache_reported_input = 0u64;

    let mut by_model: HashMap<String, UsageStatisticsEntry> = HashMap::new();
    let mut by_group: HashMap<String, UsageStatisticsEntry> = HashMap::new();
    let mut by_endpoint: HashMap<String, UsageStatisticsEntry> = HashMap::new();
    let mut by_channel: HashMap<String, UsageStatisticsEntry> = HashMap::new();

    for record in records {
        total_requests += 1;
        let known = record.usage_is_known();
        let context = record.request_context();
        let channel = context
            .as_ref()
            .and_then(|request| request.channel.as_ref())
            .map(|channel| UsageDimensionAttribution {
                key: format!(
                    "channel:{}:{}",
                    channel.model_config_id, channel.binding_fingerprint
                ),
                name: channel.name.clone(),
                provider_name: Some(channel.protocol.clone()),
                attribution_status: UsageAttributionStatus::Resolved,
            })
            .unwrap_or_else(|| UsageDimensionAttribution {
                key: "legacy_unknown_channel".into(),
                name: record.effective_model_name.clone(),
                provider_name: None,
                attribution_status: UsageAttributionStatus::ConfigIdMissing,
            });
        accumulate_entry(&mut by_channel, channel, record);
        let failed = context
            .as_ref()
            .is_some_and(|context| context.outcome == super::types::ModelRequestOutcome::Failed);
        unknown_usage_requests += u32::from(!known);
        failed_requests += u32::from(failed);
        let (key, kind, provider, account_id, upstream_account_id) = match context.as_ref() {
            Some(context) => match &context.account {
                Some(account) => (
                    format!(
                        "subscription:{}",
                        serde_json::json!([
                            account.provider,
                            account.account_id,
                            account.upstream_account_id
                        ])
                    ),
                    "subscription",
                    Some(account.provider.clone()),
                    Some(account.account_id.clone()),
                    account.upstream_account_id.clone(),
                ),
                None if context.authentication == super::types::UsageAuthenticationKind::ApiKey => {
                    ("api-key".into(), "api_key", None, None, None)
                }
                None => (
                    "subscription-unknown".into(),
                    "subscription_identity_unknown",
                    None,
                    None,
                    None,
                ),
            },
            None => (
                "historical-unknown".into(),
                "historical_unknown",
                None,
                None,
                None,
            ),
        };
        if let Some(context) = context {
            native_attempt_count += 1;
            // Keep the dashboard detail window bounded while aggregating the entire range.
            let position = recent_attempts
                .binary_search_by(|existing| {
                    record
                        .timestamp
                        .cmp(&existing.timestamp)
                        .then_with(|| existing.request.attempt_id.cmp(&context.attempt_id))
                })
                .unwrap_or_else(|position| position);
            if position < MAX_RECENT_ATTEMPTS {
                recent_attempts.insert(
                    position,
                    UsageAttemptSummary {
                        account_key: key.clone(),
                        timestamp: record.timestamp,
                        session_id: record.session_id.clone(),
                        turn_id: record.turn_id.clone(),
                        input_tokens: known.then_some(record.input_tokens),
                        output_tokens: known.then_some(record.output_tokens),
                        request: context,
                    },
                );
                recent_attempts.truncate(MAX_RECENT_ATTEMPTS);
            }
        }
        let account = by_account
            .entry(key.clone())
            .or_insert_with(|| AccountUsageStatistics {
                key,
                kind: kind.into(),
                provider,
                account_id,
                upstream_account_id,
                requests: 0,
                failed_requests: 0,
                unknown_usage_requests: 0,
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
            });
        account.requests += 1;
        account.failed_requests += u32::from(failed);
        account.unknown_usage_requests += u32::from(!known);
        if known {
            account.input_tokens += u64::from(record.input_tokens);
            account.output_tokens += u64::from(record.output_tokens);
            account.cached_tokens += u64::from(record.cached_tokens);
            total_input += record.input_tokens as u64;
            total_output += record.output_tokens as u64;
            total_cached += record.cached_tokens as u64;
            total_cache_write += record.cache_write_tokens as u64;
            if record.cached_tokens_available {
                total_cache_reported_input += record.input_tokens as u64;
            }
        }

        let attribution = attribute(record);
        accumulate_entry(&mut by_model, attribution.model, record);
        accumulate_entry(&mut by_group, attribution.group, record);
        accumulate_entry(&mut by_endpoint, attribution.endpoint, record);
    }

    let time_zone = parse_time_zone(time_zone).unwrap_or(chrono_tz::UTC);
    let (trend, effective_granularity) = build_trend(records, granularity, time_zone);

    let attempts_truncated = native_attempt_count > MAX_RECENT_ATTEMPTS;

    UsageStatistics {
        recent_attempts,
        attempts_truncated,
        total_requests,
        unknown_usage_requests,
        failed_requests,
        by_account: {
            let mut accounts: Vec<_> = by_account.into_values().collect();
            accounts.sort_by(|left, right| {
                right
                    .requests
                    .cmp(&left.requests)
                    .then_with(|| left.key.cmp(&right.key))
            });
            accounts
        },
        total_tokens: total_input + total_output,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cached_tokens: total_cached,
        total_cache_write_tokens: total_cache_write,
        total_cache_reported_input_tokens: total_cache_reported_input,
        by_model: finalize_entries(by_model),
        by_channel: finalize_entries(by_channel),
        by_group: finalize_entries(by_group),
        by_endpoint: finalize_entries(by_endpoint),
        trend,
        granularity: effective_granularity,
    }
}

fn accumulate_entry(
    map: &mut HashMap<String, UsageStatisticsEntry>,
    attribution: UsageDimensionAttribution,
    record: &TokenUsageRecord,
) {
    let key = attribution.key.clone();
    let entry = map
        .entry(key)
        .or_insert_with(|| UsageStatisticsEntry::new(attribution));
    entry.requests += 1;
    if !record.usage_is_known() {
        entry.unknown_usage_requests += 1;
        return;
    }
    entry.tokens += record.total_tokens as u64;
    entry.cached_tokens += record.cached_tokens as u64;
    if record.cached_tokens_available {
        entry.reported_input_tokens += record.input_tokens as u64;
    }
}

fn finalize_entries(map: HashMap<String, UsageStatisticsEntry>) -> Vec<UsageStatisticsEntry> {
    let mut entries = map.into_values().collect::<Vec<_>>();
    for entry in &mut entries {
        entry.cache_hit_rate = if entry.reported_input_tokens == 0 {
            None
        } else if entry.cached_tokens == entry.reported_input_tokens {
            // Exact full cache hit: represent as exactly 1.0 so the UI never
            // shows 99.99...% for a mathematically complete hit.
            Some(1.0)
        } else {
            Some(entry.cached_tokens as f64 / entry.reported_input_tokens as f64)
        };
    }
    entries.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.key.cmp(&right.key))
    });
    entries
}

/// Build the trend series, filling empty buckets so the chart stays contiguous.
///
/// Returns the granularity actually applied: when the requested granularity
/// would exceed [`MAX_TREND_POINTS`] buckets, bucketing is coarsened to days,
/// and when even that is too long only the most recent buckets are retained.
fn build_trend(
    records: &[TokenUsageRecord],
    granularity: UsageGranularity,
    time_zone: Tz,
) -> (Vec<UsageTrendPoint>, UsageGranularity) {
    if records.is_empty() {
        return (Vec::new(), granularity);
    }

    let mut granularity = granularity;
    let mut buckets = bucket_records(records, granularity, time_zone);
    if buckets.is_empty() {
        return (Vec::new(), granularity);
    }

    let mut first = *buckets.keys().min().unwrap_or(&0);
    let mut last = *buckets.keys().max().unwrap_or(&0);

    let hourly_bucket_count = (last - first) / 3600 + 1;
    if granularity == UsageGranularity::Hour && hourly_bucket_count > MAX_TREND_POINTS as i64 {
        granularity = UsageGranularity::Day;
        buckets = bucket_records(records, granularity, time_zone);
        first = *buckets.keys().min().unwrap_or(&0);
        last = *buckets.keys().max().unwrap_or(&0);
    }

    let bucket_keys = bucket_keys_between(first, last, granularity, time_zone);
    let retained_start = bucket_keys.len().saturating_sub(MAX_TREND_POINTS);

    let mut trend = Vec::with_capacity(bucket_keys.len() - retained_start);
    for key in bucket_keys.into_iter().skip(retained_start) {
        let bucket = buckets.remove(&key);
        trend.push(
            TrendBucket {
                key,
                ..bucket.unwrap_or_default()
            }
            .into_point(),
        );
    }

    (trend, granularity)
}

fn bucket_records(
    records: &[TokenUsageRecord],
    granularity: UsageGranularity,
    time_zone: Tz,
) -> HashMap<i64, TrendBucket> {
    let mut buckets: HashMap<i64, TrendBucket> = HashMap::new();
    for record in records {
        if !record.usage_is_known() {
            continue;
        }
        let key = bucket_key(record.timestamp, granularity, time_zone);
        let bucket = buckets.entry(key).or_insert_with(|| TrendBucket {
            key,
            ..TrendBucket::default()
        });
        bucket.input_tokens += record.input_tokens as u64;
        bucket.output_tokens += record.output_tokens as u64;
        bucket.cached_tokens += record.cached_tokens as u64;
        bucket.cache_write_tokens += record.cache_write_tokens as u64;
        if record.cached_tokens_available {
            bucket.reported_input_tokens += record.input_tokens as u64;
        }
    }
    buckets
}

fn bucket_key(timestamp: DateTime<Utc>, granularity: UsageGranularity, time_zone: Tz) -> i64 {
    match granularity {
        UsageGranularity::Hour => timestamp
            .with_timezone(&time_zone)
            .with_minute(0)
            .and_then(|value| value.with_second(0))
            .and_then(|value| value.with_nanosecond(0))
            .map(|value| value.with_timezone(&Utc).timestamp())
            .unwrap_or_else(|| timestamp.timestamp() - timestamp.timestamp().rem_euclid(3600)),
        UsageGranularity::Day => {
            let date = timestamp.with_timezone(&time_zone).date_naive();
            local_date_start_utc(date, time_zone)
                .map(|value| value.timestamp())
                .unwrap_or_else(|_| {
                    date.and_hms_opt(0, 0, 0)
                        .expect("midnight is valid")
                        .and_utc()
                        .timestamp()
                })
        }
    }
}

fn bucket_keys_between(
    first: i64,
    last: i64,
    granularity: UsageGranularity,
    time_zone: Tz,
) -> Vec<i64> {
    let mut keys = Vec::new();
    let mut cursor = first;
    while cursor <= last {
        keys.push(cursor);
        let next = match granularity {
            UsageGranularity::Hour => cursor.checked_add(3600),
            UsageGranularity::Day => DateTime::from_timestamp(cursor, 0)
                .and_then(|value| value.with_timezone(&time_zone).date_naive().succ_opt())
                .and_then(|date| local_date_start_utc(date, time_zone).ok())
                .map(|value| value.timestamp()),
        };
        let Some(next) = next.filter(|next| *next > cursor) else {
            break;
        };
        cursor = next;
    }
    keys
}

#[derive(Debug, Default, Clone, Copy)]
struct TrendBucket {
    key: i64,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    cache_write_tokens: u64,
    reported_input_tokens: u64,
}

impl TrendBucket {
    fn into_point(self) -> UsageTrendPoint {
        let cache_hit_rate = (self.reported_input_tokens > 0)
            .then(|| self.cached_tokens as f64 / self.reported_input_tokens as f64);
        UsageTrendPoint {
            bucket: DateTime::from_timestamp(self.key, 0).unwrap_or(Utc::now()),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cached_tokens,
            cache_write_tokens: self.cache_write_tokens,
            cache_hit_rate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Timelike, Utc};

    fn record(
        model: &str,
        timestamp: DateTime<Utc>,
        input: u32,
        output: u32,
        cached: u32,
        cache_write: u32,
        cached_available: bool,
    ) -> TokenUsageRecord {
        TokenUsageRecord {
            model_config_id: format!("config-{model}"),
            effective_model_name: model.to_string(),
            session_id: "session-a".to_string(),
            turn_id: "turn-a".to_string(),
            timestamp,
            input_tokens: input,
            output_tokens: output,
            cached_tokens: cached,
            cached_tokens_available: cached_available,
            cache_write_tokens: cache_write,
            total_tokens: input + output,
            token_details: None,
            is_subagent: false,
        }
    }

    fn dimension(
        key: impl Into<String>,
        name: impl Into<String>,
        provider_name: Option<String>,
    ) -> UsageDimensionAttribution {
        UsageDimensionAttribution {
            key: key.into(),
            name: name.into(),
            provider_name,
            attribution_status: UsageAttributionStatus::Resolved,
        }
    }

    fn attribution() -> impl Fn(&TokenUsageRecord) -> UsageAttribution {
        |record| UsageAttribution {
            model: dimension(
                record.model_config_id.clone(),
                record.effective_model_name.clone(),
                Some(format!("provider-of-{}", record.effective_model_name)),
            ),
            group: dimension(
                format!("group-of-{}", record.effective_model_name),
                format!("provider-of-{}", record.effective_model_name),
                None,
            ),
            endpoint: dimension(
                format!("endpoint-of-{}", record.effective_model_name),
                format!("/endpoint-of-{}", record.effective_model_name),
                None,
            ),
        }
    }

    #[test]
    fn aggregates_totals_and_breakdowns() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let records = vec![
            record("model-a", t0, 1000, 200, 500, 0, true),
            record(
                "model-a",
                t0 + Duration::minutes(30),
                2000,
                300,
                0,
                100,
                false,
            ),
            record("model-b", t0 + Duration::hours(2), 500, 50, 0, 0, false),
        ];

        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());

        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.total_input_tokens, 3500);
        assert_eq!(stats.total_output_tokens, 550);
        assert_eq!(stats.total_cached_tokens, 500);
        assert_eq!(stats.total_cache_write_tokens, 100);
        assert_eq!(stats.total_tokens, 4050);
        assert_eq!(stats.total_cache_reported_input_tokens, 1000);

        assert_eq!(stats.by_model.len(), 2);
        let model_a = stats
            .by_model
            .iter()
            .find(|entry| entry.name == "model-a")
            .unwrap();
        assert_eq!(model_a.requests, 2);
        assert_eq!(model_a.tokens, 3500);
        assert_eq!(model_a.cached_tokens, 500);
        assert_eq!(model_a.reported_input_tokens, 1000);
        assert!((model_a.cache_hit_rate.unwrap() - 0.5).abs() < 1e-9);

        let model_b = stats
            .by_model
            .iter()
            .find(|entry| entry.name == "model-b")
            .unwrap();
        assert!(model_b.cache_hit_rate.is_none());

        assert_eq!(stats.by_group.len(), 2);
        assert_eq!(stats.by_endpoint.len(), 2);
    }

    #[test]
    fn same_named_models_with_different_keys_are_not_merged() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let first = record("shared-model", t0, 100, 0, 0, 0, false);
        let mut second = record(
            "shared-model",
            t0 + Duration::minutes(1),
            200,
            0,
            0,
            0,
            false,
        );
        second.model_config_id = "another-config".to_string();

        let stats = aggregate_statistics(&[first, second], UsageGranularity::Hour, attribution());

        assert_eq!(stats.by_model.len(), 2);
        assert!(stats
            .by_model
            .iter()
            .all(|entry| entry.name == "shared-model"));
        assert_ne!(stats.by_model[0].key, stats.by_model[1].key);
    }

    #[test]
    fn entry_without_cache_telemetry_has_no_hit_rate() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let records = vec![record("model-a", t0, 100, 100, 0, 0, false)];
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        assert_eq!(stats.by_model[0].cache_hit_rate, None);
        assert_eq!(stats.total_cache_reported_input_tokens, 0);
    }

    #[test]
    fn exact_full_cache_hit_is_reported_as_exactly_one() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        // cached == input on a single request: mathematically a 100% hit.
        let records = vec![record("model-a", t0, 1000, 0, 1000, 0, true)];
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        assert_eq!(stats.by_model[0].cache_hit_rate, Some(1.0));
        assert_eq!(
            stats.total_cached_tokens,
            stats.total_cache_reported_input_tokens
        );
    }

    #[test]
    fn trend_buckets_by_hour_and_fills_gaps() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let records = vec![
            record("model-a", t0, 100, 0, 0, 0, false),
            record("model-a", t0 + Duration::hours(3), 200, 0, 0, 0, false),
        ];
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        assert_eq!(stats.granularity, UsageGranularity::Hour);
        assert_eq!(stats.trend.len(), 4);
        assert_eq!(stats.trend[0].input_tokens, 100);
        assert_eq!(stats.trend[1].input_tokens, 0);
        assert_eq!(stats.trend[3].input_tokens, 200);
        assert_eq!(
            stats.trend[0].bucket,
            t0.with_minute(0).unwrap().with_second(0).unwrap()
        );
    }

    #[test]
    fn trend_cache_hit_rate_uses_reported_input() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let records = vec![
            record("model-a", t0, 1000, 0, 250, 0, true),
            record("model-b", t0 + Duration::minutes(10), 100, 0, 0, 0, false),
        ];
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        let point = &stats.trend[0];
        assert_eq!(point.input_tokens, 1100);
        assert_eq!(point.cache_read_tokens, 250);
        // Only the record with explicit cache telemetry feeds the ratio.
        assert!((point.cache_hit_rate.unwrap() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn trend_coarsens_to_days_when_hourly_span_is_too_long() {
        let t0 = Utc.with_ymd_and_hms(2026, 8, 16, 0, 0, 0).unwrap();
        let records = vec![
            record("model-a", t0, 100, 0, 0, 0, false),
            record("model-a", t0 + Duration::days(60), 200, 0, 0, 0, false),
        ];
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        assert_eq!(stats.granularity, UsageGranularity::Day);
        assert_eq!(stats.trend.len(), 61);
    }

    #[test]
    fn daily_trend_uses_the_requested_local_midnight() {
        let records = vec![
            record(
                "model-a",
                Utc.with_ymd_and_hms(2026, 8, 15, 16, 30, 0).unwrap(),
                100,
                0,
                0,
                0,
                false,
            ),
            record(
                "model-a",
                Utc.with_ymd_and_hms(2026, 8, 16, 15, 30, 0).unwrap(),
                200,
                0,
                0,
                0,
                false,
            ),
        ];

        let stats = aggregate_statistics_with_time_zone(
            &records,
            UsageGranularity::Day,
            Some("Asia/Shanghai"),
            attribution(),
        );

        assert_eq!(stats.trend.len(), 1);
        assert_eq!(stats.trend[0].input_tokens, 300);
        assert_eq!(
            stats.trend[0].bucket,
            Utc.with_ymd_and_hms(2026, 8, 15, 16, 0, 0).unwrap()
        );
    }

    #[test]
    fn daily_trend_follows_dst_calendar_days() {
        let records = vec![
            record(
                "model-a",
                Utc.with_ymd_and_hms(2026, 3, 7, 13, 0, 0).unwrap(),
                100,
                0,
                0,
                0,
                false,
            ),
            record(
                "model-a",
                Utc.with_ymd_and_hms(2026, 3, 9, 12, 0, 0).unwrap(),
                200,
                0,
                0,
                0,
                false,
            ),
        ];

        let stats = aggregate_statistics_with_time_zone(
            &records,
            UsageGranularity::Day,
            Some("America/New_York"),
            attribution(),
        );

        assert_eq!(stats.trend.len(), 3);
        assert_eq!(
            stats.trend[0].bucket,
            Utc.with_ymd_and_hms(2026, 3, 7, 5, 0, 0).unwrap()
        );
        assert_eq!(
            stats.trend[1].bucket,
            Utc.with_ymd_and_hms(2026, 3, 8, 5, 0, 0).unwrap()
        );
        assert_eq!(
            stats.trend[2].bucket,
            Utc.with_ymd_and_hms(2026, 3, 9, 4, 0, 0).unwrap()
        );
    }

    #[test]
    fn channels_keep_request_time_identity_and_unknown_legacy_records() {
        let time = Utc.with_ymd_and_hms(2026, 10, 15, 10, 0, 0).unwrap();
        let mut first = record("same-model", time, 10, 2, 0, 0, false);
        let mut second = record("same-model", time, 0, 0, 0, 0, false);
        for (record, id, known) in [
            (&mut first, "old-channel", true),
            (&mut second, "backup", false),
        ] {
            record.token_details = Some(serde_json::json!({"openbitfunModelRequest":{
                "version":1,"roundId":"round","attemptId":id,"attemptIndex":1,"startedAt":time,
                "authentication":"api_key","requestedModel":"same-model","outcome":"failed","usageKnown":known,
                "channel":{"modelConfigId":id,"name":id,"protocol":"anthropic","bindingFingerprint":"recorded-fingerprint"}
            }}));
        }
        let legacy = record("same-model", time, 4, 1, 0, 0, false);
        let stats = aggregate_statistics(
            &[first, second, legacy],
            UsageGranularity::Day,
            attribution(),
        );
        assert_eq!(stats.by_channel.len(), 3);
        let frozen = stats
            .by_channel
            .iter()
            .find(|channel| channel.name == "old-channel")
            .unwrap();
        assert_eq!(frozen.provider_name.as_deref(), Some("anthropic"));
        assert_eq!(frozen.tokens, 12);
        let unknown = stats
            .by_channel
            .iter()
            .find(|channel| channel.name == "backup")
            .unwrap();
        assert_eq!(unknown.unknown_usage_requests, 1);
        assert_eq!(
            stats
                .by_channel
                .iter()
                .find(|channel| channel.key == "legacy_unknown_channel")
                .unwrap()
                .attribution_status,
            UsageAttributionStatus::ConfigIdMissing
        );
        assert_eq!(stats.total_tokens, 17);
    }

    #[test]
    fn account_totals_preserve_recorded_seats_unknown_usage_and_legacy_identity() {
        let time = Utc.with_ymd_and_hms(2026, 10, 13, 10, 0, 0).unwrap();
        let mut first = record("same-model", time, 10, 2, 3, 0, true);
        let context = |seat: &str, known: bool| {
            serde_json::json!({"openbitfunModelRequest":{
                "version":1,"roundId":"round","attemptId":seat,"attemptIndex":1,"startedAt":time,
                "authentication":"subscription","account":{"provider":"codex","account_id":"codex","upstream_account_id":seat},
                "requestedModel":"same-model","outcome":"failed","usageKnown":known
            }})
        };
        first.token_details = Some(context("seat-one", true));
        first.token_details.as_mut().unwrap()["openbitfunModelRequest"]["routingWarnings"] =
            serde_json::json!(["affinity_unavailable", "future_observation"]);
        let mut second = record("same-model", time, 0, 0, 0, 0, false);
        second.token_details = Some(context("seat-two", false));
        let legacy = record("same-model", time, 20, 5, 0, 0, false);
        let unreported =
            aggregate_statistics(&[second.clone()], UsageGranularity::Hour, attribution());
        assert!(
            unreported.trend.is_empty(),
            "unknown usage must not create a fabricated zero bucket at the Unix epoch"
        );
        assert_eq!(unreported.unknown_usage_requests, 1);
        let stats = aggregate_statistics(
            &[first, second, legacy],
            UsageGranularity::Hour,
            attribution(),
        );
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.total_tokens, 37);
        assert_eq!(stats.unknown_usage_requests, 1);
        assert_eq!(stats.failed_requests, 2);
        assert_eq!(
            stats.by_account.len(),
            3,
            "the mutable default slot must not merge different recorded upstream seats"
        );
        let unknown = stats
            .by_account
            .iter()
            .find(|account| account.upstream_account_id.as_deref() == Some("seat-two"))
            .unwrap();
        assert_eq!(unknown.unknown_usage_requests, 1);
        assert_eq!(unknown.input_tokens, 0);
        assert!(stats
            .by_account
            .iter()
            .any(|account| account.kind == "historical_unknown" && account.requests == 1));
        let mut old_payload = serde_json::to_value(&stats).unwrap();
        for field in [
            "unknownUsageRequests",
            "failedRequests",
            "byAccount",
            "recentAttempts",
            "attemptsTruncated",
        ] {
            old_payload.as_object_mut().unwrap().remove(field);
        }
        let restored: UsageStatistics = serde_json::from_value(old_payload).unwrap();
        assert_eq!(restored.unknown_usage_requests, 0);
        assert!(restored.by_account.is_empty());
        assert!(restored.recent_attempts.is_empty());
        assert!(!restored.attempts_truncated);
        assert_eq!(
            stats.recent_attempts.len(),
            2,
            "legacy rows must not gain invented attempt identities"
        );
        let failed = stats
            .recent_attempts
            .iter()
            .find(|attempt| attempt.request.attempt_id == "seat-one")
            .unwrap();
        assert_eq!(failed.input_tokens, Some(10));
        assert_eq!(
            failed.request.routing_warnings,
            ["affinity_unavailable", "future_observation"]
        );
        let failed_payload = serde_json::to_value(failed).unwrap();
        assert_eq!(
            failed_payload["routingWarnings"],
            serde_json::json!(["affinity_unavailable", "future_observation"])
        );
        let restored: UsageAttemptSummary = serde_json::from_value(failed_payload).unwrap();
        assert_eq!(
            restored.request.routing_warnings,
            failed.request.routing_warnings
        );
        let unknown = stats
            .recent_attempts
            .iter()
            .find(|attempt| attempt.request.attempt_id == "seat-two")
            .unwrap();
        assert_eq!(unknown.input_tokens, None);
        assert_eq!(unknown.output_tokens, None);
        assert!(
            unknown.request.routing_warnings.is_empty(),
            "legacy attempts omit the additive observation"
        );
        let payload = serde_json::to_value(unknown).unwrap();
        assert_eq!(payload["outcome"], "failed");
        assert_eq!(payload["usageKnown"], false);
        assert_eq!(payload["accountKey"], unknown.account_key);
    }

    #[test]
    fn recent_attempts_are_latest_bounded_and_do_not_truncate_totals() {
        let time = Utc.with_ymd_and_hms(2026, 10, 15, 10, 0, 0).unwrap();
        let records: Vec<_> = (0..55).map(|index| {
            let mut value = record("model", time + Duration::seconds(index), 2, 1, 0, 0, false);
            value.token_details = Some(serde_json::json!({"openbitfunModelRequest":{
                "version":1,"roundId":"round","attemptId":format!("attempt-{index}"),"attemptIndex":index+1,"startedAt":value.timestamp,
                "authentication":"api_key","requestedModel":"model","outcome":"completed","usageKnown":true
            }}));
            value
        }).collect();
        let stats = aggregate_statistics(&records, UsageGranularity::Hour, attribution());
        assert_eq!(stats.total_requests, 55);
        assert_eq!(stats.total_tokens, 165);
        assert!(stats.attempts_truncated);
        assert_eq!(stats.recent_attempts.len(), 50);
        assert_eq!(stats.recent_attempts[0].request.attempt_id, "attempt-54");
        assert_eq!(stats.recent_attempts[49].request.attempt_id, "attempt-5");
    }

    #[test]
    fn empty_records_produce_empty_statistics() {
        let stats = aggregate_statistics(&[], UsageGranularity::Hour, attribution());
        assert_eq!(stats.total_requests, 0);
        assert_eq!(stats.trend.len(), 0);
        assert!(stats.by_model.is_empty());
    }
}
