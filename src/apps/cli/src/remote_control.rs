//! CLI adapters for the shared Remote Connect owner and ProductControl tool.
//!
//! The daemon owns listeners. Interactive, Shared and headless Agent processes
//! use its authenticated local management endpoint instead of polling providers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use anyhow::{anyhow, Result};
use openbitfun_core::agentic::tools::openbitfun_control_config::global_shared_product_control_executor;
use openbitfun_core::agentic::tools::openbitfun_control_host::set_openbitfun_control_port;
use openbitfun_core::service::remote_connect::{
    bot,
    control::{RemoteBotControl, RemoteConnectServiceHolder},
    embedded_relay_host::EmbeddedRelayHost,
    relay_client::ConnectionState,
    AccountClient, DeviceIdentity, QrGenerator, RemoteConnectConfig, RemoteConnectService,
};
use openbitfun_product_domains::product_control::{
    capability, discover, validate_operation_arguments, ProductCapabilityOperationHandler,
    ProductControlAction, ProductControlDeliveryProfile, ProductControlFuture, ProductControlPort,
    ProductControlRequest,
};
use openbitfun_product_domains::remote_control::{
    RemoteControlMethod, RemoteControlRequest, REMOTE_CONTROL_PROVIDER,
};
use serde_json::{json, Value};
use tokio::sync::{Mutex, RwLock};

use crate::runtime::CliRuntimeContext;

static DAEMON_HOST: OnceLock<Arc<CliRemoteControlHost>> = OnceLock::new();

pub(crate) fn daemon_host() -> Option<Arc<CliRemoteControlHost>> {
    DAEMON_HOST.get().cloned()
}

pub(crate) fn install(runtime: &Arc<CliRuntimeContext>) {
    set_openbitfun_control_port(Arc::new(CliProductControlPort {
        runtime: Arc::downgrade(runtime),
    }));
}

pub(crate) async fn activate_daemon(
    runtime: &Arc<CliRuntimeContext>,
) -> Result<Arc<CliRemoteControlHost>> {
    let host = CliRemoteControlHost::new(runtime)?;
    DAEMON_HOST
        .set(host.clone())
        .map_err(|_| anyhow!("CLI Remote Connect daemon owner is already installed"))?;
    let account = Arc::downgrade(runtime.account_runtime());
    bot::set_delegated_identity_provider(move || {
        let account = account.clone();
        async move {
            let account = account.upgrade()?;
            let generation = account.account_context_generation();
            let (session, relay_url) = account
                .read_account_context_for_generation(generation)
                .await
                .ok()?;
            let delegated = AccountClient::new()
                .delegate_token(&relay_url, &session)
                .await
                .ok()?;
            account.account_context_is_current(generation).then_some((
                relay_url,
                delegated.token,
                delegated.device_secret.to_vec(),
            ))
        }
    });
    let info = runtime.account_runtime().account_info().await?;
    if let Err(error) = host.bots.restore(&info.user_id).await {
        tracing::warn!("Daemon bot restore is unavailable: {error}");
    }
    Ok(host)
}

pub(crate) async fn retire_daemon_account() {
    if let Some(host) = daemon_host() {
        host.shutdown().await;
    }
}

pub(crate) struct CliRemoteControlHost {
    runtime: Weak<CliRuntimeContext>,
    service: RemoteConnectServiceHolder,
    bots: RemoteBotControl,
    relay_operation: Mutex<()>,
    relay_enabled: AtomicBool,
    relay_error: RwLock<Option<String>>,
    shutdown_requested: tokio::sync::Notify,
}

impl CliRemoteControlHost {
    fn new(runtime: &Arc<CliRuntimeContext>) -> Result<Arc<Self>> {
        let service = Arc::new(RwLock::new(Some(RemoteConnectService::new(
            RemoteConnectConfig::default(),
            Arc::new(CliEmbeddedRelayUnavailable),
        )?)));
        Ok(Arc::new(Self {
            runtime: Arc::downgrade(runtime),
            bots: RemoteBotControl::new(service.clone()),
            service,
            relay_operation: Mutex::new(()),
            relay_enabled: AtomicBool::new(true),
            relay_error: RwLock::new(None),
            shutdown_requested: tokio::sync::Notify::new(),
        }))
    }

