use serde::{Deserialize, Serialize};

/// Optional tool failure classification, preserved across events and history.
/// Open strings allow older consumers to retain unfamiliar codes and kinds.
/// This describes the failure; it does not authorize automatic retries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolErrorDetail {
    pub code: String,
    pub kind: String,
}

/// Error category for classifying dialog turn failures.
/// Used by the frontend to show user-friendly error messages without string matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    /// Network interruption, SSE stream closed, connection reset
    Network,
    /// API authentication failure, invalid/expired key
    Auth,
    /// Rate limit exceeded
    RateLimit,
    /// Conversation exceeds model context window
    ContextOverflow,
    /// Model response timed out
    Timeout,
    /// Provider/account quota, balance, or resource package is exhausted
    ProviderQuota,
    /// Provider billing plan, subscription, or package is invalid or expired
    ProviderBilling,
    /// Provider service is overloaded or temporarily unavailable
    ProviderUnavailable,
    /// API key is valid but does not have access to the requested resource
    Permission,
    /// Request format, parameters, model name, or payload size is invalid
    InvalidRequest,
    /// Provider policy or content safety system blocked the request
    ContentPolicy,
    /// Model returned an error
    ModelError,
    /// Unclassified error
    Unknown,
}

/// Structured AI error details for user-facing recovery and diagnostics.
///
/// Keep this shape provider-agnostic: stable categories drive UI behavior while
/// provider-specific codes/messages remain optional metadata for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorDetail {
    pub category: ErrorCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub action_hints: Vec<String>,
}

/// Provider failure normalized before it crosses adapter/runtime boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderError {
    pub message: String,
    pub category: ErrorCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Provider-requested delay before another attempt, in milliseconds.
    ///
    /// This is transport metadata only. Runtime owners decide whether to retry;
    /// the hint must never be used as retry-admission policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl AiProviderError {
    pub fn from_parts(
        message: String,
        provider: Option<String>,
        provider_code: Option<String>,
        http_status: Option<u16>,
    ) -> Self {
        let category = classify_ai_error_parts(&message, provider_code.as_deref(), http_status);
        Self {
            message,
            category,
            provider,
            provider_code,
            http_status,
            retry_after_ms: None,
        }
    }

    pub fn classified(message: String, category: ErrorCategory) -> Self {
        Self {
            message,
            category,
            provider: None,
            provider_code: None,
            http_status: None,
            retry_after_ms: None,
        }
    }

    pub fn with_retry_after_ms(mut self, retry_after_ms: Option<u64>) -> Self {
        self.retry_after_ms = retry_after_ms;
        self
    }

    pub fn detail(&self) -> AiErrorDetail {
        AiErrorDetail {
            category: self.category.clone(),
            provider: self.provider.clone(),
            provider_code: self.provider_code.clone(),
            provider_message: Some(self.message.clone()),
            request_id: extract_error_field(&self.message, "request_id"),
            http_status: self.http_status,
            retryable: Some(is_retryable_category(&self.category)),
            action_hints: action_hints_for_category(&self.category),
        }
    }
}

impl std::fmt::Display for AiProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AiProviderError {}

/// Prefer structured provider facts over text. Text classification remains a
/// fallback for providers that expose only opaque error strings.
pub fn classify_ai_error_parts(
    message: &str,
    provider_code: Option<&str>,
    http_status: Option<u16>,
) -> ErrorCategory {
    match http_status {
        Some(401) => return ErrorCategory::Auth,
        Some(402) => return ErrorCategory::ProviderQuota,
        Some(403) => return ErrorCategory::Permission,
        Some(429) => return ErrorCategory::RateLimit,
        Some(500..=599) => return ErrorCategory::ProviderUnavailable,
        _ => {}
    }

    let code = provider_code
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(
        code.as_str(),
        "context_length_exceeded" | "model_context_window_exceeded" | "context_window_exceeded"
    ) {
        return ErrorCategory::ContextOverflow;
    }
    match code.as_str() {
        "insufficient_quota" | "quota_exceeded" => return ErrorCategory::ProviderQuota,
        "rate_limit_exceeded" | "throttling_error" => return ErrorCategory::RateLimit,
        "overloaded_error" | "server_is_overloaded" | "server_error" => {
            return ErrorCategory::ProviderUnavailable;
        }
        "authentication_error" | "invalid_api_key" => return ErrorCategory::Auth,
        "permission_error" => return ErrorCategory::Permission,
        "content_filter" | "safety" => return ErrorCategory::ContentPolicy,
        _ => {}
    }

    let category = classify_ai_error_message(message);
    if category != ErrorCategory::ModelError {
        return category;
    }

    if matches!(code.as_str(), "invalid_request_error" | "invalid_prompt") {
        return ErrorCategory::InvalidRequest;
    }

    if matches!(http_status, Some(400 | 404 | 409 | 413 | 422)) {
        ErrorCategory::InvalidRequest
    } else {
        category
    }
}

