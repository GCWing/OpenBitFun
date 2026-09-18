//! Terminal Session Binding - Generic binding manager for terminal sessions
//!
//! This module provides a generic binding manager that maps external entity IDs
//! (owner_id) to terminal session IDs. It can be used for any scenario where
//! an external entity needs to maintain a persistent terminal session.
//!
//! # Use Cases
//! - Chat sessions binding to terminals (owner_id = chat_session_id)
//! - Workflows binding to terminals (owner_id = workflow_id)
//! - Tasks binding to terminals (owner_id = task_id)
//! - Any other scenario requiring persistent terminals

use std::collections::HashMap;
use std::sync::Arc;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use log::warn;

use crate::session::get_session_manager;
use crate::session::SessionSource;
use crate::shell::ShellType;
use crate::{TerminalError, TerminalResult};

/// Options for creating a terminal session when binding
#[derive(Debug, Clone, Default)]
pub struct TerminalBindingOptions {
    pub owner: Option<super::SessionOwner>,
    /// Working directory for the terminal
    pub working_directory: Option<String>,
    /// Session ID
    pub session_id: Option<String>,
    /// Session name (for UI display)
    pub session_name: Option<String>,
    /// Shell type (if not specified, uses system default)
    pub shell_type: Option<ShellType>,
    /// Environment variables to set
    pub env: Option<HashMap<String, String>>,
    /// Terminal columns (default: 120)
    pub cols: Option<u16>,
    /// Terminal rows (default: 30)
    pub rows: Option<u16>,
    /// Source of the terminal session
    pub source: Option<SessionSource>,
}

/// Terminal Session Binding Manager
///
/// Manages the mapping between external entity IDs (owner_id) and terminal session IDs.
/// Provides functionality to:
/// - Get or create terminal sessions on demand
/// - Bind existing terminal sessions to owners
/// - Remove bindings and optionally close terminal sessions
/// - Create and track background terminal sessions (one-to-many)
///
/// # Thread Safety
/// This struct is thread-safe and can be shared across async tasks.
pub struct TerminalSessionBinding {
    /// Mapping from owner_id to terminal_session_id (primary, one-to-one)
    bindings: Arc<DashMap<String, String>>,
    /// Mapping from owner_id to background terminal session IDs (one-to-many)
    background_bindings: Arc<DashMap<String, Vec<String>>>,
}

impl TerminalSessionBinding {
    /// Create a new binding manager
    pub fn new() -> Self {
        Self {
            bindings: Arc::new(DashMap::new()),
            background_bindings: Arc::new(DashMap::new()),
        }
    }

    /// Get or create a terminal session for the given owner
    ///
    /// If a binding already exists, returns the existing terminal session ID.
    /// If no binding exists, creates a new terminal session and establishes the binding.
    ///
    /// # Arguments
    /// * `owner_id` - The external entity ID (e.g., chat_session_id, workflow_id)
    /// * `options` - Options for creating the terminal session
    ///
    /// # Returns
    /// The terminal session ID (existing or newly created)
    pub async fn get_or_create(
        &self,
        owner_id: &str,
        options: TerminalBindingOptions,
    ) -> TerminalResult<String> {
        // Check if binding already exists
        if let Some(terminal_session_id) = self.get(owner_id) {
            return Ok(terminal_session_id);
        }

        // Create a new terminal session
        let session_manager = get_session_manager()
            .ok_or_else(|| TerminalError::Session("SessionManager not initialized".to_string()))?;

        // Generate a session ID based on owner_id for easier debugging
        let terminal_session_id = options.session_id.unwrap_or_else(|| {
            format!(
                "term-{}-{}",
                &owner_id[..8.min(owner_id.len())],
                &uuid::Uuid::new_v4().to_string()[..8]
            )
        });

        let session_name = options
            .session_name
            .unwrap_or_else(|| format!("Terminal-{}", &owner_id[..8.min(owner_id.len())]));

        // Create the session
        let _session = session_manager
            .create_session(
                Some(terminal_session_id.clone()),
                Some(session_name),
                options.shell_type,
                options.working_directory,
                options.env,
                options.cols,
                options.rows,
                options.source,
            )
            .await?;

        if let Some(owner) = options.owner {
            session_manager
                .set_owner(&terminal_session_id, owner)
                .await?;
        }

        // Establish the binding
        self.bindings
            .insert(owner_id.to_string(), terminal_session_id.clone());

        Ok(terminal_session_id)
    }

    /// Get the terminal session ID for a given owner
    ///
    /// Returns None if no binding exists.
    pub fn get(&self, owner_id: &str) -> Option<String> {
        self.bindings.get(owner_id).map(|v| v.value().clone())
    }

    /// Manually bind an existing terminal session to an owner
    ///
    /// This is useful when you have an existing terminal session
    /// that wasn't created through get_or_create().
    ///
    /// # Note
    /// If a binding already exists for this owner, it will be replaced.
    pub fn bind(&self, owner_id: &str, terminal_session_id: &str) {
        self.bindings
            .insert(owner_id.to_string(), terminal_session_id.to_string());
    }

    /// Unbind a terminal session from an owner without closing the session
    ///
    /// Returns the terminal session ID that was unbound, if any.
    pub fn unbind(&self, owner_id: &str) -> Option<String> {
        self.bindings.remove(owner_id).map(|(_, v)| v)
    }

