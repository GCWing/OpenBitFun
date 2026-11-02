//! Opt-in native fixture assertions; absent from production builds.
pub fn frontmost_pid() -> Option<i32> {
    super::macos_bg_input::frontmost_pid_macos()
}
pub fn minimize_window(pid: i32, window: u32) -> Result<(), String> {
    super::macos_ax_ui::minimize_window_for_fixture(pid, window)
}
pub fn webkit_target_frame(pid: i32, idx: u32) -> (f64, f64, f64, f64) {
    let target = super::macos_ax_dump::retained_cached_target(pid, idx).unwrap();
    assert_ne!(
        unsafe { super::macos_ax_dispatch::actual_pid(target.reference().0) }.unwrap(),
        pid,
        "The fixture must exercise a real WebKit subprocess element"
    );
    target
        .frame_global()
        .expect("WebKit button must expose real geometry")
}
pub async fn assert_revoked_writes(owner: &str, pid: i32, native_idx: u32) {
    let native_target = super::macos_ax_dump::retained_cached_target(pid, native_idx).unwrap();
    let lease = super::control_session::acquire(owner, "app_click").unwrap();
    let stale_token = super::control_session::capture_token().unwrap();
    super::control_session::stop(Some(owner), "fixture_revoke_queued_input").unwrap();
    drop(lease);
    tokio::task::spawn_blocking(move || {
        use super::{control_session, macos_ax_dispatch};
        use core_foundation::{base::TCFType, string::CFString};
        assert_eq!(
            unsafe { macos_ax_dispatch::actual_pid(native_target.reference().0) }.unwrap(),
            pid,
            "Revocation must exercise a same-process main-queue message"
        );
        control_session::with_token(stale_token, || unsafe {
            let action = CFString::new("AXRaise");
            assert_eq!(
                macos_ax_dispatch::perform_action(
                    native_target.reference().0,
                    action.as_concrete_TypeRef()
                ),
                -25200,
                "Stopped input must be rejected on main before AXRaise"
            );
            let attr = CFString::new("AXTitle");
            let value = CFString::new("Revoked write must not arrive");
            assert_eq!(
                macos_ax_dispatch::set_input_attribute_value(
                    native_target.reference().0,
                    attr.as_concrete_TypeRef(),
                    value.as_CFTypeRef()
                ),
                -25200,
                "Stopped input must be rejected on main before attribute writes"
            );
        });
    })
    .await
    .unwrap();
}
pub fn assert_unbound_window_rejected(owner: &str, pid: i32) {
    let mut lease = super::control_session::acquire(owner, "app_click").unwrap();
    let snapshot = super::macos_ax_dump::dump_app_ax(pid, Default::default()).unwrap();
    let foreign = snapshot
        .nodes
        .iter()
        .find(|node| node.title.as_deref() == Some("Unbound semantic action"))
        .expect("second-window control missing");
    let target = super::macos_ax_dump::retained_cached_target(pid, foreign.idx).unwrap();
    assert!(super::macos_ax_dump::validate_bound_target(pid, target.reference()).is_err());
    assert!(matches!(
        super::macos_ax_write::try_ax_press(target.reference()),
        super::macos_ax_write::AxWriteOutcome::Unavailable(_)
    ));
    lease.complete();
}
pub fn deactivate_target(pid: i32, window: u32) {
    let identity = super::macos_skylight::process_identity(pid).unwrap();
    assert!(super::macos_skylight::set_local_activation(
        identity, window, false
    ));
}
pub struct ProcessIdentity(super::process_identity::ProcessIdentity);
impl ProcessIdentity {
    pub fn read(pid: i32) -> Result<Self, String> {
        super::process_identity::ProcessIdentity::read(pid).map(Self)
    }
    pub fn validate(&self) -> Result<(), String> {
        self.0.validate()
    }
}
