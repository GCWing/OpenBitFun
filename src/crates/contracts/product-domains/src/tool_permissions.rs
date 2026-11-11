//! Pure domain contracts and evaluation rules for tool-call permissions.
//!
//! This module intentionally has no runtime, persistence, or interaction
//! responsibilities. Product assembly and execution owners may consume these
//! decisions in later integration phases.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

/// The effect produced by a matching permission rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionEffect {
    Allow,
    Ask,
    Deny,
}

impl PermissionEffect {
    /// Combines independently owned policy decisions without allowing either
    /// side to widen the other.
    pub const fn most_restrictive(self, other: Self) -> Self {
        match (self, other) {
            (Self::Deny, _) | (_, Self::Deny) => Self::Deny,
            (Self::Ask, _) | (_, Self::Ask) => Self::Ask,
            (Self::Allow, Self::Allow) => Self::Allow,
        }
    }
}

/// An ordered action/resource permission rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRule {
    pub action: String,
    pub resource: String,
    pub effect: PermissionEffect,
}

impl PermissionRule {
    pub fn new(
        action: impl Into<String>,
        resource: impl Into<String>,
        effect: PermissionEffect,
    ) -> Self {
        Self {
            action: action.into(),
            resource: resource.into(),
            effect,
        }
    }
}

/// A rule list whose order is significant: later matching rules win.
pub type PermissionRuleset = Vec<PermissionRule>;

/// One independently evaluated restriction layer.
///
/// Rules keep their source-local last-match-wins behavior, while an unmatched
/// request defaults to `allow`. The layer is combined with the host policy and
/// other layers by taking the most restrictive result, so an `allow` here can
/// express an exception to an earlier rule in this layer without widening the
/// host policy.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionConstraintLayer {
    rules: PermissionRuleset,
}

impl PermissionConstraintLayer {
    pub fn new(rules: PermissionRuleset) -> Self {
        Self { rules }
    }

    pub fn rules(&self) -> &[PermissionRule] {
        &self.rules
    }

    pub fn into_rules(self) -> PermissionRuleset {
        self.rules
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

/// A resolved host policy plus independently owned restriction layers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResolvedPermissionPolicy {
    rules: PermissionRuleset,
    constraint_layers: Vec<PermissionConstraintLayer>,
}

impl ResolvedPermissionPolicy {
    pub fn new(
        rules: PermissionRuleset,
        constraint_layers: Vec<PermissionConstraintLayer>,
    ) -> Self {
        Self {
            rules,
            constraint_layers,
        }
    }

    pub fn rules(&self) -> &[PermissionRule] {
        &self.rules
    }

    pub fn constraint_layers(&self) -> &[PermissionConstraintLayer] {
        &self.constraint_layers
    }

    pub fn into_parts(self) -> (PermissionRuleset, Vec<PermissionConstraintLayer>) {
        (self.rules, self.constraint_layers)
    }
}

/// A validated runtime restriction inherited by a delegated child agent.
///
/// A ceiling is intentionally unable to carry `allow` rules: delegation may
/// preserve or tighten the parent's runtime restrictions, but it must never
/// widen the child's independently resolved policy.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PermissionRuntimeCeiling {
    rules: PermissionRuleset,
}

impl PermissionRuntimeCeiling {
    pub fn try_new(
        rules: PermissionRuleset,
    ) -> Result<Self, PermissionRuntimeCeilingValidationError> {
        if let Some((rule_index, rule)) = rules
            .iter()
            .enumerate()
            .find(|(_, rule)| rule.effect == PermissionEffect::Allow)
        {
            return Err(PermissionRuntimeCeilingValidationError {
                rule_index,
                action: rule.action.clone(),
                resource: rule.resource.clone(),
            });
        }

        Ok(Self { rules })
    }

    pub fn rules(&self) -> &[PermissionRule] {
        &self.rules
    }

    pub fn into_rules(self) -> PermissionRuleset {
        self.rules
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

/// Validation failure returned when a runtime ceiling attempts to widen
/// delegated permissions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRuntimeCeilingValidationError {
    pub rule_index: usize,
    pub action: String,
    pub resource: String,
}

impl fmt::Display for PermissionRuntimeCeilingValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "permission runtime ceiling rule {} cannot allow action '{}' on resource '{}'",
            self.rule_index, self.action, self.resource
        )
    }
}

impl std::error::Error for PermissionRuntimeCeilingValidationError {}

