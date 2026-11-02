//! Operation-boundary desktop witnesses adapted from computer-use-rust's
//! background-interference check. They never restore focus or replay input.
use super::*;
use openbitfun_agent_tools::computer_use_control::{
    BackgroundObservation, ControlMode, ObservationScope,
};

#[derive(Debug, Clone)]
struct Witness {
    foreground: Vec<String>,
    pointer: Option<(f64, f64)>,
    window_order: Option<Vec<String>>,
    activation_epoch: Option<u64>,
}

// New/closed windows do not establish a raise. Compare the relative order of
// windows that existed at both boundaries, including the human foreground.
fn common_order_unchanged(before: &[String], after: &[String]) -> bool {
    let common_before: Vec<_> = before
        .iter()
        .filter(|window| after.contains(window))
        .collect();
    let common_after: Vec<_> = after
        .iter()
        .filter(|window| before.contains(window))
        .collect();
    common_before == common_after
}

fn evidence(before: &Witness, after: &Witness, sequence: u64) -> BackgroundObservation {
    BackgroundObservation {
        sequence,
        foreground_unchanged: before.foreground == after.foreground
            && match (before.activation_epoch, after.activation_epoch) { (Some(a),Some(b)) => a == b, _ => true },
        cursor_unchanged: before.pointer.zip(after.pointer).map(|(a,b)| a == b),
        window_order_unchanged: before.window_order.as_ref().zip(after.window_order.as_ref())
            .map(|(a,b)| common_order_unchanged(a,b)),
        scope: if cfg!(target_os = "linux") {
            "AT-SPI active top-level windows at call boundaries; compositor cursor and stacking are not observable. Semantic actions only; no seat input."
        } else {
            "Foreground identity, physical cursor and relative order of existing top-level windows at call boundaries. This does not prove delivery or later application behavior."
        }.into(),
    }
}

pub(super) async fn run<T>(
    input: impl std::future::Future<Output = OpenBitFunResult<T>>,
) -> OpenBitFunResult<T> {
    let control = crate::computer_use::control_session::snapshot();
    if control.mode != ControlMode::Background {
        return input.await;
    }
    let scope = ObservationScope::from_control(&control);
    let (result, observation) = observe_operation(input, capture, control.sequence).await;
    if let Some(observation) = observation {
        crate::computer_use::control_session::record_background_observation(&scope, observation);
    }
    result
}

/// Global desktop changes cannot be attributed to this action: the user is
/// allowed to keep working while directed input runs. Witnesses are diagnostic
/// evidence, never admission or revocation. Native target/lease checks still own
/// input validity. Preserve the action's exact outcome and never replay it.
async fn observe_operation<T, F, Fut>(
    input: impl std::future::Future<Output = OpenBitFunResult<T>>,
    mut read: F,
    sequence: u64,
) -> (OpenBitFunResult<T>, Option<BackgroundObservation>)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Witness, String>>,
{
    let before = read().await;
    let result = input.await;
    let after = read().await;
    let observation = before
        .ok()
        .zip(after.ok())
        .map(|(before, after)| evidence(&before, &after, sequence));
    (result, observation)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn capture() -> Result<Witness, String> {
    crate::computer_use::control_session::spawn_blocking(native_witness)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn native_witness() -> Result<Witness, String> {
    let foreground = objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or("No foreground application")?
        .processIdentifier();
    let pointer = macos::quartz_mouse_location().map_err(|error| error.to_string())?;
    let windows = crate::computer_use::macos_list_apps::list_share_targets()
        .map_err(|error| error.to_string())?;
    let epoch = crate::computer_use::macos_capture::activation_epoch();
    Ok(Witness {
        foreground: vec![foreground.to_string()],
        pointer: Some(pointer),
        window_order: Some(windows.into_iter().map(|window| window.id).collect()),
        activation_epoch: (epoch != 0).then_some(epoch),
    })
}

#[cfg(target_os = "windows")]
fn native_witness() -> Result<Witness, String> {
    use windows::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow},
    };
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return Err("No foreground window in this desktop session".into());
    }
    let mut pointer = POINT::default();
    unsafe { GetCursorPos(&mut pointer) }.map_err(|error| error.to_string())?;
    Ok(Witness {
        foreground: vec![(foreground.0 as usize).to_string()],
        pointer: Some((pointer.x as f64, pointer.y as f64)),
        window_order: Some(
            crate::computer_use::windows_list_apps::list_share_targets()
                .into_iter()
                .map(|window| window.id)
                .collect(),
        ),
        activation_epoch: None,
    })
}

