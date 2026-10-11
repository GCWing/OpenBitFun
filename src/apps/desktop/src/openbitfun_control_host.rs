//! Desktop adapter for the platform-agnostic OpenBitFun product-control port.
//!
//! Discovery and contract lookup run in the product-domain owner. This adapter
//! owns concrete Desktop state reads/mutations and delegates only presentation
//! actions (navigation/product actions) to the Web UI surface.

mod miniapps;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use openbitfun_core::agentic::tools::openbitfun_control_config::{
    apply_legacy_config_mutation, config_handler_path, configure_config_backed_option,
    exact_config_binding, read_config_backed_option, ProductConfigBinding,
};
use openbitfun_core::agentic::tools::openbitfun_control_host::{
    set_openbitfun_control_port, OpenBitFunControlHostRequest, ProductControlAction,
    ProductControlPort, ProductControlSource,
};
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::service::config::types::{AIExperienceConfig, AgentCompanionPetSelection};
use openbitfun_product_domains::product_control::{
    capability as product_capability, inspect_contract, validate_open_target,
    validate_operation_arguments, validate_option_value, ProductCapabilityOperationHandler,
    ProductCapabilityOption, ProductCapabilityOptionHandler, ProductControlRisk,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tokio::sync::oneshot;

use crate::api::app_state::AppState;
use crate::api::commands::{
    delete_agent_companion_pet_package_impl, import_agent_companion_pet_package_impl,
    list_agent_companion_pets_impl, AgentCompanionPetPackageDto,
};

const OPENBITFUN_CONTROL_REQUEST_EVENT: &str = "agentic://openbitfun-control-request";
const OPENBITFUN_CONTROL_APPLIED_EVENT: &str = "agentic://openbitfun-control-applied";
const OPENBITFUN_CONTROL_EFFECT_EVENT: &str = "agentic://openbitfun-control-effect";
const OPENBITFUN_CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const OPENBITFUN_CONTROL_EFFECT_TIMEOUT: Duration = Duration::from_secs(20);

type PendingResponse = oneshot::Sender<Result<Value, String>>;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_STATE_REVISION: AtomicU64 = AtomicU64::new(1);
static SURFACE_READY: AtomicBool = AtomicBool::new(false);
static CREATION_API_VERSION: AtomicU64 = AtomicU64::new(0);
static PENDING_RESPONSES: OnceLock<Mutex<HashMap<String, PendingResponse>>> = OnceLock::new();
static PRODUCT_CONTROL_TRANSACTION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn product_control_transaction() -> &'static tokio::sync::Mutex<()> {
    PRODUCT_CONTROL_TRANSACTION.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn current_revision() -> u64 {
    NEXT_STATE_REVISION
        .load(Ordering::Acquire)
        .saturating_sub(1)
}

fn commit_revision() -> u64 {
    NEXT_STATE_REVISION.fetch_add(1, Ordering::AcqRel)
}

fn pending_responses() -> &'static Mutex<HashMap<String, PendingResponse>> {
    PENDING_RESPONSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_pending_responses() -> std::sync::MutexGuard<'static, HashMap<String, PendingResponse>> {
    pending_responses()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn dispatch_surface_event(
    event_name: &str,
    mut payload: Value,
    timeout: Duration,
    purpose: &str,
) -> Result<Value, String> {
    if !SURFACE_READY.load(Ordering::Acquire) {
        return Err(
            "The Desktop product-control adapter is ready, but its Web UI navigation surface is not"
                .to_string(),
        );
    }
    let request_id = format!(
        "openbitfun-control-{}-{}",
        std::process::id(),
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = oneshot::channel();
    lock_pending_responses().insert(request_id.clone(), sender);

    let Some(payload) = payload.as_object_mut() else {
        lock_pending_responses().remove(&request_id);
        return Err(
            "OpenBitFunControl request serialization produced an invalid payload".to_string(),
        );
    };
    payload.insert("requestId".to_string(), Value::String(request_id.clone()));

    if let Err(error) = emit_global_event(BackendEvent::Custom {
        event_name: event_name.to_string(),
        payload: Value::Object(payload.clone()),
    })
    .await
    {
        lock_pending_responses().remove(&request_id);
        return Err(format!(
            "Failed to send OpenBitFunControl surface request: {error}"
        ));
    }

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("OpenBitFunControl response channel closed".to_string()),
        Err(_) => {
            lock_pending_responses().remove(&request_id);
            SURFACE_READY.store(false, Ordering::Release);
            Err(format!(
                "OpenBitFunControl timed out waiting for the active product surface to {purpose}"
            ))
        }
    }
}

async fn dispatch_surface_request(request: OpenBitFunControlHostRequest) -> Result<Value, String> {
    dispatch_surface_event(
        OPENBITFUN_CONTROL_REQUEST_EVENT,
        serde_json::to_value(request).map_err(|error| error.to_string())?,
        OPENBITFUN_CONTROL_RESPONSE_TIMEOUT,
        "complete the presentation request",
    )
    .await
}

/// Creation owns its command registry; ProductControl only supplies correlated transport.
pub(crate) async fn dispatch_creation_runtime(
    action: &str,
    command_id: Option<String>,
    arguments: Option<Value>,
) -> Result<Value, String> {
    if CREATION_API_VERSION.load(Ordering::Acquire) != 1 {
        return Err("The active frontend does not advertise Creation API v1. Restore the installed frontend before using runtime discovery or commands".into());
    }
    dispatch_surface_event(
        "agentic://creation-runtime-request",
        json!({ "action": action, "commandId": command_id, "arguments": arguments.unwrap_or_else(|| json!({})) }),
        OPENBITFUN_CONTROL_RESPONSE_TIMEOUT,
        "complete the Creation runtime request",
    )
    .await
}

async fn current_option_value(
    app: &AppHandle,
    state: &AppState,
    option: &ProductCapabilityOption,
) -> Result<Value, String> {
    if let Some(value) = read_config_backed_option(&state.config_service, option).await? {
        return Ok(value);
    }
    match &option.handler {
        ProductCapabilityOptionHandler::Provider {
            provider_id,
            option_id,
        } => match desktop_provider_option(provider_id, option_id) {
            Some(DesktopProviderOption::LaunchAtLogin) => app
                .autolaunch()
                .is_enabled()
                .map(Value::Bool)
                .map_err(|error| error.to_string()),
            Some(DesktopProviderOption::PreventSleep) => state
                .config_service
                .get_config(Some("app.prevent_sleep"))
                .await
                .map_err(|error| error.to_string()),
            None => Err(format!(
                "Product-control provider option is not registered: {provider_id}:{option_id}"
            )),
        },
        _ => Err("Shared product-control config handler did not return a value".to_string()),
    }
}

fn dto_to_selection(pet: &AgentCompanionPetPackageDto) -> AgentCompanionPetSelection {
    AgentCompanionPetSelection {
        id: pet.id.clone(),
        display_name: pet.display_name.clone(),
        description: pet.description.clone(),
        source: pet.source.clone(),
        package_path: pet.package_path.clone(),
        spritesheet_path: pet.spritesheet_path.clone(),
        spritesheet_mime_type: pet.spritesheet_mime_type.clone(),
        sprite_version_number: Some(pet.sprite_version_number),
    }
}

async fn companion_state(state: &AppState) -> Result<Value, String> {
    let imported = list_agent_companion_pets_impl(state).await?;
    let experience: AIExperienceConfig = state
        .config_service
        .get_config(Some("app.ai_experience"))
        .await
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "activePet": experience.agent_companion_pet,
        "enabled": experience.enable_agent_companion,
        "importedPets": imported.pets,
    }))
}

