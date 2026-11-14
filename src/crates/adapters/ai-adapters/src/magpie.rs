//! Magpie identity and catalog protocol. Runs on the inference host; never infers.
use crate::{
    client::http::{create_router_http_client_with_connection_mode, is_loopback_url},
    ProxyConfig,
};
use openbitfun_core_types::magpie::{
    MagpieModel, MagpieProbeRequest, MagpieProbeResult, MagpieProbeStatus,
};
use reqwest::{Client, Response, Url};
use serde::Deserialize;
use std::time::Duration;

const BODY_LIMIT: usize = 2 * 1024 * 1024;

fn gateway_root(address: &str) -> Option<Url> {
    let mut url = Url::parse(address.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let root = path.strip_suffix("/v1").unwrap_or(path).to_string();
    url.set_path(&format!("{root}/"));
    Some(url)
}

async fn json_body<T: serde::de::DeserializeOwned>(mut response: Response) -> Option<T> {
    if response
        .content_length()
        .is_some_and(|size| size > BODY_LIMIT as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > BODY_LIMIT {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

/// Read-only discovery with bounded requests, no redirects and no error-body echo.
pub async fn probe(request: MagpieProbeRequest, proxy: Option<ProxyConfig>) -> MagpieProbeResult {
    let Some(root) = gateway_root(&request.base_url) else {
        return MagpieProbeResult {
            status: MagpieProbeStatus::InvalidAddress,
            base_url: String::new(),
            version: None,
            models: vec![],
        };
    };
    let mut result = MagpieProbeResult {
        status: MagpieProbeStatus::Unreachable,
        base_url: root.join("v1").expect("valid relative URL").to_string(),
        version: None,
        models: vec![],
    };
    let Ok(client) = create_router_http_client_with_connection_mode(
        Duration::from_secs(8),
        proxy,
        false,
        is_loopback_url(root.as_str()),
    ) else {
        return result;
    };
    let key = if request.api_key.trim().is_empty() {
        "magpie-openbitfun"
    } else {
        request.api_key.trim()
    };
    if key.contains(['\r', '\n']) {
        result.status = MagpieProbeStatus::AccessDenied;
        return result;
    }
    match tokio::time::timeout(
        Duration::from_secs(12),
        probe_with_client(&client, &root, key, &mut result),
    )
    .await
    {
        Ok(()) => result,
        Err(_) => {
            result.status = if result.status == MagpieProbeStatus::CatalogError {
                MagpieProbeStatus::CatalogError
            } else {
                MagpieProbeStatus::Unreachable
            };
            result
        }
    }
}

async fn probe_with_client(client: &Client, root: &Url, key: &str, result: &mut MagpieProbeResult) {
    let get = |path: &str| {
        client
            .get(root.join(path).expect("valid relative URL"))
            .header(reqwest::header::USER_AGENT, "OpenBitFun/1.0")
            .bearer_auth(key)
    };
    let Ok(response) = get("api/hello").send().await else {
        return;
    };
    if matches!(response.status().as_u16(), 401 | 403) {
        result.status = MagpieProbeStatus::AccessDenied;
        return;
    }
    result.status = MagpieProbeStatus::Unrecognized;
    if !response.status().is_success() {
        return;
    }
    #[derive(Deserialize)]
    struct Hello {
        name: String,
        #[serde(default)]
        version: Option<String>,
    }
    let Some(hello) = json_body::<Hello>(response).await else {
        return;
    };
    if hello.name != "magpie" {
        return;
    }
    result.version = hello.version.filter(|value| value.len() <= 100);
    result.status = MagpieProbeStatus::CatalogError;
    let Ok(response) = get("v1/models").send().await else {
        return;
    };
    if matches!(response.status().as_u16(), 401 | 403) {
        result.status = MagpieProbeStatus::AccessDenied;
        return;
    }
    if !response.status().is_success() {
        return;
    }
    #[derive(Deserialize)]
    struct Catalog {
        data: Vec<MagpieModel>,
    }
    let Some(catalog) = json_body::<Catalog>(response).await else {
        return;
    };
    let mut seen = std::collections::HashSet::new();
    if catalog
        .data
        .iter()
        .any(|model| model.id.trim().is_empty() || model.id.len() > 1024)
    {
        return;
    }
    result.models = catalog
        .data
        .into_iter()
        .filter(|model| seen.insert(model.id.clone()))
        .collect();
    result.status = if result.models.is_empty() {
        MagpieProbeStatus::Empty
    } else {
        MagpieProbeStatus::Ready
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;

    async fn server(
        hello: serde_json::Value,
        status: u16,
        catalog: serde_json::Value,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route("/prefix/api/hello", get(move || async move { Json(hello) }))
            .route(
                "/prefix/v1/models",
                get(move |headers: axum::http::HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer magpie-openbitfun");
                    assert_eq!(headers["user-agent"], "OpenBitFun/1.0");
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(catalog),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/prefix/v1/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, task)
    }

    #[tokio::test]
    async fn identity_catalog_and_failures_are_distinct() {
        for (name, status, body, expected) in [
            ("magpie", 200, json!({"data": []}), MagpieProbeStatus::Empty),
            (
                "other",
                200,
                json!({"data": []}),
                MagpieProbeStatus::Unrecognized,
            ),
            (
                "magpie",
                403,
                json!({"error": "secret"}),
                MagpieProbeStatus::AccessDenied,
            ),
            (
                "magpie",
                200,
                json!({"unexpected": []}),
                MagpieProbeStatus::CatalogError,
            ),
            (
                "magpie",
                200,
                json!({"data":[{"id":"group/work","context_window":12345},{"id":"group/work"}]}),
                MagpieProbeStatus::Ready,
            ),
        ] {
            let (base_url, task) =
                server(json!({"name":name,"version":"test"}), status, body).await;
            let result = probe(
                MagpieProbeRequest {
                    base_url,
                    api_key: String::new(),
                },
                None,
            )
            .await;
            task.abort();
            assert_eq!(result.status, expected);
            assert!(result.base_url.ends_with("/prefix/v1"));
            if expected == MagpieProbeStatus::Ready {
                assert_eq!(result.models.len(), 1);
                assert_eq!(result.models[0].context_window, Some(12345));
            }
            assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
        }
    }

    #[test]
    fn validates_addresses_without_losing_proxy_prefixes() {
        for address in [
            "file:///tmp/key",
            "http://key@localhost",
            "https://host/?key=secret",
            "http://host/#key",
        ] {
            assert!(gateway_root(address).is_none());
        }
        assert_eq!(
            gateway_root("https://host/proxy/v1/").unwrap().as_str(),
            "https://host/proxy/"
        );
    }

    #[tokio::test]
    async fn loopback_gateway_bypasses_configured_proxy() {
        let (base_url, gateway) = server(
            json!({"name":"magpie","version":"test"}),
            200,
            json!({"data":[]}),
        )
        .await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let proxy_hits = hits.clone();
        let proxy = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(move || {
                    proxy_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { axum::http::StatusCode::BAD_GATEWAY }
                }),
            )
            .await
            .unwrap();
        });
        let result = probe(
            MagpieProbeRequest {
                base_url,
                api_key: String::new(),
            },
            Some(ProxyConfig {
                enabled: true,
                url: proxy_url,
                ..Default::default()
            }),
        )
        .await;
        gateway.abort();
        proxy.abort();
        assert_eq!(result.status, MagpieProbeStatus::Empty);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn remote_gateway_keeps_configured_proxy() {
        let (proxy_url, proxy) = server(
            json!({"name":"magpie","version":"proxy"}),
            200,
            json!({"data":[{"id":"fixture-model"}]}),
        )
        .await;
        let result = probe(
            MagpieProbeRequest {
                base_url: "http://remote-magpie.invalid/prefix/v1".into(),
                api_key: String::new(),
            },
            Some(ProxyConfig {
                enabled: true,
                url: proxy_url.replace("/prefix/v1/", ""),
                ..Default::default()
            }),
        )
        .await;
        proxy.abort();
        assert_eq!(result.status, MagpieProbeStatus::Ready);
        assert_eq!(result.models[0].id, "fixture-model");
    }
    #[tokio::test]
    async fn denies_redirects_and_reports_offline_hosts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/api/hello",
            get(|| async {
                axum::response::Redirect::temporary("http://127.0.0.1:1/should-not-receive-key")
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let result = probe(
            MagpieProbeRequest {
                base_url: address.clone(),
                api_key: "fixture-key".into(),
            },
            None,
        )
        .await;
        assert_eq!(result.status, MagpieProbeStatus::Unrecognized);
        task.abort();
        let _ = task.await;
        let result = probe(
            MagpieProbeRequest {
                base_url: address,
                api_key: String::new(),
            },
            None,
        )
        .await;
        assert_eq!(result.status, MagpieProbeStatus::Unreachable);
    }

    #[tokio::test]
    #[ignore = "Reads the local Magpie gateway without inference or disk credentials"]
    async fn live_local_gateway_catalog() {
        let result = probe(
            MagpieProbeRequest {
                base_url: "http://127.0.0.1:3425/v1".into(),
                api_key: String::new(),
            },
            std::env::var("OPENBITFUN_LIVE_MAGPIE_PROXY")
                .ok()
                .map(|url| ProxyConfig {
                    enabled: true,
                    url,
                    ..Default::default()
                }),
        )
        .await;
        println!(
            "Magpie status: {:?}; version: {:?}; model count: {}",
            result.status,
            result.version,
            result.models.len()
        );
        assert!(matches!(
            result.status,
            MagpieProbeStatus::Ready | MagpieProbeStatus::Empty
        ));
    }
}
