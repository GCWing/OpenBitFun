//! Shared retry policy for one immutable model request. Input recovery starts a new budget.

use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};

pub const MAX_MODEL_ATTEMPTS: usize = 10;

pub fn should_retry(category: &ErrorCategory) -> bool {
    match category {
        ErrorCategory::Auth
        | ErrorCategory::Permission
        | ErrorCategory::ProviderQuota
        | ErrorCategory::ProviderBilling
        | ErrorCategory::InvalidRequest
        | ErrorCategory::ContentPolicy
        | ErrorCategory::ContextOverflow => false,
        ErrorCategory::Network
        | ErrorCategory::RateLimit
        | ErrorCategory::Timeout
        | ErrorCategory::ProviderUnavailable
        | ErrorCategory::ModelError
        | ErrorCategory::Unknown => true,
    }
}

pub fn delay_ms(attempt_index: usize, message: &str, error: Option<&AiProviderError>) -> u64 {
    let shift = attempt_index.min(6) as u32;
    let message = message.to_lowercase();
    let rate_limit = error.is_some_and(|error| error.category == ErrorCategory::RateLimit)
        || message.contains("429")
        || message.contains("rate limit")
        || message.contains("too many requests");
    let fallback = if rate_limit {
        (2_000u64 << shift).min(60_000)
    } else {
        (500u64 << shift).min(30_000)
    };
    match error.and_then(|error| error.retry_after_ms) {
        Some(hint) if rate_limit => hint.max(fallback).min(60_000),
        Some(hint) if hint > 0 => hint.min(60_000),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_rejections_and_overflow_never_enter_retry() {
        for category in [
            ErrorCategory::Auth,
            ErrorCategory::Permission,
            ErrorCategory::ProviderQuota,
            ErrorCategory::ProviderBilling,
            ErrorCategory::InvalidRequest,
            ErrorCategory::ContentPolicy,
            ErrorCategory::ContextOverflow,
        ] {
            assert!(!should_retry(&category), "{category:?}");
        }
        for category in [
            ErrorCategory::Network,
            ErrorCategory::RateLimit,
            ErrorCategory::Timeout,
            ErrorCategory::ProviderUnavailable,
            ErrorCategory::ModelError,
            ErrorCategory::Unknown,
        ] {
            assert!(should_retry(&category), "{category:?}");
        }
    }

    #[test]
    fn backoff_and_provider_hints_have_shared_caps() {
        let ordinary: Vec<_> = (0..9).map(|i| delay_ms(i, "", None)).collect();
        assert_eq!(
            ordinary,
            vec![500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
        );
        let rate: Vec<_> = (0..9).map(|i| delay_ms(i, "429", None)).collect();
        assert_eq!(
            rate,
            vec![2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]
        );
        let rate = AiProviderError::classified("slow down".into(), ErrorCategory::RateLimit)
            .with_retry_after_ms(Some(1000));
        assert_eq!(delay_ms(3, "", Some(&rate)), 16000);
        let unavailable =
            AiProviderError::classified("offline".into(), ErrorCategory::ProviderUnavailable)
                .with_retry_after_ms(Some(90000));
        assert_eq!(delay_ms(0, "", Some(&unavailable)), 60000);
        let denied = AiProviderError::classified("denied".into(), ErrorCategory::Permission)
            .with_retry_after_ms(Some(1000));
        assert!(!should_retry(&denied.category));
    }
}
