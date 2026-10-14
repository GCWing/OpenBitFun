//! Adaptive context profile policy.
//!
//! Profiles keep context behavior aligned with the shape of the agent workload
//! without exposing more knobs to the UI.
//!
//! The same tier table also carries the agent loop detection policy: the
//! detector owns its baseline thresholds and its own configuration type, and
//! wiring translates [`LoopDetectionPolicy`] into it by scaling those baselines
//! and passing the structural exclusions through. This crate must not depend on
//! the detector's crate location, and the detector crate must not depend on this
//! one, so the shared facts stay pure data with no matching logic.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextProfile {
    LongTask,
    Conversation,
}

impl ContextProfile {
    pub fn for_agent_type(agent_type: &str) -> Self {
        Self::for_agent_context(agent_type, false)
    }

    pub fn for_agent_context(agent_type: &str, is_review_subagent: bool) -> Self {
        if is_review_subagent || is_long_task_agent(agent_type) {
            Self::LongTask
        } else {
            Self::Conversation
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCapabilityProfile {
    Standard,
    Weak,
}

impl ModelCapabilityProfile {
    pub fn from_model_id(model_id: Option<&str>) -> Self {
        let Some(model_id) = model_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return Self::Standard;
        };
        let normalized = model_id.to_ascii_lowercase();
        if matches!(normalized.as_str(), "fast" | "primary") {
            return Self::Standard;
        }

        // Weak model detection: match suffix-based markers (e.g., "gpt-4o-mini",
        // "gemini-1.5-flash") and exact markers (e.g., "haiku", "mini").
        // Avoid false positives from substring matches (e.g., "gemini-pro" should
        // NOT match "mini" inside "gemini").
        let weak_suffixes = ["-haiku", "-mini", "-small", "-lite", "-flash", "-nano"];
        let weak_exact = ["haiku", "mini", "small", "lite", "flash", "nano"];
        // Also match known weak model name patterns where the marker appears
        // mid-string but is a genuine weak model (e.g., "claude-3-haiku-20240307").
        let weak_mid_patterns = [
            "-haiku-", "-mini-", "-small-", "-lite-", "-flash-", "-nano-",
        ];
        if weak_suffixes.iter().any(|s| normalized.ends_with(s))
            || weak_exact.iter().any(|e| normalized == *e)
            || weak_mid_patterns.iter().any(|p| normalized.contains(p))
        {
            Self::Weak
        } else {
            Self::Standard
        }
    }

    pub fn from_resolved_model(resolved_model_id: &str, provider_model_name: &str) -> Self {
        let resolved = Self::from_model_id(Some(resolved_model_id));
        if resolved == Self::Weak {
            resolved
        } else {
            Self::from_model_id(Some(provider_model_name))
        }
    }
}

/// Structural regions whose repetition is legitimate and must never count as
/// loop evidence.
///
/// The detector owns the matching logic; this enum is the canonical policy data
/// for *which* structural classes are excluded. Keeping the list in one place
/// stops the detector and the tier table from drifting apart.
///
/// Deliberately outside this set:
/// - predictable numeric or alphabetic sequences (`2074-2075-...`,
///   `8.1A -> 8.1Z`), which need a separate predictable-change classifier
///   because the repetition is real even though the change is expected;
/// - tool-level repetition (batch calls over different targets, equal-length
///   polling), which is decided from tool signatures and progress evidence, not
///   from text structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StructuralExclusionKind {
    /// Fenced code blocks, including their info string line.
    FencedCodeBlock,
    /// Markdown table rows and separator lines.
    Table,
    /// Ordered and unordered list item bodies.
    List,
    /// Heading lines.
    Heading,
    /// Block quote lines.
    BlockQuote,
    /// Horizontal rules.
    HorizontalRule,
}

impl StructuralExclusionKind {
    /// Canonical structural exclusion set: code blocks, tables, lists,
    /// headings, quotes, and horizontal rules.
    pub const ALL: &'static [Self] = &[
        Self::FencedCodeBlock,
        Self::Table,
        Self::List,
        Self::Heading,
        Self::BlockQuote,
        Self::HorizontalRule,
    ];

    /// Stable identifier for detector hand-off, telemetry, and logs.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FencedCodeBlock => "fenced_code_block",
            Self::Table => "table",
            Self::List => "list",
            Self::Heading => "heading",
            Self::BlockQuote => "block_quote",
            Self::HorizontalRule => "horizontal_rule",
        }
    }
}

