//! Portable control-resource facts. Native resources and permission decisions live in hosts.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlMode {
    Observe,
    #[default]
    Background,
    Foreground,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ControlSnapshot {
    pub supported: bool,
    pub generation: u64,
    pub owner: Option<String>,
    pub mode: ControlMode,
    pub state: String,
    pub target: Option<String>,
    /// Changes on every rebind, including A -> B -> A in one generation.
    /// Older peers omit this and retain their existing target comparison.
    pub target_revision: u64,
    pub action: Option<String>,
    pub sequence: u64,
    pub reason: Option<String>,
    pub pointer: Option<ControlPointer>,
    pub capabilities: Vec<String>,
    /// Missing on older hosts. A native share grants observation first; input
    /// is authorized separately by the driving user, never by a tool call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sharing: Option<ControlSharing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_observation: Option<BackgroundObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundObservation {
    pub sequence: u64,
    pub foreground_unchanged: bool,
    pub cursor_unchanged: Option<bool>,
    pub window_order_unchanged: Option<bool>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlSharing {
    pub phase: SharingPhase,
    pub requested_mode: ControlMode,
    pub target_label: Option<String>,
    pub control_enabled: bool,
    pub authorization_revision: u64,
    #[serde(default)]
    pub remembered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharingPhase {
    Selecting,
    Starting,
    Shared,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareTarget {
    /// Native identity. Titles are labels, never authorization identities.
    pub id: String,
    /// Opaque selection reference bound to the process lifetime at discovery.
    #[serde(default)]
    pub selection_id: String,
    #[serde(default)]
    pub unavailable_reason: Option<String>,
    pub pid: Option<i32>,
    pub window_id: Option<u64>,
    pub application: String,
    pub title: String,
    pub bundle_id: Option<String>,
    pub background_pointer: bool,
    pub background_semantic: bool,
    pub selection_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlPointer {
    pub x: f64,
    pub y: f64,
    pub click: bool,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub occurred_at_ms: u64,
    #[serde(default)]
    pub last_click: Option<ControlClick>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlClick {
    pub x: f64,
    pub y: f64,
    pub sequence: u64,
    pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlStartRequest {
    #[serde(default)]
    pub mode: ControlMode,
}

/// Admission facts shared by the tool, native lease and read-only retry policy.
/// Unknown names have no policy and must fail before acquiring any resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlActionPolicy {
    pub observation: bool,
    pub foreground: bool,
    pub target: bool,
    pub lease: bool,
}

impl ControlActionPolicy {
    pub fn for_action(action: &str) -> Option<Self> {
        let (observation, foreground, target, lease) = match action {
            "start_control" | "stop_control" => (false, false, false, false),
            "control_status" | "list_apps" | "list_windows" | "list_displays" | "get_os_info" => {
                (true, false, false, false)
            }
            "wait" | "clipboard_get" => (true, false, false, true),
            "screenshot"
            | "describe_screen"
            | "locate"
            | "get_app_state"
            | "get_app_shortcuts"
            | "app_wait_for"
            | "build_interactive_view"
            | "build_visual_mark_view" => (true, false, true, true),
            "app_click"
            | "app_type_text"
            | "app_scroll"
            | "app_key_chord"
            | "app_drag"
            | "app_batch"
            | "interactive_click"
            | "interactive_type_text"
            | "interactive_scroll"
            | "visual_click" => (false, false, true, true),
            "clipboard_set" => (false, false, false, true),
            "open_app" => (false, false, false, true),
            "activate_app" => (false, true, true, true),
            "run_apple_script" | "run_script" | "open_url" | "open_file" => {
                (false, true, false, true)
            }
            "click" | "mouse_move" | "pointer_move_rel" | "scroll" | "drag" | "key_chord"
            | "type_text" | "paste" | "click_target" | "move_to_target" | "click_element"
            | "move_to_text" | "focus_display" => (false, true, true, true),
            _ => return None,
        };
        Some(Self {
            observation,
            foreground,
            target,
            lease,
        })
    }
}

pub fn action_requires_foreground(action: &str) -> bool {
    ControlActionPolicy::for_action(action).is_some_and(|policy| policy.foreground)
}

pub fn action_is_observation(action: &str) -> bool {
    ControlActionPolicy::for_action(action).is_some_and(|policy| policy.observation)
}

/// Identity of an observation binding, separate from the input action lease.
/// It is an in-process fact, never authority supplied by a model/controller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationScope {
    pub generation: u64,
    pub target_revision: u64,
    pub target: Option<String>,
}

impl ObservationScope {
    pub fn from_control(control: &ControlSnapshot) -> Self {
        Self {
            generation: control.generation,
            target_revision: control.target_revision,
            target: control.target.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_payloads_do_not_grant_control() {
        let old: ControlSnapshot = serde_json::from_str("{}").unwrap();
        assert!(!old.supported);
        assert_eq!(old.target_revision, 0);
        assert!(old.owner.is_none());
        let round: ControlSnapshot =
            serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        assert!(!round.supported);
        let pointer: ControlPointer =
            serde_json::from_str(r#"{"x":1.0,"y":2.0,"click":false}"#).unwrap();
        assert_eq!(pointer.sequence, 0);
        assert!(pointer.last_click.is_none());
        let pointer: ControlPointer =
            serde_json::from_value(serde_json::to_value(pointer).unwrap()).unwrap();
        assert_eq!((pointer.x, pointer.y), (1.0, 2.0));
        assert_eq!(
            serde_json::from_str::<ControlStartRequest>("{}")
                .unwrap()
                .mode,
            ControlMode::Background
        );
    }
    #[test]
    fn seat_actions_never_claim_background_semantics() {
        for action in ["paste", "drag", "click_target", "key_chord"] {
            assert!(action_requires_foreground(action));
            assert!(!action_is_observation(action));
        }
        assert!(!action_requires_foreground("app_click"));
        assert!(!action_requires_foreground("open_app"));
        assert!(action_is_observation("get_app_state"));
    }

    #[test]
    fn unknown_actions_cannot_acquire_a_default_input_policy() {
        assert!(ControlActionPolicy::for_action("native_surprise").is_none());
        let observation = ControlActionPolicy::for_action("get_app_state").unwrap();
        assert!(observation.observation && observation.target && observation.lease);
        for action in ["list_apps", "list_windows"] {
            let discovery = ControlActionPolicy::for_action(action).unwrap();
            assert!(discovery.observation && !discovery.target && !discovery.lease);
        }
    }

    #[test]
    fn clipboard_access_requires_a_lease_without_foreground_or_window_input() {
        for action in ["clipboard_get", "clipboard_set"] {
            let policy = ControlActionPolicy::for_action(action).unwrap();
            assert!(policy.lease);
            assert!(!policy.foreground && !policy.target);
            assert_eq!(policy.observation, action == "clipboard_get");
        }
    }

    #[test]
    fn returning_to_the_same_target_does_not_restore_old_observation_scope() {
        let mut control = ControlSnapshot {
            target: Some("pid:1/window:2".into()),
            ..Default::default()
        };
        let old = ObservationScope::from_control(&control);
        control.target_revision += 2;
        assert_ne!(old, ObservationScope::from_control(&control));
    }
}
