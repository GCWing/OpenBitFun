//! Unified ProductControl HostInvoke adapter for the CLI product host.
//!
//! The adapter only translates the Peer transport envelope and audit source.
//! Shared setting reads and mutations execute in the same process-level
//! handler used by OpenBitFunControl in the CLI Agent loop.

use openbitfun_core::agentic::tools::openbitfun_control_config::global_shared_product_control_executor;
use openbitfun_product_domains::product_control::{
    discover, ProductControlAction, ProductControlDeliveryProfile, ProductControlRequest,
    ProductControlSource,
};
use serde_json::Value;

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

pub(crate) async fn invoke(_state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let mut request: ProductControlRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid ProductControl request: {error}"))?;
    // Source is trusted transport metadata, never caller-controlled behavior.
    request.source = ProductControlSource::Peer;

    if request.capability_id.as_deref() == Some("feature.remote-connect") {
        if request.action == ProductControlAction::Execute {
            openbitfun_product_domains::remote_control::RemoteControlRequest::from_operation(
                request.operation_id.as_deref().unwrap_or_default(),
                request.arguments.as_ref(),
            )?
            .ensure_direct_peer_safe()?;
        }
        return openbitfun_core::agentic::tools::openbitfun_control_host::invoke_openbitfun_control(request).await;
    }

    match request.action {
        ProductControlAction::List | ProductControlAction::Search => discover(&request),
        ProductControlAction::Get => {
            let capability_id = request
                .capability_id
                .as_deref()
                .ok_or_else(|| "capabilityId is required for get".to_string())?;
            global_shared_product_control_executor()
                .await?
                .inspect(capability_id, ProductControlDeliveryProfile::Peer)
                .await
        }
        ProductControlAction::Configure => {
            let result = global_shared_product_control_executor()
                .await?
                .configure(&request)
                .await?;
            Ok(result)
        }
        ProductControlAction::Open => Err(
            "product_control_presentation_unavailable: The CLI Peer host has no live presentation surface"
                .to_string(),
        ),
        ProductControlAction::Execute => Err(
            "product_control_native_operation_unavailable: The requested operation requires a native product-host or presentation provider that the CLI Peer host does not implement"
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn peer_transport_source_cannot_change_the_business_request_shape() {
        let mut request: ProductControlRequest = serde_json::from_value(json!({
            "action": "configure",
            "capabilityId": "setting.tools.execution",
            "optionId": "timeouts",
            "value": 73,
            "source": "gui"
        }))
        .expect("request");
        request.source = ProductControlSource::Peer;
        assert_eq!(request.source, ProductControlSource::Peer);
        assert_eq!(request.value, Some(json!(73)));
    }
}