async fn emit_applied(
    capability_id: &str,
    operation_id: Option<&str>,
    option_id: Option<&str>,
    changed_paths: &[&str],
    value: Option<&Value>,
) -> Value {
    if !SURFACE_READY.load(Ordering::Acquire) {
        return json!({
            "status": "notAttached",
            "reason": "The persistent product state changed before a presentation surface attached",
        });
    }
    match emit_global_event(BackendEvent::Custom {
        event_name: OPENBITFUN_CONTROL_APPLIED_EVENT.to_string(),
        payload: json!({
            "capabilityId": capability_id,
            "operationId": operation_id,
            "optionId": option_id,
            "changedPaths": changed_paths,
            "value": value,
        }),
    })
    .await
    {
        Ok(()) => json!({ "status": "notified" }),
        Err(error) => {
            log::warn!(
                "Product control persisted successfully but presentation synchronization failed: {}",
                error
            );
            json!({
                "status": "degraded",
                "reason": error.to_string(),
            })
        }
    }
}

fn option_requires_presentation_commit(option: &ProductCapabilityOption) -> bool {
    matches!(
        option.handler,
        ProductCapabilityOptionHandler::AppearanceSelection
            | ProductCapabilityOptionHandler::Language
    )
}

fn config_path_invalidates_ai_client(path: &str) -> bool {
    [
        "ai.models",
        "ai.stream_idle_timeout_secs",
        "ai.stream_ttft_timeout_secs",
        "ai.proxy",
    ]
    .iter()
    .any(|owned| {
        path == *owned
            || path.starts_with(&format!("{owned}."))
            || owned.starts_with(&format!("{path}."))
    })
}

