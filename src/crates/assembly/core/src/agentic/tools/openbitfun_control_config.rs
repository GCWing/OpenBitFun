//! Shared, config-backed OpenBitFun product control.
//!
//! Product surfaces may provide extra adapters for presentation and native
//! providers, but ordinary OpenBitFun settings are owned by the shared
//! [`ConfigService`]. Keeping their read/write behavior here lets Desktop,
//! CLI, and other headless product hosts execute the same catalog handlers.

use crate::service::config::types::{GlobalConfig, MemoriesConfig};
use crate::service::config::ConfigService;
use openbitfun_product_domains::product_control::{
    catalog as product_control_catalog, inspect_contract, validate_option_value, ProductCapability,
    ProductCapabilityOption, ProductCapabilityOptionHandler, ProductControlDeliveryProfile,
    ProductControlRequest,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::service::config::get_global_config_service;

static GLOBAL_SHARED_PRODUCT_CONTROL_EXECUTOR: tokio::sync::OnceCell<
    Arc<SharedProductControlExecutor>,
> = tokio::sync::OnceCell::const_new();

/// One process-level executor for product settings owned by [`ConfigService`].
///
/// CLI Agent calls, the CLI product itself, and CLI Peer HostInvoke all use
/// this exact handler. Product surfaces may wrap the outcome for transport or
/// audit purposes, but they must not reimplement validation, mutation,
/// serialization, revision ordering, or read-back.
pub struct SharedProductControlExecutor {
    config_service: Arc<ConfigService>,
    mutation_lock: tokio::sync::Mutex<()>,
    revision: AtomicU64,
}

impl SharedProductControlExecutor {
    pub fn new(config_service: Arc<ConfigService>) -> Self {
        Self {
            config_service,
            mutation_lock: tokio::sync::Mutex::new(()),
            revision: AtomicU64::new(0),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    /// Inspect the effective settings and runtime availability for one
    /// capability on a headless/shared-config product host.
    pub async fn inspect(
        &self,
        capability_id: &str,
        delivery_profile: ProductControlDeliveryProfile,
    ) -> Result<Value, String> {
        let capability = openbitfun_product_domains::product_control::capability(capability_id)?;
        let mut result = inspect_contract(capability_id)?;
        let object = result
            .as_object_mut()
            .ok_or_else(|| "Product-control inspection was not an object".to_string())?;

        let mut current_values = Map::new();
        let mut shared_option_ids = Vec::new();
        let mut host_option_ids = Vec::new();
        for option in &capability.options {
            match read_config_backed_option(&self.config_service, option).await {
                Ok(Some(value)) => {
                    shared_option_ids.push(option.id.clone());
                    current_values.insert(option.id.clone(), value);
                }
                Ok(None) => {
                    host_option_ids.push(option.id.clone());
                    current_values.insert(
                        option.id.clone(),
                        json!({
                            "availability": "unavailable",
                            "reason": "This option requires a native provider on the executing product host",
                        }),
                    );
                }
                Err(error) => {
                    shared_option_ids.push(option.id.clone());
                    current_values.insert(
                        option.id.clone(),
                        json!({ "availability": "degraded", "reason": error }),
                    );
                }
            }
        }

        let profile_label = match delivery_profile {
            ProductControlDeliveryProfile::Desktop => "desktop",
            ProductControlDeliveryProfile::Cli => "cli",
            ProductControlDeliveryProfile::Peer => "peer",
            ProductControlDeliveryProfile::RemoteControl => "remoteControl",
            ProductControlDeliveryProfile::DetachedDispatch => "detachedDispatch",
        };
        let operation_ids: Vec<&str> = capability
            .operations
            .iter()
            .map(|operation| operation.id.as_str())
            .collect();
        let operation_availability: Map<String, Value> = operation_ids
            .iter()
            .map(|operation_id| {
                let definition_id = format!("{capability_id}:operation:{operation_id}");
                let declared_availability =
                    openbitfun_product_domains::product_control::ProductControlRegistry::global()
                        .definition(&definition_id)
                        .ok()
                        .and_then(|definition| definition.availability.get(&delivery_profile));
                (
                    (*operation_id).to_string(),
                    json!({
                        "status": "unavailable",
                        "deliveryProfile": profile_label,
                        "declaredAvailable": declared_availability.is_some_and(|value| value.available),
                        "requiredCapabilities": declared_availability
                            .map(|value| value.required_capabilities.as_slice())
                            .unwrap_or_default(),
                        "reason": "The shared-config product host has no native product-operation adapter",
                    }),
                )
            })
            .collect();

        object.insert(
            "currentOptionValues".to_string(),
            Value::Object(current_values),
        );
        object.insert(
            "catalogDigest".to_string(),
            Value::String(product_control_catalog()?.digest.clone()),
        );
        object.insert("revision".to_string(), Value::from(self.revision()));
        object.insert(
            "operationAvailability".to_string(),
            Value::Object(operation_availability),
        );
        object.insert(
            "controlAvailability".to_string(),
            json!({
                "status": if shared_option_ids.is_empty() { "unavailable" } else { "available" },
                "adapter": "shared-config",
                "contractAvailable": true,
                "deliveryProfile": profile_label,
                "readBack": !shared_option_ids.is_empty(),
                "actions": {
                    "get": { "status": "available" },
                    "configure": {
                        "status": if shared_option_ids.is_empty() { "unavailable" } else { "available" },
                        "optionIds": shared_option_ids,
                        "requiresHostOptionIds": host_option_ids,
                    },
                    "open": {
                        "status": "unavailable",
                        "reason": "This product host has no live presentation adapter",
                    },
                    "execute": {
                        "status": "unavailable",
                        "operationIds": operation_ids,
                        "reason": "This product host has no native product-operation adapter",
                    },
                },
            }),
        );
        Ok(result)
    }

    /// Execute the shared config-backed configure command and return the
    /// effective persisted value. Host-native provider options are rejected
    /// explicitly; callers must never emulate them on another machine.
    pub async fn configure(&self, request: &ProductControlRequest) -> Result<Value, String> {
        let _mutation = self.mutation_lock.lock().await;
        let capability_id = request
            .capability_id
            .as_deref()
            .ok_or_else(|| "capability_id is required".to_string())?;
        let option_id = request
            .option_id
            .as_deref()
            .ok_or_else(|| "option_id is required".to_string())?;
        let value = request
            .value
            .as_ref()
            .ok_or_else(|| "value is required".to_string())?;
        let capability = openbitfun_product_domains::product_control::capability(capability_id)?;
        let option = capability
            .options
            .iter()
            .find(|option| option.id == option_id)
            .ok_or_else(|| format!("Unknown option for {capability_id}: {option_id}"))?;
        let applied = configure_config_backed_option(&self.config_service, option, value)
            .await?
            .ok_or_else(|| {
                format!(
                    "Option {capability_id}:{option_id} requires a native provider on the executing product host"
                )
            })?;
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        Ok(json!({
            "catalogDigest": product_control_catalog()?.digest.clone(),
            "capabilityId": capability_id,
            "optionId": option_id,
            "configured": true,
            "effectiveValue": applied.effective_value,
            "changedPath": applied.changed_path.clone(),
            "changedPaths": [applied.changed_path],
            "revision": revision,
            "adapter": "shared-config",
            "readBack": true,
        }))
    }

    /// Compatibility translation for an existing GUI/Peer ConfigAPI write.
    /// Controlled paths are validated against every affected ProductControl
    /// option and share this executor's serialization and revision sequence.
    /// Unknown internal paths remain writable for upgrade compatibility, but
    /// they are never discoverable through ProductControl.
    pub async fn configure_legacy_path(&self, path: &str, value: Value) -> Result<Value, String> {
        let _mutation = self.mutation_lock.lock().await;
        let applied = apply_legacy_config_mutation(&self.config_service, path, value).await?;
        let revision = if applied.changed {
            self.revision.fetch_add(1, Ordering::AcqRel) + 1
        } else {
            self.revision.load(Ordering::Acquire)
        };
        Ok(json!({
            "catalogDigest": product_control_catalog()?.digest.clone(),
            "configured": true,
            "changedPath": applied.changed_path.clone(),
            "changedPaths": if applied.changed { vec![applied.changed_path] } else { vec![] },
            "controlledBindings": applied.controlled_bindings,
            "effectiveValue": applied.effective_value,
            "revision": revision,
            "adapter": "shared-config-compatibility",
            "readBack": true,
        }))
    }
}

pub async fn global_shared_product_control_executor(
) -> Result<Arc<SharedProductControlExecutor>, String> {
    GLOBAL_SHARED_PRODUCT_CONTROL_EXECUTOR
        .get_or_try_init(|| async {
            get_global_config_service()
                .await
                .map(SharedProductControlExecutor::new)
                .map(Arc::new)
                .map_err(|error| error.to_string())
        })
        .await
        .cloned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppliedProductConfigOption {
    pub changed_path: String,
    pub effective_value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductConfigBinding {
    pub capability_id: String,
    pub option_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppliedLegacyProductConfig {
    pub changed: bool,
    pub changed_path: String,
    pub effective_value: Value,
    pub controlled_bindings: Vec<ProductConfigBinding>,
}

fn read_nested_value<'a>(value: &'a Value, field: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in field.split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn set_nested_value(value: &mut Value, field: &str, next_value: Value) -> Result<(), String> {
    let segments: Vec<&str> = field
        .split('.')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some((last, parents)) = segments.split_last() else {
        return Err("A product-control config field cannot be empty".to_string());
    };
    let mut current = value;
    for segment in parents {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        current = current
            .as_object_mut()
            .expect("object was initialized")
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    current
        .as_object_mut()
        .expect("object was initialized")
        .insert((*last).to_string(), next_value);
    Ok(())
}

fn validate_config_semantics(path: &str, value: &Value) -> Result<(), String> {
    if path == "memories" {
        let memories: MemoriesConfig = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid memory settings: {error}"))?;
        if memories.max_rollout_age_days > memories.max_unused_days {
            return Err("Memory rollout age must not exceed unused-memory retention".to_string());
        }
    }
    Ok(())
}

fn paths_overlap(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('.'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

pub fn config_handler_path(option: &ProductCapabilityOption) -> Option<&str> {
    match &option.handler {
        ProductCapabilityOptionHandler::Config { path }
        | ProductCapabilityOptionHandler::MergeConfig { path, .. } => Some(path),
        ProductCapabilityOptionHandler::AppearanceSelection => Some("appearance.selection"),
        ProductCapabilityOptionHandler::Language => Some("app.language"),
        ProductCapabilityOptionHandler::FlowChatPermissionModeControl => {
            Some("app.flow_chat.show_permission_mode_control")
        }
        ProductCapabilityOptionHandler::Provider { .. } => None,
    }
}

pub fn exact_config_binding(
    path: &str,
) -> Result<Option<(&'static ProductCapability, &'static ProductCapabilityOption)>, String> {
    let mut matched = None;
    for capability in &product_control_catalog()?.capabilities {
        for option in &capability.options {
            if config_handler_path(option) == Some(path) {
                if matched.is_some() {
                    return Ok(None);
                }
                matched = Some((capability, option));
            }
        }
    }
    Ok(matched)
}

fn requested_handler_value<'a>(
    request_path: &str,
    request_value: &'a Value,
    handler_path: &str,
) -> Option<&'a Value> {
    if request_path == handler_path {
        return Some(request_value);
    }
    let suffix = handler_path.strip_prefix(request_path)?.strip_prefix('.')?;
    read_nested_value(request_value, suffix)
}

fn validate_legacy_option_value(
    request_path: &str,
    request_value: &Value,
    option: &ProductCapabilityOption,
) -> Result<(), String> {
    let Some(handler_path) = config_handler_path(option) else {
        return Ok(());
    };
    let Some(handler_value) = requested_handler_value(request_path, request_value, handler_path)
    else {
        // A narrower compatibility mutation is validated by the typed
        // GlobalConfig deserializer in ConfigService. The common product UI
        // does not currently write below a scalar product-control option.
        return Ok(());
    };
    match &option.handler {
        ProductCapabilityOptionHandler::MergeConfig { fields, .. } => {
            let values: Vec<&Value> = fields
                .iter()
                .filter_map(|field| read_nested_value(handler_value, field))
                .collect();
            if values.is_empty() {
                return Ok(());
            }
            for value in &values {
                validate_option_value(&option.value_schema, value)?;
            }
            if values.len() > 1 && values.windows(2).any(|pair| pair[0] != pair[1]) {
                return Err(format!(
                    "Legacy config mutation would split the unified option {} across incompatible fields",
                    option.id
                ));
            }
            Ok(())
        }
        _ => validate_option_value(&option.value_schema, handler_value),
    }
}

/// Resolve every public option affected by a legacy Config API write and
/// validate it against the same typed schema used by OpenBitFunControl.
///
/// The result is also the compatibility translation record used by Desktop
/// auditing. Unknown internal config remains writable for upgrade
/// compatibility but is never surfaced to Agent discovery.
pub fn validate_legacy_config_mutation(
    path: &str,
    value: &Value,
) -> Result<Vec<ProductConfigBinding>, String> {
    let mut bindings = Vec::new();
    for capability in &product_control_catalog()?.capabilities {
        for option in &capability.options {
            let Some(handler_path) = config_handler_path(option) else {
                continue;
            };
            if !paths_overlap(path, handler_path) {
                continue;
            }
            validate_legacy_option_value(path, value, option).map_err(|error| {
                format!(
                    "Invalid product-control value for {}:{} through legacy config path {path}: {error}",
                    capability.id, option.id
                )
            })?;
            bindings.push(ProductConfigBinding {
                capability_id: capability.id.clone(),
                option_id: option.id.clone(),
            });
        }
    }
    Ok(bindings)
}

/// Compatibility entry point for existing GUI settings that still submit a
/// config path. It performs the same product schema and semantic validation as
/// Agent configure before committing through the shared ConfigService owner.
pub async fn apply_legacy_config_mutation(
    config_service: &ConfigService,
    path: &str,
    value: Value,
) -> Result<AppliedLegacyProductConfig, String> {
    let controlled_bindings = validate_legacy_config_mutation(path, &value)?;
    validate_config_semantics(path, &value)?;
    let changed = config_service
        .set_config_if_changed(path, value)
        .await
        .map_err(|error| error.to_string())?;
    let effective_value = config_service
        .get_config(Some(path))
        .await
        .map_err(|error| error.to_string())?;
    Ok(AppliedLegacyProductConfig {
        changed,
        changed_path: path.to_string(),
        effective_value,
        controlled_bindings,
    })
}

/// Read an option implemented by the shared OpenBitFun configuration service.
///
/// `Ok(None)` means the semantic catalog deliberately routed the option to a
/// product-host provider instead of shared config.
pub async fn read_config_backed_option(
    config_service: &ConfigService,
    option: &ProductCapabilityOption,
) -> Result<Option<Value>, String> {
    let value = match &option.handler {
        ProductCapabilityOptionHandler::Config { path } => config_service
            .get_config(Some(path))
            .await
            .map_err(|error| error.to_string())?,
        ProductCapabilityOptionHandler::MergeConfig { path, fields } => {
            let current: Value = config_service
                .get_config(Some(path))
                .await
                .map_err(|error| error.to_string())?;
            let values: Vec<Value> = fields
                .iter()
                .map(|field| {
                    read_nested_value(&current, field)
                        .cloned()
                        .unwrap_or(Value::Null)
                })
                .collect();
            if values.len() == 1 || values.windows(2).all(|pair| pair[0] == pair[1]) {
                values.into_iter().next().unwrap_or(Value::Null)
            } else {
                Value::Object(fields.iter().cloned().zip(values).collect::<Map<_, _>>())
            }
        }
        ProductCapabilityOptionHandler::AppearanceSelection => config_service
            .get_config(Some("appearance.selection"))
            .await
            .map_err(|error| error.to_string())?,
        ProductCapabilityOptionHandler::Language => config_service
            .get_config(Some("app.language"))
            .await
            .map_err(|error| error.to_string())?,
        ProductCapabilityOptionHandler::FlowChatPermissionModeControl => {
            let config: GlobalConfig = config_service
                .get_config(None)
                .await
                .map_err(|error| error.to_string())?;
            Value::Bool(config.app.flow_chat.show_permission_mode_control)
        }
        ProductCapabilityOptionHandler::Provider { .. } => return Ok(None),
    };
    Ok(Some(value))
}

/// Apply an option implemented by the shared OpenBitFun configuration service and
/// read the persisted effective value back through the same handler.
///
/// `Ok(None)` means a product-host provider owns the option.
pub async fn configure_config_backed_option(
    config_service: &ConfigService,
    option: &ProductCapabilityOption,
    value: &Value,
) -> Result<Option<AppliedProductConfigOption>, String> {
    validate_option_value(&option.value_schema, value)?;
    let changed_path = match &option.handler {
        ProductCapabilityOptionHandler::Config { path } => {
            config_service
                .set_config(path, value.clone())
                .await
                .map_err(|error| error.to_string())?;
            path.clone()
        }
        ProductCapabilityOptionHandler::MergeConfig { path, fields } => {
            let mut current: Value = config_service
                .get_config(Some(path))
                .await
                .map_err(|error| error.to_string())?;
            for field in fields {
                set_nested_value(&mut current, field, value.clone())?;
            }
            validate_config_semantics(path, &current)?;
            config_service
                .set_config(path, current)
                .await
                .map_err(|error| error.to_string())?;
            path.clone()
        }
        ProductCapabilityOptionHandler::AppearanceSelection => {
            config_service
                .set_config("appearance.selection", value.clone())
                .await
                .map_err(|error| error.to_string())?;
            "appearance.selection".to_string()
        }
        ProductCapabilityOptionHandler::Language => {
            config_service
                .set_config("app.language", value.clone())
                .await
                .map_err(|error| error.to_string())?;
            "app.language".to_string()
        }
        ProductCapabilityOptionHandler::FlowChatPermissionModeControl => {
            config_service
                .set_config("app.flow_chat.show_permission_mode_control", value.clone())
                .await
                .map_err(|error| error.to_string())?;
            "app.flow_chat.show_permission_mode_control".to_string()
        }
        ProductCapabilityOptionHandler::Provider { .. } => return Ok(None),
    };
    let effective_value = read_config_backed_option(config_service, option)
        .await?
        .ok_or_else(|| "Shared config option unexpectedly became provider-backed".to_string())?;
    Ok(Some(AppliedProductConfigOption {
        changed_path,
        effective_value,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::PathManager;
    use crate::service::config::types::GlobalConfig;
    use crate::service::config::{ConfigManagerSettings, ConfigService};
    use openbitfun_product_domains::product_control::{
        capability as product_capability, catalog, ProductControlAction, ProductControlSource,
        ProductControlValueSchema, ProductControlValueType,
    };
    use std::sync::Arc;

    async fn test_service(name: &str) -> (ConfigService, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(dir.path().join(name)));
        let service = ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .expect("config service");
        (service, dir)
    }

    fn writable_samples(schema: &ProductControlValueSchema, current: Option<&Value>) -> Vec<Value> {
        let mut samples = Vec::new();
        if let Some(values) = &schema.r#enum {
            samples.extend(values.iter().cloned());
        }
        match schema.value_type {
            ProductControlValueType::Boolean => {
                samples.push(Value::Bool(true));
                samples.push(Value::Bool(false));
            }
            ProductControlValueType::String => samples.push(Value::String(
                "x".repeat(schema.min_length.unwrap_or(1).max(1)),
            )),
            ProductControlValueType::Integer => {
                samples.push(Value::from(schema.minimum.unwrap_or(1.0).ceil() as i64));
                if let Some(maximum) = schema.maximum {
                    samples.push(Value::from(maximum.floor() as i64));
                }
            }
            ProductControlValueType::Number => {
                samples.push(Value::from(schema.minimum.unwrap_or(1.0)));
                if let Some(maximum) = schema.maximum {
                    samples.push(Value::from(maximum));
                }
            }
            ProductControlValueType::Object => samples.push(serde_json::json!({})),
            ProductControlValueType::Array => samples.push(serde_json::json!([])),
        }
        if schema.nullable {
            samples.push(Value::Null);
        }
        if let Some(current) = current {
            samples.push(current.clone());
        }
        samples.retain(|sample| validate_option_value(schema, sample).is_ok());
        samples.dedup();
        samples
    }

    fn assert_config_binding(root: &Value, path: &str, schema: &ProductControlValueSchema) {
        let current = read_nested_value(root, path);
        if let Some(current) = current {
            assert!(
                validate_option_value(schema, current).is_ok(),
                "default value at {path} does not satisfy its product-control schema: {current}"
            );
        }

        let samples = writable_samples(schema, current);
        for sample in &samples {
            let mut candidate = root.clone();
            set_nested_value(&mut candidate, path, sample.clone()).unwrap();
            let Ok(typed) = serde_json::from_value::<GlobalConfig>(candidate) else {
                continue;
            };
            let serialized = serde_json::to_value(typed).unwrap();
            if read_nested_value(&serialized, path) == Some(sample) {
                return;
            }
        }
        panic!(
            "product-control config path is not consumed by typed GlobalConfig: {path}; valid samples: {samples:?}"
        );
    }

    #[tokio::test]
    async fn config_handler_round_trips_through_the_shared_service() {
        let (service, _dir) = test_service("product-control-round-trip").await;
        let capability = product_capability("setting.tools.execution").unwrap();
        let option = capability
            .options
            .iter()
            .find(|option| option.id == "deferred-tool-loading")
            .unwrap();

        let applied = configure_config_backed_option(&service, option, &Value::Bool(false))
            .await
            .unwrap()
            .expect("config-backed option");
        assert_eq!(applied.changed_path, "ai.enable_deferred_tool_loading");
        assert_eq!(applied.effective_value, Value::Bool(false));
        assert_eq!(
            read_config_backed_option(&service, option).await.unwrap(),
            Some(Value::Bool(false))
        );
    }

    #[tokio::test]
    async fn shared_executor_orders_typed_and_legacy_callers_in_one_revision_stream() {
        let (service, _dir) = test_service("product-control-shared-executor").await;
        let executor = SharedProductControlExecutor::new(Arc::new(service));
        let typed = executor
            .configure(&ProductControlRequest {
                action: ProductControlAction::Configure,
                query: None,
                capability_id: Some("setting.tools.execution".to_string()),
                item_id: None,
                operation_id: None,
                option_id: Some("deferred-tool-loading".to_string()),
                arguments: None,
                value: Some(Value::Bool(false)),
                cursor: None,
                limit: None,
                source: ProductControlSource::Agent,
            })
            .await
            .expect("typed configure");
        let legacy = executor
            .configure_legacy_path("ai.enable_deferred_tool_loading", Value::Bool(true))
            .await
            .expect("legacy configure");

        assert_eq!(typed["revision"], 1);
        assert_eq!(legacy["revision"], 2);
        assert_eq!(executor.revision(), 2);
        assert_eq!(legacy["effectiveValue"], Value::Bool(true));
        assert_eq!(
            legacy["controlledBindings"][0]["optionId"],
            "deferred-tool-loading"
        );
    }

    #[tokio::test]
    async fn every_catalog_config_option_is_readable_from_default_config() {
        let (service, _dir) = test_service("product-control-default-readback").await;
        for option in catalog()
            .unwrap()
            .capabilities
            .iter()
            .flat_map(|capability| &capability.options)
        {
            if matches!(
                option.handler,
                ProductCapabilityOptionHandler::Provider { .. }
            ) {
                continue;
            }
            let value = read_config_backed_option(&service, option)
                .await
                .unwrap_or_else(|error| panic!("{} is unreadable: {error}", option.id));
            assert!(
                value.is_some(),
                "{} unexpectedly requires a host",
                option.id
            );
        }
    }

    #[tokio::test]
    async fn every_catalog_config_option_can_be_applied_and_read_back() {
        let (service, _dir) = test_service("product-control-all-options-round-trip").await;
        for capability in &catalog().unwrap().capabilities {
            for option in &capability.options {
                if matches!(
                    option.handler,
                    ProductCapabilityOptionHandler::Provider { .. }
                ) {
                    continue;
                }
                let current = read_config_backed_option(&service, option)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "{}.{} initial read failed: {error}",
                            capability.id, option.id
                        )
                    })
                    .unwrap_or_else(|| {
                        panic!(
                            "{}.{} unexpectedly requires a host",
                            capability.id, option.id
                        )
                    });
                let candidates = writable_samples(&option.value_schema, Some(&current));
                let mut failures = Vec::new();
                let mut applied = false;
                for candidate in candidates {
                    match configure_config_backed_option(&service, option, &candidate).await {
                        Ok(Some(result)) if result.effective_value == candidate => {
                            applied = true;
                            break;
                        }
                        Ok(Some(result)) => failures.push(format!(
                            "{candidate} read back as {}",
                            result.effective_value
                        )),
                        Ok(None) => {
                            failures.push(format!("{candidate} unexpectedly required host"))
                        }
                        Err(error) => failures.push(format!("{candidate}: {error}")),
                    }
                }
                assert!(
                    applied,
                    "{}.{} has no shared config value that round-trips: {}",
                    capability.id,
                    option.id,
                    failures.join("; ")
                );
            }
        }
    }

    #[tokio::test]
    async fn gui_config_adapter_and_agent_option_adapter_are_differentially_equivalent() {
        let (agent_service, _agent_dir) = test_service("product-control-agent-adapter").await;
        let (gui_service, _gui_dir) = test_service("product-control-gui-adapter").await;

        for capability in &catalog().unwrap().capabilities {
            for option in &capability.options {
                if matches!(
                    option.handler,
                    ProductCapabilityOptionHandler::Provider { .. }
                ) {
                    continue;
                }
                let current = read_config_backed_option(&agent_service, option)
                    .await
                    .unwrap()
                    .expect("shared option");
                let candidate = writable_samples(&option.value_schema, Some(&current))
                    .into_iter()
                    .find(|candidate| candidate != &current)
                    .unwrap_or(current);

                configure_config_backed_option(&agent_service, option, &candidate)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "Agent adapter failed for {}:{}: {error}",
                            capability.id, option.id
                        )
                    })
                    .expect("shared option");

                let (path, legacy_value) = match &option.handler {
                    ProductCapabilityOptionHandler::Config { path } => {
                        (path.clone(), candidate.clone())
                    }
                    ProductCapabilityOptionHandler::MergeConfig { path, fields } => {
                        let mut parent: Value = gui_service
                            .get_config(Some(path))
                            .await
                            .expect("GUI parent config");
                        for field in fields {
                            set_nested_value(&mut parent, field, candidate.clone()).unwrap();
                        }
                        (path.clone(), parent)
                    }
                    ProductCapabilityOptionHandler::AppearanceSelection => {
                        ("appearance.selection".to_string(), candidate.clone())
                    }
                    ProductCapabilityOptionHandler::Language => {
                        ("app.language".to_string(), candidate.clone())
                    }
                    ProductCapabilityOptionHandler::FlowChatPermissionModeControl => (
                        "app.flow_chat.show_permission_mode_control".to_string(),
                        candidate.clone(),
                    ),
                    ProductCapabilityOptionHandler::Provider { .. } => unreachable!(),
                };
                let applied = apply_legacy_config_mutation(&gui_service, &path, legacy_value)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "GUI adapter failed for {}:{} through {path}: {error}",
                            capability.id, option.id
                        )
                    });
                assert!(applied.controlled_bindings.iter().any(|binding| {
                    binding.capability_id == capability.id && binding.option_id == option.id
                }));

                let mut agent_root: Value = agent_service.get_config(None).await.unwrap();
                let mut gui_root: Value = gui_service.get_config(None).await.unwrap();
                // Each isolated ConfigService owns its own commit timestamp;
                // product state and side-effect inputs must otherwise match.
                agent_root.as_object_mut().unwrap().remove("last_modified");
                gui_root.as_object_mut().unwrap().remove("last_modified");
                assert_eq!(
                    agent_root, gui_root,
                    "GUI and Agent diverged after {}:{}",
                    capability.id, option.id
                );
            }
        }
    }

    #[test]
    fn every_catalog_config_option_binds_to_typed_global_config() {
        let root = serde_json::to_value(GlobalConfig::default()).unwrap();
        for option in catalog()
            .unwrap()
            .capabilities
            .iter()
            .flat_map(|capability| &capability.options)
        {
            match &option.handler {
                ProductCapabilityOptionHandler::Config { path } => {
                    assert_config_binding(&root, path, &option.value_schema);
                }
                ProductCapabilityOptionHandler::MergeConfig { path, fields } => {
                    for field in fields {
                        assert_config_binding(
                            &root,
                            &format!("{path}.{field}"),
                            &option.value_schema,
                        );
                    }
                    let current = read_nested_value(&root, path)
                        .unwrap_or_else(|| panic!("product-control merge path is absent: {path}"));
                    validate_config_semantics(path, current).unwrap();
                }
                ProductCapabilityOptionHandler::AppearanceSelection => {
                    assert_config_binding(&root, "appearance.selection", &option.value_schema);
                }
                ProductCapabilityOptionHandler::Language => {
                    assert_config_binding(&root, "app.language", &option.value_schema);
                }
                ProductCapabilityOptionHandler::FlowChatPermissionModeControl => {
                    let current = Value::Bool(
                        GlobalConfig::default()
                            .app
                            .flow_chat
                            .show_permission_mode_control,
                    );
                    assert!(validate_option_value(&option.value_schema, &current).is_ok());
                }
                ProductCapabilityOptionHandler::Provider { .. } => {}
            }
        }
    }
}
