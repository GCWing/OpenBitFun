//! Compatibility facade for the MiniApp JS worker pool.

use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::miniapp::js_worker::{JsWorker, MiniAppWorkerEvent, MiniAppWorkerEventFuture};
use crate::miniapp::runtime_detect::DetectedRuntime;
use crate::miniapp::types::{NodePermissions, NpmDep};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_product_domains::miniapp::ports::{
    MiniAppInstallDepsRequest, MiniAppPortError, MiniAppPortErrorKind, MiniAppPortFuture,
    MiniAppRuntimePort,
};
pub use openbitfun_product_domains::miniapp::worker::InstallResult;
use openbitfun_services_integrations::miniapp::worker::{
    MiniAppWorkerEventSink, SharedMiniAppWorkerEventSink,
};
use openbitfun_services_integrations::miniapp::worker_pool::{
    JsWorkerPool as ServiceJsWorkerPool, MiniAppWorkerPoolError, MiniAppWorkerPoolErrorKind,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct JsWorkerPool {
    inner: ServiceJsWorkerPool,
}

impl JsWorkerPool {
    pub fn new(
        path_manager: Arc<crate::infrastructure::PathManager>,
        worker_host_path: PathBuf,
        resource_dir: Option<PathBuf>,
    ) -> OpenBitFunResult<Self> {
        let event_sink: SharedMiniAppWorkerEventSink = Arc::new(CoreMiniAppWorkerEventSink);
        ServiceJsWorkerPool::new(
            path_manager.miniapps_dir(),
            worker_host_path,
            resource_dir,
            Some(event_sink),
        )
        .map(|inner| Self { inner })
        .map_err(map_worker_pool_error)
    }

    pub fn runtime_info(&self) -> &DetectedRuntime {
        self.inner.runtime_info()
    }

    pub async fn get_or_spawn(
        &self,
        app_id: &str,
        worker_revision: &str,
        policy_json: &str,
        node_perms: Option<&NodePermissions>,
    ) -> OpenBitFunResult<Arc<Mutex<JsWorker>>> {
        self.inner
            .get_or_spawn(app_id, worker_revision, policy_json, node_perms)
            .await
            .map_err(map_worker_pool_error)
    }

    pub async fn get_or_spawn_with_app_dir(
        &self,
        worker_key: &str,
        app_id: &str,
        app_dir: &Path,
        worker_revision: &str,
        policy_json: &str,
        node_perms: Option<&NodePermissions>,
    ) -> OpenBitFunResult<Arc<Mutex<JsWorker>>> {
        self.inner
            .get_or_spawn_with_app_dir(
                worker_key,
                app_id,
                app_dir,
                worker_revision,
                policy_json,
                node_perms,
            )
            .await
            .map_err(map_worker_pool_error)
    }

    pub async fn call(
        &self,
        app_id: &str,
        worker_revision: &str,
        policy_json: &str,
        permissions: Option<&NodePermissions>,
        method: &str,
        params: Value,
    ) -> OpenBitFunResult<Value> {
        self.inner
            .call(
                app_id,
                worker_revision,
                policy_json,
                permissions,
                method,
                params,
            )
            .await
            .map_err(map_worker_pool_error)
    }

    pub async fn call_with_app_dir(
        &self,
        worker_key: &str,
        app_id: &str,
        app_dir: &Path,
        worker_revision: &str,
        policy_json: &str,
        permissions: Option<&NodePermissions>,
        method: &str,
        params: Value,
    ) -> OpenBitFunResult<Value> {
        self.inner
            .call_with_app_dir(
                worker_key,
                app_id,
                app_dir,
                worker_revision,
                policy_json,
                permissions,
                method,
                params,
            )
            .await
            .map_err(map_worker_pool_error)
    }

    pub async fn stop(&self, app_id: &str) {
        self.inner.stop(app_id).await;
    }

    pub async fn list_running(&self) -> Vec<String> {
        self.inner.list_running().await
    }

    pub async fn is_running(&self, app_id: &str) -> bool {
        self.inner.is_running(app_id).await
    }

    pub async fn stop_all(&self) {
        self.inner.stop_all().await;
    }

    pub fn has_installed_deps(&self, app_id: &str) -> bool {
        self.inner.has_installed_deps(app_id)
    }

    pub fn has_installed_deps_in_dir(&self, app_dir: &Path) -> bool {
        self.inner.has_installed_deps_in_dir(app_dir)
    }

    pub async fn install_deps(
        &self,
        app_id: &str,
        deps: &[NpmDep],
    ) -> OpenBitFunResult<InstallResult> {
        self.inner
            .install_deps(app_id, deps)
            .await
            .map_err(map_worker_pool_error)
    }

    pub async fn install_deps_in_dir(
        &self,
        app_dir: &Path,
        deps: &[NpmDep],
    ) -> OpenBitFunResult<InstallResult> {
        self.inner
            .install_deps_in_dir(app_dir, deps)
            .await
            .map_err(map_worker_pool_error)
    }

    #[cfg(test)]
    fn from_runtime_for_tests(
        path_manager: Arc<crate::infrastructure::PathManager>,
        worker_host_path: PathBuf,
        runtime: DetectedRuntime,
    ) -> Self {
        Self {
            inner: ServiceJsWorkerPool::from_runtime(
                path_manager.miniapps_dir(),
                worker_host_path,
                None,
                runtime,
                Some(Arc::new(CoreMiniAppWorkerEventSink)),
            ),
        }
    }
}

impl MiniAppRuntimePort for JsWorkerPool {
    fn detect_runtime(&self) -> MiniAppPortFuture<'_, Option<DetectedRuntime>> {
        Box::pin(async move { Ok(Some(self.runtime_info().clone())) })
    }

    fn install_deps(
        &self,
        request: MiniAppInstallDepsRequest,
    ) -> MiniAppPortFuture<'_, InstallResult> {
        Box::pin(async move {
            self.install_deps(&request.app_id, &request.dependencies)
                .await
                .map_err(map_miniapp_runtime_port_error)
        })
    }
}

