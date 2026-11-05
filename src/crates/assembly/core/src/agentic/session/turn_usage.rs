//! Reconcile the durable Turn with the executing host's request-usage ledger.

use crate::infrastructure::PathManager;
use crate::service::session::{DialogTurnData, DialogTurnTokenUsageData};
use crate::service::token_usage::{
    TimeRange, TokenUsageQuery, TokenUsageRecord, TokenUsageService,
};

/// Native request writers commit before returning from model execution.
/// Read that authority before taking the Session mutation lock; client
/// checkpoints and event subscribers may still be behind at completion.
pub(super) async fn load_turn_token_usage(
    path_manager: &PathManager,
    session_id: &str,
    turn_id: &str,
    started_at_ms: u64,
) -> Option<DialogTurnTokenUsageData> {
    // A UI checkpoint may timestamp the Turn after the first request started.
    // Bound the ledger scan by its UTC day, then select exact Session/Turn IDs;
    // never discard a request just because its timestamp precedes that checkpoint.
    let start = chrono::DateTime::from_timestamp_millis(i64::try_from(started_at_ms).ok()?)?
        .date_naive()
        .and_hms_opt(0, 0, 0)?
        .and_utc();
    let service = TokenUsageService::for_queries(path_manager);
    let records = match service
        .query_records(TokenUsageQuery {
            model_id: None,
            session_id: Some(session_id.to_string()),
            time_range: TimeRange::Custom {
                start,
                end: chrono::Utc::now(),
            },
            time_zone: None,
            limit: None,
            offset: None,
            // Child Sessions have their own identity. Include the flag so
            // completing a child also persists its own Turn's usage.
            include_subagent: true,
        })
        .await
    {
        Ok(records) => records,
        Err(error) => {
            log::warn!(
                "Failed to reconcile turn token usage; retaining checkpoint: session_id={}, turn_id={}, error={}",
                session_id, turn_id, error
            );
            return None;
        }
    };
    aggregate_turn_usage(&records, turn_id)
}

fn aggregate_turn_usage(
    records: &[TokenUsageRecord],
    turn_id: &str,
) -> Option<DialogTurnTokenUsageData> {
    // Only native round attempts emit the usage events shown beside the Turn.
    // The ledger also holds auxiliary calls (for example AnalyzeImage) under
    // the same Turn ID. Unattributed legacy rows cannot prove this distinction;
    // keep their existing checkpoint instead of mixing them into the rate.
    let mut total: Option<DialogTurnTokenUsageData> = None;
    for record in records.iter().filter(|record| {
        record.turn_id == turn_id
            && record
                .request_context()
                .is_some_and(|context| context.usage_known)
    }) {
        let usage = DialogTurnTokenUsageData {
            input_tokens: u64::from(record.input_tokens),
            output_tokens: Some(u64::from(record.output_tokens)),
            cached_tokens: record
                .cached_tokens_available
                .then_some(u64::from(record.cached_tokens)),
            total_tokens: u64::from(record.total_tokens),
            timestamp: record.timestamp.timestamp_millis().max(0) as u64,
        };
        match &mut total {
            None => total = Some(usage),
            Some(total) => {
                total.input_tokens = total.input_tokens.saturating_add(usage.input_tokens);
                total.output_tokens = total
                    .output_tokens
                    .zip(usage.output_tokens)
                    .map(|(left, right)| left.saturating_add(right));
                total.cached_tokens = total
                    .cached_tokens
                    .zip(usage.cached_tokens)
                    .map(|(left, right)| left.saturating_add(right));
                total.total_tokens = total.total_tokens.saturating_add(usage.total_tokens);
                total.timestamp = total.timestamp.max(usage.timestamp);
            }
        }
    }
    total
}

