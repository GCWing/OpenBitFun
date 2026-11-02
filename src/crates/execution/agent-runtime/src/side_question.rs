//! Runtime-only `/btw` request tracking.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct SideQuestionRuntime {
    tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    btw_turns: Arc<Mutex<HashMap<String, ActiveBtwTurn>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveBtwTurn {
    pub session_id: String,
    pub turn_id: String,
}

/// How often a host re-reads whether a registered `/btw` turn still runs.
pub const BTW_TURN_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long a turn that has not been seen running yet may keep its registration.
const BTW_TURN_START_GRACE: Duration = Duration::from_secs(5);

/// Decides when a host may drop a `/btw` registration, which only serves
/// `btw_cancel`. A turn accepted a moment ago may not be running yet, and
/// dropping it then would make it uncancellable for its whole run.
#[derive(Debug)]
pub struct BtwTurnWatch {
    started_at: Instant,
    seen_processing: bool,
}

impl Default for BtwTurnWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl BtwTurnWatch {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            seen_processing: false,
        }
    }

    /// Record one observation; `true` means the turn has settled.
    pub fn should_release(&mut self, processing: bool) -> bool {
        self.should_release_at(processing, Instant::now())
    }

    fn should_release_at(&mut self, processing: bool, now: Instant) -> bool {
        if processing {
            self.seen_processing = true;
            return false;
        }
        self.seen_processing || now.duration_since(self.started_at) >= BTW_TURN_START_GRACE
    }
}

impl Default for SideQuestionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl SideQuestionRuntime {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(Mutex::new(HashMap::new())),
            btw_turns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn register(&self, request_id: String) -> CancellationToken {
        let token = CancellationToken::new();

        let old = {
            let mut guard = self.tokens.lock().await;
            guard.insert(request_id, token.clone())
        };
        if let Some(old) = old {
            old.cancel();
        }

        token
    }

    pub async fn cancel(&self, request_id: &str) {
        let token = {
            let guard = self.tokens.lock().await;
            guard.get(request_id).cloned()
        };
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub async fn remove(&self, request_id: &str) {
        {
            let mut guard = self.tokens.lock().await;
            guard.remove(request_id);
        }
        let mut btw_turns = self.btw_turns.lock().await;
        btw_turns.remove(request_id);
    }

    pub async fn register_btw_turn(&self, request_id: String, session_id: String, turn_id: String) {
        let mut guard = self.btw_turns.lock().await;
        guard.insert(
            request_id,
            ActiveBtwTurn {
                session_id,
                turn_id,
            },
        );
    }

    pub async fn get_btw_turn(&self, request_id: &str) -> Option<ActiveBtwTurn> {
        let guard = self.btw_turns.lock().await;
        guard.get(request_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::{ActiveBtwTurn, BtwTurnWatch, SideQuestionRuntime, BTW_TURN_START_GRACE};
    use std::time::Duration;

    #[test]
    fn a_turn_not_running_yet_keeps_its_registration_during_the_grace_period() {
        let mut watch = BtwTurnWatch::new();
        let start = watch.started_at;
        assert!(!watch.should_release_at(false, start));
        assert!(!watch.should_release_at(false, start + Duration::from_secs(1)));
    }

    #[test]
    fn a_turn_that_never_runs_is_released_after_the_grace_period() {
        let mut watch = BtwTurnWatch::new();
        let start = watch.started_at;
        assert!(watch.should_release_at(false, start + BTW_TURN_START_GRACE));
    }

    #[test]
    fn a_running_turn_is_released_as_soon_as_it_settles() {
        let mut watch = BtwTurnWatch::new();
        let start = watch.started_at;
        assert!(!watch.should_release_at(false, start));
        let long_after = start + BTW_TURN_START_GRACE * 10;
        assert!(!watch.should_release_at(true, long_after));
        assert!(watch.should_release_at(false, start + Duration::from_millis(1)));
    }

    #[tokio::test]
    async fn registering_same_request_cancels_previous_token() {
        let runtime = SideQuestionRuntime::new();

        let first = runtime.register("req-1".to_string()).await;
        let second = runtime.register("req-1".to_string()).await;

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[tokio::test]
    async fn remove_clears_token_and_btw_turn_mapping() {
        let runtime = SideQuestionRuntime::new();
        let token = runtime.register("req-1".to_string()).await;
        runtime
            .register_btw_turn(
                "req-1".to_string(),
                "session-1".to_string(),
                "turn-1".to_string(),
            )
            .await;

        assert_eq!(
            runtime.get_btw_turn("req-1").await,
            Some(ActiveBtwTurn {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
            })
        );

        runtime.remove("req-1").await;

        assert!(!token.is_cancelled());
        assert_eq!(runtime.get_btw_turn("req-1").await, None);
    }

    #[tokio::test]
    async fn cancel_marks_registered_token_without_removing_turn_mapping() {
        let runtime = SideQuestionRuntime::new();
        let token = runtime.register("req-1".to_string()).await;
        runtime
            .register_btw_turn(
                "req-1".to_string(),
                "session-1".to_string(),
                "turn-1".to_string(),
            )
            .await;

        runtime.cancel("req-1").await;

        assert!(token.is_cancelled());
        assert_eq!(
            runtime.get_btw_turn("req-1").await,
            Some(ActiveBtwTurn {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
            })
        );
    }
}