/// Classify an AI client error message into a structured category.
pub fn classify_ai_error_message(msg: &str) -> ErrorCategory {
    let m = msg.to_lowercase();
    if contains_any(
        &m,
        &[
            "code=1113",
            "\"code\":\"1113\"",
            "insufficient_quota",
            "insufficient quota",
            "insufficient balance",
            "not_enough_balance",
            "not enough balance",
            "exceeded_current_quota_error",
            "exceeded current quota",
            "you exceeded your current quota",
            "no available resource package",
            "无可用资源包",
            "余额不足",
            "账户已欠费",
            "account has exceeded",
            "http 402",
            "error 402",
            "402 - insufficient balance",
        ],
    ) {
        ErrorCategory::ProviderQuota
    } else if contains_any(
        &m,
        &[
            "billing",
            "membership expired",
            "subscription expired",
            "plan expired",
            "套餐已到期",
        ],
    ) || contains_provider_code(&m, "1309")
    {
        ErrorCategory::ProviderBilling
    } else if contains_any(
        &m,
        &[
            "overloaded_error",
            "server overloaded",
            "temporarily overloaded",
            "provider unavailable",
            "service unavailable",
            "http 503",
            "error 503",
            "http 529",
            "error 529",
        ],
    ) || contains_provider_code(&m, "1305")
    {
        ErrorCategory::ProviderUnavailable
    } else if contains_any(
        &m,
        &[
            "content policy",
            "policy blocked",
            "safety",
            "sensitive",
            "content_filter",
            "api 调用被策略阻止",
        ],
    ) || contains_provider_code(&m, "1301")
    {
        ErrorCategory::ContentPolicy
    } else if m.contains("rate limit")
        || contains_http_status(&m, 429)
        || m.contains("too many requests")
        || contains_provider_code(&m, "1302")
        || m.contains("concurrency")
        || m.contains("请求并发超额")
    {
        ErrorCategory::RateLimit
    } else if m.contains("authentication")
        || contains_http_status(&m, 401)
        || m.contains("invalid api key")
        || m.contains("incorrect api key")
        || m.contains("unauthorized")
        || contains_provider_code(&m, "1000")
        || contains_provider_code(&m, "1002")
    {
        ErrorCategory::Auth
    } else if contains_any(
        &m,
        &[
            "permission_error",
            "permission denied",
            "forbidden",
            "not authorized",
            "no permission",
            "无权访问",
        ],
    ) || contains_provider_code(&m, "1220")
    {
        ErrorCategory::Permission
    } else if is_context_overflow_message(&m) {
        ErrorCategory::ContextOverflow
    } else if contains_any(
        &m,
        &[
            "invalid_request_error",
            "invalid request",
            "bad request",
            "invalid format",
            "invalid parameter",
            "model not found",
            "unsupported model",
            "request too large",
            "http 400",
            "error 400",
            "http 413",
            "error 413",
            "http 422",
            "error 422",
        ],
    ) || contains_provider_code(&m, "1210")
        || contains_provider_code(&m, "1211")
        || contains_provider_code(&m, "435")
    {
        ErrorCategory::InvalidRequest
    } else if m.contains("timeout") || m.contains("timed out") {
        ErrorCategory::Timeout
    } else if m.contains("stream closed")
        || m.contains("sse error")
        || m.contains("connection reset")
        || m.contains("broken pipe")
    {
        ErrorCategory::Network
    } else {
        ErrorCategory::ModelError
    }
}

