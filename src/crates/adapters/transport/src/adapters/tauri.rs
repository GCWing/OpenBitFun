//! Tauri transport adapter.
//!
//! This adapter owns only Tauri delivery. Agentic event names and payload
//! shapes are projected by `openbitfun-events`.

#[cfg(feature = "tauri-adapter")]
use crate::traits::TransportAdapter;
use async_trait::async_trait;
use log::warn;
use openbitfun_events::{project_agentic_frontend_event, AgenticEvent};
use std::fmt;

#[cfg(feature = "tauri-adapter")]
use tauri::{AppHandle, Emitter};

#[cfg(feature = "tauri-adapter")]
pub struct TauriTransportAdapter {
    app_handle: AppHandle,
}

#[cfg(feature = "tauri-adapter")]
impl TauriTransportAdapter {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "tauri-adapter")]
impl fmt::Debug for TauriTransportAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TauriTransportAdapter")
            .field("adapter_type", &"tauri")
            .finish()
    }
}

#[cfg(feature = "tauri-adapter")]
#[async_trait]
impl TransportAdapter for TauriTransportAdapter {
    async fn emit_event(&self, event: AgenticEvent) -> anyhow::Result<()> {
        let Some(projected) = project_agentic_frontend_event(event) else {
            warn!("Unhandled AgenticEvent type in TauriAdapter");
            return Ok(());
        };
        self.emit_to("main", projected.event_name.as_str(), projected.payload)
            .await
    }

    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        if event_name.starts_with("agentic://") {
            self.emit_to("main", event_name, payload).await
        } else {
            self.app_handle.emit(event_name, payload)?;
            Ok(())
        }
    }

    async fn emit_to(
        &self,
        target: &str,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        self.app_handle.emit_to(target, event_name, payload)?;
        Ok(())
    }
}
