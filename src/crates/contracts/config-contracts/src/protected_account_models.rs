//! A single-document downgrade boundary for explicit subscription accounts.
//! Legacy readers retain raw model metadata but do not understand account_id.
//! Keep the original there and expose an API-key projection which cannot reach
//! a real provider or obtain a provider-default subscription credential.

use crate::{
    AIModelConfig, AuthConfig, ConfigDiagnostic, ConfigDiagnosticRecoverability,
    ConfigDiagnosticSeverity,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const ACCOUNT_MODEL_GUARD_KEY: &str = "openbitfun_subscription_account_binding";
pub const ACCOUNT_MODEL_GUARD_URL: &str = "https://subscription-accounts.openbitfun.invalid";
const GUARD_API_KEY: &str = "requires-subscription-accounts-v1";
const AUTH_BINDING_KEYS: &[&str] = &[
    "type",
    "provider",
    "plan",
    "account_id",
    "accounts",
    "revision",
];

fn model_id_counts(value: &Value) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for id in value
        .pointer("/ai/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
    {
        *counts.entry(id.to_string()).or_default() += 1;
    }
    counts
}

/// Opaque compatible-source fields survive new-version settings writes too.
/// The manager retains only these model records, not a second config document.
pub fn account_guard_sources(value: &Value) -> HashMap<String, Value> {
    value
        .pointer("/ai/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            Some((
                model.get("id")?.as_str()?.to_string(),
                guard_entry(model)?.clone(),
            ))
        })
        .collect()
}

pub fn preserve_account_guard_sources(value: &mut Value, sources: &HashMap<String, Value>) {
    if sources.is_empty() {
        return;
    }
    let id_counts = model_id_counts(value);
    let Some(models) = value
        .pointer_mut("/ai/models")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    let mut known_model_fields: std::collections::HashSet<String> =
        serde_json::to_value(AIModelConfig::default())
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
    known_model_fields.insert("reasoning".into());
    known_model_fields.insert("channel_routing".into());
    for model in models {
        let Some(source) = model
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| sources.get(id))
        else {
            continue;
        };
        // Ambiguous IDs remain wrapped instead of being decoded, so each row
        // already retains its complete opaque record. Never merge a source
        // indexed by ID into another row with the same ID.
        if model
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id_counts.get(id))
            .is_some_and(|count| *count > 1)
        {
            continue;
        }
        let Some(current) = model
            .get_mut("metadata")
            .and_then(|metadata| metadata.get_mut(ACCOUNT_MODEL_GUARD_KEY))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        if !matches!(
            current.get("version").and_then(Value::as_u64),
            Some(1 | 2 | 3)
        ) || current.get("version") != source.get("version")
        {
            continue;
        }
        let same_binding = AUTH_BINDING_KEYS.iter().all(|key| {
            let left = current
                .get("model")
                .and_then(|model| model.get("auth"))
                .and_then(|auth| auth.get(key))
                .filter(|value| !value.is_null());
            let right = source
                .get("model")
                .and_then(|model| model.get("auth"))
                .and_then(|auth| auth.get(key))
                .filter(|value| !value.is_null());
            if *key == "revision" {
                left.and_then(Value::as_u64).unwrap_or(0)
                    == right.and_then(Value::as_u64).unwrap_or(0)
            } else if *key == "accounts" {
                left.and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
                    == right
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
            } else {
                left == right
            }
        });
        if !same_binding {
            continue;
        }
        if let Some(fields) = source.as_object() {
            for (key, data) in fields {
                if key != "version" && key != "model" {
                    current.insert(key.clone(), data.clone());
                }
            }
        }
        if let Some(original) = source.get("model").and_then(Value::as_object) {
            if let Some(updated) = current.get_mut("model").and_then(Value::as_object_mut) {
                for (key, data) in original {
                    if !known_model_fields.contains(key) {
                        updated.insert(key.clone(), data.clone());
                    }
                }
                if let Some(auth) = updated.get_mut("auth").and_then(Value::as_object_mut) {
                    for (key, data) in original
                        .get("auth")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                    {
                        if !AUTH_BINDING_KEYS.contains(&key.as_str()) {
                            auth.insert(key.clone(), data.clone());
                        }
                    }
                }
                if let Some(route) = updated
                    .get_mut("channel_routing")
                    .and_then(Value::as_object_mut)
                {
                    for (key, data) in original
                        .get("channel_routing")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                    {
                        if !["version", "fallback_model_ids", "manual_channel"]
                            .contains(&key.as_str())
                        {
                            route.entry(key.clone()).or_insert_with(|| data.clone());
                        }
                    }
                }
            }
        }
    }
}

