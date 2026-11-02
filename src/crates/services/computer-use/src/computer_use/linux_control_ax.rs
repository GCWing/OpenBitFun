//! AT-SPI semantic operations: no compositor focus changes or pointer injection.
use atspi::{
    connection::P2P, proxy::proxy_ext::ProxyExt, AccessibilityConnection, CoordType,
    ObjectRefOwned, State,
};
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::{AppInfo, AppSelector, AppStateSnapshot, AxNode};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
struct CachedNode {
    scope: openbitfun_agent_tools::computer_use_control::ObservationScope,
    pid: i32,
    object: ObjectRefOwned,
    role: String,
    title: String,
}
static CACHE: OnceLock<Mutex<HashMap<i32, Vec<CachedNode>>>> = OnceLock::new();
fn cache() -> &'static Mutex<HashMap<i32, Vec<CachedNode>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn clear_observations() {
    if let Ok(mut entries) = cache().lock() {
        entries.clear();
    }
}
fn error(message: impl std::fmt::Display) -> OpenBitFunError {
    OpenBitFunError::tool(format!("[AT_SPI] {message}"))
}

async fn applications(
    connection: &AccessibilityConnection,
) -> OpenBitFunResult<Vec<(AppInfo, ObjectRefOwned)>> {
    let root = connection
        .root_accessible_on_registry()
        .await
        .map_err(error)?;
    let bus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
        .await
        .map_err(error)?;
    let mut result = Vec::new();
    for object in root.get_children().await.map_err(error)? {
        let Some(destination) = object.name_as_str() else {
            continue;
        };
        let destination = atspi::zbus::names::BusName::try_from(destination).map_err(error)?;
        let pid = bus
            .get_connection_unix_process_id(destination)
            .await
            .map_err(error)?;
        let accessible = connection
            .object_as_accessible(&object)
            .await
            .map_err(error)?;
        result.push((
            AppInfo {
                name: accessible.name().await.map_err(error)?,
                bundle_id: None,
                pid: i32::try_from(pid).ok(),
                running: true,
                last_used_ms: None,
                launch_count: 0,
            },
            object,
        ));
    }
    Ok(result)
}

pub(super) async fn list_apps() -> OpenBitFunResult<Vec<AppInfo>> {
    let connection = AccessibilityConnection::new().await.map_err(error)?;
    Ok(applications(&connection)
        .await?
        .into_iter()
        .map(|(app, _)| app)
        .collect())
}

fn bound_selector(target: Option<&str>) -> OpenBitFunResult<AppSelector> {
    let pid = target.and_then(|target| target.strip_prefix("atspi:"))
        .and_then(|pid| pid.parse::<i32>().ok()).filter(|pid| *pid > 0)
        .ok_or_else(|| error("[TARGET_REQUIRED] Select an application with get_app_state and an explicit app PID or name before AT-SPI observation. Portal pixel selection does not identify an application."))?;
    Ok(AppSelector::by_pid(pid))
}

pub(super) fn bound_app_selector() -> OpenBitFunResult<AppSelector> {
    bound_selector(super::control_session::snapshot().target.as_deref())
}

/// Resolve and bind identity without replacing the caller's cached node indices.
pub(super) async fn bind_app_selector(selector: &AppSelector) -> OpenBitFunResult<()> {
    let connection = AccessibilityConnection::new().await.map_err(error)?;
    let (app, _) = resolve(&connection, selector).await?;
    let pid = app
        .pid
        .ok_or_else(|| error("[APP_IDENTITY_UNAVAILABLE] Missing PID"))?;
    super::control_session::bind_target(format!("atspi:{pid}")).map_err(error)
}

/// Locate starts at exactly the bound application's root, never the desktop registry.
pub(super) async fn bound_application_root(
    connection: &AccessibilityConnection,
) -> OpenBitFunResult<ObjectRefOwned> {
    let selector = bound_app_selector()?;
    let (_, root) = resolve(connection, &selector).await?;
    Ok(root)
}

