use openbitfun_agent_runtime::custom_agent::CustomAgentDiscoveryRoots;

/// The mutex owning this state serializes discovery and publication. Watch events
/// are consumed before a scan, so events arriving during it remain pending.
#[derive(Default)]
pub(super) struct CustomAgentLoadState {
    pub(super) roots: Option<CustomAgentDiscoveryRoots>,
    pub(super) published: bool,
    #[cfg(feature = "file-watch")]
    monitor: Option<UserAgentWatch>,
}

impl CustomAgentLoadState {
    pub(super) async fn prepare(&mut self, roots: &CustomAgentDiscoveryRoots) -> bool {
        let mut user_roots = roots.clone();
        user_roots.workspace_root = None;
        let changed = !self.published || self.roots.as_ref() != Some(&user_roots);
        self.roots = Some(user_roots);
        let previously_published = self.published;
        self.published = false;
        #[cfg(feature = "file-watch")]
        {
            let monitor = self.monitor.get_or_insert_with(UserAgentWatch::new);
            let dirty = monitor
                .prepare(roots.openbitfun_user_agents_dir.as_deref(), changed)
                .await;
            self.published = previously_published && !dirty;
            dirty
        }
        #[cfg(not(feature = "file-watch"))]
        {
            let _ = (changed, previously_published);
            // Hosts without native watching always discover on query.
            true
        }
    }
}

#[cfg(feature = "file-watch")]
use openbitfun_services_integrations::file_watch::{
    FileWatchEvent, FileWatchEventKind, FileWatchService, FileWatcherConfig,
};
#[cfg(feature = "file-watch")]
use std::path::{Path, PathBuf};
#[cfg(feature = "file-watch")]
use tokio::sync::broadcast::{error::TryRecvError, Receiver};

#[cfg(feature = "file-watch")]
struct UserAgentWatch {
    service: FileWatchService,
    events: Receiver<Vec<FileWatchEvent>>,
    failures: Receiver<()>,
    registrations: Vec<(PathBuf, bool)>,
    healthy: bool,
}

#[cfg(feature = "file-watch")]
fn watch_config(recursive: bool) -> FileWatcherConfig {
    FileWatcherConfig {
        watch_recursively: recursive,
        ignore_hidden_files: false,
        ignore_common_build_directories: false,
        debounce_interval_ms: 0,
        ..Default::default()
    }
}

#[cfg(feature = "file-watch")]
impl UserAgentWatch {
    fn new() -> Self {
        let service = FileWatchService::new(watch_config(true));
        let events = service.subscribe();
        let failures = service.subscribe_health_failures();
        Self {
            service,
            events,
            failures,
            registrations: Vec::new(),
            healthy: false,
        }
    }

    async fn prepare(&mut self, root: Option<&Path>, changed: bool) -> bool {
        let mut dirty = changed || !self.healthy || !self.service.is_healthy();
        loop {
            match self.failures.try_recv() {
                Ok(()) | Err(TryRecvError::Lagged(_)) => dirty = true,
                Err(TryRecvError::Closed) => {
                    dirty = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        loop {
            match self.events.try_recv() {
                Ok(events) => {
                    dirty |= events.iter().any(|event| {
                        let relevant = |path: &str| root.is_some_and(|root| {
                            let path = Path::new(path);
                            path.starts_with(root) || root.starts_with(path)
                        });
                        relevant(&event.path) || matches!(&event.kind,
                            FileWatchEventKind::Rename { from, to } if relevant(from) || relevant(to))
                    });
                }
                Err(TryRecvError::Lagged(_)) => dirty = true,
                Err(TryRecvError::Closed) => {
                    dirty = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        // Watch the root recursively and its nearest existing parent shallowly.
        // The parent catches creation and atomic replacement of the root itself.
        let mut desired = Vec::new();
        if let Some(root) = root {
            if root.is_dir() {
                desired.push((root.to_path_buf(), true));
            }
            if let Some(parent) = root.ancestors().skip(1).find(|p| p.is_dir()) {
                desired.push((parent.to_path_buf(), false));
            }
        }
        dirty |= desired != self.registrations;
        if !dirty {
            return false;
        }

        self.healthy = false;
        for (path, _) in self.registrations.drain(..) {
            if let Err(error) = self.service.unwatch_path(&path.to_string_lossy()).await {
                log::warn!(
                    "Failed to remove custom Agent watch {}: {}",
                    path.display(),
                    error
                );
            }
        }
        if !self.service.is_healthy() {
            if let Err(error) = self.service.rebuild_watcher().await {
                log::warn!("Failed to rebuild custom Agent watcher: {}", error);
                return true;
            }
        }
        let mut healthy = !desired.is_empty();
        for (path, recursive) in desired {
            match self
                .service
                .watch_path(&path.to_string_lossy(), Some(watch_config(recursive)))
                .await
            {
                Ok(()) => self.registrations.push((path, recursive)),
                Err(error) => {
                    healthy = false;
                    log::warn!(
                        "Failed to watch custom Agent directory {}: {}",
                        path.display(),
                        error
                    );
                }
            }
        }
        self.healthy = healthy && self.service.is_healthy();
        true
    }
}

#[cfg(all(test, feature = "file-watch"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stable_watch_reuses_cache_and_unavailable_watch_stays_dirty() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let roots = CustomAgentDiscoveryRoots {
            workspace_root: Some(root.path().join("workspace")),
            openbitfun_user_agents_dir: Some(agents.clone()),
            home_dir: None,
        };
        let mut state = CustomAgentLoadState::default();
        assert!(state.prepare(&roots).await);
        state.published = true;
        assert!(!state.prepare(&roots).await);
        assert!(state.roots.as_ref().unwrap().workspace_root.is_none());
        let monitor = state.monitor.as_ref().unwrap();
        assert_eq!(
            monitor.registrations,
            vec![(agents, true), (root.path().to_path_buf(), false)]
        );

        // A host with no usable root cannot mark its discovery cache fresh.
        let unavailable = CustomAgentDiscoveryRoots {
            workspace_root: None,
            openbitfun_user_agents_dir: None,
            home_dir: None,
        };
        assert!(state.prepare(&unavailable).await);
        assert!(state.prepare(&unavailable).await);
    }
}
