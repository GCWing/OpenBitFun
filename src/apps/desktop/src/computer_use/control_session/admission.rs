//! Deterministic resource admission. No OS handles, threads, timers or IO.
//! Native cleanup is performed by the desktop facade using the returned epoch.

use openbitfun_agent_tools::computer_use_control::{
    ControlActionPolicy, ControlMode, ControlSharing, ControlSnapshot, SharingPhase,
};

pub(super) const FOREGROUND_REQUIRED: &str = "[FOREGROUND_REQUIRED] This global action uses the human's foreground application or cursor. Keep background control and use app_click, app_type_text, app_key_chord, app_scroll or app_drag with observed application/window targets. Do not request foreground takeover to recover from this error. Use start_control with mode=foreground only when the user explicitly requests taking over the visible desktop.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ControlToken {
    pub(super) generation: u64,
    pub(super) sequence: u64,
    pub(super) input: bool,
    authorization_revision: u64,
    leased: bool,
}

impl ControlToken {
    #[cfg(target_os = "macos")]
    pub(crate) fn generation(self) -> u64 {
        self.generation
    }

    pub(super) const fn invalid() -> Self {
        Self {
            generation: u64::MAX,
            sequence: u64::MAX,
            input: false,
            authorization_revision: u64::MAX,
            leased: true,
        }
    }
}

pub(super) struct Admission<E> {
    pub(super) snapshot: ControlSnapshot,
    pub(super) executor: Option<E>,
    pub(super) busy: bool,
    cleaning: bool,
    last_revoked_generation: Option<u64>,
}

impl<E> Default for Admission<E> {
    fn default() -> Self {
        Self {
            snapshot: ControlSnapshot::default(),
            executor: None,
            busy: false,
            cleaning: false,
            last_revoked_generation: None,
        }
    }
}

impl<E: Copy + PartialEq> Admission<E> {
    pub(super) fn active(&self) -> bool {
        self.snapshot.state == "active" && !self.cleaning
    }

    pub(super) fn token(&self, executor: E) -> ControlToken {
        ControlToken {
            generation: self.snapshot.generation,
            sequence: self.snapshot.sequence,
            input: self.busy
                && self.executor == Some(executor)
                && self
                    .snapshot
                    .action
                    .as_deref()
                    .and_then(ControlActionPolicy::for_action)
                    .is_some_and(|policy| !policy.observation),
            leased: self.busy,
            authorization_revision: self.authorization_revision(),
        }
    }

    pub(super) fn matches_token(&self, token: ControlToken) -> bool {
        token.generation == self.snapshot.generation
            && token.sequence == self.snapshot.sequence
            && (!token.leased || self.busy)
            && token.authorization_revision == self.authorization_revision()
    }

    fn authorization_revision(&self) -> u64 {
        self.snapshot
            .sharing
            .as_ref()
            .map_or(0, |sharing| sharing.authorization_revision)
    }

    /// Optional manual sharing has its own selection and input grant. Normal
    /// Agent sessions use begin_start/admit and never enter this workflow.
    pub(super) fn request_share(&mut self, owner: &str, mode: ControlMode) -> Result<(), String> {
        if self.snapshot.owner.as_deref() != Some(owner) || self.busy || self.cleaning {
            return Err("[CONTROL_BUSY] Another task or action owns desktop control".into());
        }
        self.snapshot.mode = ControlMode::Observe;
        self.snapshot.state = "awaiting_share".into();
        self.snapshot.sharing = Some(ControlSharing {
            phase: SharingPhase::Selecting,
            requested_mode: mode,
            target_label: None,
            control_enabled: false,
            authorization_revision: 0,
            remembered: false,
            grant_note: None,
        });
        Ok(())
    }

    pub(super) fn begin_share(
        &mut self,
        generation: u64,
        target: String,
        label: String,
        mode: ControlMode,
    ) -> Result<(), String> {
        if self.snapshot.generation != generation
            || self.busy
            || self.cleaning
            || self
                .snapshot
                .sharing
                .as_ref()
                .is_none_or(|sharing| sharing.phase != SharingPhase::Selecting)
        {
            return Err(
                "[CONTROL_STALE] Start a new share selection before selecting a target".into(),
            );
        }
        self.bind(target)?;
        let sharing = self
            .snapshot
            .sharing
            .as_mut()
            .ok_or("[SHARE_REQUIRED] No share request")?;
        sharing.phase = SharingPhase::Starting;
        sharing.requested_mode = mode;
        sharing.target_label = Some(label);
        self.snapshot.mode = ControlMode::Observe;
        self.snapshot.state = "active".into();
        Ok(())
    }

