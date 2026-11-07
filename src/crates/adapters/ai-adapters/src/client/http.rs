use crate::client::AIClient;
use crate::types::ProxyConfig;
use anyhow::{anyhow, Result};
use log::{debug, error, info, warn};
use openbitfun_services_core::system_proxy::SystemProxy;
use reqwest::{Client, ClientBuilder, Proxy};

/// Router requests use the shared proxy policy with their own total timeout.
pub(crate) fn create_router_http_client(
    timeout: std::time::Duration,
    proxy_config: Option<ProxyConfig>,
    skip_ssl_verify: bool,
) -> Result<Client> {
    create_router_http_client_with_connection_mode(timeout, proxy_config, skip_ssl_verify, false)
}

/// Only explicit local classifier profiles opt into a direct loopback connection.
/// Other Router and model traffic keeps the existing shared proxy policy.
pub(crate) fn create_router_http_client_with_connection_mode(
    timeout: std::time::Duration,
    proxy_config: Option<ProxyConfig>,
    skip_ssl_verify: bool,
    direct: bool,
) -> Result<Client> {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    let builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(skip_ssl_verify);
    let builder = if direct {
        builder.no_proxy()
    } else {
        apply_proxy_policy(builder, proxy_config)
    };
    Ok(builder.build()?)
}

pub(crate) fn create_http_client(
    proxy_config: Option<ProxyConfig>,
    skip_ssl_verify: bool,
) -> Client {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    let mut builder = Client::builder()
        .tls_backend_rustls()
        .connect_timeout(std::time::Duration::from_secs(
            AIClient::STREAM_CONNECT_TIMEOUT_SECS,
        ))
        .user_agent("OpenBitFun/1.0")
        .pool_idle_timeout(std::time::Duration::from_secs(
            AIClient::HTTP_POOL_IDLE_TIMEOUT_SECS,
        ))
        .pool_max_idle_per_host(4)
        .tcp_keepalive(Some(std::time::Duration::from_secs(
            AIClient::HTTP_TCP_KEEPALIVE_SECS,
        )))
        .danger_accept_invalid_certs(skip_ssl_verify);

    if skip_ssl_verify {
        warn!(
            "SSL certificate verification disabled - security risk, use only in test environments"
        );
    }

    builder = apply_proxy_policy(builder, proxy_config.clone());

    match builder.build() {
        Ok(client) => client,
        Err(e) => {
            error!(
                "HTTP client initialization failed: {}, using default transport options",
                e
            );
            apply_proxy_policy(Client::builder(), proxy_config)
                .build()
                .expect("Failed to initialize HTTP client with configured proxy policy")
        }
    }
}

/// Missing or disabled app proxy settings retain the legacy direct connection.
/// Only an enabled proxy may select a manual address or, when its address is
/// empty, inherit operating system / environment settings.
fn apply_proxy_policy(builder: ClientBuilder, proxy_config: Option<ProxyConfig>) -> ClientBuilder {
    apply_proxy_policy_with_system_proxy(
        builder,
        proxy_config,
        openbitfun_services_core::system_proxy::detect,
    )
}

fn apply_proxy_policy_with_system_proxy(
    builder: ClientBuilder,
    proxy_config: Option<ProxyConfig>,
    detect: impl FnOnce() -> Option<SystemProxy>,
) -> ClientBuilder {
    let Some(proxy_cfg) = proxy_config.filter(|config| config.enabled) else {
        return builder.no_proxy();
    };

    if !proxy_cfg.url.trim().is_empty() {
        return match build_proxy(&proxy_cfg) {
            Ok(proxy) => {
                info!("Using proxy: {}", proxy_cfg.url);
                builder.proxy(proxy)
            }
            Err(e) => {
                error!(
                    "Proxy configuration failed: {}, proceeding without proxy",
                    e
                );
                builder.no_proxy()
            }
        };
    }

    match detect() {
        Some(system) => match system_proxy(&system) {
            Some(proxy) => {
                info!("Using operating system proxy: {}", system.url);
                builder.proxy(proxy)
            }
            None => {
                warn!(
                    "Operating system proxy {} could not be applied, connecting directly",
                    system.url
                );
                builder.no_proxy()
            }
        },
        None => builder,
    }
}