async fn apply_backend_config_effects(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    value: &Value,
) -> Result<(), String> {
    if config_path_invalidates_ai_client(path) {
        state.ai_client_factory.invalidate_cache();
        log::info!("AI config changed, cache invalidated: path={path}");
    }
    if path == "app.language" {
        let language = value
            .as_str()
            .ok_or_else(|| "The interface language must be a string".to_string())?;
        crate::api::i18n_api::apply_language_runtime_effects(app, state, language).await?;
    }
    Ok(())
}

async fn synchronize_required_effect(
    capability_id: &str,
    option_id: &str,
    changed_path: &str,
    value: &Value,
    phase: &str,
) -> Result<Value, String> {
    if !SURFACE_READY.load(Ordering::Acquire) {
        return Ok(json!({
            "status": "notAttached",
            "reason": "The product state was committed without an active presentation surface",
        }));
    }
    dispatch_surface_event(
        OPENBITFUN_CONTROL_EFFECT_EVENT,
        json!({
            "capabilityId": capability_id,
            "optionId": option_id,
            "changedPaths": [changed_path],
            "value": value,
            "phase": phase,
        }),
        OPENBITFUN_CONTROL_EFFECT_TIMEOUT,
        "apply the required runtime effect",
    )
    .await
}

async fn rollback_config_option(
    app: &AppHandle,
    state: &AppState,
    capability_id: &str,
    option: &ProductCapabilityOption,
    previous_value: &Value,
) -> Result<(), String> {
    if let Some(applied) =
        configure_config_backed_option(&state.config_service, option, previous_value).await?
    {
        apply_backend_config_effects(app, state, &applied.changed_path, &applied.effective_value)
            .await?;

        if option_requires_presentation_commit(option) {
            synchronize_required_effect(
                capability_id,
                &option.id,
                &applied.changed_path,
                &applied.effective_value,
                "rollback",
            )
            .await?;
        }
        return Ok(());
    }

    let ProductCapabilityOptionHandler::Provider {
        provider_id,
        option_id,
    } = &option.handler
    else {
        return Err("Product-control option has no rollback handler".to_string());
    };
    let provider = desktop_provider_option(provider_id, option_id).ok_or_else(|| {
        format!("Product-control provider option is not registered: {provider_id}:{option_id}")
    })?;
    configure_desktop_provider_option(app, provider, previous_value).await
}

async fn failed_option_transaction(
    app: &AppHandle,
    state: &AppState,
    capability_id: &str,
    option: &ProductCapabilityOption,
    previous_value: &Value,
    failure: String,
) -> String {
    match rollback_config_option(app, state, capability_id, option, previous_value).await {
        Ok(()) => format!("Product-control transaction failed and was rolled back: {failure}"),
        Err(rollback_error) => format!(
            "Product-control transaction failed: {failure}; rollback degraded: {rollback_error}"
        ),
    }
}

async fn configure_option_transaction(
    app: &AppHandle,
    capability_id: &str,
    option_id: &str,
    value: &Value,
) -> Result<Value, String> {
    let _transaction = product_control_transaction().lock().await;
    let capability = product_capability(capability_id)?;
    let option = capability
        .options
        .iter()
        .find(|option| option.id == option_id)
        .ok_or_else(|| format!("Unknown option for {capability_id}: {option_id}"))?;
    validate_option_value(&option.value_schema, value)?;
    let state = app.state::<AppState>();
    let previous_value = current_option_value(app, &state, option).await?;

    let (changed_path, effective_value, notify_settings) = if let Some(applied) =
        configure_config_backed_option(&state.config_service, option, value).await?
    {
        if let Err(error) = apply_backend_config_effects(
            app,
            &state,
            &applied.changed_path,
            &applied.effective_value,
        )
        .await
        {
            return Err(failed_option_transaction(
                app,
                &state,
                capability_id,
                option,
                &previous_value,
                error,
            )
            .await);
        }
        (applied.changed_path, applied.effective_value, true)
    } else if let ProductCapabilityOptionHandler::Provider {
        provider_id,
        option_id,
    } = &option.handler
    {
        let provider = desktop_provider_option(provider_id, option_id).ok_or_else(|| {
            format!("Product-control provider option is not registered: {provider_id}:{option_id}")
        })?;
        if let Err(error) = configure_desktop_provider_option(app, provider, value).await {
            return Err(failed_option_transaction(
                app,
                &state,
                capability_id,
                option,
                &previous_value,
                error,
            )
            .await);
        }
        let effective_value = match current_option_value(app, &state, option).await {
            Ok(value) => value,
            Err(error) => {
                return Err(failed_option_transaction(
                    app,
                    &state,
                    capability_id,
                    option,
                    &previous_value,
                    error,
                )
                .await);
            }
        };
        (provider.changed_path().to_string(), effective_value, false)
    } else {
        return Err("Product-control option has no executable handler".to_string());
    };
    if notify_settings {}

    let presentation_sync = if option_requires_presentation_commit(option) {
        match synchronize_required_effect(
            capability_id,
            option_id,
            &changed_path,
            &effective_value,
            "commit",
        )
        .await
        {
            Ok(result) => result,
            Err(effect_error) => {
                return Err(failed_option_transaction(
                    app,
                    &state,
                    capability_id,
                    option,
                    &previous_value,
                    format!("Required presentation effect failed: {effect_error}"),
                )
                .await);
            }
        }
    } else {
        emit_applied(
            capability_id,
            None,
            Some(option_id),
            &[changed_path.as_str()],
            Some(&effective_value),
        )
        .await
    };
    let revision = commit_revision();
    Ok(json!({
        "catalogDigest": openbitfun_product_domains::product_control::catalog()?.digest.clone(),
        "capabilityId": capability_id,
        "optionId": option_id,
        "configured": true,
        "effectiveValue": effective_value,
        "changedPaths": [changed_path],
        "revision": revision,
        "readBack": true,
        "presentationSync": presentation_sync,
    }))
}

