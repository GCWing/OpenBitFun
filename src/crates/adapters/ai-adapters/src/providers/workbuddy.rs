//! Request dialect required by WorkBuddy's streaming Chat Completions API.
use crate::{
    client::{AIClient, StreamResponse},
    types::ModelRequestContext,
};
use futures::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub(super) fn active(client: &AIClient) -> bool {
    matches!(client.subscription_provider_key(), Some("workbuddy"))
        && super::shared::is_https_endpoint(
            &client.config.request_url,
            "copilot.tencent.com",
            "/v2/chat/completions",
        )
        || matches!(client.subscription_provider_key(), Some("workbuddy_ai"))
            && super::shared::is_https_endpoint(
                &client.config.request_url,
                "www.workbuddy.ai",
                "/v2/chat/completions",
            )
}

fn digest(seed: &str) -> String {
    static SALT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let salt = SALT.get_or_init(|| uuid::Uuid::new_v4().to_string());
    hex::encode(Sha256::digest(format!("{salt}|{seed}").as_bytes()))[..32].into()
}

pub(super) fn headers(
    client: &AIClient,
    builder: reqwest::RequestBuilder,
    body: &Value,
    context: Option<&ModelRequestContext>,
) -> reqwest::RequestBuilder {
    if !active(client) {
        return builder;
    }
    let messages = body["messages"].as_array();
    let first = messages
        .and_then(|ms| ms.iter().find(|m| m["role"] == "user"))
        .map(|m| m["content"].to_string());
    let session = context
        .and_then(|c| c.prompt_cache_route_key.as_deref())
        .or(first.as_deref())
        .unwrap_or("");
    let users: Vec<_> = messages
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, m)| m["role"] == "user")
        .map(|(i, m)| json!([i, m["content"]]))
        .collect();
    // Only opaque digests leave the host. The turn remains stable across tool
    // continuations and transport retries; the next user message changes it.
    let conversation = digest(session);
    let turn = digest(&format!("{conversation}|{}", json!(users)));
    let request = uuid::Uuid::new_v4().simple().to_string();
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in [
        ("x-conversation-id", conversation),
        ("x-conversation-request-id", turn),
        ("x-conversation-message-id", request.clone()),
        ("x-request-id", request),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_static(name),
            value.parse().unwrap(),
        );
    }
    builder.headers(headers)
}