fn explicit_account(model: &Value) -> bool {
    // New subscription tags need the same downgrade boundary even when they
    // use their provider-default slot: older readers cannot parse those tags.
    // `workbuddy`/`workbuddy_ai` are retired providers, but the models an
    // earlier release wrote under those tags keep this boundary.
    model
        .get("channel_routing")
        .is_some_and(|route| !route.is_null())
        || model.pointer("/auth/type").and_then(Value::as_str) == Some("subscription_pool")
        || (model.pointer("/auth/type").and_then(Value::as_str) == Some("subscription")
            && (model
                .pointer("/auth/account_id")
                .is_some_and(|id| !id.is_null())
                || matches!(
                    model.pointer("/auth/provider").and_then(Value::as_str),
                    Some("workbuddy" | "workbuddy_ai" | "zcode" | "zcode_cn")
                )))
}

fn guard_entry(model: &Value) -> Option<&Value> {
    model.get("metadata")?.get(ACCOUNT_MODEL_GUARD_KEY)
}

/// Reject these records at runtime if their payload cannot be restored. A
/// protected export must not accidentally become a working API-key model.
pub fn is_guarded_account_model(model: &AIModelConfig) -> bool {
    model
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(ACCOUNT_MODEL_GUARD_KEY))
        .is_some()
        && model.auth == AuthConfig::ApiKey
        && (model.api_key == GUARD_API_KEY || model.base_url == ACCOUNT_MODEL_GUARD_URL)
}

fn make_projection(model: &mut Value, entry: Value) {
    let Some(fields) = model.as_object_mut() else {
        return;
    };
    let metadata = fields
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    if !metadata.is_object() {
        *metadata = Value::Object(Map::new());
    }
    metadata
        .as_object_mut()
        .unwrap()
        .insert(ACCOUNT_MODEL_GUARD_KEY.into(), entry);
    fields.insert("auth".into(), json!({"type":"api_key"}));
    fields.insert("api_key".into(), GUARD_API_KEY.into());
    fields.insert("base_url".into(), ACCOUNT_MODEL_GUARD_URL.into());
    fields.insert(
        "request_url".into(),
        format!("{ACCOUNT_MODEL_GUARD_URL}/requires-newer-openbitfun").into(),
    );
    fields.insert("custom_headers".into(), Value::Null);
    fields.insert("custom_request_body".into(), Value::Null);
    fields.remove("channel_routing");
    // Preserve enabled and capability facts so legacy reference reconciliation
    // cannot replace an explicitly selected account model with another model.
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Subscription account");
    let suffix = if entry_version_is_channel(fields) {
        " [requires channel-capable OpenBitFun]"
    } else {
        " [requires account-capable OpenBitFun]"
    };
    if !name.ends_with(suffix) {
        fields.insert("name".into(), format!("{name}{suffix}").into());
    }
}

fn entry_version_is_channel(fields: &Map<String, Value>) -> bool {
    fields
        .get("metadata")
        .and_then(|metadata| metadata.get(ACCOUNT_MODEL_GUARD_KEY))
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_u64)
        == Some(3)
}

/// Protects persisted/exported model values without changing the live DTO or
/// its approved runtime binding fingerprint. No second file or vault mutation.
pub fn protect_account_models(value: &mut Value) {
    let Some(models) = value
        .pointer_mut("/ai/models")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for model in models {
        if explicit_account(model) {
            let original = model.clone();
            let version = if model
                .get("channel_routing")
                .is_some_and(|route| !route.is_null())
            {
                3
            } else if model.pointer("/auth/type").and_then(Value::as_str)
                == Some("subscription_pool")
            {
                2
            } else {
                1
            };
            make_projection(model, json!({"version":version,"model":original}));
        } else if let Some(entry) = guard_entry(model).cloned() {
            // Unknown versions remain raw and unusable even after unrelated
            // settings writes. Never replace their retained source payload.
            if model.get("api_key").and_then(Value::as_str) == Some(GUARD_API_KEY)
                || model.get("base_url").and_then(Value::as_str) == Some(ACCOUNT_MODEL_GUARD_URL)
            {
                make_projection(model, entry);
            }
        }
    }
}

