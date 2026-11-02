//! Targeted barriers fence delayed model writes without revoking other readers.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;

const MAX_SESSION_FENCES: usize = 256;
const MAX_PREPARED_WRITES: usize = 64;

#[derive(Default)]
pub(super) struct ModelWriteFence {
    tokens: VecDeque<String>,
}

impl ModelWriteFence {
    pub(super) fn issue(&mut self) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        if self.tokens.len() >= MAX_PREPARED_WRITES {
            self.tokens.pop_front();
        }
        self.tokens.push_back(token.clone());
        token
    }

    pub(super) fn retire(&mut self, token: &str) -> bool {
        if let Some(index) = self.tokens.iter().position(|candidate| candidate == token) {
            self.tokens.remove(index);
            return true;
        }
        false
    }

    pub(super) fn claim(&mut self, token: Option<&str>) -> Result<(), String> {
        match token {
            Some(token) if !self.retire(token) => Err(
                "Session model selection expired; reload the session model before retrying"
                    .to_string(),
            ),
            Some(_) => Ok(()),
            None => {
                // Legacy writes invalidate outstanding preparations, but an
                // ordinary catalog read never revokes another caller's intent.
                self.tokens.clear();
                Ok(())
            }
        }
    }
}

struct Entry {
    gate: Arc<AsyncMutex<ModelWriteFence>>,
    last_used: Instant,
}

struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    capacity: usize,
}

impl Registry {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capacity,
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<AsyncMutex<ModelWriteFence>>, String> {
        if session_id.is_empty() || session_id.len() > 512 {
            return Err("Invalid session identity for model selection".to_string());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Session model fence unavailable".to_string())?;
        if let Some(entry) = entries.get_mut(session_id) {
            entry.last_used = Instant::now();
            return Ok(entry.gate.clone());
        }
        if entries.len() >= self.capacity {
            // A held or queued guard owns another Arc. Never evict it: a second
            // gate for that session would let a read overtake an active write.
            let idle = entries
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.gate) == 1)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(id, _)| id.clone());
            if let Some(id) = idle {
                entries.remove(&id);
            } else {
                return Err("Session model settings are busy; retry later".to_string());
            }
        }
        let gate = Arc::new(AsyncMutex::new(ModelWriteFence::default()));
        entries.insert(
            session_id.to_string(),
            Entry {
                gate: gate.clone(),
                last_used: Instant::now(),
            },
        );
        Ok(gate)
    }
}

pub(super) fn session(session_id: &str) -> Result<Arc<AsyncMutex<ModelWriteFence>>, String> {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Registry::new(MAX_SESSION_FENCES))
        .session(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_targeted_barrier_retires_only_its_write_and_tokens_are_single_use() {
        let mut fence = ModelWriteFence::default();
        let old = fence.issue();
        let current = fence.issue();
        assert!(fence.retire(&old));
        assert!(fence.claim(Some(&old)).is_err());
        assert!(fence.claim(Some(&current)).is_ok());
        assert!(fence.claim(Some(&current)).is_err());
    }

    #[test]
    fn prepared_writes_are_independent_and_bounded() {
        let mut fence = ModelWriteFence::default();
        let first = fence.issue();
        let second = fence.issue();
        assert!(fence.claim(Some(&first)).is_ok());
        assert!(fence.claim(Some(&second)).is_ok());
        let retired = fence.issue();
        for _ in 0..MAX_PREPARED_WRITES {
            fence.issue();
        }
        assert_eq!(fence.tokens.len(), MAX_PREPARED_WRITES);
        assert!(fence.claim(Some(&retired)).is_err());
    }

    #[test]
    fn legacy_writes_retire_outstanding_tokens() {
        let mut fence = ModelWriteFence::default();
        let token = fence.issue();
        fence.claim(None).unwrap();
        assert!(fence.claim(Some(&token)).is_err());
    }

    #[tokio::test]
    async fn a_catalog_read_waits_for_the_actual_write_not_its_transport_owner() {
        let registry = Registry::new(1);
        let gate = registry.session("A").unwrap();
        let mut write = gate.lock().await;
        let token = write.issue();
        write.claim(Some(&token)).unwrap();
        let reading_gate = registry.session("A").unwrap();
        assert!(reading_gate.try_lock().is_err());
        assert!(
            registry.session("B").is_err(),
            "an active gate cannot be evicted"
        );
        drop(write);
        let fresh = reading_gate.lock().await.issue();
        assert!(gate.lock().await.claim(Some(&token)).is_err());
        assert!(gate.lock().await.claim(Some(&fresh)).is_ok());
    }

    #[tokio::test]
    async fn eviction_cannot_revalidate_a_delayed_write() {
        let registry = Registry::new(1);
        let token = registry.session("A").unwrap().lock().await.issue();
        drop(registry.session("B").unwrap());
        assert!(registry
            .session("A")
            .unwrap()
            .lock()
            .await
            .claim(Some(&token))
            .is_err());
    }
}