async fn resolve(
    connection: &AccessibilityConnection,
    selector: &AppSelector,
) -> OpenBitFunResult<(AppInfo, ObjectRefOwned)> {
    let bound;
    let selector = if selector.is_empty() {
        bound = bound_app_selector()?;
        &bound
    } else {
        selector
    };
    if selector.pid.is_none() && selector.name.is_none() {
        return Err(error("[APP_SELECTOR_REQUIRED] Linux semantic operations require an explicit PID or exact application name."));
    }
    let candidates: Vec<_> = applications(connection)
        .await?
        .into_iter()
        .filter(|(app, _)| {
            if let Some(pid) = selector.pid {
                app.pid == Some(pid)
            } else {
                selector
                    .name
                    .as_ref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&app.name))
            }
        })
        .collect();
    if candidates.len() != 1 {
        return Err(error(
            "[APP_AMBIGUOUS_OR_MISSING] Select one AT-SPI application by PID.",
        ));
    }
    Ok(candidates.into_iter().next().unwrap())
}

pub(super) async fn snapshot(
    selector: AppSelector,
    max_depth: u32,
    focus_only: bool,
) -> OpenBitFunResult<AppStateSnapshot> {
    snapshot_impl(selector, max_depth, focus_only, true).await
}

/// The human's semantic preview must not replace indices held by the Agent's
/// last observation. Only the Agent observation path publishes actionable nodes.
pub(super) async fn preview_snapshot(
    selector: AppSelector,
    max_depth: u32,
) -> OpenBitFunResult<AppStateSnapshot> {
    snapshot_impl(selector, max_depth, false, false).await
}

