use crate::client::utils::{
    build_request_body_subset, is_trim_custom_request_body_mode, merge_json_value,
};
use crate::client::AIClient;
use crate::types::{ReasoningPresetAction, ReasoningPresetDescriptor};
use anyhow::{anyhow, Result};
use reqwest::RequestBuilder;

/// Internal execution identity for best-effort reasoning controls offered when
/// neither models.dev nor a model-specific adapter projection has a preset.
/// The field is host-only and is never serialized to Web or remote clients.
pub(crate) const GENERIC_REASONING_PROVIDER_ID: &str = "openbitfun-generic";

pub(crate) fn is_generic_reasoning_preset(preset: &ReasoningPresetDescriptor) -> bool {
    preset.execution_provider.as_deref() == Some(GENERIC_REASONING_PROVIDER_ID)
}

pub(crate) fn normalize_generic_reasoning_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        _ => None,
    }
}

/// Attribution for APIs that accept third-party harnesses under their own name.
#[cfg(feature = "subscription-auth")]
pub(crate) fn product_user_agent() -> String {
    format!(
        "OpenBitFun/{} ({}; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub(crate) fn is_https_endpoint(raw: &str, host: &str, path: &str) -> bool {
    reqwest::Url::parse(raw).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some(host)
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && (url.path() == path
                || url
                    .path()
                    .strip_prefix(path)
                    .is_some_and(|suffix| suffix.starts_with('/')))
    })
}

/// Session affinity is a protocol requirement, independent of OAuth. API-key
/// clients opt into this header alone at the official Zen/Go inference routes.
fn uses_opencode_affinity(client: &AIClient, url: &str) -> bool {
    if client.subscription_provider_key() == Some("opencode")
        && is_https_endpoint(url, "opencode.ai", "/inference")
    {
        return true;
    }
    if !is_https_endpoint(url, "opencode.ai", "/zen") {
        return false;
    }
    match client.subscription_provider_key() {
        Some("opencode") => true,
        Some(_) => false,
        None => reqwest::Url::parse(url).ok().is_some_and(|url| {
            matches!(
                url.path(),
                "/zen/v1/chat/completions"
                    | "/zen/v1/responses"
                    | "/zen/v1/messages"
                    | "/zen/go/v1/chat/completions"
                    | "/zen/go/v1/responses"
                    | "/zen/go/v1/messages"
            )
        }),
    }
}

/// OpenCode requires an affinity header even for standalone calls such as
/// connection tests and auxiliary summaries. Allocate their identity once per
/// logical call, before retries; never share a fallback across a cached client.
pub(crate) fn prepare_request_context(
    client: &AIClient,
    context: Option<crate::types::ModelRequestContext>,
) -> Option<crate::types::ModelRequestContext> {
    if !uses_opencode_affinity(client, &client.config.request_url)
        || context
            .as_ref()
            .and_then(|context| context.prompt_cache_route_key.as_deref())
            .is_some_and(|key| !key.trim().is_empty())
    {
        return context;
    }
    use std::collections::hash_map::RandomState;
    use std::hash::BuildHasher;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    };
    // Process-random hashing plus a monotonic nonce gives concurrent calls
    // distinct opaque routing labels without exposing prompts or machine IDs.
    // This is a cache label, not an authentication credential.
    static HASHER: OnceLock<RandomState> = OnceLock::new();
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nonce = NEXT.fetch_add(1, Ordering::Relaxed);
    let hasher = HASHER.get_or_init(RandomState::new);
    let mut context = context.unwrap_or_default();
    context.prompt_cache_route_key = Some(format!(
        "openbitfun-call-{:016x}{:016x}",
        hasher.hash_one((nonce, 0_u8)),
        hasher.hash_one((nonce, 1_u8)),
    ));
    Some(context)
}