fn map_worker_pool_error(error: MiniAppWorkerPoolError) -> OpenBitFunError {
    match error.kind() {
        MiniAppWorkerPoolErrorKind::NotFound => {
            OpenBitFunError::NotFound(error.message().to_string())
        }
        MiniAppWorkerPoolErrorKind::Validation => {
            OpenBitFunError::validation(error.message().to_string())
        }
        MiniAppWorkerPoolErrorKind::Io => OpenBitFunError::io(error.message().to_string()),
        MiniAppWorkerPoolErrorKind::RuntimeUnavailable => {
            OpenBitFunError::ProcessError(error.message().to_string())
        }
        MiniAppWorkerPoolErrorKind::Backend => {
            OpenBitFunError::service(error.message().to_string())
        }
    }
}

fn map_miniapp_runtime_port_error(error: OpenBitFunError) -> MiniAppPortError {
    let kind = match &error {
        OpenBitFunError::NotFound(_) => MiniAppPortErrorKind::NotFound,
        OpenBitFunError::Validation(_) | OpenBitFunError::Deserialization(_) => {
            MiniAppPortErrorKind::InvalidInput
        }
        OpenBitFunError::Io(io_error)
            if io_error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            MiniAppPortErrorKind::PermissionDenied
        }
        OpenBitFunError::Io(_) => MiniAppPortErrorKind::Io,
        OpenBitFunError::ProcessError(_) | OpenBitFunError::Timeout(_) => {
            MiniAppPortErrorKind::RuntimeUnavailable
        }
        _ => MiniAppPortErrorKind::Backend,
    };
    MiniAppPortError::new(kind, error.to_string())
}

struct CoreMiniAppWorkerEventSink;

impl MiniAppWorkerEventSink for CoreMiniAppWorkerEventSink {
    fn emit_worker_event<'a>(&'a self, event: MiniAppWorkerEvent) -> MiniAppWorkerEventFuture<'a> {
        Box::pin(async move {
            let event_full_name = format!("miniapp://worker-event:{}", event.app_id);
            let payload = serde_json::json!({
                "appId": event.app_id,
                "event": event.event,
                "data": event.data,
            });
            let _ = emit_global_event(BackendEvent::Custom {
                event_name: event_full_name,
                payload,
            })
            .await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::miniapp::runtime::RuntimeKind;
    use std::fs;

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("test root should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn runtime_port_adapter_preserves_existing_runtime_and_noop_install() {
        let root = TestTempDir::new("openbitfun-miniapp-runtime-port");
        let path_manager = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(root.path().to_path_buf()),
        );
        let app_id = "demo_app";
        tokio::fs::create_dir_all(path_manager.miniapp_dir(app_id))
            .await
            .unwrap();
        let pool = JsWorkerPool::from_runtime_for_tests(
            path_manager,
            PathBuf::from("worker-host.js"),
            DetectedRuntime {
                kind: RuntimeKind::Node,
                path: PathBuf::from("node"),
                version: "v20.0.0".to_string(),
            },
        );
        let port: &dyn MiniAppRuntimePort = &pool;

        let runtime = port.detect_runtime().await.unwrap().unwrap();
        assert_eq!(runtime.kind, RuntimeKind::Node);
        assert_eq!(runtime.version, "v20.0.0");

        let result = port
            .install_deps(MiniAppInstallDepsRequest {
                app_id: app_id.to_string(),
                dependencies: vec![NpmDep {
                    name: "lodash".to_string(),
                    version: "^4.17.21".to_string(),
                }],
            })
            .await
            .unwrap();
        assert!(result.success);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
    }

    #[tokio::test]
    async fn install_deps_in_dir_noops_without_package_json() {
        let root = TestTempDir::new("openbitfun-miniapp-runtime-draft-port");
        let path_manager = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(root.path().to_path_buf()),
        );
        let draft_dir = path_manager
            .miniapps_dir()
            .join(".drafts")
            .join("demo_app")
            .join("draft_1");
        tokio::fs::create_dir_all(&draft_dir).await.unwrap();
        let pool = JsWorkerPool::from_runtime_for_tests(
            path_manager,
            PathBuf::from("worker-host.js"),
            DetectedRuntime {
                kind: RuntimeKind::Node,
                path: PathBuf::from("node"),
                version: "v20.0.0".to_string(),
            },
        );

        let result = pool
            .install_deps_in_dir(
                &draft_dir,
                &[NpmDep {
                    name: "lodash".to_string(),
                    version: "^4.17.21".to_string(),
                }],
            )
            .await
            .unwrap();
        assert!(result.success);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
    }
}
