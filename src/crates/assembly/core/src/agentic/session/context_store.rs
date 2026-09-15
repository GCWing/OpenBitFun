//! Runtime session context store.
//!
//! Holds the in-memory model context for each active session.

use crate::agentic::core::Message;
use dashmap::DashMap;
use log::debug;
use std::sync::Arc;

/// In-memory runtime context store for active sessions.
pub struct SessionContextStore {
    session_contexts: Arc<DashMap<String, Vec<Message>>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_transform_serializes_with_concurrent_append() {
        let store = Arc::new(SessionContextStore::new());
        store.create_session("session");
        let original = Message::user("original".into());
        store.add_message("session", original.clone());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_store = store.clone();
        let worker = std::thread::spawn(move || {
            worker_store
                .try_transform_context("session", |current| {
                    assert_eq!(current.len(), 1);
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok((Some(vec![Message::assistant("summary".into())]), ()))
                })
                .unwrap();
        });
        entered_rx.recv().unwrap();
        let append_store = store.clone();
        let appended = Message::assistant("new tail".into());
        let appended_id = appended.id.clone();
        let append = std::thread::spawn(move || append_store.add_message("session", appended));
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        append.join().unwrap();
        let result = store.get_context_messages("session");
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].id, appended_id);
    }

    #[test]
    fn compression_rejected_transform_keeps_context() {
        let store = SessionContextStore::new();
        store.create_session("session");
        let original = Message::user("original".into());
        store.add_message("session", original.clone());
        let result = store.try_transform_context::<()>("session", |_| {
            Err(crate::OpenBitFunError::Cancelled("owner changed".into()))
        });
        assert!(result.is_err());
        assert_eq!(store.get_context_messages("session")[0].id, original.id);
    }
}

impl Default for SessionContextStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionContextStore {
    pub fn new() -> Self {
        Self {
            session_contexts: Arc::new(DashMap::new()),
        }
    }

    pub fn create_session(&self, session_id: &str) {
        self.session_contexts.insert(session_id.to_string(), vec![]);
        debug!("Created session context cache: session_id={}", session_id);
    }

    pub fn add_message(&self, session_id: &str, message: Message) {
        if let Some(mut cached_messages) = self.session_contexts.get_mut(session_id) {
            cached_messages.push(message);
        } else {
            self.session_contexts
                .insert(session_id.to_string(), vec![message]);
        }
    }

    pub fn replace_context(&self, session_id: &str, messages: Vec<Message>) {
        self.session_contexts
            .insert(session_id.to_string(), messages);
        debug!("Replaced session context cache: session_id={}", session_id);
    }

    pub fn get_context_messages(&self, session_id: &str) -> Vec<Message> {
        self.session_contexts
            .get(session_id)
            .map(|messages| messages.clone())
            .unwrap_or_default()
    }

    /// Validate and transform the latest context under the same entry lock used
    /// by append/replace. A rejected preparation never changes the cache.
    pub(crate) fn try_transform_context<T>(
        &self,
        session_id: &str,
        transform: impl FnOnce(&[Message]) -> crate::OpenBitFunResult<(Option<Vec<Message>>, T)>,
    ) -> crate::OpenBitFunResult<T> {
        let mut messages = self.session_contexts.get_mut(session_id).ok_or_else(|| {
            crate::OpenBitFunError::NotFound(format!("Session context not found: {session_id}"))
        })?;
        let (replacement, result) = transform(&messages)?;
        if let Some(replacement) = replacement {
            *messages = replacement;
        }
        Ok(result)
    }

    pub fn delete_session(&self, session_id: &str) {
        self.session_contexts.remove(session_id);
        debug!("Deleted session context cache: session_id={}", session_id);
    }

    #[cfg(test)]
    pub(crate) fn has_session(&self, session_id: &str) -> bool {
        self.session_contexts.contains_key(session_id)
    }
}