/// Structural classes excluded from loop evidence by default.
pub const DEFAULT_STRUCTURAL_EXCLUSIONS: &[StructuralExclusionKind] = StructuralExclusionKind::ALL;

/// Loop-detection tuning tier for a context profile and model capability.
///
/// Pure data: the detector owns its own baseline thresholds and configuration
/// type, and wiring translates this policy into them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoopDetectionPolicy {
    /// Multiplier applied to the detector's baseline thresholds.
    ///
    /// `1.0` keeps the calibrated baseline; values above `1.0` require more
    /// evidence, so a signal fires later and costs fewer false positives.
    pub threshold_scale: f32,
    /// Structural classes whose repetition must not count as loop evidence.
    pub structural_exclusions: &'static [StructuralExclusionKind],
}

impl LoopDetectionPolicy {
    pub fn for_profile(profile: ContextProfile, model_capability: ModelCapabilityProfile) -> Self {
        Self {
            threshold_scale: loop_detection_threshold_scale(profile, model_capability),
            structural_exclusions: DEFAULT_STRUCTURAL_EXCLUSIONS,
        }
    }

    /// Scale a fractional detector baseline, such as a similarity or a ratio.
    pub fn scale_threshold(&self, baseline: f32) -> f32 {
        baseline * self.threshold_scale
    }

    /// Scale a count baseline conservatively: round up, never below one.
    pub fn scale_count(&self, baseline: usize) -> usize {
        let scaled = (baseline.max(1) as f32 * self.threshold_scale).ceil();
        scaled.max(1.0) as usize
    }

    /// Whether repetition inside `kind` must be excluded from loop evidence.
    pub fn excludes(&self, kind: StructuralExclusionKind) -> bool {
        self.structural_exclusions.contains(&kind)
    }
}

/// Long-task standard tier: the calibrated baseline the detection plan is tuned
/// for, because long-horizon output repetition usually means lost progress.
const LONG_TASK_STANDARD_LOOP_DETECTION_SCALE: f32 = 1.0;
/// Long-task weak-model tier: a weak model repeats more, but its text-level
/// evidence is noisier, so a false positive on a good turn is the likelier cost.
const LONG_TASK_WEAK_LOOP_DETECTION_SCALE: f32 = 1.25;
/// Conversation standard tier: short chat answers legitimately restate the
/// request, so the same evidence is less conclusive than in a long task.
const CONVERSATION_STANDARD_LOOP_DETECTION_SCALE: f32 = 1.25;
/// Conversation weak-model tier: both effects above apply.
const CONVERSATION_WEAK_LOOP_DETECTION_SCALE: f32 = 1.5;