/// Product-facing baseline for static tool permission rules.
///
/// Presets expand into ordinary rules and never bypass permission evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPolicyPreset {
    Ask,
    #[default]
    FullAccess,
}

impl PermissionPolicyPreset {
    pub fn baseline_rules(self) -> PermissionRuleset {
        match self {
            // Later matches win, so sensitive read exceptions follow the broad
            // low-risk allow and .env.example follows the .env.* guard.
            Self::Ask => vec![
                PermissionRule::new("*", "*", PermissionEffect::Ask),
                PermissionRule::new("read", "*", PermissionEffect::Allow),
                PermissionRule::new("read", "*/.env", PermissionEffect::Ask),
                PermissionRule::new("read", "*/.env.*", PermissionEffect::Ask),
                PermissionRule::new("read", "*/.env.example", PermissionEffect::Allow),
                PermissionRule::new("websearch", "*", PermissionEffect::Allow),
                PermissionRule::new("webfetch", "*", PermissionEffect::Allow),
                PermissionRule::new("task", "*", PermissionEffect::Allow),
                PermissionRule::new("skill", "*", PermissionEffect::Allow),
                PermissionRule::new("git", "git status *", PermissionEffect::Allow),
                PermissionRule::new("git", "git diff *", PermissionEffect::Allow),
                PermissionRule::new("git", "git log *", PermissionEffect::Allow),
                PermissionRule::new("git", "git show *", PermissionEffect::Allow),
                PermissionRule::new("git", "git blame *", PermissionEffect::Allow),
                PermissionRule::new("git", "git rev-parse *", PermissionEffect::Allow),
                PermissionRule::new("git", "git describe *", PermissionEffect::Allow),
                PermissionRule::new("git", "git shortlog *", PermissionEffect::Allow),
                PermissionRule::new("git", "git branch", PermissionEffect::Allow),
            ],
            Self::FullAccess => vec![PermissionRule::new("*", "*", PermissionEffect::Allow)],
        }
    }
}

/// Static user-level policy. Custom rules are evaluated after the preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PermissionPolicyConfig {
    pub preset: PermissionPolicyPreset,
    pub rules: PermissionRuleset,
}

/// User interaction preferences applied only after static policy evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PermissionInteractionConfig {
    pub auto_approve_ask: bool,
}

/// The strategy used after static permission evaluation leaves a request in
/// the `Ask` state.  This is deliberately separate from the static policy:
/// approval can never widen a policy `Deny` or a runtime constraint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalStrategy {
    #[default]
    Interactive,
    ImmediateAllow,
    Model,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalModelKind {
    #[default]
    Chat,
    Decision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalOnAsk {
    #[default]
    User,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalOnError {
    #[default]
    Ask,
    Reject,
}

/// Model approval configuration. Defaults are fail-closed, so an existing
/// `tool_permissions` record without this section remains valid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PermissionApprovalConfig {
    pub strategy: PermissionApprovalStrategy,
    pub model_kind: PermissionApprovalModelKind,
    pub chat_model_id: String,
    pub timeout_ms: u64,
    pub on_ask: PermissionApprovalOnAsk,
    pub on_error: PermissionApprovalOnError,
}

impl Default for PermissionApprovalConfig {
    fn default() -> Self {
        Self {
            strategy: PermissionApprovalStrategy::Interactive,
            model_kind: PermissionApprovalModelKind::Chat,
            chat_model_id: "fast".to_string(),
            timeout_ms: 30_000,
            on_ask: PermissionApprovalOnAsk::User,
            on_error: PermissionApprovalOnError::Ask,
        }
    }
}

impl PermissionApprovalConfig {
    pub fn is_default(value: &Self) -> bool {
        value == &Self::default()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.timeout_ms == 0 || self.timeout_ms > 300_000 {
            return Err("permission approval timeout_ms must be between 1 and 300000".into());
        }
        if matches!(self.strategy, PermissionApprovalStrategy::Model) {
            if self.model_kind == PermissionApprovalModelKind::Chat
                && self.chat_model_id.trim().is_empty()
            {
                return Err("chat approval strategy requires a chat_model_id".into());
            }
        }
        Ok(())
    }
}

/// The interaction mode a dialog turn runs with.
///
/// This is the single user-facing selection behind the permission control. It
/// projects onto the two independent knobs the runtime already owns: the static
/// policy preset and the interactive auto-answer preference. Keeping both knobs
/// derived from one value prevents meaningless combinations such as full access
/// plus auto approval.
///
/// A mode never widens the resolved ruleset beyond its preset baseline. Project,
/// agent, enforced, and constraint layers are evaluated after the baseline, so a
/// `FullAccess` turn is still bounded by every deny those layers own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Every `ask` decision is raised to the user.
    #[default]
    Ask,
    /// Static policy is unchanged; runtime automatic approval evaluates each
    /// `ask` request before deciding whether to allow it once or ask the user.
    AutoApprove,
    /// The policy baseline allows everything the later layers do not deny.
    FullAccess,
}

