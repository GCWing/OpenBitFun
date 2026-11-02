//! Zen free-tier compatibility, scoped to the official public inference APIs.
//! Request shape compared with ZhiAo1120/pi-opencode-zen (2026-10-17).
//! Tool aliases never escape into the runtime contract. Console OAuth and Go
//! keep their own authentication and never enter the anonymous Zen route.

use crate::{client::AIClient, client::StreamResponse};
use anyhow::Result;
use futures::StreamExt;
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use serde_json::{json, Value};
use std::collections::HashMap;

const COMPAT_USER_AGENT: &str = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

pub(super) fn public_endpoint(url: &str) -> bool {
    super::shared::is_https_endpoint(url, "opencode.ai", "/zen")
        && reqwest::Url::parse(url).ok().is_some_and(|url| {
            matches!(
                url.path(),
                "/zen/v1/chat/completions" | "/zen/v1/responses" | "/zen/v1/messages"
            )
        })
}

fn free_model(client: &AIClient, model: &str) -> bool {
    public_endpoint(&client.config.request_url)
        && client.subscription_provider_key().is_none()
        && (model.ends_with("-free")
            || matches!(model, "big-pickle" | "grok-code")
            || crate::opencode_catalog::cached_free_model(
                crate::opencode_catalog::OpenCodePlan::Zen,
                model,
            ))
}

pub(super) fn uses_free_zen(client: &AIClient) -> bool {
    free_model(client, &client.config.model)
}

/// Preserve request-scoped affinity while matching the free endpoint's session
/// layout. Never use a process-wide identity across unrelated conversations.
fn zen_session_id(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let valid = seed.strip_prefix("ses_");
    if valid.is_some_and(|s| {
        let bytes = s.as_bytes();
        bytes.len() == 26
            && bytes[..12]
                .iter()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
            && bytes[9] == b'f'
            && (b'c'..=b'f').contains(&bytes[10])
            && bytes[12..].iter().all(u8::is_ascii_alphanumeric)
    }) {
        return seed.into();
    }
    let digest = Sha256::digest(seed.as_bytes());
    let prefix = hex::encode(&digest[..5]);
    const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let suffix: String = digest[6..20]
        .iter()
        .map(|byte| BASE62[usize::from(*byte) % BASE62.len()] as char)
        .collect();
    format!(
        "ses_{}f{:02x}{suffix}",
        &prefix[..9],
        0xc0 | (digest[5] & 0x3f)
    )
}

pub(super) fn headers(
    client: &AIClient,
    builder: reqwest::RequestBuilder,
    url: &str,
    session: &str,
) -> reqwest::RequestBuilder {
    if !uses_free_zen(client) || !public_endpoint(url) {
        return builder;
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "user-agent",
        reqwest::header::HeaderValue::from_static(COMPAT_USER_AGENT),
    );
    let session = zen_session_id(session)
        .parse::<reqwest::header::HeaderValue>()
        .unwrap();
    headers.insert("x-opencode-session", session.clone());
    headers.insert("x-opencode-session-id", session);
    // x-opencode-request is deliberately absent. Shared custom-header policy
    // also removes saved spellings of this legacy header on this route only.
    let custom_auth = client
        .config
        .custom_headers
        .as_ref()
        .is_some_and(|headers| {
            headers.keys().any(|name| {
                name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("x-api-key")
            })
        });
    if client.config.api_key.trim().is_empty() && !custom_auth {
        if client
            .config
            .format
            .trim()
            .eq_ignore_ascii_case("anthropic")
        {
            headers.insert(
                "x-api-key",
                reqwest::header::HeaderValue::from_static("public"),
            );
        } else {
            headers.insert(
                "authorization",
                reqwest::header::HeaderValue::from_static("Bearer public"),
            );
        }
    }
    builder.headers(headers)
}

#[derive(Default)]
pub(super) struct FreeTools {
    original: HashMap<String, String>,
    stubs: Vec<String>,
}