    pub(super) fn finish_share(&mut self, generation: u64, revision: u64) -> Result<(), String> {
        if self.snapshot.generation != generation
            || self.snapshot.target_revision != revision
            || !self.active()
        {
            return Err("[CONTROL_STALE] Share was stopped during native capture".into());
        }
        let sharing = self
            .snapshot
            .sharing
            .as_mut()
            .ok_or("[SHARE_REQUIRED] No share request")?;
        if sharing.phase != SharingPhase::Starting {
            return Err("[CONTROL_STALE] Native share completion is no longer current".into());
        }
        sharing.phase = SharingPhase::Shared;
        Ok(())
    }

    pub(super) fn set_control(
        &mut self,
        generation: u64,
        target_revision: u64,
        expected_revision: u64,
        enabled: bool,
    ) -> Result<(), String> {
        if self.snapshot.generation != generation
            || self.snapshot.target_revision != target_revision
            || !self.active()
        {
            return Err("[CONTROL_STALE] Share changed before authorization".into());
        }
        if enabled && self.busy {
            return Err(
                "[CONTROL_BUSY] Wait for the current action before granting control".into(),
            );
        }
        let sharing = self
            .snapshot
            .sharing
            .as_mut()
            .ok_or("[SHARE_REQUIRED] This host has no user-selected share")?;
        if sharing.phase != SharingPhase::Shared
            || sharing.authorization_revision != expected_revision
        {
            return Err("[CONTROL_STALE] Authorization request is stale".into());
        }
        if enabled && sharing.requested_mode == ControlMode::Observe {
            return Err("[CONTROL_OBSERVE_ONLY] The user selected observation only".into());
        }
        sharing.authorization_revision = sharing
            .authorization_revision
            .checked_add(1)
            .ok_or("[CONTROL_FAILED] Authorization revision exhausted")?;
        sharing.control_enabled = enabled;
        self.snapshot.mode = if enabled {
            sharing.requested_mode
        } else {
            ControlMode::Observe
        };
        self.snapshot.pointer = None;
        Ok(())
    }

    pub(super) fn shared_target_allowed(&self, target: &str) -> Result<(), String> {
        if self.snapshot.sharing.is_some() && self.snapshot.target.as_deref() != Some(target) {
            return Err(
                "[SHARED_TARGET_ONLY] This operation does not address the user's shared window"
                    .into(),
            );
        }
        Ok(())
    }

    pub(super) fn check(&self, token: Option<ControlToken>) -> Result<(), String> {
        if !self.active() {
            return Err("[CONTROL_STOPPED] Start a new control session before capturing".into());
        }
        if token.is_some_and(|token| !self.matches_token(token)) {
            return Err("[CONTROL_STALE] This worker belongs to an earlier action".into());
        }
        Ok(())
    }

    pub(super) fn check_observer(
        &self,
        execution: E,
        token: Option<ControlToken>,
    ) -> Result<(), String> {
        self.check(token)?;
        if token.is_none() && self.busy && self.executor != Some(execution) {
            return Err("[CONTROL_BUSY] Observation belongs to another action; native workers must carry the original lease".into());
        }
        Ok(())
    }

    pub(super) fn owns_cleanup(&self, ticket: u64) -> bool {
        self.cleaning && self.snapshot.generation == ticket
    }

    pub(super) fn check_input(&self, token: ControlToken) -> Result<(), String> {
        self.check(Some(token))?;
        if !self.busy || !token.input {
            return Err("[CONTROL_OBSERVE_ONLY] This action has no input lease".into());
        }
        if self.snapshot.mode == ControlMode::Observe {
            return Err("[CONTROL_OBSERVE_ONLY] Observation does not authorize input".into());
        }
        if self.snapshot.sharing.as_ref().is_some_and(|sharing| {
            !sharing.control_enabled || sharing.phase != SharingPhase::Shared
        }) {
            return Err(
                "[CONTROL_NOT_GRANTED] The user has not authorized input for this share".into(),
            );
        }
        Ok(())
    }

