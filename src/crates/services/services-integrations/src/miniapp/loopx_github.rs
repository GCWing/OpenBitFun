use super::loopx_cli::LoopxIntakeMetadataProvider;
use async_trait::async_trait;
use openbitfun_product_domains::miniapp::loopx as loopx_contract;
use reqwest::header::{HeaderMap, ETAG, IF_NONE_MATCH, RETRY_AFTER};
use reqwest::StatusCode;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const GITHUB_API_ROOT: &str = "https://api.github.com";
const INTAKE_PAGE_SIZE: usize = 100;
const INTAKE_MAX_REPOSITORY_PAGES: usize = 10;
const AUTHENTICATED_CREDENTIAL_TTL: Duration = Duration::from_secs(300);
const MISSING_CREDENTIAL_TTL: Duration = Duration::from_secs(30);
const RESPONSE_CACHE_TTL: Duration = Duration::from_secs(60);
const RATE_SNAPSHOT_TTL: Duration = Duration::from_secs(30);
const MAX_RESPONSE_CACHE_ENTRIES: usize = 256;
const DEFAULT_SECONDARY_BACKOFF: Duration = Duration::from_secs(60);
/// Upper bound of the plain-text excerpt kept per issue/PR body. Keeps task
/// snapshots (and the event stream) bounded while still giving task surfaces
/// readable context.
const DESCRIPTION_EXCERPT_MAX_CHARS: usize = 600;

/// Trims a GitHub markdown body into a bounded plain-text excerpt used by
/// task surfaces. Markdown image/link syntax is resolved to its visible text,
/// common markup characters are folded away, and the result is whitespace-
/// normalized. The full body is never projected into the candidate/task
/// snapshot.
fn candidate_description(body: &str) -> String {
    let mut excerpt = String::with_capacity(body.len().min(DESCRIPTION_EXCERPT_MAX_CHARS * 3));
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '!' if chars.peek() == Some(&'[') => {
                // `![alt](url)` → keep alt, drop url.
                chars.next(); // '['
                let alt = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    take_until(&mut chars, ')');
                }
                push_word(&mut excerpt, &alt);
            }
            '[' => {
                // `[text](url)` → keep text, drop url.
                let text = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    take_until(&mut chars, ')');
                }
                push_word(&mut excerpt, &text);
            }
            '#' | '*' | '_' | '`' | '>' | '~' => push_word(&mut excerpt, ""),
            _ => excerpt.push(ch),
        }
    }
    let normalized = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut normalized_chars = normalized.chars();
    let mut bounded = normalized_chars
        .by_ref()
        .take(DESCRIPTION_EXCERPT_MAX_CHARS)
        .collect::<String>();
    if normalized_chars.next().is_some() {
        bounded.push('…');
    }
    bounded
}

/// Reads characters up to and including `stop`, returning the text before it.
fn take_until(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, stop: char) -> String {
    let mut text = String::new();
    while let Some(next) = chars.next() {
        if next == stop {
            break;
        }
        text.push(next);
    }
    text
}

/// Appends `word` to `excerpt`, separated by a space when non-empty.
fn push_word(excerpt: &mut String, word: &str) {
    let word = word.trim();
    if word.is_empty() {
        return;
    }
    if !excerpt.is_empty() && !excerpt.ends_with(' ') {
        excerpt.push(' ');
    }
    excerpt.push_str(word);
}

#[derive(Clone)]
struct GithubCredential {
    token: Option<String>,
    source: Option<&'static str>,
    detail: String,
}

impl GithubCredential {
    fn cache_scope(&self) -> String {
        let Some(token) = self.token.as_deref() else {
            return "anonymous".to_string();
        };
        let digest = Sha256::digest(token.as_bytes());
        let fingerprint = digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("authenticated:{fingerprint}")
    }
}

#[derive(Clone)]
struct CachedCredential {
    credential: GithubCredential,
    checked_at: Instant,
}

#[derive(Clone)]
struct CachedGithubResponse {
    value: Value,
    etag: Option<String>,
    stored_at: Instant,
}

#[derive(Debug, Clone)]
struct RateLimitSnapshot {
    credential_scope: String,
    limit: Option<u64>,
    remaining: Option<u64>,
    reset_at: Option<u64>,
    observed_at: Instant,
}