impl PermissionMode {
    pub const fn preset(self) -> PermissionPolicyPreset {
        match self {
            Self::Ask | Self::AutoApprove => PermissionPolicyPreset::Ask,
            Self::FullAccess => PermissionPolicyPreset::FullAccess,
        }
    }

    pub const fn auto_approve_ask(self) -> bool {
        matches!(self, Self::AutoApprove)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AutoApprove => "auto_approve",
            Self::FullAccess => "full_access",
        }
    }

    /// Parses a wire value, accepting the surface aliases already used by the
    /// desktop control and the CLI approval flags.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask" => Some(Self::Ask),
            "auto" | "auto_approve" | "autoapprove" => Some(Self::AutoApprove),
            "full_access" | "fullaccess" | "full" => Some(Self::FullAccess),
            _ => None,
        }
    }

    /// Derives the mode a stored configuration represents.
    ///
    /// `full_access` wins over the auto-approve preference: the preset already
    /// resolves every `ask` to `allow`, so auto-answering is not observable.
    pub const fn from_config(config: &ToolPermissionConfig) -> Self {
        match config.policy.preset {
            PermissionPolicyPreset::FullAccess => Self::FullAccess,
            PermissionPolicyPreset::Ask if config.interaction.auto_approve_ask => Self::AutoApprove,
            PermissionPolicyPreset::Ask => Self::Ask,
        }
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Deserializes an optional mode without letting an unrecognized value fail the
/// whole record it belongs to.
///
/// Persisted carriers must use this. A file written by a newer build can hold a
/// mode this build has never heard of, and the strict derive would turn that
/// single field into a parse failure for the entire session state — the failure
/// mode that made incompatible model settings block startup before.
///
/// An unreadable value degrades to `None`, which means "follow the user-level
/// default". That is the same resolution a session that never chose a mode
/// gets, so the fallback lands on a value the user configured themselves rather
/// than on a mode nobody asked for. The selection is intentionally dropped
/// rather than preserved: a value this build cannot evaluate must not decide
/// how tools get authorized.
pub fn deserialize_optional_permission_mode<'de, D>(
    deserializer: D,
) -> Result<Option<PermissionMode>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(Value::as_str)
        .and_then(PermissionMode::parse))
}

/// The layer that owns the effective mode of one dialog turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionModeSource {
    /// The user-level default applied to sessions that never chose a mode.
    GlobalDefault,
    /// A workspace-level default. Reserved: no surface writes this layer yet.
    Project,
    /// The session's own selection.
    Session,
    /// A single submission's one-off selection.
    Turn,
}

/// Ordered mode inputs. Later layers win; every layer is optional except the
/// global default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionModeLayers {
    pub global_default: PermissionMode,
    pub project: Option<PermissionMode>,
    pub session: Option<PermissionMode>,
    pub turn: Option<PermissionMode>,
}

impl PermissionModeLayers {
    pub const fn new(global_default: PermissionMode) -> Self {
        Self {
            global_default,
            project: None,
            session: None,
            turn: None,
        }
    }

    pub const fn with_session(mut self, session: Option<PermissionMode>) -> Self {
        self.session = session;
        self
    }

    pub const fn with_turn(mut self, turn: Option<PermissionMode>) -> Self {
        self.turn = turn;
        self
    }
}

/// One effective mode plus the layer that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPermissionMode {
    pub mode: PermissionMode,
    pub source: PermissionModeSource,
}

/// Resolves `turn -> session -> project -> global default`.
pub const fn resolve_permission_mode(layers: PermissionModeLayers) -> ResolvedPermissionMode {
    if let Some(mode) = layers.turn {
        return ResolvedPermissionMode {
            mode,
            source: PermissionModeSource::Turn,
        };
    }
    if let Some(mode) = layers.session {
        return ResolvedPermissionMode {
            mode,
            source: PermissionModeSource::Session,
        };
    }
    if let Some(mode) = layers.project {
        return ResolvedPermissionMode {
            mode,
            source: PermissionModeSource::Project,
        };
    }
    ResolvedPermissionMode {
        mode: layers.global_default,
        source: PermissionModeSource::GlobalDefault,
    }
}