impl FreeTools {
    /// Run after custom body merging so the compatibility contract describes
    /// the tools actually sent on the wire, including connection-test probes.
    pub(super) fn prepare(client: &AIClient, body: &mut Value) -> Result<Self> {
        let mut mapping = Self::default();
        if !free_model(
            client,
            body["model"].as_str().unwrap_or(&client.config.model),
        ) {
            return Ok(mapping);
        }
        body["stream"] = json!(true);
        if body.get("tools").is_none_or(Value::is_null) {
            body["tools"] = json!([]);
        }
        let tools = body["tools"].as_array_mut().ok_or_else(|| {
            AiProviderError::classified(
                "OpenCode tools must be an array".into(),
                ErrorCategory::InvalidRequest,
            )
        })?;
        for required in ["bash", "read"] {
            let name = |tool: &Value| {
                tool["function"]["name"]
                    .as_str()
                    .or_else(|| tool["name"].as_str())
                    .map(str::to_owned)
            };
            let index = tools
                .iter()
                .position(|tool| name(tool).as_deref() == Some(required))
                .or_else(|| {
                    tools.iter().position(|tool| {
                        name(tool).is_some_and(|n| n.eq_ignore_ascii_case(required))
                    })
                });
            if let Some(index) = index {
                let tool = &mut tools[index];
                let original = name(tool).unwrap();
                if original != required {
                    mapping.original.insert(required.into(), original);
                    if tool.get("function").is_some() {
                        tool["function"]["name"] = json!(required);
                    } else {
                        tool["name"] = json!(required);
                    }
                }
            } else {
                let parameter = if required == "bash" {
                    "command"
                } else {
                    "filePath"
                };
                let schema = json!({"type":"object","properties":{parameter:{"type":"string"}},"required":[parameter]});
                let description = "Unavailable in this session. Do not call this tool.";
                tools.push(match crate::client::format::ApiFormat::parse(&client.config.format)? {
                    crate::client::format::ApiFormat::Anthropic => json!({"name":required,"description":description,"input_schema":schema}),
                    crate::client::format::ApiFormat::OpenAIResponses => json!({"type":"function","name":required,"description":description,"parameters":schema}),
                    _ => json!({"type":"function","function":{"name":required,"description":description,"parameters":schema}}),
                });
                mapping.stubs.push(required.into());
            }
        }
        if !mapping.stubs.is_empty() && body.get("tool_choice").is_none() {
            body["tool_choice"] = json!("auto");
        }
        // Only traverse protocol message containers, never schemas, arguments,
        // user content objects, or opaque provider reasoning/replay state.
        for field in ["messages", "input"] {
            if let Some(messages) = body.get_mut(field).and_then(Value::as_array_mut) {
                for message in messages {
                    mapping.rename_message(message);
                }
            }
        }
        if let Some(choice) = body.get_mut("tool_choice") {
            mapping.rename_name(choice);
            if let Some(function) = choice.get_mut("function") {
                mapping.rename_name(function);
            }
        }
        Ok(mapping)
    }

    fn rename_name(&self, value: &mut Value) {
        if let Some(name) = value["name"].as_str() {
            if let Some((alias, _)) = self.original.iter().find(|(_, original)| *original == name) {
                value["name"] = json!(alias);
            }
        }
    }