#[derive(Debug, Clone)]
struct RateLimitBlock {
    credential_scope: String,
    until: Instant,
    message: String,
}

#[derive(Debug, Default)]
struct GithubRateState {
    snapshot: Option<RateLimitSnapshot>,
    block: Option<RateLimitBlock>,
}

#[derive(Clone)]
pub struct GithubLoopxIntakeMetadataProvider {
    client: reqwest::Client,
    credential: Arc<Mutex<Option<CachedCredential>>>,
    responses: Arc<Mutex<HashMap<String, CachedGithubResponse>>>,
    rate: Arc<Mutex<GithubRateState>>,
    request_gate: Arc<Mutex<()>>,
}

impl GithubLoopxIntakeMetadataProvider {
    pub fn new() -> Result<Self, String> {
        let client = crate::reqwest_client_builder()
            .user_agent("BitFun LoopX MiniApp")
            .build()
            .map_err(|error| format!("Failed to build GitHub client: {error}"))?;
        Ok(Self {
            client,
            credential: Arc::new(Mutex::new(None)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            rate: Arc::new(Mutex::new(GithubRateState::default())),
            request_gate: Arc::new(Mutex::new(())),
        })
    }

    async fn github_credential(&self, force_refresh: bool) -> GithubCredential {
        let mut cached = self.credential.lock().await;
        if !force_refresh {
            if let Some(existing) = cached.as_ref() {
                let ttl = if existing.credential.token.is_some() {
                    AUTHENTICATED_CREDENTIAL_TTL
                } else {
                    MISSING_CREDENTIAL_TTL
                };
                if existing.checked_at.elapsed() < ttl {
                    return existing.credential.clone();
                }
            }
        }
        let credential = load_github_credential().await;
        *cached = Some(CachedCredential {
            credential: credential.clone(),
            checked_at: Instant::now(),
        });
        credential
    }

    async fn invalidate_credential(&self) {
        *self.credential.lock().await = None;
    }

    async fn active_rate_limit(&self, credential_scope: &str) -> Option<RateLimitBlock> {
        let mut rate = self.rate.lock().await;
        match rate.block.as_ref() {
            Some(block) if block.credential_scope != credential_scope => {
                rate.block = None;
                None
            }
            Some(block) if block.until > Instant::now() => Some(block.clone()),
            Some(_) => {
                rate.block = None;
                None
            }
            None => None,
        }
    }

    async fn recent_rate_snapshot(&self, credential_scope: &str) -> Option<RateLimitSnapshot> {
        self.rate.lock().await.snapshot.clone().filter(|snapshot| {
            snapshot.credential_scope == credential_scope
                && snapshot.observed_at.elapsed() < RATE_SNAPSHOT_TTL
        })
    }

    async fn store_rate_snapshot(
        &self,
        credential_scope: &str,
        limit: Option<u64>,
        remaining: Option<u64>,
        reset_at: Option<u64>,
    ) {
        self.rate.lock().await.snapshot = Some(RateLimitSnapshot {
            credential_scope: credential_scope.to_string(),
            limit,
            remaining,
            reset_at,
            observed_at: Instant::now(),
        });
    }

    async fn record_rate_headers(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        credential_scope: &str,
    ) -> Option<RateLimitBlock> {
        let now = Instant::now();
        let unix_now = now_unix_seconds();
        let limit = header_u64(headers, "x-ratelimit-limit");
        let remaining = header_u64(headers, "x-ratelimit-remaining");
        let reset_at = header_u64(headers, "x-ratelimit-reset");
        let retry_after = header_u64(headers, RETRY_AFTER.as_str());
        let mut rate = self.rate.lock().await;
        if limit.is_some() || remaining.is_some() || reset_at.is_some() {
            rate.snapshot = Some(RateLimitSnapshot {
                credential_scope: credential_scope.to_string(),
                limit,
                remaining,
                reset_at,
                observed_at: now,
            });
        }
        let block = if remaining == Some(0) {
            let wait_seconds = reset_at
                .map(|reset| reset.saturating_sub(unix_now).max(1))
                .unwrap_or(60);
            Some(RateLimitBlock {
                credential_scope: credential_scope.to_string(),
                until: now + Duration::from_secs(wait_seconds),
                message: format!(
                    "GitHub primary API rate limit is exhausted; retry in {wait_seconds} seconds{}",
                    reset_at
                        .map(|reset| format!(" (reset epoch {reset})"))
                        .unwrap_or_default()
                ),
            })
        } else if status == StatusCode::TOO_MANY_REQUESTS || retry_after.is_some() {
            let wait_seconds = retry_after
                .unwrap_or(DEFAULT_SECONDARY_BACKOFF.as_secs())
                .max(1);
            Some(RateLimitBlock {
                credential_scope: credential_scope.to_string(),
                until: now + Duration::from_secs(wait_seconds),
                message: format!(
                    "GitHub secondary API rate limit is active; retry in {wait_seconds} seconds"
                ),
            })
        } else {
            None
        };
        if let Some(block) = block.clone() {
            rate.block = Some(block);
        } else if status.is_success() {
            rate.block = None;
        }
        block
    }

    async fn record_secondary_limit(&self, credential_scope: &str) -> RateLimitBlock {
        let block = RateLimitBlock {
            credential_scope: credential_scope.to_string(),
            until: Instant::now() + DEFAULT_SECONDARY_BACKOFF,
            message: format!(
                "GitHub secondary API rate limit is active; retry in {} seconds",
                DEFAULT_SECONDARY_BACKOFF.as_secs()
            ),
        };
        self.rate.lock().await.block = Some(block.clone());
        block
    }

    async fn cached_response(
        &self,
        credential_scope: &str,
        path: &str,
    ) -> Option<CachedGithubResponse> {
        self.responses
            .lock()
            .await
            .get(&response_cache_key(credential_scope, path))
            .cloned()
    }

    async fn store_response(
        &self,
        credential_scope: &str,
        path: &str,
        value: Value,
        etag: Option<String>,
    ) {
        let cache_key = response_cache_key(credential_scope, path);
        let mut responses = self.responses.lock().await;
        if responses.len() >= MAX_RESPONSE_CACHE_ENTRIES && !responses.contains_key(&cache_key) {
            if let Some(oldest) = responses
                .iter()
                .min_by_key(|(_, response)| response.stored_at)
                .map(|(path, _)| path.clone())
            {
                responses.remove(&oldest);
            }
        }
        responses.insert(
            cache_key,
            CachedGithubResponse {
                value,
                etag,
                stored_at: Instant::now(),
            },
        );
    }

    async fn get_json(
        &self,
        path: &str,
        deadline: Duration,
        operation_id: &str,
    ) -> loopx_contract::LoopxCliResult<Value> {
        let _request = self.request_gate.lock().await;
        let credential = self.github_credential(false).await;
        let credential_scope = credential.cache_scope();
        let cached = self.cached_response(&credential_scope, path).await;
        if let Some(cached) = cached.as_ref() {
            if cached.stored_at.elapsed() < RESPONSE_CACHE_TTL {
                return Ok(cached.value.clone());
            }
        }
        if let Some(block) = self.active_rate_limit(&credential_scope).await {
            return Err(rate_limit_error(operation_id, block));
        }
        let mut request = self
            .client
            .get(format!("{GITHUB_API_ROOT}{path}"))
            .timeout(deadline);
        if let Some(token) = credential.token.as_deref() {
            request = request.bearer_auth(token);
        }
        if credential.token.is_some() {
            if let Some(etag) = cached.as_ref().and_then(|cached| cached.etag.as_deref()) {
                request = request.header(IF_NONE_MATCH, etag);
            }
        }
        let response = request.send().await.map_err(|error| {
            loopx_contract::LoopxCliError::new(
                if error.is_timeout() {
                    loopx_contract::LoopxCliErrorKind::Timeout
                } else {
                    loopx_contract::LoopxCliErrorKind::Backend
                },
                format!("GitHub intake request failed: {error}"),
            )
            .for_operation(operation_id)
            .retryable(true)
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        if let Some(block) = self
            .record_rate_headers(status, &headers, &credential_scope)
            .await
        {
            return Err(rate_limit_error(operation_id, block));
        }
        if status == StatusCode::NOT_MODIFIED {
            return cached.map(|cached| cached.value).ok_or_else(|| {
                loopx_contract::LoopxCliError::new(
                    loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                    "GitHub returned 304 without a cached response",
                )
                .for_operation(operation_id)
            });
        }
        if status == StatusCode::UNAUTHORIZED {
            self.invalidate_credential().await;
            return Err(loopx_contract::LoopxCliError::new(
                loopx_contract::LoopxCliErrorKind::Backend,
                "GitHub authentication is invalid or expired; run `gh auth login --hostname github.com --web`",
            )
            .for_operation(operation_id));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(loopx_contract::LoopxCliError::new(
                loopx_contract::LoopxCliErrorKind::NotFound,
                "GitHub repository, issue, or pull request was not found",
            )
            .for_operation(operation_id));
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let api_detail = github_error_detail(&body);
            let lower_detail = api_detail.to_ascii_lowercase();
            if status == StatusCode::FORBIDDEN
                && (lower_detail.contains("secondary rate limit")
                    || lower_detail.contains("abuse detection"))
            {
                let block = self.record_secondary_limit(&credential_scope).await;
                return Err(rate_limit_error(operation_id, block));
            }
            let message = if status == StatusCode::FORBIDDEN {
                if credential.token.is_none() {
                    format!(
                        "GitHub request was forbidden without authentication; {}",
                        credential.detail
                    )
                } else {
                    format!(
                        "GitHub request was forbidden (403); the repository may be private or the credential lacks access{}",
                        optional_api_detail(&api_detail)
                    )
                }
            } else {
                format!(
                    "GitHub intake request returned HTTP {status}{}",
                    optional_api_detail(&api_detail)
                )
            };
            return Err(loopx_contract::LoopxCliError::new(
                loopx_contract::LoopxCliErrorKind::Backend,
                message,
            )
            .for_operation(operation_id)
            .retryable(status.is_server_error()));
        }
        let etag = headers
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let value = response.json::<Value>().await.map_err(|error| {
            loopx_contract::LoopxCliError::new(
                loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                format!("GitHub intake response was invalid: {error}"),
            )
            .for_operation(operation_id)
        })?;
        self.store_response(&credential_scope, path, value.clone(), etag)
            .await;
        Ok(value)
    }

    async fn resolve_repository_candidates(
        &self,
        repository: &loopx_contract::LoopxRepositoryKey,
        deadline: Duration,
        operation_id: &str,
    ) -> loopx_contract::LoopxCliResult<(Vec<loopx_contract::LoopxIntakeCandidate>, bool)> {
        let mut candidates = Vec::new();
        let mut seen = BTreeSet::new();
        for page in 1..=INTAKE_MAX_REPOSITORY_PAGES {
            let value = self
                .get_json(
                    &format!(
                        "/repos/{}/{}/issues?state=open&sort=updated&direction=desc&per_page={INTAKE_PAGE_SIZE}&page={page}",
                        repository.owner, repository.repository
                    ),
                    deadline,
                    operation_id,
                )
                .await?;
            let rows = value.as_array().ok_or_else(|| {
                loopx_contract::LoopxCliError::new(
                    loopx_contract::LoopxCliErrorKind::SchemaMismatch,
                    "GitHub issues response was not an array",
                )
                .for_operation(operation_id)
            })?;
            append_repository_issue_candidates(repository, rows, &mut seen, &mut candidates);
            if rows.len() < INTAKE_PAGE_SIZE {
                return Ok((candidates, false));
            }
        }
        Ok((candidates, true))
    }
}

async fn load_github_credential() -> GithubCredential {
    if let Some((name, token)) = ["GH_TOKEN", "GITHUB_TOKEN"].into_iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .map(|token| (name, token))
    }) {
        return GithubCredential {
            token: Some(token),
            source: Some("environment"),
            detail: format!("GitHub authentication is configured through {name}"),
        };
    }
    let Some(executable) = resolve_github_cli() else {
        return GithubCredential {
            token: None,
            source: None,
            detail: "GitHub CLI was not found and GH_TOKEN/GITHUB_TOKEN is not set".to_string(),
        };
    };
    let output = match tokio::process::Command::new(executable)
        .args(["auth", "token", "--hostname", "github.com"])
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) => {
            return GithubCredential {
                token: None,
                source: None,
                detail: format!("GitHub CLI credential lookup failed: {error}"),
            };
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .unwrap_or("run `gh auth login --hostname github.com --web`");
        return GithubCredential {
            token: None,
            source: None,
            detail: format!("GitHub CLI is not authenticated: {detail}"),
        };
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        GithubCredential {
            token: None,
            source: None,
            detail: "GitHub CLI returned an empty credential".to_string(),
        }
    } else {
        GithubCredential {
            token: Some(token),
            source: Some("GitHub CLI"),
            detail: "GitHub authentication is provided by the local GitHub CLI login".to_string(),
        }
    }
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn response_cache_key(credential_scope: &str, path: &str) -> String {
    format!("{credential_scope}\n{path}")
}

fn rate_limit_error(operation_id: &str, block: RateLimitBlock) -> loopx_contract::LoopxCliError {
    loopx_contract::LoopxCliError::new(loopx_contract::LoopxCliErrorKind::Backend, block.message)
        .for_operation(operation_id)
        .retryable(false)
}

fn github_error_detail(body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());
    detail.chars().take(300).collect()
}