/// Build a structured, provider-agnostic AI error detail for UI recovery.
pub fn ai_error_detail_from_message(message: &str, category: ErrorCategory) -> AiErrorDetail {
    AiErrorDetail {
        category: category.clone(),
        provider: extract_error_field(message, "provider"),
        provider_code: extract_error_field(message, "code"),
        provider_message: extract_error_field(message, "message"),
        request_id: extract_error_field(message, "request_id"),
        http_status: extract_http_status(message),
        retryable: Some(is_retryable_category(&category)),
        action_hints: action_hints_for_category(&category),
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn contains_provider_code(message: &str, code: &str) -> bool {
    if message.trim() == code {
        return true;
    }
    [
        format!("code={code}"),
        format!("code: {code}"),
        format!("\"code\":\"{code}"),
        format!("\"code\":{code}"),
    ]
    .iter()
    .any(|marker| contains_numeric_marker(message, marker))
}

fn contains_http_status(message: &str, status: u16) -> bool {
    let status = status.to_string();
    message.trim_start().starts_with(&format!("{status} "))
        || [
            format!("http {status}"),
            format!("error {status}"),
            format!("status {status}"),
            format!("{status} status code"),
        ]
        .iter()
        .any(|marker| contains_numeric_marker(message, marker))
}

fn contains_numeric_marker(message: &str, marker: &str) -> bool {
    message.match_indices(marker).any(|(start, _)| {
        message[start + marker.len()..]
            .chars()
            .next()
            .is_none_or(|character| !character.is_ascii_digit())
    })
}

fn is_context_overflow_message(message: &str) -> bool {
    if contains_any(
        message,
        &[
            "finish_reason=max_tokens",
            "max_output_tokens",
            "maximum output token",
            "output token limit",
            "completion token limit",
            "response truncated by model",
        ],
    ) {
        return false;
    }

    contains_any(
        message,
        &[
            "context_length_exceeded",
            "model_context_window_exceeded",
            "context window exceeded",
            "context window exceeds limit",
            "context length exceeded",
            "context length is only",
            "maximum context length",
            "maximum prompt length is",
            "maximum allowed input length",
            "exceeds the context window",
            "exceeds the available context size",
            "greater than the context length",
            "prompt is too long",
            "prompt too long; exceeded",
            "request_too_large",
            "input is too long for requested model",
            "tokens in request more than max tokens allowed",
            "reduce the length of the messages",
            "request entity too large",
        ],
    ) || ((message.contains("input") || message.contains("prompt"))
        && message.contains("token")
        && contains_any(message, &["exceed", "too long", "maximum", "limit"]))
        || (message.contains("input length") && message.contains("context length"))
        || (message.contains("prompt has") && message.contains("configured context size"))
}

fn is_retryable_category(category: &ErrorCategory) -> bool {
    matches!(
        category,
        ErrorCategory::Network
            | ErrorCategory::RateLimit
            | ErrorCategory::Timeout
            | ErrorCategory::ProviderUnavailable
    )
}

fn action_hints_for_category(category: &ErrorCategory) -> Vec<String> {
    let hints: &[&str] = match category {
        ErrorCategory::ProviderQuota | ErrorCategory::ProviderBilling => {
            &["open_model_settings", "switch_model", "copy_diagnostics"]
        }
        ErrorCategory::Auth | ErrorCategory::Permission => {
            &["open_model_settings", "copy_diagnostics"]
        }
        ErrorCategory::RateLimit | ErrorCategory::ProviderUnavailable => {
            &["wait_and_retry", "switch_model", "copy_diagnostics"]
        }
        ErrorCategory::ContextOverflow => &["compress_context", "start_new_chat"],
        ErrorCategory::Network | ErrorCategory::Timeout => {
            &["retry", "switch_model", "copy_diagnostics"]
        }
        ErrorCategory::ContentPolicy | ErrorCategory::InvalidRequest => &["copy_diagnostics"],
        ErrorCategory::ModelError | ErrorCategory::Unknown => {
            &["retry", "switch_model", "copy_diagnostics"]
        }
    };

    hints.iter().map(|hint| (*hint).to_string()).collect()
}

fn extract_error_field(message: &str, field: &str) -> Option<String> {
    let key = format!("{field}=");
    if let Some(start) = message.find(&key) {
        let value_start = start + key.len();
        let value = message[value_start..]
            .split([',', ';'])
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    let json_key = format!("\"{field}\"");
    if let Some(start) = message.find(&json_key) {
        let after_key = &message[start + json_key.len()..];
        if let Some(colon_pos) = after_key.find(':') {
            let after_colon = after_key[colon_pos + 1..].trim_start();
            let value = after_colon
                .trim_start_matches('"')
                .split(['"', ',', '}'])
                .next()
                .unwrap_or_default()
                .trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

fn extract_http_status(message: &str) -> Option<u16> {
    let m = message.to_lowercase();
    for marker in ["http ", "error ", "status "] {
        if let Some(start) = m.find(marker) {
            let digits = m[start + marker.len()..]
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>();
            if let Ok(status) = digits.parse::<u16>() {
                return Some(status);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        ai_error_detail_from_message, classify_ai_error_message, classify_ai_error_parts,
        AiProviderError, ErrorCategory,
    };

    #[test]
    fn classifies_quota_and_provider_unavailable_errors() {
        assert_eq!(
            classify_ai_error_message("Provider error: provider=glm, code=1113, message=余额不足"),
            ErrorCategory::ProviderQuota
        );
        assert_eq!(
            classify_ai_error_message(
                "DeepSeek API error 402 - Insufficient Balance: You have run out of balance"
            ),
            ErrorCategory::ProviderQuota
        );
        assert_eq!(
            classify_ai_error_message(
                "Anthropic API error 529: overloaded_error: Anthropic API is temporarily overloaded"
            ),
            ErrorCategory::ProviderUnavailable
        );
    }

    #[test]
    fn builds_ai_error_detail_from_provider_metadata() {
        let detail = ai_error_detail_from_message(
            r#"AI client error: provider=openai, code=rate_limit_exceeded, message="Too many requests", request_id=req_123, http 429"#,
            ErrorCategory::RateLimit,
        );

        assert_eq!(detail.category, ErrorCategory::RateLimit);
        assert_eq!(detail.provider.as_deref(), Some("openai"));
        assert_eq!(detail.provider_code.as_deref(), Some("rate_limit_exceeded"));
        assert_eq!(
            detail.provider_message.as_deref(),
            Some("Too many requests")
        );
        assert_eq!(detail.request_id.as_deref(), Some("req_123"));
        assert_eq!(detail.http_status, Some(429));
        assert_eq!(detail.retryable, Some(true));
        assert_eq!(
            detail.action_hints,
            vec!["wait_and_retry", "switch_model", "copy_diagnostics"]
        );
    }

    #[test]
    fn distinguishes_input_context_overflow_from_output_token_limits() {
        assert_eq!(
            classify_ai_error_message(
                "context_length_exceeded: maximum context length is 200000 tokens"
            ),
            ErrorCategory::ContextOverflow
        );
        assert_eq!(
            classify_ai_error_message(
                "The input token count exceeds the maximum number of tokens allowed"
            ),
            ErrorCategory::ContextOverflow
        );
        assert_eq!(
            classify_ai_error_message(
                "response truncated by model output token limit (finish_reason=max_tokens)"
            ),
            ErrorCategory::ModelError
        );
    }

    #[test]
    fn classifies_common_provider_context_overflow_messages() {
        for message in [
            "request_too_large",
            "Input is too long for requested model",
            "tokens in request more than max tokens allowed",
            "Please reduce the length of the messages or completion",
            "request entity too large",
            "model_context_window_exceeded",
            "context window exceeds limit",
            "maximum prompt length is 200000",
            "input length 210000 exceeds context length 200000",
            "prompt has 210,000 tokens, but the configured context size is 200,000 tokens",
        ] {
            assert_eq!(
                classify_ai_error_message(message),
                ErrorCategory::ContextOverflow,
                "message: {message}"
            );
        }
    }

    #[test]
    fn structured_status_and_code_take_precedence_over_ambiguous_text() {
        assert_eq!(
            classify_ai_error_parts("Request failed", Some("context_length_exceeded"), Some(400)),
            ErrorCategory::ContextOverflow
        );
        assert_eq!(
            classify_ai_error_parts(
                "The prompt is too long for this model",
                Some("invalid_request_error"),
                Some(400)
            ),
            ErrorCategory::ContextOverflow
        );
        assert_eq!(
            classify_ai_error_parts("429 status code (no body)", None, Some(429)),
            ErrorCategory::RateLimit
        );
        assert_eq!(
            classify_ai_error_parts("400 status code (no body)", None, Some(400)),
            ErrorCategory::InvalidRequest
        );
        assert_eq!(
            classify_ai_error_parts("Service unavailable: token limit exceeded", None, Some(503)),
            ErrorCategory::ProviderUnavailable
        );
        assert_eq!(
            classify_ai_error_message("Processed 429000 input tokens successfully"),
            ErrorCategory::ModelError
        );
        assert_eq!(
            classify_ai_error_message("Observed status 401000 in token accounting"),
            ErrorCategory::ModelError
        );
        assert_eq!(
            classify_ai_error_message("Provider error: code=1302, message=concurrency exceeded"),
            ErrorCategory::RateLimit
        );
    }

    #[test]
    fn provider_error_preserves_structured_diagnostics() {
        let error = AiProviderError::from_parts(
            "Request failed".to_string(),
            Some("openai".to_string()),
            Some("context_length_exceeded".to_string()),
            Some(400),
        );

        assert_eq!(error.category, ErrorCategory::ContextOverflow);
        assert_eq!(error.retry_after_ms, None);
        let detail = error.detail();
        assert_eq!(detail.provider.as_deref(), Some("openai"));
        assert_eq!(
            detail.provider_code.as_deref(),
            Some("context_length_exceeded")
        );
        assert_eq!(detail.http_status, Some(400));
    }

    #[test]
    fn provider_error_preserves_retry_after_hint() {
        let error = AiProviderError::from_parts(
            "Request failed".to_string(),
            Some("openai".to_string()),
            Some("permission_denied".to_string()),
            Some(403),
        )
        .with_retry_after_ms(Some(1_500));

        assert_eq!(error.retry_after_ms, Some(1_500));
        assert_eq!(
            serde_json::to_value(&error).expect("serialize provider error")["retryAfterMs"],
            1_500
        );
    }
}
