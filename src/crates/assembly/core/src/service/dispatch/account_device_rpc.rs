//! Account-device transport for the dispatch controller.
//!
//! Every controller host (Desktop, CLI) routes `dispatch_target_*` verbs to an
//! account device through the same `host_invoke` envelope over the encrypted
//! Relay RPC. The host supplies only the transport call; the envelope and the
//! agent-identity dialect translation live here so they cannot drift.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openbitfun_core_types::agent_identity_wire::{
    translate_agent_identity_command, translate_agent_identity_response, AgentIdentityDialect,
};
use serde_json::Value;

use super::DeviceDispatchRpc;
use crate::service::remote_connect::account_runtime::AccountRuntime;
use crate::service::remote_connect::AccountClient;

const DEVICE_DISPATCH_RPC_TIMEOUT: Duration = Duration::from_secs(120);

/// Encode one dispatch verb as the plaintext `host_invoke` RPC command.
pub fn encode_device_dispatch_command(command: &str, args: Value) -> anyhow::Result<String> {
    let args = translate_agent_identity_command(command, args, AgentIdentityDialect::Legacy)
        .map_err(anyhow::Error::msg)?;
    Ok(serde_json::to_string(&serde_json::json!({
        "cmd": "host_invoke",
        "command": command,
        "args": args,
    }))?)
}

/// Decode a target's `host_invoke_result` reply for one dispatch verb.
pub fn decode_device_dispatch_response(command: &str, raw: &str) -> anyhow::Result<Value> {
    let envelope: Value =
        serde_json::from_str(raw).map_err(|error| anyhow::anyhow!("decode device RPC: {error}"))?;
    let value = match envelope.get("resp").and_then(Value::as_str) {
        Some("host_invoke_result") if envelope.get("ok").and_then(Value::as_bool) == Some(true) => {
            envelope.get("value").cloned().unwrap_or(Value::Null)
        }
        Some("host_invoke_result") => anyhow::bail!(
            "{}",
            envelope
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Device dispatch target rejected the command")
        ),
        Some("error") => anyhow::bail!(
            "{}",
            envelope
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Device dispatch RPC failed")
        ),
        _ => anyhow::bail!("Device dispatch target returned an unexpected RPC envelope"),
    };
    translate_agent_identity_response(
        command,
        value,
        &Value::Null,
        AgentIdentityDialect::Canonical,
    )
    .map_err(anyhow::Error::msg)
}

/// Device dispatch over the account session held by an [`AccountRuntime`].
pub struct AccountRuntimeDeviceDispatchRpc {
    account: Arc<AccountRuntime>,
}

impl AccountRuntimeDeviceDispatchRpc {
    pub fn new(account: Arc<AccountRuntime>) -> Self {
        Self { account }
    }
}

#[async_trait]
impl DeviceDispatchRpc for AccountRuntimeDeviceDispatchRpc {
    async fn invoke(&self, device_id: &str, command: &str, args: Value) -> anyhow::Result<Value> {
        let command_json = encode_device_dispatch_command(command, args)?;
        let generation = self.account.account_context_generation();
        let (session, relay_url) = self
            .account
            .read_account_context_for_generation(generation)
            .await?;
        let raw = tokio::time::timeout(
            DEVICE_DISPATCH_RPC_TIMEOUT,
            AccountClient::new().device_rpc(&relay_url, &session, device_id, &command_json),
        )
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "device RPC timed out after {}ms",
                DEVICE_DISPATCH_RPC_TIMEOUT.as_millis()
            )
        })??;
        if !self.account.account_context_is_current(generation) {
            anyhow::bail!("account context changed");
        }
        decode_device_dispatch_response(command, &raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_dispatch_envelope_round_trips_success_and_errors() {
        let encoded =
            encode_device_dispatch_command("dispatch_target_probe", serde_json::json!({})).unwrap();
        let encoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(encoded["cmd"], "host_invoke");
        assert_eq!(encoded["command"], "dispatch_target_probe");

        let ok = decode_device_dispatch_response(
            "dispatch_target_probe",
            r#"{"resp":"host_invoke_result","ok":true,"value":{"protocolVersion":6}}"#,
        )
        .unwrap();
        assert_eq!(ok["protocolVersion"], 6);

        let rejected = decode_device_dispatch_response(
            "dispatch_target_probe",
            r#"{"resp":"host_invoke_result","ok":false,"error":"busy"}"#,
        )
        .unwrap_err();
        assert_eq!(rejected.to_string(), "busy");

        let failed = decode_device_dispatch_response(
            "dispatch_target_probe",
            r#"{"resp":"error","message":"offline"}"#,
        )
        .unwrap_err();
        assert_eq!(failed.to_string(), "offline");

        assert!(
            decode_device_dispatch_response("dispatch_target_probe", r#"{"resp":"other"}"#)
                .is_err()
        );
    }
}