async fn inspect_desktop(
    app: &AppHandle,
    request: &OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    let capability_id = request
        .capability_id
        .as_deref()
        .ok_or_else(|| "capabilityId is required for get".to_string())?;
    let capability = product_capability(capability_id)?;
    let state = app.state::<AppState>();
    let mut result = inspect_contract(capability_id)?;
    let option_values = result
        .as_object_mut()
        .ok_or_else(|| "Product-control inspection was not an object".to_string())?;
    let mut current_values = Map::new();
    for option in &capability.options {
        match current_option_value(app, &state, option).await {
            Ok(value) => {
                current_values.insert(option.id.clone(), value);
            }
            Err(error) => {
                current_values.insert(
                    option.id.clone(),
                    json!({ "availability": "degraded", "reason": error }),
                );
            }
        }
    }
    option_values.insert(
        "currentOptionValues".to_string(),
        Value::Object(current_values),
    );
    option_values.insert(
        "controlAvailability".to_string(),
        json!({
            "status": "available",
            "adapter": "desktop-native",
            "readBack": true,
            "presentationReady": SURFACE_READY.load(Ordering::Acquire),
        }),
    );
    option_values.insert(
        "catalogDigest".to_string(),
        Value::String(
            openbitfun_product_domains::product_control::catalog()?
                .digest
                .clone(),
        ),
    );
    option_values.insert("revision".to_string(), Value::from(current_revision()));
    if capability_id == "setting.application.pet" {
        let provider_state = match companion_state(&state).await {
            Ok(value) => value,
            Err(error) => json!({ "availability": "degraded", "reason": error }),
        };
        option_values.insert(
            "providerState".to_string(),
            json!({ "agent-companion-pet": provider_state }),
        );
    }
    Ok(result)
}

async fn configure_desktop(
    app: &AppHandle,
    request: &OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    let capability_id = request
        .capability_id
        .as_deref()
        .ok_or_else(|| "capabilityId is required for configure".to_string())?;
    let option_id = request
        .option_id
        .as_deref()
        .ok_or_else(|| "optionId is required for configure".to_string())?;
    let value = request
        .value
        .as_ref()
        .ok_or_else(|| "value is required for configure".to_string())?;
    configure_option_transaction(app, capability_id, option_id, value).await
}

fn binding_contract(
    binding: &ProductConfigBinding,
) -> Result<(&'static str, &'static ProductCapabilityOption), String> {
    let capability = product_capability(&binding.capability_id)?;
    let option = capability
        .options
        .iter()
        .find(|option| option.id == binding.option_id)
        .ok_or_else(|| {
            format!(
                "Resolved config binding points to a missing option: {}:{}",
                binding.capability_id, binding.option_id
            )
        })?;
    Ok((capability.id.as_str(), option))
}

async fn apply_binding_backend_effects(
    app: &AppHandle,
    state: &AppState,
    bindings: &[ProductConfigBinding],
) -> Result<(), String> {
    for binding in bindings {
        let (_, option) = binding_contract(binding)?;
        let Some(path) = config_handler_path(option) else {
            continue;
        };
        let effective = current_option_value(app, state, option).await?;
        apply_backend_config_effects(app, state, path, &effective).await?;
    }
    Ok(())
}

