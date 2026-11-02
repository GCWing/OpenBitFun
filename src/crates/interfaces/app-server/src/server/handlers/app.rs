use agent_client_protocol::{Builder, Error, HandleDispatchFrom};
use openbitfun_app_server_protocol::app::{
    CapabilityAvailability, CapabilityDescriptor, HealthRequest, HealthResponse, HealthStatus,
    InitializeRequest, InitializeResponse, ServerInfo, TransportLimits,
};
use openbitfun_app_server_protocol::error::{AppServerErrorData, AppServerErrorKind};
use openbitfun_app_server_protocol::event::{SyncEventsRequest, SyncEventsResponse};
use openbitfun_app_server_protocol::{MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};
use openbitfun_product_domains::product_search::PRODUCT_SEARCH_CAPABILITY_ID;

use crate::management::EXTERNAL_SOURCES_CAPABILITY;
use crate::role::{AppClient, AppServer};
use crate::server::host_policy::{AppServerHostLimits, AppServerHostPolicy};

pub(in crate::server) fn builder(
    runtime: std::sync::Arc<crate::agent::OpenBitFunAppRuntime>,
    event_state: std::sync::Arc<crate::server::ConnectionEventState>,
    management: Option<std::sync::Arc<crate::management::AppManagementService>>,
    host_policy: Option<std::sync::Arc<AppServerHostPolicy>>,
    limits: AppServerHostLimits,
) -> Builder<AppServer, impl HandleDispatchFrom<AppClient>> {
    let capabilities = registered_capabilities(
        runtime.product_search().is_some(),
        management.as_deref(),
        runtime.context_reload().is_some(),
        host_policy.as_deref(),
    );
    let external_source_snapshot_available = capabilities.iter().any(|capability| {
        capability.id == EXTERNAL_SOURCES_CAPABILITY
            && matches!(capability.availability, CapabilityAvailability::Available)
    });
    AppServer
        .builder()
        .name("app lifecycle handlers")
        .on_receive_request(
            async move |request: InitializeRequest, responder, _cx| {
                if request.protocol_version < MIN_PROTOCOL_VERSION
                    || request.protocol_version > PROTOCOL_VERSION
                {
                    return responder.respond_with_result(Err(Error::invalid_params().data(
                        serde_json::to_value(AppServerErrorData {
                            kind: AppServerErrorKind::InvalidRequest,
                            retryable: false,
                            outcome_unknown: false,
                            capability: Some("app.initialize".to_string()),
                            request_id: None,
                        })
                        .unwrap_or(serde_json::Value::Null),
                    )));
                }
                responder.respond_with_result(Ok(InitializeResponse::new(
                    ServerInfo {
                        name: "openbitfun-app-server".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                    capabilities.clone(),
                    TransportLimits {
                        max_frame_bytes: limits.max_frame_bytes,
                        event_buffer_capacity: limits.event_buffer_capacity,
                    },
                )))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: HealthRequest, responder, _cx| {
                responder.respond(HealthResponse {
                    status: HealthStatus::Ready,
                    protocol_version: PROTOCOL_VERSION,
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SyncEventsRequest, responder, _cx| {
                let pending_permissions = runtime
                    .runtime()
                    .pending_permission_requests()
                    .unwrap_or_default();
                responder.respond(SyncEventsResponse {
                    cursors: request
                        .streams
                        .into_iter()
                        .map(|stream| event_state.cursor(stream))
                        .collect(),
                    pending_permissions,
                    agent_snapshot_available: false,
                    config_snapshot_available: false,
                    external_source_snapshot_available,
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
}

fn registered_capabilities(
    product_search_available: bool,
    management: Option<&crate::management::AppManagementService>,
    context_reload_available: bool,
    host_policy: Option<&AppServerHostPolicy>,
) -> Vec<CapabilityDescriptor> {
    let mut capabilities = Vec::new();
    for (id, methods) in [
        (
            "agent",
            vec![
                "agent/createSession",
                "agent/listSessions",
                "agent/deleteSession",
                "agent/submitTurn",
                "agent/submitDialogTurn",
                "agent/steerTurn",
                "agent/runUserShellCommand",
                "agent/submitUserAnswers",
                "agent/cancelTurn",
                "agent/run",
                "agent/event",
            ],
        ),
        (
            "session",
            vec![
                "session/sync",
                "session/readTranscript",
                "session/resolveWorkspace",
                "session/rename",
                "session/setArchived",
                "session/updateModel",
                "session/updateMode",
                "session/fork",
                "session/forkAtTurn",
                "session/forkBeforeTurn",
                "session/restore",
                "session/compact",
                "session/undo",
                "session/redo",
                "session/reloadContext",
                "session/usage",
                "session/waitForSettlement",
                "session/lineage",
                "session/inspectLineage",
                "session/cancelLineage",
            ],
        ),
        (
            "permission",
            vec![
                "agent/permissionEvent",
                "agent/respondPermission",
                "agent/respondPermissionBatch",
                "agent/listPendingPermissionRequests",
                "agent/listProjectPermissionGrants",
                "agent/removeProjectPermissionGrant",
                "agent/clearProjectPermissionGrants",
                "agent/listProjectPermissionAudit",
            ],
        ),
        (
            "workspace",
            vec![
                "workspace/diff",
                "workspace/searchReferences",
                "workspace/messageReferences",
            ],
        ),
        (
            "git",
            vec![
                "git/isRepository",
                "git/getStatus",
                "git/getBranches",
                "git/getRepositoryTrust",
            ],
        ),
        (
            "config",
            vec![
                "config/event",
                "config/getAgentProfileConfigs",
                "config/getAgentProfileConfig",
                "config/getModelConfigs",
                "config/getTuiModelCatalog",
                "model/projectReasoningCatalog",
                "config/getConfig",
                "config/getConfigs",
                "config/setConfig",
                "config/saveCloudSpeechConfig",
                "config/validateConfig",
                "config/setAgentProfileConfig",
                "config/resetAgentProfileConfig",
            ],
        ),
        (
            "i18n",
            vec![
                "i18n/getCurrentLanguage",
                "i18n/setLanguage",
                "i18n/getConfig",
                "i18n/setConfig",
                "i18n/getSupportedLanguages",
            ],
        ),
        ("eventSync", vec!["app/syncEvents", "app/eventStreamState"]),
    ] {
        let mut methods = methods;
        if !context_reload_available {
            methods.retain(|method| *method != "session/reloadContext");
        }
        if let Some(host_policy) = host_policy {
            methods.retain(|method| host_policy.allows(method));
        }
        if methods.is_empty() {
            continue;
        }
        capabilities.push(CapabilityDescriptor {
            id: id.to_string(),
            availability: CapabilityAvailability::Available,
            methods: methods.into_iter().map(str::to_string).collect(),
        });
    }
    const PRODUCT_SEARCH_METHOD: &str = "search/sessionContent";
    if host_policy
        .map(|policy| policy.allows(PRODUCT_SEARCH_METHOD))
        .unwrap_or(true)
    {
        capabilities.push(CapabilityDescriptor {
            id: PRODUCT_SEARCH_CAPABILITY_ID.to_string(),
            availability: if product_search_available {
                CapabilityAvailability::Available
            } else {
                CapabilityAvailability::Unavailable {
                    reason: "The Host did not provide product search".to_string(),
                }
            },
            methods: vec![PRODUCT_SEARCH_METHOD.to_string()],
        });
    }
    let management_capabilities = management
        .map(|service| service.capabilities())
        .unwrap_or_else(|| {
            crate::management::AppManagementCapabilities::unavailable(
                "The Host did not provide management owners",
            )
        });
    for mut descriptor in management_capabilities.descriptors() {
        if let Some(host_policy) = host_policy {
            descriptor
                .methods
                .retain(|method| host_policy.allows(method));
        }
        if descriptor.methods.is_empty() {
            continue;
        }
        capabilities.push(descriptor);
    }
    capabilities
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_host_management_service_declares_capabilities_unavailable() {
        let capabilities = registered_capabilities(false, None, true, None);
        for id in [
            "tui.modes",
            "tui.models",
            "tui.skills",
            "tui.subagents",
            "tui.mcp",
            EXTERNAL_SOURCES_CAPABILITY,
            crate::management::ACCOUNT_CAPABILITY,
            crate::management::WORKTREES_CAPABILITY,
        ] {
            let capability = capabilities
                .iter()
                .find(|capability| capability.id == id)
                .expect("management capability should be declared");
            assert!(matches!(
                capability.availability,
                CapabilityAvailability::Unavailable { .. }
            ));
        }
    }

    #[test]
    fn product_search_capability_reflects_the_injected_port() {
        for (available, expected_available) in [(false, false), (true, true)] {
            let capabilities = registered_capabilities(available, None, true, None);
            let search = capabilities
                .iter()
                .find(|capability| capability.id == PRODUCT_SEARCH_CAPABILITY_ID)
                .expect("search capability");
            assert_eq!(
                matches!(search.availability, CapabilityAvailability::Available),
                expected_available
            );
            assert_eq!(search.methods, vec!["search/sessionContent"]);
        }
    }

    #[test]
    fn host_policy_hides_product_search_when_method_is_not_allowed() {
        let policy =
            AppServerHostPolicy::new("test-host", std::env::temp_dir(), ["app/initialize"])
                .expect("build host policy");
        let capabilities = registered_capabilities(true, None, true, Some(&policy));

        assert!(capabilities
            .iter()
            .all(|capability| capability.id != PRODUCT_SEARCH_CAPABILITY_ID));
    }
}