    pub(super) fn begin_start(&mut self, owner: &str, mode: ControlMode) -> Result<u64, String> {
        if owner.trim().is_empty() {
            return Err("[CONTROL_OWNER_REQUIRED] A runtime session is required".into());
        }
        if self.busy
            || self.cleaning
            || ((self.active() || self.snapshot.state == "awaiting_share")
                && self.snapshot.owner.as_deref() != Some(owner))
        {
            return Err("[CONTROL_BUSY] Another action or session owns desktop control".into());
        }
        let generation = self
            .snapshot
            .generation
            .checked_add(1)
            .ok_or("[CONTROL_FAILED] Control generation exhausted")?;
        self.cleaning = true;
        self.last_revoked_generation = None;
        self.snapshot.generation = generation;
        self.snapshot.target_revision = 0;
        self.snapshot.owner = Some(owner.into());
        self.snapshot.mode = mode;
        self.snapshot.target = None;
        self.snapshot.pointer = None;
        self.snapshot.reason = None;
        self.snapshot.action = None;
        self.snapshot.sharing = None;
        self.snapshot.background_observation = None;
        self.snapshot.state = "starting".into();
        Ok(generation)
    }

    pub(super) fn finish_start(&mut self, generation: u64) -> Result<(), String> {
        if self.snapshot.generation != generation || self.snapshot.state != "starting" {
            return Err("[CONTROL_STOPPED] Start was cancelled during native cleanup".into());
        }
        self.cleaning = false;
        self.snapshot.state = "active".into();
        Ok(())
    }

    /// Retried Stop requests acknowledge the original revocation, but can never
    /// stop a subsequently started session, even if its owner is unchanged.
    pub(super) fn request_stop(
        &mut self,
        owner: Option<&str>,
        generation: Option<u64>,
        reason: &str,
    ) -> Result<Option<u64>, String> {
        if generation.is_some_and(|generation| {
            generation != self.snapshot.generation
                && !(self.snapshot.state == "stopped"
                    && self.last_revoked_generation == Some(generation))
        }) {
            return Err("[CONTROL_STALE] The control session has changed".into());
        }
        if owner.is_some_and(|owner| {
            self.snapshot
                .owner
                .as_deref()
                .is_some_and(|current| current != owner)
        }) {
            return Err("[CONTROL_OWNER_MISMATCH] This task does not own desktop control".into());
        }
        if self.snapshot.state == "stopped"
            || self.snapshot.state == "idle"
            || self.snapshot.state.is_empty()
        {
            return Ok(None);
        }
        Ok(Some(self.revoke(reason)))
    }

    pub(super) fn revoke(&mut self, reason: &str) -> u64 {
        // Saturation is safe only for revocation: admission uses checked_add
        // and can never restart an exhausted generation.
        self.last_revoked_generation = Some(self.snapshot.generation);
        self.snapshot.generation = self.snapshot.generation.saturating_add(1);
        self.snapshot.state = "stopped".into();
        self.snapshot.reason = Some(reason.into());
        self.snapshot.pointer = None;
        self.snapshot.action = None;
        if let Some(sharing) = self.snapshot.sharing.as_mut() {
            sharing.control_enabled = false;
        }
        self.busy = false;
        self.executor = None;
        self.cleaning = true;
        self.snapshot.generation
    }

    pub(super) fn finish_cleanup(&mut self, ticket: u64) {
        if self.snapshot.generation == ticket && self.snapshot.state == "stopped" {
            self.cleaning = false;
        }
    }

    pub(super) fn bind(&mut self, target: String) -> Result<bool, String> {
        if target.trim().is_empty() {
            return Err("[CONTROL_TARGET_REQUIRED] A native target is required".into());
        }
        if self.snapshot.target.as_ref() == Some(&target) {
            return Ok(false);
        }
        let portal_selection = self.snapshot.target.as_deref() == Some("portal:pending")
            && target.starts_with("portal:/")
            && self
                .snapshot
                .sharing
                .as_ref()
                .is_some_and(|sharing| sharing.phase == SharingPhase::Starting);
        if !portal_selection
            && self
                .snapshot
                .sharing
                .as_ref()
                .is_some_and(|sharing| sharing.phase != SharingPhase::Selecting)
        {
            self.shared_target_allowed(&target)?;
        }
        self.snapshot.target_revision = self
            .snapshot
            .target_revision
            .checked_add(1)
            .ok_or("[CONTROL_FAILED] Target revision exhausted")?;
        self.snapshot.target = Some(target);
        self.snapshot.pointer = None;
        Ok(true)
    }

