//! Pure account selection for an immutable model request. Assembly supplies
//! current account facts, quota observations, scope and the existing attempt
//! budget. This module performs no credential, configuration or network IO.

use openbitfun_core_types::{
    errors::ErrorCategory,
    subscription::{ModelQuotaEligibility, ModelQuotaObservation},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountPolicy {
    Fixed(String),
    Ordered(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownQuotaPolicy {
    /// Eligibility is checked by the real request; no fabricated allowance.
    Probe,
    RequireKnown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteScope {
    pub execution_host: String,
    pub provider: String,
    pub model_config_id: String,
    pub policy_revision: u64,
    pub cache_lineage: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountAffinity {
    pub scope: RouteScope,
    pub account_id: String,
    pub credential_revision: u64,
}

pub struct AccountCandidate<'a> {
    pub account_id: &'a str,
    pub provider: &'a str,
    pub request_model: &'a str,
    pub credential_revision: u64,
    pub enabled: bool,
    pub connected: bool,
    pub supports_model: bool,
    pub user_limit_exhausted: bool,
    pub cooldown_until: Option<i64>,
    pub at_capacity: bool,
    pub quota: Option<ModelQuotaObservation<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountRejection {
    Missing,
    Disabled,
    AuthorizationUnavailable,
    WrongProvider,
    ModelUnavailable,
    UserLimit,
    Cooldown,
    Capacity,
    QuotaUnknown,
    QuotaExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedAccount {
    pub account_id: String,
    pub reason: AccountRejection,
    pub recovery_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionReason {
    Fixed,
    Ordered,
    Affinity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountSelection {
    Selected {
        account_id: String,
        reason: SelectionReason,
    },
    Unavailable(Vec<RejectedAccount>),
    InvalidPolicy,
}

fn reject(
    candidate: &AccountCandidate<'_>,
    scope: &RouteScope,
    unknown: UnknownQuotaPolicy,
    now: i64,
) -> Option<(AccountRejection, Option<i64>)> {
    if candidate.provider != scope.provider {
        return Some((AccountRejection::WrongProvider, None));
    }
    if !candidate.enabled {
        return Some((AccountRejection::Disabled, None));
    }
    if !candidate.connected {
        return Some((AccountRejection::AuthorizationUnavailable, None));
    }
    if !candidate.supports_model {
        return Some((AccountRejection::ModelUnavailable, None));
    }
    if candidate.user_limit_exhausted {
        return Some((AccountRejection::UserLimit, None));
    }
    if let Some(until) = candidate.cooldown_until.filter(|until| *until > now) {
        return Some((AccountRejection::Cooldown, Some(until)));
    }
    if candidate.at_capacity {
        return Some((AccountRejection::Capacity, None));
    }
    let quota = candidate.quota.filter(|quota| {
        quota.account_id == candidate.account_id
            && quota.provider == candidate.provider
            && quota.credential_revision == candidate.credential_revision
            && quota.model == candidate.request_model
            && quota.observed_at.is_some_and(|observed| observed <= now)
            && quota.valid_until.is_some_and(|deadline| deadline > now)
    });
    let Some(quota) = quota else {
        return (unknown == UnknownQuotaPolicy::RequireKnown)
            .then_some((AccountRejection::QuotaUnknown, None));
    };
    match quota.eligibility {
        ModelQuotaEligibility::Attemptable => None,
        ModelQuotaEligibility::TemporarilyUnavailable {
            recovery_at: recovery,
        } => Some((AccountRejection::QuotaExhausted, recovery)),
        ModelQuotaEligibility::Unknown => (unknown == UnknownQuotaPolicy::RequireKnown)
            .then_some((AccountRejection::QuotaUnknown, None)),
    }
}

/// Selects only from the immutable declared members. New accounts appearing in
/// live facts cannot enlarge the request's authorized account set.
pub fn select_account(
    policy: &AccountPolicy,
    scope: &RouteScope,
    candidates: &[AccountCandidate<'_>],
    affinity: Option<&AccountAffinity>,
    unknown: UnknownQuotaPolicy,
    now: i64,
) -> AccountSelection {
    let members: Vec<&str> = match policy {
        AccountPolicy::Fixed(id) => vec![id.as_str()],
        AccountPolicy::Ordered(ids) => ids.iter().map(String::as_str).collect(),
    };
    let mut unique = std::collections::HashSet::new();
    if members.is_empty()
        || members
            .iter()
            .any(|id| id.is_empty() || !unique.insert(*id))
    {
        return AccountSelection::InvalidPolicy;
    }
    let mut available = Vec::new();
    let mut rejected = Vec::new();
    for id in members {
        let mut matching = candidates
            .iter()
            .filter(|candidate| candidate.account_id == id);
        let candidate = matching.next();
        if matching.next().is_some() {
            return AccountSelection::InvalidPolicy;
        }
        match candidate {
            None => rejected.push(RejectedAccount {
                account_id: id.into(),
                reason: AccountRejection::Missing,
                recovery_at: None,
            }),
            Some(candidate) => match reject(candidate, scope, unknown, now) {
                Some((reason, recovery_at)) => rejected.push(RejectedAccount {
                    account_id: id.into(),
                    reason,
                    recovery_at,
                }),
                None => available.push(candidate),
            },
        }
    }
    if matches!(policy, AccountPolicy::Ordered(_)) {
        if let Some(account) =
            affinity
                .filter(|binding| binding.scope == *scope)
                .and_then(|binding| {
                    available.iter().find(|candidate| {
                        candidate.account_id == binding.account_id
                            && candidate.credential_revision == binding.credential_revision
                    })
                })
        {
            return AccountSelection::Selected {
                account_id: account.account_id.into(),
                reason: SelectionReason::Affinity,
            };
        }
    }
    match available.first() {
        Some(account) => AccountSelection::Selected {
            account_id: account.account_id.into(),
            reason: match policy {
                AccountPolicy::Fixed(_) => SelectionReason::Fixed,
                AccountPolicy::Ordered(_) => SelectionReason::Ordered,
            },
        },
        None => AccountSelection::Unavailable(rejected),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchRejection {
    FixedAccount,
    Cancelled,
    AttemptBudget,
    EffectiveOutput,
    ToolSideEffect,
    IncompatibleReplay,
    AuthenticationRecoveryPending,
    DeterministicFailure,
    UnclassifiedFailure,
}

pub struct SwitchBoundary {
    pub cancelled: bool,
    pub remaining_attempts: usize,
    pub effective_output: bool,
    pub tool_side_effect_committed: bool,
    pub replay_compatible: bool,
    pub authentication_recovery_exhausted: bool,
}

/// Uses the caller's existing model-round budget; no nested retry loop or new
/// hard limit. Admission does not execute, sleep, refresh or change an account.
pub fn admit_account_switch(
    policy: &AccountPolicy,
    category: &ErrorCategory,
    boundary: &SwitchBoundary,
) -> Result<(), SwitchRejection> {
    if matches!(policy, AccountPolicy::Fixed(_)) {
        return Err(SwitchRejection::FixedAccount);
    }
    if boundary.cancelled {
        return Err(SwitchRejection::Cancelled);
    }
    if boundary.remaining_attempts == 0 {
        return Err(SwitchRejection::AttemptBudget);
    }
    if boundary.effective_output {
        return Err(SwitchRejection::EffectiveOutput);
    }
    if boundary.tool_side_effect_committed {
        return Err(SwitchRejection::ToolSideEffect);
    }
    if !boundary.replay_compatible {
        return Err(SwitchRejection::IncompatibleReplay);
    }
    match category {
        ErrorCategory::Auth if !boundary.authentication_recovery_exhausted => {
            Err(SwitchRejection::AuthenticationRecoveryPending)
        }
        ErrorCategory::Auth
        | ErrorCategory::ProviderQuota
        | ErrorCategory::ProviderBilling
        | ErrorCategory::RateLimit
        | ErrorCategory::Network
        | ErrorCategory::Timeout
        | ErrorCategory::ProviderUnavailable => Ok(()),
        ErrorCategory::ContextOverflow
        | ErrorCategory::Permission
        | ErrorCategory::InvalidRequest
        | ErrorCategory::ContentPolicy => Err(SwitchRejection::DeterministicFailure),
        ErrorCategory::ModelError | ErrorCategory::Unknown => {
            Err(SwitchRejection::UnclassifiedFailure)
        }
    }
}

/// Exhausted allowance without a provider reset hint. Retry backoff (seconds)
/// would send the next turn straight back to the same spent account.
pub const QUOTA_COOLDOWN_WITHOUT_HINT_MS: u64 = 15 * 60 * 1000;
/// Billing/plan failures need user action; probe again only occasionally.
pub const BILLING_COOLDOWN_WITHOUT_HINT_MS: u64 = 30 * 60 * 1000;

/// A structured failure observation, independent of retry/switch admission.
/// Cancellation and deterministic input/auth failures never poison health.
/// Assembly supplies its existing backoff; a provider hint is not shortened
/// to the model loop's per-sleep cap. Allowance failures without a hint use
/// their own floor instead of retry backoff. Expiry permits a probe, not fake
/// recovery.
pub fn cooldown_deadline(
    category: &ErrorCategory,
    now: i64,
    retry_after_ms: Option<u64>,
    fallback_delay_ms: u64,
) -> Option<i64> {
    if !matches!(
        category,
        ErrorCategory::ProviderQuota
            | ErrorCategory::ProviderBilling
            | ErrorCategory::RateLimit
            | ErrorCategory::Network
            | ErrorCategory::Timeout
            | ErrorCategory::ProviderUnavailable
    ) {
        return None;
    }
    let fallback_delay_ms = match category {
        ErrorCategory::ProviderQuota => fallback_delay_ms.max(QUOTA_COOLDOWN_WITHOUT_HINT_MS),
        ErrorCategory::ProviderBilling => fallback_delay_ms.max(BILLING_COOLDOWN_WITHOUT_HINT_MS),
        _ => fallback_delay_ms,
    };
    let delay = retry_after_ms
        .filter(|hint| *hint > 0)
        .unwrap_or(fallback_delay_ms);
    let seconds = i64::try_from(delay.div_ceil(1000)).ok()?;
    (seconds > 0).then(|| now.checked_add(seconds)).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_uses_structured_deadlines_and_does_not_mark_deterministic_failures() {
        assert_eq!(
            cooldown_deadline(&ErrorCategory::RateLimit, 100, Some(120_001), 2_000),
            Some(221)
        );
        assert_eq!(
            cooldown_deadline(&ErrorCategory::Network, 100, None, 500),
            Some(101)
        );
        assert_eq!(
            cooldown_deadline(&ErrorCategory::ProviderQuota, 100, Some(0), 500),
            Some(100 + 15 * 60)
        );
        assert_eq!(
            cooldown_deadline(&ErrorCategory::ProviderQuota, 100, Some(7_200_000), 500),
            Some(100 + 7_200)
        );
        assert_eq!(
            cooldown_deadline(&ErrorCategory::ProviderBilling, 100, None, 500),
            Some(100 + 30 * 60)
        );
        assert_eq!(
            cooldown_deadline(&ErrorCategory::Timeout, i64::MAX, None, 500),
            None
        );
        for category in [
            ErrorCategory::Auth,
            ErrorCategory::InvalidRequest,
            ErrorCategory::Permission,
            ErrorCategory::ContextOverflow,
            ErrorCategory::ContentPolicy,
            ErrorCategory::Unknown,
            ErrorCategory::ModelError,
        ] {
            assert_eq!(cooldown_deadline(&category, 100, Some(9999), 500), None);
        }
    }
    fn scope() -> RouteScope {
        RouteScope {
            execution_host: "host-one".into(),
            provider: "codex".into(),
            model_config_id: "model-one".into(),
            policy_revision: 1,
            cache_lineage: "conversation-one".into(),
        }
    }
    fn candidate(id: &str) -> AccountCandidate<'_> {
        AccountCandidate {
            account_id: id,
            provider: "codex",
            request_model: "test-model",
            credential_revision: 3,
            enabled: true,
            connected: true,
            supports_model: true,
            user_limit_exhausted: false,
            cooldown_until: None,
            at_capacity: false,
            quota: None,
        }
    }
    fn pool() -> AccountPolicy {
        AccountPolicy::Ordered(vec!["primary".into(), "backup".into()])
    }
    fn quota() -> ModelQuotaObservation<'static> {
        ModelQuotaObservation {
            account_id: "primary",
            provider: "codex",
            model: "test-model",
            credential_revision: 3,
            observed_at: Some(1000),
            valid_until: Some(1060),
            eligibility: ModelQuotaEligibility::TemporarilyUnavailable { recovery_at: None },
        }
    }

    fn boundary() -> SwitchBoundary {
        SwitchBoundary {
            cancelled: false,
            remaining_attempts: 1,
            effective_output: false,
            tool_side_effect_committed: false,
            replay_compatible: true,
            authentication_recovery_exhausted: false,
        }
    }

    #[test]
    fn exhausted_primary_selects_backup_but_fixed_never_falls_back() {
        let quota = quota();
        let mut primary = candidate("primary");
        primary.quota = Some(quota);
        let facts = [primary, candidate("backup"), candidate("undeclared")];
        assert_eq!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Selected {
                account_id: "backup".into(),
                reason: SelectionReason::Ordered
            }
        );
        assert_eq!(
            select_account(
                &AccountPolicy::Fixed("primary".into()),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Unavailable(vec![RejectedAccount {
                account_id: "primary".into(),
                reason: AccountRejection::QuotaExhausted,
                recovery_at: None
            }])
        );
        assert!(matches!(
            select_account(
                &AccountPolicy::Fixed("missing".into()),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Unavailable(_)
        ));
    }

    #[test]
    fn stale_or_foreign_observations_follow_explicit_unknown_policy() {
        for alteration in 0..6 {
            let quota = match alteration {
                0 => {
                    let mut quota = quota();
                    quota.valid_until = Some(1000);
                    quota
                }
                1 => ModelQuotaObservation {
                    credential_revision: 2,
                    ..quota()
                },
                2 => ModelQuotaObservation {
                    account_id: "other",
                    ..quota()
                },
                3 => ModelQuotaObservation {
                    observed_at: Some(2000),
                    ..quota()
                },
                4 => ModelQuotaObservation {
                    model: "another-model",
                    ..quota()
                },
                _ => ModelQuotaObservation {
                    provider: "another-provider",
                    ..quota()
                },
            };
            let mut primary = candidate("primary");
            primary.quota = Some(quota);
            let facts = [primary];
            let fixed = AccountPolicy::Fixed("primary".into());
            assert!(matches!(
                select_account(
                    &fixed,
                    &scope(),
                    &facts,
                    None,
                    UnknownQuotaPolicy::Probe,
                    1001
                ),
                AccountSelection::Selected { .. }
            ));
            assert!(matches!(
                select_account(
                    &fixed,
                    &scope(),
                    &facts,
                    None,
                    UnknownQuotaPolicy::RequireKnown,
                    1001
                ),
                AccountSelection::Unavailable(_)
            ));
        }
    }

    #[test]
    fn affinity_is_scoped_to_host_model_policy_lineage_and_authorization() {
        let facts = [candidate("primary"), candidate("backup")];
        let mut binding = AccountAffinity {
            scope: scope(),
            account_id: "backup".into(),
            credential_revision: 3,
        };
        assert_eq!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                Some(&binding),
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Selected {
                account_id: "backup".into(),
                reason: SelectionReason::Affinity
            }
        );
        for field in 0..5 {
            binding.scope = scope();
            binding.credential_revision = 3;
            match field {
                0 => binding.scope.execution_host = "other".into(),
                1 => binding.scope.model_config_id = "other".into(),
                2 => binding.scope.policy_revision += 1,
                3 => binding.scope.cache_lineage = "other".into(),
                _ => binding.credential_revision += 1,
            };
            assert_eq!(
                select_account(
                    &pool(),
                    &scope(),
                    &facts,
                    Some(&binding),
                    UnknownQuotaPolicy::Probe,
                    1001
                ),
                AccountSelection::Selected {
                    account_id: "primary".into(),
                    reason: SelectionReason::Ordered
                }
            );
        }
    }

    #[test]
    fn live_revocation_capacity_and_cooldown_override_order_and_affinity() {
        let mut first = candidate("primary");
        first.enabled = false;
        let mut second = candidate("backup");
        second.cooldown_until = Some(1020);
        let facts = [first, second];
        assert_eq!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Unavailable(vec![
                RejectedAccount {
                    account_id: "primary".into(),
                    reason: AccountRejection::Disabled,
                    recovery_at: None
                },
                RejectedAccount {
                    account_id: "backup".into(),
                    reason: AccountRejection::Cooldown,
                    recovery_at: Some(1020)
                },
            ])
        );
        assert_eq!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1020
            ),
            AccountSelection::Selected {
                account_id: "backup".into(),
                reason: SelectionReason::Ordered
            }
        );
        assert_eq!(
            select_account(
                &AccountPolicy::Ordered(vec!["primary".into(), "primary".into()]),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::InvalidPolicy
        );
    }

    #[test]
    fn all_eligibility_facts_are_checked_before_selecting_a_candidate() {
        for (field, reason) in [
            (0, AccountRejection::AuthorizationUnavailable),
            (1, AccountRejection::WrongProvider),
            (2, AccountRejection::ModelUnavailable),
            (3, AccountRejection::UserLimit),
            (4, AccountRejection::Capacity),
        ] {
            let mut candidate = candidate("primary");
            match field {
                0 => candidate.connected = false,
                1 => candidate.provider = "other",
                2 => candidate.supports_model = false,
                3 => candidate.user_limit_exhausted = true,
                _ => candidate.at_capacity = true,
            };
            assert_eq!(
                select_account(
                    &AccountPolicy::Fixed("primary".into()),
                    &scope(),
                    &[candidate],
                    None,
                    UnknownQuotaPolicy::Probe,
                    1001
                ),
                AccountSelection::Unavailable(vec![RejectedAccount {
                    account_id: "primary".into(),
                    reason,
                    recovery_at: None
                }])
            );
        }
        assert_eq!(
            select_account(
                &AccountPolicy::Ordered(vec![]),
                &scope(),
                &[],
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::InvalidPolicy
        );
    }

    #[test]
    fn switching_obeys_budget_output_tools_replay_and_failure_category() {
        for category in [
            ErrorCategory::ProviderQuota,
            ErrorCategory::RateLimit,
            ErrorCategory::Network,
            ErrorCategory::Timeout,
            ErrorCategory::ProviderUnavailable,
        ] {
            assert_eq!(
                admit_account_switch(&pool(), &category, &boundary()),
                Ok(())
            );
        }
        for category in [
            ErrorCategory::Permission,
            ErrorCategory::InvalidRequest,
            ErrorCategory::ContentPolicy,
            ErrorCategory::ContextOverflow,
        ] {
            assert_eq!(
                admit_account_switch(&pool(), &category, &boundary()),
                Err(SwitchRejection::DeterministicFailure)
            );
        }
        assert_eq!(
            admit_account_switch(&pool(), &ErrorCategory::Auth, &boundary()),
            Err(SwitchRejection::AuthenticationRecoveryPending)
        );
        for (field, expected) in [
            (0, SwitchRejection::Cancelled),
            (1, SwitchRejection::AttemptBudget),
            (2, SwitchRejection::EffectiveOutput),
            (3, SwitchRejection::ToolSideEffect),
            (4, SwitchRejection::IncompatibleReplay),
        ] {
            let mut boundary = boundary();
            match field {
                0 => boundary.cancelled = true,
                1 => boundary.remaining_attempts = 0,
                2 => boundary.effective_output = true,
                3 => boundary.tool_side_effect_committed = true,
                _ => boundary.replay_compatible = false,
            };
            assert_eq!(
                admit_account_switch(&pool(), &ErrorCategory::ProviderQuota, &boundary),
                Err(expected)
            );
        }
    }

    #[test]
    fn newly_discovered_accounts_cannot_enlarge_an_immutable_pool() {
        let mut primary = candidate("primary");
        primary.connected = false;
        let mut backup = candidate("backup");
        backup.at_capacity = true;
        let facts = [primary, backup, candidate("newly-discovered")];
        assert!(matches!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                None,
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Unavailable(_)
        ));
        let binding = AccountAffinity {
            scope: scope(),
            account_id: "newly-discovered".into(),
            credential_revision: 3,
        };
        assert!(matches!(
            select_account(
                &pool(),
                &scope(),
                &facts,
                Some(&binding),
                UnknownQuotaPolicy::Probe,
                1001
            ),
            AccountSelection::Unavailable(_)
        ));
    }
}