async fn snapshot_impl(
    selector: AppSelector,
    max_depth: u32,
    focus_only: bool,
    publish_nodes: bool,
) -> OpenBitFunResult<AppStateSnapshot> {
    let selector = if selector.is_empty() {
        bound_app_selector()?
    } else {
        selector
    };
    let connection = AccessibilityConnection::new().await.map_err(error)?;
    let (app, root) = resolve(&connection, &selector).await?;
    let pid = app
        .pid
        .ok_or_else(|| error("[APP_IDENTITY_UNAVAILABLE] Missing PID"))?;
    super::control_session::bind_target(format!("atspi:{pid}")).map_err(error)?;
    let scope = super::control_session::observation_scope().map_err(error)?;
    let selected_window = if focus_only {
        let accessible = connection
            .object_as_accessible(&root)
            .await
            .map_err(error)?;
        let children = accessible.get_children().await.map_err(error)?;
        let mut active = Vec::new();
        for child in &children {
            let window = connection
                .object_as_accessible(child)
                .await
                .map_err(error)?;
            if window
                .get_state()
                .await
                .map_err(error)?
                .contains(State::Active)
            {
                active.push(child.clone());
            }
        }
        if active.len() == 1 {
            active.pop()
        } else if children.len() == 1 {
            children.into_iter().next()
        } else {
            return Err(error("[WINDOW_SCOPE_UNAVAILABLE] No unique active window for this background application; request focus_window_only=false."));
        }
    } else {
        None
    };
    let mut queue = VecDeque::from([(root.clone(), None, 0u32)]);
    let mut seen = HashSet::new();
    let mut nodes = Vec::new();
    let mut cached = Vec::new();
    let mut tree = String::from("AT-SPI semantic tree. Pixel capture is separate: portal selection does not prove application identity.\n");
    while let Some((object, parent, depth)) = queue.pop_front() {
        if depth > max_depth.min(200) || !seen.insert(object.clone()) {
            continue;
        }
        if nodes.len() >= 12_000 {
            return Err(error("[OBSERVATION_TOO_LARGE] Narrow the application or reduce max_depth; no partial actionable tree was published."));
        }
        let accessible = connection
            .object_as_accessible(&object)
            .await
            .map_err(error)?;
        let role = accessible.get_role_name().await.map_err(error)?;
        let title = accessible.name().await.map_err(error)?;
        let states = accessible.get_state().await.map_err(error)?;
        if states.contains(State::Defunct) {
            continue;
        }
        // Window scoping is AT-SPI Active, not global focus manipulation. App root is retained.
        if depth == 1
            && selected_window
                .as_ref()
                .is_some_and(|selected| selected != &object)
        {
            continue;
        }
        let proxies = accessible.proxies().await.map_err(error)?;
        let frame = match proxies.component().await {
            Ok(component) => component
                .get_extents(CoordType::Screen)
                .await
                .ok()
                .filter(|(_, _, w, h)| *w > 0 && *h > 0)
                .map(|(x, y, w, h)| (x as f64, y as f64, w as f64, h as f64)),
            Err(_) => None,
        };
        // Older GTK ATK bridges have a broken GetActions array marshaller.
        // NActions/GetName are the same standard contract without that array path.
        let mut actions = Vec::new();
        if let Ok(action) = proxies.action().await {
            if let Ok(count) = action.inner().get_property::<i32>("NActions").await {
                for action_index in 0..count {
                    if let Ok(name) = action.get_name(action_index).await {
                        actions.push(name);
                    }
                }
            }
        }
        let value = if states.contains(State::Editable)
            && !role.to_ascii_lowercase().contains("password")
        {
            match proxies.text().await {
                Ok(text) => text.get_text(0, -1).await.ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        let idx = nodes.len() as u32;
        tree.push_str(&format!(
            "{}[{}] {} {:?} enabled={} focused={} actions={:?}\n",
            "  ".repeat(depth as usize),
            idx,
            role,
            title,
            states.contains(State::Enabled),
            states.contains(State::Focused),
            actions
        ));
        cached.push(CachedNode {
            scope: scope.clone(),
            pid,
            object: object.clone(),
            role: role.clone(),
            title: title.clone(),
        });
        nodes.push(AxNode {
            idx,
            parent_idx: parent,
            role,
            title: Some(title),
            value,
            description: accessible
                .description()
                .await
                .ok()
                .filter(|s| !s.is_empty()),
            identifier: accessible
                .accessible_id()
                .await
                .ok()
                .filter(|s| !s.is_empty()),
            enabled: states.contains(State::Enabled),
            focused: states.contains(State::Focused),
            selected: Some(states.contains(State::Selected)),
            frame_global: frame,
            actions,
            role_description: None,
            subrole: None,
            help: None,
            url: None,
            expanded: Some(states.contains(State::Expanded)),
        });
        for child in accessible.get_children().await.map_err(error)? {
            queue.push_back((child, Some(idx), depth + 1));
        }
    }
    let digest = super::ax_snapshot_digest::compute_digest(&nodes);
    let window_title = nodes
        .iter()
        .find(|node| node.parent_idx == Some(0))
        .and_then(|node| node.title.clone());
    let pid = app
        .pid
        .ok_or_else(|| error("[APP_IDENTITY_UNAVAILABLE] AT-SPI application PID unavailable"))?;
    super::control_session::validate_observation_scope(&scope).map_err(error)?;
    if publish_nodes {
        let mut entries = cache().lock().map_err(error)?;
        entries.clear();
        entries.insert(pid, cached);
    }
    Ok(AppStateSnapshot {
        observation_id: None,
        app,
        window_title,
        tree_text: tree,
        nodes,
        digest,
        captured_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        screenshot: None,
        loop_warning: None,
    })
}

async fn cached_target(
    selector: &AppSelector,
    index: u32,
) -> OpenBitFunResult<(AccessibilityConnection, CachedNode)> {
    let connection = AccessibilityConnection::new().await.map_err(error)?;
    let (app, root) = resolve(&connection, selector).await?;
    let pid = app
        .pid
        .ok_or_else(|| error("[APP_IDENTITY_UNAVAILABLE] Missing PID"))?;
    let target = cache()
        .lock()
        .map_err(error)?
        .get(&pid)
        .and_then(|nodes| nodes.get(index as usize))
        .cloned()
        .ok_or_else(|| error("[STALE_NODE] Read get_app_state before acting on a node index."))?;
    if super::control_session::validate_observation_scope(&target.scope).is_err() {
        return Err(error(
            "[STALE_NODE] Control session changed; read a fresh application snapshot.",
        ));
    }
    if target.object.name_as_str() != root.name_as_str() {
        return Err(error("[STALE_NODE] Application instance changed."));
    }
    let accessible = connection
        .object_as_accessible(&target.object)
        .await
        .map_err(|_| error("[STALE_NODE] Accessible no longer exists."))?;
    if accessible.name().await.map_err(error)? != target.title
        || accessible.get_role_name().await.map_err(error)? != target.role
    {
        return Err(error(
            "[STALE_NODE] Accessible identity changed; read a fresh snapshot.",
        ));
    }
    let states = accessible.get_state().await.map_err(error)?;
    if states.contains(State::Defunct) || !states.contains(State::Enabled) {
        return Err(error(
            "[NODE_UNAVAILABLE] Accessible is defunct or disabled.",
        ));
    }
    Ok((connection, target))
}

pub(super) async fn press(selector: &AppSelector, index: u32) -> OpenBitFunResult<()> {
    let (connection, target) = cached_target(selector, index).await?;
    let accessible = connection
        .object_as_accessible(&target.object)
        .await
        .map_err(error)?;
    let proxies = accessible.proxies().await.map_err(error)?;
    let action = proxies.action().await.map_err(|_| {
        error("[BACKGROUND_ACTION_UNAVAILABLE] Target exposes no AT-SPI Action interface.")
    })?;
    if action
        .inner()
        .get_property::<i32>("NActions")
        .await
        .map_err(error)?
        < 1
    {
        return Err(error(
            "[BACKGROUND_ACTION_UNAVAILABLE] Target exposes no default action.",
        ));
    }
    // AT-SPI defines action zero as the default semantic action. Never also inject a click.
    super::control_session::input_allowed().map_err(error)?;
    super::control_session::bind_target(format!("atspi:{}", target.pid)).map_err(error)?;
    if !action.do_action(0).await.map_err(error)? {
        return Err(error(
            "[ACTION_REJECTED] AT-SPI default action was rejected.",
        ));
    }
    Ok(())
}

pub(super) async fn insert_text(
    selector: &AppSelector,
    index: u32,
    text: &str,
) -> OpenBitFunResult<()> {
    let (connection, target) = cached_target(selector, index).await?;
    let accessible = connection
        .object_as_accessible(&target.object)
        .await
        .map_err(error)?;
    let proxies = accessible.proxies().await.map_err(error)?;
    let editor = proxies.editable_text().await.map_err(|_| {
        error("[BACKGROUND_TEXT_UNAVAILABLE] Target exposes no EditableText interface.")
    })?;
    let readable = proxies.text().await.map_err(error)?;
    if text.is_empty() {
        return Ok(());
    }
    let caret = readable.caret_offset().await.map_err(error)?;
    let characters = readable.character_count().await.map_err(error)?;
    // atspi-proxies 0.13 generates GetNselections; the AT-SPI wire name is
    // GetNSelections. Use the real method until that proxy spelling is fixed.
    let selections: i32 = readable
        .inner()
        .call("GetNSelections", &())
        .await
        .map_err(error)?;
    let selected = match selections {
        0 => None,
        1 => Some(readable.get_selection(0).await.map_err(error)?),
        _ => return Err(error("[BACKGROUND_TEXT_UNAVAILABLE] Multiple text selections cannot be replaced as one typing action.")),
    };
    let (start, end) = selected.unwrap_or((caret, caret));
    if start < 0 || end < start || end > characters {
        return Err(error(
            "[STALE_TEXT_SELECTION] Text selection or caret is outside the observed text.",
        ));
    }
    // EditableText.InsertText takes a UTF-8 byte length, while Text offsets
    // count Unicode characters. Mixing the two places the caret after CJK or
    // emoji at the wrong offset and can reorder subsequent typing.
    let count = i32::try_from(text.len()).map_err(error)?;
    let next_caret = start
        .checked_add(i32::try_from(text.chars().count()).map_err(error)?)
        .ok_or_else(|| {
            error("[BACKGROUND_TEXT_UNAVAILABLE] Resulting caret exceeds AT-SPI offset range.")
        })?;
    super::control_session::input_allowed().map_err(error)?;
    super::control_session::bind_target(format!("atspi:{}", target.pid)).map_err(error)?;
    if end > start && !editor.delete_text(start, end).await.map_err(error)? {
        return Err(error(
            "[ACTION_REJECTED] AT-SPI selected-text deletion was rejected.",
        ));
    }
    // Deletion may already have occurred if insertion fails. Propagate the
    // failure once; the caller must observe rather than replay this mutation.
    super::control_session::input_allowed().map_err(error)?;
    if !editor
        .insert_text(start, text, count)
        .await
        .map_err(error)?
    {
        return Err(error(
            "[ACTION_REJECTED] AT-SPI text insertion was rejected.",
        ));
    }
    super::control_session::input_allowed().map_err(error)?;
    if !readable.set_caret_offset(next_caret).await.map_err(error)? {
        return Err(error("[ACTION_REJECTED] Text was inserted but AT-SPI caret placement was rejected; observe before further input."));
    }
    Ok(())
}

#[cfg(test)]
mod native_tests {
    use super::*;

    #[test]
    fn portal_capture_is_not_an_atspi_application_identity() {
        assert_eq!(bound_selector(Some("atspi:73")).unwrap().pid, Some(73));
        for target in [
            None,
            Some("portal:73"),
            Some("pid:73/window:1"),
            Some("atspi:0"),
            Some("atspi:-1"),
            Some("atspi:73/extra"),
        ] {
            assert!(bound_selector(target).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "requires the dedicated GTK fixture and a live AT-SPI bus"]
    async fn atspi_semantic_fixture() {
        use openbitfun_agent_tools::computer_use_control::ControlMode;
        let pid: i32 = std::env::var("OPENBITFUN_ATSPI_FIXTURE_PID")
            .expect("run scripts/test-linux-computer-use-atspi.sh")
            .parse()
            .unwrap();
        let selector = AppSelector::by_pid(pid);
        super::super::control_session::start("native-atspi-fixture", ControlMode::Background)
            .unwrap();
        let mut lease =
            super::super::control_session::acquire("native-atspi-fixture", "app_click").unwrap();
        let query = openbitfun_agent_tools::computer_use_host::UiElementLocateQuery {
            text_contains: Some("Activate fixture".into()),
            ..Default::default()
        };
        let unbound = super::super::linux_ax_ui::locate_ui_element_center(query.clone())
            .await
            .unwrap_err();
        assert!(unbound.to_string().contains("TARGET_REQUIRED"));
        bind_app_selector(&selector).await.unwrap();
        let located = super::super::linux_ax_ui::locate_ui_element_center(query.clone())
            .await
            .unwrap();
        assert_eq!(located.matched_title.as_deref(), Some("Activate fixture"));
        super::super::control_session::bind_target("atspi:2147483647".into()).unwrap();
        assert!(
            super::super::linux_ax_ui::locate_ui_element_center(query)
                .await
                .is_err(),
            "a missing bound app must not match a different registered app"
        );
        bind_app_selector(&selector).await.unwrap();
        let before = snapshot(AppSelector::default(), 32, false).await.unwrap();
        assert_eq!(before.app.pid, Some(pid));
        let button = before
            .nodes
            .iter()
            .find(|node| node.title.as_deref() == Some("Activate fixture"))
            .expect("fixture button")
            .idx;
        bind_app_selector(&selector).await.unwrap();
        press(&selector, button).await.unwrap();
        let after = snapshot(selector.clone(), 32, false).await.unwrap();
        assert!(
            after
                .nodes
                .iter()
                .any(|node| node.title.as_deref() == Some("Activated 1")),
            "semantic action must execute exactly once"
        );
        let entry = after
            .nodes
            .iter()
            .find(|node| node.title.as_deref() == Some("Fixture text"))
            .expect("fixture EditableText")
            .idx;
        insert_text(&selector, entry, "\u{4e2d}\u{6587} native")
            .await
            .unwrap();
        let typed = snapshot(selector.clone(), 32, false).await.unwrap();
        assert!(
            typed
                .nodes
                .iter()
                .any(|node| node.value.as_deref() == Some("prefix \u{4e2d}\u{6587} native")),
            "UTF-8 insertion must preserve the entire string"
        );
        assert_ne!(
            after.digest, typed.digest,
            "text changes must affect observation digest"
        );
        let entry = typed
            .nodes
            .iter()
            .find(|node| node.title.as_deref() == Some("Fixture text"))
            .unwrap()
            .idx;
        let (connection, target) = cached_target(&selector, entry).await.unwrap();
        let accessible = connection
            .object_as_accessible(&target.object)
            .await
            .unwrap();
        let proxies = accessible.proxies().await.unwrap();
        let readable = proxies.text().await.unwrap();
        assert!(readable.add_selection(0, 7).await.unwrap());
        assert_eq!(
            readable
                .inner()
                .call::<_, _, i32>("GetNSelections", &())
                .await
                .unwrap(),
            1
        );
        insert_text(&selector, entry, "\u{66ff}\u{6362}\u{1f642}")
            .await
            .unwrap();
        let count = readable.character_count().await.unwrap();
        assert_eq!(
            readable.get_text(0, count).await.unwrap(),
            "\u{66ff}\u{6362}\u{1f642}\u{4e2d}\u{6587} native",
            "typing replaces the selected prefix, preserving unselected text"
        );
        assert_eq!(
            readable.caret_offset().await.unwrap(),
            3,
            "caret uses Unicode characters, not UTF-8 bytes"
        );
        insert_text(&selector, entry, "!").await.unwrap();
        let count = readable.character_count().await.unwrap();
        assert_eq!(
            readable.get_text(0, count).await.unwrap(),
            "\u{66ff}\u{6362}\u{1f642}!\u{4e2d}\u{6587} native",
            "a following input must continue after the inserted Unicode text"
        );
        lease.complete();
        drop(lease);
        super::super::control_session::stop(None, "native fixture complete").unwrap();
    }
}
