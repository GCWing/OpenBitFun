//! Bounded summary generation shared by live updates and history bootstrap.

use super::*;

#[derive(Debug, serde::Serialize)]
pub(super) struct SummaryAttemptDiagnostics {
    model_id: Option<String>,
    model_name: Option<String>,
    estimated_input_tokens: usize,
    token_counter: &'static str,
    summary_tokens: usize,
    text_chars: usize,
    reasoning_chars: usize,
    finish_reason: Option<String>,
    latency_ms: u64,
    usage: Option<Value>,
    error: Option<String>,
}

pub(super) struct SummaryAttemptTrace<'a> {
    pub path: Option<&'a PathBuf>,
    pub identity: Value,
}

/// The caller owns one queue permit and one deadline around both attempts. A
/// rewrite always reads the same complete source, never a clipped candidate.
pub(super) async fn summarize_bounded(
    provider: &dyn SummaryProvider,
    prompt: String,
    config: &RouterContextConfig,
    trace: Option<SummaryAttemptTrace<'_>>,
) -> OpenBitFunResult<SummaryResult> {
    config.validate()?;
    let budget = RouterSummaryBudget::new(config.summary_target_tokens).unwrap();
    // Models routinely overshoot their requested length. Ask for less than the
    // admission ceiling from the first call rather than paying for a rewrite
    // whenever the previous summary has already grown beyond that ceiling.
    let mut request = config.clone();
    request.summary_target_tokens = (budget.max_tokens() / 2).max(1);
    let mut attempts = Vec::new();
    let mut result = attempt(
        provider,
        prompt.clone(),
        &request,
        &budget,
        &mut attempts,
        trace.as_ref(),
    )
    .await?;
    if result.complete && !budget.accepts(&result.text) {
        // Tighten only the text instruction. Keep reasoning headroom and the
        // original input intact; shrinking max_tokens risks a truncated answer.
        let mut rewrite = request.clone();
        rewrite.summary_target_tokens = (request.summary_target_tokens / 2).max(1);
        match attempt(
            provider,
            prompt,
            &rewrite,
            &budget,
            &mut attempts,
            trace.as_ref(),
        )
        .await
        {
            Ok(rewritten) => result = rewritten,
            Err(_) => {
                result.complete = false;
                result.diagnostics.incomplete_reason = Some("summary_rewrite_failed");
            }
        }
    }
    if result.complete && !budget.accepts(&result.text) {
        result.complete = false;
        result.diagnostics.incomplete_reason = Some("summary_budget_exceeded");
    }
    result.usage = aggregate_usage(&attempts);
    result.diagnostics.summary_tokens = budget.estimate(&result.text);
    result.diagnostics.summary_budget_tokens = budget.max_tokens();
    result.diagnostics.attempts = attempts;
    Ok(result)
}

async fn attempt(
    provider: &dyn SummaryProvider,
    prompt: String,
    config: &RouterContextConfig,
    budget: &RouterSummaryBudget,
    attempts: &mut Vec<SummaryAttemptDiagnostics>,
    trace: Option<&SummaryAttemptTrace<'_>>,
) -> OpenBitFunResult<SummaryResult> {
    let input_tokens = EstimatedRouterTokens.count(&prompt);
    let started = Instant::now();
    let result = provider.summarize(prompt, config).await;
    let response = result.as_ref().ok();
    attempts.push(SummaryAttemptDiagnostics {
        model_id: response.map(|result| result.model_id.clone()),
        model_name: response.map(|result| result.model_name.clone()),
        estimated_input_tokens: input_tokens,
        token_counter: "estimated_tokens",
        summary_tokens: response.map_or(0, |result| budget.estimate(&result.text)),
        text_chars: response.map_or(0, |result| result.text.chars().count()),
        reasoning_chars: response.map_or(0, |result| result.diagnostics.reasoning_chars),
        finish_reason: response.and_then(|result| result.diagnostics.finish_reason.clone()),
        latency_ms: started.elapsed().as_millis() as u64,
        usage: response.and_then(|result| result.usage.clone()),
        error: match &result {
            Err(error) => Some(error.to_string()),
            Ok(result) if !result.complete => result.incomplete_error(),
            Ok(result) if !budget.accepts(&result.text) => {
                Some("Summary text exceeds its estimated token budget".into())
            }
            _ => None,
        },
    });
    // Publish completed attempts immediately: a later rewrite timeout/cancel
    // must not hide a completed first call or its reported usage.
    if let Some(trace) = trace {
        let mut event = trace.identity.clone();
        event["event"] = json!("router_context_summary_attempt");
        event["attempt"] = json!(attempts.len());
        event["summary_budget_tokens"] = json!(budget.max_tokens());
        event["requested_summary_budget_tokens"] = json!(config.summary_target_tokens);
        event["response"] = json!(attempts.last());
        append_trace_record(trace.path, &event);
    }
    result
}

/// Missing usage is unknown, not zero. Keep per-attempt reports and only sum
/// fields reported by every attempt; never present the final call as total cost.
fn aggregate_usage(attempts: &[SummaryAttemptDiagnostics]) -> Option<Value> {
    if attempts.len() == 1 {
        return attempts[0].usage.clone();
    }
    let usages = attempts
        .iter()
        .map(|attempt| attempt.usage.as_ref())
        .collect::<Option<Vec<_>>>()?;
    let mut total = serde_json::Map::new();
    for key in [
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "reasoningTokenCount",
        "cachedContentTokenCount",
        "cacheCreationTokenCount",
    ] {
        if let Some(counts) = usages
            .iter()
            .map(|usage| usage.get(key)?.as_u64())
            .collect::<Option<Vec<_>>>()
        {
            total.insert(
                key.into(),
                json!(counts.into_iter().fold(0u64, u64::saturating_add)),
            );
        }
    }
    (!total.is_empty()).then_some(Value::Object(total))
}