#[cfg(target_os = "linux")]
async fn capture() -> Result<Witness, String> {
    use atspi::{connection::P2P, AccessibilityConnection, State};
    fn error(error: impl std::fmt::Display) -> String {
        error.to_string()
    }
    let connection = AccessibilityConnection::new()
        .await
        .map_err(|error| error.to_string())?;
    let root = connection
        .root_accessible_on_registry()
        .await
        .map_err(error)?;
    let mut active = Vec::new();
    for application in root.get_children().await.map_err(error)? {
        let app = connection
            .object_as_accessible(&application)
            .await
            .map_err(error)?;
        for window in app.get_children().await.map_err(error)? {
            let accessible = connection
                .object_as_accessible(&window)
                .await
                .map_err(error)?;
            if accessible
                .get_state()
                .await
                .map_err(error)?
                .contains(State::Active)
            {
                active.push(format!("{:?}", window));
            }
        }
    }
    active.sort();
    Ok(Witness {
        foreground: active,
        pointer: None,
        window_order: None,
        activation_epoch: None,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn capture() -> Result<Witness, String> {
    Err("No desktop observation provider".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn witness(order: &[&str]) -> Witness {
        Witness {
            foreground: vec!["human".into()],
            pointer: Some((12.0, 34.0)),
            window_order: Some(order.iter().map(|value| (*value).into()).collect()),
            activation_epoch: Some(4),
        }
    }
    #[tokio::test]
    async fn concurrent_human_input_does_not_cancel_or_replay_directed_input() {
        let before = witness(&["human", "target"]);
        let mut after = witness(&["other", "target", "human"]);
        after.foreground = vec!["other".into()];
        after.pointer = Some((900.0, 500.0));
        after.activation_epoch = Some(5);
        let mut witnesses = [Ok(before), Ok(after)].into_iter();
        let mut calls = 0;
        let (result, evidence) = observe_operation(
            async {
                calls += 1;
                Ok("delivered")
            },
            || std::future::ready(witnesses.next().unwrap()),
            7,
        )
        .await;
        assert_eq!(result.unwrap(), "delivered");
        assert_eq!(calls, 1);
        let evidence = evidence.unwrap();
        assert!(!evidence.foreground_unchanged);
        assert_eq!(evidence.cursor_unchanged, Some(false));
    }
    #[tokio::test]
    async fn missing_diagnostics_preserve_the_native_operation_result() {
        let mut calls = 0;
        let (result, evidence) = observe_operation(
            async {
                calls += 1;
                Err::<(), _>(OpenBitFunError::tool("native target closed"))
            },
            || std::future::ready(Err("desktop witness unavailable".into())),
            8,
        )
        .await;
        assert_eq!(
            result.unwrap_err().to_string(),
            OpenBitFunError::tool("native target closed").to_string()
        );
        assert_eq!(calls, 1);
        assert!(evidence.is_none());
    }
    #[test]
    fn detects_raise_pointer_and_transient_activation_without_blame_or_repair() {
        let before = witness(&["human", "target", "other"]);
        assert!(
            !evidence(&before, &witness(&["target", "human", "other"]), 1)
                .window_order_unchanged
                .unwrap()
        );
        let mut after = before.clone();
        after.pointer = Some((13.0, 34.0));
        assert_eq!(evidence(&before, &after, 1).cursor_unchanged, Some(false));
        after = before.clone();
        after.activation_epoch = Some(6);
        assert!(!evidence(&before, &after, 1).foreground_unchanged);
    }
    #[test]
    fn new_background_window_is_not_a_raise_and_missing_coverage_is_not_success() {
        let before = witness(&["human", "target"]);
        assert_eq!(
            evidence(&before, &witness(&["human", "dialog", "target"]), 1).window_order_unchanged,
            Some(true)
        );
        let mut partial = before.clone();
        partial.pointer = None;
        partial.window_order = None;
        assert_eq!(evidence(&partial, &partial, 1).cursor_unchanged, None);
        assert_eq!(evidence(&partial, &partial, 1).window_order_unchanged, None);
    }
}
