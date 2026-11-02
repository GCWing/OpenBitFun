//! Platform-neutral host port for driving a MiniApp Web surface.
//!
//! A MiniApp is a Web page hosted by the product window, so the Agent drives it
//! with BrowserUse semantics instead of source edits or Tauri-only commands.
//! This module owns the transport-neutral parts:
//!
//! - the host port the Desktop adapter registers,
//! - the session registry (one session is bound to exactly one `appId`),
//! - short-lived target handles and their staleness rules,
//! - typed request/response normalization for the Web UI surface runtime.
//!
//! DOM traversal and event dispatch stay in the Web UI surface runtime; the host
//! port only forwards a bounded, typed request and validates what comes back.

use async_trait::async_trait;
use openbitfun_product_domains::miniapp::web_surface::{
    validate_bridge_payload_size, MiniAppWebAppSummary, MiniAppWebCapability, MiniAppWebErrorCode,
    MiniAppWebNode, MiniAppWebSurfaceInfo, MiniAppWebTargetRegistry, MINIAPP_WEB_MAX_APPS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use tokio::sync::Mutex;

/// Actions the Web UI surface runtime must implement. Anything else is refused
/// before it reaches the frontend, so the Agent tool contract stays closed.
pub const SURFACE_METHODS: &[&str] = &[
    "inspect",
    "find",
    "read",
    "click",
    "type",
    "key",
    "scroll",
    // Pixel observation: a canvas or game surface has no readable structure, so
    // the frame itself is the only live state the Agent can perceive.
    "capture",
    "bridge_observe",
    "bridge_act",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppWebOpenRequest {
    pub app_id: String,
}

/// One forwarded surface request. `app_id`/`instance_id` identify the bound
/// surface so the frontend never resolves an ambiguous frame on its own.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppWebCommand {
    pub app_id: String,
    #[serde(default)]
    pub instance_id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl MiniAppWebCommand {
    pub fn new(
        app_id: &str,
        instance_id: Option<&str>,
        method: &str,
        params: Option<Value>,
    ) -> Self {
        Self {
            app_id: app_id.to_string(),
            instance_id: instance_id.map(str::to_string),
            method: method.to_string(),
            params,
        }
    }
}

/// Desktop (or any product surface) implementation of the MiniApp Web surface.
#[async_trait]
pub trait MiniAppWebHost: Send + Sync {
    /// Present the MiniApp in a surface the Agent can control and return its
    /// capabilities. Must not silently fall back to a surface the controller
    /// cannot reach.
    async fn open(&self, request: MiniAppWebOpenRequest) -> Result<MiniAppWebSurfaceInfo, String>;

    async fn execute(&self, command: MiniAppWebCommand) -> Result<Value, String>;

    /// Enumerate the MiniApps this host can present, so the Agent can address an
    /// app the user named instead of inventing an id or reading host paths.
    ///
    /// The default refuses: a host that does not know its installed apps must
    /// say so, because an empty list would read as "nothing is installed".
    async fn list_apps(&self) -> Result<Vec<MiniAppWebAppSummary>, String> {
        Err(format!(
            "{}: this host cannot enumerate installed MiniApps",
            MiniAppWebErrorCode::SurfaceUnavailable.as_str()
        ))
    }
}

type HostSlot = RwLock<Option<Arc<dyn MiniAppWebHost>>>;

static MINIAPP_WEB_HOST: OnceLock<HostSlot> = OnceLock::new();
static MINIAPP_WEB_SESSIONS: OnceLock<Mutex<SessionRegistry>> = OnceLock::new();

fn host_slot() -> &'static HostSlot {
    MINIAPP_WEB_HOST.get_or_init(|| RwLock::new(None))
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn set_miniapp_web_host(host: Arc<dyn MiniAppWebHost>) {
    *write_lock(host_slot()) = Some(host);
}

/// Tests that mutate the process-global host slot must serialize, including the
/// ones in sibling modules, so this lives at module level instead of inside the
/// test module that happened to need it first.
#[cfg(test)]
pub(crate) static HOST_SLOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn miniapp_web_host_available() -> bool {
    read_lock(host_slot()).is_some()
}

pub fn miniapp_web_host() -> Result<Arc<dyn MiniAppWebHost>, String> {
    read_lock(host_slot()).clone().ok_or_else(|| {
        "The MiniApp Web surface host is unavailable in this runtime. Controlling a MiniApp requires an active Desktop product surface.".to_string()
    })
}

fn sessions() -> &'static Mutex<SessionRegistry> {
    MINIAPP_WEB_SESSIONS.get_or_init(|| Mutex::new(SessionRegistry::default()))
}

/// A live control session. The session id is the only handle the Agent keeps
/// afterwards, so it must stay bound to the app that opened it.
#[derive(Debug)]
pub struct MiniAppWebSession {
    pub session_id: String,
    pub surface: MiniAppWebSurfaceInfo,
    owner_id: Option<String>,
    targets: MiniAppWebTargetRegistry,
}

impl MiniAppWebSession {
    pub fn app_id(&self) -> &str {
        &self.surface.app_id
    }

    pub fn snapshot(&self) -> MiniAppWebSessionSnapshot {
        MiniAppWebSessionSnapshot {
            session_id: self.session_id.clone(),
            app_id: self.surface.app_id.clone(),
            instance_id: self.surface.instance_id.clone(),
            strict_runtime: self.surface.strict_runtime,
            width: self.surface.width,
            height: self.surface.height,
            capabilities: self.surface.capabilities.clone(),
            bridge_capabilities: self.surface.bridge_capabilities.clone(),
            declared_actions: self.surface.declared_actions.clone(),
            presented_from: self.surface.presented_from.clone(),
            presentation: self.surface.presentation.clone(),
            target_count: self.targets.len(),
        }
    }

    pub fn to_value(&self) -> Value {
        self.snapshot().to_value()
    }
}

/// Detached view of a session. Tool responses must not hold the registry lock,
/// so every read path copies what it needs.
#[derive(Clone, Debug)]
pub struct MiniAppWebSessionSnapshot {
    pub session_id: String,
    pub app_id: String,
    pub instance_id: Option<String>,
    pub strict_runtime: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub capabilities: Vec<String>,
    pub bridge_capabilities: Vec<String>,
    /// Action types the app listed for `act`. Empty means it listed none, so the
    /// vocabulary is unknown rather than empty: the app still decides what it
    /// accepts, and an undeclared name is never blocked on this basis.
    pub declared_actions: Vec<String>,
    /// Where the app was presented before this request, when the host had to move
    /// it (for example out of its own window into a tab).
    pub presented_from: Option<String>,
    /// `Some("window")` when the Agent controls the MiniApp's own window, which
    /// answers the agent bridge but cannot receive DOM input or pixels.
    pub presentation: Option<String>,
    pub target_count: usize,
}

impl MiniAppWebSessionSnapshot {
    pub fn has_capability(&self, capability: MiniAppWebCapability) -> bool {
        self.capabilities
            .iter()
            .any(|value| value == capability.as_str())
    }

    pub fn has_dom(&self) -> bool {
        self.has_capability(MiniAppWebCapability::Dom)
    }

    pub fn has_bridge_capability(&self, capability: &str) -> bool {
        self.bridge_capabilities
            .iter()
            .any(|value| value == capability)
    }

    /// `true` when this session is bound to the MiniApp's own window rather than a
    /// tab the Agent opened.
    pub fn is_window_presentation(&self) -> bool {
        self.presentation.as_deref() == Some("window")
    }

    /// `false` means the MiniApp has not announced an agent bridge yet, so the
    /// declared set is unknown rather than empty. The surface runtime answers
    /// authoritatively in that case instead of the tool guessing.
    pub fn bridge_announced(&self) -> bool {
        !self.bridge_capabilities.is_empty()
    }

    pub fn to_value(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "appId": self.app_id,
            "instanceId": self.instance_id,
            "surface": {
                "kind": match self.is_window_presentation() {
                    true => "window",
                    false => "iframe",
                },
                "width": self.width,
                "height": self.height,
            },
            "strictRuntime": self.strict_runtime,
            "capabilities": self.capabilities,
            "bridgeCapabilities": self.bridge_capabilities,
            "bridgeAnnounced": self.bridge_announced(),
            "declaredActions": self.declared_actions,
            "presentedFrom": self.presented_from,
            "targets": self.target_count,
        })
    }
}