/// Root configuration contract for the `tool_permissions` config section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ToolPermissionConfig {
    pub policy: PermissionPolicyConfig,
    pub interaction: PermissionInteractionConfig,
    #[serde(skip_serializing_if = "PermissionApprovalConfig::is_default")]
    pub approval: PermissionApprovalConfig,
}

/// Ordered inputs used to resolve one effective static permission ruleset.
///
/// Product defaults are the initial baseline. The user preset and global
/// rules follow, then project and agent overrides. Enforced rules remain last
/// so user-level full access cannot loosen product or organization limits.
#[derive(Debug, Clone, Copy)]
pub struct PermissionPolicyLayers<'a> {
    pub product_defaults: &'a [PermissionRule],
    pub global: &'a PermissionPolicyConfig,
    /// Effective interaction mode for this resolution. `None` keeps the stored
    /// global preset, which is the behavior of callers that never resolved a
    /// session- or turn-scoped mode.
    pub mode: Option<PermissionMode>,
    pub project: &'a [PermissionRule],
    pub agent: &'a [PermissionRule],
    pub enforced: &'a [PermissionRule],
}

/// Ordered inputs used to derive a delegated child agent's permission policy.
///
/// The child keeps the ordinary global, project, and child-profile layers.
/// The parent's validated runtime ceiling follows the child profile, while
/// product or organization enforced rules remain authoritative at the end.
#[derive(Debug, Clone, Copy)]
pub struct ChildPermissionPolicyLayers<'a> {
    pub product_defaults: &'a [PermissionRule],
    pub global: &'a PermissionPolicyConfig,
    /// Effective interaction mode inherited from the delegating turn. The
    /// parent runtime ceiling is still applied on top, so an inherited
    /// `FullAccess` cannot widen what the parent restricted.
    pub mode: Option<PermissionMode>,
    pub project: &'a [PermissionRule],
    pub child_agent: &'a [PermissionRule],
    pub parent_runtime_ceiling: &'a PermissionRuntimeCeiling,
    pub enforced: &'a [PermissionRule],
}

/// Expands the configured preset and merges every static rule layer in its
/// security-significant evaluation order.
pub fn resolve_permission_policy(layers: PermissionPolicyLayers<'_>) -> ResolvedPermissionPolicy {
    let baseline = effective_preset(layers.mode, layers.global).baseline_rules();
    ResolvedPermissionPolicy::new(
        merge_permission_rule_layers(&[
            layers.product_defaults,
            &baseline,
            &layers.global.rules,
            layers.project,
            layers.agent,
            layers.enforced,
        ]),
        Vec::new(),
    )
}

/// Resolves a delegated child policy and evaluates the parent ceiling as an
/// independent constraint that cannot widen the child's own policy.
pub fn resolve_child_permission_policy(
    layers: ChildPermissionPolicyLayers<'_>,
) -> ResolvedPermissionPolicy {
    let baseline = effective_preset(layers.mode, layers.global).baseline_rules();
    ResolvedPermissionPolicy::new(
        merge_permission_rule_layers(&[
            layers.product_defaults,
            &baseline,
            &layers.global.rules,
            layers.project,
            layers.child_agent,
            layers.enforced,
        ]),
        vec![PermissionConstraintLayer::new(
            layers.parent_runtime_ceiling.rules().to_vec(),
        )],
    )
}

/// Identifies the boundary that originated a permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PermissionRequestSourceKind {
    ToolCall,
    Provider,
    Extension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestSource {
    pub kind: PermissionRequestSourceKind,
    pub identity: String,
}

/// Identifies the parent Task invocation that owns interaction for a
/// permission request raised by a subagent.
///
/// The request's own session and tool-call IDs continue to identify the
/// concrete child execution. These fields only project the existing
/// delegation relationship to interactive surfaces and audit consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionDelegationContext {
    pub parent_session_id: String,
    /// The parent dialog turn when it is available from the persisted
    /// subagent lineage. Older child sessions may retain only the parent
    /// session and Task call identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_dialog_turn_id: Option<String>,
    pub parent_tool_call_id: String,
    pub subagent_type: String,
}

