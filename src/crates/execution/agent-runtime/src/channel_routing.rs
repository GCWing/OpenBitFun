//! Pure cross-channel failover admission. The caller supplies the existing
//! round budget and replay/output facts; this policy starts no retry loop.
use openbitfun_core_types::errors::ErrorCategory;

pub fn may_switch_channel(
    category: &ErrorCategory,
    remaining_attempts: usize,
    effective_output: bool,
    opaque_replay: bool,
    cancelled: bool,
) -> bool {
    remaining_attempts > 0
        && !effective_output
        && !opaque_replay
        && !cancelled
        && matches!(
            category,
            ErrorCategory::Auth
                | ErrorCategory::ProviderQuota
                | ErrorCategory::ProviderBilling
                | ErrorCategory::RateLimit
                | ErrorCategory::Network
                | ErrorCategory::Timeout
                | ErrorCategory::ProviderUnavailable
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_budget_output_history_and_deterministic_errors_bound_failover() {
        for category in [
            ErrorCategory::Auth,
            ErrorCategory::ProviderQuota,
            ErrorCategory::ProviderBilling,
            ErrorCategory::RateLimit,
            ErrorCategory::Network,
            ErrorCategory::Timeout,
            ErrorCategory::ProviderUnavailable,
        ] {
            assert!(may_switch_channel(&category, 1, false, false, false));
            for (budget, output, replay, cancelled) in [
                (0, false, false, false),
                (1, true, false, false),
                (1, false, true, false),
                (1, false, false, true),
            ] {
                assert!(!may_switch_channel(
                    &category, budget, output, replay, cancelled
                ));
            }
        }
        for category in [
            ErrorCategory::Permission,
            ErrorCategory::InvalidRequest,
            ErrorCategory::ContentPolicy,
            ErrorCategory::ContextOverflow,
            ErrorCategory::Unknown,
        ] {
            assert!(!may_switch_channel(&category, 1, false, false, false));
        }
    }
}
