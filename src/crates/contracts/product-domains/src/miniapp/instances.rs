//! MiniApp presentation contracts. Transfers retain the instance until all views close.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MINIAPP_PRESENTATION_PROTOCOL: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MiniAppViewKind {
    Window,
    Tab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppView {
    pub view_id: String,
    pub kind: MiniAppViewKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppInstance {
    pub instance_id: String,
    pub app_id: String,
    pub workspace_path: Option<String>,
    pub primary_view: Option<MiniAppView>,
    pub pending_view: Option<MiniAppView>,
    /// Content control is deliberately not advertised by the presentation host.
    #[serde(default)]
    pub content_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppInstanceSnapshot {
    pub protocol_version: u32,
    pub host_epoch: String,
    pub revision: u64,
    pub instances: Vec<MiniAppInstance>,
}

/// Future semantic controls use declared actions, never arbitrary JS evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppContentActionRequest {
    pub instance_id: String,
    pub action: String,
    pub arguments: Value,
    pub request_id: String,
}

impl MiniAppInstance {
    pub fn has_views(&self) -> bool {
        self.primary_view.is_some() || self.pending_view.is_some()
    }

    pub fn accepts_view(&self, view_id: &str) -> bool {
        self.primary_view
            .iter()
            .chain(self.pending_view.iter())
            .any(|view| view.view_id == view_id)
    }

    /// The old view remains authoritative until the prepared target reports ready.
    pub fn prepare(&mut self, view: MiniAppView) -> Result<MiniAppView, String> {
        if let Some(current) = &self.primary_view {
            if current.kind == view.kind {
                return Ok(current.clone());
            }
        }
        if let Some(pending) = &self.pending_view {
            if pending.kind == view.kind {
                return Ok(pending.clone());
            }
            return Err("A MiniApp view transfer is already in progress".into());
        }
        self.pending_view = Some(view.clone());
        Ok(view)
    }

    pub fn ready(&mut self, view_id: &str) -> Result<Option<MiniAppView>, String> {
        if self
            .primary_view
            .as_ref()
            .is_some_and(|view| view.view_id == view_id)
        {
            return Ok(None);
        }
        if !self
            .pending_view
            .as_ref()
            .is_some_and(|view| view.view_id == view_id)
        {
            return Err("MiniApp view is stale or was not prepared".into());
        }
        Ok(std::mem::replace(
            &mut self.primary_view,
            self.pending_view.take(),
        ))
    }

    pub fn detach(&mut self, view_id: &str) {
        if self
            .primary_view
            .as_ref()
            .is_some_and(|view| view.view_id == view_id)
        {
            self.primary_view = None;
        }
        if self
            .pending_view
            .as_ref()
            .is_some_and(|view| view.view_id == view_id)
        {
            self.pending_view = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn instance() -> MiniAppInstance {
        MiniAppInstance {
            instance_id: "instance".into(),
            app_id: "app".into(),
            workspace_path: None,
            primary_view: Some(MiniAppView {
                view_id: "old".into(),
                kind: MiniAppViewKind::Window,
            }),
            pending_view: None,
            content_capabilities: vec![],
        }
    }
    #[test]
    fn failed_transfer_keeps_source_and_stale_ready_cannot_close_it() {
        let mut value = instance();
        value
            .prepare(MiniAppView {
                view_id: "new".into(),
                kind: MiniAppViewKind::Tab,
            })
            .unwrap();
        assert_eq!(value.primary_view.as_ref().unwrap().view_id, "old");
        value.detach("new");
        assert!(value.ready("new").is_err());
        assert_eq!(value.primary_view.as_ref().unwrap().view_id, "old");
    }
    #[test]
    fn commit_is_idempotent_and_late_close_does_not_detach_target() {
        let mut value = instance();
        value
            .prepare(MiniAppView {
                view_id: "new".into(),
                kind: MiniAppViewKind::Tab,
            })
            .unwrap();
        assert_eq!(value.ready("new").unwrap().unwrap().view_id, "old");
        assert!(value.ready("new").unwrap().is_none());
        value.detach("old");
        assert_eq!(value.primary_view.as_ref().unwrap().view_id, "new");
    }
    #[test]
    fn older_instance_payload_has_no_content_control_capability() {
        let old = serde_json::json!({"instanceId":"i","appId":"a","workspacePath":null,"primaryView":null,"pendingView":null});
        let value: MiniAppInstance = serde_json::from_value(old.clone()).unwrap();
        assert!(value.content_capabilities.is_empty());
        let roundtrip = serde_json::to_value(value).unwrap();
        for (key, expected) in old.as_object().unwrap() {
            assert_eq!(&roundtrip[key], expected);
        }
    }
}
