//! Closed management requests for the executing OpenBitFun host's Remote Connect.
//!
//! This is independent of workspace file routing and contains no provider secrets.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REMOTE_CONTROL_PROVIDER: &str = "remote-connect";
pub const REMOTE_CONTROL_CAPABILITY: &str = "remote_connect_control_v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteControlMethod {
    Weixin,
    Telegram,
    Feishu,
    MobileWeb,
    Lan,
}

impl RemoteControlMethod {
    pub fn bot_type(self) -> Option<&'static str> {
        match self {
            Self::Weixin => Some("weixin"),
            Self::Telegram => Some("telegram"),
            Self::Feishu => Some("feishu"),
            Self::MobileWeb | Self::Lan => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteControlRequest {
    Status,
    Start {
        method: RemoteControlMethod,
        #[serde(default)]
        lan_ip: Option<String>,
    },
    Stop {
        method: RemoteControlMethod,
    },
    ConfigureBot {
        method: RemoteControlMethod,
        credentials_file: String,
    },
    WeixinLoginStart,
    WeixinLoginPoll {
        session_key: String,
        #[serde(default)]
        verify_code: Option<String>,
    },
    SetBotVerbose {
        enabled: bool,
    },
}

impl RemoteControlRequest {
    pub fn from_operation(operation: &str, arguments: Option<&Value>) -> Result<Self, String> {
        let mut arguments = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
        let object = arguments
            .as_object_mut()
            .ok_or("Remote Connect arguments must be an object")?;
        if object.contains_key("operation") {
            return Err(
                "Remote Connect operation must be supplied by the registered handler".into(),
            );
        }
        object.insert("operation".into(), Value::String(operation.into()));
        serde_json::from_value(arguments)
            .map_err(|_| "Invalid Remote Connect operation or arguments".into())
    }

    /// Direct HostInvoke holds the route's read lease through its response.
    /// A turn submitted to the Agent runtime is independent of that lease.
    pub fn ensure_direct_peer_safe(&self) -> Result<(), String> {
        if matches!(
            self,
            Self::Start {
                method: RemoteControlMethod::MobileWeb | RemoteControlMethod::Lan,
                ..
            } | Self::Stop {
                method: RemoteControlMethod::MobileWeb | RemoteControlMethod::Lan
            }
        ) {
            return Err("remote_control_transport_lifecycle_unsupported: Start or stop Relay through a Claw conversation or on the executing host; a direct Peer RPC cannot replace its own transport".into());
        }
        Ok(())
    }

    pub fn operation_id(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Start { .. } => "start",
            Self::Stop { .. } => "stop",
            Self::ConfigureBot { .. } => "configure-bot",
            Self::WeixinLoginStart => "weixin-login-start",
            Self::WeixinLoginPoll { .. } => "weixin-login-poll",
            Self::SetBotVerbose { .. } => "set-bot-verbose",
        }
    }

    pub fn is_readonly(&self) -> bool {
        matches!(self, Self::Status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn controls_declare_risk_host_paths_and_peer_negotiation() {
        use crate::product_control::*;
        let registry = ProductControlRegistry::global();
        let operation = registry
            .operation("feature.remote-connect", "configure-bot")
            .unwrap();
        let args = serde_json::json!({"method":"telegram", "credentialsFile":"/host/private.json"});
        validate_operation_arguments(&operation.input_schema, Some(&args)).unwrap();
        assert!(validate_operation_argument_scopes(operation, Some(&args), true).is_err());
        assert_eq!(
            registry
                .operation("feature.remote-connect", "status")
                .unwrap()
                .risk,
            ProductControlRisk::Read
        );
        assert_eq!(
            registry
                .operation("feature.remote-connect", "start")
                .unwrap()
                .risk,
            ProductControlRisk::Write
        );
        let definition = registry
            .definition("feature.remote-connect:operation:start")
            .unwrap();
        assert!(definition.availability[&ProductControlDeliveryProfile::Cli].available);
        assert!(
            definition.availability[&ProductControlDeliveryProfile::Peer]
                .required_capabilities
                .contains(&REMOTE_CONTROL_CAPABILITY.to_owned())
        );
        assert!(RemoteControlRequest::from_operation(
            "weixin-login-poll",
            Some(&serde_json::json!({"sessionKey":"one"}))
        )
        .is_ok());
    }

    #[test]
    fn direct_peer_lifecycle_refuses_to_replace_its_own_route() {
        for method in [RemoteControlMethod::MobileWeb, RemoteControlMethod::Lan] {
            assert!(RemoteControlRequest::Start {
                method,
                lan_ip: None
            }
            .ensure_direct_peer_safe()
            .is_err());
            assert!(RemoteControlRequest::Stop { method }
                .ensure_direct_peer_safe()
                .is_err());
        }
        assert!(RemoteControlRequest::Start {
            method: RemoteControlMethod::Weixin,
            lan_ip: None
        }
        .ensure_direct_peer_safe()
        .is_ok());
        assert!(RemoteControlRequest::Status
            .ensure_direct_peer_safe()
            .is_ok());
    }

    #[test]
    fn closed_requests_reject_secret_arguments_and_unknown_methods() {
        assert!(
            RemoteControlRequest::from_operation("start", Some(&json!({"method":"weixin"})))
                .is_ok()
        );
        for arguments in [
            json!({"method":"weixin", "token":"secret"}),
            json!({"method":"shell"}),
            json!({"operation":"stop", "method":"weixin"}),
        ] {
            assert!(RemoteControlRequest::from_operation("start", Some(&arguments)).is_err());
        }
    }
}
