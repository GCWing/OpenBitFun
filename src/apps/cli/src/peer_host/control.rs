//! Peer Mode control-plane subscribers (attach / detach / ping).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tokio::sync::{RwLock, RwLockReadGuard};

use openbitfun_core::service::remote_connect::DeviceIdentity;
use openbitfun_product_domains::remote_surface::{
    capability_map, digest as remote_surface_digest, PeerHostKind,
};

#[derive(Default)]
struct ControllerRegistry {
    ids: HashSet<String>,
}

static CONTROL_SUBSCRIBERS: OnceLock<Mutex<ControllerRegistry>> = OnceLock::new();
static CONTROLLER_DELIVERY: OnceLock<RwLock<()>> = OnceLock::new();
const MAX_ATTACHED_CONTROLLERS: usize = i32::MAX as usize;

fn control_subscribers() -> &'static Mutex<ControllerRegistry> {
    CONTROL_SUBSCRIBERS.get_or_init(|| Mutex::new(ControllerRegistry::default()))
}

fn controller_delivery() -> &'static RwLock<()> {
    CONTROLLER_DELIVERY.get_or_init(|| RwLock::new(()))
}

pub(crate) async fn attach_controller(device_id: String) -> Result<(), String> {
    if device_id.trim().is_empty() {
        return Err("controller_device_id is required".to_string());
    }
    let _delivery = controller_delivery().write().await;
    let mut registry = control_subscribers()
        .lock()
        .map_err(|_| "Peer controller registry is unavailable".to_string())?;
    if !registry.ids.contains(&device_id) && registry.ids.len() >= MAX_ATTACHED_CONTROLLERS {
        return Err("Peer controller capacity is exhausted".to_string());
    }
    registry.ids.insert(device_id);
    Ok(())
}

/// Remove one DeviceEvent delivery target.
///
/// Controller presence is not Runtime ownership. In particular, removing the
/// final target must not expose a lifecycle signal that callers could turn into
/// cancellation of a Host-accepted Turn.
pub(crate) async fn detach_controller(device_id: &str) {
    let _delivery = controller_delivery().write().await;
    if let Ok(mut registry) = control_subscribers().lock() {
        detach_from_registry(&mut registry, device_id);
    }
}

/// Retain only currently reachable DeviceEvent delivery targets.
///
/// Losing every target does not end Host-owned Turns; the Runtime projection is
/// kept for a later controller attachment.
pub(crate) async fn retain_online_controllers<'a>(online: impl IntoIterator<Item = &'a str>) {
    let online = online.into_iter().collect::<HashSet<_>>();
    let _delivery = controller_delivery().write().await;
    if let Ok(mut registry) = control_subscribers().lock() {
        retain_online_in_registry(&mut registry, &online);
    }
}

pub(crate) async fn controller_delivery_lease(
    device_id: &str,
) -> Option<RwLockReadGuard<'static, ()>> {
    let lease = controller_delivery().read().await;
    let attached = control_subscribers()
        .lock()
        .map(|registry| registry.ids.contains(device_id))
        .unwrap_or(false);
    attached.then_some(lease)
}

fn detach_from_registry(registry: &mut ControllerRegistry, device_id: &str) {
    registry.ids.remove(device_id);
}

fn retain_online_in_registry(registry: &mut ControllerRegistry, online: &HashSet<&str>) {
    registry
        .ids
        .retain(|device_id| online.contains(device_id.as_str()));
}

pub(crate) fn attached_controllers() -> Vec<String> {
    let mut controllers: Vec<String> = control_subscribers()
        .lock()
        .map(|registry| registry.ids.iter().cloned().collect())
        .unwrap_or_default();
    controllers.sort();
    controllers
}

fn is_controller_attached(device_id: &str) -> bool {
    control_subscribers()
        .lock()
        .map(|registry| registry.ids.contains(device_id))
        .unwrap_or(false)
}

/// `peer_mode_ping`, optionally answered for the controller named in its args.
///
/// A controller that sends its `controller_device_id` (the id it attaches
/// with) receives the additive `caller_attached` field advertised by
/// `peer_attachment_status_v1`, so a link this host dropped on presence loss
/// re-attaches instead of reporting ready. Older controllers send no id.
pub(crate) fn peer_mode_ping_for_args(args: &Value) -> Value {
    let caller = parse_controller_device_id(args);
    let mut value = peer_mode_ping_value();
    if !caller.trim().is_empty() {
        value["caller_attached"] = Value::Bool(is_controller_attached(&caller));
    }
    value
}

