//! A remembered preference can authorize input only after explicit selection
//! and successful native sharing. No preference starts a capture or picks an app.
use super::{
    control_session,
    grants::{GrantIdentity, GrantRecord, GrantStore},
};
use openbitfun_agent_tools::computer_use_control::{ControlMode, ControlSnapshot};
use std::path::PathBuf;
// Serializes preference intentions across windows/controllers. Forget revokes
// input before waiting; a pending remember cannot reinsert it afterwards.
static PREFERENCES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn authorization(snapshot: &ControlSnapshot) -> u64 {
    snapshot
        .sharing
        .as_ref()
        .map_or(0, |sharing| sharing.authorization_revision)
}
fn current_grant(snapshot: &ControlSnapshot) -> Result<(), String> {
    let current = control_session::snapshot();
    if current.generation != snapshot.generation
        || current.target_revision != snapshot.target_revision
        || authorization(&current) != authorization(snapshot)
        || current
            .sharing
            .as_ref()
            .is_none_or(|sharing| !sharing.control_enabled)
    {
        return Err("[CONTROL_STALE] Grant changed before its preference was saved".into());
    }
    Ok(())
}

async fn identity(snapshot: &ControlSnapshot) -> Result<GrantIdentity, String> {
    let process = control_session::shared_process(snapshot.generation, snapshot.target_revision)?;
    let mode = match snapshot
        .sharing
        .as_ref()
        .ok_or("[SHARE_REQUIRED] No share")?
        .requested_mode
    {
        ControlMode::Background => "background",
        ControlMode::Foreground => "foreground",
        ControlMode::Observe => {
            return Err("[CONTROL_OBSERVE_ONLY] Observation has no remembered input grant".into())
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        process.validate()?;
        let identity = GrantIdentity::capture(
            process.bundle_id.clone(),
            &process.executable,
            mode,
            process.started,
        )
        .map_err(|error| error.to_string())?;
        process.validate()?;
        Ok::<_, String>(identity)
    })
    .await
    .map_err(|error| error.to_string())??;
    control_session::shared_process(snapshot.generation, snapshot.target_revision)?;
    Ok(result)
}

pub async fn apply_remembered(
    path: PathBuf,
    snapshot: ControlSnapshot,
) -> Result<ControlSnapshot, String> {
    let _operation = PREFERENCES.lock().await;
    if snapshot
        .sharing
        .as_ref()
        .is_none_or(|sharing| sharing.requested_mode == ControlMode::Observe)
        || snapshot
            .target
            .as_deref()
            .is_some_and(|target| target.starts_with("portal:"))
    {
        return Ok(snapshot);
    }
    let result = async {
        let identity = identity(&snapshot).await?;
        tokio::task::spawn_blocking(move || {
            GrantStore::load(path)
                .map(|store| store.contains(&identity))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    let (remembered, note) = match result {
        Ok(found) => (found, None),
        Err(error) => (false, Some(error)),
    };
    let snapshot = if remembered {
        control_session::set_share_control(
            snapshot.generation,
            snapshot.target_revision,
            authorization(&snapshot),
            true,
        )?
    } else {
        snapshot
    };
    control_session::grant_preference_result(
        snapshot.generation,
        snapshot.target_revision,
        authorization(&snapshot),
        remembered,
        note,
    )
}

pub async fn remember(path: PathBuf, snapshot: ControlSnapshot) -> Result<ControlSnapshot, String> {
    let _operation = PREFERENCES.lock().await;
    let result = async {
        let identity = identity(&snapshot).await?;
        current_grant(&snapshot)?;
        let label = snapshot
            .sharing
            .as_ref()
            .and_then(|sharing| sharing.target_label.clone())
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            GrantStore::load(path)
                .and_then(|mut store| store.remember(identity, label))
                .map(|result| result.warning)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    let (remembered, note) = match result {
        Ok(warning) => (true, warning),
        Err(error) => (false, Some(error)),
    };
    control_session::grant_preference_result(
        snapshot.generation,
        snapshot.target_revision,
        authorization(&snapshot),
        remembered,
        note,
    )
}

pub async fn list(path: PathBuf) -> Result<Vec<GrantRecord>, String> {
    tokio::task::spawn_blocking(move || {
        GrantStore::load(path)
            .map(|store| store.records().to_vec())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn forget(path: PathBuf, identity: GrantIdentity) -> Result<Option<String>, String> {
    // Forgetting matching active consent revokes it immediately; disk IO cannot
    // keep input alive. Unreadable preferences are retained and reported.
    let snapshot = control_session::snapshot();
    if let Some(sharing) = &snapshot.sharing {
        if let Ok(process) =
            control_session::shared_process(snapshot.generation, snapshot.target_revision)
        {
            let mode = if sharing.requested_mode == ControlMode::Foreground {
                "foreground"
            } else {
                "background"
            };
            if process.executable.canonicalize().ok().as_ref() == Some(&identity.executable)
                && identity.input_mode == mode
            {
                if let Ok(revoked) = control_session::set_share_control(
                    snapshot.generation,
                    snapshot.target_revision,
                    sharing.authorization_revision,
                    false,
                ) {
                    let _ = control_session::grant_preference_result(
                        snapshot.generation,
                        snapshot.target_revision,
                        authorization(&revoked),
                        false,
                        None,
                    );
                }
            }
        }
    }
    let _operation = PREFERENCES.lock().await;
    tokio::task::spawn_blocking(move || {
        GrantStore::load(path)
            .and_then(|mut store| store.forget(&identity))
            .map(|result| result.warning)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
