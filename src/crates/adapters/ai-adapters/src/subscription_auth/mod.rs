//! In-app subscription authentication.
//!
//! Lets OpenBitFun sign in to another product's subscription (Codex/ChatGPT,
//! Antigravity/Google, OpenCode, xAI/SuperGrok, Hermes/Nous Portal) with an in-app OAuth flow,
//! and use the resulting tokens to authenticate AI requests. Secret material
//! is stored separately from the non-secret account metadata. macOS uses a
//! prompt-free encrypted local vault; other platforms use their native store.
//!
//! There is no upgrade path for the previous Codex/Gemini CLI disk-scan import.

mod antigravity;
mod codex;
mod device_flow;
mod grok;
mod hermes;
mod jwt;
mod oauth_server;
mod opencode;
mod pkce;
pub mod store;

pub use store::{set_store_path_for_test, StoredCredential};

use crate::types::ProxyConfig;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Maximum lifetime of a pending login session (matches OpenCode).
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// OpenCode release whose built-in subscription protocols these adapters mirror.
pub(crate) const OPENCODE_COMPAT_VERSION: &str = "1.18.29";

pub const OPENCODE_GO_REQUIRES_API_KEY: &str = "OpenCode Console OAuth supports Zen only. Edit this model to use the OpenCode Go API-key preset. Existing configuration and credentials have been preserved.";

/// One of the subscription providers OpenBitFun can sign in to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionProvider {
    Codex,
    Antigravity,
    Opencode,
    Grok,
    Hermes,
}

/// User-visible authorization method supported by a subscription provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionLoginMethod {
    Browser,
    Device,
}

/// Transport policy shared by subscription-auth requests.
///
/// The proxy is owned because login flows keep these options in a background
/// future while token refresh and credential resolution only borrow them.
#[derive(Debug, Clone, Default)]
pub struct SubscriptionHttpOptions {
    proxy_config: Option<ProxyConfig>,
    skip_ssl_verify: bool,
}

impl SubscriptionHttpOptions {
    pub fn new(proxy_config: Option<ProxyConfig>, skip_ssl_verify: bool) -> Self {
        Self {
            proxy_config,
            skip_ssl_verify,
        }
    }
}

impl SubscriptionProvider {
    /// All providers, in display order.
    pub const ALL: [SubscriptionProvider; 5] = [
        Self::Codex,
        Self::Antigravity,
        Self::Opencode,
        Self::Grok,
        Self::Hermes,
    ];

    /// Stable store key / serde tag for this provider.
    pub fn key(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
            Self::Grok => "grok",
            Self::Hermes => "hermes",
        }
    }

    /// Parses a provider from its stable key.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "codex" => Some(Self::Codex),
            "antigravity" => Some(Self::Antigravity),
            "opencode" => Some(Self::Opencode),
            "grok" => Some(Self::Grok),
            "hermes" => Some(Self::Hermes),
            _ => None,
        }
    }

    fn display_label(self) -> String {
        match self {
            Self::Codex => "Codex (ChatGPT)",
            Self::Antigravity => "Antigravity (Google)",
            Self::Opencode => "OpenCode Console (Zen)",
            Self::Grok => "xAI (SuperGrok)",
            Self::Hermes => "Hermes (Nous Portal)",
        }
        .to_string()
    }

    fn suggested(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Codex => codex::suggested(),
            Self::Antigravity => antigravity::suggested(),
            Self::Opencode => opencode::suggested(),
            Self::Grok => grok::suggested(),
            Self::Hermes => hermes::suggested(),
        }
    }

    /// Login methods exposed by the provider, in preferred display order.
    pub fn login_methods(self) -> &'static [SubscriptionLoginMethod] {
        use SubscriptionLoginMethod::{Browser, Device};

        match self {
            Self::Codex => &[Browser, Device],
            Self::Antigravity => &[Browser],
            Self::Opencode | Self::Grok | Self::Hermes => &[Device],
        }
    }

    fn supports_login_method(self, method: SubscriptionLoginMethod) -> bool {
        self.login_methods().contains(&method)
    }
}

/// Returns a runtime-only model replacement for blank or retired subscription
/// model ids. Persisted user configuration remains untouched, while existing
/// installs keep working when a provider removes an old default slug.
pub fn runtime_model_override(
    provider: SubscriptionProvider,
    configured_model: &str,
) -> Option<&'static str> {
    let model = configured_model.trim();
    if model.is_empty() {
        return Some(provider.suggested().2);
    }
    match (provider, model) {
        // OpenBitFun used this as its original Codex subscription default. It is
        // no longer in OpenCode's current ChatGPT subscription model set.
        (SubscriptionProvider::Codex, "gpt-5-codex") => Some("gpt-5.5"),
        // The retired Grok proxy exposed an unversioned coding-model alias;
        // xAI's standard Responses API now publishes the versioned model id.
        (SubscriptionProvider::Grok, "grok-build") => Some("grok-build-0.1"),
        _ => None,
    }
}

/// Billing/API product selected for an OpenCode-backed model.
///
/// Console OAuth supports Zen only. Go remains readable for legacy config
/// compatibility and is rejected before credential resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodePlan {
    Zen,
    Go,
}

/// One model exposed by an OpenCode plan + wire-format offering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionOfferingModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// A homogeneous group of models that share one OpenCode plan and wire format.
///
/// OpenCode's catalog mixes Chat Completions, Responses, and Messages models
/// within the same plan. Keeping those groups separate lets the UI create a
/// model configuration whose protocol and endpoint are always paired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionApiOffering {
    pub plan: OpenCodePlan,
    pub format: String,
    pub base_url: String,
    pub suggested_model: String,
    #[serde(default)]
    pub models: Vec<SubscriptionOfferingModel>,
}

/// A subscription account entry surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionAccount {
    pub provider: SubscriptionProvider,
    pub display_label: String,
    pub account: Option<String>,
    /// Unix seconds when the current credential expires (for UI display).
    pub expires_at: Option<i64>,
    pub connected: bool,
    /// Authorization methods this provider currently supports.
    #[serde(default)]
    pub login_methods: Vec<SubscriptionLoginMethod>,
    /// The account was known previously, but its secret is absent from the
    /// credential vault. The UI should ask the user to sign in again.
    #[serde(default)]
    pub reauthentication_required: bool,
    /// The credential vault is currently unavailable. Unlike
    /// a missing entry, this is retryable and should not request re-login.
    #[serde(default)]
    pub vault_unavailable: bool,
    pub suggested_format: String,
    pub suggested_base_url: String,
    pub suggested_model: String,
    /// OpenCode plan/format groups available through this single account.
    /// Empty for subscription providers that expose only one fixed endpoint.
    #[serde(default)]
    pub api_offerings: Vec<SubscriptionApiOffering>,
    /// Provider-owned page where the user can start or manage a subscription.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub management_url: Option<String>,
}

/// Structured sign-out result. Metadata removal determines connection state;
/// credential deletion may be queued for a later retry.
#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionLogoutResult {
    pub cleanup_pending: bool,
    pub warning: Option<String>,
}

/// Durable account epoch used to invalidate cached model clients after login,
/// logout, refresh, or profile changes, including changes from another host process.
pub async fn credential_revision(provider: SubscriptionProvider) -> Result<u64> {
    store::credential_revision(provider.key()).await
}

/// Runtime-resolved credential that overrides fields in the AI client config.
#[derive(Debug, Clone)]
pub struct ResolvedCredential {
    pub api_key: String,
    pub base_url: Option<String>,
    pub request_url: Option<String>,
    pub format: Option<String>,
    pub extra_headers: HashMap<String, String>,
    /// Unix seconds when this credential expires; `None` means non-expiring.
    pub expires_at: Option<i64>,
}

impl ResolvedCredential {
    /// Applies account-owned authentication to a transient client configuration.
    /// Saved API-key headers and replace mode must not suppress OAuth auth, or
    /// select a different account after login/refresh. HTTP names ignore case.
    pub fn apply_to(self, config: &mut crate::types::AIConfig) -> Option<i64> {
        config.api_key = self.api_key;
        if let Some(base_url) = self.base_url {
            config.base_url = base_url;
        }
        if let Some(request_url) = self.request_url {
            config.request_url = request_url;
        }
        if let Some(format) = self.format {
            config.format = format;
        }
        let mut headers = config.custom_headers.take().unwrap_or_default();
        headers.retain(|name, _| {
            ![
                "authorization",
                "x-api-key",
                "x-goog-api-key",
                "content-type",
                "anthropic-version",
                "chatgpt-account-id",
                "x-openai-internal-codex-residency",
                "x-org-id",
                "x-opencode-org-id",
                "session-id",
                "session_id",
                "x-client-request-id",
                "x-opencode-session",
                "x-grok-conv-id",
            ]
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
                && !self
                    .extra_headers
                    .keys()
                    .any(|required| name.eq_ignore_ascii_case(required))
        });
        headers.extend(self.extra_headers);
        config.custom_headers = (!headers.is_empty()).then_some(headers);
        config.custom_headers_mode = Some("merge".to_string());
        self.expires_at
    }
}

