//! Host-local observations and interaction feedback; control authority lives in control_session.
use super::PointerMap;
use openbitfun_agent_tools::computer_use_host::ComputerUseLastMutationKind;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use openbitfun_agent_tools::computer_use_host::VisualMark;
use tool_runtime::computer_use::ComputerUseOptimizer;

/// Unified mutable session state for computer use — one mutex instead of five.
/// State transitions are applied centrally after each action (screenshot, pointer move, click, etc.).
#[derive(Debug)]
pub(super) struct ComputerUseSessionMutableState {
    pub(super) observations: crate::computer_use::observation_cache::ObservationCache<PointerMap>,
    /// When true, a fresh `screenshot_display` is required before `click` and before `key_chord` that sends Return/Enter
    /// (set after pointer moves / click; cleared after screenshot).
    pub(super) click_needs_fresh_screenshot: bool,
    /// After click / key / type / scroll / drag: recommend a **`screenshot`** to confirm UI state (Cowork verify).
    /// Cleared on the next successful `screenshot_display`.
    pub(super) pending_verify_screenshot: bool,
    /// Bounded action evidence; hashes alone never verify task completion.
    pub(super) optimizer: ComputerUseOptimizer,
    /// Most-recent action **kind** that mutated UI / pointer state. Surfaced
    /// to the model via `interaction_state.last_mutation` so it can pair the
    /// right verification step (e.g. after `Click` + `pending_verify` ⇒ take
    /// a confirming `screenshot`; after `TypeText` ⇒ may chain Enter without
    /// re-screenshotting because typing does not move the pointer).
    pub(super) last_mutation_kind: Option<ComputerUseLastMutationKind>,
    /// Caller-pinned target display (set via `desktop.focus_display`).
    /// When set, all subsequent screenshots / peeks / locates use this
    /// display instead of "screen under the mouse pointer". The model
    /// uses this to disambiguate multi-monitor targets explicitly.
    pub(super) preferred_display_id: Option<u32>,
    /// Most-recent Set-of-Mark interactive view per pid. Used to resolve
    /// `interactive_*` numeric `i` indices back to AX node indices and to
    /// detect stale-view usage via `before_view_digest`.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(super) interactive_view_cache: std::collections::HashMap<i32, CachedInteractiveView>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(super) visual_mark_cache: std::collections::HashMap<i32, CachedVisualMarkView>,
}

#[derive(Debug, Clone)]
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) struct CachedInteractiveView {
    pub(super) digest: String,
    /// `i` → `node_idx` map (dense, indexed by `i`).
    pub(super) elements: Vec<openbitfun_agent_tools::computer_use_host::InteractiveElement>,
}

#[derive(Debug, Clone)]
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) struct CachedVisualMarkView {
    pub(super) digest: String,
    pub(super) marks: Vec<VisualMark>,
    pub(super) screenshot_id: Option<String>,
}

impl ComputerUseSessionMutableState {
    pub(super) fn synchronize(
        &mut self,
        scope: &openbitfun_agent_tools::computer_use_control::ObservationScope,
    ) {
        if self.observations.synchronize(scope) {
            self.clear_derived_state();
        }
    }
    fn clear_derived_state(&mut self) {
        self.click_needs_fresh_screenshot = true;
        self.pending_verify_screenshot = false;
        self.last_mutation_kind = None;
        self.optimizer.clear_history();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.interactive_view_cache.clear();
            self.visual_mark_cache.clear();
        }
    }

    pub(super) fn new() -> Self {
        Self {
            observations: Default::default(),
            click_needs_fresh_screenshot: true,
            pending_verify_screenshot: false,
            optimizer: ComputerUseOptimizer::new(),
            last_mutation_kind: None,
            preferred_display_id: None,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            interactive_view_cache: std::collections::HashMap::new(),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            visual_mark_cache: std::collections::HashMap::new(),
        }
    }

    /// Called after a successful screenshot capture.
    pub(super) fn transition_after_screenshot(&mut self, id: String, map: PointerMap) {
        self.observations.record_image(id, map);
        self.click_needs_fresh_screenshot = false;
        self.pending_verify_screenshot = false;
        self.last_mutation_kind = Some(ComputerUseLastMutationKind::Screenshot);
    }

    /// Called after pointer mutation (move, step, relative), click, scroll, key_chord, or type_text.
    pub(super) fn transition_after_pointer_mutation(&mut self) {
        self.click_needs_fresh_screenshot = true;
        // Note: `last_mutation_kind` is set explicitly by the calling
        // action (PointerMove / Click / Scroll / KeyChord / TypeText / Drag)
        // so we do not overwrite it here with a generic value.
    }

    /// Called after click (same effect as pointer mutation for freshness).
    pub(super) fn transition_after_click(&mut self) {
        self.click_needs_fresh_screenshot = true;
        self.pending_verify_screenshot = true;
        self.last_mutation_kind = Some(ComputerUseLastMutationKind::Click);
    }

    /// Called after key, typing, scroll, or drag — UI likely changed; next `screenshot` should confirm.
    pub(super) fn transition_after_committed_ui_action(&mut self) {
        self.pending_verify_screenshot = true;
    }

    pub(super) fn record_mutation(&mut self, kind: ComputerUseLastMutationKind) {
        self.last_mutation_kind = Some(kind);
    }
}