fn peer_mode_ping_value() -> Value {
    let device_id = DeviceIdentity::from_current_machine()
        .map(|d| d.device_id)
        .unwrap_or_else(|_| "unknown".to_string());
    json!({
        "ok": true,
        "peer": true,
        "device_id": device_id,
        // Declares which kind of host answered so the controller can resolve
        // capabilities that an older CLI did not advertise. Older CLI hosts
        // omitted `cancel_tool`/`tool_catalog` and lacked
        // `submit_user_answers`; reporting the host kind lets the controller
        // gate those controls instead of showing actions that silently fail.
        "host_type": PeerHostKind::Cli.as_wire_str(),
        // Only advertised keys, all `true`, taken from the Product Operation
        // Registry so the desktop host, this host and the generated frontend
        // artifact publish and consume one capability list.
        "capabilities": Value::Object(capability_map(PeerHostKind::Cli)),
        // Additive: lets a controller detect that this host and its own
        // generated tables were built from different registries.
        "surface_registry_digest": remote_surface_digest(),
        // A CLI host executes product commands without a webview bridge.
        "host_ui_ready": true,
    })
}

pub(crate) fn parse_controller_device_id(args: &Value) -> String {
    args.get("controllerDeviceId")
        .or_else(|| args.get("controller_device_id"))
        .or_else(|| {
            args.get("request").and_then(|req| {
                req.get("controllerDeviceId")
                    .or_else(|| req.get("controller_device_id"))
            })
        })
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use super::{
        attach_controller, controller_delivery_lease, detach_controller, detach_from_registry,
        peer_mode_ping_for_args, retain_online_in_registry, ControllerRegistry,
    };
    use serde_json::json;

    #[tokio::test]
    async fn ping_reports_whether_the_named_caller_is_attached() {
        let caller = "ping-caller-attachment";
        let args = json!({ "controller_device_id": caller });
        let detached = peer_mode_ping_for_args(&args);
        assert_eq!(detached["caller_attached"], json!(false));
        assert_eq!(
            detached["capabilities"]["peer_attachment_status_v1"],
            json!(true)
        );
        assert_eq!(detached["host_ui_ready"], json!(true));

        attach_controller(caller.to_string()).await.expect("attach");
        assert_eq!(
            peer_mode_ping_for_args(&args)["caller_attached"],
            json!(true)
        );
        detach_controller(caller).await;
        assert_eq!(
            peer_mode_ping_for_args(&args)["caller_attached"],
            json!(false)
        );

        // Older controllers send no id and get the legacy payload.
        assert!(peer_mode_ping_for_args(&json!({}))
            .get("caller_attached")
            .is_none());
    }

    #[test]
    fn detach_only_updates_delivery_subscribers() {
        let mut registry = ControllerRegistry {
            ids: HashSet::from(["controller-1".to_string(), "controller-2".to_string()]),
        };
        detach_from_registry(&mut registry, "controller-1");
        assert_eq!(registry.ids, HashSet::from(["controller-2".to_string()]));

        detach_from_registry(&mut registry, "controller-2");
        assert!(registry.ids.is_empty());

        detach_from_registry(&mut registry, "controller-2");
        assert!(registry.ids.is_empty());
    }

    #[test]
    fn presence_removal_only_updates_delivery_subscribers() {
        let mut registry = ControllerRegistry {
            ids: HashSet::from(["controller-1".to_string(), "controller-2".to_string()]),
        };
        let first_online = HashSet::from(["controller-1"]);
        retain_online_in_registry(&mut registry, &first_online);
        assert_eq!(registry.ids, HashSet::from(["controller-1".to_string()]));

        retain_online_in_registry(&mut registry, &HashSet::new());
        assert!(registry.ids.is_empty());
    }

    #[tokio::test]
    async fn detach_waits_for_an_in_flight_delivery_lease() {
        let controller_id = "delivery-lease-controller".to_string();
        attach_controller(controller_id.clone())
            .await
            .expect("attach controller");
        let delivery_lease = controller_delivery_lease(&controller_id)
            .await
            .expect("delivery lease");
        let started = Arc::new(tokio::sync::Barrier::new(2));
        let detach_started = Arc::clone(&started);
        let detach_id = controller_id.clone();
        let detach_task = tokio::spawn(async move {
            detach_started.wait().await;
            detach_controller(&detach_id).await
        });

        started.wait().await;
        tokio::task::yield_now().await;
        assert!(!detach_task.is_finished());

        drop(delivery_lease);
        detach_task.await.expect("detach task");
        assert!(controller_delivery_lease(&controller_id).await.is_none());
    }
}
