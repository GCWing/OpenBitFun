//! One host-owned presentation registry shared by tabs and independently launched shells.
use openbitfun_product_domains::miniapp::instances::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub struct MiniAppInstances {
    state: Mutex<State>,
}
struct State {
    snapshot: MiniAppInstanceSnapshot,
    leases: HashMap<String, Instant>,
}

impl Default for MiniAppInstances {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                snapshot: MiniAppInstanceSnapshot {
                    protocol_version: MINIAPP_PRESENTATION_PROTOCOL,
                    host_epoch: Uuid::new_v4().to_string(),
                    revision: 0,
                    instances: vec![],
                },
                leases: HashMap::new(),
            }),
        }
    }
}

impl MiniAppInstances {
    /// A native container may keep committed views alive while its WebView
    /// timers are suspended. Pending transfers must still acknowledge ready.
    pub fn renew_committed_views(&self, kind: MiniAppViewKind) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let views: Vec<_> = state
            .snapshot
            .instances
            .iter()
            .filter_map(|instance| instance.primary_view.as_ref())
            .filter(|view| view.kind == kind)
            .map(|view| view.view_id.clone())
            .collect();
        for view in views {
            state.leases.insert(view, Instant::now());
        }
    }

    pub fn snapshot(&self) -> MiniAppInstanceSnapshot {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let expired: Vec<_> = state
            .leases
            .iter()
            .filter(|(_, at)| at.elapsed() > Duration::from_secs(45))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            state.leases.remove(&id);
            for instance in &mut state.snapshot.instances {
                instance.detach(&id);
            }
            state.snapshot.revision += 1;
        }
        state.snapshot.clone()
    }

    pub fn prepare(
        &self,
        app_id: String,
        workspace_path: Option<String>,
        kind: MiniAppViewKind,
    ) -> Result<(MiniAppInstance, MiniAppView), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // Existing worker/Agent policies are app-scoped. Until their owner supports
        // concurrent workspace scopes, reject an unsafe second scope explicitly.
        let index = match state
            .snapshot
            .instances
            .iter()
            .position(|i| i.app_id == app_id)
        {
            Some(index) => {
                if state.snapshot.instances[index].workspace_path != workspace_path {
                    return Err("This MiniApp is bound to another workspace; close its instance before changing workspace".into());
                }
                index
            }
            None => {
                state.snapshot.instances.push(MiniAppInstance {
                    instance_id: Uuid::new_v4().to_string(),
                    app_id,
                    workspace_path,
                    primary_view: None,
                    pending_view: None,
                    content_capabilities: vec![],
                });
                state.snapshot.instances.len() - 1
            }
        };
        let view = state.snapshot.instances[index].prepare(MiniAppView {
            view_id: Uuid::new_v4().to_string(),
            kind,
        })?;
        let instance = state.snapshot.instances[index].clone();
        state.leases.insert(view.view_id.clone(), Instant::now());
        state.snapshot.revision += 1;
        Ok((instance, view))
    }

    pub fn get(&self, instance_id: &str) -> Result<MiniAppInstance, String> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot
            .instances
            .iter()
            .find(|i| i.instance_id == instance_id)
            .cloned()
            .ok_or_else(|| "MiniApp instance no longer exists; reconnect to the host".into())
    }

    pub fn touch(&self, instance_id: &str, view_id: &str) -> Result<MiniAppInstance, String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let instance = state
            .snapshot
            .instances
            .iter()
            .find(|i| i.instance_id == instance_id)
            .ok_or("MiniApp instance no longer exists")?
            .clone();
        if !instance.accepts_view(view_id) {
            return Err("MiniApp view was released".into());
        }
        // A target which never acknowledges ready must expire even if its UI
        // keeps polling. Heartbeats renew only committed presentations.
        if instance
            .primary_view
            .as_ref()
            .is_some_and(|view| view.view_id == view_id)
        {
            state.leases.insert(view_id.into(), Instant::now());
        }
        Ok(instance)
    }

    pub fn ready(&self, instance_id: &str, view_id: &str) -> Result<Option<MiniAppView>, String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let instance = state
            .snapshot
            .instances
            .iter_mut()
            .find(|i| i.instance_id == instance_id)
            .ok_or("MiniApp instance no longer exists")?;
        let previous = instance.ready(view_id)?;
        state.leases.insert(view_id.into(), Instant::now());
        if let Some(previous) = &previous {
            state.leases.remove(&previous.view_id);
        }
        state.snapshot.revision += 1;
        Ok(previous)
    }

    /// Return an unpresented instance for host-owned shutdown. A transfer's
    /// prepared destination counts as a view even before its ready handshake.
    pub fn detach(&self, instance_id: &str, view_id: &str) -> Option<MiniAppInstance> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(instance) = state
            .snapshot
            .instances
            .iter_mut()
            .find(|i| i.instance_id == instance_id)
        {
            instance.detach(view_id);
            let unpresented = (!instance.has_views()).then(|| instance.clone());
            state.leases.remove(view_id);
            state.snapshot.revision += 1;
            return unpresented;
        }
        None
    }

    pub fn retire(&self, instance_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(index) = state
            .snapshot
            .instances
            .iter()
            .position(|i| i.instance_id == instance_id)
        {
            let instance = state.snapshot.instances.remove(index);
            for view in instance
                .primary_view
                .iter()
                .chain(instance.pending_view.iter())
            {
                state.leases.remove(&view.view_id);
            }
            state.snapshot.revision += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_a_transfer_source_keeps_the_target_and_last_close_requests_shutdown() {
        for source_kind in [MiniAppViewKind::Window, MiniAppViewKind::Tab] {
            let target_kind = if source_kind == MiniAppViewKind::Window {
                MiniAppViewKind::Tab
            } else {
                MiniAppViewKind::Window
            };
            let registry = MiniAppInstances::default();
            let (instance, source) = registry.prepare("notes".into(), None, source_kind).unwrap();
            registry
                .ready(&instance.instance_id, &source.view_id)
                .unwrap();
            let (_, target) = registry.prepare("notes".into(), None, target_kind).unwrap();
            let (other, _) = registry
                .prepare("other".into(), None, MiniAppViewKind::Tab)
                .unwrap();
            assert!(registry
                .detach(&instance.instance_id, &source.view_id)
                .is_none());
            registry
                .ready(&instance.instance_id, &target.view_id)
                .unwrap();
            // A delayed native Close event from the old presentation is harmless.
            assert!(registry
                .detach(&instance.instance_id, &source.view_id)
                .is_none());
            let stopped = registry
                .detach(&instance.instance_id, &target.view_id)
                .unwrap();
            assert!(!stopped.has_views());
            assert_eq!(stopped.app_id, "notes");
            assert!(registry.get(&other.instance_id).unwrap().has_views());
            registry.retire(&stopped.instance_id);
            assert!(registry
                .detach(&instance.instance_id, &target.view_id)
                .is_none());
        }
    }

    #[test]
    fn failed_target_keeps_source_but_abandoned_initial_launch_becomes_unpresented() {
        let registry = MiniAppInstances::default();
        let (instance, source) = registry
            .prepare("notes".into(), None, MiniAppViewKind::Window)
            .unwrap();
        registry
            .ready(&instance.instance_id, &source.view_id)
            .unwrap();
        let (_, target) = registry
            .prepare("notes".into(), None, MiniAppViewKind::Tab)
            .unwrap();
        assert!(registry
            .detach(&instance.instance_id, &target.view_id)
            .is_none());
        assert_eq!(
            registry.get(&instance.instance_id).unwrap().primary_view,
            Some(source)
        );
        let (initial, target) = registry
            .prepare("new".into(), None, MiniAppViewKind::Tab)
            .unwrap();
        assert!(registry
            .detach(&initial.instance_id, &target.view_id)
            .is_some());
    }

    #[test]
    fn a_crashed_last_window_is_unpresented_after_lease_expiry() {
        let registry = MiniAppInstances::default();
        let (instance, window) = registry
            .prepare("notes".into(), None, MiniAppViewKind::Window)
            .unwrap();
        registry
            .ready(&instance.instance_id, &window.view_id)
            .unwrap();
        registry
            .state
            .lock()
            .unwrap()
            .leases
            .insert(window.view_id, Instant::now() - Duration::from_secs(46));
        assert!(!registry.snapshot().instances[0].has_views());
    }
    #[test]
    fn independent_launch_reuses_instance_and_window_but_fences_workspace() {
        let registry = MiniAppInstances::default();
        let (a, view) = registry
            .prepare("app".into(), None, MiniAppViewKind::Window)
            .unwrap();
        registry.ready(&a.instance_id, &view.view_id).unwrap();
        let (b, second) = registry
            .prepare("app".into(), None, MiniAppViewKind::Window)
            .unwrap();
        assert_eq!(a.instance_id, b.instance_id);
        assert_eq!(view, second);
        assert!(registry
            .prepare(
                "app".into(),
                Some("/another".into()),
                MiniAppViewKind::Window
            )
            .is_err());
        let _ = registry.detach(&a.instance_id, &view.view_id);
        assert!(registry.get(&a.instance_id).unwrap().primary_view.is_none());
        registry.retire(&a.instance_id);
        assert!(registry
            .prepare(
                "app".into(),
                Some("/another".into()),
                MiniAppViewKind::Window
            )
            .is_ok());
    }
    #[test]
    fn native_container_keeps_committed_tabs_alive_but_cannot_commit_pending_views() {
        let registry = MiniAppInstances::default();
        let (instance, tab) = registry
            .prepare("notes".into(), None, MiniAppViewKind::Tab)
            .unwrap();
        registry.ready(&instance.instance_id, &tab.view_id).unwrap();
        let (_, target) = registry
            .prepare("notes".into(), None, MiniAppViewKind::Window)
            .unwrap();
        {
            let mut state = registry.state.lock().unwrap();
            for view in [&tab, &target] {
                state.leases.insert(
                    view.view_id.clone(),
                    Instant::now() - Duration::from_secs(46),
                );
            }
        }
        registry.renew_committed_views(MiniAppViewKind::Tab);
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.instances[0].primary_view.as_ref(), Some(&tab));
        assert!(snapshot.instances[0].pending_view.is_none());
    }
    #[test]
    fn target_heartbeat_does_not_keep_failed_transfer_alive() {
        let registry = MiniAppInstances::default();
        let (instance, window) = registry
            .prepare("app".into(), None, MiniAppViewKind::Window)
            .unwrap();
        registry
            .ready(&instance.instance_id, &window.view_id)
            .unwrap();
        let (_, tab) = registry
            .prepare("app".into(), None, MiniAppViewKind::Tab)
            .unwrap();
        registry.state.lock().unwrap().leases.insert(
            tab.view_id.clone(),
            Instant::now() - Duration::from_secs(46),
        );
        registry.touch(&instance.instance_id, &tab.view_id).unwrap();
        let snapshot = registry.snapshot();
        assert!(snapshot.instances[0].pending_view.is_none());
        assert_eq!(
            snapshot.instances[0].primary_view.as_ref().unwrap().view_id,
            window.view_id
        );
    }
}