    /// Create a new background terminal session for the given owner.
    ///
    /// Unlike `get_or_create`, this always creates a fresh session and allows
    /// multiple background sessions per owner. The session ID is returned immediately
    /// after the session is started; the caller is responsible for sending commands.
    ///
    /// # Arguments
    /// * `owner_id` - The external entity ID (e.g., chat_session_id)
    /// * `options` - Options for creating the terminal session
    ///
    /// # Returns
    /// The newly created background terminal session ID
    pub async fn create_background_session(
        &self,
        owner_id: &str,
        options: TerminalBindingOptions,
    ) -> TerminalResult<String> {
        let session_manager = get_session_manager()
            .ok_or_else(|| TerminalError::Session("SessionManager not initialized".to_string()))?;

        let session_id = options.session_id.unwrap_or_else(|| {
            format!(
                "bg-{}-{}",
                &owner_id[..8.min(owner_id.len())],
                &uuid::Uuid::new_v4().to_string()[..8]
            )
        });

        let session_name = options
            .session_name
            .unwrap_or_else(|| format!("Background-{}", &session_id[..8.min(session_id.len())]));

        let _session = session_manager
            .create_session(
                Some(session_id.clone()),
                Some(session_name),
                options.shell_type,
                options.working_directory,
                options.env,
                options.cols,
                options.rows,
                options.source,
            )
            .await?;

        self.background_bindings
            .entry(owner_id.to_string())
            .or_default()
            .push(session_id.clone());

        Ok(session_id)
    }

    /// List all background terminal session IDs for the given owner.
    pub fn list_background_sessions(&self, owner_id: &str) -> Vec<String> {
        self.background_bindings
            .get(owner_id)
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    /// Remove binding and close the associated terminal session
    ///
    /// This is the recommended way to clean up when an owner is being destroyed.
    /// Also closes all background sessions associated with this owner.
    pub async fn remove(&self, owner_id: &str) -> TerminalResult<()> {
        let session_manager = get_session_manager()
            .ok_or_else(|| TerminalError::Session("SessionManager not initialized".to_string()))?;
        let mut first_error = None;

        // Close primary session
        if let Some(terminal_session_id) = self.get(owner_id) {
            if let Err(error) = session_manager
                .close_session(&terminal_session_id, false)
                .await
            {
                warn!(
                    "Failed to close terminal session {}: {}",
                    terminal_session_id, error
                );
                first_error = Some(error);
            } else if let Entry::Occupied(entry) = self.bindings.entry(owner_id.to_string()) {
                if entry.get() == &terminal_session_id {
                    entry.remove();
                }
            }
        }

        // Close all background sessions
        for bg_session_id in self.list_background_sessions(owner_id) {
            if let Err(error) = session_manager.close_session(&bg_session_id, false).await {
                warn!(
                    "Failed to close background terminal session {}: {}",
                    bg_session_id, error
                );
                if first_error.is_none() {
                    first_error = Some(error);
                }
            } else if let Entry::Occupied(mut entry) =
                self.background_bindings.entry(owner_id.to_string())
            {
                entry.get_mut().retain(|current| current != &bg_session_id);
                if entry.get().is_empty() {
                    entry.remove();
                }
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Check if a binding exists for the given owner
    pub fn has(&self, owner_id: &str) -> bool {
        self.bindings.contains_key(owner_id) || self.background_bindings.contains_key(owner_id)
    }

    /// List all current bindings
    ///
    /// Returns a vector of (owner_id, terminal_session_id) pairs.
    pub fn list_bindings(&self) -> Vec<(String, String)> {
        self.bindings
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }

    /// Get the number of active bindings
    pub fn count(&self) -> usize {
        self.bindings.len()
    }

    /// Clear all bindings without closing terminal sessions
    ///
    /// Use this with caution - terminal sessions will become orphaned.
    pub fn clear(&self) {
        self.bindings.clear();
        self.background_bindings.clear();
    }

    /// Remove all bindings and close all associated terminal sessions (primary + background)
    pub async fn remove_all(&self) -> TerminalResult<()> {
        let owner_ids: Vec<String> = self
            .bindings
            .iter()
            .map(|e| e.key().clone())
            .chain(self.background_bindings.iter().map(|e| e.key().clone()))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        for owner_id in owner_ids {
            if let Err(e) = self.remove(&owner_id).await {
                warn!("Failed to remove binding for {}: {}", owner_id, e);
            }
        }

        Ok(())
    }
}

impl Default for TerminalSessionBinding {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_binding_operations() {
        let binding = TerminalSessionBinding::new();

        // Test bind and get
        binding.bind("owner1", "session1");
        assert_eq!(binding.get("owner1"), Some("session1".to_string()));
        assert!(binding.has("owner1"));
        assert!(!binding.has("owner2"));

        // Test unbind
        let unbound = binding.unbind("owner1");
        assert_eq!(unbound, Some("session1".to_string()));
        assert!(!binding.has("owner1"));

        // Test list_bindings
        binding.bind("owner2", "session2");
        binding.bind("owner3", "session3");
        let bindings = binding.list_bindings();
        assert_eq!(bindings.len(), 2);

        // Test count
        assert_eq!(binding.count(), 2);

        // Test clear
        binding.clear();
        assert_eq!(binding.count(), 0);
    }

    #[test]
    fn background_only_binding_is_owned_by_the_session() {
        let binding = TerminalSessionBinding::new();
        binding
            .background_bindings
            .insert("owner1".to_string(), vec!["background-session".to_string()]);

        assert!(binding.has("owner1"));
    }
}