async fn synchronize_legacy_bindings(
    app: &AppHandle,
    state: &AppState,
    bindings: &[ProductConfigBinding],
    phase: &str,
) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    for binding in bindings {
        let (capability_id, option) = binding_contract(binding)?;
        let Some(path) = config_handler_path(option) else {
            continue;
        };
        let effective = current_option_value(app, state, option).await?;
        if option_requires_presentation_commit(option) {
            results.push(
                synchronize_required_effect(capability_id, &option.id, path, &effective, phase)
                    .await?,
            );
        } else {
            results.push(
                emit_applied(
                    capability_id,
                    None,
                    Some(&option.id),
                    &[path],
                    Some(&effective),
                )
                .await,
            );
        }
    }
    Ok(results)
}

async fn rollback_legacy_config_transaction(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    previous_value: Value,
) -> Result<(), String> {
    let rolled_back =
        apply_legacy_config_mutation(&state.config_service, path, previous_value).await?;
    apply_backend_config_effects(app, state, path, &rolled_back.effective_value).await?;
    apply_binding_backend_effects(app, state, &rolled_back.controlled_bindings).await?;

    synchronize_legacy_bindings(app, state, &rolled_back.controlled_bindings, "rollback")
        .await
        .map(|_| ())
}

async fn failed_legacy_transaction(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    previous_value: Option<Value>,
    failure: String,
) -> String {
    let rollback = match previous_value {
        Some(previous_value) => {
            rollback_legacy_config_transaction(app, state, path, previous_value).await
        }
        None => Err("The legacy path had no previous value to restore".to_string()),
    };
    match rollback {
        Ok(()) => format!("GUI config transaction failed and was rolled back: {failure}"),
        Err(rollback_error) => {
            format!("GUI config transaction failed: {failure}; rollback degraded: {rollback_error}")
        }
    }
}

/// Compatibility adapter for existing GUI settings. Exact controlled paths
/// become the same typed option command used by OpenBitFunControl. Parent-object
/// writes are schema-checked against every affected option, committed once,
/// and produce the same backend and presentation effects.
pub(crate) async fn set_config_from_gui(
    app: &AppHandle,
    path: &str,
    value: Value,
) -> Result<Value, String> {
    if let Some((capability, option)) = exact_config_binding(path)? {
        return configure_option_transaction(app, &capability.id, &option.id, &value).await;
    }

    let _transaction = product_control_transaction().lock().await;
    let state = app.state::<AppState>();
    let previous_value = state.config_service.get_config(Some(path)).await.ok();
    let applied = apply_legacy_config_mutation(&state.config_service, path, value).await?;
    if !applied.changed {
        return Ok(json!({
            "catalogDigest": openbitfun_product_domains::product_control::catalog()?.digest.clone(),
            "configured": true,
            "changedPaths": [],
            "controlledBindings": applied.controlled_bindings,
            "effectiveValue": applied.effective_value,
            "revision": current_revision(),
            "presentationSync": [],
        }));
    }
    let backend_effect_result =
        match apply_backend_config_effects(app, &state, path, &applied.effective_value).await {
            Ok(()) => {
                apply_binding_backend_effects(app, &state, &applied.controlled_bindings).await
            }
            Err(error) => Err(error),
        };
    if let Err(error) = backend_effect_result {
        return Err(failed_legacy_transaction(app, &state, path, previous_value, error).await);
    }

    let presentation_sync = match synchronize_legacy_bindings(
        app,
        &state,
        &applied.controlled_bindings,
        "commit",
    )
    .await
    {
        Ok(results) => results,
        Err(effect_error) => {
            return Err(failed_legacy_transaction(
                app,
                &state,
                path,
                previous_value,
                format!("Required presentation effect failed: {effect_error}"),
            )
            .await);
        }
    };
    let revision = commit_revision();
    Ok(json!({
        "catalogDigest": openbitfun_product_domains::product_control::catalog()?.digest.clone(),
        "configured": true,
        "changedPaths": [applied.changed_path],
        "controlledBindings": applied.controlled_bindings,
        "effectiveValue": applied.effective_value,
        "revision": revision,
        "presentationSync": presentation_sync,
    }))
}

pub(crate) async fn configure_option_from_gui(
    app: &AppHandle,
    capability_id: &str,
    option_id: &str,
    value: Value,
) -> Result<Value, String> {
    configure_option_transaction(app, capability_id, option_id, &value).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DesktopProviderOption {
    LaunchAtLogin,
    PreventSleep,
}

impl DesktopProviderOption {
    fn changed_path(self) -> &'static str {
        match self {
            Self::LaunchAtLogin => "system.launch_at_login",
            Self::PreventSleep => "app.prevent_sleep",
        }
    }
}

fn desktop_provider_option(provider_id: &str, option_id: &str) -> Option<DesktopProviderOption> {
    match (provider_id, option_id) {
        ("desktop-lifecycle", "launch-at-login") => Some(DesktopProviderOption::LaunchAtLogin),
        ("desktop-lifecycle", "prevent-sleep") => Some(DesktopProviderOption::PreventSleep),
        _ => None,
    }
}

