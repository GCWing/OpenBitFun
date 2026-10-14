//! The model-backed L2 judge as the arbitration port's implementation.
//!
//! [`arbiter`](super::arbiter) owns the port and knows nothing about models,
//! prompts, or budgets. `ModelLoopArbiter` owns all three and knows nothing
//! about sessions, ladders, or interventions. This module is the only place the
//! two meet, so neither side has to learn the other's shape:
//!
//! * **Request.** Turn identity comes from [`LoopArbiterContext`] and the
//!   evidence comes from the L1 verdict. The context's `model_id` is the
//!   observed round's model, and it travels as the judge request's
//!   `monitored_model_id`, which is what arms the judge's model-avoidance rule:
//!   the judge must never be the model whose output is under suspicion.
//! * **Answer.** The mapping below is the whole arbitration policy this layer
//!   owns. It mirrors the judge's documented caller contract, and it is total:
//!   every judge outcome has exactly one port decision.
//!
//!   | judge outcome | arbitration decision |
//!   |---|---|
//!   | `Judged(loop)` | [`ArbiterDecision::Confirmed`] carrying the judge's stated confidence |
//!   | `Judged(not_loop)` | [`ArbiterDecision::Rejected`] |
//!   | `Judged(unclear)` | [`ArbiterDecision::Indeterminate`] |
//!   | `Indeterminate(_)` | [`ArbiterDecision::Indeterminate`] |
//!
//!   `Indeterminate` covers every unusable answer the judge reports: disabled
//!   judge, no eligible judge model, spent per-turn budget, unavailable
//!   configuration or client, cancellation, timeout, provider failure, and a
//!   reply that does not satisfy the verdict contract. In all of them the
//!   heuristic verdict stands with the kind's own caps, so a missing or broken
//!   judge can never take L1 detection down with it.
//!
//! The arbiter answers; it never acts. It does not steer, cancel, or escalate. It
//! reports the judge's confidence rather than judging it, because the threshold
//! that decides how much a confirmation is worth is configuration
//! (`ai.loop_detection.thresholds.judge_verdict_confidence_min`) and the ladder
//! applies it to the port decision
//! ([`ArbiterDecision::gated_by_confidence`]).
//!
//! # Known deviation
//!
//! The port carries no cancellation token, so one arbitration is bounded by the
//! judge's own timeout instead of by the dialog turn's token. A cancelled turn
//! can therefore spend at most one bounded judge call. Threading the turn token
//! through the port would need a port change; until then the timeout is the
//! bound, and the judge itself refuses to start work for an already-cancelled
//! request whenever a caller does supply one.

use super::arbiter::{ArbiterDecision, LoopArbiter, LoopArbiterContext};
use crate::agentic::execution::loop_arbiter::{
    global_model_loop_arbiter, LoopJudgeOutcome, LoopJudgeRequest, LoopJudgeVerdict,
    ModelLoopArbiter,
};
use log::debug;
use openbitfun_agent_stream::LoopVerdict;
use std::sync::Arc;

#[async_trait::async_trait]
impl LoopArbiter for ModelLoopArbiter {
    async fn arbitrate(
        &self,
        verdict: &LoopVerdict,
        context: &LoopArbiterContext,
    ) -> ArbiterDecision {
        debug!(
            "Loop arbitration delegated to the model judge: session_id={}, turn_id={}, round_index={}, agent_type={}, source={}, kind={}, monitored_model_id={}",
            context.session_id,
            context.turn_id,
            context.round_index,
            context.agent_type,
            context.signal_source.as_str(),
            verdict.kind.as_str(),
            context.model_id
        );
        let outcome = ModelLoopArbiter::arbitrate(self, judge_request_for(verdict, context)).await;
        arbitration_decision_for(&outcome)
    }
}

/// Builds the judge request that corresponds to one port arbitration call.
///
/// Pure, so the whole identity adaptation is visible in one place. A blank
/// observed model id is passed as absent instead of as an empty string, because
/// an empty id must not arm the judge's avoidance rule.
pub fn judge_request_for(verdict: &LoopVerdict, context: &LoopArbiterContext) -> LoopJudgeRequest {
    let monitored_model_id = {
        let model_id = context.model_id.trim();
        (!model_id.is_empty()).then(|| model_id.to_string())
    };
    LoopJudgeRequest::new(
        context.session_id.clone(),
        context.turn_id.clone(),
        verdict.clone(),
    )
    .with_monitored_model_id(monitored_model_id)
}