/// Process-wide session registry. Sessions are created by `open` and dropped by
/// `close`; they never outlive the surface they were bound to.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: HashMap<String, MiniAppWebSession>,
    next_id: u64,
}

impl SessionRegistry {
    fn mint_session_id(&mut self) -> String {
        let id = format!("miniapp-session-{}", self.next_id.max(1));
        self.next_id = self.next_id.max(1).saturating_add(1);
        id
    }

    /// Bind a new session to one app. Reopening the same app replaces the older
    /// session so the Agent never holds two handles to one surface.
    pub fn open(
        &mut self,
        surface: MiniAppWebSurfaceInfo,
        owner_id: Option<&str>,
    ) -> &MiniAppWebSession {
        self.sessions.retain(|_, session| {
            !(session.surface.app_id == surface.app_id && session.owner_id.as_deref() == owner_id)
        });
        let session_id = self.mint_session_id();
        let session = MiniAppWebSession {
            session_id: session_id.clone(),
            surface,
            owner_id: owner_id.map(str::to_string),
            targets: MiniAppWebTargetRegistry::new(),
        };
        self.sessions.insert(session_id.clone(), session);
        self.sessions
            .get(&session_id)
            .expect("session was just inserted")
    }

    pub fn get(&self, session_id: &str) -> Option<&MiniAppWebSession> {
        self.sessions.get(session_id)
    }