/// A client is cached across conversations; affinity belongs to each request.
/// Only forward the runtime's opaque routing key to the owning provider origin.
/// HeaderMap replacement ensures a stale custom header cannot create duplicates.
pub(crate) fn apply_affinity_headers(
    client: &AIClient,
    builder: RequestBuilder,
    url: &str,
    context: Option<&crate::types::ModelRequestContext>,
) -> RequestBuilder {
    let Some(key) = context
        .and_then(|context| context.prompt_cache_route_key.as_deref())
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        return builder;
    };
    let names: &[&'static str] = if client.subscription_provider_key() == Some("codex")
        && is_https_endpoint(url, "chatgpt.com", "/backend-api/codex")
    {
        &["session_id", "x-client-request-id"]
    } else if uses_opencode_affinity(client, url) {
        &["x-opencode-session"]
    } else if client.subscription_provider_key() == Some("grok")
        && is_https_endpoint(url, "cli-chat-proxy.grok.com", "/v1/responses")
    {
        &["x-grok-conv-id"]
    } else {
        return builder;
    };
    let Ok(value) = reqwest::header::HeaderValue::from_str(key) else {
        // Let reqwest report invalid header input through its normal error path.
        return builder.header(names[0], key);
    };
    let headers = names
        .iter()
        .map(|name| {
            (
                reqwest::header::HeaderName::from_static(name),
                value.clone(),
            )
        })
        .collect();
    let builder = builder.headers(headers);
    super::opencode::headers(client, builder, url, key)
}

pub(crate) fn apply_header_policy<F>(
    client: &AIClient,
    builder: RequestBuilder,
    apply_defaults: F,
) -> RequestBuilder
where
    F: FnOnce(RequestBuilder) -> RequestBuilder,
{
    let has_custom_headers = client
        .config
        .custom_headers
        .as_ref()
        .is_some_and(|headers| !headers.is_empty());
    let is_merge_mode = client.config.custom_headers_mode.as_deref() != Some("replace");

    if has_custom_headers && !is_merge_mode {
        return apply_custom_headers(client, builder);
    }

    let mut builder = apply_defaults(builder);

    if has_custom_headers && is_merge_mode {
        builder = apply_custom_headers(client, builder);
    }

    builder
}

pub(crate) fn apply_custom_headers(
    client: &AIClient,
    mut builder: RequestBuilder,
) -> RequestBuilder {
    if let Some(custom_headers) = &client.config.custom_headers {
        if !custom_headers.is_empty() {
            for (key, value) in custom_headers {
                if super::opencode::uses_free_zen(client)
                    && key.eq_ignore_ascii_case("x-opencode-request")
                {
                    continue;
                }
                builder = builder.header(key.as_str(), value.as_str());
            }
        }
    }

    builder
}

pub(crate) fn protect_request_body(
    client: &AIClient,
    request_body: &mut serde_json::Value,
    top_level_keys: &[&str],
    nested_fields: &[(&str, &str)],
) -> Option<serde_json::Value> {
    let protected_body = is_trim_custom_request_body_mode(&client.config)
        .then(|| build_request_body_subset(request_body, top_level_keys, nested_fields));

    if let Some(protected_body) = &protected_body {
        *request_body = protected_body.clone();
    }

    protected_body
}

pub(crate) fn restore_protected_body(
    request_body: &mut serde_json::Value,
    protected_body: Option<serde_json::Value>,
) {
    if let Some(protected_body) = protected_body {
        merge_json_value(request_body, protected_body);
    }
}

pub(crate) fn merge_extra_body(
    request_body: &mut serde_json::Value,
    extra_obj: &serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in extra_obj {
        request_body[key] = value.clone();
    }
}

pub(crate) fn merge_extra_body_recursively(
    request_body: &mut serde_json::Value,
    extra_obj: serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in extra_obj {
        if let Some(request_obj) = request_body.as_object_mut() {
            let target = request_obj.entry(key).or_insert(serde_json::Value::Null);
            merge_json_value(target, value);
        }
    }
}

pub(crate) fn capture_reasoning_fields(
    request_body: &serde_json::Value,
    top_level_keys: &[&str],
    nested_fields: &[(&str, &str)],
) -> Option<serde_json::Value> {
    Some(build_request_body_subset(
        request_body,
        top_level_keys,
        nested_fields,
    ))
}