fn optional_api_detail(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn resolve_github_cli() -> Option<PathBuf> {
    if let Ok(path) = which::which("gh") {
        return Some(path);
    }
    github_cli_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn github_cli_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(root).join("GitHub CLI").join("gh.exe"));
            }
        }
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(root)
                    .join("Programs")
                    .join("GitHub CLI")
                    .join("gh.exe"),
            );
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[async_trait]
impl LoopxIntakeMetadataProvider for GithubLoopxIntakeMetadataProvider {
    async fn resolve(
        &self,
        request: &loopx_contract::LoopxCliResolveIntakeRequest,
        deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxCliResolveIntakeResult> {
        let repository = request.target.repository().clone();
        let operation_id = &request.call.operation_id;
        let mut candidates = Vec::new();
        let mut truncated = false;
        match &request.target {
            loopx_contract::LoopxIntakeTarget::Item { item } => {
                let collection = match item.kind {
                    loopx_contract::LoopxItemKind::Issue => "issues",
                    loopx_contract::LoopxItemKind::PullRequest => "pulls",
                };
                let value = self
                    .get_json(
                        &format!(
                            "/repos/{}/{}/{collection}/{}",
                            repository.owner, repository.repository, item.number
                        ),
                        deadline,
                        operation_id,
                    )
                    .await?;
                candidates.push(candidate_from_value(item.clone(), &value, false));
            }
            loopx_contract::LoopxIntakeTarget::Repository { .. } => {
                let (resolved_candidates, was_truncated) = self
                    .resolve_repository_candidates(&repository, deadline, operation_id)
                    .await?;
                candidates = resolved_candidates;
                truncated = was_truncated;
            }
        }
        Ok(loopx_contract::LoopxCliResolveIntakeResult {
            target: request.target.clone(),
            repository,
            candidates,
            truncated,
            resolved_at: now_ms(),
        })
    }

    async fn viewer_merge_authority(
        &self,
        repository: &loopx_contract::LoopxRepositoryKey,
        deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<Option<bool>> {
        let path = format!("/repos/{}/{}", repository.owner, repository.repository);
        let value = match self
            .get_json(&path, deadline, "github-merge-authority")
            .await
        {
            Ok(value) => value,
            Err(error) if error.kind == loopx_contract::LoopxCliErrorKind::NotFound => {
                // Unknown repository for this identity: treat as no authority
                // rather than blocking the gate behind a probe failure.
                return Ok(Some(false));
            }
            Err(_) => return Ok(None),
        };
        let Some(permissions) = value.get("permissions") else {
            // Unauthenticated responses omit the viewer permission block.
            return Ok(None);
        };
        let can = |field: &str| {
            permissions
                .get(field)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        Ok(Some(can("push") || can("maintain") || can("admin")))
    }

    async fn probe_auth(
        &self,
        deadline: Duration,
    ) -> loopx_contract::LoopxCliResult<loopx_contract::LoopxGithubAuthProbe> {
        const OPERATION_ID: &str = "github-auth-probe";
        let _request = self.request_gate.lock().await;
        let credential = self.github_credential(false).await;
        let credential_scope = credential.cache_scope();
        if let Some(block) = self.active_rate_limit(&credential_scope).await {
            let snapshot = self.recent_rate_snapshot(&credential_scope).await;
            return Ok(build_github_auth_probe(
                &credential,
                snapshot.as_ref(),
                Some(block.message),
            ));
        }
        if let Some(snapshot) = self.recent_rate_snapshot(&credential_scope).await {
            return Ok(build_github_auth_probe(&credential, Some(&snapshot), None));
        }
        let mut request = self
            .client
            .get(format!("{GITHUB_API_ROOT}/rate_limit"))
            .timeout(deadline);
        if let Some(token) = credential.token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|error| {
            loopx_contract::LoopxCliError::new(
                if error.is_timeout() {
                    loopx_contract::LoopxCliErrorKind::Timeout
                } else {
                    loopx_contract::LoopxCliErrorKind::Backend
                },
                format!("GitHub auth probe failed: {error}"),
            )
            .for_operation(OPERATION_ID)
            .retryable(true)
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        let header_block = self
            .record_rate_headers(status, &headers, &credential_scope)
            .await;
        if status == StatusCode::UNAUTHORIZED {
            self.invalidate_credential().await;
            return Ok(loopx_contract::LoopxGithubAuthProbe {
                authenticated: false,
                detail: Some(
                    "GitHub authentication is invalid or expired; run `gh auth login --hostname github.com --web`"
                        .to_string(),
                ),
                ..loopx_contract::LoopxGithubAuthProbe::default()
            });
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let api_detail = github_error_detail(&body);
            let lower_detail = api_detail.to_ascii_lowercase();
            let block = if let Some(block) = header_block {
                Some(block)
            } else if status == StatusCode::FORBIDDEN
                && (lower_detail.contains("secondary rate limit")
                    || lower_detail.contains("abuse detection"))
            {
                Some(self.record_secondary_limit(&credential_scope).await)
            } else {
                None
            };
            return Ok(loopx_contract::LoopxGithubAuthProbe {
                authenticated: false,
                detail: Some(block.map(|block| block.message).unwrap_or_else(|| {
                    format!(
                        "GitHub auth probe returned HTTP {status}{}; {}",
                        optional_api_detail(&api_detail),
                        credential.detail
                    )
                })),
                ..loopx_contract::LoopxGithubAuthProbe::default()
            });
        }

        let parsed = response.json::<Value>().await.ok();
        let limit = parsed
            .as_ref()
            .and_then(|value| value.pointer("/rate/limit"))
            .and_then(Value::as_u64);
        let remaining = parsed
            .as_ref()
            .and_then(|value| value.pointer("/rate/remaining"))
            .and_then(Value::as_u64);
        let reset_at = parsed
            .as_ref()
            .and_then(|value| value.pointer("/rate/reset"))
            .and_then(Value::as_u64);
        self.store_rate_snapshot(&credential_scope, limit, remaining, reset_at)
            .await;
        let snapshot = RateLimitSnapshot {
            credential_scope,
            limit,
            remaining,
            reset_at,
            observed_at: Instant::now(),
        };
        Ok(build_github_auth_probe(
            &credential,
            Some(&snapshot),
            header_block.map(|block| block.message),
        ))
    }
}

fn candidate_labels(value: &Value) -> Vec<String> {
    // LoopX's own metadata projection caps labels at 12 entries; mirror that
    // bound so the inline metadata stays within the workflow-plan budget.
    const LABEL_CAP: usize = 12;
    value
        .get("labels")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let name = match entry {
                        Value::String(text) => Some(text.clone()),
                        Value::Object(_) => entry
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        _ => None,
                    }?;
                    let name = name.trim().to_string();
                    (!name.is_empty()).then_some(name)
                })
                .take(LABEL_CAP)
                .collect()
        })
        .unwrap_or_default()
}

