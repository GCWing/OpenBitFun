//! Human preview control uses the existing host and lease; animation never
//! submits input. Image coordinates carry the immutable capture identity.
use super::*;
use crate::computer_use::control_session;
use openbitfun_agent_tools::computer_use_control::{ControlSnapshot, ObservationScope};
use openbitfun_agent_tools::computer_use_host::{
    AppInputAction, ClickTarget, ComputerUseActionLease, ComputerUseImageContentRect,
    ComputerUseImageGlobalBounds,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub fn host() -> &'static NativeComputerUseHost {
    static HOST: OnceLock<NativeComputerUseHost> = OnceLock::new();
    HOST.get_or_init(NativeComputerUseHost::new)
}

#[derive(Debug, Deserialize)]
pub struct SharedPreviewRequest {
    pub generation: u64,
    pub target_revision: u64,
    pub authorization_revision: u64,
}
impl SharedPreviewRequest {
    fn acquire(
        &self,
        action: &str,
    ) -> Result<(ControlSnapshot, Box<dyn ComputerUseActionLease>), String> {
        control_session::acquire_shared(
            self.generation,
            self.target_revision,
            self.authorization_revision,
            action,
        )
    }
}

#[derive(Serialize)]
pub struct SharedFrame {
    pub screenshot_id: String,
    pub image_base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub content: ComputerUseImageContentRect,
    pub bounds: Option<ComputerUseImageGlobalBounds>,
}
#[derive(Serialize)]
pub struct SharedObservation {
    pub control: ControlSnapshot,
    pub frame: Option<SharedFrame>,
    pub tree: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct SharedInputRequest {
    #[serde(flatten)]
    pub scope: SharedPreviewRequest,
    pub input: AppInputAction,
}

fn pid(control: &ControlSnapshot) -> Result<i32, String> {
    let target = control
        .target
        .as_deref()
        .ok_or("[SHARE_REQUIRED] No shared target")?;
    target
        .strip_prefix("pid:")
        .and_then(|value| value.split('/').next())
        .or_else(|| target.strip_prefix("atspi:"))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "[TARGET_REQUIRED] Shared target has no application process".into())
}

pub async fn observe(request: SharedPreviewRequest) -> Result<SharedObservation, String> {
    let (control, mut lease) = request.acquire("get_app_state")?;
    let result = capture(&control).await;
    lease.complete();
    result
}