pub(crate) fn reset_reasoning_fields(
    request_body: &mut serde_json::Value,
    captured_reasoning_fields: Option<&serde_json::Value>,
    reasoning_top_level_keys: &[&str],
    reasoning_nested_fields: &[(&str, &str)],
) {
    if let Some(request_object) = request_body.as_object_mut() {
        for key in reasoning_top_level_keys {
            request_object.remove(*key);
        }
        for (parent, child) in reasoning_nested_fields {
            if let Some(parent_object) = request_object
                .get_mut(*parent)
                .and_then(serde_json::Value::as_object_mut)
            {
                parent_object.remove(*child);
            }
        }
    }
    if let Some(captured_reasoning_fields) = captured_reasoning_fields {
        merge_json_value(request_body, captured_reasoning_fields.clone());
    }
}

pub(crate) fn apply_reasoning_request_patch(
    action: &ReasoningPresetAction,
    request_body: &mut serde_json::Value,
    protected_top_level_keys: &[&str],
    protected_nested_fields: &[(&str, &str)],
) -> Result<()> {
    let ReasoningPresetAction::RequestPatch { body } = action else {
        return Ok(());
    };
    let mut patch = body.clone();
    let Some(patch_object) = patch.as_object_mut() else {
        return Err(anyhow!(
            "Reasoning preset request_patch body must be a JSON object"
        ));
    };
    let protected_body = build_request_body_subset(
        request_body,
        protected_top_level_keys,
        protected_nested_fields,
    );
    for key in protected_top_level_keys {
        patch_object.remove(*key);
    }
    for (parent, child) in protected_nested_fields {
        if let Some(parent_object) = patch_object
            .get_mut(*parent)
            .and_then(serde_json::Value::as_object_mut)
        {
            parent_object.remove(*child);
        }
    }
    apply_json_merge_patch(request_body, &patch);
    // A merge patch can replace or delete a protected field's parent with
    // null, a scalar, or an array. Restore the captured paths after every
    // patch so nested runtime fields survive those parent-level changes.
    merge_json_value(request_body, protected_body);
    Ok(())
}

pub(crate) fn apply_reasoning_actions<F>(
    preset: &ReasoningPresetDescriptor,
    request_body: &mut serde_json::Value,
    protected_top_level_keys: &[&str],
    protected_nested_fields: &[(&str, &str)],
    mut compile_typed_action: F,
) -> Result<()>
where
    F: FnMut(&ReasoningPresetAction, &mut serde_json::Value) -> Result<bool>,
{
    for action in &preset.actions {
        if matches!(action, ReasoningPresetAction::RequestPatch { .. }) {
            apply_reasoning_request_patch(
                action,
                request_body,
                protected_top_level_keys,
                protected_nested_fields,
            )?;
        } else if !compile_typed_action(action, request_body)? {
            return Err(anyhow!(
                "Reasoning preset '{}' contains an action unsupported by this provider: {:?}",
                preset.id,
                action
            ));
        }
    }
    Ok(())
}

fn apply_json_merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
    let serde_json::Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = serde_json::json!({});
    }
    let target = target
        .as_object_mut()
        .expect("merge patch target should be an object");
    for (key, patch_value) in patch {
        if patch_value.is_null() {
            target.remove(key);
            continue;
        }
        let target_value = target.entry(key.clone()).or_insert(serde_json::Value::Null);
        apply_json_merge_patch(target_value, patch_value);
    }
}

pub(crate) fn log_extra_body_keys(
    target: &str,
    extra_obj: &serde_json::Map<String, serde_json::Value>,
) {
    log::debug!(
        target: target,
        "Applied extra_body overrides: {:?}",
        extra_obj.keys().collect::<Vec<_>>()
    );
}