/// Maps one judge outcome onto the port's decision.
///
/// A judge that abstains must be indistinguishable from no judge at all:
/// anything other than an answered `loop` or `not_loop` keeps the heuristic
/// verdict, so thin evidence can never silently suppress a real loop.
///
/// A `loop` answer carries the judge's own confidence into
/// [`ArbiterDecision::Confirmed`], where the ladder's configured gate decides
/// whether that is authoritative. The judge reports `0.0` for a reply it could not
/// parse a confidence out of, and documents that a confidence-gated caller ignores
/// such a reply, so this adapter passes [`None`] instead of a literal zero: an
/// unstating judge must not look like a maximally cautious but real answer.
pub fn arbitration_decision_for(outcome: &LoopJudgeOutcome) -> ArbiterDecision {
    match outcome {
        LoopJudgeOutcome::Judged(judgement) => match judgement.verdict {
            LoopJudgeVerdict::Loop => ArbiterDecision::Confirmed {
                confidence: stated_judge_confidence(judgement.confidence),
            },
            LoopJudgeVerdict::NotLoop => ArbiterDecision::Rejected,
            LoopJudgeVerdict::Unclear => ArbiterDecision::Indeterminate,
        },
        LoopJudgeOutcome::Indeterminate(_) => ArbiterDecision::Indeterminate,
    }
}

/// The judge's confidence when it stated a usable one.
///
/// A non-finite or non-positive confidence is "no usable confidence" rather than a
/// number: the judge's own parser returns `0.0` for a missing or non-numeric
/// field, and a ratio of zero cannot be distinguished from that sentinel.
fn stated_judge_confidence(confidence: f32) -> Option<f32> {
    (confidence.is_finite() && confidence > 0.0).then_some(confidence)
}

/// The arbiter a session host installs when its configured judge is enabled.
///
/// `None` means "install nothing". A disabled judge is never consulted by the
/// ladder, so installing the process-wide arbiter anyway would only reserve a
/// slot that answers `Indeterminate` forever; the engine's no-arbiter default
/// behaves identically. The process-wide instance is created lazily here, so a
/// host that never installs it never builds one.
pub fn configured_model_loop_arbiter(judge_enabled: bool) -> Option<Arc<dyn LoopArbiter>> {
    if !judge_enabled {
        return None;
    }
    let arbiter: Arc<dyn LoopArbiter> = global_model_loop_arbiter();
    Some(arbiter)
}