async fn capture(control: &ControlSnapshot) -> Result<SharedObservation, String> {
    let scope = ObservationScope::from_control(control);
    let shot: ComputerScreenshot;
    #[cfg(target_os = "macos")]
    {
        shot = host()
            .screenshot_for_app_pid(pid(control)?)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let hwnd = control
            .target
            .as_deref()
            .and_then(|target| target.split("/window:").nth(1))
            .and_then(|window| window.parse().ok())
            .ok_or("[TARGET_REQUIRED] Missing shared window")?;
        shot = host()
            .screenshot_for_foreground_window(pid(control)?, hwnd)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        if control
            .target
            .as_deref()
            .is_some_and(|target| target.starts_with("atspi:"))
        {
            let state = crate::computer_use::linux_control_ax::preview_snapshot(
                AppSelector::by_pid(pid(control)?),
                8,
            )
            .await
            .map_err(|e| e.to_string())?;
            control_session::validate_observation_scope(&scope)?;
            return Ok(SharedObservation {
                control: control_session::snapshot(),
                frame: None,
                tree: Some(state.tree_text),
            });
        }
        shot = host()
            .screenshot_display(Default::default())
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = scope;
        return Err("[CONTROL_UNSUPPORTED] No shared preview provider".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        use base64::Engine;
        control_session::validate_observation_scope(&scope)?;
        Ok(SharedObservation {
            control: control_session::snapshot(),
            tree: None,
            frame: Some(SharedFrame {
                screenshot_id: shot
                    .screenshot_id
                    .ok_or("[CAPTURE_ID_REQUIRED] Missing frame identity")?,
                image_base64: base64::engine::general_purpose::STANDARD.encode(shot.bytes),
                mime_type: shot.mime_type,
                width: shot.image_width,
                height: shot.image_height,
                content: shot
                    .image_content_rect
                    .unwrap_or(ComputerUseImageContentRect {
                        left: 0,
                        top: 0,
                        width: shot.image_width,
                        height: shot.image_height,
                    }),
                bounds: shot.image_global_bounds,
            }),
        })
    }
}

fn validate_preview_input(input: &AppInputAction) -> Result<(), String> {
    input.validate()?;
    let image = |target: &ClickTarget| {
        matches!(
            target,
            ClickTarget::ImageXy {
                screenshot_id: Some(_),
                ..
            }
        )
    };
    let valid = match input {
        AppInputAction::Click { target, .. } => image(target),
        AppInputAction::TypeText { focus, .. } | AppInputAction::Scroll { focus, .. } => {
            focus.as_ref().is_none_or(image)
        }
        AppInputAction::KeyChord { focus_idx, .. } => focus_idx.is_none(),
        AppInputAction::Drag { from, to, .. } => image(from) && image(to),
        AppInputAction::Wait { .. } => false,
    };
    if valid {
        Ok(())
    } else {
        Err("[PREVIEW_IMAGE_REQUIRED] Preview input requires coordinates from its observed image; AX indices belong to the Agent observation".into())
    }
}

pub async fn input(request: SharedInputRequest) -> Result<ControlSnapshot, String> {
    validate_preview_input(&request.input)?;
    let (control, mut lease) = request.scope.acquire(request.input.name())?;
    #[cfg(target_os = "linux")]
    let result = if control
        .target
        .as_deref()
        .is_some_and(|target| target.starts_with("portal:"))
    {
        portal_input(request.input).await
    } else {
        host()
            .dispatch_app_input(AppSelector::by_pid(pid(&control)?), request.input)
            .await
    };
    #[cfg(not(target_os = "linux"))]
    let result = host()
        .dispatch_app_input(AppSelector::by_pid(pid(&control)?), request.input)
        .await;
    lease.complete();
    if let Err(error) = result {
        // A partial gesture must not be retried by the preview, nor keep its grant.
        if let Some(sharing) = &control.sharing {
            let _ = control_session::set_share_control(
                control.generation,
                control.target_revision,
                sharing.authorization_revision,
                false,
            );
        }
        return Err(error.to_string());
    }
    control_session::validate_observation_scope(&ObservationScope::from_control(&control))?;
    Ok(control_session::snapshot())
}

#[cfg(target_os = "linux")]
async fn portal_input(input: AppInputAction) -> OpenBitFunResult<()> {
    control_session::foreground_allowed().map_err(OpenBitFunError::tool)?;
    // Portal coordinates are stream-local. They never address an AT-SPI PID.
    let point = |target: ClickTarget| -> OpenBitFunResult<(f64, f64)> {
        if let ClickTarget::ImageXy {
            x,
            y,
            screenshot_id: Some(id),
        } = target
        {
            host()
                .observed_pointer_map(None, Some(&id), true)?
                .map_image_to_global_f64(x, y)
        } else {
            Err(OpenBitFunError::tool(
                "[PREVIEW_IMAGE_REQUIRED] Missing image coordinates",
            ))
        }
    };
    match input {
        AppInputAction::Click {
            target,
            click_count,
            mouse_button,
            modifier_keys,
            ..
        } => {
            if !modifier_keys.is_empty() {
                return Err(OpenBitFunError::tool(
                    "[PREVIEW_UNSUPPORTED] Portal modified clicks are unavailable",
                ));
            }
            let (x, y) = point(target)?;
            host().mouse_move_global_f64(x, y).await?;
            for _ in 0..click_count {
                host().mouse_click_authoritative(&mouse_button).await?;
            }
            Ok(())
        }
        AppInputAction::TypeText { text, focus: None } => host().type_text(&text).await,
        AppInputAction::KeyChord { keys, .. } => host().key_chord(keys).await,
        AppInputAction::Scroll { dx, dy, focus } => {
            if let Some(target) = focus {
                let (x, y) = point(target)?;
                host().mouse_move_global_f64(x, y).await?;
            }
            host().scroll(dx, dy).await
        }
        AppInputAction::Drag {
            from,
            to,
            mouse_button,
            duration_ms,
        } => {
            host()
                .drag(point(from)?, point(to)?, &mouse_button, duration_ms)
                .await
        }
        _ => Err(OpenBitFunError::tool(
            "[PREVIEW_UNSUPPORTED] Unsupported portal preview input",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_cannot_smuggle_agent_nodes_or_unscoped_coordinates() {
        for target in [
            ClickTarget::NodeIdx { idx: 1 },
            ClickTarget::ImageXy {
                x: 1,
                y: 1,
                screenshot_id: None,
            },
        ] {
            assert!(validate_preview_input(&AppInputAction::Click {
                target,
                click_count: 1,
                mouse_button: "left".into(),
                modifier_keys: vec![],
                wait_ms_after: None
            })
            .is_err());
        }
    }
}
