//! Per-card fetch serialization for desktop cards.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

type CardSlot = Arc<tokio::sync::Mutex<Option<i64>>>;

/// Lets one fetch per card run at a time, so a command source never runs
/// concurrently with itself, and remembers when the last stored fetch
/// started so a caller that waited can reuse a fetch that began after it asked.
#[derive(Default)]
pub(crate) struct FetchGate {
    cards: Mutex<HashMap<String, CardSlot>>,
}

/// Exclusive right to fetch one card, held until dropped.
pub(crate) struct FetchTurn {
    last_started_ms: tokio::sync::OwnedMutexGuard<Option<i64>>,
}

impl FetchGate {
    fn cards(&self) -> MutexGuard<'_, HashMap<String, CardSlot>> {
        match self.cards.lock() {
            Ok(cards) => cards,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub(crate) async fn turn(&self, card_id: &str) -> FetchTurn {
        let slot = Arc::clone(self.cards().entry(card_id.to_string()).or_default());
        FetchTurn {
            last_started_ms: slot.lock_owned().await,
        }
    }

    /// Drops the bookkeeping of a deleted card; a running turn keeps its slot alive.
    pub(crate) fn forget(&self, card_id: &str) {
        self.cards().remove(card_id);
    }

    #[cfg(test)]
    fn tracked_cards(&self) -> usize {
        self.cards().len()
    }
}

impl FetchTurn {
    /// Whether a stored fetch started at or after `not_before_ms`.
    pub(crate) fn started_since(&self, not_before_ms: i64) -> bool {
        self.last_started_ms
            .is_some_and(|started| started >= not_before_ms)
    }

    /// Records the start of a fetch whose result was stored.
    pub(crate) fn record_stored_fetch(&mut self, started_at_ms: i64) {
        *self.last_started_ms = Some(started_at_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn turns_for_one_card_are_serialized_and_share_the_start_time() {
        let gate = Arc::new(FetchGate::default());
        let mut first = gate.turn("card-1").await;
        assert!(!first.started_since(0));

        let waiter = {
            let gate = Arc::clone(&gate);
            tokio::spawn(async move { gate.turn("card-1").await.started_since(100) })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "a second turn must wait for the first"
        );

        first.record_stored_fetch(150);
        drop(first);
        assert!(waiter.await.unwrap());

        let turn = gate.turn("card-1").await;
        assert!(turn.started_since(150));
        assert!(!turn.started_since(151));
    }

    #[tokio::test]
    async fn cards_do_not_block_each_other_and_deleted_cards_are_forgotten() {
        let gate = FetchGate::default();
        let _one = gate.turn("card-1").await;
        let two = tokio::time::timeout(Duration::from_millis(100), gate.turn("card-2")).await;
        assert!(two.is_ok(), "different cards fetch independently");
        assert_eq!(gate.tracked_cards(), 2);

        gate.forget("card-1");
        gate.forget("card-2");
        assert_eq!(gate.tracked_cards(), 0);
    }

    #[tokio::test]
    async fn cancelled_fetches_are_not_reused() {
        let gate = FetchGate::default();
        {
            let _turn = gate.turn("card-1").await;
            // dropped without record_stored_fetch, as when a fetch is cancelled
        }
        assert!(!gate.turn("card-1").await.started_since(0));
    }
}