/// Build a reqwest proxy from an operating system setting.
///
/// Loopback targets always bypass the proxy so local model servers keep working.
fn system_proxy(system: &SystemProxy) -> Option<Proxy> {
    // Validate eagerly, then use the Windows matcher rather than translating
    // wildcard / <local> rules into reqwest's narrower NoProxy syntax.
    Proxy::all(&system.url).ok()?;
    let system = system.clone();
    Some(Proxy::custom(move |url| {
        let host = url.host_str()?;
        (!system.bypasses_host(host)).then(|| system.url.clone())
    }))
}

pub(crate) fn build_proxy(config: &ProxyConfig) -> Result<Proxy> {
    let proxy_url = normalize_proxy_url(&config.url);
    let mut proxy = Proxy::all(&proxy_url).map_err(|e| anyhow!("Failed to create proxy: {}", e))?;

    if let (Some(username), Some(password)) = (&config.username, &config.password) {
        if !username.is_empty() && !password.is_empty() {
            proxy = proxy.basic_auth(username, password);
            debug!("Proxy authentication configured for user: {}", username);
        }
    }

    Ok(proxy)
}

fn normalize_proxy_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_proxy_policy_with_system_proxy, build_proxy, normalize_proxy_url, system_proxy,
    };
    use crate::types::ProxyConfig;
    use openbitfun_services_core::system_proxy::SystemProxy;

    async fn response_fixture(body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        let app = axum::Router::new().fallback(move || async move { body });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, server)
    }

    #[tokio::test]
    async fn system_proxy_preserves_loopback_bypass_and_proxies_other_hosts() {
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let (direct_url, direct_server) = response_fixture("direct").await;
        let (proxy_url, proxy_server) = response_fixture("system proxy").await;
        let proxy = system_proxy(&SystemProxy {
            url: proxy_url,
            no_proxy: Some("localhost,127.0.0.1,::1".into()),
        })
        .unwrap();
        let client = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();

        for url in [
            direct_url.clone(),
            direct_url.replace("127.0.0.1", "localhost"),
        ] {
            assert_eq!(
                client.get(url).send().await.unwrap().text().await.unwrap(),
                "direct"
            );
        }
        assert_eq!(
            client
                .get("http://router-proxy-fixture.invalid/probe")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "system proxy"
        );
        direct_server.abort();
        proxy_server.abort();
    }

    #[tokio::test]
    async fn legacy_proxy_payloads_round_trip_and_connect_directly_without_system_detection() {
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let (direct_url, direct_server) = response_fixture("direct").await;
        let address = direct_url.strip_prefix("http://").unwrap().parse().unwrap();
        let target = direct_url.replace("127.0.0.1", "legacy-model.corp.internal");
        let mut configs = vec![None];
        for payload in [
            serde_json::json!({}),
            serde_json::json!({"enabled": false}),
            serde_json::json!({"enabled": false, "url": ""}),
            serde_json::json!({"enabled": false, "url": "  "}),
            serde_json::json!({
                "enabled": false,
                "url": "http://unused-proxy.invalid:7897",
                "username": "saved-user",
                "password": "saved-password"
            }),
        ] {
            let config: ProxyConfig = serde_json::from_value(payload.clone()).unwrap();
            let stored = serde_json::to_value(&config).unwrap();
            for (key, value) in payload.as_object().unwrap() {
                assert_eq!(&stored[key], value, "legacy field {key} changed");
            }
            configs.push(Some(serde_json::from_value(stored).unwrap()));
        }
        for config in configs {
            let builder = reqwest::Client::builder()
                .resolve("legacy-model.corp.internal", address)
                .timeout(std::time::Duration::from_secs(3));
            let client = apply_proxy_policy_with_system_proxy(builder, config, || {
                panic!("legacy direct settings must not inspect the system proxy")
            })
            .build()
            .unwrap();
            assert_eq!(
                client
                    .get(&target)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "direct"
            );
        }
        direct_server.abort();
    }

    #[tokio::test]
    async fn system_proxy_routes_windows_wildcards_and_local_marker_without_bypassing_public_hosts()
    {
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let (direct_url, direct_server) = response_fixture("direct").await;
        let (proxy_url, proxy_server) = response_fixture("system proxy").await;
        let address = direct_url.strip_prefix("http://").unwrap().parse().unwrap();
        let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3));
        for host in ["model.corp.internal", "intranet", "exact.internal"] {
            builder = builder.resolve(host, address);
        }
        let client = apply_proxy_policy_with_system_proxy(
            builder,
            Some(ProxyConfig {
                enabled: true,
                ..Default::default()
            }),
            || {
                Some(SystemProxy {
                    url: proxy_url,
                    no_proxy: Some("*.corp.internal,<local>,exact.internal".into()),
                })
            },
        )
        .build()
        .unwrap();
        for (host, expected) in [
            ("model.corp.internal", "direct"),
            ("intranet", "direct"),
            ("exact.internal", "direct"),
            ("public.example", "system proxy"),
            ("corp.internal", "system proxy"),
            ("child.exact.internal", "system proxy"),
            ("model.corp.internal.attacker.example", "system proxy"),
        ] {
            let target = direct_url.replace("127.0.0.1", host);
            assert_eq!(
                client
                    .get(target)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                expected,
                "unexpected route for {host}"
            );
        }
        direct_server.abort();
        proxy_server.abort();
    }

    #[tokio::test]
    async fn router_client_keeps_its_total_timeout_and_rejects_redirects() {
        use axum::{http::StatusCode, response::Redirect, routing::get};
        use std::time::Duration;

        let app = axum::Router::new()
            .route(
                "/redirect",
                get(|| async { Redirect::temporary("/target") }),
            )
            .route("/target", get(|| async { "redirect target" }))
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    "delayed body"
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = super::create_router_http_client(
            Duration::from_millis(50),
            Some(ProxyConfig {
                enabled: false,
                url: "http://unused-proxy.invalid".into(),
                ..Default::default()
            }),
            false,
        )
        .unwrap();
        assert_eq!(
            client
                .get(format!("{url}/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::TEMPORARY_REDIRECT
        );
        assert!(client
            .get(format!("{url}/slow"))
            .send()
            .await
            .unwrap_err()
            .is_timeout());
        server.abort();
    }

    // A separate process keeps reqwest's environment cache and proxy variables
    // isolated from concurrent tests. The existing auth feature supplies the
    // platform-safe process helper without adding a production dependency.
    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn router_proxy_policy_preserves_environment_explicit_and_disabled_routes() {
        use super::create_router_http_client;
        use openbitfun_services_core::process_manager::create_tokio_command;
        use std::time::Duration;

        const CHILD: &str = "OPENBITFUN_HTTP_PROXY_FIXTURE_CHILD";
        const DIRECT_URL: &str = "OPENBITFUN_HTTP_PROXY_FIXTURE_DIRECT";
        const EXPLICIT_PROXY: &str = "OPENBITFUN_HTTP_PROXY_FIXTURE_EXPLICIT";
        const TEST_NAME: &str = "client::http::tests::router_proxy_policy_preserves_environment_explicit_and_disabled_routes";

        if std::env::var(CHILD).as_deref() == Ok("1") {
            let direct_url = std::env::var(DIRECT_URL).unwrap();
            let explicit_proxy = std::env::var(EXPLICIT_PROXY).unwrap();
            for config in [
                None,
                Some(ProxyConfig::default()),
                Some(ProxyConfig {
                    enabled: false,
                    url: explicit_proxy.clone(),
                    ..Default::default()
                }),
            ] {
                for client in [
                    super::create_http_client(config.clone(), false),
                    create_router_http_client(Duration::from_secs(3), config, false).unwrap(),
                ] {
                    assert_eq!(
                        client
                            .get(&direct_url)
                            .send()
                            .await
                            .unwrap()
                            .text()
                            .await
                            .unwrap(),
                        "direct"
                    );
                }
            }

            // An enabled proxy with no address retains inheritance. Inject the
            // absence of an OS proxy so this fixture is independent of the
            // Windows machine's actual registry configuration.
            for url in ["", "  "] {
                let client = apply_proxy_policy_with_system_proxy(
                    reqwest::Client::builder().timeout(Duration::from_secs(3)),
                    Some(ProxyConfig {
                        enabled: true,
                        url: url.into(),
                        ..Default::default()
                    }),
                    || None,
                )
                .build()
                .unwrap();
                assert_eq!(
                    client
                        .get("http://router-proxy-fixture.invalid/probe")
                        .send()
                        .await
                        .unwrap()
                        .text()
                        .await
                        .unwrap(),
                    "environment proxy"
                );
            }

            // Explicit app proxy settings also take priority for loopback URLs.
            for (enabled, expected) in [(true, "explicit proxy"), (false, "direct")] {
                let client = create_router_http_client(
                    Duration::from_secs(3),
                    Some(ProxyConfig {
                        enabled,
                        url: explicit_proxy.clone(),
                        ..Default::default()
                    }),
                    false,
                )
                .unwrap();
                assert_eq!(
                    client
                        .get(&direct_url)
                        .send()
                        .await
                        .unwrap()
                        .text()
                        .await
                        .unwrap(),
                    expected
                );
            }
            return;
        }

        let (direct_url, direct_server) = response_fixture("direct").await;
        let (environment_proxy, environment_server) = response_fixture("environment proxy").await;
        let (explicit_proxy, explicit_server) = response_fixture("explicit proxy").await;
        let mut child = create_tokio_command(std::env::current_exe().unwrap());
        child.args(["--exact", TEST_NAME, "--nocapture"]);
        for key in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            child.env_remove(key);
        }
        let output = tokio::time::timeout(
            Duration::from_secs(20),
            child
                .env(CHILD, "1")
                .env(DIRECT_URL, direct_url)
                .env(EXPLICIT_PROXY, explicit_proxy)
                .env("HTTP_PROXY", &environment_proxy)
                .env("HTTPS_PROXY", &environment_proxy)
                .env("ALL_PROXY", &environment_proxy)
                .env("NO_PROXY", "")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("isolated proxy test timed out")
        .unwrap();
        direct_server.abort();
        environment_server.abort();
        explicit_server.abort();
        assert!(
            output.status.success(),
            "isolated proxy test failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    #[test]
    fn normalizes_bare_host_and_port_to_http_proxy_url() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7897"),
            "http://127.0.0.1:7897"
        );
    }

    #[test]
    fn preserves_explicit_proxy_scheme() {
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:1080"),
            "socks5://127.0.0.1:1080"
        );
    }

    #[test]
    fn accepts_bare_host_and_port_proxy_configuration() {
        let config = ProxyConfig {
            enabled: true,
            url: "127.0.0.1:7897".to_string(),
            username: None,
            password: None,
        };

        assert!(build_proxy(&config).is_ok());
    }

    #[test]
    fn accepts_explicit_socks5_proxy_configuration() {
        let config = ProxyConfig {
            enabled: true,
            url: "socks5://127.0.0.1:1080".to_string(),
            username: None,
            password: None,
        };

        assert!(build_proxy(&config).is_ok());
    }
}