async fn configure_desktop_provider_option(
    app: &AppHandle,
    option: DesktopProviderOption,
    value: &Value,
) -> Result<(), String> {
    let enabled = value
        .as_bool()
        .ok_or_else(|| "Desktop lifecycle options require a boolean value".to_string())?;
    match option {
        DesktopProviderOption::LaunchAtLogin => {
            if enabled {
                app.autolaunch().enable().map_err(|error| error.to_string())
            } else {
                app.autolaunch()
                    .disable()
                    .map_err(|error| error.to_string())
            }
        }
        DesktopProviderOption::PreventSleep => {
            crate::sleep_prevention::set_prevent_sleep_enabled_from_host(app, enabled).await
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DesktopProviderOperation {
    MiniApp(miniapps::Operation),
    ListCompanionPets,
    UseCompanionPet,
    DeleteCompanionPet,
}

fn desktop_provider_operation(
    provider_id: &str,
    operation_id: &str,
) -> Option<DesktopProviderOperation> {
    match (provider_id, operation_id) {
        ("miniapp", id) => miniapps::operation(id).map(DesktopProviderOperation::MiniApp),
        ("agent-companion-pet", "list") => Some(DesktopProviderOperation::ListCompanionPets),
        ("agent-companion-pet", "use") => Some(DesktopProviderOperation::UseCompanionPet),
        ("agent-companion-pet", "delete") => Some(DesktopProviderOperation::DeleteCompanionPet),
        _ => None,
    }
}

async fn select_companion(
    state: &AppState,
    selection: AgentCompanionPetSelection,
) -> Result<Value, String> {
    let mut experience: AIExperienceConfig = state
        .config_service
        .get_config(Some("app.ai_experience"))
        .await
        .map_err(|error| error.to_string())?;
    experience.enable_agent_companion = true;
    experience.agent_companion_pet = Some(selection);
    state
        .config_service
        .set_config("app.ai_experience", &experience)
        .await
        .map_err(|error| error.to_string())?;

    companion_state(state).await
}

async fn execute_desktop_provider_operation(
    app: &AppHandle,
    operation: DesktopProviderOperation,
    arguments: Option<&Value>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    match operation {
        DesktopProviderOperation::MiniApp(operation) => {
            miniapps::execute(
                &state.miniapp_manager,
                state.js_worker_pool.as_deref(),
                operation,
                arguments,
            )
            .await
        }
        DesktopProviderOperation::ListCompanionPets => companion_state(&state).await,
        DesktopProviderOperation::UseCompanionPet => {
            let arguments = arguments.and_then(Value::as_object).ok_or_else(|| {
                "use-pet requires an arguments object with path or id".to_string()
            })?;
            let selection = if let Some(path) = arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
            {
                let installed = list_agent_companion_pets_impl(&state).await?;
                let existing = installed.pets.iter().find(|pet| pet.package_path == path);
                match existing {
                    Some(pet) => dto_to_selection(pet),
                    None => dto_to_selection(
                        &import_agent_companion_pet_package_impl(&state, path).await?,
                    ),
                }
            } else if let Some(id) = arguments
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                if id == "openbitfun" {
                    AIExperienceConfig::default()
                        .agent_companion_pet
                        .ok_or_else(|| {
                            "The default OpenBitFun companion is unavailable".to_string()
                        })?
                } else {
                    let installed = list_agent_companion_pets_impl(&state).await?;
                    let pet = installed
                        .pets
                        .iter()
                        .find(|pet| pet.id == id)
                        .ok_or_else(|| format!("No imported Agent companion pet has ID {id}"))?;
                    dto_to_selection(pet)
                }
            } else {
                return Err("use-pet requires a non-empty path or id".to_string());
            };
            let state_value = select_companion(&state, selection).await?;
            let presentation_sync = emit_applied(
                "setting.application.pet",
                Some("use-pet"),
                None,
                &["app.ai_experience"],
                None,
            )
            .await;
            Ok(json!({
                "capabilityId": "setting.application.pet",
                "operationId": "use-pet",
                "executed": true,
                "effectiveState": state_value,
                "readBack": true,
                "presentationSync": presentation_sync,
            }))
        }
        DesktopProviderOperation::DeleteCompanionPet => {
            let arguments = arguments
                .and_then(Value::as_object)
                .ok_or_else(|| "delete-pet requires an arguments object".to_string())?;
            let installed = list_agent_companion_pets_impl(&state).await?;
            let package_path = if let Some(path) = arguments
                .get("packagePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
            {
                path.to_string()
            } else if let Some(id) = arguments
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                installed
                    .pets
                    .iter()
                    .find(|pet| pet.id == id)
                    .map(|pet| pet.package_path.clone())
                    .ok_or_else(|| format!("No imported Agent companion pet has ID {id}"))?
            } else {
                return Err("delete-pet requires a non-empty packagePath or id".to_string());
            };
            let mut experience: AIExperienceConfig = state
                .config_service
                .get_config(Some("app.ai_experience"))
                .await
                .map_err(|error| error.to_string())?;
            let deleting_active = experience
                .agent_companion_pet
                .as_ref()
                .is_some_and(|pet| pet.package_path == package_path);
            delete_agent_companion_pet_package_impl(&state, &package_path).await?;
            if deleting_active {
                experience.agent_companion_pet = AIExperienceConfig::default().agent_companion_pet;
                state
                    .config_service
                    .set_config("app.ai_experience", &experience)
                    .await
                    .map_err(|error| error.to_string())?;
            }

            let state_value = companion_state(&state).await?;
            let presentation_sync = emit_applied(
                "setting.application.pet",
                Some("delete-pet"),
                None,
                &["app.ai_experience"],
                None,
            )
            .await;
            Ok(json!({
                "capabilityId": "setting.application.pet",
                "operationId": "delete-pet",
                "executed": true,
                "effectiveState": state_value,
                "readBack": true,
                "presentationSync": presentation_sync,
            }))
        }
    }
}

async fn execute_desktop(
    app: &AppHandle,
    request: &OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    let capability_id = request
        .capability_id
        .as_deref()
        .ok_or_else(|| "capabilityId is required for execute".to_string())?;
    let operation_id = request
        .operation_id
        .as_deref()
        .ok_or_else(|| "operationId is required for execute".to_string())?;
    let capability = product_capability(capability_id)?;
    let operation = capability
        .operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| format!("Unknown operation for {capability_id}: {operation_id}"))?;
    validate_operation_arguments(&operation.input_schema, request.arguments.as_ref())?;
    // Reads stay concurrent. Every mutating product operation shares the same
    // transaction coordinator as GUI and Agent setting mutations, so revision
    // order matches the order in which product state/effects are committed.
    let _transaction = if operation.risk == ProductControlRisk::Read {
        None
    } else {
        Some(product_control_transaction().lock().await)
    };
    let mut result = match &operation.handler {
        ProductCapabilityOperationHandler::ProductAction { .. } => {
            dispatch_surface_request(request.clone()).await
        }
        ProductCapabilityOperationHandler::Provider {
            provider_id,
            operation_id: provider_operation_id,
        } => match desktop_provider_operation(provider_id, provider_operation_id) {
            Some(operation) => {
                execute_desktop_provider_operation(app, operation, request.arguments.as_ref()).await
            }
            None => Err(format!(
                "Product-control operation provider is not registered: {provider_id}:{provider_operation_id}"
            )),
        },
    }?;
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "catalogDigest".to_string(),
            Value::String(
                openbitfun_product_domains::product_control::catalog()?
                    .digest
                    .clone(),
            ),
        );
        object.insert(
            "revision".to_string(),
            Value::from(if operation.risk == ProductControlRisk::Read {
                current_revision()
            } else {
                commit_revision()
            }),
        );
    }
    Ok(result)
}