    fn runtime(&self) -> Result<Arc<CliRuntimeContext>> {
        self.runtime
            .upgrade()
            .ok_or_else(|| anyhow!("CLI runtime is shutting down"))
    }

    pub(crate) async fn reconcile_relay(&self) -> Result<()> {
        let _operation = self.relay_operation.lock().await;
        self.connect_relay_if_enabled().await
    }

    async fn connect_relay_if_enabled(&self) -> Result<()> {
        if !self.relay_enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        let runtime = self.runtime()?;
        if !matches!(
            runtime.account_routing().connection_state().await,
            ConnectionState::Disconnected
        ) {
            return Ok(());
        }
        let device = DeviceIdentity::from_current_machine()?;
        let result = runtime
            .account_runtime()
            .restore_device_routing(&device.device_name)
            .await;
        *self.relay_error.write().await = result.as_ref().err().map(ToString::to_string);
        result
    }

    pub(crate) async fn execute_for_account(
        &self,
        request: RemoteControlRequest,
        expected_user: &str,
    ) -> Result<Value> {
        anyhow::ensure!(self.runtime()?.account_runtime().account_info().await?.user_id == expected_user,
            "account_changed: This chat and the daemon have different account identities; reload this chat before managing Remote Connect");
        self.execute(request).await
    }

    pub(crate) async fn execute(&self, request: RemoteControlRequest) -> Result<Value> {
        let runtime = self.runtime()?;
        let account = runtime.account_runtime();
        if !request.is_readonly() {
            account.read_account_context().await?;
        }
        match request {
            RemoteControlRequest::Status => {
                let mut result = self.bots.status().await?;
                let info = account.account_info().await?;
                result["daemonRunning"] = json!(true);
                result["host"] = json!({"kind":"cli", "deviceId":info.device_id, "deviceName":info.device_name});
                result["mobileWeb"] = json!({
                    "method":"mobile_web", "enabled":self.relay_enabled.load(Ordering::Acquire),
                    "routingState": format!("{:?}", runtime.account_routing().connection_state().await).to_ascii_lowercase(),
                    "relayUrl":info.relay_url, "lastError":self.relay_error.read().await.clone(),
                });
                result["lan"] = json!({"available":false,"reason":"This CLI build uses the configured Relay for Mobile Web; it does not host an embedded LAN Relay"});
                Ok(result)
            }
            RemoteControlRequest::Start { method: RemoteControlMethod::MobileWeb, .. } => {
                let _operation = self.relay_operation.lock().await;
                self.relay_enabled.store(true, Ordering::Release);
                self.connect_relay_if_enabled().await?;
                let info = account.account_info().await?;
                let url = QrGenerator::build_device_url(&info.relay_url, &info.device_id)?;
                Ok(json!({"started":true,"method":"mobile_web", "url":url,
                    "routingState":format!("{:?}", runtime.account_routing().connection_state().await).to_ascii_lowercase(),
                    "deviceId":info.device_id, "nextStep":"Open the URL in Mobile Web and sign in with the same OpenBitFun account. The daemon owns the session and continues when this chat disconnects."}))
            }
            RemoteControlRequest::Stop { method: RemoteControlMethod::MobileWeb } => {
                let _operation = self.relay_operation.lock().await;
                self.relay_enabled.store(false, Ordering::Release);
                runtime.account_routing().stop_device_routing().await;
                Ok(json!({"stopped":true,"method":"mobile_web", "affects":"Mobile Web and Peer Device routing on this daemon; bot listeners remain active", "until":"next daemon restart or explicit start"}))
            }
            RemoteControlRequest::Start { method: RemoteControlMethod::Lan, .. }
            | RemoteControlRequest::Stop { method: RemoteControlMethod::Lan } => {
                Err(anyhow!("unsupported: This CLI build has no embedded LAN Relay. Use method mobile_web with the configured Relay; no local or controller fallback was performed"))
            }
            other => self.bots.execute(other).await,
        }
    }