    pub fn get_mut(&mut self, session_id: &str) -> Option<&mut MiniAppWebSession> {
        self.sessions.get_mut(session_id)
    }

    pub fn close(&mut self, session_id: &str) -> Option<MiniAppWebSession> {
        self.sessions.remove(session_id)
    }

    pub fn list(&self) -> Vec<&MiniAppWebSession> {
        self.sessions.values().collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// Mint a target handle for a node the host just returned.
pub async fn mint_target(
    session_id: &str,
    node_key: &str,
    summary: String,
) -> Result<String, MiniAppWebErrorCode> {
    let now_ms = now_ms();
    let mut registry = sessions().lock().await;
    let session = registry
        .get_mut(session_id)
        .ok_or(MiniAppWebErrorCode::UnknownSession)?;
    let app_id = session.surface.app_id.clone();
    Ok(session.targets.mint(&app_id, node_key, summary, now_ms))
}

/// Resolve a target handle to the host-internal node key.
pub async fn resolve_target(
    session_id: &str,
    target_id: &str,
) -> Result<(String, String), MiniAppWebErrorCode> {
    let now_ms = now_ms();
    let mut registry = sessions().lock().await;
    let session = registry
        .get_mut(session_id)
        .ok_or(MiniAppWebErrorCode::UnknownSession)?;
    let app_id = session.surface.app_id.clone();
    let target = session.targets.resolve(&app_id, target_id, now_ms)?;
    Ok((target.node_key, target.summary))
}

/// Host errors are plain strings, but the surface runtime reports typed
/// failures with a leading `CODE:` (for example `STALE_TARGET: frame reloaded`).
/// Recognizing that prefix keeps the tool contract typed without a second
/// protocol on the port.
pub fn classify_surface_error(message: &str) -> MiniAppWebErrorCode {
    let Some((code, _rest)) = message.split_once(':') else {
        return MiniAppWebErrorCode::HostError;
    };
    let code = code.trim();
    [
        MiniAppWebErrorCode::InvalidParams,
        MiniAppWebErrorCode::UnknownApp,
        MiniAppWebErrorCode::UnknownSession,
        MiniAppWebErrorCode::UnknownTarget,
        MiniAppWebErrorCode::StaleTarget,
        MiniAppWebErrorCode::SurfaceUnavailable,
        MiniAppWebErrorCode::CapabilityMissing,
        MiniAppWebErrorCode::BridgeUnavailable,
        MiniAppWebErrorCode::BridgeTimeout,
        MiniAppWebErrorCode::BridgeRejected,
        MiniAppWebErrorCode::Timeout,
    ]
    .into_iter()
    .find(|candidate| candidate.as_str() == code)
    .unwrap_or(MiniAppWebErrorCode::HostError)
}

/// Enumerate installed MiniApps through the host port.
///
/// A host error keeps its typed code so the tool can tell "this runtime cannot
/// enumerate apps" apart from "the enumeration failed".
pub async fn list_installed_apps(
) -> Result<Vec<MiniAppWebAppSummary>, (MiniAppWebErrorCode, String)> {
    let host =
        miniapp_web_host().map_err(|error| (MiniAppWebErrorCode::SurfaceUnavailable, error))?;
    let apps = host
        .list_apps()
        .await
        .map_err(|error| (classify_surface_error(&error), error))?;
    let mut apps = apps;
    apps.truncate(MINIAPP_WEB_MAX_APPS);
    Ok(apps)
}

/// Forward one typed request to the product surface runtime.
pub async fn execute_surface(
    command: MiniAppWebCommand,
) -> Result<Value, (MiniAppWebErrorCode, String)> {
    if !SURFACE_METHODS.contains(&command.method.as_str()) {
        return Err((
            MiniAppWebErrorCode::InvalidParams,
            format!("Unsupported MiniApp surface method: {}", command.method),
        ));
    }
    let host =
        miniapp_web_host().map_err(|error| (MiniAppWebErrorCode::SurfaceUnavailable, error))?;
    let is_bridge = matches!(command.method.as_str(), "bridge_observe" | "bridge_act");
    let payload = host
        .execute(command)
        .await
        .map_err(|error| (classify_surface_error(&error), error))?;
    if is_bridge && validate_bridge_payload_size(&payload).is_err() {
        return Err((
            MiniAppWebErrorCode::BridgeRejected,
            "BRIDGE_REJECTED: the MiniApp bridge response exceeds the 32 KiB limit".to_string(),
        ));
    }
    Ok(payload)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse the `inspect` payload returned by the surface runtime. The tree is
/// re-sanitized here because the frontend is not a trust boundary.
pub fn parse_inspect_payload(
    payload: &Value,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Vec<MiniAppWebNode>,
        usize,
        bool,
    ),
    MiniAppWebErrorCode,
> {
    let nodes: Vec<MiniAppWebNode> = payload
        .get("tree")
        .cloned()
        .map(|tree| {
            if tree.is_array() {
                serde_json::from_value(tree).unwrap_or_default()
            } else {
                Vec::new()
            }
        })
        .unwrap_or_default();
    let declared_count = payload
        .get("nodeCount")
        .and_then(Value::as_u64)
        .unwrap_or(nodes.len() as u64) as usize;
    let (tree, truncated) = MiniAppWebNode::sanitize_tree(nodes);
    let declared_truncated = payload
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((
        payload
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        payload
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
        tree,
        declared_count,
        truncated || declared_truncated,
    ))
}

/// Parse the `find` payload: one entry per matching node.
pub fn parse_find_payload(payload: &Value) -> Vec<MiniAppWebNode> {
    let matches: Vec<MiniAppWebNode> = payload
        .get("matches")
        .and_then(Value::as_array)
        .map(|matches| {
            matches
                .iter()
                .filter_map(|value| serde_json::from_value::<MiniAppWebNode>(value.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let (mut matches, _) = MiniAppWebNode::sanitize_tree(
        matches
            .into_iter()
            .map(|mut node| {
                node.children.clear();
                node
            })
            .collect(),
    );
    matches.truncate(20);
    matches
}

/// Bind a freshly opened surface to a new control session. Reopening the same
/// app replaces the older session so one app never has two live handles.
pub async fn open_session(
    surface: MiniAppWebSurfaceInfo,
    owner_id: Option<&str>,
) -> MiniAppWebSessionSnapshot {
    sessions().lock().await.open(surface, owner_id).snapshot()
}

/// Release a control session. The MiniApp stays open for the user; only the
/// Agent's handles die.
pub async fn close_session(session_id: &str, owner_id: Option<&str>) -> bool {
    let mut registry = sessions().lock().await;
    if registry
        .get(session_id)
        .is_some_and(|session| session.owner_id.as_deref() == owner_id)
    {
        return registry.close(session_id).is_some();
    }
    false
}

pub async fn sessions_snapshot(
    session_id: &str,
    owner_id: Option<&str>,
) -> Option<MiniAppWebSessionSnapshot> {
    sessions()
        .lock()
        .await
        .get(session_id)
        .filter(|session| session.owner_id.as_deref() == owner_id)
        .map(MiniAppWebSession::snapshot)
}

pub async fn sessions_snapshot_all(owner_id: Option<&str>) -> Vec<MiniAppWebSessionSnapshot> {
    let mut snapshots = sessions()
        .lock()
        .await
        .list()
        .into_iter()
        .filter(|session| session.owner_id.as_deref() == owner_id)
        .map(MiniAppWebSession::snapshot)
        .collect::<Vec<_>>();
    snapshots.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    snapshots
}

/// Store bridge capabilities the MiniApp announced after `open`. The surface
/// runtime is authoritative for what the app declared.
pub async fn refresh_bridge_capabilities(session_id: &str, capabilities: Vec<String>) {
    let mut registry = sessions().lock().await;
    if let Some(session) = registry.get_mut(session_id) {
        session.surface.bridge_capabilities = capabilities;
    }
}

/// Keep the declared action vocabulary in step with the app.
///
/// The app can re-declare at any time, so a later observation replaces the
/// previous list instead of merging with it.
pub async fn refresh_bridge_actions(session_id: &str, actions: Vec<String>) {
    let mut registry = sessions().lock().await;
    if let Some(session) = registry.get_mut(session_id) {
        session.surface.declared_actions = actions;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RecordingHost {
        info: MiniAppWebSurfaceInfo,
        calls: AtomicUsize,
        last_method: RwLock<String>,
        response: Option<Value>,
    }

    impl RecordingHost {
        fn new(info: MiniAppWebSurfaceInfo) -> Self {
            Self {
                info,
                calls: AtomicUsize::new(0),
                last_method: RwLock::new(String::new()),
                response: None,
            }
        }
    }

    #[async_trait]
    impl MiniAppWebHost for RecordingHost {
        async fn open(
            &self,
            _request: MiniAppWebOpenRequest,
        ) -> Result<MiniAppWebSurfaceInfo, String> {
            Ok(self.info.clone())
        }

        async fn execute(&self, command: MiniAppWebCommand) -> Result<Value, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            *write_lock(&self.last_method) = command.method.clone();
            Ok(self
                .response
                .clone()
                .unwrap_or_else(|| json!({ "echo": command.method })))
        }
    }

    fn surface(app_id: &str) -> MiniAppWebSurfaceInfo {
        MiniAppWebSurfaceInfo {
            app_id: app_id.to_string(),
            capabilities: MiniAppWebCapability::readable_surface()
                .into_iter()
                .map(|capability| capability.as_str().to_string())
                .collect(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn reopening_an_app_replaces_the_previous_session() {
        let mut registry = SessionRegistry::default();
        let first = registry
            .open(surface("demo"), Some("owner-1"))
            .session_id
            .clone();
        let second = registry
            .open(surface("demo"), Some("owner-1"))
            .session_id
            .clone();
        assert_ne!(first, second);
        assert!(registry.get(&first).is_none());
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.get(&second).unwrap().app_id(), "demo");
    }

    #[tokio::test]
    async fn owners_keep_independent_sessions_for_the_same_app() {
        let mut registry = SessionRegistry::default();
        let first = registry
            .open(surface("demo"), Some("owner-1"))
            .session_id
            .clone();
        let second = registry
            .open(surface("demo"), Some("owner-2"))
            .session_id
            .clone();
        assert!(registry.get(&first).is_some());
        assert!(registry.get(&second).is_some());
        assert_eq!(registry.len(), 2);
    }

    #[tokio::test]
    async fn targets_resolve_only_inside_their_session_and_invalidate_on_reload() {
        let mut registry = SessionRegistry::default();
        let session_id = registry
            .open(surface("demo"), Some("owner-1"))
            .session_id
            .clone();
        let target_id = registry.get_mut(&session_id).unwrap().targets.mint(
            "demo",
            "n1",
            "target-1 button".to_string(),
            now_ms(),
        );
        assert_eq!(
            registry
                .get_mut(&session_id)
                .unwrap()
                .targets
                .resolve("demo", &target_id, now_ms())
                .map(|target| target.node_key),
            Ok("n1".to_string())
        );
        registry.get_mut(&session_id).unwrap().targets.invalidate();
        assert_eq!(
            registry
                .get_mut(&session_id)
                .unwrap()
                .targets
                .resolve("demo", &target_id, now_ms())
                .unwrap_err(),
            MiniAppWebErrorCode::UnknownTarget
        );
    }

    #[tokio::test]
    async fn unsupported_surface_methods_are_refused_before_the_host() {
        let _guard = HOST_SLOT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let host = Arc::new(RecordingHost::new(surface("demo")));
        set_miniapp_web_host(host.clone());
        let error = execute_surface(MiniAppWebCommand::new(
            "demo",
            None,
            "evaluate",
            Some(json!({"expression": "1+1"})),
        ))
        .await
        .expect_err("arbitrary evaluation must never be forwarded");
        assert_eq!(error.0, MiniAppWebErrorCode::InvalidParams);
        assert_eq!(host.calls.load(Ordering::Relaxed), 0);

        let value = execute_surface(MiniAppWebCommand::new("demo", None, "inspect", None))
            .await
            .expect("inspect is forwarded");
        assert_eq!(value["echo"], "inspect");
        assert_eq!(*read_lock(&host.last_method), "inspect");
    }

    #[tokio::test]
    async fn hosts_that_cannot_enumerate_apps_refuse_instead_of_reporting_none() {
        let _guard = HOST_SLOT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        set_miniapp_web_host(Arc::new(RecordingHost::new(surface("demo"))));
        let error = list_installed_apps()
            .await
            .expect_err("the default enumeration must refuse");
        assert_eq!(error.0, MiniAppWebErrorCode::SurfaceUnavailable);
    }

    #[tokio::test]
    async fn bridge_responses_are_bounded_at_the_rust_boundary() {
        let _guard = HOST_SLOT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut host = RecordingHost::new(surface("demo"));
        host.response = Some(json!({"state": "界".repeat(12 * 1024)}));
        set_miniapp_web_host(Arc::new(host));
        for method in ["bridge_observe", "bridge_act"] {
            let error = execute_surface(MiniAppWebCommand::new("demo", None, method, None))
                .await
                .expect_err("oversized bridge output must not reach the model");
            assert_eq!(error.0, MiniAppWebErrorCode::BridgeRejected);
        }
        // Non-bridge responses, including pixel captures, have their own bounds.
        assert!(
            execute_surface(MiniAppWebCommand::new("demo", None, "capture", None))
                .await
                .is_ok()
        );
    }

    #[test]
    fn inspect_payload_is_resanitized_and_bounded() {
        let payload = json!({
            "url": "miniapp://demo",
            "title": "Demo",
            "nodeCount": 900,
            "truncated": true,
            "tree": [{
                "nodeKey": "n1",
                "role": "main",
                "children": [{"nodeKey": "n2", "role": "button", "name": "Start"}]
            }],
        });
        let (url, title, tree, count, truncated) = parse_inspect_payload(&payload).unwrap();
        assert_eq!(url.as_deref(), Some("miniapp://demo"));
        assert_eq!(title.as_deref(), Some("Demo"));
        assert_eq!(count, 900);
        assert!(truncated);
        assert_eq!(tree[0].children[0].name.as_deref(), Some("Start"));
    }

    #[test]
    fn find_payload_keeps_flat_matches_only() {
        let payload = json!({
            "matches": [
                {"nodeKey": "n1", "role": "button", "name": "Start", "children": [{"nodeKey": "n2"}]},
                {"nodeKey": "n3", "role": "textbox", "name": "City"},
            ],
        });
        let matches = parse_find_payload(&payload);
        assert_eq!(matches.len(), 2);
        assert!(matches[0].children.is_empty());
        assert_eq!(matches[1].node_key.as_deref(), Some("n3"));
    }
}