async fn dispatch_request(
    app: &AppHandle,
    request: OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    match request.action {
        ProductControlAction::Get => inspect_desktop(app, &request).await,
        ProductControlAction::Open => {
            let capability_id = request
                .capability_id
                .as_deref()
                .ok_or_else(|| "capabilityId is required for open".to_string())?;
            validate_open_target(capability_id, request.item_id.as_deref())?;
            dispatch_surface_request(request).await
        }
        ProductControlAction::Execute => execute_desktop(app, &request).await,
        ProductControlAction::Configure => configure_desktop(app, &request).await,
        ProductControlAction::List | ProductControlAction::Search => {
            Err("Discovery is owned by the platform-agnostic product-control catalog".to_string())
        }
    }
}

struct DesktopProductControlPort {
    app: AppHandle,
}

impl ProductControlPort for DesktopProductControlPort {
    fn invoke<'a>(
        &'a self,
        request: OpenBitFunControlHostRequest,
    ) -> openbitfun_product_domains::product_control::ProductControlFuture<'a> {
        Box::pin(async move { dispatch_request(&self.app, request).await })
    }
}

pub(crate) fn install(app: AppHandle) {
    set_openbitfun_control_port(Arc::new(DesktopProductControlPort { app }));
}

/// Mark only the presentation adapter ready; direct product controls are
/// installed during native setup and do not depend on the React listener.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ProductControlSurfaceReadyRequest {
    creation_api_version: Option<u64>,
}