    pub(crate) fn request_shutdown(&self) {
        self.shutdown_requested.notify_one();
    }

    pub(crate) async fn wait_for_shutdown_request(&self) {
        self.shutdown_requested.notified().await;
    }

    pub(crate) async fn shutdown(&self) {
        self.relay_enabled.store(false, Ordering::Release);
        if let Some(service) = self.service.read().await.as_ref() {
            service.set_bot_account(None).await;
        }
    }
}

struct CliEmbeddedRelayUnavailable;
#[async_trait::async_trait]
impl EmbeddedRelayHost for CliEmbeddedRelayUnavailable {
    async fn start(&self, _: u16, _: Option<String>) -> Result<()> {
        Err(anyhow!(
            "unsupported: Embedded LAN Relay is not available in this CLI host"
        ))
    }
    async fn stop(&self) {}
}

struct CliProductControlPort {
    runtime: Weak<CliRuntimeContext>,
}

impl ProductControlPort for CliProductControlPort {
    fn invoke<'a>(&'a self, request: ProductControlRequest) -> ProductControlFuture<'a> {
        Box::pin(async move {
            let runtime = self
                .runtime
                .upgrade()
                .ok_or("CLI product host is unavailable")?;
            match request.action {
                ProductControlAction::List | ProductControlAction::Search => discover(&request),
                ProductControlAction::Get => {
                    let id = request
                        .capability_id
                        .as_deref()
                        .ok_or("capabilityId is required")?;
                    let mut result = global_shared_product_control_executor()
                        .await?
                        .inspect(id, ProductControlDeliveryProfile::Cli)
                        .await?;
                    if id == "feature.remote-connect" {
                        result["operationAvailability"] = Value::Object(
                            capability(id)?
                                .operations
                                .iter()
                                .map(|operation| {
                                    (
                                        operation.id.clone(),
                                        json!({"status":"available", "owner":"cli-daemon"}),
                                    )
                                })
                                .collect(),
                        );
                        result["controlAvailability"] = json!({"status":"available", "adapter":"cli-daemon", "readBack":true, "actions":{"execute":{"status":"available"}}});
                        result["remoteConnect"] = match crate::daemon::control::invoke(
                            &runtime,
                            RemoteControlRequest::Status,
                        )
                        .await
                        {
                            Ok(status) => status,
                            Err(error) => {
                                json!({"status":"unavailable", "reason":error.to_string()})
                            }
                        };
                    }
                    Ok(result)
                }
                ProductControlAction::Configure => {
                    global_shared_product_control_executor()
                        .await?
                        .configure(&request)
                        .await
                }
                ProductControlAction::Open => Err(
                    "product_control_presentation_unavailable: CLI has no presentation surface"
                        .into(),
                ),
                ProductControlAction::Execute => {
                    let capability = capability(
                        request
                            .capability_id
                            .as_deref()
                            .ok_or("capabilityId is required")?,
                    )?;
                    let operation = capability
                        .operations
                        .iter()
                        .find(|op| Some(op.id.as_str()) == request.operation_id.as_deref())
                        .ok_or("Unknown product-control operation")?;
                    validate_operation_arguments(
                        &operation.input_schema,
                        request.arguments.as_ref(),
                    )?;
                    let ProductCapabilityOperationHandler::Provider {
                        provider_id,
                        operation_id,
                    } = &operation.handler
                    else {
                        return Err("product_control_native_operation_unavailable: CLI has no provider for this operation".into());
                    };
                    if provider_id != REMOTE_CONTROL_PROVIDER {
                        return Err("product_control_native_operation_unavailable: CLI has no provider for this operation".into());
                    }
                    let command = RemoteControlRequest::from_operation(
                        operation_id,
                        request.arguments.as_ref(),
                    )?;
                    crate::daemon::control::invoke(&runtime, command)
                        .await
                        .map_err(|error| error.to_string())
                }
            }
        })
    }
}