pub(crate) fn summarize_request_body_for_log(
    request_body: &serde_json::Value,
) -> serde_json::Value {
    let mut summary = serde_json::Map::new();

    if let Some(model) = request_body
        .get("model")
        .and_then(serde_json::Value::as_str)
    {
        summary.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }
    if let Some(stream) = request_body
        .get("stream")
        .and_then(serde_json::Value::as_bool)
    {
        summary.insert("stream".to_string(), serde_json::Value::Bool(stream));
    }
    if let Some(max_tokens) = request_body
        .get("max_tokens")
        .and_then(|value| value.as_u64())
    {
        summary.insert(
            "max_tokens".to_string(),
            serde_json::Value::Number(max_tokens.into()),
        );
    }
    if let Some(tool_stream) = request_body
        .get("tool_stream")
        .and_then(serde_json::Value::as_bool)
    {
        summary.insert(
            "tool_stream".to_string(),
            serde_json::Value::Bool(tool_stream),
        );
    }
    if let Some(system) = request_body
        .get("system")
        .and_then(serde_json::Value::as_str)
    {
        summary.insert(
            "system_chars".to_string(),
            serde_json::Value::Number((system.chars().count() as u64).into()),
        );
    }
    if let Some(messages) = request_body
        .get("messages")
        .and_then(serde_json::Value::as_array)
    {
        summary.insert(
            "message_count".to_string(),
            serde_json::Value::Number((messages.len() as u64).into()),
        );
        summary.insert(
            "messages".to_string(),
            serde_json::Value::Array(messages.iter().map(summarize_message_for_log).collect()),
        );
    }
    if let Some(tools) = request_body
        .get("tools")
        .and_then(serde_json::Value::as_array)
    {
        summary.insert(
            "tool_count".to_string(),
            serde_json::Value::Number((tools.len() as u64).into()),
        );
    }
    if let Some(object) = request_body.as_object() {
        let mut top_level_keys = object.keys().cloned().collect::<Vec<_>>();
        top_level_keys.sort();
        summary.insert(
            "top_level_keys".to_string(),
            serde_json::Value::Array(
                top_level_keys
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }

    serde_json::Value::Object(summary)
}

fn summarize_message_for_log(message: &serde_json::Value) -> serde_json::Value {
    let mut summary = serde_json::Map::new();
    let content = message.get("content");

    if let Some(role) = message.get("role").and_then(serde_json::Value::as_str) {
        summary.insert(
            "role".to_string(),
            serde_json::Value::String(role.to_string()),
        );
    }
    if let Some(content) = content {
        summary.insert(
            "content_chars".to_string(),
            serde_json::Value::Number((content_text_chars(content) as u64).into()),
        );
        if let Some(items) = content.as_array() {
            summary.insert(
                "content_items".to_string(),
                serde_json::Value::Number((items.len() as u64).into()),
            );
            let mut content_types = items
                .iter()
                .filter_map(|item| item.get("type").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>();
            content_types.sort();
            content_types.dedup();
            if !content_types.is_empty() {
                summary.insert(
                    "content_types".to_string(),
                    serde_json::Value::Array(
                        content_types
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
            }
        }
    }

    serde_json::Value::Object(summary)
}

fn content_text_chars(content: &serde_json::Value) -> usize {
    if let Some(text) = content.as_str() {
        return text.chars().count();
    }

    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
                .map(|text| text.chars().count())
                .sum()
        })
        .unwrap_or(0)
}

fn should_log_full_request_body(include_sensitive_diagnostics: bool) -> bool {
    include_sensitive_diagnostics
}

pub(crate) fn log_request_body(target: &str, label: &str, request_body: &serde_json::Value) {
    if should_log_full_request_body(crate::diagnostics::include_sensitive_diagnostics()) {
        log::debug!(
            target: target,
            "{}\n{}",
            label,
            serde_json::to_string_pretty(request_body)
                .unwrap_or_else(|_| "serialization failed".to_string())
        );
        return;
    }

    let summary_label = label.trim_end_matches(':');
    log::debug!(
        target: target,
        "{} summary:\n{}",
        summary_label,
        serde_json::to_string_pretty(&summarize_request_body_for_log(request_body))
            .unwrap_or_else(|_| "serialization failed".to_string())
    );
}

pub(crate) fn log_tool_names(target: &str, tool_names: Vec<String>) {
    log::debug!(target: target, "\ntools: {:?}", tool_names);
}

pub(crate) fn extract_top_level_string_field(
    value: &serde_json::Value,
    key: &str,
) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

pub(crate) fn collect_function_declaration_names_or_object_keys(
    tool: &serde_json::Value,
) -> Vec<String> {
    if let Some(declarations) = tool
        .get("functionDeclarations")
        .and_then(serde_json::Value::as_array)
    {
        declarations
            .iter()
            .filter_map(|declaration| extract_top_level_string_field(declaration, "name"))
            .collect()
    } else {
        tool.as_object()
            .into_iter()
            .flat_map(|map| map.keys().cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::should_log_full_request_body;
    use super::summarize_request_body_for_log;

    fn request_client(url: &str) -> crate::client::AIClient {
        crate::client::AIClient::new(
            serde_json::from_value(serde_json::json!({
                "name": "synthetic", "base_url": url, "request_url": url, "api_key": "synthetic",
                "model": "test", "format": "openai", "context_window": 4096,
                "inline_think_in_text": false, "skip_ssl_verify": false
            }))
            .unwrap(),
        )
    }

    #[test]
    fn unrelated_api_requests_keep_headers_and_context_even_at_subscription_origins() {
        use crate::types::ModelRequestContext;
        for url in [
            "https://opencode.ai/zen/v1/models",
            "https://opencode.ai/zen/go/v1/models",
            "https://chatgpt.com/backend-api/codex/responses",
            "https://api.x.ai/v1/responses",
            "https://cli-chat-proxy.grok.com/v1/responses",
            "https://inference-api.nousresearch.com/v1/chat/completions",
        ] {
            for mode in ["merge", "replace"] {
                let mut client = request_client(url);
                client.config.custom_headers_mode = Some(mode.into());
                client.config.custom_headers = Some(std::collections::HashMap::from([
                    ("x-opencode-session".into(), "user-managed".into()),
                    ("session_id".into(), "user-session".into()),
                    ("x-grok-conv-id".into(), "user-grok".into()),
                    ("user-agent".into(), "user-agent-value".into()),
                ]));
                for context in [
                    None,
                    Some(ModelRequestContext {
                        prompt_cache_route_key: Some("runtime-lineage".into()),
                        output_schema: Some(serde_json::json!({"type": "object"})),
                    }),
                ] {
                    assert_eq!(
                        super::prepare_request_context(&client, context.clone()),
                        context
                    );
                    let original =
                        super::apply_header_policy(&client, client.client.post(url), |builder| {
                            builder.bearer_auth("synthetic")
                        });
                    let before = original.try_clone().unwrap().build().unwrap();
                    let after =
                        super::apply_affinity_headers(&client, original, url, context.as_ref())
                            .build()
                            .unwrap();
                    assert_eq!(before.headers(), after.headers(), "{url} {mode}");
                    assert!(!after.headers().contains_key("x-client-request-id"));
                }
                let empty = super::apply_affinity_headers(
                    &client,
                    client.client.post(url),
                    url,
                    Some(&ModelRequestContext {
                        prompt_cache_route_key: Some("runtime-lineage".into()),
                        ..Default::default()
                    }),
                )
                .build()
                .unwrap();
                assert!(empty.headers().is_empty(), "{url}");
            }
        }
    }

    #[test]
    fn api_key_opencode_calls_keep_auth_and_send_per_call_affinity_on_every_wire() {
        use super::{apply_affinity_headers, apply_header_policy, prepare_request_context};
        use crate::types::ModelRequestContext;
        let mut generated = std::collections::HashSet::new();
        for plan in ["zen", "zen/go"] {
            for wire in ["chat/completions", "responses", "messages"] {
                let url = format!("https://opencode.ai/{plan}/v1/{wire}");
                let mut client = request_client(&url);
                assert!(client.subscription_provider_key().is_none());
                for mode in ["merge", "replace"] {
                    client.config.custom_headers_mode = Some(mode.into());
                    client.config.custom_headers = Some(std::collections::HashMap::from([
                        ("X-OpenCode-Session".into(), "stale".into()),
                        ("Authorization".into(), "Bearer user-key".into()),
                    ]));
                    for initial in [
                        None,
                        Some(ModelRequestContext::default()),
                        Some(ModelRequestContext {
                            prompt_cache_route_key: Some(" ".into()),
                            output_schema: Some(serde_json::json!({"type":"object"})),
                        }),
                        Some(ModelRequestContext {
                            prompt_cache_route_key: Some("conversation-a".into()),
                            ..Default::default()
                        }),
                        Some(ModelRequestContext {
                            prompt_cache_route_key: Some("conversation-b".into()),
                            ..Default::default()
                        }),
                    ] {
                        let schema = initial
                            .as_ref()
                            .and_then(|value| value.output_schema.clone());
                        let existing = initial
                            .as_ref()
                            .and_then(|value| value.prompt_cache_route_key.clone())
                            .filter(|value| !value.trim().is_empty());
                        let context = prepare_request_context(&client, initial).unwrap();
                        assert_eq!(context.output_schema, schema);
                        let key = context.prompt_cache_route_key.as_ref().unwrap();
                        if let Some(existing) = existing {
                            assert_eq!(*key, existing);
                        } else {
                            assert!(generated.insert(key.clone()));
                        }
                        for _ in 0..3 {
                            let retry = prepare_request_context(&client, Some(context.clone()));
                            let builder =
                                apply_header_policy(&client, client.client.post(&url), |builder| {
                                    builder.bearer_auth("synthetic")
                                });
                            let before = builder.try_clone().unwrap().build().unwrap();
                            let request =
                                apply_affinity_headers(&client, builder, &url, retry.as_ref())
                                    .build()
                                    .unwrap();
                            assert_eq!(request.headers()["x-opencode-session"], key.as_str());
                            assert_eq!(
                                request
                                    .headers()
                                    .get_all("x-opencode-session")
                                    .iter()
                                    .count(),
                                1
                            );
                            assert_eq!(
                                request.headers()["authorization"],
                                before.headers()["authorization"]
                            );
                            assert!(!request.headers().contains_key("x-org-id"));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn api_key_opencode_affinity_is_limited_to_official_inference_endpoints() {
        for url in [
            "http://opencode.ai/zen/go/v1/messages",
            "https://opencode.ai:444/zen/go/v1/messages",
            "https://opencode.ai.evil.test/zen/go/v1/messages",
            "https://user:password@opencode.ai/zen/go/v1/messages",
            "https://opencode.ai/zen-other/v1/messages",
            "https://opencode.ai/zen/go/v1/messages/other",
            "https://opencode.ai/zen/go/v1/models",
            "https://opencode.ai/console/api/config",
        ] {
            let client = request_client(url);
            assert!(
                super::prepare_request_context(&client, None).is_none(),
                "{url}"
            );
            let context = crate::types::ModelRequestContext {
                prompt_cache_route_key: Some("private-scope".into()),
                ..Default::default()
            };
            let request = super::apply_affinity_headers(
                &client,
                client.client.post(url),
                url,
                Some(&context),
            )
            .build()
            .unwrap();
            assert!(
                !request.headers().contains_key("x-opencode-session"),
                "{url}"
            );
        }
    }

    #[cfg(feature = "subscription-auth")]
    mod subscription {
        use super::request_client;
        use crate::providers::shared::{apply_affinity_headers, prepare_request_context};
        use crate::subscription_auth::SubscriptionProvider;
        use crate::types::ModelRequestContext;

        #[test]
        fn console_credentials_and_affinity_survive_saved_header_replacement() {
            use crate::providers::shared::apply_header_policy;
            use crate::subscription_auth::ResolvedCredential;
            use std::collections::HashMap;
            let url = "https://opencode.ai/inference/openai/v1/chat/completions";
            let mut client =
                request_client(url).with_subscription_provider(SubscriptionProvider::Opencode);
            client.config.custom_headers_mode = Some("replace".into());
            client.config.custom_headers = Some(HashMap::from([
                ("Authorization".into(), "stale".into()),
                ("X-OpenCode-Org-Id".into(), "stale".into()),
                ("x-org-id".into(), "legacy".into()),
                ("X-OpenCode-Session".into(), "stale".into()),
            ]));
            ResolvedCredential {
                api_key: "synthetic-access".into(),
                base_url: None,
                request_url: None,
                format: None,
                expires_at: None,
                extra_headers: HashMap::from([("x-opencode-org-id".into(), "account-org".into())]),
            }
            .apply_to(&mut client.config);
            let context = prepare_request_context(&client, None);
            let builder = apply_header_policy(&client, client.client.post(url), |builder| {
                builder.bearer_auth(&client.config.api_key)
            });
            let request = apply_affinity_headers(&client, builder, url, context.as_ref())
                .build()
                .unwrap();
            assert_eq!(
                request.headers()["authorization"],
                "Bearer synthetic-access"
            );
            assert_eq!(request.headers()["x-opencode-org-id"], "account-org");
            assert!(!request.headers().contains_key("x-org-id"));
            assert_ne!(request.headers()["x-opencode-session"], "stale");
            assert_eq!(
                request
                    .headers()
                    .get_all("x-opencode-org-id")
                    .iter()
                    .count(),
                1
            );
            let public_client = request_client(url);
            assert!(prepare_request_context(&public_client, None).is_none());
        }

        #[test]
        fn standalone_opencode_calls_send_affinity_on_every_wire_and_retry() {
            let mut call_keys = std::collections::HashSet::new();
            for plan in ["zen", "zen/go", "inference/openai", "inference/anthropic"] {
                for wire in ["chat/completions", "responses", "messages"] {
                    let url = format!("https://opencode.ai/{plan}/v1/{wire}");
                    let client = request_client(&url)
                        .with_subscription_provider(SubscriptionProvider::Opencode);
                    for initial in [
                        None,
                        Some(ModelRequestContext::default()),
                        Some(ModelRequestContext {
                            prompt_cache_route_key: Some("  ".into()),
                            output_schema: Some(serde_json::json!({"type": "object"})),
                        }),
                    ] {
                        let schema = initial
                            .as_ref()
                            .and_then(|context| context.output_schema.clone());
                        let call = prepare_request_context(&client, initial).unwrap();
                        assert_eq!(call.output_schema, schema);
                        let key = call.prompt_cache_route_key.as_ref().unwrap();
                        assert!(
                            call_keys.insert(key.clone()),
                            "standalone calls must not share affinity"
                        );
                        for _ in 0..3 {
                            let retry = prepare_request_context(&client, Some(call.clone()));
                            let request = apply_affinity_headers(
                                &client,
                                client.client.post(&url),
                                &url,
                                retry.as_ref(),
                            )
                            .build()
                            .unwrap();
                            assert_eq!(request.headers()["x-opencode-session"], key.as_str());
                            assert_eq!(
                                request
                                    .headers()
                                    .get_all("x-opencode-session")
                                    .iter()
                                    .count(),
                                1
                            );
                        }
                    }
                    let context = ModelRequestContext {
                        prompt_cache_route_key: Some("runtime-lineage".into()),
                        ..Default::default()
                    };
                    assert_eq!(
                        prepare_request_context(&client, Some(context.clone())),
                        Some(context)
                    );
                }
            }
        }

        #[test]
        fn affinity_is_scoped_to_each_request_and_replaces_stale_headers() {
            for (provider, url, names) in [
                (
                    SubscriptionProvider::Codex,
                    "https://chatgpt.com/backend-api/codex/responses",
                    vec!["session_id", "x-client-request-id"],
                ),
                (
                    SubscriptionProvider::Grok,
                    "https://cli-chat-proxy.grok.com/v1/responses",
                    vec!["x-grok-conv-id"],
                ),
                (
                    SubscriptionProvider::Opencode,
                    "https://opencode.ai/zen/v1/chat/completions",
                    vec!["x-opencode-session"],
                ),
                (
                    SubscriptionProvider::Opencode,
                    "https://opencode.ai/zen/go/v1/responses",
                    vec!["x-opencode-session"],
                ),
                (
                    SubscriptionProvider::Opencode,
                    "https://opencode.ai/zen/go/v1/messages",
                    vec!["x-opencode-session"],
                ),
            ] {
                let client = request_client(url)
                    .with_subscription_provider(provider)
                    .with_max_tokens(Some(2048));
                for scope in ["lineage-a", "lineage-b", "lineage-a"] {
                    let context = ModelRequestContext {
                        prompt_cache_route_key: Some(scope.into()),
                        ..Default::default()
                    };
                    let mut builder = client.client.post(url);
                    for name in &names {
                        builder = builder.header(name.to_ascii_uppercase(), "stale");
                    }
                    let request = apply_affinity_headers(&client, builder, url, Some(&context))
                        .build()
                        .unwrap();
                    for name in &names {
                        assert_eq!(request.headers().get_all(*name).iter().count(), 1);
                        assert_eq!(request.headers()[*name], scope);
                    }
                }
                // A different subscription provider must not activate this origin's policy.
                let mismatch =
                    request_client(url).with_subscription_provider(SubscriptionProvider::Hermes);
                assert!(prepare_request_context(&mismatch, None).is_none());
                let context = ModelRequestContext {
                    prompt_cache_route_key: Some("scope".into()),
                    ..Default::default()
                };
                assert!(apply_affinity_headers(
                    &mismatch,
                    mismatch.client.post(url),
                    url,
                    Some(&context)
                )
                .build()
                .unwrap()
                .headers()
                .is_empty());
            }
        }

        #[test]
        fn affinity_never_leaks_to_other_origins_or_lookalike_paths() {
            let context = ModelRequestContext {
                prompt_cache_route_key: Some("opaque-scope".into()),
                ..Default::default()
            };
            for provider in SubscriptionProvider::ALL {
                for url in [
                    "https://api.openai.com/v1/responses",
                    "https://example.test/chatgpt.com/backend-api/codex/responses",
                    "https://chatgpt.com.evil.test/backend-api/codex/responses",
                    "https://chatgpt.com/backend-api/codex-other/responses",
                    "http://chatgpt.com/backend-api/codex/responses",
                    "https://chatgpt.com:444/backend-api/codex/responses",
                    "https://opencode.ai/zen-other/v1/messages",
                    "https://opencode.ai.evil.test/zen/v1/messages",
                    "https://api.x.ai/v1/chat/completions",
                    "https://api.x.ai/v1/responses",
                    "https://cli-chat-proxy.grok.com.evil.test/v1/responses",
                    "http://cli-chat-proxy.grok.com/v1/responses",
                ] {
                    let client = request_client(url).with_subscription_provider(provider);
                    assert!(prepare_request_context(&client, None).is_none());
                    assert!(
                        apply_affinity_headers(
                            &client,
                            client.client.post(url),
                            url,
                            Some(&context)
                        )
                        .build()
                        .unwrap()
                        .headers()
                        .is_empty(),
                        "{provider:?} {url}"
                    );
                }
            }
        }
    }

    #[test]
    fn request_body_log_summary_keeps_shape_without_message_contents() {
        let request_body = serde_json::json!({
            "model": "kimi-k2.6",
            "stream": true,
            "max_tokens": 32000,
            "system": "secret system context",
            "messages": [
                { "role": "user", "content": "secret user message" },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "secret assistant message" },
                        { "type": "tool_use", "id": "tool-1", "name": "Read" }
                    ]
                }
            ]
        });

        let summary = summarize_request_body_for_log(&request_body);
        let summary_text = serde_json::to_string(&summary).unwrap();

        assert!(!summary_text.contains("secret system context"));
        assert!(!summary_text.contains("secret user message"));
        assert!(!summary_text.contains("secret assistant message"));
        assert_eq!(summary["model"], "kimi-k2.6");
        assert_eq!(summary["stream"], true);
        assert_eq!(summary["max_tokens"], 32000);
        assert_eq!(summary["system_chars"], 21);
        assert_eq!(summary["message_count"], 2);
        assert_eq!(summary["messages"][0]["role"], "user");
        assert_eq!(summary["messages"][0]["content_chars"], 19);
        assert_eq!(summary["messages"][1]["content_items"], 2);
    }

    #[test]
    fn request_body_logging_keeps_full_payload_when_sensitive_diagnostics_are_enabled() {
        assert!(should_log_full_request_body(true));
        assert!(!should_log_full_request_body(false));
    }
}