#[cfg(test)]
mod tests {
    use super::super::runtime::LoopDetectionRuntime;
    use super::*;
    use crate::agentic::execution::loop_arbiter::{
        LoopJudgeEnvironment, LoopJudgeJudgement, LoopJudgeModelSource, LoopJudgeSettings,
        LoopJudgeSkip, LoopJudgeUsage,
    };
    use crate::agentic::execution::loop_detection::ladder::LoopSignalSource;
    use crate::agentic::execution::round_executor::tests::RetryTestServer;
    use crate::infrastructure::ai::AIClient;
    use crate::service::config::types::{AIConfig, AIModelConfig};
    use openbitfun_agent_stream::{LoopEvidence, LoopKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    const OBSERVED_MODEL_ID: &str = "turn-model";

    fn arbitration_verdict() -> LoopVerdict {
        LoopVerdict {
            kind: LoopKind::NearRepetition,
            confidence: 0.62,
            evidence: LoopEvidence {
                occurrences: 4,
                consecutive_repeats: 2,
                mean_interval_chars: Some(120.5),
                max_similarity: Some(0.87),
                requires_arbitration: true,
                samples: vec!["the same sentence appears again".to_string()],
                ..Default::default()
            },
        }
    }

    fn arbitration_context(model_id: &str) -> LoopArbiterContext {
        LoopArbiterContext {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_index: 3,
            model_id: model_id.to_string(),
            agent_type: "Standard".to_string(),
            signal_source: LoopSignalSource::Thinking,
        }
    }

    fn judgement(verdict: LoopJudgeVerdict, confidence: f32) -> LoopJudgeJudgement {
        LoopJudgeJudgement {
            verdict,
            confidence,
            reason: "bounded explanation".to_string(),
            model_config_id: "judge-fast".to_string(),
            model_source: LoopJudgeModelSource::Fast,
            usage: None,
        }
    }

    fn model(id: &str, model_name: &str, base_url: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: id.to_string(),
            model_name: model_name.to_string(),
            provider: "openai".to_string(),
            base_url: base_url.to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    /// A judge model that is a different provider model from the observed round's
    /// model, so the judge's avoidance rule never has to step in.
    fn judge_ai_config() -> AIConfig {
        let mut ai_config = AIConfig {
            models: vec![
                model(OBSERVED_MODEL_ID, "gpt-turn", "https://turn.example/v1"),
                model("judge-fast", "gpt-fast", "https://fast.example/v1"),
            ],
            ..Default::default()
        };
        ai_config.default_models.fast = Some("judge-fast".to_string());
        ai_config
    }

    /// A judge substitute that answers from an injected client, so the port
    /// adaptation is observable without global process state.
    struct FakeJudgeEnvironment {
        enabled: bool,
        client: Option<Arc<AIClient>>,
        reported_usage: Mutex<Vec<LoopJudgeUsage>>,
        client_requests: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl LoopJudgeEnvironment for FakeJudgeEnvironment {
        async fn judge_settings(&self) -> anyhow::Result<LoopJudgeSettings> {
            Ok(LoopJudgeSettings {
                enabled: self.enabled,
                max_verdicts_per_turn: 2,
                ai_config: judge_ai_config(),
            })
        }

        async fn judge_client(&self, _model_id: &str) -> anyhow::Result<Arc<AIClient>> {
            self.client_requests.fetch_add(1, Ordering::SeqCst);
            self.client
                .clone()
                .ok_or_else(|| anyhow::anyhow!("judge client unavailable"))
        }

        async fn report_usage(&self, usage: &LoopJudgeUsage) {
            self.reported_usage.lock().unwrap().push(usage.clone());
        }
    }

    fn fake_environment(enabled: bool, client: Option<Arc<AIClient>>) -> Arc<FakeJudgeEnvironment> {
        Arc::new(FakeJudgeEnvironment {
            enabled,
            client,
            reported_usage: Mutex::new(Vec::new()),
            client_requests: AtomicUsize::new(0),
        })
    }

    fn judge_sse(text: &str) -> (u16, String) {
        let chunks = [
            serde_json::json!({
                "id": "judge", "object": "chat.completion.chunk", "created": 1,
                "model": "retry-test-model",
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": "stop"}]
            }),
            serde_json::json!({
                "id": "judge", "object": "chat.completion.chunk", "created": 1,
                "model": "retry-test-model", "choices": [],
                "usage": {"prompt_tokens": 120, "completion_tokens": 18, "total_tokens": 138}
            }),
        ];
        let mut body = String::new();
        for chunk in chunks {
            body.push_str(&format!("data: {chunk}\n\n"));
        }
        body.push_str("data: [DONE]\n\n");
        (200, body)
    }

    // ------------------------- outcome-to-decision mapping -------------------------

    #[test]
    fn answered_verdicts_map_onto_the_port_decisions() {
        for (verdict, expected) in [
            (
                LoopJudgeVerdict::Loop,
                ArbiterDecision::Confirmed {
                    confidence: Some(0.42),
                },
            ),
            (LoopJudgeVerdict::NotLoop, ArbiterDecision::Rejected),
            (LoopJudgeVerdict::Unclear, ArbiterDecision::Indeterminate),
        ] {
            let outcome = LoopJudgeOutcome::Judged(judgement(verdict, 0.42));

            assert_eq!(
                arbitration_decision_for(&outcome),
                expected,
                "judge verdict {} must map to its port decision",
                verdict.as_str()
            );
        }
    }

    #[test]
    fn a_loop_verdict_without_a_usable_confidence_carries_no_confidence() {
        // The judge reports 0.0 for a confidence it could not parse, and its own
        // contract says a confidence-gated caller ignores such a reply; the port
        // must not turn that into a confident zero.
        for unstating in [0.0, -0.5, f32::NAN, f32::INFINITY] {
            let outcome = LoopJudgeOutcome::Judged(judgement(LoopJudgeVerdict::Loop, unstating));

            assert_eq!(
                arbitration_decision_for(&outcome),
                ArbiterDecision::Confirmed { confidence: None },
                "confidence {unstating} is not a stated confidence"
            );
        }
    }

    #[test]
    fn every_unusable_judge_outcome_keeps_the_heuristic_verdict() {
        for skip in [
            LoopJudgeSkip::JudgeDisabled,
            LoopJudgeSkip::NoJudgeModelConfigured,
            LoopJudgeSkip::JudgeModelIsMonitoredModel,
            LoopJudgeSkip::VerdictBudgetExhausted { max_per_turn: 2 },
            LoopJudgeSkip::ConfigUnavailable,
            LoopJudgeSkip::ClientUnavailable,
            LoopJudgeSkip::Cancelled,
            LoopJudgeSkip::TimedOut,
            LoopJudgeSkip::ModelCallFailed,
            LoopJudgeSkip::MalformedReply,
        ] {
            assert_eq!(
                arbitration_decision_for(&LoopJudgeOutcome::Indeterminate(skip)),
                ArbiterDecision::Indeterminate,
                "skip {} must keep the heuristic verdict",
                skip.as_str()
            );
        }
    }

    // ------------------------------ request adaptation ------------------------------

    #[test]
    fn judge_request_carries_turn_identity_and_the_observed_model() {
        let verdict = arbitration_verdict();
        let context = arbitration_context(OBSERVED_MODEL_ID);

        let request = judge_request_for(&verdict, &context);

        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.turn_id, "turn-1");
        assert_eq!(
            request.monitored_model_id.as_deref(),
            Some(OBSERVED_MODEL_ID)
        );
        assert_eq!(request.verdict, verdict);
        assert!(request.cancellation.is_none());
    }

    #[test]
    fn a_blank_observed_model_is_passed_as_absent() {
        let request = judge_request_for(&arbitration_verdict(), &arbitration_context("   "));

        assert!(
            request.monitored_model_id.is_none(),
            "a blank observed model must not arm the judge's avoidance rule"
        );
    }

    // --------------------------- arbitration through the port ---------------------------

    #[tokio::test]
    async fn the_port_confirms_a_judged_loop_and_rejects_a_legitimate_repeat() {
        let server = RetryTestServer::new(vec![
            judge_sse(r#"{"verdict":"loop","confidence":0.92,"reason":"same paragraph"}"#),
            judge_sse(r#"{"verdict":"not_loop","confidence":0.88,"reason":"numeric table"}"#),
        ]);
        let environment = fake_environment(true, Some(server.client()));
        let arbiter = ModelLoopArbiter::with_environment(environment.clone());
        let context = arbitration_context(OBSERVED_MODEL_ID);
        let verdict = arbitration_verdict();

        let confirmed = LoopArbiter::arbitrate(&arbiter, &verdict, &context).await;
        let rejected = LoopArbiter::arbitrate(&arbiter, &verdict, &context).await;

        assert_eq!(
            confirmed,
            ArbiterDecision::Confirmed {
                confidence: Some(0.92)
            },
            "the judge's stated confidence must reach the port decision"
        );
        assert_eq!(confirmed.confidence(), Some(0.92));
        assert_eq!(rejected, ArbiterDecision::Rejected);
        assert_eq!(rejected.confidence(), None);
        assert_eq!(arbiter.arbitrations_for_turn("session-1", "turn-1"), 2);
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert_eq!(environment.reported_usage.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_port_keeps_the_heuristic_verdict_when_the_judge_cannot_answer() {
        for (enabled, client) in [(false, None), (true, None)] {
            let environment = fake_environment(enabled, client);
            let arbiter = ModelLoopArbiter::with_environment(environment.clone());

            let decision = LoopArbiter::arbitrate(
                &arbiter,
                &arbitration_verdict(),
                &arbitration_context(OBSERVED_MODEL_ID),
            )
            .await;

            assert_eq!(decision, ArbiterDecision::Indeterminate);
            assert_eq!(arbiter.arbitrations_for_turn("session-1", "turn-1"), 0);
        }

        let malformed = RetryTestServer::new(vec![judge_sse("I cannot decide.")]);
        let environment = fake_environment(true, Some(malformed.client()));
        let arbiter = ModelLoopArbiter::with_environment(environment);

        // A reply outside the verdict contract is a spent call, not an answer.
        assert_eq!(
            LoopArbiter::arbitrate(
                &arbiter,
                &arbitration_verdict(),
                &arbitration_context(OBSERVED_MODEL_ID)
            )
            .await,
            ArbiterDecision::Indeterminate
        );
    }

    // ------------------------------- registration gate -------------------------------

    #[test]
    fn a_disabled_judge_installs_no_arbiter() {
        assert!(configured_model_loop_arbiter(false).is_none());
    }

    #[tokio::test]
    async fn an_enabled_judge_yields_an_arbiter_the_engine_runtime_accepts() {
        let arbiter = configured_model_loop_arbiter(true).expect("enabled judge installs");
        let runtime = LoopDetectionRuntime::default();

        runtime.install_arbiter(arbiter);

        assert!(runtime.arbiter().is_some());
    }

    #[test]
    fn the_shared_host_assembly_installs_the_configured_arbiter() {
        // Source-level pin, the same shape the other assembly seams use: CLI,
        // ACP, server, and SDK hosts share this one path, so an engine built
        // there must get the arbiter instead of the no-arbiter default.
        const AGENTIC_SYSTEM: &str = include_str!("../../system.rs");

        assert!(
            AGENTIC_SYSTEM.contains("configured_model_loop_arbiter")
                && AGENTIC_SYSTEM.contains("install_loop_arbiter"),
            "the shared agentic system assembly must install the configured loop arbiter"
        );
    }
}