/// Returned by `start_login`; contains what the UI needs to guide the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginStartResult {
    pub provider: SubscriptionProvider,
    pub session_id: String,
    pub method: SubscriptionLoginMethod,
    pub authorization_url: String,
    pub user_code: Option<String>,
    pub instructions: String,
}

/// Lifecycle state of a login session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginStatus {
    Pending,
    Authorized,
    Failed,
    Cancelled,
}

/// Snapshot of a login session, polled by the UI.
#[derive(Debug, Clone, Serialize)]
pub struct LoginSessionSnapshot {
    pub provider: SubscriptionProvider,
    pub session_id: String,
    pub status: LoginStatus,
    pub method: Option<SubscriptionLoginMethod>,
    pub authorization_url: Option<String>,
    pub user_code: Option<String>,
    pub instructions: Option<String>,
    pub error: Option<String>,
    pub account: Option<SubscriptionAccount>,
}

/// Internal handle returned by each provider's `begin_login`.
pub(crate) struct StartedLogin {
    pub method: SubscriptionLoginMethod,
    pub authorization_url: String,
    pub user_code: Option<String>,
    pub instructions: String,
    pub runner: Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>>,
}

struct SessionState {
    /// Client-generated UUID used to correlate start/status/cancel commands.
    session_id: String,
    status: LoginStatus,
    method: Option<SubscriptionLoginMethod>,
    authorization_url: Option<String>,
    user_code: Option<String>,
    instructions: Option<String>,
    error: Option<String>,
    account: Option<SubscriptionAccount>,
    cancel: CancellationToken,
    /// Monotonic id distinguishing successive logins for the same provider.
    generation: u64,
}

