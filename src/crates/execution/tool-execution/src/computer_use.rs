//! Bounded Computer Use evidence and conservative read-retry policy.
//! Input submission, observed pixel changes and task completion are different facts.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum actions to track in history
const MAX_HISTORY_SIZE: usize = 50;

pub use openbitfun_agent_tools::computer_use_host::{ActionRecord, LoopDetectionResult};

/// Computer Use session optimizer
#[derive(Debug)]
pub struct ComputerUseOptimizer {
    action_history: VecDeque<ActionRecord>,
    last_screenshot_hash: Option<u64>,
}

impl ComputerUseOptimizer {
    pub fn new() -> Self {
        Self {
            action_history: VecDeque::with_capacity(MAX_HISTORY_SIZE),
            last_screenshot_hash: None,
        }
    }

    /// Record an action in history
    pub fn record_action(&mut self, action_type: String, action_params: String, success: bool) {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let record = ActionRecord {
            timestamp_ms,
            action_type,
            action_params,
            success,
            screenshot_hash: self.last_screenshot_hash,
        };

        self.action_history.push_back(record);
        if self.action_history.len() > MAX_HISTORY_SIZE {
            self.action_history.pop_front();
        }
    }

    /// Update screenshot hash for visual change detection
    pub fn update_screenshot_hash(&mut self, hash: u64) {
        self.last_screenshot_hash = Some(hash);
    }

    /// Compatibility projection for existing host APIs. Repeated action names,
    /// byte-identical frames and mouse usage alone cannot prove a task loop.
    /// Keep factual history for the caller's next decision without inventing
    /// retries, focus changes or keyboard input.
    pub fn detect_loop(&self) -> LoopDetectionResult {
        LoopDetectionResult {
            is_loop: false,
            pattern_length: 0,
            repetitions: 0,
            suggestion: String::new(),
        }
    }

    /// Get action history for backtracking
    pub fn get_history(&self) -> Vec<ActionRecord> {
        self.action_history.iter().cloned().collect()
    }

    /// Clear history (for new task)
    pub fn clear_history(&mut self) {
        self.action_history.clear();
        self.last_screenshot_hash = None;
    }
}

impl Default for ComputerUseOptimizer {
    fn default() -> Self {
        Self::new()
    }
}

/// Full-buffer fingerprint of encoded bytes, not a perceptual or task-success metric.
pub fn hash_screenshot_bytes(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &byte in bytes.iter() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Verification result after an action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    /// Hash comparison alone never verifies the requested outcome.
    pub verified: bool,
    pub visual_change_detected: bool,
    /// Legacy compatibility field. Always zero: hashes cannot measure an area.
    pub change_percentage: f32,
    pub suggestion: Option<String>,
}

/// Retry strategy for failed actions
#[derive(Debug, Clone)]
pub struct RetryStrategy {
    pub max_attempts: u32,
    pub current_attempt: u32,
    pub should_retry: bool,
    pub retry_delay_ms: u64,
}

impl RetryStrategy {
    pub fn new(max_attempts: u32) -> Self {
        Self {
            max_attempts,
            current_attempt: 0,
            should_retry: max_attempts > 0,
            retry_delay_ms: 500,
        }
    }

    pub fn next_attempt(&mut self) -> bool {
        self.current_attempt = self.current_attempt.saturating_add(1);
        self.should_retry = self.current_attempt < self.max_attempts;
        self.should_retry
    }

    pub fn is_exhausted(&self) -> bool {
        self.current_attempt >= self.max_attempts
    }
}

/// Compare encoded frame fingerprints. A clock, caret or animation can change
/// pixels after failed input; successful input can also leave pixels unchanged.
pub fn detect_visual_change(hash_before: u64, hash_after: u64) -> VerificationResult {
    VerificationResult {
        verified: false,
        visual_change_detected: hash_before != hash_after,
        change_percentage: 0.0,
        suggestion: Some("Inspect the observation against the requested outcome. Pixel changes do not prove completion; an unchanged image does not justify replaying input.".into()),
    }
}

/// Only side-effect-free observations can be retried after a transient failure.
/// Text errors cannot establish that a mutation was never submitted.
pub fn should_retry_action_message(error_message: &str, action_type: &str) -> bool {
    if !matches!(
        action_type,
        "screenshot" | "get_app_state" | "get_app_shortcuts" | "locate" | "list_apps" | "read_text"
    ) {
        return false;
    }
    let error = error_message.to_ascii_lowercase();
    if [
        "permission",
        "denied",
        "unsupported",
        "not available",
        "control_stale",
        "control_stopped",
        "cancelled",
    ]
    .iter()
    .any(|term| error.contains(term))
    {
        return false;
    }
    error.contains("timeout") || error.contains("temporarily unavailable")
}

pub fn generate_retry_suggestion(action_type: &str, _attempt: u32) -> String {
    format!("{action_type} did not establish the requested outcome. Read the authorized target again and inspect the result before choosing new input. Submitted input must not be automatically replayed.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legitimate_repeated_work_is_not_classified_as_a_loop() {
        for action in ["scroll", "click", "mouse_move", "screenshot", "type_text"] {
            let mut evidence = ComputerUseOptimizer::new();
            evidence.update_screenshot_hash(7);
            for index in 0..100 {
                evidence.record_action(action.into(), format!("target:{index}"), true);
            }
            assert!(!evidence.detect_loop().is_loop);
            assert_eq!(evidence.get_history().len(), MAX_HISTORY_SIZE);
            evidence.clear_history();
            assert!(evidence.get_history().is_empty());
        }
    }

    #[test]
    fn same_and_changed_frames_never_claim_completion_or_area() {
        for (before, after) in [(1, 1), (1, 2)] {
            let evidence = detect_visual_change(before, after);
            assert!(!evidence.verified);
            assert_eq!(evidence.visual_change_detected, before != after);
            assert_eq!(evidence.change_percentage, 0.0);
        }
    }

    #[test]
    fn fingerprint_covers_pixels_between_previous_sparse_samples() {
        let before = vec![0; 4001];
        let mut after = before.clone();
        after[3999] = 1;
        assert_ne!(
            hash_screenshot_bytes(&before),
            hash_screenshot_bytes(&after)
        );
        assert_eq!(
            hash_screenshot_bytes(&before),
            hash_screenshot_bytes(&before)
        );
    }

    #[test]
    fn timeout_or_stale_errors_never_authorize_input_replay() {
        for action in [
            "click",
            "app_click",
            "click_element",
            "drag",
            "type_text",
            "app_batch",
            "key_chord",
            "open_app",
            "unknown",
        ] {
            for error in [
                "timeout",
                "element not found",
                "stale",
                "temporarily unavailable",
            ] {
                assert!(!should_retry_action_message(error, action));
            }
        }
        assert!(should_retry_action_message("timeout", "get_app_state"));
        assert!(!should_retry_action_message(
            "permission denied timeout",
            "get_app_state"
        ));
        assert!(!should_retry_action_message(
            "CONTROL_STALE timeout",
            "screenshot"
        ));
    }

    #[test]
    fn read_retry_budget_handles_zero_and_overflow() {
        let mut zero = RetryStrategy::new(0);
        assert!(!zero.should_retry);
        assert!(!zero.next_attempt());
        let mut retry = RetryStrategy::new(2);
        assert!(retry.next_attempt());
        assert!(!retry.next_attempt());
        retry.current_attempt = u32::MAX;
        assert!(!retry.next_attempt());
    }
}
