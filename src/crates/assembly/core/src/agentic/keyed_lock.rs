use std::sync::{Arc, Weak};

use dashmap::DashMap;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub(crate) struct KeyedAsyncLockGuard {
    guard: Option<OwnedMutexGuard<()>>,
    registry: Arc<DashMap<String, Weak<AsyncMutex<()>>>>,
    key: String,
    generation: Weak<AsyncMutex<()>>,
}

impl Drop for KeyedAsyncLockGuard {
    fn drop(&mut self) {
        // Release the async lock before removing its dead weak entry. A new
        // waiter either upgrades this generation first or creates the next one
        // after removal; two live generations cannot overlap.
        drop(self.guard.take());
        self.registry.remove_if(&self.key, |_, current| {
            current.ptr_eq(&self.generation) && current.upgrade().is_none()
        });
    }
}

/// Race-safe keyed async lock registry.
///
/// The registry owns only weak references backed by a sharded concurrent map (DashMap).
/// Waiters keep the lock generation alive through their strong references, while dead
/// keys are reclaimed atomically without holding a process-wide mutex.
#[derive(Clone, Default)]
pub(crate) struct KeyedAsyncLock {
    registry: Arc<DashMap<String, Weak<AsyncMutex<()>>>>,
}

impl KeyedAsyncLock {
    pub(crate) async fn lock(&self, key: &str) -> KeyedAsyncLockGuard {
        let (lock, generation) = {
            let mut entry = self.registry.entry(key.to_string());
            match entry {
                dashmap::mapref::entry::Entry::Occupied(ref mut occupied) => {
                    if let Some(lock) = occupied.get().upgrade() {
                        let generation = Arc::downgrade(&lock);
                        (lock, generation)
                    } else {
                        let lock = Arc::new(AsyncMutex::new(()));
                        let generation = Arc::downgrade(&lock);
                        occupied.insert(generation.clone());
                        (lock, generation)
                    }
                }
                dashmap::mapref::entry::Entry::Vacant(vacant) => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    let generation = Arc::downgrade(&lock);
                    vacant.insert(generation.clone());
                    (lock, generation)
                }
            }
        };
        let guard = lock.lock_owned().await;
        KeyedAsyncLockGuard {
            guard: Some(guard),
            registry: self.registry.clone(),
            key: key.to_string(),
            generation,
        }
    }

    #[cfg(test)]
    fn registry_len(&self) -> usize {
        self.registry.len()
    }
}

#[cfg(test)]
mod tests {
    use super::KeyedAsyncLock;

    #[tokio::test]
    async fn dead_key_generations_are_reclaimed() {
        let locks = KeyedAsyncLock::default();
        for index in 0..64 {
            drop(locks.lock(&format!("missing-{index}")).await);
        }

        let survivor = locks.lock("survivor").await;

        assert_eq!(locks.registry_len(), 1);
        drop(survivor);
        assert_eq!(locks.registry_len(), 0);
    }
}