/// Restores only this codec's supported account records. Unsupported or
/// malformed source data stays in metadata behind the safe projection.
pub fn restore_account_models(value: &mut Value) -> Vec<ConfigDiagnostic> {
    let id_counts = model_id_counts(value);
    let Some(models) = value
        .pointer_mut("/ai/models")
        .and_then(Value::as_array_mut)
    else {
        return vec![];
    };
    let mut diagnostics = Vec::new();
    for (index, model) in models.iter_mut().enumerate() {
        let Some(entry) = guard_entry(model).cloned() else {
            continue;
        };
        if model.get("api_key").and_then(Value::as_str) != Some(GUARD_API_KEY)
            && model.get("base_url").and_then(Value::as_str) != Some(ACCOUNT_MODEL_GUARD_URL)
        {
            continue;
        }
        let source = entry.get("model");
        let ambiguous = model
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id_counts.get(id))
            .is_some_and(|count| *count > 1);
        let version_matches = match entry.get("version").and_then(Value::as_u64) {
            Some(1) => {
                source
                    .and_then(|model| model.pointer("/auth/type"))
                    .and_then(Value::as_str)
                    == Some("subscription")
            }
            Some(2) => {
                source
                    .and_then(|model| model.pointer("/auth/type"))
                    .and_then(Value::as_str)
                    == Some("subscription_pool")
            }
            Some(3) => source
                .and_then(|model| model.get("channel_routing"))
                .is_some_and(|route| {
                    serde_json::from_value::<crate::channel_routing::ModelChannelRouting>(
                        route.clone(),
                    )
                    .is_ok_and(|route| route.version == 1)
                }),
            _ => false,
        };
        let restorable = !ambiguous
            && version_matches
            && source.is_some_and(|source| {
                source.get("id") == model.get("id")
                    && explicit_account(source)
                    && serde_json::from_value::<AIModelConfig>(source.clone()).is_ok()
            });
        if restorable {
            *model = source.unwrap().clone();
        } else {
            make_projection(model, entry);
            diagnostics.push(ConfigDiagnostic {
                path: format!("ai.models[{index}]"),
                message: if ambiguous {
                    "Multiple models share this account binding's configuration ID; their original records were preserved and requests are blocked.".into()
                } else {
                    "This subscription account binding is unreadable or requires a newer OpenBitFun; its original data was preserved and requests are blocked.".into()
                },
                code: "SUBSCRIPTION_ACCOUNT_BINDING_UNSUPPORTED".into(),
                severity: ConfigDiagnosticSeverity::Warning,
                recoverability: ConfigDiagnosticRecoverability::None,
            });
        }
    }
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model_runtime_binding_fingerprint, GlobalConfig, SubscriptionProvider};
    use serde::{Deserialize, Serialize};

    fn config() -> Value {
        let mut config = GlobalConfig::default();
        config.ai.models = vec![AIModelConfig {
            id: "named-model".into(),
            name: "Named model".into(),
            provider: "responses".into(),
            model_name: "fixture-model".into(),
            capabilities: vec![crate::ModelCapability::TextChat],
            enabled: true,
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            request_url: Some("https://chatgpt.com/backend-api/codex/responses".into()),
            auth: AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex-account-58134808-15a6-45db-ae33-2ad7d85cc570".into()),
            },
            metadata: Some(json!({"provider_instance_id":"seat-two","future_field":{"keep":true}})),
            custom_headers: Some(std::collections::HashMap::from([(
                "Authorization".into(),
                "saved-inline-header".into(),
            )])),
            custom_request_body: Some("{\"extra\":true}".into()),
            ..AIModelConfig::default()
        }];
        config.ai.default_models.primary = Some("named-model".into());
        serde_json::to_value(config).unwrap()
    }

    // Auth and metadata behavior from the released 7ac47e655 model shape: the
    // former understands only api_key/provider-default subscription, and the
    // latter is an opaque serde_json::Value which survives settings writes.
    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum LegacyAuth {
        ApiKey,
        Subscription { provider: SubscriptionProvider },
    }

    #[test]
    fn new_subscription_defaults_survive_legacy_settings_round_trip() {
        for provider in ["workbuddy", "workbuddy_ai", "zcode", "zcode_cn"] {
            let mut original = config();
            original["ai"]["models"][0]["auth"] =
                json!({"type":"subscription","provider":provider});
            let mut persisted = original.clone();
            protect_account_models(&mut persisted);
            let outer = &persisted["ai"]["models"][0];
            assert_eq!(outer["auth"], json!({"type":"api_key"}));
            assert_eq!(outer["base_url"], ACCOUNT_MODEL_GUARD_URL);
            // An old settings writer preserves opaque metadata while changing
            // unrelated settings. The source auth cannot reach its public URL.
            let mut legacy: GlobalConfig = serde_json::from_value(persisted).unwrap();
            legacy.ai.default_models.primary = Some("named-model".into());
            let mut restored = serde_json::to_value(legacy).unwrap();
            assert!(restore_account_models(&mut restored).is_empty());
            assert_eq!(restored, original);
        }
        // Existing provider-default records keep their original on-disk shape.
        let mut old = config();
        old["ai"]["models"][0]["auth"] = json!({"type":"subscription","provider":"codex"});
        let unchanged = old.clone();
        protect_account_models(&mut old);
        assert_eq!(old, unchanged);
    }

    #[test]
    fn channel_guards_prevent_legacy_primary_substitution_and_keep_unknown_fields_on_edit() {
        let mut original = config();
        original["ai"]["models"][0]["auth"] = json!({"type":"api_key"});
        original["ai"]["models"][0]["api_key"] = json!("synthetic-primary-key");
        let mut backup = original["ai"]["models"][0].clone();
        backup["id"] = json!("backup");
        backup["api_key"] = json!("synthetic-backup-key");
        original["ai"]["models"]
            .as_array_mut()
            .unwrap()
            .push(backup);
        original["ai"]["models"][0]["channel_routing"] = json!({"version":1,"fallback_model_ids":["backup"],"manual_channel":"backup","future_option":{"keep":true}});
        let mut protected = original.clone();
        protect_account_models(&mut protected);
        let outer = &protected["ai"]["models"][0];
        assert_eq!(outer["metadata"][ACCOUNT_MODEL_GUARD_KEY]["version"], 3);
        assert!(outer.get("channel_routing").is_none());
        assert!(matches!(
            serde_json::from_value::<LegacyAuth>(outer["auth"].clone()).unwrap(),
            LegacyAuth::ApiKey
        ));
        assert_eq!(outer["base_url"], ACCOUNT_MODEL_GUARD_URL);
        assert_eq!(outer["api_key"], GUARD_API_KEY);
        let sources = account_guard_sources(&protected);
        assert!(restore_account_models(&mut protected).is_empty());
        assert_eq!(protected, original);
        let mut typed: GlobalConfig = serde_json::from_value(protected).unwrap();
        typed.ai.models[0]
            .channel_routing
            .as_mut()
            .unwrap()
            .manual_channel = Some("named-model".into());
        let mut changed = serde_json::to_value(typed).unwrap();
        protect_account_models(&mut changed);
        preserve_account_guard_sources(&mut changed, &sources);
        let retained = &changed["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"]
            ["channel_routing"];
        assert_eq!(retained["manual_channel"], "named-model");
        assert_eq!(retained["future_option"], json!({"keep":true}));
        let source = &mut changed["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"];
        source["channel_routing"]["version"] = json!(99);
        let unknown = source.clone();
        assert_eq!(restore_account_models(&mut changed).len(), 1);
        assert_eq!(
            changed["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"],
            unknown
        );
        assert_eq!(
            changed["ai"]["models"][0]["base_url"],
            ACCOUNT_MODEL_GUARD_URL
        );
    }

    #[test]
    fn legacy_auth_roundtrip_cannot_select_a_default_account_and_preserves_binding() {
        let original = config();
        let before: GlobalConfig = serde_json::from_value(original.clone()).unwrap();
        let mut persisted = original.clone();
        protect_account_models(&mut persisted);
        let model = &persisted["ai"]["models"][0];
        let old_auth: LegacyAuth = serde_json::from_value(model["auth"].clone()).unwrap();
        assert!(matches!(old_auth, LegacyAuth::ApiKey));
        assert_eq!(model["base_url"], ACCOUNT_MODEL_GUARD_URL);
        assert_eq!(model["api_key"], GUARD_API_KEY);
        assert_eq!(model["custom_headers"], Value::Null);
        assert_eq!(model["custom_request_body"], Value::Null);
        assert_eq!(model["enabled"], true);
        let mut old_write = persisted.clone();
        old_write["ai"]["models"][0]["auth"] = serde_json::to_value(old_auth).unwrap();
        old_write["app"]["auto_update"] = json!(false);
        assert!(restore_account_models(&mut old_write).is_empty());
        assert_eq!(old_write["ai"]["models"], original["ai"]["models"]);
        assert_eq!(old_write["app"]["auto_update"], false);
        let after: GlobalConfig = serde_json::from_value(old_write).unwrap();
        assert_eq!(
            model_runtime_binding_fingerprint(&before.ai.models[0]),
            model_runtime_binding_fingerprint(&after.ai.models[0])
        );
        // Legacy enabled/reference facts must remain intact. Otherwise its
        // normalizer could clear the selected model and pick another account.
        let mut legacy_projection: GlobalConfig = serde_json::from_value(persisted).unwrap();
        crate::normalization::recover_persisted_config(&mut legacy_projection);
        assert_eq!(
            legacy_projection.ai.default_models.primary.as_deref(),
            Some("named-model")
        );
        assert!(legacy_projection.ai.models[0].enabled);
    }

    #[test]
    fn default_accounts_and_unrelated_models_keep_the_existing_format() {
        let mut value = config();
        value["ai"]["models"][0]["auth"]
            .as_object_mut()
            .unwrap()
            .remove("account_id");
        let before = value.clone();
        protect_account_models(&mut value);
        assert_eq!(value, before);
        value["ai"]["models"][0]["auth"] = json!({"type":"api_key"});
        let before = value.clone();
        protect_account_models(&mut value);
        assert_eq!(value, before);
    }

    #[test]
    fn unsupported_and_corrupt_guards_preserve_source_and_remain_unusable() {
        for source in [
            json!({"version":99,"model":{"future":"keep"}}),
            json!({"version":1,"model":{"id":"wrong"}}),
        ] {
            let mut value = config();
            protect_account_models(&mut value);
            value["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY] = source.clone();
            let diagnostics = restore_account_models(&mut value);
            assert_eq!(
                diagnostics[0].code,
                "SUBSCRIPTION_ACCOUNT_BINDING_UNSUPPORTED"
            );
            protect_account_models(&mut value);
            assert_eq!(
                value["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY],
                source
            );
            let model: AIModelConfig =
                serde_json::from_value(value["ai"]["models"][0].clone()).unwrap();
            assert!(is_guarded_account_model(&model));
            assert!(crate::conversion::AIConfig::try_from(model)
                .unwrap_err()
                .contains("account-capable"));
        }
    }

    #[test]
    fn ambiguous_model_ids_never_merge_or_discard_distinct_source_records() {
        let mut value = config();
        let mut duplicate = value["ai"]["models"][0].clone();
        duplicate["name"] = json!("Different model with same ID");
        value["ai"]["models"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        protect_account_models(&mut value);
        for (index, model) in value["ai"]["models"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            model["metadata"][ACCOUNT_MODEL_GUARD_KEY]["future"] = json!(index);
        }
        let sources = account_guard_sources(&value);
        let before: Vec<_> = value["ai"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| guard_entry(model).unwrap().clone())
            .collect();
        assert_eq!(restore_account_models(&mut value).len(), 2);
        let typed: GlobalConfig = serde_json::from_value(value).unwrap();
        let mut rewritten = serde_json::to_value(typed).unwrap();
        protect_account_models(&mut rewritten);
        preserve_account_guard_sources(&mut rewritten, &sources);
        for (index, model) in rewritten["ai"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(guard_entry(model).unwrap(), &before[index]);
        }
    }

    #[test]
    fn account_pools_use_version_two_and_roundtrip_without_legacy_default_auth() {
        let mut value = config();
        value["ai"]["models"][0]["auth"] = json!({"type":"subscription_pool","provider":"codex","accounts":["codex","codex-account-58134808-15a6-45db-ae33-2ad7d85cc570"],"revision":2});
        let original = value.clone();
        protect_account_models(&mut value);
        assert_eq!(
            value["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["version"],
            2
        );
        let old_auth: LegacyAuth =
            serde_json::from_value(value["ai"]["models"][0]["auth"].clone()).unwrap();
        assert!(matches!(old_auth, LegacyAuth::ApiKey));
        assert!(restore_account_models(&mut value).is_empty());
        assert_eq!(value, original);
    }
}