fn candidate_from_value(
    key: loopx_contract::LoopxIssueKey,
    value: &Value,
    from_repository: bool,
) -> loopx_contract::LoopxIntakeCandidate {
    let merged = value.get("merged_at").is_some_and(|value| !value.is_null());
    let state = if merged {
        loopx_contract::LoopxRemoteItemState::Merged
    } else {
        match value.get("state").and_then(Value::as_str) {
            Some("open") => loopx_contract::LoopxRemoteItemState::Open,
            Some("closed") => loopx_contract::LoopxRemoteItemState::Closed,
            _ => loopx_contract::LoopxRemoteItemState::Unknown,
        }
    };
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    loopx_contract::LoopxIntakeCandidate {
        url: key.canonical_url(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        description: candidate_description(body),
        state,
        state_reason: value
            .get("state_reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        labels: candidate_labels(value),
        from_repository,
        has_images: body.contains("![") || body.to_ascii_lowercase().contains("<img"),
        default_selected: !from_repository,
        key,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn build_github_auth_probe(
    credential: &GithubCredential,
    snapshot: Option<&RateLimitSnapshot>,
    override_detail: Option<String>,
) -> loopx_contract::LoopxGithubAuthProbe {
    let authenticated = credential.token.is_some();
    let remaining = snapshot.and_then(|snapshot| snapshot.remaining);
    let detail = override_detail.unwrap_or_else(|| match (authenticated, remaining) {
        (true, Some(count)) => format!(
            "Authenticated GitHub access via {} ({count} requests remaining this hour)",
            credential.source.unwrap_or("configured credential")
        ),
        (true, None) => format!(
            "Authenticated GitHub access via {}",
            credential.source.unwrap_or("configured credential")
        ),
        (false, Some(count)) => format!(
            "Unauthenticated GitHub access ({count} of {} requests remaining this hour); {}",
            snapshot.and_then(|snapshot| snapshot.limit).unwrap_or(60),
            credential.detail
        ),
        (false, None) => credential.detail.clone(),
    });
    let detail = if remaining == Some(0) {
        let reset = snapshot
            .and_then(|snapshot| snapshot.reset_at)
            .map(|reset| format!("; reset epoch {reset}"))
            .unwrap_or_default();
        format!("{detail}{reset}")
    } else {
        detail
    };
    loopx_contract::LoopxGithubAuthProbe {
        authenticated,
        rate_limit_remaining: remaining,
        detail: Some(detail),
    }
}

fn append_repository_issue_candidates(
    repository: &loopx_contract::LoopxRepositoryKey,
    rows: &[Value],
    seen: &mut BTreeSet<u64>,
    candidates: &mut Vec<loopx_contract::LoopxIntakeCandidate>,
) {
    for value in rows {
        if value.get("pull_request").is_some() {
            continue;
        }
        let Some(number) = value.get("number").and_then(Value::as_u64) else {
            continue;
        };
        if !seen.insert(number) {
            continue;
        }
        candidates.push(candidate_from_value(
            loopx_contract::LoopxIssueKey {
                repository: repository.clone(),
                kind: loopx_contract::LoopxItemKind::Issue,
                number,
            },
            value,
            true,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn metadata_projection_keeps_bounded_plain_text_excerpt_not_full_body() {
        let key = loopx_contract::LoopxIssueKey {
            repository: loopx_contract::LoopxRepositoryKey {
                host: "github.com".to_string(),
                owner: "owner".to_string(),
                repository: "repo".to_string(),
            },
            kind: loopx_contract::LoopxItemKind::Issue,
            number: 7,
        };
        let value = serde_json::json!({
            "number": 7,
            "title": "Visible title",
            "state": "open",
            "body": "private-looking body ![image](https://example.test/image.png) and a [link](https://example.test/x)"
        });
        let candidate = candidate_from_value(key, &value, false);
        assert_eq!(candidate.title, "Visible title");
        assert!(candidate.has_images);
        assert!(candidate.description.contains("private-looking"));
        assert!(candidate.description.contains("image"));
        // Full body and remote URLs never leak into the projection.
        let serialized = serde_json::to_string(&candidate).expect("serialize");
        assert!(!serialized.contains("https://example.test"));
        assert!(candidate.description.chars().count() <= DESCRIPTION_EXCERPT_MAX_CHARS + 1);
    }

    #[test]
    fn metadata_projection_counts_unicode_characters_and_marks_real_truncation() {
        let cjk_body = format!("{} sh 命令。", "中".repeat(210));
        assert!(cjk_body.len() > DESCRIPTION_EXCERPT_MAX_CHARS);
        assert_eq!(candidate_description(&cjk_body), cjk_body);

        let oversized = "项".repeat(DESCRIPTION_EXCERPT_MAX_CHARS + 1);
        let projected = candidate_description(&oversized);
        assert_eq!(projected.chars().count(), DESCRIPTION_EXCERPT_MAX_CHARS + 1);
        assert!(projected.ends_with('…'));
    }

    #[test]
    fn repository_candidate_collection_filters_pull_requests_and_duplicates() {
        let repository = loopx_contract::LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repository: "repo".to_string(),
        };
        let rows = vec![
            serde_json::json!({
                "number": 7,
                "title": "First issue",
                "state": "open",
                "body": ""
            }),
            serde_json::json!({
                "number": 8,
                "title": "Pull request",
                "state": "open",
                "pull_request": {}
            }),
            serde_json::json!({
                "number": 7,
                "title": "Duplicate issue",
                "state": "open",
                "body": ""
            }),
        ];
        let mut seen = BTreeSet::new();
        let mut candidates = Vec::new();

        append_repository_issue_candidates(&repository, &rows, &mut seen, &mut candidates);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].key.number, 7);
        assert!(candidates[0].from_repository);
        assert!(!candidates[0].default_selected);
    }

    #[tokio::test]
    async fn primary_rate_limit_blocks_local_retries_until_reset() {
        let provider = GithubLoopxIntakeMetadataProvider::new().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-limit", HeaderValue::from_static("5000"));
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        headers.insert(
            "x-ratelimit-reset",
            HeaderValue::from_str(&(now_unix_seconds() + 120).to_string()).unwrap(),
        );

        let block = provider
            .record_rate_headers(StatusCode::FORBIDDEN, &headers, "authenticated:account-a")
            .await
            .expect("primary limit should create a local block");
        assert!(block.message.contains("primary API rate limit"));
        assert!(provider
            .active_rate_limit("authenticated:account-a")
            .await
            .is_some());
        assert!(provider.active_rate_limit("anonymous").await.is_none());
        let error = rate_limit_error("rate-limited", block);
        assert!(!error.retryable);
        assert_eq!(error.operation_id.as_deref(), Some("rate-limited"));

        let snapshot = provider
            .recent_rate_snapshot("authenticated:account-a")
            .await
            .unwrap();
        assert_eq!(snapshot.limit, Some(5000));
        assert_eq!(snapshot.remaining, Some(0));
    }

    #[tokio::test]
    async fn retry_after_creates_a_secondary_rate_limit_block() {
        let provider = GithubLoopxIntakeMetadataProvider::new().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("90"));

        let block = provider
            .record_rate_headers(StatusCode::FORBIDDEN, &headers, "authenticated:account-a")
            .await
            .expect("retry-after should create a local block");
        assert!(block.message.contains("secondary API rate limit"));
        assert!(block.message.contains("90 seconds"));
    }

    #[tokio::test]
    async fn response_cache_keeps_value_and_etag_for_conditional_requests() {
        let provider = GithubLoopxIntakeMetadataProvider::new().unwrap();
        let value = serde_json::json!({"number": 42, "state": "open"});
        provider
            .store_response(
                "authenticated:account-a",
                "/repos/owner/repo/issues/42",
                value.clone(),
                Some("\"etag-42\"".to_string()),
            )
            .await;

        let cached = provider
            .cached_response("authenticated:account-a", "/repos/owner/repo/issues/42")
            .await
            .unwrap();
        assert_eq!(cached.value, value);
        assert_eq!(cached.etag.as_deref(), Some("\"etag-42\""));
        assert!(cached.stored_at.elapsed() < RESPONSE_CACHE_TTL);
        assert!(provider
            .cached_response("authenticated:account-b", "/repos/owner/repo/issues/42")
            .await
            .is_none());
    }

    #[test]
    fn auth_probe_reports_credential_source_and_anonymous_diagnostics() {
        let snapshot = RateLimitSnapshot {
            credential_scope: "authenticated:account-a".to_string(),
            limit: Some(5000),
            remaining: Some(4999),
            reset_at: None,
            observed_at: Instant::now(),
        };
        let authenticated = build_github_auth_probe(
            &GithubCredential {
                token: Some("secret-not-rendered".to_string()),
                source: Some("GitHub CLI"),
                detail: String::new(),
            },
            Some(&snapshot),
            None,
        );
        assert!(authenticated.authenticated);
        assert!(authenticated
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("via GitHub CLI")));
        assert!(!authenticated
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("secret-not-rendered"));

        let anonymous = build_github_auth_probe(
            &GithubCredential {
                token: None,
                source: None,
                detail: "GitHub CLI is not authenticated".to_string(),
            },
            Some(&RateLimitSnapshot {
                credential_scope: "anonymous".to_string(),
                limit: Some(60),
                remaining: Some(12),
                reset_at: None,
                observed_at: Instant::now(),
            }),
            None,
        );
        assert!(!anonymous.authenticated);
        assert!(anonymous
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("12 of 60")));
    }
}