#[derive(Default)]
pub(super) struct Tools {
    original: HashMap<String, String>,
}
impl Tools {
    pub(super) fn prepare(client: &AIClient, body: &mut Value) -> Self {
        let mut mapping = Self::default();
        if !active(client) {
            return mapping;
        }
        body["stream"] = json!(true);
        if let Some(object) = body.as_object_mut() {
            if let Some(max) = object.remove("max_completion_tokens") {
                object.entry("max_tokens").or_insert(max);
            }
        }
        if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages.iter_mut() {
                if message["role"] == "developer" {
                    message["role"] = json!("system");
                }
            }
            if messages.first().is_none_or(|m| m["role"] != "system") {
                messages.insert(
                    0,
                    json!({"role":"system","content":"You are a helpful assistant."}),
                );
            }
        }
        if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
            let names: std::collections::HashSet<String> = tools
                .iter()
                .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
                .collect();
            for tool in tools {
                let function = &mut tool["function"];
                if let Some(name) = function["name"].as_str().map(str::to_owned) {
                    if !name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    {
                        let safe: String = name
                            .chars()
                            .map(|c| {
                                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                                    c
                                } else {
                                    '_'
                                }
                            })
                            .take(45)
                            .collect();
                        let alias = if names.contains(&safe) || mapping.original.contains_key(&safe)
                        {
                            format!("{safe}_{}", &digest(&name)[..8])
                        } else {
                            safe
                        };
                        function["name"] = json!(alias);
                        mapping.original.insert(alias, name);
                    }
                }
                schema(&mut function["parameters"]);
                // The gateway requires an object parameter root, including
                // tools that publish a union of object schemas.
                if let Some(parameters) = function["parameters"].as_object_mut() {
                    for union in ["anyOf", "oneOf", "allOf"] {
                        if let Some(branches) =
                            parameters.remove(union).and_then(|v| v.as_array().cloned())
                        {
                            let properties =
                                parameters.entry("properties").or_insert_with(|| json!({}));
                            if let Some(properties) = properties.as_object_mut() {
                                for branch in branches {
                                    if let Some(fields) = branch["properties"].as_object() {
                                        for (name, value) in fields {
                                            properties
                                                .entry(name.clone())
                                                .or_insert_with(|| value.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if function["parameters"]["type"] != "object" {
                    function["parameters"]["type"] = json!("object");
                }
            }
        }
        if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message["role"] == "tool" {
                    mapping.rename(message);
                }
                for call in message
                    .get_mut("tool_calls")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    mapping.rename(&mut call["function"]);
                }
            }
        }
        if let Some(choice) = body.get_mut("tool_choice") {
            if choice.is_object() {
                mapping.rename(&mut choice["function"]);
                let kind = choice["type"].as_str().unwrap_or("auto").to_owned();
                *choice = if kind == "function" {
                    choice["function"]["name"].clone()
                } else {
                    json!(kind)
                };
            }
            if choice == "none" {
                if let Some(object) = body.as_object_mut() {
                    object.remove("tools");
                    object.remove("functions");
                    object.remove("tool_choice");
                }
            }
        }
        mapping
    }
    fn rename(&self, value: &mut Value) {
        if let Some(name) = value["name"].as_str() {
            if let Some((alias, _)) = self.original.iter().find(|(_, n)| *n == name) {
                value["name"] = json!(alias);
            }
        }
    }
    pub(super) fn wrap(self, mut response: StreamResponse) -> StreamResponse {
        if self.original.is_empty() {
            return response;
        }
        response.stream = Box::pin(response.stream.map(move |chunk| {
            chunk.map(|mut chunk| {
                if let Some(name) = chunk.tool_call.as_mut().and_then(|c| c.name.as_mut()) {
                    if let Some(original) = self.original.get(name) {
                        *name = original.clone();
                    }
                }
                chunk
            })
        }));
        response
    }
}

fn schema(value: &mut Value) {
    if value == &Value::Bool(true) {
        *value = json!({});
        return;
    }
    if value == &Value::Bool(false) {
        *value = json!({"not":{}});
        return;
    }
    let Some(object) = value.as_object_mut() else {
        *value = json!({});
        return;
    };
    if let Some(kind) = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
    {
        if [
            "object", "array", "string", "number", "integer", "boolean", "null",
        ]
        .contains(&kind.as_str())
        {
            object.insert("type".into(), json!(kind));
        } else {
            object.remove("type");
        }
    }
    if object.get("required").is_some_and(|v| !v.is_array()) {
        object.remove("required");
    }
    if let Some(pattern) = object.get_mut("pattern") {
        if let Some(text) = pattern.as_str() {
            *pattern = json!(text.replace("\\0", "\\u0000"));
        }
    }
    if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
        for property in properties.values_mut() {
            schema(property);
        }
    }
    for key in [
        "additionalProperties",
        "contains",
        "not",
        "if",
        "then",
        "else",
    ] {
        if let Some(child) = object.get_mut(key) {
            if child.is_object() {
                schema(child);
            }
        }
    }
    if let Some(items) = object.get_mut("items") {
        if let Some(tuple) = items.as_array() {
            *items = json!({"anyOf":tuple});
        }
        schema(items);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = object.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                schema(item);
            }
        }
    }
    if let Some(values) = object.get("enum").and_then(Value::as_array) {
        if values.is_empty() {
            object.remove("enum");
        } else if !object.contains_key("type") {
            let kind = if values.iter().all(Value::is_string) {
                Some("string")
            } else if values.iter().all(Value::is_number) {
                Some("number")
            } else if values.iter().all(Value::is_boolean) {
                Some("boolean")
            } else {
                None
            };
            if let Some(kind) = kind {
                object.insert("type".into(), json!(kind));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client() -> AIClient {
        AIClient::new(serde_json::from_value(json!({"name":"fixture","model":"auto","format":"openai","base_url":"https://copilot.tencent.com/v2","request_url":"https://copilot.tencent.com/v2/chat/completions","api_key":"synthetic","context_window":4096,"inline_think_in_text":false,"skip_ssl_verify":false})).unwrap()).with_subscription_provider(crate::subscription_auth::SubscriptionProvider::Workbuddy)
    }
    #[test]
    fn translates_tools_history_choices_and_streaming() {
        let mut body = json!({"stream":false,"max_completion_tokens":128,"messages":[{"role":"developer","content":"system"},{"role":"assistant","tool_calls":[{"function":{"name":"mcp.read"}}]}],"tools":[{"type":"function","function":{"name":"mcp.read","parameters":{"properties":{"path":{"enum":["a","b"]}}}}}],"tool_choice":{"type":"function","function":{"name":"mcp.read"}}});
        let mapping = Tools::prepare(&client(), &mut body);
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 128);
        assert!(body.get("max_completion_tokens").is_none());
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["tool_choice"], "mcp_read");
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["name"],
            "mcp_read"
        );
        assert_eq!(mapping.original["mcp_read"], "mcp.read");
    }

    #[test]
    fn object_unions_and_boolean_schemas_fit_the_gateway() {
        let mut body = json!({"messages":[{"role":"user","content":"fixture"}],"tools":[{"type":"function","function":{"name":"one","parameters":{"anyOf":[{"type":"object","properties":{"path":{"type":"String"}}},{"type":"object","properties":{"enabled":true}}]}}}]});
        Tools::prepare(&client(), &mut body);
        let parameters = &body["tools"][0]["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["path"]["type"], "string");
        assert_eq!(parameters["properties"]["enabled"], json!({}));
        assert!(parameters.get("anyOf").is_none());
        let unrelated = client()
            .with_subscription_provider(crate::subscription_auth::SubscriptionProvider::Zcode);
        let old = body.clone();
        Tools::prepare(&unrelated, &mut body);
        assert_eq!(body, old);
    }
    #[test]
    fn conversation_and_turn_headers_survive_tool_steps() {
        let client = client();
        let context = ModelRequestContext {
            prompt_cache_route_key: Some("opaque-session".into()),
            ..Default::default()
        };
        let mut body = json!({"messages":[{"role":"user","content":"synthetic prompt"}]});
        let send = |body: &Value| {
            headers(
                &client,
                client.client.post(&client.config.request_url),
                body,
                Some(&context),
            )
            .build()
            .unwrap()
        };
        let first = send(&body);
        body["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"tool","content":"result"}));
        let tool = send(&body);
        assert_eq!(
            first.headers()["x-conversation-request-id"],
            tool.headers()["x-conversation-request-id"]
        );
        body["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user","content":"next"}));
        let next = send(&body);
        assert_ne!(
            first.headers()["x-conversation-request-id"],
            next.headers()["x-conversation-request-id"]
        );
        assert_eq!(
            first.headers()["x-conversation-id"],
            next.headers()["x-conversation-id"]
        );
    }
}
