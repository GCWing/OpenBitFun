//! User-owned sharing transitions around the existing native resource owner.
use super::*;

pub(crate) fn request_share(owner: &str, mode: ControlMode) -> Result<ControlSnapshot, String> {
    {
        let r = locked()?;
        if r.admission.snapshot.owner.as_deref() != Some(owner)
            && (active(&r) || r.admission.snapshot.state == "awaiting_share")
        {
            return Err("[CONTROL_BUSY] Another task owns the share request".into());
        }
        if let Some(sharing) = &r.admission.snapshot.sharing {
            if r.admission.snapshot.owner.as_deref() == Some(owner)
                && (active(&r) || r.admission.snapshot.state == "awaiting_share")
            {
                if sharing.requested_mode != mode {
                    return Err("[CONTROL_USER_MODE_REQUIRED] The user must stop sharing and select the new input mode".into());
                }
                return Ok(projected(&r));
            }
        }
    }
    let generation = {
        let mut r = locked()?;
        let generation = r.admission.begin_start(owner, ControlMode::Observe)?;
        r.preview = None;
        r.process = None;
        SCOPE_CHANGED.notify_waiters();
        generation
    };
    stop_native(generation)?;
    let mut r = locked()?;
    r.admission.finish_start(generation)?;
    r.admission.request_share(owner, mode)?;
    Ok(projected(&r))
}

pub(crate) fn begin_share(
    generation: u64,
    target: String,
    label: String,
    mode: ControlMode,
    process: Option<super::super::process_identity::ProcessIdentity>,
) -> Result<(ControlSnapshot, Box<dyn ComputerUseActionLease>), String> {
    let mut r = locked()?;
    if let Some(process) = &process {
        process.validate()?;
    }
    r.admission.begin_share(generation, target, label, mode)?;
    let owner = r
        .admission
        .snapshot
        .owner
        .clone()
        .ok_or("[CONTROL_OWNER_REQUIRED] No sharing task")?;
    let token = r.admission.admit(&owner, "get_app_state", executor())?;
    r.preview = None;
    r.process = process;
    SCOPE_CHANGED.notify_waiters();
    Ok((
        projected(&r),
        Box::new(Lease {
            token,
            complete: false,
        }),
    ))
}

pub(crate) fn finish_share(generation: u64, revision: u64) -> Result<ControlSnapshot, String> {
    let mut r = locked()?;
    r.admission.finish_share(generation, revision)?;
    Ok(projected(&r))
}

pub(crate) fn set_share_control(
    generation: u64,
    target_revision: u64,
    expected_revision: u64,
    enabled: bool,
) -> Result<ControlSnapshot, String> {
    let _cleanup = NATIVE_CLEANUP
        .lock()
        .map_err(|_| "[CONTROL_FAILED] Native cleanup lock poisoned")?;
    let result = {
        let mut r = locked()?;
        if let Some(process) = &r.process {
            process.validate()?;
        }
        r.admission
            .set_control(generation, target_revision, expected_revision, enabled)?;
        SCOPE_CHANGED.notify_waiters();
        projected(&r)
    };
    if !enabled {
        // Serialize with native teardown and keep the revocation's identity.
        // A delayed cleanup must never hide a newer share's feedback.
        let current = snapshot();
        if current.generation != generation
            || current.target_revision != target_revision
            || current
                .sharing
                .as_ref()
                .is_none_or(|sharing| sharing.authorization_revision != expected_revision + 1)
        {
            return Ok(result);
        }
        #[cfg(target_os = "macos")]
        {
            super::super::macos_bg_input::release_held_inputs();
            super::super::macos_input_focus::stop();
            super::super::macos_capture::hide_pointer();
        }
        #[cfg(target_os = "windows")]
        super::super::windows_pointer_feedback::hide_pointer();
    }
    Ok(result)
}

/// UI preview actions join the existing exclusive action lease. A controller
/// cannot choose the task owner or race a grant/target change into a new lease.
pub(crate) fn acquire_shared(
    generation: u64,
    target_revision: u64,
    authorization_revision: u64,
    action: &str,
) -> Result<(ControlSnapshot, Box<dyn ComputerUseActionLease>), String> {
    let mut r = locked()?;
    if r.admission.snapshot.generation != generation
        || r.admission.snapshot.target_revision != target_revision
        || r.admission.snapshot.sharing.as_ref().is_none_or(|sharing| {
            sharing.phase != openbitfun_agent_tools::computer_use_control::SharingPhase::Shared
                || sharing.authorization_revision != authorization_revision
        })
    {
        return Err("[CONTROL_STALE] Shared preview or authorization changed".into());
    }
    if let Some(process) = &r.process {
        process.validate()?;
    }
    let owner = r
        .admission
        .snapshot
        .owner
        .clone()
        .ok_or("[SHARE_REQUIRED] No shared application")?;
    let token = r.admission.admit(&owner, action, executor())?;
    Ok((
        projected(&r),
        Box::new(Lease {
            token,
            complete: false,
        }),
    ))
}

/// Must run before native capture, AX observation or input, not after pixels
/// have already been fetched from an unshared application.
#[cfg(target_os = "macos")]
pub(crate) fn shared_target_allowed(target: &str) -> Result<(), String> {
    locked()?.admission.shared_target_allowed(target)
}

pub(crate) fn shared_process(
    generation: u64,
    revision: u64,
) -> Result<super::super::process_identity::ProcessIdentity, String> {
    let r = locked()?;
    if !active(&r)
        || r.admission.snapshot.generation != generation
        || r.admission.snapshot.target_revision != revision
    {
        return Err("[CONTROL_STALE] Shared application changed".into());
    }
    let process = r.process.clone().ok_or("[GRANT_IDENTITY_UNAVAILABLE] Portal streams have no verifiable application executable; consent is session-only")?;
    process.validate()?;
    Ok(process)
}

pub(crate) fn grant_preference_result(
    generation: u64,
    revision: u64,
    authorization_revision: u64,
    remembered: bool,
    note: Option<String>,
) -> Result<ControlSnapshot, String> {
    let mut r = locked()?;
    if !active(&r)
        || r.admission.snapshot.generation != generation
        || r.admission.snapshot.target_revision != revision
        || r.admission
            .snapshot
            .sharing
            .as_ref()
            .is_none_or(|sharing| sharing.authorization_revision != authorization_revision)
    {
        return Err(
            "[CONTROL_STALE] Shared application changed while reading its preference".into(),
        );
    }
    if let Some(sharing) = r.admission.snapshot.sharing.as_mut() {
        sharing.remembered = remembered;
        sharing.grant_note = note;
    }
    Ok(projected(&r))
}
