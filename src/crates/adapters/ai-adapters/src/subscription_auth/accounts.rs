//! Explicit subscription credential slots. The legacy provider key remains
//! its default slot; additional accounts use provider-scoped v2 store keys.
//! Existing v2 readers/writers preserve those entries without a schema change.

use super::{
    antigravity, build_account, codex, grok, hermes, opencode, store, zcode, LoginStartResult,
    SubscriptionAccount, SubscriptionHttpOptions, SubscriptionLoginMethod,
    SubscriptionLogoutResult, SubscriptionProvider,
};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Public account metadata never contains credential material. The ID is an
/// opaque local slot identity, not an email or the upstream organization ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionAccountInstance {
    pub account_id: String,
    pub is_default: bool,
    /// False/absent on older hosts that support only Codex multi-account slots.
    #[serde(default)]
    pub supports_multiple_accounts: bool,
    #[serde(default = "default_account_enabled")]
    pub enabled: bool,
    pub upstream_account_id: Option<String>,
    pub account: SubscriptionAccount,
}

fn default_account_enabled() -> bool {
    true
}

fn build_instance(
    provider: SubscriptionProvider,
    id: &str,
    state: &store::LoadState,
) -> SubscriptionAccountInstance {
    let metadata = state.account_metadata.get(id);
    let mut account = build_account(
        provider,
        state.credentials.get(id),
        state.requires_reauthentication.contains(id),
        state.vault_unavailable.contains(id),
    );
    if account.account.is_none() {
        account.account = metadata.and_then(|metadata| metadata.display_account.clone());
    }
    SubscriptionAccountInstance {
        account_id: id.into(),
        is_default: id == provider.key(),
        supports_multiple_accounts: true,
        enabled: metadata.is_none_or(|metadata| metadata.enabled),
        upstream_account_id: metadata.and_then(|metadata| metadata.upstream_account_id.clone()),
        account,
    }
}

pub(super) fn validate_account_id(provider: SubscriptionProvider, id: &str) -> Result<()> {
    if id == provider.key() {
        return Ok(());
    }
    if let Some(suffix) = id.strip_prefix(&format!("{}-account-", provider.key())) {
        if let Ok(uuid) = uuid::Uuid::parse_str(suffix) {
            if uuid.get_version_num() == 4 && uuid.to_string() == suffix {
                return Ok(());
            }
        }
    }
    Err(anyhow!(
        "Invalid or unsupported subscription account ID for {}",
        provider.key()
    ))
}

pub(super) async fn account_snapshot(
    provider: SubscriptionProvider,
    id: &str,
) -> Result<SubscriptionAccount> {
    validate_account_id(provider, id)?;
    let state = store::load_with_state().await?;
    Ok(build_instance(provider, id, &state).account)
}

/// Lists default provider slots plus additional configured provider slots. Read
/// errors propagate rather than turning an unreadable store into an empty list.
pub async fn list_account_instances() -> Result<Vec<SubscriptionAccountInstance>> {
    let state = store::load_with_state().await?;
    let mut result = Vec::new();
    for provider in SubscriptionProvider::ALL {
        result.push(build_instance(provider, provider.key(), &state));
    }
    // Retired providers are never advertised, but any slot that still holds
    // credentials or metadata stays listed so an upgrade can show and remove
    // what an earlier release created.
    for provider in SubscriptionProvider::RETIRED {
        if super::slot_holds_state(&state, provider.key()) {
            result.push(build_instance(provider, provider.key(), &state));
        }
    }
    let ids: BTreeSet<_> = state
        .account_metadata
        .keys()
        .chain(state.requires_reauthentication.iter())
        .chain(state.vault_unavailable.iter())
        .collect();
    for id in ids {
        // Unknown entries may belong to another version. Preserve them on disk,
        // but never interpret them as one of the supported account identities.
        if let Some(provider) = SubscriptionProvider::ALL
            .into_iter()
            .chain(SubscriptionProvider::RETIRED)
            .find(|provider| {
                id.as_str() != provider.key() && validate_account_id(*provider, id).is_ok()
            })
        {
            result.push(build_instance(provider, id, &state));
        }
    }
    Ok(result)
}

