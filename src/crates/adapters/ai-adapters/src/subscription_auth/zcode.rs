//! ZCode browser authorization for Z.ai and BigModel GLM Coding Plans.
//! Mirrors magpie's cli/init -> cli/poll -> business login -> project key flow.
//! Start/gift plans are distinct products and never receive a Coding Plan call.
use super::browser_poll::{self as api, integer, required, text};
use super::device_flow::{poll_device_code, DevicePoll};
use super::{
    store, ResolvedCredential, StartedLogin, StoredCredential, SubscriptionHttpOptions,
    SubscriptionProvider,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio_util::sync::CancellationToken;

const ZCODE: &str = "https://zcode.z.ai";
const VERSION: &str = "3.14.3";

fn site(provider: SubscriptionProvider) -> &'static str {
    match provider {
        SubscriptionProvider::Zcode => "zai",
        SubscriptionProvider::ZcodeCn => "bigmodel",
        _ => unreachable!("ZCode provider required"),
    }
}
fn business_root(provider: SubscriptionProvider) -> &'static str {
    match provider {
        SubscriptionProvider::Zcode => "https://api.z.ai",
        SubscriptionProvider::ZcodeCn => "https://bigmodel.cn",
        _ => unreachable!("ZCode provider required"),
    }
}
pub(super) fn suggested(
    provider: SubscriptionProvider,
) -> (&'static str, &'static str, &'static str) {
    match provider {
        SubscriptionProvider::Zcode => (
            "anthropic",
            "https://api.z.ai/api/anthropic",
            "GLM-5.3-Flash",
        ),
        SubscriptionProvider::ZcodeCn => (
            "anthropic",
            "https://open.bigmodel.cn/api/anthropic",
            "GLM-5.3-Flash",
        ),
        _ => unreachable!("ZCode provider required"),
    }
}
fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header("User-Agent", format!("ZCode/{VERSION}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
}

// Retry only a transient failure before an origin connection was established.
// A response, TLS validation failure, or ambiguous POST send is not replayed.
fn transient_connection_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .is_some_and(reqwest::Error::is_connect)
    }) && error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::TimedOut
            )
        })
    })
}

async fn initialize_with_retry<F, Fut>(mut initialize: F) -> Result<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    for delay in [250, 750] {
        match initialize().await {
            Err(error) if transient_connection_error(&error) => {
                log::debug!(
                    "Retrying ZCode login initialization after a transient connection failure"
                );
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            result => return result,
        }
    }
    initialize().await
}

pub(super) fn inference_url(provider: SubscriptionProvider) -> &'static str {
    match provider {
        SubscriptionProvider::Zcode => "https://api.z.ai/api/anthropic/v1/messages",
        SubscriptionProvider::ZcodeCn => "https://open.bigmodel.cn/api/anthropic/v1/messages",
        _ => unreachable!("ZCode provider required"),
    }
}
fn team_headers(
    builder: reqwest::RequestBuilder,
    org: &str,
    project: &str,
) -> reqwest::RequestBuilder {
    builder
        .header("Bigmodel-Organization", org)
        .header("Bigmodel-Project", project)
}

/// The key is scoped to the selected project, reusing ZCode's existing named
/// key before creating one. Business-session tokens are never persisted.
async fn project_key(
    client: &reqwest::Client,
    provider: SubscriptionProvider,
    auth: &str,
    org: &str,
    project: &str,
    team: bool,
) -> Result<String> {
    let mut url = reqwest::Url::parse(business_root(provider))?;
    url.path_segments_mut()
        .map_err(|_| anyhow!("Invalid ZCode business root"))?
        .extend([
            "api",
            "biz",
            "v1",
            "organization",
            org,
            "projects",
            project,
            "api_keys",
        ]);
    let list = api::data(
        team_headers(
            request(client, reqwest::Method::GET, url.as_str()).header("Authorization", auth),
            org,
            project,
        ),
        true,
    )
    .await?;
    let name = if team {
        "zcode-team-api-key"
    } else {
        "zcode-api-key"
    };
    let mut id = list
        .as_array()
        .and_then(|keys| {
            keys.iter()
                .find(|key| text(key, "name") == name && (!team || integer(&key["keyType"]) == 2))
        })
        .map(|k| text(k, "apiKey"))
        .unwrap_or("")
        .to_owned();
    if id.is_empty() {
        let body = if team {
            json!({"name":name,"keyType":2})
        } else {
            json!({"name":name})
        };
        let created = api::data(
            team_headers(
                request(client, reqwest::Method::POST, url.as_str()).header("Authorization", auth),
                org,
                project,
            )
            .json(&body),
            true,
        )
        .await?;
        id = required(&created, "apiKey")?.to_owned();
    }
    url.path_segments_mut()
        .map_err(|_| anyhow!("Invalid ZCode key endpoint"))?
        .extend(["copy", &id]);
    let secret = api::data(
        team_headers(
            request(client, reqwest::Method::GET, url.as_str()).header("Authorization", auth),
            org,
            project,
        ),
        true,
    )
    .await?;
    let secret = text(&secret, "secretKey");
    if secret.is_empty() && team {
        return Ok(id);
    }
    if secret.is_empty() {
        return Err(anyhow!(
            "ZCode account did not provide the project key secret"
        ));
    }
    Ok(format!("{id}.{secret}"))
}