pub(crate) fn reconcile_turn_token_usage(
    turn: &mut DialogTurnData,
    usage: Option<DialogTurnTokenUsageData>,
) {
    let Some(usage) = usage else {
        return;
    };
    // A cleared/incomplete ledger must not reduce a checkpoint that already
    // contains more observed requests. Never add the checkpoint to the ledger:
    // they are overlapping projections of the same requests.
    if turn.token_usage.as_ref().is_none_or(|previous| {
        usage.input_tokens >= previous.input_tokens
            && usage.total_tokens >= previous.total_tokens
            && usage.output_tokens >= previous.output_tokens
    }) {
        turn.token_usage = Some(usage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_record(output: u32) -> TokenUsageRecord {
        serde_json::from_value(serde_json::json!({
            "model_config_id": "config", "effective_model_name": "model",
            "session_id": "session", "turn_id": "turn", "timestamp": chrono::Utc::now(),
            "input_tokens": 100, "output_tokens": output,
            "cached_tokens": 0, "total_tokens": 100 + output
        }))
        .unwrap()
    }

    fn request_details(attempt: &str) -> Option<serde_json::Value> {
        Some(serde_json::json!({"openbitfunModelRequest": {
            "version": 1, "roundId": attempt, "attemptId": attempt, "attemptIndex": 1,
            "startedAt": chrono::Utc::now(), "authentication": "api_key",
            "requestedModel": "model", "outcome": "completed", "usageKnown": true
        }}))
    }

    fn native_record(output: u32) -> TokenUsageRecord {
        let mut record = legacy_record(output);
        record.token_details = request_details(&format!("attempt-{output}"));
        record
    }

    #[test]
    fn turn_usage_keeps_legacy_unknown_cache_and_roundtrips_existing_shape() {
        let legacy = legacy_record(5000);
        assert!(aggregate_turn_usage(&[legacy.clone()], "turn").is_none());
        let first = native_record(97);
        let mut second = native_record(237);
        second.cached_tokens_available = true;
        second.cached_tokens = 80;
        let usage = aggregate_turn_usage(&[first, second, legacy], "turn").unwrap();
        assert_eq!(usage.output_tokens, Some(334));
        assert_eq!(usage.cached_tokens, None);
        let old_shape = serde_json::json!({
            "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens, "timestamp": usage.timestamp
        });
        let restored: DialogTurnTokenUsageData = serde_json::from_value(old_shape).unwrap();
        let roundtrip: DialogTurnTokenUsageData =
            serde_json::from_value(serde_json::to_value(restored).unwrap()).unwrap();
        assert_eq!(roundtrip, usage);
    }

    #[test]
    fn turn_usage_distinguishes_unknown_attempts_from_known_zero() {
        let mut unknown = legacy_record(0);
        unknown.input_tokens = 0;
        unknown.total_tokens = 0;
        unknown.token_details = Some(serde_json::json!({"openbitfunModelRequest": {
            "version": 1, "roundId": "round", "attemptId": "attempt", "attemptIndex": 1,
            "startedAt": chrono::Utc::now(), "authentication": "api_key",
            "requestedModel": "model", "outcome": "failed", "usageKnown": false
        }}));
        assert!(aggregate_turn_usage(&[unknown.clone()], "turn").is_none());
        let mut zero = native_record(0);
        zero.cached_tokens_available = true;
        let usage = aggregate_turn_usage(&[unknown, zero], "turn").unwrap();
        assert_eq!(usage.output_tokens, Some(0));
        assert_eq!(usage.cached_tokens, Some(0));
    }

    #[tokio::test]
    async fn turn_usage_reads_host_ledger_and_preserves_unreadable_records() {
        let root = tempfile::tempdir().unwrap();
        let paths = PathManager::with_user_root_for_tests(root.path().join("host"));
        let controller = PathManager::with_user_root_for_tests(root.path().join("controller"));
        let service = TokenUsageService::new(std::sync::Arc::new(
            PathManager::with_user_root_for_tests(root.path().join("host")),
        ))
        .await
        .unwrap();
        for output in [97, 237] {
            service
                .record_usage(
                    "config".into(),
                    "model".into(),
                    "session".into(),
                    "turn".into(),
                    100,
                    output,
                    None,
                    request_details(&format!("attempt-{output}")),
                    true,
                )
                .await
                .unwrap();
        }
        assert!(load_turn_token_usage(&controller, "session", "turn", 0)
            .await
            .is_none());
        assert!(!controller.user_data_dir().join("token_usage").exists());
        let usage = load_turn_token_usage(&paths, "session", "turn", 0)
            .await
            .unwrap();
        assert_eq!(usage.output_tokens, Some(334));
        let checkpoint_ms = chrono::Utc::now().timestamp_millis() as u64;
        assert_eq!(
            load_turn_token_usage(&paths, "session", "turn", checkpoint_ms).await,
            Some(usage.clone()),
        );
        let mut turn = DialogTurnData::new(
            "turn".into(),
            0,
            "session".into(),
            crate::service::session::UserMessageData {
                id: "user".into(),
                content: "hi".into(),
                timestamp: 1,
                metadata: None,
            },
        );
        turn.token_usage = Some(usage.clone());
        let older = aggregate_turn_usage(&[native_record(97)], "turn");
        reconcile_turn_token_usage(&mut turn, older);
        assert_eq!(turn.token_usage, Some(usage.clone()));
        let path = service
            .base_dir()
            .join("records")
            .join(format!("{}.json", chrono::Utc::now().format("%Y-%m-%d")));
        std::fs::write(&path, "unreadable existing ledger").unwrap();
        let unavailable = load_turn_token_usage(&paths, "session", "turn", 0).await;
        assert!(unavailable.is_none());
        reconcile_turn_token_usage(&mut turn, unavailable);
        assert_eq!(turn.token_usage, Some(usage));
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "unreadable existing ledger"
        );
    }
}