impl SessionState {
    fn snapshot(&self, provider: SubscriptionProvider) -> LoginSessionSnapshot {
        LoginSessionSnapshot {
            provider,
            session_id: self.session_id.clone(),
            status: self.status,
            method: self.method,
            authorization_url: self.authorization_url.clone(),
            user_code: self.user_code.clone(),
            instructions: self.instructions.clone(),
            error: self.error.clone(),
            account: self.account.clone(),
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<SubscriptionProvider, SessionState>> {
    static SESSIONS: OnceLock<Mutex<HashMap<SubscriptionProvider, SessionState>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(1);
    GENERATION.fetch_add(1, Ordering::Relaxed)
}

fn validate_session_id(session_id: &str) -> Result<()> {
    uuid::Uuid::parse_str(session_id)
        .map(|_| ())
        .map_err(|_| anyhow!("subscription login session_id must be a valid UUID"))
}

/// Builds the HTTP client used by proxy-aware subscription-auth requests.
///
/// Subscription providers perform token exchange, refresh, or account
/// discovery outside the normal AI request client, so they must receive the
/// same explicit proxy configuration from the host. Keep environment proxy
/// discovery disabled to match the main AI client, which is controlled by
/// `ai.proxy`.
pub(crate) fn build_http_client(
    options: &SubscriptionHttpOptions,
    provider: &str,
) -> Result<reqwest::Client> {
    build_http_client_builder(options, provider)?
        .build()
        .with_context(|| format!("build {provider} subscription http client"))
}

/// Shares TLS and host proxy configuration while allowing provider-specific
/// transport restrictions before the client is built.
pub(crate) fn build_http_client_builder(
    options: &SubscriptionHttpOptions,
    provider: &str,
) -> Result<reqwest::ClientBuilder> {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    let mut builder = reqwest::Client::builder()
        .tls_backend_rustls()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(options.skip_ssl_verify);

    if options.skip_ssl_verify {
        log::warn!(
            "SSL certificate verification disabled for {provider} subscription authentication"
        );
    }

    if let Some(proxy_config) = options
        .proxy_config
        .as_ref()
        .filter(|config| config.enabled && !config.url.trim().is_empty())
    {
        let proxy = crate::client::http::build_proxy(proxy_config)
            .map_err(|error| anyhow!("build {provider} subscription proxy: {error}"))?;
        builder = builder.proxy(proxy);
        log::info!("Using configured proxy for {provider} subscription authentication");
    } else {
        builder = builder.no_proxy();
    }

    Ok(builder)
}

/// Per-provider commit barrier for login cancellation/replacement and logout.
/// Refresh deliberately does not hold this across an external request: its
/// durable revision CAS lets logout commit immediately and reject stale tokens.
pub(crate) fn store_lock(provider: SubscriptionProvider) -> &'static tokio::sync::Mutex<()> {
    static CODEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static ANTIGRAVITY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static OPENCODE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static GROK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static HERMES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    match provider {
        SubscriptionProvider::Codex => &CODEX,
        SubscriptionProvider::Antigravity => &ANTIGRAVITY,
        SubscriptionProvider::Opencode => &OPENCODE,
        SubscriptionProvider::Grok => &GROK,
        SubscriptionProvider::Hermes => &HERMES,
    }
}

/// Runs the externally cancellable authorization/polling phase, then commits
/// the resulting credential without cancellation. Dropping a credential-vault
/// write can leave an orphan secret because credential-store calls
/// continue running after their Rust future is dropped.
pub(crate) async fn authorize_then_persist<T, Authorize, Persist, PersistFuture>(
    provider: SubscriptionProvider,
    cancel: CancellationToken,
    authorize: Authorize,
    persist: Persist,
) -> Result<()>
where
    Authorize: std::future::Future<Output = Result<T>>,
    Persist: FnOnce(T) -> PersistFuture,
    PersistFuture: std::future::Future<Output = Result<()>>,
{
    let credential = tokio::select! {
        _ = cancel.cancelled() => return Err(anyhow!("login cancelled")),
        result = tokio::time::timeout(LOGIN_TIMEOUT, authorize) => match result {
            Ok(result) => result?,
            Err(_) => return Err(anyhow!("Login timed out")),
        },
    };
    // Logout/re-login cancels the generation before waiting on this same
    // provider lock. Whichever side reaches the lock boundary first wins:
    // an already-started commit finishes before logout deletes it, while a
    // cancelled commit waiting on the lock is discarded before writing.
    let _guard = store_lock(provider).lock().await;
    if cancel.is_cancelled() {
        return Err(anyhow!("login cancelled"));
    }
    persist(credential).await
}

pub(crate) fn require_current_store_revision(
    provider: SubscriptionProvider,
    outcome: store::ConditionalCommitOutcome,
) -> Result<u64> {
    match outcome {
        store::ConditionalCommitOutcome::Committed { revision } => Ok(revision),
        store::ConditionalCommitOutcome::Conflict { current_revision } => {
            Err(store_revision_conflict(provider, current_revision))
        }
    }
}

pub(crate) fn store_revision_conflict(
    provider: SubscriptionProvider,
    current_revision: u64,
) -> anyhow::Error {
    anyhow!(
        "{} credentials changed in another OpenBitFun process (current revision {current_revision}); retry the operation",
        provider.display_label()
    )
}

/// Reloads the credential after a refresh lost its conditional commit race.
///
/// The revision returned by the CAS conflict is the revision observed while
/// holding the store lock. Reloading after releasing that lock gives the
/// caller the credential that won the race, which may be safely reused when it
/// is still valid.
pub(crate) async fn load_current_store_after_conflict(
    provider: SubscriptionProvider,
    current_revision: u64,
) -> Result<store::VersionedCredential> {
    let current = store::load_entry_with_revision(provider.key()).await?;
    log::debug!(
        "{} refresh commit lost CAS at revision {current_revision}; reloaded current revision {}",
        provider.display_label(),
        current.revision
    );
    Ok(current)
}

fn build_account(
    provider: SubscriptionProvider,
    entry: Option<&StoredCredential>,
    reauthentication_required: bool,
    vault_unavailable: bool,
) -> SubscriptionAccount {
    let (format, base_url, model) = provider.suggested();
    let (connected, account, expires_at, metadata) = match entry {
        None => (false, None, None, None),
        Some(StoredCredential::Api { metadata, .. }) => (true, None, None, metadata.as_ref()),
        Some(StoredCredential::Oauth {
            expires,
            account_id,
            metadata,
            ..
        }) => {
            let email = metadata
                .as_ref()
                .and_then(|value| value.get("email"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let account = email.or_else(|| account_id.clone());
            (true, account, Some(expires / 1000), metadata.as_ref())
        }
    };
    let api_offerings = if connected && provider == SubscriptionProvider::Opencode {
        opencode::offerings_from_metadata(metadata)
    } else {
        Vec::new()
    };
    SubscriptionAccount {
        provider,
        display_label: provider.display_label(),
        account,
        expires_at,
        connected,
        login_methods: provider.login_methods().to_vec(),
        reauthentication_required,
        vault_unavailable,
        suggested_format: format.to_string(),
        suggested_base_url: base_url.to_string(),
        suggested_model: model.to_string(),
        api_offerings,
        management_url: match provider {
            SubscriptionProvider::Hermes => Some(hermes::MANAGEMENT_URL.to_string()),
            _ => None,
        },
    }
}

async fn account_snapshot(provider: SubscriptionProvider) -> SubscriptionAccount {
    let state = store::load_with_state().await.unwrap_or_else(|error| {
        log::warn!("load subscription credential state failed: {error:#}");
        store::LoadState {
            credentials: store::Store::new(),
            requires_reauthentication: std::collections::HashSet::new(),
            vault_unavailable: std::collections::HashSet::new(),
            provider_revisions: std::collections::HashMap::new(),
        }
    });
    build_account(
        provider,
        state.credentials.get(provider.key()),
        state.requires_reauthentication.contains(provider.key()),
        state.vault_unavailable.contains(provider.key()),
    )
}

/// Lists all providers with their current connection state.
pub async fn list_accounts() -> Vec<SubscriptionAccount> {
    let state = store::load_with_state().await.unwrap_or_else(|error| {
        log::warn!("load subscription credential state failed: {error:#}");
        store::LoadState {
            credentials: store::Store::new(),
            requires_reauthentication: std::collections::HashSet::new(),
            vault_unavailable: std::collections::HashSet::new(),
            provider_revisions: std::collections::HashMap::new(),
        }
    });
    SubscriptionProvider::ALL
        .iter()
        .map(|provider| {
            build_account(
                *provider,
                state.credentials.get(provider.key()),
                state.requires_reauthentication.contains(provider.key()),
                state.vault_unavailable.contains(provider.key()),
            )
        })
        .collect()
}

/// Starts a login session, cancelling any existing pending session for the
/// same provider. Returns immediately with the authorization URL / user code.
pub async fn start_login(
    provider: SubscriptionProvider,
    session_id: String,
) -> Result<LoginStartResult> {
    start_login_with_options(provider, session_id, SubscriptionHttpOptions::default()).await
}

/// Starts a subscription login with an explicit transport policy.
pub async fn start_login_with_options(
    provider: SubscriptionProvider,
    session_id: String,
    options: SubscriptionHttpOptions,
) -> Result<LoginStartResult> {
    start_login_with_method_and_options(provider, session_id, None, options).await
}

/// Starts a subscription login using an explicitly selected authorization
/// method. `None` preserves the legacy preferred-method behavior.
pub async fn start_login_with_method_and_options(
    provider: SubscriptionProvider,
    session_id: String,
    method: Option<SubscriptionLoginMethod>,
    options: SubscriptionHttpOptions,
) -> Result<LoginStartResult> {
    validate_session_id(&session_id)?;
    if let Some(method) = method.filter(|method| !provider.supports_login_method(*method)) {
        return Err(anyhow!(
            "{} does not support the requested {:?} login method",
            provider.display_label(),
            method
        ));
    }
    let cancel = CancellationToken::new();
    let generation = next_generation();
    // Serialize the durable revision snapshot with any local refresh/commit and
    // install the replacement session before releasing that boundary. A prior
    // local login can then either finish before this snapshot or observe its
    // cancellation; it cannot commit between the snapshot and replacement.
    let provider_guard = store_lock(provider).lock().await;
    let expected_revision = store::credential_revision(provider.key()).await?;
    {
        let mut map = sessions()
            .lock()
            .map_err(|_| anyhow!("subscription login session lock poisoned"))?;
        if let Some(previous) = map.insert(
            provider,
            SessionState {
                session_id: session_id.clone(),
                status: LoginStatus::Pending,
                method,
                authorization_url: None,
                user_code: None,
                instructions: None,
                error: None,
                account: None,
                cancel: cancel.clone(),
                generation,
            },
        ) {
            previous.cancel.cancel();
        }
    }
    drop(provider_guard);

    // The placeholder above makes cancellation visible even while a provider
    // is still binding its callback listener or requesting a device code.
    let begin_cancel = cancel.clone();
    let begin = async move {
        match provider {
            SubscriptionProvider::Codex => {
                codex::begin_login(
                    begin_cancel.clone(),
                    expected_revision,
                    method,
                    options.clone(),
                )
                .await
            }
            SubscriptionProvider::Antigravity => {
                antigravity::begin_login(begin_cancel.clone(), expected_revision, options.clone())
                    .await
            }
            SubscriptionProvider::Opencode => {
                opencode::begin_login(begin_cancel.clone(), expected_revision, options).await
            }
            SubscriptionProvider::Grok => {
                grok::begin_login(begin_cancel.clone(), expected_revision, options).await
            }
            SubscriptionProvider::Hermes => {
                hermes::begin_login(begin_cancel.clone(), expected_revision, options).await
            }
        }
    };
    let started_result = tokio::select! {
        _ = cancel.cancelled() => Err(anyhow!("login cancelled")),
        result = begin => result,
    };
    let started = match started_result {
        Ok(started) if !cancel.is_cancelled() => started,
        Ok(_) => return Err(anyhow!("login cancelled")),
        Err(error) => {
            if let Ok(mut map) = sessions().lock() {
                if let Some(state) = map.get_mut(&provider).filter(|state| {
                    state.generation == generation && state.session_id == session_id
                }) {
                    state.status = if cancel.is_cancelled() {
                        LoginStatus::Cancelled
                    } else {
                        LoginStatus::Failed
                    };
                    state.error = Some(format!("{error:#}"));
                }
            }
            return Err(error);
        }
    };

    let authorization_url = started.authorization_url.clone();
    let started_method = started.method;
    // Desktop opener rejects relative URLs ("Not allowed to open url /...").
    // Every provider must return an absolute http(s) authorization URL.
    if !(authorization_url.starts_with("https://") || authorization_url.starts_with("http://")) {
        cancel.cancel();
        if let Ok(mut map) = sessions().lock() {
            if let Some(state) = map
                .get_mut(&provider)
                .filter(|state| state.generation == generation && state.session_id == session_id)
            {
                state.status = LoginStatus::Failed;
                state.error = Some(
                    "Subscription login returned a non-absolute authorization URL".to_string(),
                );
            }
        }
        return Err(anyhow!(
            "subscription login returned a non-absolute authorization URL: {authorization_url}"
        ));
    }
    let user_code = started.user_code.clone();
    let instructions = started.instructions.clone();
    {
        let mut map = sessions()
            .lock()
            .map_err(|_| anyhow!("subscription login session lock poisoned"))?;
        let Some(state) = map.get_mut(&provider).filter(|state| {
            state.generation == generation
                && state.session_id == session_id
                && !state.cancel.is_cancelled()
        }) else {
            cancel.cancel();
            return Err(anyhow!("login cancelled"));
        };
        state.authorization_url = Some(authorization_url.clone());
        state.method = Some(started_method);
        state.user_code = user_code.clone();
        state.instructions = Some(instructions.clone());
    }

    let runner = started.runner;
    let runner_session_id = session_id.clone();
    tokio::spawn(async move {
        // Authorization timeout lives inside `authorize_then_persist`; once
        // persistence begins it must not be dropped by a surrounding timeout.
        let outcome: Result<Result<()>, tokio::time::error::Elapsed> = Ok(runner.await);
        finalize_session(provider, &runner_session_id, generation, &cancel, outcome).await;
    });

    Ok(LoginStartResult {
        provider,
        session_id,
        method: started_method,
        authorization_url,
        user_code,
        instructions,
    })
}

async fn finalize_session(
    provider: SubscriptionProvider,
    session_id: &str,
    generation: u64,
    cancel: &CancellationToken,
    outcome: Result<Result<()>, tokio::time::error::Elapsed>,
) {
    // A newer login for the same provider has already replaced this session;
    // the stale runner must not overwrite its state.
    let is_current = sessions()
        .lock()
        .map(|map| {
            map.get(&provider).is_some_and(|state| {
                state.generation == generation && state.session_id == session_id
            })
        })
        .unwrap_or(false);
    if !is_current {
        return;
    }

    let (status, error, account) = match outcome {
        Err(_) => (
            LoginStatus::Failed,
            Some("Login timed out".to_string()),
            None,
        ),
        Ok(Ok(())) => {
            let account = account_snapshot(provider).await;
            (LoginStatus::Authorized, None, Some(account))
        }
        Ok(Err(err)) => {
            if cancel.is_cancelled() {
                (
                    LoginStatus::Cancelled,
                    Some("Login cancelled".to_string()),
                    None,
                )
            } else {
                (LoginStatus::Failed, Some(format!("{err:#}")), None)
            }
        }
    };

    update_session_if_current(provider, session_id, generation, status, error, account);
}

fn update_session_if_current(
    provider: SubscriptionProvider,
    session_id: &str,
    generation: u64,
    status: LoginStatus,
    error: Option<String>,
    account: Option<SubscriptionAccount>,
) {
    if let Ok(mut map) = sessions().lock() {
        if let Some(state) = map
            .get_mut(&provider)
            .filter(|state| state.generation == generation && state.session_id == session_id)
        {
            state.status = status;
            state.error = error;
            if account.is_some() {
                state.account = account;
            }
        }
    }
}

/// Returns a login snapshot only when both provider and session id still refer
/// to the same current operation.
pub async fn login_status(
    provider: SubscriptionProvider,
    session_id: &str,
) -> Result<LoginSessionSnapshot> {
    validate_session_id(session_id)?;
    let map = sessions()
        .lock()
        .map_err(|_| anyhow!("subscription login session lock poisoned"))?;
    map.get(&provider)
        .filter(|state| state.session_id == session_id)
        .map(|state| state.snapshot(provider))
        .ok_or_else(|| anyhow!("subscription login session is no longer current"))
}

/// Cancels an in-flight login session for a provider.
pub async fn cancel_login(provider: SubscriptionProvider, session_id: &str) -> Result<()> {
    validate_session_id(session_id)?;
    let wait_for_commit_barrier = if let Ok(mut map) = sessions().lock() {
        if let Some(state) = map
            .get_mut(&provider)
            .filter(|state| state.session_id == session_id)
        {
            match state.status {
                LoginStatus::Pending => {
                    state.cancel.cancel();
                    state.status = LoginStatus::Cancelled;
                    state.error = Some("Login cancelled".to_string());
                    true
                }
                // A duplicate cancel can observe the state update performed by
                // the first cancel before that call reaches the credential
                // commit barrier. It must join the same barrier instead of
                // reporting completion while persistence may still succeed.
                LoginStatus::Cancelled => true,
                // Authorization may have already committed and finalized.
                // Never rewrite an Authorized terminal state to Cancelled;
                // that would disagree with the connected credential.
                LoginStatus::Authorized | LoginStatus::Failed => false,
            }
        } else {
            false
        }
    } else {
        return Err(anyhow!("subscription login session lock poisoned"));
    };
    // A stale cancel from an older UI request is a no-op and must not wait on
    // or interfere with the replacement session's commit.
    if !wait_for_commit_barrier {
        return Ok(());
    }
    // Act as a completion barrier for the commit phase. If cancellation wins
    // the provider lock, the runner observes the cancelled token and skips its
    // write. If persistence already owns the lock, let that atomic commit
    // finish before reporting cancellation back to the UI.
    let _guard = store_lock(provider).lock().await;
    Ok(())
}

/// Removes the stored credential for a provider.
pub async fn logout(provider: SubscriptionProvider) -> Result<SubscriptionLogoutResult> {
    // Cancel any in-flight login first so its runner cannot persist fresh
    // tokens after the logout completes.
    if let Ok(mut map) = sessions().lock() {
        if let Some(state) = map.remove(&provider) {
            state.cancel.cancel();
        }
    }
    let _guard = store_lock(provider).lock().await;
    let outcome = store::remove(provider.key()).await?;
    drop(_guard);
    log::info!("subscription provider {} logged out", provider.key());
    Ok(match outcome {
        store::RemoveOutcome::Removed => SubscriptionLogoutResult {
            cleanup_pending: false,
            warning: None,
        },
        store::RemoveOutcome::CleanupPending(warning) => {
            log::warn!(
                "subscription provider {} logged out with credential cleanup pending: {}",
                provider.key(),
                warning
            );
            SubscriptionLogoutResult {
                cleanup_pending: true,
                warning: Some(warning),
            }
        }
    })
}

/// Resolves a runtime credential for a provider, refreshing tokens if needed.
pub async fn resolve(provider: SubscriptionProvider) -> Result<ResolvedCredential> {
    resolve_with_options(provider, &SubscriptionHttpOptions::default()).await
}

/// Resolves a subscription credential with an explicit transport policy.
pub async fn resolve_with_options(
    provider: SubscriptionProvider,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    match provider {
        SubscriptionProvider::Codex => codex::resolve(options).await,
        SubscriptionProvider::Antigravity => antigravity::resolve(options).await,
        SubscriptionProvider::Opencode => opencode::resolve(options).await,
        SubscriptionProvider::Grok => grok::resolve(options).await,
        SubscriptionProvider::Hermes => hermes::resolve(options).await,
    }
}

/// Resolves an OpenCode credential for a concrete plan and request format.
/// The adapter owns the endpoint mapping so an OAuth token can never be sent
/// to an arbitrary URL supplied by model configuration.
pub async fn resolve_opencode(plan: OpenCodePlan, format: &str) -> Result<ResolvedCredential> {
    resolve_opencode_with_options(plan, format, &SubscriptionHttpOptions::default()).await
}

/// Resolves an OpenCode credential with an explicit transport policy.
pub async fn resolve_opencode_with_options(
    plan: OpenCodePlan,
    format: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    opencode::resolve_for(plan, format, options).await
}

/// Resolves the OpenCode wire format from the signed-in account's catalog.
/// Legacy callers may omit the plan; known models still get their correct wire.
pub async fn resolve_opencode_model_with_options(
    plan: Option<OpenCodePlan>,
    configured_format: &str,
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    opencode::resolve_for_model(plan, configured_format, model, options).await
}

/// Resolves an xAI subscription credential for a concrete model. The adapter
/// owns the trusted Responses endpoint so the OAuth token can never be sent to
/// an arbitrary URL supplied by model configuration.
pub async fn resolve_grok(model: &str) -> Result<ResolvedCredential> {
    resolve_grok_with_options(model, &SubscriptionHttpOptions::default()).await
}

/// Resolves an xAI subscription credential with an explicit transport policy.
pub async fn resolve_grok_with_options(
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    grok::resolve_for(model, options).await
}

/// Resolves a Hermes subscription credential for a concrete model. All catalog
/// models use the current Hermes Chat Completions default, pinned to the trusted
/// Nous inference host. Saved model IDs and credentials remain unchanged.
pub async fn resolve_hermes(model: &str) -> Result<ResolvedCredential> {
    resolve_hermes_with_options(model, &SubscriptionHttpOptions::default()).await
}

/// Resolves a Hermes credential with an explicit transport policy.
pub async fn resolve_hermes_with_options(
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    hermes::resolve_for(model, options).await
}

/// Forces a resolve (which refreshes and saves), then returns the account entry.
pub async fn refresh_account(provider: SubscriptionProvider) -> Result<SubscriptionAccount> {
    refresh_account_with_options(provider, &SubscriptionHttpOptions::default()).await
}

/// Refreshes a subscription account with an explicit transport policy.
pub async fn refresh_account_with_options(
    provider: SubscriptionProvider,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionAccount> {
    match provider {
        SubscriptionProvider::Opencode => opencode::refresh_profile(options).await?,
        _ => {
            resolve_with_options(provider, options).await?;
        }
    }
    Ok(account_snapshot(provider).await)
}

#[cfg(test)]
mod tests {
    use super::store::{self, StoredCredential};
    use super::*;

    #[tokio::test]
    async fn opencode_console_routes_zen_and_preserves_rejected_go_credentials() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        let old = serde_json::json!({
            "type":"oauth", "access":"synthetic-access", "refresh":"synthetic-refresh",
            "expires":chrono::Utc::now().timestamp_millis() + 3_600_000,
            "metadata":{"org_id":"fixture-org", "console_routes_v1":{"fixture":{
                "base_url":"https://opencode.ai/inference/openai/v1",
                "request_url":"https://opencode.ai/inference/openai/v1/responses",
                "format":"responses","headers":{"x-opencode-org-id":"fixture-org"}
            }}, "api_offerings":[
                {"plan":"zen","format":"responses","base_url":"https://opencode.ai/inference/openai/v1","suggested_model":"fixture","models":[{"id":"fixture"}]},
                {"plan":"go","format":"anthropic","base_url":"https://opencode.ai/zen/go/v1","suggested_model":"go-fixture","models":[{"id":"go-fixture"}]}
            ]}
        });
        store::upsert("opencode", serde_json::from_value(old).unwrap())
            .await
            .unwrap();
        let before = store::load_entry_with_revision("opencode").await.unwrap();
        let resolved = resolve_opencode_model_with_options(
            None,
            "openai",
            "fixture",
            &SubscriptionHttpOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            resolved.request_url.as_deref(),
            Some("https://opencode.ai/inference/openai/v1/responses")
        );
        assert_eq!(
            resolved
                .extra_headers
                .get("x-opencode-org-id")
                .map(String::as_str),
            Some("fixture-org")
        );
        assert_eq!(
            resolve_opencode_model_with_options(
                Some(OpenCodePlan::Go),
                "anthropic",
                "go-fixture",
                &SubscriptionHttpOptions::default()
            )
            .await
            .unwrap_err()
            .to_string(),
            OPENCODE_GO_REQUIRES_API_KEY
        );
        let after = store::load_entry_with_revision("opencode").await.unwrap();
        assert_eq!(before.revision, after.revision);
        assert_eq!(
            serde_json::to_value(before.credential).unwrap(),
            serde_json::to_value(&after.credential).unwrap()
        );
        let account = build_account(
            SubscriptionProvider::Opencode,
            after.credential.as_ref(),
            false,
            false,
        );
        assert!(account
            .api_offerings
            .iter()
            .all(|offering| offering.plan == OpenCodePlan::Zen));
    }

    const STALE_LOGIN_CHILD_METADATA_ENV: &str = "OPENBITFUN_SUBAUTH_CAS_CHILD_METADATA";
    const STALE_LOGIN_CHILD_LOADED_ENV: &str = "OPENBITFUN_SUBAUTH_CAS_CHILD_LOADED";
    const STALE_LOGIN_CHILD_RESUME_ENV: &str = "OPENBITFUN_SUBAUTH_CAS_CHILD_RESUME";
    const STALE_LOGIN_CHILD_OUTCOME_ENV: &str = "OPENBITFUN_SUBAUTH_CAS_CHILD_OUTCOME";

    /// Serializes tests that rely on the process-global store path override.
    /// Serializes these tests against the shared on-disk store. Async-aware so
    /// the guard may be held across the awaits each test performs, matching how
    /// `store_lock` above already guards the real store.
    fn test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        &LOCK
    }

    fn temp_store_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("openbitfun-subauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("subscription_auth.json")
    }

    fn test_session_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    #[tokio::test]
    async fn legacy_codex_and_grok_expiry_is_bounded_for_client_caches() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        let now = chrono::Utc::now().timestamp();
        let actual_expiry = now + 20 * 60;
        let body = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "exp": actual_expiry, "chatgpt_account_id": "test-account"
            }))
            .unwrap(),
        );
        let token = format!("e30.{body}.test");
        for provider in [SubscriptionProvider::Codex, SubscriptionProvider::Grok] {
            // Shape written by older builds: metadata assumes a one-hour
            // lifetime even though the actual JWT expires after twenty minutes.
            let credential: StoredCredential = serde_json::from_value(serde_json::json!({
                "type": "oauth", "access": token, "refresh": "unused-synthetic-refresh",
                "expires": (now + 3600) * 1000
            }))
            .unwrap();
            store::upsert(provider.key(), credential).await.unwrap();
            let revision = store::load_entry_with_revision(provider.key())
                .await
                .unwrap()
                .revision;
            let resolved = resolve_with_options(provider, &SubscriptionHttpOptions::default())
                .await
                .unwrap();
            assert_eq!(resolved.expires_at, Some(actual_expiry));
            assert_eq!(resolved.api_key, token);
            if provider == SubscriptionProvider::Codex {
                assert_eq!(resolved.extra_headers["originator"], "openbitfun");
                assert!(resolved.extra_headers["User-Agent"].starts_with("OpenBitFun/"));
                assert_eq!(resolved.extra_headers["ChatGPT-Account-ID"], "test-account");
                assert!(!resolved.extra_headers.contains_key("session-id"));
            }
            // No rotation or mutation is needed for a still-usable legacy JWT.
            assert_eq!(
                store::load_entry_with_revision(provider.key())
                    .await
                    .unwrap()
                    .revision,
                revision
            );
        }
    }

    #[test]
    fn subscription_headers_survive_legacy_replace_mode_on_each_wire() {
        use crate::{
            client::AIClient,
            providers::{anthropic, gemini, openai},
            types::AIConfig,
        };
        // Deserialized legacy user settings, including differently cased stale
        // auth headers. Assert the final request, not just the merged HashMap.
        for (format, url, headers, auth_header) in [
            ("responses", "https://chatgpt.com/backend-api/codex/responses", vec![("originator", "openbitfun"), ("User-Agent", "OpenBitFun/test"), ("ChatGPT-Account-ID", "current-account")], "authorization"),
            ("responses", "https://api.x.ai/v1/responses", vec![("User-Agent", "opencode/test")], "authorization"),
            ("openai", "https://opencode.ai/zen/v1/chat/completions", vec![("x-org-id", "current-org"), ("User-Agent", "OpenBitFun/test")], "authorization"),
            ("anthropic", "https://opencode.ai/zen/v1/messages", vec![("x-org-id", "current-org"), ("User-Agent", "OpenBitFun/test")], "x-api-key"),
            ("openai", "https://inference-api.nousresearch.com/v1/chat/completions", vec![], "authorization"),
            ("anthropic", "https://inference-api.nousresearch.com/v1/messages", vec![], "authorization"),
            ("gemini-code-assist", "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse", vec![("User-Agent", "antigravity/test"), ("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1"), ("Client-Metadata", "ANTIGRAVITY")], "authorization"),
        ] {
            let saved = serde_json::json!({
                "name": "legacy", "model": "saved-model", "format": "anthropic",
                "base_url": "https://old.invalid", "request_url": "https://old.invalid/messages",
                "api_key": "old-api-key", "context_window": 128000, "inline_think_in_text": false, "skip_ssl_verify": false,
                "custom_headers_mode": "replace", "custom_headers": {
                    "AUTHORIZATION": "Bearer stale", "X-Api-Key": "stale-key",
                    "x-goog-api-key": "stale-google-key", "Content-Type": "text/plain",
                    "ANTHROPIC-VERSION": "invalid", "user-agent": "stale-client",
                    "X-ORG-ID": "stale-org", "chatgpt-account-id": "stale-account",
                    "x-openai-internal-codex-residency": "stale-residency", "session-id": "stale-session", "X-Trace-Test": "keep"
                }
            });
            let mut config: AIConfig = serde_json::from_value(saved.clone()).unwrap();
            let required: HashMap<String, String> = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let expires = ResolvedCredential {
                api_key: "current-token".into(), base_url: Some(url.into()), request_url: Some(url.into()),
                format: Some(format.into()), extra_headers: required.clone(), expires_at: Some(12345),
            }.apply_to(&mut config);
            assert_eq!(expires, Some(12345));
            assert_eq!(config.model, "saved-model");
            assert_eq!(config.custom_headers_mode.as_deref(), Some("merge"));
            let client = AIClient::new(config);
            for method in [reqwest::Method::GET, reqwest::Method::POST] {
                let builder = client.client.request(method, url);
                let request = match format {
                    "anthropic" => anthropic::request::apply_headers(&client, builder, url),
                    "gemini-code-assist" => gemini::code_assist::apply_headers(&client, builder),
                    _ => openai::common::apply_headers(&client, builder),
                }.build().unwrap();
                let actual = request.headers();
                assert_eq!(actual.get_all(auth_header).iter().count(), 1, "{url}");
                assert_eq!(actual[auth_header], if auth_header == "authorization" { "Bearer current-token" } else { "current-token" });
                assert!(!actual.contains_key(if auth_header == "authorization" { "x-api-key" } else { "authorization" }));
                assert!(!actual.contains_key("x-goog-api-key"));
                assert!(!actual.contains_key("session-id"));
                assert!(!actual.contains_key("x-openai-internal-codex-residency"));
                assert_eq!(actual.get_all("content-type").iter().count(), 1);
                assert_eq!(actual["content-type"], "application/json");
                assert_eq!(actual["x-trace-test"], "keep");
                for (name, value) in &required {
                    assert_eq!(actual.get_all(name).iter().count(), 1, "{url}: {name}");
                    assert_eq!(actual[name], value);
                }
            }
            // Runtime application does not rewrite the persisted legacy settings.
            let restored: AIConfig = serde_json::from_value(saved).unwrap();
            assert_eq!(restored.custom_headers_mode.as_deref(), Some("replace"));
            assert_eq!(restored.api_key, "old-api-key");
        }
    }

    #[tokio::test]
    async fn legacy_hermes_anthropic_config_uses_current_chat_route_without_relogin() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        let expires = chrono::Utc::now().timestamp() + 3600;
        let body = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "exp": expires, "scope": "inference:invoke", "sub": "fixture-account"
            }))
            .unwrap(),
        );
        let token = format!("e30.{body}.fixture");
        let legacy: StoredCredential = serde_json::from_value(serde_json::json!({
            "type": "oauth", "access": token, "refresh": "unchanged-refresh", "expires": expires * 1000
        })).unwrap();
        store::upsert("hermes", legacy).await.unwrap();
        let before = store::load_entry_with_revision("hermes")
            .await
            .unwrap()
            .revision;
        let resolved = resolve_hermes("anthropic/claude-sonnet-5").await.unwrap();
        assert_eq!(resolved.format.as_deref(), Some("openai"));
        assert_eq!(
            resolved.request_url.as_deref(),
            Some("https://inference-api.nousresearch.com/v1/chat/completions")
        );
        assert_eq!(resolved.api_key, token);
        let after = store::load_entry_with_revision("hermes").await.unwrap();
        assert_eq!(after.revision, before);
        let roundtrip: StoredCredential =
            serde_json::from_value(serde_json::to_value(after.credential.unwrap()).unwrap())
                .unwrap();
        assert!(
            matches!(roundtrip, StoredCredential::Oauth { refresh, .. } if refresh == "unchanged-refresh")
        );
    }

    #[test]
    fn subscription_provider_serde_roundtrip() {
        assert_eq!(
            serde_json::to_value(SubscriptionProvider::Codex).unwrap(),
            serde_json::json!("codex")
        );
        assert_eq!(
            serde_json::to_value(SubscriptionProvider::Antigravity).unwrap(),
            serde_json::json!("antigravity")
        );
        assert_eq!(
            serde_json::to_value(SubscriptionProvider::Grok).unwrap(),
            serde_json::json!("grok")
        );
        assert_eq!(
            serde_json::to_value(SubscriptionProvider::Hermes).unwrap(),
            serde_json::json!("hermes")
        );
        let parsed: SubscriptionProvider =
            serde_json::from_value(serde_json::json!("opencode")).unwrap();
        assert_eq!(parsed, SubscriptionProvider::Opencode);
        assert_eq!(
            SubscriptionProvider::from_key("codex"),
            Some(SubscriptionProvider::Codex)
        );
        assert_eq!(
            SubscriptionProvider::from_key("grok"),
            Some(SubscriptionProvider::Grok)
        );
        assert_eq!(
            SubscriptionProvider::from_key("hermes"),
            Some(SubscriptionProvider::Hermes)
        );
        assert_eq!(SubscriptionProvider::from_key("unknown"), None);
    }

    #[test]
    fn subscription_login_methods_match_provider_protocols() {
        assert_eq!(
            SubscriptionProvider::Codex.login_methods(),
            &[
                SubscriptionLoginMethod::Browser,
                SubscriptionLoginMethod::Device,
            ]
        );
        assert_eq!(
            SubscriptionProvider::Antigravity.login_methods(),
            &[SubscriptionLoginMethod::Browser]
        );
        assert_eq!(
            SubscriptionProvider::Opencode.login_methods(),
            &[SubscriptionLoginMethod::Device]
        );
        assert_eq!(
            SubscriptionProvider::Hermes.login_methods(),
            &[SubscriptionLoginMethod::Device]
        );
        assert_eq!(
            serde_json::to_value(SubscriptionLoginMethod::Device).unwrap(),
            serde_json::json!("device")
        );
    }

    #[tokio::test]
    async fn unsupported_login_method_is_rejected_before_session_start() {
        let error = start_login_with_method_and_options(
            SubscriptionProvider::Antigravity,
            test_session_id(),
            Some(SubscriptionLoginMethod::Device),
            SubscriptionHttpOptions::default(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("does not support"));
    }

    #[test]
    fn retired_subscription_defaults_receive_runtime_only_replacements() {
        assert_eq!(
            runtime_model_override(SubscriptionProvider::Codex, "gpt-5-codex"),
            Some("gpt-5.5")
        );
        assert_eq!(
            runtime_model_override(SubscriptionProvider::Grok, "grok-build"),
            Some("grok-build-0.1")
        );
        assert_eq!(
            runtime_model_override(SubscriptionProvider::Antigravity, "  "),
            Some("gemini-3-pro-high")
        );
        assert_eq!(
            runtime_model_override(SubscriptionProvider::Grok, "grok-4.5"),
            None
        );
        assert_eq!(
            runtime_model_override(SubscriptionProvider::Hermes, " "),
            Some("z-ai/glm-5.2")
        );
    }

    #[tokio::test]
    async fn store_roundtrip_in_temp_dir() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        let mut store = store::Store::new();
        store.insert(
            "codex".to_string(),
            StoredCredential::Oauth {
                refresh: "refresh-token".to_string(),
                access: "access-token".to_string(),
                expires: 1_800_000_000_000,
                account_id: Some("acct_1".to_string()),
                metadata: Some(serde_json::json!({ "email": "user@example.com" })),
            },
        );
        store::save(&store).await.unwrap();

        let metadata_file = std::fs::read_to_string(store_path_override_for_assertion()).unwrap();
        assert!(!metadata_file.contains("refresh-token"));
        assert!(!metadata_file.contains("access-token"));
        assert!(metadata_file.contains("user@example.com"));

        let loaded = store::load().await.unwrap();
        let entry = loaded.get("codex").expect("codex entry present");
        match entry {
            StoredCredential::Oauth {
                access, account_id, ..
            } => {
                assert_eq!(access, "access-token");
                assert_eq!(account_id.as_deref(), Some("acct_1"));
            }
            _ => panic!("expected oauth credential"),
        }

        let accounts = list_accounts().await;
        let codex = accounts
            .iter()
            .find(|a| a.provider == SubscriptionProvider::Codex)
            .unwrap();
        assert!(codex.connected);
        assert_eq!(codex.account.as_deref(), Some("user@example.com"));
        assert_eq!(codex.expires_at, Some(1_800_000_000));
        assert!(!codex.reauthentication_required);
        let hermes = accounts
            .iter()
            .find(|a| a.provider == SubscriptionProvider::Hermes)
            .unwrap();
        assert!(!hermes.connected);
        assert_eq!(
            hermes.management_url.as_deref(),
            Some("https://portal.nousresearch.com/manage-subscription")
        );
    }

    fn store_path_override_for_assertion() -> std::path::PathBuf {
        super::store::store_path_for_test_assertion()
    }

    #[tokio::test]
    async fn plaintext_store_is_rejected_without_rewrite() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());
        let plaintext = serde_json::json!({
            "opencode": {
                "type": "oauth",
                "refresh": "plaintext-refresh-secret",
                "access": "plaintext-access-secret",
                "expires": 1_900_000_000_000_i64,
                "metadata": { "email": "user@example.com" }
            }
        });
        let original = serde_json::to_vec_pretty(&plaintext).unwrap();
        std::fs::write(&path, &original).unwrap();

        let error = store::load().await.unwrap_err();
        assert!(error.to_string().contains("subscription auth metadata"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(store::test_vault_entries_for_assertion().is_empty());
    }

    #[tokio::test]
    async fn partial_chunk_write_is_durably_cleaned_after_retry() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        store::set_test_vault_write_failure_after(Some(1));
        store::set_test_vault_delete_failure(true);

        let error = store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "r".repeat(3_000),
                access: "a".repeat(3_000),
                expires: 1_900_000_000_000,
                account_id: None,
                metadata: None,
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("vault write failure"));
        assert!(!store::test_vault_entries_for_assertion().is_empty());
        assert!(!store::cleanup_journal_entries_for_assertion()
            .await
            .is_empty());

        store::set_test_vault_write_failure_after(None);
        store::set_test_vault_delete_failure(false);
        let loaded = store::load().await.unwrap();
        assert!(loaded.is_empty());
        assert!(store::test_vault_entries_for_assertion().is_empty());
        assert!(store::cleanup_journal_entries_for_assertion()
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn windows_post_commit_backup_cleanup_failure_does_not_fail_commit() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        let tmp = path.with_extension("tmp-one");
        let backup = path.with_extension("bak");
        std::fs::write(&path, b"previous-sensitive-metadata").unwrap();
        std::fs::write(&tmp, b"new-metadata").unwrap();

        store::set_test_backup_cleanup_failure(&backup, true);
        store::replace_metadata_file_windows(&tmp, &path)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new-metadata");
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            b"previous-sensitive-metadata"
        );

        store::set_test_backup_cleanup_failure(&backup, false);
        let next_tmp = path.with_extension("tmp-two");
        std::fs::write(&next_tmp, b"newer-metadata").unwrap();
        store::replace_metadata_file_windows(&next_tmp, &path)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"newer-metadata");
        assert!(!backup.exists());
    }

    #[tokio::test]
    async fn concurrent_provider_upserts_preserve_both_metadata_entries() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());

        let codex = store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "codex-refresh".to_string(),
                access: "codex-access".to_string(),
                expires: 1_900_000_000_000,
                account_id: Some("codex-account".to_string()),
                metadata: None,
            },
        );
        let opencode = store::upsert(
            "opencode",
            StoredCredential::Oauth {
                refresh: "opencode-refresh".to_string(),
                access: "opencode-access".to_string(),
                expires: 1_900_000_000_000,
                account_id: None,
                metadata: Some(serde_json::json!({ "email": "zen@example.com" })),
            },
        );
        let (codex_result, opencode_result) = tokio::join!(codex, opencode);
        codex_result.unwrap();
        opencode_result.unwrap();

        let loaded = store::load().await.unwrap();
        assert!(loaded.contains_key("codex"));
        assert!(loaded.contains_key("opencode"));
        let metadata = std::fs::read_to_string(path).unwrap();
        assert!(metadata.contains("\"codex\""));
        assert!(metadata.contains("\"opencode\""));
        assert!(!metadata.contains("codex-access"));
        assert!(!metadata.contains("opencode-access"));
    }

    #[tokio::test]
    async fn logout_tombstone_wins_over_a_refresh_paused_after_load() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "refresh-before-logout".to_string(),
                access: "access-before-logout".to_string(),
                expires: 1,
                account_id: None,
                metadata: None,
            },
        )
        .await
        .unwrap();

        // Model a second process paused in the external refresh request after
        // it has loaded the old credential and revision.
        let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let stale_refresh = tokio::spawn(async move {
            let snapshot = store::load_entry_with_revision("codex").await?;
            loaded_tx
                .send(snapshot.revision)
                .map_err(|_| anyhow!("refresh load signal receiver dropped"))?;
            resume_rx
                .await
                .map_err(|_| anyhow!("refresh resume signal sender dropped"))?;
            store::upsert_if_revision(
                "codex",
                snapshot.revision,
                StoredCredential::Oauth {
                    refresh: "stale-rotated-refresh".to_string(),
                    access: "stale-refreshed-access".to_string(),
                    expires: 1_900_000_000_000,
                    account_id: None,
                    metadata: None,
                },
            )
            .await
        });

        let loaded_revision = loaded_rx.await.unwrap();
        let remove_outcome = store::remove("codex").await.unwrap();
        assert!(matches!(remove_outcome, store::RemoveOutcome::Removed));
        let logout_revision = store::credential_revision("codex").await.unwrap();
        assert!(logout_revision > loaded_revision);
        resume_tx.send(()).unwrap();

        let refresh_outcome = stale_refresh.await.unwrap().unwrap();
        assert_eq!(
            refresh_outcome,
            store::ConditionalCommitOutcome::Conflict {
                current_revision: logout_revision,
            }
        );
        assert!(store::load_entry("codex").await.unwrap().is_none());

        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(metadata["accounts"].get("codex").is_none());
        assert_eq!(
            metadata["provider_revisions"]["codex"].as_u64(),
            Some(logout_revision)
        );
    }

    #[tokio::test]
    async fn cross_process_stale_login_cas_child() {
        let Some(path) =
            std::env::var_os(STALE_LOGIN_CHILD_METADATA_ENV).map(std::path::PathBuf::from)
        else {
            return;
        };
        let loaded_path = std::path::PathBuf::from(
            std::env::var_os(STALE_LOGIN_CHILD_LOADED_ENV).expect("child loaded marker path"),
        );
        let resume_path = std::path::PathBuf::from(
            std::env::var_os(STALE_LOGIN_CHILD_RESUME_ENV).expect("child resume marker path"),
        );
        let outcome_path = std::path::PathBuf::from(
            std::env::var_os(STALE_LOGIN_CHILD_OUTCOME_ENV).expect("child outcome marker path"),
        );
        store::set_store_path_for_test(path);

        let login_revision = store::credential_revision("opencode").await.unwrap();
        assert_eq!(login_revision, 0);
        std::fs::write(&loaded_path, b"loaded").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !resume_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("parent should release the stale login after logout");

        let outcome = store::upsert_if_revision(
            "opencode",
            login_revision,
            StoredCredential::Api {
                key: "stale-login-key".to_string(),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let store::ConditionalCommitOutcome::Conflict { current_revision } = outcome else {
            panic!("stale cross-process login unexpectedly committed: {outcome:?}");
        };
        std::fs::write(outcome_path, current_revision.to_string()).unwrap();
    }

    #[tokio::test]
    async fn logout_of_an_absent_provider_invalidates_a_cross_process_login() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());
        let parent = path.parent().unwrap();
        let loaded_path = parent.join("child-loaded");
        let resume_path = parent.join("child-resume");
        let outcome_path = parent.join("child-outcome");
        let mut child = openbitfun_services_core::process_manager::create_command(
            std::env::current_exe().unwrap(),
        )
        .arg("--exact")
        .arg("subscription_auth::tests::cross_process_stale_login_cas_child")
        .arg("--nocapture")
        .env(STALE_LOGIN_CHILD_METADATA_ENV, &path)
        .env(STALE_LOGIN_CHILD_LOADED_ENV, &loaded_path)
        .env(STALE_LOGIN_CHILD_RESUME_ENV, &resume_path)
        .env(STALE_LOGIN_CHILD_OUTCOME_ENV, &outcome_path)
        .spawn()
        .expect("spawn stale-login child process");

        tokio::time::timeout(Duration::from_secs(5), async {
            while !loaded_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("child should capture the pre-logout revision");
        store::remove("opencode").await.unwrap();
        let logout_revision = store::credential_revision("opencode").await.unwrap();
        std::fs::write(&resume_path, b"resume").unwrap();

        let status = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(status) = child.try_wait().expect("poll stale-login child process") {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stale-login child should finish after resume");
        assert!(status.success(), "stale-login child failed: {status}");
        assert_eq!(
            std::fs::read_to_string(outcome_path).unwrap(),
            logout_revision.to_string()
        );
        assert!(store::load_entry("opencode").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn v2_metadata_without_revision_map_remains_conditionally_writable() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 2,
                "accounts": {}
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(store::credential_revision("antigravity").await.unwrap(), 0);
        let outcome = store::upsert_if_revision(
            "antigravity",
            0,
            StoredCredential::Api {
                key: "compatible-key".to_string(),
                metadata: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            outcome,
            store::ConditionalCommitOutcome::Committed { revision: 1 }
        );
        assert!(store::load_entry("antigravity").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn repeated_upsert_replaces_existing_metadata_file() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());

        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "old-refresh".to_string(),
                access: "old-access".to_string(),
                expires: 1_800_000_000_000,
                account_id: None,
                metadata: None,
            },
        )
        .await
        .unwrap();
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "new-refresh".to_string(),
                access: "new-access".to_string(),
                expires: 1_900_000_000_000,
                account_id: Some("updated-account".to_string()),
                metadata: None,
            },
        )
        .await
        .unwrap();

        let loaded = store::load_entry("codex").await.unwrap().unwrap();
        match loaded {
            StoredCredential::Oauth {
                refresh,
                access,
                expires,
                account_id,
                ..
            } => {
                assert_eq!(refresh, "new-refresh");
                assert_eq!(access, "new-access");
                assert_eq!(expires, 1_900_000_000_000);
                assert_eq!(account_id.as_deref(), Some("updated-account"));
            }
            _ => panic!("expected oauth credential"),
        }
        let metadata = std::fs::read_to_string(path).unwrap();
        assert!(!metadata.contains("old-access"));
        assert!(!metadata.contains("new-access"));
        assert!(metadata.contains("updated-account"));
    }

    #[tokio::test]
    async fn long_tokens_are_split_below_the_windows_vault_limit() {
        let _guard = test_lock().lock().await;
        let path = temp_store_path();
        store::set_store_path_for_test(path.clone());
        let refresh = "r".repeat(5_000);
        let access = "a".repeat(9_000);

        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: refresh.clone(),
                access: access.clone(),
                expires: 1_900_000_000_000,
                account_id: None,
                metadata: None,
            },
        )
        .await
        .unwrap();

        let entries = store::test_vault_entries_for_assertion();
        assert!(entries.len() > 2, "long tokens must use multiple entries");
        assert!(entries.keys().all(|name| name != "codex"));
        assert!(entries.values().all(|part| part.len() <= 2_048));
        let loaded = store::load_entry("codex").await.unwrap().unwrap();
        match loaded {
            StoredCredential::Oauth {
                refresh: loaded_refresh,
                access: loaded_access,
                ..
            } => {
                assert_eq!(loaded_refresh, refresh);
                assert_eq!(loaded_access, access);
            }
            _ => panic!("expected oauth credential"),
        }
        let metadata = std::fs::read_to_string(path).unwrap();
        assert!(!metadata.contains(&refresh));
        assert!(!metadata.contains(&access));
    }

    #[tokio::test]
    async fn unavailable_vault_is_retryable_not_missing_credential() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        store::upsert(
            "opencode",
            StoredCredential::Api {
                key: "sk-present-but-locked".to_string(),
                metadata: None,
            },
        )
        .await
        .unwrap();

        store::set_test_vault_unavailable(true);
        let state = store::load_with_state().await.unwrap();
        assert!(!state.credentials.contains_key("opencode"));
        assert!(!state.requires_reauthentication.contains("opencode"));
        assert!(state.vault_unavailable.contains("opencode"));
        let error = store::load_entry("opencode").await.unwrap_err();
        assert!(error.to_string().contains("locked or unavailable"));
        store::set_test_vault_unavailable(false);

        let restored = store::load_entry("opencode").await.unwrap();
        assert!(restored.is_some());
    }

    #[tokio::test]
    async fn logout_clears_stored_credential() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        let mut store = store::Store::new();
        store.insert(
            "opencode".to_string(),
            StoredCredential::Api {
                key: "sk-test".to_string(),
                metadata: None,
            },
        );
        store::save(&store).await.unwrap();

        logout(SubscriptionProvider::Opencode).await.unwrap();
        let loaded = store::load().await.unwrap();
        assert!(!loaded.contains_key("opencode"));
    }

    #[tokio::test]
    async fn failed_logout_metadata_commit_preserves_usable_credential() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        store::upsert(
            "opencode",
            StoredCredential::Api {
                key: "sk-still-usable".to_string(),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let entries_before = store::test_vault_entries_for_assertion();

        store::set_test_metadata_write_failure(true);
        let error = store::remove("opencode").await.unwrap_err();
        assert!(error.to_string().contains("injected"));
        store::set_test_metadata_write_failure(false);

        assert_eq!(store::test_vault_entries_for_assertion(), entries_before);
        let loaded = store::load_entry("opencode").await.unwrap().unwrap();
        match loaded {
            StoredCredential::Api { key, .. } => assert_eq!(key, "sk-still-usable"),
            _ => panic!("expected api credential"),
        }
    }

    #[tokio::test]
    async fn failed_logout_vault_delete_is_reported_and_retried() {
        let _guard = test_lock().lock().await;
        store::set_store_path_for_test(temp_store_path());
        store::upsert(
            "opencode",
            StoredCredential::Api {
                key: "sk-pending-delete".to_string(),
                metadata: None,
            },
        )
        .await
        .unwrap();

        store::set_test_vault_delete_failure(true);
        let outcome = logout(SubscriptionProvider::Opencode).await.unwrap();
        assert!(outcome.cleanup_pending);
        assert!(outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("cleanup is pending")));
        assert!(!store::test_vault_entries_for_assertion().is_empty());
        assert!(!store::cleanup_journal_entries_for_assertion()
            .await
            .is_empty());
        assert!(store::load_entry("opencode").await.unwrap().is_none());

        store::set_test_vault_delete_failure(false);
        assert!(store::load().await.unwrap().is_empty());
        assert!(store::test_vault_entries_for_assertion().is_empty());
        assert!(store::cleanup_journal_entries_for_assertion()
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn finalize_ignores_superseded_session() {
        let _guard = test_lock().lock().await;
        let provider = SubscriptionProvider::Codex;
        let stale_generation = next_generation();
        let stale_session_id = test_session_id();
        let current_session_id = test_session_id();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: current_session_id,
                    status: LoginStatus::Pending,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: CancellationToken::new(),
                    generation: stale_generation + 1,
                },
            );
        }

        // The stale runner (previous generation) must not overwrite the newer
        // pending session when it finishes.
        finalize_session(
            provider,
            &stale_session_id,
            stale_generation,
            &CancellationToken::new(),
            Ok(Err(anyhow!("stale runner failed"))),
        )
        .await;

        let status = {
            let mut map = sessions().lock().unwrap();
            let status = map.get(&provider).map(|state| state.status);
            map.remove(&provider);
            status
        };
        assert_eq!(status, Some(LoginStatus::Pending));
    }

    #[tokio::test]
    async fn cancellation_does_not_drop_started_credential_persistence() {
        let cancel = CancellationToken::new();
        let (persist_started_tx, persist_started_rx) = tokio::sync::oneshot::channel();
        let (allow_persist_tx, allow_persist_rx) = tokio::sync::oneshot::channel();

        let task = tokio::spawn(authorize_then_persist(
            SubscriptionProvider::Codex,
            cancel.clone(),
            async { Ok::<_, anyhow::Error>("authorized-token") },
            move |token| async move {
                assert_eq!(token, "authorized-token");
                persist_started_tx.send(()).unwrap();
                allow_persist_rx.await.unwrap();
                Ok(())
            },
        ));

        persist_started_rx.await.unwrap();
        cancel.cancel();
        tokio::task::yield_now().await;
        assert!(!task.is_finished());

        allow_persist_tx.send(()).unwrap();
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn cancellation_before_authorization_skips_persistence() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let persisted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let persisted_for_task = persisted.clone();

        let result = authorize_then_persist(
            SubscriptionProvider::Opencode,
            cancel,
            std::future::pending::<Result<()>>(),
            move |_| async move {
                persisted_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(result.is_err());
        assert!(!persisted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelled_commit_waiting_for_provider_lock_does_not_persist() {
        let provider = SubscriptionProvider::Antigravity;
        let store_guard = store_lock(provider).lock().await;
        let cancel = CancellationToken::new();
        let (authorized_tx, authorized_rx) = tokio::sync::oneshot::channel();
        let persisted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let persisted_for_task = persisted.clone();

        let task = tokio::spawn(authorize_then_persist(
            provider,
            cancel.clone(),
            async move {
                authorized_tx.send(()).unwrap();
                Ok::<_, anyhow::Error>("authorized-token")
            },
            move |_| async move {
                persisted_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));

        authorized_rx.await.unwrap();
        cancel.cancel();
        drop(store_guard);

        assert!(task.await.unwrap().is_err());
        assert!(!persisted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancel_command_waits_for_the_commit_boundary() {
        let _guard = test_lock().lock().await;
        let provider = SubscriptionProvider::Opencode;
        let store_guard = store_lock(provider).lock().await;
        let cancel = CancellationToken::new();
        let generation = next_generation();
        let session_id = test_session_id();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: session_id.clone(),
                    status: LoginStatus::Pending,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: cancel.clone(),
                    generation,
                },
            );
        }

        let task_session_id = session_id.clone();
        let task =
            tokio::spawn(async move { cancel_login(provider, &task_session_id).await.unwrap() });
        tokio::task::yield_now().await;
        assert!(cancel.is_cancelled());
        assert!(!task.is_finished());

        drop(store_guard);
        task.await.unwrap();
        let status = sessions()
            .lock()
            .unwrap()
            .remove(&provider)
            .map(|state| state.status);
        assert_eq!(status, Some(LoginStatus::Cancelled));
    }

    #[tokio::test]
    async fn duplicate_cancel_waits_for_the_same_commit_boundary() {
        let _guard = test_lock().lock().await;
        let provider = SubscriptionProvider::Antigravity;
        let store_guard = store_lock(provider).lock().await;
        let cancel = CancellationToken::new();
        let session_id = test_session_id();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: session_id.clone(),
                    status: LoginStatus::Pending,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: cancel.clone(),
                    generation: next_generation(),
                },
            );
        }

        let first_session_id = session_id.clone();
        let first_cancel =
            tokio::spawn(async move { cancel_login(provider, &first_session_id).await.unwrap() });
        tokio::task::yield_now().await;
        assert!(cancel.is_cancelled());
        assert!(!first_cancel.is_finished());

        let second_session_id = session_id.clone();
        let second_cancel =
            tokio::spawn(async move { cancel_login(provider, &second_session_id).await.unwrap() });
        tokio::task::yield_now().await;
        assert!(!second_cancel.is_finished());

        drop(store_guard);
        first_cancel.await.unwrap();
        second_cancel.await.unwrap();
        let status = sessions()
            .lock()
            .unwrap()
            .remove(&provider)
            .map(|state| state.status);
        assert_eq!(status, Some(LoginStatus::Cancelled));
    }

    #[tokio::test]
    async fn stale_cancel_does_not_cancel_replacement_session() {
        let _guard = test_lock().lock().await;
        let provider = SubscriptionProvider::Opencode;
        let stale_session_id = test_session_id();
        let current_session_id = test_session_id();
        let current_cancel = CancellationToken::new();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: current_session_id.clone(),
                    status: LoginStatus::Pending,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: current_cancel.clone(),
                    generation: next_generation(),
                },
            );
        }

        cancel_login(provider, &stale_session_id).await.unwrap();
        assert!(!current_cancel.is_cancelled());
        let snapshot = login_status(provider, &current_session_id).await.unwrap();
        assert_eq!(snapshot.session_id, current_session_id);
        assert_eq!(snapshot.status, LoginStatus::Pending);
        sessions().lock().unwrap().remove(&provider);
    }

    #[tokio::test]
    async fn cancel_does_not_rewrite_authorized_terminal_state() {
        let _guard = test_lock().lock().await;
        let provider = SubscriptionProvider::Codex;
        let session_id = test_session_id();
        let cancel = CancellationToken::new();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: session_id.clone(),
                    status: LoginStatus::Authorized,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: cancel.clone(),
                    generation: next_generation(),
                },
            );
        }

        cancel_login(provider, &session_id).await.unwrap();
        assert!(!cancel.is_cancelled());
        let snapshot = login_status(provider, &session_id).await.unwrap();
        assert_eq!(snapshot.status, LoginStatus::Authorized);
        sessions().lock().unwrap().remove(&provider);
    }

    #[test]
    fn final_state_update_rechecks_generation_after_async_work() {
        // Plain `#[test]`, so there is no ambient runtime for `blocking_lock` to
        // stall; it still serializes against the async tests above.
        let _guard = test_lock().blocking_lock();
        let provider = SubscriptionProvider::Codex;
        let old_generation = next_generation();
        let new_generation = next_generation();
        let old_session_id = test_session_id();
        let new_session_id = test_session_id();
        {
            let mut map = sessions().lock().unwrap();
            map.insert(
                provider,
                SessionState {
                    session_id: new_session_id,
                    status: LoginStatus::Pending,
                    method: None,
                    authorization_url: None,
                    user_code: None,
                    instructions: None,
                    error: None,
                    account: None,
                    cancel: CancellationToken::new(),
                    generation: new_generation,
                },
            );
        }

        update_session_if_current(
            provider,
            &old_session_id,
            old_generation,
            LoginStatus::Authorized,
            None,
            None,
        );

        let status = {
            let mut map = sessions().lock().unwrap();
            let status = map.get(&provider).map(|state| state.status);
            map.remove(&provider);
            status
        };
        assert_eq!(status, Some(LoginStatus::Pending));
    }
}