    pub(super) fn admit(
        &mut self,
        owner: &str,
        action: &str,
        execution: E,
    ) -> Result<ControlToken, String> {
        let policy = ControlActionPolicy::for_action(action)
            .filter(|policy| policy.lease)
            .ok_or_else(|| format!("[CONTROL_ACTION_INVALID] {action} is not a resource action"))?;
        if owner.trim().is_empty() {
            return Err("[CONTROL_OWNER_REQUIRED] A runtime session is required".into());
        }
        let initial = self.snapshot.state.is_empty() || self.snapshot.state == "idle";
        if self.snapshot.state == "awaiting_share" {
            if self.snapshot.owner.as_deref() != Some(owner) {
                return Err("[CONTROL_BUSY] Desktop control is reserved by another session".into());
            }
            return Err("[SHARE_REQUIRED] This optional manual share has no target. Agent tasks use start_control to select applications through their tool requests.".into());
        }
        if !initial && !self.active() {
            return Err("[CONTROL_STOPPED] Use start_control to begin a new session".into());
        }
        if self.busy || (!initial && self.snapshot.owner.as_deref() != Some(owner)) {
            return Err("[CONTROL_BUSY] Desktop control belongs to another task or action".into());
        }
        let mode = if initial {
            ControlMode::Background
        } else {
            self.snapshot.mode
        };
        if self.snapshot.sharing.is_some()
            && (policy.foreground && !policy.target
                || matches!(action, "clipboard_get" | "clipboard_set" | "open_app"))
        {
            return Err("[SHARED_TARGET_ONLY] Window sharing does not authorize global clipboard, launching or scripts".into());
        }
        if mode == ControlMode::Observe && !policy.observation {
            return Err("[CONTROL_OBSERVE_ONLY] Start a control session to send input".into());
        }
        if policy.foreground && mode != ControlMode::Foreground {
            return Err(FOREGROUND_REQUIRED.into());
        }
        let sequence = self
            .snapshot
            .sequence
            .checked_add(1)
            .ok_or("[CONTROL_FAILED] Action sequence exhausted")?;
        if initial {
            self.snapshot.generation = self
                .snapshot
                .generation
                .checked_add(1)
                .ok_or("[CONTROL_FAILED] Control generation exhausted")?;
            self.snapshot.owner = Some(owner.into());
            self.snapshot.mode = mode;
            self.snapshot.state = "active".into();
        }
        self.busy = true;
        self.executor = Some(execution);
        self.snapshot.sequence = sequence;
        self.snapshot.action = Some(action.into());
        Ok(self.token(execution))
    }