/// A process-local permission request projected to an interactive surface.
///
/// Resource and display values stored here must already be safe for user
/// presentation and audit persistence. Raw secrets and unrestricted command
/// payloads must remain outside this DTO.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    /// Model round that owns this permission request.
    ///
    /// OpenBitFun-created tool requests always provide this value so interactive
    /// surfaces can keep requests from one model round together.
    pub round_id: String,
    /// Stable permission order within `round_id`.
    ///
    /// This is derived from the model tool-call order before tools are
    /// scheduled. Requests produced by one tool share the same order when
    /// they cannot be counted before execution; registration order remains a
    /// deterministic tie-breaker in that case.
    pub order: u32,
    /// Provider/tool-stream call ID used to correlate this request with one
    /// concrete tool invocation in interactive surfaces.
    ///
    /// This is deliberately separate from `request_id`: one tool invocation
    /// may produce more than one permission request, while some providers or
    /// extensions may not expose a call ID at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// User-presentable logical workspace root for this permission request.
    ///
    /// This is display-only and must not be used as a persistence or grant
    /// identity. `project_id` remains the stable authorization scope key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub project_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub action: String,
    pub resources: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub save_resources: Vec<String>,
    pub source: PermissionRequestSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<PermissionDelegationContext>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub display_metadata: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum PermissionReply {
    Once,
    /// Approve this invocation once with a shallow object patch to its input.
    OnceWithInput {
        updated_input: Value,
    },
    Always,
    Reject {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PermissionReplySource {
    User,
    ImmediateAllow,
    Model,
    ModelAsk,
    ModelDeny,
    /// Compatibility value for old clients and persisted audit records.
    AutoApprove,
    System,
}

/// Process-local lifecycle event projected to interactive permission surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PermissionRequestEvent {
    Asked {
        request: PermissionRequest,
    },
    Replied {
        request_id: String,
        reply: PermissionReply,
        source: PermissionReplySource,
    },
    Cancelled {
        request_id: String,
        reason: String,
    },
}

/// A remembered allow scoped by project, action, and resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrant {
    pub project_id: String,
    pub action: String,
    pub resource: String,
    pub created_at_ms: i64,
}

impl PermissionGrant {
    pub fn key(&self) -> PermissionGrantKey {
        PermissionGrantKey {
            project_id: self.project_id.clone(),
            action: self.action.clone(),
            resource: self.resource.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrantKey {
    pub project_id: String,
    pub action: String,
    pub resource: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum PermissionAuditEvent {
    Requested,
    Replied {
        reply: PermissionReply,
        source: PermissionReplySource,
    },
    Cancelled {
        reason: String,
    },
}

/// An append-only audit fact containing only presentation-safe request data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PermissionAuditRecord {
    pub audit_id: String,
    pub request: PermissionRequest,
    pub event: PermissionAuditEvent,
    pub timestamp_ms: i64,
}

/// Controls resource matching for local or remote workspace path semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionResourceCaseSensitivity {
    Sensitive,
    Insensitive,
}

/// Pure evaluator for ordered tool permission rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionEvaluator {
    resource_case_sensitivity: PermissionResourceCaseSensitivity,
}

impl PermissionEvaluator {
    pub const fn new(resource_case_sensitivity: PermissionResourceCaseSensitivity) -> Self {
        Self {
            resource_case_sensitivity,
        }
    }

    pub const fn case_sensitive() -> Self {
        Self::new(PermissionResourceCaseSensitivity::Sensitive)
    }

    pub const fn windows_compatible() -> Self {
        Self::new(PermissionResourceCaseSensitivity::Insensitive)
    }

    pub const fn for_current_platform() -> Self {
        if cfg!(windows) {
            Self::windows_compatible()
        } else {
            Self::case_sensitive()
        }
    }

    /// Returns the effect of the last rule matching both action and resource.
    /// Unmatched requests default to `ask`.
    pub fn evaluate_resource(
        &self,
        action: &str,
        resource: &str,
        rules: &[PermissionRule],
    ) -> PermissionEffect {
        rules
            .iter()
            .rev()
            .find(|rule| {
                wildcard_matches(
                    action,
                    &rule.action,
                    PermissionResourceCaseSensitivity::Sensitive,
                ) && wildcard_matches(resource, &rule.resource, self.resource_case_sensitivity)
            })
            .map(|rule| rule.effect)
            .unwrap_or(PermissionEffect::Ask)
    }

