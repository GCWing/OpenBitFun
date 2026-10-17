//! Provider-neutral pool decisions. The host supplies time, persistence and IO.

use openbitfun_core_types::errors::AiProviderError;
use openbitfun_core_types::model_pool::{
    ModelPoolBinding, ModelPoolHealthStatus, ModelPoolMemberStatus, ModelPoolStrategy,
};
use openbitfun_core_types::ErrorCategory;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct Candidate {
    pub model_id: String,
    pub fingerprint: String,
    /// The host has checked configuration, capabilities and request compatibility.
    pub eligible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Health {
    #[serde(default)]
    generation: u64,
    fingerprint: String,
    status: ModelPoolHealthStatus,
    reason: Option<String>,
    retry_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Cursor {
    next_id: String,
    order: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Reservation {
    pub session_id: String,
    pub binding: ModelPoolBinding,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionError {
    UnsupportedStrategy,
    RequestInProgress,
    Unavailable { retry_at_ms: Option<u64> },
}

/// One instance belongs to one execution Runtime, shared across all its clients.
/// IO must never run while the owner's lock on this state is held.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelPoolRouter {
    bindings: BTreeMap<String, ModelPoolBinding>,
    health: BTreeMap<String, Health>,
    cursors: BTreeMap<String, Cursor>,
    generation: u64,
    #[serde(skip)]
    reservations: BTreeMap<String, Reservation>,
}

impl ModelPoolRouter {
    /// Used only on a cloned state for read-only admission previews.
    pub fn release_session_reservation(&mut self, session_id: &str) {
        self.reservations.remove(session_id);
    }

    pub fn retry_member(&mut self, model_id: &str) {
        self.generation = self.generation.saturating_add(1);
        if let Some(health) = self.health.get_mut(model_id) {
            health.generation = self.generation;
            health.status = ModelPoolHealthStatus::Unverified;
            health.reason = None;
            health.retry_at_ms = None;
        }
    }

    pub fn binding(&self, session_id: &str) -> Option<&ModelPoolBinding> {
        self.bindings.get(session_id)
    }

    pub fn restore_binding(&mut self, session_id: &str, binding: ModelPoolBinding) {
        self.generation = self.generation.max(binding.generation);
        self.bindings
            .entry(session_id.into())
            .and_modify(|existing| {
                if binding.generation > existing.generation {
                    *existing = binding.clone();
                }
            })
            .or_insert(binding);
    }

    /// Explicit user selection invalidates in-flight publication as well as affinity.
    pub fn clear_session(&mut self, session_id: &str) {
        self.bindings.remove(session_id);
        self.reservations.remove(session_id);
    }

    pub fn member_status(&self, candidate: &Candidate, now_ms: u64) -> ModelPoolMemberStatus {
        let health = self
            .health
            .get(&candidate.model_id)
            .filter(|health| health.fingerprint == candidate.fingerprint);
        let probing = self.reservations.values().any(|reservation| {
            reservation.expires_at_ms > now_ms
                && reservation.binding.model_id == candidate.model_id
                && reservation.binding.configuration_fingerprint == candidate.fingerprint
        });
        let (status, reason, retry_at_ms) = match health {
            Some(health) => {
                let status = if health.status == ModelPoolHealthStatus::CoolingDown
                    && health.retry_at_ms.is_some_and(|until| until <= now_ms)
                    && probing
                {
                    ModelPoolHealthStatus::Probing
                } else {
                    health.status.clone()
                };
                (status, health.reason.clone(), health.retry_at_ms)
            }
            None => (ModelPoolHealthStatus::Unverified, None, None),
        };
        ModelPoolMemberStatus {
            model_id: candidate.model_id.clone(),
            status,
            reason,
            retry_at_ms,
            context_budget: None,
        }
    }

    fn ready(&self, candidate: &Candidate, now_ms: u64) -> bool {
        if !candidate.eligible {
            return false;
        }
        let Some(health) = self
            .health
            .get(&candidate.model_id)
            .filter(|health| health.fingerprint == candidate.fingerprint)
        else {
            return true;
        };
        match health.status {
            ModelPoolHealthStatus::NeedsAttention => false,
            ModelPoolHealthStatus::CoolingDown => {
                health.retry_at_ms.is_some_and(|until| until <= now_ms)
                    && !self.reservations.values().any(|reservation| {
                        reservation.binding.model_id == candidate.model_id
                            && reservation.binding.configuration_fingerprint
                                == candidate.fingerprint
                            && reservation.expires_at_ms > now_ms
                    })
            }
            _ => true,
        }
    }

    /// Read-only admission for a different member; never reserves a probe or
    /// advances the balanced cursor. The actual selection revalidates readiness.
    pub fn has_available_alternative(
        &self,
        current_model_id: &str,
        candidates: &[Candidate],
        excluded: &BTreeSet<String>,
        now_ms: u64,
    ) -> bool {
        candidates.iter().any(|candidate| {
            candidate.model_id != current_model_id
                && !excluded.contains(&candidate.model_id)
                && self.ready(candidate, now_ms)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve(
        &mut self,
        session_id: &str,
        pool_id: &str,
        strategy: ModelPoolStrategy,
        candidates: &[Candidate],
        excluded: &BTreeSet<String>,
        now_ms: u64,
        lease_ms: u64,
    ) -> Result<Reservation, SelectionError> {
        self.reservations
            .retain(|_, reservation| reservation.expires_at_ms > now_ms);
        if strategy == ModelPoolStrategy::Unsupported {
            return Err(SelectionError::UnsupportedStrategy);
        }
        if self.reservations.contains_key(session_id) {
            return Err(SelectionError::RequestInProgress);
        }
        let ready = |candidate: &&Candidate| {
            !excluded.contains(&candidate.model_id) && self.ready(candidate, now_ms)
        };
        let bound = self
            .bindings
            .get(session_id)
            .filter(|binding| binding.pool_id == pool_id);
        let sticky = bound.and_then(|binding| {
            candidates.iter().filter(ready).find(|candidate| {
                candidate.model_id == binding.model_id
                    && candidate.fingerprint == binding.configuration_fingerprint
            })
        });
        let start = if strategy == ModelPoolStrategy::Balanced {
            self.cursors
                .get(pool_id)
                .and_then(|cursor| {
                    candidates
                        .iter()
                        .position(|candidate| candidate.model_id == cursor.next_id)
                        .or_else(|| {
                            // Keep the next surviving identity when a member disappears.
                            let old_start = cursor
                                .order
                                .iter()
                                .position(|id| id == &cursor.next_id)
                                .unwrap_or(0);
                            cursor
                                .order
                                .iter()
                                .cycle()
                                .skip(old_start)
                                .take(cursor.order.len())
                                .find_map(|id| {
                                    candidates
                                        .iter()
                                        .position(|candidate| &candidate.model_id == id)
                                })
                        })
                })
                .unwrap_or(0)
        } else {
            0
        };
        let selected = sticky.or_else(|| {
            candidates
                .iter()
                .cycle()
                .skip(start)
                .take(candidates.len())
                .filter(ready)
                .next()
        });
        let Some(selected) = selected else {
            return Err(SelectionError::Unavailable {
                retry_at_ms: candidates
                    .iter()
                    .filter(|candidate| candidate.eligible)
                    .filter_map(|candidate| {
                        self.health
                            .get(&candidate.model_id)
                            .filter(|health| health.fingerprint == candidate.fingerprint)
                            .and_then(|health| health.retry_at_ms)
                    })
                    .filter(|until| *until > now_ms)
                    .min(),
            });
        };
        let model_id = selected.model_id.clone();
        let fingerprint = selected.fingerprint.clone();
        if sticky.is_none() && strategy == ModelPoolStrategy::Balanced {
            let selected_index = candidates
                .iter()
                .position(|candidate| candidate.model_id == model_id)
                .unwrap_or(0);
            self.cursors.insert(
                pool_id.into(),
                Cursor {
                    next_id: candidates[(selected_index + 1) % candidates.len()]
                        .model_id
                        .clone(),
                    order: candidates
                        .iter()
                        .map(|candidate| candidate.model_id.clone())
                        .collect(),
                },
            );
        }
        self.generation = self.generation.saturating_add(1);
        let reservation = Reservation {
            session_id: session_id.into(),
            binding: ModelPoolBinding {
                pool_id: pool_id.into(),
                model_id,
                configuration_fingerprint: fingerprint,
                generation: self.generation,
            },
            expires_at_ms: now_ms.saturating_add(lease_ms.max(1)),
        };
        self.reservations
            .insert(session_id.into(), reservation.clone());
        Ok(reservation)
    }

    fn release(&mut self, reservation: &Reservation) -> bool {
        if self
            .reservations
            .get(&reservation.session_id)
            .is_some_and(|active| active.binding.generation == reservation.binding.generation)
        {
            self.reservations.remove(&reservation.session_id);
            true
        } else {
            false
        }
    }

    pub fn renew(&mut self, reservation: &Reservation, now_ms: u64, lease_ms: u64) {
        if let Some(active) = self
            .reservations
            .get_mut(&reservation.session_id)
            .filter(|active| active.binding.generation == reservation.binding.generation)
        {
            active.expires_at_ms = now_ms.saturating_add(lease_ms.max(1));
        }
    }

    pub fn cancel(&mut self, reservation: &Reservation) {
        self.release(reservation);
    }

    /// Call only once the response has reached the host's accepted-response boundary.
    pub fn accept(&mut self, reservation: &Reservation) -> bool {
        if !self.release(reservation) {
            return false;
        }
        let is_current = self
            .health
            .get(&reservation.binding.model_id)
            .is_none_or(|health| health.generation < reservation.binding.generation);
        if is_current {
            self.health.insert(
                reservation.binding.model_id.clone(),
                Health {
                    generation: reservation.binding.generation,
                    fingerprint: reservation.binding.configuration_fingerprint.clone(),
                    status: ModelPoolHealthStatus::Available,
                    reason: None,
                    retry_at_ms: None,
                },
            );
        }
        self.bindings
            .insert(reservation.session_id.clone(), reservation.binding.clone());
        true
    }

    pub fn configuration_failed(&mut self, reservation: &Reservation) {
        if !self.release(reservation) {
            return;
        }
        if self
            .health
            .get(&reservation.binding.model_id)
            .is_some_and(|health| health.generation >= reservation.binding.generation)
        {
            return;
        }
        self.health.insert(
            reservation.binding.model_id.clone(),
            Health {
                generation: reservation.binding.generation,
                fingerprint: reservation.binding.configuration_fingerprint.clone(),
                status: ModelPoolHealthStatus::NeedsAttention,
                reason: Some("configuration".into()),
                retry_at_ms: None,
            },
        );
    }

    /// The caller supplies the existing request retry policy's delay.
    /// Returns whether another compatible pool member may be attempted safely.
    pub fn fail(
        &mut self,
        reservation: &Reservation,
        error: &AiProviderError,
        now_ms: u64,
        retry_delay_ms: u64,
    ) -> bool {
        if !self.release(reservation) {
            return false;
        }
        let status = match error.category {
            ErrorCategory::Auth | ErrorCategory::Permission | ErrorCategory::ProviderBilling => {
                ModelPoolHealthStatus::NeedsAttention
            }
            ErrorCategory::Network
            | ErrorCategory::Timeout
            | ErrorCategory::RateLimit
            | ErrorCategory::ProviderQuota
            | ErrorCategory::ProviderUnavailable => ModelPoolHealthStatus::CoolingDown,
            // Exhausted response recovery may try a different member, but
            // opaque/model-output failures are not evidence of global ill health.
            ErrorCategory::ModelError | ErrorCategory::Unknown => return true,
            _ => return false,
        };
        if self
            .health
            .get(&reservation.binding.model_id)
            .is_some_and(|health| health.generation >= reservation.binding.generation)
        {
            return true; // This request may fail over without overwriting newer evidence.
        }
        let retry_at_ms = (status == ModelPoolHealthStatus::CoolingDown)
            .then(|| now_ms.saturating_add(error.retry_after_ms.unwrap_or(retry_delay_ms).max(1)));
        self.health.insert(
            reservation.binding.model_id.clone(),
            Health {
                generation: reservation.binding.generation,
                fingerprint: reservation.binding.configuration_fingerprint.clone(),
                status,
                reason: Some(
                    serde_json::to_value(&error.category)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                        .unwrap_or_default(),
                ),
                retry_at_ms,
            },
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<Candidate> {
        ["a", "b", "c"]
            .into_iter()
            .map(|id| Candidate {
                model_id: id.into(),
                fingerprint: format!("{id}-v1"),
                eligible: true,
            })
            .collect()
    }
    fn pick(
        router: &mut ModelPoolRouter,
        session: &str,
        pool: &str,
        strategy: ModelPoolStrategy,
        now: u64,
    ) -> Reservation {
        router
            .reserve(
                session,
                pool,
                strategy,
                &members(),
                &BTreeSet::new(),
                now,
                100,
            )
            .unwrap()
    }
    fn unavailable() -> AiProviderError {
        AiProviderError::classified("Unavailable".into(), ErrorCategory::ProviderUnavailable)
    }

    #[test]
    fn inherited_child_binding_wins_over_both_routing_strategies() {
        for strategy in [ModelPoolStrategy::Ordered, ModelPoolStrategy::Balanced] {
            let mut router = ModelPoolRouter::default();
            let binding = ModelPoolBinding {
                pool_id: "p".into(),
                model_id: "b".into(),
                configuration_fingerprint: "b-v1".into(),
                generation: 1,
            };
            router.restore_binding("parent", binding.clone());
            router.restore_binding("btw-child", binding);
            let child = pick(&mut router, "btw-child", "p", strategy, 0);
            assert_eq!(child.binding.model_id, "b");
            router.accept(&child);
            assert_eq!(
                pick(&mut router, "parent", "p", strategy, 0)
                    .binding
                    .model_id,
                "b"
            );
            // Inheritance must not consume the balanced cursor's next assignment.
            assert_eq!(
                pick(&mut router, "fresh", "p", strategy, 0)
                    .binding
                    .model_id,
                "a"
            );
            let next_child_attempt = pick(&mut router, "btw-child", "p", strategy, 1);
            router.configuration_failed(&next_child_attempt);
            assert_ne!(
                pick(&mut router, "btw-child", "p", strategy, 1)
                    .binding
                    .model_id,
                "b"
            );
        }
    }

    #[test]
    fn configuration_failure_skips_member_until_retry_or_configuration_change() {
        let mut router = ModelPoolRouter::default();
        let first = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 0);
        router.configuration_failed(&first);
        assert_eq!(
            router.member_status(&members()[0], 1).status,
            ModelPoolHealthStatus::NeedsAttention
        );
        let second = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 1);
        assert_eq!(second.binding.model_id, "b");
        router.cancel(&second);
        router.retry_member("a");
        assert_eq!(
            pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 2)
                .binding
                .model_id,
            "a"
        );
    }

    #[test]
    fn ordered_failure_and_recovery_preserve_affinity() {
        let mut router = ModelPoolRouter::default();
        let a = pick(&mut router, "s1", "p", ModelPoolStrategy::Ordered, 0);
        assert_eq!(a.binding.model_id, "a");
        assert!(router.fail(&a, &unavailable(), 0, 10));
        let b = pick(&mut router, "s1", "p", ModelPoolStrategy::Ordered, 1);
        assert_eq!(b.binding.model_id, "b");
        router.accept(&b);
        let sticky = pick(&mut router, "s1", "p", ModelPoolStrategy::Ordered, 20);
        assert_eq!(sticky.binding.model_id, "b");
        let new_session = pick(&mut router, "s2", "p", ModelPoolStrategy::Ordered, 20);
        assert_eq!(new_session.binding.model_id, "a");
    }

    #[test]
    fn balanced_routing_distributes_new_sessions_without_rotating_bound_sessions() {
        let mut router = ModelPoolRouter::default();
        for index in 0..9 {
            let selection = pick(
                &mut router,
                &format!("s{index}"),
                "p",
                ModelPoolStrategy::Balanced,
                0,
            );
            assert_eq!(selection.binding.model_id, ["a", "b", "c"][index % 3]);
            router.accept(&selection);
        }
        let same = pick(&mut router, "s0", "p", ModelPoolStrategy::Balanced, 1);
        assert_eq!(same.binding.model_id, "a");
        router.accept(&same);
        let new_session = pick(&mut router, "s9", "p", ModelPoolStrategy::Balanced, 1);
        assert_eq!(new_session.binding.model_id, "a");
    }

    #[test]
    fn cooldown_and_probe_are_shared_across_pools_and_cancel_releases_probe() {
        let mut router = ModelPoolRouter::default();
        let failed = pick(&mut router, "s1", "p1", ModelPoolStrategy::Ordered, 0);
        router.fail(&failed, &unavailable().with_retry_after_ms(Some(20)), 0, 1);
        assert_eq!(
            pick(&mut router, "s2", "p2", ModelPoolStrategy::Ordered, 10)
                .binding
                .model_id,
            "b"
        );
        let probe = pick(&mut router, "s3", "p2", ModelPoolStrategy::Ordered, 20);
        assert_eq!(probe.binding.model_id, "a");
        assert_eq!(
            pick(&mut router, "s4", "p1", ModelPoolStrategy::Ordered, 20)
                .binding
                .model_id,
            "b"
        );
        router.cancel(&probe);
        assert_eq!(
            pick(&mut router, "s5", "p1", ModelPoolStrategy::Ordered, 20)
                .binding
                .model_id,
            "a"
        );
    }

    #[test]
    fn stale_results_cannot_rebind_after_explicit_selection_or_expired_lease() {
        let mut router = ModelPoolRouter::default();
        let old = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 0);
        router.clear_session("s");
        assert!(!router.accept(&old));
        let old = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 1);
        let new = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 102);
        assert!(!router.fail(&old, &unavailable(), 102, 10));
        assert!(router.accept(&new));
    }

    #[test]
    fn request_errors_do_not_poison_health() {
        for category in [
            ErrorCategory::ContextOverflow,
            ErrorCategory::InvalidRequest,
            ErrorCategory::ContentPolicy,
        ] {
            let mut router = ModelPoolRouter::default();
            let attempt = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 0);
            assert!(!router.fail(
                &attempt,
                &AiProviderError::classified("request".into(), category),
                0,
                10
            ));
            assert_eq!(
                router.member_status(&members()[0], 0).status,
                ModelPoolHealthStatus::Unverified
            );
            assert!(router.binding("s").is_none());
        }
    }

    #[test]
    fn exhausted_response_recovery_can_traverse_more_than_ten_members_without_cooling_them() {
        let mut router = ModelPoolRouter::default();
        let candidates: Vec<_> = (0..11)
            .map(|i| Candidate {
                model_id: format!("member-{i}"),
                fingerprint: format!("fp-{i}"),
                eligible: true,
            })
            .collect();
        let mut excluded = BTreeSet::new();
        for (index, candidate) in candidates.iter().enumerate() {
            let attempt = router
                .reserve(
                    "s",
                    "p",
                    ModelPoolStrategy::Ordered,
                    &candidates,
                    &excluded,
                    0,
                    100,
                )
                .unwrap();
            assert_eq!(attempt.binding.model_id, candidate.model_id);
            if index == 10 {
                assert!(router.accept(&attempt));
            } else {
                let category = if index % 2 == 0 {
                    ErrorCategory::ModelError
                } else {
                    ErrorCategory::Unknown
                };
                assert!(router.fail(
                    &attempt,
                    &AiProviderError::classified("response recovery exhausted".into(), category),
                    0,
                    100
                ));
                assert_eq!(
                    router.member_status(candidate, 0).status,
                    ModelPoolHealthStatus::Unverified
                );
                excluded.insert(candidate.model_id.clone());
            }
        }
        assert_eq!(router.binding("s").unwrap().model_id, "member-10");
        excluded.insert("member-10".into());
        assert!(router
            .reserve(
                "s",
                "p",
                ModelPoolStrategy::Ordered,
                &candidates,
                &excluded,
                0,
                100
            )
            .is_err());
    }

    #[test]
    fn alternative_admission_respects_exclusions_health_and_probe_ownership() {
        let mut router = ModelPoolRouter::default();
        let candidates = members();
        let excluded = BTreeSet::from(["c".into()]);
        assert!(router.has_available_alternative("a", &candidates, &excluded, 0));
        let attempt = router
            .reserve(
                "other",
                "p",
                ModelPoolStrategy::Ordered,
                &candidates,
                &BTreeSet::from(["a".into(), "c".into()]),
                0,
                100,
            )
            .unwrap();
        router.fail(&attempt, &unavailable(), 0, 10);
        assert!(!router.has_available_alternative("a", &candidates, &excluded, 1));
        assert!(router.has_available_alternative("a", &candidates, &excluded, 10));
        let probe = router
            .reserve(
                "probe",
                "p",
                ModelPoolStrategy::Ordered,
                &candidates,
                &BTreeSet::from(["a".into(), "c".into()]),
                10,
                100,
            )
            .unwrap();
        assert!(!router.has_available_alternative("a", &candidates, &excluded, 10));
        router.cancel(&probe);
        assert!(router.has_available_alternative("a", &candidates, &excluded, 10));
        let mut incompatible = candidates;
        incompatible[1].eligible = false;
        assert!(!router.has_available_alternative("a", &incompatible, &excluded, 10));
    }

    #[test]
    fn changed_configuration_does_not_inherit_old_health_or_binding() {
        let mut router = ModelPoolRouter::default();
        let old = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 0);
        router.fail(
            &old,
            &AiProviderError::classified("auth".into(), ErrorCategory::Auth),
            0,
            10,
        );
        let mut candidates = members();
        candidates[0].fingerprint = "a-v2".into();
        let selection = router
            .reserve(
                "s",
                "p",
                ModelPoolStrategy::Ordered,
                &candidates,
                &BTreeSet::new(),
                1,
                100,
            )
            .unwrap();
        assert_eq!(selection.binding.model_id, "a");
    }

    #[test]
    fn restart_keeps_binding_but_not_live_reservations() {
        let mut router = ModelPoolRouter::default();
        let selected = pick(&mut router, "s", "p", ModelPoolStrategy::Balanced, 0);
        router.accept(&selected);
        let _active = pick(&mut router, "s", "p", ModelPoolStrategy::Balanced, 1);
        let mut restored: ModelPoolRouter =
            serde_json::from_value(serde_json::to_value(&router).unwrap()).unwrap();
        assert_eq!(
            pick(&mut restored, "s", "p", ModelPoolStrategy::Balanced, 2).binding,
            ModelPoolBinding {
                generation: 3,
                ..selected.binding
            }
        );
    }

    #[test]
    fn removed_cursor_member_does_not_restart_at_first_member() {
        let mut router = ModelPoolRouter::default();
        let a = pick(&mut router, "s1", "p", ModelPoolStrategy::Balanced, 0);
        router.accept(&a);
        let candidates = vec![members()[0].clone(), members()[2].clone()];
        let c = router
            .reserve(
                "s2",
                "p",
                ModelPoolStrategy::Balanced,
                &candidates,
                &BTreeSet::new(),
                1,
                100,
            )
            .unwrap();
        assert_eq!(c.binding.model_id, "c");
    }

    #[test]
    fn incompatible_and_excluded_candidates_are_never_selected() {
        let mut router = ModelPoolRouter::default();
        let mut candidates = members();
        candidates[0].eligible = false;
        let excluded = BTreeSet::from(["b".into(), "c".into()]);
        assert_eq!(
            router
                .reserve(
                    "s",
                    "p",
                    ModelPoolStrategy::Ordered,
                    &candidates,
                    &excluded,
                    0,
                    100
                )
                .unwrap_err(),
            SelectionError::Unavailable { retry_at_ms: None }
        );
        assert_eq!(
            router
                .reserve(
                    "s",
                    "p",
                    ModelPoolStrategy::Unsupported,
                    &candidates,
                    &BTreeSet::new(),
                    0,
                    100
                )
                .unwrap_err(),
            SelectionError::UnsupportedStrategy
        );
    }
    #[test]
    fn newer_health_is_not_overwritten_but_older_request_can_fail_over() {
        let mut router = ModelPoolRouter::default();
        let older = pick(&mut router, "older", "p", ModelPoolStrategy::Ordered, 0);
        let newer = pick(&mut router, "newer", "p", ModelPoolStrategy::Ordered, 1);
        router.accept(&newer);
        assert!(router.fail(&older, &unavailable(), 2, 30));
        assert_eq!(
            router.member_status(&members()[0], 2).status,
            ModelPoolHealthStatus::Available
        );
        let next = router
            .reserve(
                "older",
                "p",
                ModelPoolStrategy::Ordered,
                &members(),
                &BTreeSet::from(["a".into()]),
                2,
                100,
            )
            .unwrap();
        assert_eq!(next.binding.model_id, "b");
    }

    #[test]
    fn manual_retry_and_configuration_revision_are_separate_from_session_affinity() {
        let mut router = ModelPoolRouter::default();
        let attempt = pick(&mut router, "s:0", "p", ModelPoolStrategy::Ordered, 0);
        router.fail(
            &attempt,
            &AiProviderError::classified("Auth".into(), ErrorCategory::Auth),
            0,
            1,
        );
        let bound = pick(&mut router, "s:0", "p", ModelPoolStrategy::Ordered, 1);
        router.accept(&bound);
        router.retry_member("a");
        assert_eq!(
            pick(&mut router, "s:0", "p", ModelPoolStrategy::Ordered, 2)
                .binding
                .model_id,
            "b"
        );
        assert_eq!(
            pick(&mut router, "s:1", "p", ModelPoolStrategy::Ordered, 2)
                .binding
                .model_id,
            "a"
        );
    }

    #[test]
    fn live_attempt_renewal_protects_long_stream_and_preview_does_not_mutate_owner() {
        let mut router = ModelPoolRouter::default();
        let attempt = pick(&mut router, "s", "p", ModelPoolStrategy::Ordered, 0);
        router.renew(&attempt, 90, 100);
        let mut preview = router.clone();
        preview.release_session_reservation("s");
        assert!(preview
            .reserve(
                "s",
                "p",
                ModelPoolStrategy::Ordered,
                &members(),
                &BTreeSet::new(),
                110,
                1
            )
            .is_ok());
        pick(&mut router, "other", "p", ModelPoolStrategy::Ordered, 110);
        assert!(router.accept(&attempt));
    }
}