/// Starts authorization for an explicit slot. The UI generates a fresh UUID v4
/// slot for Add account, or supplies an existing slot for reauthentication.
pub async fn start_account_login_with_options(
    provider: SubscriptionProvider,
    account_id: String,
    session_id: String,
    method: Option<SubscriptionLoginMethod>,
    options: SubscriptionHttpOptions,
) -> Result<LoginStartResult> {
    validate_account_id(provider, &account_id)?;
    super::start_login_in_account_slot(provider, Some(account_id), session_id, method, options)
        .await
}

pub async fn account_credential_revision(provider: SubscriptionProvider, id: &str) -> Result<u64> {
    validate_account_id(provider, id)?;
    store::credential_revision(id).await
}

pub async fn refresh_account_instance_with_options(
    provider: SubscriptionProvider,
    id: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionAccountInstance> {
    validate_account_id(provider, id)?;
    if provider == SubscriptionProvider::Opencode {
        opencode::refresh_account_profile(id, options).await?;
    } else {
        resolve_account_with_options(provider, id, options).await?;
    }
    list_account_instances()
        .await?
        .into_iter()
        .find(|account| account.account_id == id)
        .ok_or_else(|| anyhow!("Subscription account was removed during refresh"))
}

/// Resolves exactly the requested slot. Missing/invalid slots never fall back
/// to this provider's default account or any other account.
pub async fn resolve_account_with_options(
    provider: SubscriptionProvider,
    id: &str,
    options: &SubscriptionHttpOptions,
) -> Result<super::ResolvedCredential> {
    validate_account_id(provider, id)?;
    match provider {
        SubscriptionProvider::Codex => codex::resolve_account(id, options).await,
        SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => {
            Err(provider.retired_error())
        }
        SubscriptionProvider::Zcode | SubscriptionProvider::ZcodeCn => {
            zcode::resolve(provider, id, options).await
        }
        SubscriptionProvider::Antigravity => antigravity::resolve_account(id, options).await,
        SubscriptionProvider::Grok => {
            grok::resolve_for_account(id, provider.suggested().2, options).await
        }
        SubscriptionProvider::Hermes => {
            hermes::resolve_for_account(id, provider.suggested().2, options).await
        }
        SubscriptionProvider::Opencode => {
            opencode::resolve_account_for_model(id, None, "openai", "", options).await
        }
    }
}

/// Recover exactly the credential rejected by a model request. Another
/// process's replacement token is reused under the existing account lease;
/// logout, disable and changed account identity remain hard gates.
pub async fn recover_rejected_account_with_options(
    provider: SubscriptionProvider,
    id: &str,
    rejected_access: &str,
    upstream_account_id: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    validate_account_id(provider, id)?;
    let state = store::load_with_state().await?;
    let metadata = state.account_metadata.get(id);
    if metadata.is_none_or(|metadata| {
        !metadata.enabled || metadata.upstream_account_id.as_deref() != upstream_account_id
    }) || !state.credentials.contains_key(id)
    {
        return Err(anyhow!(
            "Subscription account is unavailable or its identity changed"
        ));
    }
    match provider {
        SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => {
            Err(provider.retired_error())
        }
        SubscriptionProvider::Zcode | SubscriptionProvider::ZcodeCn => {
            zcode::recover(provider, id, rejected_access, options).await
        }
        SubscriptionProvider::Codex => {
            codex::recover_rejected_account(id, rejected_access, upstream_account_id, options).await
        }
        SubscriptionProvider::Antigravity => {
            antigravity::recover_rejected_account(id, rejected_access, options).await
        }
        SubscriptionProvider::Grok => {
            grok::recover_rejected_account(id, rejected_access, options).await
        }
        SubscriptionProvider::Hermes => {
            hermes::recover_rejected_account(id, rejected_access, options).await
        }
        SubscriptionProvider::Opencode => {
            opencode::recover_rejected_account(id, rejected_access, options).await
        }
    }
}

/// Revokes only the selected account, retaining its identity and a revision so an
/// authorization or refresh already running elsewhere cannot resurrect it.
pub async fn logout_account(
    provider: SubscriptionProvider,
    id: &str,
) -> Result<SubscriptionLogoutResult> {
    validate_account_id(provider, id)?;
    {
        let mut sessions = super::sessions()
            .lock()
            .map_err(|_| anyhow!("subscription login session lock poisoned"))?;
        if sessions
            .get(&provider)
            .is_some_and(|session| session.account_id.as_deref().unwrap_or(provider.key()) == id)
        {
            if let Some(session) = sessions.remove(&provider) {
                session.cancel.cancel();
            }
        }
    }
    let _guard = super::store_lock(provider).lock().await;
    let outcome = store::sign_out_account(id).await?;
    log::info!(
        "Subscription account logged out: provider={}, account_id={id}",
        provider.key()
    );
    Ok(match outcome {
        store::RemoveOutcome::Removed => SubscriptionLogoutResult {
            cleanup_pending: false,
            warning: None,
        },
        store::RemoveOutcome::CleanupPending(warning) => SubscriptionLogoutResult {
            cleanup_pending: true,
            warning: Some(warning),
        },
    })
}

/// Enables/disables request eligibility without discarding login or quota data.
pub async fn set_account_instance_enabled(
    provider: SubscriptionProvider,
    id: &str,
    enabled: bool,
) -> Result<SubscriptionAccountInstance> {
    validate_account_id(provider, id)?;
    let _guard = super::store_lock(provider).lock().await;
    store::set_account_enabled(id, enabled).await?;
    let state = store::load_with_state().await?;
    Ok(build_instance(provider, id, &state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids_are_provider_scoped_and_canonical() {
        let id = format!("codex-account-{}", uuid::Uuid::new_v4());
        assert!(validate_account_id(SubscriptionProvider::Codex, &id).is_ok());
        assert!(validate_account_id(SubscriptionProvider::Codex, "codex").is_ok());
        for bad in [
            "",
            "../codex",
            "codex-account-email@example.com",
            "codex-account-00000000-0000-0000-0000-000000000000",
            "hermes",
        ] {
            assert!(validate_account_id(SubscriptionProvider::Codex, bad).is_err());
        }
        assert!(validate_account_id(SubscriptionProvider::Hermes, &id).is_err());
    }
    #[tokio::test]
    async fn every_provider_keeps_slots_credentials_identity_and_revocation_independent() {
        let _guard = super::super::tests::test_lock().lock().await;
        store::set_store_path_for_test(super::super::tests::temp_store_path());
        for provider in SubscriptionProvider::ALL {
            let first = format!("{}-account-{}", provider.key(), uuid::Uuid::new_v4());
            let second = format!("{}-account-{}", provider.key(), uuid::Uuid::new_v4());
            let credential = |access: &str, identity: &str| store::StoredCredential::Oauth {
                access: access.into(),
                refresh: format!("synthetic-refresh-{access}"),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some(identity.into()),
                metadata: None,
            };
            persist_account_credential(
                provider,
                &first,
                0,
                credential("first-secret", "first-subject"),
            )
            .await
            .unwrap();
            persist_account_credential(
                provider,
                &second,
                0,
                credential("second-secret", "second-subject"),
            )
            .await
            .unwrap();
            let config = serde_json::from_value(serde_json::json!({
                "name":"fixture","model":"fixture","format":"responses","base_url":"https://fixture.invalid",
                "request_url":"https://fixture.invalid/responses","api_key":"first-secret",
                "context_window":4096,"inline_think_in_text":false,"skip_ssl_verify":false,
                "custom_headers": if provider == SubscriptionProvider::Codex {
                    serde_json::json!({"chatgpt-account-id":"first-subject"})
                } else { serde_json::Value::Null }
            })).unwrap();
            let client =
                bind_resolved_account_identity(crate::AIClient::new(config), provider, &first)
                    .await
                    .unwrap();
            let origin = client.subscription_account_origin(&first).unwrap();
            assert_eq!(origin.provider, provider.key());
            assert_eq!(origin.upstream_account_id.as_deref(), Some("first-subject"));
            client
                .account_identity
                .as_ref()
                .unwrap()
                .validate(&client)
                .await
                .unwrap();
            set_account_instance_enabled(provider, &first, false)
                .await
                .unwrap();
            assert!(client
                .account_identity
                .as_ref()
                .unwrap()
                .validate(&client)
                .await
                .is_err());
            assert!(store::load_entry(&second).await.unwrap().is_some());
            logout_account(provider, &first).await.unwrap();
            set_account_instance_enabled(provider, &first, true)
                .await
                .unwrap();
            assert!(store::load_entry(&first).await.unwrap().is_none());
            assert!(client
                .account_identity
                .as_ref()
                .unwrap()
                .validate(&client)
                .await
                .is_err());
            let revision = account_credential_revision(provider, &first).await.unwrap();
            assert!(persist_account_credential(
                provider,
                &first,
                revision,
                credential("changed", "different-subject")
            )
            .await
            .is_err());
            assert!(matches!(
                persist_account_credential(
                    provider,
                    &first,
                    0,
                    credential("late", "first-subject")
                )
                .await
                .unwrap(),
                store::ConditionalCommitOutcome::Conflict { .. }
            ));
            let rows = list_account_instances().await.unwrap();
            let retained = rows.iter().find(|row| row.account_id == first).unwrap();
            assert_eq!(
                retained.upstream_account_id.as_deref(),
                Some("first-subject")
            );
            assert!(!retained.account.connected);
            assert!(
                rows.iter()
                    .find(|row| row.account_id == second)
                    .unwrap()
                    .account
                    .connected
            );
            assert!(
                store::load_entry(provider.key()).await.unwrap().is_none(),
                "named slot must never become the default"
            );
            assert!(
                validate_account_id(provider, &first.replace(provider.key(), "unknown")).is_err()
            );
        }
    }
}

/// Commit a provider credential only to its explicitly authorized slot. A known
/// upstream identity survives sign-out and cannot be replaced by reauthorization.
/// CAS remains the authority if another process changed the slot meanwhile.
pub(super) async fn persist_account_credential(
    provider: SubscriptionProvider,
    slot: &str,
    expected_revision: u64,
    credential: store::StoredCredential,
) -> Result<store::ConditionalCommitOutcome> {
    validate_account_id(provider, slot)?;
    let state = store::load_with_state().await?;
    let current_revision = state.provider_revisions.get(slot).copied().unwrap_or(0);
    if current_revision != expected_revision {
        return Ok(store::ConditionalCommitOutcome::Conflict { current_revision });
    }
    let next_identity = match &credential {
        store::StoredCredential::Oauth { account_id, .. } => account_id.as_deref(),
        _ => None,
    };
    if state
        .account_metadata
        .get(slot)
        .and_then(|metadata| metadata.upstream_account_id.as_deref())
        .is_some_and(|identity| Some(identity) != next_identity)
    {
        return Err(anyhow!("Subscription account identity changed; add a separate account instead of replacing this slot"));
    }
    store::upsert_if_revision(slot, expected_revision, credential).await
}

/// Bind the exact credential already resolved, including provider-owned profile
/// identity. A concurrent replacement cannot lend its metadata to an old token.
pub async fn bind_resolved_account_identity(
    client: crate::client::AIClient,
    provider: SubscriptionProvider,
    slot: &str,
) -> Result<crate::client::AIClient> {
    validate_account_id(provider, slot)?;
    let snapshot = store::load_entry_with_revision(slot).await?;
    let (access, upstream) = match snapshot.credential {
        Some(store::StoredCredential::Oauth {
            access, account_id, ..
        }) => (access, account_id),
        Some(store::StoredCredential::Api { key, .. })
            if provider == SubscriptionProvider::Opencode =>
        {
            (key, None)
        }
        _ => {
            return Err(anyhow!(
                "Subscription account is unavailable; resolve the account again"
            ))
        }
    };
    if access != client.config.api_key {
        return Err(anyhow!(
            "Subscription credentials changed while the client was being prepared"
        ));
    }
    Ok(client.with_resolved_subscription_account(provider, slot, upstream))
}