    /// Evaluates the host policy and every independent restriction layer.
    pub fn evaluate_policy_resource(
        &self,
        action: &str,
        resource: &str,
        policy: &ResolvedPermissionPolicy,
    ) -> PermissionEffect {
        policy.constraint_layers().iter().fold(
            self.evaluate_resource(action, resource, policy.rules()),
            |effect, layer| {
                let constraint = self.evaluate_constraint_resource(action, resource, layer);
                effect.most_restrictive(constraint)
            },
        )
    }

    /// Evaluates one restriction layer. An unmatched request is unrestricted
    /// by that layer and therefore defaults to `allow`.
    pub fn evaluate_constraint_resource(
        &self,
        action: &str,
        resource: &str,
        layer: &PermissionConstraintLayer,
    ) -> PermissionEffect {
        layer
            .rules()
            .iter()
            .rev()
            .find(|rule| {
                wildcard_matches(
                    action,
                    &rule.action,
                    PermissionResourceCaseSensitivity::Sensitive,
                ) && wildcard_matches(resource, &rule.resource, self.resource_case_sensitivity)
            })
            .map(|rule| rule.effect)
            .unwrap_or(PermissionEffect::Allow)
    }

    /// Evaluates every resource in one tool call atomically.
    ///
    /// Any denied resource denies the call. Otherwise any resource that still
    /// requires confirmation makes the call ask. Only an all-allow result is
    /// allowed. A request without resources fails closed as `ask`.
    pub fn evaluate_resources(
        &self,
        action: &str,
        resources: &[String],
        rules: &[PermissionRule],
    ) -> PermissionEffect {
        if resources.is_empty() {
            return PermissionEffect::Ask;
        }

        let mut aggregate = PermissionEffect::Allow;
        for resource in resources {
            match self.evaluate_resource(action, resource, rules) {
                PermissionEffect::Deny => return PermissionEffect::Deny,
                PermissionEffect::Ask => aggregate = PermissionEffect::Ask,
                PermissionEffect::Allow => {}
            }
        }
        aggregate
    }
}

impl Default for PermissionEvaluator {
    fn default() -> Self {
        Self::for_current_platform()
    }
}

/// Picks the preset baseline a resolution should expand.
fn effective_preset(
    mode: Option<PermissionMode>,
    global: &PermissionPolicyConfig,
) -> PermissionPolicyPreset {
    mode.map_or(global.preset, PermissionMode::preset)
}

/// Merges global, project, and agent rule layers without changing their order.
pub fn merge_permission_rule_layers(layers: &[&[PermissionRule]]) -> PermissionRuleset {
    let capacity = layers.iter().map(|layer| layer.len()).sum();
    let mut merged = Vec::with_capacity(capacity);
    for layer in layers {
        merged.extend_from_slice(layer);
    }
    merged
}

/// Matches `*` and `?` wildcards after normalizing path separators.
///
/// Like the OpenCode V2 reference, a pattern ending in ` *` also matches the
/// prefix without a trailing argument (for example, `git *` matches `git`).
pub fn wildcard_matches(
    input: &str,
    pattern: &str,
    case_sensitivity: PermissionResourceCaseSensitivity,
) -> bool {
    let input = normalize_wildcard_value(input, case_sensitivity);
    let pattern = normalize_wildcard_value(pattern, case_sensitivity);

    if pattern
        .strip_suffix(" *")
        .is_some_and(|prefix| input == prefix)
    {
        return true;
    }

    glob_matches(&input, &pattern)
}

fn normalize_wildcard_value(
    value: &str,
    case_sensitivity: PermissionResourceCaseSensitivity,
) -> String {
    let normalized = value.replace('\\', "/");
    match case_sensitivity {
        PermissionResourceCaseSensitivity::Sensitive => normalized,
        PermissionResourceCaseSensitivity::Insensitive => normalized.to_lowercase(),
    }
}

fn glob_matches(input: &str, pattern: &str) -> bool {
    let input: Vec<char> = input.chars().collect();
    let mut previous = vec![false; input.len() + 1];
    previous[0] = true;

    for pattern_char in pattern.chars() {
        let mut current = vec![false; input.len() + 1];
        if pattern_char == '*' {
            current[0] = previous[0];
        }

        for (index, input_char) in input.iter().enumerate() {
            current[index + 1] = match pattern_char {
                '*' => previous[index + 1] || current[index],
                '?' => previous[index],
                literal => previous[index] && literal == *input_char,
            };
        }
        previous = current;
    }

    previous[input.len()]
}