fn projects(info: &Value) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let mut organizations: Vec<_> = info["organizations"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    organizations.sort_by_key(|org| !text(org, "organizationName").contains("默认机构"));
    for org in organizations {
        let org_id = text(org, "organizationId");
        if org_id.is_empty() {
            continue;
        }
        let projects: Vec<_> = org["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| !text(p, "projectId").is_empty())
            .collect();
        let personal = projects
            .iter()
            .copied()
            .filter(|p| integer(&p["projectType"]) != 2)
            .find(|p| text(p, "projectName").contains("默认项目"))
            .or_else(|| {
                projects
                    .iter()
                    .copied()
                    .find(|p| integer(&p["projectType"]) != 2)
            });
        if let Some(project) = personal {
            out.push((org_id.into(), text(project, "projectId").into(), false));
        }
        for project in projects
            .into_iter()
            .filter(|p| integer(&p["projectType"]) == 2)
        {
            out.push((org_id.into(), text(project, "projectId").into(), true));
        }
    }
    out
}

async fn paid_credential(
    client: &reqwest::Client,
    provider: SubscriptionProvider,
    got: &Value,
) -> Result<StoredCredential> {
    let token = if provider == SubscriptionProvider::ZcodeCn {
        let value = &got["bigmodel"];
        let token = text(value, "access_token");
        if token.is_empty() {
            required(value, "accessToken")?
        } else {
            token
        }
    } else {
        required(&got["zai"], "access_token")?
    };
    let auth = if provider == SubscriptionProvider::ZcodeCn {
        token.to_owned()
    } else {
        let exchanged = api::data(
            request(
                client,
                reqwest::Method::POST,
                "https://api.z.ai/api/auth/z/login",
            )
            .json(&json!({"token":token})),
            true,
        )
        .await?;
        format!("Bearer {}", required(&exchanged, "access_token")?)
    };
    let info = api::data(
        request(
            client,
            reqwest::Method::GET,
            &format!(
                "{}/api/biz/customer/getCustomerInfo",
                business_root(provider)
            ),
        )
        .header("Authorization", &auth),
        true,
    )
    .await?;
    let account_id = required(&got["user"], "user_id")?.to_owned();
    let display = [
        text(&got["user"], "email"),
        text(&got["user"], "name"),
        account_id.as_str(),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap()
    .to_owned();
    let projects = projects(&info);
    let mut last_error = None;
    // Personal plans precede team seats, matching ZCode's account preference.
    for (org, project, team) in projects
        .iter()
        .filter(|(_, _, team)| !team)
        .chain(projects.iter().filter(|(_, _, team)| *team))
    {
        let candidate = async {
            let selected = if *team {
                let detail = api::data(
                    team_headers(
                        request(
                            client,
                            reqwest::Method::GET,
                            &format!(
                                "{}/api/biz/team/subscribe/product/querySubscribeDetail",
                                business_root(provider)
                            ),
                        )
                        .header("Authorization", &auth),
                        org,
                        project,
                    ),
                    true,
                )
                .await?;
                if detail["hasSubscription"] == false
                    || text(&detail, "status") != "EFFECTIVE"
                    || text(&detail, "memberGrantStatus") != "VALID"
                {
                    return Ok::<_, anyhow::Error>(None);
                }
                (
                    project_key(client, provider, &auth, org, project, true).await?,
                    text(&detail, "productName").to_owned(),
                )
            } else {
                let key = project_key(client, provider, &auth, org, project, false).await?;
                let subs = api::data(
                    request(
                        client,
                        reqwest::Method::GET,
                        &format!(
                            "{}/api/biz/subscription/list",
                            suggested(provider)
                                .1
                                .split("/api/anthropic")
                                .next()
                                .unwrap()
                        ),
                    )
                    .header("Authorization", &key),
                    true,
                )
                .await?;
                let plan = subs.as_array().and_then(|subs| {
                    subs.iter()
                        .find(|s| text(s, "status").eq_ignore_ascii_case("VALID"))
                });
                let Some(plan) = plan else {
                    return Ok::<_, anyhow::Error>(None);
                };
                (key, text(plan, "productName").to_owned())
            };
            Ok::<_, anyhow::Error>(Some(selected))
        }
        .await;
        let (key, plan) = match candidate {
            Ok(Some(candidate)) => candidate,
            Ok(None) => continue,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        return Ok(StoredCredential::Oauth {
            access: key,
            refresh: String::new(),
            expires: i64::MAX,
            account_id: Some(if *team {
                json!([account_id, org, project]).to_string()
            } else {
                account_id
            }),
            metadata: Some(
                json!({"email":display,"site":site(provider),"plan":plan,"organization": if *team {org.as_str()} else {""},"project":if *team {project.as_str()} else {""}}),
            ),
        });
    }
    if let Some(error) = last_error {
        return Err(error.context("Could not verify the ZCode Coding Plan or team seat"));
    }
    Err(anyhow!("No active GLM Coding Plan or assigned team seat was found. This channel requires a Coding Plan; ZCode Start and gift plans are not imported."))
}

pub(super) async fn begin_login_for_account(
    provider: SubscriptionProvider,
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let client = super::build_http_client_with_redirect_policy(
        &options,
        "ZCode",
        reqwest::redirect::Policy::none(),
    )?;
    let poll_auth = format!(
        "Bearer {}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let device = uuid::Uuid::new_v4().to_string();
    let flow = initialize_with_retry(|| {
        api::data(
            request(
                &client,
                reqwest::Method::POST,
                &format!("{ZCODE}/api/v1/oauth/cli/init"),
            )
            .header("Authorization", &poll_auth)
            .header("X-Device-Mid", &device)
            .json(&json!({"provider":site(provider)})),
            true,
        )
    })
    .await?;
    let flow_id = required(&flow, "flow_id")?.to_owned();
    let mut url = api::authorization_url(required(&flow, "authorize_url")?)?;
    let mut back = reqwest::Url::parse(&format!("{ZCODE}/app/oauth/login"))?;
    back.query_pairs_mut()
        .append_pair("redirect", "zcode://oauth/callback")
        .append_pair("app_version", VERSION);
    api::set_query(
        &mut url,
        if provider == SubscriptionProvider::ZcodeCn {
            "redirect"
        } else {
            "redirect_uri"
        },
        back.as_str(),
    );
    let interval = integer(&flow["poll_interval_sec"]).clamp(1, 30) as u64;
    let expires = integer(&flow["expires_at"]);
    let lifetime = if expires > 0 {
        (expires - chrono::Utc::now().timestamp()).clamp(1, 300) as u64
    } else {
        300
    };
    let runner = async move {
        super::authorize_then_persist(
            provider,
            cancel,
            async {
                let mut endpoint = reqwest::Url::parse(ZCODE)?;
                endpoint
                    .path_segments_mut()
                    .map_err(|_| anyhow!("Invalid ZCode root"))?
                    .extend(["api", "v1", "oauth", "cli", "poll", &flow_id]);
                let got = poll_device_code(
                    Duration::from_secs(interval),
                    Duration::from_secs(lifetime),
                    Duration::ZERO,
                    false,
                    || async {
                        let got = match api::data(
                            request(&client, reqwest::Method::GET, endpoint.as_str())
                                .header("Authorization", &poll_auth)
                                .header("X-Device-Mid", &device),
                            true,
                        )
                        .await
                        {
                            Ok(got) => got,
                            Err(error)
                                if error.downcast_ref::<api::ApiError>().is_some_and(|e| {
                                    e.status >= 500 || e.status == 408 || e.status == 429
                                }) || transient_connection_error(&error) =>
                            {
                                return Ok(DevicePoll::Pending)
                            }
                            Err(error) => return Err(error),
                        };
                        match text(&got, "status") {
                            "" | "pending" => Ok(DevicePoll::Pending),
                            "ready" => Ok(DevicePoll::Authorized(got)),
                            "failed" => Err(anyhow!("ZCode authorization was declined")),
                            _ => Err(anyhow!("Unexpected ZCode authorization state")),
                        }
                    },
                )
                .await?;
                paid_credential(&client, provider, &got).await
            },
            move |credential| async move {
                let outcome = super::accounts::persist_account_credential(
                    provider,
                    &slot,
                    expected_revision,
                    credential,
                )
                .await?;
                super::require_current_store_revision(provider, outcome).map(|_| ())
            },
        )
        .await
    };
    Ok(StartedLogin {method:super::SubscriptionLoginMethod::Device,authorization_url:url.into(),user_code:None,instructions:"Sign in to your GLM Coding Plan account in the browser, then return to OpenBitFun. The selected project's ZCode API key will be reused or created automatically.".into(),runner:Box::pin(runner)})
}

pub(super) async fn resolve(
    provider: SubscriptionProvider,
    slot: &str,
    _options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let credential = store::load_entry(slot)
        .await?
        .ok_or_else(|| anyhow!("ZCode is not connected; sign in first"))?;
    let StoredCredential::Oauth {
        access,
        metadata: Some(metadata),
        ..
    } = credential
    else {
        return Err(anyhow!("Invalid ZCode credential; sign in again"));
    };
    if access.trim().is_empty() || text(&metadata, "site") != site(provider) {
        return Err(anyhow!(
            "ZCode credential does not match the selected region; sign in again"
        ));
    }
    let (_, base, _) = suggested(provider);
    let mut headers = HashMap::from([
        ("Authorization".into(), format!("Bearer {access}")),
        ("x-api-key".into(), access.clone()),
    ]);
    for (field, header) in [
        ("organization", "Bigmodel-Organization"),
        ("project", "Bigmodel-Project"),
    ] {
        if !text(&metadata, field).is_empty() {
            headers.insert(header.into(), text(&metadata, field).into());
        }
    }
    Ok(ResolvedCredential {
        api_key: access,
        base_url: Some(base.into()),
        request_url: Some(inference_url(provider).into()),
        format: Some("anthropic".into()),
        extra_headers: headers,
        expires_at: None,
    })
}

pub(super) async fn recover(
    _provider: SubscriptionProvider,
    _slot: &str,
    _rejected: &str,
    _options: &SubscriptionHttpOptions,
) -> Result<()> {
    Err(anyhow!("ZCode rejected the Coding Plan key; sign in again to verify the account and project. The existing account has been preserved."))
}

pub(crate) async fn list_models(
    client: &crate::client::AIClient,
    provider: SubscriptionProvider,
) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let platform = format!(
        "{}-{}",
        match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        },
        match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        }
    );
    let mut url = reqwest::Url::parse(&format!("{ZCODE}/api/v1/client/configs"))?;
    url.query_pairs_mut()
        .append_pair("app_version", VERSION)
        .append_pair("platform", &platform);
    let config = api::data(
        request(&client.client, reqwest::Method::GET, url.as_str())
            .header("X-Device-Mid", uuid::Uuid::new_v4().to_string()),
        true,
    )
    .await?;
    let url = api::authorization_url(required(
        &config["configs"],
        "builtin_provider_config_json",
    )?)?;
    // Public config download carries no account or API-key headers.
    let cfg: Value = client
        .client
        .get(url)
        .header("User-Agent", format!("ZCode/{VERSION}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    parse_models(&cfg, provider)
}

fn parse_models(
    cfg: &Value,
    provider: SubscriptionProvider,
) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let plan = if provider == SubscriptionProvider::ZcodeCn {
        "account:bigmodel-individual-coding-plan"
    } else {
        "account:zai-individual-coding-plan"
    };
    let mut ids = std::collections::BTreeSet::new();
    for rule in cfg["config"]["providerConfigRules"]["providerRules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| text(r, "providerId") == plan)
    {
        for id in rule["builtinModelIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            ids.insert(id.to_owned());
        }
    }
    let rules = cfg["config"]["modelConfigRules"]["builtinProviderModelRules"].as_array();
    for rule in rules
        .into_iter()
        .flatten()
        .filter(|r| text(r, "providerId") == plan)
    {
        let id = text(rule, "modelId");
        if !id.is_empty() && rule["config"]["enabled"] != false {
            ids.insert(id.into());
        }
    }
    for rule in rules
        .into_iter()
        .flatten()
        .filter(|r| text(r, "providerId") == plan && r["config"]["enabled"] == false)
    {
        ids.retain(|id| !id.eq_ignore_ascii_case(text(rule, "modelId")));
    }
    if ids.is_empty() {
        return Err(anyhow!(
            "ZCode published no models for the selected Coding Plan region"
        ));
    }
    Ok(ids
        .into_iter()
        .map(|id| crate::types::RemoteModelInfo {
            display_name: Some(id.clone()),
            id,
            routing: None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A proxy accepts CONNECT then drops the TLS handshake. No application
    // request reaches an origin, matching the reported Connect/reset failure.
    async fn resetting_proxy() -> (
        reqwest::Client,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let count = connections.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read_exact(&mut byte).await.is_err() {
                        break;
                    }
                    header.push(byte[0]);
                }
                socket
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .unwrap();
                let mut byte = [0];
                let _ = socket.read_exact(&mut byte).await;
            }
        });
        let client = reqwest::Client::builder()
            .tls_backend_rustls()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        (client, connections, task)
    }

    #[tokio::test]
    async fn login_initialization_recovers_from_a_pre_request_connection_reset() {
        let (client, connections, task) = resetting_proxy().await;
        let mut attempts = 0;
        let result = initialize_with_retry(|| {
            attempts += 1;
            let first = attempts == 1;
            let client = &client;
            async move {
                if first {
                    api::data(client.post("https://zcode.invalid/cli/init"), true).await
                } else {
                    Ok(json!({"flow_id":"synthetic-flow"}))
                }
            }
        })
        .await;
        task.abort();
        assert_eq!(result.unwrap()["flow_id"], "synthetic-flow");
        assert_eq!(attempts, 2);
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn login_initialization_bounds_connection_retries() {
        let (client, connections, task) = resetting_proxy().await;
        let result = initialize_with_retry(|| {
            api::data(client.post("https://zcode.invalid/cli/init"), true)
        })
        .await;
        task.abort();
        assert!(transient_connection_error(&result.unwrap_err()));
        assert_eq!(connections.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn login_initialization_does_not_retry_api_rejections() {
        let mut attempts = 0;
        let error = initialize_with_retry(|| {
            attempts += 1;
            std::future::ready(Err(api::ApiError {
                status: 403,
                code: 401,
            }
            .into()))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(error.downcast_ref::<api::ApiError>().unwrap().status, 403);
    }

    #[tokio::test]
    async fn login_initialization_does_not_replay_an_ambiguous_post() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            // The POST might already have been processed before disconnecting.
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut attempts = 0;
        let error = initialize_with_retry(|| {
            attempts += 1;
            api::data(
                client
                    .post(format!("http://{address}/init"))
                    .json(&json!({"provider":"bigmodel"})),
                true,
            )
        })
        .await
        .unwrap_err();
        server.await.unwrap();
        assert!(!transient_connection_error(&error));
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    #[ignore = "Creates short-lived ZCode authorization flows; never polls, authorizes, or stores an account"]
    async fn live_browser_authorization_init() {
        let proxy = std::env::var("OPENBITFUN_LIVE_SUBSCRIPTION_PROXY")
            .ok()
            .map(|url| crate::types::ProxyConfig {
                enabled: true,
                url,
                username: None,
                password: None,
            });
        for provider in [SubscriptionProvider::Zcode, SubscriptionProvider::ZcodeCn] {
            let started = begin_login_for_account(
                provider,
                format!("{}-account-{}", provider.key(), uuid::Uuid::new_v4()),
                CancellationToken::new(),
                0,
                SubscriptionHttpOptions::new(proxy.clone(), false),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error:#}", provider.key()));
            println!("{}: authorization initialization accepted", provider.key());
            drop(started);
        }
    }

    #[tokio::test]
    #[ignore = "Reads the real public ZCode catalogs; no account or inference credentials are used"]
    async fn live_public_coding_catalogs() {
        let proxy = std::env::var("OPENBITFUN_LIVE_SUBSCRIPTION_PROXY")
            .ok()
            .map(|url| crate::types::ProxyConfig {
                enabled: true,
                url,
                username: None,
                password: None,
            });
        for provider in [SubscriptionProvider::Zcode, SubscriptionProvider::ZcodeCn] {
            let (_, base, model) = suggested(provider);
            let config=serde_json::from_value(json!({"name":"public-catalog-probe","model":model,"format":"anthropic","base_url":base,"request_url":inference_url(provider),"api_key":"","context_window":4096,"inline_think_in_text":false,"skip_ssl_verify":false})).unwrap();
            let client = crate::AIClient::new_with_proxy(config, proxy.clone());
            let models = list_models(&client, provider).await.unwrap();
            assert!(!models.is_empty());
            println!(
                "{}: live public catalog models={:?}",
                provider.key(),
                models.into_iter().map(|m| m.id).collect::<Vec<_>>()
            );
        }
    }
    #[tokio::test]
    async fn saved_coding_key_is_bound_to_its_region_and_never_needs_oauth_refresh() {
        let _guard = super::super::tests::test_lock().lock().await;
        let dir =
            std::env::temp_dir().join(format!("openbitfun-zcode-test-{}", uuid::Uuid::new_v4()));
        store::set_store_path_for_test(dir.join("metadata.json"));
        for provider in [SubscriptionProvider::Zcode, SubscriptionProvider::ZcodeCn] {
            let slot = format!("{}-account-{}", provider.key(), uuid::Uuid::new_v4());
            let credential = StoredCredential::Oauth {
                access: "synthetic.key".into(),
                refresh: String::new(),
                expires: i64::MAX,
                account_id: Some("fixture-user".into()),
                metadata: Some(json!({"site":site(provider),"email":"fixture@example.invalid"})),
            };
            super::super::accounts::persist_account_credential(provider, &slot, 0, credential)
                .await
                .unwrap();
            let resolved = resolve(provider, &slot, &Default::default()).await.unwrap();
            assert_eq!(
                resolved.extra_headers["Authorization"],
                "Bearer synthetic.key"
            );
            assert_eq!(resolved.extra_headers["x-api-key"], "synthetic.key");
            assert!(resolved.expires_at.is_none());
            assert!(super::super::accounts::account_snapshot(provider, &slot)
                .await
                .unwrap()
                .expires_at
                .is_none());
            let other = if provider == SubscriptionProvider::Zcode {
                SubscriptionProvider::ZcodeCn
            } else {
                SubscriptionProvider::Zcode
            };
            assert!(resolve(other, &slot, &Default::default()).await.is_err());
            super::super::logout_account(provider, &slot).await.unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn model_catalog_is_region_scoped_and_keeps_wire_ids() {
        let cfg = json!({"config":{"providerConfigRules":{"providerRules":[{"providerId":"account:zai-individual-coding-plan","builtinModelIds":["GLM-5.3","GLM-5.2"]},{"providerId":"account:bigmodel-individual-coding-plan","builtinModelIds":["GLM-5.3-Flash"]}]},"modelConfigRules":{"builtinProviderModelRules":[{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.2","config":{"enabled":false}}]}}});
        assert_eq!(
            parse_models(&cfg, SubscriptionProvider::Zcode).unwrap()[0].id,
            "GLM-5.3"
        );
        assert_eq!(
            parse_models(&cfg, SubscriptionProvider::ZcodeCn).unwrap()[0].id,
            "GLM-5.3-Flash"
        );
        assert!(parse_models(&json!({}), SubscriptionProvider::Zcode).is_err());
    }
    #[test]
    fn routing_uses_pinned_inference_hosts() {
        assert_eq!(
            suggested(SubscriptionProvider::Zcode).1,
            "https://api.z.ai/api/anthropic"
        );
        assert_eq!(
            suggested(SubscriptionProvider::ZcodeCn).1,
            "https://open.bigmodel.cn/api/anthropic"
        );
        assert_eq!(
            projects(
                &json!({"organizations":[{"organizationId":"org","projects":[{"projectId":"personal","projectType":1},{"projectId":"team","projectType":"2"}]}]})
            ),
            vec![
                ("org".into(), "personal".into(), false),
                ("org".into(), "team".into(), true)
            ]
        );
    }
}