#[tauri::command]
pub(crate) fn mark_openbitfun_control_surface_ready(
    request: Option<ProductControlSurfaceReadyRequest>,
) {
    CREATION_API_VERSION.store(
        request
            .and_then(|request| request.creation_api_version)
            .unwrap_or(0),
        Ordering::Release,
    );
    SURFACE_READY.store(true, Ordering::Release);
}

#[tauri::command]
pub(crate) fn mark_openbitfun_control_surface_unready() {
    SURFACE_READY.store(false, Ordering::Release);
    CREATION_API_VERSION.store(0, Ordering::Release);
    let pending = std::mem::take(&mut *lock_pending_responses());
    for (_, sender) in pending {
        let _ = sender.send(Err(
            "The active OpenBitFun presentation surface detached".to_string()
        ));
    }
}

/// Typed GUI adapter into the same Desktop executor used by OpenBitFunControl.
/// Caller-provided source metadata is overwritten at the trusted boundary.
#[tauri::command]
pub(crate) async fn product_control_invoke(
    app: AppHandle,
    mut request: OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    request.source = ProductControlSource::Gui;
    dispatch_request(&app, request).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportOpenBitFunControlResultRequest {
    request_id: String,
    success: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

/// Return a presentation-surface result to the waiting product-control call.
#[tauri::command]
pub(crate) async fn report_openbitfun_control_result(
    request: ReportOpenBitFunControlResultRequest,
) -> Result<(), String> {
    let sender = lock_pending_responses()
        .remove(&request.request_id)
        .ok_or_else(|| "OpenBitFunControl request is no longer pending".to_string())?;
    let result = if request.success {
        Ok(request.result.unwrap_or(Value::Null))
    } else {
        Err(request
            .error
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "OpenBitFunControl presentation request failed".to_string()))
    };
    sender
        .send(result)
        .map_err(|_| "OpenBitFunControl request receiver is no longer available".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_surface_readiness_does_not_claim_creation_support() {
        let legacy: super::ProductControlSurfaceReadyRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(legacy.creation_api_version, None);
        let current: super::ProductControlSurfaceReadyRequest =
            serde_json::from_value(serde_json::json!({"creationApiVersion": 1})).unwrap();
        assert_eq!(current.creation_api_version, Some(1));
    }
    use super::*;

    #[test]
    fn every_provider_operation_in_the_catalog_has_a_desktop_binding() {
        let catalog = openbitfun_product_domains::product_control::catalog().unwrap();
        for operation in catalog
            .capabilities
            .iter()
            .flat_map(|capability| &capability.operations)
        {
            if let ProductCapabilityOperationHandler::Provider {
                provider_id,
                operation_id,
            } = &operation.handler
            {
                assert!(
                    desktop_provider_operation(provider_id, operation_id).is_some(),
                    "missing Desktop provider binding for {provider_id}:{operation_id}"
                );
            }
        }
    }

    #[test]
    fn every_provider_option_in_the_catalog_has_a_desktop_binding() {
        let catalog = openbitfun_product_domains::product_control::catalog().unwrap();
        for option in catalog
            .capabilities
            .iter()
            .flat_map(|capability| &capability.options)
        {
            if let ProductCapabilityOptionHandler::Provider {
                provider_id,
                option_id,
            } = &option.handler
            {
                assert!(
                    desktop_provider_option(provider_id, option_id).is_some(),
                    "missing Desktop provider binding for {provider_id}:{option_id}"
                );
            }
        }
    }

    #[test]
    fn backend_effect_routing_is_owned_by_the_control_transaction() {
        for path in [
            "ai.models",
            "ai.models.providers.openai",
            "ai.stream_idle_timeout_secs",
            "ai.stream_ttft_timeout_secs",
            "ai.proxy",
        ] {
            assert!(
                config_path_invalidates_ai_client(path),
                "AI client-affecting path is missing its runtime effect: {path}"
            );
        }
        assert!(!config_path_invalidates_ai_client(
            "ai.tool_execution_timeout_secs"
        ));
        for path in ["ai.default_models.primary", "ai.agent_model_defaults.mode"] {
            assert!(!config_path_invalidates_ai_client(path));
        }

        let appearance = product_capability("setting.application.appearance")
            .unwrap()
            .options
            .iter()
            .find(|option| option.id == "theme")
            .unwrap();
        let language = product_capability("setting.application.appearance")
            .unwrap()
            .options
            .iter()
            .find(|option| option.id == "language")
            .unwrap();
        let auto_update = product_capability("setting.application.general")
            .unwrap()
            .options
            .iter()
            .find(|option| option.id == "auto-update")
            .unwrap();
        assert!(option_requires_presentation_commit(appearance));
        assert!(option_requires_presentation_commit(language));
        assert!(!option_requires_presentation_commit(auto_update));
    }
}