    pub(super) fn release(&mut self, token: ControlToken, complete: bool) -> Option<u64> {
        // A control revocation invalidates input immediately, but the old lease
        // still releases its own busy slot. Never release a later action.
        if token.generation != self.snapshot.generation
            || token.sequence != self.snapshot.sequence
            || !self.busy
        {
            return None;
        }
        self.busy = false;
        self.executor = None;
        if complete {
            self.snapshot.action = None;
            None
        } else {
            Some(self.revoke("action_cancelled"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agent_selects_targets_and_operates_without_a_manual_share() {
        let mut state = Admission::<u8>::default();
        let observe = state.admit("task", "get_app_state", 1).unwrap();
        assert_eq!(state.snapshot.mode, ControlMode::Background);
        assert!(state.snapshot.sharing.is_none());
        state.bind("pid:1/window:10".into()).unwrap();
        state.release(observe, true);
        for action in ["click", "type_text", "key_chord", "scroll", "drag"] {
            let error = state.admit("task", action, 1).unwrap_err();
            assert!(error.starts_with("[FOREGROUND_REQUIRED]"), "{error}");
            assert!(error.contains("app_click, app_type_text, app_key_chord"));
            assert!(error.contains("Do not request foreground takeover"));
            assert!(error.contains("only when the user explicitly requests"));
            assert_eq!(state.snapshot.mode, ControlMode::Background);
            assert!(!state.busy);
        }
        let input = state.admit("task", "app_type_text", 1).unwrap();
        assert!(state.check_input(input).is_ok());
        state.release(input, true);
        let next = state.admit("task", "get_app_state", 1).unwrap();
        state.bind("pid:2/window:20".into()).unwrap();
        assert_eq!(state.snapshot.target_revision, 2);
        state.release(next, true);
        let launch = state.admit("task", "open_app", 1).unwrap();
        assert!(state.check_input(launch).is_ok());
    }
    #[test]
    fn sharing_requires_selection_capture_and_a_separate_revocable_grant() {
        let mut state = running();
        let generation = state.snapshot.generation;
        state
            .request_share("owner", ControlMode::Background)
            .unwrap();
        assert_eq!(state.snapshot.mode, ControlMode::Observe);
        assert!(state
            .admit("owner", "app_click", 1)
            .unwrap_err()
            .contains("SHARE_REQUIRED"));
        assert!(state.begin_start("other", ControlMode::Background).is_err());
        state
            .begin_share(
                generation,
                "pid:1/window:2".into(),
                "App".into(),
                ControlMode::Background,
            )
            .unwrap();
        let revision = state.snapshot.target_revision;
        assert!(state.set_control(generation, revision, 0, true).is_err());
        state.finish_share(generation, revision).unwrap();
        assert!(state.admit("owner", "app_click", 1).is_err());
        let read = state.admit("owner", "get_app_state", 1).unwrap();
        assert!(state.set_control(generation, revision, 0, true).is_err());
        state.release(read, true);
        state.set_control(generation, revision, 0, true).unwrap();
        let input = state.admit("owner", "app_drag", 1).unwrap();
        assert!(state.check_input(input).is_ok());
        state.set_control(generation, revision, 1, false).unwrap();
        assert!(state.check_input(input).is_err());
        assert!(state.release(input, true).is_none());
        assert!(!state.busy);
        assert!(state.set_control(generation, revision, 1, true).is_err());
        assert!(state.bind("pid:1/window:3".into()).is_err());
        assert_eq!(state.snapshot.target.as_deref(), Some("pid:1/window:2"));
    }

    #[test]
    fn stopped_sharing_and_observe_only_selection_cannot_be_granted_by_late_completion() {
        let mut state = running();
        let generation = state.snapshot.generation;
        state.request_share("owner", ControlMode::Observe).unwrap();
        state
            .begin_share(
                generation,
                "window:a".into(),
                "App".into(),
                ControlMode::Observe,
            )
            .unwrap();
        state.finish_share(generation, 1).unwrap();
        assert!(state.set_control(generation, 1, 0, true).is_err());
        state.revoke("user_stopped");
        assert!(state.finish_share(generation, 1).is_err());
        assert!(state.set_control(generation, 1, 0, true).is_err());
    }

    #[test]
    fn shared_foreground_mode_does_not_authorize_global_scripts_or_clipboard() {
        let mut state = running();
        let generation = state.snapshot.generation;
        state
            .request_share("owner", ControlMode::Foreground)
            .unwrap();
        state
            .begin_share(
                generation,
                "window:a".into(),
                "App".into(),
                ControlMode::Foreground,
            )
            .unwrap();
        state.finish_share(generation, 1).unwrap();
        state.set_control(generation, 1, 0, true).unwrap();
        for action in ["clipboard_get", "clipboard_set", "open_app", "run_script"] {
            assert!(state.admit("owner", action, 1).is_err(), "{action}");
            assert!(!state.busy);
        }
    }

    #[test]
    fn clipboard_reads_obey_owner_stop_and_observe_mode() {
        let mut state = running();
        state.snapshot.mode = ControlMode::Observe;
        assert!(state.admit("other-owner", "clipboard_get", 1).is_err());
        assert!(state.admit("owner", "clipboard_set", 1).is_err());
        let token = state.admit("owner", "clipboard_get", 1).unwrap();
        state.release(token, true);
        state.revoke("user_stopped");
        assert!(state.admit("owner", "clipboard_get", 1).is_err());
    }
    fn running() -> Admission<u8> {
        let mut state = Admission::default();
        let generation = state.begin_start("owner", ControlMode::Background).unwrap();
        state.finish_start(generation).unwrap();
        state
    }

    #[test]
    fn retried_stop_is_idempotent_but_cannot_revoke_a_restart() {
        let mut resource = Admission::<u8>::default();
        let generation = resource
            .begin_start("task", ControlMode::Background)
            .unwrap();
        resource.finish_start(generation).unwrap();
        let ticket = resource
            .request_stop(Some("task"), Some(generation), "stop")
            .unwrap()
            .unwrap();
        assert_eq!(
            resource
                .request_stop(Some("task"), Some(generation), "retry")
                .unwrap(),
            None
        );
        resource.finish_cleanup(ticket);
        assert_eq!(
            resource.request_stop(Some("task"), None, "retry").unwrap(),
            None
        );
        let restarted = resource
            .begin_start("task", ControlMode::Background)
            .unwrap();
        resource.finish_start(restarted).unwrap();
        assert!(resource
            .request_stop(Some("task"), Some(generation), "late retry")
            .is_err());
        assert!(resource.active());
    }

    #[test]
    fn stop_during_start_cannot_resurrect_admission() {
        let mut state = Admission::<u8>::default();
        let start = state.begin_start("owner", ControlMode::Background).unwrap();
        let stop = state.revoke("stopped");
        assert!(state.finish_start(start).is_err());
        state.finish_cleanup(stop);
        assert!(!state.active());
    }

    #[test]
    fn stale_cleanup_and_lease_cannot_change_a_new_owner() {
        let mut state = running();
        let old = state.admit("owner", "app_click", 1).unwrap();
        let first = state.revoke("first");
        let second = state.revoke("second");
        assert!(!state.owns_cleanup(first));
        assert!(state.owns_cleanup(second));
        state.finish_cleanup(first);
        assert!(state.begin_start("new", ControlMode::Background).is_err());
        state.finish_cleanup(second);
        let generation = state.begin_start("new", ControlMode::Background).unwrap();
        state.finish_start(generation).unwrap();
        let new = state.admit("new", "app_click", 2).unwrap();
        assert!(state.check(Some(old)).is_err());
        assert!(state.release(old, false).is_none());
        assert!(state.check_input(new).is_ok());
    }

    #[test]
    fn read_actions_and_foreign_executors_never_receive_input_authority() {
        let mut state = running();
        let read = state.admit("owner", "get_app_state", 1).unwrap();
        assert!(state.check(Some(read)).is_ok());
        assert!(state.check_observer(1, None).is_ok());
        assert!(state.check_observer(2, None).is_err());
        assert!(state.check_observer(2, Some(read)).is_ok());
        assert!(state.check_input(read).is_err());
        state.release(read, true);
        let input = state.admit("owner", "app_click", 1).unwrap();
        assert!(state.check_input(input).is_ok());
        assert!(state.check_input(state.token(2)).is_err());
        assert!(state.check(Some(read)).is_err());
        assert!(state.check_observer(2, Some(read)).is_err());
        state.release(input, true);
        assert!(state.check(Some(input)).is_err());
    }

    #[test]
    fn rejected_actions_do_not_create_or_take_over_sessions() {
        let mut state = Admission::<u8>::default();
        for action in ["unrecognized", "click", "start_control"] {
            assert!(state.admit("owner", action, 1).is_err());
            assert!(state.snapshot.owner.is_none());
        }
        let mut state = running();
        state.snapshot.mode = ControlMode::Observe;
        assert!(state.admit("owner", "app_click", 1).is_err());
        assert!(state.admit("other", "get_app_state", 1).is_err());
        assert!(state.admit("", "get_app_state", 1).is_err());
        assert!(!state.busy);
    }

    #[test]
    fn target_rebinding_and_exhausted_ids_cannot_alias_old_observations() {
        let mut state = running();
        assert!(state.bind("a".into()).unwrap());
        assert!(!state.bind("a".into()).unwrap());
        assert!(state.bind("b".into()).unwrap());
        assert!(state.bind("a".into()).unwrap());
        assert_eq!(state.snapshot.target_revision, 3);
        state.snapshot.sequence = u64::MAX;
        assert!(state.admit("owner", "app_click", 1).is_err());
        state.snapshot.generation = u64::MAX;
        let stop = state.revoke("stopped");
        state.finish_cleanup(stop);
        assert!(state.begin_start("owner", ControlMode::Background).is_err());
        assert!(!state.active());
    }
}