/// Loop-detection threshold scale per (context profile, model capability).
///
/// Weak models move in the opposite direction from the context-compaction knobs:
/// compaction tightens for weak models because they drift sooner, while loop
/// detection asks for more evidence because weak models repeat in legitimate
/// ways too, and a false positive kills a good turn.
fn loop_detection_threshold_scale(
    profile: ContextProfile,
    model_capability: ModelCapabilityProfile,
) -> f32 {
    match (profile, model_capability) {
        (ContextProfile::LongTask, ModelCapabilityProfile::Standard) => {
            LONG_TASK_STANDARD_LOOP_DETECTION_SCALE
        }
        (ContextProfile::LongTask, ModelCapabilityProfile::Weak) => {
            LONG_TASK_WEAK_LOOP_DETECTION_SCALE
        }
        (ContextProfile::Conversation, ModelCapabilityProfile::Standard) => {
            CONVERSATION_STANDARD_LOOP_DETECTION_SCALE
        }
        (ContextProfile::Conversation, ModelCapabilityProfile::Weak) => {
            CONVERSATION_WEAK_LOOP_DETECTION_SCALE
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextProfilePolicy {
    pub profile: ContextProfile,
    pub compression_contract_limit: usize,
    pub subagent_concurrency_cap: usize,
    pub repeated_tool_signature_threshold: usize,
    pub consecutive_failed_command_threshold: usize,
    /// Loop-detection tier derived from the profile and the model capability.
    pub loop_detection: LoopDetectionPolicy,
}

impl ContextProfilePolicy {
    pub fn for_agent_context(
        agent_type: &str,
        is_review_subagent: bool,
        model_capability: ModelCapabilityProfile,
    ) -> Self {
        let profile = ContextProfile::for_agent_context(agent_type, is_review_subagent);
        let mut policy = match profile {
            ContextProfile::LongTask => Self::long_task(),
            ContextProfile::Conversation => Self::conversation(),
        };

        if model_capability == ModelCapabilityProfile::Weak {
            policy.apply_weak_model_override();
        }

        policy
    }

    pub fn for_agent_context_and_model(
        agent_type: &str,
        is_review_subagent: bool,
        resolved_model_id: &str,
        provider_model_name: &str,
    ) -> Self {
        Self::for_agent_context(
            agent_type,
            is_review_subagent,
            ModelCapabilityProfile::from_resolved_model(resolved_model_id, provider_model_name),
        )
    }

    pub fn for_subagent_context_and_models(
        agent_type: &str,
        is_review_subagent: bool,
        subagent_model_id: Option<&str>,
        parent_agent_type: Option<&str>,
        parent_is_review_subagent: bool,
        parent_model_id: Option<&str>,
    ) -> Self {
        let child_profile = ContextProfile::for_agent_context(agent_type, is_review_subagent);
        let parent_profile = parent_agent_type
            .map(|agent_type| {
                ContextProfile::for_agent_context(agent_type, parent_is_review_subagent)
            })
            .unwrap_or(ContextProfile::Conversation);
        let profile = if child_profile == ContextProfile::LongTask
            || parent_profile == ContextProfile::LongTask
        {
            ContextProfile::LongTask
        } else {
            ContextProfile::Conversation
        };
        let model_capability = subagent_model_id
            .map(str::trim)
            .filter(|model_id| !model_id.is_empty())
            .map(|model_id| ModelCapabilityProfile::from_model_id(Some(model_id)))
            .or_else(|| {
                parent_model_id
                    .map(str::trim)
                    .filter(|model_id| !model_id.is_empty())
                    .map(|model_id| ModelCapabilityProfile::from_model_id(Some(model_id)))
            })
            .unwrap_or(ModelCapabilityProfile::Standard);

        let mut policy = match profile {
            ContextProfile::LongTask => Self::long_task(),
            ContextProfile::Conversation => Self::conversation(),
        };
        if model_capability == ModelCapabilityProfile::Weak {
            policy.apply_weak_model_override();
        }
        policy
    }

    pub fn effective_subagent_max_concurrency(&self, configured: usize) -> usize {
        configured.clamp(1, self.subagent_concurrency_cap)
    }

    pub fn effective_loop_threshold(&self, configured: usize) -> usize {
        configured
            .max(1)
            .min(self.repeated_tool_signature_threshold.max(1))
    }

    pub fn has_repeated_tool_loop(&self, repeated_tool_signature_count: usize) -> bool {
        repeated_tool_signature_count >= self.repeated_tool_signature_threshold.max(1)
    }

    pub fn has_consecutive_command_failure_loop(&self, consecutive_failed_commands: usize) -> bool {
        consecutive_failed_commands >= self.consecutive_failed_command_threshold.max(1)
    }

    /// Resolve a loop-detection threshold: an explicit configuration override
    /// wins outright, otherwise the tier scale applies to the detector baseline.
    /// A non-positive override counts as unset, so a stray zero cannot disable a
    /// signal silently.
    pub fn resolve_loop_detection_threshold(
        &self,
        configured: Option<f32>,
        detector_baseline: f32,
    ) -> f32 {
        match configured {
            Some(configured) if configured > 0.0 => configured,
            _ => self.loop_detection.scale_threshold(detector_baseline),
        }
    }

    fn long_task() -> Self {
        Self {
            profile: ContextProfile::LongTask,
            compression_contract_limit: 8,
            subagent_concurrency_cap: 5,
            repeated_tool_signature_threshold: 3,
            consecutive_failed_command_threshold: 2,
            loop_detection: LoopDetectionPolicy::for_profile(
                ContextProfile::LongTask,
                ModelCapabilityProfile::Standard,
            ),
        }
    }

    fn conversation() -> Self {
        Self {
            profile: ContextProfile::Conversation,
            compression_contract_limit: 4,
            subagent_concurrency_cap: 2,
            repeated_tool_signature_threshold: 4,
            consecutive_failed_command_threshold: 3,
            loop_detection: LoopDetectionPolicy::for_profile(
                ContextProfile::Conversation,
                ModelCapabilityProfile::Standard,
            ),
        }
    }

    fn apply_weak_model_override(&mut self) {
        self.compression_contract_limit = self.compression_contract_limit.min(4);
        self.subagent_concurrency_cap = self.subagent_concurrency_cap.min(2);
        self.repeated_tool_signature_threshold = self.repeated_tool_signature_threshold.min(2);
        self.consecutive_failed_command_threshold =
            self.consecutive_failed_command_threshold.min(2);
        // Loop detection is the exception to the tightening rule above: weak
        // models produce noisier text-level evidence, and a false positive costs
        // a good turn, so the tier asks for more evidence instead of less.
        self.loop_detection =
            LoopDetectionPolicy::for_profile(self.profile, ModelCapabilityProfile::Weak);
    }
}

fn is_long_task_agent(agent_type: &str) -> bool {
    matches!(
        agent_type,
        "Standard"
            | "DeepReview"
            | "DeepResearch"
            | "ComputerUse"
            | "Ultimate"
            | "SwarmPlanner"
            | "SwarmWorker"
            | "SwarmReviewer"
    ) || agent_type.starts_with("Review")
}

#[cfg(test)]
mod tests {
    use super::{
        ContextProfile, LoopDetectionPolicy, ModelCapabilityProfile, StructuralExclusionKind,
    };

    #[test]
    fn model_capability_standard_for_empty_or_none() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(None),
            ModelCapabilityProfile::Standard
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("")),
            ModelCapabilityProfile::Standard
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("  ")),
            ModelCapabilityProfile::Standard
        );
    }

    #[test]
    fn model_capability_standard_for_strong_models() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("gpt-4o")),
            ModelCapabilityProfile::Standard
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("claude-sonnet-4")),
            ModelCapabilityProfile::Standard
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("gemini-pro")),
            ModelCapabilityProfile::Standard
        );
    }

    #[test]
    fn model_capability_weak_for_haiku() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("claude-3-haiku-20240307")),
            ModelCapabilityProfile::Weak
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("anthropic/claude-3-haiku")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_weak_for_mini() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("gpt-4o-mini")),
            ModelCapabilityProfile::Weak
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("openai/gpt-4o-mini")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_weak_for_flash() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("gemini-1.5-flash")),
            ModelCapabilityProfile::Weak
        );
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("google/gemini-flash")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_weak_for_lite() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("qwen-lite")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_weak_for_small() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("llama-small")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_weak_for_nano() {
        assert_eq!(
            ModelCapabilityProfile::from_model_id(Some("gemini-nano")),
            ModelCapabilityProfile::Weak
        );
    }

    #[test]
    fn model_capability_from_resolved_model_prefers_resolved() {
        // resolved is weak → returns weak regardless of provider name
        assert_eq!(
            ModelCapabilityProfile::from_resolved_model("gpt-4o-mini", "gpt-4o"),
            ModelCapabilityProfile::Weak
        );
        // resolved is standard, provider is weak → returns weak
        assert_eq!(
            ModelCapabilityProfile::from_resolved_model("gpt-4o", "gpt-4o-mini"),
            ModelCapabilityProfile::Weak
        );
        // both standard → returns standard
        assert_eq!(
            ModelCapabilityProfile::from_resolved_model("gpt-4o", "claude-sonnet"),
            ModelCapabilityProfile::Standard
        );
    }

    #[test]
    fn loop_detection_policy_scales_counts_conservatively() {
        let baseline = LoopDetectionPolicy::for_profile(
            ContextProfile::LongTask,
            ModelCapabilityProfile::Standard,
        );
        assert_eq!(baseline.scale_count(4), 4);
        assert_eq!(
            baseline.scale_count(0),
            1,
            "a count threshold never reaches zero"
        );
        assert_eq!(baseline.scale_threshold(0.85), 0.85);

        let weak = LoopDetectionPolicy::for_profile(
            ContextProfile::Conversation,
            ModelCapabilityProfile::Weak,
        );
        assert_eq!(weak.scale_count(4), 6);
        assert_eq!(weak.scale_count(1), 2);
        assert!(weak.scale_threshold(0.85) > baseline.scale_threshold(0.85));
    }

    #[test]
    fn loop_detection_policy_excludes_canonical_structural_classes() {
        let policy = LoopDetectionPolicy::for_profile(
            ContextProfile::Conversation,
            ModelCapabilityProfile::Weak,
        );
        assert_eq!(policy.structural_exclusions, StructuralExclusionKind::ALL);
        assert_eq!(
            StructuralExclusionKind::ALL
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
            [
                "fenced_code_block",
                "table",
                "list",
                "heading",
                "block_quote",
                "horizontal_rule"
            ]
        );
        for kind in StructuralExclusionKind::ALL {
            assert!(policy.excludes(*kind));
        }
    }
}