    fn rename_message(&self, message: &mut Value) {
        if matches!(message["type"].as_str(), Some("function_call" | "tool_use"))
            || message["role"] == "tool"
        {
            self.rename_name(message);
        }
        if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for call in calls {
                if let Some(function) = call.get_mut("function") {
                    self.rename_name(function);
                }
            }
        }
        if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
            for part in content {
                if part["type"] == "tool_use" {
                    self.rename_name(part);
                }
            }
        }
    }

    pub(super) fn wrap(self, mut response: StreamResponse) -> StreamResponse {
        if self.original.is_empty() && self.stubs.is_empty() {
            return response;
        }
        response.stream = Box::pin(response.stream.scan(false, move |failed, chunk| {
            if *failed { return std::future::ready(None); }
            let result = chunk.and_then(|mut chunk| {
                if let Some(call) = &mut chunk.tool_call {
                    if let Some(name) = &mut call.name {
                        if self.stubs.contains(name) {
                            return Err(AiProviderError::classified(
                                format!("OpenCode requested unavailable compatibility tool '{name}'; enable the corresponding tool for this session"),
                                ErrorCategory::InvalidRequest,
                            ).into());
                        }
                        if let Some(original) = self.original.get(name) { *name = original.clone(); }
                    }
                }
                Ok(chunk)
            });
            *failed = result.is_err();
            std::future::ready(Some(result))
        }));
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        stream::{UnifiedResponse, UnifiedToolCall},
        types::ModelRequestContext,
    };

    fn client(format: &str, model: &str, url: &str) -> AIClient {
        AIClient::new(
            serde_json::from_value(json!({
                "name":"test", "base_url":url, "request_url":url, "api_key":"synthetic",
                "model":model, "format":format, "context_window":4096,
                "inline_think_in_text":false, "skip_ssl_verify":false
            }))
            .unwrap(),
        )
    }

    #[test]
    fn free_zen_headers_replace_custom_values_and_keep_per_request_affinity() {
        use super::super::shared::{
            apply_affinity_headers, apply_header_policy, prepare_request_context,
        };
        for (format, wire) in [
            ("openai", "chat/completions"),
            ("responses", "responses"),
            ("anthropic", "messages"),
        ] {
            let url = format!("https://opencode.ai/zen/v1/{wire}");
            let mut client = client(format, "test-free", &url);
            for mode in ["merge", "replace"] {
                client.config.custom_headers_mode = Some(mode.into());
                client.config.custom_headers = Some(HashMap::from([
                    ("X-OpenCode-Request".into(), "legacy".into()),
                    ("X-OpenCode-Session-Id".into(), "stale".into()),
                    ("USER-AGENT".into(), "stale-agent".into()),
                    ("Authorization".into(), "Bearer own-key".into()),
                ]));
                let context = prepare_request_context(
                    &client,
                    Some(ModelRequestContext {
                        prompt_cache_route_key: Some("private-runtime-conversation".into()),
                        ..Default::default()
                    }),
                );
                let request = || {
                    let builder =
                        apply_header_policy(&client, client.client.post(&url), |builder| {
                            builder.header("content-type", "application/json")
                        });
                    apply_affinity_headers(&client, builder, &url, context.as_ref())
                        .build()
                        .unwrap()
                };
                let first = request();
                let retry = request();
                let h = first.headers();
                assert_eq!(
                    h["x-opencode-session"],
                    retry.headers()["x-opencode-session"]
                );
                assert_eq!(h["x-opencode-session"], h["x-opencode-session-id"]);
                assert_eq!(h["user-agent"], COMPAT_USER_AGENT);
                assert!(!h.contains_key("x-opencode-request"));
                assert_eq!(h["authorization"], "Bearer own-key");
                assert_eq!(h.get_all("x-opencode-session-id").iter().count(), 1);
                let id = h["x-opencode-session"].to_str().unwrap();
                assert_eq!(id.len(), 30);
                assert_eq!(&id[13..14], "f");
                assert!(matches!(id.as_bytes()[14], b'c'..=b'f'));
                assert!(!id.contains("private"));
                let other = prepare_request_context(&client, None).unwrap();
                assert_ne!(
                    id,
                    zen_session_id(other.prompt_cache_route_key.as_deref().unwrap())
                );
            }
        }
        for seed in ["ses_0123456789abABCDEFGHIJKLMN", "ses_你好你好你好你好AB"] {
            let id = zen_session_id(seed);
            assert!(id.is_ascii());
            assert_eq!(id.len(), 30);
            assert_eq!(zen_session_id(&id), id);
        }
        assert_eq!(
            zen_session_id("ses_012345678fc0ABCDEFGHIJKLMN"),
            "ses_012345678fc0ABCDEFGHIJKLMN"
        );
    }

    #[test]
    fn go_free_named_models_keep_paid_auth_and_do_not_get_zen_placeholders() {
        let url = "https://opencode.ai/zen/go/v1/chat/completions";
        let client = client("openai", "test-free", url);
        let mut body = json!({"model":"test-free"});
        FreeTools::prepare(&client, &mut body).unwrap();
        assert_eq!(body, json!({"model":"test-free"}));
        let req = headers(
            &client,
            client.client.post(url).bearer_auth("paid-go-key"),
            url,
            "s",
        )
        .build()
        .unwrap();
        assert_eq!(req.headers()["authorization"], "Bearer paid-go-key");
        assert!(!req.headers().contains_key("x-opencode-session-id"));
        assert!(!req.headers().contains_key("user-agent"));
    }

    #[test]
    fn anonymous_headers_preserve_paid_keys_and_custom_auth() {
        for wire in ["chat/completions", "responses", "messages"] {
            let url = format!("https://opencode.ai/zen/v1/{wire}");
            let mut client = client(
                if wire == "messages" {
                    "anthropic"
                } else {
                    "openai"
                },
                "test-free",
                &url,
            );
            client.config.api_key.clear();
            let name = if wire == "messages" {
                "x-api-key"
            } else {
                "authorization"
            };
            let request = headers(&client, client.client.post(&url), &url, "s")
                .build()
                .unwrap();
            assert_eq!(
                request.headers()[name],
                if name == "x-api-key" {
                    "public"
                } else {
                    "Bearer public"
                }
            );
            client.config.custom_headers = Some(HashMap::from([(
                "AUTHORIZATION".into(),
                "Bearer own".into(),
            )]));
            let request = headers(
                &client,
                client
                    .client
                    .post(&url)
                    .header("authorization", "Bearer own"),
                &url,
                "s",
            )
            .build()
            .unwrap();
            assert_eq!(request.headers()["authorization"], "Bearer own");
            client.config.custom_headers = None;
            client.config.api_key = "own".into();
            let request = headers(
                &client,
                client.client.post(&url).header(name, "own"),
                &url,
                "s",
            )
            .build()
            .unwrap();
            assert_eq!(request.headers()[name], "own");
        }
    }

    #[test]
    fn free_tools_map_definitions_history_and_choices_for_all_protocols() {
        for (format, tools, messages, choice) in [
            (
                "openai",
                json!([{"type":"function","function":{"name":"Bash","parameters":{"type":"object"}}},{"type":"function","function":{"name":"Read"}}]),
                json!([{"role":"assistant","tool_calls":[{"function":{"name":"Bash","arguments":"{\"name\":\"Read\"}"}}]},{"role":"tool","name":"Bash","content":"Read"},{"role":"user","content":"Bash"}]),
                json!({"type":"function","function":{"name":"Read"}}),
            ),
            (
                "responses",
                json!([{"type":"function","name":"Bash"},{"type":"function","name":"Read"}]),
                json!([{"type":"function_call","name":"Bash","arguments":"{\"name\":\"Read\"}"}]),
                json!({"type":"function","name":"Read"}),
            ),
            (
                "anthropic",
                json!([{"name":"Bash","input_schema":{"type":"object"}},{"name":"Read","input_schema":{"type":"object"}}]),
                json!([{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"name":"Read"}}]}]),
                json!({"type":"tool","name":"Read"}),
            ),
        ] {
            let client = client(
                format,
                "test-free",
                "https://opencode.ai/zen/v1/chat/completions",
            );
            let field = if format == "responses" {
                "input"
            } else {
                "messages"
            };
            let mut body =
                json!({"model":"test-free","tools":tools,"tool_choice":choice,"stream":false});
            body[field] = messages;
            let mapping = FreeTools::prepare(&client, &mut body).unwrap();
            assert!(mapping.stubs.is_empty());
            assert_eq!(mapping.original.get("bash").unwrap(), "Bash");
            assert_eq!(mapping.original.get("read").unwrap(), "Read");
            assert_eq!(body["stream"], true);
            match format {
                "openai" => {
                    assert_eq!(body["tools"][0]["function"]["name"], "bash");
                    assert_eq!(body[field][0]["tool_calls"][0]["function"]["name"], "bash");
                    assert_eq!(
                        body[field][0]["tool_calls"][0]["function"]["arguments"],
                        "{\"name\":\"Read\"}"
                    );
                    assert_eq!(body[field][1]["name"], "bash");
                    assert_eq!(body[field][2]["content"], "Bash");
                    assert_eq!(body["tool_choice"]["function"]["name"], "read");
                }
                "responses" => {
                    assert_eq!(body[field][0]["name"], "bash");
                    assert_eq!(body["tool_choice"]["name"], "read");
                }
                _ => {
                    assert_eq!(body[field][0]["content"][0]["name"], "bash");
                    assert_eq!(body[field][0]["content"][0]["input"]["name"], "Read");
                }
            }
        }
    }

    #[test]
    fn missing_tools_use_the_correct_schema_and_exact_names_win() {
        for (format, schema) in [
            ("openai", "function"),
            ("responses", "parameters"),
            ("anthropic", "input_schema"),
        ] {
            let client = client(format, "big-pickle", "https://opencode.ai/zen/v1/messages");
            let mut body = json!({"model":"big-pickle", "tool_choice":"none"});
            let mapping = FreeTools::prepare(&client, &mut body).unwrap();
            assert_eq!(mapping.stubs, ["bash", "read"]);
            assert!(body["tools"][0].get(schema).is_some());
            let tool = &body["tools"][0];
            let parameters = match format {
                "openai" => &tool["function"]["parameters"],
                "anthropic" => &tool["input_schema"],
                _ => &tool["parameters"],
            };
            assert_eq!(parameters["properties"]["command"]["type"], "string");
            assert_eq!(parameters["required"], json!(["command"]));

            assert_eq!(body["tool_choice"], "none");
            let mut body = json!({"model":"big-pickle", "tools":[{"name":"Bash"},{"name":"bash"},{"name":"read"}]});
            let mapping = FreeTools::prepare(&client, &mut body).unwrap();
            assert!(mapping.original.is_empty());
            assert!(mapping.stubs.is_empty());
            assert_eq!(body["tools"][0]["name"], "Bash");
        }
    }

    #[tokio::test]
    async fn streams_restore_names_preserve_metadata_and_stop_on_unavailable_tools() {
        let client = client(
            "openai",
            "test-free",
            "https://opencode.ai/zen/v1/chat/completions",
        );
        let mapping = FreeTools::prepare(
            &client,
            &mut json!({"model":"test-free","tools":[{"name":"Bash"}]}),
        )
        .unwrap();
        let tool = |name: &str| UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: Some(0),
                id: Some("call-1".into()),
                name: Some(name.into()),
                arguments: Some("{}".into()),
                arguments_is_snapshot: false,
            }),
            response_model: Some("observed-model".into()),
            ..Default::default()
        };
        let response = StreamResponse {
            stream: Box::pin(futures::stream::iter(vec![
                Ok(tool("bash")),
                Ok(tool("read")),
                Ok(tool("bash")),
            ])),
            raw_sse_rx: None,
            trace_handle: None,
        };
        let chunks: Vec<_> = mapping.wrap(response).stream.collect().await;
        assert_eq!(chunks.len(), 2);
        let first = chunks[0].as_ref().unwrap();
        assert_eq!(
            first.tool_call.as_ref().unwrap().name.as_deref(),
            Some("Bash")
        );
        assert_eq!(first.response_model.as_deref(), Some("observed-model"));
        let error = chunks[1]
            .as_ref()
            .unwrap_err()
            .downcast_ref::<AiProviderError>()
            .unwrap();
        assert_eq!(error.category, ErrorCategory::InvalidRequest);
        assert!(error.provider.is_none());
    }

    #[test]
    fn paid_models_and_unrelated_origins_do_not_gain_synthetic_tools_or_headers() {
        for url in [
            "https://other.test/v1/chat/completions",
            "https://opencode.ai.evil.test/zen/v1/chat/completions",
            "http://opencode.ai/zen/v1/messages",
            "https://opencode.ai:444/zen/v1/messages",
            "https://opencode.ai/inference/openai/v1/responses",
            "https://opencode.ai/zen/v1/models",
        ] {
            let client = client("openai", "test-free", url);
            let mut body = json!({"model":"test-free"});
            let before = body.clone();
            FreeTools::prepare(&client, &mut body).unwrap();
            assert_eq!(body, before);
            assert!(headers(&client, client.client.post(url), url, "s")
                .build()
                .unwrap()
                .headers()
                .is_empty());
        }
        let client = client(
            "openai",
            "paid",
            "https://opencode.ai/zen/v1/chat/completions",
        );
        let mut body = json!({"model":"paid"});
        FreeTools::prepare(&client, &mut body).unwrap();
        assert!(body.get("tools").is_none());
    }
    #[tokio::test]
    #[ignore = "Requires explicit live OpenCode access; sends a synthetic prompt using the public key"]
    async fn live_mimo_public_connection() {
        use crate::{Message, ProxyConfig, StreamOptions};
        use std::time::Duration;
        let mut config = client(
            "openai",
            "mimo-v2.6-flash-free",
            "https://opencode.ai/zen/v1/chat/completions",
        )
        .config;
        config.api_key = "public".into();
        config.max_tokens = Some(256);
        let mut proxy = std::env::var("OPENBITFUN_LIVE_OPENCODE_PROXY")
            .ok()
            .map(|url| ProxyConfig {
                enabled: true,
                url,
                username: None,
                password: None,
            });
        if let Ok(path) = std::env::var("OPENBITFUN_LIVE_OPENCODE_CONFIG") {
            let settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            let selected = settings["ai"]["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|model| model["id"] == "mimo-v2.6-flash-free")
                .unwrap();
            assert_eq!(selected["auth"]["type"], "api_key");
            assert_eq!(selected["api_key"], "public");
            config.base_url = selected["base_url"].as_str().unwrap().into();
            config.request_url = selected["request_url"].as_str().unwrap().into();
            config.model = selected["model_name"].as_str().unwrap().into();
            config.format = selected["provider"].as_str().unwrap().into();
            proxy = serde_json::from_value(settings["ai"]["proxy"].clone()).unwrap();
        }
        let client = AIClient::new_with_runtime_options(
            config,
            proxy,
            StreamOptions {
                idle_timeout: Some(Duration::from_secs(20)),
                ttft_timeout: Some(Duration::from_secs(45)),
            },
        );
        let response = client
            .send_message_once_with_trace_and_request_context(
                vec![Message::user(
                    "Reply with exactly: OPENBITFUN_ZEN_OK".into(),
                )],
                None,
                None,
                None,
            )
            .await
            .expect("live public Zen request must complete");
        eprintln!("live_mimo_public_text={}", response.text);
        assert!(response.text.contains("OPENBITFUN_ZEN_OK"));
        // Exercise the same one-attempt tool probe used by the settings button.
        let probe = crate::client::healthcheck::test_connection(&client, 1)
            .await
            .unwrap();
        eprintln!(
            "live_mimo_connection_probe={}",
            serde_json::to_string(&probe).unwrap()
        );
        assert!(probe.success, "connection probe failed");
    }
}
